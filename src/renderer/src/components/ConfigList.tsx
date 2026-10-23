import { useState, type ReactNode } from 'react';
import { App, Button, Card, Form, Modal, Popconfirm, Space, Table, type FormInstance, type TableColumnsType } from 'antd';
import { Pencil, Plus, Trash } from 'lucide-react';
import type { AppConfig } from '@shared/types';
import { errMsg, useRelay } from '../relay';

type ListKey = 'providers' | 'harnesses' | 'tools' | 'mcpServers' | 'prompts' | 'agents' | 'rules';
type Item<K extends ListKey> = AppConfig[K][number];

interface Props<K extends ListKey> {
  listKey: K;
  title: ReactNode;
  columns: TableColumnsType<Item<K>>;
  defaults: () => Partial<Item<K>>;
  form: (form: FormInstance, editing: Item<K> | null) => ReactNode;
  toForm?: (item: Item<K>) => Record<string, unknown>;
  fromForm?: (values: Record<string, unknown>, prev: Item<K> | null) => Item<K>;
  extraActions?: (item: Item<K>) => ReactNode;
  /** Runs before the item is saved (e.g. install dependencies); throwing keeps the editor open and shows the error. */
  beforeSave?: (item: Item<K>) => Promise<void>;
  modalWidth?: number;
  /** Extra header buttons next to 新增. */
  extra?: ReactNode;
  sortable?: boolean;
}

/** Table + modal editor for one array section of the config. */
export default function ConfigList<K extends ListKey>(p: Props<K>) {
  const { config, saveConfig } = useRelay();
  const { modal } = App.useApp();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<Item<K> | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const items = (config?.[p.listKey] ?? []) as Item<K>[];

  const edit = (item: Item<K> | null) => {
    setEditing(item);
    form.resetFields();
    // New items go through toForm too, so editors get the same value shapes (e.g. JSON text, not objects).
    const base = item ?? (p.defaults() as Item<K>);
    form.setFieldsValue(p.toForm ? p.toForm(base) : base);
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const item = p.fromForm ? p.fromForm(values, editing) : ({ ...(editing ?? {}), ...values } as Item<K>);
    const id = (item as { id: string }).id;
    if ((!editing || (editing as { id: string }).id !== id) && items.some((x) => (x as { id: string }).id === id)) {
      form.setFields([{ name: 'id', errors: ['ID 已存在'] }]);
      return;
    }
    if (p.beforeSave) {
      setSaving(true);
      try { await p.beforeSave(item); } catch (e) {
        modal.error({ title: '保存前准备失败', width: 720, content: <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', fontSize: 12 }}>{errMsg(e)}</pre> });
        return;
      } finally { setSaving(false); }
    }
    await saveConfig((c) => {
      const list = c[p.listKey] as Item<K>[];
      const i = editing ? list.findIndex((x) => (x as { id: string }).id === (editing as { id: string }).id) : -1;
      if (i >= 0) list[i] = item; else list.push(item);
    });
    setOpen(false);
  };

  const remove = (item: Item<K>) => saveConfig((c) => {
    (c as unknown as Record<string, Item<K>[]>)[p.listKey] = (c[p.listKey] as Item<K>[]).filter((x) => x !== item && (x as { id: string }).id !== (item as { id: string }).id);
  });

  const move = (item: Item<K>, d: -1 | 1) => saveConfig((c) => {
    const list = c[p.listKey] as Item<K>[];
    const i = list.findIndex((x) => (x as { id: string }).id === (item as { id: string }).id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  });

  return (
    <Card size="small" title={p.title} extra={<Space size={8}>{p.extra}<Button type="primary" size="small" icon={<Plus size={14} />} onClick={() => edit(null)}>新增</Button></Space>} style={{ marginBottom: 16 }}>
      <Table<Item<K>>
        size="small"
        rowKey={(r) => (r as { id: string }).id}
        dataSource={items}
        pagination={false}
        columns={[
          ...p.columns,
          {
            title: '操作', key: '_ops', width: p.sortable ? 220 : 150, align: 'right',
            render: (_: unknown, r: Item<K>) => (
              <Space size={4}>
                {p.extraActions?.(r)}
                {p.sortable && <><Button size="small" type="text" onClick={() => void move(r, -1)}>↑</Button><Button size="small" type="text" onClick={() => void move(r, 1)}>↓</Button></>}
                <Button size="small" type="text" icon={<Pencil size={14} />} onClick={() => edit(r)} />
                <Popconfirm title="确定删除？" onConfirm={() => void remove(r)}>
                  <Button size="small" type="text" danger icon={<Trash size={14} />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal open={open} title={editing ? '编辑' : '新增'} onCancel={() => setOpen(false)} onOk={() => void submit()} confirmLoading={saving} width={p.modalWidth ?? 640} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false}>{p.form(form, editing)}</Form>
      </Modal>
    </Card>
  );
}

export const linesToList = (v: unknown): string[] => String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
export const listToLines = (v: string[] | undefined): string => (v ?? []).join('\n');
export const kvToText = (v: Record<string, string> | undefined): string => Object.entries(v ?? {}).map(([k, x]) => `${k}=${x}`).join('\n');
export const textToKv = (v: unknown): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const line of linesToList(v)) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return Object.keys(out).length ? out : undefined;
};
