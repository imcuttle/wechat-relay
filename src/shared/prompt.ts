import type { PromptCase, PromptConfig } from './types';

const usable = (l?: PromptCase[]) => (l ?? []).filter((c) => c.reply?.trim());

function caseBlock(c: PromptCase, title: string, replyLabel: string, noteLabel: string): string {
  return [
    `### ${title}`,
    c.context?.trim() && `对话：\n${c.context.trim()}`,
    `${replyLabel}：\n${c.reply.trim()}`,
    c.note?.trim() && `${noteLabel}：${c.note.trim()}`,
  ].filter(Boolean).join('\n');
}

/** Reply examples of a prompt as a prompt section ('' when there are none). */
export function casesText(p: Pick<PromptConfig, 'goodCases' | 'badCases'>): string {
  const good = usable(p.goodCases), bad = usable(p.badCases);
  const out: string[] = [];
  if (good.length) out.push(`## 好的回复示例（参照这些回复的语气、长度和处理方式，但不要照抄原话）\n\n${good.map((c, i) => caseBlock(c, `好例 ${i + 1}`, '我的回复', '好在哪里')).join('\n\n')}`);
  if (bad.length) out.push(`## 不好的回复示例（避免这样回复）\n\n${bad.map((c, i) => caseBlock(c, `反例 ${i + 1}`, '不好的回复', '问题')).join('\n\n')}`);
  return out.join('\n\n');
}

/** Id of the persona prompt a chat owns (generated / edited in 会话记录 → 人设). */
export const personaPromptId = (chat: string) => `persona-${chat.trim().replace(/\s+/g, '-')}`;

/** Full text of a prompt: the content followed by its reply examples. */
export function promptText(p: PromptConfig | undefined): string {
  if (!p) return '';
  return [p.content?.trim(), casesText(p)].filter(Boolean).join('\n\n');
}
