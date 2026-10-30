// Human-readable documentation of every config.yaml field (used for hover / completion in the YAML editor and the
// field reference panel). Keys of CONFIG_DOCS are the path of the parent: "general", "rules", "rules.match", ...

export interface FieldDoc {
  desc: string;
  type?: string;
  def?: string;
  /** Allowed values → meaning. */
  values?: Record<string, string>;
  example?: string;
}

export interface SectionDoc { title: string; desc: string; list?: boolean; fields: Record<string, FieldDoc> }

export const CONFIG_DOCS: Record<string, SectionDoc> = {
  general: {
    title: '通用', desc: '监听与回复的全局行为。',
    fields: {
      autoReply: { type: 'true / false', def: 'false', desc: '总开关。关闭时只监听、记录消息，不会发送任何回复。' },
      mode: { type: '字符串', def: 'review', desc: '回复的发送方式（可被规则里的 mode 覆盖）。', values: { auto: '生成后直接发送', review: '只生成草稿，在「待审核」里确认后才发送' } },
      pollIntervalMs: { type: '毫秒', def: '1500', desc: '每隔多久截一次微信窗口检查新消息。越小越及时，但越耗资源。' },
      myNickname: { type: '字符串', def: '""', desc: '你在微信里的昵称。用来识别群里是否有人 @你，也会填进提示词的 {{myNickname}}。' },
      replyDelayMs: { type: '[最小, 最大]', def: '[1500, 4000]', desc: '收到消息后随机等待多久再回复（毫秒），像真人一样不秒回。等待期间到达的新消息会合并成一次回复。' },
      openUnreadChats: { type: 'true / false', def: 'true', desc: '自动点开有未读红点、且命中「回复」规则的会话来读取消息。' },
      restoreChat: { type: 'true / false', def: 'false', desc: '处理完其他会话后，回到之前打开的那个会话。' },
      restoreClipboard: { type: 'true / false', def: 'true', desc: '前台发送时用剪贴板粘贴文字，发送后恢复你原来的剪贴板内容。' },
      maxRepliesPerMinute: { type: '数字', def: '6', desc: '每分钟最多发送几条，超出的自动变成草稿，防止刷屏。' },
      historyLimit: { type: '条数', def: '30', desc: '给智能体的上下文最多多少条消息。超出时一次丢掉较早的一半，之后只追加，这样提示词缓存能持续命中。' },
      historyMinutes: { type: '分钟', def: '10', desc: '上下文只保留最近多少分钟的消息；「同步历史」也只读取这段时间内的消息。会话第一次出现时会在后台向上滚动读取。', values: { '0': '不限时间，也不向上滚动读取' } },
      imageMaxSize: { type: '像素', def: '768', desc: '聊天里的图片裁剪后压缩到的最长边。越大越清晰，但占空间、发给模型更费 token。' },
      askUser: { type: 'true / false', def: 'false', desc: '允许智能体用 AskUserQuestion 弹出全局窗口询问你（Esc 不回答、数字键选择、点击或自由输入）。参数与 CodeBuddy 的 AskUserQuestion 一致；codebuddy harness 走 ACP 原生工具，其他走内置工具。可在「会话记录」里按会话单独开关。开启记忆时，提示词会引导把你回答的长期偏好记进记忆。' },
      askTimeoutSec: { type: '秒', def: '10', desc: '弹窗多少秒内没有任何操作就自动关闭：询问视为不回答，草稿留在「待审核」。按键或点击后倒计时停止。' },
      askPrompt: { type: '文本', def: '空（使用内置引导）', desc: '开启询问时加进系统提示词的引导，决定智能体什么时候该问你。默认：回复需要的事实在聊天记录 / 记忆里找不到、也无法确定时才问。可用 {{myNickname}} {{chat}} {{askTimeoutSec}}，{{#memory}}…{{/memory}} 只在开启记忆时出现。' },
      reviewPopup: { type: 'true / false', def: 'false', desc: '待审核的草稿也弹出全局窗口审批：回车发送、E 编辑、Esc 不发送、L 稍后。' },
    },
  },
  driver: {
    title: '驱动（Cua Driver）', desc: '负责在后台操作微信窗口（截图、点击、输入）。',
    fields: {
      command: { type: '路径', def: 'auto', desc: 'cua-driver 可执行文件路径。', values: { auto: '自动使用 CodeBuddy 自带的 cua-driver' } },
      args: { type: '列表', def: '[]', desc: '启动驱动时附加的命令行参数，一般留空。' },
      deliveryMode: { type: '字符串', def: 'background', desc: '消息的发送方式。', values: { background: '纯后台操作，不打扰你（部分微信版本可能不接受后台输入）', foreground: '先尝试后台发送；失败或需要搜索时，等你空闲 3 秒后把微信短暂切到前台用快捷键发送，再切回原应用' } },
    },
  },
  providers: {
    title: '模型服务商', desc: '大模型接口。智能体通过 provider 字段引用这里的 id。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识，智能体的 provider 引用它。' },
      name: { type: '字符串', desc: '界面上显示的名称（可选）。' },
      type: { type: '字符串', desc: '接口协议。', values: { openai: 'OpenAI 兼容接口（OpenAI、DeepSeek、Kimi、通义、智谱、Ollama、OpenRouter 等）', anthropic: 'Anthropic 接口' } },
      baseUrl: { type: 'URL', desc: '接口地址，例如 https://api.deepseek.com/v1。' },
      apiKey: { type: '字符串', desc: 'API Key。建议写成 ${环境变量名}，避免把密钥明文存在配置里。', example: '${DEEPSEEK_API_KEY}' },
      headers: { type: '键值', desc: '额外的 HTTP 请求头（可选）。' },
    },
  },
  harnesses: {
    title: '外部代理（Harness）', desc: '把回复交给命令行智能体（CodeBuddy、Claude Code 等）来完成。智能体的 harness 字段引用这里的 id。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识。' },
      name: { type: '字符串', desc: '界面显示名称（可选）。' },
      type: { type: '字符串', desc: '代理类型。', values: { codebuddy: 'CodeBuddy Code，以 codebuddy --acp 通过 ACP 对接', acp: '任意通过 stdio 说 ACP 的命令，例如 npx -y @agentclientprotocol/claude-agent-acp（Claude Code）', command: '任意命令行程序：从标准输入读提示词，把回复打印到标准输出' } },
      command: { type: '命令', desc: '可执行文件名或路径，例如 codebuddy、npx。' },
      args: { type: '列表', desc: '附加命令行参数。' },
      model: { type: '字符串', desc: '指定模型（可选，不填用代理默认值；acp 类型不使用，请在命令参数里设置）。' },
      cwd: { type: '路径', desc: '运行命令的工作目录（可选）。' },
      env: { type: '键值', desc: '额外的环境变量（可选）。' },
      timeoutMs: { type: '毫秒', def: '180000', desc: '单次回复超过这个时间还没返回就取消（session/cancel）并放弃。' },
      sessionPerChat: { type: 'true / false', desc: '每个微信会话保持一个 ACP 会话，之后只发新消息；进程退出后用 session/load 恢复（仅 codebuddy / acp）。' },
      idleMinutes: { type: '分钟', def: '10', desc: '每个微信会话一个常驻 ACP 进程，这么久没有新消息就结束它（仅 codebuddy / acp）。', values: { '0': '每次回复后就结束' } },
      passMcpServers: { type: 'true / false', desc: '把智能体启用的 MCP 服务通过 ACP session/new 的 mcpServers 传给代理。' },
      toolProxy: { type: 'true / false', def: 'true', desc: '在本机起一个代理 MCP 服务，把智能体的内置工具、自定义工具（命令 / TypeScript）传给代理（仅 codebuddy / acp）。' },
      disableNativeMemory: { type: 'true / false', def: 'true', desc: '关闭代理自带的 Auto Memory（设置 CODEBUDDY_DISABLE_AUTO_MEMORY / CLAUDE_CODE_DISABLE_AUTO_MEMORY），统一使用 ~/.wechat-relay/memory。' },
      prewarm: { type: 'true / false', def: 'true', desc: '提前启动一个 codebuddy --acp --prewarm 待命进程（完成冷启动、登录、MCP 发现），需要新的 ACP 进程时再绑定 cwd 和参数，省去约 5 秒的启动时间（仅 codebuddy）。每个预热进程只用一次，用完自动补一个。' },
    },
  },
  builtinTools: {
    title: '内置工具开关', desc: '内置工具（builtin:time、builtin:history、builtin:skip 等）的全局开关，写法是「工具名: true/false」。智能体的 tools 里引用后才会真正生效。',
    fields: {},
  },
  tools: {
    title: '自定义工具', desc: '智能体可以调用的工具：一条 shell 命令，或一段 TypeScript 脚本。智能体在 tools 里按 id 引用。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识，也是模型看到的工具名。' },
      type: { type: '字符串', desc: '工具类型。', values: { command: 'shell 命令', script: 'TypeScript 模块（export default async (args, ctx) => 结果）' } },
      enabled: { type: 'true / false', def: 'true', desc: '全局开关，关闭后所有智能体都不能用。' },
      description: { type: '字符串', desc: '告诉模型这个工具做什么、什么时候该用。写清楚模型才会正确调用。' },
      parameters: { type: 'JSON Schema', desc: '工具参数的定义（JSON Schema 格式），模型据此决定传什么参数。' },
      command: { type: '命令', desc: '（type=command）要执行的 shell 命令。{{参数名}} 会被替换成已转义的参数值；完整参数也在环境变量 $TOOL_ARGS（JSON）里。', example: 'curl -s "wttr.in/{{city}}?format=3"' },
      code: { type: '代码', desc: '（type=script）TypeScript 源码。只剥离类型，不支持 enum / namespace。' },
      dependencies: { type: '键值', desc: '（type=script）依赖的 npm 包，写法同 package.json，建议锁定版本。保存工具时自动安装。' },
      cwd: { type: '路径', desc: '命令 / 脚本的工作目录（可选）。' },
      timeoutMs: { type: '毫秒', def: '15000', desc: '工具执行的超时时间。' },
    },
  },
  mcpServers: {
    title: 'MCP 服务', desc: '外部 MCP 工具服务器。智能体用 mcp:<id> 引用，需同时在这里 enabled。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识。' },
      enabled: { type: 'true / false', desc: '全局开关。' },
      command: { type: '命令', desc: '（stdio 方式）启动服务的命令，例如 uvx、npx。' },
      args: { type: '列表', desc: '（stdio 方式）命令参数。' },
      env: { type: '键值', desc: '（stdio 方式）环境变量。' },
      url: { type: 'URL', desc: '（HTTP / SSE 方式）服务地址。与 command 二选一。' },
      headers: { type: '键值', desc: '（HTTP / SSE 方式）请求头，例如鉴权信息。' },
    },
  },
  memory: {
    title: '记忆', desc: '跨消息的长期记忆。开启后系统提示词会附带全局记忆索引和读写路径说明，并自动给智能体开放只限 ~/.wechat-relay/memory 与 skills 目录的文件工具和沙箱 Bash；记忆文件是普通 Markdown，一行一条。',
    fields: {
      enabled: { type: 'true / false', def: 'false', desc: '记忆总开关（与 Skill 互相独立）。' },
      indexLimit: { type: '条数', def: '12', desc: '系统提示词里列出多少条全局记忆（按优先级、时间排序）。会话记忆不列出，需要时让智能体读文件或 grep。' },
      dreamEveryMessages: { type: '条数', def: '100', desc: '某个会话新增这么多条消息后，自动「做梦」：让智能体整理合并该会话和全局记忆。', values: { '0': '只在界面手动触发' } },
      dreamAgent: { type: '字符串', desc: '做梦使用的智能体 id，不填用第一个智能体。' },
    },
  },
  skillsEnabled: {
    title: 'Skill 总开关', desc: 'true / false，默认 false。与记忆互相独立：开启后系统提示词带 skill 索引与路径说明，并开放只限 ~/.wechat-relay/skills 的文件工具和沙箱 Bash（可运行 skill 里的脚本）。', fields: {},
  },
  skills: {
    title: 'Skill', desc: '可复用的操作指引（SKILL.md），文件在 ~/.wechat-relay/skills。此处只记录启用开关和初始内容；文件已存在时以磁盘为准。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识，也是目录名（字母数字下划线连字符）。' },
      name: { type: '字符串', desc: '界面显示名称。' },
      description: { type: '字符串', desc: '一句话说明何时使用，会列在系统提示词的 skill 索引里。' },
      scope: { type: '字符串', def: 'global', desc: '生效范围。', values: { global: '所有会话', session: '只对 chat 指定的会话' } },
      chat: { type: '字符串', desc: '（scope=session）会话名。' },
      enabled: { type: 'true / false', def: 'true', desc: '是否列入提示词。' },
      content: { type: '文本', desc: 'SKILL.md 正文；仅在文件不存在时写入。' },
    },
  },
  prompts: {
    title: '提示词', desc: '可复用的系统提示词。智能体用 prompt 字段引用 id。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识。' },
      name: { type: '字符串', desc: '界面显示名称。' },
      content: {
        type: '模板文本', desc: '提示词正文，支持模板变量：{{myNickname}} 你的昵称、{{chat}} 会话名、{{sender}} 最新发言人、{{now}} 当前时间；{{#group}}…{{/group}} 只在群聊时生效。',
      },
      goodCases: { type: '列表', desc: '好的回复示例，追加在正文后让模型参照。每项：context 之前的对话（每行「说话人: 内容」）、reply 我的回复、note 好在哪里（可选）。可在「会话记录」里勾选消息标注。' },
      badCases: { type: '列表', desc: '不好的回复示例，追加在正文后让模型避免。字段同 goodCases，note 写问题所在。' },
    },
  },
  agents: {
    title: '智能体', desc: '决定「怎么回复」：用哪个模型 / 代理、什么提示词、能用哪些工具。规则里用 agent 引用 id。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识。' },
      name: { type: '字符串', desc: '界面显示名称。' },
      engine: { type: '字符串', desc: '回复引擎。', values: { model: '直接调用大模型（配合 provider / model）', harness: '交给外部命令行代理（配合 harness）' } },
      provider: { type: '字符串', desc: '（engine=model）使用的服务商 id，对应 providers。' },
      model: { type: '字符串', desc: '（engine=model）模型名，例如 deepseek-chat、gpt-4o。' },
      temperature: { type: '0 ~ 2', def: '0.7', desc: '随机性。越低越稳定保守，越高越有变化。' },
      maxTokens: { type: '数字', desc: '单次回复最大 token 数（可选）。' },
      harness: { type: '字符串', desc: '（engine=harness）使用的代理 id，对应 harnesses。' },
      prompt: { type: '字符串', desc: '使用的提示词 id，对应 prompts。' },
      systemPrompt: { type: '文本', desc: '追加在提示词后面的额外系统提示（可选）。' },
      tools: { type: '列表', desc: '可用的工具。写法：builtin:名称（内置）、工具 id（自定义）、mcp:服务 id（MCP）。需同时在全局启用。', example: '[builtin:time, builtin:skip, weather]' },
      maxToolRounds: { type: '数字', def: '4', desc: '一次回复里最多允许调用几轮工具，防止死循环。' },
      vision: { type: 'true / false', def: 'false', desc: '模型支持看图时打开（如 gpt-4o）：聊天里的图片会直接发给模型；关闭则用图片里识别出的文字代替。模型不支持图片时会自动退回文字。' },
      maxImages: { type: '数字', def: '4', desc: '每次最多发给模型几张图片（取最近的），更早的用文字代替。' },
      imageDetail: { type: '字符串', def: 'low', desc: '图片精度（OpenAI 风格）。', values: { low: '最省 token', high: '更清晰但更贵', auto: '由模型决定' } },
    },
  },
  apps: {
    title: '监听的聊天软件', desc: '可同时监听多个 App，互不干扰；规则的 match.apps 限定作用于哪些 App。写法：apps.wechat / apps.wecom。',
    fields: {
      wechat: { type: '对象', desc: '微信。enabled: 是否监听。' },
      wecom: { type: '对象', desc: '企微（通过辅助功能树后台读取会话列表，不抢焦点、窗口可隐藏在托盘）。enabled 是否监听；nickname 你在企微里的名字（如 zhangsan），用于识别群里 @我；pollIntervalMs 读取会话列表的间隔。目前只支持脚本动作，不支持 AI 回复和发送。' },
    },
  },
  scripts: {
    title: '脚本', desc: 'TypeScript 脚本，代码在 ~/.wechat-relay/scripts/<id>/index.ts（在「脚本」页或 VS Code 里编辑），这里只保存开关。规则 action: script + script: <id> 触发。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识，也是脚本文件夹名。' },
      name: { type: '字符串', desc: '界面显示名称。' },
      description: { type: '字符串', desc: '说明。' },
      enabled: { type: 'true / false', def: 'true', desc: '是否启用。停用后指向它的规则不再生效。' },
      timeoutMs: { type: '毫秒', def: '120000', desc: '单次运行超过这个时间就终止。' },
      dependencies: { type: '键值', desc: 'npm 依赖（包名: 版本），保存时在脚本文件夹里 npm install。' },
    },
  },
  rules: {
    title: '回复规则', desc: '决定「回不回复谁」。按从上到下的顺序匹配，第一条命中的生效。', list: true,
    fields: {
      id: { type: '字符串', desc: '唯一标识。' },
      name: { type: '字符串', desc: '界面显示名称。' },
      enabled: { type: 'true / false', def: 'true', desc: '是否启用这条规则。' },
      match: { type: '对象', desc: '匹配条件，所有写出的条件需同时满足。可用字段见下方 match 说明。' },
      action: { type: '字符串', desc: '命中后的动作。', values: { reply: '交给智能体回复', script: '交给 TypeScript 脚本处理（不走 AI 回复）', ignore: '忽略，不回复' } },
      script: { type: '字符串', desc: '（action=script）脚本 id，对应 scripts 里的条目。' },
      agent: { type: '字符串', desc: '（action=reply）负责回复的智能体 id，不填用第一个智能体。' },
      mode: { type: '字符串', def: 'inherit', desc: '覆盖通用设置里的 mode。', values: { inherit: '沿用 general.mode', auto: '直接发送', review: '生成草稿待审核' } },
      cooldownSec: { type: '秒', def: '0', desc: '同一会话命中这条规则后，多少秒内不再自动回复。' },
    },
  },
  'rules.match': {
    title: '规则匹配条件', desc: 'rules[].match 里可以写的条件。',
    fields: {
      apps: { type: '列表', desc: '作用于哪些聊天软件（可多选）。不写 = 所有 App。', values: { wechat: '微信', wecom: '企微' }, example: '[wecom]' },
      chats: { type: '列表', desc: '会话名（备注名 / 群名）。支持精确匹配、* 通配符、/正则/。不写 = 所有会话。', example: '[老婆, 订阅号*, /项目.*群/]' },
      excludeChats: { type: '列表', desc: '排除的会话名，写法同 chats。' },
      chatType: { type: '字符串', desc: '会话类型。', values: { any: '不限', private: '仅私聊', group: '仅群聊' } },
      mentionOnly: { type: 'true / false', desc: '群聊里只有 @我 时才命中（需要设置 general.myNickname）。' },
      includeAtAll: { type: 'true / false', desc: '同时把 @所有人 也算作 @我。' },
      keywords: { type: '列表', desc: '新消息里包含其中任意一个词（或匹配 /正则/）才命中。' },
      senders: { type: '列表', desc: '群聊发言人名字，写法同 chats。' },
    },
  },
};

