const { WebContentsView, shell } = require('electron')

/**
 * 管理挂在主窗口 contentView 上的原生浮层。
 *
 * 业务浮层只需要提供一个唯一 key、桌面路由查询参数和可选的上下文事件；
 * 视图创建、加载重试、尺寸同步、层级、焦点和销毁都由这里统一处理。
 */
class DesktopNativeOverlayManager {
  constructor({
    getParentWindow,
    preloadPath,
    rendererPath,
    isDev = false,
    devRendererOrigins = [],
    loadAttempts = 2,
    retryDelayMs = 200,
    loadTimeoutMs = 10000,
    webPreferences = {}
  }) {
    this.getParentWindow = getParentWindow
    this.preloadPath = preloadPath
    this.rendererPath = rendererPath
    this.isDev = isDev
    this.devRendererOrigins = devRendererOrigins
    this.loadAttempts = Math.max(1, Number(loadAttempts) || 1)
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0)
    this.loadTimeoutMs = Math.max(1000, Number(loadTimeoutMs) || 10000)
    this.webPreferences = webPreferences
    this.entries = new Map()
    this.topKey = ''
  }

  get parentWindow() {
    const window = this.getParentWindow?.()
    return window && !window.isDestroyed() ? window : null
  }

  get(key) {
    return this.entries.get(String(key || '')) || null
  }

  isVisible(key) {
    return Boolean(this.get(key)?.visible)
  }

  getTopVisible() {
    const preferred = this.get(this.topKey)
    if (preferred?.visible) return preferred
    return [...this.entries.values()].reverse().find((entry) => entry.visible) || null
  }

  normalizeBounds() {
    const parent = this.parentWindow
    if (!parent) return null
    const contentBounds = parent.getContentBounds()
    return {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(contentBounds.width)),
      height: Math.max(1, Math.round(contentBounds.height))
    }
  }

  syncBounds(key) {
    const entry = key ? this.get(key) : null
    if (!entry) return false
    const bounds = this.normalizeBounds()
    if (!bounds || entry.view.webContents.isDestroyed()) return false
    entry.view.setBounds(bounds)
    return true
  }

  syncAll() {
    for (const key of this.entries.keys()) this.syncBounds(key)
  }

  bringToFront(entry) {
    const parent = this.parentWindow
    if (!parent || !entry || entry.view.webContents.isDestroyed()) return false
    try {
      // 原生视图按 contentView 子节点顺序合成，末尾子节点位于最上层。
      try { parent.contentView.removeChildView(entry.view) } catch { /* 已经不在树中 */ }
      parent.contentView.addChildView(entry.view)
      this.syncBounds(entry.key)
      return true
    } catch (error) {
      console.warn(`[desktop-overlay:${entry.key}] failed to bring overlay to front:`, error)
      return false
    }
  }

  async open(key, {
    query = {},
    backgroundColor = '#00000000',
    contextChannel = '',
    context = undefined,
    webPreferences = {},
    show = true
  } = {}) {
    const overlayKey = String(key || '').trim()
    if (!overlayKey || !this.parentWindow) return null

    let entry = this.get(overlayKey)
    if (!entry || entry.view.webContents.isDestroyed()) {
      entry = this.createEntry(overlayKey, query, backgroundColor, webPreferences)
    }

    try {
      await entry.ready
    } catch (error) {
      if (this.get(overlayKey) === entry) this.destroy(overlayKey)
      throw error
    }
    if (this.get(overlayKey) !== entry || entry.view.webContents.isDestroyed()) return null

    if (!show) {
      entry.visible = false
      if (this.topKey === overlayKey) this.topKey = ''
      if (!entry.view.webContents.isDestroyed()) entry.view.setVisible(false)
    }
    // 先把视图放到正确的原生层级并发送上下文，再决定是否显示。
    // 某些浮层（例如探索菜单）需要等待渲染进程确认上下文已绘制，
    // 因此不能在上下文到达前先暴露一个默认的左上角首帧。
    this.bringToFront(entry)
    if (contextChannel && !entry.view.webContents.isDestroyed()) {
      entry.view.webContents.send(contextChannel, context)
    }
    if (show) this.show(overlayKey)
    return entry
  }

  show(key) {
    const entry = this.get(key)
    if (!entry || entry.view.webContents.isDestroyed()) return false
    this.bringToFront(entry)
    entry.visible = true
    this.topKey = entry.key
    entry.view.setVisible(true)
    this.syncBounds(entry.key)
    entry.view.webContents.focus()
    return true
  }

  createEntry(key, query, backgroundColor, webPreferences) {
    const parent = this.parentWindow
    if (!parent) throw new Error('Parent window is not available')

    const view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        ...this.webPreferences,
        ...webPreferences
      }
    })
    view.setBackgroundColor(backgroundColor)
    view.setVisible(false)

    const entry = { key, view, visible: false, ready: null }
    this.entries.set(key, entry)
    view.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
    view.webContents.on('destroyed', () => {
      if (this.get(key) === entry) this.entries.delete(key)
    })

    parent.contentView.addChildView(view)
    entry.ready = this.load(view, query)
    return entry
  }

  async load(view, query) {
    const queryParams = Object.fromEntries(
      Object.entries(query || {}).map(([key, value]) => [key, String(value ?? '')])
    )
    const queryString = new URLSearchParams(queryParams).toString()
    const targets = this.isDev
      ? this.devRendererOrigins.map((origin) => `${origin}/?${queryString}`)
      : [this.rendererPath]
    if (!targets.length) throw new Error('No desktop overlay renderer target is configured')

    let lastError = null
    for (let attempt = 0; attempt < this.loadAttempts; attempt++) {
      const target = targets[Math.min(attempt, targets.length - 1)]
      try {
        if (this.isDev) {
          await this.waitForLoad(view, () => view.webContents.loadURL(target), target)
        } else {
          await this.waitForLoad(view, () => view.webContents.loadFile(target, { query: queryParams }), target)
        }
        return
      } catch (error) {
        lastError = error
        if (view.webContents.isDestroyed() || attempt === this.loadAttempts - 1) break
        const nextTarget = targets[Math.min(attempt + 1, targets.length - 1)]
        console.warn(`[desktop-overlay] load failed from ${target}, retrying with ${nextTarget}: ${error.message}`)
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
      }
    }
    throw lastError || new Error('Failed to load desktop overlay')
  }

  waitForLoad(view, load, target) {
    return new Promise((resolve, reject) => {
      let settled = false
      let failure = null
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const webContents = view.webContents
        if (webContents && !webContents.isDestroyed()) {
          webContents.removeListener('destroyed', onDestroyed)
          webContents.removeListener('did-fail-load', onFailedLoad)
        }
        callback(value)
      }
      const onDestroyed = () => finish(reject, new Error('Desktop overlay was destroyed while loading'))
      const onFailedLoad = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame) failure = { errorCode, errorDescription, url: validatedURL }
      }
      const timeout = setTimeout(() => {
        finish(reject, new Error(`Timed out loading desktop overlay: ${target}`))
      }, this.loadTimeoutMs)
      view.webContents.once('destroyed', onDestroyed)
      view.webContents.on('did-fail-load', onFailedLoad)
      Promise.resolve()
        .then(load)
        .then(() => finish(resolve))
        .catch((error) => {
          const detail = failure ? ` (${failure.errorCode} ${failure.errorDescription}: ${failure.url})` : ''
          finish(reject, new Error(`${error.message || 'Failed to load desktop overlay'}${detail}`))
        })
    })
  }

  hide(key) {
    const entry = this.get(key)
    if (!entry) return false
    entry.visible = false
    if (this.topKey === entry.key) this.topKey = ''
    if (!entry.view.webContents.isDestroyed()) entry.view.setVisible(false)
    return true
  }

  destroy(key) {
    const overlayKey = String(key || '').trim()
    const entry = this.get(overlayKey)
    if (!entry) return false
    this.entries.delete(overlayKey)
    if (this.topKey === overlayKey) this.topKey = ''
    entry.visible = false
    const parent = this.parentWindow
    if (parent) {
      try { parent.contentView.removeChildView(entry.view) } catch { /* window may already be closing */ }
    }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    return true
  }

  destroyAll() {
    for (const key of [...this.entries.keys()]) this.destroy(key)
  }
}

module.exports = { DesktopNativeOverlayManager }
