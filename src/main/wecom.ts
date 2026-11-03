import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatKey, type AppConfig, type ChatMessage, type MonitorStatus, type RuleConfig, type SessionRow } from '@shared/types';
import { CONFIG_PATH, DATA_DIR } from './config';
import { CuaDriver, structured, text } from './driver';
import { isMention, matchRule } from './rules';
import type { ScriptTrigger } from './scripting/host';
import { store } from './store';
import { errText, logger, sleep } from './util';
import { frontmostPid, sameChat } from './wechat';
import { parseChatPane, parseSessions, type ChatPane, type PaneElement, type WecomSession } from './wecomParse';

const log = logger.scope('wecom');
const BUNDLE_ID = 'com.tencent.WeWorkMac';

/** Walk budget of one read: the session table is hundreds of rows, the newest ones are at the top. */
const WALK_MS = 5000;
const WALK_NODES = 400;
/** A session that appears in the window for the first time only counts as new when it is among the top rows (freshly updated). */
const TOP_ROWS = 4;

/** Walk budget of reading an open chat (the message cells come after the 100+ menu bar nodes). */
const PANE_MS = 20000;
const PANE_NODES = 1500;
/** Most chats that may be opened in a row to reach the wanted one (every chat opened on the way is marked read). */
const MAX_HOPS = 3;
const MENU_NEXT_UNREAD = ['窗口', '选择下一个未读会话'];

/** Time label of a session updated within the last couple of minutes. */
const isFreshTime = (t: string): boolean => {
  const s = t.trim();
  if (s === '刚刚' || /^\d+\s*秒前$/.test(s)) return true;
  const m = /^(\d+)\s*分钟前$/.exec(s);
  return !!m && Number(m[1]) <= 2;
};

interface Seen { unread: number; text: string; isGroup: boolean }

/** The screen is locked: accessibility shows nothing until the Mac is unlocked. */
class ScreenLocked extends Error {}

/**
 * Watches 企业微信 through its Accessibility tree (read in the background through the Cua Driver: no focus, no pixels,
 * works while the window is hidden in the tray). Each poll reads the top of the session list; a chat whose unread count
 * went up has a new message, whose text is the list's preview (the last message, complete). Only that last message of a
 * burst is visible (the rest is reported as `missed`). Messages go through the same rules as WeChat's; only rules with
 * action "script" are supported here (no AI replies / sending into 企业微信).
 */
