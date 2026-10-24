import { DEFAULT_ASK_PROMPT } from '@shared/prompt';
import type { AppConfig, AskAnswers, AskQuestion } from '@shared/types';
import { render } from '../util';
import type { ToolImpl } from './tools';

/** AskUserQuestion arguments from a model (or a harness) are untrusted: normalise, or explain what is wrong. */
export function parseQuestions(raw: unknown): AskQuestion[] | string {
  const list = (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list) || !list.length) return 'error: 需要 questions 数组（1-4 个问题）';
  const out: AskQuestion[] = [];
  for (const q of list.slice(0, 4)) {
    const question = String(q?.question ?? '').trim();
    if (!question) return 'error: 每个问题都需要 question';
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o: unknown) => (typeof o === 'object' && o ? { label: String((o as { label?: unknown }).label ?? '').trim(), description: String((o as { description?: unknown }).description ?? '').trim() } : { label: String(o ?? '').trim(), description: '' }))
      .filter((o: { label: string }) => o.label)
      .slice(0, 4);
    if (options.length < 2) return `error: 问题「${question}」需要 2-4 个选项`;
    out.push({ question, header: String(q?.header ?? '').trim().slice(0, 12) || '问题', options, multiSelect: q?.multiSelect === true });
  }
  return out;
}

export function answersText(questions: AskQuestion[], answers: AskAnswers, why = '超时或拒绝'): string {
  if (!answers) return `用户没有回答（${why}）。不要再问同样的问题，按你自己的判断继续：拿不准的就礼貌表示稍后回复。`;
  return `用户的回答：\n${questions.map((q) => ` · ${q.question} → ${answers[q.question] ?? '（未回答）'}`).join('\n')}`;
}

/** Same name, schema and answer format as CodeBuddy / Claude Code's AskUserQuestion; asks through ToolCtx.ask. */
export function askTool(): ToolImpl {
  return {
    name: 'AskUserQuestion',
    description: '弹窗询问我（这个微信号的主人）一到四个选择题。界面会显示你给的选项，并提供自由输入框，所以我也可能输入选项以外的答案，一律视为有效回答。我可能超时不回答。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: 4, description: '要问的问题（1-4 个）',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '完整的问题，以问号结尾' },
              header: { type: 'string', description: '很短的标签（最多 12 个字），如「时间」「价格」' },
              options: {
                type: 'array', minItems: 2, maxItems: 4, description: '2-4 个互斥选项（不要自己加「其他」，界面自带输入框）',
                items: { type: 'object', properties: { label: { type: 'string', description: '选项文字（1-5 个词）' }, description: { type: 'string', description: '选项的含义或后果' } }, required: ['label', 'description'] },
              },
              multiSelect: { type: 'boolean', description: '允许多选', default: false },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
        },
      },
      required: ['questions'],
    },
    run: async (args, ctx) => {
      const qs = parseQuestions(args);
      if (typeof qs === 'string') return qs;
      if (!ctx.ask) return answersText(qs, null, '这个会话没有开启询问');
      return answersText(qs, await ctx.ask(qs));
    },
  };
}

/** System prompt section when AskUserQuestion is available (general.askPrompt, rendered; stable text keeps the prompt cacheable). */
export function askGuide(cfg: AppConfig, chat: string): string {
  const tpl = cfg.general.askPrompt?.trim() || DEFAULT_ASK_PROMPT;
  return render(tpl, { myNickname: cfg.general.myNickname || '我', chat, askTimeoutSec: cfg.general.askTimeoutSec, memory: cfg.memory.enabled }).trim();
}
