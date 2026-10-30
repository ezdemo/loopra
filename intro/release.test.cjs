const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assetInfo, normalizeRelease } = require('./release.js');

function asset(name, extra = {}) {
  return { name, size: 1048576, state: 'uploaded', browser_download_url: 'https://github.com/ezdemo/loopra-release/releases/download/v1/' + name, ...extra };
}
function release(assets, extra = {}) {
  return { tag_name: 'v1', published_at: '2026-10-25T12:18:19Z', html_url: 'https://github.com/ezdemo/loopra-release/releases/tag/v1', assets, ...extra };
}

test('classifies current release installers and excludes updater metadata and the CLI archive', () => {
  const data = normalizeRelease(release([
    asset('latest.yml'), asset('latest-unsigned-mac.yml'), asset('loopra-dist.tar.gz'),
    asset('Loopra-windows-x64.exe'), asset('Loopra-windows-x64.exe.blockmap'),
    asset('Loopra-macos-arm64.zip'), asset('Loopra-linux-x64.AppImage'), asset('Loopra-linux-x64.deb'),
    asset('looprax-desktop-darwin-amd64.zip'), asset('looprax-desktop-darwin-arm64.zip'),
    asset('looprax-darwin-arm64'), asset('looprax-desktop-linux-amd64'), asset('looprax-linux-arm64'),
    asset('looprax-windows-386.exe')
  ]));
  assert.deepEqual(data.assets.map(a => [a.platform, a.arch, a.format, a.kind]), [
    ['windows', 'x64', 'exe', 'cli'],
    ['macos', 'arm64', 'zip', 'cli'],
    ['linux', 'x64', 'appimage', 'cli'],
    ['linux', 'x64', 'deb', 'cli'],
    ['macos', 'x64', 'zip', 'desktop'],
    ['macos', 'arm64', 'zip', 'desktop'],
    ['macos', 'arm64', 'bin', 'cli'],
    ['linux', 'x64', 'bin', 'desktop'],
    ['linux', 'arm64', 'bin', 'cli'],
    ['windows', 'x86', 'exe', 'cli']
  ]);
  assert.equal(data.assets[0].size, 1048576);
  assert.equal(data.version, 'v1');
});

test('discovers additional architectures and formats when they are actually published', () => {
  assert.equal(assetInfo(asset('Loopra-macos-x64.dmg')).arch, 'x64');
  assert.equal(assetInfo(asset('Loopra-linux-arm64.deb')).arch, 'arm64');
  assert.equal(assetInfo(asset('Loopra-macos-universal.zip')).arch, 'universal');
  assert.equal(assetInfo(asset('Loopra-windows-arm64.msi')).arch, 'arm64');
});

test('uses only uploaded assets from this repository and removes duplicate URLs', () => {
  const valid = asset('Loopra-windows-x64.exe');
  assert.equal(normalizeRelease(release([valid, valid])).assets.length, 1);
  for (const url of ['javascript:alert(1)', 'https://example.com/setup.exe', 'https://github.com/other/repo/releases/download/v1/setup.exe', 'https://github.com.evil.test/ezdemo/loopra-release/releases/download/v1/setup.exe']) {
    assert.equal(assetInfo(asset('setup.exe', { browser_download_url: url })), null);
  }
  assert.equal(assetInfo(asset('setup.exe', { state: 'open' })), null);
  assert.equal(assetInfo(null), null);
  assert.equal(assetInfo(asset('unknown.zip')), null);
});

test('rejects malformed or non-stable releases and accepts an empty package list for fallback', () => {
  for (const patch of [{ draft: true }, { prerelease: true }, { published_at: null }, { published_at: 'invalid' }, { tag_name: '' }, { assets: null }, { html_url: 'https://example.com/release' }]) {
    assert.throws(() => normalizeRelease(release([], patch)));
  }
  assert.deepEqual(normalizeRelease(release([])).assets, []);
});
