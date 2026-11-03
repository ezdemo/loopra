import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// While a reply streams, markdown-reveal.ts wraps the characters of the live
// block so CSS can fade each one in as React mounts it. These tests mount the
// real Markdown pipeline and check the three things that make that safe: the
// text stays intact, only the live block is wrapped, and a delta mounts only the
// new tail (existing character nodes keep their identity, so nothing re-fades).
// Everything here is client-side; the animation itself is CSS (motion.css).
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const transpile = (source, jsx = false) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: jsx ? ts.JsxEmit.ReactJSX : undefined },
}).outputText;

const uiStub = dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});\nexport const IconButton = ({ children }) => createElement('button', null, children);\n`);
const moduleUrl = async path => dataUrl(transpile(await readFile(new URL(path, import.meta.url), 'utf8')));
const jsxImports = { react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'react-dom': import.meta.resolve('react-dom'), 'lucide-react': import.meta.resolve('lucide-react') };
const rewrite = (code, imports) => {
  let result = code;
  for (const [specifier, url] of Object.entries(imports)) result = result.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return result;
};
const componentUrl = async path => dataUrl(rewrite(transpile(await readFile(new URL(path, import.meta.url), 'utf8'), true), jsxImports));

const schemaUrl = dataUrl(transpile(await readFile(new URL('../src/markdown-schema.ts', import.meta.url), 'utf8'))
  .replaceAll("'rehype-sanitize'", JSON.stringify(import.meta.resolve('rehype-sanitize'))));

const specifiers = {
  react: reactUrl,
  'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
  '../markdown-math': await moduleUrl('../src/markdown-math.ts'),
  '../markdown-alert': await moduleUrl('../src/markdown-alert.ts'),
  '../markdown-links': await moduleUrl('../src/markdown-links.ts'),
  '../markdown-schema': schemaUrl,
  '../markdown-reveal': await moduleUrl('../src/markdown-reveal.ts'),
  'react-markdown': import.meta.resolve('react-markdown'),
  'remark-gfm': import.meta.resolve('remark-gfm'),
  'remark-math': import.meta.resolve('remark-math'),
  'remark-breaks': import.meta.resolve('remark-breaks'),
  'rehype-raw': import.meta.resolve('rehype-raw'),
  'rehype-sanitize': import.meta.resolve('rehype-sanitize'),
  'rehype-katex': import.meta.resolve('rehype-katex'),
  'katex/dist/katex.min.css': dataUrl('export default {};'),
  // Monaco is stubbed: this suite covers the reveal pass, not tokenizing.
  '../highlight': (await import('./helpers/highlight.mjs')).highlightStub,
  'lucide-react': import.meta.resolve('lucide-react'),
  './ImagePreview': await componentUrl('../src/components/ImagePreview.tsx'),
  './ui': uiStub,
  './Motion': dataUrl('export const useCollapseAll = () => {};'),
  './LinkPopover': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)}); export const LinkPopoverProvider = ({ children }) => children; export const useLinkPopover = () => ({ show() {}, scheduleHide() {} });`),
  // The inline file chip only needs to exist for this suite.
  './FileGlyph': dataUrl('export default () => null;'),
};

let output = rewrite(transpile(await readFile(new URL('../src/components/Markdown.tsx', import.meta.url), 'utf8'), true), specifiers);
const { default: Markdown } = await import(dataUrl(output));
const { REVEAL_LIMIT } = await import(specifiers['../markdown-reveal']);

