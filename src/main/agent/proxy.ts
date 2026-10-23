import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { errText, logger } from '../util';
import type { ToolCtx, ToolImpl } from './tools';

const log = logger.scope('proxy');
const MAX_CALLS = 30;

export interface ProxyRun { tools: ToolImpl[]; ctx: ToolCtx; trace: string[] }

const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * One local MCP server (Streamable HTTP, 127.0.0.1) for the whole app. Each harness run registers its tools and
 * ToolCtx under a random bearer token, so concurrent runs for different chats never see each other's context.
 */
class Proxy {
  private http: HttpServer | null = null;
  private starting: Promise<number> | null = null;
  private runs = new Map<string, ProxyRun & { calls: number }>();

  private start(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const srv = createServer((req, res) => { void this.handle(req, res); });
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        this.http = srv;
        const port = (srv.address() as AddressInfo).port;
        log.info(`proxy MCP 已启动：127.0.0.1:${port}`);
        resolve(port);
      });
    });
    this.starting.catch(() => { this.starting = null; });
    return this.starting;
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const token = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const run = token ? this.runs.get(token) : undefined;
    if (!run) { res.writeHead(401).end('unauthorized'); return; }

    const server = new Server({ name: 'wechat-relay', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: run.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: 'object' } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const name = r.params.name;
      const args = (r.params.arguments ?? {}) as Record<string, unknown>;
      const tool = run.tools.find((t) => t.name === name);
      let text: string, isError = false;
      if (!tool) { text = `error: 没有名为 ${name} 的工具`; isError = true; }
      else if (++run.calls > MAX_CALLS) { text = `error: 单次回复最多调用 ${MAX_CALLS} 次工具`; isError = true; }
      else {
        try { text = await tool.run(args, run.ctx); } catch (e) { text = `error: ${errText(e)}`; }
        if (text.startsWith('error:')) isError = true;
      }
      run.trace.push(`proxy ${name}(${short(JSON.stringify(args), 120)}) → ${short(text)}`);
      return { content: [{ type: 'text' as const, text: text || '(空)' }], ...(isError ? { isError: true } : {}) };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log.warn(`proxy 请求失败：${errText(e)}`);
      if (!res.headersSent) res.writeHead(500).end('error');
    }
  }

  /** Registers a run; `release` must be called when the harness process ended. */
  async register(run: ProxyRun): Promise<{ url: string; token: string; release: () => void }> {
    const port = await this.start();
    const token = randomUUID();
    this.runs.set(token, { ...run, calls: 0 });
    return { url: `http://127.0.0.1:${port}/mcp`, token, release: () => { this.runs.delete(token); } };
  }

  close(): void {
    this.runs.clear();
    this.http?.close();
    this.http = null;
    this.starting = null;
  }
}

export const proxy = new Proxy();
