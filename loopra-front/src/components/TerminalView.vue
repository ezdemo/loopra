<template>
  <section class="terminal-panel" :class="{ open, vertical }" :style="panelStyle">
    <div
      class="terminal-resize-handle"
      :class="{ dragging, 'is-vertical': vertical }"
      :title="vertical ? '拖动调整终端宽度' : '拖动调整终端高度'"
      aria-hidden="true"
      @mousedown.prevent="startResize"
    />
    <header class="terminal-panel-header">
      <div class="terminal-tabs">
        <button
          v-for="tab in terminals"
          :key="tab.id"
          class="terminal-tab"
          :class="{ active: tab.id === activeId }"
          type="button"
          :title="tab.title"
          @click="activateTerminal(tab.id)"
        >
          <span class="terminal-tab-title">{{ tab.title }}</span>
          <span class="terminal-tab-close" role="button" title="关闭此终端" aria-label="关闭此终端" @click.stop="closeTerminal(tab.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </span>
        </button>
        <div class="terminal-add">
          <button ref="addBtnEl" class="terminal-tab-add" type="button" title="新建终端" aria-label="新建终端" @click.stop="openShellMenu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <Teleport to="body">
            <div
              v-if="shellMenuOpen"
              ref="shellMenuEl"
              class="terminal-shell-menu"
              :style="shellMenuStyle"
              role="menu"
              aria-label="选择终端 Shell"
              @click.stop
            >
              <button
                v-for="s in availableShells"
                :key="s.id"
                type="button"
                class="terminal-shell-menu-item"
                role="menuitem"
                @click="pickShell(s.id)"
              >
                {{ s.name }}
              </button>
            </div>
          </Teleport>
        </div>
      </div>
      <span v-if="activePid" class="terminal-panel-pid">PID {{ activePid }}</span>
      <button
        type="button"
        class="terminal-panel-close"
        title="收起终端面板"
        aria-label="收起终端面板"
        @click="$emit('close')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
    </header>
    <div v-if="unsupported" class="terminal-panel-unsupported">终端仅在桌面端可用</div>
    <div v-else class="terminal-panel-body" :class="terminalThemeClass">
      <div v-if="terminals.length === 0" class="terminal-empty">暂无终端，点击「+」新建</div>
      <div
        v-for="tab in terminals"
        :key="tab.id"
        class="terminal-slot"
        :class="{ active: tab.id === activeId }"
        :ref="(el) => setSlotEl(tab.id, el)"
      />
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../stores/app'

const props = defineProps({
  // 终端初始工作目录（当前项目路径）；留空则使用主进程默认（用户主目录）
  cwd: { type: String, default: '' },
  // 面板展开状态：首次展开时创建首个终端，收起仅隐藏（所有终端持久保留）
  open: { type: Boolean, default: false },
  // 当前主题（dark / gray）；由宿主页面传入，保证与页面实际主题一致
  theme: { type: String, default: '' },
  // 垂直模式（右侧独立面板）：按宽度展开/收起，拖拽手柄在左侧调宽度；默认水平模式（底部面板）
  vertical: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])

const store = useAppStore()
const unsupported = ref(false)
const codeFontSize = computed(() => Number(store.settings.codeFontSize) || 12)
// 可用 shell 列表（主进程按系统检测）与「+」菜单开关；新建时默认用列表第一项
const availableShells = ref([])
const shellMenuOpen = ref(false)
// 「+」按钮、菜单元素与基于视口的定位
const addBtnEl = ref(null)
const shellMenuEl = ref(null)
const shellMenuPos = ref({ left: 0, top: 0 })
const shellMenuStyle = computed(() => ({
  left: `${shellMenuPos.value.left}px`,
  top: `${shellMenuPos.value.top}px`
}))
const MENU_VIEWPORT_GAP = 8
const MENU_ANCHOR_GAP = 4
// 标签列表（响应式，用于渲染标签栏与 PID）；xterm/PTY 实例放在 tabState 避免被 Vue 代理
const terminals = ref([])
const activeId = ref('')
const tabState = new Map()
const slotEls = new Map()
let nextTerminalNo = 1
let dataUnsubscribe = null
let exitUnsubscribe = null
let resizeObserver = null
let themeObserver = null

// xterm 主题：跟随应用主题（dark / gray）
// 注意：xterm 6 的 _setTheme 只读取命名键（black/red/.../brightWhite），不读 ansi 数组
const THEMES = {
  dark: {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#aeafad',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5'
  },
  gray: {
    background: '#ffffff',
    foreground: '#333333',
    cursor: '#333333',
    selectionBackground: '#add6ff',
    // VS Code Light+ 风格：黄色系加深（yellow/brightYellow），避免白色背景上看不清
    black: '#000000',
    red: '#cd3131',
    green: '#00bc00',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5'
  }
}

