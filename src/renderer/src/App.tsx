import { Activity as KeepAlive, useState, type ReactElement } from 'react';
import { App as AntApp, Badge, Button, Layout, Menu, Segmented, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { Activity, Bot, Brain, Code, Cpu, FileText, Sparkles, Inbox, ListFilter, MessagesSquare, Play, ScrollText, Square, Wrench } from 'lucide-react';
import ErrorBoundary from './components/ErrorBoundary';
import { PageVisit } from './pageVisit';
import { RelayProvider, errMsg, useRelay } from './relay';
import Dashboard from './pages/Dashboard';
import Chats from './pages/Chats';
import Drafts from './pages/Drafts';
import Rules from './pages/Rules';
import Agents from './pages/Agents';
import Providers from './pages/Providers';
import Tools from './pages/Tools';
import Prompts from './pages/Prompts';
import Memory from './pages/Memory';
import Skills from './pages/Skills';
import Logs from './pages/Logs';
import YamlPage from './pages/Yaml';

const { Sider, Header, Content } = Layout;
const icon = (I: typeof Activity) => <I size={16} />;

function Shell() {
  const { status, config, drafts, saveConfig } = useRelay();
  const { message } = AntApp.useApp();
  const [page, setPage] = useState('dashboard');
  const pendingDrafts = drafts.filter((d) => d.status === 'pending').length;

  // Keep-alive: a page is mounted on first visit; hidden pages use display:none (React Activity) so nothing of them is painted.
  const [visited, setVisited] = useState<string[]>(['dashboard']);
  /** Times each page was shown (see PageVisit). */
  const [visits, setVisits] = useState<Record<string, number>>({});
  const open = (key: string) => {
    if (key === page) return;
    setPage(key);
    setVisited((v) => (v.includes(key) ? v : [...v, key]));
    setVisits((n) => ({ ...n, [key]: (n[key] ?? 0) + 1 }));
  };

  const pages: Record<string, ReactElement> = {
    dashboard: <Dashboard />, chats: <Chats />, drafts: <Drafts />, rules: <Rules />, agents: <Agents />,
    providers: <Providers />, tools: <Tools />, prompts: <Prompts />, memory: <Memory />, skills: <Skills />, logs: <Logs />, yaml: <YamlPage />,
  };

  const driverTag = !status ? null
    : status.driver === 'ready' ? <Tag color="success">Cua Driver 就绪</Tag>
    : status.driver === 'error' ? <Tooltip title={status.driverError}><Tag color="error">Driver 异常</Tag></Tooltip>
    : <Tag>{status.driver}</Tag>;

  return (
    <Layout style={{ height: '100%' }}>
      <Sider width={208} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
        <div className="drag" style={{ height: 52 }} />
        <div style={{ padding: '0 20px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <MessagesSquare size={22} color="#07c160" />
          <Typography.Text strong style={{ fontSize: 15 }}>WeChat Relay</Typography.Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          onClick={(e) => open(e.key)}
          style={{ borderInlineEnd: 'none' }}
          items={[
            { key: 'dashboard', icon: icon(Activity), label: '实时监控' },
            { key: 'chats', icon: icon(MessagesSquare), label: '会话记录' },
            { key: 'drafts', icon: icon(Inbox), label: <Space>待审核<Badge count={pendingDrafts} size="small" /></Space> },
            { type: 'divider' },
            { key: 'rules', icon: icon(ListFilter), label: '回复规则' },
            { key: 'agents', icon: icon(Bot), label: '智能体' },
            { key: 'providers', icon: icon(Cpu), label: '模型 / Harness' },
            { key: 'tools', icon: icon(Wrench), label: '工具 / MCP' },
            { key: 'prompts', icon: icon(FileText), label: '提示词' },
            { key: 'memory', icon: icon(Brain), label: '记忆' },
            { key: 'skills', icon: icon(Sparkles), label: 'Skill' },
            { type: 'divider' },
            { key: 'logs', icon: icon(ScrollText), label: '运行日志' },
            { key: 'yaml', icon: icon(Code), label: 'YAML 配置' },
          ]}
        />
      </Sider>
      <Layout>
        <Header className="drag" style={{ height: 52, lineHeight: '52px', padding: '0 20px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space className="no-drag" size={12}>
            {driverTag}
            {status?.wechat ? <Tag color="green">微信 pid {status.wechat.pid}</Tag> : <Tag color="warning">未找到微信窗口</Tag>}
            {status?.currentChat && <Typography.Text type="secondary">当前会话：{status.currentChat}</Typography.Text>}
          </Space>
          <Space className="no-drag" size={16}>
            {config && (
              <>
                <Tooltip title="默认发送方式：审核后发送 = 生成草稿需确认；自动发送 = 直接发送。可在「会话记录」里为单个会话单独设置，优先级高于此处">
                  <Segmented
                    size="small"
                    value={config.general.mode}
                    options={[{ label: '审核后发送', value: 'review' }, { label: '自动发送', value: 'auto' }]}
                    onChange={(v) => void saveConfig((c) => { c.general.mode = v as 'auto' | 'review'; })}
                  />
                </Tooltip>
                <Tooltip title="允许智能体用 AskUserQuestion 弹出全局窗口问你（事实不清楚时）。可在「会话记录」里为单个会话单独开关，优先级高于此处">
                  <Space size={6}>
                    <Typography.Text>询问我</Typography.Text>
                    <Switch
                      size="small"
                      checked={config.general.askUser}
                      onChange={(v) => void saveConfig((c) => { c.general.askUser = v; })}
                    />
                  </Space>
                </Tooltip>
                <Space size={6}>
                  <Typography.Text>自动操作</Typography.Text>
                  <Switch
                    checked={config.general.autoReply}
                    onChange={(v) => void saveConfig((c) => { c.general.autoReply = v; })}
                  />
                </Space>
              </>
            )}
            {status?.running
              ? <Button icon={<Square size={14} />} onClick={() => void window.relay.stop()}>停止监听</Button>
              : <Button type="primary" icon={<Play size={14} />} onClick={() => window.relay.start().catch((e) => message.error(errMsg(e)))}>开始监听</Button>}
          </Space>
        </Header>
        <Content style={{ overflow: 'hidden', position: 'relative' }}>
          {visited.map((key) => (
            <KeepAlive key={key} mode={key === page ? 'visible' : 'hidden'}>
              <div style={{ position: 'absolute', inset: 0 }}>
                <PageVisit.Provider value={visits[key] ?? 0}><ErrorBoundary resetKey={key === page}>{pages[key]}</ErrorBoundary></PageVisit.Provider>
              </div>
            </KeepAlive>
          ))}
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  return <RelayProvider><Shell /></RelayProvider>;
}
