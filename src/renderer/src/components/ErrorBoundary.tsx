import { Component, type ReactNode } from 'react';
import { Button, Result, Typography } from 'antd';

/** Keeps a crash in one page from blanking the whole window. */
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Result status="error" title="页面出错了"
        subTitle={<Typography.Text type="secondary" className="mono">{this.state.error.message}</Typography.Text>}
        extra={<Button onClick={() => this.setState({ error: null })}>重试</Button>} />
    );
  }
}
