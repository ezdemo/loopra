import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/i18n.ts', import.meta.url), 'utf8');
const zhPart = source.split('const zh = {', 2)[1]?.split('const en:', 2)[0] || '';
const enPart = source.split('const en:', 2)[1] || '';
const keys = text => new Set([...text.matchAll(/^\s*'([^']+)':/gm)].map(match => match[1]));
const zhKeys = keys(zhPart);
const enKeys = keys(enPart);

test('zh and en i18n resources expose the same keys', () => {
  assert.deepEqual([...zhKeys].filter(key => !enKeys.has(key)).sort(), []);
  assert.deepEqual([...enKeys].filter(key => !zhKeys.has(key)).sort(), []);
  assert.ok(zhKeys.size > 100);
});

test('core language switching keys are present', () => {
  for (const key of ['nav.newChat', 'settings.language', 'composer.sendMessage', 'chat.copyReply']) {
    assert.ok(zhKeys.has(key), `${key} missing from zh resources`);
    assert.ok(enKeys.has(key), `${key} missing from en resources`);
  }
});
