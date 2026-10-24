import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, InputNumber, Select, Space, Switch, Typography } from 'antd';
import { Brain, Moon, RefreshCw, Save } from 'lucide-react';
import type { ChatSummary, MemorySummary } from '@shared/types';
import CodeEditor from '../components/CodeEditor';
import { errMsg, useRelay } from '../relay';

const GLOBAL = '__global__';
const keyOf = (m: MemorySummary) => (m.scope === 'global' ? GLOBAL : m.chat ?? '');
const fmt = (t: number) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-');

function Settings() {
  const { config, saveConfig } = useRelay();
  if (!config) return null;
  const m = config.memory;
  const set = (p: Partial<typeof m>) => void saveConfig((c) => { c.memory = { ...c.memory, ...p }; });
  return (
    <Card size="small" title="记忆设置" style={{ marginBottom: 16 }}>
      <Space size={24} wrap align="center">
        <Space>启用<Switch checked={m.enabled} onChange={(enabled) => set({ enabled })} /></Space>
        <Space>提示词里的全局记忆条数<InputNumber min={0} max={100} value={m.indexLimit} onChange={(v) => v != null && set({ indexLimit: v })} /></Space>
        <Space>每个会话新增 N 条消息后自动整理（0 = 不自动）<InputNumber min={0} step={10} value={m.dreamEveryMessages} onChange={(v) => v != null && set({ dreamEveryMessages: v })} /></Space>
        <Space>整理用的智能体
          <Select allowClear style={{ width: 180 }} placeholder="第一个智能体" value={m.dreamAgent}
            options={config.agents.map((a) => ({ value: a.id, label: a.name || a.id }))} onChange={(v) => set({ dreamAgent: v })} />
        </Space>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '10px 0 0' }}>
        开启后，系统提示词会附带全局记忆索引，并说明全局 / 会话记忆的文件路径（<code>~/.wechat-relay/memory</code>）；
        模型型智能体自动获得只限该目录的 Read / Write / Edit / Glob / Grep 和沙箱里的 Bash（家目录其他文件不可读、目录外不可写），Harness 用自己的同名工具。会话记忆不进索引，需要时由智能体读文件或 grep。
      </Typography.Paragraph>
    </Card>
  );
}

function MemoryFiles() {
  const { message } = App.useApp();
  const { config } = useRelay();
  const [files, setFiles] = useState<MemorySummary[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [sel, setSel] = useState(GLOBAL);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'save' | 'dream' | null>(null);

  const refresh = useCallback(async () => {
    const [f, c] = await Promise.all([window.relay.listMemory(), window.relay.getChats()]);
    setFiles(f); setChats(c);
  }, []);
  const load = useCallback(async (key: string) => {
    setText(await window.relay.readMemory(key === GLOBAL ? 'global' : 'session', key === GLOBAL ? undefined : key));
    setDirty(false);
  }, []);
  useEffect(() => { void refresh().catch((e) => message.error(errMsg(e))); }, [refresh, message]);
  useEffect(() => { void load(sel).catch((e) => message.error(errMsg(e))); }, [sel, load, message]);

  const options = [
    { value: GLOBAL, label: '全局记忆' },
    ...[...new Set([...files.filter((f) => f.scope === 'session').map(keyOf), ...chats.map((c) => c.name)])]
      .map((n) => ({ value: n, label: `会话 · ${n}${files.find((f) => keyOf(f) === n) ? ` (${files.find((f) => keyOf(f) === n)!.entries} 条)` : ''}` })),
  ];
  const cur = files.find((f) => keyOf(f) === sel);

  const save = async () => {
    setBusy('save');
    try { await window.relay.writeMemory(sel === GLOBAL ? 'global' : 'session', sel === GLOBAL ? undefined : sel, text); setDirty(false); message.success('已保存'); await refresh(); }
    catch (e) { message.error(errMsg(e)); } finally { setBusy(null); }
  };
  const doDream = async () => {
    setBusy('dream');
    try { const r = await window.relay.dreamMemory(sel === GLOBAL ? undefined : sel); message.success(r.message.slice(0, 200)); await load(sel); await refresh(); }
    catch (e) { message.error(errMsg(e)); } finally { setBusy(null); }
  };

  return (
    <Card size="small" title="记忆文件" style={{ marginBottom: 16 }}
      extra={<Space>
        <Button size="small" icon={<RefreshCw size={14} />} onClick={() => void refresh().then(() => load(sel))} />
        <Button size="small" icon={<Moon size={14} />} loading={busy === 'dream'} disabled={!config?.memory.enabled || dirty} onClick={() => void doDream()}
          title={config?.memory.enabled ? '让智能体整理合并这份记忆（会话记忆会同时整理全局记忆）' : '先开启记忆功能'}>整理记忆</Button>
        <Button size="small" type="primary" icon={<Save size={14} />} loading={busy === 'save'} disabled={!dirty} onClick={() => void save()}>保存</Button>
      </Space>}>
      <Space style={{ marginBottom: 8 }} wrap>
        <Select showSearch style={{ width: 320 }} value={sel} options={options} onChange={(v) => { if (!dirty || window.confirm('有未保存的修改，切换会丢弃，继续？')) setSel(v); }} />
        <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{cur?.file ?? '（尚无文件，开启记忆后首次回复时创建）'} · 更新于 {fmt(cur?.updatedAt ?? 0)}</Typography.Text>
      </Space>
      <CodeEditor language="markdown" height={320} value={text} onChange={(t) => { setText(t); setDirty(true); }} onSave={() => void save()} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
        每行一条：<code>- [P0|2026-10-20 12:30] 内容</code>，P0 最高、P2 为默认；智能体读写的是同一份文件。
      </Typography.Paragraph>
    </Card>
  );
}

export default function Memory() {
  return (
    <div className="page">
      <div className="page-title"><h2><Brain size={18} />记忆</h2></div>
      <Settings />
      <MemoryFiles />
    </div>
  );
}
