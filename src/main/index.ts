import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, shell } from 'electron';
import type { AppConfig, RelayEvent, TestAgentRequest, TestAgentResult } from '@shared/types';
import { runAgent } from './agent/engine';
import { mcpPool } from './agent/tools';
import { CONFIG_PATH, configStore } from './config';
import { Monitor } from './monitor';
import { store } from './store';
import { errText, logger } from './util';
import { visionBinary } from './vision';
import type { Frame } from './wechat';

const log = logger.scope('app');
let win: BrowserWindow | null = null;
let monitor: Monitor;

function send(e: RelayEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('relay:event', e);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 1100, minHeight: 700,
    title: 'WeChat Relay',
    show: !process.env.RELAY_SHOW_INACTIVE,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f6f8',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => { win = null; });
  win.webContents.on('preload-error', (_e, path, err) => log.error(`preload ${path}: ${err.message}`));
  // stdout only: routing these through the logger would feed back into the renderer's log view.
  win.webContents.on('console-message', (e) => { if (e.level === 'error') console.error(`[renderer] ${e.message}`); });
  // Show without activating (used when started from scripts, so WeChat / the user's app keeps focus).
  if (process.env.RELAY_SHOW_INACTIVE) win.once('ready-to-show', () => win?.showInactive());
}

let lastFrameSent = 0;
function sendFrame(f: Frame): void {
  if (!win || win.isDestroyed() || !win.isVisible() || Date.now() - lastFrameSent < 1500) return;
  lastFrameSent = Date.now();
  const img = nativeImage.createFromPath(f.path);
  if (img.isEmpty()) return;
  const small = img.resize({ width: Math.min(1100, f.width) });
  const { lines: _lines, ...vision } = f.vision;
  send({ type: 'snapshot', snapshot: { at: f.at, image: `data:image/jpeg;base64,${small.toJPEG(80).toString('base64')}`, vision: { ...vision, lines: [] } } });
}

/**
 * Apps started from Finder / Dock only get launchd's minimal PATH, so CLIs installed via nvm / Homebrew
 * (codebuddy, claude, npx, uvx) would not be found. Adopt the login shell's PATH once at startup.
 */
function loadShellPath(): void {
  if (process.platform !== 'darwin') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
    const path = /__PATH__(.*)__PATH__/.exec(out)?.[1];
    if (path) process.env.PATH = [...new Set([...path.split(':'), ...(process.env.PATH ?? '').split(':')])].filter(Boolean).join(':');
  } catch (e) {
    log.warn(`读取登录 shell PATH 失败：${errText(e)}`);
  }
}

function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
  ipcMain.handle(channel, async (_e, ...args) => fn(...(args as T)));
}

function registerIpc(): void {
  handle('status', () => monitor.getStatus());
  handle('start', () => monitor.start());
  handle('stop', () => monitor.stop());
  handle('tickOnce', () => monitor.tickOnce());
  handle('getConfig', () => configStore.config);
  handle('saveConfig', (c: AppConfig) => configStore.save(c));
  handle('getConfigYaml', () => configStore.yaml());
  handle('saveConfigYaml', (y: string) => configStore.saveYaml(y));
  handle('openConfigFile', () => { void shell.openPath(CONFIG_PATH); });
  handle('getLogs', () => logger.all());
  handle('getChats', () => store.summaries());
  handle('getHistory', (chat: string) => store.history(chat));
  handle('setChatPaused', (chat: string, paused: boolean) => store.setPaused(chat, paused));
  handle('clearHistory', (chat: string) => store.clear(chat));
  handle('getDrafts', () => store.drafts());
  handle('approveDraft', (id: string, text?: string) => monitor.approve(id, text));
  handle('rejectDraft', (id: string) => monitor.reject(id));
  handle('sendManual', (chat: string, text: string) => monitor.sendManual(chat, text));
  handle('listMcpTools', async (id: string) => {
    const s = configStore.config.mcpServers.find((x) => x.id === id);
    if (!s) throw new Error('未找到 MCP server');
    return (await mcpPool.tools({ ...s, enabled: true })).map((t) => ({ name: t.name, description: t.description }));
  });
  handle('testAgent', async (req: TestAgentRequest): Promise<TestAgentResult> => {
    const t0 = Date.now();
    const now = Date.now();
    const history = req.messages.map((m, i) => ({ id: String(i), side: m.side, sender: m.sender, text: m.text, at: now, source: 'ocr' as const }));
    const incoming: typeof history = [];
    for (let i = history.length - 1; i >= 0 && history[i].side === 'other'; i--) incoming.unshift(history[i]);
    try {
      const out = await runAgent(configStore.config, req.agent, { chat: req.chat, isGroup: req.isGroup, history, incoming });
      return { ok: true, reply: out.reply, skipped: out.skipped, trace: [...out.trace, ...(out.reason ? [`skip: ${out.reason}`] : [])], ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: errText(e), trace: [], ms: Date.now() - t0 };
    }
  });
}

app.whenReady().then(() => {
  loadShellPath();
  store.load();
  try { configStore.load(); } catch (e) { dialog.showErrorBox('配置文件错误', `${CONFIG_PATH}\n\n${errText(e)}`); }
  configStore.watch((e) => log.error(`配置重载失败：${errText(e)}`));
  configStore.on('change', (c: AppConfig) => {
    monitor.setConfig(c);
    void mcpPool.closeAll();
    send({ type: 'config', config: c });
    log.info('配置已更新');
  });

  monitor = new Monitor(configStore.config, visionBinary(app.getAppPath(), app.isPackaged ? process.resourcesPath : undefined));
  monitor.on('status', (status) => send({ type: 'status', status }));
  monitor.on('frame', sendFrame);
  monitor.on('chat', (chat, message) => send({ type: 'chat', chat, message }));
  monitor.on('draft', (draft) => {
    send({ type: 'draft', draft });
    if (draft.status === 'pending' && Notification.isSupported()) new Notification({ title: `待审核回复 · ${draft.chat}`, body: draft.text }).show();
  });
  monitor.on('safety', (msg: string) => {
    configStore.save({ ...configStore.config, general: { ...configStore.config.general, autoReply: false } });
    if (Notification.isSupported()) new Notification({ title: '已停止自动回复', body: msg }).show();
  });
  logger.on('entry', (entry) => send({ type: 'log', entry }));

  registerIpc();
  createWindow();
  void monitor.start();

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { /* keep monitoring in the background on macOS */ if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { store.flush(); void monitor?.dispose(); void mcpPool.closeAll(); });
