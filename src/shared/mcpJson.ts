import type { McpServerConfig } from './types';

type JsonServer = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; serverUrl?: string; type?: string; headers?: Record<string, string>; disabled?: boolean };

/** Current servers as the common `{ "mcpServers": { id: {...} } }` format (Claude Code / Cursor / CodeBuddy). */
export function toMcpJson(servers: McpServerConfig[]): string {
  const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
  return JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((s) => [s.id, strip(s.url
      ? { type: 'http', url: s.url, headers: s.headers, disabled: s.enabled ? undefined : true }
      : { command: s.command, args: s.args, env: s.env, disabled: s.enabled ? undefined : true })])),
  }, null, 2);
}

/** Accepts `{ mcpServers: {...} }` or the bare server map. Throws with a readable message on invalid input. */
export function fromMcpJson(text: string): McpServerConfig[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`JSON 格式错误：${(e as Error).message}`); }
  const map = (raw && typeof raw === 'object' && 'mcpServers' in raw ? (raw as { mcpServers: unknown }).mcpServers : raw) as Record<string, JsonServer>;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('应为 { "mcpServers": { "<id>": { ... } } }');
  return Object.entries(map).map(([id, v]) => {
    if (!v || typeof v !== 'object') throw new Error(`「${id}」不是对象`);
    const url = v.url ?? v.serverUrl;
    if (!url && !v.command) throw new Error(`「${id}」需要 command（stdio）或 url（HTTP / SSE）`);
    if (v.args !== undefined && !Array.isArray(v.args)) throw new Error(`「${id}」的 args 应为数组`);
    return url
      ? { id, enabled: !v.disabled, url, headers: v.headers }
      : { id, enabled: !v.disabled, command: v.command, args: (v.args ?? []).map(String), env: v.env };
  });
}
