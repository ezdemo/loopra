function createDesktopTheme(nativeTheme) {
  let source = null
  function apply(next) {
    if (nativeTheme.themeSource !== next) nativeTheme.themeSource = next
  }
  return {
    setSource(next) {
      if (!['dark', 'light', 'system'].includes(next)) throw new Error('Invalid desktop theme')
      source = next
      apply(source)
    },
    applyMenuTheme(rawTheme) {
      // A menu's resolved color must not replace the app's "follow system" mode.
      apply(source ?? (rawTheme === 'dark' ? 'dark' : 'light'))
    }
  }
}

function registerDesktopThemeIpc({ ipcMain, getMainWindow, theme }) {
  ipcMain.handle('desktop-theme-set', (event, source) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents) {
      throw new Error('Unauthorized desktop theme request')
    }
    theme.setSource(source)
    return { success: true }
  })
}

module.exports = { createDesktopTheme, registerDesktopThemeIpc }
