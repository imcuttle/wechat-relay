import { App, Button, Card, Col, Descriptions, Empty, Row, Segmented, Space, Statistic, Switch, Tag, Typography } from 'antd';
import { Activity, Eye, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { APP_IDS, APP_LABELS, appOfChat, chatName, type AppId } from '@shared/types';
import { errMsg, useRelay } from '../relay';

export default function Dashboard() {
  const { statuses, config } = useRelay();
  const { message } = App.useApp();
  const running = (id: AppId) => statuses[id]?.running;
  // Default tab follows the header: a running app first, else an enabled one. Tracks live until the user picks a tab by hand.
  const [picked, setApp] = useState<AppId | null>(null);
  const inferred = APP_IDS.find((id) => running(id)) ?? APP_IDS.find((id) => config?.apps[id].enabled) ?? APP_IDS[0];
  const app = picked ?? inferred;

  return (
    <div className="page">
      <div className="page-title">
        <h2><Activity size={18} />实时监控</h2>
        <Space>
          <Segmented value={app} onChange={(v) => setApp(v as AppId)}
            options={APP_IDS.map((id) => ({ value: id, label: <Space size={6}>{APP_LABELS[id]}<Badge on={!!running(id)} /></Space> }))} />
          <Button icon={<RefreshCw size={14} />} onClick={() => window.relay.tickOnce(app).catch((e) => message.error(errMsg(e)))}>立即识别</Button>
        </Space>
      </div>

      {config && !config.general.autoReply && app === 'wechat' && (
        <Card size="small" style={{ marginBottom: 16, background: '#fffbe6', borderColor: '#ffe58f' }}>
          <Space><ShieldAlert size={16} color="#faad14" />自动操作已关闭：只识别和记录消息、生成草稿，不会点击微信或发送消息。</Space>
        </Card>
      )}

      {app === 'wechat' ? <WechatView /> : <WecomView />}
    </div>
  );
}

const Badge = ({ on }: { on: boolean }) => (
  <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: on ? '#52c41a' : '#d9d9d9' }} />
);

