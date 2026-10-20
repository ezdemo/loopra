const { compareVersions } = require('./version.cjs')

// Keep installer control in the main process. No feed URLs or paths come from IPC.
function createDesktopUpdater({ app, updater, publish = () => {}, platform = process.platform }) {
  const supported = app.isPackaged && platform === 'win32' && !!updater
  let state = {
    supported, currentVersion: app.getVersion(), status: supported ? 'idle' : 'unsupported',
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
    if (!supported || ['downloaded', 'installing'].includes(state.status)) return Promise.resolve(getState())
    if (downloading) return downloading
    if (!state.latestVersion) return check()
    change({ status: 'downloading', error: '', percent: 0 })
    downloading = Promise.resolve().then(() => updater.downloadUpdate())
      .catch(fail).finally(() => { downloading = null })
      .then(getState)
    return downloading
  }

  function check() {
    if (!supported || ['downloading', 'downloaded', 'installing'].includes(state.status)) return Promise.resolve(getState())
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
    updater.on('update-downloaded', (info) => change({ status: 'downloaded', latestVersion: info.version, percent: 100, error: '' }))
  }

  function start() {
    if (!supported || startupTimer || interval) return
    startupTimer = setTimeout(() => { startupTimer = null; void check() }, 10000)
    startupTimer.unref?.()
    interval = setInterval(() => { void check() }, 4 * 60 * 60 * 1000)
    interval.unref?.()
  }
  function dispose() { clearTimeout(startupTimer); clearInterval(interval) }
  return { getState, check, download, install, start, dispose }
}

function registerDesktopUpdateIpc(ipcMain, controller, getWindow) {
  for (const action of ['getState', 'check', 'download', 'install']) {
    ipcMain.handle(`desktop-update-${action}`, (event) => {
      const window = getWindow()
      if (!window || window.isDestroyed() || event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame) throw new Error('无权操作桌面更新')
      return controller[action]()
    })
  }
}

module.exports = { createDesktopUpdater, registerDesktopUpdateIpc }
