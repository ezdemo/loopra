const { compareVersions } = require('./version.cjs')
const fs = require('fs')
const path = require('path')
const { normalizeUpdateSource, desktopUpdateFeed } = require('./desktop-update-source.cjs')

function desktopUpdateSupport({ isPackaged, platform, macSigned = false, linuxPackageType = '', appImagePath = '' }) {
  if (!isPackaged) return { supported: false, unsupportedReason: '开发环境不自动更新，请使用正式安装版。' }
  if (platform === 'win32') return { supported: true, packageType: 'nsis' }
  if (platform === 'darwin') return macSigned
    ? { supported: true, packageType: 'mac' }
    : { supported: true, packageType: 'mac-unsigned', installHint: '请将应用放在可写的应用程序目录；下载后退出应用即可安装更新。' }
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
    try { macSigned = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).loopraDesktopUpdate?.macSigned === true } catch { /* Unmarked builds use the unsigned installer. */ }
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
  if (support.packageType === 'mac-unsigned') return require('./unsigned-mac-updater.cjs').createUnsignedMacUpdater(library)
  if (support.packageType === 'AppImage') return new library.AppImageUpdater()
  if (support.packageType === 'deb') return new library.DebUpdater()
  return library.autoUpdater
}

// IPC selects an allowlisted source; only the main process builds the official feed URL.
function createDesktopUpdater({ app, updater, nativeUpdater, getReleaseNotes, source = 'normal', saveSource = () => {},
  publish = () => {}, platform = process.platform, ...options }) {
  const support = desktopUpdateSupport({ isPackaged: app.isPackaged, platform, ...options })
  const supported = support.supported && !!updater
  let state = {
    ...support, supported, currentVersion: app.getVersion(), status: supported ? 'idle' : 'unsupported',
    latestVersion: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0,
    error: updater?.installationError || '', checkedAt: '', revision: 0,
    source: normalizeUpdateSource(source), changingSource: false,
  }
  if (supported && state.error) state.status = 'error'
  let checking = null
  let downloading = null
  let cancellationToken
  let sourceChange = null
  let startupTimer
  let interval
  const getState = () => ({ ...state })
  const change = (patch) => { state = { ...state, ...patch, revision: state.revision + 1 }; publish(getState()) }
  const fail = (error) => {
    if (state.changingSource) return
    if (state.status === 'installing') {
      change({ status: 'downloaded', error: error?.message || String(error) })
      return
    }
    if (state.status === 'downloaded') return
    change({ status: 'error', error: error?.message || String(error) })
  }

  function download() {
    if (!supported || state.changingSource || ['verifying', 'downloaded', 'installing'].includes(state.status)) return Promise.resolve(getState())
    if (downloading) return downloading
    if (!state.latestVersion) return check()
    change({ status: 'downloading', error: '', percent: 0 })
    downloading = Promise.resolve().then(() => updater.downloadUpdate(cancellationToken))
      .catch(fail).finally(() => { downloading = null })
      .then(getState)
    return downloading
  }

  function check() {
    if (!supported || state.changingSource || ['downloading', 'verifying', 'downloaded', 'installing'].includes(state.status)) return Promise.resolve(getState())
    if (checking) return checking
    change({ status: 'checking', error: '' })
    checking = Promise.resolve().then(async () => {
      const result = await updater.checkForUpdates()
      cancellationToken = result?.cancellationToken
      if (state.status === 'available' && !state.changingSource) void download()
    })
      .catch(fail).finally(() => { checking = null }).then(getState)
    return checking
  }

  function configureSource(next) {
    if (!supported) return
    updater.setFeedURL(desktopUpdateFeed(next, support.packageType))
    // Mirrors need not support the multipart ranges used for differential downloads.
    updater.disableDifferentialDownload = next !== 'normal'
  }

  async function setSource(value) {
    const next = normalizeUpdateSource(value)
    if (sourceChange) throw new Error('正在切换更新源，请稍候')
    if (next === state.source) return getState()
    if (['verifying', 'downloaded', 'installing'].includes(state.status)) throw new Error('更新已下载，请完成安装后再切换更新源')
    change({ changingSource: true, error: '' })
    sourceChange = (async () => {
      try {
        cancellationToken?.cancel()
        // Wait for the old provider and download to settle before replacing either.
        await Promise.all([checking, downloading])
        if (['verifying', 'downloaded', 'installing'].includes(state.status)) throw new Error('更新已下载，请完成安装后再切换更新源')
        configureSource(next)
        try { saveSource(next) }
        catch (error) { configureSource(state.source); throw error }
        cancellationToken = undefined
        change({ source: next, status: supported ? 'idle' : 'unsupported', latestVersion: '', checkedAt: '',
          percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, error: '' })
      } catch (error) {
        if (!['verifying', 'downloaded', 'installing'].includes(state.status)) {
          change({ status: supported ? 'error' : 'unsupported', error: error.message || String(error) })
        }
        throw error
      } finally {
        change({ changingSource: false })
      }
      return check()
    })().finally(() => { sourceChange = null })
    return sourceChange
  }

  function install() {
    if (state.changingSource) throw new Error('正在切换更新源，请稍候')
    if (!supported || state.status !== 'downloaded') throw new Error('更新尚未下载完成')
    change({ status: 'installing', error: '' })
    try {
      const result = updater.quitAndInstall(true, true)
      if (result?.then) return result.then(getState, error => {
        change({ status: 'downloaded', error: error.message || String(error) }); throw error
      })
    }
    catch (error) { change({ status: 'downloaded', error: error.message || String(error) }); throw error }
    return getState()
  }

  if (supported) {
    configureSource(state.source)
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
    })
    updater.on('update-not-available', () => change({ status: 'idle', latestVersion: '', checkedAt: new Date().toISOString() }))
    updater.on('download-progress', (progress) => !state.changingSource && change({
      status: 'downloading', percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)),
      transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond,
    }))
    updater.on('update-verifying', () => !state.changingSource && change({ status: 'verifying', percent: 100, error: '' }))
    updater.on('update-downloaded', (info) => change({ status: support.packageType === 'mac' ? 'verifying' : 'downloaded', latestVersion: info.version, percent: 100, error: '' }))
    // MacUpdater emits its event before Squirrel verifies the signed ZIP.
    // Enable installation only when Electron confirms the native update is ready.
    if (support.packageType === 'mac') nativeUpdater?.on('update-downloaded', () => {
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
  return { getState, check, download, install, start, dispose, getReleaseNotes, setSource }
}

function registerDesktopUpdateIpc(ipcMain, controller, getWindow) {
  for (const action of ['getState', 'check', 'download', 'install', 'getReleaseNotes', 'setSource']) {
    ipcMain.handle(`desktop-update-${action}`, (event, source) => {
      const window = getWindow()
      if (!window || window.isDestroyed() || event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame) throw new Error('无权操作桌面更新')
      return action === 'setSource' ? controller.setSource(source) : controller[action]()
    })
  }
}

module.exports = { createDesktopUpdater, registerDesktopUpdateIpc, desktopUpdateSupport, readDesktopUpdateOptions, loadDesktopUpdater }
