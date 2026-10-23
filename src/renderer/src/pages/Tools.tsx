import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, InputNumber, Modal, Radio, Space, Switch, Table, Tag, Typography } from 'antd';
import { Braces, Plug, Wrench } from 'lucide-react';
import { BUILTIN_TOOLS, builtinEnabled, SCRIPT_TOOL_TEMPLATE, type BuiltinToolMeta } from '@shared/builtins';
import { fromMcpJson, toMcpJson } from '@shared/mcpJson';
import type { McpServerConfig, ToolConfig } from '@shared/types';
import CodeEditor from '../components/CodeEditor';
import ConfigList, { kvToText, linesToList, listToLines, textToKv } from '../components/ConfigList';
import { errMsg, useRelay } from '../relay';

function McpJsonEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { config, saveConfig } = useRelay();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open && config) { setText(toMcpJson(config.mcpServers)); setError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = (t: string) => { try { fromMcpJson(t); setError(null); } catch (e) { setError((e as Error).message); } };
  const save = async () => {
    let servers: McpServerConfig[];
    try { servers = fromMcpJson(text); } catch (e) { setError((e as Error).message); return; }
    await saveConfig((c) => { c.mcpServers = servers; });
    onClose();
  };
  return (
    <Modal open={open} title="以 JSON 编辑 MCP 服务" width={760} onCancel={onClose} onOk={() => void save()} okText="保存" okButtonProps={{ disabled: !!error }} destroyOnHidden>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        与 Claude Code / Cursor / CodeBuddy 的 <code>mcpServers</code> 格式兼容，可直接粘贴。stdio 用 <code>command</code> + <code>args</code> + <code>env</code>，
        HTTP / SSE 用 <code>url</code> + <code>headers</code>；<code>"disabled": true</code> 表示停用。保存会替换整个列表。
      </Typography.Paragraph>
      <CodeEditor language="json" height={420} value={text} onChange={(t) => { setText(t); check(t); }} onSave={() => void save()} />
      {error && <Alert style={{ marginTop: 8 }} type="error" showIcon message={error} />}
    </Modal>
  );
}

