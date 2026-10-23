import { Alert, Button, Card, Form, Input, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd';
import { ListFilter, Save } from 'lucide-react';
import type { RuleConfig } from '@shared/types';
import ConfigList, { linesToList, listToLines } from '../components/ConfigList';
import { useRelay } from '../relay';

const TYPE = { any: '全部', private: '私聊', group: '群聊' };

export default function Rules() {
  const { config, saveConfig } = useRelay();
  const agents = config?.agents ?? [];
  return (
    <div className="page">
      <div className="page-title"><h2><ListFilter size={18} />回复规则</h2></div>
      <Alert style={{ marginBottom: 16 }} type="info" showIcon
        message="规则按顺序匹配，第一条命中的规则生效。会话名支持精确匹配、通配符 *（如 订阅号*）和正则 /^工作群/。“忽略”规则可用作黑名单，放在前面。" />
      <ConfigList
        listKey="rules"
        title="规则列表"
        sortable
        columns={[
          { title: '#', key: 'i', width: 40, render: (_, __, i) => i + 1 },
          {
            title: '启用', dataIndex: 'enabled', width: 60,
            render: (v: boolean, r) => <Switch size="small" checked={v} onChange={(on) => void saveConfig((c) => { c.rules.find((x) => x.id === r.id)!.enabled = on; })} />,
          },
          { title: '名称', key: 'name', render: (_, r) => <Space direction="vertical" size={0}><Typography.Text strong>{r.name || r.id}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.id}</Typography.Text></Space> },
          {
            title: '条件', key: 'match', render: (_, r) => (
              <Space size={[4, 4]} wrap>
                {r.match.chatType && r.match.chatType !== 'any' && <Tag color="blue">{TYPE[r.match.chatType]}</Tag>}
                {r.match.chats?.map((c) => <Tag key={c}>{c}</Tag>)}
                {r.match.excludeChats?.map((c) => <Tag key={c} color="default">排除 {c}</Tag>)}
                {r.match.mentionOnly && <Tag color="orange">@我{r.match.includeAtAll ? ' / @所有人' : ''}</Tag>}
                {r.match.keywords?.map((k) => <Tag key={k} color="purple">含「{k}」</Tag>)}
                {r.match.senders?.map((k) => <Tag key={k} color="cyan">发送者 {k}</Tag>)}
                {!Object.values(r.match).some((v) => (Array.isArray(v) ? v.length : v && v !== 'any')) && <Typography.Text type="secondary">所有会话</Typography.Text>}
              </Space>
            ),
          },
          {
            title: '动作', key: 'action', width: 200, render: (_, r) => r.action === 'ignore' ? <Tag>忽略</Tag> : (
              <Space size={4}><Tag color="green">回复</Tag>{r.agent}{r.mode && r.mode !== 'inherit' && <Tag>{r.mode === 'auto' ? '自动' : '审核'}</Tag>}</Space>
            ),
          },
        ]}
        defaults={() => ({ id: `rule-${Date.now().toString(36)}`, enabled: true, action: 'reply', agent: agents[0]?.id, mode: 'inherit', cooldownSec: 10, chatType: 'any' } as never)}
        toForm={(r) => ({
          ...r, ...r.match,
          chats: listToLines(r.match.chats), excludeChats: listToLines(r.match.excludeChats),
          keywords: listToLines(r.match.keywords), senders: listToLines(r.match.senders), chatType: r.match.chatType ?? 'any',
        })}
        fromForm={(v): RuleConfig => ({
          id: String(v.id), name: (v.name as string) || undefined, enabled: Boolean(v.enabled ?? true),
          action: v.action as RuleConfig['action'], agent: v.agent as string, mode: v.mode as RuleConfig['mode'], cooldownSec: Number(v.cooldownSec ?? 0),
          match: {
            chats: linesToList(v.chats), excludeChats: linesToList(v.excludeChats), chatType: v.chatType as RuleConfig['match']['chatType'],
            mentionOnly: Boolean(v.mentionOnly), includeAtAll: Boolean(v.includeAtAll), keywords: linesToList(v.keywords), senders: linesToList(v.senders),
          },
        })}
        modalWidth={720}
        form={(form) => (
          <>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input style={{ width: 200 }} /></Form.Item>
              <Form.Item name="name" label="名称"><Input style={{ width: 260 }} /></Form.Item>
              <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </Space>
            <Typography.Title level={5}>匹配条件</Typography.Title>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="chatType" label="会话类型"><Select style={{ width: 140 }} options={Object.entries(TYPE).map(([value, label]) => ({ value, label }))} /></Form.Item>
              <Form.Item name="mentionOnly" label="群聊仅在 @我 时" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="includeAtAll" label="包含 @所有人" valuePropName="checked"><Switch /></Form.Item>
            </Space>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="chats" label="会话名（每行一个，空 = 全部）"><Input.TextArea rows={3} style={{ width: 330 }} /></Form.Item>
              <Form.Item name="excludeChats" label="排除会话"><Input.TextArea rows={3} style={{ width: 330 }} /></Form.Item>
            </Space>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="keywords" label="关键词（任一命中，支持 /正则/）"><Input.TextArea rows={2} style={{ width: 330 }} /></Form.Item>
              <Form.Item name="senders" label="群成员（发送者）"><Input.TextArea rows={2} style={{ width: 330 }} /></Form.Item>
            </Space>
            <Typography.Title level={5}>动作</Typography.Title>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="action" label="动作"><Select style={{ width: 120 }} options={[{ value: 'reply', label: '回复' }, { value: 'ignore', label: '忽略' }]} /></Form.Item>
              <Form.Item noStyle shouldUpdate>{() => form.getFieldValue('action') === 'reply' && (
                <Space align="start">
                  <Form.Item name="agent" label="智能体" rules={[{ required: true }]}><Select style={{ width: 180 }} options={agents.map((a) => ({ value: a.id, label: a.name || a.id }))} /></Form.Item>
                  <Form.Item name="mode" label="发送方式"><Select style={{ width: 140 }} options={[{ value: 'inherit', label: '跟随全局' }, { value: 'review', label: '审核后发送' }, { value: 'auto', label: '自动发送' }]} /></Form.Item>
                  <Form.Item name="cooldownSec" label="冷却（秒）"><InputNumber min={0} style={{ width: 110 }} /></Form.Item>
                </Space>
              )}</Form.Item>
            </Space>
          </>
        )}
      />
      <GeneralSettings />
    </div>
  );
}

