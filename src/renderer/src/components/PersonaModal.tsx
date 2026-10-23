import { useEffect, useState } from 'react';
import { Alert, App, Button, Checkbox, Divider, Input, InputNumber, Modal, Select, Space, Switch, Typography } from 'antd';
import { Sparkles } from 'lucide-react';
import type { Persona } from '@shared/types';
import { errMsg, useRelay } from '../relay';

const RANGES = [
  { value: 1440, label: '最近 1 天' }, { value: 4320, label: '最近 3 天' }, { value: 10080, label: '最近 7 天' },
  { value: 43200, label: '最近 30 天' }, { value: 129600, label: '最近 90 天' }, { value: 0, label: '不限时间' },
];

/** Per-chat persona: one-click generation from the chat history, plus manual editing. */
export default function PersonaModal({ chat, open, onClose, onChanged }: { chat: string; open: boolean; onClose: () => void; onChanged: () => void }) {
  const { config } = useRelay();
  const { message } = App.useApp();
  const [persona, setPersona] = useState<Persona | null>(null);
  const [text, setText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [agent, setAgent] = useState('');
  const [minutes, setMinutes] = useState(10080);
  const [limit, setLimit] = useState(400);
  const [fetch, setFetch] = useState(true);
  const [busy, setBusy] = useState(false);

  const apply = (p: Persona | null) => { setPersona(p); setText(p?.text ?? ''); setEnabled(p?.enabled ?? true); };
  useEffect(() => { if (open) void window.relay.getPersona(chat).then(apply); }, [open, chat]);

  const generate = async () => {
    setBusy(true);
    try {
      const r = await window.relay.generatePersona(chat, { agent: agent || undefined, minutes, limit, fetch });
      apply(r.persona);
      onChanged();
      (r.note ? message.warning : message.success)(r.note ?? `已根据 ${r.count} 条消息生成并启用人设`);
    } catch (e) { message.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const save = async (next?: { text?: string; enabled?: boolean }) => {
    const body = { text: next?.text ?? text, enabled: next?.enabled ?? enabled };
    try { await window.relay.setPersona(chat, body); apply(body.text.trim() ? await window.relay.getPersona(chat) : null); onChanged(); message.success(body.text.trim() ? '已保存' : '已删除人设'); }
    catch (e) { message.error(errMsg(e)); }
  };

  const dirty = (persona?.text ?? '') !== text || (persona?.enabled ?? true) !== enabled;

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={680} title={`人设 · ${chat}`}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="根据这个会话的历史聊天记录，总结你在这里的语气、称呼、口头禅等，生成的是一份完整提示词（含 {{chat}}、{{#group}}…{{/group}} 等模板变量和 [SKIP] 规则），启用后会替换该会话智能体所选的提示词，系统提示词仍会追加在后面。生成的范围可以比默认上下文大得多。" />
      <Space wrap size={[12, 8]} style={{ marginBottom: 8 }}>
        <Space size={6}>时间范围<Select style={{ width: 120 }} value={minutes} onChange={setMinutes} options={RANGES} /></Space>
        <Space size={6}>最多<InputNumber min={10} max={1000} step={50} value={limit} onChange={(v) => setLimit(v ?? 400)} />条</Space>
        <Space size={6}>智能体
          <Select style={{ width: 170 }} value={agent} onChange={setAgent}
            options={[{ value: '', label: '第一个智能体' }, ...(config?.agents ?? []).map((a) => ({ value: a.id, label: a.name ? `${a.name}（${a.id}）` : a.id }))]} />
        </Space>
      </Space>
      <div style={{ marginBottom: 12 }}>
        <Checkbox checked={fetch} onChange={(e) => setFetch(e.target.checked)}>从微信读取更早的消息（后台向上滚动，范围大时较慢；取消勾选则只用本地已有记录）</Checkbox>
      </div>
      <Button type="primary" icon={<Sparkles size={14} />} loading={busy} onClick={() => void generate()}>
        {persona ? '重新生成人设（覆盖当前）' : '一键生成人设'}
      </Button>
      {busy && <Typography.Text type="secondary" style={{ marginLeft: 12 }}>正在读取并总结，请稍候…</Typography.Text>}
      <Divider style={{ margin: '16px 0 12px' }} />
      <Space style={{ marginBottom: 8, justifyContent: 'space-between', width: '100%' }}>
        <Space size={6}>
          <Switch size="small" checked={enabled} onChange={(v) => { setEnabled(v); if (persona && !dirty) void save({ enabled: v }); }} />
          <span>启用人设</span>
        </Space>
        {persona && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{persona.source ? `${persona.source} · ` : ''}{new Date(persona.updatedAt).toLocaleString()}</Typography.Text>}
      </Space>
      <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 8, maxRows: 16 }} placeholder="还没有人设。点上面的按钮一键生成，或直接手写：语气、称呼、口头禅、常用表情……" />
      <Space style={{ marginTop: 12 }}>
        <Button type="primary" disabled={!dirty} onClick={() => void save()}>保存修改</Button>
        <Button danger disabled={!persona} onClick={() => void save({ text: '' })}>删除人设</Button>
      </Space>
    </Modal>
  );
}
