import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createDesktopUpdater, registerDesktopUpdateIpc, desktopUpdateSupport, readDesktopUpdateOptions, loadDesktopUpdater } = require('../../electron/desktop-updater.cjs');
const { MIRROR_SOURCES, normalizeUpdateSource, desktopUpdateFeed, readDesktopUpdateSource, saveDesktopUpdateSource } = require('../../electron/desktop-update-source.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const updater = new EventEmitter();
  const calls = { check: 0, download: 0, install: [], feeds: [] };
  const states = [];
  updater.checkForUpdates = async () => { calls.check++; updater.emit('update-available', { version: '26.10.2002' }); };
  updater.downloadUpdate = async () => { calls.download++; };
  updater.quitAndInstall = (...args) => calls.install.push(args);
  updater.setFeedURL = feed => calls.feeds.push(feed);
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

test('signed macOS waits for native verification before exposing installation', async () => {
  const nativeUpdater = new EventEmitter();
  const { updater, calls, controller } = fixture({ platform: 'darwin', macSigned: true, nativeUpdater });
  assert.equal(controller.getState().supported, true);
  await controller.check(); await flush();
  assert.equal(calls.download, 1);
  updater.emit('update-downloaded', { version: '26.10.2002' });
  assert.equal(controller.getState().status, 'verifying');
  assert.throws(() => controller.install(), /尚未下载/);
  await controller.check(); await controller.download();
  assert.equal(calls.download, 1); assert.equal(calls.check, 1);
  assert.deepEqual(calls.install, []);
  nativeUpdater.emit('update-downloaded');
  assert.equal(controller.getState().status, 'downloaded');
  controller.install(); assert.equal(calls.install.length, 1);
});

test('macOS signature failure stays visible and never enables installation', async () => {
  const nativeUpdater = new EventEmitter();
  const { updater, controller } = fixture({ platform: 'darwin', macSigned: true, nativeUpdater });
  await controller.check(); await flush();
  updater.emit('update-downloaded', { version: '26.10.2002' });
  updater.emit('error', new Error('signature invalid'));
  nativeUpdater.emit('update-downloaded');
  assert.equal(controller.getState().status, 'error');
  assert.equal(controller.getState().error, 'signature invalid');
  assert.throws(() => controller.install(), /尚未下载/);
});

test('Linux DEB and AppImage download automatically and preserve restart installation', async () => {
  for (const options of [{ linuxPackageType: 'deb' }, { appImagePath: '/home/user/Loopra.AppImage' }]) {
    const { updater, calls, controller } = fixture({ platform: 'linux', ...options });
    assert.equal(controller.getState().supported, true);
    await controller.check(); await flush();
    assert.equal(calls.download, 1);
    updater.emit('update-downloaded', { version: '26.10.2002' });
    assert.equal(controller.getState().status, 'downloaded');
    assert.equal(updater.autoInstallOnAppQuit, true);
    assert.deepEqual(calls.install, []);
    controller.install(); assert.deepEqual(calls.install, [[true, true]]);
    if (options.linuxPackageType) assert.match(controller.getState().installHint, /管理员授权/);
  }
});

test('platform selection never loads an installer for development, ad-hoc macOS or unsupported Linux packages', () => {
  for (const options of [{ isPackaged: false, platform: 'win32' }, { isPackaged: true, platform: 'darwin' },
    { isPackaged: true, platform: 'linux', linuxPackageType: 'rpm' }]) {
    assert.equal(loadDesktopUpdater(options, () => { throw new Error('must not load updater'); }), null);
    assert.equal(desktopUpdateSupport(options).supported, false);
    assert.ok(desktopUpdateSupport(options).unsupportedReason);
  }
  const library = { autoUpdater: 'native', AppImageUpdater: class { kind = 'image'; }, DebUpdater: class { kind = 'deb'; } };
  const load = () => library;
  assert.equal(loadDesktopUpdater({ isPackaged: true, platform: 'win32' }, load), 'native');
  assert.equal(loadDesktopUpdater({ isPackaged: true, platform: 'darwin', macSigned: true }, load), 'native');
  assert.equal(loadDesktopUpdater({ isPackaged: true, platform: 'linux', linuxPackageType: 'deb' }, load).kind, 'deb');
  // APPIMAGE takes precedence over a package-type marker included in shared build resources.
  assert.equal(loadDesktopUpdater({ isPackaged: true, platform: 'linux', linuxPackageType: 'deb', appImagePath: '/tmp/Loopra.AppImage' }, load).kind, 'image');
});

test('reads signing metadata and Linux package identity from the packaged app, failing closed for unmarked builds', () => {
  const app = { isPackaged: true, getAppPath: () => '/app' };
  for (const signed of [true, false, 'true', undefined]) {
    const options = readDesktopUpdateOptions(app, { platform: 'darwin', env: {}, readFileSync: () => JSON.stringify({ loopraDesktopUpdate: { macSigned: signed } }) });
    assert.equal(options.macSigned, signed === true);
  }
  assert.equal(readDesktopUpdateOptions(app, { platform: 'darwin', env: {}, readFileSync: () => { throw new Error('missing'); } }).macSigned, false);
  const linux = readDesktopUpdateOptions(app, { platform: 'linux', resourcesPath: '/resources', env: { APPIMAGE: '/tmp/app.AppImage' }, readFileSync: () => 'deb\n' });
  assert.equal(linux.linuxPackageType, 'deb'); assert.equal(linux.appImagePath, '/tmp/app.AppImage');
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

test('release notes IPC uses the main-process reader and accepts no renderer URL', async () => {
  let calls = 0;
  const { controller } = fixture({ getReleaseNotes: async (...args) => { calls++; assert.equal(args.length, 0); return { releases: [] }; } });
  const handlers = new Map();
  const window = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  registerDesktopUpdateIpc({ handle: (name, fn) => handlers.set(name, fn) }, controller, () => window);
  const result = await handlers.get('desktop-update-getReleaseNotes')({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'https://other.invalid');
  assert.deepEqual(result, { releases: [] });
  assert.equal(calls, 1);
});

test('desktop mirrors match the core list and only fixed official release feeds can be selected', () => {
  const coreSource = readFileSync(new URL('../src/update-scripts.ts', import.meta.url), 'utf8');
  const coreMirrors = [...coreSource.matchAll(/\{ value: '(https:\/\/[^']+)', label:/g)].map(match => match[1]);
  assert.deepEqual(MIRROR_SOURCES, coreMirrors);
  assert.deepEqual(desktopUpdateFeed('normal'), { provider: 'github', owner: 'ezdemo', repo: 'loopra-release' });
  assert.equal(normalizeUpdateSource('mirror'), MIRROR_SOURCES[0]);
  assert.equal(normalizeUpdateSource('https://ghproxy.net'), 'https://ghproxy.net/');
  for (const value of ['https://evil.example/', 'http://ghproxy.net/', 'https://ghproxy.net/other/', {}, null]) {
    assert.throws(() => desktopUpdateFeed(value), /请选择/);
  }
  for (const source of MIRROR_SOURCES) {
    const { controller, updater, calls } = fixture({ source });
    assert.equal(controller.getState().source, source);
    assert.deepEqual(calls.feeds[0], { provider: 'generic',
      url: `${source}https://github.com/ezdemo/loopra-release/releases/latest/download/`, useMultipleRangeRequest: false });
    assert.equal(updater.disableDifferentialDownload, true);
  }
});

test('the real generic provider fetches both the manifest and installer through the selected mirror', async () => {
  const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
  for (const platform of ['win32', 'linux', 'darwin']) {
    const feed = desktopUpdateFeed('https://ghproxy.net/');
    const provider = new GenericProvider(feed, {}, { platform, executor: {} });
    let manifestUrl;
    provider.httpRequest = async url => {
      manifestUrl = url.href;
      return 'version: 26.10.2002\nfiles:\n  - url: Loopra-windows-x64.exe\n    sha512: test-checksum\n    size: 123\n';
    };
    const info = await provider.getLatestVersion();
    const channel = platform === 'win32' ? 'latest' : platform === 'linux' ? 'latest-linux' : 'latest-mac';
    assert.equal(manifestUrl, feed.url + channel + '.yml');
    assert.equal(provider.resolveFiles(info)[0].url.href, feed.url + 'Loopra-windows-x64.exe');
    assert.equal(info.files[0].sha512, 'test-checksum');
  }
});

test('saves the selected source and restores it on the next desktop launch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'loopra-update-source-'));
  const file = join(directory, 'preferences', 'desktop-update.json');
  try {
    assert.equal(readDesktopUpdateSource(file), 'normal');
    const { controller } = fixture({ saveSource: source => saveDesktopUpdateSource(file, source) });
    await controller.setSource('https://ghproxy.net/');
    assert.equal(readDesktopUpdateSource(file), 'https://ghproxy.net/');
    const next = fixture({ source: readDesktopUpdateSource(file) });
    assert.equal(next.controller.getState().source, 'https://ghproxy.net/');
    writeFileSync(file, '{"source":"https://evil.example/"}');
    assert.equal(readDesktopUpdateSource(file), 'normal');
    writeFileSync(file, '{broken');
    assert.equal(readDesktopUpdateSource(file), 'normal');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('switching mirrors cancels an active download before replacing the provider and restarting', async () => {
  const { updater, calls, controller } = fixture();
  let cancel;
  const token = { cancel: () => cancel?.() };
  updater.checkForUpdates = async () => {
    calls.check++;
    updater.emit('update-available', { version: '26.10.2002' });
    return { cancellationToken: calls.check === 1 ? token : { cancel() {} } };
  };
  updater.downloadUpdate = receivedToken => {
    calls.download++;
    if (calls.download > 1) return Promise.resolve();
    assert.equal(receivedToken, token);
    return new Promise((_, reject) => {
      cancel = () => {
        assert.equal(calls.feeds.length, 1);
        reject(new Error('cancelled'));
      };
    });
  };
  await controller.check(); await flush();
  assert.equal(controller.getState().status, 'downloading');
  await controller.setSource('https://ghproxy.net/'); await flush();
  assert.equal(calls.check, 2); assert.equal(calls.download, 2);
  assert.equal(controller.getState().source, 'https://ghproxy.net/');
  assert.equal(controller.getState().changingSource, false);
  assert.equal(controller.getState().error, '');
  assert.equal(calls.feeds.at(-1).provider, 'generic');
  assert.equal(controller.getState().status, 'downloading');
});

test('switching while checking waits for the old check without downloading from the old provider', async () => {
  const { updater, calls, controller } = fixture();
  let finishCheck;
  updater.checkForUpdates = () => {
    calls.check++;
    if (calls.check > 1) { updater.emit('update-available', { version: '26.10.2002' }); return Promise.resolve(); }
    return new Promise(resolve => { finishCheck = () => { updater.emit('update-available', { version: '26.10.2002' }); resolve(); }; });
  };
  const pending = controller.check(); await flush();
  const switching = controller.setSource('https://ghfast.top/');
  assert.equal(controller.getState().changingSource, true);
  await assert.rejects(controller.setSource('https://ghproxy.net/'), /正在切换/);
  assert.equal(calls.feeds.length, 1);
  finishCheck(); await pending; await switching; await flush();
  assert.equal(calls.check, 2); assert.equal(calls.download, 1);
  assert.equal(controller.getState().source, 'https://ghfast.top/');
});

test('switching back to GitHub restores its provider and differential downloads; save failures retain the old source', async () => {
  const { updater, calls, controller } = fixture({ source: 'mirror' });
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  await controller.setSource('normal');
  assert.equal(calls.feeds.at(-1).provider, 'github');
  assert.equal(updater.disableDifferentialDownload, false);
  const failed = fixture({ saveSource: () => { throw new Error('disk full'); } });
  await assert.rejects(failed.controller.setSource('https://ghproxy.net/'), /disk full/);
  assert.equal(failed.controller.getState().source, 'normal');
  assert.equal(failed.controller.getState().changingSource, false);
  assert.equal(failed.calls.feeds.at(-1).provider, 'github');
  assert.equal(failed.calls.check, 0);
});

test('source IPC validates choices and does not replace a verified or installing update', async () => {
  const { updater, controller, calls } = fixture();
  const handlers = new Map();
  const window = { webContents: { mainFrame: {} }, isDestroyed: () => false };
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  registerDesktopUpdateIpc({ handle: (name, handler) => handlers.set(name, handler) }, controller, () => window);
  await assert.rejects(handlers.get('desktop-update-setSource')(event, 'https://evil.example/'), /请选择/);
  assert.equal(calls.feeds.length, 1); assert.equal(calls.check, 0);
  updater.emit('update-downloaded', { version: '26.10.2002' });
  await assert.rejects(controller.setSource('https://ghproxy.net/'), /已下载/);
  controller.install();
  await assert.rejects(controller.setSource('https://ghproxy.net/'), /已下载/);
  assert.equal(controller.getState().status, 'installing');
});
