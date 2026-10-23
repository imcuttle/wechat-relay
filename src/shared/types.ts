// Types shared by main and renderer.

export type ChatType = 'any' | 'private' | 'group';
export type ReplyMode = 'auto' | 'review';

export interface GeneralConfig {
  /** Master switch for sending replies (monitoring still runs when false). */
  autoReply: boolean;
  /** auto = send immediately, review = queue drafts for approval in the UI. */
  mode: ReplyMode;
  pollIntervalMs: number;
  /** Your WeChat nickname, used to detect @mentions in groups. */
  myNickname: string;
  /** Random delay before sending, [min, max] ms; new messages arriving during the delay are batched. */
  replyDelayMs: [number, number];
  /** Click into chats that show an unread badge and match a reply rule. */
  openUnreadChats: boolean;
  /** Return to the chat that was open before the bot switched away. */
  restoreChat: boolean;
  restoreClipboard: boolean;
  maxRepliesPerMinute: number;
  /** How many history messages are given to the agent (upper bound). */
  historyLimit: number;
  /**
   * Give the agent the messages of the last N minutes. When a chat is seen without known history, the bot scrolls the
   * chat up (in the background) before replying to read them. 0 = only what was seen on screen.
   */
  historyMinutes: number;
  /** Image messages are cropped from the screenshot and saved as JPEG with this longest side (px). */
  imageMaxSize: number;
}

export interface DriverConfig {
  /** Path to cua-driver-mcp (or `cua-driver`), "auto" to detect the one bundled with CodeBuddy. */
  command: string;
  args: string[];
  deliveryMode: 'background' | 'foreground';
}

