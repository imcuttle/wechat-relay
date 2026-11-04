import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app, desktopCapturer, systemPreferences } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DriverConfig } from '@shared/types';
import { errText, logger } from './util';

const log = logger.scope('driver');
const execFileAsync = promisify(execFile);

const HOST_BUNDLE_ID = 'dev.cuttleyu.wechat-relay';

/** cua-driver shipped inside this app (Resources/native when packaged, native/bin in dev). */
function bundledDriver(): string | null {
  const candidates = [join(process.resourcesPath ?? '', 'native', 'cua-driver'), join(app.getAppPath(), 'native', 'bin', 'cua-driver')];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** The bare `cua-driver` executable behind an MCP entry point (CodeBuddy's launcher script lives in bin/, the app in vendor/). */
function driverBinary(command: string): string | null {
  if (command.endsWith('cua-driver-mcp')) {
    const bin = join(dirname(dirname(command)), 'vendor/CuaDriver.app/Contents/MacOS/cua-driver');
    return existsSync(bin) ? bin : null;
  }
  return basename(command) === 'cua-driver' ? command : null;
}

let requestedHostPermissions = false;
/** Embedded drivers never prompt: macOS checks the host app, so this app has to ask for 辅助功能 / 录屏 itself. */
function requestHostPermissions(): void {
  if (requestedHostPermissions || process.platform !== 'darwin') return;
  requestedHostPermissions = true;
  try {
    if (!systemPreferences.isTrustedAccessibilityClient(true)) log.warn('「WeChat Relay」缺少辅助功能权限：请在 系统设置 → 隐私与安全性 → 辅助功能 中打开');
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      log.warn('「WeChat Relay」缺少录屏权限：请在 系统设置 → 隐私与安全性 → 录屏与系统录音 中打开');
      void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined);
    }
  } catch (e) { log.debug(`request permissions: ${errText(e)}`); }
}

/** Socket of the daemon that the bundled `cua-driver-mcp` launcher uses (mirrors bin/lib.sh); null for other entry points. */
function daemonSocket(command: string): string | null {
  if (!command.endsWith('cua-driver-mcp')) return null;
  const stateDir = process.env.CODEBUDDY_PLUGIN_DATA || join(homedir(), 'Library/Caches/codebuddy-desktop/cua-driver');
  let sock = join(stateDir, 'driver.sock');
  if (sock.length > 100) sock = join(process.env.TMPDIR || '/tmp', `codebuddy-cua-${process.getuid?.() ?? 0}.sock`);
  return existsSync(sock) ? sock : null;
}

/** Locate a cua-driver MCP entry point: CodeBuddy Desktop bundle, CodeBuddy plugin cache, or `cua-driver` on PATH. */
export function resolveDriver(cfg: DriverConfig): { command: string; args: string[] } | null {
  if (cfg.command && cfg.command !== 'auto') return { command: cfg.command, args: cfg.args ?? [] };
  const candidates = [
    '/Applications/CodeBuddy Desktop.app/Contents/Resources/native/cua-driver/bin/cua-driver-mcp',
    '/Applications/CodeBuddy Desktop.app/Contents/Resources/plugins/cua-driver/bin/cua-driver-mcp',
    '/Applications/CodeBuddy.app/Contents/Resources/plugins/cua-driver/bin/cua-driver-mcp',
    '/Applications/WorkBuddy.app/Contents/Resources/plugins/cua-driver/bin/cua-driver-mcp',
  ];
  const cache = join(homedir(), '.codebuddy', 'plugins', 'cache');
  try {
    for (const market of readdirSync(cache)) {
      const dir = join(cache, market, 'cua-driver');
      if (!existsSync(dir)) continue;
      for (const v of readdirSync(dir).sort().reverse()) candidates.push(join(dir, v, 'bin', 'cua-driver-mcp'));
    }
  } catch { /* no cache */ }
  for (const c of candidates) if (existsSync(c)) return { command: c, args: [] };
  for (const p of (process.env.PATH ?? '').split(':')) {
    const bin = join(p, 'cua-driver');
    if (p && existsSync(bin)) return { command: bin, args: ['mcp'] };
  }
  for (const bin of ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver', join(homedir(), '.local/bin/cua-driver')]) {
    if (existsSync(bin)) return { command: bin, args: ['mcp'] };
  }
  return null;
}

