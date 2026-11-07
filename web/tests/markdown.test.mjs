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
const { isLocalFilePath, filePathFromHref, fileLineFromHref } = await import(linksUrl);
const imagesUrl = dataUrl(ts.transpileModule(await readFile(new URL('../src/markdown-images.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);

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
let imageText = ts.transpileModule(await readFile(new URL('../src/components/ChatImage.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), '../markdown-images': imagesUrl, './ImagePreview': previewUrl })) imageText = imageText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
const chatImageUrl = dataUrl(imageText);
const { SessionImageSourceProvider } = await import(chatImageUrl);

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
  '../markdown-images': imagesUrl,
  './ChatImage': chatImageUrl,
  '../markdown-schema': schemaUrl,
  '../markdown-reveal': dataUrl('export const rehypeStreamReveal = () => () => {};'),
  'react-markdown': import.meta.resolve('react-markdown'),
  'remark-gfm': import.meta.resolve('remark-gfm'),
  'remark-math': import.meta.resolve('remark-math'),
  'remark-breaks': import.meta.resolve('remark-breaks'),
  'rehype-raw': import.meta.resolve('rehype-raw'),
  'rehype-sanitize': import.meta.resolve('rehype-sanitize'),
  'rehype-katex': import.meta.resolve('rehype-katex'),
  'katex/dist/katex.min.css': dataUrl('export default {};'),
  // Monaco is stubbed: this suite covers markdown structure, not tokenizing.
  '../highlight': (await import('./helpers/highlight.mjs')).highlightStub,
  'lucide-react': import.meta.resolve('lucide-react'),
  './ImagePreview': previewUrl,
  './ui': uiStub,
  // The collapse-all bridge lives in Motion.tsx; Markdown only needs the hook.
  './Motion': dataUrl('export const useCollapseAll = () => {};'),
  './LinkPopover': linkPopoverUrl,
  // The inline file chip renders a lucide glyph; this suite checks structure only.
  './FileGlyph': dataUrl('export default () => null;'),
};

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

function imageHarness() {
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const requests = [], revoked = [];
  let next = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), signal: options.signal });
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
  };
  URL.createObjectURL = () => `blob:image-${++next}`;
  URL.revokeObjectURL = url => revoked.push(url);
  const api = { assetUrl: path => `http://backend.invalid/api${path}` };
  const wrap = ({ children }) => createElement(ImagePreviewProvider, null,
    createElement(SessionImageSourceProvider, { api, workspaceHash: 'workspace', sessionName: 'session one' }, children));
  return { api, wrap, requests, revoked, restore() {
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  } };
}

test('reply image paths use the authenticated session endpoint, including bare and escaped names', async () => {
  const harness = imageHarness();
  const fixtures = [
    ['qr.png', 'qr.png'],
    ['images/二维码.png', 'images/二维码.png'],
    ['C:/repo/二维码 result.png', 'C:/repo/二维码 result.png'],
    ['/C:/repo/qr.png', 'C:/repo/qr.png'],
    ['C:\\repo\\image.png', 'C:/repo/image.png'],
    [String.raw`C:\Users\15614\.loopra\chat-workspace\pixel-gungeon\screenshots\1-title.png`, 'C:/Users/15614/.loopra/chat-workspace/pixel-gungeon/screenshots/1-title.png'],
    ['/tmp/image.png', '/tmp/image.png'],
    ['images/100%25%20done%23%3F.png', 'images/100% done#?.png'],
    ['images/literal%2520.png', 'images/literal%20.png'],
  ];
  try {
    for (const [path, expected] of fixtures) {
      const view = await mount(`![二维码](<${path}>)`, {}, harness.wrap);
      try {
        const request = new URL(harness.requests.at(-1).url);
        assert.equal(request.pathname, '/api/files/image');
        assert.equal(request.searchParams.get('workspaceHash'), 'workspace');
        assert.equal(request.searchParams.get('sessionName'), 'session one');
        assert.equal(request.searchParams.get('path'), expected);
        const image = view.container.querySelector('img');
        assert.match(image.getAttribute('src'), /^blob:image-/);
        assert.equal(image.alt, '二维码');
        await act(async () => view.container.querySelector('.markdown-image-button').click());
        assert.equal(document.querySelector('.image-preview-full').getAttribute('src'), image.getAttribute('src'));
        await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
      } finally { await view.unmount(); }
    }
    assert.equal(harness.revoked.length, fixtures.length);
  } finally { harness.restore(); }
});

test('Windows image destinations preserve separators before Markdown punctuation', async () => {
  const harness = imageHarness();
  const path = String.raw`C:\Users\15614\.loopra\chat-workspace\pixel-gungeon\screenshots\1-title.png`;
  const expected = 'C:/Users/15614/.loopra/chat-workspace/pixel-gungeon/screenshots/1-title.png';
  const fixtures = [
    [`![标题](${path})`, expected],
    [`![标题](<${path}> "截图")`, expected],
    [String.raw`![截图](C:\repo\_shots\!done.png)`, 'C:/repo/_shots/!done.png'],
    [String.raw`![截图](C:\.shots\image.png)`, 'C:/.shots/image.png'],
    [String.raw`![截图](C:\\repo\\.shots\\image.png)`, 'C:/repo/.shots/image.png'],
    [String.raw`![截图](C:/repo/foo\(1\).png)`, 'C:/repo/foo(1).png'],
    [String.raw`![截图](<C:\repo\.shots\100%25%20done.png>)`, 'C:/repo/.shots/100% done.png'],
    [`![标题][shot]\n\n[shot]: <${path}> "截图"`, expected],
  ];
  try {
    for (const [text, destination] of fixtures) {
      const view = await mount(text, {}, harness.wrap);
      try {
        assert.equal(new URL(harness.requests.at(-1).url).searchParams.get('path'), destination, text);
        assert.ok(view.container.querySelector('img'), text);
      } finally { await view.unmount(); }
    }
    const opened = [];
    const shared = await mount(`![标题][shot]\n\n[文件][shot]\n\n[shot]: <${path}>`, { onOpenFile: value => opened.push(value) }, harness.wrap);
    try {
      await act(async () => shared.container.querySelector('.ai-file-link').click());
      assert.deepEqual(opened, [expected]);
    } finally { await shared.unmount(); }
    const count = harness.requests.length;
    const code = await render('```markdown\n' + `![标题](${path})` + '\n```\n\n`' + path + '`', {}, harness.wrap);
    assert.ok(code.includes('15614\\.loopra'));
    const escaped = await render(String.raw`\!\[标题\]` + `(${path})`, {}, harness.wrap);
    assert.ok(!escaped.includes('<img'));
    assert.equal(harness.requests.length, count);
  } finally { harness.restore(); }
});

test('streaming and historical Markdown keep image references without fetching every delta', async () => {
  const harness = imageHarness();
  const text = String.raw`![二维码](C:\Users\15614\.loopra\screenshots\qr.png)`;
  const view = await mount(text, { streaming: true }, harness.wrap);
  try {
    const first = view.container.querySelector('img').getAttribute('src');
    await act(async () => view.root.render(createElement(harness.wrap, null,
      createElement(Markdown, { text: text + '\n\n完成', streaming: true, notify() {} }))));
    assert.equal(harness.requests.length, 1);
    assert.equal(view.container.querySelector('img').getAttribute('src'), first);
    await act(async () => view.root.render(createElement(harness.wrap, null,
      createElement(Markdown, { text: text + '\n\n完成', notify() {} }))));
    assert.equal(harness.requests.length, 1);
  } finally { await view.unmount(); }
  try {
    const history = await mount(text, {}, harness.wrap);
    assert.equal(harness.requests.length, 2);
    assert.match(history.container.querySelector('img').getAttribute('src'), /^blob:/);
    await history.unmount();
  } finally { harness.restore(); }
});

test('switching sessions hides the previous image, aborts stale reads and releases blobs', async () => {
  const harness = imageHarness();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url: String(url), signal: options.signal, resolve }));
  const render = sessionName => act(async () => root.render(createElement(SessionImageSourceProvider,
    { api: harness.api, workspaceHash: 'workspace', sessionName }, createElement(Markdown, { text: '![图片](qr.png)', notify() {} }))));
  const respond = async index => act(async () => pending[index].resolve(new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } })));
  try {
    await render('first'); await respond(0);
    assert.equal(container.querySelector('img').getAttribute('src'), 'blob:image-1');
    await render('second');
    assert.equal(container.querySelector('img'), null);
    assert.ok(pending[0].signal.aborted);
    assert.deepEqual(harness.revoked, ['blob:image-1']);
    await render('third');
    assert.ok(pending[1].signal.aborted);
    await respond(1);
    assert.equal(container.querySelector('img'), null, 'late response cannot replace the next session');
    await respond(2);
    assert.equal(container.querySelector('img').getAttribute('src'), 'blob:image-2');
    assert.equal(new URL(pending[2].url).searchParams.get('sessionName'), 'third');
  } finally { await act(async () => root.unmount()); container.remove(); harness.restore(); }
  assert.deepEqual(harness.revoked, ['blob:image-1', 'blob:image-2']);
});

