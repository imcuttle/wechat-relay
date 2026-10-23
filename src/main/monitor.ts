import { EventEmitter } from 'node:events';
import type { AppConfig, ChatMessage, Draft, MonitorStatus, RuleConfig, VisionMessage } from '@shared/types';
import { runAgent } from './agent/engine';
import { CONFIG_PATH } from './config';
import { CuaDriver } from './driver';
import { matchRule } from './rules';
import { store } from './store';
import { errText, logger, sleep } from './util';
import { Vision } from './vision';
import { SafetyStop, WeChat, normText, sameChat, similarity, type Frame } from './wechat';

const log = logger.scope('monitor');

interface Pending { chat: string; isGroup: boolean; rule: RuleConfig; incoming: ChatMessage[]; due: number }

const sameMsg = (a: Pick<ChatMessage, 'side' | 'text'>, b: Pick<ChatMessage, 'side' | 'text'>) =>
  a.side === b.side && (normText(a.text) === normText(b.text) || similarity(a.text, b.text) >= 0.8);

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
  private sentAt: number[] = [];
  /** Recently sent texts per chat, to tag our own messages when they show up on screen. */
  private botSent = new Map<string, string[]>();
  private failures = 0;
  private status: MonitorStatus;

  constructor(private cfg: AppConfig, visionBin: string) {
    super();
    this.driver = new CuaDriver(cfg.driver);
    this.vision = new Vision(visionBin);
    this.wechat = new WeChat(this.driver, this.vision);
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

    this.ingest(frame, 0);
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
        this.ingest(opened, unread);
        if (this.cfg.general.restoreChat && previous && !this.pending.size) await this.wechat.openChat(previous).catch(() => undefined);
      }
    }
    this.update({ lastTickMs: Date.now() - t0 });
  }

  /** Diff the open chat against stored history; schedule replies for new incoming messages. */
  private ingest(frame: Frame, unreadHint: number): void {
    const chat = frame.vision.title;
    if (!chat) return;
    const isGroup = frame.vision.isGroup;
    const name = store.summaries().find((c) => sameChat(c.name, chat))?.name ?? chat;
    const now = Date.now();
    const visible: ChatMessage[] = frame.vision.messages
      .filter((m: VisionMessage) => m.side !== 'system' && !m.partial)
      .map((m) => ({ id: '', side: m.side as 'self' | 'other', sender: m.sender ?? undefined, text: m.text, at: now, source: 'ocr' as const }));
    if (!visible.length) return;

    const state = store.ensure(name, isGroup);
    let start = newStart(state.messages, visible);
    if (start < 0) {
      if (state.messages.length) log.debug(`「${name}」屏幕内容与记录无重叠，重新同步`);
      // First sight (or resync): everything on screen is old unless the chat had an unread badge.
      const others = visible.map((m, i) => ({ m, i })).filter((x) => x.m.side === 'other');
      start = unreadHint > 0 && others.length ? others[Math.max(0, others.length - unreadHint)].i : visible.length;
      const old = visible.slice(0, start);
      for (const m of old) m.id = store.id();
      store.append(name, old);
    }
    const fresh = visible.slice(start);
    if (!fresh.length) return;
    const sent = this.botSent.get(name) ?? [];
    for (const m of fresh) {
      m.id = store.id();
      if (m.side === 'self' && sent.some((t) => similarity(t, m.text) >= 0.7)) m.source = 'bot';
      this.emit('chat', name, m);
    }
    store.append(name, fresh);
    log.info(`「${name}」新消息 ${fresh.length} 条：${fresh.map((m) => `${m.side === 'self' ? '我' : m.sender || '对方'}: ${m.text}`).join(' / ').slice(0, 200)}`);

    // A message typed by the user themself cancels a pending auto-reply.
    if (fresh.some((m) => m.side === 'self' && m.source !== 'bot')) { this.pending.delete(name); return; }
    const incoming = fresh.filter((m) => m.side === 'other');
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
    log.info(`「${p.chat}」→ agent ${agentId}（规则 ${p.rule.id}，${mode === 'auto' ? '自动发送' : '待审核'}）`);
    const t0 = Date.now();
    let out;
    try {
      out = await runAgent(this.cfg, agentId, { chat: p.chat, isGroup: p.isGroup, history: store.history(p.chat), incoming: p.incoming });
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
        await this.wechat.sendText(draft.chat, draft.text);
        this.sentAt.push(Date.now());
        const list = this.botSent.get(draft.chat) ?? [];
        list.push(draft.text); if (list.length > 20) list.shift();
        this.botSent.set(draft.chat, list);
        draft.status = 'sent'; draft.error = undefined;
        this.update({ replies: this.status.replies + 1 });
        log.info(`已发送到「${draft.chat}」：${draft.text.slice(0, 80)}`);
        await sleep(300);
      } catch (e) {
        draft.status = 'failed'; draft.error = this.wechat.describeError(e);
        log.error(`发送到「${draft.chat}」失败：${draft.error}`);
        if (e instanceof SafetyStop) { store.upsertDraft(draft); this.emit('draft', draft); throw e; }
      }
    }
    store.upsertDraft(draft);
    this.emit('draft', draft);
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

  sendManual(chat: string, text: string): Promise<void> {
    const draft: Draft = { id: store.id(), chat, text, agent: 'manual', rule: 'manual', createdAt: Date.now(), status: 'pending', trigger: '' };
    return this.approve((store.upsertDraft(draft), draft.id));
  }
}
