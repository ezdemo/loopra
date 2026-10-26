/* Loopra 官网交互：语言切换 / 主题切换 / 命令复制 / 安装源标签页 / 移动端导航 / 进入动画 */
(function () {
  'use strict';

  var THEME_KEY = 'loopra-site-theme';

  /* ---------- 主题 ---------- */
  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var useDark = theme === 'dark';
    document.querySelectorAll('[data-icon-sun]').forEach(function (el) {
      el.style.display = useDark ? 'none' : '';
    });
    document.querySelectorAll('[data-icon-moon]').forEach(function (el) {
      el.style.display = useDark ? '' : 'none';
    });
  }

  var saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
  applyTheme(saved === 'dark' || saved === 'light' ? saved : systemTheme());

  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-theme-toggle]');
    if (!toggle) return;
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* ignore */ }
  });

  /* ---------- 语言切换 ---------- */
  var LANG_KEY = 'loopra-site-lang';
  var originalTitle = document.title;
  var description = document.querySelector('meta[name="description"]');
  var originalDescription = description ? description.content : '';
  var i18nEls = document.querySelectorAll('[data-i18n]');
  var i18nLabelEls = document.querySelectorAll('[data-i18n-label]');

  function getLang() {
    var stored = null;
    try { stored = localStorage.getItem(LANG_KEY); } catch (e) { /* ignore */ }
    return stored === 'en' ? 'en' : 'zh';
  }

  function setYear() {
    document.querySelectorAll('[data-year]').forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  function applyLang(lang) {
    var en = window.LOOPRA_I18N_EN || {};
    i18nEls.forEach(function (el) {
      if (el.dataset.i18nZh === undefined) el.dataset.i18nZh = el.innerHTML;
      var key = el.getAttribute('data-i18n');
      if (lang === 'en') {
        if (en[key] != null) el.innerHTML = en[key];
      } else {
        el.innerHTML = el.dataset.i18nZh;
      }
    });
    i18nLabelEls.forEach(function (el) {
      if (el.dataset.i18nLabelZh === undefined) {
        el.dataset.i18nLabelZh = el.getAttribute('aria-label') || '';
      }
      var key = el.getAttribute('data-i18n-label');
      var text = lang === 'en' && en[key] != null ? en[key] : el.dataset.i18nLabelZh;
      el.setAttribute('aria-label', text);
      if (el.hasAttribute('title')) el.setAttribute('title', text);
    });
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
    document.title = lang === 'en' && en['doc.title'] ? en['doc.title'] : originalTitle;
    if (description) {
      description.content = lang === 'en'
        ? 'Loopra is a Java-powered AI coding agent and workbench. Use Native, Claude Code, Codex, Pi and DeepSeek Harness through React Web and Electron Desktop for local codebase development and collaboration.'
        : originalDescription;
    }
    var toggle = document.querySelector('[data-lang-toggle]');
    if (toggle) toggle.textContent = lang === 'en' ? '中文' : 'EN';
    setYear();
    document.dispatchEvent(new CustomEvent('loopra:languagechange', { detail: { lang: lang } }));
  }

  applyLang(getLang());

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-lang-toggle]');
    if (!btn) return;
    var next = getLang() === 'en' ? 'zh' : 'en';
    try { localStorage.setItem(LANG_KEY, next); } catch (err) { /* ignore */ }
    applyLang(next);
  });

  /* ---------- 命令复制 ---------- */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var text = btn.getAttribute('data-copy');
    var fromSel = btn.getAttribute('data-copy-from');
    if (!text && fromSel) {
      var source = document.querySelector(fromSel);
      if (source) text = source.textContent.trim();
    }
    if (!text) return;
    copyText(text).then(function () {
      btn.classList.add('copied');
      var label = btn.querySelector('.copy-label');
      if (label) label.textContent = getLang() === 'en' ? 'Copied' : '已复制';
      setTimeout(function () {
        btn.classList.remove('copied');
        if (label) label.textContent = getLang() === 'en' ? 'Copy' : '复制';
      }, 1600);
    }).catch(function () { /* 复制失败静默处理 */ });
  });

  /* ---------- 安装源标签页 ---------- */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]');
    if (!tab) return;
    var group = tab.closest('[data-tabs]');
    if (!group) return;
    var key = tab.getAttribute('data-tab');
    group.querySelectorAll('[data-tab]').forEach(function (el) {
      var active = el === tab;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    group.querySelectorAll('[data-tab-panel]').forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === key);
    });
  });

  /* ---------- 移动端导航 ---------- */
  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-nav-toggle]');
    var links = document.querySelector('[data-nav-links]');
    if (toggle && links) {
      links.classList.toggle('open');
      return;
    }
    if (links && links.classList.contains('open')) {
      if (!e.target.closest('[data-nav-links]')) links.classList.remove('open');
    }
  });

  /* ---------- 进入动画 ---------- */
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('visible'); });
  }

  /* ---------- 年份 ---------- */
  setYear();
})();
