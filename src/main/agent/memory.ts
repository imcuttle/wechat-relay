import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, MemorySummary } from '@shared/types';
import { MEMORY_DIR } from '../config';
import { chatSlug } from './skills';

export const globalMemoryFile = () => join(MEMORY_DIR, 'global.md');
export const sessionMemoryFile = (chat: string) => join(MEMORY_DIR, 'sessions', `${chatSlug(chat)}.md`);

/** `- [P0|2026-10-20 12:30] text` */
const LINE = /^- \[P([0-9])\|(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)\]\s*(.*)$/;

export interface MemoryLine { p: number; at: string; text: string }

export function parseMemory(text: string): MemoryLine[] {
  return text.split('\n').flatMap((l) => {
    const m = LINE.exec(l.trim());
    return m ? [{ p: Number(m[1]), at: m[2], text: m[3] }] : [];
  });
}

const GLOBAL_HEADER = `# 全局记忆

每行一条：\`- [P优先级|YYYY-MM-DD HH:mm] 内容\`。优先级 P0 最高、P2 为默认；重复的信息直接改原来那一行。
`;

const sessionHeader = (chat: string) => `# 会话记忆：${chat}

每行一条：\`- [P优先级|YYYY-MM-DD HH:mm] 内容\`，只记和这个会话有关的信息。
`;

/** Creates the global and the chat's memory file (with a format header) so the file tools can edit them right away. */
function ensureFiles(chat: string): void {
  mkdirSync(join(MEMORY_DIR, 'sessions'), { recursive: true });
  if (!existsSync(globalMemoryFile())) writeFileSync(globalMemoryFile(), GLOBAL_HEADER);
  if (chat && !existsSync(sessionMemoryFile(chat))) writeFileSync(sessionMemoryFile(chat), sessionHeader(chat));
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** Most important / most recent global memories, in a stable order and format (keeps the prompt prefix cacheable). */
function globalIndex(limit: number): { lines: string[]; total: number } {
  const all = parseMemory(read(globalMemoryFile()));
  const top = [...all].sort((a, b) => a.p - b.p || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, Math.max(0, limit));
  return { lines: top.map((m) => `- [P${m.p}|${m.at}] ${m.text}`), total: all.length };
}

/**
 * The memory section of the system prompt: where the files are, the global / session path rules, and the global index
 * (same text for model and harness agents). Session memories are not indexed, only reachable through the file tools.
 */
export function memoryGuide(cfg: AppConfig, chat: string): string {
  if (!cfg.memory.enabled) return '';
  ensureFiles(chat);
  const idx = globalIndex(cfg.memory.indexLimit);
  return `## 记忆
记忆是普通 Markdown 文件，用 Read / Grep / Glob 查，用 Write / Edit 改（Edit 可用 start_line / end_line 按行修改）。路径规则：
- 全局记忆（对所有会话都有用的信息：我的习惯、长期偏好、通用事实）：${globalMemoryFile()}
- 当前会话「${chat}」的记忆（只和这个会话有关：对方的偏好、约定、进行中的事）：${sessionMemoryFile(chat)}
- 其他会话的记忆在同目录 ${join(MEMORY_DIR, 'sessions')}/ 下，只用来查阅，不要改。
格式：每行一条 \`- [P优先级|YYYY-MM-DD HH:mm] 内容\`，优先级 P0 最高、P2 为默认。
- 回复前如果可能涉及以前聊过的事，先读当前会话记忆文件或 grep 一下；全局记忆只在下面列出了最重要的几条。
- 值得长期记住的新信息再记：追加一行用 Write 并设 append=true（不要覆盖整个文件，会丢掉别的记忆）；已有同主题的就先 Read 再用 Edit 改那一行，不要重复。寒暄和一次性内容不要记。
- 记忆文件不要写进回复里；需要时把里面的信息自然地用在回复中。

### 全局记忆索引（共 ${idx.total} 条，最重要的 ${idx.lines.length} 条；会话记忆不在此列出）
${idx.lines.join('\n') || '（暂无）'}`;
}

/** Memory files for the 记忆 page; `chats` resolves file names back to chat names. */
export function memorySummaries(chats: string[]): MemorySummary[] {
  const info = (file: string) => ({ entries: parseMemory(read(file)).length, updatedAt: existsSync(file) ? statSync(file).mtimeMs : 0, file });
  const out: MemorySummary[] = [{ scope: 'global', ...info(globalMemoryFile()) }];
  const dir = join(MEMORY_DIR, 'sessions');
  if (existsSync(dir)) {
    const names = new Map(chats.map((c) => [chatSlug(c), c]));
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const slug = f.slice(0, -3);
      const header = /^# 会话记忆：(.+)$/m.exec(read(join(dir, f)))?.[1];
      out.push({ scope: 'session', chat: names.get(slug) ?? header ?? slug, ...info(join(dir, f)) });
    }
  }
  return out;
}

/** Memory text of a scope; '' when the file does not exist yet. */
export function readMemory(scope: 'global' | 'session', chat: string | undefined): string {
  return read(scope === 'global' ? globalMemoryFile() : sessionMemoryFile(chat ?? ''));
}

export function writeMemory(scope: 'global' | 'session', chat: string | undefined, text: string): void {
  if (scope === 'session' && !chat) throw new Error('会话记忆需要会话名');
  mkdirSync(join(MEMORY_DIR, 'sessions'), { recursive: true });
  writeFileSync(scope === 'global' ? globalMemoryFile() : sessionMemoryFile(chat!), text);
}
