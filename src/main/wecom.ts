import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatKey, type AppConfig, type ChatMessage, type MonitorStatus, type RuleConfig, type SessionRow } from '@shared/types';
import { CONFIG_PATH, DATA_DIR } from './config';
import { CuaDriver, structured, text } from './driver';
import { isMention, matchRule } from './rules';
import type { ScriptTrigger } from './scripting/host';
import { store } from './store';
import { power } from './power';
import { errText, LogGate, logger, sleep } from './util';
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
const PANE_NODES = 3000;
/** Geometry of the session list in window points: a header row, then rows of equal height; one wheel "line" moves 48. */
const LIST_HEADER = 64;
const ROW_H = 64;
const WHEEL_LINE = 48;
/** The list is scrolled until the wanted row is inside [LIST_TOP, window height - LIST_BOTTOM]. */
const LIST_TOP = 110;
const LIST_BOTTOM = 40;
const LIST_X = 130;

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
const LOCKED_MSG = '屏幕已锁定，暂停读取企业微信（解锁后自动继续，期间的新消息会补上；想锁屏也监听请打开顶栏「不休眠」）';
/** While the screen is locked nothing is read: look again this often (the unlock itself also wakes the poll up). */
const LOCKED_POLL_MS = 10_000;

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
  /** The screen is locked (told by the power module): no driver calls, no failures, no log lines until it is unlocked. */
  private screenLocked = false;
  /** A condition that repeats every poll (empty tree, ...) is logged once, then rarely. */
  private gate = new LogGate();
  private seen = new Map<string, Seen>();
  private baseline = false;
  private rows: WecomSession[] = [];
  /** Recoveries run one at a time (they switch the chat shown in the window); a chat is queued once. */
  private recoverQueue: Promise<void> = Promise.resolve();
  private recovering = new Set<string>();
  private marking = new Set<string>();
  /** > 0 while the window is being driven (opening a chat): the poll must not read the window and drop the pixel snapshot. */
  private holding = 0;
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

  /** "Identify now": also forgets the cached window and the failure state, so a stale window id is resolved again. */
  tickOnce(): Promise<void> {
    this.win = null;
    this.emptyReads = 0;
    this.failures = 0;
    return this.tick();
  }

  /** The screen was locked / unlocked. Unlocking re-activates the monitor: window re-resolved, polling resumes at once. */
  setScreenLocked(locked: boolean): void {
    if (locked === this.screenLocked) return;
    this.screenLocked = locked;
    if (!this.status.running) return;
    if (locked) this.schedule(0); // the loop shows the locked state
    else this.activate('屏幕已解锁');
  }

  /** Drops everything that may be stale (window id, failure counters, log gates) and polls right away. */
  activate(reason: string): void {
    if (!this.status.running) return;
    this.win = null;
    this.emptyReads = 0;
    this.failures = 0;
    this.gate.reset();
    this.update({ driver: 'ready', driverError: undefined });
    log.info(`${reason}，已重新识别企业微信窗口并恢复监听`);
    this.schedule(0);
  }

  private interval(): number { return this.cfg.apps.wecom.pollIntervalMs ?? 3000; }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.status.running) return;
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop(): Promise<void> {
    if (this.screenLocked) {
      // Also covers a monitor started while the screen was already locked.
      if (this.status.driverError !== LOCKED_MSG) { log.info(LOCKED_MSG); this.update({ driver: 'ready', driverError: LOCKED_MSG }); }
      this.schedule(LOCKED_POLL_MS);
      return;
    }
    try {
      await this.tick();
      this.failures = 0;
      if (this.status.driver !== 'ready' || this.status.driverError) this.update({ driver: 'ready', driverError: undefined });
    } catch (e) {
      if (e instanceof ScreenLocked) {
        // Not an error: wait for the unlock (no back-off, the baseline is kept so messages that arrive meanwhile are picked up).
        this.failures = 0;
        if (this.status.driverError !== e.message && this.gate.pass('locked') !== null) log.info(e.message);
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
      if (out.degraded && /^screen_locked/.test(out.degraded_reason ?? '')) throw new ScreenLocked(LOCKED_MSG);
      const tree = out.tree_markdown ?? text(res);
      const sessions = parseSessions(tree);
      if (sessions.length) { this.gate.reset(); return { sessions, tree }; }
      const unresolved = /^ax_window_unresolved/.test(out.degraded_reason ?? '');
      // Every window of another app is hidden behind a locked screen, which the driver reports as an unresolved window.
      if (unresolved && await power.refreshLocked()) throw new ScreenLocked(LOCKED_MSG);
      // The same empty read every 3 seconds: log it once, then at most every 10 minutes.
      const why = unresolved ? 'ax_window_unresolved' : (out.degraded_reason ?? 'empty').split(':')[0];
      const skipped = this.gate.pass(`empty:${why}`);
      if (skipped !== null) log.debug(`会话列表为空（${why}）${skipped ? `，期间省略了 ${skipped} 条相同日志` : ''}：${text(res).slice(0, 200)}`);
      // The window id went stale (window recreated / re-parented): resolve it again on the next attempt.
      if (unresolved) this.win = null;
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
    if (this.busy || this.holding) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const { sessions, tree } = await this.read();
      this.update({ wechat: this.win ? { pid: this.win.pid, windowId: this.win.windowId, width: 0, height: 0 } : null, ticks: this.status.ticks + 1, lastTickAt: Date.now() });
      if (!sessions.length) {
        // Momentary (window being redrawn / switching views): not worth an error or a back-off; only a persistent failure is.
        if (++this.emptyReads < 3) return;
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
    const onDone = this.cfg.apps.wecom.readAfterScript ? (ok: boolean) => { if (ok) this.markRead(chat); } : undefined;
    this.emit('script', rule.script, { app: 'wecom', chat, isGroup, rule: { id: rule.id, name: rule.name }, messages, mentionedMe, missed: Math.max(0, missed), onDone } satisfies ScriptTrigger);
  }

  /** One read of the main window's tree (with an inline screenshot when pixel input will follow). */
  private async readState(shot: boolean): Promise<{ elements: PaneElement[]; tree: string; shotWidth: number; bounds: { x: number; y: number; width: number; height: number } | null }> {
    const w = await this.locate();
    const res = await this.driver.call('get_window_state', {
      pid: w.pid, window_id: w.windowId, include_accessibility_tree: true, include_screenshot: shot, ...(shot ? { max_image_dimension: 1200 } : {}),
      timeout_ms: PANE_MS, max_elements: PANE_NODES,
    }, PANE_MS + 10000);
    const out = structured<{ elements?: PaneElement[]; tree_markdown?: string; degraded?: boolean; degraded_reason?: string; screenshot_width?: number; window_bounds?: { x: number; y: number; width: number; height: number } }>(res);
    if (out.degraded && /^screen_locked/.test(out.degraded_reason ?? '')) throw new ScreenLocked('屏幕已锁定');
    if (shot && !res.content?.some((b) => b.type === 'image')) throw new Error('无法截取企业微信窗口（窗口隐藏在托盘或缺少屏幕录制权限）');
    return { elements: out.elements ?? [], tree: out.tree_markdown ?? '', shotWidth: out.screenshot_width ?? 0, bounds: out.window_bounds ?? null };
  }

  /** The chat open in the main window with its message texts (null when no chat is open / the tree has no message cells). */
  private async readPane(): Promise<ChatPane | null> {
    return parseChatPane((await this.readState(false)).elements);
  }

  /**
   * Scrolls the session list (wheel events posted to the window, no focus change) until the row of `name` is on screen and
   * posts a click on it. `shift` corrects the row geometry (window points). Returns the row index and the list as read.
   */
  private async clickRow(name: string, shift: number): Promise<{ idx: number; names: string[] } | { why: string }> {
    const w = await this.locate();
    // After a scroll the list keeps animating for a moment: click only when two reads in a row see it at the same place.
    let lastY: number | null = null;
    let scrolled = false;
    for (let i = 0; i < 12; i++) {
      const st = await this.readState(true);
      if (!st.bounds || !st.shotWidth) return { why: '读不到企业微信窗口的位置' };
      const names = parseSessions(st.tree).map((r) => r.name);
      const idx = names.findIndex((n) => n === name) >= 0 ? names.findIndex((n) => n === name) : names.findIndex((n) => sameChat(n, name));
      if (idx < 0) return { why: '会话不在列表里（可能被折叠或太靠后）' };
      const table = st.elements.find((e) => e.role === 'AXTable' && e.frame && e.frame.x < st.bounds!.x + 300);
      if (!table?.frame) return { why: '读不到会话列表的位置' };
      const k = st.shotWidth / st.bounds.width;
      const y = table.frame.y - st.bounds.y + LIST_HEADER + idx * ROW_H + ROW_H / 2 + shift;
      const stable = !scrolled || lastY === table.frame.y;
      lastY = table.frame.y;
      if (!stable) { await sleep(500); continue; }
      if (y >= LIST_TOP && y <= st.bounds.height - LIST_BOTTOM) {
        await this.driver.call('click', { pid: w.pid, window_id: w.windowId, x: Math.round(LIST_X * k), y: Math.round(y * k), delivery_mode: 'background' });
        return { idx, names };
      }
      const delta = y - st.bounds.height / 2;
      const lines = Math.max(1, Math.min(20, Math.round(Math.abs(delta) / WHEEL_LINE)));
      await this.driver.call('scroll', { pid: w.pid, window_id: w.windowId, x: Math.round(LIST_X * k), y: Math.round((st.bounds.height / 2) * k), direction: delta > 0 ? 'down' : 'up', amount: lines, by: 'line', delivery_mode: 'background' });
      scrolled = true;
      lastY = null;
      await sleep(1200);
    }
    return { why: '滚动会话列表后仍没有定位到该会话' };
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

  /**
   * Opens the chat `name` in the main window: scrolls the session list to its row (also rows below the viewport) and
   * posts a click on it, all in the background (the app is never activated, the pointer does not move). The result is
   * verified by the chat title; a row off by a few (list reordered / odd row heights) is corrected once.
   */
  private async openChat(name: string): Promise<{ pane: ChatPane; already: boolean } | { why: string }> {
    const w = await this.locate();
    if ((await frontmostPid()) === w.pid) return { why: '企业微信正在前台使用，不去切换会话' };
    this.holding++;
    try {
      let pane = await this.readPane();
      if (pane && sameChat(pane.title, name)) return { pane, already: true };
      let shift = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const c = await this.clickRow(name, shift);
        if ('why' in c) return c;
        await sleep(700);
        pane = await this.readPane();
        if (pane && sameChat(pane.title, name)) return { pane, already: false };
        const at = c.names.findIndex((n) => sameChat(n, pane?.title));
        if (at < 0) break;
        shift += (c.idx - at) * ROW_H;
      }
      return { why: `点击后打开的是「${pane?.title ?? '?'}」而不是目标会话` };
    } catch (e) {
      return { why: errText(e) };
    } finally { this.holding--; }
  }

  private async recover(s: WecomSession, isGroup: boolean, preview: ChatMessage, missed: number, rule: RuleConfig): Promise<void> {
    const give = (why: string) => { log.info(`「${s.name}」${why}，按会话列表里的最后一条处理`); this.fire(rule, s.name, isGroup, [preview], missed); };
    const r = await this.openChat(s.name);
    if ('why' in r) return give(r.why);
    if (r.already) return give('该会话已在窗口里打开，没有可读的新消息');
    // Cells come oldest first: the preview was handled already (skipped by newTexts), so the burst is recovered + preview.
    const recovered = this.ingest(s, isGroup, this.newTexts(r.pane, s));
    const all = [...recovered, preview];
    if (store.ensure(chatKey('wecom', s.name), isGroup).paused) return;
    const hit = matchRule(this.cfg, { app: 'wecom', chat: s.name, isGroup, messages: all, senderUnknown: recovered.length > 0 });
    if (!hit || hit.action !== 'script' || !hit.script) { log.debug(`「${s.name}」读到完整消息后未命中脚本规则`); return; }
    this.fire(hit, s.name, isGroup, all, Math.max(0, missed - recovered.length));
  }

  /** After a script handled a chat's messages: open exactly that chat so that WeCom marks it read (no-op when it has no unread left). */
  private markRead(chat: string): void {
    if (this.marking.has(chat)) return;
    this.marking.add(chat);
    this.recoverQueue = this.recoverQueue
      .then(async () => {
        const row = this.rows.find((r) => sameChat(r.name, chat));
        if (!row || row.unread <= 0) return;
        const r = await this.openChat(chat);
        if ('why' in r) log.info(`「${chat}」脚本执行完成，未能标为已读：${r.why}`);
        else if (!r.already) log.info(`「${chat}」脚本执行完成，已点开会话标为已读`);
      })
      .catch((e) => log.warn(`「${chat}」标为已读失败：${errText(e)}`))
      .finally(() => this.marking.delete(chat));
  }
}
