import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, AppConfig, ChatMessage, HarnessConfig, ProviderConfig } from '@shared/types';
import { DATA_DIR, expandEnv } from '../config';
import { dateText, errText, nowText, render, sleep } from '../util';
import { resolveTools, type ToolCtx, type ToolImpl } from './tools';

export interface AgentInput {
  chat: string;
  isGroup: boolean;
  /** Context for the model (recent history including the new messages). */
  history: ChatMessage[];
  /** Everything stored for the chat, for the history tool. Defaults to `history`. */
  allHistory?: ChatMessage[];
  /** The new messages that triggered this run. */
  incoming: ChatMessage[];
  /** Persona prompt of this chat (a full prompt template); replaces the agent's base prompt. */
  persona?: string;
}

export interface AgentOutput { reply: string | null; skipped: boolean; reason?: string; trace: string[] }

const SKIP_RE = /^\s*\[?\s*(SKIP|NO_REPLY|不回复)\s*\]?\s*$/i;

function speaker(m: ChatMessage, chat: string, isGroup: boolean): string {
  return m.side === 'self' ? '我' : isGroup ? m.sender || '群成员' : chat;
}

/**
 * The system prompt must stay byte-identical across runs for prompt caching, so `{{now}}` is only the date;
 * the exact time is attached to the newest message instead (see `turns` / `transcript`).
 */
function systemPrompt(cfg: AppConfig, agent: AgentConfig, input: AgentInput): string {
  const last = input.incoming[input.incoming.length - 1];
  const vars = {
    chat: input.chat,
    group: input.isGroup,
    private: !input.isGroup,
    sender: last ? speaker(last, input.chat, input.isGroup) : '',
    myNickname: cfg.general.myNickname || '我',
    now: dateText(),
  };
  const base = input.persona?.trim() || (agent.prompt ? cfg.prompts.find((p) => p.id === agent.prompt)?.content ?? '' : '');
  return render([base, agent.systemPrompt ?? ''].filter((s) => s.trim()).join('\n\n'), vars).trim();
}

const timeNote = () => `[当前时间：${nowText()}]`;

type Part = { type: 'text'; text: string } | { type: 'image'; path: string };
interface Turn { role: 'user' | 'assistant'; parts: Part[] }

/** Width / height of a JPEG (SOF marker), or null. */
function jpegSize(path: string): { w: number; h: number } | null {
  try {
    const b = readFileSync(path);
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1], len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  } catch { /* unreadable */ }
  return null;
}

/** A crop worth sending as a picture: exists and is not a tiny (mis-detected text bubble) one. */
function usableImage(m: ChatMessage): boolean {
  if (m.kind !== 'image' || !m.image || !existsSync(m.image)) return false;
  const sz = jpegSize(m.image);
  return !sz || Math.min(sz.w, sz.h) >= 90;
}

/** OCR text found in an image message ("[图片] xxx" → "xxx"). */
const imageOcr = (m: ChatMessage) => m.text.replace(/^\[图片\]\s*/, '').trim();

/** Image messages that will be sent as pictures: the most recent `maxImages` usable crops. */
function pickImages(msgs: ChatMessage[], agent: AgentConfig): Set<ChatMessage> {
  if (!agent.vision) return new Set();
  const withImage = msgs.filter(usableImage);
  return new Set(withImage.slice(-Math.max(0, agent.maxImages ?? 4)));
}

/**
 * Conversation as alternating user/assistant turns (other → user, self → assistant).
 * Images may only appear in user turns, so pictures I sent are attached to the following user turn with a label.
 */
