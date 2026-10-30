/**
 * Child-process side of a script run. It is plain JavaScript run by Electron in Node mode (whose Node strips TypeScript
 * types natively): it imports the script's index.ts, builds `api` as a thin proxy whose methods call the main process
 * over IPC (`{ rpc, method, params }` → `{ rpcResult, value | error }`, handled in host.ts) and sends `{ done }` at the end.
 */
export const RUNNER = `import { pathToFileURL } from 'node:url';

const pending = new Map();
let seq = 0;
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  process.send({ rpc: id, method, params });
});
const fire = (method, params) => process.send({ rpc: 0, method, params });
const fmt = (a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());

function buildApi(meta) {
  const { app, chat, dryRun, script } = meta;
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...a) => fire('log', { level, text: a.map(fmt).join(' ') });
  const held = [];
  return {
    app, dryRun, script, log,
    chat: {
      app: chat.app, name: chat.name, isGroup: chat.isGroup,
      history: (n) => call('history', { chat: chat.name, app: chat.app, n }),
      send: (text) => call('send', { chat: chat.name, app: chat.app, text }),
    },
    send: (name, text, opts) => call('send', { chat: name, app: opts && opts.app || app, text }),
    ai: {
      complete: (prompt, opts) => call('ai.complete', { prompt, ...(opts || {}) }),
      reply: (opts) => call('ai.reply', { chat: chat.name, app: chat.app, ...(opts || {}) }),
    },
    ask: (questions) => call('ask', { questions, chat: chat.name, isGroup: chat.isGroup }),
    ocr: (path) => call('ocr', { path }),
    notify: (n) => call('notify', n),
    clipboard: { read: () => call('clipboard.read'), write: (text) => call('clipboard.write', { text }) },
    exec: (cmd, args, opts) => call('exec', { cmd, args: args || [], ...(opts || {}) }),
    state: {
      get: (key) => call('state.get', { key }),
      set: (key, value) => call('state.set', { key, value }),
      delete: (key) => call('state.delete', { key }),
    },
    lock: async (key, fn) => {
      await call('lock.acquire', { key });
      try { return await fn(); } finally { await call('lock.release', { key }); }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

async function run({ file, event, meta }) {
  const mod = await import(pathToFileURL(file).href);
  const def = mod.default;
  const handler = typeof def === 'function' ? def : def && typeof def.onMessage === 'function' ? def.onMessage.bind(def) : typeof mod.onMessage === 'function' ? mod.onMessage : null;
  if (!handler) throw new Error('脚本需要 export default { onMessage(ev, api) {…} }，或 export default 一个 (ev, api) => … 函数');
  const r = await handler(event, buildApi(meta));
  return r == null ? '' : typeof r === 'string' ? r : JSON.stringify(r, null, 2);
}

process.on('message', async (m) => {
  if (m.rpcResult) {
    const p = pending.get(m.rpcResult);
    if (!p) return;
    pending.delete(m.rpcResult);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.value);
    return;
  }
  if (!m.run) return;
  // A pending promise alone does not keep Node alive; stay up until the script settles (or the host's timeout kills us).
  const keepAlive = setInterval(() => {}, 1 << 30);
  let done;
  try { done = { ok: true, result: await run(m.run) }; } catch (e) { done = { ok: false, error: (e && e.stack) || String(e) }; }
  clearInterval(keepAlive);
  process.send({ done }, () => process.exit(0));
});
`;
