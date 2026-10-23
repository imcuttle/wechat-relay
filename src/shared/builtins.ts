// Built-in tools metadata shared by main (implementation in main/agent/builtins.ts) and renderer (switches / agent picker).

export interface BuiltinToolMeta {
  id: string;
  label: string;
  /** Enabled when not set in config.builtinTools. */
  defaultEnabled: boolean;
  /** Can touch files / run commands: anyone chatting with the bot could try to make the model use it. */
  danger?: boolean;
}

export const BUILTIN_TOOLS: BuiltinToolMeta[] = [
  { id: 'builtin:time', label: '当前时间', defaultEnabled: true },
  { id: 'builtin:history', label: '读取聊天记录', defaultEnabled: true },
  { id: 'builtin:skip', label: '不回复', defaultEnabled: true },
  { id: 'builtin:fetch', label: '请求网页 / HTTP 接口', defaultEnabled: false },
  { id: 'builtin:read', label: '读取文件', defaultEnabled: false, danger: true },
  { id: 'builtin:ls', label: '列出目录', defaultEnabled: false, danger: true },
  { id: 'builtin:glob', label: '按通配符查找文件', defaultEnabled: false, danger: true },
  { id: 'builtin:grep', label: '搜索文件内容', defaultEnabled: false, danger: true },
  { id: 'builtin:write', label: '写入文件', defaultEnabled: false, danger: true },
  { id: 'builtin:edit', label: '编辑文件（替换字符串）', defaultEnabled: false, danger: true },
  { id: 'builtin:bash', label: '执行 Shell 命令', defaultEnabled: false, danger: true },
];

export const builtinEnabled = (map: Record<string, boolean> | undefined, id: string): boolean =>
  map?.[id] ?? BUILTIN_TOOLS.find((b) => b.id === id)?.defaultEnabled ?? false;

/** Default source of a new TypeScript tool. */
export const SCRIPT_TOOL_TEMPLATE = `// 默认导出一个函数：args = 模型传入的参数（对应下方参数 JSON Schema），ctx = 会话上下文。
// 返回字符串或可 JSON 序列化的对象。可 import Node 内置模块和「npm 依赖」中声明的包。
// 只做类型擦除：可以写类型标注 / interface，不支持 enum、namespace。
import { setTimeout as sleep } from 'node:timers/promises';

interface Args { text: string }
interface Ctx { chat: string; isGroup: boolean; history: Array<{ side: 'self' | 'other'; sender?: string; text: string }>; toolDir: string }

export default async function (args: Args, ctx: Ctx) {
  await sleep(10);
  return \`[\${ctx.chat}] \${args.text.toUpperCase()}\`;
}
`;
