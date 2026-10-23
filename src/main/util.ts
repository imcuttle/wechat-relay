import { EventEmitter } from 'node:events';
import type { LogEntry } from '@shared/types';

class Logger extends EventEmitter {
  private buf: LogEntry[] = [];

  private push(level: LogEntry['level'], scope: string, message: string): void {
    const entry: LogEntry = { at: Date.now(), level, scope, message };
    this.buf.push(entry);
    if (this.buf.length > 2000) this.buf.splice(0, this.buf.length - 2000);
    const line = `[${new Date(entry.at).toLocaleTimeString()}] ${level.toUpperCase()} ${scope}: ${message}`;
    if (level === 'error') console.error(line); else if (level !== 'debug' || process.env.RELAY_DEBUG) console.log(line);
    this.emit('entry', entry);
  }

  scope(scope: string) {
    return {
      debug: (m: string) => this.push('debug', scope, m),
      info: (m: string) => this.push('info', scope, m),
      warn: (m: string) => this.push('warn', scope, m),
      error: (m: string) => this.push('error', scope, m),
    };
  }

  all(): LogEntry[] { return [...this.buf]; }
}

export const logger = new Logger();

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Minimal mustache: {{var}}, {{#flag}}...{{/flag}}, {{^flag}}...{{/flag}}. */
export function render(tpl: string, vars: Record<string, unknown>): string {
  const sections = tpl.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, kind: string, key: string, body: string) =>
    (kind === '#') === Boolean(vars[key]) ? body : '');
  return sections.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => (vars[key] === undefined ? '' : String(vars[key])));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const nowText = (): string => {
  const d = new Date();
  return `${d.toLocaleString('zh-CN', { hour12: false })} ${d.toLocaleDateString('zh-CN', { weekday: 'long' })}`;
};

/** Date + weekday only (stable for a whole day, used where text must not change between calls). */
export const dateText = (): string => {
  const d = new Date();
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleDateString('zh-CN', { weekday: 'long' })}`;
};

/** WeChat UI overlays that are not messages ("3条新消息" pill, "以下为新消息" divider, jump-to-bottom hints). */
export const isNoiseText = (t: string): boolean => {
  const s = t.replace(/[\s↓⬇⬆↑>〉›]/g, '');
  return /^(有)?\d+条(新|未读)?消息$/.test(s) || /^\d+条@?我?的?消息$/.test(s) ||
    ['以下为新消息', '以下是新消息', '回到最新', '回到底部', '查看最新消息'].includes(s);
};
