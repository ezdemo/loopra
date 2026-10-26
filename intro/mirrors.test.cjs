const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SOURCES, downloadUrl, fastestSource, probeSource, installCommand } = require('./mirrors.js');
const original = 'https://github.com/ezdemo/loopra-release/releases/download/v1/Loopra-windows-x64.exe';

test('all install commands use official scripts and pass the chosen mirror through the environment', () => {
  const base = 'https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup';
  for (const source of SOURCES) {
    for (const gui of [false, true]) {
      const name = base + (gui ? '-gui' : '');
      assert.equal(installCommand(source.id, 'windows', gui), (source.prefix ? `$env:LOOPRA_MIRROR='${source.prefix}'; ` : '') + `irm ${name}.ps1 | iex`);
      assert.equal(installCommand(source.id, 'unix', gui), (source.prefix ? `export LOOPRA_MIRROR='${source.prefix}'; ` : '') + `curl -fsSL ${name}.sh | bash`);
    }
  }
  assert.throws(() => installCommand('unlisted', 'unix'));
  assert.throws(() => installCommand('github', 'unsupported'));
});

test('switches between direct and mirrored URLs without stacking prefixes', () => {
  assert.equal(downloadUrl(original, 'github'), original);
  assert.equal(downloadUrl(original, 'gh-proxy-org'), 'https://gh-proxy.org/' + original);
  assert.equal(downloadUrl(original, 'ghfast'), 'https://ghfast.top/' + original);
  for (const source of SOURCES) {
    assert.equal(downloadUrl(original, source.id), source.prefix + original);
  }
  assert.throws(() => downloadUrl('https://example.com/file.exe', 'ghfast'));
  assert.throws(() => downloadUrl(original, 'https://unknown-mirror.example/'));
  assert.throws(() => downloadUrl('https://gh-proxy.org/' + original, 'ghfast'));
});

test('recommends the fastest verified source, excluding failures and unknown sources', () => {
  assert.equal(fastestSource([{ id: 'github', latency: 400 }, { id: 'ghfast', latency: 50 }, { id: 'ghproxy', latency: null }]), 'ghfast');
  assert.equal(fastestSource([{ id: 'ghfast', latency: null }]), 'github');
  assert.equal(fastestSource([{ id: 'unknown', latency: 1 }, { id: 'ghfast', latency: NaN }, { id: 'github', latency: -1 }]), 'github');
  assert.equal(fastestSource([]), 'github');
});

test('probes a small release manifest, passing Range and omitting credentials', async () => {
  let request;
  const result = await probeSource(SOURCES[1], async (url, options) => {
    request = { url, options };
    return new Response('version: 26.10.2503\nfiles:\n', { status: 206 });
  });
  assert.ok(result.latency > 0);
  assert.equal(request.url, 'https://gh-proxy.org/https://github.com/ezdemo/loopra-release/releases/latest/download/latest.yml');
  assert.equal(request.options.headers.Range, 'bytes=0-2047');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
});

test('rejects error pages, CORS failures and oversized responses instead of calling them fast', async () => {
  for (const response of [
    new Response('version: 1', { status: 403 }),
    new Response('<html>Verification required</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    new Response('Access denied', { status: 200 }),
    new Response('version: 1', { headers: { 'Content-Length': '900000' } })
  ]) {
    assert.equal((await probeSource(SOURCES[0], async () => response)).latency, null);
  }
  assert.equal((await probeSource(SOURCES[0], async () => { throw new TypeError('Failed to fetch'); })).latency, null);
});
