import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ChatSummary, Draft } from '@shared/types';
import { DATA_DIR } from './config';

const FILE = join(DATA_DIR, 'state.json');
const MAX_PER_CHAT = 300;

interface ChatState { isGroup: boolean; paused: boolean; messages: ChatMessage[]; lastReplyAt?: Record<string, number> }
interface State { chats: Record<string, ChatState>; drafts: Draft[] }

/** Persisted chat history (as seen on screen + sent by the bot) and reply drafts. */
class Store {
  private s: State = { chats: {}, drafts: [] };
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;

  load(): void {
    if (existsSync(FILE)) {
      try { this.s = { chats: {}, drafts: [], ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { /* corrupt: start fresh */ }
    }
  }

  private save(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => writeFileSync(FILE, JSON.stringify(this.s)), 500);
  }

  flush(): void { clearTimeout(this.timer); writeFileSync(FILE, JSON.stringify(this.s)); }

  id(): string { return `${Date.now().toString(36)}${(this.seq++).toString(36)}`; }

  chat(name: string): ChatState | undefined { return this.s.chats[name]; }

  ensure(name: string, isGroup: boolean): ChatState {
    const c = (this.s.chats[name] ??= { isGroup, paused: false, messages: [] });
    if (isGroup) c.isGroup = true;
    return c;
  }

  append(name: string, msgs: ChatMessage[]): void {
    const c = this.s.chats[name];
    if (!c || !msgs.length) return;
    c.messages.push(...msgs);
    if (c.messages.length > MAX_PER_CHAT) c.messages.splice(0, c.messages.length - MAX_PER_CHAT);
    this.save();
  }

  history(name: string): ChatMessage[] { return this.s.chats[name]?.messages ?? []; }

  summaries(): ChatSummary[] {
    return Object.entries(this.s.chats)
      .map(([name, c]) => {
        const last = c.messages[c.messages.length - 1];
        return { name, isGroup: c.isGroup, paused: c.paused, count: c.messages.length, lastAt: last?.at ?? 0, lastText: last?.text ?? '' };
      })
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  setPaused(name: string, paused: boolean): void { this.ensure(name, false).paused = paused; this.save(); }
  clear(name: string): void { delete this.s.chats[name]; this.save(); }

  lastReply(name: string, rule: string): number { return this.s.chats[name]?.lastReplyAt?.[rule] ?? 0; }
  markReply(name: string, rule: string): void {
    const c = this.ensure(name, false);
    (c.lastReplyAt ??= {})[rule] = Date.now();
    this.save();
  }

  drafts(): Draft[] { return this.s.drafts; }
  upsertDraft(d: Draft): void {
    const i = this.s.drafts.findIndex((x) => x.id === d.id);
    if (i >= 0) this.s.drafts[i] = d; else this.s.drafts.unshift(d);
    if (this.s.drafts.length > 200) this.s.drafts.length = 200;
    this.save();
  }
}

export const store = new Store();
