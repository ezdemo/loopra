import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// KaTeX and alert cards both run through the real react-markdown pipeline, so
// mount the component and assert the rendered HTML keeps the legacy behavior.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const uiStub = dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});\nexport const IconButton = ({ children }) => createElement('button', null, children);\n`);

const mathSource = await readFile(new URL('../src/markdown-math.ts', import.meta.url), 'utf8');
const mathTranspiled = ts.transpileModule(mathSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const mathUrl = dataUrl(mathTranspiled);
const { normalizeMathMarkdown } = await import(mathUrl);

const alertSource = await readFile(new URL('../src/markdown-alert.ts', import.meta.url), 'utf8');
const alertTranspiled = ts.transpileModule(alertSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const alertUrl = dataUrl(alertTranspiled);
const { normalizeAlertMarkdown } = await import(alertUrl);

const linksSource = await readFile(new URL('../src/markdown-links.ts', import.meta.url), 'utf8');
const linksTranspiled = ts.transpileModule(linksSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const linksUrl = dataUrl(linksTranspiled);
const { isLocalFilePath, filePathFromHref } = await import(linksUrl);

const schemaSource = await readFile(new URL('../src/markdown-schema.ts', import.meta.url), 'utf8');
const schemaTranspiled = ts.transpileModule(schemaSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const schemaUrl = dataUrl(schemaTranspiled.replaceAll("'rehype-sanitize'", JSON.stringify(import.meta.resolve('rehype-sanitize'))));

const previewSource = await readFile(new URL('../src/components/ImagePreview.tsx', import.meta.url), 'utf8');
let previewTranspiled = ts.transpileModule(previewSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'react-dom': import.meta.resolve('react-dom'), 'lucide-react': import.meta.resolve('lucide-react') })) {
  previewTranspiled = previewTranspiled.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const previewUrl = dataUrl(previewTranspiled);
const { ImagePreviewProvider } = await import(previewUrl);

// Real LinkPopover (link hover toolbar) so the markdown wiring is covered here.
const linkPureText = ts.transpileModule(await readFile(new URL('../src/link-popover.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const linkPureUrl = dataUrl(linkPureText);
let linkPopoverText = ts.transpileModule(await readFile(new URL('../src/components/LinkPopover.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'react-dom': import.meta.resolve('react-dom'), 'lucide-react': import.meta.resolve('lucide-react'), '../link-popover': linkPureUrl })) {
  linkPopoverText = linkPopoverText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const linkPopoverUrl = dataUrl(linkPopoverText);

const specifiers = {
  react: reactUrl,
  'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
  '../markdown-math': mathUrl,
  '../markdown-alert': alertUrl,
  '../markdown-links': linksUrl,
  '../markdown-schema': schemaUrl,
  'react-markdown': import.meta.resolve('react-markdown'),
  'remark-gfm': import.meta.resolve('remark-gfm'),
  'remark-math': import.meta.resolve('remark-math'),
  'remark-breaks': import.meta.resolve('remark-breaks'),
  'rehype-raw': import.meta.resolve('rehype-raw'),
  'rehype-sanitize': import.meta.resolve('rehype-sanitize'),
  'rehype-katex': import.meta.resolve('rehype-katex'),
  'katex/dist/katex.min.css': dataUrl('export default {};'),
  'highlight.js/lib/core': import.meta.resolve('highlight.js/lib/core'),
  'lucide-react': import.meta.resolve('lucide-react'),
  './ImagePreview': previewUrl,
  './ui': uiStub,
  // The collapse-all bridge lives in Motion.tsx; Markdown only needs the hook.
  './Motion': dataUrl('export const useCollapseAll = () => {};'),
  './LinkPopover': linkPopoverUrl,
};
for (const language of ['javascript', 'typescript', 'python', 'bash', 'json', 'css', 'xml']) {
  specifiers[`highlight.js/lib/languages/${language}`] = import.meta.resolve(`highlight.js/lib/languages/${language}`);
}

const source = await readFile(new URL('../src/components/Markdown.tsx', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
for (const [specifier, url] of Object.entries(specifiers)) {
  outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const { default: Markdown } = await import(dataUrl(outputText));

async function render(text, props = {}, wrapper) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const tree = createElement(Markdown, { text, notify: () => {}, ...props });
  await act(async () => root.render(wrapper ? createElement(wrapper, null, tree) : tree));
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return html;
}

test('inline and display dollars render as KaTeX like the legacy renderer', async () => {
  const inline = await render('设 $x + 1 = 2$ 成立');
  assert.match(inline, /class="katex/);
  assert.ok(!inline.includes('katex-display'));

  const display = await render('答案是 $$(6 - 5)! \\times 4! = 24$$');
  assert.match(display, /katex-display/);
  assert.ok(!display.includes('$$'));
});

test('prices and code spans are not misread as math', async () => {
  const prices = await render('价格是 $5 和 $6 之间');
  assert.ok(!prices.includes('katex'));
  assert.match(prices, /\$5/);

  const code = await render('```js\nconst price = "$5";\n```');
  assert.ok(!code.includes('katex'));
});

test('normalizer promotes inline display math and escapes literal dollars', () => {
  assert.equal(normalizeMathMarkdown('答案 $$x^2$$'), '答案 \n\n$$\nx^2\n$$');
  assert.equal(normalizeMathMarkdown('$$\nE = mc^2\n$$'), '$$\nE = mc^2\n$$');
  assert.equal(normalizeMathMarkdown('价格 $5 和 $6'), '价格 \\$5 和 \\$6');
  assert.equal(normalizeMathMarkdown('行内 $x + 1$ 成立'), '行内 $x + 1$ 成立');
  assert.equal(normalizeMathMarkdown('`$5` 与 ```js\nconst p = "$5"\n```'), '`$5` 与 ```js\nconst p = "$5"\n```');
});

test('GitHub alerts render as cards and drop the marker', async () => {
  const note = await render('> [!NOTE]\n> 请先备份配置');
  assert.match(note, /markdown-alert markdown-alert-note/);
  assert.ok(!note.includes('[!NOTE]'));

  const warning = await render('> [!WARNING]\n> 有风险');
  assert.match(warning, /markdown-alert-warning/);
});

test('plain blockquotes stay blockquotes and Obsidian containers convert', async () => {
  const quote = await render('> 普通引用');
  assert.match(quote, /<blockquote>/);
  assert.ok(!quote.includes('markdown-alert'));

  const tip = await render(':::tip\n换个思路\n:::');
  assert.match(tip, /markdown-alert markdown-alert-tip/);
  assert.ok(!tip.includes(':::tip'));
});

test('alert normalizer converts ::: containers and skips code fences', () => {
  assert.equal(normalizeAlertMarkdown(':::warning\n注意\n:::\n后续'), '> [!WARNING]\n> 注意\n后续');
  assert.equal(normalizeAlertMarkdown('```\n:::note\n```'), '```\n:::note\n```');
  assert.equal(normalizeAlertMarkdown(':::caution\n第一行\n\n第三行\n:::'), '> [!CAUTION]\n> 第一行\n>\n> 第三行');
});

async function mount(text, props = {}, wrapper) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const tree = createElement(Markdown, { text, notify: () => {}, ...props });
  await act(async () => root.render(wrapper ? createElement(wrapper, null, tree) : tree));
  return { container, root, async unmount() { await act(async () => root.unmount()); container.remove(); } };
}

test('markdown images open the shared lightbox and Escape closes it', async () => {
  const view = await mount('![架构图](https://example.com/a.png)', {}, ImagePreviewProvider);
  const button = view.container.querySelector('.markdown-image-button');
  assert.ok(button, 'image should be wrapped in a preview button');
  assert.equal(button.querySelector('img').getAttribute('src'), 'https://example.com/a.png');

  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  const overlay = document.querySelector('.image-preview-overlay');
  assert.ok(overlay, 'lightbox should render');
  assert.equal(overlay.getAttribute('aria-label'), '图片预览');
  assert.equal(overlay.querySelector('.image-preview-full').getAttribute('src'), 'https://example.com/a.png');

  await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); });
  assert.equal(document.querySelector('.image-preview-overlay'), null);
  await view.unmount();
});

test('markdown images stay plain without a preview provider', async () => {
  const html = await render('![架构图](https://example.com/a.png)');
  assert.ok(html.includes('<img'));
  assert.ok(!html.includes('markdown-image-button'));
  assert.equal(document.querySelector('.image-preview-overlay'), null);
});

test('workspace file links are intercepted rather than opened in a tab', async () => {
  const opened = [];
  const view = await mount('[src/app.ts:12](src/app.ts:12)', { onOpenFile: path => opened.push(path) });
  const link = view.container.querySelector('a.ai-file-link');
  assert.ok(link, 'local file path should render an ai-file-link');
  assert.equal(link.getAttribute('target'), null);
  await act(async () => { link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  assert.deepEqual(opened, ['src/app.ts']);

  const external = await render('[文档](https://example.com/docs)');
  assert.match(external, /target="_blank"/);
  assert.ok(!external.includes('ai-file-link'));
  await view.unmount();
});

test('local file path detection matches the legacy highlight rule', () => {
  assert.equal(isLocalFilePath('src/app.ts'), true);
  assert.equal(isLocalFilePath('a/b/c.ts:12'), true);
  assert.equal(isLocalFilePath('C:\\repo\\src\\main.rs'), true);
  assert.equal(isLocalFilePath('https://example.com/a.ts'), false);
  assert.equal(isLocalFilePath('README.md'), false);
  assert.equal(filePathFromHref('src/app.ts:12'), 'src/app.ts');
  assert.equal(filePathFromHref('a\\b\\c.ts'), 'a/b/c.ts');
});

test('absolute drive paths survive react-markdown url handling and sanitizing', async () => {
  const opened = [];
  const view = await mount('[main.rs](C:/repo/src/main.rs)', { onOpenFile: path => opened.push(path) });
  const link = view.container.querySelector('a.ai-file-link');
  assert.ok(link, 'a forward-slash drive path must still become an ai-file-link');
  assert.equal(link.getAttribute('href'), '#');
  await act(async () => { link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  assert.deepEqual(opened, ['C:/repo/src/main.rs']);
  await view.unmount();
});

test('unsafe link protocols stay neutralised', async () => {
  const html = await render('[脚本](javascript:alert(1))');
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('onclick'));
  assert.match(html, /脚本/);
});

test('external links carry the hover hook and workspace files stay on the preview path', async () => {
  const external = await render('[文档](https://example.com/docs)');
  assert.match(external, /class="ai-link"/);
  assert.match(external, /href="https:\/\/example.com\/docs"/);
  // Hovering is wired to the shared LinkPopover provider: mount and hover the
  // anchor to make sure the toolbar actually appears in the document body.
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Markdown, { text: '[文档](https://example.com/docs)', notify: () => {} })));
  const anchor = container.querySelector('a.ai-link');
  assert.ok(anchor, '外部链接渲染成 ai-link');
  await act(async () => { anchor.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
  assert.equal(document.querySelectorAll('.link-popover').length, 1, '悬停出现链接浮层');
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('.link-popover').forEach(node => node.remove());

  const file = await render('[app.ts](src/app.ts)', { onOpenFile: () => {} });
  assert.match(file, /ai-file-link/);
  assert.ok(!file.includes('target="_blank"'), '工作区文件链接不打开新标签');
});

test('single newlines break like the legacy markdown-it renderer', async () => {
  const html = await render('第一行\n第二行');
  assert.match(html, /第一行<br\s*\/?>\s*\n?第二行/);
});

test('raw HTML renders but scripts and event handlers are sanitized', async () => {
  const details = await render('<details><summary>展开</summary>内容</details>');
  assert.match(details, /<summary>展开<\/summary>/);
  assert.ok(!details.includes('&lt;details&gt;'));

  const script = await render('<script>alert(1)</script>普通文本');
  assert.ok(!script.includes('alert(1)'));
  assert.ok(!/onerror/i.test(script));

  const handler = await render('<img src="https://example.com/a.png" onerror="alert(1)">');
  assert.ok(!/onerror/i.test(handler));
  assert.match(handler, /src="https:\/\/example.com\/a.png"/);

  const kbd = await render('按 <kbd>Ctrl</kbd> 键');
  assert.match(kbd, /<kbd>Ctrl<\/kbd>/);
});
