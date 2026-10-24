import type { AppConfig, ChatMessage, RuleConfig } from '@shared/types';
import { isNotice, noticeActor, patsMe } from './notice';
import { normText } from './wechat';

/** exact (normalised), `*` wildcard, or /regex/flags */
export function matchPattern(pattern: string, value: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const re = /^\/(.+)\/([a-z]*)$/i.exec(p);
  if (re) { try { return new RegExp(re[1], re[2]).test(value); } catch { return false; } }
  if (p.includes('*')) {
    const rx = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    return rx.test(value) || rx.test(normText(value));
  }
  return normText(p) === normText(value);
}

export interface RuleContext {
  chat: string;
  isGroup: boolean;
  /** New incoming messages (other side). Empty when matching on chat metadata only (unread rows). */
  messages: ChatMessage[];
  /** For unread rows: the list preview says someone @'d me. */
  mentionedHint?: boolean;
}

export function isMention(text: string, nickname: string, includeAtAll: boolean): boolean {
  if (nickname && new RegExp(`@\\s?${nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text)) return true;
  if (/有人@我/.test(text)) return true;
  return includeAtAll && /@所有人|@All/i.test(text);
}

/**
 * First enabled rule whose conditions all hold. With `metadataOnly`, content conditions (keywords / senders / mentions)
 * are treated optimistically so that an unread chat can be opened and then evaluated on its real messages.
 */
export function matchRule(cfg: AppConfig, ctx: RuleContext, metadataOnly = false): RuleConfig | null {
  for (const rule of cfg.rules) {
    if (!rule.enabled) continue;
    const m = rule.match;
    if (m.chats?.length && !m.chats.some((p) => matchPattern(p, ctx.chat))) continue;
    if (m.excludeChats?.some((p) => matchPattern(p, ctx.chat))) continue;
    if (m.chatType === 'group' && !ctx.isGroup) continue;
    if (m.chatType === 'private' && ctx.isGroup) continue;
    if (!metadataOnly) {
      const me = cfg.general.myNickname;
      const texts = ctx.messages.map((x) => x.text);
      const senderOf = (x: ChatMessage) => noticeActor(x, me) ?? (isNotice(x) ? undefined : x.sender);
      if (m.senders?.length && !ctx.messages.some((x) => { const s = senderOf(x); return s && m.senders!.some((p) => matchPattern(p, s)); })) continue;
      if (m.keywords?.length && !texts.some((t) => m.keywords!.some((k) => (k.startsWith('/') ? matchPattern(k, t) : t.includes(k))))) continue;
      // Being patted (拍一拍) addresses me just like an @.
      if (m.mentionOnly && ctx.isGroup && !ctx.messages.some((x) => patsMe(x, me) || (!isNotice(x) && isMention(x.text, me, m.includeAtAll ?? false)))) continue;
    } else if (m.mentionOnly && ctx.isGroup && !ctx.mentionedHint) {
      continue;
    }
    return rule;
  }
  return null;
}
