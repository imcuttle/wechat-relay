import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { builtinEnabled } from '@shared/builtins';
import type { AgentConfig, AppConfig, ChatMessage, McpServerConfig, ToolConfig } from '@shared/types';
import { expandEnv, knowledgeDirs } from '../config';
import { errText, logger } from '../util';
import { BUILTINS, runProcess, scopedFileTools } from './builtins';
import { prepareScriptTool, runScriptTool } from './scriptTools';

const log = logger.scope('tools');

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCtx { chat: string; isGroup: boolean; history: ChatMessage[]; skipped: { reason?: string } | null }
export interface ToolImpl extends ToolDef { run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> }

const shellQuote = (v: unknown) => `'${String(typeof v === 'object' ? JSON.stringify(v) : v ?? '').replace(/'/g, `'\\''`)}'`;

async function runCommand(tool: ToolConfig, args: Record<string, unknown>): Promise<string> {
  const cmd = (tool.command ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => shellQuote(args[k]));
  const r = await runProcess('/bin/sh', ['-c', cmd], {
    cwd: tool.cwd || undefined,
    env: { ...process.env, TOOL_ARGS: JSON.stringify(args) },
    timeoutMs: tool.timeoutMs,
  });
  return (r.out || r.err || `(exit ${r.code})`).slice(0, 8000);
}

/** Connected MCP servers, reused across agent runs and reset on config change. */
class McpPool {
  private clients = new Map<string, Promise<Client>>();
  private sig = new Map<string, string>();

  private connect(s: McpServerConfig): Promise<Client> {
    const key = JSON.stringify(s);
    if (this.sig.get(s.id) !== key) { void this.drop(s.id); this.sig.set(s.id, key); }
    let p = this.clients.get(s.id);
    if (!p) {
      p = (async () => {
        const client = new Client({ name: 'wechat-relay', version: '0.1.0' });
        const headers = Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]));
        if (s.url) {
          const url = new URL(expandEnv(s.url));
          try {
            await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
          } catch {
            await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
          }
        } else if (s.command) {
          const env = Object.fromEntries(Object.entries({ ...process.env, ...(s.env ?? {}) }).map(([k, v]) => [k, expandEnv(String(v ?? ''))]));
          await client.connect(new StdioClientTransport({ command: s.command, args: s.args ?? [], env, stderr: 'ignore' }));
        } else throw new Error(`MCP server ${s.id} 缺少 command 或 url`);
        client.onclose = () => { this.clients.delete(s.id); };
        log.info(`MCP ${s.id} connected`);
        return client;
      })();
      p.catch(() => this.clients.delete(s.id));
      this.clients.set(s.id, p);
    }
    return p;
  }

  async drop(id: string): Promise<void> {
    const p = this.clients.get(id);
    this.clients.delete(id);
    try { await (await p)?.close(); } catch { /* ignore */ }
  }

  async closeAll(): Promise<void> { await Promise.all([...this.clients.keys()].map((id) => this.drop(id))); }

  async tools(s: McpServerConfig): Promise<ToolImpl[]> {
    const client = await this.connect(s);
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: `${s.id}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      description: t.description ?? t.name,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      run: async (args) => {
        const r = await client.callTool({ name: t.name, arguments: args });
        const content = (r.content as Array<{ type: string; text?: string }>) ?? [];
        return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n').slice(0, 12000) || JSON.stringify(r.structuredContent ?? {});
      },
    }));
  }
}

export const mcpPool = new McpPool();

/** Built-ins a harness CLI already has natively (Read / Write / Edit / Glob / Grep / LS / Bash / WebFetch). */
const NATIVE_IN_HARNESS = new Set(['builtin:read', 'builtin:write', 'builtin:edit', 'builtin:glob', 'builtin:grep', 'builtin:ls', 'builtin:bash', 'builtin:fetch']);

/**
 * Resolves an agent's tool list: builtin:*, custom tool ids, mcp:<server id>.
 * A tool is used only when the agent selects it AND it is enabled globally.
 * Model agents also get Read / Write / Edit / Glob / Grep limited to the memory / skill directories whenever either is
 * on (selected or not). For `harness` the result is what the proxy MCP server serves: no external MCP servers (they are
 * passed straight to the CLI) and no built-ins the CLI has itself.
 */
export async function resolveTools(cfg: AppConfig, agent: AgentConfig, opts: { harness?: boolean } = {}): Promise<ToolImpl[]> {
  const out: ToolImpl[] = [];
  for (const id of agent.tools ?? []) {
    try {
      if (id.startsWith('builtin:')) {
        if (!BUILTINS[id]) throw new Error('未定义');
        if (opts.harness && NATIVE_IN_HARNESS.has(id)) continue;
        if (builtinEnabled(cfg.builtinTools, id)) out.push(BUILTINS[id]);
        continue;
      }
      if (id.startsWith('mcp:')) {
        if (opts.harness) continue;
        const s = cfg.mcpServers.find((x) => x.id === id.slice(4));
        if (!s) throw new Error('未定义');
        if (!s.enabled) continue;
        out.push(...(await mcpPool.tools(s)));
        continue;
      }
      const t = cfg.tools.find((x) => x.id === id);
      if (!t) throw new Error('未定义');
      if (t.enabled === false) continue;
      const def = { name: t.id.replace(/[^a-zA-Z0-9_-]/g, '_'), description: t.description, parameters: t.parameters };
      if (t.type === 'script') {
        await prepareScriptTool(t);
        out.push({ ...def, run: (args, ctx) => runScriptTool(t, args, ctx) });
      } else {
        out.push({ ...def, run: (args) => runCommand(t, args) });
      }
    } catch (e) {
      log.warn(`工具 ${id} 不可用：${errText(e)}`);
    }
  }
  const dirs = knowledgeDirs(cfg);
  if (dirs.length && !opts.harness) {
    for (const t of scopedFileTools(dirs)) if (!out.some((x) => x.name === t.name)) out.push(t);
  }
  return out;
}
