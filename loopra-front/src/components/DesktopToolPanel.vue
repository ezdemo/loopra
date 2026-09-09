<template>
  <aside
    ref="panelRef"
    class="desktop-tool-panel"
    :class="{ collapsed: !open }"
    :style="panelStyle"
    aria-label="会话侧边栏"
  >
    <div
      class="desktop-tool-resize"
      :class="{ dragging }"
      title="拖动调整侧边栏宽度"
      aria-hidden="true"
      @mousedown.prevent="startResize"
    />

    <section class="desktop-tool-content">
      <header class="desktop-tool-head">
        <div class="desktop-tool-tabbar">
          <nav ref="tabStripRef" class="desktop-tool-tabs" role="tablist" aria-label="侧边栏标签">
            <button
              v-for="tab in openTabs"
              :key="tab.id"
              type="button"
              class="desktop-tool-tab"
              :class="{ active: tab.id === activeTabId }"
              role="tab"
              :aria-selected="tab.id === activeTabId"
              :title="tab.title || tab.label"
              @click="activateTab(tab.id)"
              @auxclick="onTabAuxClick($event, tab.id)"
            >
              <span class="desktop-tool-tab-icon" aria-hidden="true">
                <span v-if="tab.kind === 'browser' && tab.loading" class="desktop-tool-tab-spinner"></span>
                <img
                  v-else-if="tab.kind === 'browser' && tab.favicon"
                  class="desktop-tool-tab-favicon"
                  :src="tab.favicon"
                  alt=""
                  @error="onBrowserFaviconError(tab.id)"
                />
                <span
                  v-else-if="tab.kind === 'browser'"
                  class="desktop-tool-tab-browser-avatar"
                  :style="{ background: browserSiteColor(tab.url) }"
                >{{ browserTabLetter(tab) }}</span>
                <i v-else :class="['codicon', tab.icon]" />
              </span>
              <span class="desktop-tool-tab-title">{{ tab.label }}</span>
              <span
                class="desktop-tool-tab-close"
                role="button"
                tabindex="0"
                :aria-label="`关闭${tab.label}`"
                :title="`关闭${tab.label}`"
                @click.stop="closeTab(tab.id)"
                @keydown.enter.stop="closeTab(tab.id)"
                @keydown.space.prevent.stop="closeTab(tab.id)"
              >
                <i class="codicon codicon-close" aria-hidden="true" />
              </span>
            </button>
          </nav>

          <div class="desktop-tool-add">
            <button
              ref="addButtonRef"
              type="button"
              class="desktop-tool-add-button"
              title="打开工具"
              aria-label="打开工具"
              aria-haspopup="menu"
              :aria-expanded="addMenuOpen || nativeToolMenuOpening"
              @click.stop="toggleAddMenu"
            >
              <i class="codicon codicon-add" aria-hidden="true" />
            </button>
            <div
              v-if="addMenuOpen"
              ref="addMenuRef"
              class="desktop-tool-add-menu"
              role="menu"
              aria-label="选择要打开的工具"
              @click.stop
            >
              <button
                v-for="tool in toolOptions"
                :key="tool.id"
                type="button"
                class="desktop-tool-add-item"
                role="menuitem"
                :class="{ opened: isToolOpen(tool.id), attention: tool.id === 'environment' && environmentAttention }"
                @click="selectTool(tool.id)"
                @animationend="tool.id === 'environment' && $emit('environmentAttentionEnd')"
              >
                <i :class="['codicon', tool.icon]" aria-hidden="true" />
                <span class="desktop-tool-add-item-label">{{ tool.label }}</span>
                <span v-if="isToolOpen(tool.id)" class="desktop-tool-add-item-state" aria-label="已打开">✓</span>
                <kbd v-else-if="tool.shortcut">{{ tool.shortcut }}</kbd>
              </button>
              <div class="desktop-tool-add-divider" role="separator" />
              <button
                type="button"
                class="desktop-tool-add-item desktop-tool-add-quick-item"
                role="menuitem"
                @click="openOnboarding"
              >
                <i class="codicon codicon-wand" aria-hidden="true" />
                <span class="desktop-tool-add-item-label">引导</span>
              </button>
            </div>
          </div>
        </div>

        <div class="desktop-tool-head-actions">
          <button
            v-if="activeToolId === 'files'"
            type="button"
            class="desktop-tool-head-button"
            title="刷新文件"
            @click="fileExplorerRef?.refresh?.()"
          >
            <i class="codicon codicon-refresh" aria-hidden="true" />
          </button>
          <button
            v-if="activeToolId === 'environment'"
            type="button"
            class="desktop-tool-head-button"
            title="刷新环境信息"
            @click="environmentPanelRef?.refresh?.()"
          >
            <i class="codicon codicon-refresh" aria-hidden="true" />
          </button>
          <button
            v-if="activeToolId === 'sub-agents'"
            type="button"
            class="desktop-tool-head-button"
            title="刷新子代理"
            @click="subAgentPanelRef?.refresh?.()"
          >
            <i class="codicon codicon-refresh" aria-hidden="true" />
          </button>
          <button
            v-if="activeToolId === 'project-capabilities'"
            type="button"
            class="desktop-tool-head-button"
            title="刷新项目能力"
            @click="projectCapabilitiesPanelRef?.load?.()"
          >
            <i class="codicon codicon-refresh" aria-hidden="true" />
          </button>
          <button
            v-if="activeToolId === 'schedule'"
            type="button"
            class="desktop-tool-head-button"
            title="刷新定时任务"
            @click="scheduleRef?.loadTasks?.()"
          >
            <i class="codicon codicon-refresh" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="desktop-tool-head-button"
            title="关闭侧边栏"
            aria-label="关闭侧边栏"
            @click="$emit('close')"
          >
            <i class="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div class="desktop-tool-body">
        <div v-if="openTabs.length === 0" class="desktop-tool-empty">
          <i class="codicon codicon-layout" aria-hidden="true" />
          <strong>没有打开的工具</strong>
          <span>点击上方「+」选择要打开的面板</span>
        </div>

        <FileExplorer
          v-if="visited.has('files')"
          v-show="activeToolId === 'files'"
          ref="fileExplorerRef"
          :root-path="workspacePath"
          :workspace-hash="workspaceHash"
          @add-to-session="$emit('addToSession', $event)"
          @open-file="$emit('openFile', $event)"
          @file-deleted="$emit('fileDeleted', $event)"
          @file-renamed="(oldPath, newPath) => $emit('fileRenamed', oldPath, newPath)"
        />
        <EnvironmentPanel
          v-if="visited.has('environment')"
          v-show="activeToolId === 'environment'"
          ref="environmentPanelRef"
          :workspace-hash="workspaceHash || ''"
          :session-name="sessionName"
          @mode-change="$emit('environmentModeChange', $event)"
          @close="$emit('close')"
        />
        <SubAgentPanel
          v-if="visited.has('sub-agents')"
          v-show="activeToolId === 'sub-agents'"
          ref="subAgentPanelRef"
          :workspace-hash="workspaceHash"
          :session-name="sessionName"
          @open="$emit('openSubAgent', $event)"
          @removed="$emit('subAgentRemoved', $event)"
        />
        <ProjectCapabilitiesPanel
          v-if="visited.has('project-capabilities')"
          v-show="activeToolId === 'project-capabilities'"
          ref="projectCapabilitiesPanelRef"
          :workspace-hash="workspaceHash"
          :workspace-name="workspaceName"
        />
        <SchedulePanel
          v-if="visited.has('schedule')"
          v-show="activeToolId === 'schedule'"
          ref="scheduleRef"
          :workspace-hash="workspaceHash"
          :session-name="sessionName"
          :sessions="sessions"
        />
        <TerminalView
          v-if="visited.has('terminal')"
          v-show="activeToolId === 'terminal'"
          :open="activeToolId === 'terminal'"
          :cwd="workspacePath"
          :theme="theme"
          vertical
          @close="closeTab('terminal')"
        />
        <BashSessionManager
          v-if="visited.has('bash')"
          v-show="activeToolId === 'bash'"
          embedded
        />
        <AIBrowser
          ref="browserRef"
          v-show="isBrowserSurfaceActive"
          :active="open && isBrowserSurfaceActive"
          :inspect-mode="activeToolId === 'review'"
          hide-tab-strip
          @state-change="syncBrowserState"
        />
      </div>
    </section>
  </aside>
