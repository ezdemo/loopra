import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { codeFontSize, highlightThemeName, initHighlight, isDarkTheme, useHighlightRevision } from '../highlight';

const CODE_FONT_FAMILY = '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", Consolas, "Microsoft YaHei", monospace';

function rootFontSize(): number {
  return Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
}

/**
 * Read-only VS Code editor for the workspace file preview. Loading both the
 * Monaco chunk and the file itself is asynchronous, so the pane stays empty
 * until the editor exists; the caller keeps showing its own status text.
 */
export default function CodeViewer({ path, content, active, onSelect }: {
  path: string; content: string; active: boolean; onSelect: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [ready, setReady] = useState(false);
  // Selection lives in Monaco's own model, so `window.getSelection()` cannot see it.
  const report = useRef(onSelect);
  report.current = onSelect;
  const revision = useHighlightRevision();

  useEffect(() => {
    let disposed = false;
    const owned: Monaco.IDisposable[] = [];
    void (async () => {
      await initHighlight();
      if (disposed || !host.current) return;
      const { default: monaco } = await import('../monaco');
      if (disposed || !host.current) return;
      const uri = monaco.Uri.file(path);
      // An in-flight unmount may still hold the model for this path (React
      // StrictMode remounts effects in development), so reuse instead of throwing.
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel('', undefined, uri);
      owned.push(model);
      const instance = monaco.editor.create(host.current, {
        model,
        ariaLabel: `${path} 文件内容`,
        theme: highlightThemeName(isDarkTheme()),
        readOnly: true,
        domReadOnly: true,
        // Every open tab stays mounted while hidden, so the first measurement can
        // be 0×0 and the real size only arrives when the tab is selected.
        automaticLayout: true,
        fontFamily: CODE_FONT_FAMILY,
        fontSize: codeFontSize(rootFontSize()),
        minimap: { enabled: true, renderCharacters: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        padding: { top: 8, bottom: 8 },
        tabSize: 4,
        contextmenu: false,
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        // The workbench owns light/dark through <html class="dark">.
        autoDetectHighContrast: false,
      });
      editor.current = instance;
      owned.push(instance);
      owned.push(instance.onDidChangeCursorSelection(() => {
        const selection = instance.getSelection();
        const text = instance.getModel();
        report.current(text && selection ? text.getValueInRange(selection).trim() : '');
      }));
      setReady(true);
    })();
    return () => {
      disposed = true;
      editor.current = null;
      for (const item of owned) item.dispose();
    };
  }, [path]);

  useEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!ready || !instance || !model || model.getValue() === content) return;
    // A refresh keeps the reader where they were.
    const state = instance.saveViewState();
    model.setValue(content);
    if (state) instance.restoreViewState(state);
  }, [ready, content]);

  useEffect(() => {
    if (active) editor.current?.layout();
  }, [active, ready]);

  useEffect(() => {
    editor.current?.updateOptions({ fontSize: codeFontSize(rootFontSize()) });
  }, [revision]);

  return <div className="workspace-code-editor" ref={host} />;
}
