import Editor, { loader, type EditorProps } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';

// Bundle Monaco locally (no CDN; the app CSP only allows 'self').
self.MonacoEnvironment = { getWorker: (_: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker()) };
loader.config({ monaco });

interface Props {
  value?: string;
  onChange?: (v: string) => void;
  language?: string;
  height?: number | string;
  options?: EditorProps['options'];
  onSave?: () => void;
}

/** VS Code editor (Monaco). Works as a controlled antd Form control. */
export default function CodeEditor({ value, onChange, language = 'plaintext', height = 200, options, onSave }: Props) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', height }}>
      <Editor
        value={value ?? ''}
        language={language}
        height="100%"
        theme="vs"
        onChange={(v) => onChange?.(v ?? '')}
        onMount={(editor, m) => { if (onSave) editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, onSave); }}
        options={{
          minimap: { enabled: false }, fontSize: 12, lineHeight: 19, tabSize: 2, scrollBeyondLastLine: false,
          wordWrap: language === 'markdown' || language === 'plaintext' ? 'on' : 'off', automaticLayout: true,
          renderLineHighlight: 'none', lineNumbersMinChars: 3, padding: { top: 6 }, ...options,
        }}
      />
    </div>
  );
}
