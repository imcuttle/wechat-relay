import { useEffect, useRef, useState } from 'react';
import { App, Button, Empty, Input, List, Popconfirm, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { MessagesSquare, Send, Trash } from 'lucide-react';
import type { ChatMessage, ChatSummary } from '@shared/types';
import { errMsg, useRelay } from '../relay';

export default function Chats() {
  const { chatVersion } = useRelay();
  const { message } = App.useApp();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { void window.relay.getChats().then(setChats); }, [chatVersion]);
  useEffect(() => { if (active) void window.relay.getHistory(active).then(setHistory); }, [active, chatVersion]);
  useEffect(() => { bottom.current?.scrollIntoView(); }, [history]);
  const current = chats.find((c) => c.name === active);

  const send = async () => {
    if (!active || !draft.trim()) return;
    setSending(true);
    try { await window.relay.sendManual(active, draft.trim()); setDraft(''); message.success('已发送'); }
    catch (e) { message.error(errMsg(e)); }
    finally { setSending(false); }
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 280, borderRight: '1px solid #f0f0f0', background: '#fff', overflow: 'auto' }}>
        <div style={{ padding: '16px 16px 8px', fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}><MessagesSquare size={16} />会话记录</div>
        <List
          dataSource={chats}
          locale={{ emptyText: <Empty description="还没有识别到会话" /> }}
          renderItem={(c) => (
            <List.Item
              onClick={() => setActive(c.name)}
              style={{ padding: '10px 16px', cursor: 'pointer', background: c.name === active ? '#e8f8ee' : undefined }}
            >
              <List.Item.Meta
                title={<Space size={4}>{c.name}{c.isGroup && <Tag color="blue">群</Tag>}{c.paused && <Tag>已暂停</Tag>}</Space>}
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
              <Space>
                <Tooltip title="暂停后不会对该会话自动回复">
                  <Space size={6}>自动回复<Switch size="small" checked={!current.paused} onChange={(v) => void window.relay.setChatPaused(current.name, !v).then(() => window.relay.getChats().then(setChats))} /></Space>
                </Tooltip>
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
                  <div className={`bubble ${m.source === 'bot' ? 'bot' : m.side}`}>{m.text}</div>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            <div style={{ padding: 12, borderTop: '1px solid #f0f0f0', background: '#fff' }}>
              <Space.Compact style={{ width: '100%' }}>
                <Input.TextArea value={draft} onChange={(e) => setDraft(e.target.value)} autoSize={{ minRows: 1, maxRows: 4 }} placeholder="手动发送（会在后台切换到该会话，发送前校验会话与输入框内容）" onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void send(); } }} />
                <Button type="primary" icon={<Send size={14} />} loading={sending} onClick={() => void send()}>发送</Button>
              </Space.Compact>
            </div>
          </>
        ) : <Empty style={{ marginTop: 120 }} description="选择左侧会话查看记录" />}
      </div>
    </div>
  );
}
