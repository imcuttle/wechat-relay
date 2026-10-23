import { useState } from 'react';
import { App, Button, Card, Col, Form, Input, InputNumber, Row, Select, Space, Switch, Tag, Typography } from 'antd';
import { Bot, Play, Plus, Trash } from 'lucide-react';
import { BUILTIN_TOOLS, builtinEnabled } from '@shared/builtins';
import type { AgentConfig, TestAgentResult } from '@shared/types';
import CodeEditor from '../components/CodeEditor';
import ConfigList from '../components/ConfigList';
import { errMsg, useRelay } from '../relay';

const OFF = '（未启用）';

export default function Agents() {
  const { config } = useRelay();
  if (!config) return null;
  const toolOptions = [
    { label: '内置', options: BUILTIN_TOOLS.map((b) => ({ value: b.id, label: `${b.label} (${b.id})${builtinEnabled(config.builtinTools, b.id) ? '' : OFF}` })) },
    { label: '自定义工具', options: config.tools.map((t) => ({ value: t.id, label: `${t.id} — ${t.description}${t.enabled === false ? OFF : ''}` })) },
    { label: 'MCP 服务', options: config.mcpServers.map((m) => ({ value: `mcp:${m.id}`, label: `mcp:${m.id}${m.enabled ? '' : OFF}` })) },
  ];
  return (
    <div className="page">
      <div className="page-title"><h2><Bot size={18} />智能体</h2></div>
      <ConfigList
        listKey="agents"
        title="智能体 = 引擎（模型 / Harness）+ 提示词 + 工具"
        columns={[
          { title: '名称', key: 'name', render: (_, a) => <Space direction="vertical" size={0}><Typography.Text strong>{a.name || a.id}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{a.id}</Typography.Text></Space> },
          { title: '引擎', key: 'engine', render: (_, a) => a.engine === 'harness' ? <Tag color="purple">Harness · {a.harness}</Tag> : <Tag color="blue">{a.provider} · {a.model}</Tag> },
          { title: '提示词', dataIndex: 'prompt', render: (v?: string) => v ? <Tag>{v}</Tag> : '-' },
          { title: '工具', dataIndex: 'tools', render: (v: string[]) => <Space size={[4, 4]} wrap>{v.map((t) => <Tag key={t}>{t}</Tag>)}</Space> },
        ]}
        defaults={() => ({ id: `agent-${Date.now().toString(36)}`, engine: 'model', provider: config.providers[0]?.id, tools: ['builtin:time', 'builtin:skip'], maxToolRounds: 4, temperature: 0.7, prompt: config.prompts[0]?.id } as Partial<AgentConfig>)}
        modalWidth={760}
        fromForm={(v, prev) => {
          const a = { ...(prev ?? {}), ...v } as AgentConfig;
          const tools = (a.tools ?? []) as string[];
          // A harness only receives MCP servers; built-in / command tools would be silently ignored.
          return { ...a, tools: a.engine === 'harness' ? tools.filter((t) => t.startsWith('mcp:')) : tools };
        }}
        form={(form) => (
          <>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input style={{ width: 200 }} /></Form.Item>
              <Form.Item name="name" label="名称"><Input style={{ width: 240 }} /></Form.Item>
              <Form.Item name="engine" label="引擎"><Select style={{ width: 200 }} options={[{ value: 'model', label: '模型 API（自管工具）' }, { value: 'harness', label: 'Harness（CLI 智能体）' }]} /></Form.Item>
            </Space>
            <Form.Item noStyle shouldUpdate>{() => form.getFieldValue('engine') === 'harness' ? (
              <Form.Item name="harness" label="Harness" rules={[{ required: true }]}>
                <Select options={config.harnesses.map((h) => ({ value: h.id, label: `${h.id}（${h.type}: ${h.command}）` }))} />
              </Form.Item>
            ) : (
              <Space style={{ display: 'flex' }} align="start">
                <Form.Item name="provider" label="模型服务" rules={[{ required: true }]}><Select style={{ width: 180 }} options={config.providers.map((p) => ({ value: p.id, label: p.name || p.id }))} /></Form.Item>
                <Form.Item name="model" label="模型" rules={[{ required: true }]}><Input style={{ width: 200 }} placeholder="deepseek-chat / gpt-4o-mini" /></Form.Item>
                <Form.Item name="temperature" label="temperature"><InputNumber min={0} max={2} step={0.1} /></Form.Item>
                <Form.Item name="maxTokens" label="max tokens"><InputNumber min={16} step={64} /></Form.Item>
                <Form.Item name="maxToolRounds" label="工具轮数"><InputNumber min={0} max={20} /></Form.Item>
              </Space>
            )}</Form.Item>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="vision" label="支持图片（多模态）" valuePropName="checked"
                tooltip="打开后聊天里的图片（含我发出的）会压缩后直接作为图片发给模型；模型不支持时自动退回 OCR 文字。Harness 引擎则在记录里附上图片文件路径">
                <Switch />
              </Form.Item>
              <Form.Item name="maxImages" label="每次最多图片数" tooltip="只发送最近的几张，更早的图片用文字代替"><InputNumber min={0} max={20} /></Form.Item>
              <Form.Item name="imageDetail" label="图片精度" tooltip="low 最省 token（OpenAI / DeepSeek 等兼容接口的 detail 参数）">
                <Select style={{ width: 100 }} options={['low', 'auto', 'high'].map((v) => ({ value: v, label: v }))} />
              </Form.Item>
            </Space>
            <Form.Item name="prompt" label="提示词模板"><Select allowClear options={config.prompts.map((p) => ({ value: p.id, label: p.name || p.id }))} /></Form.Item>
            <Form.Item name="systemPrompt" label="附加系统提示词" tooltip="追加在模板之后，支持 {{chat}} {{sender}} {{myNickname}} {{now}} {{#group}}...{{/group}}">
              <CodeEditor language="markdown" height={120} />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(a, b) => a.engine !== b.engine || a.harness !== b.harness}>{() => {
              if (form.getFieldValue('engine') !== 'harness') {
                return <Form.Item name="tools" label="工具" extra="标注「未启用」的需先在「工具 / MCP」页打开开关才会生效"><Select mode="multiple" options={toolOptions} /></Form.Item>;
              }
              const h = config.harnesses.find((x) => x.id === form.getFieldValue('harness'));
              const mcpUsable = h && h.type !== 'command' && h.passMcpServers;
              return (
                <Form.Item name="tools" label="MCP 服务（传给 harness）"
                  extra={mcpUsable ? '内置工具与自定义命令工具由 harness 自身管理，这里只能选 MCP 服务，通过 --mcp-config 传入'
                    : h ? `该 harness ${h.type === 'command' ? '是自定义命令，不支持' : '未开启「传递 MCP 配置」，不会使用'} MCP 服务` : '请先选择 harness'}>
                  <Select mode="multiple" disabled={!mcpUsable} options={toolOptions.filter((g) => g.label === 'MCP 服务')} />
                </Form.Item>
              );
            }}</Form.Item>
          </>
        )}
      />
      <TestPanel />
    </div>
  );
}

