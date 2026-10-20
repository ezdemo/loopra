import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { developmentElectron } from '../../scripts/electron-runtime.mjs';
import versionHelpers from '../../electron/version.cjs';

const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
const defaults = { isLoopraCoreBundled: () => false, readBundledCoreVersion: () => '', readLoopraGuiVersion: () => '26.9.91', isLoopraGuiInstalled: () => true, compareVersions: versionHelpers.compareVersions, detectJavaStatus: async () => ({ usable: true }) };
const startup = main.match(/async function openDesktopWorkspace\(\) \{[\s\S]*?\n\}/)[0];
const localInstall = main.match(/function installLoopraCoreLocal\(\) \{[\s\S]*?\n\}/)[0];

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

test('an existing core opens the new workspace without blocking on setup', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, currentPort: 0, healthCheck: async port => { calls.push(port); return true; }, createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup') });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, [4567, 'workspace']);
  assert.equal(context.currentPort, 4567);
});

test('a missing core keeps the installation and startup path available', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, currentPort: 0, healthCheck: async () => false, createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup') });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, ['setup']);
});

test('a bundled update uses setup even when the old service is healthy', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, currentPort: 0,
    isLoopraCoreBundled: () => true, readBundledCoreVersion: () => '26.9.92',
    healthCheck: async () => true, createWindow: () => calls.push('workspace'), createSplashWindow: () => calls.push('setup'),
  });
  await vm.runInContext(`${startup}; openDesktopWorkspace()`, context);
  assert.deepEqual(calls, ['setup']);
});

test('a healthy service still opens Java setup when no usable runtime is available', async () => {
  const calls = [];
  const context = vm.createContext({ ...defaults, currentPort: 0,
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
