import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
const helpers = main.slice(main.indexOf('function waitForDesktopChatReady('), main.indexOf("ipcMain.handle('desktop-chat-tab-create'"));
const require = createRequire(import.meta.url);
const { Linter } = require('eslint');

test('Electron main has no undefined references after removing the browser gateway', () => {
  const issues = new Linter().verify(main, {
    env: { node: true, es2022: true },
    parserOptions: { ecmaVersion: 2022 },
    rules: { 'no-undef': 'error' },
  });
  assert.deepEqual(issues.map(issue => `${issue.line}: ${issue.message}`), []);
});

test('desktop chat tabs still load, queue events, switch visibility and close', async () => {
  class View {
    constructor() {
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.loadFile = async (file, options) => { this.loaded = { file, options }; };
      this.webContents.send = (channel, payload) => this.events.push([channel, payload]);
      this.webContents.close = () => { this.destroyed = true; this.webContents.emit('destroyed'); };
      this.events = [];
      this.destroyed = false;
    }
    setBackgroundColor() {}
    setVisible(visible) { this.visible = visible; }
  }
  const attached = new Set();
  const context = vm.createContext({
    path, __dirname: '/electron', URLSearchParams, console, setTimeout, clearTimeout,
    isDev: false, WebContentsView: View, shell: { openExternal() {} },
    DESKTOP_CHAT_LOAD_TIMEOUT_MS: 1000, DESKTOP_CHAT_LOAD_ATTEMPTS: 1,
    desktopChatTabs: new Map(), desktopChatActiveTabId: null,
    mainWindow: {
      isDestroyed: () => false,
      getContentBounds: () => ({ width: 1000, height: 800 }),
      contentView: { addChildView: view => attached.add(view), removeChildView: view => attached.delete(view) },
    },
  });
  vm.runInContext(helpers, context);
  const first = await context.getOrCreateDesktopChatTab('first', 'session-1', 'workspace');
  assert.equal(first.view.loaded.options.query.desktopChatTab, '1');
  assert.equal(first.view.loaded.options.query.sessionName, 'session-1');
  assert.ok(attached.has(first.view));
  context.sendDesktopChatTabEvent(first, 'queued', 'payload');
  assert.equal(first.pendingEvents[0][0], 'queued');
  const ready = context.waitForDesktopChatReady(first, 1000);
  first.rendererReady = true;
  for (const resolve of first.readyWaiters.splice(0)) resolve(true);
  assert.equal(await ready, true);
  const reused = await context.getOrCreateDesktopChatTab('first', 'session-1', 'workspace', 'dark', false, 'Renamed');
  assert.equal(reused, first);
  assert.deepEqual(first.view.events, [['desktop-chat-tab-session-title', 'Renamed'], ['desktop-chat-tab-theme', 'dark']]);
  const second = await context.getOrCreateDesktopChatTab('second', 'session-2', 'workspace');
  first.visible = true;
  first.view.setVisible(true);
  second.visible = true;
  second.view.setVisible(true);
  context.hideDesktopChatViews('second');
  assert.equal(first.view.visible, false);
  assert.equal(second.view.visible, true);
  const bounds = context.normalizeDesktopChatBounds({ x: -10, y: 20, width: 2000, height: 1000 });
  assert.equal(JSON.stringify(bounds), '{"x":0,"y":20,"width":1000,"height":780}');
  const painted = context.waitForDesktopChatLoadingPaint(first, 1, 1000);
  first.loadingWaiters.get(1)(true);
  assert.equal(await painted, true);
  const secondReady = context.waitForDesktopChatReady(second, 1000);
  context.destroyDesktopChatTabs();
  assert.equal(await secondReady, false);
  assert.equal(context.desktopChatTabs.size, 0);
  assert.equal(attached.size, 0);
  assert.ok(first.view.destroyed && second.view.destroyed);
});

for (const isWin of [true, false]) {
  test(`${isWin ? 'Windows' : 'Unix'} startup cleanup preserves the active service and unrelated processes`, async () => {
    const stopped = [];
    const context = vm.createContext({
      isWin, console,
      execFileAsync: async (file, args, options) => {
        assert.equal(file, 'taskkill');
        assert.equal(options.windowsHide, true);
        stopped.push(Number(args[1]));
      },
      process: { kill: (pid, signal) => { assert.equal(signal, 'SIGTERM'); stopped.push(pid); } },
      listLoopraJavaProcesses: async () => [
        { pid: 1, port: 4567, commandLine: 'gui' },
        { pid: 2, port: 4568, commandLine: 'gui' },
        { pid: 3, port: 4569, commandLine: 'cli' },
      ],
      isLoopraGuiRuntime: commandLine => commandLine === 'gui',
    });
    vm.runInContext(helpers, context);
    await context.closeOtherLoopraJavaProcesses(4567);
    assert.deepEqual(stopped, [2]);
  });
}
