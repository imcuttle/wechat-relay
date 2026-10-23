import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VisionResult } from '@shared/types';
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

/**
 * Drives the WeChat main window strictly in the background through the Cua Driver.
 *
 * Rules (learned the hard way): no keyboard combos (they front WeChat), no clipboard, no global search. Only pixel clicks,
 * `type_text` and single keys posted to the WeChat process, and every send is verified (chat title + input box OCR)
 * before Return is pressed. If WeChat ever becomes frontmost because of an action, a SafetyStop is raised.
 */
export class WeChat {
  win: WindowRef | null = null;
  private frameDir = join(CACHE_DIR, 'frames');
  private frameSeq = 0;
  constructor(private driver: CuaDriver, private vision: Vision) {
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
    const wins = structured<{ windows?: Array<{ window_id: number; is_on_screen?: boolean; bounds: { width: number; height: number } }> }>(
      await this.driver.call('list_windows', { pid: app.pid })).windows ?? [];
    const main = wins
      .filter((w) => w.bounds.width >= 500 && w.bounds.height >= 400)
      .sort((a, b) => Number(b.is_on_screen) - Number(a.is_on_screen) || b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
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
    return (await this.apps()).find((a) => a.pid === w.pid)?.active === true;
  }

  /** Screenshot of the main window (works while covered by other windows, not while minimised). */
  async capture(): Promise<Frame> {
    const w = await this.target();
    const path = join(this.frameDir, `frame-${this.frameSeq++ % 4}.png`);
    let st: { screenshot_width?: number; screenshot_height?: number; window_bounds?: { width: number; height: number }; screenshot_file_path?: string };
    try {
      st = structured(await this.driver.call('get_window_state', {
        pid: w.pid, window_id: w.windowId, include_accessibility_tree: false, include_screenshot: true,
        max_image_dimension: 4000, screenshot_out_file: path,
      }, 15000));
    } catch (e) {
      this.win = null; // the window may have been recreated
      throw e;
    }
    if (!st.screenshot_file_path) { this.win = null; throw new Error('无法截取微信窗口（窗口可能已最小化，或缺少屏幕录制权限）'); }
    const width = st.screenshot_width ?? 0, height = st.screenshot_height ?? 0;
    if (st.window_bounds) { w.width = st.window_bounds.width; w.height = st.window_bounds.height; }
    const scale = st.window_bounds?.width ? width / st.window_bounds.width : 2;
    const vision = await this.vision.parse(st.screenshot_file_path, scale);
    if (!vision.ok) throw new Error(`识别失败：${vision.error}`);
    return { path: st.screenshot_file_path, scale, width, height, vision, at: Date.now() };
  }

  /** Posts one input action to WeChat and raises SafetyStop if it pulled WeChat to the front. */
  private async act(tool: 'click' | 'type_text' | 'press_key', args: Record<string, unknown>): Promise<void> {
    const w = await this.target();
    if (await this.isFrontmost()) throw new SafetyStop('微信正在前台使用中，暂不操作');
    await this.driver.call(tool, { pid: w.pid, window_id: w.windowId, delivery_mode: 'background', ...args });
    if (await this.isFrontmost()) throw new SafetyStop(`${tool} 导致微信被切到前台，已停止自动操作`);
  }

  /** Clicks a visible session row and waits until the chat header shows it. Never uses search. */
  async openChat(name: string, frame?: Frame): Promise<Frame> {
    let f = frame ?? (await this.capture());
    if (sameChat(f.vision.title, name)) return f;
    const row = f.vision.sessions.find((s) => sameChat(s.name, name));
    if (!row) throw new Error(`会话「${name}」不在可见的会话列表中，已跳过`);
    await this.act('click', { x: Math.round(row.x), y: Math.round(row.y) });
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      f = await this.capture();
      if (sameChat(f.vision.title, name)) return f;
    }
    throw new Error(`点击后未能切换到「${name}」（当前：${f.vision.title ?? '无'}）`);
  }

  /** OCR text currently inside the input box. */
  inputText(f: Frame): string {
    const l = f.vision.layout;
    if (!l) return '';
    const bottom = l.send ? l.send.y - 20 * f.scale : f.height;
    return f.vision.lines
      .filter((x) => x.y >= l.inputTop && x.y + x.h / 2 < bottom && x.x >= l.chatLeft)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((x) => x.text)
      .join('');
  }

  private async clearInput(chars: number): Promise<void> {
    for (let i = 0; i < Math.min(chars + 4, 400); i++) await this.act('press_key', { key: 'delete' });
  }

  /**
   * Types `value` into the chat named `chat` and presses Return, only after verifying that
   * (1) the open chat is `chat`, (2) the input box was empty, and (3) the input box now contains `value`.
   */
  async sendText(chat: string, value: string): Promise<void> {
    const msg = value.replace(/\s*\n+\s*/g, ' ').trim();
    if (!msg) return;
    let f = await this.openChat(chat);
    const l = f.vision.layout;
    if (!l?.input || !l.send) throw new Error('未识别到输入框 / 发送按钮');
    const before = this.inputText(f);
    if (before) throw new Error(`输入框里已有未发送的内容「${before.slice(0, 20)}」，为避免误发已跳过`);

    const at = { x: Math.round(l.input.x), y: Math.round(l.input.y) };
    const chunks = msg.match(/[\s\S]{1,40}/gu) ?? [];
    for (let i = 0; i < chunks.length; i++) await this.act('type_text', i === 0 ? { text: chunks[i], ...at } : { text: chunks[i] });
    await sleep(250);

    f = await this.capture();
    const typed = this.inputText(f);
    if (!sameChat(f.vision.title, chat)) {
      throw new SafetyStop(`输入过程中会话变成了「${f.vision.title ?? '无'}」，未发送（输入框可能残留文字，请检查）`);
    }
    const score = similarity(typed, msg);
    if (score < 0.6) {
      await this.clearInput(msg.length);
      throw new Error(`输入框内容校验失败（相似度 ${score.toFixed(2)}，识别到「${typed.slice(0, 30)}」），已清空未发送`);
    }
    await this.act('press_key', { key: 'return' });
    await sleep(500);
    f = await this.capture();
    if (this.inputText(f)) log.warn(`发送后输入框仍有内容：「${this.inputText(f).slice(0, 30)}」`);
  }

  describeError(e: unknown): string {
    const m = errText(e);
    if (/accessibility|screen recording|permission/i.test(m)) return `${m}（请在 系统设置 → 隐私与安全性 中为 Cua Driver 打开「辅助功能」和「录屏与系统录音」）`;
    return m;
  }
}