// 主题源：页面 DOM data-theme 为权威（实际渲染主题），未设置时兑底 props → store
function readTheme() {
  const domTheme = document.documentElement.getAttribute('data-theme')
  if (domTheme === 'dark' || domTheme === 'gray') return domTheme
  return props.theme || store.settings.theme
}

const activeTheme = ref(readTheme())
const currentTheme = () => THEMES[activeTheme.value] || THEMES.gray

// xterm 容器背景跟随主题，保证留白区域与终端底色无缝衔接
const terminalThemeClass = computed(() => (activeTheme.value === 'dark' ? 'theme-dark' : 'theme-gray'))

// 同步主题到所有终端：options 赋值（xterm 6 已移除 setOption）+ 强制重绘
function syncTheme() {
  activeTheme.value = readTheme()
  const theme = currentTheme()
  for (const state of tabState.values()) {
    if (!state.term) continue
    try {
      state.term.options = { theme }
      state.term.refresh(0, state.term.rows - 1)
    } catch (error) {
      console.warn('[terminal] 主题同步失败:', error)
    }
  }
}

const activePid = computed(() => {
  const tab = terminals.value.find((item) => item.id === activeId.value)
  return tab?.pid || ''
})

// ── 面板尺寸：可拖拽调整（水平=高度 / 垂直=宽度），持久化到 localStorage ──
const isVertical = () => props.vertical
const SAVE_KEY = isVertical() ? 'loopra-terminal-width' : 'loopra-terminal-height'
const DEFAULT_SIZE = isVertical() ? 650 : 187
const MIN_SIZE = isVertical() ? 120 : 80
const MAX_SIZE_RATIO = 0.7
const savedSize = Number(localStorage.getItem(SAVE_KEY))
const panelSize = ref(Number.isFinite(savedSize) && savedSize >= MIN_SIZE ? savedSize : DEFAULT_SIZE)
const dragging = ref(false)

// 展开时用自定义尺寸；拖拽过程中禁用过渡动画，避免拖拽时跳动
const panelStyle = computed(() => {
  if (!props.open) return null
  return isVertical()
    ? {
      width: `${panelSize.value}px`,
      ...(dragging.value ? { transition: 'none' } : {})
    }
    : {
      height: `${panelSize.value}px`,
      ...(dragging.value ? { transition: 'none' } : {})
    }
})

