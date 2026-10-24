import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, SkillConfig, SkillInfo } from '@shared/types';
import { SKILLS_DIR } from '../config';

/** Directory name of a chat: readable part + short hash, so names with / : spaces or only a different case never collide. */
export function chatSlug(chat: string): string {
  const name = chat.trim().normalize('NFC');
  const base = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'chat';
  return `${base}-${createHash('sha1').update(name).digest('hex').slice(0, 6)}`;
}

export const globalSkillsDir = () => join(SKILLS_DIR, 'global');
export const sessionSkillsDir = (chat: string) => join(SKILLS_DIR, 'sessions', chatSlug(chat));
export const validSkillId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

const skillFile = (dir: string, id: string) => join(dir, id, 'SKILL.md');

export function skillDir(scope: 'global' | 'session', chat: string | undefined): string {
  if (scope === 'global') return globalSkillsDir();
  if (!chat) throw new Error('会话 skill 需要会话名');
  return sessionSkillsDir(chat);
}

export function skillPath(scope: 'global' | 'session', chat: string | undefined, id: string): string {
  if (!validSkillId(id)) throw new Error('skill id 只能包含字母数字下划线连字符');
  return skillFile(skillDir(scope, chat), id);
}

/** `description:` of a SKILL.md frontmatter. */
function description(text: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return /^description:\s*(.*)$/m.exec(fm)?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
}

const same = (c: SkillConfig, scope: string, chat: string | undefined, id: string) =>
  c.id === id && c.scope === scope && (scope === 'global' || c.chat === chat);

function scan(dir: string, scope: 'global' | 'session', chat: string | undefined, cfg: AppConfig): SkillInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && validSkillId(e.name) && existsSync(skillFile(dir, e.name)))
    .map((e) => {
      const file = skillFile(dir, e.name);
      const conf = cfg.skills.find((c) => same(c, scope, chat, e.name));
      return { id: e.name, scope, chat, description: description(readFileSync(file, 'utf8')) || conf?.description || '', enabled: conf?.enabled !== false, file };
    });
}

/** Writes the SKILL.md of config entries that have content and no file yet (afterwards the file on disk wins). */
export function syncSkills(cfg: AppConfig): void {
  for (const s of cfg.skills) {
    if (!s.content || !validSkillId(s.id) || (s.scope === 'session' && !s.chat)) continue;
    const file = skillPath(s.scope, s.chat, s.id);
    if (existsSync(file)) continue;
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `---\nname: ${s.name || s.id}\ndescription: ${s.description}\n---\n\n${s.content.trim()}\n`);
  }
}

/** Skills of the global dir and of `chat` (a session skill replaces a global one with the same id). Disabled ones are dropped. */
export function activeSkills(cfg: AppConfig, chat: string): SkillInfo[] {
  const byId = new Map<string, SkillInfo>();
  for (const s of [...scan(globalSkillsDir(), 'global', undefined, cfg), ...scan(sessionSkillsDir(chat), 'session', chat, cfg)]) byId.set(s.id, s);
  return [...byId.values()].filter((s) => s.enabled).sort((a, b) => a.id.localeCompare(b.id));
}

/** Every skill on disk for the 记忆 page; `chats` resolves session directory names back to chat names. */
export function allSkills(cfg: AppConfig, chats: string[]): SkillInfo[] {
  const out = scan(globalSkillsDir(), 'global', undefined, cfg);
  const root = join(SKILLS_DIR, 'sessions');
  if (existsSync(root)) {
    const names = new Map(chats.map((c) => [chatSlug(c), c]));
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...scan(join(root, e.name), 'session', names.get(e.name) ?? e.name, cfg));
    }
  }
  return out;
}

export function deleteSkill(scope: 'global' | 'session', chat: string | undefined, id: string): void {
  rmSync(join(skillPath(scope, chat, id), '..'), { recursive: true, force: true });
}

/** The skill section of the system prompt: path rules for global / session skills plus the index of the active ones. */
export function skillGuide(cfg: AppConfig, chat: string): string {
  if (!cfg.skillsEnabled) return '';
  const skills = activeSkills(cfg, chat);
  return `## Skill
Skill 是可复用的操作指引，每个是一个目录里的 SKILL.md（开头有 name / description），用 Read / Glob / Grep 查看，用 Write / Edit 修改；skill 目录里附带的脚本、批量文件操作用 Bash 执行。
- 全局 skill：${globalSkillsDir()}/<id>/SKILL.md
- 当前会话「${chat}」的 skill：${sessionSkillsDir(chat)}/<id>/SKILL.md（同 id 时覆盖全局）
遇到相关场景时先 Read 对应 SKILL.md 再照做；发现流程值得沉淀时可以新建（Write，目录不存在会自动创建）或用 Edit 修改（全局通用的放全局，只对本会话有用的放会话目录）。
${skills.length ? skills.map((s) => `- ${s.id}（${s.scope === 'global' ? '全局' : '会话'}）：${s.description || '（无说明）'}`).join('\n') : '（暂无 skill）'}`;
}