test('failed reads and browser decode failures offer retry, with no broken image left behind', async () => {
  const harness = imageHarness();
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('{}', { status: 401 })
    : calls === 2 ? new Response('<html/>', { headers: { 'Content-Type': 'text/html' } })
    : new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/avif' } });
  const view = await mount('![图片](qr.png)', {}, harness.wrap);
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal(view.container.querySelector('img'), null);
      assert.match(view.container.textContent, /图片无法读取/);
      await act(async () => view.container.querySelector('.chat-image-state button').click());
    }
    await act(async () => view.container.querySelector('img').dispatchEvent(new window.Event('error')));
    assert.equal(view.container.querySelector('img'), null);
    await act(async () => view.container.querySelector('.chat-image-state button').click());
    assert.ok(view.container.querySelector('img'));
  } finally { await view.unmount(); harness.restore(); }
});

test('external images bypass local fetching and unsafe protocols or code fences never load images', async () => {
  const harness = imageHarness();
  try {
    const remote = await render('![示例](https://example.com/a.png)', {}, harness.wrap);
    assert.match(remote, /src="https:\/\/example.com\/a.png"/);
    assert.match(remote, /referrerpolicy="no-referrer"/);
    for (const src of ['javascript:alert(1)', 'file:///etc/a.png', '//example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=']) {
      const html = await render(`<img src="${src}" onerror="alert(1)">`, {}, harness.wrap);
      assert.ok(!html.includes('<img'));
    }
    const code = await render('```markdown\n![二维码](qr.png)\n```', {}, harness.wrap);
    assert.ok(!code.includes('<img'));
    assert.equal(harness.requests.length, 0);
  } finally { harness.restore(); }
});

