import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AppConfig, AskAnswers, AskQuestion, DebugSection, HarnessConfig } from '@shared/types';
import { errText, logger } from '../util';
import { answersText, parseQuestions } from './ask';
import { prewarm } from './prewarm';
import { proxy } from './proxy';
import type { ToolCtx, ToolImpl } from './tools';

/**
 * Harnesses over ACP (Agent Client Protocol: JSON-RPC 2.0, one JSON message per line on stdio).
 *
 * Every chat gets its own long-lived agent process (process-level arguments such as CodeBuddy's
 * --append-system-prompt are per chat) with one ACP session; the process exits after `idleMinutes` without a new
 * message. The session id is remembered, so the next process `session/load`s it and only the new messages are sent.
 *
 * CodeBuddy's AskUserQuestion: declared with `clientCapabilities._meta["codebuddy.ai"].question`; the tool call then
 * arrives as `session/request_permission` (rawInput.questions) and the answers go back through the
 * `_codebuddy.ai/resolveInterruption` extension method.
 */

const log = logger.scope('ACP');
const PROTOCOL_VERSION = 1;
/** After session/cancel, wait this long for the turn to end before killing the process. */
const CANCEL_GRACE_MS = 5000;

const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface AcpSpec {
  harness: HarnessConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Arguments of the agent process (codebuddy: after `--acp`). */
  args: string[];
  /** CodeBuddy extensions: prewarm, AskUserQuestion via request_permission. */
  codebuddy: boolean;
  /** Declare the AskUserQuestion capability (codebuddy). */
  ask: boolean;
  /** ACP session/new mcpServers (without the tool proxy, which is added per process). */
  mcpServers: unknown[];
  /** Served to the agent through the local proxy MCP server. */
  tools: ToolImpl[];
}

export interface AcpTurn {
  /** Prompt for a session without context: the whole conversation. */
  intro: string;
  /** Prompt when the session already knows the conversation; null = always `intro`. */
  followUp: string | null;
  ctx: ToolCtx;
  /** Shows the popup; absent = questions are declined. */
  ask?: (q: AskQuestion[], signal: AbortSignal) => Promise<AskAnswers>;
  trace: string[];
  debug?: DebugSection[];
}

interface Rpc { resolve: (v: any) => void; reject: (e: Error) => void }

interface TurnState {
  text: string;
  tools: Map<string, { title: string; input?: unknown }>;
  abort: AbortController;
  turn: AcpTurn;
}

class AcpClient {
  closed = false;
  sessionId: string | undefined;
  onExit: () => void = () => {};
  private rpc = new Map<number, Rpc>();
  private seq = 0;
  private buf = '';
  private stray = '';
  private stderr: () => string = () => '';
  /** stderr plus non-JSON stdout lines: some CLI errors are printed on stdout. */
  private diag(): string { return `${this.stderr()}${this.stray}`; }
  private loadSession = false;
  private state: TurnState | null = null;
  private idle: NodeJS.Timeout | undefined;
  private reg: Awaited<ReturnType<typeof proxy.register>> | undefined;
  private mcpServers: unknown[] = [];

  private constructor(readonly spec: AcpSpec, readonly sig: string, private child: ChildProcess) {}

  /** Spawns (or activates a prewarmed standby of) the agent and runs `initialize`. */
  static async start(spec: AcpSpec, sig: string, turn: AcpTurn): Promise<AcpClient> {
    const h = spec.harness;
    const note = (t: string) => { turn.trace.push(`ACP：${t}`); turn.debug?.push({ title: 'ACP 进程', text: t }); };
    if (spec.codebuddy && h.prewarm !== false) {
      const t0 = Date.now();
      const taken = await prewarm.take({ id: h.id, command: h.command, cwd: spec.cwd, env: spec.env });
      if (taken.standby) {
        const a = await prewarm.activate(taken.standby, spec.cwd, spec.args);
        if (a.child) {
          note(`预热${taken.info}，激活 ${Date.now() - t0}ms`);
          try { return await AcpClient.init(spec, sig, turn, a.child, a.err); } catch (e) {
            // A standby that dies right after activation must not fail the reply: retry once with a cold start.
            note(`预热进程激活后不可用（${e instanceof Error ? e.message.split('\n')[0] : e}），改为冷启动`);
            log.warn(`${h.id} 预热进程激活后不可用，改为冷启动：${e instanceof Error ? e.message : e}`);
          }
        } else note(`预热${taken.info}，但激活失败（${a.error}），改为冷启动`);
      } else note(`预热${taken.info}，改为冷启动`);
    }
    const args = spec.codebuddy ? ['--acp', ...spec.args] : spec.args;
    const child = spawn(h.command, args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { err = (err + d).slice(-4000); });
    return AcpClient.init(spec, sig, turn, child, () => err);
  }

