/**
 * 中文字体切换（仅桌面端，设置 → 外观 → 中文字体）。
 * 英文/数字统一使用 JetBrains Mono Variable，font 为选中的系统字体名；
 * 'system' 或空表示不指定中文字体（跟随系统，如微软雅黑/苹方）。
 */
export const DEFAULT_FONT = 'system'
export const DEFAULT_UI_FONT_SIZE = 14
export const DEFAULT_CODE_FONT_SIZE = 12

const UI_FONT_SIZE_MIN = 11
const UI_FONT_SIZE_MAX = 18
const CODE_FONT_SIZE_MIN = 10
const CODE_FONT_SIZE_MAX = 16

const SANS_TAIL = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
const MONO_TAIL = "'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace"

/**
 * 根据字体名生成 --sans / --mono 完整值并应用到根元素内联样式
 * （内联样式优先级高于 main.css 的 :root 定义）。
 */
export const applyFontPreset = (font) => {
  let cn = ''
  if (typeof font === 'string' && font.trim() && font !== 'system') {
    // 系统字体名按字面量使用，去除引号防注入
    cn = `'${font.trim().replace(/'/g, '')}', `
  }
  document.documentElement.style.setProperty('--sans', `'JetBrains Mono Variable', ${cn}${SANS_TAIL}`)
  document.documentElement.style.setProperty('--mono', `'JetBrains Mono Variable', ${cn}${MONO_TAIL}`)
}

/**
 * Normalize and apply the two typography scales shared by Web and Electron.
 * UI text defaults to Codex's 14px rhythm; source/code output defaults to 12px.
 */
export const normalizeFontSize = (value, fallback, min = 10, max = 24) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

export const applyTypographyPreset = (
  uiFontSize = DEFAULT_UI_FONT_SIZE,
  codeFontSize = DEFAULT_CODE_FONT_SIZE
) => {
  const ui = normalizeFontSize(uiFontSize, DEFAULT_UI_FONT_SIZE, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX)
  const code = normalizeFontSize(codeFontSize, DEFAULT_CODE_FONT_SIZE, CODE_FONT_SIZE_MIN, CODE_FONT_SIZE_MAX)
  const uiLineHeight = Math.max(16, Math.round(ui * 1.428571))

  if (typeof document === 'undefined') return {uiFontSize: ui, codeFontSize: code}

  const root = document.documentElement
  root.style.setProperty('--font-ui-size', `${ui}px`)
  root.style.setProperty('--font-ui-line-height', `${uiLineHeight}px`)
  root.style.setProperty('--font-message-size', `${ui}px`)
  root.style.setProperty('--font-code-size', `${code}px`)
  return {uiFontSize: ui, codeFontSize: code}
}
