import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { AppUpdater } = require('electron-updater');
const { createUnsignedMacUpdater, MacAppInstaller, selectMacZip, validateArchiveEntries, INSTALL_SCRIPT } = require('../../electron/unsigned-mac-updater.cjs');
const { createDesktopUpdater, loadDesktopUpdater } = require('../../electron/desktop-updater.cjs');
const { desktopUpdateFeed } = require('../../electron/desktop-update-source.cjs');
const bytes = Buffer.from('zip fixture');
const checksum = createHash('sha512').update(bytes).digest('base64');
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'loopra-mac-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(file, value = '') { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value, { mode: 0o755 }); }
const zipInfo = arch => ({ url: new URL(`https://github.com/ezdemo/loopra-release/releases/download/v1.0.1/Loopra-macos-${arch}.zip`),
  info: { url: `Loopra-macos-${arch}.zip`, sha512: checksum, size: bytes.length } });

test('unsigned Mac selects only its exact architecture and requires integrity metadata', () => {
  const files = [zipInfo('arm64'), zipInfo('x64')];
  assert.equal(selectMacZip(files, 'x64'), files[1]);
  assert.equal(selectMacZip(files, 'arm64'), files[0]);
  assert.throws(() => selectMacZip([files[0]], 'x64'), /架构/);
  for (const patch of [{ sha512: '' }, { size: 0 }, { url: 'https://other.example/Loopra-macos-arm64.zip' }]) {
    assert.throws(() => selectMacZip([{ ...files[0], info: { ...files[0].info, ...patch } }], 'arm64'));
  }
});

test('unsigned feed stays separate on GitHub and mirrors, including the real provider filename', async () => {
  const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
  for (const source of ['normal', 'https://ghproxy.net/']) {
    const feed = desktopUpdateFeed(source, 'mac-unsigned');
    assert.equal(feed.provider, 'generic');
    assert.equal(feed.channel, 'latest-unsigned');
    const provider = new GenericProvider(feed, {}, { platform: 'darwin', executor: {} });
    provider.httpRequest = async url => {
      assert.equal(url.href, feed.url + 'latest-unsigned-mac.yml');
      return 'version: 1.0.1\n';
    };
    await provider.getLatestVersion();
    assert.equal(desktopUpdateFeed(source).channel, undefined);
  }
});

function updaterFixture(t, dir = directory(t)) {
  const calls = { quit: 0, download: 0, prepared: [], started: [] };
  const adapter = { version: '1.0.0', name: 'Loopra', isPackaged: true, userDataPath: dir, baseCachePath: dir,
    appUpdateConfigPath: join(dir, 'app-update.yml'), quit: () => calls.quit++, onQuit: fn => { calls.onQuit = fn; } };
  write(adapter.appUpdateConfigPath, 'updaterCacheDirName: cache\n');
  const installer = { installationError: '', started: false,
    prepare: async (...args) => calls.prepared.push(args),
    start: async relaunch => { calls.started.push(relaunch); installer.started = true; } };
  const updater = createUnsignedMacUpdater({ AppUpdater }, { adapter, installer, arch: 'arm64' });
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  updater.httpExecutor = { download: async (url, file, options) => {
    calls.download++;
    assert.equal(options.sha512, checksum);
    assert.equal(url.href, zipInfo('arm64').url.href);
    write(file, bytes);
  } };
  const info = { version: '1.0.1', files: [zipInfo('arm64').info] };
  updater.checkForUpdates = async () => {
    updater.updateInfoAndProvider = { info, provider: { resolveFiles: () => [zipInfo('arm64')] } };
    updater.emit('update-available', info);
    return {};
  };
  const controller = createDesktopUpdater({ app: { isPackaged: true, getVersion: () => '1.0.0' }, platform: 'darwin', updater });
  return { dir, calls, adapter, installer, updater, controller };
}

