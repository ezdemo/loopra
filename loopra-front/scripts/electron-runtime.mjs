import { spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Chromium can fail before the main script under inherited workspace ACLs.
// Keep the vendor runtime in the standard local cache when that happens.
export async function developmentElectron(executable, version, {
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  run = spawnSync,
  copy = cp,
  makeDirectory = mkdir,
} = {}) {
  if (platform !== 'win32') return executable;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const probe = file => run(file, ['--version'], { env, windowsHide: true, encoding: 'utf8', timeout: 8000 });
  const original = probe(executable);
  if (original.status === 0 || (original.status >>> 0) !== 0x80000003) return executable;
  if (!localAppData || !/^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(version)) throw new Error('Cannot locate the Electron development runtime cache.');

  const cache = join(localAppData, 'Loopra', 'development', `electron-${version}`);
  const cachedExecutable = join(cache, 'electron.exe');
  if (probe(cachedExecutable).status === 0) return cachedExecutable;
  console.log(`[desktop] Preparing Electron runtime cache at ${cache}`);
  await makeDirectory(cache, { recursive: true });
  await copy(dirname(executable), cache, { recursive: true, force: true });
  // Read/execute access is required for Chromium's restricted child processes.
  // Only the public Electron runtime is exposed, not the workspace or user data.
  const acl = run('icacls.exe', [cache, '/grant', '*S-1-15-2-2:(OI)(CI)(RX)', '/q'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (acl.status !== 0) throw new Error(`Cannot prepare Electron runtime permissions: ${acl.stderr || acl.stdout || acl.error?.message}`);
  const result = probe(cachedExecutable);
  if (result.status !== 0) throw new Error(`Electron runtime check failed (${result.status}): ${result.stderr || result.error?.message || ''}`);
  return cachedExecutable;
}
