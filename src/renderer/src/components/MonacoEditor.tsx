import Editor, { loader, type EditorProps } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { docAt, docMarkdown, keysAt } from '@shared/fieldDocs';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

// Bundle Monaco locally (no CDN; the app CSP only allows 'self').
self.MonacoEnvironment = {
  getWorker: (_: string, label: string) => (label === 'json' ? new JsonWorker() : label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};
// Script tools import npm packages the editor cannot resolve: keep syntax errors, skip type checking.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true });
monaco.typescript.typescriptDefaults.setCompilerOptions({ target: monaco.typescript.ScriptTarget.ESNext, module: monaco.typescript.ModuleKind.ESNext, allowNonTsExtensions: true });
loader.config({ monaco });

// config.yaml: hover and key completion with the Chinese field docs (the only YAML editor in the app).
monaco.languages.registerHoverProvider('yaml', {
  provideHover(model, pos) {
    const hit = docAt(model.getLinesContent(), pos.lineNumber - 1, pos.column - 1);
    return hit ? { contents: [{ value: docMarkdown(hit.title, hit.doc) }] } : null;
  },
});
monaco.languages.registerCompletionItemProvider('yaml', {
  provideCompletionItems(model, pos) {
    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1);
    const m = /^(\s*(?:-\s+)?)([\w-]*)$/.exec(before);
    if (!m) return { suggestions: [] };
    const word = model.getWordUntilPosition(pos);
    const range = new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn);
    const lines = model.getLinesContent();
    return {
      suggestions: keysAt(lines, pos.lineNumber - 1, m[1].length).map((k) => ({
        label: k.name, kind: monaco.languages.CompletionItemKind.Property, range, insertText: `${k.name}: `,
        detail: [k.doc.type, k.doc.def ? `默认 ${k.doc.def}` : ''].filter(Boolean).join(' · '),
        documentation: { value: docMarkdown(k.name, k.doc) },
      })),
    };
  },
});

interface Props {
  value?: string;
  onChange?: (v: string) => void;
  language?: string;
  height?: number | string;
  options?: EditorProps['options'];
  onSave?: () => void;
  /** Receives the editor instance (e.g. to jump to a line). */
  onReady?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
}

/** VS Code editor (Monaco). Works as a controlled antd Form control. */
export default function CodeEditor({ value, onChange, language = 'plaintext', height = 200, options, onSave, onReady }: Props) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', height }}>
      <Editor
        value={value ?? ''}
        language={language}
        height="100%"
        theme="vs"
        onChange={(v) => onChange?.(v ?? '')}
        onMount={(editor, m) => { if (onSave) editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, onSave); onReady?.(editor); }}
        options={{
          minimap: { enabled: false }, fontSize: 12, lineHeight: 19, tabSize: 2, scrollBeyondLastLine: false,
          wordWrap: language === 'markdown' || language === 'plaintext' ? 'on' : 'off', automaticLayout: true,
          renderLineHighlight: 'none', lineNumbersMinChars: 3, padding: { top: 6 }, ...options,
        }}
      />
    </div>
  );
}
