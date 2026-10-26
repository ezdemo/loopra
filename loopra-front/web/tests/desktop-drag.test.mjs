import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { developmentElectron } from '../../scripts/electron-runtime.mjs';

test('native title-bar drag survives clipped chat buttons and streaming updates', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const require = createRequire(import.meta.url);
  const executable = await developmentElectron(require('electron'), require('electron/package.json').version);
  const profile = await mkdtemp(join(tmpdir(), 'loopra-desktop-drag-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const { stdout } = await promisify(execFile)(executable, [
      fileURLToPath(new URL('./fixtures/desktop-drag.cjs', import.meta.url)),
      fileURLToPath(new URL('../src/styles.css', import.meta.url)), profile,
    ], { env, windowsHide: true, timeout: 45_000 });
    assert.match(stdout, /Verified 63 native title-bar and control hit tests\./);
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
