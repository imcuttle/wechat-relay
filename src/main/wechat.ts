import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VisionResult, VoiceConfig } from '@shared/types';
import { AudioRig, NotRecordingError, VoiceFailed, VoiceUnavailable } from './audio';
import { CACHE_DIR } from './config';
import { CuaDriver, structured, text } from './driver';
import { errText, logger, sleep } from './util';
import { Vision } from './vision';

const log = logger.scope('wechat');
const BUNDLE_IDS = ['com.tencent.xinWeChat', 'com.tencent.WeChat'];

export interface WindowRef { pid: number; windowId: number; width: number; height: number }
export interface Frame { path: string; scale: number; width: number; height: number; vision: VisionResult; at: number }

/** Thrown when an action would (or did) disturb the user: WeChat pulled to the front, wrong chat, etc. Stops automation. */
export class SafetyStop extends Error {}

/** The chat is not in the session list (opening it needs a search, which only works in the foreground). */
export class NotInListError extends Error {}

/** Background typing left the input box empty (WeChat ignored the events); nothing to clean up. */
export class NotLandedError extends Error {}

/** Normalises OCR'd text for fuzzy comparison (WeChat truncates long names with "..."). */
export function normText(s: string): string {
  return s.replace(/[\s|｜.。…⋯,，:：!！?？"“”'‘’]/gu, '').replace(/[（(]\d+[)）]$/, '').toLowerCase();
}

export function similarity(a: string, b: string): number {
  const x = normText(a), y = normText(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

export function sameChat(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = normText(a), y = normText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return (short.length >= 4 && long.startsWith(short)) || similarity(x, y) >= 0.85;
}

export interface WeChatOptions { foreground: boolean; restoreClipboard: boolean }

/** Seconds since the last real keyboard / mouse input (IOHIDSystem HIDIdleTime). Driver-posted events reset it too. */
async function userIdleSeconds(): Promise<number> {
  const out = await new Promise<string>((resolve, reject) =>
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { maxBuffer: 4 << 20 }, (e, so) => (e ? reject(e) : resolve(so))));
  const ns = Number(/"HIDIdleTime" = (\d+)/.exec(out)?.[1] ?? 0);
  return ns / 1e9;
}

/** Pid of the frontmost app per LaunchServices (the driver's list_apps `active` flag can be stale). */
async function frontmostPid(): Promise<number> {
  const out = await new Promise<string>((resolve, reject) =>
    execFile('/bin/sh', ['-c', 'lsappinfo info -only pid "$(lsappinfo front)"'], (e, so) => (e ? reject(e) : resolve(so))));
  return Number(/"pid"\s*=\s*(\d+)/.exec(out)?.[1] ?? 0);
}

/** Re-activates the app `pid` (works for apps with several windows, unlike the driver's pid-only bring_to_front). */
async function activatePid(pid: number): Promise<void> {
  const out = await new Promise<string>((resolve, reject) =>
    execFile('/usr/bin/lsappinfo', ['info', '-only', 'bundlepath', '-app', String(pid)], (e, so) => (e ? reject(e) : resolve(so))));
  const path = /="(.+)"/.exec(out)?.[1];
  if (!path) throw new Error(`找不到 pid ${pid} 对应的应用`);
  await new Promise<void>((resolve, reject) => execFile('/usr/bin/open', ['-a', path], (e) => (e ? reject(e) : resolve())));
}

const IDLE_BEFORE_FOREGROUND_SEC = 3;
const IDLE_WAIT_MAX_MS = 30000;

/**
 * Drives the WeChat main window through the Cua Driver.
 *
 * Background mode (default): no keyboard combos (they front WeChat), no clipboard. Only pixel clicks, `type_text` and
 * single keys posted to the WeChat process; if WeChat ever becomes frontmost because of an action, a SafetyStop is raised.
 * Note: WeChat 4.x ignores background focus clicks, so background typing does not land (see foreground mode).
 *
 * Foreground mode (`driver.deliveryMode: foreground`, opt-in): only for sending. Waits until the user is idle, brings
 * WeChat to the front once, pastes via the clipboard (restored afterwards) and switches back to the previous app.
 *
 * Every send is verified (chat title + input box OCR) before Return is pressed.
 */
export class WeChat {
  win: WindowRef | null = null;
  private frameDir = join(CACHE_DIR, 'frames');
  private frameSeq = 0;
  /** True while a foreground send owns WeChat (it is frontmost on purpose). */
  private fg = false;
  constructor(private driver: CuaDriver, private vision: Vision, private opts: () => WeChatOptions = () => ({ foreground: false, restoreClipboard: true })) {
    mkdirSync(this.frameDir, { recursive: true });
  }

  async permissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    const t = text(await this.driver.call('check_permissions', { prompt: false }));
    return { accessibility: /Accessibility: granted/i.test(t), screenRecording: /Screen Recording: granted/i.test(t) };
  }

  private async apps() {
    return structured<{ apps?: Array<{ bundle_id?: string; pid: number; running: boolean; active?: boolean }> }>(await this.driver.call('list_apps')).apps ?? [];
  }

  async locate(): Promise<WindowRef | null> {
    const app = (await this.apps()).find((a) => a.running && a.bundle_id && BUNDLE_IDS.includes(a.bundle_id));
    if (!app) { this.win = null; return null; }
    const wins = structured<{ windows?: Array<{ window_id: number; title?: string; is_on_screen?: boolean; bounds: { width: number; height: number } }> }>(
      await this.driver.call('list_windows', { pid: app.pid })).windows ?? [];
    // The main window is titled 微信 / WeChat; detached chat windows ("微信 (窗口)" etc.) must not be picked.
    const isMain = (t?: string) => ['微信', 'WeChat', 'Weixin'].includes((t ?? '').trim());
    const main = wins
      .filter((w) => w.bounds.width >= 500 && w.bounds.height >= 400)
      .sort((a, b) => Number(isMain(b.title)) - Number(isMain(a.title)) || Number(b.is_on_screen) - Number(a.is_on_screen) ||
        b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
    this.win = main ? { pid: app.pid, windowId: main.window_id, width: main.bounds.width, height: main.bounds.height } : null;
    return this.win;
  }

  private async target(): Promise<WindowRef> {
    if (this.win) return this.win;
    const w = await this.locate();
    if (!w) throw new Error('未找到微信主窗口（请登录微信并保持主窗口打开，不要最小化）');
    return w;
  }

  /** Whether WeChat is the frontmost app (i.e. the user is probably using it). */
  async isFrontmost(): Promise<boolean> {
    const w = await this.target();
    return (await frontmostPid()) === w.pid;
  }

  /** Screenshot of the main window (works while covered by other windows, not while minimised). */
  async capture(): Promise<Frame> {
    const w = await this.target();
    const path = join(this.frameDir, `frame-${this.frameSeq++ % 4}.png`);
    let st: { screenshot_width?: number; screenshot_height?: number; window_bounds?: { width: number; height: number } };
    let image: string | undefined;
    try {
      // The screenshot must come back inline: the driver only accepts pixel-addressed input (click / type_text x,y /
      // scroll) against a snapshot whose image was returned to this session — screenshot_out_file does not count.
      const res = await this.driver.call('get_window_state', {
        pid: w.pid, window_id: w.windowId, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: 4000,
      }, 15000);
      st = structured(res);
      image = res.content?.find((b) => b.type === 'image' && b.data)?.data;
    } catch (e) {
      this.win = null; // the window may have been recreated
      throw e;
    }
    if (!image) { this.win = null; throw new Error('无法截取微信窗口（窗口可能已最小化，或缺少屏幕录制权限）'); }
    writeFileSync(path, Buffer.from(image, 'base64'));
    const width = st.screenshot_width ?? 0, height = st.screenshot_height ?? 0;
    if (st.window_bounds) { w.width = st.window_bounds.width; w.height = st.window_bounds.height; }
    const scale = st.window_bounds?.width ? width / st.window_bounds.width : 2;
    const vision = await this.vision.parse(path, scale);
    if (!vision.ok) throw new Error(`识别失败：${vision.error}`);
    return { path, scale, width, height, vision, at: Date.now() };
  }

  /**
   * Posts one input action to WeChat. Background mode: raises SafetyStop if it pulled WeChat to the front.
   * Foreground mode: WeChat is frontmost on purpose; aborts if the user switched away meanwhile.
   */
  private async act(tool: 'click' | 'type_text' | 'press_key' | 'scroll' | 'hotkey', args: Record<string, unknown>): Promise<void> {
    const w = await this.target();
    if (this.fg) {
      // WeChat is frontmost on purpose, so events posted to its pid are handled like real input. With several WeChat
      // windows open the driver refuses pid-scoped keys (same_pid_keyboard_ambiguity): retry targeting the window.
      if (!(await this.isFrontmost())) throw new SafetyStop('发送过程中微信不在前台了（可能你切换了应用），已中止');
      const a = { pid: w.pid, window_id: w.windowId, ...args };
      const post = async (mode: string) => {
        try {
          await this.driver.call(tool, { ...a, delivery_mode: mode });
        } catch (e) {
          // Pixel actions need a screenshot snapshot owned by this session; refresh it once (e.g. after activation).
          if (!/No current snapshot|screenshot_context_missing/i.test(errText(e))) throw e;
          await this.capture();
          await this.driver.call(tool, { ...a, delivery_mode: mode });
        }
      };
      try {
        await post('background');
      } catch (e) {
        if (!/same_pid_keyboard_ambiguity/.test(errText(e))) throw e;
        await post('foreground');
      }
      return;
    }
    if (await this.isFrontmost()) throw new SafetyStop('微信正在前台使用中，暂不操作');
    const bg = { pid: w.pid, window_id: w.windowId, delivery_mode: 'background', ...args };
    try {
      await this.driver.call(tool, bg);
    } catch (e) {
      if (!/No current snapshot|screenshot_context_missing/i.test(errText(e))) throw e;
      await this.capture();
      await this.driver.call(tool, bg);
    }
    if (await this.isFrontmost()) throw new SafetyStop(`${tool} 导致微信被切到前台，已停止自动操作`);
  }

  /**
   * Runs `fn` with WeChat briefly in front: waits for the user to be idle, saves the clipboard and the frontmost app,
   * fronts WeChat once, then restores the clipboard and switches back (only if WeChat is still the frontmost app).
   */
  private async withForeground<T>(fn: () => Promise<T>): Promise<T> {
    const w = await this.target();
    const t0 = Date.now();
    while ((await userIdleSeconds()) < IDLE_BEFORE_FOREGROUND_SEC) {
      if (Date.now() - t0 > IDLE_WAIT_MAX_MS) throw new Error('你一直在操作电脑，为避免打扰暂不切换微信发送');
      await sleep(1000);
    }
    const front = await frontmostPid();
    if (front === w.pid) throw new Error('微信正在前台使用中，暂不操作');
    const restoreClip = this.opts().restoreClipboard;
    if (restoreClip) await this.vision.clipboard('save');
    try {
      await this.driver.call('bring_to_front', { pid: w.pid, window_id: w.windowId });
      await sleep(150);
      this.fg = true;
      return await fn();
    } finally {
      this.fg = false;
      if (restoreClip) {
        const r = await this.vision.clipboard('restore').catch((e) => ({ ok: false, error: errText(e), restored: false }));
        if (!r.ok) log.warn(`恢复剪贴板失败：${r.error}`);
        else if (!r.restored) log.info('剪贴板在发送期间被其他内容覆盖，保留新内容');
      }
      if (front && (await this.isFrontmost().catch(() => false))) {
        await activatePid(front).catch((e) => log.warn(`切回之前的应用失败：${errText(e)}`));
      }
    }
  }

  /**
   * Foreground only: focuses the field at (x, y) with a driver click (posted to WeChat, the real pointer does not move)
   * and pastes `value` via the clipboard.
   */
  private async pasteAt(x: number, y: number, value: string): Promise<void> {
    await this.act('click', { x, y });
    await this.vision.clipboard('set', value);
    await this.act('hotkey', { keys: ['cmd', 'v'] });
  }

  /**
   * Finds a session row, scrolling the session list in the background (wheel events over the list, no focus change):
   * first towards the top (recent chats), then down, stopping when a scroll no longer changes the visible rows.
   */
  private async findSession(name: string, frame: Frame): Promise<{ f: Frame; row: Frame['vision']['sessions'][number] } | null> {
    let f = frame;
    const hit = () => f.vision.sessions.find((s) => sameChat(s.name, name));
    if (hit()) return { f, row: hit()! };
    for (const direction of ['up', 'down'] as const) {
      for (let i = 0; i < 12; i++) {
        const l = f.vision.layout;
        if (!l) return null;
        const before = f.vision.sessions.map((s) => s.name).join('|');
        await this.act('scroll', { x: Math.round((l.listLeft + l.listRight) / 2), y: Math.round(f.height / 2), direction, amount: 10, by: 'line' });
        await sleep(350);
        f = await this.capture();
        const row = hit();
        if (row) return { f, row };
        if (f.vision.sessions.map((s) => s.name).join('|') === before) break; // reached the end
      }
    }
    return null;
  }

  /**
   * Background: focuses the field at (x, y) with a driver click, then posts the text to WeChat. (The driver's
   * one-call px form of type_text is skipped: its focus click is always refused by WeChat 4.x.)
   */
  private async typeAt(x: number, y: number, value: string): Promise<void> {
    const chunks = value.match(/[\s\S]{1,40}/gu) ?? [];
    if (!chunks.length) return;
    await this.act('click', { x, y });
    await sleep(200);
    for (const c of chunks) await this.act('type_text', { text: c });
  }

  /**
   * Foreground only, keyboard only: Cmd+F, types `name`, reads WeChat's search popup (a separate window), moves the
   * highlight with Down onto the matching contact / group row and presses Return. The search box has focus, so Return
   * never reaches the chat input. Returns the frame once the chat header shows `name`.
   */
  private async searchChatFg(name: string): Promise<Frame> {
    const w = await this.target();
    const want = normText(name);
    await this.act('hotkey', { keys: ['cmd', 'f'] });
    await sleep(300);
    await this.act('type_text', { text: name, delay_ms: 40 });
    try {
      let popup: { id: number; path: string; scale: number; lines: Frame['vision']['lines'] } | null = null;
      let hit: Frame['vision']['lines'][number] | undefined;
      for (let i = 0; i < 4 && !hit; i++) {
        await sleep(i ? 500 : 900);
        const wins = (await this.vision.windows(w.pid)).filter((x) => x.id !== w.windowId && x.layer > 0 && x.layer < 20 && x.w >= 200 && x.h >= 150);
        for (const pw of wins) {
          popup = await this.captureWindow(pw.id);
          const lines = popup.lines;
          // Contact / group rows sit under a section header; the rows above it are 搜一搜 suggestions.
          const header = lines.find((x) => /^(联系人|群聊|功能|最常使用|Contacts|Group Chats|Top Hits)$/.test(x.text.trim()));
          const end = lines.find((x) => header && x.y > header.y && /^(聊天记录|Chat History|公众号|小程序|搜一搜)$/.test(x.text.trim()));
          const rows = header ? lines.filter((x) => x.y > header.y && (!end || x.y < end.y)) : [];
          hit = rows.find((x) => normText(x.text) === want) ?? rows.find((x) => sameChat(x.text, name));
          if (hit) break;
        }
      }
      if (!popup || !hit) throw new Error(`搜索「${name}」没有找到联系人或群聊`);
      const target = hit.y + hit.h / 2;
      const rowYs = popup.lines.filter((x) => x.x < popup!.lines.reduce((m, l) => Math.min(m, l.x), 1e9) + 120 * popup!.scale && !/^(联系人|群聊|功能|最常使用|聊天记录)$/.test(x.text.trim()))
        .map((x) => x.y + x.h / 2);
      const stripX = Math.max(0, Math.round(popup.lines.reduce((m, l) => Math.min(m, l.x), 1e9) - 20 * popup.scale / 2));
      for (let k = 0; k <= 15; k++) {
        if (k) { await this.act('press_key', { key: 'down' }); await sleep(150); popup = { ...popup, ...(await this.captureWindow(popup.id, false)) }; }
        const lum = await this.vision.luma(popup.path, stripX, rowYs);
        const max = Math.max(...lum);
        if (max - Math.min(...lum) < 6) continue; // nothing highlighted yet
        const at = rowYs[lum.indexOf(max)];
        if (Math.abs(at - target) < hit.h) {
          await this.act('press_key', { key: 'return' });
          for (let i = 0; i < 6; i++) {
            await sleep(300);
            const f = await this.capture();
            if (sameChat(f.vision.title, name)) return f;
          }
          throw new Error(`搜索后未能打开「${name}」`);
        }
        if (at > target + hit.h) break; // overshot
      }
      throw new Error(`搜索结果中无法选中「${name}」`);
    } catch (e) {
      await this.act('press_key', { key: 'escape' }).catch(() => undefined);
      throw e;
    }
  }

  /** Screenshot + OCR of another WeChat window (e.g. the search popup). */
  private async captureWindow(windowId: number, ocr = true): Promise<{ id: number; path: string; scale: number; lines: Frame['vision']['lines'] }> {
    const w = await this.target();
    const res = await this.driver.call('get_window_state', { pid: w.pid, window_id: windowId, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: 4000 }, 15000);
    const st = structured<{ screenshot_width?: number; window_bounds?: { width: number } }>(res);
    const image = res.content?.find((b) => b.type === 'image' && b.data)?.data;
    if (!image) throw new Error('无法截取微信搜索结果');
    const path = join(this.frameDir, 'popup.png');
    writeFileSync(path, Buffer.from(image, 'base64'));
    const scale = st.window_bounds?.width && st.screenshot_width ? st.screenshot_width / st.window_bounds.width : 2;
    const lines = ocr ? (await this.vision.parse(path, scale)).lines ?? [] : [];
    return { id: windowId, path, scale, lines: lines.sort((a, b) => a.y - b.y) };
  }

  /**
   * Opens a chat in the background: clicks its row (scrolling the session list if needed) and waits until the chat
   * header shows it. Throws NotInListError when the chat is not in the session list (search needs the foreground).
   */
  async openChat(name: string, frame?: Frame): Promise<Frame> {
    let f = frame ?? (await this.capture());
    if (sameChat(f.vision.title, name)) return f;
    const found = await this.findSession(name, f);
    if (!found) throw new NotInListError(`会话列表中找不到「${name}」`);
    f = found.f;
    const row = found.row;
    await this.act('click', { x: Math.round(row.x), y: Math.round(row.y) });
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      f = await this.capture();
      if (sameChat(f.vision.title, name)) return f;
    }
    throw new Error(`点击后未能切换到「${name}」（当前：${f.vision.title ?? '无'}）`);
  }

  /** Scrolls the message area with wheel events (background, no focus change). */
  async scrollChat(f: Frame, direction: 'up' | 'down', amount: number): Promise<void> {
    const l = f.vision.layout;
    if (!l) throw new Error('未识别到聊天区域');
    await this.act('scroll', { x: Math.round((l.chatLeft + l.chatRight) / 2), y: Math.round((l.headerBottom + l.inputTop) / 2), direction, amount, by: 'line' });
  }

  /** OCR text currently inside the input box. */
  inputText(f: Frame): string {
    const l = f.vision.layout;
    if (!l) return '';
    const bottom = l.send ? l.send.y - 20 * f.scale : f.height;
    // The empty box shows a gray placeholder at the same spot as typed text ("按住鼠标 语音输入文字", or the
    // English / Traditional variants); it is not user content.
    const isPlaceholder = (x: { text: string }): boolean =>
      /^(按住.{0,6}[语語]音[输輸]入|hold.{0,12}(voice|dictat))/i.test(x.text.replace(/\s+/g, ''));
    return f.vision.lines
      .filter((x) => x.y >= l.inputTop && x.y + x.h / 2 < bottom && x.x >= l.chatLeft && !isPlaceholder(x))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((x) => x.text)
      .join('');
  }

  private async clearInput(chars: number): Promise<void> {
    if (this.fg) {
      await this.act('hotkey', { keys: ['cmd', 'a'] });
      await this.act('press_key', { key: 'delete' });
      return;
    }
    for (let i = 0; i < Math.min(chars + 4, 400); i++) await this.act('press_key', { key: 'delete' });
  }

  /**
   * Enters `value` into the chat named `chat` and presses Return, only after verifying that
   * (1) the open chat is `chat`, (2) the input box was empty, and (3) the input box now contains `value`.
   *
   * Foreground mode: the chat is opened in the background when it is in the session list; only the steps that
   * cannot be done in the background (search, entering the text, Return) run inside one short foreground window.
   * Returns the screen captured right after sending.
   */
  async sendText(chat: string, value: string): Promise<Frame | undefined> {
    const msg = value.replace(/\s*\n+\s*/g, ' ').trim();
    if (!msg) return;
    const fgAllowed = this.opts().foreground;
    let opened: Frame | null = null;
    try {
      opened = await this.openChat(chat);
    } catch (e) {
      if (!(e instanceof NotInListError)) throw e;
      if (!fgAllowed) throw new Error(`${e.message}，已跳过（开启「前台快速发送」后可通过搜索打开）`);
      log.info(`${e.message}，将在前台通过搜索打开`);
    }
    let leftover = false;
    if (opened) {
      try {
        return await this.sendInner(opened, chat, msg);
      } catch (e) {
        if (!(e instanceof NotLandedError) || !fgAllowed) throw e;
        log.info('后台输入没有生效，改为前台快速发送');
        leftover = true; // keystrokes may still have landed unseen: clear our own text before pasting
      }
    }
    return this.withForeground(async () => this.sendInner(opened ?? (await this.searchChatFg(chat)), chat, msg, leftover));
  }

  /** `clearOwn`: the input box was verified empty before our own background attempt, so anything in it now is ours. */
  private async sendInner(opened: Frame, chat: string, msg: string, clearOwn = false): Promise<Frame> {
    let f = this.fg ? await this.capture() : opened;
    if (!sameChat(f.vision.title, chat)) throw new Error(`当前会话不是「${chat}」（${f.vision.title ?? '无'}），未发送`);
    let l = f.vision.layout;
    if (!l?.input || !l.send) throw new Error('未识别到输入框 / 发送按钮');
    if (clearOwn && this.fg) {
      await this.act('click', { x: Math.round(l.input.x), y: Math.round(l.input.y) });
      await this.clearInput(0);
      await sleep(200);
      f = await this.capture();
      l = f.vision.layout;
      if (!l?.input || !l.send) throw new Error('未识别到输入框 / 发送按钮');
    }
    const before = this.inputText(f);
    if (before) throw new Error(`输入框里已有未发送的内容「${before.slice(0, 20)}」，为避免误发已跳过`);

    const x = Math.round(l.input.x), y = Math.round(l.input.y);
    if (this.fg) await this.pasteAt(x, y, msg);
    else await this.typeAt(x, y, msg);
    await sleep(250);

    f = await this.capture();
    let typed = this.inputText(f);
    for (let i = 0; i < 2 && similarity(typed, msg) < 0.6 && sameChat(f.vision.title, chat); i++) {
      await sleep(400); // long texts may still be rendering
      f = await this.capture();
      typed = this.inputText(f);
    }
    if (!sameChat(f.vision.title, chat)) {
      throw new SafetyStop(`输入过程中会话变成了「${f.vision.title ?? '无'}」，未发送（输入框可能残留文字，请检查）`);
    }
    if (!typed && !this.fg) throw new NotLandedError('后台输入没有生效（输入框仍为空），未发送');
    const score = similarity(typed, msg);
    if (score < 0.6) {
      await this.clearInput(msg.length);
      throw new Error(`输入框内容校验失败（相似度 ${score.toFixed(2)}，识别到「${typed.slice(0, 30)}」），已清空未发送`);
    }
    await this.act('press_key', { key: 'return' });
    await sleep(500);
    f = await this.capture();
    if (this.inputText(f)) log.warn(`发送后输入框仍有内容：「${this.inputText(f).slice(0, 30)}」`);
    return f;
  }

  /** Saves a screenshot of a voice-sending step (debug aid: the recording UI differs between WeChat versions). */
  private debugFrame(f: Frame, step: string): void {
    try {
      const dir = join(CACHE_DIR, 'voice-debug');
      mkdirSync(dir, { recursive: true });
      copyFileSync(f.path, join(dir, `${step}.png`));
    } catch { /* debug only */ }
  }

  /** OCR lines of the input area as one string; changes when the recording UI replaces the input box. */
  private inputArea(f: Frame): string {
    const l = f.vision.layout;
    if (!l) return '';
    return f.vision.lines.filter((x) => x.y >= l.inputTop && x.x >= l.chatLeft).sort((a, b) => a.y - b.y || a.x - b.x).map((x) => x.text.trim()).join('|');
  }

  /**
   * Sends `file` as a WeChat voice message: opens the chat (background when possible), clicks the voice button, plays the
   * audio into the virtual input device, then clicks the send control of the recording panel. Every step is verified; when
   * the recording does not start in the background and foreground mode is on, it is retried in the short foreground window.
   * Throws VoiceUnavailable while nothing has happened yet (caller sends text), VoiceFailed afterwards.
   */
  async sendVoice(chat: string, rig: AudioRig, cfg: VoiceConfig, file: string): Promise<Frame> {
    const fgAllowed = this.opts().foreground;
    const { virtual, real } = await rig.preflight(cfg, file);
    let opened: Frame | null = null;
    try {
      opened = await this.openChat(chat);
    } catch (e) {
      if (!(e instanceof NotInListError)) throw e;
      if (!fgAllowed) throw new VoiceUnavailable(`${e.message}，语音需要前台搜索打开`);
    }
    if (opened) {
      try {
        return await this.voiceInner(opened, chat, rig, cfg, file, virtual, real);
      } catch (e) {
        if (!(e instanceof NotRecordingError) || !fgAllowed) throw e;
        log.info('后台点击语音按钮没有开始录音，改为前台快速发送');
      }
    }
    return this.withForeground(async () => this.voiceInner(opened ?? (await this.searchChatFg(chat)), chat, rig, cfg, file, virtual, real));
  }

  private async voiceInner(opened: Frame, chat: string, rig: AudioRig, cfg: VoiceConfig, file: string, virtual: Parameters<AudioRig['withVirtualInput']>[0], real: Parameters<AudioRig['withVirtualInput']>[1]): Promise<Frame> {
    const f0 = this.fg ? await this.capture() : opened;
    if (!sameChat(f0.vision.title, chat)) throw new Error(`当前会话不是「${chat}」（${f0.vision.title ?? '无'}），未发送`);
    const l = f0.vision.layout;
    if (!l?.input || !l.send) throw new Error('未识别到输入框 / 发送按钮');
    if (this.inputText(f0)) throw new VoiceUnavailable('输入框里有未发送的内容，语音改发文字');
    const bx = Math.round(l.send.x - cfg.buttonOffset * f0.scale), by = Math.round(l.send.y);
    const idle = this.inputArea(f0);
    this.debugFrame(f0, '0-idle');
    return rig.withVirtualInput(virtual, real, async () => {
      await this.act('click', { x: bx, y: by });
      await sleep(700);
      const f1 = await this.capture();
      this.debugFrame(f1, '1-after-click');
      if (!sameChat(f1.vision.title, chat)) throw new SafetyStop(`点击语音按钮后会话变成了「${f1.vision.title ?? '无'}」`);
      if (this.inputArea(f1) === idle) throw new NotRecordingError('点击语音按钮后界面没有变化（没有开始录音）');
      // Recording has started: from here on a failure must not fall back to text.
      try {
        await sleep(300);
        await rig.play(file, virtual);
        await sleep(500);
        const f2 = await this.capture();
        this.debugFrame(f2, '2-after-play');
        if (!sameChat(f2.vision.title, chat)) throw new SafetyStop(`录音过程中会话变成了「${f2.vision.title ?? '无'}」`);
        const lines = f2.vision.lines.filter((x) => x.y >= l.inputTop - 40 * f2.scale && x.x >= l.chatLeft);
        const sendBtn = lines.filter((x) => /^(发送|Send|發送|完成)$/.test(x.text.trim())).sort((a, b) => b.y - a.y)[0];
        if (!sendBtn) throw new VoiceFailed('没有在录音界面找到「发送」控件，已取消这条语音');
        await this.act('click', { x: Math.round(sendBtn.x + sendBtn.w / 2), y: Math.round(sendBtn.y + sendBtn.h / 2) });
        await sleep(900);
        const f3 = await this.capture();
        this.debugFrame(f3, '3-after-send');
        if (this.inputArea(f3) !== idle && !sameChat(f3.vision.title, chat)) throw new SafetyStop('发送语音后会话发生变化');
        if (this.inputArea(f3) !== idle) throw new VoiceFailed('点击发送后录音界面仍在，请检查微信');
        return f3;
      } catch (e) {
        await this.act('press_key', { key: 'escape' }).catch(() => undefined);
        throw e instanceof SafetyStop || e instanceof VoiceFailed ? e : new VoiceFailed(`发送语音出错：${errText(e)}`);
      }
    });
  }

  describeError(e: unknown): string {
    const m = errText(e);
    if (/accessibility|screen recording|permission/i.test(m)) return `${m}（请在 系统设置 → 隐私与安全性 中为 Cua Driver 打开「辅助功能」和「录屏与系统录音」）`;
    return m;
  }
}