async function mount(text, props = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const tree = next => createElement(Markdown, { notify: () => {}, ...next });
  await act(async () => root.render(tree({ text, ...props })));
  return {
    container,
    async render(next) { await act(async () => root.render(tree(next))); },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}

const PARA = '这是一段用于验证流式揭示的中文正文，包含 **加粗** 与 `行内代码`。';

test('a streaming reply wraps only the block that is still growing', async () => {
  const view = await mount(`${PARA}\n\n第二段文字。`, { streaming: true });
  try {
    assert.match(view.container.innerHTML, /stream-char/, 'live text should carry reveal spans');
    const paragraphs = [...view.container.querySelectorAll('p')];
    assert.ok(!paragraphs[0].querySelector('.stream-char'), 'the settled paragraph stays plain');
    assert.ok(paragraphs[1].querySelector('.stream-char'), 'the trailing paragraph is the live one');
    // Wrapping must not disturb the prose: same text, same single spaces.
    assert.equal(paragraphs[0].textContent, '这是一段用于验证流式揭示的中文正文，包含 加粗 与 行内代码。');
    assert.equal(paragraphs[1].textContent, '第二段文字。');
  } finally { await view.unmount(); }
});

test('a delta mounts only the new characters', async () => {
  const view = await mount(`${PARA}\n\n新增`, { streaming: true });
  try {
    const before = [...view.container.querySelectorAll('.stream-char')];
    assert.equal(before.length, 2, 'only the live tail is wrapped');
    await view.render({ text: `${PARA}\n\n新增内容继续`, streaming: true });
    const after = [...view.container.querySelectorAll('.stream-char')];
    assert.equal(after.length, 6);
    // Identity is what keeps the earlier characters from re-fading: React found
    // the same keys and reused the nodes instead of remounting them.
    assert.equal(after[0], before[0], 'existing characters keep their nodes');
    assert.equal(after[1], before[1], 'existing characters keep their nodes');
  } finally { await view.unmount(); }
});

test('code fences, formulas and callouts are revealed as whole units', async () => {
  const code = await mount('说明\n\n```js\nconst a = 1;\n```', { streaming: true });
  try {
    assert.ok(!code.container.querySelector('pre .stream-char'), 'code keeps its exact text');
    assert.match(code.container.textContent, /const a = 1;/);
  } finally { await code.unmount(); }

  const math = await mount('设 $x + 1 = 2$ 成立', { streaming: true });
  try {
    assert.ok(!math.container.querySelector('.katex .stream-char'), 'KaTeX output is never split');
    assert.match(math.container.innerHTML, /class="katex/);
  } finally { await math.unmount(); }

  const alert = await mount('> [!NOTE]\n> 请先备份配置', { streaming: true });
  try {
    // The marker is read from the blockquote's first text child, so it has to
    // survive unwrapped or the card silently degrades to a plain quote.
    assert.match(alert.container.innerHTML, /markdown-alert-note/);
    assert.ok(!alert.container.textContent.includes('[!NOTE]'));
  } finally { await alert.unmount(); }
});

test('a finished turn renders plain text again', async () => {
  const view = await mount(`${PARA}\n\n新增内容`, { streaming: true });
  try {
    assert.ok(view.container.querySelector('.stream-char'));
    await view.render({ text: `${PARA}\n\n新增内容` });
    assert.ok(!view.container.querySelector('.stream-char'), 'the reveal pass is dropped when the turn ends');
    assert.match(view.container.textContent, /新增内容/);
  } finally { await view.unmount(); }
});

test('a runaway paragraph stops wrapping past the budget', async () => {
  const view = await mount('字'.repeat(REVEAL_LIMIT + 1000), { streaming: true });
  try {
    assert.equal(view.container.querySelectorAll('.stream-char').length, REVEAL_LIMIT);
    assert.equal(view.container.textContent.length, REVEAL_LIMIT + 1000, 'all text still renders');
  } finally { await view.unmount(); }
});

test('emoji and combining marks stay in one span', async () => {
  const text = '今天 👨‍👩‍👧 和 é 都正常';
  const view = await mount(text, { streaming: true });
  try {
    assert.equal(view.container.textContent, text);
    const values = [...view.container.querySelectorAll('.stream-char')].map(span => span.textContent);
    assert.ok(values.some(value => value.includes('\u200D')), 'a ZWJ emoji is not split across spans');
    assert.ok(values.includes('é'), 'a precomposed accent stays one character');
  } finally { await view.unmount(); }
});

test('a reply that is only a code fence renders without spans', async () => {
  const view = await mount('```ts\nconst a = 1;\n```', { streaming: true });
  try {
    assert.equal(view.container.querySelectorAll('.stream-char').length, 0);
    assert.match(view.container.textContent, /const a = 1;/);
  } finally { await view.unmount(); }
});

test('text outside the live block never animates', async () => {
  // The settle of an older block must not replay motion when new text arrives.
  const view = await mount('第一段\n\n第二段', { streaming: true });
  try {
    const first = view.container.querySelector('p');
    const firstText = first.firstChild;
    await view.render({ text: '第一段\n\n第二段继续', streaming: true });
    const after = view.container.querySelector('p');
    assert.equal(after.firstChild, firstText, 'the settled paragraph keeps its original text node');
  } finally { await view.unmount(); }
});
