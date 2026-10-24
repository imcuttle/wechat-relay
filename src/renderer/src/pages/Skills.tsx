import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Radio, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { Pencil, Plus, Sparkles, Trash } from 'lucide-react';
import type { ChatSummary, SkillInfo } from '@shared/types';
import CodeEditor from '../components/CodeEditor';
import { errMsg, useRelay } from '../relay';

const skillKey = (s: SkillInfo) => `${s.scope}:${s.chat ?? ''}:${s.id}`;

function Settings() {
  const { config, saveConfig } = useRelay();
  if (!config) return null;
  return (
    <Card size="small" title="Skill 设置" style={{ marginBottom: 16 }}>
      <Space>启用<Switch checked={config.skillsEnabled} onChange={(on) => void saveConfig((c) => { c.skillsEnabled = on; })} /></Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '10px 0 0' }}>
        开启后，系统提示词会附带 skill 索引和全局 / 会话 skill 的路径说明（<code>~/.wechat-relay/skills</code>）；
        模型型智能体自动获得只限该目录的 Read / Write / Edit / Glob / Grep 和沙箱里的 Bash（家目录其他文件不可读、目录外不可写），Harness 用自己的同名工具。与「记忆」互相独立。
      </Typography.Paragraph>
    </Card>
  );
}

const skeleton = (id: string, description: string) => `---\nname: ${id}\ndescription: ${description}\n---\n\n## 何时使用\n\n## 步骤\n`;

function Skills() {
  const { message } = App.useApp();
  const { saveConfig } = useRelay();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [edit, setEdit] = useState<{ s: Pick<SkillInfo, 'id' | 'scope' | 'chat'>; text: string; isNew: boolean } | null>(null);
  const [form] = Form.useForm<{ id: string; scope: 'global' | 'session'; chat?: string; description: string }>();
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const [s, c] = await Promise.all([window.relay.listSkills(), window.relay.getChats()]);
    setSkills(s); setChats(c);
  }, []);
  useEffect(() => { void refresh().catch((e) => message.error(errMsg(e))); }, [refresh, message]);

  const toggle = (s: SkillInfo, enabled: boolean) => saveConfig((c) => {
    const hit = c.skills.find((x) => x.id === s.id && x.scope === s.scope && (s.scope === 'global' || x.chat === s.chat));
    if (hit) hit.enabled = enabled; else c.skills.push({ id: s.id, scope: s.scope, chat: s.chat, description: s.description, enabled });
  }).then(refresh);

  const open = async (s: SkillInfo) => setEdit({ s, text: await window.relay.readSkill(s.scope, s.chat, s.id), isNew: false });
  const saveSkill = async () => {
    if (!edit) return;
    try { await window.relay.writeSkill(edit.s.scope, edit.s.chat, edit.s.id, edit.text); setEdit(null); message.success('已保存'); await refresh(); }
    catch (e) { message.error(errMsg(e)); }
  };
  const create = async () => {
    const v = await form.validateFields();
    if (v.scope === 'session' && !v.chat) { form.setFields([{ name: 'chat', errors: ['请选择会话'] }]); return; }
    setCreating(false);
    setEdit({ s: { id: v.id, scope: v.scope, chat: v.scope === 'session' ? v.chat : undefined }, text: skeleton(v.id, v.description), isNew: true });
  };

  return (
    <Card size="small" title="Skill（SKILL.md）" extra={<Button type="primary" size="small" icon={<Plus size={14} />} onClick={() => { form.resetFields(); form.setFieldsValue({ scope: 'global' }); setCreating(true); }}>新增</Button>}>
      <Table<SkillInfo> size="small" rowKey={skillKey} pagination={false} dataSource={skills}
        locale={{ emptyText: '还没有 skill。新增，或让智能体在 ~/.wechat-relay/skills 下自己沉淀。' }}
        columns={[
          { title: '启用', width: 60, render: (_, s) => <Switch size="small" checked={s.enabled} onChange={(on) => void toggle(s, on)} /> },
          { title: 'ID', dataIndex: 'id', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
          { title: '范围', key: 'scope', render: (_, s) => (s.scope === 'global' ? <Tag color="blue">全局</Tag> : <Tag color="orange">会话 · {s.chat}</Tag>) },
          { title: '说明', dataIndex: 'description' },
          { title: '操作', key: 'ops', width: 100, align: 'right', render: (_, s) => (
            <Space size={4}>
              <Button size="small" type="text" icon={<Pencil size={14} />} onClick={() => void open(s)} />
              <Popconfirm title="删除这个 skill 的整个目录？" onConfirm={() => void window.relay.deleteSkill(s.scope, s.chat, s.id).then(refresh, (e) => message.error(errMsg(e)))}>
                <Button size="small" type="text" danger icon={<Trash size={14} />} />
              </Popconfirm>
            </Space>
          ) },
        ]} />
      <Modal open={creating} title="新增 Skill" onCancel={() => setCreating(false)} onOk={() => void create()} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="id" label="ID（目录名）" rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/, message: '仅字母数字下划线连字符' }]}><Input /></Form.Item>
          <Form.Item name="scope" label="范围"><Radio.Group optionType="button" options={[{ value: 'global', label: '全局' }, { value: 'session', label: '某个会话' }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.scope !== b.scope}>{() => form.getFieldValue('scope') === 'session' && (
            <Form.Item name="chat" label="会话"><Select showSearch options={chats.map((c) => ({ value: c.name, label: c.name }))} /></Form.Item>
          )}</Form.Item>
          <Form.Item name="description" label="一句话说明（何时使用）" rules={[{ required: true }]}><Input /></Form.Item>
        </Form>
      </Modal>
      <Modal open={!!edit} width={820} title={edit ? `${edit.s.id} · ${edit.s.scope === 'global' ? '全局' : `会话 ${edit.s.chat}`}` : ''} onCancel={() => setEdit(null)} onOk={() => void saveSkill()} okText="保存" destroyOnHidden>
        {edit && <CodeEditor language="markdown" height={440} value={edit.text} onChange={(t) => setEdit({ ...edit, text: t })} onSave={() => void saveSkill()} />}
      </Modal>
    </Card>
  );
}

export default function SkillsPage() {
  return (
    <div className="page">
      <div className="page-title"><h2><Sparkles size={18} />Skill</h2></div>
      <Settings />
      <Skills />
    </div>
  );
}
