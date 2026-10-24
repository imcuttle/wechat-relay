import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { join } from 'node:path';
import { logger } from '../util';

/**
 * Standby `codebuddy --acp --prewarm` processes. A prewarmed process has finished its cold start (bundle, auth, product
 * config, MCP discovery) and waits on a local socket; `activate` binds the working directory + arguments and the
 * process starts speaking ACP on its stdio at once (~5 s cold start → a few ms). A prewarmed process serves exactly
 * one ACP client, so a replacement is started right after each take.
 */

const log = logger.scope('预热');
const TTL_MS = 20 * 60_000; // recycled so a standby never drifts far from the user's CodeBuddy settings / login
const READY_TIMEOUT_MS = 60_000;

/** Mode flag given at prewarm start, so the standby initialises in ACP mode; not repeated at activation. */
export const PREWARM_ARGS = ['--acp'];

export interface PrewarmSpec {
  /** harness id */
  id: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface Standby {
  key: string;
  name: string;
  spec: PrewarmSpec;
  child: ChildProcess;
  born: number;
  exited: boolean;
  err: string;
  ready: Promise<boolean>;
  readyMs?: number;
  timer: NodeJS.Timeout;
}

const specKey = (s: PrewarmSpec) => JSON.stringify([s.command, s.cwd, s.env]);

function socketPath(name: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\codebuddy-prewarm-${name}`;
  return join((process.env.CODEBUDDY_CODE_PREWARM_SOCKET_PATH ?? '').trim() || '/tmp', `codebuddy-prewarm-${name}.sock`);
}

/** One NDJSON request / response over the prewarm socket. */
function ipc(name: string, msg: object, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const sock = connect(socketPath(name), () => sock.write(`${JSON.stringify(msg)}\n`));
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('ipc timeout')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e as Error); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export type TakeResult =
  | { standby: Standby; info: string }
  | { standby: null; info: string };

class Prewarm {
  private pool = new Map<string, Standby>();

  /** Make the pool match the harnesses that should have a standby: start missing ones, drop stale / removed ones. */
  sync(specs: PrewarmSpec[]): void {
    const wanted = new Set(specs.map((s) => s.id));
    for (const [id, s] of this.pool) if (!wanted.has(id)) this.discard(s, '已停用或已删除');
    for (const spec of specs) {
      const cur = this.pool.get(spec.id);
      if (cur && cur.key === specKey(spec) && !cur.exited) continue;
      if (cur) this.discard(cur, '配置已变更');
      this.start(spec);
    }
  }

  private start(spec: PrewarmSpec): void {
    const name = `wr-${process.pid}-${randomUUID().slice(0, 8)}`;
    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...PREWARM_ARGS, '--prewarm', '--prewarm-id', name], { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log.warn(`启动预热进程失败（${spec.id}）：${e instanceof Error ? e.message : e}`);
      return;
    }

    const born = Date.now();
    const s: Standby = {
      key: specKey(spec), name, spec, child, born, exited: false, err: '',
      ready: Promise.resolve(false),
      timer: setTimeout(() => {
        if (this.pool.get(spec.id) !== s) return;
        this.discard(s, `空闲超过 ${TTL_MS / 60000} 分钟，换新`);
        this.start(spec);
      }, TTL_MS),
    };
    s.timer.unref();
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { s.err = (s.err + d).slice(-2000); });
    child.stdin!.on('error', () => { /* process gone */ });
    child.on('error', (e) => { s.err += e.message; });
    child.on('exit', (code, signal) => {
      s.exited = true;
      if (this.pool.get(spec.id) === s) {
        this.pool.delete(spec.id);
        clearTimeout(s.timer);
        log.warn(`预热进程已退出（${spec.id}，${signal ?? `exit ${code}`}）${s.err.trim() ? `：${s.err.trim().slice(-200)}` : ''}`);
      }
    });
    s.ready = (async () => {
      while (!s.exited && Date.now() - born < READY_TIMEOUT_MS) {
        try {
          const r = await ipc(name, { cmd: 'ping' }, 2000);
          if (r?.ok) { s.readyMs = Date.now() - born; log.info(`预热进程就绪（${spec.id}，pid ${child.pid}，冷启动 ${s.readyMs}ms）`); return true; }
        } catch { /* socket not there yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!s.exited) log.warn(`预热进程 ${READY_TIMEOUT_MS / 1000}s 内未就绪（${spec.id}），已放弃`);
      return false;
    })();
    void s.ready.then((ok) => { if (!ok && this.pool.get(spec.id) === s) this.discard(s, '未就绪'); });
    this.pool.set(spec.id, s);
    log.info(`正在预热 ${spec.command}（${spec.id}，cwd ${spec.cwd}）`);
  }

  private discard(s: Standby, why: string): void {
    if (this.pool.get(s.spec.id) === s) this.pool.delete(s.spec.id);
    clearTimeout(s.timer);
    if (!s.exited) s.child.kill('SIGTERM');
    log.info(`丢弃预热进程（${s.spec.id}）：${why}`);
  }

  /** Takes the standby for this spec (waiting for it if still starting) and starts its replacement. */
  async take(spec: PrewarmSpec): Promise<TakeResult> {
    const s = this.pool.get(spec.id);
    if (!s) { this.start(spec); return { standby: null, info: '未命中：没有待命的预热进程，已开始预热下一个' }; }
    if (s.key !== specKey(spec)) { this.discard(s, '配置不一致'); this.start(spec); return { standby: null, info: '未命中：预热进程的命令 / cwd / 环境变量与本次不一致' }; }
    this.pool.delete(spec.id);
    clearTimeout(s.timer);
    const t0 = Date.now();
    const ok = !s.exited && await s.ready;
    if (!ok || s.exited) {
      if (!s.exited) s.child.kill('SIGTERM');
      this.start(spec);
      return { standby: null, info: `未命中：预热进程不可用${s.err.trim() ? `（${s.err.trim().slice(-120)}）` : ''}` };
    }
    this.start(spec);
    const waited = Date.now() - t0;
    return { standby: s, info: `命中：待命 ${Math.round((t0 - s.born) / 1000)}s${waited > 50 ? `，又等了 ${waited}ms 就绪` : ''}` };
  }

  /**
   * Activates a taken standby with the real cwd + arguments; from then on the process speaks ACP on its stdio.
   * Returns the process, or the error (the caller falls back to a cold start).
   */
  async activate(s: Standby, cwd: string, args: string[]): Promise<{ child: ChildProcess; err: () => string } | { child: null; error: string }> {
    try {
      const r = await ipc(s.name, { cmd: 'activate', cwd, args }, 10_000);
      if (!r?.ok) throw new Error(String(r?.error ?? '激活被拒绝'));
    } catch (e) {
      if (!s.exited) s.child.kill('SIGTERM');
      return { child: null, error: e instanceof Error ? e.message : String(e) };
    }
    return { child: s.child, err: () => s.err };
  }

  dispose(): void {
    for (const s of [...this.pool.values()]) this.discard(s, '应用退出');
  }
}

export const prewarm = new Prewarm();
