import { Alert, Button, Collapse, Form, Input, Space, Tag, Typography } from 'antd';
import { FileText, Plus, Trash } from 'lucide-react';
import { promptText } from '@shared/prompt';
import type { PromptCase, PromptConfig } from '@shared/types';
import CodeEditor from '../components/CodeEditor';
import ConfigList from '../components/ConfigList';

/** Keeps a value in the form without an input (where an example was marked). */
const Keep = (_: { value?: unknown }) => null;

function CaseFields({ name, kind }: { name: 'goodCases' | 'badCases'; kind: 'good' | 'bad' }) {
  const good = kind === 'good';
  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          {fields.map((f, i) => (
            <div key={f.key} className="case-card">
              <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 4 }}>
                <Typography.Text strong style={{ fontSize: 12 }}>{good ? '好例' : '反例'} {i + 1}</Typography.Text>
                <Button size="small" type="text" danger icon={<Trash size={13} />} onClick={() => remove(f.name)} />
              </Space>
              <Form.Item name={[f.name, 'context']} label="之前的对话" tooltip="每行「说话人: 内容」，可留空" style={{ marginBottom: 6 }}>
                <Input.TextArea autoSize={{ minRows: 1, maxRows: 8 }} placeholder={'小王: 周末去爬山不\n我: 看天气'} />
              </Form.Item>
              <Form.Item name={[f.name, 'reply']} label={good ? '我的回复' : '不好的回复'} rules={[{ required: true, whitespace: true, message: '请填写回复' }]} style={{ marginBottom: 6 }}>
                <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} />
              </Form.Item>
              <Form.Item name={[f.name, 'note']} label={good ? '好在哪里' : '问题在哪'} style={{ marginBottom: 0 }}>
                <Input placeholder="可选，会告诉模型" />
              </Form.Item>
              {(['chat', 'ids', 'at'] as const).map((k) => <Form.Item key={k} name={[f.name, k]} hidden noStyle><Keep /></Form.Item>)}
            </div>
          ))}
          <Button size="small" icon={<Plus size={14} />} onClick={() => add({ context: '', reply: '', note: '' } satisfies PromptCase)}>添加{good ? '好例' : '反例'}</Button>
        </Space>
      )}
    </Form.List>
  );
}

export default function Prompts() {
  return (
    <div className="page">
      <div className="page-title"><h2><FileText size={18} />提示词</h2></div>
      <Alert style={{ marginBottom: 16 }} type="info" showIcon message={
        <span>
          模板变量：<code>{'{{chat}}'}</code> 会话名、<code>{'{{sender}}'}</code> 最新消息发送者、<code>{'{{myNickname}}'}</code> 我的昵称、<code>{'{{now}}'}</code> 今天的日期和星期（精确到秒的时间会附在最新消息前，让提示词保持不变以命中模型的提示词缓存）；
          条件块：<code>{'{{#group}}群聊时显示{{/group}}'}</code>、<code>{'{{^group}}私聊时显示{{/group}}'}</code>。模型输出 <code>[SKIP]</code> 表示不回复。以 <code>persona-</code> 开头的是「会话记录 → 人设」生成的会话人设，启用后替换该会话智能体的提示词，在这里修改同样生效。
          好例 / 反例会按固定格式追加在正文后面；会话人设的示例也可以在「会话记录」里勾选消息标注。
        </span>
      } />
      <ConfigList
        listKey="prompts"
        title="提示词模板"
        columns={[
          { title: 'ID', dataIndex: 'id', width: 160, render: (v: string, r) => <Typography.Text strong>{r.name || v}</Typography.Text> },
          { title: '内容', dataIndex: 'content', render: (v: string) => <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0 }}>{v || <Typography.Text type="secondary">（空）</Typography.Text>}</Typography.Paragraph> },
          {
            title: '示例', key: 'cases', width: 110,
            render: (_, r) => <Space size={4}>{!!r.goodCases?.length && <Tag color="green">好 {r.goodCases.length}</Tag>}{!!r.badCases?.length && <Tag color="red">反 {r.badCases.length}</Tag>}{!r.goodCases?.length && !r.badCases?.length && '-'}</Space>,
          },
        ]}
        defaults={() => ({ id: `prompt-${Date.now().toString(36)}`, content: '' })}
        modalWidth={820}
        fromForm={(v, prev): PromptConfig => {
          const clean = (l?: PromptCase[]) => { const x = (l ?? []).filter((c) => c?.reply?.trim()); return x.length ? x : undefined; };
          const p = { ...(prev ?? {}), ...v } as PromptConfig;
          return { ...p, goodCases: clean(p.goodCases), badCases: clean(p.badCases) };
        }}
        form={(form) => (
          <>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input style={{ width: 260 }} /></Form.Item>
              <Form.Item name="name" label="名称"><Input style={{ width: 300 }} /></Form.Item>
            </Space>
            <Form.Item name="content" label="正文"><CodeEditor language="markdown" height={300} /></Form.Item>
            <Form.Item label="好例（参照这样回复）" tooltip="让模型参照语气、长度和处理方式，不会照抄原话"><CaseFields name="goodCases" kind="good" /></Form.Item>
            <Form.Item label="反例（避免这样回复）"><CaseFields name="badCases" kind="bad" /></Form.Item>
            <Form.Item noStyle shouldUpdate>{() => (
              <Collapse size="small" items={[{
                key: 'preview', label: '预览最终提示词（变量替换前）',
                children: <pre className="mono debug-block" style={{ maxHeight: 360, overflow: 'auto' }}>{promptText(form.getFieldsValue(true) as PromptConfig) || '（空）'}</pre>,
              }]} />
            )}</Form.Item>
          </>
        )}
      />
    </div>
  );
}
