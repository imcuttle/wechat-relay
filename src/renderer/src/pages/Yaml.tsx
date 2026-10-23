import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Card, Collapse, Empty, Input, Space, Tag, Typography } from 'antd';
import { BookOpen, Code, FolderOpen, RefreshCw, Save } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { CONFIG_DOCS, findField, type FieldDoc } from '@shared/fieldDocs';
import CodeEditor from '../components/CodeEditor';
import { errMsg, useRelay } from '../relay';

const topSections = Object.keys(CONFIG_DOCS).filter((k) => !k.includes('.'));

export default function YamlPage() {
  const { config, status } = useRelay();
  const { message } = App.useApp();
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [panel, setPanel] = useState(true);
  const [query, setQuery] = useState('');
  const textRef = useRef(text);
  textRef.current = text;
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const load = () => window.relay.getConfigYaml().then((t) => { setText(t); setDirty(false); });
  useEffect(() => { if (!dirty) void load(); }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    try { await window.relay.saveConfigYaml(textRef.current); setDirty(false); message.success('已保存并生效'); } catch (e) { message.error(`保存失败：${errMsg(e)}`); }
  };

  const jump = (path: string[], key: string) => {
    const line = findField(textRef.current.split('\n'), path, key);
    if (line < 0 || !editor.current) { message.info('当前配置里没有这个字段，可以在编辑器里输入字段名（会有补全提示）'); return; }
    editor.current.revealLineInCenter(line + 1);
    editor.current.setPosition({ lineNumber: line + 1, column: 1 });
    editor.current.focus();
  };

  const q = query.trim().toLowerCase();
  const items = useMemo(() => topSections.flatMap((sec) => {
    const groups = [sec, ...Object.keys(CONFIG_DOCS).filter((k) => k.startsWith(`${sec}.`))];
    const blocks = groups.map((g) => {
      const doc = CONFIG_DOCS[g];
      const fields = Object.entries(doc.fields).filter(([name, f]) => !q || name.toLowerCase().includes(q) || f.desc.toLowerCase().includes(q) || g.includes(q));
      return { g, doc, fields };
    }).filter((b) => b.fields.length || (!q && b.g === sec) || (q && (CONFIG_DOCS[sec].title.includes(q) || sec.includes(q))));
    if (!blocks.length) return [];
    return [{
      key: sec,
      label: <span><code>{sec}</code> <Typography.Text type="secondary">{CONFIG_DOCS[sec].title}</Typography.Text></span>,
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {blocks.map((b) => (
            <div key={b.g}>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
                {b.g.includes('.') && <b>{b.doc.title}：</b>}{b.doc.desc}{b.doc.list && '（列表，每项以 - 开头）'}
              </Typography.Paragraph>
              {b.fields.map(([name, f]) => <FieldRow key={name} name={name} f={f} onJump={() => jump(b.g.split('.'), name)} />)}
            </div>
          ))}
        </div>
      ),
    }];
  }), [q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-title">
        <h2><Code size={18} />YAML 配置</h2>
        <Space>
          <Typography.Text type="secondary" className="mono">{status?.configPath}</Typography.Text>
          <Button icon={<BookOpen size={14} />} type={panel ? 'primary' : 'default'} ghost={panel} onClick={() => setPanel(!panel)}>字段说明</Button>
          <Button icon={<FolderOpen size={14} />} onClick={() => void window.relay.openConfigFile()}>用外部编辑器打开</Button>
          <Button icon={<RefreshCw size={14} />} onClick={() => void load()}>重新加载</Button>
          <Button type="primary" icon={<Save size={14} />} disabled={!dirty} onClick={() => void save()}>保存 (⌘S)</Button>
        </Space>
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 12, minHeight: 0 }}>
        <Card size="small" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }} styles={{ body: { flex: 1, minHeight: 0, padding: 0 } }}>
          <CodeEditor value={text} language="yaml" height="100%" onChange={(v) => { setText(v); setDirty(true); }} onSave={() => void save()}
            onReady={(e) => { editor.current = e; }} options={{ minimap: { enabled: false }, fontSize: 13, hover: { delay: 200 } }} />
        </Card>
        {panel && (
          <Card size="small" style={{ width: 380, display: 'flex', flexDirection: 'column', minHeight: 0 }} styles={{ body: { flex: 1, minHeight: 0, overflow: 'auto', padding: 12 } }}
            title="字段说明" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>鼠标悬停字段名也能看到说明</Typography.Text>}>
            <Input.Search allowClear placeholder="搜索字段或说明" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 10 }} />
            {items.length ? <Collapse size="small" items={items} {...(q ? { activeKey: items.map((i) => i.key) } : { defaultActiveKey: ['general'] })} /> : <Empty description="没有匹配的字段" />}
          </Card>
        )}
      </div>
    </div>
  );
}

function FieldRow({ name, f, onJump }: { name: string; f: FieldDoc; onJump: () => void }) {
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px dashed #f0f0f0' }}>
      <Space size={6} wrap>
        <Typography.Link code onClick={onJump} title="在编辑器中定位">{name}</Typography.Link>
        {f.type && <Tag style={{ margin: 0 }}>{f.type}</Tag>}
        {f.def && <Typography.Text type="secondary" style={{ fontSize: 12 }}>默认 {f.def}</Typography.Text>}
      </Space>
      <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{f.desc}</div>
      {f.values && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: '#555' }}>
          {Object.entries(f.values).map(([v, t]) => <li key={v}><code>{v}</code>：{t}</li>)}
        </ul>
      )}
      {f.example && <div style={{ fontSize: 12, marginTop: 2 }}>示例：<code>{f.example}</code></div>}
    </div>
  );
}
