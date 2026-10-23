import { useEffect, useState } from 'react';
import { Button, Empty, Input, Modal, Popconfirm, Radio, Space, Tabs, Typography } from 'antd';
import { Pencil, ThumbsDown, ThumbsUp, Trash } from 'lucide-react';
import type { Persona, PromptCase } from '@shared/types';

export type CaseKind = 'good' | 'bad';
export interface CaseDraft { kind: CaseKind; case: PromptCase; /** Index when editing an existing case. */ index?: number; from?: CaseKind }

export const KIND_LABEL: Record<CaseKind, string> = { good: '好例', bad: '反例' };
const listKey = (k: CaseKind): 'goodCases' | 'badCases' => (k === 'good' ? 'goodCases' : 'badCases');

/** Applies an added / edited case to the persona's lists. */
export function applyCase(p: Pick<Persona, 'goodCases' | 'badCases'> | null, d: CaseDraft): { goodCases: PromptCase[]; badCases: PromptCase[] } {
  const out = { goodCases: [...(p?.goodCases ?? [])], badCases: [...(p?.badCases ?? [])] };
  if (d.index !== undefined && d.from) out[listKey(d.from)].splice(d.index, 1);
  const list = out[listKey(d.kind)];
  if (d.index !== undefined && d.from === d.kind) list.splice(d.index, 0, d.case); else list.push(d.case);
  return out;
}

export function removeCase(p: Pick<Persona, 'goodCases' | 'badCases'>, kind: CaseKind, index: number) {
  const out = { goodCases: [...p.goodCases], badCases: [...p.badCases] };
  out[listKey(kind)].splice(index, 1);
  return out;
}

/** Edits one reply example (context / reply / note) and whether it is good or bad. */
export function CaseModal({ draft, onCancel, onSave }: { draft: CaseDraft | null; onCancel: () => void; onSave: (d: CaseDraft) => Promise<void> }) {
  const [d, setD] = useState<CaseDraft | null>(draft);
  const [busy, setBusy] = useState(false);
  useEffect(() => setD(draft), [draft]);
  const set = (c: Partial<PromptCase>) => setD((x) => (x ? { ...x, case: { ...x.case, ...c } } : x));
  const ok = async () => {
    if (!d) return;
    setBusy(true);
    try { await onSave(d); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!draft} title={draft?.index !== undefined ? '编辑示例' : '标注为示例'} onCancel={onCancel} onOk={() => void ok()} confirmLoading={busy}
      okButtonProps={{ disabled: !d?.case.reply.trim() }} width={620} destroyOnHidden>
      {d && (
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Radio.Group value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value })} optionType="button" buttonStyle="solid"
            options={[{ value: 'good', label: '好例：参照这样回复' }, { value: 'bad', label: '反例：避免这样回复' }]} />
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>之前的对话（每行「说话人: 内容」，可留空）</Typography.Text>
            <Input.TextArea value={d.case.context} onChange={(e) => set({ context: e.target.value })} autoSize={{ minRows: 2, maxRows: 10 }} />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.kind === 'good' ? '我的回复' : '不好的回复'}</Typography.Text>
            <Input.TextArea value={d.case.reply} onChange={(e) => set({ reply: e.target.value })} autoSize={{ minRows: 2, maxRows: 8 }} status={d.case.reply.trim() ? undefined : 'error'} />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.kind === 'good' ? '好在哪里' : '问题在哪'}（可选，会告诉模型）</Typography.Text>
            <Input value={d.case.note} onChange={(e) => set({ note: e.target.value })} placeholder={d.kind === 'good' ? '例如：先接住情绪再给建议，简短不说教' : '例如：太客套像客服；不该替我答应时间'} />
          </div>
        </Space>
      )}
    </Modal>
  );
}

function CaseList({ kind, list, onEdit, onRemove }: { kind: CaseKind; list: PromptCase[]; onEdit: (i: number) => void; onRemove: (i: number) => void }) {
  if (!list.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`还没有${KIND_LABEL[kind]}。在聊天记录里点「标注示例」勾选消息即可添加`} />;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={10}>
      {list.map((c, i) => (
        <div key={i} className="case-card">
          <Space style={{ float: 'right' }} size={0}>
            <Button size="small" type="text" icon={<Pencil size={13} />} onClick={() => onEdit(i)} />
            <Popconfirm title="删除这个示例？" onConfirm={() => onRemove(i)}><Button size="small" type="text" danger icon={<Trash size={13} />} /></Popconfirm>
          </Space>
          {c.context?.trim() && <div className="case-context">{c.context}</div>}
          <div className={`case-reply ${kind}`}>{c.reply}</div>
          {c.note?.trim() && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{kind === 'good' ? '好在：' : '问题：'}{c.note}</Typography.Text>}
          {c.at && <div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{new Date(c.at).toLocaleString()}</Typography.Text></div>}
        </div>
      ))}
    </Space>
  );
}

/** Good / bad examples of a chat's persona, with edit and delete. */
export function CasesModal({ open, persona, onClose, onEdit, onChange }: {
  open: boolean; persona: Persona | null; onClose: () => void;
  onEdit: (d: CaseDraft) => void; onChange: (next: { goodCases: PromptCase[]; badCases: PromptCase[] }) => Promise<void>;
}) {
  const good = persona?.goodCases ?? [], bad = persona?.badCases ?? [];
  const tab = (kind: CaseKind, list: PromptCase[]) => ({
    key: kind,
    label: <Space size={4}>{kind === 'good' ? <ThumbsUp size={13} /> : <ThumbsDown size={13} />}{KIND_LABEL[kind]} {list.length}</Space>,
    children: <CaseList kind={kind} list={list} onEdit={(i) => onEdit({ kind, from: kind, index: i, case: list[i] })} onRemove={(i) => void onChange(removeCase(persona!, kind, i))} />,
  });
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={680} title="回复示例">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        示例保存在本会话的人设提示词里（提示词页 {persona?.own ?? '—'}），会附在该会话所用人设的后面发给模型（切换成其他提示词也生效）；重新生成人设时也会参考它们。没有启用人设时示例不生效。
      </Typography.Paragraph>
      <Tabs items={[tab('good', good), tab('bad', bad)]} />
    </Modal>
  );
}
