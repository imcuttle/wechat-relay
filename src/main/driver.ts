import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DriverConfig } from '@shared/types';
import { errText, logger } from './util';

const log = logger.scope('driver');

/** Locate a cua-driver MCP entry point: CodeBuddy Desktop bundle, CodeBuddy plugin cache, or `cua-driver` on PATH. */
export function resolveDriver(cfg: DriverConfig): { command: string; args: string[] } | null {
  if (cfg.command && cfg.command !== 'auto') return { command: cfg.command, args: cfg.args ?? [] };
  const candidates = [
    '/Applications/CodeBuddy Desktop.app/Contents/Resources/plugins/cua-driver/bin/cua-driver-mcp',
    '/Applications/CodeBuddy.app/Contents/Resources/plugins/cua-driver/bin/cua-driver-mcp',
    '/Applications/WorkBuddy.app/Contents/Resources/plugins/cua-driver/bin/cua-driver-mcp',
  ];
  const cache = join(homedir(), '.codebuddy', 'plugins', 'cache');
  try {
    for (const market of readdirSync(cache)) {
      const dir = join(cache, market, 'cua-driver');
      if (!existsSync(dir)) continue;
      for (const v of readdirSync(dir).sort().reverse()) candidates.push(join(dir, v, 'bin', 'cua-driver-mcp'));
    }
  } catch { /* no cache */ }
  for (const c of candidates) if (existsSync(c)) return { command: c, args: [] };
  for (const p of (process.env.PATH ?? '').split(':')) {
    const bin = join(p, 'cua-driver');
    if (p && existsSync(bin)) return { command: bin, args: ['mcp'] };
  }
  for (const bin of ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver', join(homedir(), '.local/bin/cua-driver')]) {
    if (existsSync(bin)) return { command: bin, args: ['mcp'] };
  }
  return null;
}

export interface ToolResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/** MCP stdio client for the Cua Driver (background AX / screenshot / input for native macOS apps). */
export class CuaDriver {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Driver sessions are ended for good when their owner disconnects, so each connection gets a fresh label. */
  private session = '';
  constructor(private cfg: DriverConfig) {}

  setConfig(cfg: DriverConfig): void {
    const changed = cfg.command !== this.cfg.command || JSON.stringify(cfg.args) !== JSON.stringify(this.cfg.args);
    this.cfg = cfg;
    if (changed) void this.close();
  }

  get deliveryMode() { return this.cfg.deliveryMode; }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const entry = resolveDriver(this.cfg);
      if (!entry) throw new Error('找不到 cua-driver：请安装 CodeBuddy Desktop，或在配置 driver.command 中指定 cua-driver-mcp 路径');
      log.info(`starting ${entry.command} ${entry.args.join(' ')}`);
      const transport = new StdioClientTransport({ command: entry.command, args: entry.args, stderr: 'pipe' });
      transport.stderr?.on('data', (d: Buffer) => log.debug(d.toString().trim()));
      const client = new Client({ name: 'wechat-relay', version: '0.1.0' });
      client.onclose = () => { if (this.client === client) { this.client = null; log.warn('driver connection closed'); } };
      await client.connect(transport);
      this.session = `wechat-relay-${process.pid}-${Date.now().toString(36)}`;
      await client.callTool({ name: 'start_session', arguments: { session: this.session } }).catch((e) => log.debug(`start_session: ${errText(e)}`));
      this.client = client;
      return client;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 30000, retried = false): Promise<ToolResult> {
    const client = await this.connect();
    try {
      const res = (await client.callTool({ name, arguments: { session: this.session, ...args } }, undefined, { timeout: timeoutMs })) as ToolResult;
      if (res.isError) throw new Error(`${name}: ${text(res) || 'failed'}`);
      return res;
    } catch (e) {
      const m = errText(e);
      if (/closed|not connected|EPIPE/i.test(m)) this.client = null;
      if (!retried && /session has ended|unknown session|start_session/i.test(m)) {
        await this.close();
        return this.call(name, args, timeoutMs, true);
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    const c = this.client; this.client = null;
    if (c && this.session) await c.callTool({ name: 'end_session', arguments: { session: this.session } }).catch(() => undefined);
    try { await c?.close(); } catch { /* ignore */ }
  }
}

export function text(r: ToolResult): string {
  return (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

export function structured<T = Record<string, unknown>>(r: ToolResult): T {
  if (r.structuredContent) return r.structuredContent as T;
  try { return JSON.parse(text(r)) as T; } catch { return {} as T; }
}
