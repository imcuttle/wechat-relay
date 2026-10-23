import { useState } from 'react';
import { App, Badge, Button, Card, Empty, Input, Segmented, Space, Tag, Typography } from 'antd';
import { Check, Inbox, X } from 'lucide-react';
import type { Draft } from '@shared/types';
import { errMsg, useRelay } from '../relay';

const STATUS: Record<Draft['status'], { color: string; text: string }> = {
  pending: { color: 'processing', text: '待审核' }, sent: { color: 'success', text: '已发送' },
  rejected: { color: 'default', text: '已忽略' }, failed: { color: 'error', text: '发送失败' },
};

function DraftCard({ d }: { d: Draft }) {
  const { message } = App.useApp();
  const [text, setText] = useState(d.text);
  const [busy, setBusy] = useState(false);
  const editable = d.status === 'pending' || d.status === 'failed';
  const approve = async () => {
    setBusy(true);
    try { await window.relay.approveDraft(d.id, text); message.success('已发送'); } catch (e) { message.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card size="small" style={{ marginBottom: 12 }}
      title={<Space><Typography.Text strong>{d.chat}</Typography.Text><Tag color={STATUS[d.status].color}>{STATUS[d.status].text}</Tag></Space>}
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.agent} · {d.rule} · {new Date(d.createdAt).toLocaleString()}</Typography.Text>}>
      {d.trigger && <div style={{ marginBottom: 8 }}><Typography.Text type="secondary" style={{ fontSize: 12 }}>触发消息</Typography.Text><div className="bubble other" style={{ maxWidth: '100%' }}>{d.trigger}</div></div>}
      {editable ? <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 2, maxRows: 8 }} /> : <div className="bubble bot" style={{ maxWidth: '100%' }}>{d.text}</div>}
      {d.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{d.error}</Typography.Text>}
      {editable && (
        <Space style={{ marginTop: 8 }}>
          <Button type="primary" size="small" icon={<Check size={14} />} loading={busy} onClick={() => void approve()}>{d.status === 'failed' ? '重试发送' : '发送'}</Button>
          <Button size="small" icon={<X size={14} />} onClick={() => void window.relay.rejectDraft(d.id)}>忽略</Button>
        </Space>
      )}
    </Card>
  );
}

export default function Drafts() {
  const { drafts } = useRelay();
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [chat, setChat] = useState<string>(''); // '' = all chats
  const visible = drafts.filter((d) => filter === 'all' || d.status === 'pending' || d.status === 'failed');
  // One group per chat, most recently active first; the badge counts drafts that still need action.
  const groups = [...visible.reduce((m, d) => {
    const g = m.get(d.chat) ?? { chat: d.chat, total: 0, todo: 0, last: 0 };
    g.total++; g.last = Math.max(g.last, d.createdAt);
    if (d.status === 'pending' || d.status === 'failed') g.todo++;
    return m.set(d.chat, g);
  }, new Map<string, { chat: string; total: number; todo: number; last: number }>()).values()].sort((a, b) => b.last - a.last);
  const selected = groups.some((g) => g.chat === chat) ? chat : '';
  const list = selected ? visible.filter((d) => d.chat === selected) : visible;
  const row = (key: string, label: string, count: number) => (
    <div key={key} onClick={() => setChat(key)}
      style={{ padding: '10px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: key === selected ? '#e8f8ee' : undefined }}>
      <Typography.Text ellipsis style={{ maxWidth: 160 }} strong={key === selected}>{label}</Typography.Text>
      <Badge count={count} color={count ? undefined : '#d9d9d9'} showZero size="small" />
    </div>
  );
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 220, borderRight: '1px solid #f0f0f0', background: '#fff', overflow: 'auto' }}>
        <div style={{ padding: '16px 16px 8px', fontWeight: 600 }}>按会话</div>
        {row('', '全部会话', visible.filter((d) => d.status === 'pending' || d.status === 'failed').length)}
        {groups.map((g) => row(g.chat, g.chat, g.todo))}
      </div>
      <div className="page" style={{ flex: 1, minWidth: 0 }}>
        <div className="page-title">
          <h2><Inbox size={18} />待审核回复{selected && <Tag>{selected}</Tag>}</h2>
          <Segmented value={filter} onChange={(v) => setFilter(v as 'pending' | 'all')} options={[{ label: '待处理', value: 'pending' }, { label: '全部', value: 'all' }]} />
        </div>
        {list.length ? list.map((d) => <DraftCard key={`${d.id}-${d.status}`} d={d} />) : <Empty description="没有草稿" />}
      </div>
    </div>
  );
}
