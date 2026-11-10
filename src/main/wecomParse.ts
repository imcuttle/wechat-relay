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

/** Comparable start of a message text (markers, whitespace and a trailing "…" of truncated previews are dropped). */
export const cellHead = (t: string): string => t.replace(/^(\[(?:有人@我|@所有人|有人@你)\]\s*)+/, '').replace(/\s+/g, '').replace(/…+$/, '').slice(0, 30);

/** A quoted message's cell starts with its author: "name(中文名):" followed by the quoted text. */
const QUOTE_CELL = /^[^\n:：]{1,40}[:：](?:\s|$)/;

/**
 * The quotes of a reply. The session list preview of a reply only has the reply's own text; the quoted message sits in the
 * chat pane as its own cell(s) right before the reply. Returns the cells between the quote's author line and the (last)
 * cell that starts like `preview`, unless one of them is a message already seen (`known` heads).
 */
export function quotesOf(texts: string[], preview: string, known: string[] = []): string[] {
  const want = cellHead(preview);
  if (!want) return [];
  let at = -1;
  for (let i = texts.length - 1; i >= 0; i--) {
    const h = cellHead(texts[i]);
    if (h && (h.startsWith(want) || want.startsWith(h))) { at = i; break; }
  }
  if (at < 0) return [];
  const seen = new Set(known.map(cellHead));
  // The quote may be one cell or split by line: walk back to the cell that starts with the author.
  // (the quoted text can itself contain "xxx: yyy" lines, so the farthest author-looking cell wins)
  let from = -1;
  for (let i = at - 1; i >= 0 && i >= at - 3; i--) {
    if (seen.has(cellHead(texts[i]))) break;
    if (QUOTE_CELL.test(texts[i])) from = i;
  }
  return from < 0 ? [] : texts.slice(from, at);
}

export interface PaneElement {
  role?: string; element_index?: number; parent_index?: number; value?: unknown; label?: unknown;
  frame?: { x: number; y: number; w: number; h: number };
}
export interface ChatPane {
  /** Title of the chat that is open in the window. */
  title: string;
  /** Texts of the message cells, oldest first (quotes appear as their own cells; images / files have none). */
  texts: string[];
}

/**
 * The chat that is open in the main window: the AXTable whose children are message text areas (the session list has
 * none), preceded by the title (an AXTextField for some chats, an AXStaticText for others, in the header right of the
 * session list). Message order follows the tree, newest last.
 */
export function parseChatPane(els: PaneElement[]): ChatPane | null {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const win = els.find((e) => e.role === 'AXWindow' && e.frame)?.frame;
  let table: PaneElement | null = null;
  let most = 0;
  for (const t of els) {
    if (t.role !== 'AXTable' || t.element_index == null) continue;
    if (win && t.frame && t.frame.x < win.x + 300) continue; // the session list (its text areas are the "外部" tags)
    const n = els.filter((e) => e.role === 'AXTextArea' && e.parent_index === t.element_index && str(e.value).trim()).length;
    if (n > most) { most = n; table = t; }
  }
  if (!table) return null;
  const header = els.filter((e) => (e.role === 'AXTextField' || e.role === 'AXStaticText') && e.frame && (e.element_index ?? 0) < table!.element_index! &&
    (!win || (e.frame.x >= win.x + 300 && e.frame.y >= win.y && e.frame.y <= win.y + 60)) && str(e.value ?? e.label).trim());
  const title = str(header[header.length - 1]?.value ?? header[header.length - 1]?.label).trim();
  if (!title) return null;
  const texts: string[] = [];
  for (const e of els) {
    if (e.role !== 'AXTextArea' || e.parent_index !== table.element_index) continue;
    const v = str(e.value).trim();
    if (v && texts[texts.length - 1] !== v) texts.push(v);
  }
  return { title, texts };
}