</template>

<script setup>
import {computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import SchedulePanel from './SchedulePanel.vue'
import BashSessionManager from './BashSessionManager.vue'
import ProjectCapabilitiesPanel from './ProjectCapabilitiesPanel.vue'

const FileExplorer = defineAsyncComponent(() => import('./FileExplorer.vue'))
const EnvironmentPanel = defineAsyncComponent(() => import('./EnvironmentPanel.vue'))
const SubAgentPanel = defineAsyncComponent(() => import('./SubAgentPanel.vue'))
const AIBrowser = defineAsyncComponent(() => import('./AIBrowser.vue'))
const TerminalView = defineAsyncComponent(() => import('./TerminalView.vue'))

const props = defineProps({
  open: {type: Boolean, default: false},
  modelValue: {type: String, default: 'launcher'},
  workspaceHash: {type: String, default: null},
  workspacePath: {type: String, default: ''},
  workspaceName: {type: String, default: ''},
  sessionName: {type: String, default: ''},
  sessions: {type: Array, default: () => []},
  theme: {type: String, default: ''},
  environmentAttention: {type: Boolean, default: false}
})

const emit = defineEmits([
  'update:modelValue', 'close', 'addToSession', 'openFile', 'fileDeleted', 'fileRenamed',
  'environmentModeChange', 'openSubAgent', 'subAgentRemoved', 'openOnboarding',
  'environmentAttentionEnd'
])

const toolOptions = [
  {id: 'review', label: '审查', icon: 'codicon-inspect', shortcut: 'Ctrl+Shift+G'},
  {id: 'terminal', label: '终端', icon: 'codicon-terminal-bash', shortcut: 'Ctrl+`'},
  {id: 'browser', label: '浏览器', icon: 'codicon-globe', shortcut: 'Ctrl+T'},
  {id: 'files', label: '文件', icon: 'codicon-files', shortcut: 'Ctrl+P'},
  {id: 'environment', label: '环境信息', icon: 'codicon-git-branch', shortcut: ''},
  {id: 'sub-agents', label: '子代理', icon: 'codicon-organization', shortcut: ''},
  {id: 'project-capabilities', label: '项目能力', icon: 'codicon-settings', shortcut: ''},
  {id: 'schedule', label: '定时任务', icon: 'codicon-history', shortcut: ''},
  {id: 'bash', label: '后台进程', icon: 'codicon-terminal-bash', shortcut: ''}
]

const panelRef = ref(null)
const tabStripRef = ref(null)
const addButtonRef = ref(null)
const addMenuRef = ref(null)
const addMenuOpen = ref(false)
const nativeToolMenuOpening = ref(false)
const nativeToolMenuAvailable = typeof window !== 'undefined'
  && typeof window.electronAPI?.desktopToolMenu?.open === 'function'
const openTabs = ref([])
const visited = ref(new Set())
const activeTabId = ref('')
const browserState = ref({activeTabId: null, tabs: []})
const browserStateReady = ref(false)
const browserRequested = ref(false)
const browserCreatePending = ref(false)
const browserRef = ref(null)
const fileExplorerRef = ref(null)
const environmentPanelRef = ref(null)
const subAgentPanelRef = ref(null)
const projectCapabilitiesPanelRef = ref(null)
const scheduleRef = ref(null)

const activeTab = computed(() => openTabs.value.find((tab) => tab.id === activeTabId.value) || null)
const activeToolId = computed(() => {
  if (activeTab.value?.kind === 'browser') return activeTab.value.id
  return activeTab.value?.toolId || ''
})
const isBrowserSurfaceActive = computed(() => activeToolId.value === 'review' || activeTab.value?.kind === 'browser')

const BROWSER_TAB_PREFIX = 'browser:'
const browserPanelTabId = (id) => `${BROWSER_TAB_PREFIX}${id}`
const failedBrowserFavicons = new Map()

function findTool(toolId) {
  return toolOptions.find((tool) => tool.id === toolId) || null
}

function normalizeToolId(value) {
  if (!value || value === 'launcher') return ''
  return String(value)
}

function makeToolTab(toolId) {
  const tool = findTool(toolId)
  if (!tool) return null
  return {
    id: tool.id,
    toolId: tool.id,
    kind: 'tool',
    label: tool.label,
    title: tool.label,
    icon: tool.icon,
    closable: true
  }
}

function browserSiteColor(url) {
  const colors = ['#5b8def', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#c678dd', '#d19a66', '#61afef']
  const text = String(url || '')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  return colors[hash % colors.length]
}

function browserTabLetter(tab) {
  const text = String(tab.title || tab.url || '新标签页').trim()
  const first = text.replace(/^https?:\/\/(www\.)?/i, '').charAt(0)
  return first ? first.toUpperCase() : '新'
}

function makeBrowserTab(tab) {
  const failed = failedBrowserFavicons.get(tab.id)
  const favicon = failed && failed.url === tab.url && failed.favicon === tab.favicon
    ? null
    : (tab.favicon || null)
  if (failed && (failed.url !== tab.url || failed.favicon !== tab.favicon)) failedBrowserFavicons.delete(tab.id)
  return {
    id: browserPanelTabId(tab.id),
    browserTabId: tab.id,
    kind: 'browser',
    toolId: 'browser',
    label: tab.title || '新标签页',
    title: tab.title || tab.url || '新标签页',
    url: tab.url || '',
    favicon,
    loading: Boolean(tab.loading),
    closable: true
  }
}

function isToolOpen(toolId) {
  return openTabs.value.some((tab) => tab.toolId === toolId || (toolId === 'browser' && tab.kind === 'browser'))
}

function emitActive(value) {
  emit('update:modelValue', value || 'launcher')
}

function setActiveTab(id, notify = true) {
  const tab = openTabs.value.find((item) => item.id === id)
  if (!tab) {
    activeTabId.value = ''
    if (notify) emitActive('')
    return
  }
  activeTabId.value = tab.id
  if (notify) emitActive(tab.id)
}

function insertToolTab(toolId) {
  const existing = openTabs.value.find((tab) => tab.toolId === toolId && tab.kind === 'tool')
  if (existing) return existing
  const tab = makeToolTab(toolId)
  if (!tab) return null
  openTabs.value.push(tab)
  visited.value = new Set([...visited.value, toolId])
  return tab
}

async function ensureBrowserTab() {
  if (!browserRef.value || browserCreatePending.value) return
  if (!browserStateReady.value) {
    await browserRef.value.refreshState?.()
    if (!browserStateReady.value) return
  }
  if (browserState.value.tabs.length > 0) {
    browserRequested.value = false
    syncBrowserState(browserState.value)
    return
  }
  browserCreatePending.value = true
  try {
    await browserRef.value.newTab?.()
  } finally {
    browserCreatePending.value = false
  }
}

function openTool(toolId, {notify = true} = {}) {
  const normalized = normalizeToolId(toolId)
  if (!normalized) return
  if (normalized === 'browser') {
    browserRequested.value = true
    const browserTabs = openTabs.value.filter((tab) => tab.kind === 'browser')
    if (browserTabs.length > 0) {
      browserRequested.value = false
      const target = browserState.value.activeTabId
        ? browserPanelTabId(browserState.value.activeTabId)
        : browserTabs[0].id
      setActiveTab(target, notify)
      return
    }
    const placeholder = openTabs.value.find((tab) => tab.id === 'browser') || insertToolTab('browser')
    if (placeholder) {
      setActiveTab(placeholder.id, notify)
      void nextTick(() => ensureBrowserTab())
    }
    return
  }
  const tab = insertToolTab(normalized)
  if (tab) setActiveTab(tab.id, notify)
}

function selectTool(toolId) {
  addMenuOpen.value = false
  openTool(toolId)
}

function openOnboarding() {
  addMenuOpen.value = false
  emit('openOnboarding')
}

function activateTab(id) {
  const tab = openTabs.value.find((item) => item.id === id)
  if (!tab) return
  setActiveTab(tab.id)
  if (tab.kind === 'browser') void browserRef.value?.activate?.(tab.browserTabId)
}

function fallbackAfterClose(index) {
  const next = openTabs.value[index] || openTabs.value[index - 1]
  setActiveTab(next?.id || '', true)
}

function fallbackBeforeClose(index) {
  const next = openTabs.value[index + 1] || openTabs.value[index - 1]
  setActiveTab(next?.id || '', true)
}

function removeTab(id) {
  const index = openTabs.value.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const wasActive = activeTabId.value === id
  openTabs.value.splice(index, 1)
  if (wasActive) fallbackAfterClose(index)
  if (openTabs.value.length === 0) emitActive('')
}

async function closeTab(id) {
  const tab = openTabs.value.find((item) => item.id === id)
  if (!tab) return
  if (tab.kind === 'browser') {
    browserRequested.value = false
    // 先选中相邻标签，关闭原生 WebContentsView 后状态事件会移除当前标签。
    if (activeTabId.value === id) fallbackBeforeClose(openTabs.value.indexOf(tab))
    try {
      await browserRef.value?.closeTab?.(tab.browserTabId)
    } catch (error) {
      console.warn('[desktop-tool-panel] failed to close browser tab:', error)
    }
    return
  }
  if (tab.id === 'browser') browserRequested.value = false
  removeTab(id)
}

function onTabAuxClick(event, id) {
  if (event.button === 1) {
    event.preventDefault()
    void closeTab(id)
  }
}

function onBrowserFaviconError(id) {
  const tab = openTabs.value.find((item) => item.id === id)
  if (tab) {
    failedBrowserFavicons.set(tab.browserTabId, {url: tab.url, favicon: tab.favicon})
    tab.favicon = null
  }
}

function syncBrowserState(nextState) {
  browserStateReady.value = true
  const nextBrowserTabs = (Array.isArray(nextState?.tabs) ? nextState.tabs : []).map(makeBrowserTab)
  if (nextBrowserTabs.length > 0) browserRequested.value = false
  browserState.value = {
    activeTabId: nextState?.activeTabId || null,
    // 保留原生浏览器标签的原始 id；右侧栏标签使用 browser:<id>，两者不能混用。
    tabs: (Array.isArray(nextState?.tabs) ? nextState.tabs : []).map((tab) => ({...tab}))
  }

  const current = openTabs.value.find((tab) => tab.id === activeTabId.value)
  const oldBrowserIndex = openTabs.value.findIndex((tab) => tab.kind === 'browser' || tab.id === 'browser')
  const nonBrowserTabs = openTabs.value.filter((tab) => tab.kind !== 'browser' && tab.id !== 'browser')
  const keepBrowserPlaceholder = nextBrowserTabs.length === 0 && browserRequested.value
  if (nextBrowserTabs.length > 0) {
    const insertionIndex = oldBrowserIndex >= 0 ? Math.min(oldBrowserIndex, nonBrowserTabs.length) : nonBrowserTabs.length
    nonBrowserTabs.splice(insertionIndex, 0, ...nextBrowserTabs)
  } else if (keepBrowserPlaceholder) {
    const insertionIndex = oldBrowserIndex >= 0 ? Math.min(oldBrowserIndex, nonBrowserTabs.length) : nonBrowserTabs.length
    nonBrowserTabs.splice(insertionIndex, 0, makeToolTab('browser'))
  }
  openTabs.value = nonBrowserTabs
  if (!current || current.kind === 'browser' || current.id === 'browser') {
    const target = nextState?.activeTabId || nextBrowserTabs[0]?.browserTabId
    const fallback = target
      ? browserPanelTabId(target)
      : keepBrowserPlaceholder
        ? 'browser'
        : nonBrowserTabs[Math.min(Math.max(oldBrowserIndex, 0), nonBrowserTabs.length - 1)]?.id || ''
    setActiveTab(fallback, false)
    emitActive(fallback)
  }
  if (nextBrowserTabs.length === 0 && openTabs.value.length === 0) {
    activeTabId.value = ''
    emitActive('')
  }
  if (nextBrowserTabs.length === 0 && browserRequested.value && openTabs.value.some((tab) => tab.id === 'browser')) {
    void nextTick(() => ensureBrowserTab())
  }
}

async function toggleAddMenu() {
  if (nativeToolMenuAvailable) {
    if (nativeToolMenuOpening.value) return
    nativeToolMenuOpening.value = true
    try {
      const action = await window.electronAPI.desktopToolMenu.open(props.theme)
      if (action === 'onboarding') openOnboarding()
      else if (findTool(action)) openTool(action)
    } catch (error) {
      console.warn('[desktop-tool-panel] failed to open native tool menu:', error)
    } finally {
      nativeToolMenuOpening.value = false
    }
    return
  }
  addMenuOpen.value = !addMenuOpen.value
}

function onDocumentPointerDown(event) {
  if (!panelRef.value?.contains(event.target)) addMenuOpen.value = false
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape') {
    addMenuOpen.value = false
    return
  }
  if (!props.open || event.defaultPrevented) return
  const target = event.target
  if (target instanceof HTMLElement && target.matches('input, textarea, [contenteditable="true"]')) return
  const modifier = event.ctrlKey || event.metaKey
  const key = String(event.key || '').toLowerCase()
  let toolId = ''
  if (modifier && event.shiftKey && key === 'g') toolId = 'review'
  else if (modifier && key === 'p') toolId = 'files'
  else if (modifier && (key === '`' || key === '~')) toolId = 'terminal'
  else if (modifier && key === 't' && !isBrowserSurfaceActive.value) toolId = 'browser'
  if (!toolId) return
  event.preventDefault()
  openTool(toolId)
}

function onTabStripWheel(event) {
  const element = tabStripRef.value
  if (!element || element.scrollWidth <= element.clientWidth) return
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault()
    element.scrollLeft += event.deltaY
  }
}

