import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, AppConfig, ChatMessage, HarnessConfig, ProviderConfig } from '@shared/types';
import { DATA_DIR, expandEnv } from '../config';
import { errText, nowText, render } from '../util';
import { resolveTools, type ToolCtx, type ToolImpl } from './tools';

export interface AgentInput {
  chat: string;
  isGroup: boolean;
  /** Full stored history including the new messages. */
  history: ChatMessage[];
  /** The new messages that triggered this run. */
  incoming: ChatMessage[];
}

export interface AgentOutput { reply: string | null; skipped: boolean; reason?: string; trace: string[] }

const SKIP_RE = /^\s*\[?\s*(SKIP|NO_REPLY|不回复)\s*\]?\s*$/i;

function speaker(m: ChatMessage, chat: string, isGroup: boolean): string {
  return m.side === 'self' ? '我' : isGroup ? m.sender || '群成员' : chat;
}

function systemPrompt(cfg: AppConfig, agent: AgentConfig, input: AgentInput): string {
  const last = input.incoming[input.incoming.length - 1];
  const vars = {
    chat: input.chat,
    group: input.isGroup,
    private: !input.isGroup,
    sender: last ? speaker(last, input.chat, input.isGroup) : '',
    myNickname: cfg.general.myNickname || '我',
    now: nowText(),
  };
  const base = agent.prompt ? cfg.prompts.find((p) => p.id === agent.prompt)?.content ?? '' : '';
  return render([base, agent.systemPrompt ?? ''].filter((s) => s.trim()).join('\n\n'), vars).trim();
}

/** Conversation as alternating user/assistant turns (other → user, self → assistant). */
function turns(input: AgentInput, limit: number): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of input.history.slice(-limit)) {
    const role = m.side === 'self' ? 'assistant' : 'user';
    const content = role === 'user' && input.isGroup ? `${m.sender || '群成员'}: ${m.text}` : m.text;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content += `\n${content}`; else out.push({ role, content });
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') {
    out.push({ role: 'user', content: input.incoming.map((m) => m.text).join('\n') || '(无新消息)' });
  }
  return out;
}

function transcript(input: AgentInput, limit: number): string {
  const lines = input.history.slice(-limit).map((m) => `${speaker(m, input.chat, input.isGroup)}: ${m.text}`);
  return `以下是与「${input.chat}」的微信${input.isGroup ? '群聊' : '聊天'}记录（最后几条是需要你回复的新消息）：\n\n${lines.join('\n')}\n\n` +
    `请直接输出要发送的回复正文，不要任何解释或前缀。如果不需要回复，只输出 [SKIP]。`;
}

function finish(text: string | null | undefined, ctx: ToolCtx, trace: string[]): AgentOutput {
  if (ctx.skipped) return { reply: null, skipped: true, reason: ctx.skipped.reason, trace };
  const t = (text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!t || SKIP_RE.test(t)) return { reply: null, skipped: true, reason: t ? 'model returned SKIP' : 'empty reply', trace };
  return { reply: t, skipped: false, trace };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 120000): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 500)}`);
  return JSON.parse(raw);
}

const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function runTool(tools: ToolImpl[], name: string, rawArgs: unknown, ctx: ToolCtx, trace: string[]): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  let args: Record<string, unknown> = {};
  try { args = typeof rawArgs === 'string' ? (rawArgs ? JSON.parse(rawArgs) : {}) : ((rawArgs as Record<string, unknown>) ?? {}); } catch { /* keep {} */ }
  let result: string;
  try { result = tool ? await tool.run(args, ctx) : `unknown tool ${name}`; } catch (e) { result = `error: ${errText(e)}`; }
  trace.push(`tool ${name}(${short(JSON.stringify(args), 120)}) → ${short(result)}`);
  return result;
}

async function runOpenAI(p: ProviderConfig, agent: AgentConfig, system: string, input: AgentInput, tools: ToolImpl[], ctx: ToolCtx, limit: number, trace: string[]): Promise<string | null> {
  const url = `${expandEnv(p.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const headers = { authorization: `Bearer ${expandEnv(p.apiKey)}`, ...Object.fromEntries(Object.entries(p.headers ?? {}).map(([k, v]) => [k, expandEnv(v)])) };
  const messages: any[] = [{ role: 'system', content: system }, ...turns(input, limit)];
  for (let round = 0; round <= agent.maxToolRounds; round++) {
    const body: any = { model: agent.model, messages, temperature: agent.temperature, max_tokens: agent.maxTokens };
    if (tools.length && round < agent.maxToolRounds) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const res = await postJson(url, headers, body);
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error(`无效响应：${short(JSON.stringify(res), 300)}`);
    if (!msg.tool_calls?.length) return msg.content ?? '';
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls, ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}) });
    for (const call of msg.tool_calls) {
      const out = await runTool(tools, call.function?.name, call.function?.arguments, ctx, trace);
      messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
    if (ctx.skipped) return null;
  }
  return null;
}