export interface ToolResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/** MCP stdio client for the Cua Driver (background AX / screenshot / input for native macOS apps). */
export class CuaDriver {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  /** Driver sessions are ended for good when their owner disconnects, so each connection gets a fresh label. */
  private session = '';
  private entryCommand = '';
  private lastDaemonRestart = 0;
  /** Private driver daemon owned by this app (embedded mode); macOS then checks this app's permissions, not CuaDriver's. */
  private daemon: ChildProcess | null = null;
  private daemonSock = '';
  private inflight = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  constructor(private cfg: DriverConfig) {}

  setConfig(cfg: DriverConfig): void {
    const changed = cfg.enabled !== this.cfg.enabled || cfg.command !== this.cfg.command || cfg.embedded !== this.cfg.embedded || JSON.stringify(cfg.args) !== JSON.stringify(this.cfg.args);
    this.cfg = cfg;
    if (changed) void this.close();
    else this.armIdle();
  }

  get enabled(): boolean { return this.cfg.enabled !== false; }

  /** (Re)starts the idle countdown; the driver process is stopped when it expires and is launched again by the next call. */
  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const sec = this.cfg.idleTimeoutSec ?? 60;
    if (sec <= 0 || (!this.client && !this.daemon)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inflight > 0 || this.connecting) return this.armIdle();
      log.info(`cua-driver 空闲 ${sec} 秒，已退出（下次需要时自动启动）`);
      void this.close();
    }, sec * 1000);
    this.idleTimer.unref?.();
  }

  get deliveryMode() { return this.cfg.deliveryMode; }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const own = this.cfg.embedded !== false && process.platform === 'darwin' && (!this.cfg.command || this.cfg.command === 'auto') ? bundledDriver() : null;
      const entry = own ? { command: own, args: [] as string[] } : resolveDriver(this.cfg);
      if (!entry) throw new Error('找不到 cua-driver：请安装 CodeBuddy Desktop，或在配置 driver.command 中指定 cua-driver-mcp 路径');
      this.entryCommand = entry.command;
      let { command, args } = entry;
      const bin = this.cfg.embedded !== false && process.platform === 'darwin' ? (bundledDriver() ?? driverBinary(entry.command)) : null;
      if (bin) {
        requestHostPermissions();
        this.daemonSock = await this.startDaemon(bin);
        command = bin; args = ['mcp', '--socket', this.daemonSock];
      }
      log.info(`starting ${command} ${args.join(' ')}`);
      const transport = new StdioClientTransport({ command, args, stderr: 'pipe' });
      transport.stderr?.on('data', (d: Buffer) => log.debug(d.toString().trim()));
      const client = new Client({ name: 'wechat-relay', version: '0.1.0' });
      client.onclose = () => { if (this.client === client) { this.client = null; log.warn('driver connection closed'); } };
      await client.connect(transport);
      this.session = `wechat-relay-${process.pid}-${Date.now().toString(36)}`;
      await client.callTool({ name: 'start_session', arguments: { session: this.session } }).catch((e) => log.debug(`start_session: ${errText(e)}`));
      await client.callTool({ name: 'set_agent_cursor_enabled', arguments: { session: this.session, enabled: false } }).catch((e) => log.debug(`hide cursor: ${errText(e)}`));
      this.client = client;
      return client;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 30000, retried = false): Promise<ToolResult> {
    if (!this.enabled) throw new Error('cua-driver: 驱动总开关已关闭（界面左上角可重新打开）');
    this.inflight++;
    try { return await this.callOnce(name, args, timeoutMs, retried); } finally { this.inflight--; this.armIdle(); }
  }

  private async callOnce(name: string, args: Record<string, unknown>, timeoutMs: number, retried: boolean): Promise<ToolResult> {
    const client = await this.connect();
    try {
      const res = (await client.callTool({ name, arguments: { session: this.session, ...args } }, undefined, { timeout: timeoutMs })) as ToolResult;
      if (res.isError) throw new Error(`${name}: ${text(res) || 'failed'}`);
      return res;
    } catch (e) {
      const m = errText(e);
      if (/closed|not connected|EPIPE/i.test(m)) this.client = null;
      if (!retried && /session has ended|unknown session|start_session/i.test(m)) {
        await this.close();
        return this.callOnce(name, args, timeoutMs, true);
      }
      // 长期运行的 daemon 读不到之后才授予的 TCC 权限，一直报 permissions_pending；重启 daemon 即可生效。
      if (!retried && /permissions_pending/i.test(m) && (await this.restartDaemon())) {
        return this.callOnce(name, args, timeoutMs, true);
      }
      if (this.daemon && /permissions_pending/i.test(m)) {
        throw new Error(`${m}（请在 系统设置 → 隐私与安全性 的「辅助功能」和「录屏与系统录音」中为「WeChat Relay」打开权限）`);
      }
      throw e;
    }
  }

  /** Spawn this app's own driver daemon (`serve --embedded`) on a private socket; returns the socket path. */
  private async startDaemon(bin: string): Promise<string> {
    this.stopDaemon();
    const sock = join(tmpdir(), `wechat-relay-cua-${process.getuid?.() ?? 0}.sock`);
    // An orphan from a crashed run would keep serving the old socket.
    await execFileAsync('pkill', ['-f', `serve --embedded --socket ${sock}`]).catch(() => undefined);
    rmSync(sock, { force: true });
    const env = { ...process.env, CUA_DRIVER_HOST_BUNDLE_ID: app.isPackaged ? HOST_BUNDLE_ID : 'com.github.Electron' };
    const child = spawn(bin, ['serve', '--embedded', '--socket', sock], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (d: Buffer) => log.debug(d.toString().trim()));
    child.on('exit', (code) => { if (this.daemon === child) { this.daemon = null; log.warn(`driver daemon exited (${code})`); } });
    this.daemon = child;
    for (let i = 0; i < 100; i++) {
      if (existsSync(sock)) return sock;
      if (this.daemon !== child) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.stopDaemon();
    throw new Error('cua-driver: 内置 daemon 未能在 10 秒内就绪');
  }

  private stopDaemon(): void {
    const d = this.daemon; this.daemon = null;
    if (d && d.exitCode === null) d.kill('SIGTERM');
    if (this.daemonSock) rmSync(this.daemonSock, { force: true });
  }

  /** The driver reads macOS permissions once at launch, so a grant made afterwards only counts after a restart. Rate-limited; false if nothing was restarted. */
  private async restartDaemon(): Promise<boolean> {
    if (Date.now() - this.lastDaemonRestart < 60_000) return false;
    this.lastDaemonRestart = Date.now();
    try {
      if (this.daemon) {
        log.warn('cua-driver 报告权限待定（permissions_pending），重启驱动以读取最新授权');
        await this.close();
        return true;
      }
      // Shared CodeBuddy daemon (embedded: false): restart it for every client.
      const sock = daemonSocket(this.entryCommand);
      if (!sock) return false;
      const { stdout } = await execFileAsync('lsof', ['-t', sock]).catch(() => ({ stdout: '' }));
      let killed = 0;
      for (const pid of stdout.split('\n').map((x) => Number(x.trim())).filter((n) => n > 0)) {
        const { stdout: cmd } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
        if (/cua-driver\s+serve\b/.test(cmd)) { process.kill(pid, 'SIGTERM'); killed++; }
      }
      if (!killed) return false;
      log.warn('cua-driver 权限状态过期（permissions_pending），已重启共享 daemon');
      await this.close();
      await new Promise((r) => setTimeout(r, 1000));
      return true;
    } catch (e) {
      log.warn(`重启 cua-driver 失败：${errText(e)}`);
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const c = this.client; this.client = null;
    if (c && this.session) await c.callTool({ name: 'end_session', arguments: { session: this.session } }).catch(() => undefined);
    try { await c?.close(); } catch { /* ignore */ }
    this.stopDaemon();
  }
}

export function text(r: ToolResult): string {
  return (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

export function structured<T = Record<string, unknown>>(r: ToolResult): T {
  if (r.structuredContent) return r.structuredContent as T;
  try { return JSON.parse(text(r)) as T; } catch { return {} as T; }
}
