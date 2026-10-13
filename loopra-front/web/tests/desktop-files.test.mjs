import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// 旧 FileExplorer.vue 的「重命名 / 在文件管理器中显示」只在 Electron 桥存在时可用；
// 后端没有对应 HTTP 接口，所以浏览器版本按能力探测隐藏这两个入口。
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://test.invalid' });
const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom.window });

const source = await readFile(new URL('../src/desktop-files.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { baseName, canRenameFiles, canRevealFiles, desktopFileBridge, invalidFileName, renamedPath } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
after(() => {
  dom.window.close();
  if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window;
});

test('file name validation mirrors legacy commitEdit', () => {
  assert.equal(invalidFileName(''), true);
  assert.equal(invalidFileName('   '), true);
  assert.equal(invalidFileName('.'), true);
  assert.equal(invalidFileName('..'), true);
  assert.equal(invalidFileName('a/b.ts'), true);
  assert.equal(invalidFileName('a\\b.ts'), true);
  assert.equal(invalidFileName(' app.ts '), false);
  assert.equal(invalidFileName('组件.vue'), false);
});

test('rename helpers keep the directory and separator form', () => {
  assert.equal(baseName('src/web/app.ts'), 'app.ts');
  assert.equal(baseName('src\\web\\app.ts'), 'app.ts');
  assert.equal(baseName('app.ts'), 'app.ts');
  assert.equal(baseName(''), '');
  assert.equal(renamedPath('src/web/app.ts', 'main.ts'), 'src/web/main.ts');
  assert.equal(renamedPath('src\\web\\app.ts', 'main.ts'), 'src/web/main.ts');
  assert.equal(renamedPath('app.ts', 'main.ts'), 'main.ts');
});

test('capability detection needs the Electron bridge', () => {
  assert.equal(desktopFileBridge(), null);
  assert.equal(canRenameFiles(), false);
  assert.equal(canRevealFiles(), false);
  dom.window.electronAPI = { fileExplorer: {}, openFolder: async () => ({ success: true }) };
  assert.equal(canRenameFiles(), false, 'rename 需要 fileExplorer.rename');
  assert.equal(canRevealFiles(), true);
  dom.window.electronAPI.fileExplorer.rename = async () => ({ success: true });
  assert.equal(canRenameFiles(), true);
  assert.equal(canRenameFiles({ fileExplorer: { rename: () => {} } }), true);
  assert.equal(canRevealFiles({}), false);
  delete dom.window.electronAPI;
});
