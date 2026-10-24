import { useEffect, useState } from 'react';
import { Checkbox, InputNumber, Modal, Select, Space, Typography } from 'antd';
import type { SyncOptions } from '@shared/types';
import { useRelay } from '../relay';

/** Matches MAX_PER_CHAT in main/store.ts: the records keep at most this many messages per chat. */
const MAX = 300;
const RANGES = [
  { value: 10, label: '最近 10 分钟' }, { value: 30, label: '最近 30 分钟' }, { value: 60, label: '最近 1 小时' },
  { value: 180, label: '最近 3 小时' }, { value: 720, label: '最近 12 小时' }, { value: 1440, label: '最近 1 天' },
  { value: 4320, label: '最近 3 天' }, { value: 10080, label: '最近 7 天' }, { value: 0, label: '不限时间' },
];
const KEY = 'relay.syncOptions';

const minutesLabel = (m: number) => (m >= 1440 && m % 1440 === 0 ? `最近 ${m / 1440} 天` : m >= 60 && m % 60 === 0 ? `最近 ${m / 60} 小时` : `最近 ${m} 分钟`);

/** Options of「同步历史」: time range, message count, images, whether older records stay. Remembers the last choice. */
export default function SyncModal({ chat, open, onClose, onSync }: { chat: string; open: boolean; onClose: () => void; onSync: (o: SyncOptions) => void }) {
  const { config } = useRelay();
  const [o, setO] = useState<SyncOptions>({ minutes: 10, limit: MAX, images: true, keepOlder: false });
  useEffect(() => {
    if (!open) return;
    let saved: Partial<SyncOptions> = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { /* ignore */ }
    setO({ minutes: config?.general.historyMinutes ?? 10, limit: MAX, images: true, keepOlder: false, ...saved });
  }, [open, config]);
  const set = (p: Partial<SyncOptions>) => setO((x) => ({ ...x, ...p }));
  const ranges = RANGES.some((r) => r.value === o.minutes) ? RANGES : [...RANGES, { value: o.minutes, label: minutesLabel(o.minutes) }].sort((a, b) => (a.value || Infinity) - (b.value || Infinity));

  return (
    <Modal title={`同步「${chat}」的历史`} open={open} onCancel={onClose} okText="同步" cancelText="取消"
      onOk={() => { localStorage.setItem(KEY, JSON.stringify(o)); onSync(o); onClose(); }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        在后台打开该会话并向上滚动读取消息，读到时间范围的边界、条数上限或会话顶部即停止，然后用读取结果重建本地记录（不会前置微信）。
      </Typography.Paragraph>
      <Space direction="vertical" size={12}>
        <Space size={6}>时间范围<Select style={{ width: 140 }} value={o.minutes} onChange={(v) => set({ minutes: v })} options={ranges} /></Space>
        <Space size={6}>最多<InputNumber min={10} max={MAX} step={50} value={o.limit} onChange={(v) => set({ limit: v ?? MAX })} />条
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>（本地每个会话最多保存 {MAX} 条）</Typography.Text></Space>
        <Checkbox checked={o.images} onChange={(e) => set({ images: e.target.checked })}>保存图片（关闭后新读到的图片只保留识别文字，更快）</Checkbox>
        <Checkbox checked={o.keepOlder} onChange={(e) => set({ keepOlder: e.target.checked })}>保留范围之前的本地记录（否则只留下这次读到的消息）</Checkbox>
      </Space>
    </Modal>
  );
}