/** Top-level section key → doc (title / description), for hovering over `general:` etc. */
export const sectionDoc = (key: string): SectionDoc | undefined => CONFIG_DOCS[key];

const KEY_RE = /^(\s*)(-\s+)?([A-Za-z_][\w-]*)\s*:/;

/** Column (0-based) of the key on a YAML line, or null. */
function keyCol(line: string): { col: number; key: string } | null {
  const m = KEY_RE.exec(line);
  return m ? { col: m[1].length + (m[2]?.length ?? 0), key: m[3] } : null;
}

/** Keys of the mappings enclosing a key that starts at column `col` on line `i` (outermost first). */
export function ancestors(lines: string[], i: number, col: number): string[] {
  const out: string[] = [];
  let cur = col;
  for (let j = i - 1; j >= 0 && cur > 0; j--) {
    const k = keyCol(lines[j]);
    if (k && k.col < cur) { out.unshift(k.key); cur = k.col; }
  }
  return out;
}

export function fieldDoc(path: string[], key: string): { title: string; doc: FieldDoc } | null {
  if (!path.length) {
    const s = CONFIG_DOCS[key];
    return s ? { title: key, doc: { desc: `${s.title}：${s.desc}`, type: s.list ? '列表' : '对象' } } : null;
  }
  const f = CONFIG_DOCS[path.join('.')]?.fields[key];
  return f ? { title: key, doc: f } : null;
}