function turns(input: AgentInput, agent: AgentConfig, limit: number): Turn[] {
  const msgs = input.history.slice(-limit);
  const images = pickImages(msgs, agent);
  const out: Turn[] = [];
  let n = 0;
  let mine: Part[] = []; // my images waiting for the next user turn
  const push = (role: Turn['role'], parts: Part[]) => {
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      const last = prev.parts[prev.parts.length - 1];
      if (last?.type === 'text' && parts[0]?.type === 'text') { last.text += `\n${parts[0].text}`; prev.parts.push(...parts.slice(1)); }
      else prev.parts.push(...parts);
    } else out.push({ role, parts });
  };
  for (const m of msgs) {
    const role = m.side === 'self' ? 'assistant' : 'user';
    const who = role === 'user' && input.isGroup ? `${m.sender || '群成员'}: ` : '';
    if (!images.has(m)) { push(role, [{ type: 'text', text: who + m.text }]); continue; }
    const ocr = imageOcr(m);
    const label = `[图片${++n}]${ocr ? `（图中文字：${ocr}）` : ''}`;
    if (role === 'user') {
      push('user', [...mine, { type: 'text', text: who + label }, { type: 'image', path: m.image! }]);
      mine = [];
    } else {
      push('assistant', [{ type: 'text', text: label }]);
      mine.push({ type: 'text', text: `（${label} 是我发出的图片）` }, { type: 'image', path: m.image! });
    }
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') {
    push('user', [{ type: 'text', text: input.incoming.map((m) => m.text).join('\n') || '(无新消息)' }]);
  }
  if (mine.length) out[out.length - 1].parts.unshift(...mine);
  // Only the last turn varies between runs, so everything before it stays a cacheable prefix.
  out[out.length - 1].parts.unshift({ type: 'text', text: timeNote() + (n ? `\n${IMAGE_NOTE}` : '') });
  return out;
}

const b64 = (path: string) => readFileSync(path).toString('base64');

/** Images are screenshot crops: never blame them on loading problems, fall back to the OCR text instead. */
const IMAGE_NOTE = '（图片是从聊天截图中裁剪的，标注里附有图中识别出的文字。如果某张图看不清，就根据图中文字和上下文理解，不要说图片没加载、黑屏或让对方重发。）';

