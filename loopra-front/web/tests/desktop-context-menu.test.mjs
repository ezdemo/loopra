import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { desktopContextMenuTemplate, registerDesktopContextMenus } = require('../../electron/desktop-context-menu.cjs');
const roles = template => template.filter(item => item.role).map(item => item.role);
const editable = {
  isEditable: true, formControlType: 'text-area', selectionText: 'selected',
  editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
};

test('selected read-only text offers copy, including whitespace selections', () => {
  for (const selectionText of ['a message', '  \n']) {
    const items = desktopContextMenuTemplate({ selectionText, editFlags: { canCopy: true } });
    assert.deepEqual(items, [{ role: 'copy', label: '复制', enabled: true }]);
  }
  assert.deepEqual(desktopContextMenuTemplate({ selectionText: 'protected', editFlags: { canCopy: false } }), []);
});

test('plain inputs expose standard editing actions with native availability flags', () => {
  const items = desktopContextMenuTemplate(editable);
  assert.deepEqual(roles(items), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  assert.equal(items.find(item => item.role === 'redo').enabled, false);
  assert.equal(items.find(item => item.role === 'paste').enabled, true);
  const empty = desktopContextMenuTemplate({
    ...editable, selectionText: '', editFlags: { canPaste: true },
  });
  assert.equal(empty.find(item => item.role === 'copy').enabled, false);
  assert.equal(empty.find(item => item.role === 'cut').enabled, false);
  assert.equal(empty.find(item => item.role === 'selectAll').enabled, false);
  assert.equal(empty.find(item => item.role === 'paste').enabled, true);
});

test('rich editors also offer paste as plain text', () => {
  const items = desktopContextMenuTemplate({ ...editable, editFlags: { canPaste: false, canEditRichly: true } });
  assert.equal(items.find(item => item.role === 'pasteAndMatchStyle').enabled, false);
});

test('password inputs permit pasting without offering copy or cut', () => {
  const items = desktopContextMenuTemplate({ ...editable, formControlType: 'input-password' });
  assert.deepEqual(roles(items), ['undo', 'redo', 'paste', 'selectAll']);
});

test('blank areas never get developer or reload actions', () => {
  assert.deepEqual(desktopContextMenuTemplate({ isEditable: false, selectionText: '' }), []);
});

test('web links can be copied without opening them and non-web links add no menu', () => {
  const writes = [];
  const linkURL = 'https://example.com/docs?q=one#section';
  const items = desktopContextMenuTemplate({ linkURL }, null, { writeText: text => writes.push(text) });
  assert.equal(items.length, 1);
  assert.equal(items[0].label, '复制链接地址');
  items[0].click();
  assert.deepEqual(writes, [linkURL]);
  for (const linkURL of ['javascript:alert(1)', 'file:///private/file', '#local', '']) {
    assert.deepEqual(desktopContextMenuTemplate({ linkURL }), []);
  }
});

test('image copy targets the clicked contents and tolerates a closed view', () => {
  const copies = [];
  let destroyed = false;
  const contents = { isDestroyed: () => destroyed, copyImageAt: (...point) => copies.push(point) };
  const params = { mediaType: 'image', hasImageContents: true, x: 40, y: 20 };
  const items = desktopContextMenuTemplate(params, contents);
  assert.equal(items[0].label, '复制图片');
  items[0].click();
  assert.deepEqual(copies, [[40, 20]]);
  destroyed = true;
  items[0].click();
  assert.equal(copies.length, 1);
  assert.deepEqual(desktopContextMenuTemplate({ ...params, hasImageContents: false }, contents), []);
});

function harness(beforePopup) {
  const app = new EventEmitter();
  const popups = [];
  const owner = {};
  registerDesktopContextMenus({
    app,
    BrowserWindow: { fromWebContents: contents => contents.owner },
    Menu: { buildFromTemplate: template => ({ popup: options => popups.push({ template, options }) }) },
    clipboard: { writeText: () => {} },
    beforePopup,
  });
  function createContents(type = 'window') {
    const contents = Object.assign(new EventEmitter(), {
      getType: () => type, isDestroyed: () => false, owner, focusCount: 0,
      focus() { this.focusCount++; },
    });
    app.emit('web-contents-created', {}, contents);
    return contents;
  }
  return { popups, owner, createContents };
}

test('main windows and embedded views get the same native menu anywhere in the window', () => {
  const { popups, owner, createContents } = harness();
  const frame = {};
  for (const type of ['window', 'browserView', 'webview']) {
    const contents = createContents(type);
    for (const x of [10, 600]) {
      contents.emit('context-menu', {}, { ...editable, x, frame });
    }
    assert.equal(contents.focusCount, 2);
  }
  assert.equal(popups.length, 6);
  for (const popup of popups) {
    assert.deepEqual(roles(popup.template), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
    assert.equal(popup.options.window, owner);
    assert.equal(popup.options.frame, frame);
  }
});

test('custom menus, blank areas, closed contents and devtools do not get a second menu', () => {
  const { popups, createContents } = harness();
  const contents = createContents();
  contents.emit('context-menu', { defaultPrevented: true }, editable);
  contents.emit('context-menu', {}, { selectionText: '', isEditable: false });
  contents.isDestroyed = () => true;
  contents.emit('context-menu', {}, editable);
  for (const type of ['remote', 'backgroundPage', 'offscreen']) {
    assert.equal(createContents(type).listenerCount('context-menu'), 0);
  }
  assert.equal(popups.length, 0);
});

test('native menus apply the current app theme before opening, without work on blank areas', () => {
  let syncs = 0;
  const { popups, createContents } = harness(() => { syncs++; });
  const contents = createContents();
  contents.emit('context-menu', {}, { isEditable: false, selectionText: '' });
  assert.equal(syncs, 0);
  contents.emit('context-menu', {}, editable);
  assert.equal(syncs, 1);
  assert.equal(popups.length, 1);
});
