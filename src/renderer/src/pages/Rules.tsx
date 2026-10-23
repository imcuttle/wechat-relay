import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Select, Space, Switch, Tag, Typography, type FormInstance } from 'antd';
import { ListFilter, Save } from 'lucide-react';
import type { ChatSummary, RuleConfig } from '@shared/types';
import ConfigList from '../components/ConfigList';
import { useRelay } from '../relay';

const TYPE = { any: '全部', private: '私聊', group: '群聊' };
type ChatType = keyof typeof TYPE;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** Tag-style input: free text (wildcards / regex) plus suggestions of chats seen so far, filtered by chat type. */
function ChatPicker({ chats, type, ...rest }: { chats: ChatSummary[]; type: ChatType; value?: string[]; onChange?: (v: string[]) => void; placeholder?: string }) {
  const options = chats
    .filter((c) => type === 'any' || (type === 'group') === c.isGroup)
    .map((c) => ({ value: c.name, label: <Space size={4}>{c.name}{c.isGroup && <Tag color="blue" style={{ marginInlineEnd: 0 }}>群</Tag>}</Space> }));
  return <Select mode="tags" style={{ width: 330 }} options={options} tokenSeparators={['\n']} {...rest} />;
}

/** Conditions whose fields depend on the chat type (and on each other). */
function MatchFields({ form, chats }: { form: FormInstance; chats: ChatSummary[] }) {
  const type = (Form.useWatch('chatType', form) ?? 'any') as ChatType;
  const mentionOnly = Form.useWatch('mentionOnly', form) as boolean | undefined;
  const groupish = type !== 'any' ? type === 'group' : true;
  const scope = type === 'any' ? '（仅对群聊生效）' : '';
  const noun = type === 'private' ? '联系人' : type === 'group' ? '群' : '会话';

  // Hidden fields unmount (the modal form uses preserve={false}) and fromForm drops group-only values for 私聊,
  // so switching the type never leaves conditions that silently can never match.

  return (
    <>
      <Space style={{ display: 'flex' }} align="start" size={24}>
        <Form.Item name="chatType" label="会话类型">
          <Select style={{ width: 140 }} options={Object.entries(TYPE).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        {groupish && (
          <Form.Item name="mentionOnly" label={`仅在 @我 时${scope}`} valuePropName="checked"
            tooltip="需要在全局设置里填写「我的群昵称」，或依赖会话列表中的「有人@我」提示">
            <Switch />
          </Form.Item>
        )}
        {groupish && mentionOnly && (
          <Form.Item name="includeAtAll" label="@所有人 也算" valuePropName="checked"><Switch /></Form.Item>
        )}
      </Space>
      <Space style={{ display: 'flex' }} align="start">
        <Form.Item name="chats" label={`${noun}（空 = 全部${noun}）`} tooltip="可输入名称、通配符 *（如 工作群*）或 /正则/，回车确认；下拉为已识别过的会话">
          <ChatPicker chats={chats} type={type} placeholder={`全部${noun}`} />
        </Form.Item>
        <Form.Item name="excludeChats" label={`排除${noun}`}>
          <ChatPicker chats={chats} type={type} placeholder="无" />
        </Form.Item>
      </Space>
      <Space style={{ display: 'flex' }} align="start">
        <Form.Item name="keywords" label="关键词（任一命中，支持 /正则/）" tooltip="空 = 不限内容">
          <Select mode="tags" style={{ width: 330 }} open={false} placeholder="不限" tokenSeparators={[',', '，']} />
        </Form.Item>
        {groupish && (
          <Form.Item name="senders" label={`群成员（发送者）${scope}`} tooltip="只回应这些人在群里发的消息；空 = 所有人">
            <Select mode="tags" style={{ width: 330 }} open={false} placeholder="所有人" tokenSeparators={[',', '，']} />
          </Form.Item>
        )}
      </Space>
    </>
  );
}

export default function Rules() {
  const { config, saveConfig, chatVersion } = useRelay();
  const agents = config?.agents ?? [];
  const [chats, setChats] = useState<ChatSummary[]>([]);
  useEffect(() => { void window.relay.getChats().then(setChats); }, [chatVersion]);
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
              <Space size={4}><Tag color="green">回复</Tag>{r.agent}{r.mode && r.mode !== 'inherit' && <Tag>{r.mode === 'auto' ? '自动' : '审核'}</Tag>}{r.voice === 'always' && <Tag color="purple">语音</Tag>}</Space>
            ),
          },
        ]}
        defaults={() => ({ id: `rule-${Date.now().toString(36)}`, enabled: true, action: 'reply' as const, agent: agents[0]?.id, mode: 'inherit' as const, cooldownSec: 10, match: { chatType: 'any' as const } })}
        toForm={(r) => ({ ...r, ...r.match, chatType: r.match.chatType ?? 'any' })}
        fromForm={(v, prev): RuleConfig => {
          const chatType = (v.chatType ?? 'any') as ChatType;
          const group = chatType !== 'private';
          const mentionOnly = group && Boolean(v.mentionOnly);
          const reply = v.action === 'reply';
          return {
            id: String(v.id), name: (v.name as string) || undefined, enabled: Boolean(v.enabled ?? prev?.enabled ?? true),
            action: v.action as RuleConfig['action'],
            agent: reply ? (v.agent as string) : undefined,
            mode: reply ? (v.mode as RuleConfig['mode']) : undefined,
            cooldownSec: reply ? Number(v.cooldownSec ?? 0) : 0,
            voice: reply && v.voice && v.voice !== 'inherit' ? (v.voice as RuleConfig['voice']) : undefined,
            match: {
              chatType, chats: list(v.chats), excludeChats: list(v.excludeChats), keywords: list(v.keywords),
              mentionOnly, includeAtAll: mentionOnly && Boolean(v.includeAtAll), senders: group ? list(v.senders) : [],
            },
          };
        }}
        modalWidth={720}
        form={(form) => (
          <>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input style={{ width: 200 }} /></Form.Item>
              <Form.Item name="name" label="名称"><Input style={{ width: 260 }} /></Form.Item>
              <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </Space>
            <Typography.Title level={5}>匹配条件</Typography.Title>
            <MatchFields form={form} chats={chats} />
            <Typography.Title level={5}>动作</Typography.Title>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="action" label="动作"><Select style={{ width: 120 }} options={[{ value: 'reply', label: '回复' }, { value: 'ignore', label: '忽略' }]} /></Form.Item>
              <Form.Item noStyle shouldUpdate>{() => form.getFieldValue('action') === 'reply' && (
                <Space align="start">
                  <Form.Item name="agent" label="智能体" rules={[{ required: true }]}><Select style={{ width: 180 }} options={agents.map((a) => ({ value: a.id, label: a.name || a.id }))} /></Form.Item>
                  <Form.Item name="mode" label="发送方式"><Select style={{ width: 140 }} options={[{ value: 'inherit', label: '跟随全局' }, { value: 'review', label: '审核后发送' }, { value: 'auto', label: '自动发送' }]} /></Form.Item>
                  <Form.Item name="voice" label="语音回复" tooltip="需先在配置里开启 voice；无法安全发语音时（麦克风被占用、未装虚拟声卡等）自动改发文字"><Select style={{ width: 120 }} options={[{ value: 'inherit', label: '仅文字' }, { value: 'always', label: '语音' }]} /></Form.Item>
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
      const { delayMin, delayMax, foregroundSend, ...rest } = await form.validateFields();
      await saveConfig((c) => {
        c.general = { ...c.general, ...rest, replyDelayMs: [delayMin, Math.max(delayMin, delayMax)] };
        c.driver = { ...c.driver, deliveryMode: foregroundSend ? 'foreground' : 'background' };
      });
    }}>
      <Form form={form} layout="inline" initialValues={{ ...g, delayMin: g.replyDelayMs[0], delayMax: g.replyDelayMs[1], foregroundSend: config.driver.deliveryMode === 'foreground' }} style={{ rowGap: 12 }}>
        <Form.Item name="myNickname" label="我的群昵称" tooltip="用于识别 @我"><Input style={{ width: 160 }} /></Form.Item>
        <Form.Item name="pollIntervalMs" label="轮询间隔(ms)"><InputNumber min={500} step={250} /></Form.Item>
        <Form.Item name="delayMin" label="回复延迟(ms)"><InputNumber min={0} step={500} /></Form.Item>
        <Form.Item name="delayMax" label="~"><InputNumber min={0} step={500} /></Form.Item>
        <Form.Item name="maxRepliesPerMinute" label="每分钟最多发送"><InputNumber min={1} /></Form.Item>
        <Form.Item name="historyLimit" label="上下文条数" tooltip="上限。超过条数或时间上限时，一次性丢弃较早的一半（类似上下文压缩），之后只追加新消息，让模型的提示词缓存持续命中；被丢弃的消息仍可通过「读取聊天记录」工具获取"><InputNumber min={1} max={200} /></Form.Item>
        <Form.Item name="historyMinutes" label="上下文时间(分钟)" tooltip="上下文中最早消息的时间上限，超过时与条数一样批量丢弃；会话首次出现时以及点「同步历史」时，会在后台向上滚动读取这段时间内的消息。0 = 不限时间，也不向上滚动读取"><InputNumber min={0} max={1440} /></Form.Item>
        <Form.Item name="imageMaxSize" label="图片最长边(px)" tooltip="聊天图片裁剪后压缩到该尺寸再保存 / 发送给模型"><InputNumber min={128} max={2048} step={64} /></Form.Item>
        <Form.Item name="openUnreadChats" label="自动点开未读会话" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="restoreChat" label="处理后切回原会话" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="foregroundSend" label="前台快速发送" valuePropName="checked" tooltip="始终先在后台发送；只有后台输入没生效、或会话需要搜索时，才等你键鼠空闲 3 秒，把微信短暂切到前台，用快捷键搜索、粘贴并校验后发送，再恢复剪贴板并切回原来的应用。不移动鼠标"><Switch /></Form.Item>
        <Form.Item name="restoreClipboard" label="发送后恢复剪贴板" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </ConfigCard>
  );
}

export function ConfigCard({ title, onSave, children }: { title: string; onSave: () => Promise<void>; children: React.ReactNode }) {
  return <Card size="small" title={title} extra={<Button size="small" type="primary" icon={<Save size={14} />} onClick={() => void onSave()}>保存</Button>}>{children}</Card>;
}
