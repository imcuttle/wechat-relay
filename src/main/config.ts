import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { AppConfig } from '@shared/types';
import { BUILTIN_TOOLS } from '@shared/builtins';

export const DATA_DIR = process.env.WECHAT_RELAY_HOME || join(homedir(), '.wechat-relay');
export const CONFIG_PATH = join(DATA_DIR, 'config.yaml');
/** Script tools: one npm package per tool (package.json + index.ts + node_modules). */
export const TOOLS_DIR = join(DATA_DIR, 'tools');
/** Default cwd / base of relative paths for the file and shell built-in tools. */
export const WORKSPACE_DIR = join(DATA_DIR, 'workspace');
/** Screenshots are rewritten every poll; keep them out of the data dir. */
export const CACHE_DIR = process.env.WECHAT_RELAY_HOME ? join(DATA_DIR, 'cache') : join(homedir(), 'Library', 'Caches', 'wechat-relay');
/** Compressed crops of image messages, referenced by stored chat history. */
export const MEDIA_DIR = join(DATA_DIR, 'media');
/** Memories: global.md plus sessions/<slug>.md per chat. Plain Markdown, edited with the generic file tools. */
export const MEMORY_DIR = join(DATA_DIR, 'memory');
/** Skills: global/<id>/SKILL.md and sessions/<slug>/<id>/SKILL.md. */
export const SKILLS_DIR = join(DATA_DIR, 'skills');