  /** Wires the process and runs `initialize`; the process is disposed when that fails. */
  private static async init(spec: AcpSpec, sig: string, turn: AcpTurn, child: ChildProcess, stderr: () => string): Promise<AcpClient> {
    const h = spec.harness;
    const t0 = Date.now();
    const c = new AcpClient(spec, sig, child);
    c.stderr = stderr;
    c.wire();
    try {
      if (spec.tools.length) {
        c.reg = await proxy.register({ tools: spec.tools, ctx: turn.ctx, trace: turn.trace });
        c.mcpServers = [...spec.mcpServers, { type: 'http', name: 'wr', url: c.reg.url, headers: [{ name: 'Authorization', value: `Bearer ${c.reg.token}` }] }];
        turn.trace.push(`proxy tools: ${spec.tools.map((t) => t.name).join(', ')}`);
      } else c.mcpServers = spec.mcpServers;
      const init = await c.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'wechat-relay', version: '0.1.0' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          ...(spec.codebuddy && spec.ask ? { _meta: { 'codebuddy.ai': { question: true } } } : {}),
        },
      }, 60_000);
      c.loadSession = init?.agentCapabilities?.loadSession === true;
      log.info(`${h.id} 已启动（pid ${child.pid}，${Date.now() - t0}ms，cwd ${spec.cwd}）`);
    } catch (e) {
      c.dispose();
      throw new Error(`ACP 初始化失败：${errText(e)}${c.diag().trim() ? `\n${short(c.diag().trim().slice(-400), 400)}` : ''}`);
    }
    return c;
  }

  private wire(): void {
    const child = this.child;
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      this.buf += d;
      for (let nl = this.buf.indexOf('\n'); nl >= 0; nl = this.buf.indexOf('\n')) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { this.stray = (this.stray + line + '\n').slice(-1000); continue; } // stray log output, kept for error messages
        this.onMessage(m);
      }
    });
    child.stdin!.on('error', () => { /* process gone: reported by exit */ });
    child.on('error', (e) => this.fail(`ACP 进程启动失败：${e.message}`));
    child.on('exit', (code, signal) => this.fail(`ACP 进程已退出（${signal ?? `exit ${code}`}）${this.diag().trim() ? `：${short(this.diag().trim().slice(-300), 300)}` : ''}`));
  }

  private fail(why: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    this.reg?.release();
    this.state?.abort.abort();
    for (const r of this.rpc.values()) r.reject(new Error(why));
    this.rpc.clear();
    this.onExit();
  }

  private send(m: object): void {
    if (!this.closed) this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error('ACP 进程已退出'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.rpc.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs) : undefined;
      this.rpc.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ id, method, params });
    });
  }

  private onMessage(m: any): void {
    if (m.id != null && !m.method) {
      const r = this.rpc.get(m.id);
      if (!r) return;
      this.rpc.delete(m.id);
      if (m.error) r.reject(new Error(`${m.error.message ?? 'error'}${m.error.data ? ` ${short(JSON.stringify(m.error.data), 300)}` : ''}`));
      else r.resolve(m.result);
      return;
    }
    if (m.method && m.id != null) {
      void this.onRequest(m.method, m.params).then(
        (result) => this.send({ id: m.id, result }),
        (e) => this.send({ id: m.id, error: { code: e?.code ?? -32603, message: errText(e) } }),
      );
      return;
    }
    if (m.method === 'session/update') this.onUpdate(m.params);
  }

  private onUpdate(p: any): void {
    const st = this.state;
    const u = p?.update;
    // Updates outside a turn are the history replay of session/load; team members' messages are not the reply.
    if (!st || !u || p.sessionId !== this.sessionId || u._meta?.['codebuddy.ai/memberEvent']) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') st.text += u.content.text ?? '';
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        let t = st.tools.get(id);
        if (!t) {
          t = { title: String(u.title ?? u._meta?.['codebuddy.ai/toolName'] ?? 'tool') };
          st.tools.set(id, t);
          // Text before a tool call is a preamble ("让我查一下"); the reply is what comes after the last one.
          st.text = '';
        }
        if (u.title) t.title = String(u.title);
        if (u.rawInput && Object.keys(u.rawInput).length) t.input = u.rawInput;
        if (u.status === 'completed' || u.status === 'failed') {
          const out = (Array.isArray(u.content) ? u.content : []).map((c: any) => (c?.content?.type === 'text' ? c.content.text : '')).join('').trim();
          const args = t.input ? short(JSON.stringify(t.input), 120) : '';
          st.turn.trace.push(`tool ${t.title}(${args}) → ${u.status === 'failed' ? '失败 ' : ''}${short(out)}`);
          st.turn.debug?.push({ title: `工具 · ${t.title}${u.status === 'failed' ? '（失败）' : ''}`, text: [t.input ? JSON.stringify(t.input, null, 2) : '', out].filter(Boolean).join('\n\n→ ') || '(空)' });
        }
        break;
      }
      default:
    }
  }

  private async onRequest(method: string, p: any): Promise<unknown> {
    if (method !== 'session/request_permission') throw Object.assign(new Error(`不支持 ${method}`), { code: -32601 });
    const options: Array<{ optionId: string; kind: string }> = Array.isArray(p?.options) ? p.options : [];
    const pick = (kind: 'allow' | 'reject') => {
      const o = options.find((x) => x.kind === `${kind}_once`) ?? options.find((x) => x.kind?.startsWith(kind));
      return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } };
    };
    const tc = p?.toolCall ?? {};
    const name = String(tc._meta?.['codebuddy.ai/toolName'] ?? tc.title ?? '');
    const st = this.state;
    const isAsk = Array.isArray(tc.rawInput?.questions) && (!name || name === 'AskUserQuestion');
    if (!isAsk || !this.spec.codebuddy) {
      st?.turn.trace.push(`拒绝权限请求：${name || '(未知工具)'}${tc.rawInput ? ` ${short(JSON.stringify(tc.rawInput), 120)}` : ''}`);
      return pick('reject');
    }
    const qs = parseQuestions(tc.rawInput);
    const questions = typeof qs === 'string' ? [] : qs;
    const answers = questions.length && st?.turn.ask && !st.abort.signal.aborted ? await st.turn.ask(questions, st.abort.signal) : null;
    st?.turn.trace.push(`AskUserQuestion → ${short(answersText(questions, answers).replace(/\n/g, ' '))}`);
    st?.turn.debug?.push({ title: '询问', text: `${questions.map((q) => `${q.question}\n${q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')}`).join('\n\n')}\n\n${answersText(questions, answers)}` });
    let resolved = false;
    try {
      const r = await this.request('_codebuddy.ai/resolveInterruption', {
        sessionId: p.sessionId ?? this.sessionId, toolCallId: tc.toolCallId,
        decision: answers ? 'allow' : 'deny', ...(answers ? { answers } : {}),
      }, 15_000);
      resolved = r?.resolved === true;
    } catch (e) {
      st?.turn.trace.push(`resolveInterruption 失败：${errText(e)}`);
    }
    // Resolved: CodeBuddy has already moved on and ignores this response. Not resolved: reject so the turn never hangs.
    return pick(resolved ? 'allow' : 'reject');
  }

  /** Uses the existing session, else loads `prev` (when supported), else creates one. true = it knows the conversation. */
  async ensureSession(prev: string | undefined): Promise<boolean> {
    if (this.sessionId) return true;
    if (prev && this.loadSession) {
      try {
        await this.request('session/load', { sessionId: prev, cwd: this.spec.cwd, mcpServers: this.mcpServers }, 60_000);
        this.sessionId = prev;
        return true;
      } catch (e) {
        log.warn(`${this.spec.harness.id} 恢复会话 ${prev} 失败，改为新会话：${errText(e)}`);
      }
    }
    const r = await this.request('session/new', { cwd: this.spec.cwd, mcpServers: this.mcpServers }, 60_000);
    if (!r?.sessionId) throw new Error('session/new 没有返回 sessionId');
    this.sessionId = String(r.sessionId);
    return false;
  }

  async prompt(text: string, turn: AcpTurn, timeoutMs: number): Promise<string> {
    this.reg?.update(turn.ctx, turn.trace);
    const st: TurnState = { text: '', tools: new Map(), abort: new AbortController(), turn };
    this.state = st;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      st.abort.abort();
      this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } });
      setTimeout(() => { if (this.state === st) this.dispose(); }, CANCEL_GRACE_MS).unref();
    }, timeoutMs);
    try {
      const r = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
      if (timedOut) throw new Error(`harness 超时（${timeoutMs}ms）`);
      if (r?.stopReason === 'refusal') throw new Error('harness 拒绝了本次请求');
      if (r?.stopReason && r.stopReason !== 'end_turn') turn.trace.push(`stopReason: ${r.stopReason}`);
      return st.text;
    } catch (e) {
      if (timedOut) throw new Error(`harness 超时（${timeoutMs}ms）`);
      throw e;
    } finally {
      clearTimeout(timer);
      st.abort.abort(); // closes a popup still open for this turn
      if (this.state === st) this.state = null;
    }
  }

  scheduleIdle(minutes: number, onIdle: () => void): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(onIdle, minutes * 60_000);
    this.idle.unref();
  }

  cancelIdle(): void { clearTimeout(this.idle); }

  dispose(): void {
    if (!this.closed && this.child.exitCode == null) this.child.kill('SIGTERM');
    this.fail('ACP 进程已结束');
  }
}

