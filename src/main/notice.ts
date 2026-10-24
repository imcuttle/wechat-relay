// System notices in a chat (centred grey lines): 拍一拍, 撤回, 入群, 红包 / 转账提示 …
// They are stored as messages from「系统提示」so the model sees the whole interaction; a pat on me also triggers a reply.

import type { ChatMessage } from '@shared/types';
import { normText } from './wechat';

export const NOTICE_SENDER = '系统提示';

export const isNotice = (m: { kind?: string }) => m.kind === 'notice';

const unquote = (s: string) => s.replace(/["“”「」『』'‘’]/g, '').trim();
const isMe = (name: string, me: string) => name === '我' || name === '你' || (!!me && normText(name) === normText(me));

/** "张三 拍了拍我的头" / "\"张三\" 拍了拍 \"李四\"" / "我拍了拍\"张三\"" → actor + whether I was the one patted. */
export function patOf(text: string, me: string): { actor: string; byMe: boolean; patsMe: boolean } | null {
  const m = /^(.*?)\s*拍了拍\s*(.*)$/.exec(text.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const actor = unquote(m[1]);
  const target = unquote(m[2]);
  const byMe = isMe(actor, me);
  const targetMe = (target.startsWith('我') && !target.startsWith('我们')) || (!!me && normText(target).startsWith(normText(me)));
  return { actor, byMe, patsMe: !byMe && targetMe };
}

/** Somebody else patted me: counts as addressing me (triggers a reply, like an @). */
export const patsMe = (m: ChatMessage, me: string) => isNotice(m) && !!patOf(m.text, me)?.patsMe;

/** Who caused the notice (the patter), for sender rules and the prompt's {{sender}}. */
export const noticeActor = (m: ChatMessage, me: string) => (isNotice(m) && patOf(m.text, me)?.actor) || undefined;
