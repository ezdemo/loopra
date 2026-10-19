import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// main.cjs cannot be loaded outside Electron, so its proxy parser lives in
// electron/proxy.cjs and is exercised here directly.
const require = createRequire(import.meta.url);
const { normalizeProxyAddress, electronProxyRules } = require('../../electron/proxy.cjs');

test('normalizes HTTP and SOCKS addresses', () => {
  assert.equal(normalizeProxyAddress(''), '');
  assert.equal(normalizeProxyAddress(null), '');
  assert.equal(normalizeProxyAddress('  '), '');
  assert.equal(normalizeProxyAddress('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyAddress('http://localhost'), 'http://localhost:80');
  assert.equal(normalizeProxyAddress('socks://localhost'), 'socks5://localhost:1080');
  assert.equal(normalizeProxyAddress('socks5h://localhost:1080'), 'socks5://localhost:1080');
  assert.equal(normalizeProxyAddress('socks4://[::1]:9050'), 'socks5://[::1]:9050');
});

test('rejects unsupported schemes and authority components', () => {
  assert.throws(() => normalizeProxyAddress('https://127.0.0.1:7890'), /仅支持 http 或 socks5/);
  assert.throws(() => normalizeProxyAddress('http://user:secret@127.0.0.1:7890'), /用户名、密码/);
  assert.throws(() => normalizeProxyAddress('http://127.0.0.1:7890/path'), /路径或查询参数/);
  assert.throws(() => normalizeProxyAddress('http://127.0.0.1:7890?q=1'), /路径或查询参数/);
});

test('builds Chromium proxy rules for HTTP and SOCKS', () => {
  assert.equal(electronProxyRules('http://127.0.0.1:7890'), 'http=127.0.0.1:7890;https=127.0.0.1:7890');
  assert.equal(electronProxyRules('socks5://127.0.0.1:1080'), 'socks5=127.0.0.1:1080');
  assert.equal(electronProxyRules('socks5://[::1]:1080'), 'socks5=[::1]:1080');
});
