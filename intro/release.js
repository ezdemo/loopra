/* Public release metadata only: no token, guessed asset URL, or bundled version. */
(function () {
  'use strict';

  var RELEASE_PAGE = 'https://github.com/ezdemo/loopra-release/releases/latest';
  var REPOSITORY = 'https://github.com/ezdemo/loopra-release/releases/';
  var API = 'https://api.github.com/repos/ezdemo/loopra-release/releases/latest';
  var CACHE_KEY = 'loopra.public-release.v1';
  var CACHE_TTL = 5 * 60 * 1000;

  function assetInfo(asset) {
    if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') return null;
    if (asset.state && asset.state !== 'uploaded') return null;
    var url;
    try { url = new URL(asset.browser_download_url); } catch (e) { return null; }
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/ezdemo/loopra-release/releases/download/')) return null;
    var name = asset.name.toLowerCase();
    if (/\.(?:yml|yaml|blockmap|txt|json)$/.test(name) || /\.tar\.gz$/.test(name) || name.endsWith('.tgz')) return null;
    var extension = (name.match(/\.(appimage|deb|rpm|exe|msi|dmg|pkg|zip)$/) || [])[1] || '';
    // darwin- 里含有 win-，必须先于 Windows 判断，否则 macOS 压缩包会被划进 Windows。
    var platform;
    if (/(?:macos|darwin|mac[-_.])/.test(name) || /^(dmg|pkg)$/.test(extension)) platform = 'macos';
    else if (/(?:^|[-_.])linux(?:[-_.]|$)/.test(name) || /^(appimage|deb|rpm)$/.test(extension)) platform = 'linux';
    else if (/(?:^|[-_.])(?:windows|win32|win64)(?:[-_.]|$)/.test(name) || /(?:^|[-_.])win[-_.]/.test(name) || /^(exe|msi)$/.test(extension)) platform = 'windows';
    else return null;
    var arch = /arm64|aarch64/.test(name) ? 'arm64'
      : /x64|x86[-_]64|amd64/.test(name) ? 'x64'
      : /universal/.test(name) ? 'universal'
      : /armv7|(?:^|[-_.])arm(?:[-_.]|$)/.test(name) ? 'armv7'
      : /s390x/.test(name) ? 's390x'
      : /ia32|i[3-6]86|(?:^|[-_.])386(?:[-_.]|$)/.test(name) ? 'x86' : '';
    return {
      platform: platform, arch: arch, format: extension || 'bin',
      kind: /(?:^|[-_.])desktop(?:[-_.]|$)/.test(name) ? 'desktop' : 'cli',
      name: asset.name, url: url.href,
      size: typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size > 0 ? asset.size : 0
    };
  }

  function normalizeRelease(data) {
    if (!data || data.draft || data.prerelease || typeof data.tag_name !== 'string' || !data.tag_name.trim()) throw new Error('Invalid release');
    if (typeof data.html_url !== 'string' || !data.html_url.startsWith(REPOSITORY + 'tag/')) throw new Error('Invalid release page');
    if (typeof data.published_at !== 'string' || !Number.isFinite(Date.parse(data.published_at))) throw new Error('Invalid release date');
    if (!Array.isArray(data.assets)) throw new Error('Invalid release assets');
    var seen = new Set();
    var assets = data.assets.map(assetInfo).filter(function (asset) {
      if (!asset || seen.has(asset.url)) return false;
      seen.add(asset.url);
      return true;
    });
    return { version: data.tag_name, date: data.published_at, url: data.html_url, assets: assets };
  }

  // These pure functions are also used by the release metadata tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = { assetInfo: assetInfo, normalizeRelease: normalizeRelease };
  if (typeof document === 'undefined') return;

  var release = null;
  var state = 'loading';
  var loading = false;
  var platform = detectPlatform();
  var section = document.getElementById('download');
  if (!section) return;

  function detectPlatform() {
    var value = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
    if (/win/i.test(value)) return 'windows';
    if (/mac/i.test(value) && navigator.maxTouchPoints < 2) return 'macos';
    if (/linux/i.test(value) && !/android/i.test(navigator.userAgent)) return 'linux';
    return '';
  }

  function english() { return document.documentElement.lang === 'en'; }
  function text(zh, en) { return english() ? en : zh; }

  function assetLabel(asset) {
    var arch = { x64: 'x86-64', arm64: 'ARM64', x86: 'x86', universal: 'Universal', armv7: 'ARMv7', s390x: 's390x' }[asset.arch] || asset.arch || '';
    if (asset.platform === 'macos') {
      if (asset.arch === 'arm64') arch = 'Apple Silicon';
      if (asset.arch === 'x64') arch = 'Intel';
    }
    var format = { appimage: 'AppImage', deb: 'Debian / Ubuntu', rpm: 'RPM', exe: 'Windows', msi: 'Windows MSI', dmg: 'DMG', pkg: 'PKG', zip: 'ZIP' }[asset.format] || '';
    var kind = asset.kind === 'desktop' ? text('桌面', 'Desktop') : text('命令行', 'CLI');
    return [kind, asset.platform === 'macos' ? arch : format, asset.platform === 'macos' ? format : arch].filter(Boolean).join(' · ');
  }

  function fallbackLink(label) {
    var link = document.createElement('a');
    link.href = RELEASE_PAGE;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'download-link download-fallback';
    link.textContent = label;
    return link;
  }

  function render() {
    var versions = document.querySelectorAll('[data-release-version]');
    versions.forEach(function (element) {
      element.textContent = release ? release.version : state === 'loading' ? text('获取版本中', 'Loading release') : text('GitHub Releases ↗', 'GitHub Releases ↗');
    });
    document.querySelector('[data-release-status]').textContent = state === 'ready' ? 'LATEST' : state === 'cached' ? text('缓存版本', 'CACHED') : 'GITHUB';
    document.querySelectorAll('[data-release-page]').forEach(function (link) { link.href = release ? release.url : RELEASE_PAGE; });
    var date = document.querySelector('[data-release-date]');
    date.textContent = release ? text('发布于 ', 'Released ') + new Intl.DateTimeFormat(english() ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Shanghai' }).format(new Date(release.date)) : '';
    document.querySelectorAll('[data-platform]').forEach(function (card) {
      var detected = card.dataset.platform === platform;
      card.classList.toggle('detected', detected);
      card.querySelector('.platform-detected').hidden = !detected;
      var list = card.querySelector('[data-download-assets]');
      list.replaceChildren();
      if (release) {
        var assets = release.assets.filter(function (asset) { return asset.platform === card.dataset.platform; });
        assets.forEach(function (asset) {
          var link = document.createElement('a');
          link.className = 'download-link';
          link.href = asset.url;
          link.dataset.downloadOriginal = asset.url;
          link.title = asset.name;
          link.setAttribute('aria-label', text('下载 ', 'Download ') + asset.name);
          var label = document.createElement('span');
          label.textContent = assetLabel(asset);
          var size = document.createElement('small');
          size.textContent = asset.size ? (asset.size / 1024 / 1024).toFixed(1) + ' MB' : '';
          var icon = document.createElement('span');
          icon.className = 'download-arrow';
          icon.textContent = '↓';
          icon.setAttribute('aria-hidden', 'true');
          link.append(label, size, icon);
          list.appendChild(link);
        });
        if (!assets.length) list.appendChild(fallbackLink(text('本次未提供安装包 · 查看发布 ↗', 'No package in this release · View release ↗')));
      } else if (state === 'loading') {
        var placeholder = document.createElement('p');
        placeholder.className = 'download-placeholder';
        placeholder.textContent = text('正在获取可用安装包…', 'Loading available packages…');
        list.appendChild(placeholder);
      } else list.appendChild(fallbackLink(text('前往 GitHub 下载 ↗', 'Download on GitHub ↗')));
    });
    var message = document.querySelector('[data-download-message]');
    message.textContent = state === 'error' ? text('暂时无法获取最新版本，请前往 GitHub 下载或重试。', 'Could not fetch the latest release. Download on GitHub or try again.')
      : state === 'cached' ? text('暂时无法确认最新版本，当前显示上次获取的版本与安装包。', 'Could not confirm the latest release. Showing the previously fetched version and packages.')
      : text('版本与安装包列表来自 GitHub 最新正式发布。', 'Version and packages come from the latest stable GitHub release.');
    var retry = document.querySelector('[data-release-retry]');
    retry.hidden = state !== 'error' && state !== 'cached';
    retry.disabled = loading;
    section.setAttribute('aria-busy', String(loading));
    document.dispatchEvent(new CustomEvent('loopra:releasechange'));
  }

  function readCache() {
    try {
      var cache = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (!cache || typeof cache.fetchedAt !== 'number' || cache.fetchedAt > Date.now() || Date.now() - cache.fetchedAt > 7 * 86400000) return null;
      return { release: normalizeRelease(cache.data), fetchedAt: cache.fetchedAt };
    } catch (e) { return null; }
  }

  async function load() {
    if (loading) return;
    loading = true;
    render();
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 8000);
    try {
      var response = await fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal });
      if (!response.ok) throw new Error('Release request failed: ' + response.status);
      var data = await response.json();
      release = normalizeRelease(data);
      state = 'ready';
      // Keep only public fields used by the page.
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), data: {
          tag_name: data.tag_name, published_at: data.published_at, html_url: data.html_url,
          assets: data.assets.map(function (asset) { return { name: asset.name, size: asset.size, state: asset.state, browser_download_url: asset.browser_download_url }; })
        } }));
      } catch (e) { /* Downloading also works when storage is unavailable. */ }
    } catch (e) {
      state = release ? 'cached' : 'error';
    } finally {
      clearTimeout(timer);
      loading = false;
      render();
    }
  }

  document.addEventListener('loopra:languagechange', render);
  document.querySelector('[data-release-retry]').addEventListener('click', load);
  var cached = readCache();
  if (cached) {
    release = cached.release;
    state = Date.now() - cached.fetchedAt < CACHE_TTL ? 'ready' : 'cached';
  }
  render();
  if (!cached || Date.now() - cached.fetchedAt >= CACHE_TTL) load();
})();
