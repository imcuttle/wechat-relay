import { copyFileSync, existsSync } from 'node:fs';
import type { AppConfig, ChatMessage } from '@shared/types';
import { store } from '../store';
import { errText, logger } from '../util';
import { runTask } from './engine';
import { globalMemoryFile, sessionMemoryFile } from './memory';

const log = logger.scope('dream');
const running = new Set<string>();
const RECENT = 80;

const SYSTEM = `你在整理「我」的微信记忆（做梦）。记忆是普通 Markdown 文件，每行一条：\`- [P优先级|YYYY-MM-DD HH:mm] 内容\`，P0 最高、P2 为默认。
用 Read 读文件，用 Edit 改文件（可用 start_line / end_line 按行替换、插入、删除），追加用 Write 并设 append=true；不要用 Write 覆盖整个文件，不要碰记忆目录以外的文件。整理规则：
- 合并重复和同主题的条目，删除已经过时或被推翻的，保留最新的说法；不要编造聊天里没有的信息；不属于上述情况的已有条目一律保留，不要为了精简随意删除。
- 从最近的聊天里提炼值得长期记住的新信息（对方的偏好、约定、待办、重要事实），追加到对应文件；寒暄和一次性内容不记。
- 只和这个会话有关的写会话记忆；对所有会话都有用的（我的习惯、通用事实）写全局记忆，必要时把会话记忆里的通用条目提升到全局。
- 优先级：影响回复方式或有时限的约定用 P0，长期偏好用 P1，其余 P2。全局记忆保持精炼，不超过 {limit} 条。
- 保持文件开头的标题与说明行不变。
改完后用一句话说明做了什么。`;

const stamp = (t: number) => { const d = new Date(t); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const fmt = (t: number) => { const d = new Date(t); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; };

function transcript(chat: string, msgs: ChatMessage[]): string {
  return msgs.map((m) => `[${fmt(m.at)}] ${m.side === 'self' ? '我' : m.sender || chat}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
}

/** Has the agent consolidate the memory of `chat` (and the global one); without a chat only the global memory. */
export async function dream(cfg: AppConfig, chat?: string): Promise<string> {
  if (!cfg.memory.enabled) throw new Error('记忆功能未开启');
  const agent = cfg.memory.dreamAgent || cfg.agents[0]?.id;
  if (!agent) throw new Error('没有可用的 agent');
  const key = chat ?? '';
  if (running.has(key)) throw new Error('正在整理中');
  running.add(key);
  try {
    const recent = chat ? store.history(chat).slice(-RECENT) : [];
    const user = `全局记忆文件：${globalMemoryFile()}\n${chat ? `会话「${chat}」的记忆文件：${sessionMemoryFile(chat)}\n` : ''}` +
      `现在时间：${stamp(Date.now())}（新条目的时间用这个格式）\n\n` +
      (chat ? `# 「${chat}」最近的聊天（${recent.length} 条）\n${transcript(chat, recent) || '（无）'}\n\n` : '') +
      '请开始整理。';
    // One-step undo: the previous version of each file stays next to it as <file>.bak.
    for (const f of [globalMemoryFile(), ...(chat ? [sessionMemoryFile(chat)] : [])]) if (existsSync(f)) copyFileSync(f, `${f}.bak`);
    const t0 = Date.now();
    log.info(`开始整理记忆${chat ? `「${chat}」` : '（全局）'} → agent ${agent}`);
    const text = await runTask(cfg, agent, SYSTEM.replace('{limit}', String(cfg.memory.indexLimit * 3)), user);
    log.info(`记忆整理完成（${Date.now() - t0}ms）：${text.slice(0, 120)}`);
    return text || '已整理';
  } finally {
    running.delete(key);
  }
}

const counts = new Map<string, number>();

/** Counts new messages of a chat; every `dreamEveryMessages` of them a dream runs in the background. */
export function noteMessages(cfg: AppConfig, chat: string, n: number): void {
  const every = cfg.memory.dreamEveryMessages;
  if (!cfg.memory.enabled || every <= 0) return;
  const total = (counts.get(chat) ?? 0) + n;
  if (total < every) { counts.set(chat, total); return; }
  counts.set(chat, 0);
  dream(cfg, chat).catch((e) => log.warn(`自动整理「${chat}」失败：${errText(e)}`));
}
