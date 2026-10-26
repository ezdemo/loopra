const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

app.setPath('userData', process.argv[3]);
const css = readFileSync(process.argv[2], 'utf8').replace(/^@import.*$/gm, '');
const afterPaint = win => win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
function hitTest(win, points) {
  const handle = win.getNativeWindowHandle().readBigUInt64LE().toString();
  const scale = screen.getDisplayMatching(win.getContentBounds()).scaleFactor;
  const coordinates = points.map(point => `${Math.round(point.x * scale)},${Math.round(point.y * scale)}`).join(';');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'desktop-drag-hit-test.ps1'), handle, coordinates], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('exit', code => code ? reject(new Error(stderr)) : resolve(stdout.trim().split(/\s+/).map(Number)));
  });
}

app.whenReady().then(async () => {
  // Hidden windows still register native drag regions, without interrupting the desktop.
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, frame: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><style>${css}
    .main-content { position:relative; display:flex; flex:1; flex-direction:column; min-height:0; }
    .history-action { display:block; width:100%; height:36px; }
    </style><div class="desktop-app is-desktop-shell" data-panel="closed"><div class="app-body">
    <aside class="sidebar"><div class="sidebar-brand">Loopra<button id="sidebar-control">toggle</button></div></aside>
    <main class="main-area"><header class="conversation-header"><div class="header-leading">
    <div class="breadcrumb"><span>project</span><span>/</span><strong>Running session</strong><button id="session-control">...</button></div>
    <div class="header-drag" aria-hidden="true"></div></div>
    <div class="header-actions"><button id="version-control">version</button></div></header>
    <div class="main-content"><div class="chat-scroll"><button class="history-action">history action</button><div id="stream" style="height:1400px">history</div></div></div>
    </main></div><header class="desktop-titlebar"><div class="desktop-window-controls">
    <button class="dw-btn" id="minimize">-</button><button class="dw-btn" id="maximize">+</button><button class="dw-btn" id="close">x</button>
    </div></header></div>`));

  let checked = 0;
  for (const uiScale of [0.8, 1, 1.25]) {
    await win.webContents.executeJavaScript(`document.documentElement.style.setProperty('--ui-scale', '${uiScale}'); document.querySelector('.chat-scroll').scrollTop = 0; document.querySelector('.streaming-bar')?.remove()`);
    for (const state of ['idle', 'streaming', 'streaming-update']) {
      if (state === 'streaming') {
        // Scroll a full-width history button behind the title row, entirely clipped
        // by chat-scroll. It must not subtract a native drag rectangle there.
        await win.webContents.executeJavaScript(`document.querySelector('.chat-scroll').scrollTop = 36; document.querySelector('.main-content').insertAdjacentHTML('afterbegin', '<div class="streaming-bar"><div class="streaming-bar-inner"></div></div>')`);
      } else if (state === 'streaming-update') {
        await win.webContents.executeJavaScript(`document.querySelector('#stream').append(document.createTextNode(' streamed tool output')); document.querySelector('.history-action').disabled = true`);
      }
      await afterPaint(win);
      const points = await win.webContents.executeJavaScript(`['.header-drag', '#session-control', '#version-control', '#sidebar-control', '#minimize', '#maximize', '#close'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { selector, x:(r.left+r.right)/2, y:(r.top+r.bottom)/2 };
      })`);
      const hits = await hitTest(win, points);
      assert.equal(hits.length, points.length);
      points.forEach((point, index) => assert.equal(hits[index], index === 0 ? 2 : 1, `${state} at UI scale ${uiScale}: ${point.selector}`));
      checked += points.length;
    }
  }
  console.log(`Verified ${checked} native title-bar and control hit tests.`);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