interface TestMsg { side: 'self' | 'other'; sender?: string; text: string }

function TestPanel() {
  const { config } = useRelay();
  const { message } = App.useApp();
  const [agent, setAgent] = useState<string | undefined>(config?.agents[0]?.id);
  const [chat, setChat] = useState('测试好友');
  const [isGroup, setIsGroup] = useState(false);
  const [msgs, setMsgs] = useState<TestMsg[]>([{ side: 'other', text: '在吗？周末有空一起吃饭不' }]);
  const [result, setResult] = useState<TestAgentResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!agent) return;
    setBusy(true); setResult(null);
    try { setResult(await window.relay.testAgent({ agent, chat, isGroup, messages: msgs })); } catch (e) { message.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Card size="small" title="调试智能体（不会发送到微信）">
      <Row gutter={16}>
        <Col span={12}>
          <Space wrap style={{ marginBottom: 12 }}>
            <Select style={{ width: 180 }} value={agent} onChange={setAgent} options={config?.agents.map((a) => ({ value: a.id, label: a.name || a.id }))} />
            <Input style={{ width: 140 }} value={chat} onChange={(e) => setChat(e.target.value)} addonBefore="会话" />
            <Space size={4}>群聊<Switch size="small" checked={isGroup} onChange={setIsGroup} /></Space>
          </Space>
          {msgs.map((m, i) => (
            <Space.Compact key={i} style={{ width: '100%', marginBottom: 6 }}>
              <Select style={{ width: 90 }} value={m.side} onChange={(side) => setMsgs(msgs.map((x, j) => (j === i ? { ...x, side } : x)))} options={[{ value: 'other', label: '对方' }, { value: 'self', label: '我' }]} />
              {isGroup && m.side === 'other' && <Input style={{ width: 110 }} placeholder="发送者" value={m.sender} onChange={(e) => setMsgs(msgs.map((x, j) => (j === i ? { ...x, sender: e.target.value } : x)))} />}
              <Input value={m.text} onChange={(e) => setMsgs(msgs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <Button icon={<Trash size={14} />} onClick={() => setMsgs(msgs.filter((_, j) => j !== i))} />
            </Space.Compact>
          ))}
          <Space>
            <Button size="small" icon={<Plus size={14} />} onClick={() => setMsgs([...msgs, { side: 'other', text: '' }])}>添加消息</Button>
            <Button size="small" type="primary" icon={<Play size={14} />} loading={busy} onClick={() => void run()}>运行</Button>
          </Space>
        </Col>
        <Col span={12}>
          {result && (
            <>
              <Typography.Text type="secondary">{result.ms}ms</Typography.Text>
              {result.ok
                ? result.skipped ? <div><Tag>不回复</Tag></div> : <div className="bubble bot" style={{ margin: '6px 0' }}>{result.reply}</div>
                : <Typography.Paragraph type="danger" className="mono">{result.error}</Typography.Paragraph>}
              {result.trace.map((t, i) => <div key={i} className="mono log-line">{t}</div>)}
            </>
          )}
        </Col>
      </Row>
    </Card>
  );
}
