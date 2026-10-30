import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRIPT_TEMPLATE, SCRIPT_TSCONFIG, SDK_DTS } from '@shared/scriptSdk';
import type { ScriptConfig } from '@shared/types';
import { runProcess } from '../agent/builtins';
import { SCRIPTS_DIR } from '../config';
import { logger } from '../util';
import { RUNNER } from './runner';

const log = logger.scope('script');

export const scriptDir = (id: string) => join(SCRIPTS_DIR, id);
export const scriptFile = (id: string) => join(scriptDir(id), 'index.ts');
export const RUNNER_FILE = join(SCRIPTS_DIR, '_runner.mjs');

export function checkScriptId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('脚本 ID 只能包含字母、数字、下划线和连字符');
}

/** Node versions that strip TypeScript types without a flag. */
const stripsTypes = (v: string): boolean => {
  const [major, minor] = v.split('.').map(Number);
  return major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
};

let runtime: Promise<{ cmd: string; label: string }> | null = null;
/**
 * What runs scripts: the user's own Node (from PATH) when it is recent enough, else this app's Electron in Node mode.
 * The system Node is preferred because Electron's network stack (BoringSSL) is blocked by some corporate gateways and
 * because scripts then run exactly like in the user's terminal / VS Code.
 */
export function scriptRuntime(): Promise<{ cmd: string; label: string }> {
  return (runtime ??= (async () => {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      const bin = join(dir, 'node');
      if (!dir || !existsSync(bin)) continue;
      const v = await runProcess(bin, ['-p', 'process.versions.node'], { timeoutMs: 5000 }).then((r) => r.out.trim()).catch(() => '');
      if (/^\d+\.\d+\.\d+$/.test(v) && stripsTypes(v)) { log.info(`脚本使用系统 Node ${v}（${bin}）`); return { cmd: bin, label: `node ${v}` }; }
    }
    log.info('没有找到 Node ≥ 22.18，脚本改用应用内置的 Electron（Node 模式）');
    return { cmd: process.execPath, label: 'electron' };
  })());
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const writeIfChanged = (p: string, s: string) => { if (read(p) !== s) writeFileSync(p, s); };

const inflight = new Map<string, Promise<void>>();

/**
 * Writes the support files of a script folder (package.json, tsconfig.json, relay.d.ts, the shared runner; index.ts from the
 * template when missing) and runs `npm install` when the dependencies changed. `@types/node` is always a dev dependency so
 * VS Code has Node types; at run time it is only installed when the script has real dependencies.
 *  - run: install only when the script has dependencies; failures throw.
 *  - save: install when anything changed; failures throw if the script has dependencies, else only log.
 */
export function prepareScript(script: ScriptConfig, mode: 'run' | 'save'): Promise<void> {
  const prev = inflight.get(script.id) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => prepare(script, mode));
  inflight.set(script.id, next);
  void next.finally(() => { if (inflight.get(script.id) === next) inflight.delete(script.id); }).catch(() => undefined);
  return next;
}

async function prepare(script: ScriptConfig, mode: 'run' | 'save'): Promise<void> {
  checkScriptId(script.id);
  const dir = scriptDir(script.id);
  mkdirSync(dir, { recursive: true });
  writeIfChanged(RUNNER_FILE, RUNNER);
  const deps = script.dependencies ?? {};
  const dev = { '@types/node': '^24.0.0' };
  const pkg = { name: `wechat-relay-script-${script.id.toLowerCase()}`, private: true, type: 'module', dependencies: deps, devDependencies: dev };
  writeIfChanged(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeIfChanged(join(dir, 'tsconfig.json'), SCRIPT_TSCONFIG);
  writeIfChanged(join(dir, 'relay.d.ts'), SDK_DTS);
  if (!existsSync(join(dir, 'index.ts'))) writeFileSync(join(dir, 'index.ts'), SCRIPT_TEMPLATE);

  const hasDeps = Object.keys(deps).length > 0;
  if (mode === 'run' && !hasDeps) return;
  const stamp = join(dir, '.installed');
  const want = JSON.stringify({ deps, dev });
  if (read(stamp) === want && existsSync(join(dir, 'node_modules'))) return;
  log.info(`安装脚本 ${script.id} 的依赖：${[...Object.entries(deps), ...Object.entries(dev)].map(([k, v]) => `${k}@${v}`).join(' ')}`);
  const r = await runProcess('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, timeoutMs: 300000 });
  if (r.code !== 0) {
    const detail = (r.err || r.out).trim().slice(-4000);
    const msg = `npm install 失败${r.timedOut ? '（超时）' : ''}：\n${detail || `exit ${r.code}`}`;
    if (hasDeps) throw new Error(msg);
    log.warn(`脚本 ${script.id}：${msg}（只影响 VS Code 里的 Node 类型提示）`);
    return;
  }
  writeFileSync(stamp, want);
}

/** Source of a script; the template when it does not exist yet. */
export function readScript(id: string): string {
  checkScriptId(id);
  return read(scriptFile(id)) ?? SCRIPT_TEMPLATE;
}

/** .d.ts of @types/* packages installed in the script folder (the SDK and Node's own types are bundled with the editor). */
export function scriptTypings(id: string): Record<string, string> {
  checkScriptId(id);
  const out: Record<string, string> = {};
  const root = join(scriptDir(id), 'node_modules', '@types');
  if (!existsSync(root)) return out;
  let total = 0;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || total > 4_000_000) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, `${rel}/${name}`);
      else if (name.endsWith('.d.ts')) { const s = readFileSync(p, 'utf8'); total += s.length; out[`file:///scripts/${id}/node_modules/@types${rel}/${name}`] = s; }
    }
  };
  for (const pkg of readdirSync(root)) if (pkg !== 'node') walk(join(root, pkg), `/${pkg}`);
  return out;
}
