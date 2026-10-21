import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { createDesktopReleaseNotes } = createRequire(import.meta.url)('../../electron/desktop-release-notes.cjs');
const entry = (version, body = `Changes for ${version}`, extra = {}) => ({
  tag_name: `v${version}`, body, name: `Loopra ${version}`, published_at: '2026-10-21T00:00:00Z', ...extra,
});
const response = entries => ({ ok: true, json: async () => entries });

test('selects every stable version between the installed and target versions, newest first', async () => {
  const service = createDesktopReleaseNotes({ currentVersion: '26.10.2001', getLatestVersion: () => '26.10.2004',
    request: async () => response([
      entry('26.10.2002'), entry('26.10.2005'), entry('26.10.2001'), entry('26.10.2004'), entry('26.10.2003'),
      entry('26.10.2000'), entry('26.10.2006', '', { prerelease: true }), entry('26.10.2007', '', { draft: true }),
      entry('26.10.2008-beta.1'), entry('docs'), null,
    ]) });
  const result = await service.getReleaseNotes();
  assert.deepEqual(result.releases.map(release => release.version), ['26.10.2004', '26.10.2003', '26.10.2002']);
  assert.equal(result.complete, true);
  assert.equal(result.latestVersion, '26.10.2004');
});

test('paginates beyond the first 100 releases, deduplicates requests, and caches for five minutes', async () => {
  const urls = [];
  let time = 0;
  const service = createDesktopReleaseNotes({ currentVersion: '1.0.0', now: () => time,
    request: async url => {
      urls.push(url);
      return response(url.endsWith('page=1') ? Array.from({ length: 100 }, (_, index) => entry(`1.0.${index + 2}`)) : [entry('1.0.1'), entry('1.0.0')]);
    } });
  const [result, duplicate] = await Promise.all([service.getReleaseNotes(), service.getReleaseNotes()]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/api.github.com\/repos\/ezdemo\/loopra-release\/releases\?per_page=100&page=1$/);
  assert.equal(result.releases.length, 101);
  assert.equal(duplicate.releases.length, 101);
  await service.getReleaseNotes(); assert.equal(urls.length, 2);
  time = 300000;
  await service.getReleaseNotes(); assert.equal(urls.length, 4);
});

test('shows installed release notes when up to date and strips generated download/metadata appendices', async () => {
  const service = createDesktopReleaseNotes({ currentVersion: '26.10.2001',
    request: async () => response([entry('26.10.2001', '## Loopra v26.10.2001\n\n### 修复\n\n- 修复更新问题\n\n### 下载\n\ninstaller\n<!-- metadata -->'), entry('26.10.2000')]) });
  const result = await service.getReleaseNotes();
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].body, '### 修复\n\n- 修复更新问题');
  assert.equal(result.releases[0].url, 'https://github.com/ezdemo/loopra-release/releases/tag/v26.10.2001');
});

test('changing the updater target reselects cached notes without an additional request', async () => {
  let target = '1.0.1'; let calls = 0;
  const service = createDesktopReleaseNotes({ currentVersion: '1.0.0', getLatestVersion: () => target,
    request: async () => { calls++; return response([entry('1.0.2'), entry('1.0.1')]); } });
  assert.equal((await service.getReleaseNotes()).releases.length, 1);
  target = '1.0.2';
  assert.equal((await service.getReleaseNotes()).releases.length, 2);
  assert.equal(calls, 1);
});

test('reports truncation instead of silently claiming complete history', async () => {
  let calls = 0;
  const service = createDesktopReleaseNotes({ currentVersion: '1.0.0',
    request: async () => { calls++; return response(Array.from({ length: 100 }, (_, index) => entry(`1.0.${index + 1}`))); } });
  assert.equal((await service.getReleaseNotes()).complete, false);
  assert.equal(calls, 10);
});

test('a newly discovered target invalidates release history cached before publication', async () => {
  let target = '1.0.1'; let calls = 0;
  const service = createDesktopReleaseNotes({ currentVersion: '1.0.0', getLatestVersion: () => target,
    request: async () => { calls++; return response([entry(target)]); } });
  await service.getReleaseNotes();
  target = '1.0.2';
  assert.equal((await service.getReleaseNotes()).releases[0].version, '1.0.2');
  assert.equal(calls, 2);
});

test('failed/rate-limited requests can be retried and do not cache errors', async () => {
  let calls = 0;
  const service = createDesktopReleaseNotes({ currentVersion: '1.0.0', request: async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (++calls === 1) return { ok: false, status: 403 };
    return response([entry('1.0.1', null)]);
  } });
  await assert.rejects(service.getReleaseNotes(), /过于频繁/);
  assert.equal((await service.getReleaseNotes()).releases[0].body, '');
  assert.equal(calls, 2);
});
