import { useEffect, useRef, useState } from 'react';
import { App, Button, Checkbox, Divider, Dropdown, Empty, Image, Input, List, Popover, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { CheckSquare, Ellipsis, ListChecks, MessagesSquare, Plus, RefreshCw, Send, Sparkles, ThumbsDown, ThumbsUp, Trash, UserRound } from 'lucide-react';
import type { ChatMessage, ChatSummary, Persona, PromptCase, ReplyMode, SyncOptions } from '@shared/types';
import { applyCase, CaseModal, CasesModal, KIND_LABEL, type CaseDraft, type CaseKind } from '../components/CaseModal';
import PersonaModal from '../components/PersonaModal';
import SyncModal from '../components/SyncModal';
import { errMsg, useRelay } from '../relay';

const MODE_TAG: Record<ReplyMode, string> = { review: '审核', auto: '自动' };

const speakerOf = (m: ChatMessage, chat: string) => (m.side === 'self' ? '我' : m.sender || chat);
const lineOf = (m: ChatMessage) => m.text.replace(/\s+/g, ' ').trim();

/** Selected messages → example: my trailing messages are the reply, everything before is the context. */
function caseFrom(msgs: ChatMessage[], chat: string): PromptCase {
  let k = msgs.length;
  while (k > 0 && msgs[k - 1].side === 'self') k--;
  return {
    context: msgs.slice(0, k).map((m) => `${speakerOf(m, chat)}: ${lineOf(m)}`).join('\n'),
    reply: msgs.slice(k).map(lineOf).join('\n'),
    chat, ids: msgs.map((m) => m.id), at: Date.now(),
  };
}

export default function Chats() {
  const { chatVersion, config } = useRelay();
  const { message, modal } = App.useApp();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [newChat, setNewChat] = useState('');
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [agent, setAgent] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [caseDraft, setCaseDraft] = useState<CaseDraft | null>(null);
  const [casesOpen, setCasesOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);

  useEffect(() => { void window.relay.getChats().then(setChats); }, [chatVersion]);
  // Nothing selected (first visit, or the selected chat is gone): pick the first chat.
  useEffect(() => { if (chats.length && !chats.some((c) => c.name === active)) setActive(chats[0].name); }, [chats, active]);
  useEffect(() => { if (active) void window.relay.getHistory(active).then(setHistory); }, [active, chatVersion]);
  useEffect(() => { bottom.current?.scrollIntoView(); }, [history]);
  // A draft belongs to one chat: never carry it over to another one.
  useEffect(() => { activeRef.current = active; setDraft(''); setSelecting(false); setSelected(new Set()); }, [active]);
  const [agentPrompt, setAgentPrompt] = useState<{ agent: string; prompt?: string } | null>(null);
  const loadPersona = () => {
    if (!active) return;
    void window.relay.getPersona(active).then(setPersona);
    void window.relay.agentPrompt(active).then(setAgentPrompt);
  };
  useEffect(loadPersona, [active, chatVersion, config]);
  const current = chats.find((c) => c.name === active);
  const refreshChats = () => window.relay.getChats().then(setChats);

  const send = async () => {
    if (!active || !draft.trim()) return;
    setSending(true);
    try { await window.relay.sendManual(active, draft.trim()); setDraft(''); message.success('已发送'); }
    catch (e) { message.error(errMsg(e)); }
    finally { setSending(false); }
  };

  const generate = async () => {
    if (!active) return;
    const chat = active;
    setGenerating(true);
    try {
      const r = await window.relay.generateReply(chat, agent || undefined);
      if (activeRef.current !== chat) { message.info(`「${chat}」的回复已生成，但你已切换会话，未填入`); return; }
      if (r.text) { setDraft(r.text); message.success(`已生成（${r.agent}，${(r.ms / 1000).toFixed(1)}s），确认或修改后点发送`); }
      else message.info(`${r.agent}：${r.reason ?? '不回复'}`);
    } catch (e) { message.error(errMsg(e)); }
    finally { setGenerating(false); }
  };

  const sync = async (opts: SyncOptions) => {
    if (!active) return;
    const chat = active;
    setSyncing(true);
    try {
      const r = await window.relay.syncHistory(chat, opts);
      message.success(`已同步 ${r.count} 条${r.reachedTop ? '（已到会话顶部）' : ''}`);
      if (activeRef.current === chat) setHistory(await window.relay.getHistory(chat));
      setChats(await window.relay.getChats());
    } catch (e) { message.error(errMsg(e)); }
    finally { setSyncing(false); }
  };

  // Message id → kind of the examples it is part of.
  const marks = new Map<string, CaseKind>();
  for (const [kind, list] of [['good', persona?.goodCases], ['bad', persona?.badCases]] as const) {
    for (const c of list ?? []) if (c.chat === active) for (const id of c.ids ?? []) marks.set(id, kind);
  }
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const mark = (kind: CaseKind) => {
    if (!active) return;
    const msgs = history.filter((m) => selected.has(m.id));
    if (!msgs.length) { message.info('先勾选几条消息：对方的话 + 我的回复'); return; }
    setCaseDraft({ kind, case: caseFrom(msgs, active) });
  };
  const saveCases = async (next: { goodCases: PromptCase[]; badCases: PromptCase[] }) => {
    if (!active) return;
    try { setPersona(await window.relay.setPersonaCases(active, next)); void refreshChats(); }
    catch (e) { message.error(errMsg(e)); throw e; }
  };
  const saveCase = async (d: CaseDraft) => {
    await saveCases(applyCase(persona, d));
    message.success(d.index !== undefined ? '已更新示例' : `已添加${KIND_LABEL[d.kind]}${persona?.enabled ? '' : '（该会话没有启用人设，启用后示例才会生效）'}`);
    setCaseDraft(null);
    if (d.index === undefined) { setSelecting(false); setSelected(new Set()); }
  };
  const caseCount = (persona?.goodCases.length ?? 0) + (persona?.badCases.length ?? 0);

  const selectPersona = async (prompt: string) => {
    if (!active) return;
    try {
      setPersona(await window.relay.selectPersona(active, prompt || null));
      void refreshChats();
      message.success(prompt ? `已切换人设：${promptName(prompt)}` : `已改为跟随智能体${agentPrompt ? `「${agentPrompt.agent}」` : ''}的提示词`);
    } catch (e) { message.error(errMsg(e)); }
  };
  const promptName = (id?: string) => (id ? config?.prompts.find((p) => p.id === id)?.name || id : '无提示词');
  const ownId = persona?.own;
  const ownReady = !!persona?.text.trim();
  // title '' keeps the browser from repeating the label as a native tooltip.
  const personaOptions = [
    { value: '', label: `跟随智能体：${promptName(agentPrompt?.prompt)}`, title: '' },
    { value: '__own', label: ownReady ? '本会话人设' : '本会话人设（未生成，点右侧按钮）', disabled: !ownReady, title: '' },
    {
      label: '切换为其他提示词',
      options: (config?.prompts ?? []).filter((p) => p.id !== ownId && p.content.trim()).map((p) => ({ value: p.id, label: p.name || p.id, title: '' })),
    },
  ];
  const personaValue = !persona?.enabled ? '' : persona.prompt === ownId ? '__own' : persona.prompt;

  // Batch selection in the chat list.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => { setPicked((s) => new Set([...s].filter((n) => chats.some((c) => c.name === n)))); }, [chats]);
  const togglePick = (name: string) => setPicked((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const stopPicking = () => { setPicking(false); setPicked(new Set()); };
  const deleteChats = async (names: string[]) => {
    try {
      const n = await window.relay.deleteChats(names);
      message.success(`已删除 ${n} 个会话`);
      if (active && names.includes(active)) setActive(null);
      stopPicking();
      await refreshChats();
    } catch (e) { message.error(errMsg(e)); }
  };
  const confirmDelete = (names: string[]) => modal.confirm({
    title: names.length === 1 ? `删除会话「${names[0]}」？` : `删除选中的 ${names.length} 个会话？`,
    content: '本地聊天记录、图片和该会话的发送方式 / 人设开关都会删除，不影响微信。会话人设的提示词仍保留在「提示词」页。之后收到新消息会重新出现。',
    okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
    onOk: () => deleteChats(names),
  });

  const add = async () => {
    const name = newChat.trim();
    if (!name) return;
    setAdding(true);
    try {
      const r = await window.relay.addChat(name);
      (r.synced ? message.success : message.info)(r.message);
      setNewChat('');
      setChats(await window.relay.getChats());
      setActive(name);
    } catch (e) { message.error(errMsg(e)); }
    finally { setAdding(false); }
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 280, borderRight: '1px solid #f0f0f0', background: '#fff', overflow: 'auto' }}>
        <div style={{ padding: '16px 12px 8px 16px', fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}>
          <MessagesSquare size={16} />会话记录
          <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>{chats.length}</Typography.Text>
          <Button size="small" type={picking ? 'link' : 'text'} icon={picking ? undefined : <CheckSquare size={14} />} style={{ marginLeft: 'auto' }} disabled={!chats.length}
            onClick={() => (picking ? stopPicking() : setPicking(true))}>{picking ? '完成' : '批量'}</Button>
        </div>
        {picking && (
          <div className="pick-bar">
            <Checkbox checked={!!chats.length && picked.size === chats.length} indeterminate={picked.size > 0 && picked.size < chats.length}
              onChange={(e) => setPicked(e.target.checked ? new Set(chats.map((c) => c.name)) : new Set())}>全选</Checkbox>
            <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>已选 {picked.size}</Typography.Text>
            <Button size="small" danger type="primary" icon={<Trash size={13} />} disabled={!picked.size} onClick={() => confirmDelete([...picked])}>删除</Button>
          </div>
        )}
        <div style={{ padding: '0 16px 8px' }}>
          <Tooltip title="填写微信里显示的备注名或群名。会话在微信列表中时会立即读取屏幕上的消息；否则先添加空记录，首次发送时通过搜索打开">
            <Space.Compact style={{ width: '100%' }}>
              <Input size="small" value={newChat} onChange={(e) => setNewChat(e.target.value)} onPressEnter={() => void add()} placeholder="新增会话（备注名 / 群名）" />
              <Button size="small" icon={<Plus size={14} />} loading={adding} onClick={() => void add()} />
            </Space.Compact>
          </Tooltip>
        </div>
        <List
          dataSource={chats}
          locale={{ emptyText: <Empty description="还没有识别到会话" /> }}
          renderItem={(c) => (
            <List.Item
              onClick={() => (picking ? togglePick(c.name) : setActive(c.name))}
              style={{ padding: '10px 16px', cursor: 'pointer', background: picking ? (picked.has(c.name) ? '#f0f7ff' : undefined) : c.name === active ? '#e8f8ee' : undefined }}
            >
              {picking && <Checkbox checked={picked.has(c.name)} style={{ marginRight: 10 }} />}
              <List.Item.Meta
                title={<Space size={4}>{c.name}{c.isGroup && <Tag color="blue">群</Tag>}{c.paused && <Tag>已暂停</Tag>}{c.mode !== 'inherit' && <Tag color={c.mode === 'auto' ? 'orange' : 'green'}>{MODE_TAG[c.mode]}</Tag>}{c.ask !== 'inherit' && <Tag color={c.ask === 'on' ? 'cyan' : 'default'}>{c.ask === 'on' ? '询问' : '不询问'}</Tag>}{c.persona?.enabled && <Tooltip title={config?.prompts.find((p) => p.id === c.persona!.prompt)?.name || c.persona.prompt}><Tag color="purple">人设</Tag></Tooltip>}</Space>}
                description={<Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 220 }}>{c.lastText}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {current ? (
          <>
            <div className="chat-header">
              <div className="chat-title">
                <Typography.Text strong ellipsis style={{ fontSize: 15 }}>{current.name}</Typography.Text>
                {current.isGroup && <Tag color="blue" style={{ marginInlineEnd: 0 }}>群</Tag>}
                <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{current.count} 条{syncing ? ' · 同步中…' : ''}</Typography.Text>
              </div>
              <div className="chat-tools">
                <Tooltip title="该会话的发送方式，优先级高于回复规则和顶部的全局设置。审核 = 生成草稿到「待审核」；自动 = 直接发送">
                  <Select size="small" style={{ width: 128 }} value={current.mode} prefix={<span style={{ color: '#999' }}>发送</span>}
                    onChange={(v) => void window.relay.setChatMode(current.name, v).then(refreshChats)}
                    options={[{ value: 'inherit', label: '跟随默认', title: '' }, { value: 'review', label: '审核后', title: '' }, { value: 'auto', label: '自动', title: '' }]} />
                </Tooltip>
                <Tooltip title="该会话是否允许智能体用 AskUserQuestion 弹窗问你，优先级高于全局设置">
                  <Select size="small" style={{ width: 118 }} value={current.ask} prefix={<span style={{ color: '#999' }}>询问</span>}
                    onChange={(v) => void window.relay.setChatAsk(current.name, v).then(refreshChats)}
                    options={[{ value: 'inherit', label: `默认·${config?.general.askUser ? '开' : '关'}`, title: '' }, { value: 'on', label: '开', title: '' }, { value: 'off', label: '关', title: '' }]} />
                </Tooltip>
                <Space.Compact size="small">
                  <Select size="small" style={{ width: 176 }} value={personaValue} popupMatchSelectWidth={280}
                    prefix={<span style={{ color: '#999' }}>人设</span>}
                    labelRender={(o) => (personaValue ? o.label : <span style={{ color: '#999' }}>跟随 · {promptName(agentPrompt?.prompt)}</span>)}
                    onChange={(v) => void selectPersona(v === '__own' ? ownId ?? '' : v)} options={personaOptions} />
                  <Tooltip title="生成 / 编辑本会话人设：基于该会话的历史聊天记录，一键总结语气和风格">
                    <Button size="small" icon={<UserRound size={14} />} onClick={() => setPersonaOpen(true)} />
                  </Tooltip>
                </Space.Compact>
                <Space.Compact size="small">
                  <Tooltip title="勾选聊天记录里的消息（对方的话 + 我的回复），标为好例或反例，附在人设提示词里让模型参照 / 避免">
                    <Button size="small" icon={<ListChecks size={14} />} type={selecting ? 'primary' : 'default'} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>标注示例</Button>
                  </Tooltip>
                  <Tooltip title="查看 / 管理已标注的示例">
                    <Button size="small" onClick={() => setCasesOpen(true)}>{caseCount}</Button>
                  </Tooltip>
                </Space.Compact>
                <Divider type="vertical" style={{ margin: 0 }} />
                <Tooltip title="暂停后不会对该会话自动回复">
                  <Space size={6} style={{ whiteSpace: 'nowrap' }}>自动回复<Switch size="small" checked={!current.paused} onChange={(v) => void window.relay.setChatPaused(current.name, !v).then(refreshChats)} /></Space>
                </Tooltip>
                <Dropdown trigger={['click']} placement="bottomRight" menu={{
                  items: [
                    { key: 'sync', icon: <RefreshCw size={14} />, label: syncing ? '同步中…' : '同步历史', disabled: syncing },
                    { type: 'divider' },
                    { key: 'clear', icon: <Trash size={14} />, label: '清空记录', danger: true },
                    { key: 'delete', icon: <Trash size={14} />, label: '删除会话', danger: true },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'sync') setSyncOpen(true);
                    if (key === 'clear') modal.confirm({ title: '清空本地记录？', content: '只删除聊天记录，会话的发送方式和人设保留，不影响微信。', okText: '清空', okButtonProps: { danger: true }, cancelText: '取消',
                      onOk: () => window.relay.clearHistory(current.name).then(() => { setActive(null); return refreshChats(); }) });
                    if (key === 'delete') confirmDelete([current.name]);
                  },
                }}>
                  <Button size="small" type="text" icon={<Ellipsis size={16} />} loading={syncing} />
                </Dropdown>
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 8, background: '#f5f6f8' }}>
              {history.map((m) => (
                <div key={m.id} onClick={selecting ? () => toggle(m.id) : undefined}
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: selecting ? 'pointer' : undefined, borderRadius: 6, background: selected.has(m.id) ? 'rgba(22,119,255,.08)' : undefined }}>
                {selecting && <Checkbox checked={selected.has(m.id)} style={{ marginTop: 18 }} />}
                {m.kind === 'notice' ? (
                  <Tooltip title={new Date(m.at).toLocaleString()}>
                    <Typography.Text type="secondary" style={{ margin: '0 auto', fontSize: 12, padding: '2px 8px', background: 'rgba(0,0,0,.04)', borderRadius: 4 }}>{m.text}</Typography.Text>
                  </Tooltip>
                ) : (
                <div style={{ marginLeft: m.side === 'self' ? 'auto' : undefined, maxWidth: '70%', display: 'flex', flexDirection: 'column', alignItems: m.side === 'self' ? 'flex-end' : 'flex-start' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {m.side === 'self' ? (m.source === 'bot' ? '机器人' : '我') : m.sender || current.name} · {new Date(m.at).toLocaleString()}
                    {marks.has(m.id) && <Tag color={marks.get(m.id) === 'good' ? 'green' : 'red'} style={{ marginLeft: 6, fontSize: 10, lineHeight: '16px' }}>{KIND_LABEL[marks.get(m.id)!]}</Tag>}
                  </Typography.Text>
                  <div className={`bubble ${m.source === 'bot' ? 'bot' : m.side}`}>
                    {m.image && <Image src={`relay-media://img/${encodeURIComponent(m.image.split('/').pop() ?? '')}`} style={{ maxWidth: 260, maxHeight: 260, borderRadius: 4, display: 'block' }} fallback="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />}
                    {m.image ? (
                      <Popover trigger="click" placement="bottom" title="识别文字（OCR）"
                        content={<div style={{ maxWidth: 360, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>{m.text.replace(/^\[图片\]\s*/, '') || '（没有识别到文字）'}</div>}>
                        <Typography.Link style={{ fontSize: 11, display: 'inline-block', marginTop: 2 }}>查看识别文字</Typography.Link>
                      </Popover>
                    ) : m.text}
                  </div>
                </div>
                )}
                </div>
              ))}
              <div ref={bottom} />
            </div>
            {selecting && (
              <div style={{ padding: '8px 12px', borderTop: '1px solid #f0f0f0', background: '#f0f7ff', display: 'flex', gap: 8, alignItems: 'center' }}>
                <Typography.Text>已选 {selected.size} 条</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>最后连续的「我」的消息作为回复，之前的作为对话上下文，下一步可以修改</Typography.Text>
                <Button size="small" icon={<ThumbsUp size={14} />} disabled={!selected.size} onClick={() => mark('good')}>标为好例</Button>
                <Button size="small" danger icon={<ThumbsDown size={14} />} disabled={!selected.size} onClick={() => mark('bad')}>标为反例</Button>
                <Button size="small" type="text" onClick={() => { setSelecting(false); setSelected(new Set()); }}>取消</Button>
              </div>
            )}
            <div style={{ padding: 12, borderTop: '1px solid #f0f0f0', background: '#fff' }}>
              <Space size={8} style={{ marginBottom: 8 }}>
                <Select size="small" style={{ width: 180 }} value={agent} onChange={setAgent}
                  options={[{ value: '', label: '按回复规则选择 agent' }, ...(config?.agents ?? []).map((a) => ({ value: a.id, label: a.name ? `${a.name}（${a.id}）` : a.id }))]} />
                <Tooltip title="用当前会话记录让智能体生成一条回复，填入下方输入框，不会自动发送">
                  <Button size="small" icon={<Sparkles size={14} />} loading={generating} onClick={() => void generate()}>生成回复</Button>
                </Tooltip>
              </Space>
              <Space.Compact style={{ width: '100%' }}>
                <Input.TextArea value={draft} onChange={(e) => setDraft(e.target.value)} autoSize={{ minRows: 1, maxRows: 4 }} placeholder="手动发送（会在后台切换到该会话，发送前校验会话与输入框内容）" onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void send(); } }} />
                <Button type="primary" icon={<Send size={14} />} loading={sending} onClick={() => void send()}>发送</Button>
              </Space.Compact>
            </div>
          </>
        ) : <Empty style={{ marginTop: 120 }} description="选择左侧会话查看记录" />}
      </div>
      {current && <PersonaModal chat={current.name} open={personaOpen} onClose={() => setPersonaOpen(false)} onChanged={() => { void refreshChats(); loadPersona(); }} />}
      {current && <SyncModal chat={current.name} open={syncOpen} onClose={() => setSyncOpen(false)} onSync={(o) => { void sync(o); }} />}
      <CasesModal open={casesOpen} persona={persona} onClose={() => setCasesOpen(false)} onEdit={setCaseDraft} onChange={saveCases} />
      <CaseModal draft={caseDraft} onCancel={() => setCaseDraft(null)} onSave={saveCase} />
    </div>
  );
}
