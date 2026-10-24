import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, Notification, protocol, shell } from 'electron';
import type { AppConfig, ChatMessage, DebugSection, Draft, Persona, PromptCase, PersonaOptions, RelayEvent, ReplyMode, SyncOptions, TestAgentRequest, TestAgentResult, ToolConfig } from '@shared/types';
import { dream } from './agent/dream';
import { runAgent, syncHarnesses } from './agent/engine';
import { acpPool } from './agent/acp';
import { prewarm } from './agent/prewarm';
import { memorySummaries, readMemory, writeMemory } from './agent/memory';
import { proxy } from './agent/proxy';
import { allSkills, deleteSkill, skillPath, syncSkills } from './agent/skills';
import { prepareScriptTool } from './agent/scriptTools';
import { mcpPool } from './agent/tools';
import { CONFIG_PATH, configStore, MEDIA_DIR } from './config';
import { Monitor } from './monitor';
import { popup } from './popup';
import { store } from './store';
import { errText, logger } from './util';
import { personaPromptId } from '@shared/prompt';
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

function getPersona(chat: string): Persona | null {
  const meta = store.chat(chat)?.persona;
  if (!meta) return null;
  const own = personaPromptId(chat);
  const p = configStore.config.prompts.find((x) => x.id === own);
  return { ...meta, own, text: p?.content ?? '', goodCases: p?.goodCases ?? [], badCases: p?.badCases ?? [] };
}

/**
 * Persona in use = any prompt of the config. The chat's own persona prompt must have text; switching away keeps it
 * (and its examples, which still apply on top of the other prompt).
 */
function selectPersona(chat: string, prompt: string | null): Persona | null {
  const meta = store.chat(chat)?.persona;
  if (prompt === null) {
    if (meta) store.setPersona(chat, { ...meta, enabled: false });
    return getPersona(chat);
  }
  const p = configStore.config.prompts.find((x) => x.id === prompt);
  if (!p) throw new Error(`没有 id 为「${prompt}」的提示词`);
  if (!p.content.trim()) throw new Error(prompt === personaPromptId(chat) ? '本会话人设还没有正文，先在「人设」里生成或填写' : `提示词「${p.name || p.id}」是空的`);
  store.setPersona(chat, { ...(meta ?? {}), prompt, enabled: true, updatedAt: Date.now() });
  return getPersona(chat);
}

/** Reply examples live on the chat's own persona prompt; a chat without one gets an empty, switched-off persona. */
function setPersonaCases(chat: string, cases: { goodCases: PromptCase[]; badCases: PromptCase[] }): Persona {
  const meta = store.chat(chat)?.persona;
  const id = personaPromptId(chat);
  const next = structuredClone(configStore.config);
  const clean = (l: PromptCase[]) => { const x = (l ?? []).filter((c) => c.reply?.trim()); return x.length ? x : undefined; };
  const fields = { goodCases: clean(cases.goodCases), badCases: clean(cases.badCases) };
  const i = next.prompts.findIndex((x) => x.id === id);
  if (i >= 0) next.prompts[i] = { ...next.prompts[i], ...fields }; else next.prompts.push({ id, name: `人设 · ${chat}`, content: '', ...fields });
  configStore.save(next);
  if (!meta) store.setPersona(chat, { prompt: id, enabled: false, updatedAt: Date.now() });
  return getPersona(chat)!;
}

/**
 * Writes the chat's own persona prompt (a normal entry of `prompts`, shown on the 提示词 page). Enabling it switches
 * the chat to it; switching it off only matters while it is the one in use.
 */
