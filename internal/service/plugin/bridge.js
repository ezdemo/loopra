// 插件页和宿主之间的桥。页面用 <script src="_loopra/bridge.js"></script> 加载。
// 沙箱页是不透明源，读不到访问密钥。主题、配置和服务请求都走 postMessage。
//
//   await loopra.ready
//   loopra.theme
//   loopra.onTheme(fn)
//   await loopra.config.get()
//   await loopra.config.set(value)
//   await loopra.request(action, value)
//
// 没写样式的标题、按钮、输入框和表格用宿主的样子。规则都包在 :where() 里，
// 页面自己的样式表会盖过它们。
(() => {
  const waiting = new Map();
  let next = 0;
  const themed = [];
  const contextual = [];
  const skip = { dark: 1, font: 1, code: 1 };
  function call(op, extra) {
    const id = String(++next);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("请求超时，请重试"));
      }, 45000);
      waiting.set(id, { resolve, reject, timer });
      parent.postMessage(Object.assign({ type: "loopra", op, id }, extra || {}), "*");
    });
  }
  function paint(theme) {
    const root = document.documentElement;
    const dark = theme && (theme.dark === "dark" || theme.dark === true);
    root.dataset.theme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
    if (!theme) return;
    for (const [key, value] of Object.entries(theme)) {
      if (skip[key] || typeof value !== "string" || !value) continue;
      root.style.setProperty("--" + key, value);
    }
    if (typeof theme.font === "string" && theme.font) root.style.setProperty("--loopra-font", theme.font);
    if (typeof theme.code === "string" && theme.code) root.style.setProperty("--loopra-code", theme.code);
  }
  function settle(data) {
    api.theme = data.theme || {};
    api.plugin = data.plugin || null;
    api.context = data.context || {};
    paint(api.theme);
    for (const fn of themed) {
      try { fn(api.theme); } catch (error) { report(error); }
    }
    for (const fn of contextual) {
      try { fn(api.context); } catch (error) { report(error); }
    }
    if (!api.ready.settled) {
      api.ready.settled = true;
      api.ready.resolve(api.theme);
    }
  }
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.type !== "loopra") return;
    if (data.op === "ready") {
      settle(data);
      return;
    }
    if (data.op !== "config" && data.op !== "service:result") return;
    const wait = waiting.get(String(data.id));
    if (!wait) return;
    waiting.delete(String(data.id));
    clearTimeout(wait.timer);
    if (data.error) wait.reject(new Error(data.error));
    else wait.resolve(data.value);
  });
  let resolveReady = () => {};
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const api = {
    theme: null,
    plugin: null,
    context: {},
    onTheme(fn) { themed.push(fn); },
    onContext(fn) { contextual.push(fn); },
    config: {
      get: () => call("config:get"),
      set: (value) => call("config:set", { value }),
    },
    request: (action, value) => call("service:request", { action, value: value || {} }),
  };
  api.ready = ready;
  api.ready.resolve = resolveReady;
  api.ready.settled = false;
  function report(error) {
    parent.postMessage({ type: "loopra", op: "error", message: String(error?.message || error || "页面运行出错") }, "*");
  }
  addEventListener("error", event => {
    if (/ResizeObserver loop/.test(event.message)) return;
    report(event.error || event.message);
  });
  addEventListener("unhandledrejection", event => report(event.reason));
  const base = document.createElement("style");
  base.dataset.loopra = "base";
  base.textContent = `
:where(html) { background: var(--surface, #fff); color: var(--text, #1c1c1a); font: 14px/1.5 var(--loopra-font, Inter, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif); -webkit-font-smoothing: antialiased; }
:where(body) { margin: 0; padding: 20px 24px 32px; }
:where(*), :where(*::before), :where(*::after) { box-sizing: border-box; }
:where(h1, h2, h3, h4) { font-weight: 600; margin: 0 0 8px; letter-spacing: -.01em; color: var(--text, inherit); }
:where(h1) { font-size: 18px; } :where(h2) { font-size: 15px; } :where(h3, h4) { font-size: 13px; }
:where(p) { margin: 0 0 8px; }
:where(small, .muted) { color: var(--muted, #8f8f89); }
:where(a) { color: var(--blue, #3b6cf6); text-decoration: none; }
:where(a:hover) { text-decoration: underline; }
:where(button, input, textarea, select) { font: inherit; color: inherit; }
:where(button) { background: var(--surface, #fff); border: 1px solid var(--line, #e7e7e4); border-radius: var(--radius-md, .5rem); padding: 6px 12px; cursor: pointer; }
:where(button:hover:not(:disabled)) { background: var(--hover, #f0f0ee); }
:where(button.primary) { background: var(--blue, #3b6cf6); border-color: transparent; color: #fff; }
:where(button.primary:hover:not(:disabled)) { background: color-mix(in srgb, var(--blue, #3b6cf6) 88%, black); }
:where(button.danger) { color: var(--danger, #d6453d); }
:where(button:disabled) { opacity: .5; cursor: default; }
:where(input, textarea, select) { background: var(--surface, #fff); border: 1px solid var(--line, #e7e7e4); border-radius: var(--radius-md, .5rem); padding: 8px 10px; }
:where(label) { display: block; color: var(--secondary, #5f5f5a); font-size: 13px; }
:where(label input, label textarea, label select) { display: block; width: 100%; margin-top: 6px; }
:where(:focus-visible) { outline: 2px solid var(--blue, #3b6cf6); outline-offset: 1px; }
:where(table) { border-collapse: collapse; width: 100%; }
:where(th) { text-align: left; font-weight: 500; font-size: 12px; color: var(--muted, #8f8f89); }
:where(th, td) { padding: 6px 8px; border-bottom: 1px solid var(--line, #e7e7e4); }
:where(code, kbd) { font-family: var(--loopra-code, Consolas, "Cascadia Code", monospace); font-size: 12px; }
:where(pre) { background: var(--soft, #f5f5f4); border: 1px solid var(--line, #e7e7e4); border-radius: var(--radius-lg, .75rem); padding: 12px 14px; overflow: auto; font-family: var(--loopra-code, Consolas, "Cascadia Code", monospace); font-size: 12px; white-space: pre-wrap; }
:where(hr) { border: 0; border-top: 1px solid var(--line, #e7e7e4); margin: 16px 0; }
:where(::selection) { background: var(--accent-soft, #3b6cf61a); }
:where([hidden]) { display: none !important; }
`;
  (document.head || document.documentElement).prepend(base);
  window.loopra = api;
  parent.postMessage({ type: "loopra", op: "hello" }, "*");
})();
