import {message as antMessage} from 'ant-design-vue'

const MESSAGE_TYPES = ['success', 'error', 'warning', 'info', 'loading']

let installed = false

function readMessageOptions(content, duration, onClose) {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return {...content}
  }
  return {content, duration, onClose}
}

function stringifyMessageContent(content) {
  if (typeof content === 'string' || typeof content === 'number') return String(content)
  if (content == null) return ''
  if (typeof content?.content === 'string' || typeof content?.content === 'number') return String(content.content)
  return String(content)
}

function currentTheme() {
  return document.querySelector('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'gray'
}

function sendDesktopMessage(type, content, duration, onClose) {
  const desktopMessage = window.electronAPI?.desktopMessage
  if (!desktopMessage?.show) return null

  const options = readMessageOptions(content, duration, onClose)
  const value = stringifyMessageContent(options.content)
  if (!value) return null

  desktopMessage.show({
    type,
    content: value,
    duration: options.duration,
    theme: currentTheme()
  })
  return () => desktopMessage.clear?.()
}

/**
 * Desktop shell and native chat tabs render in different WebContentsViews.
 * Route their Ant Design message calls to the one main-window overlay so a
 * message never gets trapped below the active native chat view.
 */
export function installDesktopMessageBridge() {
  if (installed || !window.electronAPI?.desktopMessage?.show) return false
  installed = true

  for (const type of MESSAGE_TYPES) {
    const original = antMessage[type]
    antMessage[type] = (content, duration, onClose) => {
      const result = sendDesktopMessage(type, content, duration, onClose)
      return result || original?.(content, duration, onClose)
    }
  }

  antMessage.warn = (...args) => antMessage.warning(...args)

  const originalOpen = antMessage.open
  antMessage.open = (options = {}) => {
    const type = MESSAGE_TYPES.includes(options.type) ? options.type : 'info'
    const result = sendDesktopMessage(type, options.content, options.duration, options.onClose)
    return result || originalOpen?.(options)
  }

  const originalDestroy = antMessage.destroy
  antMessage.destroy = (key) => {
    if (window.electronAPI?.desktopMessage?.clear) {
      window.electronAPI.desktopMessage.clear(key)
      return
    }
    originalDestroy?.(key)
  }

  return true
}
