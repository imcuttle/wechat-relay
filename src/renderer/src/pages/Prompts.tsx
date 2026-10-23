import { Alert, Form, Input, Typography } from 'antd';
import { FileText } from 'lucide-react';
import CodeEditor from '../components/CodeEditor';
import ConfigList from '../components/ConfigList';

export default function Prompts() {
  return (
    <div className="page">
      <div className="page-title"><h2><FileText size={18} />提示词</h2></div>
      <Alert style={{ marginBottom: 16 }} type="info" showIcon message={
        <span>
          模板变量：<code>{'{{chat}}'}</code> 会话名、<code>{'{{sender}}'}</code> 最新消息发送者、<code>{'{{myNickname}}'}</code> 我的昵称、<code>{'{{now}}'}</code> 今天的日期和星期（精确到秒的时间会附在最新消息前，让提示词保持不变以命中模型的提示词缓存）；
          条件块：<code>{'{{#group}}群聊时显示{{/group}}'}</code>、<code>{'{{^group}}私聊时显示{{/group}}'}</code>。模型输出 <code>[SKIP]</code> 表示不回复。以 <code>persona-</code> 开头的是「会话记录 → 人设」生成的会话人设，启用后替换该会话智能体的提示词，在这里修改同样生效。
        </span>
      } />
      <ConfigList
        listKey="prompts"
        title="提示词模板"
        columns={[
          { title: 'ID', dataIndex: 'id', width: 160, render: (v: string, r) => <Typography.Text strong>{r.name || v}</Typography.Text> },
          { title: '内容', dataIndex: 'content', render: (v: string) => <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0 }}>{v}</Typography.Paragraph> },
        ]}
        defaults={() => ({ id: `prompt-${Date.now().toString(36)}`, content: '' })}
        modalWidth={760}
        form={() => (
          <>
            <Form.Item name="id" label="ID" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="name" label="名称"><Input /></Form.Item>
            <Form.Item name="content" label="内容" rules={[{ required: true }]}><CodeEditor language="markdown" height={340} /></Form.Item>
          </>
        )}
      />
    </div>
  );
}