watch(() => props.modelValue, (value) => {
  const normalized = normalizeToolId(value)
  if (!normalized) {
    if (value === 'launcher') activeTabId.value = ''
    return
  }
  if (normalized.startsWith(BROWSER_TAB_PREFIX)) {
    if (openTabs.value.some((tab) => tab.id === normalized)) activeTabId.value = normalized
    return
  }
  if (normalized === 'browser') {
    openTool('browser', {notify: false})
    return
  }
  if (!openTabs.value.some((tab) => tab.toolId === normalized)) insertToolTab(normalized)
  const tab = openTabs.value.find((item) => item.toolId === normalized)
  if (tab) activeTabId.value = tab.id
}, {immediate: true})

watch(() => props.open, (open) => {
  if (open && openTabs.value.length === 0) openTool('files')
}, {immediate: true})

watch(() => activeTabId.value, (id) => {
  const tab = openTabs.value.find((item) => item.id === id)
  if (tab?.kind === 'browser' && browserState.value.activeTabId !== tab.browserTabId) {
    void browserRef.value?.activate?.(tab.browserTabId)
  }
})

const PANEL_SIZE_KEY = 'loopra-desktop-tool-panel-width'
const DEFAULT_PANEL_WIDTH = 680
const MIN_PANEL_WIDTH = 420
const MAX_PANEL_WIDTH_RATIO = 0.72
const savedWidth = Number(localStorage.getItem(PANEL_SIZE_KEY))
const panelWidth = ref(Number.isFinite(savedWidth) && savedWidth >= MIN_PANEL_WIDTH ? savedWidth : DEFAULT_PANEL_WIDTH)
const dragging = ref(false)
let stopResize = null

