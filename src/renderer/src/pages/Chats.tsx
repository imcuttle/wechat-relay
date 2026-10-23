import { useEffect, useRef, useState } from 'react';
import { App, Button, Empty, Image, Input, List, Popconfirm, Popover, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { MessagesSquare, Plus, RefreshCw, Send, Sparkles, Trash, UserRound } from 'lucide-react';
import type { ChatMessage, ChatSummary, ReplyMode } from '@shared/types';
import PersonaModal from '../components/PersonaModal';
import { errMsg, useRelay } from '../relay';

const MODE_TAG: Record<ReplyMode, string> = { review: '审核', auto: '自动' };

export default function Chats() {
  const { chatVersion, config } = useRelay();
  const { message } = App.useApp();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [newChat, setNewChat] = useState('');
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [agent, setAgent] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);

  useEffect(() => { void window.relay.getChats().then(setChats); }, [chatVersion]);
  // Nothing selected (first visit, or the selected chat is gone): pick the first chat.
  useEffect(() => { if (chats.length && !chats.some((c) => c.name === active)) setActive(chats[0].name); }, [chats, active]);
  useEffect(() => { if (active) void window.relay.getHistory(active).then(setHistory); }, [active, chatVersion]);
  useEffect(() => { bottom.current?.scrollIntoView(); }, [history]);
  // A draft belongs to one chat: never carry it over to another one.
  useEffect(() => { activeRef.current = active; setDraft(''); }, [active]);
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

  const sync = async () => {
    if (!active) return;
    setSyncing(true);
    try {
      const r = await window.relay.syncHistory(active);
      message.success(`已同步 ${r.count} 条`);
      setHistory(await window.relay.getHistory(active));
      setChats(await window.relay.getChats());
    } catch (e) { message.error(errMsg(e)); }
    finally { setSyncing(false); }
  };

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
        <div style={{ padding: '16px 16px 8px', fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}><MessagesSquare size={16} />会话记录</div>
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
              onClick={() => setActive(c.name)}
              style={{ padding: '10px 16px', cursor: 'pointer', background: c.name === active ? '#e8f8ee' : undefined }}
            >
              <List.Item.Meta
                title={<Space size={4}>{c.name}{c.isGroup && <Tag color="blue">群</Tag>}{c.paused && <Tag>已暂停</Tag>}{c.mode !== 'inherit' && <Tag color={c.mode === 'auto' ? 'orange' : 'green'}>{MODE_TAG[c.mode]}</Tag>}{c.persona?.enabled && <Tag color="purple">人设</Tag>}</Space>}
                description={<Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 220 }}>{c.lastText}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {current ? (
          <>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff', display: 'flex', justifyContent: 'space-between' }}>
              <Typography.Text strong>{current.name}（{current.count} 条）</Typography.Text>
              <Space wrap>
                <Tooltip title="该会话的发送方式，优先级高于回复规则和顶部的全局设置。审核 = 生成草稿到「待审核」；自动 = 直接发送">
                  <Select size="small" style={{ width: 130 }} value={current.mode}
                    onChange={(v) => void window.relay.setChatMode(current.name, v).then(refreshChats)}
                    options={[{ value: 'inherit', label: '发送：跟随默认' }, { value: 'review', label: '发送：审核后' }, { value: 'auto', label: '发送：自动' }]} />
                </Tooltip>
                <Tooltip title="基于该会话的历史聊天记录，一键总结语气和风格">
                  <Button size="small" icon={<UserRound size={14} />} type={current.persona?.enabled ? 'primary' : 'default'} ghost={!!current.persona?.enabled} onClick={() => setPersonaOpen(true)}>人设</Button>
                </Tooltip>
                <Tooltip title="暂停后不会对该会话自动回复">
                  <Space size={6}>自动回复<Switch size="small" checked={!current.paused} onChange={(v) => void window.relay.setChatPaused(current.name, !v).then(refreshChats)} /></Space>
                </Tooltip>
                <Popconfirm title="同步历史？" description="在后台打开该会话并向上滚动，读取「上下文时间」（设置里可改，默认 10 分钟）内的消息，用读取结果重建本地记录（不会前置微信）" onConfirm={() => void sync()}>
                  <Button size="small" icon={<RefreshCw size={14} />} loading={syncing}>同步历史</Button>
                </Popconfirm>
                <Popconfirm title="清空本地记录？（不影响微信）" onConfirm={() => void window.relay.clearHistory(current.name).then(() => { setActive(null); return window.relay.getChats().then(setChats); })}>
                  <Button size="small" danger icon={<Trash size={14} />}>清空记录</Button>
                </Popconfirm>
              </Space>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 8, background: '#f5f6f8' }}>
              {history.map((m) => (
                <div key={m.id} style={{ alignSelf: m.side === 'self' ? 'flex-end' : 'flex-start', maxWidth: '70%', display: 'flex', flexDirection: 'column', alignItems: m.side === 'self' ? 'flex-end' : 'flex-start' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {m.side === 'self' ? (m.source === 'bot' ? '机器人' : '我') : m.sender || current.name} · {new Date(m.at).toLocaleString()}
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
              ))}
              <div ref={bottom} />
            </div>
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
      {current && <PersonaModal chat={current.name} open={personaOpen} onClose={() => setPersonaOpen(false)} onChanged={() => void refreshChats()} />}
    </div>
  );
}
