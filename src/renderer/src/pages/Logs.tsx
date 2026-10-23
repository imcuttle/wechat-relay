import { useEffect, useRef, useState } from 'react';
import { Card, Input, Segmented, Space, Typography } from 'antd';
import { ScrollText } from 'lucide-react';
import type { LogEntry } from '@shared/types';
import { useRelay } from '../relay';

const COLORS: Record<LogEntry['level'], string> = { debug: '#999', info: '#333', warn: '#d48806', error: '#cf1322' };

export default function Logs() {
  const { logs } = useRelay();
  const [level, setLevel] = useState<'all' | 'info' | 'warn'>('info');
  const [q, setQ] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const shown = logs.filter((l) =>
    (level === 'all' || (level === 'info' ? l.level !== 'debug' : l.level === 'warn' || l.level === 'error')) &&
    (!q || `${l.scope} ${l.message}`.includes(q)));
  useEffect(() => { end.current?.scrollIntoView(); }, [shown.length]);

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-title">
        <h2><ScrollText size={18} />运行日志</h2>
        <Space>
          <Input.Search allowClear placeholder="过滤" onSearch={setQ} style={{ width: 200 }} />
          <Segmented value={level} onChange={(v) => setLevel(v as typeof level)} options={[{ label: '全部', value: 'all' }, { label: '信息', value: 'info' }, { label: '警告/错误', value: 'warn' }]} />
        </Space>
      </div>
      <Card size="small" style={{ flex: 1, overflow: 'auto' }}>
        {shown.map((l, i) => (
          <div key={i} className="mono log-line" style={{ color: COLORS[l.level] }}>
            <Typography.Text type="secondary" className="mono">{new Date(l.at).toLocaleTimeString()} </Typography.Text>
            [{l.scope}] {l.message}
          </div>
        ))}
        <div ref={end} />
      </Card>
    </div>
  );
}
