const { compareVersions } = require('./version.cjs')
const fs = require('fs')
const path = require('path')

function desktopUpdateSupport({ isPackaged, platform, macSigned = false, linuxPackageType = '', appImagePath = '' }) {
  if (!isPackaged) return { supported: false, unsupportedReason: '开发环境不自动更新，请使用正式安装版。' }
  if (platform === 'win32') return { supported: true, packageType: 'nsis' }
  if (platform === 'darwin') return macSigned
    ? { supported: true, packageType: 'mac' }
    : { supported: false, unsupportedReason: '此 macOS 版本未使用正式签名，请从发布页下载安装。' }
  if (platform === 'linux') {
    if (appImagePath) return { supported: true, packageType: 'AppImage' }
    if (linuxPackageType === 'deb') return { supported: true, packageType: 'deb', installHint: '安装更新时，系统可能要求管理员授权。' }
    return { supported: false, unsupportedReason: '请安装官方 .deb 或使用 AppImage，以启用自动更新。' }
  }
  return { supported: false, unsupportedReason: '此平台请从发布页下载安装。' }
}

function readDesktopUpdateOptions(app, { platform = process.platform, resourcesPath = process.resourcesPath, env = process.env, readFileSync = fs.readFileSync } = {}) {
  let macSigned = false
  let linuxPackageType = ''
  if (app.isPackaged && platform === 'darwin') {
    try { macSigned = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).loopraDesktopUpdate?.macSigned === true } catch { /* Unmarked builds retain manual updates. */ }
  }
  if (app.isPackaged && platform === 'linux') {
    try { linuxPackageType = readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim() } catch { /* AppImage needs no package-type marker. */ }
  }
  return { platform, macSigned, linuxPackageType, appImagePath: env.APPIMAGE || '' }
}

function loadDesktopUpdater(options, load = () => require('electron-updater')) {
  const support = desktopUpdateSupport(options)
  if (!support.supported) return null
  const library = load()
  if (support.packageType === 'AppImage') return new library.AppImageUpdater()
  if (support.packageType === 'deb') return new library.DebUpdater()
  return library.autoUpdater
}

// Keep installer control in the main process. No feed URLs or paths come from IPC.
function createDesktopUpdater({ app, updater, nativeUpdater, getReleaseNotes, publish = () => {}, platform = process.platform, ...options }) {
  const support = desktopUpdateSupport({ isPackaged: app.isPackaged, platform, ...options })
  const supported = support.supported && !!updater
  let state = {
    ...support, supported, currentVersion: app.getVersion(), status: supported ? 'idle' : 'unsupported',
    latestVersion: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0,
    error: '', checkedAt: '', revision: 0,
  }
  let checking = null
  let downloading = null
  let startupTimer
  let interval
  const getState = () => ({ ...state })
  const change = (patch) => { state = { ...state, ...patch, revision: state.revision + 1 }; publish(getState()) }
  const fail = (error) => {
    if (state.status === 'installing') {
      change({ status: 'downloaded', error: error?.message || String(error) })
      return
    }
    if (state.status === 'downloaded') return
    change({ status: 'error', error: error?.message || String(error) })
  }

  function download() {
    if (!supported || ['verifying', 'downloaded', 'installing'].includes(state.status)) return Promise.resolve(getState())
    if (downloading) return downloading
    if (!state.latestVersion) return check()
    change({ status: 'downloading', error: '', percent: 0 })
    downloading = Promise.resolve().then(() => updater.downloadUpdate())
      .catch(fail).finally(() => { downloading = null })
      .then(getState)
    return downloading
  }

  function check() {
    if (!supported || ['downloading', 'verifying', 'downloaded', 'installing'].includes(state.status)) return Promise.resolve(getState())
    if (checking) return checking
    change({ status: 'checking', error: '' })
    checking = Promise.resolve().then(() => updater.checkForUpdates())
      .catch(fail).finally(() => { checking = null }).then(getState)
    return checking
  }

  function install() {
    if (!supported || state.status !== 'downloaded') throw new Error('更新尚未下载完成')
    change({ status: 'installing', error: '' })
    try { updater.quitAndInstall(true, true) }
    catch (error) { change({ status: 'downloaded', error: error.message || String(error) }); throw error }
    return getState()
  }

  if (supported) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.autoRunAppAfterInstall = true
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.on('error', fail)
    updater.on('update-available', (info) => {
      if (compareVersions(info.version, state.currentVersion) <= 0) {
        change({ status: 'idle', latestVersion: '', checkedAt: new Date().toISOString() })
        return
      }
      change({ status: 'available', latestVersion: info.version, checkedAt: new Date().toISOString() })
      void download()
    })
    updater.on('update-not-available', () => change({ status: 'idle', latestVersion: '', checkedAt: new Date().toISOString() }))
    updater.on('download-progress', (progress) => change({
      status: 'downloading', percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)),
      transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond,
    }))
    updater.on('update-downloaded', (info) => change({ status: platform === 'darwin' ? 'verifying' : 'downloaded', latestVersion: info.version, percent: 100, error: '' }))
    // MacUpdater emits its event before Squirrel verifies the signed ZIP.
    // Enable installation only when Electron confirms the native update is ready.
    if (platform === 'darwin') nativeUpdater?.on('update-downloaded', () => {
      if (state.status === 'verifying') change({ status: 'downloaded', error: '' })
    })
  }

  function start() {
    if (!supported || startupTimer || interval) return
    startupTimer = setTimeout(() => { startupTimer = null; void check() }, 10000)
    startupTimer.unref?.()
    interval = setInterval(() => { void check() }, 4 * 60 * 60 * 1000)
    interval.unref?.()
  }
  function dispose() { clearTimeout(startupTimer); clearInterval(interval) }
  return { getState, check, download, install, start, dispose, getReleaseNotes }
}

function registerDesktopUpdateIpc(ipcMain, controller, getWindow) {
  for (const action of ['getState', 'check', 'download', 'install', 'getReleaseNotes']) {
    ipcMain.handle(`desktop-update-${action}`, (event) => {
      const window = getWindow()
      if (!window || window.isDestroyed() || event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame) throw new Error('无权操作桌面更新')
      return controller[action]()
    })
  }
}

module.exports = { createDesktopUpdater, registerDesktopUpdateIpc, desktopUpdateSupport, readDesktopUpdateOptions, loadDesktopUpdater }
