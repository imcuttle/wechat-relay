import { useState } from 'react';
import { Alert, App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { FileCode, FolderOpen, Pencil, Play, Plus, Save, SquareTerminal, Trash } from 'lucide-react';
import { APP_IDS, APP_LABELS, type AppId, type ScriptConfig, type ScriptTestResult } from '@shared/types';
import CodeEditor from '../components/CodeEditor';
import { errMsg, useRelay } from '../relay';

interface Draft { script: ScriptConfig; code: string; isNew: boolean }

const parseDeps = (v: unknown): Record<string, string> => {
  const d = JSON.parse(String(v || '{}'));
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.values(d).some((x) => typeof x !== 'string')) throw new Error('依赖需要 { "包名": "版本" } 形式的 JSON');
  return d as Record<string, string>;
};

export default function Scripts() {
  const { config, saveConfig } = useRelay();
  const { message, modal } = App.useApp();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const scripts = config?.scripts ?? [];
  const usedBy = (id: string) => (config?.rules ?? []).filter((r) => r.action === 'script' && r.script === id);

  const edit = async (s: ScriptConfig | null) => {
    const script: ScriptConfig = s ?? { id: 'my-script', name: '', description: '', enabled: true, timeoutMs: 120000, dependencies: {} };
    const code = await window.relay.readScript(script.id).catch(() => '');
    form.resetFields();
    form.setFieldsValue({ ...script, dependencies: JSON.stringify(script.dependencies ?? {}, null, 2) });
    setDraft({ script, code, isNew: !s });
    if (s) void window.relay.scriptTypings(s.id).then(async (files) => (await import('../components/MonacoEditor')).setScriptTypings(files)).catch(() => undefined);
  };

  /** Writes the file (+ npm install) and the config entry. */
  const save = async (): Promise<ScriptConfig | null> => {
    if (!draft) return null;
    const v = await form.validateFields();
    let script: ScriptConfig;
    try {
      script = { ...draft.script, id: String(v.id), name: (v.name as string) || undefined, description: (v.description as string) || undefined, enabled: Boolean(v.enabled), timeoutMs: Number(v.timeoutMs), dependencies: parseDeps(v.dependencies) };
    } catch (e) { message.error(errMsg(e)); return null; }
    if (draft.isNew && scripts.some((x) => x.id === script.id)) { form.setFields([{ name: 'id', errors: ['ID 已存在'] }]); return null; }
    setSaving(true);
    const hide = message.loading(Object.keys(script.dependencies ?? {}).length ? '正在写入脚本并安装 npm 依赖…' : '正在写入脚本…', 0);
    try { await window.relay.writeScript(script, draft.code); } catch (e) {
      modal.error({ title: '保存前准备失败', width: 720, content: <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', fontSize: 12 }}>{errMsg(e)}</pre> });
      return null;
    } finally { hide(); setSaving(false); }
    await saveConfig((c) => {
      const i = c.scripts.findIndex((x) => x.id === draft.script.id);
      if (i >= 0 && !draft.isNew) c.scripts[i] = script; else c.scripts.push(script);
    });
    setDraft({ script, code: draft.code, isNew: false });
    void window.relay.scriptTypings(script.id).then(async (files) => (await import('../components/MonacoEditor')).setScriptTypings(files)).catch(() => undefined);
    return script;
  };

  const remove = (s: ScriptConfig) => saveConfig((c) => { c.scripts = c.scripts.filter((x) => x.id !== s.id); });

  return (
    <div className="page">
      <div className="page-title"><h2><FileCode size={18} />脚本</h2></div>
      <Alert style={{ marginBottom: 16 }} type="info" showIcon
        message="规则的动作选「脚本」，命中后新消息交给 TypeScript 脚本处理（不走 AI 回复）。脚本是 ~/.wechat-relay/scripts/<ID>/index.ts，在独立 Node 进程里运行：可 import 任意 Node 内置模块 / npm 包、读写文件、执行命令，并通过 api 发消息、调智能体、OCR、通知、持久化状态。这里和 VS Code 里都有完整的类型提示。" />
      <Card size="small" title="脚本列表" extra={<Button type="primary" size="small" icon={<Plus size={14} />} onClick={() => void edit(null)}>新增</Button>}>
        <Table<ScriptConfig>
          size="small" rowKey="id" pagination={false} dataSource={scripts}
          columns={[
            { title: '启用', dataIndex: 'enabled', width: 60, render: (v: boolean, r) => <Switch size="small" checked={v !== false} onChange={(on) => void saveConfig((c) => { c.scripts.find((x) => x.id === r.id)!.enabled = on; })} /> },
            { title: '脚本', key: 'name', render: (_, r) => <Space direction="vertical" size={0}><Typography.Text strong>{r.name || r.id}</Typography.Text><Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{r.id}</Typography.Text></Space> },
            { title: '说明', dataIndex: 'description' },
            { title: '依赖', key: 'deps', render: (_, r) => <span className="mono">{Object.entries(r.dependencies ?? {}).map(([k, v]) => `${k}@${v}`).join(' ') || '—'}</span> },
            { title: '被规则使用', key: 'rules', render: (_, r) => usedBy(r.id).map((x) => <Tag key={x.id} color={x.enabled ? 'green' : 'default'}>{x.name || x.id}</Tag>) },
            {
              title: '操作', key: 'ops', width: 200, align: 'right', render: (_, r) => (
                <Space size={4}>
                  <Button size="small" type="text" icon={<SquareTerminal size={14} />} title="在 VS Code 中打开" onClick={() => void window.relay.openScript(r.id, 'vscode').catch((e) => message.error(errMsg(e)))} />
                  <Button size="small" type="text" icon={<FolderOpen size={14} />} title="打开文件夹" onClick={() => void window.relay.openScript(r.id, 'folder').catch((e) => message.error(errMsg(e)))} />
                  <Button size="small" type="text" icon={<Pencil size={14} />} onClick={() => void edit(r)} />
                  <Popconfirm title="删除脚本？文件仍保留在磁盘上" description={usedBy(r.id).length ? `有 ${usedBy(r.id).length} 条规则在使用它，删除后这些规则不再生效` : undefined} onConfirm={() => void remove(r)}>
                    <Button size="small" type="text" danger icon={<Trash size={14} />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={!!draft} title={draft?.isNew ? '新增脚本' : `编辑脚本 · ${draft?.script.id}`} width={1040} destroyOnHidden
        onCancel={() => setDraft(null)}
        footer={(
          <Space>
            {draft && !draft.isNew && <Button icon={<SquareTerminal size={14} />} onClick={() => void window.relay.openScript(draft.script.id, 'vscode').catch((e) => message.error(errMsg(e)))}>在 VS Code 中打开</Button>}
            <Button onClick={() => setDraft(null)}>关闭</Button>
            <Button type="primary" icon={<Save size={14} />} loading={saving} onClick={() => void save()}>保存</Button>
          </Space>
        )}
      >
        {draft && (
          <>
            <Form form={form} layout="vertical" preserve={false}>
              <Space style={{ display: 'flex' }} align="start" wrap>
                <Form.Item name="id" label="ID（文件夹名）" rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/, message: '仅字母数字下划线连字符' }]}><Input style={{ width: 200 }} disabled={!draft.isNew} /></Form.Item>
                <Form.Item name="name" label="名称"><Input style={{ width: 220 }} /></Form.Item>
                <Form.Item name="timeoutMs" label="超时(ms)"><InputNumber min={1000} step={5000} /></Form.Item>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
              </Space>
              <Form.Item name="description" label="说明"><Input /></Form.Item>
              <Form.Item name="dependencies" label="npm 依赖（package.json 的 dependencies，建议锁定版本）" extra="保存时在脚本文件夹里执行 npm install（同时安装 @types/node 供 VS Code 提示）；Node 内置模块直接 import 即可"
                rules={[{ validator: (_, v) => { try { parseDeps(v); return Promise.resolve(); } catch (e) { return Promise.reject(e); } } }]}>
                <CodeEditor language="json" height={70} />
              </Form.Item>
            </Form>
            <Typography.Text strong>index.ts</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>⌘S 保存 · 类型来自 relay.d.ts：输入 <code>ev.</code> / <code>api.</code> 查看全部能力</Typography.Text>
            <div style={{ marginTop: 6 }}>
              <CodeEditor language="typescript" path={`file:///scripts/${draft.script.id}/index.ts`} height={380} value={draft.code}
                onChange={(code) => setDraft((d) => (d ? { ...d, code } : d))} onSave={() => void save()} />
            </div>
            <TestPanel getScript={save} />
          </>
        )}
      </Modal>
    </div>
  );
}

/** Runs the script with a made-up message (dry run by default: api.send is skipped, the script sees ev.dryRun = true). */
function TestPanel({ getScript }: { getScript: () => Promise<ScriptConfig | null> }) {
  const { message } = App.useApp();
  const [req, setReq] = useState<{ app: AppId; chat: string; isGroup: boolean; sender: string; text: string; dryRun: boolean }>({
    app: 'wecom', chat: '张三', isGroup: false, sender: '', text: 'https://example.com/team/repo/-/pulls/123 帮忙看一下', dryRun: true,
  });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ScriptTestResult | null>(null);
  const run = async () => {
    const s = await getScript();
    if (!s) return;
    setRunning(true);
    try { setResult(await window.relay.testScript({ id: s.id, ...req })); } catch (e) { message.error(errMsg(e)); } finally { setRunning(false); }
  };
  return (
    <Card size="small" style={{ marginTop: 12 }} title="试运行（会先保存）">
      <Space style={{ display: 'flex' }} align="start" wrap>
        <Select style={{ width: 120 }} value={req.app} onChange={(app) => setReq({ ...req, app })} options={APP_IDS.map((id) => ({ value: id, label: APP_LABELS[id] }))} />
        <Input style={{ width: 200 }} value={req.chat} onChange={(e) => setReq({ ...req, chat: e.target.value })} placeholder="会话名" />
        <Space size={4}>群聊<Switch size="small" checked={req.isGroup} onChange={(isGroup) => setReq({ ...req, isGroup })} /></Space>
        {req.isGroup && <Input style={{ width: 140 }} value={req.sender} onChange={(e) => setReq({ ...req, sender: e.target.value })} placeholder="发送者" />}
        <Space size={4}>试运行（不真正发送）<Switch size="small" checked={req.dryRun} onChange={(dryRun) => setReq({ ...req, dryRun })} /></Space>
        <Button type="primary" icon={<Play size={14} />} loading={running} onClick={() => void run()}>运行</Button>
      </Space>
      <Input.TextArea style={{ marginTop: 8 }} rows={2} value={req.text} onChange={(e) => setReq({ ...req, text: e.target.value })} placeholder="消息内容" />
      {!req.dryRun && <Alert style={{ marginTop: 8 }} type="warning" showIcon message="已关闭试运行：脚本会真的执行（approve、发送消息等）" />}
      {result && (
        <div style={{ marginTop: 8 }}>
          <Tag color={result.ok ? 'success' : 'error'}>{result.ok ? '成功' : '失败'}</Tag><span style={{ color: '#888', fontSize: 12 }}>{result.ms}ms</span>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', fontSize: 12, background: '#fafafa', padding: 8, borderRadius: 6, marginTop: 6 }}>
            {[...result.logs, result.ok ? result.result && `→ ${result.result}` : `✗ ${result.error}`].filter(Boolean).join('\n') || '（没有输出）'}
          </pre>
        </div>
      )}
    </Card>
  );
}
