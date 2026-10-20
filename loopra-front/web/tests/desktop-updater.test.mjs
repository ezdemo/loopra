import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createDesktopUpdater, registerDesktopUpdateIpc } = require('../../electron/desktop-updater.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const updater = new EventEmitter();
  const calls = { check: 0, download: 0, install: [] };
  const states = [];
  updater.checkForUpdates = async () => { calls.check++; updater.emit('update-available', { version: '26.10.2002' }); };
  updater.downloadUpdate = async () => { calls.download++; };
  updater.quitAndInstall = (...args) => calls.install.push(args);
  const controller = createDesktopUpdater({ app: { isPackaged: true, getVersion: () => '26.10.2001' },
    updater, publish: state => states.push(state), platform: 'win32', ...options });
  return { updater, calls, states, controller };
}

test('automatically downloads a newer desktop version and waits for exit or explicit installation', async () => {
  const { updater, calls, controller } = fixture();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(updater.allowDowngrade, false);
  await controller.check(); await flush();
  assert.equal(calls.download, 1);
  assert.equal(controller.getState().status, 'downloading');
  updater.emit('download-progress', { percent: 45.8, transferred: 45, total: 100, bytesPerSecond: 10 });
  assert.equal(controller.getState().percent, 45.8);
  updater.emit('update-downloaded', { version: '26.10.2002' });
  assert.equal(controller.getState().status, 'downloaded');
  assert.deepEqual(calls.install, []);
  await controller.check(); await controller.download();
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(calls.check, 1);
  controller.install();
  assert.deepEqual(calls.install, [[true, true]]);
  assert.equal(controller.getState().status, 'installing');
  assert.throws(() => controller.install(), /尚未下载/);
});

test('checks automatically after startup, repeats periodically and stops timers on exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { updater, calls, controller } = fixture();
  updater.checkForUpdates = async () => { calls.check++; updater.emit('update-not-available'); };
  controller.start(); controller.start();
  t.mock.timers.tick(9999); await flush(); assert.equal(calls.check, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(calls.check, 1);
  t.mock.timers.tick(4 * 60 * 60 * 1000); await flush(); assert.equal(calls.check, 2);
  controller.dispose();
  t.mock.timers.tick(4 * 60 * 60 * 1000); await flush(); assert.equal(calls.check, 2);
});

test('deduplicates checks/downloads and never installs an incomplete update', async () => {
  const { updater, calls, controller } = fixture();
  let finish;
  updater.downloadUpdate = () => { calls.download++; return new Promise(resolve => { finish = resolve; }); };
  assert.throws(() => controller.install(), /尚未下载/);
  await Promise.all([controller.check(), controller.check(), controller.check()]); await flush();
  const pending = controller.download();
  await controller.check();
  assert.equal(calls.check, 1); assert.equal(calls.download, 1);
  assert.throws(() => controller.install(), /尚未下载/);
  finish(); await pending;
});

test('network/download failures are visible and retry checks can download successfully', async () => {
  const { updater, calls, controller } = fixture();
  updater.checkForUpdates = async () => { throw new Error('network unavailable'); };
  assert.equal((await controller.check()).error, 'network unavailable');
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '26.10.2002' });
  updater.downloadUpdate = async () => { throw new Error('download interrupted'); };
  await controller.check(); await flush();
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().error, 'download interrupted');
  updater.downloadUpdate = async () => { calls.download++; updater.emit('update-downloaded', { version: '26.10.2002' }); };
  await controller.check(); await flush();
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(controller.getState().error, '');
  updater.emit('error', new Error('late check error'));
  assert.equal(controller.getState().status, 'downloaded');
});

test('equal/older versions do not download; a current version check clears old errors', async () => {
  for (const version of ['26.10.2001', '26.9.91']) {
    const { updater, calls, controller } = fixture();
    updater.checkForUpdates = async () => updater.emit('update-available', { version });
    await controller.check(); await flush();
    assert.equal(controller.getState().status, 'idle'); assert.equal(calls.download, 0);
  }
  const { updater, controller } = fixture();
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await controller.check()).status, 'idle');
});

test('development and other platforms never contact the updater or install', async () => {
  for (const options of [{ app: { isPackaged: false, getVersion: () => '1.0.0' } }, { platform: 'darwin' }, { platform: 'linux' }]) {
    const { calls, controller } = fixture(options);
    controller.start(); await controller.check(); await controller.download(); controller.dispose();
    assert.equal(controller.getState().supported, false);
    assert.equal(controller.getState().status, 'unsupported');
    assert.equal(calls.check, 0); assert.equal(calls.download, 0);
    assert.throws(() => controller.install(), /尚未下载/);
  }
});

test('failed installer launch retains the downloaded update for retry', () => {
  const { updater, controller } = fixture();
  updater.emit('update-downloaded', { version: '26.10.2002' });
  updater.quitAndInstall = () => { throw new Error('launch failed'); };
  assert.throws(() => controller.install(), /launch failed/);
  assert.equal(controller.getState().status, 'downloaded');
  updater.quitAndInstall = () => updater.emit('error', new Error('installer blocked'));
  controller.install();
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(controller.getState().error, 'installer blocked');
});

test('update IPC rejects other windows, subframes and destroyed main windows', () => {
  const handlers = new Map(); const { controller } = fixture();
  const window = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  registerDesktopUpdateIpc({ handle: (name, fn) => handlers.set(name, fn) }, controller, () => window);
  for (const [channel, handler] of handlers) {
    assert.throws(() => handler({ sender: {}, senderFrame: window.webContents.mainFrame }), /无权/);
    assert.throws(() => handler({ sender: window.webContents, senderFrame: {} }), /无权/);
    if (channel.endsWith('getState')) assert.equal(handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }).currentVersion, '26.10.2001');
  }
  window.isDestroyed = () => true;
  assert.throws(() => handlers.get('desktop-update-install')({ sender: window.webContents, senderFrame: window.webContents.mainFrame }), /无权/);
});
