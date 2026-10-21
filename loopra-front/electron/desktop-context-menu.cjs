function desktopContextMenuTemplate(params, webContents, clipboard) {
  const flags = params.editFlags || {}
  const groups = []
  const edit = (role, label, flag) => ({ role, label, enabled: Boolean(flags[flag]) })
  if (params.isEditable) {
    groups.push([
      edit('undo', '撤销', 'canUndo'),
      edit('redo', '重做', 'canRedo')
    ])
    const editing = []
    if (params.formControlType !== 'input-password') {
      editing.push(edit('cut', '剪切', 'canCut'), edit('copy', '复制', 'canCopy'))
    }
    editing.push(edit('paste', '粘贴', 'canPaste'))
    if (flags.canEditRichly) editing.push(edit('pasteAndMatchStyle', '粘贴为纯文本', 'canPaste'))
    groups.push(editing, [edit('selectAll', '全选', 'canSelectAll')])
  } else if (params.selectionText?.length && flags.canCopy) {
    groups.push([edit('copy', '复制', 'canCopy')])
  }
  if (/^https?:\/\//i.test(params.linkURL || '')) {
    groups.push([{ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) }])
  }
  if (params.mediaType === 'image' && params.hasImageContents) {
    groups.push([{ label: '复制图片', click: () => {
      if (!webContents.isDestroyed()) webContents.copyImageAt(params.x, params.y)
    } }])
  }
  return groups.flatMap((group, index) => index ? [{ type: 'separator' }, ...group] : group)
}

function registerDesktopContextMenus({ app, BrowserWindow, Menu, clipboard, beforePopup }) {
  app.on('web-contents-created', (_event, webContents) => {
    if (!['window', 'browserView', 'webview'].includes(webContents.getType())) return
    webContents.on('context-menu', (event, params) => {
      if (event.defaultPrevented || webContents.isDestroyed()) return
      const template = desktopContextMenuTemplate(params, webContents, clipboard)
      if (!template.length) return
      beforePopup?.()
      // Keep edit roles on the clicked view, including embedded chat tabs.
      webContents.focus()
      const window = BrowserWindow.fromWebContents(webContents)
      Menu.buildFromTemplate(template).popup({
        ...(window ? { window } : {}),
        ...(params.frame ? { frame: params.frame } : {})
      })
    })
  })
}

module.exports = { desktopContextMenuTemplate, registerDesktopContextMenus }