const panelStyle = computed(() => props.open ? {
  width: `${panelWidth.value}px`,
  ...(dragging.value ? {transition: 'none'} : {})
} : null)

function startResize(event) {
  stopResize?.()
  const startX = event.clientX
  const startWidth = panelWidth.value
  dragging.value = true
  const onMove = (moveEvent) => {
    const maxWidth = Math.floor(window.innerWidth * MAX_PANEL_WIDTH_RATIO)
    panelWidth.value = Math.round(Math.min(
      Math.max(startWidth + startX - moveEvent.clientX, MIN_PANEL_WIDTH),
      Math.max(maxWidth, MIN_PANEL_WIDTH)
    ))
  }
  const onUp = () => {
    dragging.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    stopResize = null
    try { localStorage.setItem(PANEL_SIZE_KEY, String(panelWidth.value)) } catch { /* ignore */ }
  }
  stopResize = onUp
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

async function refreshEnvironment() {
  await nextTick()
  await environmentPanelRef.value?.refresh?.()
}

function refreshSubAgents() {
  subAgentPanelRef.value?.refresh?.()
}

function refreshFiles() {
  fileExplorerRef.value?.refresh?.()
}

function refreshCapabilities() {
  projectCapabilitiesPanelRef.value?.load?.()
}

defineExpose({
  refreshEnvironment,
  refreshSubAgents,
  refreshFiles,
  refreshCapabilities,
  openTool,
  closeTab,
  openTabs,
  activeTabId,
  syncBrowserState
})

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
  tabStripRef.value?.addEventListener('wheel', onTabStripWheel, {passive: false})
  // 右侧栏打开时浏览器组件已经在后台同步状态；这里再兜底一次，覆盖懒加载时序。
  void nextTick(() => browserRef.value?.refreshState?.())
})

