import { useState } from 'react';
import { App, Button, Card, Col, Form, Image, Input, InputNumber, Row, Select, Space, Switch, Tag, Tooltip, Typography, Upload } from 'antd';
import { Bot, ImagePlus, Play, Plus, Trash, X } from 'lucide-react';
import { BUILTIN_TOOLS, builtinEnabled } from '@shared/builtins';
import type { AgentConfig, DebugSection, TestAgentResult } from '@shared/types';
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
          return a;
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
                return <Form.Item name="tools" label="工具" extra="标注「未启用」的需先在「工具 / MCP」页打开开关才会生效。开启「记忆」或「Skill」后，Read / Write / Edit / Glob / Grep（限对应目录）会自动提供，无需勾选"><Select mode="multiple" options={toolOptions} /></Form.Item>;
              }
              const h = config.harnesses.find((x) => x.id === form.getFieldValue('harness'));
              const cli = h && h.type !== 'command';
              return (
                <Form.Item name="tools" label="工具（传给 harness）"
                  extra={cli ? `MCP 服务${h.passMcpServers ? '' : '（该 harness 未开启「传递 MCP 配置」，不会使用）'}直接传入；时间 / 聊天记录 / 不回复和自定义工具${h.toolProxy ? '经本地代理 MCP 传入' : '（该 harness 未开启「代理内置 / 自定义工具」，不会使用）'}；文件 / Shell / 网页类工具 harness 自带，勾选无效`
                    : h ? '自定义命令不支持工具' : '请先选择 harness'}>
                  <Select mode="multiple" disabled={!cli} options={toolOptions.map((g) => (g.label === '内置' ? { ...g, options: g.options.filter((o) => ['builtin:time', 'builtin:history', 'builtin:skip'].includes(o.value)) } : g))} />
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

interface TestMsg { side: 'self' | 'other'; sender?: string; text: string; image?: string }

const readDataUrl = (f: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

const mediaUrl = (path: string) => `relay-media://img/${encodeURIComponent(path.split('/').pop() ?? '')}`;

function Section({ s }: { s: DebugSection }) {
  return (
    <div style={{ marginTop: 10 }}>
      <Typography.Text strong style={{ fontSize: 12 }}>{s.title}</Typography.Text>
      <pre className="mono debug-block">{s.text}</pre>
      {!!s.images?.length && (
        <Image.PreviewGroup>
          <Space wrap size={6}>{s.images.map((p) => <Image key={p} src={mediaUrl(p)} height={90} style={{ borderRadius: 4 }} />)}</Space>
        </Image.PreviewGroup>
      )}
    </div>
  );
}

function TestPanel() {
  const { config } = useRelay();
  const { message } = App.useApp();
  const [agent, setAgent] = useState<string | undefined>(config?.agents[0]?.id);
  const [chat, setChat] = useState('测试好友');
  const [isGroup, setIsGroup] = useState(false);
  const [ask, setAsk] = useState(false);
  const [msgs, setMsgs] = useState<TestMsg[]>([{ side: 'other', text: '在吗？周末有空一起吃饭不' }]);
  const [result, setResult] = useState<TestAgentResult | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<TestMsg>) => setMsgs((ms) => ms.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const setImage = async (i: number, f: Blob) => patch(i, { image: await readDataUrl(f) });
  const onPaste = (i: number) => (e: React.ClipboardEvent) => {
    const f = [...e.clipboardData.items].find((it) => it.type.startsWith('image/'))?.getAsFile();
    if (f) { e.preventDefault(); void setImage(i, f); }
  };

  const run = async () => {
    if (!agent) return;
    setBusy(true); setResult(null);
    try { setResult(await window.relay.testAgent({ agent, chat, isGroup, messages: msgs, ask })); } catch (e) { message.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Card size="small" title="调试智能体（不会发送到微信）">
      <Row gutter={16}>
        <Col span={12}>
          <Space wrap style={{ marginBottom: 12 }}>
            <Select style={{ width: 180 }} value={agent} onChange={setAgent} options={config?.agents.map((a) => ({ value: a.id, label: a.name || a.id }))} />
            <Input style={{ width: 140 }} value={chat} onChange={(e) => setChat(e.target.value)} addonBefore="会话" />
            <Space size={4}>群聊<Switch size="small" checked={isGroup} onChange={setIsGroup} /></Space>
            <Tooltip title="给智能体 AskUserQuestion 工具，会真的弹出询问窗口"><Space size={4}>询问我<Switch size="small" checked={ask} onChange={setAsk} /></Space></Tooltip>
          </Space>
          {msgs.map((m, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <Space.Compact style={{ width: '100%' }}>
                <Select style={{ width: 90 }} value={m.side} onChange={(side) => patch(i, { side })} options={[{ value: 'other', label: '对方' }, { value: 'self', label: '我' }]} />
                {isGroup && m.side === 'other' && <Input style={{ width: 110 }} placeholder="发送者" value={m.sender} onChange={(e) => patch(i, { sender: e.target.value })} />}
                <Input value={m.text} onChange={(e) => patch(i, { text: e.target.value })} onPaste={onPaste(i)}
                  placeholder={m.image ? '图中文字（留空则自动 OCR）' : '消息内容，可直接粘贴图片'} />
                <Upload accept="image/*" showUploadList={false} beforeUpload={(f) => { void setImage(i, f); return false; }}>
                  <Button icon={<ImagePlus size={14} />} title="作为图片消息" />
                </Upload>
                <Button icon={<Trash size={14} />} onClick={() => setMsgs(msgs.filter((_, j) => j !== i))} />
              </Space.Compact>
              {m.image && (
                <div style={{ position: 'relative', display: 'inline-block', marginTop: 4, marginLeft: 90 }}>
                  <Image src={m.image} height={72} style={{ borderRadius: 4 }} />
                  <Button size="small" type="text" icon={<X size={12} />} onClick={() => patch(i, { image: undefined })}
                    style={{ position: 'absolute', top: 0, right: 0, background: 'rgba(255,255,255,.85)' }} />
                </div>
              )}
            </div>
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
              {result.detail?.map((s, i) => <Section key={i} s={s} />)}
            </>
          )}
        </Col>
      </Row>
    </Card>
  );
}