function GeneralSettings() {
  const { config, saveConfig } = useRelay();
  const [form] = Form.useForm();
  if (!config) return null;
  const g = config.general;
  return (
    <ConfigCard title="全局设置" onSave={async () => {
      const { delayMin, delayMax, ...rest } = await form.validateFields();
      await saveConfig((c) => { c.general = { ...c.general, ...rest, replyDelayMs: [delayMin, Math.max(delayMin, delayMax)] }; });
    }}>
      <Form form={form} layout="inline" initialValues={{ ...g, delayMin: g.replyDelayMs[0], delayMax: g.replyDelayMs[1] }} style={{ rowGap: 12 }}>
        <Form.Item name="myNickname" label="我的群昵称" tooltip="用于识别 @我"><Input style={{ width: 160 }} /></Form.Item>
        <Form.Item name="pollIntervalMs" label="轮询间隔(ms)"><InputNumber min={500} step={250} /></Form.Item>
        <Form.Item name="delayMin" label="回复延迟(ms)"><InputNumber min={0} step={500} /></Form.Item>
        <Form.Item name="delayMax" label="~"><InputNumber min={0} step={500} /></Form.Item>
        <Form.Item name="maxRepliesPerMinute" label="每分钟最多发送"><InputNumber min={1} /></Form.Item>
        <Form.Item name="historyLimit" label="上下文条数"><InputNumber min={1} max={200} /></Form.Item>
        <Form.Item name="openUnreadChats" label="自动点开未读会话" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="restoreChat" label="处理后切回原会话" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </ConfigCard>
  );
}

export function ConfigCard({ title, onSave, children }: { title: string; onSave: () => Promise<void>; children: React.ReactNode }) {
  return <Card size="small" title={title} extra={<Button size="small" type="primary" icon={<Save size={14} />} onClick={() => void onSave()}>保存</Button>}>{children}</Card>;
}
