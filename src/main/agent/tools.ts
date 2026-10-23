import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { AgentConfig, AppConfig, ChatMessage, McpServerConfig, ToolConfig } from '@shared/types';
import { expandEnv } from '../config';
import { errText, logger, nowText } from '../util';

const log = logger.scope('tools');

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCtx { chat: string; isGroup: boolean; history: ChatMessage[]; skipped: { reason?: string } | null }
export interface ToolImpl extends ToolDef { run(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> }

const shellQuote = (v: unknown) => `'${String(typeof v === 'object' ? JSON.stringify(v) : v ?? '').replace(/'/g, `'\\''`)}'`;

function runCommand(tool: ToolConfig, args: Record<string, unknown>): Promise<string> {
  const cmd = tool.command.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => shellQuote(args[k]));
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd: tool.cwd || undefined,
      env: { ...process.env, TOOL_ARGS: JSON.stringify(args) },
      timeout: tool.timeoutMs,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve((out || err || `(exit ${code})`).slice(0, 8000)));
    child.on('error', (e) => resolve(`error: ${e.message}`));
  });
}

const BUILTINS: Record<string, ToolImpl> = {
  'builtin:time': {
    name: 'get_current_time', description: '获取当前日期、星期和时间', parameters: { type: 'object', properties: {} },
    run: async () => nowText(),
  },
  'builtin:history': {
    name: 'get_chat_history', description: '读取当前会话更早的聊天记录', parameters: {
      type: 'object', properties: { limit: { type: 'integer', description: '条数，默认 50' } },
    },
    run: async (args, ctx) => ctx.history.slice(-Number(args.limit ?? 50))
      .map((m) => `${m.side === 'self' ? '我' : m.sender || ctx.chat}: ${m.text}`).join('\n') || '(无记录)',
  },
  'builtin:skip': {
    name: 'skip_reply', description: '决定不回复这条消息（无需回复、与我无关、不适合自动回复时调用）', parameters: {
      type: 'object', properties: { reason: { type: 'string' } },
    },
    run: async (args, ctx) => { ctx.skipped = { reason: String(args.reason ?? '') }; return 'ok, no reply will be sent'; },
  },
};

export const BUILTIN_TOOL_IDS = Object.keys(BUILTINS);

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

/** Resolves an agent's tool list: builtin:*, custom command tool ids, mcp:<server id>. */
export async function resolveTools(cfg: AppConfig, agent: AgentConfig): Promise<ToolImpl[]> {
  const out: ToolImpl[] = [];
  for (const id of agent.tools ?? []) {
    try {
      if (BUILTINS[id]) { out.push(BUILTINS[id]); continue; }
      if (id.startsWith('mcp:')) {
        const s = cfg.mcpServers.find((x) => x.id === id.slice(4));
        if (!s) throw new Error('未定义');
        if (!s.enabled) continue;
        out.push(...(await mcpPool.tools(s)));
        continue;
      }
      const t = cfg.tools.find((x) => x.id === id);
      if (!t) throw new Error('未定义');
      out.push({ name: t.id.replace(/[^a-zA-Z0-9_-]/g, '_'), description: t.description, parameters: t.parameters, run: (args) => runCommand(t, args) });
    } catch (e) {
      log.warn(`工具 ${id} 不可用：${errText(e)}`);
    }
  }
  return out;
}
