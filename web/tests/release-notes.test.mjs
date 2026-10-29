import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function moduleUrl(file, dependencies = {}) {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  for (const [specifier, url] of Object.entries(dependencies)) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url));
  return dataUrl(outputText);
}
const { createWebReleaseNotesReader } = await import(await moduleUrl('release-notes.ts', { './update-scripts': await moduleUrl('update-scripts.ts') }));
const entry = (version, extra = {}) => ({ tag_name: `v${version}`, body: `### 修复\n\n- Changes in ${version}`, ...extra });
const response = entries => ({ ok: true, json: async () => entries });

test('Web notes use the core version range, excluding previews and versions newer than the target', async () => {
  const read = createWebReleaseNotesReader(async (url, options) => {
    assert.match(url, /^https:\/\/api.github.com\/repos\/ezdemo\/loopra-release\/releases\?/);
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    return response([entry('26.9.91'), entry('26.10.1'), entry('26.9.92'), entry('26.10.2'),
      entry('26.10.3', { draft: true }), entry('26.10.4', { prerelease: true }), entry('26.10.5-beta.1'), null]);
  });
  const result = await read('26.9.91', '26.10.1');
  assert.deepEqual(result.releases.map(release => release.version), ['26.10.1', '26.9.92']);
  assert.equal(result.currentVersion, '26.9.91');
  assert.equal(result.latestVersion, '26.10.1');
  assert.equal(result.complete, true);
});

test('Web notes paginate, share in-flight requests, cache history, and reselect it for another installed version', async () => {
  let calls = 0; let now = 0;
  const read = createWebReleaseNotesReader(async url => {
    calls++;
    return response(url.endsWith('page=1') ? Array.from({ length: 100 }, (_, index) => entry(`1.0.${index + 2}`)) : [entry('1.0.1')]);
  }, () => now);
  const [result, duplicate] = await Promise.all([read('1.0.0', '1.0.101'), read('1.0.100', '1.0.101')]);
  assert.equal(calls, 2);
  assert.equal(result.releases.length, 101);
  assert.deepEqual(duplicate.releases.map(release => release.version), ['1.0.101']);
  await read('1.0.0', '1.0.101'); assert.equal(calls, 2);
  now = 300000;
  await read('1.0.0', '1.0.101'); assert.equal(calls, 4);
});

test('up-to-date Web installs display their own notes without installer appendices', async () => {
  const read = createWebReleaseNotesReader(async () => response([entry('1.0.1', {
    body: '## Loopra v1.0.1\n\n### 新增\n\n- Release history\n\n### 下载\n\ninstaller\n<!-- provenance -->',
  }), entry('1.0.0')]));
  const result = await read('v1.0.1', 'v1.0.1');
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].body, '### 新增\n\n- Release history');
  assert.equal(result.releases[0].url, 'https://github.com/ezdemo/loopra-release/releases/tag/v1.0.1');
});

test('new release targets invalidate the cache and unknown versions never issue a request', async () => {
  let calls = 0;
  const read = createWebReleaseNotesReader(async () => response([entry(`1.0.${++calls}`)]));
  await assert.rejects(read('unknown', '1.0.1'), /版本信息尚未就绪/);
  assert.equal(calls, 0);
  await read('1.0.0', '1.0.1');
  assert.equal((await read('1.0.0', '1.0.2')).releases[0].version, '1.0.2');
  assert.equal(calls, 2);
});

test('rate limits, invalid responses, and timeouts remain retryable', async () => {
  let calls = 0;
  const read = createWebReleaseNotesReader(async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429 };
    if (calls === 2) return response({ message: 'bad response' });
    if (calls === 3) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return response([entry('1.0.1', { body: null })]);
  });
  await assert.rejects(read('1.0.0', '1.0.1'), /过于频繁/);
  await assert.rejects(read('1.0.0', '1.0.1'), /无效/);
  await assert.rejects(read('1.0.0', '1.0.1'), /超时/);
  assert.equal((await read('1.0.0', '1.0.1')).releases[0].body, '');
});

test('large release histories explicitly report the pagination limit', async () => {
  let calls = 0;
  const read = createWebReleaseNotesReader(async () => { calls++; return response(Array.from({ length: 100 }, (_, index) => entry(`1.0.${index + 1}`))); });
  assert.equal((await read('1.0.0', '1.0.100')).complete, false);
  assert.equal(calls, 10);
});
