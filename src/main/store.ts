import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ChatSummary, Draft, Persona, ReplyMode } from '@shared/types';
import { DATA_DIR } from './config';
import { isNoiseText } from './util';

const FILE = join(DATA_DIR, 'state.json');
export const MAX_PER_CHAT = 300;

export function dropImages(msgs: ChatMessage[]): void {
  for (const m of msgs) if (m.image) rmSync(m.image, { force: true });
}

/** The persona text is a prompt in the config; the chat only links to it. */
export type PersonaMeta = Omit<Persona, 'text' | 'own' | 'goodCases' | 'badCases'>;

interface ChatState { isGroup: boolean; paused: boolean; messages: ChatMessage[]; lastReplyAt?: Record<string, number>; mode?: ReplyMode; ask?: boolean; persona?: PersonaMeta }
interface State { chats: Record<string, ChatState>; drafts: Draft[] }

/** Persisted chat history (as seen on screen + sent by the bot) and reply drafts. */
class Store {
  private s: State = { chats: {}, drafts: [] };
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;

  load(): void {
    if (existsSync(FILE)) {
      try { this.s = { chats: {}, drafts: [], ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { /* corrupt: start fresh */ }
      // Drop UI overlays ("3条新消息") that earlier versions recorded as messages.
      for (const c of Object.values(this.s.chats)) {
        const bad = c.messages.filter((m) => m.kind !== 'image' && isNoiseText(m.text));
        if (bad.length) c.messages = c.messages.filter((m) => !bad.includes(m));
      }
    }
  }

  /** Persists in-place edits of returned messages. */
  touch(): void { this.save(); }

  private save(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => writeFileSync(FILE, JSON.stringify(this.s)), 500);
  }

  flush(): void { clearTimeout(this.timer); writeFileSync(FILE, JSON.stringify(this.s)); }

  id(): string { return `${Date.now().toString(36)}${(this.seq++).toString(36)}`; }

  chat(name: string): ChatState | undefined { return this.s.chats[name]; }

  ensure(name: string, isGroup: boolean): ChatState {
    const isNew = !this.s.chats[name];
    const c = (this.s.chats[name] ??= { isGroup, paused: false, messages: [] });
    if (isGroup) c.isGroup = true;
    if (isNew) this.save();
    return c;
  }

  append(name: string, msgs: ChatMessage[]): void {
    const c = this.s.chats[name];
    if (!c || !msgs.length) return;
    c.messages.push(...msgs);
    this.trim(c);
    this.save();
  }

  /** Replaces a chat's history (after reading older messages by scrolling up). */
  replace(name: string, msgs: ChatMessage[]): void {
    const c = this.s.chats[name];
    if (!c) return;
    const keep = new Set(msgs.map((m) => m.image).filter(Boolean));
    dropImages(c.messages.filter((m) => m.image && !keep.has(m.image)));
    c.messages = msgs;
    this.trim(c);
    this.save();
  }

  private trim(c: ChatState): void {
    if (c.messages.length > MAX_PER_CHAT) dropImages(c.messages.splice(0, c.messages.length - MAX_PER_CHAT));
  }

  history(name: string): ChatMessage[] { return this.s.chats[name]?.messages ?? []; }

  summaries(): ChatSummary[] {
    return Object.entries(this.s.chats)
      .map(([name, c]) => {
        const last = c.messages[c.messages.length - 1];
        return { name, isGroup: c.isGroup, paused: c.paused, count: c.messages.length, lastAt: last?.at ?? 0, lastText: last?.image ? '[图片]' : last?.text ?? '', mode: (c.mode ?? 'inherit') as ReplyMode | 'inherit', ask: c.ask === undefined ? 'inherit' as const : c.ask ? 'on' as const : 'off' as const, persona: c.persona ? { enabled: c.persona.enabled, prompt: c.persona.prompt } : undefined };
      })
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  setPaused(name: string, paused: boolean): void { this.ensure(name, false).paused = paused; this.save(); }
  setMode(name: string, mode: ReplyMode | 'inherit'): void {
    const c = this.ensure(name, false);
    if (mode === 'inherit') delete c.mode; else c.mode = mode;
    this.save();
  }

  setAsk(name: string, ask: 'inherit' | 'on' | 'off'): void {
    const c = this.ensure(name, false);
    if (ask === 'inherit') delete c.ask; else c.ask = ask === 'on';
    this.save();
  }

  setPersona(name: string, meta: PersonaMeta | null): void {
    const c = this.ensure(name, false);
    if (meta) c.persona = meta; else delete c.persona;
    this.save();
  }

  /** Removes the records; a chat with its own mode / ask switch / persona stays (empty) so those settings are not lost. */
  clear(name: string): void {
    const c = this.s.chats[name];
    if (!c) return;
    dropImages(c.messages);
    if (c.mode || c.ask !== undefined || c.persona) { c.messages = []; delete c.lastReplyAt; } else delete this.s.chats[name];
    this.save();
  }

  /** Deletes chats entirely: records, image crops and per-chat settings (the persona prompt in the config stays). */
  remove(names: string[]): number {
    let n = 0;
    for (const name of names) {
      const c = this.s.chats[name];
      if (!c) continue;
      dropImages(c.messages);
      delete this.s.chats[name];
      n++;
    }
    if (n) this.save();
    return n;
  }

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