export default function Tools() {
  const { config, saveConfig } = useRelay();
  const { message } = App.useApp();
  const [mcpTools, setMcpTools] = useState<{ id: string; tools: Array<{ name: string; description?: string }> } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);

  const inspect = async (id: string) => {
    setLoading(id);
    try { setMcpTools({ id, tools: await window.relay.listMcpTools(id) }); } catch (e) { message.error(errMsg(e)); } finally { setLoading(null); }
  };

  return (
    <div className="page">
      <div className="page-title"><h2><Wrench size={18} />工具 / MCP</h2></div>
      <Card size="small" style={{ marginBottom: 16 }}
        title={<Space>内置工具<Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>启用后还需在智能体中勾选才会使用</Typography.Text></Space>}>
        <Table<BuiltinToolMeta>
          size="small" rowKey="id" pagination={false} dataSource={BUILTIN_TOOLS}
          columns={[
            { title: '启用', key: 'on', width: 60, render: (_, b) => <Switch size="small" checked={builtinEnabled(config?.builtinTools, b.id)} onChange={(on) => void saveConfig((c) => { c.builtinTools = { ...c.builtinTools, [b.id]: on }; })} /> },
            { title: 'ID', dataIndex: 'id', render: (v: string) => <Typography.Text strong className="mono">{v}</Typography.Text> },
            { title: '说明', key: 'label', render: (_, b) => <Space>{b.label}{b.danger && <Tag color="red">高风险</Tag>}</Space> },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
          文件与 Shell 工具的相对路径基于 <code>~/.wechat-relay/workspace</code>。聊天对象可能诱导模型调用这些工具（读取隐私文件、执行命令），只给可信会话的智能体开启。
        </Typography.Paragraph>
      </Card>
      <ConfigList
        listKey="tools"
        title="自定义工具（Shell 命令 / TypeScript）"
        columns={[
          { title: '启用', dataIndex: 'enabled', width: 60, render: (v: boolean, r) => <Switch size="small" checked={v !== false} onChange={(on) => void saveConfig((c) => { c.tools.find((x) => x.id === r.id)!.enabled = on; })} /> },
          { title: 'ID', dataIndex: 'id', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
          { title: '类型', dataIndex: 'type', width: 100, render: (v: string) => v === 'script' ? <Tag color="blue">TypeScript</Tag> : <Tag color="green">命令</Tag> },
          { title: '描述', dataIndex: 'description' },
          { title: '实现', key: 'impl', render: (_, t) => t.type === 'script'
            ? <span className="mono">{Object.entries(t.dependencies ?? {}).map(([k, v]) => `${k}@${v}`).join(' ') || '(无依赖)'}</span>
            : <span className="mono">{t.command}</span> },
        ]}
        defaults={(): Partial<ToolConfig> => ({ id: 'my_tool', type: 'script', enabled: true, description: '', code: SCRIPT_TOOL_TEMPLATE, dependencies: {}, command: 'echo {{text}}', timeoutMs: 15000, parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } })}
        toForm={(t) => ({
          ...t, type: t.type ?? 'command', enabled: t.enabled !== false, parameters: JSON.stringify(t.parameters, null, 2),
          code: t.code || SCRIPT_TOOL_TEMPLATE, dependencies: JSON.stringify(t.dependencies ?? {}, null, 2),
        })}
        fromForm={(v, prev): ToolConfig => {
          const t: ToolConfig = {
            ...(prev ?? {}), ...(v as unknown as ToolConfig),
            enabled: Boolean(v.enabled ?? true), parameters: JSON.parse(String(v.parameters)), cwd: (v.cwd as string) || undefined,
          };
          if (t.type === 'script') { t.dependencies = JSON.parse(String(v.dependencies || '{}')); delete t.command; }
          else { delete t.code; delete t.dependencies; }
          return t;
        }}
        beforeSave={async (t) => {
          if (t.type !== 'script') return;
          const hide = message.loading(Object.keys(t.dependencies ?? {}).length ? '正在安装 npm 依赖…' : '正在写入工具代码…', 0);
          try { await window.relay.prepareTool(t); } finally { hide(); }
        }}
        modalWidth={860}
        form={(form) => (
          <>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="工具名（模型看到的函数名）" rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/, message: '仅字母数字下划线' }]}><Input style={{ width: 220 }} /></Form.Item>
              <Form.Item name="type" label="类型"><Radio.Group optionType="button" options={[{ value: 'script', label: 'TypeScript' }, { value: 'command', label: 'Shell 命令' }]} /></Form.Item>
              <Form.Item name="timeoutMs" label="超时(ms)"><InputNumber min={1000} step={1000} /></Form.Item>
              <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </Space>
            <Form.Item name="description" label="描述（告诉模型何时使用）" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item noStyle shouldUpdate={(a, b) => a.type !== b.type}>{() => form.getFieldValue('type') === 'script' ? (
              <>
                <Form.Item preserve name="code" label="TypeScript 代码" tooltip="export default async (args, ctx) => 结果；在独立 Node 进程中运行（Node 24，原生类型擦除），console 输出仅在出错时附带" rules={[{ required: true }]}>
                  <CodeEditor language="typescript" height={300} />
                </Form.Item>
                <Form.Item preserve name="dependencies" label="npm 依赖（package.json 的 dependencies，建议锁定版本）"
                  extra="保存时在 ~/.wechat-relay/tools/<ID>/ 中执行 npm install，依赖未变化时跳过"
                  rules={[{ validator: (_, v) => {
                    try {
                      const d = JSON.parse(v || '{}');
                      if (!d || typeof d !== 'object' || Array.isArray(d) || Object.values(d).some((x) => typeof x !== 'string')) throw new Error();
                      return Promise.resolve();
                    } catch { return Promise.reject(new Error('需要 { "包名": "版本" } 形式的 JSON')); }
                  } }]}>
                  <CodeEditor language="json" height={90} />
                </Form.Item>
              </>
            ) : (
              <Form.Item preserve name="command" label="Shell 命令" tooltip="{{参数名}} 会被替换为 shell 转义后的参数值；完整参数 JSON 在环境变量 $TOOL_ARGS；stdout 返回给模型" rules={[{ required: true }]}>
                <CodeEditor language="shell" height={70} />
              </Form.Item>
            )}</Form.Item>
            <Form.Item name="parameters" label="参数 JSON Schema" rules={[{ validator: (_, v) => { try { JSON.parse(v); return Promise.resolve(); } catch { return Promise.reject(new Error('不是有效 JSON')); } } }]}>
              <CodeEditor language="json" height={160} />
            </Form.Item>
            <Form.Item name="cwd" label="工作目录" tooltip="TypeScript 工具默认为工具目录"><Input /></Form.Item>
          </>
        )}
      />
      <ConfigList
        listKey="mcpServers"
        title="MCP 服务（在智能体中以 mcp:<id> 引用）"
        extra={<Button size="small" icon={<Braces size={14} />} onClick={() => setJsonOpen(true)}>JSON 编辑</Button>}
        columns={[
          { title: '启用', dataIndex: 'enabled', width: 60, render: (v: boolean, r) => <Switch size="small" checked={v} onChange={(on) => void saveConfig((c) => { c.mcpServers.find((x) => x.id === r.id)!.enabled = on; })} /> },
          { title: 'ID', dataIndex: 'id', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
          { title: '传输', key: 't', render: (_, s) => <Tag color={s.url ? 'geekblue' : 'green'}>{s.url ? 'HTTP' : 'stdio'}</Tag> },
          { title: '命令 / URL', key: 'c', render: (_, s) => <span className="mono">{s.url ?? [s.command, ...(s.args ?? [])].join(' ')}</span> },
        ]}
        extraActions={(s) => <Button size="small" type="text" icon={<Plug size={14} />} loading={loading === s.id} onClick={() => void inspect(s.id)}>测试</Button>}
        defaults={() => ({ id: 'mcp', enabled: true, command: 'npx', args: [] })}
        toForm={(s) => ({ ...s, args: listToLines(s.args), env: kvToText(s.env), headers: kvToText(s.headers) })}
        fromForm={(v, prev): McpServerConfig => ({
          ...(prev ?? {}), id: String(v.id), enabled: Boolean(v.enabled ?? true),
          command: (v.command as string) || undefined, args: linesToList(v.args), env: textToKv(v.env),
          url: (v.url as string) || undefined, headers: textToKv(v.headers),
        })}
        form={() => (
          <>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input style={{ width: 200 }} /></Form.Item>
              <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </Space>
            <Typography.Text type="secondary">stdio：填写命令和参数；HTTP：只填 URL</Typography.Text>
            <Form.Item name="command" label="命令" style={{ marginTop: 8 }}><Input placeholder="npx / uvx / node" /></Form.Item>
            <Form.Item name="args" label="参数（每行一个）"><Input.TextArea rows={3} className="mono" /></Form.Item>
            <Form.Item name="env" label="环境变量（KEY=value）"><Input.TextArea rows={2} className="mono" /></Form.Item>
            <Form.Item name="url" label="URL（Streamable HTTP / SSE）"><Input /></Form.Item>
            <Form.Item name="headers" label="请求头（key=value）"><Input.TextArea rows={2} className="mono" /></Form.Item>
          </>
        )}
      />
      <McpJsonEditor open={jsonOpen} onClose={() => setJsonOpen(false)} />
      <Modal open={!!mcpTools} title={`MCP ${mcpTools?.id} 提供的工具`} footer={null} onCancel={() => setMcpTools(null)} width={640}>
        {mcpTools?.tools.map((t) => (
          <div key={t.name} style={{ padding: '6px 0', borderBottom: '1px solid #f5f5f5' }}>
            <Typography.Text strong className="mono">{t.name}</Typography.Text>
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{t.description}</Typography.Text></div>
          </div>
        ))}
      </Modal>
    </div>
  );
}
