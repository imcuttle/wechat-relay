import { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Space, Typography } from 'antd';
import { Code, FolderOpen, RefreshCw, Save } from 'lucide-react';
import CodeEditor from '../components/CodeEditor';
import { errMsg, useRelay } from '../relay';

export default function YamlPage() {
  const { config, status } = useRelay();
  const { message } = App.useApp();
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const textRef = useRef(text);
  textRef.current = text;

  const load = () => window.relay.getConfigYaml().then((t) => { setText(t); setDirty(false); });
  useEffect(() => { if (!dirty) void load(); }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    try { await window.relay.saveConfigYaml(textRef.current); setDirty(false); message.success('已保存并生效'); } catch (e) { message.error(`保存失败：${errMsg(e)}`); }
  };

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-title">
        <h2><Code size={18} />YAML 配置</h2>
        <Space>
          <Typography.Text type="secondary" className="mono">{status?.configPath}</Typography.Text>
          <Button icon={<FolderOpen size={14} />} onClick={() => void window.relay.openConfigFile()}>用外部编辑器打开</Button>
          <Button icon={<RefreshCw size={14} />} onClick={() => void load()}>重新加载</Button>
          <Button type="primary" icon={<Save size={14} />} disabled={!dirty} onClick={() => void save()}>保存 (⌘S)</Button>
        </Space>
      </div>
      <Card size="small" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }} styles={{ body: { flex: 1, minHeight: 0, padding: 0 } }}>
        <CodeEditor value={text} language="yaml" height="100%" onChange={(v) => { setText(v); setDirty(true); }} onSave={() => void save()} options={{ minimap: { enabled: true }, fontSize: 13 }} />
      </Card>
    </div>
  );
}
