import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { AppConfig } from '@shared/types';

export const DATA_DIR = process.env.WECHAT_RELAY_HOME || join(homedir(), '.wechat-relay');
export const CONFIG_PATH = join(DATA_DIR, 'config.yaml');
/** Screenshots are rewritten every poll; keep them out of the data dir. */
export const CACHE_DIR = process.env.WECHAT_RELAY_HOME ? join(DATA_DIR, 'cache') : join(homedir(), 'Library', 'Caches', 'wechat-relay');

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
  restoreClipboard: true
  maxRepliesPerMinute: 6
  historyLimit: 30

driver:
  command: auto             # auto = 使用 CodeBuddy 内置的 cua-driver
  args: []
  deliveryMode: background

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
  - id: claude-code
    type: claude-code
    command: claude
    args: []
    timeoutMs: 180000
    sessionPerChat: true
    passMcpServers: true

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

prompts:
  - id: default
    name: 默认人设
    content: |
      你正在以「{{myNickname}}」的身份在微信里和「{{chat}}」聊天{{#group}}（这是一个群聊，最新消息来自 {{sender}}）{{/group}}。
      当前时间：{{now}}。
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
    harnesses: withDefaults(arr(c.harnesses), { args: [], timeoutMs: 180000, sessionPerChat: true, passMcpServers: true }),
    tools: withDefaults(arr(c.tools), { parameters: { type: 'object', properties: {} }, timeoutMs: 15000 }),
    mcpServers: withDefaults(arr(c.mcpServers), { enabled: true }),
    prompts: withDefaults(arr(c.prompts), { content: '' }),
    agents: withDefaults(arr(c.agents), { engine: 'model', tools: [], maxToolRounds: 4 }),
    rules: withDefaults(arr(c.rules), { enabled: true, action: 'reply', cooldownSec: 0, mode: 'inherit' }).map((r) => ({ ...r, match: r.match ?? {} })),
  };
}

/** Replace ${ENV} references. */
export function expandEnv(value: string | undefined): string {
  return (value ?? '').replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k: string) => process.env[k] ?? '');
}

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