test('real updater downloads with SHA-512, prepares before enabling install and restarts without Squirrel', async t => {
  const { calls, installer, controller } = updaterFixture(t);
  let finish;
  installer.prepare = () => new Promise(resolve => { finish = resolve; });
  await controller.check();
  const downloading = controller.download();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().status, 'verifying');
  assert.throws(() => controller.install(), /尚未下载/);
  finish(); await downloading;
  assert.equal(controller.getState().status, 'downloaded');
  assert.equal(calls.download, 1);
  await controller.install();
  assert.deepEqual(calls.started, [true]);
  assert.equal(calls.quit, 1);
  calls.onQuit(0);
  assert.deepEqual(calls.started, [true]);
});

test('normal exit installs without reopening; failed preparation or installer launch keeps the app running', async t => {
  const normal = updaterFixture(t);
  await normal.controller.check(); await normal.controller.download();
  normal.calls.onQuit(1); assert.deepEqual(normal.calls.started, []);
  normal.calls.onQuit(0); assert.deepEqual(normal.calls.started, [false]);
  assert.equal(normal.calls.quit, 0);
  const bad = updaterFixture(t);
  bad.installer.prepare = async () => { throw new Error('invalid bundle'); };
  await bad.controller.check(); await bad.controller.download();
  assert.equal(bad.controller.getState().status, 'error');
  assert.equal(bad.calls.onQuit, undefined);
  assert.throws(() => bad.controller.install(), /尚未下载/);
  bad.installer.prepare = async () => {};
  await bad.controller.check(); await bad.controller.download();
  bad.installer.start = async () => { throw new Error('spawn failed'); };
  await assert.rejects(bad.controller.install(), /spawn failed/);
  assert.equal(bad.calls.quit, 0);
  assert.equal(bad.controller.getState().status, 'downloaded');
  assert.match(bad.controller.getState().error, /spawn failed/);
});

test('cached ZIP is rechecked and prepared again; tampering forces a fresh download', async t => {
  const { dir, updater, controller } = updaterFixture(t);
  await controller.check(); await controller.download();
  const cached = updater.downloadedUpdateHelper.file;
  const restart = updaterFixture(t, dir);
  await restart.controller.check(); await restart.controller.download();
  assert.equal(restart.calls.download, 0); assert.equal(restart.calls.prepared.length, 1);
  write(cached, 'tampered');
  const tampered = updaterFixture(t, dir);
  await tampered.controller.check(); await tampered.controller.download();
  assert.equal(tampered.calls.download, 1); assert.equal(tampered.calls.prepared.length, 1);
});

test('platform loader uses the custom updater without constructing a native Mac updater', () => {
  class FakeUpdater extends EventEmitter { constructor() { super(); this.app = { userDataPath: tmpdir() }; } }
  const library = { AppUpdater: FakeUpdater, get autoUpdater() { throw new Error('must not load Squirrel'); } };
  const updater = loadDesktopUpdater({ isPackaged: true, platform: 'darwin', macSigned: false }, () => library);
  assert.equal(updater instanceof FakeUpdater, true);
});

test('ZIP validation rejects traversal, absolute paths and unrelated bundles', () => {
  validateArchiveEntries('Loopra.app/\nLoopra.app/Contents/Info.plist\n__MACOSX/._Loopra.app\n');
  for (const entry of ['../oops', '/tmp/oops', 'Loopra.app/../oops', 'Other.app/Contents', 'Loopra.app/Contents/./oops', 'Loopra.app\\oops']) {
    assert.throws(() => validateArchiveEntries(`Loopra.app/Contents/Info.plist\n${entry}\n`));
  }
  assert.throws(() => validateArchiveEntries('Other.app/Contents/Info.plist'));
});