const DEFAULT_YAML = `# WeChat Relay 配置（保存后自动热加载，也可在应用界面中编辑）
# 字符串中的 \${ENV_NAME} 会在使用时替换为环境变量。

general:
  autoReply: false          # 总开关：关闭时只监听不发送
  mode: review              # auto = 直接发送；review = 生成草稿，在界面里确认后发送
  pollIntervalMs: 1500
  myNickname: ""            # 你在群里的昵称，用于识别 @我
  replyDelayMs: [1500, 4000]
  openUnreadChats: true     # 自动点开有未读红点且命中回复规则的会话
  restoreChat: false
  restoreClipboard: true    # 前台发送用剪贴板粘贴，发送后恢复原剪贴板内容
  maxRepliesPerMinute: 6
  historyLimit: 30          # 给智能体的上下文最多条数（超出时一次丢弃较早的一半，之后只追加，保持提示词缓存命中）
  historyMinutes: 10        # 上下文最早消息的时间上限（同样批量丢弃）；会话首次出现时会在后台向上滚动读取（0 = 不限时间，也不滚动读取）
  imageMaxSize: 768         # 聊天图片裁剪后压缩到的最长边（像素）

driver:
  command: auto             # auto = 使用 CodeBuddy 内置的 cua-driver
  args: []
  deliveryMode: background  # foreground = 先后台发送，失败或需要搜索时才等你空闲 3 秒，把微信短暂切到前台用快捷键发送，再切回原应用

providers:
  - id: deepseek
    type: openai
    baseUrl: https://api.deepseek.com/v1
    apiKey: \${DEEPSEEK_API_KEY}
  - id: openai
    type: openai
    baseUrl: https://api.openai.com/v1
    apiKey: \${OPENAI_API_KEY}
  - id: anthropic
    type: anthropic
    baseUrl: https://api.anthropic.com
    apiKey: \${ANTHROPIC_API_KEY}
  - id: ollama
    type: openai
    baseUrl: http://127.0.0.1:11434/v1
    apiKey: ollama

harnesses:
  - id: codebuddy
    type: codebuddy
    command: codebuddy
    args: []
    timeoutMs: 180000
    sessionPerChat: true
    passMcpServers: true
    toolProxy: true
    disableNativeMemory: true
    prewarm: true
  - id: claude-code
    type: claude-code
    command: claude
    args: []
    timeoutMs: 180000
    sessionPerChat: true
    passMcpServers: true
    toolProxy: true
    disableNativeMemory: true

tools:
  - id: weather
    description: 查询城市天气
    parameters:
      type: object
      properties:
        city: { type: string, description: 城市名（拼音或英文） }
      required: [city]
    command: curl -s "wttr.in/{{city}}?format=3&lang=zh"
    timeoutMs: 15000

mcpServers:
  - id: fetch
    enabled: false
    command: uvx
    args: [mcp-server-fetch]

memory:
  enabled: false            # 记忆总开关：开启后系统提示词带「全局记忆索引」和读写说明，智能体可用文件工具读写 ~/.wechat-relay/memory
  indexLimit: 12            # 提示词里最多列几条全局记忆（会话记忆不列出，但可用 grep / read 查到）
  dreamEveryMessages: 100   # 每个会话新增这么多条消息后自动「做梦」整理记忆；0 = 只手动
  # dreamAgent: assistant   # 做梦使用的智能体，默认第一个

voice:
  enabled: false            # 语音消息总开关；还需在规则里设 voice: always 才会用语音回复
  provider: gpt-sovits      # openai | elevenlabs | fish | gpt-sovits | command
  baseUrl: http://127.0.0.1:9880
  apiKey: ""
  # voice: ""               # 音色：openai 的 voice / elevenlabs 的 voice_id / fish 的 reference_id（克隆音色）
  # refAudio: ~/voice/me.wav  # 你自己的 10-20 秒干净人声样音（gpt-sovits 零样本克隆）
  # refText: ""             # 样音里说的话（逐字）
  maxChars: 120             # 超过则改发文字
  maxSeconds: 45
  virtualDevice: BlackHole  # 微信录音所用虚拟声卡名称（包含即可）
  buttonOffset: 47          # 语音按钮到「发送」按钮的距离（点）
  timeoutMs: 60000

skillsEnabled: false        # Skill 总开关（与记忆互相独立）：开启后提示词带 skill 索引和路径说明
skills: []                  # 在「Skill」页管理；文件在 ~/.wechat-relay/skills，这里只保存各 skill 的启用开关和初始内容

prompts:
  - id: default
    name: 默认人设
    content: |
      你正在以「{{myNickname}}」的身份在微信里和「{{chat}}」聊天{{#group}}（这是一个群聊，最新消息来自 {{sender}}）{{/group}}。
      今天是 {{now}}，当前时间见最新消息开头。
      要求：
      - 像真人一样简短、口语化地回复，一般不超过两句话，不要使用 Markdown。
      - 不确定或涉及金钱、承诺、隐私的事情，礼貌地表示稍后本人回复。
      - 如果对方的消息不需要回复（如表情、"好的"、群里与你无关的闲聊），调用 skip_reply 工具或只输出 [SKIP]。

agents:
  - id: assistant
    name: 默认助理
    engine: model
    provider: deepseek
    model: deepseek-chat
    temperature: 0.7
    prompt: default
    systemPrompt: ""
    tools: [builtin:time, builtin:history, builtin:skip, weather]
    maxToolRounds: 4
    vision: false           # 模型支持图片（如 deepseek-flash、gpt-4o）时打开：聊天图片直接作为图片发给模型，否则用 OCR 文字兜底
    maxImages: 4
    imageDetail: low
  - id: codebuddy-agent
    name: CodeBuddy 代理
    engine: harness
    harness: codebuddy
    prompt: default
    tools: []
    maxToolRounds: 4

rules:
  - id: ignore-official
    name: 忽略公众号/服务号
    enabled: true
    match: { chats: [公众号, 服务号, 订阅号*, 微信团队, 文件传输助手] }
    action: ignore
    cooldownSec: 0
  - id: group-mention
    name: 群聊被 @ 时回复
    enabled: true
    match: { chatType: group, mentionOnly: true }
    action: reply
    agent: assistant
    mode: inherit
    cooldownSec: 20
  - id: private
    name: 私聊回复
    enabled: true
    match: { chatType: private }
    action: reply
    agent: assistant
    mode: inherit
    cooldownSec: 5
`;

const DEFAULTS: AppConfig = YAML.parse(DEFAULT_YAML);