test('workspace file links are intercepted rather than opened in a tab', async () => {
  const opened = [];
  const view = await mount('[src/app.ts:12](src/app.ts:12)', { onOpenFile: path => opened.push(path) });
  const link = view.container.querySelector('a.ai-file-link');
  assert.ok(link, 'local file path should render an ai-file-link');
  assert.equal(link.getAttribute('target'), null);
  // The chip shows the file name plus the line it points at, e.g. (line 12).
  assert.equal(link.querySelector('.ai-file-name').textContent, 'app.ts');
  assert.equal(link.querySelector('.ai-file-line').textContent, '(line 12)');
  assert.equal(link.getAttribute('title'), '打开文件预览 · src/app.ts (line 12)');
  await act(async () => { link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })); });
  assert.deepEqual(opened, ['src/app.ts']);

  // A link whose text already carries the hint keeps it as the line suffix.
  const textLine = await mount('[AttachmentBiz.java (line 25)](/C:/repo/src/AttachmentBiz.java)', { onOpenFile: () => {} });
  assert.equal(textLine.container.querySelector('.ai-file-name').textContent, 'AttachmentBiz.java');
  assert.equal(textLine.container.querySelector('.ai-file-line').textContent, '(line 25)');
  await textLine.unmount();

  // A link without a line suffix keeps the plain chip.
  const plain = await render('[app.ts](src/app.ts)', { onOpenFile: () => {} });
  assert.match(plain, /ai-file-name/);
  assert.ok(!plain.includes('ai-file-line'));

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
  assert.equal(fileLineFromHref('src/app.ts:12'), 12);
  assert.equal(fileLineFromHref('src/app.ts'), null);
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

test('slash-prefixed absolute file links use the internal preview and strip line numbers', async () => {
  const fixtures = [
    ['[styles.css:312](/C:/Users/15614/Documents/code/agent4j/web/src/styles.css:312)', 'C:/Users/15614/Documents/code/agent4j/web/src/styles.css'],
    ['<a href="/C:/repo/src/app.ts:12" target="_blank">app.ts:12</a>', 'C:/repo/src/app.ts'],
    ['[app.ts:12](/home/user/repo/src/app.ts:12)', '/home/user/repo/src/app.ts'],
  ];
  for (const [text, path] of fixtures) {
    const opened = [];
    const view = await mount(text, { onOpenFile: value => opened.push(value) });
    try {
      const link = view.container.querySelector('a.ai-file-link');
      assert.ok(link, text);
      assert.equal(link.getAttribute('target'), null);
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => { link.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true);
      assert.deepEqual(opened, [path]);
    } finally { await view.unmount(); }
  }
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
