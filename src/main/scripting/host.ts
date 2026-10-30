import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipboard, Notification, shell } from 'electron';
import { chatKey, type AppConfig, type AppId, type AskQuestion, type ChatMessage, type RuleConfig, type ScriptConfig, type ScriptTestResult } from '@shared/types';
import { runProcess } from '../agent/builtins';
import { completeText, runAgent } from '../agent/engine';
import { popup } from '../popup';
import { store } from '../store';
import { errText, logger } from '../util';
import { prepareScript, RUNNER_FILE, scriptDir, scriptFile, scriptRuntime } from './files';

const log = logger.scope('script');

/** What the host needs from the rest of the app. */
export interface HostDeps {
  config(): AppConfig;
  /** Sends a text message to a chat (bare name) of an app. Rejects when the app cannot send. */
  send(app: AppId, chat: string, text: string): Promise<void>;
  ocr(path: string): Promise<string>;
}

/** New messages handed to a script. */
export interface ScriptTrigger {
  app: AppId;
  /** Bare chat name as shown in the app. */
  chat: string;
  isGroup: boolean;
  rule: Pick<RuleConfig, 'id' | 'name'>;
  messages: ChatMessage[];
  mentionedMe: boolean;
  missed?: number;
  dryRun?: boolean;
}

export function makeEvent(t: ScriptTrigger) {
  const last = t.messages[t.messages.length - 1];
  return {
    type: 'message' as const, app: t.app,
    chat: { app: t.app, name: t.chat, isGroup: t.isGroup },
    rule: { id: t.rule.id, name: t.rule.name },
    messages: t.messages, text: t.messages.map((m) => m.text).join('\n'), sender: last?.sender,
    images: t.messages.flatMap((m) => (m.image ? [m.image] : [])),
    mentionedMe: t.mentionedMe, missed: t.missed ?? 0, at: Date.now(), dryRun: t.dryRun ?? false,
  };
}

interface RunState { script: ScriptConfig; trigger: ScriptTrigger; logs: string[]; held: Map<string, Array<() => void>> }

/** Runs scripts in child processes and answers their API calls. */
export class ScriptHost {
  private queues = new Map<string, Promise<unknown>>();
  private lockTails = new Map<string, Promise<void>>();
  private stateChain = new Map<string, Promise<unknown>>();

  constructor(private deps: HostDeps) {}

  /** Queues a run of the script behind earlier runs of the same script (they never overlap). Errors are logged + notified. */
  dispatch(scriptId: string, trigger: ScriptTrigger): void {
    const script = this.deps.config().scripts.find((s) => s.id === scriptId);
    if (!script || !script.enabled) { log.warn(`规则「${trigger.rule.id}」指向的脚本「${scriptId}」不存在或已停用`); return; }
    const next = (this.queues.get(script.id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const r = await this.run(script, trigger);
      if (r.ok) log.info(`脚本 ${script.id} 完成（${r.ms}ms）${r.result ? `：${r.result.slice(0, 200)}` : ''}`);
      else {
        log.error(`脚本 ${script.id} 失败：${r.error}`);
        if (Notification.isSupported()) new Notification({ title: `脚本 ${script.name || script.id} 运行失败`, body: (r.error ?? '').split('\n')[0].slice(0, 200) }).show();
      }
    });
    this.queues.set(script.id, next);
    void next.finally(() => { if (this.queues.get(script.id) === next) this.queues.delete(script.id); });
  }

  /** One run: prepares the folder, spawns the child, serves its API calls, resolves when it ends (or times out). */
  async run(script: ScriptConfig, trigger: ScriptTrigger): Promise<ScriptTestResult> {
    const t0 = Date.now();
    const st: RunState = { script, trigger, logs: [], held: new Map() };
    try {
      await prepareScript(script, 'run');
    } catch (e) {
      return { ok: false, error: errText(e), logs: st.logs, ms: Date.now() - t0 };
    }
    const rt = await scriptRuntime();
    return new Promise<ScriptTestResult>((resolve) => {
      const dir = scriptDir(script.id);
      const child = spawn(rt.cmd, ['--no-warnings', RUNNER_FILE], {
        cwd: dir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let settled = false;
      const finish = (r: Omit<ScriptTestResult, 'logs' | 'ms'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const rels of st.held.values()) for (const rel of rels) rel();
        child.kill('SIGKILL');
        resolve({ ...r, logs: st.logs, ms: Date.now() - t0 });
      };
      const timer = setTimeout(() => finish({ ok: false, error: `超时（${script.timeoutMs}ms）已终止` }), script.timeoutMs);
      const out = (level: 'debug' | 'info' | 'warn' | 'error', text: string) => {
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          st.logs.push(`[${level}] ${line}`);
          log[level](`[${script.id}] ${line}`);
        }
      };
      child.stdout?.on('data', (d) => out('info', String(d)));
      child.stderr?.on('data', (d) => out('warn', String(d)));
      child.on('error', (e) => finish({ ok: false, error: e.message }));
      child.on('close', (code) => finish({ ok: false, error: `进程意外退出 (${code})` }));
      child.on('message', (m: { rpc?: number; method?: string; params?: Record<string, unknown>; done?: { ok: boolean; result?: string; error?: string } }) => {
        if (m.done) { finish(m.done); return; }
        if (m.rpc === undefined || !m.method) return;
        const id = m.rpc;
        void this.handle(st, m.method, m.params ?? {}, out).then(
          (value) => { if (id && !settled) child.send({ rpcResult: id, value: value ?? null }); },
          (e) => { if (id && !settled) child.send({ rpcResult: id, error: errText(e) }); else if (!id) log.warn(`脚本 ${script.id} 的 ${m.method} 失败：${errText(e)}`); },
        );
      });
      child.send({
        run: {
          file: scriptFile(script.id), event: makeEvent(trigger),
          meta: { app: trigger.app, dryRun: trigger.dryRun ?? false, script: { id: script.id, dir }, chat: { app: trigger.app, name: trigger.chat, isGroup: trigger.isGroup } },
        },
      });
    });
  }