function setPersona(chat: string, p: { text: string; enabled: boolean; source?: string }): Persona | null {
  const meta = store.chat(chat)?.persona;
  const id = personaPromptId(chat);
  const inUse = !meta || meta.prompt === id;
  const next = structuredClone(configStore.config);
  const i = next.prompts.findIndex((x) => x.id === id);
  if (!p.text.trim()) {
    if (i >= 0) { next.prompts.splice(i, 1); configStore.save(next); }
    // Another prompt switched to stays in use.
    store.setPersona(chat, inUse ? null : { ...meta!, source: undefined });
    return getPersona(chat);
  }
  const content = p.text.trim();
  if (i >= 0) next.prompts[i] = { ...next.prompts[i], content }; else next.prompts.push({ id, name: `人设 · ${chat}`, content });
  configStore.save(next);
  store.setPersona(chat, p.enabled || inUse
    ? { prompt: id, enabled: p.enabled, updatedAt: Date.now(), source: p.source ?? meta?.source }
    : { ...meta!, updatedAt: Date.now(), source: p.source ?? meta?.source });
  return getPersona(chat);
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
  handle('deleteChats', (chats: string[]) => store.remove(chats));
  handle('getDrafts', () => store.drafts());
  handle('approveDraft', (id: string, text?: string) => monitor.approve(id, text));
  handle('rejectDraft', (id: string) => monitor.reject(id));
  handle('sendManual', (chat: string, text: string) => monitor.sendManual(chat, text));
  handle('syncHistory', (chat: string, opts?: SyncOptions) => monitor.syncHistory(chat, opts));
  handle('addChat', (chat: string) => monitor.addChat(chat));
  handle('generateReply', (chat: string, agent?: string) => monitor.generateReply(chat, agent));
  handle('setChatMode', (chat: string, mode: ReplyMode | 'inherit') => store.setMode(chat, mode));
  handle('setChatAsk', (chat: string, ask: 'inherit' | 'on' | 'off') => store.setAsk(chat, ask));
  handle('getPersona', (chat: string) => getPersona(chat));
  handle('setPersona', (chat: string, p: { text: string; enabled: boolean }) => setPersona(chat, p));
  handle('selectPersona', (chat: string, prompt: string | null) => selectPersona(chat, prompt));
  handle('agentPrompt', (chat: string) => {
    const agent = configStore.config.agents.find((a) => a.id === monitor.agentFor(chat).agent);
    return agent ? { agent: agent.name || agent.id, prompt: agent.prompt } : null;
  });
  handle('setPersonaCases', (chat: string, c: { goodCases: PromptCase[]; badCases: PromptCase[] }) => setPersonaCases(chat, c));
  handle('generatePersona', async (chat: string, o: PersonaOptions) => {
    const r = await monitor.generatePersona(chat, o);
    return { persona: setPersona(chat, { text: r.text, enabled: true, source: r.source })!, count: r.count, note: r.note };
  });
  handle('listMcpTools', async (id: string) => {
    const s = configStore.config.mcpServers.find((x) => x.id === id);
    if (!s) throw new Error('未找到 MCP server');
    return (await mcpPool.tools({ ...s, enabled: true })).map((t) => ({ name: t.name, description: t.description }));
  });
  handle('prepareTool', (t: ToolConfig) => prepareScriptTool(t));
  const chatNames = () => store.summaries().map((c) => c.name);
  handle('listMemory', () => memorySummaries(chatNames()));
  handle('readMemory', (scope: 'global' | 'session', chat?: string) => readMemory(scope, chat));
  handle('writeMemory', (scope: 'global' | 'session', chat: string | undefined, text: string) => writeMemory(scope, chat, text));
  handle('listSkills', () => allSkills(configStore.config, chatNames()));
  handle('readSkill', (scope: 'global' | 'session', chat: string | undefined, id: string) => {
    const file = skillPath(scope, chat, id);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  });
  handle('writeSkill', (scope: 'global' | 'session', chat: string | undefined, id: string, text: string) => {
    const file = skillPath(scope, chat, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  });
  handle('deleteSkill', (scope: 'global' | 'session', chat: string | undefined, id: string) => deleteSkill(scope, chat, id));
  handle('dreamMemory', async (chat?: string) => ({ message: await dream(configStore.config, chat) }));
  handle('testAgent', async (req: TestAgentRequest): Promise<TestAgentResult> => {
    const t0 = Date.now();
    const now = Date.now();
    const detail: DebugSection[] = [];
    const history: ChatMessage[] = [];
    for (const [i, m] of req.messages.entries()) {
      const msg: ChatMessage = { id: String(i), side: m.side, sender: m.sender, text: m.text, at: now, source: 'ocr' };
      if (m.image) {
        // Same shape as a real image message: a downscaled JPEG crop in MEDIA_DIR + "[图片] <text in it>".
        const img = nativeImage.createFromDataURL(m.image);
        if (img.isEmpty()) throw new Error(`第 ${i + 1} 条消息的图片无法解析`);
        const max = configStore.config.general.imageMaxSize || 768;
        const { width, height } = img.getSize();
        const k = Math.min(1, max / Math.max(width, height));
        const jpg = (k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }) : img).toJPEG(85);
        mkdirSync(MEDIA_DIR, { recursive: true });
        const file = join(MEDIA_DIR, `test-${createHash('sha1').update(jpg).digest('hex').slice(0, 16)}.jpg`);
        writeFileSync(file, jpg);
        const ocr = m.text.trim() || (await monitor.vision.ocr(file).catch(() => null))?.text.trim() || '';
        Object.assign(msg, { kind: 'image', image: file, text: ocr ? `[图片] ${ocr}` : '[图片]' });
      }
      history.push(msg);
    }
    const incoming: ChatMessage[] = [];
    for (let i = history.length - 1; i >= 0 && history[i].side === 'other'; i--) incoming.unshift(history[i]);
    try {
      const out = await runAgent(configStore.config, req.agent, { chat: req.chat, isGroup: req.isGroup, history, incoming, debug: detail, ask: req.ask });
      return { ok: true, reply: out.reply, skipped: out.skipped, trace: [...out.trace, ...(out.reason ? [`skip: ${out.reason}`] : [])], detail, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: errText(e), trace: [], detail, ms: Date.now() - t0 };
    }
  });
}