onBeforeUnmount(() => {
  stopResize?.()
  dragging.value = false
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  tabStripRef.value?.removeEventListener('wheel', onTabStripWheel)
})
</script>

<style scoped>
.desktop-tool-panel {
  position: relative;
  width: 680px;
  min-width: 420px;
  max-width: 72vw;
  flex: 0 0 auto;
  display: flex;
  overflow: hidden;
  color: var(--fg);
  background: var(--bg-2, #f7f7f8);
  border-left: 1px solid var(--border);
  transition: width .2s ease, min-width .2s ease, opacity .16s ease;
}

.desktop-tool-panel.collapsed {
  width: 0;
  min-width: 0;
  opacity: 0;
  border-left: 0;
  pointer-events: none;
}

.desktop-tool-resize {
  position: absolute;
  inset: 0 auto 0 -4px;
  z-index: 5;
  width: 8px;
  cursor: ew-resize;
}

.desktop-tool-resize:hover,
.desktop-tool-resize.dragging {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
}

.desktop-tool-content {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.desktop-tool-head {
  position: relative;
  z-index: 10;
  min-height: 46px;
  padding: 0 8px;
  flex: 0 0 46px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2, #f3f3f4);
}

.desktop-tool-tabbar {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
}

.desktop-tool-tabs {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
}

.desktop-tool-tabs::-webkit-scrollbar { display: none; }

.desktop-tool-tab {
  min-width: 96px;
  width: fit-content;
  max-width: 220px;
  height: 32px;
  padding: 0 6px 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 1 auto;
  overflow: hidden;
  border: 0;
  border-radius: 7px;
  color: var(--fg-3);
  background: transparent;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: color .15s ease, background-color .15s ease;
}

.desktop-tool-tab:hover { color: var(--fg); background: var(--bg-3); }
.desktop-tool-tab.active { color: var(--fg); background: var(--bg); box-shadow: inset 0 0 0 1px var(--border); }
.desktop-tool-tab-icon { width: 15px; height: 15px; display: grid; place-items: center; flex: 0 0 15px; }
.desktop-tool-tab-icon i { font-size: 15px; }
.desktop-tool-tab-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.desktop-tool-tab-favicon {
  width: 15px;
  height: 15px;
  border-radius: 3px;
  object-fit: contain;
}

.desktop-tool-tab-browser-avatar {
  width: 15px;
  height: 15px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}

.desktop-tool-tab-spinner {
  width: 13px;
  height: 13px;
  box-sizing: border-box;
  border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: desktop-tool-spin .8s linear infinite;
}

@keyframes desktop-tool-spin { to { transform: rotate(360deg); } }

.desktop-tool-tab-close {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  flex: 0 0 20px;
  border-radius: 5px;
  color: var(--fg-4);
  opacity: 0;
  transition: opacity .15s ease, color .15s ease, background-color .15s ease;
}

.desktop-tool-tab:hover .desktop-tool-tab-close,
.desktop-tool-tab.active .desktop-tool-tab-close,
.desktop-tool-tab-close:focus-visible { opacity: 1; }
.desktop-tool-tab-close:hover { color: var(--fg); background: var(--bg-3); }
.desktop-tool-tab-close i { font-size: 14px; }

.desktop-tool-add {
  position: relative;
  flex: 0 0 auto;
}

.desktop-tool-add-button,
.desktop-tool-head-button {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: var(--fg-3);
  background: transparent;
  cursor: pointer;
}

.desktop-tool-add-button:hover,
.desktop-tool-head-button:hover { color: var(--fg); background: var(--bg-3); }
.desktop-tool-add-button i,
.desktop-tool-head-button i { font-size: 16px; }

.desktop-tool-add-menu {
  position: absolute;
  top: 38px;
  right: 0;
  z-index: 50;
  width: 236px;
  max-width: min(236px, calc(100vw - 24px));
  max-height: min(620px, calc(100vh - 64px));
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg);
  box-shadow: 0 16px 38px rgba(15, 23, 42, .18);
}

.desktop-tool-add-item {
  width: 100%;
  min-height: 38px;
  padding: 0 9px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  border: 0;
  border-radius: 7px;
  color: var(--fg-2);
  background: transparent;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.desktop-tool-add-item:hover,
.desktop-tool-add-item.opened { color: var(--fg); background: var(--bg-3); }
.desktop-tool-add-item.attention { animation: desktop-tool-attention 1s ease-in-out 2; }
.desktop-tool-add-item > i { color: var(--fg-3); font-size: 16px; text-align: center; }
.desktop-tool-add-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desktop-tool-add-item kbd,
.desktop-tool-add-item-state { min-width: 42px; color: var(--fg-4); font: 11px var(--mono); text-align: right; }
.desktop-tool-add-item-state { color: var(--accent); font-size: 13px; font-weight: 700; }
.desktop-tool-add-divider { height: 1px; margin: 5px 4px; background: var(--border); }

@keyframes desktop-tool-attention {
  50% { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
}

.desktop-tool-head-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }

.desktop-tool-body {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  overflow: hidden;
}

.desktop-tool-body > * { width: 100%; min-width: 0; min-height: 0; flex: 1; }
.desktop-tool-body :deep(.sch-panel),
.desktop-tool-body :deep(.git-panel),
.desktop-tool-body :deep(.file-explorer),
.desktop-tool-body :deep(.environment-panel),
.desktop-tool-body :deep(.sub-agent-panel) {
  width: 100%;
  border: 0;
  background: transparent;
}
.desktop-tool-body :deep(.sch-head) { display: none; }
.desktop-tool-body :deep(.terminal-panel.vertical) { width: 100%; min-width: 0; flex: 1 1 auto; }
.desktop-tool-body :deep(.ai-browser-shell) { width: 100%; height: 100%; }

.desktop-tool-empty {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  color: var(--fg-4);
  text-align: center;
}

.desktop-tool-empty > i { color: var(--fg-3); font-size: 27px; }
.desktop-tool-empty strong { color: var(--fg-2); font-size: 14px; font-weight: 600; }
.desktop-tool-empty span { font-size: 12px; }

[data-theme="dark"] .desktop-tool-panel,
[data-theme="dark"] .desktop-tool-head { background: #222327; }

[data-theme="dark"] .desktop-tool-add-menu { box-shadow: 0 16px 38px rgba(0, 0, 0, .36); }

@media (max-width: 820px) {
  .desktop-tool-panel {
    position: absolute;
    inset: 0 0 0 auto;
    z-index: 100;
    width: min(520px, 92vw);
    max-width: 92vw;
    min-width: min(360px, 92vw);
    box-shadow: -8px 0 28px rgba(0, 0, 0, .14);
  }
}
</style>
