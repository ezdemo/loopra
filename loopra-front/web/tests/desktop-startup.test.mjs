import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { developmentElectron } from '../../scripts/electron-runtime.mjs';
import versionHelpers from '../../electron/version.cjs';

const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
const defaults = { isDev: false, isLoopraCoreBundled: () => false, readBundledCoreVersion: () => '', readLoopraGuiVersion: () => '26.9.91', isLoopraGuiInstalled: () => true, compareVersions: versionHelpers.compareVersions, detectJavaStatus: async () => ({ usable: true }) };
const startup = main.match(/async function openDesktopWorkspace\(\) \{[\s\S]*?\n\}/)[0];
const localInstall = main.match(/function installLoopraCoreLocal\(\) \{[\s\S]*?\n\}/)[0];
const readyHandler = main.match(/ipcMain.handle\('splash_ready', \(\) => \{[\s\S]*?\n\}\)/)[0];
const portHandler = main.match(/ipcMain.handle\('get_loopra_web_port', async \(\) => \{[\s\S]*?\n\}\)/)[0];
const startHandler = main.match(/ipcMain.handle\('start_loopra_web', async \(\) => \{[\s\S]*?\n\}\)/)[0];

test('finishing startup restores the existing workspace and closes setup', () => {
  const calls = [];
  let ready;
  const context = vm.createContext({
    ipcMain: { handle: (_, handler) => { ready = handler; } },
    mainWindow: { isDestroyed: () => false, isMinimized: () => true, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') },
    splashWindow: { isDestroyed: () => false, close: () => calls.push('close setup') },
    createWindow: () => calls.push('create workspace'),
  });
  vm.runInContext(readyHandler, context);
  assert.equal(ready(), true);
  assert.deepEqual(calls, ['restore', 'show', 'focus', 'close setup']);
});

for (const isWin of [true, false]) {
  test(`${isWin ? 'Windows' : 'Unix'} desktop updates defer Java setup until after core installation`, async () => {
    const calls = [];
    const context = vm.createContext({ isWin, path: { join }, getLoopraCoreDir: () => '/core', sendInstallLog: () => {},
      spawn: (file, args) => { calls.push([file, args]); return {}; }, runLoopraCoreInstaller: async () => {},
    });
    await vm.runInContext(`${localInstall}; installLoopraCoreLocal()`, context);
    assert.equal(calls[0][0], isWin ? 'powershell' : 'bash');
    assert.ok(calls[0][1].includes(isWin ? '-SkipJava' : '--skip-java'));
  });
}

test('development reuses the default service without blocking on setup', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, isDev: true, currentPort: 0, healthCheck: async port => { calls.push(port); return true; }, createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup') });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, [4567, 'workspace']);
  assert.equal(context.currentPort, 4567);
});

test('packaged startup uses setup without probing the default service', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, currentPort: 0, healthCheck: async port => { calls.push(port); return true; }, createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup') });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, ['setup']);
  assert.equal(context.currentPort, 0);
});

test('packaged startup can reopen the workspace on its own service port', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, currentPort: 51234, healthCheck: async port => { calls.push(port); return true; }, createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup') });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, [51234, 'workspace']);
  assert.equal(context.currentPort, 51234);
});

for (const isDev of [false, true]) {
  test(`${isDev ? 'development' : 'packaged'} port lookup ${isDev ? 'discovers' : 'ignores'} the default service`, async () => {
    const calls = [];
    let lookup;
    const context = vm.createContext({
      isDev, currentPort: 0,
      ipcMain: { handle: (_, handler) => { lookup = handler; } },
      healthCheck: async port => { calls.push(port); return true; },
    });
    vm.runInContext(portHandler, context);
    assert.equal(await lookup(), isDev ? 4567 : 0);
    assert.deepEqual(calls, isDev ? [4567] : []);
  });

  test(`${isDev ? 'development' : 'packaged'} service startup ${isDev ? 'reuses the default service' : 'starts an independent service'}`, async () => {
    const calls = [];
    let start;
    const context = vm.createContext({
      isDev, currentPort: 0, loopraWebProcess: null, console,
      ipcMain: { handle: (_, handler) => { start = handler; } },
      listLoopraJavaProcesses: async () => [{ pid: 42, port: 4567, commandLine: 'cli' }],
      isLoopraGuiRuntime: () => false,
      stopLoopraJavaProcess: async pid => calls.push(['stop', pid]),
      healthCheck: async port => { calls.push(['health', port]); return true; },
      isServiceVersionCurrent: async () => true,
      stopLoopraWebOnPort: async port => calls.push(['stop-port', port]),
      getDefaultPort: async () => 51234,
      startLoopraWeb: port => calls.push(['start', port]),
      closeOtherLoopraJavaProcesses: async port => calls.push(['cleanup', port]),
    });
    vm.runInContext(startHandler, context);
    assert.equal(await start(), isDev ? 4567 : 51234);
    assert.equal(context.currentPort, isDev ? 4567 : 51234);
    assert.deepEqual(calls, isDev ? [['health', 4567], ['cleanup', 4567]] : [['start', 51234], ['cleanup', 51234]]);
  });
}

test('a missing core keeps the installation and startup path available', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, currentPort: 0, healthCheck: async () => false, createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup') });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, ['setup']);
});

test('a bundled update uses setup even when the old service is healthy', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, isDev: true, currentPort: 0,
    isLoopraCoreBundled: () => true, readBundledCoreVersion: () => '26.9.92',
    healthCheck: async () => true, createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup'),
  });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, ['setup']);
});

test('a healthy service still opens Java setup when no usable runtime is available', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, isDev: true, currentPort: 0,
    detectJavaStatus: async () => ({ usable: false }), healthCheck: async () => true,
    createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup'),
  });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, ['setup']);
});

test('healthy Windows runtimes and other platforms do not need a runtime copy', async () => {
  const run = () => ({ status: 0 });
  const copy = () => { throw new Error('Unexpected copy'); };
  assert.equal(await developmentElectron('/vendor/electron.exe', '42.8.1', { platform: 'win32', run, copy }), '/vendor/electron.exe');
  assert.equal(await developmentElectron('/vendor/electron', '42.8.1', { platform: 'linux', run: () => { throw new Error('Unexpected probe'); }, copy }), '/vendor/electron');
});

test('a Windows startup breakpoint prepares and verifies a cached vendor runtime', async () => {
  const executable = join('/vendor', 'electron.exe');
  const cache = join('/cache', 'Loopra', 'development', 'electron-42.8.1');
  const cachedExecutable = join(cache, 'electron.exe');
  const calls = [];
  let copied = false;
  const result = await developmentElectron(executable, '42.8.1', {
    platform: 'win32', localAppData: '/cache',
    run(file, args) {
      calls.push([file, args]);
      return { status: file === 'icacls.exe' || (file === cachedExecutable && copied) ? 0 : -2147483645 };
    },
    makeDirectory: async () => {},
    copy: async (source, target) => { assert.equal(source, dirname(executable)); assert.equal(target, cache); copied = true; },
  });
  assert.equal(result, cachedExecutable);
  assert.deepEqual(calls.at(-2), ['icacls.exe', [cache, '/grant', '*S-1-15-2-2:(OI)(CI)(RX)', '/q']]);
  assert.deepEqual(calls.at(-1), [cachedExecutable, ['--version']]);
});

test('unrelated Electron failures are not treated as a permission problem', async () => {
  assert.equal(await developmentElectron('/vendor/electron.exe', '42.8.1', {
    platform: 'win32', run: () => ({ status: 1 }), copy: () => { throw new Error('Unexpected copy'); },
  }), '/vendor/electron.exe');
});
