import { useContext, useEffect, useRef } from 'react';
import Editor, { loader, type EditorProps } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { docAt, docMarkdown, keysAt } from '@shared/fieldDocs';
import { SDK_DTS } from '@shared/scriptSdk';
import { PageVisit } from '../pageVisit';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

// Bundle Monaco locally (no CDN; the app CSP only allows 'self').
self.MonacoEnvironment = {
  getWorker: (_: string, label: string) => (label === 'json' ? new JsonWorker() : label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};
// Script tools / scripts import npm packages the editor cannot resolve: keep type checking, but ignore unresolved modules
// (2307 / 2792 / 7016) and implicit any. Types come from extra libs: the script SDK, Node's own (loaded on demand) and the
// @types of a script's folder (setScriptTypings).
const ts = monaco.typescript;
ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [2307, 2792, 7016, 1479] });
ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.NodeJs,
  allowNonTsExtensions: true, strict: true, noImplicitAny: false, esModuleInterop: true, allowSyntheticDefaultImports: true, skipLibCheck: true,
});
ts.typescriptDefaults.addExtraLib(SDK_DTS, 'file:///relay-sdk.d.ts');

// Node's typings (@types/node + undici-types) are bundled lazily: a separate chunk, registered the first time a TypeScript editor opens.
const nodeTypings = import.meta.glob(['../../../../node_modules/@types/node/**/*.d.ts', '../../../../node_modules/undici-types/**/*.d.ts'], { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
let nodeTypesLoaded: Promise<void> | null = null;
function ensureNodeTypes(): Promise<void> {
  return (nodeTypesLoaded ??= (async () => {
    await Promise.all(Object.entries(nodeTypings).map(async ([path, load]) => {
      ts.typescriptDefaults.addExtraLib(await load(), `file:///${path.slice(path.indexOf('node_modules/'))}`);
    }));
  })());
}

const scriptLibs = new Map<string, string>();
/** Registers .d.ts files (uri → text) of a script folder; unchanged files are skipped. */
export function setScriptTypings(files: Record<string, string>): void {
  for (const [uri, text] of Object.entries(files)) {
    if (scriptLibs.get(uri) === text) continue;
    scriptLibs.set(uri, text);
    ts.typescriptDefaults.addExtraLib(text, uri);
  }
}
loader.config({ monaco });

// Monaco finishes some async work (hover, completion, TS worker) after its editor was disposed (modal closed, page
// switched) and then throws "InstantiationService has been disposed". It is harmless: drop just that error.
const disposedNoise = (m: unknown) => /InstantiationService has been disposed/.test(String((m as Error)?.message ?? m));
window.addEventListener('unhandledrejection', (e) => { if (disposedNoise(e.reason)) e.preventDefault(); });
window.addEventListener('error', (e) => { if (disposedNoise(e.error ?? e.message)) e.preventDefault(); });

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
  /** Model path (file:///…): gives TypeScript a file name so imports / @types resolve like in a project. */
  path?: string;
  height?: number | string;
  options?: EditorProps['options'];
  onSave?: () => void;
  /** Receives the editor instance (e.g. to jump to a line). */
  onReady?: (editor: monaco.editor.IStandaloneCodeEditor | null) => void;
}

/** VS Code editor (Monaco). Works as a controlled antd Form control. */
export default function CodeEditor({ value, onChange, language = 'plaintext', path, height = 200, options, onSave, onReady }: Props) {
  // The editor is created asynchronously and disposed on unmount (modal closed, page switched): never touch it after that,
  // and keep the latest callbacks in refs (the Ctrl+S command is registered only once).
  const alive = useRef(true);
  const saveRef = useRef(onSave);
  const readyRef = useRef(onReady);
  saveRef.current = onSave;
  readyRef.current = onReady;
  // Hiding the keep-alive page disposed the editor while @monaco-editor/react still holds it as ready: a fresh one on every show.
  const visit = useContext(PageVisit);
  useEffect(() => {
    alive.current = true;
    if (language === 'typescript') void ensureNodeTypes();
    return () => { alive.current = false; readyRef.current?.(null); };
  }, [language]);
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 6, overflow: 'hidden', height }}>
      <Editor
        key={visit}
        value={value ?? ''}
        language={language}
        path={path}
        height="100%"
        theme="vs"
        onChange={(v) => onChange?.(v ?? '')}
        onMount={(editor, m) => {
          if (!alive.current) return;
          try { editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => saveRef.current?.()); } catch { /* disposed meanwhile */ }
          readyRef.current?.(editor);
        }}
        options={{
          minimap: { enabled: false }, fontSize: 12, lineHeight: 19, tabSize: 2, scrollBeyondLastLine: false,
          wordWrap: language === 'markdown' || language === 'plaintext' ? 'on' : 'off', automaticLayout: true,
          renderLineHighlight: 'none', lineNumbersMinChars: 3, padding: { top: 6 }, ...options,
        }}
      />
    </div>
  );
}
