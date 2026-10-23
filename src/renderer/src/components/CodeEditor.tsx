import { lazy, Suspense, type ComponentProps } from 'react';
import { Skeleton } from 'antd';

const Monaco = lazy(() => import('./MonacoEditor'));

/** VS Code (Monaco) editor, loaded on first use. */
export default function CodeEditor(props: ComponentProps<typeof Monaco>) {
  return (
    <Suspense fallback={<div style={{ height: props.height ?? 200, padding: 8 }}><Skeleton active paragraph={{ rows: 3 }} /></div>}>
      <Monaco {...props} />
    </Suspense>
  );
}
