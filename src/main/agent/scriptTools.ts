import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolConfig } from '@shared/types';
import { expandEnv, TOOLS_DIR } from '../config';
import { logger } from '../util';
import { runProcess } from './builtins';
import type { ToolCtx } from './tools';

const log = logger.scope('script-tool');

/**
 * Runs in a child process (Electron in Node mode, whose Node strips TypeScript types natively): imports the tool's
 * index.ts, receives { args, ctx } over IPC and sends back the result. Tool console output goes to stdout/stderr.
 */
const RUNNER = `import { pathToFileURL } from 'node:url';
process.once('message', async ({ file, args, ctx }) => {
  // A pending promise alone does not keep Node alive; stay up until the tool settles (or the parent's timeout kills us).
  const keepAlive = setInterval(() => {}, 1 << 30);
  let msg;
  try {
    const mod = await import(pathToFileURL(file).href);
    const fn = typeof mod.default === 'function' ? mod.default : mod.run;
    if (typeof fn !== 'function') throw new Error('工具代码需要 export default 一个 (args, ctx) => 结果 的函数');
    const r = await fn(args, ctx);
    msg = { ok: true, result: typeof r === 'string' ? r : JSON.stringify(r ?? null, null, 2) };
  } catch (e) {
    msg = { ok: false, error: (e && e.stack) || String(e) };
  }
  clearInterval(keepAlive);
  process.send(msg, () => process.exit(0));
});
`;

const toolDir = (id: string) => join(TOOLS_DIR, id);
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const writeIfChanged = (p: string, s: string) => { if (read(p) !== s) writeFileSync(p, s); };

const inflight = new Map<string, Promise<void>>();

/**
 * Writes package.json / index.ts for a script tool and runs `npm install` when its dependencies changed.
 * Idempotent and cheap when nothing changed, so it is also called before each agent run.
 */
export function prepareScriptTool(tool: ToolConfig): Promise<void> {
  const prev = inflight.get(tool.id) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => prepare(tool));
  inflight.set(tool.id, next);
  void next.finally(() => { if (inflight.get(tool.id) === next) inflight.delete(tool.id); }).catch(() => undefined);
  return next;
}

async function prepare(tool: ToolConfig): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(tool.id)) throw new Error('工具 ID 只能包含字母数字下划线');
  const dir = toolDir(tool.id);
  mkdirSync(dir, { recursive: true });
  writeIfChanged(join(TOOLS_DIR, '_runner.mjs'), RUNNER);
  const deps = tool.dependencies ?? {};
  const pkg = JSON.stringify({ name: `wechat-relay-tool-${tool.id.toLowerCase()}`, private: true, type: 'module', dependencies: deps }, null, 2) + '\n';
  writeIfChanged(join(dir, 'package.json'), pkg);
  writeIfChanged(join(dir, 'index.ts'), tool.code ?? '');

  const stamp = join(dir, '.installed');
  const want = JSON.stringify(deps);
  if (read(stamp) === want && (!Object.keys(deps).length || existsSync(join(dir, 'node_modules')))) return;
  if (Object.keys(deps).length) {
    log.info(`安装 ${tool.id} 的依赖：${Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(' ')}`);
    const r = await runProcess('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, timeoutMs: 300000 });
    if (r.code !== 0) {
      const detail = (r.err || r.out).trim().slice(-4000);
      throw new Error(`npm install 失败${r.timedOut ? '（超时）' : ''}：\n${detail || `exit ${r.code}`}`);
    }
  }
  writeFileSync(stamp, want);
}

export function runScriptTool(tool: ToolConfig, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const dir = toolDir(tool.id);
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--no-warnings', join(TOOLS_DIR, '_runner.mjs')], {
      cwd: tool.cwd ? expandEnv(tool.cwd) : dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let logs = '', settled = false;
    const finish = (s: string) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); done(s.slice(0, 12000)); };
    const timer = setTimeout(() => finish(`error: 超时（${tool.timeoutMs}ms）${logs ? `\n${logs}` : ''}`), tool.timeoutMs);
    child.stdout?.on('data', (d) => { logs += d; });
    child.stderr?.on('data', (d) => { logs += d; });
    child.on('message', (m: { ok: boolean; result?: string; error?: string }) =>
      finish(m.ok ? (m.result ?? '') : `error: ${m.error}${logs ? `\n${logs}` : ''}`));
    child.on('error', (e) => finish(`error: ${e.message}`));
    child.on('close', (code) => finish(`error: 进程退出 (${code})${logs ? `\n${logs}` : ''}`));
    const { chat, isGroup, history } = ctx;
    child.send({ file: join(dir, 'index.ts'), args, ctx: { chat, isGroup, history, toolDir: dir } });
  });
}
