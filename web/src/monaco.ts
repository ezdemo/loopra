// VS Code's editor, loaded on demand by the code preview. The legacy Vue editor
// (`../../src/utils/monaco.js`) imports the same specifiers, so rollup keeps a
// single shared chunk instead of shipping Monaco twice.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker&inline';
import CssWorker from 'monaco-editor/language/css/css.worker?worker&inline';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker&inline';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker&inline';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker&inline';

// Inlined blob workers: the packaged Electron renderer runs from file://, where
// Chromium blocks module workers loaded from disk (Monaco's own fallback builds
// `new Worker(new URL('….worker.js', import.meta.url))`). Syntax colouring
// itself runs on the main thread, so a missing worker only degrades language
// services and logs a single warning.
globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    return new EditorWorker();
  },
};

export default monaco;
