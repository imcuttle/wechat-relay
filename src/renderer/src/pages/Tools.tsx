import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Modal, Space, Switch, Tag, Typography } from 'antd';
import { Plug, Wrench } from 'lucide-react';
import type { McpServerConfig, ToolConfig } from '@shared/types';
import CodeEditor from '../components/CodeEditor';
import ConfigList, { kvToText, linesToList, listToLines, textToKv } from '../components/ConfigList';
import { errMsg, useRelay } from '../relay';

export default function Tools() {
  const { saveConfig } = useRelay();
  const { message } = App.useApp();
  const [mcpTools, setMcpTools] = useState<{ id: string; tools: Array<{ name: string; description?: string }> } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const inspect = async (id: string) => {
    setLoading(id);
    try { setMcpTools({ id, tools: await window.relay.listMcpTools(id) }); } catch (e) { message.error(errMsg(e)); } finally { setLoading(null); }
  };

  return (
    <div className="page">
      <div className="page-title"><h2><Wrench size={18} />工具 / MCP</h2></div>
      <ConfigList
        listKey="tools"
        title="自定义命令工具"
        columns={[
          { title: 'ID', dataIndex: 'id', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
          { title: '描述', dataIndex: 'description' },
          { title: '命令', dataIndex: 'command', render: (v: string) => <span className="mono">{v}</span> },
        ]}
        defaults={() => ({ id: 'my_tool', description: '', command: 'echo {{text}}', timeoutMs: 15000, parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } })}
        toForm={(t) => ({ ...t, parameters: JSON.stringify(t.parameters, null, 2) })}
        fromForm={(v, prev): ToolConfig => ({ ...(prev ?? {}), ...(v as unknown as ToolConfig), parameters: JSON.parse(String(v.parameters)), cwd: (v.cwd as string) || undefined })}
        modalWidth={720}
        form={() => (
          <>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="工具名（模型看到的函数名）" rules={[{ required: true, pattern: /^[a-zA-Z0-9_-]+$/, message: '仅字母数字下划线' }]}><Input style={{ width: 220 }} /></Form.Item>
              <Form.Item name="timeoutMs" label="超时(ms)"><InputNumber min={1000} step={1000} /></Form.Item>
            </Space>
            <Form.Item name="description" label="描述（告诉模型何时使用）" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="command" label="Shell 命令" tooltip="{{参数名}} 会被替换为 shell 转义后的参数值；完整参数 JSON 在环境变量 $TOOL_ARGS；stdout 返回给模型" rules={[{ required: true }]}>
              <CodeEditor language="shell" height={70} />
            </Form.Item>
            <Form.Item name="parameters" label="参数 JSON Schema" rules={[{ validator: (_, v) => { try { JSON.parse(v); return Promise.resolve(); } catch { return Promise.reject(new Error('不是有效 JSON')); } } }]}>
              <CodeEditor language="json" height={200} />
            </Form.Item>
            <Form.Item name="cwd" label="工作目录"><Input /></Form.Item>
          </>
        )}
      />
      <ConfigList
        listKey="mcpServers"
        title="MCP 服务（在智能体中以 mcp:<id> 引用）"
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