/** Approval of a new draft in the global popup; closed / timed out = it stays in 待审核. */
const reviewing = new Set<string>();
async function reviewInPopup(draft: Draft): Promise<void> {
  if (reviewing.has(draft.id)) return;
  reviewing.add(draft.id);
  const isGroup = store.chat(draft.chat)?.isGroup ?? false;
  const trigger = new Set(draft.trigger.split('\n'));
  const lines = store.history(draft.chat).slice(-8).map((m) => {
    const who = m.side === 'self' ? '我' : isGroup ? m.sender || '群成员' : draft.chat;
    return { who, text: m.text, self: m.side === 'self', isNew: m.side === 'other' && trigger.has(m.sender ? `${m.sender}: ${m.text}` : m.text) };
  });
  const r = await popup().review({ id: draft.id, chat: draft.chat, isGroup, lines, text: draft.text, timeoutSec: configStore.config.general.askTimeoutSec });
  // Handled in the main window meanwhile.
  if (store.drafts().find((d) => d.id === draft.id)?.status !== 'pending') return;
  try {
    if (r.action === 'send') await monitor.approve(draft.id, r.text);
    else if (r.action === 'reject') await monitor.reject(draft.id);
  } catch (e) {
    log.error(`审批草稿失败：${errText(e)}`);
  } finally {
    reviewing.delete(draft.id);
  }
}

// Last-resort guard: log instead of showing Electron's modal "JavaScript error in the main process" dialog.
process.on('uncaughtException', (e) => log.error(`未捕获异常：${e.stack ?? e.message}`));
process.on('unhandledRejection', (e) => log.error(`未处理的 Promise 拒绝：${errText(e)}`));

// relay-media://img/<file> serves stored image-message crops (only files directly inside MEDIA_DIR).
protocol.registerSchemesAsPrivileged([{ scheme: 'relay-media', privileges: { standard: true, secure: true } }]);

app.whenReady().then(() => {
  protocol.handle('relay-media', (req) => {
    const file = basename(decodeURIComponent(new URL(req.url).pathname));
    return net.fetch(pathToFileURL(join(MEDIA_DIR, file)).toString());
  });
  loadShellPath();
  // Packaged apps get the icon from Info.plist; in dev the Dock would show Electron's default.
  if (!app.isPackaged && process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'));
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  }
  store.load();
  try { configStore.load(); } catch (e) { dialog.showErrorBox('配置文件错误', `${CONFIG_PATH}\n\n${errText(e)}`); }
  configStore.watch((e) => log.error(`配置重载失败：${errText(e)}`));
  syncSkills(configStore.config);
  // Exact chat names used in rules get a (possibly empty) record so they show up in 会话记录 right away.
  const syncRuleChats = (c: AppConfig) => {
    const names = c.rules.flatMap((r) => (r.enabled === false ? [] : r.match.chats ?? []))
      .map((n) => n.trim()).filter((n) => n && !n.includes('*') && !/^\/.*\/[a-z]*$/.test(n));
    const known = new Set(store.summaries().map((x) => x.name));
    const added = names.filter((n) => !known.has(n));
    for (const n of added) store.ensure(n, c.rules.some((r) => r.match.chats?.includes(n) && r.match.chatType === 'group'));
    if (added.length) { send({ type: 'chat', chat: added[0] }); log.info(`已根据回复规则新增会话记录：${added.join('、')}`); }
  };
  syncRuleChats(configStore.config);
  configStore.on('change', (c: AppConfig) => {
    syncRuleChats(c);
    syncSkills(c);
    monitor.setConfig(c);
    void mcpPool.closeAll();
    syncHarnesses(c);
    send({ type: 'config', config: c });
    log.info('配置已更新');
  });

  syncHarnesses(configStore.config);
  monitor = new Monitor(configStore.config, visionBinary(app.getAppPath(), app.isPackaged ? process.resourcesPath : undefined));
  monitor.on('status', (status) => send({ type: 'status', status }));
  monitor.on('frame', sendFrame);
  monitor.on('chat', (chat, message) => send({ type: 'chat', chat, message }));
  monitor.on('draft', (draft: Draft) => {
    send({ type: 'draft', draft });
    if (draft.status !== 'pending') return;
    if (configStore.config.general.reviewPopup) void reviewInPopup(draft);
    else if (Notification.isSupported()) new Notification({ title: `待审核回复 · ${draft.chat}`, body: draft.text }).show();
  });
  monitor.on('safety', (msg: string) => {
    configStore.save({ ...configStore.config, general: { ...configStore.config.general, autoReply: false } });
    if (Notification.isSupported()) new Notification({ title: '已停止自动回复', body: msg }).show();
  });
  logger.on('entry', (entry) => send({ type: 'log', entry }));

  registerIpc();
  popup();
  createWindow();
  void monitor.repairImages().catch((e) => log.warn(`修复图片消息失败：${errText(e)}`)).finally(() => void monitor.start());

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { /* keep monitoring in the background on macOS */ if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { store.flush(); void monitor?.dispose(); void mcpPool.closeAll(); proxy.close(); prewarm.dispose(); acpPool.dispose(); popup().dispose(); });
