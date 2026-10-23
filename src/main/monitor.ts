import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, ChatMessage, Draft, MonitorStatus, RuleConfig, VisionMessage } from '@shared/types';
import { runAgent } from './agent/engine';
import { ContextWindows } from './agent/window';
import { CONFIG_PATH, MEDIA_DIR } from './config';
import { CuaDriver } from './driver';
import { matchRule } from './rules';
import { dropImages, store } from './store';
import { parseWxTime, stamp } from './timeline';
import { errText, isNoiseText, logger, sleep } from './util';
import { Vision } from './vision';
import { NotInListError, SafetyStop, WeChat, normText, sameChat, similarity, type Frame } from './wechat';

const log = logger.scope('monitor');

/** Limits of syncHistory: at most this many scroll steps / messages. */
const SYNC_STEPS = 60;
const SYNC_MAX = 300;

interface Pending { chat: string; isGroup: boolean; rule: RuleConfig; incoming: ChatMessage[]; due: number }

/** A message (or time separator) as seen on one screenshot. */
interface Seen extends Omit<ChatMessage, 'side'> {
  side: 'self' | 'other' | 'system';
  vkind: VisionMessage['kind'];
  box?: VisionMessage['box'];
}

/**
 * The same message can be read as text ("......"), as an image ("[图片]") or as an image with OCR text
 * ("[图片] ......") on different screenshots, so compare without the image marker; a bare placeholder
 * (no text left) could be any message on that side and matches anything there.
 */
const stripMark = (t: string) => t.replace(/^\s*\[(图片|非文本消息)\]\s*/, '');
const sameMsg = (a: { side: string; text: string }, b: { side: string; text: string }) => {
  if (a.side !== b.side) return false;
  const x = stripMark(a.text), y = stripMark(b.text);
  return !x.trim() || !y.trim() || normText(x) === normText(y) || similarity(x, y) >= 0.8;
};

/** Largest k such that the last k items of `older` are the first k items of `newer`. */
function overlap(older: Seen[], newer: Seen[]): number {
  for (let k = Math.min(older.length, newer.length); k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k && ok; i++) ok = sameMsg(older[older.length - k + i], newer[i]);
    if (ok) return k;
  }
  return 0;
}

const signature = (xs: Seen[]) => xs.map((m) => `${m.side}:${normText(m.text)}`).join('|');

/** Messages plus time separators on screen, top → bottom, with estimated send times. */
function seen(frame: Frame): Seen[] {
  const items: Seen[] = frame.vision.messages
    .filter((m) => !m.partial && (m.side !== 'system' || m.kind === 'time') && !isNoiseText(m.text))
    .map((m) => ({
      id: '', side: m.side, sender: m.sender ?? undefined, text: m.text, at: 0, source: 'ocr' as const,
      vkind: m.kind, box: m.box, ...(m.kind === 'image' ? { kind: 'image' as const } : {}),
    }));
  stamp(items.map((m) => ({ side: m.side, kind: m.vkind, text: m.text }))).forEach((t, i) => { items[i].at = t; });
  return items;
}

const isMsg = (m: Seen): m is Seen & { side: 'self' | 'other' } => m.side !== 'system';
function toMessage(m: Seen): ChatMessage {
  const { vkind: _k, box: _b, ...rest } = m;
  return rest as ChatMessage;
}

/**
 * Returns the index in `visible` where unseen messages start, or -1 when the screen does not overlap the stored tail.
 * The overlap must reach back to the top of the screen or cover at least 3 messages.
 */
export function newStart(stored: ChatMessage[], visible: ChatMessage[]): number {
  if (!stored.length) return -1;
  for (let b = visible.length; b >= 1; b--) {
    let m = 0;
    while (m < b && m < stored.length && sameMsg(visible[b - 1 - m], stored[stored.length - 1 - m])) m++;
    if (m >= Math.min(b, 3) && m > 0) return b;
  }
  return -1;
}

/**
 * True when the screen matches a run of stored messages that ends before the stored tail, i.e. the chat is scrolled up
 * to older, already recorded content. Such a screen has nothing new and must not trigger a resync (duplicates).
 */