function startResize(event) {
  const startPos = isVertical() ? event.clientX : event.clientY
  const startSize = panelSize.value
  dragging.value = true
  const onMove = (ev) => {
    const pos = isVertical() ? ev.clientX : ev.clientY
    const maxSize = Math.floor((isVertical() ? window.innerWidth : window.innerHeight) * MAX_SIZE_RATIO)
    // 手柄在面板左侧/顶部：向左/上拖动（startPos - pos > 0）增大尺寸
    const next = Math.min(Math.max(startSize + (startPos - pos), MIN_SIZE), maxSize)
    panelSize.value = Math.round(next)
  }
  const onUp = () => {
    dragging.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    try {
      localStorage.setItem(SAVE_KEY, String(panelSize.value))
    } catch (error) {
      // 存储不可用时忽略
    }
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const findTab = (id) => terminals.value.find((item) => item.id === id)

const findTabByPtyId = (ptyId) => {
  for (const [id, state] of tabState) {
    if (state.ptyId === ptyId) return id
  }
  return ''
}

function setSlotEl(tabId, el) {
  if (el) slotEls.set(tabId, el)
  else slotEls.delete(tabId)
}

// 同步单个终端尺寸到主进程 PTY
function fitTab(tabId) {
  const tab = findTab(tabId)
  const state = tabState.get(tabId)
  if (!tab || !state || !state.term || !state.ptyId) return
  const hostEl = slotEls.get(tabId)
  // 收起/隐藏状态（高度或宽度任一不足）不调整：避免 xterm 被 resize 到极小导致 buffer 重排、滚动位置错乱
  // 水平模式收起时高度为 0，垂直模式收起时宽度为 0，两个方向都要拦截
  if (!hostEl || hostEl.clientHeight < 40 || hostEl.clientWidth < 40) return
  try {
    // fit 前记录视口位置，resize 后恢复，保证收起再展开时内容位置不变
    const buffer = state.term.buffer.active
    const prevViewportY = buffer.viewportY
    state.fitAddon.fit()
    window.electronAPI.terminal.resize({ id: state.ptyId, cols: state.term.cols, rows: state.term.rows })
    if (prevViewportY > 0 && buffer.viewportY !== prevViewportY) {
      state.term.scrollToLine(Math.min(prevViewportY, buffer.length - state.term.rows))
    }
  } catch (error) {
    // 容器不可见时 fit 可能失败，等待 ResizeObserver 下次触发
  }
}

// 只对当前激活的终端做尺寸同步（其余标签处于隐藏状态）
// 防抖：面板展开/收起动画期间多次触发，合并为动画结束后的最后一次 fit
let fitTimer = null
function fitActive() {
  clearTimeout(fitTimer)
  fitTimer = setTimeout(() => {
    if (activeId.value) fitTab(activeId.value)
  }, 120)
}

// 加载可用 shell 列表（面板首次展开或点击「+」时可能早于 onMounted 完成，这里兜底）
async function ensureShells() {
  if (availableShells.value.length > 0) return
  const terminalAPI = window.electronAPI?.terminal
  if (!terminalAPI) return
  try {
    const shells = await terminalAPI.listShells()
    availableShells.value = Array.isArray(shells) ? shells : []
  } catch (error) {
    console.warn('[terminal] 加载 shell 列表失败:', error)
  }
}

function positionShellMenu() {
  const buttonRect = addBtnEl.value?.getBoundingClientRect()
  const menuRect = shellMenuEl.value?.getBoundingClientRect()
  if (!buttonRect || !menuRect) return

  const maxLeft = Math.max(MENU_VIEWPORT_GAP, window.innerWidth - menuRect.width - MENU_VIEWPORT_GAP)
  const left = Math.min(Math.max(buttonRect.right - menuRect.width, MENU_VIEWPORT_GAP), maxLeft)
  const belowTop = buttonRect.bottom + MENU_ANCHOR_GAP
  const aboveTop = buttonRect.top - menuRect.height - MENU_ANCHOR_GAP
  const top = belowTop + menuRect.height <= window.innerHeight - MENU_VIEWPORT_GAP
    ? belowTop
    : Math.max(MENU_VIEWPORT_GAP, aboveTop)

  shellMenuPos.value = { left, top }
}

function onViewportResize() {
  if (shellMenuOpen.value) positionShellMenu()
}

// 点击「+」：菜单已打开则收起；多个 shell 时弹出选择菜单，仅一个时直接创建
async function openShellMenu() {
  const terminalAPI = window.electronAPI?.terminal
  if (!terminalAPI || unsupported.value) return
  if (shellMenuOpen.value) {
    shellMenuOpen.value = false
    return
  }
  await ensureShells()
  if (availableShells.value.length <= 1) {
    void addTerminal(availableShells.value[0]?.id || '')
    return
  }
  shellMenuOpen.value = true
  await nextTick()
  positionShellMenu()
}

// 菜单中选定 shell 后创建终端并关闭菜单
function pickShell(shellId) {
  shellMenuOpen.value = false
  void addTerminal(shellId)
}

// 新建一个终端标签：创建 xterm + PTY（工作目录 = 当前项目路径，shell 由调用方指定）
async function addTerminal(shellId = '') {
  const terminalAPI = window.electronAPI?.terminal
  if (!terminalAPI || unsupported.value) return

  await ensureShells()
  const shell = shellId || availableShells.value[0]?.id || ''
  const tab = {
    id: `term-${Date.now()}-${nextTerminalNo}`,
    title: `终端 ${nextTerminalNo}`,
    pid: '',
    shell
  }
  nextTerminalNo++
  terminals.value.push(tab)
  activeId.value = tab.id
  await nextTick()

  const hostEl = slotEls.get(tab.id)
  const term = new Terminal({
    cursorBlink: true,
    fontSize: codeFontSize.value,
    fontFamily: "'JetBrains Mono Variable', Consolas, Menlo, 'Courier New', monospace",
    theme: currentTheme(),
    scrollback: 5000
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(hostEl)
  const state = { term, fitAddon, ptyId: '' }
  tabState.set(tab.id, state)

  // 键盘输入 → PTY
  term.onData((data) => terminalAPI.input({ id: state.ptyId, data }))

  try {
    const created = await terminalAPI.create({
      cols: term.cols,
      rows: term.rows,
      cwd: props.cwd,
      shell: tab.shell
    })
    state.ptyId = created.id
    tab.pid = String(created.pid)
    fitTab(tab.id)
  } catch (error) {
    console.warn('[terminal] 创建 PTY 失败:', error)
  }
}

// 设置页修改代码字号后，已打开的终端也立即跟随更新。
watch(codeFontSize, (size) => {
  for (const state of tabState.values()) {
    if (!state.term) continue
    state.term.options.fontSize = size
    state.fitAddon?.fit()
  }
})

function activateTerminal(id) {
  if (activeId.value === id) return
  activeId.value = id
  // 等 slot 显示后再 fit，确保尺寸正确
  void nextTick(() => fitTab(id))
}

async function closeTerminal(id) {
  const index = terminals.value.findIndex((item) => item.id === id)
  if (index < 0) return
  const state = tabState.get(id)
  if (state?.ptyId && window.electronAPI?.terminal) {
    window.electronAPI.terminal.kill(state.ptyId).catch(() => {})
  }
  state?.term?.dispose()
  tabState.delete(id)
  slotEls.delete(id)
  terminals.value.splice(index, 1)
  // 关闭的是激活标签时，激活相邻标签
  if (activeId.value === id) {
    const next = terminals.value[Math.min(index, terminals.value.length - 1)]
    activeId.value = next ? next.id : ''
  }
}

onMounted(() => {
  const terminalAPI = window.electronAPI?.terminal
  if (!terminalAPI) {
    unsupported.value = true
    return
  }

  // 加载系统可用 shell 列表（cmd / powershell / pwsh），供「+」菜单选择
  ensureShells()

  // 点击终端面板外部时关闭 shell 选择菜单；视口变化时保持菜单贴合按钮
  document.addEventListener('click', onDocClick)
  window.addEventListener('resize', onViewportResize)

  // PTY 输出 → 对应标签的 xterm
  dataUnsubscribe = terminalAPI.onData(({ id, data }) => {
    const tabId = findTabByPtyId(id)
    if (tabId) tabState.get(tabId).term.write(data)
  })

  // PTY 退出提示
  exitUnsubscribe = terminalAPI.onExit(({ id, exitCode }) => {
    const tabId = findTabByPtyId(id)
    if (tabId) {
      tabState.get(tabId).term.write(`\r\n\x1b[90m[进程已退出，代码 ${exitCode}]\x1b[0m\r\n`)
    }
  })

  resizeObserver = new ResizeObserver(fitActive)
  resizeObserver.observe(document.querySelector('.terminal-panel-body') || document.body)

  // DOM data-theme 变化兜底：宿主 props 链路失效时仍能同步主题
  themeObserver = new MutationObserver(syncTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  syncTheme()
})

// 面板首次展开时自动创建首个终端（此时项目已加载，cwd 有效）；收起/再展开不销毁
watch(
  () => props.open,
  (open) => {
    if (!open) {
      shellMenuOpen.value = false
      return
    }
    if (terminals.value.length === 0) void addTerminal()
  },
  { immediate: true }
)

onUnmounted(() => {
  clearTimeout(fitTimer)
  fitTimer = null
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('resize', onViewportResize)
  resizeObserver?.disconnect()
  resizeObserver = null
  themeObserver?.disconnect()
  themeObserver = null
  // 关闭所有终端（标签会话销毁时清空 PTY）
  for (const state of tabState.values()) {
    if (state.ptyId && window.electronAPI?.terminal) {
      window.electronAPI.terminal.kill(state.ptyId).catch(() => {})
    }
    state.term?.dispose()
  }
  tabState.clear()
  terminals.value = []
  dataUnsubscribe?.()
  exitUnsubscribe?.()
})

// 主题切换时同步所有 xterm 配色（props / store / DOM 三源都会触发）
watch(() => props.theme, syncTheme)
watch(() => store.settings.theme, syncTheme)

// 点击面板外部时关闭 shell 选择菜单（菜单内点击已由 @click.stop 拦截）
function onDocClick() {
  shellMenuOpen.value = false
}
</script>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  height: 0;
  overflow: hidden;
  background: var(--bg, #fff);
  border-top: 1px solid var(--border, #e8e8e8);
  transition: height 0.22s ease;
}
.terminal-panel.open {
  height: 187px;
}
/* 垂直模式（右侧独立面板）：按宽度展开/收起，高度撑满父容器 */
.terminal-panel.vertical {
  position: relative;
  flex: 0 0 auto;
  width: 0;
  height: 100%;
  border-top: none;
  border-left: 1px solid var(--border, #e8e8e8);
  transition: width 0.22s ease;
}
.terminal-panel.vertical.open {
  width: 650px;
}
/* 垂直模式拖拽手柄：面板左边缘竖条，左右拖动调整宽度 */
.terminal-resize-handle.is-vertical {
  position: absolute;
  left: -4px;
  top: 0;
  bottom: 0;
  width: 8px;
  height: auto;
  flex: none;
  cursor: ew-resize;
  z-index: 2;
}
.terminal-resize-handle.is-vertical:hover,
.terminal-resize-handle.is-vertical.dragging {
  background: rgba(82, 82, 91, 0.25);
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}
/* 拖拽手柄：面板顶部细条，上下拖动调整高度（纤细 + 主题自适应） */
.terminal-resize-handle {
  height: 3.5px;
  flex: 0 0 auto;
  cursor: ns-resize;
  background: transparent;
}
.terminal-resize-handle:hover,
.terminal-resize-handle.dragging {
  background: rgba(82, 82, 91, 0.25);
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}
.terminal-panel-header {
  height: 34px;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 8px;
  border-bottom: 1px solid var(--border, #e8e8e8);
  user-select: none;
}
.terminal-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.terminal-tabs::-webkit-scrollbar {
  display: none;
}
.terminal-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 6px 0 10px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-2, #5f6368);
  font-size: 12px;
  cursor: pointer;
}
.terminal-tab:hover {
  background: var(--bg-3, #f3f4f6);
  color: var(--fg, #202124);
}
.terminal-tab.active {
  background: var(--bg-3, #f1f2f4);
  color: var(--fg, #202124);
  font-weight: 500;
}
.terminal-tab-title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 120px;
}
.terminal-tab-close {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  color: var(--fg-3, #9aa0a6);
}
.terminal-tab-close:hover {
  background: rgba(0, 0, 0, 0.08);
  color: var(--fg, #202124);
}
.terminal-tab-close svg {
  width: 10px;
  height: 10px;
}
.terminal-tab-add {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-2, #5f6368);
  cursor: pointer;
}
.terminal-tab-add:hover {
  background: var(--bg-3, #f3f4f6);
  color: var(--fg, #202124);
}
.terminal-tab-add svg {
  width: 13px;
  height: 13px;
}
/* 「+」按钮容器：与标签同一行，紧贴标签右侧；菜单传送到 body 避免被面板裁剪 */
.terminal-add {
  flex: 0 0 auto;
}
.terminal-shell-menu {
  position: fixed;
  z-index: 40;
  box-sizing: border-box;
  min-width: 150px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border, #e8e8e8);
  border-radius: 8px;
  background: var(--bg, #fff);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.terminal-shell-menu-item {
  display: block;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg, #202124);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.terminal-shell-menu-item:hover {
  background: var(--bg-3, #f3f4f6);
}
.terminal-panel-pid {
  font-size: 11px;
  color: var(--fg-4, #9ca3af);
  flex: 0 0 auto;
}
.terminal-panel-close {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-2, #5f6368);
  cursor: pointer;
}
.terminal-panel-close:hover {
  background: var(--bg-3, #f3f4f6);
  color: var(--fg, #202124);
}
.terminal-panel-close svg {
  width: 14px;
  height: 14px;
}
.terminal-panel-body {
  flex: 1;
  min-height: 0;
  background: #1e1e1e;
  position: relative;
}
.terminal-panel-body.theme-gray {
  background: #ffffff;
}
/* 每个终端标签独立容器：仅激活的显示 */
.terminal-slot {
  display: none;
  position: absolute;
  inset: 0;
}
.terminal-slot.active {
  display: block;
}
/* 留白：padding 加在 .xterm 上，FitAddon 会自动扣除（行列数精确）
   .xterm-viewport 绝对定位铺满整个 .xterm（含 padding 区），默认背景 #000，
   必须显式跟随主题，否则留白区域会显示黑色 */
.terminal-panel-body :deep(.xterm) {
  padding: 8px 12px;
  background: #1e1e1e;
}
.terminal-panel-body :deep(.xterm .xterm-viewport) {
  background-color: #1e1e1e;
}
.terminal-panel-body.theme-gray :deep(.xterm) {
  background: #ffffff;
}
.terminal-panel-body.theme-gray :deep(.xterm .xterm-viewport) {
  background-color: #ffffff;
}
.terminal-empty {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--fg-4, #9ca3af);
  font-size: 13px;
}
.terminal-panel-unsupported {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--fg-4, #9ca3af);
  font-size: 13px;
}
</style>
