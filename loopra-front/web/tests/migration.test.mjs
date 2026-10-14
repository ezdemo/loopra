import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { usesLegacyRenderer } from '../../src/entry-routing.js';

async function sourceModule(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const { resolveInitialServer } = await sourceModule('runtime-config');
const { LoopraClient } = await sourceModule('backend');

test('Web and Electron workspaces use React while auxiliary windows keep their renderer', () => {
  assert.equal(usesLegacyRenderer(''), false);
  assert.equal(usesLegacyRenderer('?theme=dark&desktopChatTab=0'), false);
  assert.equal(usesLegacyRenderer('?desktopShell=1&theme=dark', true), false);
  for (const key of ['desktopSplash', 'desktopUpdate', 'desktopOnboarding', 'desktopChatTab', 'desktopSearch', 'desktopMessage', 'desktopPopup', 'desktopPet', 'requirementBoard', 'aiBrowser', 'elementInspector']) {
    assert.equal(usesLegacyRenderer(`?${key}=1&theme=dark`), true, key);
  }
  assert.equal(usesLegacyRenderer('', true), false);
});

test('Electron uses the live core port instead of stale saved addresses', () => {
  const sources = { saved: '"http://127.0.0.1:59999"', legacy: 'http://localhost:4567', origin: 'null', development: false };
  assert.equal(resolveInitialServer({ ...sources, desktopPort: 49123 }), 'http://127.0.0.1:49123');
  for (const desktopPort of [0, -1, 65536, 1.5, NaN, undefined]) {
    assert.equal(resolveInitialServer({ ...sources, desktopPort }), 'http://127.0.0.1:59999');
  }
});

test('server migration preserves user addresses and supports same-origin packaged Web on custom ports', () => {
  const production = { origin: 'http://127.0.0.1:7890', development: false, configured: 'http://localhost:4567' };
  assert.equal(resolveInitialServer(production), production.origin);
  assert.equal(resolveInitialServer({ ...production, saved: '"https://saved.example.test/"', legacy: 'https://legacy.example.test' }), 'https://saved.example.test');
  assert.equal(resolveInitialServer({ ...production, legacy: 'https://legacy.example.test/' }), 'https://legacy.example.test');
  assert.equal(resolveInitialServer({ ...production, configured: 'https://configured.example.test/' }), 'https://configured.example.test');
  assert.equal(resolveInitialServer({ ...production, development: true }), 'http://localhost:4567');
  assert.equal(resolveInitialServer({ ...production, saved: 'broken', legacy: 'file:///tmp', configured: 'https://user@example.test' }), production.origin);
  assert.equal(resolveInitialServer({ origin: 'null', development: false }), 'http://127.0.0.1:4567');
});

test('API routing uses the existing dev proxy or same origin and honors a different configured server', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async url => {
      urls.push(url);
      return new Response(JSON.stringify({ success: true, data: { status: 'ok' } }));
    };
    globalThis.window = { location: { port: '3000', origin: 'http://127.0.0.1:3000' } };
    await new LoopraClient().request('/system/health');
    globalThis.window = { location: { port: '7890', origin: 'http://127.0.0.1:7890' } };
    await new LoopraClient('http://127.0.0.1:7890').request('/system/health');
    await new LoopraClient('https://remote.example.test').request('/system/health');
    assert.deepEqual(urls, ['/api/system/health', '/api/system/health', 'https://remote.example.test/api/system/health']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