export function scrolledBack(stored: ChatMessage[], visible: ChatMessage[]): boolean {
  const need = Math.min(3, visible.length);
  if (!need) return false;
  for (let i = 0; i + need <= visible.length; i++) {
    for (let j = 0; j + need <= stored.length; j++) {
      let k = 0;
      while (i + k < visible.length && j + k < stored.length && sameMsg(visible[i + k], stored[j + k])) k++;
      if (k >= need && j + k < stored.length) return true;
    }
  }
  return false;
}

/** Serialises everything that touches the WeChat window. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  busy = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => { this.busy = true; try { return await fn(); } finally { this.busy = false; } });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class Monitor extends EventEmitter {
  readonly driver: CuaDriver;
  readonly vision: Vision;
  readonly wechat: WeChat;
  private timer: NodeJS.Timeout | null = null;
  private lock = new Mutex();
  private pending = new Map<string, Pending>();
  /** Batched context windows per chat (keeps the prompt prefix cacheable). */
  private windows = new ContextWindows();
  private sentAt: number[] = [];
  /** Recently sent texts per chat, to tag our own messages when they show up on screen. */
  private botSent = new Map<string, string[]>();
  /** Chats whose history before the first screen we saw is unknown: scroll up to read it before replying. */
  private needBackfill = new Set<string>();
  private failures = 0;
  private status: MonitorStatus;

  constructor(private cfg: AppConfig, visionBin: string) {
    super();
    this.driver = new CuaDriver(cfg.driver);
    this.vision = new Vision(visionBin);
    this.wechat = new WeChat(this.driver, this.vision, () => ({
      foreground: this.cfg.driver.deliveryMode === 'foreground',
      restoreClipboard: this.cfg.general.restoreClipboard,
    }));
    this.status = { running: false, driver: 'stopped', ticks: 0, replies: 0, busy: false, configPath: CONFIG_PATH };
  }

  setConfig(cfg: AppConfig): void {
    this.cfg = cfg;
    this.driver.setConfig(cfg.driver);
    if (this.status.running) this.schedule(0);
  }

  getStatus(): MonitorStatus { return { ...this.status, busy: this.lock.busy }; }
  private update(p: Partial<MonitorStatus>): void { Object.assign(this.status, p); this.emit('status', this.getStatus()); }

  async start(): Promise<void> {
    if (this.status.running) return;
    this.update({ running: true, driver: 'starting', driverError: undefined });
    try {
      const perms = await this.wechat.permissions();
      this.update({ permissions: perms, driver: 'ready' });
      if (!perms.accessibility || !perms.screenRecording) log.warn('Cua Driver 缺少辅助功能 / 屏幕录制权限');
    } catch (e) {
      this.update({ driver: 'error', driverError: errText(e) });
      log.error(errText(e));
    }
    log.info('监听已启动');
    this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.update({ running: false });
    log.info('监听已停止');
  }

  async dispose(): Promise<void> { this.stop(); this.vision.close(); await this.driver.close(); }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.status.running) return;
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop(): Promise<void> {
    try {
      await this.lock.run(() => this.tick());
      this.failures = 0;
      if (this.status.driver !== 'ready') this.update({ driver: 'ready', driverError: undefined });
    } catch (e) {
      this.failures++;
      const msg = this.wechat.describeError(e);
      if (e instanceof SafetyStop) {
        log.error(`安全停止：${msg}`);
        this.cfg.general.autoReply = false;
        this.emit('safety', msg);
      } else if (this.failures <= 3 || this.failures % 20 === 0) log.warn(msg);
      if (/cua-driver|driver|not connected|closed/i.test(msg)) this.update({ driver: 'error', driverError: msg });
    }
    this.schedule(Math.min(this.cfg.general.pollIntervalMs * Math.max(1, this.failures), 30000));
  }

  tickOnce(): Promise<void> { return this.lock.run(() => this.tick()); }

  private async tick(): Promise<void> {
    const t0 = Date.now();
    const frame = await this.wechat.capture();
    const w = this.wechat.win;
    this.update({ wechat: w ? { ...w } : null, currentChat: frame.vision.title ?? null, ticks: this.status.ticks + 1, lastTickAt: Date.now() });
    this.emit('frame', frame);

    await this.ingest(frame, 0);
    const canAct = this.cfg.general.autoReply && !(await this.wechat.isFrontmost());

    // 1. Replies whose delay elapsed.
    for (const p of [...this.pending.values()]) {
      if (p.due > Date.now()) continue;
      this.pending.delete(p.chat);
      await this.reply(p, canAct);
    }

    // 2. Open one unread chat that a reply rule would handle.
    if (canAct && this.cfg.general.openUnreadChats && !this.pending.size) {
      const row = frame.vision.sessions.find((s) => s.unread && !s.selected && !store.chat(s.name)?.paused &&
        matchRule(this.cfg, { chat: s.name, isGroup: store.chat(s.name)?.isGroup ?? /[：:]/.test(s.preview), messages: [], mentionedHint: s.mentioned }, true)?.action === 'reply');
      if (row) {
        const unread = Number(/\[(\d+)\s*条\]/.exec(row.preview.replace(/[［］]/g, (c) => (c === '［' ? '[' : ']')))?.[1] ?? 1);
        log.info(`打开未读会话「${row.name}」（${unread} 条）`);
        const previous = frame.vision.title;
        const opened = await this.wechat.openChat(row.name, frame);
        await this.ingest(opened, unread);
        if (this.cfg.general.restoreChat && previous && !this.pending.size) await this.wechat.openChat(previous).catch(() => undefined);
      }
    }
    this.update({ lastTickMs: Date.now() - t0 });
  }

  /** Saves compressed crops of image messages (must run before the frame file is overwritten by a later capture). */
  private async saveImages(frame: Frame, msgs: Seen[]): Promise<void> {
    mkdirSync(MEDIA_DIR, { recursive: true });
    for (const m of msgs) {
      if (m.kind !== 'image' || !m.box || m.image) continue;
      const out = join(MEDIA_DIR, `${m.id || store.id()}.jpg`);
      try {
        const r = await this.vision.crop(frame.path, m.box, out, this.cfg.general.imageMaxSize || 768);
        if (!r.ok) { log.debug(`图片裁剪失败：${r.error}`); continue; }
        await this.checkImage(m, out, r.std);
        (m as { checked?: boolean }).checked = true;
      } catch (e) { log.debug(`图片裁剪失败：${errText(e)}`); }
    }
  }

  /**
   * Keeps an image crop only when it is usable: a blank / black crop (screen not rendered yet) or a tiny one (a
   * mis-detected text bubble) is dropped and the message falls back to the crop's OCR text. Images without OCR text
   * get the text read from the crop, so text-only models (and the fallback) still see what it says.
   */
  private async checkImage(m: { text: string; kind?: 'text' | 'image'; image?: string }, path: string, std?: number): Promise<void> {
    const o = await this.vision.ocr(path).catch(() => null);
    const s = std ?? o?.std ?? 0;
    const raw = o?.text.trim() ?? '';
    const text = /^[•·.。…⋯\s]+$/.test(raw) ? '……' : raw;
    const tiny = !!o && Math.min(o.width, o.height) < 90;
    if (s < 6 || tiny) {
      rmSync(path, { force: true });
      delete m.image;
      if (tiny && text) { m.kind = 'text'; m.text = text; } else m.text = text ? `[图片] ${text}` : m.text;
      log.debug(`图片不可用（${tiny ? '尺寸过小' : '空白/黑屏'}），改用 OCR 文字：${m.text.slice(0, 40)}`);
      return;
    }
    m.image = path;
    if (text && normText(m.text) === normText('[图片]')) m.text = `[图片] ${text}`;
  }

  /** One-off repair of image messages stored before checkImage existed (black / tiny crops sent to the model). */
  async repairImages(): Promise<void> {
    let fixed = 0;
    for (const c of store.summaries()) {
      const msgs = store.history(c.name).filter((m) => m.kind === 'image' && m.image && existsSync(m.image) && !m.checked);
      for (const m of msgs) {
        const before = m.text;
        await this.checkImage(m, m.image!);
        m.checked = true;
        if (m.text !== before || !m.image) fixed++;
      }
      if (msgs.length) store.touch();
    }
    if (fixed) log.info(`已修复 ${fixed} 条图片消息（无效截图改用 OCR 文字）`);
  }

  /** Tags messages that match something this app sent as bot messages (also for re-read old messages after a resync). */
  private tagBot(name: string, msgs: { side: string; text: string; source: 'ocr' | 'bot' }[]): void {
    const sent = this.botSent.get(name);
    if (!sent?.length) return;
    for (const m of msgs) if (m.side === 'self' && sent.some((t) => similarity(t, m.text) >= 0.7)) m.source = 'bot';
  }

  /** Diff the open chat against stored history; schedule replies for new incoming messages. */
  private async ingest(frame: Frame, unreadHint: number): Promise<void> {
    const chat = frame.vision.title;
    if (!chat) return;
    const isGroup = frame.vision.isGroup;
    const name = store.summaries().find((c) => sameChat(c.name, chat))?.name ?? chat;
    const now = Date.now();
    const visible = seen(frame).filter(isMsg);
    if (!visible.length) return;

    const state = store.ensure(name, isGroup);
    let start = newStart(state.messages, visible);
    if (start < 0 && state.messages.length && scrolledBack(state.messages, visible)) {
      log.debug(`「${name}」屏幕显示的是已记录的较早内容（可能在向上翻看历史），跳过`);
      return;
    }
    if (start < 0) {
      if (state.messages.length) log.debug(`「${name}」屏幕内容与记录无重叠，重新同步`);
      this.needBackfill.add(name);
      // First sight (or resync): everything on screen is old unless the chat had an unread badge.
      const others = visible.map((m, i) => ({ m, i })).filter((x) => x.m.side === 'other');
      start = unreadHint > 0 && others.length ? others[Math.max(0, others.length - unreadHint)].i : visible.length;
      const old = visible.slice(0, start);
      for (const m of old) m.id = store.id();
      this.tagBot(name, old);
      await this.saveImages(frame, old);
      store.append(name, old.map(toMessage));
    }
    const fresh = visible.slice(start);
    if (!fresh.length) return;
    for (const m of fresh) {
      m.id = store.id();
      m.at = now;
    }
    this.tagBot(name, fresh);
    await this.saveImages(frame, fresh);
    const msgs = fresh.map(toMessage);
    for (const m of msgs) this.emit('chat', name, m);
    store.append(name, msgs);
    log.info(`「${name}」新消息 ${msgs.length} 条：${msgs.map((m) => `${m.side === 'self' ? '我' : m.sender || '对方'}: ${m.text}`).join(' / ').slice(0, 200)}`);

    // A message typed by the user themself cancels a pending auto-reply.
    if (msgs.some((m) => m.side === 'self' && m.source !== 'bot')) { this.pending.delete(name); return; }
    const incoming = msgs.filter((m) => m.side === 'other');
    if (!incoming.length || state.paused) return;

    const rule = matchRule(this.cfg, { chat: name, isGroup, messages: incoming });
    if (!rule || rule.action === 'ignore') { log.debug(`「${name}」未命中回复规则${rule ? `（${rule.id}: ignore）` : ''}`); return; }
    if (Date.now() - store.lastReply(name, rule.id) < rule.cooldownSec * 1000) { log.info(`「${name}」规则 ${rule.id} 冷却中`); return; }

    const [lo, hi] = this.cfg.general.replyDelayMs;
    const prev = this.pending.get(name);
    this.pending.set(name, {
      chat: name, isGroup, rule,
      incoming: [...(prev?.incoming ?? []), ...incoming],
      due: Date.now() + lo + Math.random() * Math.max(0, hi - lo),
    });
  }

  private async reply(p: Pending, canAct: boolean): Promise<void> {
    const agentId = p.rule.agent ?? this.cfg.agents[0]?.id;
    if (!agentId) { log.warn('没有可用的 agent'); return; }
    const mode = p.rule.mode && p.rule.mode !== 'inherit' ? p.rule.mode : this.cfg.general.mode;
    const minutes = this.cfg.general.historyMinutes;
    if (minutes > 0 && this.needBackfill.has(p.chat)) {
      try { await this.backfill(p.chat, canAct); } catch (e) {
        if (e instanceof SafetyStop) throw e;
        log.warn(`读取「${p.chat}」更早的消息失败：${this.wechat.describeError(e)}`);
      }
    }
    const all = store.history(p.chat);
    const { history, dropped } = this.windows.select(p.chat, all, p.incoming, { limit: this.cfg.general.historyLimit, minutes });
    if (dropped) log.info(`「${p.chat}」上下文压缩：丢弃 ${dropped} 条较早的消息，保留 ${history.length} 条`);
    log.info(`「${p.chat}」→ agent ${agentId}（规则 ${p.rule.id}，${mode === 'auto' ? '自动发送' : '待审核'}，上下文 ${Math.min(history.length, this.cfg.general.historyLimit)} 条）`);
    const t0 = Date.now();
    let out;
    try {
      out = await runAgent(this.cfg, agentId, { chat: p.chat, isGroup: p.isGroup, history, allHistory: all, incoming: p.incoming });
    } catch (e) {
      log.error(`agent ${agentId} 失败：${errText(e)}`);
      return;
    }
    for (const t of out.trace) log.debug(t);
    if (out.skipped || !out.reply) { log.info(`「${p.chat}」agent 决定不回复${out.reason ? `：${out.reason}` : ''}（${Date.now() - t0}ms）`); return; }

    const draft: Draft = {
      id: store.id(), chat: p.chat, text: out.reply, agent: agentId, rule: p.rule.id, createdAt: Date.now(), status: 'pending',
      trigger: p.incoming.map((m) => (m.sender ? `${m.sender}: ${m.text}` : m.text)).join('\n'),
    };
    store.markReply(p.chat, p.rule.id);
    if (mode !== 'auto' || !canAct) {
      if (mode === 'auto') log.warn('微信在前台或自动回复已关闭，回复转为草稿');
      store.upsertDraft(draft);
      this.emit('draft', draft);
      return;
    }
    await this.deliver(draft);
  }

  /**
   * Reads messages above the first screen we saw: scrolls the chat up in the background until a time separator older
   * than `historyMinutes` (or enough messages / the top of the chat) is visible, scrolls back down and merges the older
   * messages into the stored history. Must run inside the lock.
   */
  private async backfill(chat: string, canAct: boolean): Promise<void> {
    if (await this.wechat.isFrontmost()) return; // the user is in WeChat: try again on the next reply
    let f = await this.wechat.capture();
    if (!sameChat(f.vision.title, chat)) {
      if (!canAct) return;
      f = await this.wechat.openChat(chat, f);
    }
    this.needBackfill.delete(chat);
    const g = this.cfg.general;
    const cutoff = Date.now() - g.historyMinutes * 60000;
    let items = seen(f);
    for (const m of items) if (isMsg(m)) m.id = store.id();
    await this.saveImages(f, items);
    const covered = () => items.filter(isMsg).length >= g.historyLimit + 5 ||
      items.some((m) => m.vkind === 'time' && (parseWxTime(m.text) ?? Infinity) <= cutoff);

    let scrolls = 0, amount = 5, prev = signature(items);
    try {
      for (let step = 0; step < 12 && !covered(); step++) {
        await this.wechat.scrollChat(f, 'up', amount);
        scrolls++;
        await sleep(350);
        const next = await this.wechat.capture();
        if (!sameChat(next.vision.title, chat)) throw new Error(`滚动时会话变成了「${next.vision.title ?? '无'}」`);
        f = next;
        const older = seen(next);
        const sig = signature(older);
        if (sig === prev) break; // top of the chat
        prev = sig;
        const k = overlap(older, items);
        if (!k) log.debug(`「${chat}」向上滚动后与已读内容无重叠，可能漏掉部分消息`);
        const add = older.slice(0, older.length - k);
        if (!add.length) { amount = Math.min(amount * 2, 30); continue; }
        for (const m of add) if (isMsg(m)) m.id = store.id();
        await this.saveImages(next, add);
        items = [...add, ...items];
      }
    } finally {
      if (scrolls) await this.scrollToBottom(f, scrolls);
    }

    stamp(items.map((m) => ({ side: m.side, kind: m.vkind, text: m.text }))).forEach((t, i) => { items[i].at = t; });
    const read = items.filter(isMsg).map(toMessage);
    const stored = store.history(chat);
    let m = 0;
    while (m < read.length && m < stored.length && sameMsg(read[read.length - 1 - m], stored[stored.length - 1 - m])) m++;
    const head = read.slice(0, read.length - m);
    const prefix = stored.slice(0, stored.length - m);
    const p = m ? newStart(prefix, head) : -1;
    const added = m ? (p >= 0 ? head.slice(p) : head) : [];
    this.tagBot(chat, added);
    dropImages(read.filter((x) => !added.includes(x)));
    if (!m) { log.warn(`「${chat}」读取的历史与当前记录对不上，已忽略`); return; }
    if (added.length) store.replace(chat, [...prefix, ...added, ...stored.slice(stored.length - m)]);
    log.info(`「${chat}」向上读取了 ${added.length} 条更早的消息（滚动 ${scrolls} 次）`);
  }

  /**
   * Rebuilds a chat's stored history from WeChat itself: opens the chat in the background, scrolls up until the last
   * `historyMinutes` minutes are covered (0 = to the top, or `SYNC_MAX` messages), reads every screen, scrolls back down and replaces the records with what was read, in
   * on-screen (= chronological) order. Bot tags and send times of messages we already knew are kept.
   */
  syncHistory(chat: string): Promise<{ count: number; scrolls: number; reachedTop: boolean }> {
    const name = store.summaries().find((c) => sameChat(c.name, chat))?.name ?? chat;
    if (!store.chat(name)) throw new Error(`没有「${chat}」的会话记录`);
    return this.lock.run(async () => {
      if (await this.wechat.isFrontmost()) throw new Error('微信正在前台使用中，为避免打扰暂不同步，请切到其他应用后重试');
      let f = await this.wechat.capture();
      const previous = f.vision.title;
      if (!sameChat(f.vision.title, name)) {
        try { f = await this.wechat.openChat(name, f); } catch (e) {
          if (e instanceof NotInListError) throw new Error('微信会话列表里暂时没有该会话，请先在微信里让它出现在列表中');
          throw e;
        }
      }
      const minutes = this.cfg.general.historyMinutes;
      const now = Date.now();
      const cutoff = minutes > 0 ? now - minutes * 60000 : 0;
      log.info(`开始同步「${name}」的历史记录（${minutes > 0 ? `最近 ${minutes} 分钟` : '不限时间'}）`);
      // A time separator at or before the cutoff is on screen: everything older is out of range.
      const covered = () => cutoff > 0 && items.some((m) => m.vkind === 'time' && (parseWxTime(m.text, now) ?? Infinity) <= cutoff);
      let items = seen(f);
      for (const m of items) if (isMsg(m)) m.id = store.id();
      await this.saveImages(f, items);

      let scrolls = 0, amount = 5, prev = signature(items), reachedTop = false;
      try {
        for (let step = 0; step < SYNC_STEPS; step++) {
          if (items.filter(isMsg).length >= SYNC_MAX || covered()) break;
          await this.wechat.scrollChat(f, 'up', amount);
          scrolls++;
          await sleep(600); // let images / earlier messages render
          const next = await this.wechat.capture();
          if (!sameChat(next.vision.title, name)) throw new Error(`滚动时会话变成了「${next.vision.title ?? '无'}」`);
          f = next;
          const older = seen(next);
          const sig = signature(older);
          if (sig === prev) { reachedTop = true; break; }
          prev = sig;
          const k = overlap(older, items);
          if (!k) log.debug(`「${name}」向上滚动后与已读内容无重叠，可能漏掉部分消息`);
          const add = older.slice(0, older.length - k);
          if (!add.length) { amount = Math.min(amount * 2, 30); continue; }
          for (const m of add) if (isMsg(m)) m.id = store.id();
          await this.saveImages(next, add);
          items = [...add, ...items];
        }
      } finally {
        if (scrolls) await this.scrollToBottom(f, scrolls);
      }

      stamp(items.map((m) => ({ side: m.side, kind: m.vkind, text: m.text })), now).forEach((t, i) => { items[i].at = t; });
      const all = items.filter(isMsg);
      const kept = all.filter((m) => m.at >= cutoff);
      dropImages(all.filter((m) => !kept.includes(m)));
      const read = kept.map(toMessage);
      if (!read.length) throw new Error('没有读取到任何消息');

      // Keep what we already knew about a message: it was sent by the bot, and when it was first seen.
      const stored = store.history(name);
      const same = (a: ChatMessage, b: ChatMessage) => a.side === b.side && normText(a.text) !== '' &&
        (normText(a.text) === normText(b.text) || similarity(a.text, b.text) >= 0.8);
      let j = 0;
      for (const m of read) {
        const k = stored.findIndex((x, i) => i >= j && same(x, m));
        if (k < 0) continue;
        j = k + 1;
        if (stored[k].source === 'bot') m.source = 'bot';
        if (m.at === now) m.at = stored[k].at;
      }
      this.tagBot(name, read);
      for (let i = read.length - 2; i >= 0; i--) read[i].at = Math.min(read[i].at, read[i + 1].at);

      store.ensure(name, f.vision.isGroup);
      store.replace(name, read);
      this.needBackfill.delete(name);
      this.emit('chat', name);
      log.info(`「${name}」历史同步完成：${read.length} 条（滚动 ${scrolls} 次${reachedTop ? '，已到顶部' : ''}）`);
      if (this.cfg.general.restoreChat && previous && !sameChat(previous, name)) await this.wechat.openChat(previous).catch(() => undefined);
      return { count: read.length, scrolls, reachedTop };
    });
  }

  private async scrollToBottom(f: Frame, scrolls: number): Promise<void> {
    let prev = '';
    for (let i = 0; i < scrolls + 4; i++) {
      await this.wechat.scrollChat(f, 'down', 30);
      await sleep(300);
      f = await this.wechat.capture();
      const sig = signature(seen(f));
      if (sig === prev) return;
      prev = sig;
    }
    log.warn('滚动回聊天底部后画面仍在变化，下一轮将重新同步');
  }

  private rateLimited(): boolean {
    const now = Date.now();
    this.sentAt = this.sentAt.filter((t) => now - t < 60000);
    return this.sentAt.length >= this.cfg.general.maxRepliesPerMinute;
  }

  /** Must run inside the lock. */
  private async deliver(draft: Draft): Promise<void> {
    if (this.rateLimited()) {
      draft.status = 'pending'; draft.error = '超过每分钟发送上限，已转为草稿';
      log.warn(draft.error);
    } else {
      try {
        const last = store.history(draft.chat).at(-1);
        const frame = await this.wechat.sendText(draft.chat, draft.text);
        this.sentAt.push(Date.now());
        // Manual sends are the user's own messages: leave them untagged so they show as「我」.
        if (draft.agent !== 'manual') {
          const list = this.botSent.get(draft.chat) ?? [];
          list.push(draft.text); if (list.length > 20) list.shift();
          this.botSent.set(draft.chat, list);
        }
        draft.status = 'sent'; draft.error = undefined;
        this.update({ replies: this.status.replies + 1 });
        log.info(`已发送到「${draft.chat}」：${draft.text.slice(0, 80)}`);
        await this.recordSent(draft, last, frame).catch((e) => log.debug(`记录已发送消息失败：${errText(e)}`));
      } catch (e) {
        draft.status = 'failed'; draft.error = this.wechat.describeError(e);
        log.error(`发送到「${draft.chat}」失败：${draft.error}`);
        if (e instanceof SafetyStop) { store.upsertDraft(draft); this.emit('draft', draft); throw e; }
      }
    }
    store.upsertDraft(draft);
    this.emit('draft', draft);
  }

  /**
   * Ingests the screen right after sending so the message lands in the chat history now, not on the next poll
   * (which may be far off, or never come when monitoring is stopped). Retries once if the bubble had not rendered yet.
   */
  private async recordSent(draft: Draft, last: ChatMessage | undefined, frame: Frame | undefined): Promise<void> {
    const recorded = () => {
      const h = store.history(draft.chat);
      return h.slice(last ? h.indexOf(last) + 1 : 0).some((m) => m.side === 'self' && similarity(m.text, draft.text) >= 0.7);
    };
    for (let i = 0; i < 2 && !recorded(); i++) {
      let f = frame;
      if (i || !f) { await sleep(600); f = await this.wechat.capture(); }
      if (!sameChat(f.vision.title, draft.chat)) return;
      await this.ingest(f, 0);
    }
  }

  approve(id: string, text?: string): Promise<void> {
    const d = store.drafts().find((x) => x.id === id);
    if (!d) throw new Error('草稿不存在');
    if (text !== undefined) d.text = text;
    return this.lock.run(async () => {
      if (await this.wechat.isFrontmost()) throw new Error('微信正在前台使用中，为避免打扰暂不发送，请切到其他应用后重试');
      await this.deliver(d);
      if (d.status !== 'sent') throw new Error(d.error ?? '发送失败');
    });
  }

  reject(id: string): void {
    const d = store.drafts().find((x) => x.id === id);
    if (!d) return;
    d.status = 'rejected';
    store.upsertDraft(d);
    this.emit('draft', d);
  }

  /**
   * Adds `chat` to the records. If it is in WeChat's session list, opens it in the background and records the messages
   * on screen (older ones are read on the first reply, see backfill). Otherwise the empty record stays; the chat is
   * located by search on the first send (needs「前台快速发送」).
   */
  addChat(chat: string): Promise<{ synced: boolean; message: string }> {
    const name = chat.trim();
    if (!name) throw new Error('请输入会话名称');
    const existing = store.summaries().find((c) => sameChat(c.name, name))?.name;
    store.ensure(existing ?? name, false);
    this.emit('chat', existing ?? name);
    return this.lock.run(async () => {
      if (await this.wechat.isFrontmost()) return { synced: false, message: '已添加；微信正在前台使用中，稍后打开该会话时会自动读取记录' };
      let f;
      try { f = await this.wechat.openChat(existing ?? name); } catch (e) {
        if (e instanceof NotInListError) return { synced: false, message: '已添加；微信会话列表里暂时没有它，首次发送时会通过搜索打开' };
        throw e;
      }
      await this.ingest(f, 0);
      return { synced: true, message: `已添加并读取「${f.vision.title}」当前屏幕上的消息` };
    });
  }

  /**
   * Generates a reply for `chat` from its stored history without sending it (for review / manual send). The agent is
   * `agentId`, else the one of the matching reply rule, else the first agent. Does not touch WeChat.
   */
  async generateReply(chat: string, agentId?: string): Promise<{ text: string | null; agent: string; reason?: string; ms: number }> {
    const state = store.chat(chat);
    if (!state) throw new Error(`没有「${chat}」的会话记录`);
    const all = store.history(chat);
    if (!all.length) throw new Error('该会话还没有消息记录，无法生成回复');
    let i = all.length;
    while (i > 0 && all[i - 1].side === 'other') i--;
    const incoming = all.slice(i);
    const rule = matchRule(this.cfg, { chat, isGroup: state.isGroup, messages: incoming.length ? incoming : all.slice(-1) });
    const agent = agentId || (rule?.action === 'reply' ? rule.agent : undefined) || this.cfg.agents[0]?.id;
    if (!agent) throw new Error('没有可用的 agent');
    const g = this.cfg.general;
    const since = g.historyMinutes > 0 ? Date.now() - g.historyMinutes * 60000 : 0;
    let history = all.slice(-g.historyLimit);
    const recent = history.filter((m) => m.at >= since);
    if (recent.length >= Math.min(5, history.length)) history = recent;
    const t0 = Date.now();
    log.info(`「${chat}」手动生成回复 → agent ${agent}（上下文 ${history.length} 条）`);
    const out = await runAgent(this.cfg, agent, { chat, isGroup: state.isGroup, history, allHistory: all, incoming });
    for (const t of out.trace) log.debug(t);
    const ms = Date.now() - t0;
    if (out.skipped || !out.reply) return { text: null, agent, reason: out.reason ?? '智能体决定不回复', ms };
    return { text: out.reply, agent, ms };
  }

  sendManual(chat: string, text: string): Promise<void> {
    const draft: Draft = { id: store.id(), chat, text, agent: 'manual', rule: 'manual', createdAt: Date.now(), status: 'pending', trigger: '' };
    return this.approve((store.upsertDraft(draft), draft.id));
  }
}