/** The doc for the key hovered at (line i, 0-based column c), including keys inside `{ a: 1, b: 2 }` flow mappings. */
export function docAt(lines: string[], i: number, c: number): { title: string; doc: FieldDoc } | null {
  const line = lines[i] ?? '';
  const k = keyCol(line);
  if (!k) return null;
  const word = /[A-Za-z_][\w-]*/g;
  let w: RegExpExecArray | null;
  while ((w = word.exec(line))) {
    if (c < w.index || c > w.index + w[0].length) continue;
    if (w.index === k.col && w[0] === k.key) return fieldDoc(ancestors(lines, i, k.col), k.key);
    if (new RegExp(`[{,]\\s*${w[0]}\\s*:`).test(line) && line.includes('{')) return fieldDoc([...ancestors(lines, i, k.col), k.key], w[0]);
    return null;
  }
  return null;
}

/** Field names that can be written at column `col` of line `i` (for completion). */
export function keysAt(lines: string[], i: number, col: number): Array<{ name: string; doc: FieldDoc; section?: SectionDoc }> {
  const path = ancestors(lines, i, col);
  if (!path.length) return Object.entries(CONFIG_DOCS).filter(([k]) => !k.includes('.')).map(([name, s]) => ({ name, doc: { desc: s.desc, type: s.list ? '列表' : '对象' }, section: s }));
  const s = CONFIG_DOCS[path.join('.')];
  return s ? Object.entries(s.fields).map(([name, doc]) => ({ name, doc })) : [];
}

export function docMarkdown(title: string, d: FieldDoc): string {
  const lines = [`**${title}**${d.type ? `  \`${d.type}\`` : ''}${d.def ? `  默认 \`${d.def}\`` : ''}`, '', d.desc];
  if (d.values) lines.push('', ...Object.entries(d.values).map(([v, t]) => `- \`${v}\`：${t}`));
  if (d.example) lines.push('', `示例：\`${d.example}\``);
  return lines.join('\n');
}

/** 0-based line of the first `key` whose enclosing keys are `path` (flow-mapping keys resolve to their parent line). */
export function findField(lines: string[], path: string[], key: string): number {
  const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  let fallback = -1;
  for (let i = 0; i < lines.length; i++) {
    const k = keyCol(lines[i]);
    if (!k) continue;
    const anc = ancestors(lines, i, k.col);
    if (k.key === key && eq(anc, path)) return i;
    if (fallback < 0 && eq([...anc, k.key], path) && new RegExp(`[{,]\\s*${key}\\s*:`).test(lines[i])) fallback = i;
  }
  return fallback;
}
