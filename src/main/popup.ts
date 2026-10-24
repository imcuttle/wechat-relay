import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { AskAnswers, AskQuestion, PopupContext, PopupRequest, PopupResult, ReviewResult } from '@shared/types';
import { logger } from './util';

const log = logger.scope('弹窗');
const WIDTH = 580;
/** After the user started interacting, give up only after this long. */
const HELD_MS = 10 * 60_000;

type Job = { req: PopupRequest; done: (r: PopupResult | undefined) => void; signal?: AbortSignal };

/**
 * One frameless, always-on-top window in front of every app (and full-screen spaces) for AskUserQuestion and draft
 * approval. Requests are shown one at a time. The renderer runs the countdown; the main process only keeps a fallback
 * timer (in case the page never loads) that is lifted once the user interacts.
 */
class Popup {
  private win: BrowserWindow | null = null;
  private queue: Job[] = [];
  private cur: Job | null = null;
  private timer: NodeJS.Timeout | undefined;
  /** Our app was not active when the popup came up: give the focus back to the previous app afterwards. */
  private restoreFocus = false;

  constructor() {
    ipcMain.handle('popup:current', () => this.cur?.req ?? null);
    ipcMain.handle('popup:answer', (_e, id: string, r: PopupResult) => this.finish(id, r));
    ipcMain.on('popup:hold', (_e, id: string) => { if (this.cur?.req.id === id) this.arm(HELD_MS); });
    ipcMain.on('popup:resize', (_e, h: number) => {
      if (!this.win || this.win.isDestroyed()) return;
      const area = screen.getDisplayMatching(this.win.getBounds()).workArea;
      const height = Math.max(120, Math.min(Math.ceil(h), area.height - 80));
      const b = this.win.getBounds();
      if (b.height !== height) this.win.setBounds({ x: b.x, y: Math.round(area.y + (area.height - height) / 3), width: WIDTH, height });
    });
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH, height: 320, show: false, frame: false, transparent: true, resizable: false, movable: true,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: true,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#popup`);
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'popup' });
    win.webContents.on('did-finish-load', () => this.push());
    win.on('closed', () => {
      this.win = null;
      // Closed some other way (e.g. Cmd+W): treat like Esc.
      if (this.cur) this.finish(this.cur.req.id, undefined);
    });
    this.win = win;
    return win;
  }

  private push(): void {
    if (this.win && !this.win.isDestroyed() && !this.win.webContents.isLoading()) this.win.webContents.send('popup:request', this.cur?.req ?? null);
  }

  private arm(ms: number): void {
    clearTimeout(this.timer);
    const id = this.cur?.req.id;
    this.timer = setTimeout(() => { if (id) this.finish(id, undefined); }, ms);
  }

  private next(): void {
    if (this.cur) return;
    while (this.queue.length && this.queue[0].signal?.aborted) this.queue.shift()!.done(undefined);
    const job = this.queue.shift();
    if (!job) { this.hide(); return; }
    this.cur = job;
    const win = this.window();
    if (!win.isVisible()) {
      this.restoreFocus = !BrowserWindow.getFocusedWindow();
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const b = win.getBounds();
      win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + (area.height - b.height) / 3), width: WIDTH, height: b.height });
    }
    this.push();
    // Fallback only: the renderer answers at timeoutSec itself.
    this.arm(job.req.timeoutSec * 1000 + 5000);
    app.focus({ steal: true });
    win.show();
    win.focus();
  }

  private hide(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    this.win.hide();
    // Hand the focus back to whatever app the user was in (Cmd+H semantics: the main window hides too).
    if (this.restoreFocus && process.platform === 'darwin' && !BrowserWindow.getAllWindows().some((w) => w !== this.win && w.isFocused())) app.hide();
  }

  private finish(id: string, r: PopupResult | undefined): void {
    if (this.cur?.req.id !== id) return;
    clearTimeout(this.timer);
    const job = this.cur;
    this.cur = null;
    job.done(r);
    if (this.queue.length) this.next(); else { this.push(); this.hide(); }
  }

  private open(req: PopupRequest, signal?: AbortSignal): Promise<PopupResult | undefined> {
    return new Promise((resolve) => {
      const job: Job = { req, done: resolve, signal };
      signal?.addEventListener('abort', () => {
        if (this.cur === job) this.finish(req.id, undefined);
        else { const i = this.queue.indexOf(job); if (i >= 0) { this.queue.splice(i, 1); resolve(undefined); } }
      }, { once: true });
      this.queue.push(job);
      this.next();
    });
  }

  /** Asks the user; null = declined, timed out or aborted. */
  async ask(questions: AskQuestion[], opts: PopupContext & { timeoutSec: number; signal?: AbortSignal }): Promise<AskAnswers> {
    const { signal, ...rest } = opts;
    if (signal?.aborted) return null;
    const r = await this.open({ kind: 'ask', id: randomUUID(), questions, ...rest }, signal);
    const answers = r && typeof r === 'object' && !('action' in r) ? r as Record<string, string> : null;
    log.info(`询问${opts.chat ? `（${opts.chat}）` : ''}：${questions.map((q) => q.question).join(' / ')} → ${answers ? Object.values(answers).join(' / ') : '未回答'}`);
    return answers;
  }

  /** Approval of a draft; later = closed / timed out (stays pending). */
  async review(d: PopupContext & { id: string; text: string; timeoutSec: number }): Promise<ReviewResult> {
    const r = await this.open({ kind: 'review', ...d });
    return r && typeof r === 'object' && 'action' in r ? r as ReviewResult : { action: 'later' };
  }

  dispose(): void {
    for (const j of this.queue.splice(0)) j.done(undefined);
    if (this.cur) this.finish(this.cur.req.id, undefined);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

let instance: Popup | null = null;
/** Created lazily (ipcMain handlers need the app to be ready). */
export const popup = (): Popup => (instance ??= new Popup());