function installerFixture(t, overrides = {}) {
  const dir = directory(t);
  const target = join(dir, "Loopra space '$().app");
  const execPath = join(target, 'Contents', 'MacOS', 'Loopra');
  write(execPath, 'old executable');
  const userDataPath = join(dir, 'user data');
  const calls = [];
  let child;
  const installer = new MacAppInstaller({ execPath, userDataPath,
    run: async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith('/unzip')) return { stdout: 'Loopra.app/Contents/MacOS/Loopra\n' };
      if (command.endsWith('/ditto')) { write(join(args[3], 'Loopra.app', 'Contents', 'MacOS', 'Loopra'), 'new executable'); return {}; }
      const key = args[1];
      return { stdout: key.endsWith('CFBundleIdentifier') ? 'com.loopra.desktop\n' : key.endsWith('CFBundleShortVersionString') ? '1.0.1\n' : 'Loopra\n' };
    },
    spawnProcess: (command, args, options) => { calls.push([command, args, options]); child = new EventEmitter(); child.unref = () => {}; return child; },
    ...overrides });
  return { installer, target, calls, child: () => child };
}

test('installer stages beside the app, validates identity/version, and passes literal paths to a detached helper', async t => {
  const { installer, target, calls, child } = installerFixture(t);
  await installer.prepare('/cache/update.zip', '1.0.1');
  assert.equal(dirname(installer.ready.stage), dirname(target));
  assert.equal(readFileSync(join(target, 'Contents/MacOS/Loopra'), 'utf8'), 'old executable');
  const pending = installer.start(true);
  const duplicate = installer.start(true);
  assert.equal(pending, duplicate);
  assert.equal(installer.started, false);
  const [command, args, options] = calls.at(-1);
  assert.equal(command, '/bin/sh');
  assert.equal(args[2], target);
  assert.equal(args[4], '1');
  assert.equal(options.detached, true);
  child().emit('spawn'); await pending;
  assert.equal(installer.started, true);
});

test('bad bundle metadata cleans staging without modifying the installed app; spawn failure can retry', async t => {
  const bad = installerFixture(t);
  await assert.rejects(bad.installer.prepare('/cache/update.zip', '9.9.9'), /标识或版本/);
  assert.equal(bad.installer.ready, null);
  assert.equal(readFileSync(join(bad.target, 'Contents/MacOS/Loopra'), 'utf8'), 'old executable');
  const retry = installerFixture(t);
  await retry.installer.prepare('/cache/update.zip', '1.0.1');
  const pending = retry.installer.start(true);
  retry.child().emit('error', new Error('spawn denied'));
  await assert.rejects(pending, /spawn denied/);
  assert.equal(retry.installer.started, false);
  const second = retry.installer.start(true);
  retry.child().emit('spawn'); await second;
  assert.equal(retry.installer.started, true);
});

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const shellPath = file => file.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
test('actual install script replaces on exit, restores after failure and leaves a running app untouched', { skip: !existsSync(bash) }, t => {
  for (const mode of ['success', 'failed-launch', 'running']) {
    const dir = directory(t);
    const target = join(dir, "Loopra space '$().app");
    const stage = join(dir, '.Loopra-update-fixture');
    write(join(target, 'Contents', 'version'), 'old');
    write(join(stage, 'Loopra.app', 'Contents', 'version'), 'new');
    const script = join(stage, 'install.sh');
    const result = join(dir, 'install-error.txt');
    let body = INSTALL_SCRIPT.replaceAll('/usr/bin/open -n', mode === 'failed-launch' ? '/bin/false' : '/bin/true');
    if (mode === 'running') body = body.replace('"$attempts" -le 120', '"$attempts" -le 0');
    write(script, body);
    const args = [shellPath(script), shellPath(stage), shellPath(target), '999999999', '1', shellPath(result)];
    if (mode === 'running') {
      assert.throws(() => execFileSync(bash, ['-c', '"$1" "$2" "$3" "$4" "$$" "$5" "$6"', 'test', bash, ...args.slice(0, 3), ...args.slice(4)], { stdio: 'pipe' }));
    } else if (mode === 'failed-launch') {
      assert.throws(() => execFileSync(bash, args, { stdio: 'pipe' }));
    } else execFileSync(bash, args, { stdio: 'pipe' });
    assert.equal(readFileSync(join(target, 'Contents', 'version'), 'utf8'), mode === 'success' ? 'new' : 'old');
    assert.equal(existsSync(result), mode !== 'success');
    assert.equal(existsSync(stage), mode !== 'success');
  }
});
