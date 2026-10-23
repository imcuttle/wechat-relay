import { useState } from 'react';
import { App, Button, Card, Empty, Input, Segmented, Space, Tag, Typography } from 'antd';
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
  const list = drafts.filter((d) => filter === 'all' || d.status === 'pending' || d.status === 'failed');
  return (
    <div className="page">
      <div className="page-title">
        <h2><Inbox size={18} />待审核回复</h2>
        <Segmented value={filter} onChange={(v) => setFilter(v as 'pending' | 'all')} options={[{ label: '待处理', value: 'pending' }, { label: '全部', value: 'all' }]} />
      </div>
      {list.length ? list.map((d) => <DraftCard key={`${d.id}-${d.status}`} d={d} />) : <Empty description="没有草稿" />}
    </div>
  );
}
