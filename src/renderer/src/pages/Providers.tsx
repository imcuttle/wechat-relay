import { Alert, Form, Input, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd';
import { Cpu } from 'lucide-react';
import type { HarnessConfig, ProviderConfig } from '@shared/types';
import ConfigList, { kvToText, linesToList, listToLines, textToKv } from '../components/ConfigList';

const PRESETS: Record<string, { baseUrl: string; type: ProviderConfig['type'] }> = {
  DeepSeek: { baseUrl: 'https://api.deepseek.com/v1', type: 'openai' },
  OpenAI: { baseUrl: 'https://api.openai.com/v1', type: 'openai' },
  Anthropic: { baseUrl: 'https://api.anthropic.com', type: 'anthropic' },
  '通义千问': { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', type: 'openai' },
  'Kimi': { baseUrl: 'https://api.moonshot.cn/v1', type: 'openai' },
  '智谱 GLM': { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', type: 'openai' },
  OpenRouter: { baseUrl: 'https://openrouter.ai/api/v1', type: 'openai' },
  Ollama: { baseUrl: 'http://127.0.0.1:11434/v1', type: 'openai' },
};

const mask = (k: string) => (k.startsWith('${') ? <Tag>{k}</Tag> : k ? `${k.slice(0, 4)}••••${k.slice(-4)}` : <Typography.Text type="danger">未设置</Typography.Text>);

export default function Providers() {
  return (
    <div className="page">
      <div className="page-title"><h2><Cpu size={18} />模型服务 / Harness</h2></div>
      <ConfigList
        listKey="providers"
        title="模型服务（OpenAI 兼容 / Anthropic）"
        columns={[
          { title: 'ID', dataIndex: 'id', render: (v: string, r) => <Typography.Text strong>{r.name || v}</Typography.Text> },
          { title: '协议', dataIndex: 'type', render: (v: string) => <Tag color={v === 'anthropic' ? 'orange' : 'blue'}>{v}</Tag> },
          { title: 'Base URL', dataIndex: 'baseUrl', render: (v: string) => <span className="mono">{v}</span> },
          { title: 'API Key', dataIndex: 'apiKey', render: mask },
        ]}
        defaults={() => ({ id: 'provider', type: 'openai' as const, baseUrl: 'https://api.openai.com/v1', apiKey: '' })}
        toForm={(p) => ({ ...p, headers: kvToText(p.headers) })}
        fromForm={(v, prev): ProviderConfig => ({ ...(prev ?? {}), ...(v as unknown as ProviderConfig), headers: textToKv(v.headers) })}
        form={(form) => (
          <>
            <Form.Item label="快速填充">
              <Space size={[4, 4]} wrap>
                {Object.entries(PRESETS).map(([name, p]) => (
                  <Tag.CheckableTag key={name} checked={false} onChange={() => form.setFieldsValue({ ...p, id: form.getFieldValue('id') === 'provider' ? name.toLowerCase().replace(/\s+/g, '-') : form.getFieldValue('id') })}>{name}</Tag.CheckableTag>
                ))}
              </Space>
            </Form.Item>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input style={{ width: 180 }} /></Form.Item>
              <Form.Item name="name" label="名称"><Input style={{ width: 180 }} /></Form.Item>
              <Form.Item name="type" label="协议"><Select style={{ width: 200 }} options={[{ value: 'openai', label: 'OpenAI 兼容' }, { value: 'anthropic', label: 'Anthropic Messages' }]} /></Form.Item>
            </Space>
            <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="apiKey" label="API Key" tooltip="可写 ${ENV_NAME} 引用环境变量，避免明文保存"><Input.Password /></Form.Item>
            <Form.Item name="headers" label="额外请求头（每行 key=value）"><Input.TextArea rows={2} className="mono" /></Form.Item>
          </>
        )}
      />

      <Alert style={{ marginBottom: 16 }} type="warning" showIcon
        message="Harness 会把微信消息交给 CLI 智能体处理。陌生人的消息可能包含恶意指令：不要给 harness 配置 -y / bypassPermissions 等跳过权限的参数，除非你清楚风险。" />
      <ConfigList
        listKey="harnesses"
        title="Harness（CodeBuddy CLI / Claude Code / 任意命令）"
        columns={[
          { title: 'ID', dataIndex: 'id', render: (v: string, r) => <Typography.Text strong>{r.name || v}</Typography.Text> },
          { title: '类型', dataIndex: 'type', render: (v: string) => <Tag color="purple">{v}</Tag> },
          { title: '命令', key: 'cmd', render: (_, h) => <span className="mono">{[h.command, ...h.args].join(' ')}</span> },
          { title: '模型', dataIndex: 'model', render: (v?: string) => v || '默认' },
          { title: '会话', dataIndex: 'sessionPerChat', render: (v: boolean) => (v ? '每个微信会话独立' : '无状态') },
        ]}
        defaults={() => ({ id: 'harness', type: 'codebuddy' as const, command: 'codebuddy', args: [], timeoutMs: 180000, sessionPerChat: true, passMcpServers: true })}
        toForm={(h) => ({ ...h, args: listToLines(h.args), env: kvToText(h.env) })}
        fromForm={(v, prev): HarnessConfig => ({ ...(prev ?? {}), ...(v as unknown as HarnessConfig), args: linesToList(v.args), env: textToKv(v.env), model: (v.model as string) || undefined, cwd: (v.cwd as string) || undefined })}
        form={(form) => (
          <>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input style={{ width: 160 }} /></Form.Item>
              <Form.Item name="type" label="类型">
                <Select style={{ width: 160 }} onChange={(t) => form.setFieldValue('command', t === 'codebuddy' ? 'codebuddy' : t === 'claude-code' ? 'claude' : '')}
                  options={[{ value: 'codebuddy', label: 'CodeBuddy CLI' }, { value: 'claude-code', label: 'Claude Code' }, { value: 'command', label: '自定义命令' }]} />
              </Form.Item>
              <Form.Item name="command" label="可执行文件" rules={[{ required: true }]}><Input style={{ width: 240 }} /></Form.Item>
            </Space>
            <Form.Item noStyle shouldUpdate>{() => form.getFieldValue('type') === 'command' && (
              <Alert style={{ marginBottom: 12 }} type="info" message="自定义命令：系统提示词 + 聊天记录通过 stdin 传入，stdout 作为回复；参数中可用 {{chat}} {{system}} {{model}}。" />
            )}</Form.Item>
            <Form.Item noStyle shouldUpdate={(x, y) => x.type !== y.type}>{() => {
              const cli = form.getFieldValue('type') !== 'command';
              return (
                <Space style={{ display: 'flex' }} align="start">
                  <Form.Item name="model" label={cli ? '模型（--model）' : '模型（参数中的 {{model}}）'}><Input style={{ width: 200 }} placeholder="默认" /></Form.Item>
                  <Form.Item name="timeoutMs" label="超时(ms)"><InputNumber min={5000} step={5000} /></Form.Item>
                  {cli && <Form.Item name="sessionPerChat" label="每个会话保持上下文" valuePropName="checked" tooltip="开启后用 --session-id / --resume 让每个微信会话在 harness 中有独立上下文"><Switch /></Form.Item>}
                  {cli && <Form.Item name="passMcpServers" label="传递 MCP 配置" valuePropName="checked" tooltip="把智能体选中的 mcp:* 服务通过 --mcp-config 传给 harness"><Switch /></Form.Item>}
                </Space>
              );
            }}</Form.Item>
            <Form.Item name="args" label="额外参数（每行一个）" tooltip="例如 --tools 与 Read,WebSearch 各占一行；--allowedTools；--agent xxx"><Input.TextArea rows={3} className="mono" /></Form.Item>
            <Form.Item name="cwd" label="工作目录" tooltip="默认 ~/.wechat-relay/harness/<id>"><Input /></Form.Item>
            <Form.Item name="env" label="环境变量（每行 KEY=value）"><Input.TextArea rows={2} className="mono" /></Form.Item>
          </>
        )}
      />
    </div>
  );
}