function normalize(raw: Partial<AppConfig> | null | undefined): AppConfig {
  const c = (raw ?? {}) as Partial<AppConfig>;
  const arr = <T>(v: T[] | undefined): Partial<T>[] => (Array.isArray(v) ? v : []);
  const withDefaults = <T>(items: Partial<T>[], d: Partial<T>): T[] => items.map((x) => ({ ...d, ...x }) as T);
  return {
    general: { ...DEFAULTS.general, ...(c.general ?? {}) },
    driver: { ...DEFAULTS.driver, ...(c.driver ?? {}) },
    providers: withDefaults(arr(c.providers), { type: 'openai', apiKey: '' }),
    harnesses: withDefaults(arr(c.harnesses), { args: [], timeoutMs: 180000, sessionPerChat: true, passMcpServers: true, toolProxy: true, disableNativeMemory: true, prewarm: true }),
    builtinTools: {
      ...Object.fromEntries(BUILTIN_TOOLS.map((b) => [b.id, b.defaultEnabled])),
      ...(c.builtinTools && typeof c.builtinTools === 'object' ? c.builtinTools : {}),
    },
    tools: withDefaults(arr(c.tools), { type: 'command', enabled: true, parameters: { type: 'object', properties: {} }, timeoutMs: 15000 }),
    mcpServers: withDefaults(arr(c.mcpServers), { enabled: true }),
    memory: { ...DEFAULTS.memory, ...(c.memory ?? {}) },
    voice: { ...DEFAULTS.voice, ...(c.voice ?? {}) },
    skillsEnabled: c.skillsEnabled === true,
    skills: withDefaults(arr(c.skills), { scope: 'global', enabled: true, description: '' }),
    prompts: withDefaults(arr(c.prompts), { content: '' }),
    agents: withDefaults(arr(c.agents), { engine: 'model', tools: [], maxToolRounds: 4, vision: false, maxImages: 4, imageDetail: 'low' }),
    rules: withDefaults(arr(c.rules), { enabled: true, action: 'reply', cooldownSec: 0, mode: 'inherit' }).map((r) => ({ ...r, match: r.match ?? {} })),
  };
}

/** Replace ${ENV} references. */
export function expandEnv(value: string | undefined): string {
  return (value ?? '').replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k: string) => process.env[k] ?? '');
}

/** Directories the agent may touch through the scoped file tools, by what is switched on. */
export const knowledgeDirs = (c: AppConfig): string[] => [...(c.memory.enabled ? [MEMORY_DIR] : []), ...(c.skillsEnabled ? [SKILLS_DIR] : [])];

class ConfigStore extends EventEmitter {
  config: AppConfig = DEFAULTS;
  private selfWrite = 0;

  load(): AppConfig {
    mkdirSync(DATA_DIR, { recursive: true });
    if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, DEFAULT_YAML);
    this.config = normalize(YAML.parse(readFileSync(CONFIG_PATH, 'utf8')));
    return this.config;
  }

  yaml(): string {
    return readFileSync(CONFIG_PATH, 'utf8');
  }

  /** Validates and writes raw YAML (keeps comments). */
  saveYaml(text: string): void {
    const parsed = normalize(YAML.parse(text));
    this.selfWrite = Date.now();
    writeFileSync(CONFIG_PATH, text);
    this.config = parsed;
    this.emit('change', parsed);
  }

  /** Writes a structured config, preserving comments of the existing document where keys still exist. */
  save(config: AppConfig): void {
    const doc = YAML.parseDocument(existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : '');
    for (const key of Object.keys(config) as Array<keyof AppConfig>) doc.set(key, doc.createNode(config[key]));
    this.saveYaml(doc.toString({ lineWidth: 0 }));
  }

  /**
   * Polls the file's mtime instead of fs.watch: Finder-launched apps have a 256 file-descriptor soft limit and
   * fs.watch (FSEvents) can fail with EMFILE at startup. Polling uses no descriptor and survives atomic saves.
   */
  watch(onError: (e: Error) => void): void {
    watchFile(CONFIG_PATH, { interval: 1000 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs || Date.now() - this.selfWrite < 1500) return;
      try { this.load(); this.emit('change', this.config); } catch (e) { onError(e as Error); }
    });
  }
}

export const configStore = new ConfigStore();
