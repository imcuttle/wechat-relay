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