/** Serialises the work of one key (one chat's process). */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => undefined);
  return next;
}

const signature = (s: AcpSpec) => JSON.stringify([
  s.harness.command, s.args, s.cwd, s.harness.env ?? {}, s.codebuddy, s.ask, s.mcpServers,
  s.tools.map((t) => [t.name, t.description, t.parameters]),
]);

class AcpPool {
  private clients = new Map<string, AcpClient>();
  /** key → ACP session id, kept across process restarts (session/load). */
  private sessions = new Map<string, string>();

  /** One reply. key = `${harness}:${chat}`; null = a one-off task in a fresh process that exits afterwards. */
  run(key: string | null, spec: AcpSpec, turn: AcpTurn): Promise<string> {
    const k = key ?? `once:${randomUUID()}`;
    const h = spec.harness;
    return serial(k, async () => {
      const sig = signature(spec);
      let c = this.clients.get(k);
      if (c && (c.closed || c.sig !== sig)) {
        if (!c.closed) { log.info(`${k} 的参数已变化（系统提示词 / 工具 / 配置），重启进程并恢复会话`); c.dispose(); }
        this.clients.delete(k);
        c = undefined;
      }
      if (!c) {
        const fresh = await AcpClient.start(spec, sig, turn);
        fresh.onExit = () => { if (this.clients.get(k) === fresh) this.clients.delete(k); };
        this.clients.set(k, fresh);
        c = fresh;
      } else turn.trace.push(`ACP：复用进程（会话 ${c.sessionId ?? '新'}）`);
      c.cancelIdle();
      const keep = key !== null && h.sessionPerChat;
      if (!keep) c.sessionId = undefined;
      let ok = false;
      try {
        const known = await c.ensureSession(keep ? this.sessions.get(k) : undefined);
        if (keep && c.sessionId) this.sessions.set(k, c.sessionId);
        const text = known && turn.followUp != null ? turn.followUp : turn.intro;
        turn.debug?.push({ title: known ? `prompt（续接会话 ${c.sessionId}）` : `prompt（新会话 ${c.sessionId}）`, text });
        const out = await c.prompt(text, turn, h.timeoutMs);
        ok = true;
        return out;
      } finally {
        const client = c;
        if (!ok) { this.sessions.delete(k); }
        if (!ok || key === null || h.idleMinutes <= 0) { client.dispose(); this.clients.delete(k); }
        else client.scheduleIdle(h.idleMinutes, () => {
          if (this.clients.get(k) !== client) return;
          log.info(`${k} 已 ${h.idleMinutes} 分钟没有新消息，结束 ACP 进程`);
          client.dispose();
          this.clients.delete(k);
        });
      }
    });
  }

  /** Ends processes of harnesses that were removed (changed ones restart on their next reply). */
  sync(cfg: AppConfig): void {
    const ids = new Set(cfg.harnesses.filter((h) => h.type !== 'command').map((h) => h.id));
    for (const [k, c] of this.clients) if (!ids.has(c.spec.harness.id)) { c.dispose(); this.clients.delete(k); }
  }

  dispose(): void {
    for (const c of this.clients.values()) c.dispose();
    this.clients.clear();
  }
}

export const acpPool = new AcpPool();
