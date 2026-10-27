// Monaco cannot run under jsdom (it needs canvas measuring, ResizeObserver and
// `Range.getClientRects`), and the protocol tests import compiled components
// from data: URLs, where a bare `monaco-editor` or relative '../highlight'
// specifier cannot resolve at all. So the tests replace the highlighting
// boundary with these stubs: the pure parsing helpers get their own suite in
// code-highlight.test.mjs against the real module.
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');

/** Stands in for web/src/highlight.ts. Colorization resolves to "not ready", so
 *  components fall back to the plain-text path the assertions already cover. */
export const highlightStub = dataUrl(`
export const MAX_HIGHLIGHT_CHARS = 200000;
export const highlightUri = (path, side) => side + '://highlight/' + path;
export const highlightRevision = () => 0;
export const subscribeHighlight = () => () => {};
export const useHighlightRevision = () => 0;
export const colorizeLines = async () => null;
export const colorizeFence = async () => null;
export const useColorizedLines = () => null;
export const useColorizedFence = () => null;
export const colorRunsText = runs => runs.map(run => run.text).join('');
export const splitRunsByMarks = runs => runs.map(run => ({ ...run, changed: false }));
export const resolveLanguageName = name => name || 'plaintext';
export const isDarkTheme = () => false;
export const highlightThemeName = dark => dark ? 'vs-dark' : 'vs';
export const codeFontSize = root => Math.max(9, Math.round(root * 0.8125));
export const initHighlight = () => Promise.resolve();
`);

/** Stands in for web/src/components/CodeViewer.tsx: renders the file text the
 *  editor would show, so the preview assertions keep testing the wiring. */
export const codeViewerStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ content, gitDiff }) => createElement('pre', { className: 'workspace-code-editor', 'data-git-diff': gitDiff }, content);
`);