export class WecomMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private failures = 0;
  private win: { pid: number; windowId: number } | null = null;
  private emptyReads = 0;
  private seen = new Map<string, Seen>();
  private baseline = false;
  private rows: WecomSession[] = [];
  /** Recoveries run one at a time (they switch the chat shown in the window); a chat is queued once. */
  private recoverQueue: Promise<void> = Promise.resolve();
  private recovering = new Set<string>();
  /** Message texts per chat that were already handed to the rules, to skip them when the chat is read from its pane. */
  private handled = new Map<string, string[]>();
  private status: MonitorStatus = { app: 'wecom', running: false, driver: 'stopped', ticks: 0, replies: 0, busy: false, configPath: CONFIG_PATH };

  constructor(private cfg: AppConfig, private driver: CuaDriver) { super(); }

  setConfig(cfg: AppConfig): void { this.cfg = cfg; }

  getStatus(): MonitorStatus { return { ...this.status, busy: this.busy }; }
  private update(p: Partial<MonitorStatus>): void { Object.assign(this.status, p); this.emit('status', this.getStatus()); }

  async start(): Promise<void> {
    if (this.status.running) return;
    this.baseline = false;
    this.seen.clear();
    this.handled.clear();
    this.update({ running: true, driver: 'ready', driverError: undefined });
    log.info('企业微信监听已启动');
    this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.update({ running: false });
    log.info('企业微信监听已停止');
  }

  dispose(): void { this.stop(); }

  tickOnce(): Promise<void> { return this.tick(); }

  private interval(): number { return this.cfg.apps.wecom.pollIntervalMs ?? 3000; }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.status.running) return;
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop(): Promise<void> {
    try {
      await this.tick();
      this.failures = 0;
      if (this.status.driver !== 'ready' || this.status.driverError) this.update({ driver: 'ready', driverError: undefined });
    } catch (e) {
      if (e instanceof ScreenLocked) {
        // Not an error: wait for the unlock (no back-off, the baseline is kept so messages that arrive meanwhile are picked up).
        this.failures = 0;
        if (this.status.driverError !== e.message) log.info(e.message);
        this.update({ driver: 'ready', driverError: e.message });
        this.schedule(this.interval());
        return;
      }
      this.failures++;
      const msg = errText(e);
      if (this.failures <= 3 || this.failures % 20 === 0) log.warn(msg);
      this.win = null;
      this.update({ wechat: null, driver: 'error', driverError: msg });
    }
    this.schedule(Math.min(this.interval() * Math.max(1, this.failures), 30000));
  }

  /** The main window (also found while it is hidden / closed to the tray). */
  private async locate(): Promise<{ pid: number; windowId: number }> {
    if (this.win) return this.win;
    const apps = structured<{ apps?: Array<{ bundle_id?: string; pid: number; running: boolean }> }>(await this.driver.call('list_apps')).apps ?? [];
    const app = apps.find((a) => a.running && a.bundle_id === BUNDLE_ID);
    if (!app) throw new Error('企业微信没有运行');
    const wins = structured<{ windows?: Array<{ window_id: number; title?: string; layer?: number; bounds: { width: number; height: number } }> }>(
      await this.driver.call('list_windows', { pid: app.pid })).windows ?? [];
    const main = wins
      .filter((w) => (w.layer ?? 0) === 0 && w.bounds.width >= 500 && w.bounds.height >= 400)
      .sort((a, b) => Number(b.title === '企业微信') - Number(a.title === '企业微信') || b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
    if (!main) throw new Error('找不到企业微信主窗口（请先登录企业微信）');
    this.win = { pid: app.pid, windowId: main.window_id };
    return this.win;
  }

  /** Reads the top of the session list (a few quick retries when the window subtree came back empty: only the menu bar). */
  private async read(): Promise<{ sessions: WecomSession[]; tree: string }> {
    let last = { sessions: [] as WecomSession[], tree: '' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000));
      const w = await this.locate();
      const res = await this.driver.call('get_window_state', {
        pid: w.pid, window_id: w.windowId, include_accessibility_tree: true, include_screenshot: false,
        timeout_ms: WALK_MS, max_elements: WALK_NODES,
      }, WALK_MS + 10000);
      const out = structured<{ tree_markdown?: string; degraded?: boolean; degraded_reason?: string }>(res);
      // While the screen is locked / the screen saver runs, macOS hides every window from accessibility.
      if (out.degraded && /^screen_locked/.test(out.degraded_reason ?? '')) throw new ScreenLocked('屏幕已锁定，暂停读取企业微信（解锁后自动继续，期间的新消息会补上）');
      const tree = out.tree_markdown ?? text(res);
      const sessions = parseSessions(tree);
      if (sessions.length) return { sessions, tree };
      log.debug(`会话列表为空：${out.degraded_reason ?? ''} ${text(res).slice(0, 200)}`);
      // The window id went stale (window recreated / re-parented): resolve it again on the next attempt.
      if (/^ax_window_unresolved/.test(out.degraded_reason ?? '')) this.win = null;
      else this.dumpEmptyTree(tree);
      last = { sessions, tree };
    }
    return last;
  }

  /** Keeps the latest tree that had no session rows, to find out why it was unparsable. */
  private dumpEmptyTree(tree: string): void {
    try {
      const dir = join(DATA_DIR, 'debug');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'wecom-empty-tree.md'), tree);
    } catch { /* diagnostics only */ }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const { sessions, tree } = await this.read();
      this.update({ wechat: this.win ? { pid: this.win.pid, windowId: this.win.windowId, width: 0, height: 0 } : null, ticks: this.status.ticks + 1, lastTickAt: Date.now() });
      if (!sessions.length) {
        // Momentary (window being redrawn / switching views): not worth an error or a back-off; only a persistent failure is.
        if (++this.emptyReads < 3) { log.debug(`会话列表暂时为空（${this.emptyReads}/3）`); return; }
        throw new Error('没有读到企业微信的会话列表（是否已登录？首次需要授予辅助功能权限；最近一次的树见 debug/wecom-empty-tree.md）');
      }
      this.emptyReads = 0;
      this.emit('sessions', sessions.map((s): SessionRow => ({
        name: s.name, preview: s.text, sender: s.sender, isGroup: s.isGroup, unread: s.unread, draft: s.draft, time: s.time,
        mentioned: /^\[(有人@我|@所有人)\]/.test(s.text),
      })), tree);
      this.process(sessions);
      this.update({ lastTickMs: Date.now() - t0 });
    } finally { this.busy = false; }
  }

  /** Compares the list with the previous read and hands the chats with new unread messages to the rules. */
  private process(sessions: WecomSession[]): void {
    const first = !this.baseline;
    this.baseline = true;
    this.rows = sessions;
    sessions.forEach((s, index) => {
      const prev = this.seen.get(s.name);
      // The last row of a cut tree may lack its badge: don't let a missing badge look like "read" (it would re-fire next poll).
      if (s.tail && prev && s.unread === 0 && s.text === prev.text) return;
      const isGroup = (prev?.isGroup ?? false) || s.isGroup;
      this.seen.set(s.name, { unread: s.unread, text: s.text, isGroup });
      if (first || s.draft || !s.text) return;
      const before = prev?.unread ?? 0;
      // New message = the unread count went up, or the preview changed while the chat is unread (badge capped / count unchanged).
      if (s.unread <= before && !(s.unread > 0 && prev && s.text !== prev.text)) return;
      // A chat that was not in the previous window: only trust it when it was just updated. Pinned chats occupy the top
      // rows, so the row index alone is not enough: a fresh time label ("刚刚", "N秒前", "1-2分钟前") counts too.
      if (!prev && index >= TOP_ROWS && !isFreshTime(s.time)) { log.debug(`「${s.name}」是新出现的会话但不在顶部且不是刚更新（第 ${index + 1} 行，${s.time}），已跳过`); return; }
      this.onMessage(s, isGroup, Math.max(0, s.unread - before - 1));
    });
  }

  private noteHandled(chat: string, texts: string[]): void {
    const list = this.handled.get(chat) ?? [];
    list.push(...texts);
    this.handled.set(chat, list.slice(-200));
  }

  private onMessage(s: WecomSession, isGroup: boolean, missed: number): void {
    const key = chatKey('wecom', s.name);
    const state = store.ensure(key, isGroup);
    const msg: ChatMessage = { id: store.id(), side: 'other', sender: isGroup ? s.sender : undefined, text: s.text, at: Date.now(), source: 'ocr' };
    store.append(key, [msg]);
    this.noteHandled(s.name, [s.text]);
    this.emit('chat', key, msg);
    log.info(`「${s.name}」新消息${missed > 0 ? `（另有 ${missed} 条未读不到）` : ''}：${isGroup && s.sender ? `${s.sender}: ` : ''}${s.text.slice(0, 120)}`);
    if (state.paused) return;

    const rule = matchRule(this.cfg, { app: 'wecom', chat: s.name, isGroup, messages: [msg], unseen: missed > 0 });
    if (!rule || rule.action === 'ignore') { log.debug(`「${s.name}」未命中规则${rule ? `（${rule.id}: ignore）` : ''}`); return; }
    if (rule.action !== 'script' || !rule.script) { log.debug(`「${s.name}」规则 ${rule.id} 不是脚本动作，企业微信暂不支持 AI 回复，已跳过`); return; }
    if (Date.now() - store.lastReply(key, rule.id) < rule.cooldownSec * 1000) { log.info(`「${s.name}」规则 ${rule.id} 冷却中`); return; }

    // Messages were missed and this chat hits a rule: open it and read them (the script then gets the whole burst).
    if (missed > 0 && this.cfg.apps.wecom.openMissed && !this.recovering.has(s.name)) {
      this.recovering.add(s.name);
      this.recoverQueue = this.recoverQueue
        .then(() => this.recover(s, isGroup, msg, missed, rule))
        .catch((e) => { log.warn(`「${s.name}」读取漏掉的消息失败：${errText(e)}`); this.fire(rule, s.name, isGroup, [msg], missed); })
        .finally(() => this.recovering.delete(s.name));
      return;
    }
    this.fire(rule, s.name, isGroup, [msg], missed);
  }

  private fire(rule: RuleConfig, chat: string, isGroup: boolean, messages: ChatMessage[], missed: number): void {
    if (!rule.script) return;
    store.markReply(chatKey('wecom', chat), rule.id);
    const me = this.cfg.apps.wecom.nickname || this.cfg.general.myNickname;
    const mentionedMe = messages.some((m) => isMention(m.text, me, true));
    log.info(`「${chat}」规则 ${rule.id} → 脚本 ${rule.script}${messages.length > 1 ? `（${messages.length} 条消息）` : ''}`);
    this.emit('script', rule.script, { app: 'wecom', chat, isGroup, rule: { id: rule.id, name: rule.name }, messages, mentionedMe, missed: Math.max(0, missed) } satisfies ScriptTrigger);
  }

  /** The chat open in the main window with its message texts (null when no chat is open / the tree has no message cells). */
  private async readPane(): Promise<ChatPane | null> {
    const w = await this.locate();
    const res = await this.driver.call('get_window_state', {
      pid: w.pid, window_id: w.windowId, include_accessibility_tree: true, include_screenshot: false, timeout_ms: PANE_MS, max_elements: PANE_NODES,
    }, PANE_MS + 10000);
    const out = structured<{ elements?: PaneElement[]; degraded?: boolean; degraded_reason?: string }>(res);
    if (out.degraded && /^screen_locked/.test(out.degraded_reason ?? '')) throw new ScreenLocked('屏幕已锁定');
    return parseChatPane(out.elements ?? []);
  }

  /** Window menu 窗口 → 选择下一个未读会话: switches the open chat without activating the app. Returns the new pane. */
  private async openNextUnread(from: string | undefined): Promise<ChatPane | null> {
    const w = await this.locate();
    await this.driver.call('invoke_menu', { pid: w.pid, window_id: w.windowId, path: MENU_NEXT_UNREAD });
    for (let i = 0; i < 3; i++) {
      await sleep(i ? 1000 : 700);
      const pane = await this.readPane();
      if (pane && !sameChat(pane.title, from)) return pane;
    }
    return null;
  }

  /** How many unread chats the "next unread" menu goes through to reach `target` when `current` is open (list order, wrapping). */
  private hopsTo(target: string, current: string | undefined): number {
    const unread = this.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.unread > 0 || sameChat(r.name, target));
    const t = unread.findIndex(({ r }) => sameChat(r.name, target));
    if (t < 0) return Infinity;
    const c = this.rows.findIndex((r) => sameChat(r.name, current));
    const ahead = unread.filter(({ i }) => i > c);
    const at = ahead.findIndex(({ r }) => sameChat(r.name, target));
    return at >= 0 ? at + 1 : ahead.length + t + 1;
  }

  /** Message texts of the newest `unread` cells of a pane that were not handed to the rules yet. */
  private newTexts(pane: ChatPane, s: WecomSession): string[] {
    const known = this.handled.get(s.name) ?? [];
    const head = (t: string) => t.replace(/^(\[(?:有人@我|@所有人|有人@你)\]\s*)+/, '').replace(/\s+/g, '').slice(0, 30);
    const seen = new Set(known.map(head));
    return pane.texts.slice(-Math.max(1, s.unread)).filter((t) => !seen.has(head(t)));
  }

  /** Builds chat messages from pane texts (senders are not told apart in the tree), records them and returns them. */
  private ingest(s: WecomSession, isGroup: boolean, texts: string[]): ChatMessage[] {
    const key = chatKey('wecom', s.name);
    const msgs = texts.map((text): ChatMessage => ({ id: store.id(), side: 'other', text, at: Date.now(), source: 'ocr' }));
    if (!msgs.length) return msgs;
    store.append(key, msgs);
    this.noteHandled(s.name, texts);
    for (const m of msgs) this.emit('chat', key, m);
    log.info(`「${s.name}」点开会话读到 ${msgs.length} 条漏掉的消息`);
    return msgs;
  }

  private async recover(s: WecomSession, isGroup: boolean, preview: ChatMessage, missed: number, rule: RuleConfig): Promise<void> {
    const give = (why: string) => { log.info(`「${s.name}」${why}，按会话列表里的最后一条处理`); this.fire(rule, s.name, isGroup, [preview], missed); };
    const w = await this.locate();
    if ((await frontmostPid()) === w.pid) return give('企业微信正在前台使用，不去切换会话');
    let pane = await this.readPane();
    if (pane && sameChat(pane.title, s.name)) return give('该会话已在窗口里打开，没有可读的新消息');
    const hops = this.hopsTo(s.name, pane?.title);
    if (hops > MAX_HOPS) return give(`要经过 ${hops} 个未读会话才能到达，超过上限 ${MAX_HOPS}`);
    for (let hop = 1; hop <= MAX_HOPS; hop++) {
      const next = await this.openNextUnread(pane?.title);
      if (!next) return give('切换会话后没有读到内容');
      if (sameChat(next.title, s.name)) {
        const recovered = this.ingest(s, isGroup, this.newTexts(next, s).filter((t) => !/^\s*$/.test(t)));
        // Cells come oldest first: the preview was handled already (skipped by newTexts), so the burst is recovered + preview.
        const all = [...recovered, preview];
        const key = chatKey('wecom', s.name);
        if (store.ensure(key, isGroup).paused) return;
        const hit = matchRule(this.cfg, { app: 'wecom', chat: s.name, isGroup, messages: all, senderUnknown: recovered.length > 0 });
        if (!hit || hit.action !== 'script' || !hit.script) { log.debug(`「${s.name}」读到完整消息后未命中脚本规则`); return; }
        this.fire(hit, s.name, isGroup, all, Math.max(0, missed - recovered.length));
        return;
      }
      // Opened on the way (now marked read): hand its messages to the rules like a normal burst.
      const row = this.rows.find((r) => sameChat(r.name, next.title));
      if (row) {
        const g = this.seen.get(row.name)?.isGroup ?? row.isGroup;
        const texts = this.newTexts(next, row);
        const msgs = this.ingest(row, g, texts);
        const hit = msgs.length ? matchRule(this.cfg, { app: 'wecom', chat: row.name, isGroup: g, messages: msgs, senderUnknown: true }) : null;
        if (hit?.action === 'script' && hit.script && Date.now() - store.lastReply(chatKey('wecom', row.name), hit.id) >= hit.cooldownSec * 1000) this.fire(hit, row.name, g, msgs, 0);
      }
      pane = next;
    }
    give(`连续打开 ${MAX_HOPS} 个未读会话仍未到达`);
  }
}
