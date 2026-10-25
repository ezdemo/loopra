import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { registerDesktopExternalLinks } = require('../../electron/desktop-external-links.cjs');
const renderer = 'file:///app/renderer/index.html';
function harness(openExternal) {
  const app = new EventEmitter(), opened = [], errors = [];
  registerDesktopExternalLinks({ app, shell: { openExternal: openExternal || (url => opened.push(url)) }, isAppUrl: url => url.startsWith(renderer), onError: (...args) => errors.push(args) });
  const create = (url = renderer) => {
    const contents = new EventEmitter();
    contents.getURL = () => url;
    contents.setWindowOpenHandler = handler => { contents.openWindow = handler; };
    app.emit('web-contents-created', {}, contents);
    return contents;
  };
  return { create, opened, errors };
}

test('every new desktop surface opens external popups in the default browser and denies an Electron window', () => {
  const policy = harness();
  for (const name of ['main', 'chat', 'overlay', 'service', 'onboarding', 'requirements']) {
    const contents = policy.create();
    const url = `https://example.com/${name}?q=1#details`;
    assert.deepEqual(contents.openWindow({ url }), { action: 'deny' });
    assert.equal(policy.opened.at(-1), url);
  }
  assert.equal(policy.opened.length, 6);
});

test('external same-tab navigation and redirects leave the app open and use the default browser', () => {
  const policy = harness(), contents = policy.create();
  for (const type of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    contents.emit(type, { preventDefault() { prevented = true; } }, 'https://example.com/docs', false, true);
    assert.equal(prevented, true);
  }
  assert.deepEqual(policy.opened, ['https://example.com/docs', 'https://example.com/docs']);
  let prevented = false;
  contents.emit('will-redirect', { preventDefault() { prevented = true; } }, 'https://example.com/frame', false, false);
  assert.equal(prevented, false, 'subframe redirects do not launch the browser');
});

test('app routes stay internal while unrecognized popup protocols are denied', () => {
  const policy = harness(), contents = policy.create();
  assert.deepEqual(contents.openWindow({ url: renderer + '?requirementBoard=1' }), { action: 'allow' });
  contents.emit('will-navigate', { preventDefault() { assert.fail('internal navigation was blocked'); } }, renderer + '?desktopChatTab=1');
  for (const url of ['javascript:alert(1)', 'file:///private/document', 'not a URL']) assert.deepEqual(contents.openWindow({ url }), { action: 'deny' });
  assert.deepEqual(policy.opened, []);
});

test('browser launch failures are handled without permitting a fallback Electron window', async () => {
  const policy = harness(async () => { throw new Error('launch failed'); });
  assert.deepEqual(policy.create().openWindow({ url: 'https://example.com' }), { action: 'deny' });
  await Promise.resolve();
  assert.equal(policy.errors.length, 1);
});

test('the main process recognizes packaged pages, development pages and running local service windows', async () => {
  const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /registerDesktopExternalLinks\(\{ app, shell, isAppUrl: isDesktopAppUrl \}\)/);
  const helper = main.slice(main.indexOf('function isDesktopAppUrl('), main.indexOf('function parsePort('));
  const dirname = fileURLToPath(new URL('../../electron', import.meta.url));
  const context = vm.createContext({ URL, path, fileURLToPath, __dirname: dirname, isDev: true, DESKTOP_CHAT_DEV_RENDERER_ORIGINS: ['http://127.0.0.1:3000'], loopraWebWindows: new Map([[4568, {}]]), currentPort: 4567 });
  vm.runInContext(helper, context);
  for (const url of [pathToFileURL(path.resolve(dirname, '../renderer/index.html')).href, 'http://127.0.0.1:3000/?desktopShell=1', 'http://localhost:4567/index.html', 'http://127.0.0.1:4568/index.html']) assert.equal(context.isDesktopAppUrl(url), true, url);
  for (const url of ['https://example.com', 'http://localhost:9000', 'http://127.0.0.1:4567.evil.test', pathToFileURL(path.resolve(dirname, '../private/index.html')).href]) assert.equal(context.isDesktopAppUrl(url), false, url);
});