function openaiTurns(ts: Turn[], agent: AgentConfig): any[] {
  return ts.map((t) => (t.parts.every((p) => p.type === 'text')
    ? { role: t.role, content: t.parts.map((p) => (p as { text: string }).text).join('\n') }
    : {
        role: t.role,
        content: t.parts.map((p) => (p.type === 'text' ? p : {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${b64(p.path)}`, ...(agent.imageDetail ? { detail: agent.imageDetail } : {}) },
        })),
      }));
}

function anthropicTurns(ts: Turn[]): any[] {
  return ts.map((t) => (t.parts.every((p) => p.type === 'text')
    ? { role: t.role, content: t.parts.map((p) => (p as { text: string }).text).join('\n') }
    : {
        role: t.role,
        content: t.parts.map((p) => (p.type === 'text' ? p : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(p.path) } })),
      }));
}

const countImages = (ts: Turn[]) => ts.reduce((n, t) => n + t.parts.filter((p) => p.type === 'image').length, 0);

/** Text of a message for transcripts; harnesses with vision get the image path to open themselves. */
function lineText(m: ChatMessage, agent: AgentConfig): string {
  return agent.vision && usableImage(m) ? `${m.text}（图片文件：${m.image}）` : m.text;
}

function transcript(input: AgentInput, agent: AgentConfig, limit: number): string {
  const lines = input.history.slice(-limit).map((m) => `${speaker(m, input.chat, input.isGroup)}: ${lineText(m, agent)}`);
  return `以下是与「${input.chat}」的微信${input.isGroup ? '群聊' : '聊天'}记录（最后几条是需要你回复的新消息）：\n\n${lines.join('\n')}\n\n${timeNote()}\n` +
    `${agent.vision && lines.some((l) => l.includes('（图片文件：')) ? `图片消息附带了本地图片路径，需要时可以读取查看。${IMAGE_NOTE}\n` : ''}` +
    `请直接输出要发送的回复正文，不要任何解释或前缀。如果不需要回复，只输出 [SKIP]。`;
}

function finish(text: string | null | undefined, ctx: ToolCtx, trace: string[]): AgentOutput {
  if (ctx.skipped) return { reply: null, skipped: true, reason: ctx.skipped.reason, trace };
  const t = (text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!t || SKIP_RE.test(t)) return { reply: null, skipped: true, reason: t ? 'model returned SKIP' : 'empty reply', trace };
  return { reply: t, skipped: false, trace };
}

const HTTP_HINT: Record<number, string> = {
  401: 'API Key 无效或未设置', 402: '账户余额不足，请充值或换用其他模型服务', 403: '无权访问该模型',
  404: '接口地址或模型名错误', 429: '请求过于频繁或额度用尽', 500: '模型服务内部错误', 503: '模型服务暂不可用', 529: '模型服务过载',
};
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 2;

/** POST JSON; transient failures (rate limit, overload, 5xx, network) are retried with backoff / Retry-After. */
async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 120000): Promise<any> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const backoff = (s?: number) => sleep(Math.min(10000, s != null && s >= 0 ? s * 1000 : 1000 * 2 ** attempt));
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // Timeouts are not retried (each one already took timeoutMs); connection errors are.
      if (attempt >= MAX_RETRIES || (e as Error).name === 'TimeoutError') throw e;
      await backoff();
      continue;
    }
    const raw = await res.text();
    if (res.ok) return JSON.parse(raw);
    if (attempt < MAX_RETRIES && RETRYABLE.has(res.status) && !/insufficient_quota|余额|quota/i.test(raw)) {
      const ra = Number(res.headers.get('retry-after'));
      await backoff(Number.isFinite(ra) ? ra : undefined);
      continue;
    }
    throw new Error(`${HTTP_HINT[res.status] ? `${HTTP_HINT[res.status]}（HTTP ${res.status}）` : `HTTP ${res.status}`}: ${raw.slice(0, 300)}`);
  }
}

const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---- Agent loop ----

interface ToolCall { id: string; name: string; args: unknown }
interface ToolResult { call: ToolCall; content: string; isError: boolean }
interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Step { text: string; calls: ToolCall[]; usage: Usage }

/** One provider's wire format. The adapter owns the message list; the loop only sees calls and results. */
interface Adapter {
  /** final = last allowed round: the model must answer in text (calls it still makes are ignored). */
  step(final: boolean): Promise<Step>;
  addResults(results: ToolResult[]): void;
}

async function runTool(tools: ToolImpl[], call: ToolCall, ctx: ToolCtx, trace: string[]): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === call.name);
  let content: string, isError = false;
  let args: Record<string, unknown> = {};
  try {
    const raw = call.args;
    args = typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : ((raw as Record<string, unknown>) ?? {});
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数需要是 JSON 对象');
  } catch (e) {
    content = `error: 参数不是合法的 JSON 对象（${errText(e)}），请修正后重试`;
    trace.push(`tool ${call.name}(${short(String(call.args), 120)}) → ${content}`);
    return { call, content, isError: true };
  }
  if (!tool) {
    content = `error: 没有名为 ${call.name} 的工具，可用：${tools.map((t) => t.name).join(', ')}`;
    isError = true;
  } else {
    try { content = await tool.run(args, ctx); } catch (e) { content = `error: ${errText(e)}`; isError = true; }
    if (!isError && content.startsWith('error:')) isError = true;
  }
  trace.push(`tool ${call.name}(${short(JSON.stringify(args), 120)}) → ${short(content)}`);
  return { call, content: content || '(空)', isError };
}

const usageText = (u: Usage) => `in ${u.input}${u.cacheRead ? `（缓存命中 ${u.cacheRead}）` : ''}${u.cacheWrite ? `（写入缓存 ${u.cacheWrite}）` : ''} / out ${u.output}`;

async function agentLoop(ad: Adapter, maxRounds: number, tools: ToolImpl[], ctx: ToolCtx, trace: string[]): Promise<string | null> {
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (let round = 0; ; round++) {
    const final = round >= maxRounds;
    const r = await ad.step(final);
    for (const k of Object.keys(total) as Array<keyof Usage>) total[k] += r.usage[k];
    trace.push(`round ${round + 1}${final && round ? '（最后一轮）' : ''}: ${usageText(r.usage)}`);
    if (!r.calls.length) {
      if (round) trace.push(`total: ${usageText(total)}`);
      return r.text;
    }
    // Calls of one turn are independent by contract: run them concurrently, keep their order in the reply.
    ad.addResults(await Promise.all(r.calls.map((c) => runTool(tools, c, ctx, trace))));
    if (ctx.skipped) return null;
  }
}

const providerHeaders = (p: ProviderConfig) => Object.fromEntries(Object.entries(p.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]));
const textOf = (c: unknown): string => (Array.isArray(c) ? c.map((x) => (x?.type === 'text' ? x.text : '')).join('') : String(c ?? ''));

/**
 * OpenAI-compatible chat completions. Prefix caching is automatic on OpenAI / DeepSeek / Kimi / Qwen etc., so the
 * request is kept prefix-stable: same system text, same tool list in every round (tool_choice=none ends the loop
 * instead of dropping the tools), history appended only at the end.
 */
function openaiAdapter(p: ProviderConfig, agent: AgentConfig, system: string, ts: Turn[], tools: ToolImpl[], chat: string): Adapter {
  const base = expandEnv(p.baseUrl).replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers = { authorization: `Bearer ${expandEnv(p.apiKey)}`, ...providerHeaders(p) };
  const messages: any[] = [...(system ? [{ role: 'system', content: system }] : []), ...openaiTurns(ts, agent)];
  const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  // OpenAI routes requests with the same key to the same cache; other compatible APIs may reject unknown fields.
  let cacheKey: string | undefined;
  try { if (/(^|\.)openai\.com$/.test(new URL(base).hostname)) cacheKey = `wr-${createHash('sha256').update(`${agent.id}\n${chat}`).digest('hex').slice(0, 24)}`; } catch { /* bad URL: fetch reports it */ }
  return {
    async step(final) {
      const body: any = { model: agent.model, messages, temperature: agent.temperature, max_tokens: agent.maxTokens };
      if (toolDefs.length) { body.tools = toolDefs; if (final) body.tool_choice = 'none'; }
      if (cacheKey) body.prompt_cache_key = cacheKey;
      const res = await postJson(url, headers, body);
      const msg = res.choices?.[0]?.message;
      if (!msg) throw new Error(`无效响应：${short(JSON.stringify(res), 300)}`);
      const calls: ToolCall[] = final ? [] : (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function?.name, args: c.function?.arguments }));
      if (calls.length) messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls, ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}) });
      const u = res.usage ?? {};
      return {
        text: textOf(msg.content), calls,
        // cached_tokens: OpenAI / Kimi / Qwen; prompt_cache_hit_tokens: DeepSeek.
        usage: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cacheRead: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0, cacheWrite: 0 },
      };
    },
    addResults(results) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.call.id, content: r.content });
    },
  };
}

const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * Anthropic Messages API with explicit prompt caching: breakpoints on the tool list, the system prompt and the
 * last message (moved forward every round), i.e. 3 of the 4 allowed. Earlier rounds / runs are found by the
 * API's prefix lookback, so each round only pays for the new tool results.
 */
function anthropicAdapter(p: ProviderConfig, agent: AgentConfig, system: string, ts: Turn[], tools: ToolImpl[]): Adapter {
  const url = `${expandEnv(p.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`;
  const headers = { 'x-api-key': expandEnv(p.apiKey), 'anthropic-version': '2023-06-01', ...providerHeaders(p) };
  const toolDefs = tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...(i === tools.length - 1 ? { cache_control: EPHEMERAL } : {}) }));
  const sys = system ? [{ type: 'text', text: system, cache_control: EPHEMERAL }] : undefined;
  const messages: any[] = anthropicTurns(ts);
  let marked: any = null;
  const lastBlocks = () => {
    const last = messages[messages.length - 1];
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    return last.content as any[];
  };
  return {
    async step(final) {
      // Changing tool_choice would invalidate the cached messages, so the last round is requested in text instead.
      if (final && toolDefs.length && messages.length > 1) lastBlocks().push({ type: 'text', text: '（工具调用次数已用完：不要再调用工具，直接给出最终回复。）' });
      if (marked) delete marked.cache_control;
      const blocks = lastBlocks();
      marked = blocks[blocks.length - 1];
      marked.cache_control = EPHEMERAL;
      const body: any = { model: agent.model, max_tokens: agent.maxTokens ?? 1024, temperature: agent.temperature, messages, ...(sys ? { system: sys } : {}) };
      if (toolDefs.length) body.tools = toolDefs;
      let res = await postJson(url, headers, body);
      // Still calling tools on the last round: its text is only a preamble ("让我查一下"), force a text answer.
      if (final && toolDefs.length && (res.content ?? []).some((b: any) => b.type === 'tool_use')) res = await postJson(url, headers, { ...body, tool_choice: { type: 'none' } });
      const content: any[] = res.content ?? [];
      const calls: ToolCall[] = final ? [] : content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input }));
      if (calls.length) messages.push({ role: 'assistant', content });
      const u = res.usage ?? {};
      const cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
      return {
        text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''), calls,
        usage: { input: (u.input_tokens ?? 0) + cacheRead + cacheWrite, output: u.output_tokens ?? 0, cacheRead, cacheWrite },
      };
    },
    addResults(results) {
      messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) });
    },
  };
}

/** harness id + chat → CLI session id, so each chat keeps its own context inside the harness. */
const harnessSessions = new Map<string, { id: string; started: boolean }>();

/** Env of this process minus variables that would tie a child CodeBuddy / Claude Code to a parent session. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(SERVER__PORT|CODEBUDDY_(SESSION_ID|CONVERSATION_|ROOT_REQUEST_ID|PROJECT_DIR|SERVICE_PROXY_URL)|CLAUDE_(SESSION_ID|PROJECT_DIR)|CLAUDECODE)/.test(k)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) env[k] = expandEnv(v);
  return env;
}

function exec(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number }): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(opts.input ?? '');
  });
}

function parseCliResult(out: string): { text: string; sessionId?: string; error?: string } {
  const pick = (r: any) => (r && r.type === 'result' ? { text: String(r.result ?? ''), sessionId: r.session_id, error: r.is_error ? String(r.result ?? 'error') : undefined } : null);
  try {
    const j = JSON.parse(out);
    const found = Array.isArray(j) ? [...j].reverse().map(pick).find(Boolean) : pick(j);
    if (found) return found;
  } catch { /* stream / plain text */ }
  for (const line of out.trim().split('\n').reverse()) { try { const r = pick(JSON.parse(line)); if (r) return r; } catch { /* skip */ } }
  return { text: out.trim() };
}

async function runHarness(cfg: AppConfig, h: HarnessConfig, agent: AgentConfig, system: string, input: AgentInput, limit: number, trace: string[], raw?: string): Promise<string> {
  const cwd = h.cwd ? expandEnv(h.cwd) : join(DATA_DIR, 'harness', h.id);
  mkdirSync(cwd, { recursive: true });
  const env = cleanEnv(h.env);
  const prompt = raw ?? transcript(input, agent, limit);

  if (h.type === 'command') {
    const args = h.args.map((a) => render(a, { chat: input.chat, system, model: h.model ?? '' }));
    trace.push(`$ ${h.command} ${args.join(' ')}`);
    const r = await exec(h.command, args, { cwd, env, input: `${system}\n\n${prompt}`, timeoutMs: h.timeoutMs });
    if (r.code !== 0) throw new Error(`harness exit ${r.code}: ${short(r.err || r.out, 400)}`);
    return r.out.trim();
  }

  // codebuddy / claude-code: same headless interface.
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', system];
  if (h.model) args.push('--model', h.model);
  if (h.passMcpServers) {
    const servers = cfg.mcpServers.filter((s) => s.enabled && agent.tools.includes(`mcp:${s.id}`));
    if (servers.length) {
      const mcpServers = Object.fromEntries(servers.map((s) => [s.id, s.url
        ? { type: 'http', url: expandEnv(s.url), headers: s.headers }
        : { command: s.command, args: s.args ?? [], env: s.env ?? {} }]));
      args.push('--mcp-config', JSON.stringify({ mcpServers }));
    }
  }
  const key = `${h.id}:${input.chat}`;
  let session = h.sessionPerChat && raw === undefined ? harnessSessions.get(key) : undefined;
  if (h.sessionPerChat && raw === undefined) {
    if (!session) { session = { id: randomUUID(), started: false }; harnessSessions.set(key, session); }
    args.push(...(session.started ? ['--resume', session.id] : ['--session-id', session.id]));
  } else {
    args.push('--no-session-persistence');
  }
  args.push(...h.args);
  // With a resumed session the harness already knows the earlier conversation: only send the new messages.
  const body = session?.started
    ? `${timeNote()}\n新消息：\n${input.incoming.map((m) => `${speaker(m, input.chat, input.isGroup)}: ${lineText(m, agent)}`).join('\n')}\n\n请直接输出回复正文；不需要回复则只输出 [SKIP]。`
    : prompt;
  args.push(body);
  trace.push(`$ ${h.command} ${args.slice(0, -1).map((a) => (a.length > 60 ? `'${a.slice(0, 57)}…'` : a)).join(' ')} <prompt>`);
  const r = await exec(h.command, args, { cwd, env, timeoutMs: h.timeoutMs });
  const parsed = parseCliResult(r.out);
  if (r.code !== 0 || parsed.error) {
    if (session) harnessSessions.delete(key);
    throw new Error(`harness exit ${r.code}: ${short(parsed.error || r.err || r.out, 400)}`);
  }
  if (session) session.started = true;
  return parsed.text;
}

export async function runAgent(cfg: AppConfig, agentId: string, input: AgentInput): Promise<AgentOutput> {
  const agent = cfg.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`未找到 agent「${agentId}」`);
  const trace: string[] = [];
  const system = systemPrompt(cfg, agent, input);
  const ctx: ToolCtx = { chat: input.chat, isGroup: input.isGroup, history: input.allHistory ?? input.history, skipped: null };
  const limit = cfg.general.historyLimit;

  if (agent.engine === 'harness') {
    const h = cfg.harnesses.find((x) => x.id === agent.harness);
    if (!h) throw new Error(`未找到 harness「${agent.harness}」`);
    return finish(await runHarness(cfg, h, agent, system, input, limit, trace), ctx, trace);
  }

  const p = cfg.providers.find((x) => x.id === agent.provider);
  if (!p) throw new Error(`未找到模型服务「${agent.provider}」`);
  if (!agent.model) throw new Error(`agent「${agent.id}」未设置 model`);
  const resolved = await resolveTools(cfg, agent);
  const tools = agent.maxToolRounds > 0 ? resolved : [];
  if (tools.length) trace.push(`tools: ${tools.map((t) => t.name).join(', ')}`);
  const run = (a: AgentConfig) => {
    const ts = turns(input, a, limit);
    if (countImages(ts)) trace.push(`images: ${countImages(ts)}`);
    const ad = p.type === 'anthropic' ? anthropicAdapter(p, a, system, ts, tools) : openaiAdapter(p, a, system, ts, tools, input.chat);
    return agentLoop(ad, tools.length ? a.maxToolRounds : 0, tools, ctx, trace);
  };
  let text: string | null;
  try {
    text = await run(agent);
  } catch (e) {
    // Model turned out not to accept images: fall back to the OCR text of the pictures.
    if (!agent.vision || !/HTTP 4\d\d/.test(errText(e)) || !/image|vision|multimodal|图片|多模态/i.test(errText(e))) throw e;
    trace.push(`model rejected images, retrying with OCR text: ${short(errText(e), 160)}`);
    text = await run({ ...agent, vision: false });
  }
  return finish(text, ctx, trace);
}

/**
 * One-off text completion with an agent's model / harness (no tools, no chat transcript): used for jobs like writing a
 * chat persona. `system` replaces the agent's own prompts.
 */
export async function completeText(cfg: AppConfig, agentId: string, system: string, user: string, maxTokens = 2000): Promise<string> {
  const base = cfg.agents.find((a) => a.id === agentId);
  if (!base) throw new Error(`未找到 agent「${agentId}」`);
  const agent: AgentConfig = { ...base, vision: false, temperature: 0.3, maxTokens: Math.max(maxTokens, base.maxTokens ?? 0) };
  const trace: string[] = [];
  const input: AgentInput = { chat: '', isGroup: false, history: [], incoming: [] };
  if (agent.engine === 'harness') {
    const h = cfg.harnesses.find((x) => x.id === agent.harness);
    if (!h) throw new Error(`未找到 harness「${agent.harness}」`);
    return (await runHarness(cfg, h, agent, system, input, 0, trace, user)).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  const p = cfg.providers.find((x) => x.id === agent.provider);
  if (!p) throw new Error(`未找到模型服务「${agent.provider}」`);
  if (!agent.model) throw new Error(`agent「${agent.id}」未设置 model`);
  const ts: Turn[] = [{ role: 'user', parts: [{ type: 'text', text: user }] }];
  const ad = p.type === 'anthropic' ? anthropicAdapter(p, agent, system, ts, []) : openaiAdapter(p, agent, system, ts, [], 'persona');
  const text = await agentLoop(ad, 0, [], { chat: '', isGroup: false, history: [], skipped: null }, trace);
  return (text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
