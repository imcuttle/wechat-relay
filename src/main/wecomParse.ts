// Parsing of 企业微信's session list as the Accessibility tree shows it (markdown rendering of the cua-driver's
// get_window_state): inside the AXTable every session row is a flat run
//   name · [tag…] · last message · [unread badge button] · time
// so rows are cut at the time label. The unread badge sits before the time label for some rows and right after it for
// others (a button with no text pending belongs to the row just closed). No imports: also run directly by tests.

export interface WecomSession {
  /** Chat name. */
  name: string;
  /** Last message without the sender / unread / draft prefixes (leading [有人@我] / [@所有人] markers are kept). */
  text: string;
  /** Group chats: who sent the last message. */
  sender?: string;
  isGroup: boolean;
  /** Unread count (badge, or the "[N条]" prefix of muted chats). */
  unread: number;
  /** Time label as shown ("8分钟前", "19:34"). */
  time: string;
  /** The preview is my own unsent draft. */
  draft: boolean;
  raw: string;
  /** Last row of a cut tree: its badge (which can follow the time label) may not have been read yet. */
  tail?: boolean;
}

const TIME_RE = /^(刚刚|\d+\s*秒前|\d+\s*分钟前|\d+\s*小时前|昨天(\s*\d{1,2}:\d{2})?|前天|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|\d{2,4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}\/\d{1,2})$/;
export const isTimeLabel = (s: string): boolean => TIME_RE.test(s.trim());

/** Private chats of the company directory are named "rtx(中文名)"; groups are free-form. */
const PERSON_NAME = /^[A-Za-z0-9_.-]+\([^()]+\)$/;

const valueOf = (rest: string): string | null => {
  const i = rest.indexOf('= "');
  const j = rest.lastIndexOf('"');
  return i >= 0 && j > i + 2 ? rest.slice(i + 3, j) : i >= 0 && j === i + 2 ? '' : null;
};

export function parseSession(texts: string[], unreadBadge: number, time: string): WecomSession | null {
  if (!texts.length) return null;
  // A row is name + last message; stray labels before them (the first row of the table carries one) are skipped.
  const name = (texts.length > 1 ? texts[texts.length - 2] : texts[0]).trim();
  const raw = (texts.length > 1 ? texts[texts.length - 1] : '').trim();
  if (!name) return null;
  let text = raw;
  let unread = unreadBadge;
  let draft = false;
  // Prefixes, in the order the client writes them: [N条] (muted chat's unread count), [草稿].
  for (let i = 0; i < 3; i++) {
    const count = /^\[(\d+)条\]\s*/.exec(text);
    if (count) { unread = Math.max(unread, Number(count[1])); text = text.slice(count[0].length); continue; }
    const d = /^\[草稿\]\s*/.exec(text);
    if (d) { draft = true; text = text.slice(d[0].length); continue; }
    break;
  }
  // "[有人@我] sender: text" / "[@所有人] sender: text": markers stay in the text, the sender prefix moves out.
  const marker = /^((?:\[(?:有人@我|@所有人|有人@你)\]\s*)*)/.exec(text)?.[1] ?? '';
  const body = text.slice(marker.length);
  // The sender prefix is a short name directly followed by "：" / ": " + whitespace (not the "10:30" inside a sentence).
  const who = /^([^:：，。！？,!?\n]{1,24})[:：](?:\s+([\s\S]*)|())$/.exec(body);
  const isGroup = !!who && !PERSON_NAME.test(name);
  return {
    name, isGroup, unread, time, draft, raw,
    sender: isGroup ? who![1].trim() : undefined,
    text: marker + (isGroup ? (who![2] ?? '') : body),
  };
}

/** Sessions of the table, top to bottom. The last row is dropped when the tree was cut inside it (no time label yet). */
export function parseSessions(markdown: string): WecomSession[] {
  const lines = markdown.split('\n');
  let i = lines.findIndex((l) => /\bAXTable\b/.test(l));
  if (i < 0) return [];
  const indent = (l: string) => l.length - l.trimStart().length;
  const tableIndent = indent(lines[i]);
  const out: WecomSession[] = [];
  let texts: string[] = [];
  let badge = 0;
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.startsWith('⚠️')) break;
    if (indent(l) <= tableIndent) break;
    const m = /^\s*- (?:\[\d+\] )?(AX\w+)(.*)$/.exec(l);
    if (!m) continue;
    const [, role, rest] = m;
    if (role === 'AXStaticText') {
      const v = valueOf(rest);
      if (v === null) continue;
      if (texts.length && isTimeLabel(v)) {
        const s = parseSession(texts, badge, v.trim());
        if (s) out.push(s);
        texts = []; badge = 0;
      } else texts.push(v);
    } else if (role === 'AXButton') {
      const b = /^\s*"(\d+)\+?"/.exec(rest);
      if (!b) continue;
      const n = Number(b[1]);
      if (texts.length) badge = n;
      else if (out.length) { const last = out[out.length - 1]; last.unread = Math.max(last.unread, n); }
    }
  }
  if (out.length) out[out.length - 1].tail = true;
  return out;
}
