import { App, Button, Card, Col, Descriptions, Empty, Row, Space, Statistic, Switch, Tag, Typography } from 'antd';
import { Activity, Eye, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { errMsg, useRelay } from '../relay';

export default function Dashboard() {
  const { status, snapshot, config } = useRelay();
  const { message } = App.useApp();
  const [overlay, setOverlay] = useState(true);
  const v = snapshot?.vision;
  const k = v ? 100 / v.width : 0;
  const kh = v ? 100 / v.height : 0;
  const box = (x: number, y: number, w: number, h: number, color: string, key: string) => (
    <div key={key} className="box" style={{ left: `${x * k}%`, top: `${y * kh}%`, width: `${w * k}%`, height: `${h * kh}%`, borderColor: color }} />
  );

  return (
    <div className="page">
      <div className="page-title">
        <h2><Activity size={18} />实时监控</h2>
        <Space>
          <Space size={6}><Typography.Text type="secondary">识别框</Typography.Text><Switch size="small" checked={overlay} onChange={setOverlay} /></Space>
          <Button icon={<RefreshCw size={14} />} onClick={() => window.relay.tickOnce().catch((e) => message.error(errMsg(e)))}>立即识别</Button>
        </Space>
      </div>

      {config && !config.general.autoReply && (
        <Card size="small" style={{ marginBottom: 16, background: '#fffbe6', borderColor: '#ffe58f' }}>
          <Space><ShieldAlert size={16} color="#faad14" />自动操作已关闭：只识别和记录消息、生成草稿，不会点击微信或发送消息。</Space>
        </Card>
      )}

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card size="small"><Statistic title="识别次数" value={status?.ticks ?? 0} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="单次耗时" value={status?.lastTickMs ?? 0} suffix="ms" /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="已发送回复" value={status?.replies ?? 0} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="当前会话" value={status?.currentChat ?? '-'} valueStyle={{ fontSize: 18 }} /></Card></Col>
      </Row>

      <Row gutter={16}>
        <Col span={14}>
          <Card size="small" title={<Space><Eye size={14} />微信窗口（后台截图）</Space>}>
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
            {v?.sessions.length ? v.sessions.map((s, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f5f5f5' }}>
                <Space size={6}>
                  {s.unread && <Tag color="red" style={{ marginInlineEnd: 0 }}>未读</Tag>}
                  {s.mentioned && <Tag color="orange" style={{ marginInlineEnd: 0 }}>@</Tag>}
                  <Typography.Text strong={s.selected}>{s.name}</Typography.Text>
                  <Typography.Text type="secondary" ellipsis style={{ maxWidth: 180, fontSize: 12 }}>{s.preview}</Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.time}</Typography.Text>
              </div>
            )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
