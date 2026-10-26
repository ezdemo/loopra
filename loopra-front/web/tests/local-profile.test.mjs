import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/local-profile-storage.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { PROFILE_KEY, loadDesktopProfile, persistLocalProfile, profileSaveError } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const profile = { nickname: 'Local User', avatar: '', color: 'green' };
const empty = { nickname: '', avatar: '', color: 'blue' };
const missing = channel => new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`);

test('a new preload with an old main process saves locally and migrates after restart', async () => {
  const cache = new Map();
  const storage = { setItem: (key, value) => cache.set(key, value) };
  const oldBridge = { get: async () => { throw missing('local-profile-get'); }, set: async () => { throw missing('local-profile-set'); } };
  assert.deepEqual(await loadDesktopProfile(oldBridge, empty), empty);
  await persistLocalProfile(profile, storage, oldBridge);
  const cached = JSON.parse(cache.get(PROFILE_KEY));
  let saved = null;
  const newBridge = { get: async () => saved, set: async value => { saved = value; } };
  assert.deepEqual(await loadDesktopProfile(newBridge, cached), profile);
  assert.deepEqual(saved, profile);
  assert.deepEqual(await loadDesktopProfile(newBridge, empty), profile);
});

test('an explicitly cleared desktop nickname wins over a stale local cache', async () => {
  const bridge = { get: async () => empty, set: async () => { assert.fail('must not restore stale profile'); } };
  assert.deepEqual(await loadDesktopProfile(bridge, profile), empty);
});

test('real disk errors remain visible and do not pretend a save succeeded', async () => {
  const denied = new Error('EPERM: operation not permitted');
  const bridge = { get: async () => { throw denied; }, set: async () => { throw denied; } };
  const storage = { setItem: () => assert.fail('must not hide a disk failure') };
  await assert.rejects(loadDesktopProfile(bridge, empty), error => error === denied);
  await assert.rejects(persistLocalProfile(profile, storage, bridge), error => error === denied);
  assert.match(profileSaveError(denied, false), /写入权限/);
});

test('a failed browser fallback reports quota errors, while a successful file save stays successful', async () => {
  const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
  const storage = { setItem: () => { throw quota; } };
  await assert.rejects(persistLocalProfile(profile, storage), error => error === quota);
  await assert.rejects(persistLocalProfile(profile, storage, { get: async () => null, set: async () => { throw missing('local-profile-set'); } }), error => error === quota);
  await persistLocalProfile(profile, storage, { get: async () => null, set: async () => {} });
  assert.match(profileSaveError(quota, false), /空间不足/);
  assert.match(profileSaveError(new Error('specific failure'), false), /specific failure/);
});

test('desktop storage distinguishes an absent profile from a saved empty nickname', () => {
  const require = createRequire(import.meta.url);
  const { registerLocalProfileIpc } = require('../../electron/local-profile.cjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'loopra-profile-test-'));
  const file = path.join(dir, 'local-profile.json');
  const handlers = new Map();
  const allowed = { allowed: true };
  try {
    registerLocalProfileIpc({ handle: (name, callback) => handlers.set(name, callback) }, { getPath: () => dir }, event => event.allowed === true);
    const get = () => handlers.get('local-profile-get')(allowed);
    const set = value => handlers.get('local-profile-set')(allowed, value);
    assert.equal(get(), null);
    assert.equal(existsSync(file), false);
    assert.throws(() => handlers.get('local-profile-set')({}, profile), /未授权/);
    set(profile);
    assert.deepEqual(get(), profile);
    set(empty);
    assert.deepEqual(get(), empty);
  } finally {
    for (const target of [file, `${file}.tmp`]) if (existsSync(target)) unlinkSync(target);
    rmdirSync(dir);
  }
});
