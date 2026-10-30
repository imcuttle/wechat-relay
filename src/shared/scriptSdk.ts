// The script SDK: type declarations of what a script gets (`ev`, `api`), shared by
//  - the main process (written to <script dir>/relay.d.ts for VS Code, tsconfig `paths` points at it),
//  - the editor in the app (registered with Monaco so completion / hover / errors work).
// The implementation of `api` is main/scripting/runner.ts (child side) + main/scripting/host.ts (RPC handlers).
// Scripts only `import type` from it, so nothing of the SDK exists at run time.

export const SDK_MODULE = '@wechat-relay/sdk';

export const SDK_DTS = `declare module '${SDK_MODULE}' {
  /** Chat apps that are watched. */
  export type AppId = 'wechat' | 'wecom';

  export interface Message {
    id: string;
    /** self = sent by me, other = sent by someone else. */
    side: 'self' | 'other';
    /** Group chats: who sent it. */
    sender?: string;
    /** Text; pictures are "[图片] <text read from the picture>". */
    text: string;
    /** Send time (ms since epoch), best effort. */
    at: number;
    kind?: 'text' | 'image' | 'notice';
    /** Local JPEG of a picture message. */
    image?: string;
  }

  /** Event: new message(s) arrived in a chat that a rule with action "script" matched. */
  export interface MessageEvent {
    type: 'message';
    app: AppId;
    chat: { app: AppId; name: string; isGroup: boolean };
    /** The rule that handed the messages to this script. */
    rule: { id: string; name?: string };
    /** The new messages (other side only), oldest first. */
    messages: Message[];
    /** Text of all new messages joined by newlines. */
    text: string;
    /** Sender of the last new message (group chats). */
    sender?: string;
    /** Local files of new picture messages. */
    images: string[];
    /** I was @mentioned (or patted) in the new messages. */
    mentionedMe: boolean;
    /**
     * Apps that only show the latest message of a chat (wecom) can miss some when several arrive within one poll:
     * the number of messages that were seen as unread but are not in "messages".
     */
    missed: number;
    at: number;
    /** Test run: do not change anything outside (api.send is skipped by the host). */
    dryRun: boolean;
  }

  export interface Question {
    question: string;
    /** Short chip label (max 12 chars). */
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }

  export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

  export interface ChatApi {
    readonly app: AppId;
    readonly name: string;
    readonly isGroup: boolean;
    /** The last n recorded messages of this chat (default 30), oldest first. */
    history(n?: number): Promise<Message[]>;
    /** Sends a text message to this chat (same safety checks as any send: verifies the chat, honours foreground settings). */
    send(text: string): Promise<void>;
  }

  export interface Api {
    readonly app: AppId;
    readonly dryRun: boolean;
    readonly script: { id: string; dir: string };
    /** The chat of the event. */
    readonly chat: ChatApi;

    /** Sends a text message to another chat (by name) of this or another app. */
    send(chat: string, text: string, opts?: { app?: AppId }): Promise<void>;

    ai: {
      /** One-shot completion with a configured agent (default: the first). */
      complete(prompt: string, opts?: { system?: string; agent?: string }): Promise<string>;
      /** Lets a configured agent write the reply to this chat from its history. Does not send. null = the agent chose not to reply. */
      reply(opts?: { agent?: string }): Promise<string | null>;
    };
    /** Asks me in a popup in front of everything (AskUserQuestion). null = not answered. */
    ask(questions: Question[]): Promise<Record<string, string> | null>;
    /** Text in an image file (Apple Vision OCR). */
    ocr(imagePath: string): Promise<string>;
    /** macOS notification; clicking it opens "url". */
    notify(n: { title: string; body?: string; url?: string }): Promise<void>;
    clipboard: { read(): Promise<string>; write(text: string): Promise<void> };
    /** Runs a program without a shell. */
    exec(cmd: string, args?: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string> }): Promise<ExecResult>;
    /** Persistent key-value storage of this script (survives runs; use it for de-duplication). */
    state: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<void>;
    };
    /** Runs fn exclusively across all runs of this script (and any script using the same key). */
    lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
    sleep(ms: number): Promise<void>;
    log: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  }

  export interface Script {
    /** New message(s) in a chat matched by a rule. A returned string is shown in the run log. */
    onMessage?(ev: MessageEvent, api: Api): void | string | Promise<void | string>;
  }
}
`;

/** tsconfig.json of a script folder: strict TypeScript for VS Code, SDK types from ./relay.d.ts, Node types from @types/node. */
export const SCRIPT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true,
    allowImportingTsExtensions: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, types: ['node'],
    paths: { [SDK_MODULE]: ['./relay.d.ts'] },
  },
  include: ['*.ts', 'relay.d.ts'],
}, null, 2) + '\n';

export const SCRIPT_TEMPLATE = `// 脚本：规则（动作 = 脚本）命中后由 WeChat Relay 在独立的 Node 进程里运行。
// - 类型提示来自 relay.d.ts（只做 import type，运行时不依赖它）；只支持可擦除的 TypeScript（无 enum / namespace）。
// - 可以直接 import Node 内置模块（node:fs、node:child_process …）和「依赖」里声明的 npm 包。
// - ev = 触发事件，api = 发消息 / 调 AI / OCR / 通知 / 持久化状态 等能力。
import type { Script } from '${SDK_MODULE}';

export default {
  async onMessage(ev, api) {
    api.log.info(\`[\${ev.app}] \${ev.chat.name}: \${ev.text}\`);
    // await api.chat.send('收到');                                  // 回复当前会话
    // await api.notify({ title: ev.chat.name, body: ev.text });     // 系统通知
    // const answer = await api.ai.reply();                           // 让智能体按聊天记录写一句回复
  },
} satisfies Script;
`;