function SessionList({ rows }: { rows: Array<{ name: string; preview: string; sender?: string; time: string; unread?: boolean | number; mentioned?: boolean; selected?: boolean }> }) {
  return rows.length ? rows.map((s, i) => (
    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid #f5f5f5' }}>
      <Space size={6} style={{ minWidth: 0 }}>
        {!!s.unread && <Tag color="red" style={{ marginInlineEnd: 0 }}>{typeof s.unread === 'number' ? s.unread : '未读'}</Tag>}
        {s.mentioned && <Tag color="orange" style={{ marginInlineEnd: 0 }}>@</Tag>}
        <Typography.Text strong={s.selected} ellipsis style={{ maxWidth: 160 }}>{s.name}</Typography.Text>
        <Typography.Text type="secondary" ellipsis style={{ maxWidth: 220, fontSize: 12 }}>{s.sender ? `${s.sender}: ` : ''}{s.preview}</Typography.Text>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{s.time}</Typography.Text>
    </div>
  )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />;
}

/** 企业微信 is read through the Accessibility tree (no screenshot): show the live tree, the session list and new messages. */
function WecomView() {
  const { statuses, sessions, recent, config } = useRelay();
  const st = statuses.wecom;
  const list = sessions.wecom;
  const enabled = config?.apps.wecom.enabled;
  const feed = recent.filter((r) => appOfChat(r.chat) === 'wecom');
  const hint = !st?.running
    ? (enabled ? '未在监听，点击右上角「开始监听」' : '企微监听未开启（顶栏打开企微开关）')
    : st.driverError ?? (list ? null : '等待第一次读取…');
  const stamp = list && <Typography.Text type="secondary" style={{ fontSize: 12 }}>· {new Date(list.at).toLocaleTimeString()}</Typography.Text>;
  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card size="small"><Statistic title="读取次数" value={st?.ticks ?? 0} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="单次耗时" value={st?.lastTickMs ?? 0} suffix="ms" /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="状态" value={st?.running ? (st.driverError ? '异常' : '监听中') : '未监听'} valueStyle={{ fontSize: 18, color: st?.running && !st.driverError ? '#52c41a' : undefined }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="窗口" value={st?.wechat ? `pid ${st.wechat.pid}` : '-'} valueStyle={{ fontSize: 18 }} /></Card></Col>
      </Row>
      {hint && (
        <Card size="small" style={{ marginBottom: 16, background: '#fffbe6', borderColor: '#ffe58f' }}>
          <Space><ShieldAlert size={16} color="#faad14" />{hint}</Space>
        </Card>
      )}
      <Row gutter={16}>
        <Col span={14}>
          <Card size="small" title={<Space><Eye size={14} />辅助功能树（实时）{stamp}</Space>}>
            {list?.tree
              ? <pre style={{ margin: 0, maxHeight: 640, overflow: 'auto', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre', fontFamily: 'ui-monospace, Menlo, monospace' }}>{list.tree}</pre>
              : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={st?.running ? '等待读取…' : '尚未开始监听'} />}
          </Card>
        </Col>
        <Col span={10}>
          <Card size="small" title="最近新消息" style={{ marginBottom: 16 }}>
            {feed.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' }}>
                {feed.map((r, i) => (
                  <div key={`${r.message.id}-${i}`}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>{new Date(r.message.at).toLocaleTimeString()} · {chatName(r.chat)}{r.message.sender ? ` / ${r.message.sender}` : ''}</Typography.Text>
                    <div className="bubble other" style={{ maxWidth: '100%' }}>{r.message.text}</div>
                  </div>
                ))}
              </div>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="监听期间收到的新消息会实时出现在这里" />}
          </Card>
          <Card size="small" title={<Space>会话列表{stamp}</Space>}>
            <div style={{ maxHeight: 360, overflow: 'auto' }}><SessionList rows={list?.rows ?? []} /></div>
          </Card>
        </Col>
      </Row>
    </>
  );
}

function WechatView() {
  const { status, snapshot } = useRelay();
  const [overlay, setOverlay] = useState(true);
  const v = snapshot?.vision;
  const k = v ? 100 / v.width : 0;
  const kh = v ? 100 / v.height : 0;
  const box = (x: number, y: number, w: number, h: number, color: string, key: string) => (
    <div key={key} className="box" style={{ left: `${x * k}%`, top: `${y * kh}%`, width: `${w * k}%`, height: `${h * kh}%`, borderColor: color }} />
  );

  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card size="small"><Statistic title="识别次数" value={status?.ticks ?? 0} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="单次耗时" value={status?.lastTickMs ?? 0} suffix="ms" /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="已发送回复" value={status?.replies ?? 0} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="当前会话" value={status?.currentChat ?? '-'} valueStyle={{ fontSize: 18 }} /></Card></Col>
      </Row>

      <Row gutter={16}>
        <Col span={14}>
          <Card size="small" title={<Space><Eye size={14} />微信窗口（后台截图）</Space>}
            extra={<Space size={6}><Typography.Text type="secondary">识别框</Typography.Text><Switch size="small" checked={overlay} onChange={setOverlay} /></Space>}>
            {snapshot && v ? (
              <div className="snapshot">
                <img src={snapshot.image} />
                {overlay && v.layout && (
                  <>
                    {box(v.layout.listLeft, 0, v.layout.listRight - v.layout.listLeft, v.height, '#1677ff55', 'list')}
                    {box(v.layout.chatLeft, v.layout.headerBottom, v.layout.chatRight - v.layout.chatLeft, v.layout.inputTop - v.layout.headerBottom, '#07c16088', 'chat')}
                    {box(v.layout.chatLeft, v.layout.inputTop, v.layout.chatRight - v.layout.chatLeft, v.height - v.layout.inputTop, '#fa8c1688', 'input')}
                    {v.sessions.map((s, i) => box(v.layout!.listLeft + 4, s.top, v.layout!.listRight - v.layout!.listLeft - 8, s.bottom - s.top, s.unread ? '#ff4d4f' : '#1677ff33', `s${i}`))}
                    {v.messages.map((m, i) => box(v.layout!.chatLeft + 6, m.top, v.layout!.chatRight - v.layout!.chatLeft - 12, Math.max(10, m.bottom - m.top), m.side === 'self' ? '#52c41a' : m.side === 'other' ? '#722ed1' : '#999', `m${i}`))}
                  </>
                )}
              </div>
            ) : <Empty description={status?.running ? '等待截图…（请保持微信主窗口打开、不要最小化）' : '尚未开始监听'} />}
          </Card>
        </Col>
        <Col span={10}>
          <Card size="small" title={`识别结果${v ? ` · ${v.ms}ms` : ''}`} style={{ marginBottom: 16 }}>
            {v ? (
              <>
                <Descriptions size="small" column={2} items={[
                  { key: 't', label: '会话', children: v.title ?? '-' },
                  { key: 'g', label: '类型', children: v.isGroup ? <Tag color="blue">群聊</Tag> : <Tag>私聊</Tag> },
                ]} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, maxHeight: 320, overflow: 'auto' }}>
                  {v.messages.map((m, i) => m.side === 'system'
                    ? <Typography.Text key={i} type="secondary" style={{ textAlign: 'center', fontSize: 12 }}>{m.text}</Typography.Text>
                    : (
                      <div key={i} style={{ alignSelf: m.side === 'self' ? 'flex-end' : 'flex-start', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: m.side === 'self' ? 'flex-end' : 'flex-start' }}>
                        {m.sender && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{m.sender}</Typography.Text>}
                        <div className={`bubble ${m.side}`} style={{ opacity: m.partial ? 0.5 : 1 }}>{m.text}</div>
                      </div>
                    ))}
                </div>
              </>
            ) : <Empty />}
          </Card>
          <Card size="small" title="会话列表">
            <SessionList rows={v?.sessions ?? []} />
          </Card>
        </Col>
      </Row>
    </>
  );
}