  // ---------------- API calls from the child ----------------

  private async handle(st: RunState, method: string, p: Record<string, unknown>, out: (l: 'debug' | 'info' | 'warn' | 'error', t: string) => void): Promise<unknown> {
    const cfg = this.deps.config();
    const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
    const appOf = (): AppId => (p.app === 'wecom' ? 'wecom' : p.app === 'wechat' ? 'wechat' : st.trigger.app);
    switch (method) {
      case 'log': out((['debug', 'info', 'warn', 'error'].includes(str('level')) ? str('level') : 'info') as 'info', str('text')); return;
      case 'history': {
        const key = chatKey(appOf(), str('chat'));
        return store.history(key).slice(-Math.max(1, Math.min(300, Number(p.n) || 30)));
      }
      case 'send': {
        const app = appOf(), chat = str('chat'), text = str('text');
        if (!chat || !text.trim()) throw new Error('send 需要 chat 和 text');
        if (st.trigger.dryRun) { out('info', `[试运行] 不发送 → ${app}「${chat}」：${text}`); return; }
        await this.deps.send(app, chat, text);
        return;
      }
      case 'ai.complete': {
        const agent = str('agent') || cfg.agents[0]?.id;
        if (!agent) throw new Error('没有可用的智能体');
        return completeText(cfg, agent, str('system') || '你是一个乐于助人的助手，回答简洁。', str('prompt'));
      }
      case 'ai.reply': {
        const app = appOf(), name = str('chat');
        const agent = str('agent') || cfg.agents[0]?.id;
        if (!agent) throw new Error('没有可用的智能体');
        const history = store.history(chatKey(app, name)).slice(-cfg.general.historyLimit);
        const incoming = st.trigger.messages;
        const r = await runAgent(cfg, agent, { chat: name, isGroup: st.trigger.isGroup, history: history.length ? history : incoming, incoming, ask: false });
        return r.skipped || !r.reply ? null : r.reply;
      }
      case 'ask': {
        const qs = (Array.isArray(p.questions) ? p.questions : []) as AskQuestion[];
        return popup().ask(qs.map((q) => ({ ...q, multiSelect: !!q.multiSelect })), { chat: str('chat'), isGroup: !!p.isGroup, timeoutSec: cfg.general.askTimeoutSec });
      }
      case 'ocr': return this.deps.ocr(str('path'));
      case 'notify': {
        if (!Notification.isSupported()) return;
        const n = new Notification({ title: str('title') || 'WeChat Relay', body: str('body') });
        const url = str('url');
        if (url) n.on('click', () => { void shell.openExternal(url); });
        n.show();
        return;
      }
      case 'clipboard.read': return clipboard.readText();
      case 'clipboard.write': clipboard.writeText(str('text')); return;
      case 'exec': {
        const r = await runProcess(str('cmd'), (Array.isArray(p.args) ? p.args : []).map(String), {
          cwd: str('cwd') || scriptDir(st.script.id), timeoutMs: Number(p.timeoutMs) || 60000, input: typeof p.input === 'string' ? p.input : undefined,
          env: p.env && typeof p.env === 'object' ? { ...process.env, ...(p.env as Record<string, string>) } : process.env,
        });
        return { code: r.code, stdout: r.out, stderr: r.err, timedOut: r.timedOut };
      }
      case 'state.get': return this.state(st.script.id, (s) => s[str('key')]);
      case 'state.set': return this.state(st.script.id, (s) => { s[str('key')] = p.value; return true; }, true);
      case 'state.delete': return this.state(st.script.id, (s) => { delete s[str('key')]; return true; }, true);
      case 'lock.acquire': return this.acquire(st, str('key'));
      case 'lock.release': { const rel = st.held.get(str('key'))?.pop(); rel?.(); return; }
      default: throw new Error(`未知的 API：${method}`);
    }
  }

  private async acquire(st: RunState, key: string): Promise<void> {
    const prev = this.lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.lockTails.set(key, tail);
    void tail.finally(() => { if (this.lockTails.get(key) === tail) this.lockTails.delete(key); });
    await prev;
    st.held.set(key, [...(st.held.get(key) ?? []), release]);
  }

  /** Reads / updates <script dir>/state.json one operation at a time. */
  private state<T>(id: string, fn: (s: Record<string, unknown>) => T, write = false): Promise<T> {
    const file = join(scriptDir(id), 'state.json');
    const next = (this.stateChain.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      let s: Record<string, unknown> = {};
      try { if (existsSync(file)) s = JSON.parse(readFileSync(file, 'utf8')); } catch { /* corrupt: start fresh */ }
      const r = fn(s);
      if (write) { writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2)); renameSync(`${file}.tmp`, file); }
      return r;
    });
    this.stateChain.set(id, next);
    return next;
  }
}
