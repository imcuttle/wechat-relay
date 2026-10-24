import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from '@shared/types';
import { DATA_DIR } from './config';

const LOG_DIR = join(DATA_DIR, 'logs');
/** JSON lines; rotated to relay.log.1 at MAX_BYTES so a restart can pick up where the last run left off. */
const LOG_FILE = join(LOG_DIR, 'relay.log');
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP = 2000;

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

class Logger extends EventEmitter {
  private buf: LogEntry[] = [];
  private size = 0;

  constructor() {
    super();
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      const lines = [`${LOG_FILE}.1`, LOG_FILE].flatMap((f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []));
      for (const l of lines.slice(-KEEP * 2)) {
        try { if (l) this.buf.push(JSON.parse(l) as LogEntry); } catch { /* torn line from a crash */ }
      }
      this.buf.splice(0, this.buf.length - KEEP);
      this.size = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
      if (lines.length && lines[lines.length - 1] !== '') this.persistRaw('\n');
    } catch (e) {
      console.error(`读取历史日志失败：${errText(e)}`);
    }
  }

  private persist(entry: LogEntry): void {
    this.persistRaw(`${JSON.stringify(entry)}\n`);
  }

  private persistRaw(line: string): void {
    try {
      const bytes = Buffer.byteLength(line);
      if (this.size + bytes > MAX_BYTES) { renameSync(LOG_FILE, `${LOG_FILE}.1`); this.size = 0; }
      // Sync on purpose: the entries right before a crash are the ones worth keeping.
      appendFileSync(LOG_FILE, line);
      this.size += bytes;
    } catch (e) {
      console.error(`写日志失败：${errText(e)}`);
    }
  }

  private push(level: LogEntry['level'], scope: string, message: string): void {
    const entry: LogEntry = { at: Date.now(), level, scope, message };
    this.buf.push(entry);
    if (this.buf.length > KEEP) this.buf.splice(0, this.buf.length - KEEP);
    this.persist(entry);
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
