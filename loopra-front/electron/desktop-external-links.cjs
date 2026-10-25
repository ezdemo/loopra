/** All desktop surfaces share the system browser for external web links. */
function registerDesktopExternalLinks({ app, shell, isAppUrl, onError = console.error }) {
  const openInBrowser = (url) => {
    try {
      Promise.resolve(shell.openExternal(url)).catch(error => onError('Failed to open external URL:', error))
    } catch (error) { onError('Failed to open external URL:', error) }
  }
  const isWebUrl = (url) => {
    try { return ['http:', 'https:'].includes(new URL(url).protocol) } catch { return false }
  }
  app.on('web-contents-created', (_event, webContents) => {
    webContents.setWindowOpenHandler(({ url }) => {
      if (isAppUrl(url)) return { action: 'allow' }
      if (isWebUrl(url)) openInBrowser(url)
      return { action: 'deny' }
    })
    const onNavigate = (event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame === false || !isAppUrl(webContents.getURL()) || isAppUrl(url) || !isWebUrl(url)) return
      event.preventDefault()
      openInBrowser(url)
    }
    webContents.on('will-navigate', onNavigate)
    webContents.on('will-redirect', onNavigate)
  })
}

module.exports = { registerDesktopExternalLinks }