export interface ProviderConfig {
  id: string;
  name?: string;
  /** openai = any OpenAI-compatible endpoint (OpenAI, DeepSeek, Kimi, Qwen, GLM, Ollama, OpenRouter...). */
  type: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export interface HarnessConfig {
  id: string;
  name?: string;
  /** codebuddy / claude-code: headless `-p` mode; command: any CLI that reads the prompt on stdin and prints the reply. */
  type: 'codebuddy' | 'claude-code' | 'command';
  command: string;
  args: string[];
  model?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Keep one harness session per chat (codebuddy / claude-code). */
  sessionPerChat: boolean;
  /** Pass the configured MCP servers of the agent to the harness via --mcp-config. */
  passMcpServers: boolean;
  /** Give the harness the agent's built-in / custom tools (and memory / skill tools) through a local proxy MCP server. */
  toolProxy: boolean;
  /** Turn off the CLI's own auto-memory (CODEBUDDY_DISABLE_AUTO_MEMORY / CLAUDE_CODE_DISABLE_AUTO_MEMORY): ours replaces it. */
  disableNativeMemory: boolean;
  /** codebuddy only: keep a prewarmed `codebuddy --prewarm` process on standby; cwd and arguments are bound at activation. */
  prewarm: boolean;
}

/**
 * Voice messages: the reply is synthesised with a TTS service, played into a virtual audio device (e.g. BlackHole) and
 * recorded by WeChat's own voice button. The system default input is switched to the virtual device only for that
 * moment and always restored; if the real microphone is in use by another app, the reply is sent as text instead.
 */
export interface VoiceConfig {
  enabled: boolean;
  /**
   * openai = any OpenAI-compatible /audio/speech (OpenAI, SiliconFlow CosyVoice, local servers...);
   * elevenlabs; fish = Fish Audio; gpt-sovits = local api_v2 (zero-shot clone from refAudio); command = shell command.
   */
  provider: 'openai' | 'elevenlabs' | 'fish' | 'gpt-sovits' | 'command';
  baseUrl: string;
  apiKey: string;
  model?: string;
  /** Voice name (openai), voice_id (elevenlabs), reference_id of a cloned voice (fish) or a custom voice uri. */
  voice?: string;
  /** Your own voice sample (10-20 s of clean speech) and its transcript; used by gpt-sovits (and sent to fish when no reference id). */
  refAudio?: string;
  refText?: string;
  /** provider=command: `{{text}}` and `{{out}}` placeholders, must write an audio file to {{out}}. */
  command?: string;
  speed?: number;
  /** Replies longer than this (characters) are sent as text. */
  maxChars: number;
  /** Replies longer than this many seconds of audio are sent as text (WeChat voice limit is 60 s). */
  maxSeconds: number;
  /** Substring of the virtual device name that WeChat records from. */
  virtualDevice: string;
  /** Distance from the 发送 button to the voice-message button, in points (WeChat 4.1.9+). */
  buttonOffset: number;
  timeoutMs: number;
}

export interface MemoryConfig {
  /** Master switch of memory: the memory section of the system prompt + file tools for the memory dir. */
  enabled: boolean;
  /** How many global memories the system prompt lists (session memories are never listed, only searchable). */
  indexLimit: number;
  /** Consolidate ("dream") a chat's memory after this many new messages; 0 = only manually. */
  dreamEveryMessages: number;
  /** Agent that writes the consolidation (default: first agent). */
  dreamAgent?: string;
}

export interface SkillConfig {
  id: string;
  name?: string;
  description: string;
  /** global = every chat; session = only `chat`. */
  scope: 'global' | 'session';
  chat?: string;
  enabled: boolean;
  /** Body of SKILL.md, written to disk when the file does not exist yet; afterwards the file on disk is authoritative. */
  content?: string;
}

/** A memory file (global, or one chat's) as listed on the 记忆 page. */
export interface MemorySummary { scope: 'global' | 'session'; chat?: string; entries: number; updatedAt: number; file: string }

/** A skill found on disk; `enabled` comes from the config (default on). */
export interface SkillInfo { id: string; scope: 'global' | 'session'; chat?: string; description: string; enabled: boolean; file: string }

export interface ToolConfig {
  id: string;
  /** command = shell command; script = TypeScript module (`export default async (args, ctx) => result`). */
  type: 'command' | 'script';
  enabled: boolean;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** type=command. Shell command; {{arg}} placeholders are replaced with shell-quoted values. Args are also in $TOOL_ARGS (JSON). */
  command?: string;
  /** type=script. TypeScript source (types are stripped, so no enums / namespaces). */
  code?: string;
  /** type=script. npm dependencies (package.json format, pin versions), installed when the tool is saved. */
  dependencies?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}

export interface McpServerConfig {
  id: string;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** streamable HTTP / SSE */
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

/** A reply example attached to a prompt: how to answer (good) or how not to (bad) in a given context. */
export interface PromptCase {
  /** The conversation before the reply, one "speaker: text" per line. */
  context?: string;
  reply: string;
  /** Why it is good / bad. */
  note?: string;
  /** Where it was marked (会话记录): chat name and message ids. */
  chat?: string;
  ids?: string[];
  at?: number;
}

export interface PromptConfig {
  id: string;
  name?: string;
  content: string;
  /** Appended to the content as reply examples to follow / avoid. */
  goodCases?: PromptCase[];
  badCases?: PromptCase[];
}

export interface AgentConfig {
  id: string;
  name?: string;
  engine: 'model' | 'harness';
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  harness?: string;
  /** Prompt id from `prompts`; `systemPrompt` is appended after it. */
  prompt?: string;
  systemPrompt?: string;
  /** builtin:<name>, <tool id>, mcp:<server id>. Only used when the tool / server is also enabled globally. */
  tools: string[];
  maxToolRounds: number;
  /** The model accepts images: chat images are sent as image parts instead of their OCR text. */
  vision?: boolean;
  /** At most this many (most recent) images per request; older ones fall back to text. */
  maxImages?: number;
  /** OpenAI-style image detail (low = cheapest). */
  imageDetail?: 'low' | 'high' | 'auto';
}

export interface RuleMatch {
  /** Chat names: exact, `*` wildcard or /regex/. Empty = all chats. */
  chats?: string[];
  excludeChats?: string[];
  chatType?: ChatType;
  /** Group chats: only when you are @mentioned (or @所有人 when includeAtAll). */
  mentionOnly?: boolean;
  includeAtAll?: boolean;
  /** Any of these substrings / /regex/ in the new messages. */
  keywords?: string[];
  /** Group sender names (exact / wildcard / regex). */
  senders?: string[];
}

export interface RuleConfig {
  id: string;
  name?: string;
  enabled: boolean;
  match: RuleMatch;
  action: 'reply' | 'ignore';
  agent?: string;
  /** Overrides general.mode for this rule. */
  mode?: ReplyMode | 'inherit';
  cooldownSec: number;
  /** Send replies of this rule as voice messages (needs voice.enabled). never = text only. */
  voice?: 'inherit' | 'never' | 'always';
}

export interface AppConfig {
  general: GeneralConfig;
  driver: DriverConfig;
  providers: ProviderConfig[];
  harnesses: HarnessConfig[];
  /** builtin:<name> → enabled (see shared/builtins.ts for defaults). */
  builtinTools: Record<string, boolean>;
  tools: ToolConfig[];
  mcpServers: McpServerConfig[];
  memory: MemoryConfig;
  voice: VoiceConfig;
  /** Skills switch, independent of memory: skill index in the prompt + file tools for the skills dir. */
  skillsEnabled: boolean;
  skills: SkillConfig[];
  prompts: PromptConfig[];
  agents: AgentConfig[];
  rules: RuleConfig[];
}

// ---- Vision output (native/wx-vision) ----

export interface VisionSession {
  name: string; preview: string; time: string;
  x: number; y: number; top: number; bottom: number;
  unread: boolean; selected: boolean; mentioned: boolean;
}
export interface VisionMessage {
  side: 'self' | 'other' | 'system';
  sender?: string | null;
  text: string;
  kind: 'text' | 'image' | 'media' | 'time' | 'system';
  top: number; bottom: number; partial: boolean;
  /** Bubble / image bounds in screenshot pixels. */
  box?: { x: number; y: number; w: number; h: number } | null;
}
export interface VisionLayout {
  sidebarRight: number; listLeft: number; listRight: number; chatLeft: number; chatRight: number;
  headerBottom: number; inputTop: number; input: { x: number; y: number }; send?: { x: number; y: number } | null;
  dark: boolean; chatBg: number[];
}
export interface VisionResult {
  ok: boolean; error?: string | null;
  width: number; height: number; scale: number;
  layout?: VisionLayout; title?: string | null; isGroup: boolean;
  sessions: VisionSession[]; messages: VisionMessage[];
  lines: Array<{ text: string; x: number; y: number; w: number; h: number; conf: number }>;
  ms: number;
}

// ---- Runtime ----

export interface ChatMessage {
  id: string;
  side: 'self' | 'other';
  sender?: string;
  /** For images: "[图片]" plus any OCR'd text inside the image (the fallback for text-only models). */
  text: string;
  /** Best-effort send time (from WeChat's time separators), else when it was first seen. */
  at: number;
  /** ocr = seen on screen; bot = sent by this app */
  source: 'ocr' | 'bot';
  kind?: 'text' | 'image';
  /** Compressed JPEG crop of an image message. */
  image?: string;
  /** The crop was validated (not blank / not a mis-detected text bubble). */
  checked?: boolean;
}

/**
 * Tone / style profile of one chat, injected into the agent's system prompt for that chat. The text lives in a regular
 * prompt (`prompts[]` of the config, id = `prompt`); the chat only keeps the link and the on/off switch.
 */
export interface Persona {
  /** Id of the prompt in use: the chat's own persona prompt or any other prompt switched to in 会话记录. */
  prompt: string;
  /** Id of the chat's own persona prompt (generated / edited in the persona dialog, holds the reply examples). */
  own: string;
  /** Text of the own prompt. */
  text: string;
  enabled: boolean;
  updatedAt: number;
  /** How it was made, e.g. "最近 7 天 · 312 条 · 从微信读取"; empty when hand-written. */
  source?: string;
  goodCases: PromptCase[];
  badCases: PromptCase[];
}

export interface PersonaOptions {
  /** Agent used to write the profile (default: first agent). */
  agent?: string;
  /** Only messages of the last N minutes; 0 = no time limit. */
  minutes: number;
  /** At most this many (most recent) messages. */
  limit: number;
  /** Scroll up in WeChat to read that range (otherwise only the stored records are used). */
  fetch: boolean;
}

export interface ChatSummary {
  name: string;
  isGroup: boolean;
  lastAt: number;
  lastText: string;
  count: number;
  paused: boolean;
  /** Per-chat send mode; 'inherit' = rule / global setting. */
  mode: ReplyMode | 'inherit';
  /** prompt: id of the prompt in use. */
  persona?: { enabled: boolean; prompt: string };
}

export interface Draft {
  id: string;
  chat: string;
  text: string;
  agent: string;
  rule: string;
  createdAt: number;
  status: 'pending' | 'sent' | 'rejected' | 'failed';
  error?: string;
  trigger: string;
  /** Send as a voice message (falls back to text when it cannot be done safely). */
  voice?: boolean;
}

export interface LogEntry {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

export interface MonitorStatus {
  running: boolean;
  driver: 'stopped' | 'starting' | 'ready' | 'error';
  driverError?: string;
  wechat?: { pid: number; windowId: number; width: number; height: number } | null;
  permissions?: { accessibility: boolean; screenRecording: boolean } | null;
  currentChat?: string | null;
  lastTickAt?: number;
  lastTickMs?: number;
  ticks: number;
  replies: number;
  busy: boolean;
  configPath: string;
}

export interface Snapshot {
  at: number;
  image: string; // data URL
  vision: VisionResult;
}

export interface TestAgentRequest {
  agent: string;
  chat: string;
  isGroup: boolean;
  /** image: data URL of a picture message; text is then the text inside it (empty = OCR it). */
  messages: Array<{ side: 'self' | 'other'; sender?: string; text: string; image?: string }>;
}

/** One block of the full request / response log of an agent run (debug panel). images: local file paths. */
export interface DebugSection { title: string; text: string; images?: string[] }

export interface TestAgentResult {
  ok: boolean;
  reply?: string | null;
  skipped?: boolean;
  error?: string;
  trace: string[];
  detail?: DebugSection[];
  ms: number;
}

export type RelayEvent =
  | { type: 'status'; status: MonitorStatus }
  | { type: 'log'; entry: LogEntry }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'chat'; chat: string; message?: ChatMessage }
  | { type: 'draft'; draft: Draft }
  | { type: 'config'; config: AppConfig };

export interface RelayApi {
  getStatus(): Promise<MonitorStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  tickOnce(): Promise<void>;
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  getConfigYaml(): Promise<string>;
  saveConfigYaml(yaml: string): Promise<void>;
  openConfigFile(): Promise<void>;
  getLogs(): Promise<LogEntry[]>;
  getChats(): Promise<ChatSummary[]>;
  getHistory(chat: string): Promise<ChatMessage[]>;
  setChatPaused(chat: string, paused: boolean): Promise<void>;
  clearHistory(chat: string): Promise<void>;
  /** Deletes chats with their records and per-chat settings; returns how many were deleted. */
  deleteChats(chats: string[]): Promise<number>;
  getDrafts(): Promise<Draft[]>;
  approveDraft(id: string, text?: string): Promise<void>;
  rejectDraft(id: string): Promise<void>;
  sendManual(chat: string, text: string): Promise<void>;
  /** Adds a chat to the records and, when it is in WeChat's session list, reads its visible messages. */
  syncHistory(chat: string): Promise<{ count: number; scrolls: number; reachedTop: boolean }>;
  addChat(chat: string): Promise<{ synced: boolean; message: string }>;
  /** Runs an agent on the stored history of `chat` and returns its reply without sending (agent: id, or by rule). */
  generateReply(chat: string, agent?: string): Promise<{ text: string | null; agent: string; reason?: string; ms: number }>;
  /** Per-chat send mode; overrides the rule and global mode. */
  setChatMode(chat: string, mode: ReplyMode | 'inherit'): Promise<void>;
  getPersona(chat: string): Promise<Persona | null>;
  /** text empty = remove the persona. */
  setPersona(chat: string, persona: { text: string; enabled: boolean }): Promise<void>;
  /** Switches the chat to another prompt as its persona (null = no persona, use the agent's prompt). */
  selectPersona(chat: string, prompt: string | null): Promise<Persona | null>;
  /** Agent replying in the chat (by reply rule) and the prompt it uses when the chat has no persona. */
  agentPrompt(chat: string): Promise<{ agent: string; prompt?: string } | null>;
  /** Replaces the reply examples of the chat's persona prompt (created, switched off, when the chat has none). */
  setPersonaCases(chat: string, cases: { goodCases: PromptCase[]; badCases: PromptCase[] }): Promise<Persona>;
  /** Reads the chat history (optionally from WeChat), has an agent summarise the tone / style, saves and returns it. */
  generatePersona(chat: string, opts: PersonaOptions): Promise<{ persona: Persona; count: number; note?: string }>;
  testAgent(req: TestAgentRequest): Promise<TestAgentResult>;
  listMcpTools(serverId: string): Promise<Array<{ name: string; description?: string }>>;
  /** Writes a script tool's files and installs its dependencies; rejects with the npm output on failure. */
  prepareTool(tool: ToolConfig): Promise<void>;
  /** Memory files: the global one plus one per chat that has any. */
  listMemory(): Promise<MemorySummary[]>;
  readMemory(scope: 'global' | 'session', chat?: string): Promise<string>;
  writeMemory(scope: 'global' | 'session', chat: string | undefined, text: string): Promise<void>;
  listSkills(): Promise<SkillInfo[]>;
  readSkill(scope: 'global' | 'session', chat: string | undefined, id: string): Promise<string>;
  writeSkill(scope: 'global' | 'session', chat: string | undefined, id: string, text: string): Promise<void>;
  deleteSkill(scope: 'global' | 'session', chat: string | undefined, id: string): Promise<void>;
  /** Consolidates the memory of `chat` (and the global one) with the dream agent; chat omitted = global memory only. */
  dreamMemory(chat?: string): Promise<{ message: string }>;
  onEvent(cb: (e: RelayEvent) => void): () => void;
}
