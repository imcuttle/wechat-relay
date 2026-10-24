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

/**
 * Default of general.askPrompt: the system prompt section added when AskUserQuestion is on. Variables: {{myNickname}},
 * {{chat}}, {{askTimeoutSec}}; {{#memory}}…{{/memory}} only when memory is on.
 */
export const DEFAULT_ASK_PROMPT = `## 询问我
回复需要用到某个事实，但聊天记录{{#memory}}和记忆{{/memory}}里都没有、你也不能确定时（例如我的时间安排、地点、价格、我和对方的约定、我本人的情况和想法），可以用 AskUserQuestion 工具弹窗问我（{{myNickname}}，这个微信号的主人），不要编造。能从上下文判断的、寒暄类的不要问。
问题要短，给 2-4 个具体选项（我也可以自己输入），一次最多问 4 个。我 {{askTimeoutSec}} 秒内没回答就当没回答，按原来的规则处理（例如礼貌表示稍后回复），不要重复问。
{{#memory}}- 问之前先查记忆，记过的答案直接用，不要再问。
- 我的回答里长期有效的个人信息（偏好、习惯、身份、日程规律、对某人或某类事的态度和处理方式）要记到记忆里：通用的记全局记忆，只和这个会话有关的记当前会话记忆，注明是「我本人回答的」。一次性的决定（比如这次答应了某个邀约）不用记。{{/memory}}`;
