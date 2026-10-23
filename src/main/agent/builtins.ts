import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile, appendFile, glob } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DATA_DIR, WORKSPACE_DIR } from '../config';
import { nowText } from '../util';
import type { ToolImpl } from './tools';

const MAX_OUT = 12000;

const clip = (s: string, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n)}\n…(截断，共 ${s.length} 字符)` : s);

/** Relative paths are resolved against the workspace dir; `~` is the home dir. */
function resolvePath(p: unknown, base = WORKSPACE_DIR): string {
  const s = String(p ?? '').trim() || '.';
  if (s === '~' || s.startsWith('~/')) return join(homedir(), s.slice(1));
  return isAbsolute(s) ? s : resolve(base, s);
}

async function workspace(): Promise<string> {
  await mkdir(WORKSPACE_DIR, { recursive: true });
  return WORKSPACE_DIR;
}

export interface ProcResult { code: number | null; out: string; err: string; timedOut: boolean }

export function runProcess(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }): Promise<ProcResult> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs) : null;
    child.stdout.on('data', (d) => { if (out.length < 1_000_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 1_000_000) err += d; });
    child.on('close', (code) => { if (timer) clearTimeout(timer); done({ code, out, err, timedOut }); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); done({ code: -1, out, err: err || e.message, timedOut }); });
    child.stdin.end(opts.input ?? '');
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const PATH_HINT = '相对路径基于工作目录 ~/.wechat-relay/workspace，可用绝对路径或 ~/';

/** Writes to the same file run one after another (several chats may edit the same memory file concurrently). */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => undefined);
  return next;
}

export const BUILTINS: Record<string, ToolImpl> = {
  'builtin:time': {
    name: 'get_current_time', description: '获取当前日期、星期和时间', parameters: obj({}),
    run: async () => nowText(),
  },
  'builtin:history': {
    name: 'get_chat_history', description: '读取当前会话更早的聊天记录',
    parameters: obj({ limit: { type: 'integer', description: '条数，默认 50' } }),
    run: async (args, ctx) => ctx.history.slice(-Number(args.limit ?? 50))
      .map((m) => `${m.side === 'self' ? '我' : m.sender || ctx.chat}: ${m.text}`).join('\n') || '(无记录)',
  },
  'builtin:skip': {
    name: 'skip_reply', description: '决定不回复这条消息（无需回复、与我无关、不适合自动回复时调用）',
    parameters: obj({ reason: { type: 'string' } }),
    run: async (args, ctx) => { ctx.skipped = { reason: String(args.reason ?? '') }; return 'ok, no reply will be sent'; },
  },
  'builtin:fetch': {
    name: 'WebFetch', description: '发起 HTTP 请求（获取网页正文或调用 API），HTML 会转成纯文本',
    parameters: obj({
      url: { type: 'string' },
      method: { type: 'string', description: '默认 GET' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: { type: 'string', description: '请求体（POST/PUT）' },
    }, ['url']),
    run: async (args) => {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) return 'error: 只支持 http(s) URL';
      const res = await fetch(url, {
        method: String(args.method ?? 'GET').toUpperCase(),
        headers: { 'user-agent': 'Mozilla/5.0 wechat-relay', ...((args.headers as Record<string, string>) ?? {}) },
        body: args.body == null ? undefined : String(args.body),
        signal: AbortSignal.timeout(20000),
      });
      const type = res.headers.get('content-type') ?? '';
      const text = await res.text();
      const body = /html/i.test(type) ? htmlToText(text) : text;
      return clip(`HTTP ${res.status} ${type}\n\n${body}`);
    },
  },
  'builtin:read': {
    name: 'Read', description: `读取文本文件，返回带行号的内容。${PATH_HINT}`,
    parameters: obj({
      path: { type: 'string' },
      offset: { type: 'integer', description: '起始行（从 1 开始）' },
      limit: { type: 'integer', description: '最多行数，默认 400' },
    }, ['path']),
    run: async (args) => {
      const p = resolvePath(args.path, await workspace());
      const buf = await readFile(p);
      if (buf.subarray(0, 8000).includes(0)) return `(二进制文件，${buf.length} 字节)`;
      const lines = buf.toString('utf8').split('\n');
      const from = Math.max(1, Number(args.offset ?? 1));
      const to = Math.min(lines.length, from - 1 + Math.max(1, Number(args.limit ?? 400)));
      const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}\t${l}`).join('\n');
      return clip(`${p}（第 ${from}-${to} 行，共 ${lines.length} 行）\n${body}`);
    },
  },
  'builtin:ls': {
    name: 'LS', description: `列出目录内容（目录以 / 结尾）。${PATH_HINT}`,
    parameters: obj({ path: { type: 'string', description: '默认工作目录' } }),
    run: async (args) => {
      const p = resolvePath(args.path, await workspace());
      const entries = await readdir(p, { withFileTypes: true });
      const rows = await Promise.all(entries.slice(0, 500).map(async (e) => {
        if (e.isDirectory()) return `${e.name}/`;
        const size = await stat(join(p, e.name)).then((s) => s.size, () => 0);
        return `${e.name}\t${size}`;
      }));
      return `${p}\n${rows.join('\n') || '(空目录)'}${entries.length > 500 ? `\n…共 ${entries.length} 项` : ''}`;
    },
  },
  'builtin:glob': {
    name: 'Glob', description: `按通配符查找文件，如 **/*.md。${PATH_HINT}`,
    parameters: obj({ pattern: { type: 'string' }, cwd: { type: 'string', description: '搜索根目录，默认工作目录' } }, ['pattern']),
    run: async (args) => {
      const cwd = resolvePath(args.cwd, await workspace());
      const found: string[] = [];
      for await (const f of glob(String(args.pattern ?? ''), { cwd, exclude: (n) => n === 'node_modules' || n === '.git' })) {
        found.push(f);
        if (found.length >= 500) break;
      }
      return found.length ? `${cwd}\n${found.join('\n')}` : '(无匹配)';
    },
  },
  'builtin:grep': {
    name: 'Grep', description: `在文件中搜索正则（扩展正则），返回 文件:行号:内容。${PATH_HINT}`,
    parameters: obj({
      pattern: { type: 'string' },
      path: { type: 'string', description: '文件或目录，默认工作目录' },
      include: { type: 'string', description: '只搜索匹配的文件名，如 *.ts' },
      ignore_case: { type: 'boolean' },
    }, ['pattern']),
    run: async (args) => {
      const ws = await workspace();
      const target = resolvePath(args.path, ws);
      const flags = ['-rnIE', '--exclude-dir=node_modules', '--exclude-dir=.git', ...(args.ignore_case ? ['-i'] : []), ...(args.include ? [`--include=${String(args.include)}`] : [])];
      const r = await runProcess('grep', [...flags, '-e', String(args.pattern ?? ''), '--', target], { timeoutMs: 30000 });
      if (r.code === 1) return '(无匹配)';
      if (r.code !== 0 && !r.out) return `error: ${r.err.trim() || `exit ${r.code}`}`;
      return clip(r.out.split('\n').map((l) => (l.startsWith(ws) ? relative(ws, l) : l)).join('\n'));
    },
  },
  'builtin:write': {
    name: 'Write', description: `写入文本文件（自动创建目录），默认覆盖。${PATH_HINT}`,
    parameters: obj({ path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean', description: '追加到末尾而不是覆盖' } }, ['path', 'content']),
    run: async (args) => {
      const p = resolvePath(args.path, await workspace());
      const content = String(args.content ?? '');
      await mkdir(dirname(p), { recursive: true });
      await serial(p, () => (args.append ? appendFile(p, content) : writeFile(p, content)));
      return `已${args.append ? '追加' : '写入'} ${Buffer.byteLength(content)} 字节到 ${p}`;
    },
  },
  'builtin:edit': {
    name: 'Edit', description: `编辑文本文件，两种方式：1) old_string → new_string 替换（old_string 须唯一，除非 replace_all）；2) 给出 start_line（及 end_line，含，默认等于 start_line），用 new_string 替换这些行，end_line = start_line - 1 表示在 start_line 之前插入，new_string 为空表示删除这些行。${PATH_HINT}`,
    parameters: obj({
      path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' },
      start_line: { type: 'integer', description: '按行编辑：起始行（从 1 开始）' },
      end_line: { type: 'integer', description: '按行编辑：结束行（含）' },
    }, ['path']),
    run: async (args) => {
      const p = resolvePath(args.path, await workspace());
      return serial(p, async () => {
        const text = await readFile(p, 'utf8');
        const to = String(args.new_string ?? '');
        if (args.start_line != null) {
          const lines = text.split('\n');
          const start = Math.floor(Number(args.start_line));
          const end = args.end_line == null ? start : Math.floor(Number(args.end_line));
          if (!(start >= 1 && start <= lines.length + 1)) return `error: start_line 需在 1 ~ ${lines.length + 1} 之间（文件共 ${lines.length} 行）`;
          if (end < start - 1 || end > lines.length) return `error: end_line 需在 ${start - 1} ~ ${lines.length} 之间`;
          lines.splice(start - 1, end - start + 1, ...(to === '' && end >= start ? [] : to.split('\n')));
          await writeFile(p, lines.join('\n'));
          return `已按行编辑 ${p}：第 ${start}-${Math.max(end, start - 1)} 行 → ${to === '' ? '删除' : `${to.split('\n').length} 行`}`;
        }
        const from = String(args.old_string ?? '');
        if (!from) return 'error: 需要 old_string，或 start_line（按行编辑）';
        const count = text.split(from).length - 1;
        if (!count) return 'error: 未找到 old_string';
        if (count > 1 && !args.replace_all) return `error: old_string 出现了 ${count} 次，请提供更多上下文或设置 replace_all`;
        await writeFile(p, args.replace_all ? text.split(from).join(to) : text.replace(from, () => to));
        return `已替换 ${args.replace_all ? count : 1} 处：${p}`;
      });
    },
  },
  'builtin:bash': {
    name: 'Bash', description: '在 bash 中执行命令，返回 stdout / stderr / 退出码。默认工作目录 ~/.wechat-relay/workspace',
    parameters: obj({
      command: { type: 'string' },
      cwd: { type: 'string' },
      timeout_ms: { type: 'integer', description: '默认 60000，最大 600000' },
    }, ['command']),
    run: async (args) => {
      const cwd = resolvePath(args.cwd, await workspace());
      const timeoutMs = Math.min(600000, Math.max(1000, Number(args.timeout_ms ?? 60000)));
      const r = await runProcess('/bin/bash', ['-c', String(args.command ?? '')], { cwd, timeoutMs });
      const parts = [r.out && `stdout:\n${r.out}`, r.err && `stderr:\n${r.err}`, r.timedOut ? `超时（${timeoutMs}ms）已终止` : `exit ${r.code}`];
      return clip(parts.filter(Boolean).join('\n'));
    },
  },
};

/** Memory / skill files only: the paths the silently enabled file tools may touch. */
const inside = (dirs: string[], p: string) => dirs.some((d) => p === d || p.startsWith(d + sep));

/**
 * read / glob / grep / write / edit limited to the given directories (memory and / or skills). They are added to an agent whenever
 * memory or skills are on, whether or not the unrestricted builtins are enabled: relative paths are based on the data
 * dir (`memory/global.md`), anything outside the two directories is refused.
 */
export function scopedFileTools(dirs: string[]): ToolImpl[] {
  const SCOPE_HINT = `只能访问 ${dirs.map((d) => `~/.wechat-relay/${relative(DATA_DIR, d)}`).join('、')}，相对路径基于 ~/.wechat-relay`;
  const list: Array<[string, string]> = [['builtin:read', 'path'], ['builtin:glob', 'cwd'], ['builtin:grep', 'path'], ['builtin:write', 'path'], ['builtin:edit', 'path']];
  return list.map(([id, key]) => {
    const t = BUILTINS[id];
    return {
      ...t,
      description: t.description.replace(PATH_HINT, SCOPE_HINT),
      run: async (args, ctx) => {
        const raw = String(args[key] ?? '').trim();
        if (!raw && (key === 'path' && (id === 'builtin:read' || id === 'builtin:write' || id === 'builtin:edit'))) return 'error: 需要 path';
        const p = resolvePath(raw || dirs[0], DATA_DIR);
        if (!inside(dirs, p)) return `error: 只能访问 ${dirs.join('、')}`;
        // Overwriting an existing memory / skill file loses its other lines (and the format header): append or edit instead.
        if (id === 'builtin:write' && !args.append && await stat(p).then(() => true, () => false)) {
          return 'error: 文件已存在，Write 会覆盖掉原有内容。追加新内容请设 append=true；修改已有内容请先 Read，再用 Edit（可用 start_line / end_line 按行修改）';
        }
        if (id === 'builtin:glob' && /(^|[\\/])\.\.([\\/]|$)/.test(String(args.pattern ?? ''))) return 'error: 通配符不能包含 ..';
        // Appended entries are lines: keep them apart from the previous last line.
        if (id === 'builtin:write' && args.append) {
          const prev = await readFile(p, 'utf8').catch(() => '');
          const body = String(args.content ?? '');
          return t.run({ ...args, [key]: p, content: (prev && !prev.endsWith('\n') ? '\n' : '') + body + (body.endsWith('\n') ? '' : '\n') }, ctx);
        }
        return t.run({ ...args, [key]: p }, ctx);
      },
    };
  });
}
