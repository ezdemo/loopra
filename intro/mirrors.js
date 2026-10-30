/* Mirrors use the same release-file URL as GitHub; only the public download route changes. */
(function () {
  'use strict';

  var SOURCES = [
    { id: 'github', label: 'GitHub', prefix: '' },
    { id: 'gh-proxy-org', label: 'gh-proxy.org', prefix: 'https://gh-proxy.org/' },
    { id: 'gh-proxy-com', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
    { id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' },
    { id: 'ghproxy', label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
    { id: 'fastgit', label: 'fastgit.cc', prefix: 'https://fastgit.cc/' },
    { id: 'monlor', label: 'gh.monlor.com', prefix: 'https://gh.monlor.com/' }
  ];
  var CHOICE_KEY = 'loopra.public-download-source.v1';
  // A small release manifest exercises the actual release download route.
  var PROBE_URL = 'https://github.com/ezdemo/loopra-release/releases/latest/download/latest.yml';
  var TIMEOUT = 7000;

  function downloadUrl(original, sourceId) {
    var source = SOURCES.find(function (item) { return item.id === sourceId; });
    var url;
    try { url = new URL(original); } catch (e) { throw new Error('Invalid download URL'); }
    if (!source || url.origin !== 'https://github.com' || !/^\/ezdemo\/loopra-release\/releases\/(?:download\/|latest\/download\/)/.test(url.pathname)) throw new Error('Unsupported download source or URL');
    return source.prefix + url.href;
  }

  function fastestSource(results) {
    var available = results.filter(function (result) { return SOURCES.some(function (source) { return source.id === result.id; }) && Number.isFinite(result.latency) && result.latency >= 0; });
    available.sort(function (a, b) { return a.latency - b.latency; });
    return available.length ? available[0].id : 'github';
  }

  function installCommand(sourceId, platform, gui) {
    var source = SOURCES.find(function (item) { return item.id === sourceId; });
    if (!source) throw new Error('Unsupported install source');
    var base = 'https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup' + (gui ? '-gui' : '');
    if (platform === 'windows') return (source.prefix ? "$env:LOOPRA_MIRROR='" + source.prefix + "'; " : '') + 'irm ' + base + '.ps1 | iex';
    if (platform === 'unix') return (source.prefix ? "export LOOPRA_MIRROR='" + source.prefix + "'; " : '') + 'curl -fsSL ' + base + '.sh | bash';
    throw new Error('Unsupported install platform');
  }

  async function probeSource(source, request) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT);
    var started = performance.now();
    var reader;
    try {
      var response = await request(downloadUrl(PROBE_URL, source.id), {
        headers: { Range: 'bytes=0-2047' }, signal: controller.signal,
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
      });
      if (response.status !== 200 && response.status !== 206) throw new Error('HTTP error');
      if (/text\/html/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > 65536) throw new Error('Not a release manifest');
      var content = '';
      if (response.body && response.body.getReader) {
        reader = response.body.getReader();
        var bytes = 0;
        var decoder = new TextDecoder();
        while (bytes < 2048) {
          var chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          content += decoder.decode(chunk.value.subarray(0, 2048 - content.length), { stream: true });
        }
      } else content = await response.text();
      if (!/^version:\s*\S+/m.test(content)) throw new Error('Invalid release manifest');
      return { id: source.id, latency: Math.max(1, Math.round(performance.now() - started)) };
    } catch (e) {
      // A CORS failure is not proof that the mirror cannot serve a browser download.
      return { id: source.id, latency: null };
    } finally {
      clearTimeout(timer);
      if (reader) await reader.cancel().catch(function () {});
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { SOURCES: SOURCES, downloadUrl: downloadUrl, fastestSource: fastestSource, probeSource: probeSource, installCommand: installCommand };
  if (typeof document === 'undefined') return;
  var selects = document.querySelectorAll('[data-download-source]');
  if (!selects.length) return;
  var buttons = document.querySelectorAll('[data-source-test]');
  var statuses = document.querySelectorAll('[data-source-status]');
  var preference = 'auto';
  var results = [];
  var testing = false;
  var tested = false;
  var recommended = 'github';
  try {
    var saved = localStorage.getItem(CHOICE_KEY);
    if (saved === 'auto' || SOURCES.some(function (source) { return source.id === saved; })) preference = saved;
  } catch (e) { /* Preferences are optional. */ }

  selects.forEach(function (select) {
    SOURCES.forEach(function (source) {
      var option = document.createElement('option');
      option.value = source.id;
      select.appendChild(option);
    });
  });

  function text(zh, en) { return document.documentElement.lang === 'en' ? en : zh; }
  function sourceLabel(source) { return source.id === 'github' ? text('GitHub 直连', 'GitHub direct') : source.label; }
  function activeSource() { return preference === 'auto' ? recommended : preference; }

  function updateLinks() {
    document.querySelectorAll('[data-download-original]').forEach(function (link) {
      link.href = downloadUrl(link.dataset.downloadOriginal, activeSource());
    });
    document.querySelectorAll('[data-install-command]').forEach(function (element) {
      element.textContent = installCommand(activeSource(), element.dataset.installCommand, element.dataset.installGui === 'true');
    });
  }

  function render() {
    selects.forEach(function (select) {
      select.querySelector('option[value="auto"]').textContent = text('自动选择最快源', 'Automatically choose fastest');
      SOURCES.forEach(function (source) {
        var result = results.find(function (item) { return item.id === source.id; });
        var suffix = result ? result.latency == null ? text(' · 浏览器不可测', ' · Could not measure') : ' · ' + result.latency + ' ms' : '';
        select.querySelector('option[value="' + source.id + '"]').textContent = sourceLabel(source) + suffix;
      });
      select.value = preference;
    });
    buttons.forEach(function (button) {
      button.disabled = testing;
      button.textContent = testing ? text('测速中…', 'Testing…') : text('重新测速', 'Test again');
    });
    var source = SOURCES.find(function (item) { return item.id === activeSource(); });
    var result = results.find(function (item) { return item.id === source.id; });
    var message;
    if (testing) message = text('正在测速 ', 'Testing sources ') + results.length + '/' + SOURCES.length + text(' · 当前使用 ', ' · Using ') + sourceLabel(source);
    else if (preference === 'auto' && tested && !results.some(function (item) { return item.latency != null; })) message = text('浏览器未测得可用源，已回退 GitHub 直连；可手动选择镜像。', 'No source could be measured. Using GitHub direct; mirrors remain available manually.');
    else message = (preference === 'auto' ? text('自动推荐：', 'Recommended: ') : text('当前下载源：', 'Download source: ')) + sourceLabel(source) + (result && result.latency != null ? text(' · 响应 ', ' · Response ') + result.latency + ' ms' : result ? text(' · 浏览器不可测，仍可尝试下载', ' · Unmeasured; downloads may still work') : '');
    statuses.forEach(function (status) { status.textContent = message; });
    updateLinks();
  }

  async function measure() {
    if (testing) return;
    testing = true;
    results = [];
    render();
    await Promise.all(SOURCES.map(async function (source) {
      var result = await probeSource(source, window.fetch.bind(window));
      results.push(result);
      render();
    }));
    recommended = fastestSource(results);
    tested = true;
    testing = false;
    render();
  }

  selects.forEach(function (select) {
    select.addEventListener('change', function () {
      preference = select.value;
      try { localStorage.setItem(CHOICE_KEY, preference); } catch (e) { /* Optional. */ }
      render();
    });
  });
  buttons.forEach(function (button) { button.addEventListener('click', measure); });
  document.addEventListener('loopra:languagechange', render);
  document.addEventListener('loopra:releasechange', updateLinks);
  render();
  measure();
})();
