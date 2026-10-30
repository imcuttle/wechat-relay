import { EventEmitter } from 'node:events';
import { chatKey, type AppConfig, type ChatMessage, type MonitorStatus, type SessionRow } from '@shared/types';
import { CONFIG_PATH } from './config';
import { CuaDriver, structured, text } from './driver';
import { isMention, matchRule } from './rules';
import type { ScriptTrigger } from './scripting/host';
import { store } from './store';
import { errText, logger } from './util';
import { parseSessions, type WecomSession } from './wecomParse';

const log = logger.scope('wecom');
const BUNDLE_ID = 'com.tencent.WeWorkMac';

/** Walk budget of one read: the session table is hundreds of rows, the newest ones are at the top. */
const WALK_MS = 5000;
const WALK_NODES = 400;
/** A session that appears in the window for the first time only counts as new when it is among the top rows (freshly updated). */
const TOP_ROWS = 4;

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
  private seen = new Map<string, Seen>();
  private baseline = false;
  private status: MonitorStatus = { app: 'wecom', running: false, driver: 'stopped', ticks: 0, replies: 0, busy: false, configPath: CONFIG_PATH };

  constructor(private cfg: AppConfig, private driver: CuaDriver) { super(); }

  setConfig(cfg: AppConfig): void { this.cfg = cfg; }

  getStatus(): MonitorStatus { return { ...this.status, busy: this.busy }; }
  private update(p: Partial<MonitorStatus>): void { Object.assign(this.status, p); this.emit('status', this.getStatus()); }

  async start(): Promise<void> {
    if (this.status.running) return;
    this.baseline = false;
    this.seen.clear();
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
    const w = await this.locate();
    let last = { sessions: [] as WecomSession[], tree: '' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000));
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
      last = { sessions, tree };
    }
    return last;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const { sessions, tree } = await this.read();
      this.update({ wechat: this.win ? { pid: this.win.pid, windowId: this.win.windowId, width: 0, height: 0 } : null, ticks: this.status.ticks + 1, lastTickAt: Date.now() });
      if (!sessions.length) throw new Error('没有读到企业微信的会话列表（是否已登录？首次需要授予辅助功能权限）');
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
      // A chat that was not in the previous window: only trust it when it is at the top (it was just updated).
      if (!prev && index >= TOP_ROWS) return;
      this.onMessage(s, isGroup, Math.max(0, s.unread - before - 1));
    });
  }

  private onMessage(s: WecomSession, isGroup: boolean, missed: number): void {
    const key = chatKey('wecom', s.name);
    const state = store.ensure(key, isGroup);
    const msg: ChatMessage = { id: store.id(), side: 'other', sender: isGroup ? s.sender : undefined, text: s.text, at: Date.now(), source: 'ocr' };
    store.append(key, [msg]);
    this.emit('chat', key, msg);
    log.info(`「${s.name}」新消息${missed > 0 ? `（另有 ${missed} 条未读未读到）` : ''}：${isGroup && s.sender ? `${s.sender}: ` : ''}${s.text.slice(0, 120)}`);
    if (state.paused) return;

    const rule = matchRule(this.cfg, { app: 'wecom', chat: s.name, isGroup, messages: [msg] });
    if (!rule || rule.action === 'ignore') { log.debug(`「${s.name}」未命中规则${rule ? `（${rule.id}: ignore）` : ''}`); return; }
    if (rule.action !== 'script' || !rule.script) { log.debug(`「${s.name}」规则 ${rule.id} 不是脚本动作，企业微信暂不支持 AI 回复，已跳过`); return; }
    if (Date.now() - store.lastReply(key, rule.id) < rule.cooldownSec * 1000) { log.info(`「${s.name}」规则 ${rule.id} 冷却中`); return; }
    store.markReply(key, rule.id);

    const me = this.cfg.apps.wecom.nickname || this.cfg.general.myNickname;
    const mentionedMe = isMention(s.text, me, true);
    log.info(`「${s.name}」规则 ${rule.id} → 脚本 ${rule.script}`);
    this.emit('script', rule.script, { app: 'wecom', chat: s.name, isGroup, rule: { id: rule.id, name: rule.name }, messages: [msg], mentionedMe, missed: Math.max(0, missed) } satisfies ScriptTrigger);
  }
}
