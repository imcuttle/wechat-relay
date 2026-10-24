import { useEffect, useState } from 'react';
import { App, Button, Card, Modal, Space, Tag, Typography } from 'antd';
import { Save } from 'lucide-react';
import { DEFAULT_ASK_PROMPT } from '@shared/prompt';
import { errMsg, useRelay } from '../relay';
import CodeEditor from './CodeEditor';

const HELP = (
  <>
    开启「询问我」时加进系统提示词，决定智能体什么时候用 AskUserQuestion 弹窗问你。可用 <code>{'{{myNickname}}'}</code> <code>{'{{chat}}'}</code>{' '}
    <code>{'{{askTimeoutSec}}'}</code>；<code>{'{{#memory}}…{{/memory}}'}</code> 之间的内容只在开启记忆时出现。
  </>
);

/** general.askPrompt, saved right away (no form: a stale form value elsewhere must never overwrite it). Empty = default. */
function useAskPrompt() {
  const { config, saveConfig } = useRelay();
  const { message } = App.useApp();
  const current = config?.general.askPrompt?.trim() || DEFAULT_ASK_PROMPT;
  const save = async (text: string) => {
    try {
      await saveConfig((c) => { c.general.askPrompt = text.trim() === DEFAULT_ASK_PROMPT.trim() ? '' : text; });
      message.success('询问引导已保存');
    } catch (e) { message.error(errMsg(e)); }
  };
  return { current, custom: current !== DEFAULT_ASK_PROMPT, enabled: !!config?.general.askUser, save };
}

/** Button + dialog (settings card). */
export function AskPromptButton() {
  const { current, custom, save } = useAskPrompt();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  return (
    <>
      <Button size="small" onClick={() => { setText(current); setOpen(true); }}>{custom ? '已自定义' : '默认'}</Button>
      <Modal title="询问引导（加进系统提示词）" open={open} width={720} destroyOnHidden onCancel={() => setOpen(false)}
        footer={[
          <Button key="reset" onClick={() => setText(DEFAULT_ASK_PROMPT)}>恢复默认</Button>,
          <Button key="cancel" onClick={() => setOpen(false)}>取消</Button>,
          <Button key="ok" type="primary" onClick={() => void save(text).then(() => setOpen(false))}>保存</Button>,
        ]}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{HELP}</Typography.Paragraph>
        <CodeEditor language="markdown" height={320} value={text} onChange={setText} />
      </Modal>
    </>
  );
}

/** Inline card (提示词 page). */
export function AskPromptCard() {
  const { current, custom, enabled, save } = useAskPrompt();
  const [text, setText] = useState(current);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setText(current); }, [current, dirty]);
  return (
    <Card size="small" style={{ marginBottom: 16 }}
      title={<Space>询问引导（AskUserQuestion）{custom ? <Tag color="blue">已自定义</Tag> : <Tag>默认</Tag>}{!enabled && <Tag color="default">「询问我」未开启</Tag>}</Space>}
      extra={(
        <Space>
          <Button size="small" onClick={() => { setText(DEFAULT_ASK_PROMPT); setDirty(true); }}>恢复默认</Button>
          <Button size="small" type="primary" icon={<Save size={14} />} disabled={!dirty} onClick={() => void save(text).then(() => setDirty(false))}>保存</Button>
        </Space>
      )}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>{HELP}</Typography.Paragraph>
      <CodeEditor language="markdown" height={200} value={text} onChange={(v) => { setText(v); setDirty(true); }} onSave={() => void save(text).then(() => setDirty(false))} />
    </Card>
  );
}