async function runAnthropic(p: ProviderConfig, agent: AgentConfig, system: string, input: AgentInput, tools: ToolImpl[], ctx: ToolCtx, limit: number, trace: string[]): Promise<string | null> {
  const url = `${expandEnv(p.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/messages`;
  const headers = { 'x-api-key': expandEnv(p.apiKey), 'anthropic-version': '2023-06-01', ...Object.fromEntries(Object.entries(p.headers ?? {}).map(([k, v]) => [k, expandEnv(v)])) };
  const messages: any[] = turns(input, limit);
  for (let round = 0; round <= agent.maxToolRounds; round++) {
    const body: any = { model: agent.model, system, messages, max_tokens: agent.maxTokens ?? 1024, temperature: agent.temperature };
    if (tools.length && round < agent.maxToolRounds) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const res = await postJson(url, headers, body);
    const blocks: any[] = res.content ?? [];
    const uses = blocks.filter((b) => b.type === 'tool_use');
    if (!uses.length) return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(tools, u.name, u.input, ctx, trace) });
    messages.push({ role: 'user', content: results });
    if (ctx.skipped) return null;
  }
  return null;
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

async function runHarness(cfg: AppConfig, h: HarnessConfig, agent: AgentConfig, system: string, input: AgentInput, limit: number, trace: string[]): Promise<string> {
  const cwd = h.cwd ? expandEnv(h.cwd) : join(DATA_DIR, 'harness', h.id);
  mkdirSync(cwd, { recursive: true });
  const env = cleanEnv(h.env);
  const prompt = transcript(input, limit);

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
  let session = h.sessionPerChat ? harnessSessions.get(key) : undefined;
  if (h.sessionPerChat) {
    if (!session) { session = { id: randomUUID(), started: false }; harnessSessions.set(key, session); }
    args.push(...(session.started ? ['--resume', session.id] : ['--session-id', session.id]));
  } else {
    args.push('--no-session-persistence');
  }
  args.push(...h.args);
  // With a resumed session the harness already knows the earlier conversation: only send the new messages.
  const body = session?.started
    ? `新消息：\n${input.incoming.map((m) => `${speaker(m, input.chat, input.isGroup)}: ${m.text}`).join('\n')}\n\n请直接输出回复正文；不需要回复则只输出 [SKIP]。`
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
  const ctx: ToolCtx = { chat: input.chat, isGroup: input.isGroup, history: input.history, skipped: null };
  const limit = cfg.general.historyLimit;

  if (agent.engine === 'harness') {
    const h = cfg.harnesses.find((x) => x.id === agent.harness);
    if (!h) throw new Error(`未找到 harness「${agent.harness}」`);
    return finish(await runHarness(cfg, h, agent, system, input, limit, trace), ctx, trace);
  }

  const p = cfg.providers.find((x) => x.id === agent.provider);
  if (!p) throw new Error(`未找到模型服务「${agent.provider}」`);
  if (!agent.model) throw new Error(`agent「${agent.id}」未设置 model`);
  const tools = await resolveTools(cfg, agent);
  if (tools.length) trace.push(`tools: ${tools.map((t) => t.name).join(', ')}`);
  const text = p.type === 'anthropic'
    ? await runAnthropic(p, agent, system, input, tools, ctx, limit, trace)
    : await runOpenAI(p, agent, system, input, tools, ctx, limit, trace);
  return finish(text, ctx, trace);
}
