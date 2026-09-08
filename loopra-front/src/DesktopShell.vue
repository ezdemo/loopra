<template>
  <div class="desktop-shell" :data-theme="theme" :style="typographyStyle">
    <Teleport to="body">
      <div
        v-if="homeContextMenu.visible"
        class="desktop-shell-context-menu"
        role="menu"
        aria-label="首页菜单"
        :style="{ left: `${homeContextMenu.x}px`, top: `${homeContextMenu.y}px` }"
        @contextmenu.prevent
      >
        <button type="button" role="menuitem" @click="chooseHomeContextAction('open-requirement-board')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          需求池
        </button>
        <button type="button" role="menuitem" @click="chooseHomeContextAction('open-onboarding')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4V2M15 10V8M11.5 5.5H9.5M20.5 5.5H18.5M17.99 8.5 19.5 10M12.01 8.5 10.5 10"/><path d="m3 21 8-8"/></svg>
          引导
        </button>
        <button type="button" role="menuitem" @click="chooseHomeContextAction('open-update')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          更新
        </button>
        <button
          type="button"
          role="menuitem"
          :title="theme === 'dark' ? '浅色' : '暗色'"
          @click="chooseHomeContextAction('toggle-theme')"
        >
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.2 14.1A8.5 8.5 0 0 1 9.9 3.8 8.5 8.5 0 1 0 20.2 14.1Z"/></svg>
          {{ theme === 'dark' ? '浅色' : '暗色' }}
        </button>
      </div>
      <div
        v-if="tabContextMenu.visible"
        class="desktop-tab-context-menu"
        role="menu"
        aria-label="会话操作菜单"
        :style="{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }"
        @contextmenu.prevent
      >
        <button type="button" role="menuitem" @click="chooseTabContextAction('reload')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0 2 5"/><path d="M20 4v7h-7"/></svg>
          刷新
        </button>
        <button type="button" role="menuitem" @click="chooseTabContextAction('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
          关闭
        </button>
        <button type="button" role="menuitem" :disabled="!hasTabsToClose('left')" @click="chooseTabContextAction('close-left')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5v14M9 8h10M9 12h7M9 16h10"/></svg>
          关闭上方会话
        </button>
        <button type="button" role="menuitem" :disabled="!hasTabsToClose('right')" @click="chooseTabContextAction('close-right')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 5v14M5 8h10M8 12h7M5 16h10"/></svg>
          关闭下方会话
        </button>
      </div>
    </Teleport>

    <header class="desktop-titlebar">
      <button
        type="button"
        class="desktop-titlebar-button desktop-sidebar-toggle"
        :class="{ active: !sidebarCollapsed }"
        :aria-pressed="!sidebarCollapsed"
        :title="sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
        aria-label="切换侧边栏"
        @click="toggleSidebar"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M10 5v14"/></svg>
      </button>
    </header>

    <div
      class="desktop-workbench"
      :class="{ 'sidebar-collapsed': sidebarCollapsed, 'sidebar-resizing': sidebarDragging, 'settings-mode': showSettings }"
      :style="sidebarStyle"
    >
      <DesktopHome
        sidebar-only
        :settings-mode="showSettings"
        :active-session-name="tabs.find(tab => tab.id === activeTabId)?.sessionName || ''"
        :workspaces="workspaces"
        :active-workspace-hash="activeWorkspaceHash"
        :theme="theme"
        :refresh-key="homeRefreshKey"
        :refreshing="refreshingHome"
        @select-workspace="selectWorkspace"
        @new-session="createTab"
        @open-session="openSession"
        @open-file-search="openFileSearch"
        @search-visibility-change="handleSearchVisibilityChange"
        @open-skills="openSkills"
        @open-requirement-board="openRequirementBoard"
        @open-tools="openTools"
        @open-sub-agents="openSubAgents"
        @open-settings="openSettings"
        @toggle-theme="toggleTheme"
        @add-workspace="addWorkspaceFromFolder"
        @refresh="refreshHome"
        @delete-session="confirmDeleteSession"
        @delete-sessions="confirmDeleteSessions"
        @session-renamed="onSessionRenamed"
        @clear-workspace="confirmClearWorkspace"
        @clear-old-sessions="confirmClearOldSessions"
        @delete-workspace="confirmDeleteWorkspace"
        @delete-workspaces="confirmDeleteWorkspaces"
        @reorder-workspaces="reorderWorkspaces"
        @open-home-context="openHomeContextMenu"
      >
        <template #sidebar-header-actions>
          <button
            class="desktop-sidebar-header-button desktop-notification-button"
            :class="{ 'has-update': hasNewVersion }"
            type="button"
            :title="hasNewVersion ? `发现新版本 v${latestVersion}，点击打开更新` : '更新与通知'"
            aria-label="更新与通知"
            @click="onUpdateButtonClick"
          >
            <svg v-if="checkingUpdate" class="update-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>
            <i v-if="hasNewVersion" class="desktop-update-dot" />
          </button>
        </template>
        <template #open-sessions="{ workspaceHash }">
      <nav v-if="tabs.some(tab => tab.workspaceHash === workspaceHash)" class="desktop-tabs" aria-label="已打开的会话">
        <div
          v-for="tab in tabs.filter(tab => tab.workspaceHash === workspaceHash)"
          :key="tab.id"
          class="desktop-tab"
          :class="{ active: tab.id === activeTabId, dragging: tab.id === draggedTabId, 'drag-over': tab.id === dragOverTabId }"
          draggable="true"
          role="tab"
          :aria-selected="tab.id === activeTabId"
          :aria-haspopup="'menu'"
          :aria-expanded="tabContextMenu.visible && tabContextMenu.tabId === tab.id"
          tabindex="0"
          :title="tab.title"
          @dragstart="startTabReorder($event, tab.id)"
          @dragover="dragOverTab($event, tab.id)"
          @drop="dropTab($event, tab.id)"
          @dragend="endTabReorder"
          @click="activateTab(tab.id)"
          @contextmenu.prevent.stop="openTabContextMenu($event, tab.id)"
          @mousedown.middle.prevent.stop="closeTab(tab.id)"
          @keydown.enter="activateTab(tab.id)"
          @keydown.space.prevent="activateTab(tab.id)"
        >
          <span v-if="workspaceNameOf(tab.workspaceHash)" class="desktop-tab-monogram" :class="badgeTone(workspaceNameOf(tab.workspaceHash))">{{ initial(workspaceNameOf(tab.workspaceHash)) }}</span>
          <span v-else class="desktop-tab-monogram desktop-tab-monogram-default" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          </span>
          <span class="desktop-tab-title">{{ tab.title }}</span>
        </div>

      </nav>

        </template>
      </DesktopHome>
      <div
        class="desktop-sidebar-resize-handle"
        :class="{ dragging: sidebarDragging, collapsed: sidebarCollapsed }"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左侧边栏宽度"
        :title="sidebarCollapsed ? '拖动展开侧边栏' : '拖动调整左侧边栏宽度'"
        tabindex="0"
        :aria-valuemin="DESKTOP_SIDEBAR_MIN_WIDTH"
        :aria-valuemax="sidebarMaxWidth"
        :aria-valuenow="sidebarWidth"
        :aria-valuetext="`${sidebarWidth}px`"
        @mousedown.prevent="startSidebarResize"
        @keydown="handleSidebarResizeKeydown"
        @dblclick="resetSidebarWidth"
      ></div>
    <main ref="host" class="desktop-view-host" :class="{ 'settings-host': showSettings }">
      <div v-if="sessionLoading" class="desktop-session-loading" role="status" aria-live="polite">
        <span class="desktop-session-loading-spinner" aria-hidden="true"></span>
        <span>正在加载会话…</span>
      </div>
      <div v-if="startupError" class="desktop-empty desktop-error">
        <span>{{ startupError }}</span>
        <button type="button" @click="initializeWorkspace">重试</button>
      </div>
      <SettingsView v-else-if="showSkills" class="desktop-settings" market-only />
      <ModelChannels v-else-if="showModelChannels" class="desktop-settings" :show-back="false" @saved="reloadAfterModelChannelsSaved" />
      <SettingsView v-else-if="showSettings" class="desktop-settings" :initial-tab="settingsTab" show-back @back="showHome" />
    </main>
    </div>
  <ConfirmDialog />
  <ActionConfirmDialog
    v-if="!popupUsesNativeOverlay"
    :model-value="deleteConfirm.visible"
    :title="deleteConfirm.title"
    :message="deleteConfirm.message"
    :actions="deleteConfirmActions"
    @update:model-value="dismissDeleteConfirm"
    @action="handleDeleteConfirmAction"
  />
</div>
</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue'
import {message} from 'ant-design-vue'
import {useAppStore} from './stores/app'
import {configAPI, sessionsAPI, systemAPI} from './services/api'
import {RELEASE_LATEST_URL} from './utils/constants'
import {buildUpdatePrompt} from './utils/updateScripts'
import {platform} from './services/platform'
import DesktopHome from './DesktopHome.vue'
import SettingsView from './views/Settings.vue'
import ModelChannels from './ModelChannels.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ActionConfirmDialog from './components/ActionConfirmDialog.vue'
import {hasConfiguredModelChannel} from './utils/modelChannels'
import {switchThemeWithReveal} from './utils/themeTransition'
import {toPlainIpcValue} from './utils/ipcPayload'
import {
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  normalizeFontSize
} from './utils/fonts'

const store = useAppStore()
const theme = computed(() => store.settings.theme)
// DesktopShell also owns the persistent left sidebar. Bind the typography
// variables on this root so settings changes apply immediately in this window,
// even before the global store watcher finishes its persistence round-trip.
const typographyStyle = computed(() => {
  const ui = normalizeFontSize(store.settings.uiFontSize, DEFAULT_UI_FONT_SIZE, 11, 18)
  const code = normalizeFontSize(store.settings.codeFontSize, DEFAULT_CODE_FONT_SIZE, 10, 16)
  return {
    '--font-ui-size': `${ui}px`,
    '--font-ui-line-height': `${Math.max(16, Math.round(ui * 1.428571))}px`,
    '--font-message-size': `${ui}px`,
    '--font-code-size': `${code}px`
  }
})
const popupUsesNativeOverlay = computed(() => Boolean(window.electronAPI?.desktopPopup?.open))
const creating = ref(false)
const startupError = ref('')
const workspaces = ref([])
const activeWorkspaceHash = ref('')
const homeRefreshKey = ref(0)
const refreshingHome = ref(false)
const showSkills = ref(false)
const showSettings = ref(false)
const showModelChannels = ref(false)
const modelChannelsRequireReload = ref(false)
// 设置页打开的初始 tab（工具/子代理/数据面板已收进设置页左侧菜单）
const settingsTab = ref('general')
const settingsReturnTabId = ref('')
const tabs = ref([])
const activeTabId = ref('')
const sessionLoading = ref(false)
const sidebarCollapsed = ref(false)
const DESKTOP_SIDEBAR_SIZE_KEY = 'loopra-desktop-sidebar-width'
const DESKTOP_SIDEBAR_DEFAULT_WIDTH = 280
const DESKTOP_SIDEBAR_MIN_WIDTH = 220
const DESKTOP_SIDEBAR_COLLAPSE_DISTANCE = 32
const DESKTOP_SIDEBAR_MAX_WIDTH = 420
const DESKTOP_SIDEBAR_MAX_WIDTH_RATIO = 0.4

function getSidebarMaxWidth(viewportWidthOverride) {
  const viewportWidth = viewportWidthOverride ?? (typeof window === 'undefined' ? 0 : Number(window.innerWidth))
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return DESKTOP_SIDEBAR_MAX_WIDTH
  return Math.max(
    DESKTOP_SIDEBAR_MIN_WIDTH,
    Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.floor(viewportWidth * DESKTOP_SIDEBAR_MAX_WIDTH_RATIO))
  )
}

function clampSidebarWidth(value) {
  const numericValue = Number(value)
  const width = Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : DESKTOP_SIDEBAR_DEFAULT_WIDTH
  return Math.round(Math.min(getSidebarMaxWidth(), Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, width)))
}

function readSidebarWidth() {
  try {
    return clampSidebarWidth(window.localStorage.getItem(DESKTOP_SIDEBAR_SIZE_KEY))
  } catch {
    return clampSidebarWidth(DESKTOP_SIDEBAR_DEFAULT_WIDTH)
  }
}

const sidebarWidth = ref(readSidebarWidth())
const sidebarDragging = ref(false)
const sidebarViewportWidth = ref(typeof window === 'undefined' ? 0 : window.innerWidth)
const sidebarMaxWidth = computed(() => getSidebarMaxWidth(sidebarViewportWidth.value))
const sidebarStyle = computed(() => ({'--desktop-sidebar-width': `${sidebarWidth.value}px`}))
let stopSidebarResize = null
let sidebarResizeMoveHandler = null

function persistSidebarWidth() {
  try {
    window.localStorage.setItem(DESKTOP_SIDEBAR_SIZE_KEY, String(sidebarWidth.value))
  } catch {
    // 存储不可用时忽略，当前窗口内的调整仍然有效。
  }
}

function setSidebarWidth(value) {
  sidebarWidth.value = clampSidebarWidth(value)
}

function startSidebarResize(event) {
  stopSidebarResize?.()
  const startX = Number(event.clientX) || 0
  const startWidth = sidebarWidth.value
  const previousCursor = document.body.style.cursor
  const previousUserSelect = document.body.style.userSelect
  const nativeResizeBridge = nativeTabs()
  let nativeResizeRelayActive = typeof nativeResizeBridge?.startSidebarResize === 'function'
  let finished = false
  // 隐藏态保留一条窄拖拽条，按下它即可从最小宽度重新展开。
  if (sidebarCollapsed.value) sidebarCollapsed.value = false
  sidebarDragging.value = true
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'

  const updateFromClientX = (clientX) => {
    if (finished) return
    const nextWidth = startWidth + (Number(clientX) || 0) - startX
    if (nextWidth < DESKTOP_SIDEBAR_MIN_WIDTH - DESKTOP_SIDEBAR_COLLAPSE_DISTANCE) {
      sidebarWidth.value = DESKTOP_SIDEBAR_MIN_WIDTH
      sidebarCollapsed.value = true
      onUp()
      return
    }
    setSidebarWidth(nextWidth)
  }

  const onMove = (moveEvent) => updateFromClientX(moveEvent.clientX)

  const onBlur = () => {
    // 主页面与原生 WebContentsView 交界时可能发生 renderer blur，
    // 这只是焦点切换，不代表用户松开了鼠标。
    if (nativeResizeRelayActive) return
    onUp()
  }

  const onUp = () => {
    if (finished) return
    finished = true
    sidebarDragging.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('blur', onBlur)
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
    stopSidebarResize = null
    sidebarResizeMoveHandler = null
    nativeResizeRelayActive = false
    persistSidebarWidth()
    void Promise.resolve(nativeResizeBridge?.endSidebarResize?.()).catch((error) => {
      console.warn('[desktop-shell] failed to stop native sidebar resize relay:', error)
    })
  }

  stopSidebarResize = onUp
  // 原生聊天视图覆盖在主页面之上，鼠标移入后主页面收不到 mousemove。
  // 将同一个坐标处理函数暴露给主进程转发回来的事件，保证拖拽连续。
  sidebarResizeMoveHandler = updateFromClientX
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('pointercancel', onUp)
  window.addEventListener('blur', onBlur)
  if (nativeResizeBridge?.startSidebarResize) {
    void Promise.resolve(nativeResizeBridge.startSidebarResize()).then((result) => {
      if (result?.success === false) nativeResizeRelayActive = false
    }).catch((error) => {
      nativeResizeRelayActive = false
      console.warn('[desktop-shell] failed to start native sidebar resize relay:', error)
    })
  }
}

function handleSidebarResizeKeydown(event) {
  const step = event.shiftKey ? 32 : 10
  let nextWidth = null
  if (event.key === 'ArrowLeft') nextWidth = sidebarWidth.value - step
  else if (event.key === 'ArrowRight') nextWidth = sidebarWidth.value + step
  else if (event.key === 'Home') nextWidth = DESKTOP_SIDEBAR_MIN_WIDTH
  else if (event.key === 'End') nextWidth = getSidebarMaxWidth()
  if (nextWidth === null) return
  event.preventDefault()
  if (sidebarCollapsed.value && event.key !== 'ArrowLeft') sidebarCollapsed.value = false
  setSidebarWidth(nextWidth)
  persistSidebarWidth()
}

function resetSidebarWidth() {
  sidebarCollapsed.value = false
  setSidebarWidth(DESKTOP_SIDEBAR_DEFAULT_WIDTH)
  persistSidebarWidth()
}

function onSidebarViewportResize() {
  sidebarViewportWidth.value = window.innerWidth
  setSidebarWidth(sidebarWidth.value)
}

const documentTitle = computed(() => {
  if (showSkills.value) return 'Loopra - 工具箱'
  if (showModelChannels.value) return 'Loopra - 模型渠道'
  if (showSettings.value) return 'Loopra - 设置'
  return tabs.value.find((tab) => tab.id === activeTabId.value)?.title || 'Loopra'
})
watch(documentTitle, (title) => { document.title = title }, { immediate: true })
watch(theme, (value) => {
  window.electronAPI?.desktopTitleBar?.setTheme?.(value)
}, { immediate: true })

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

const draggedTabId = ref('')
const dragOverTabId = ref('')
const host = ref(null)
const homeContextMenu = reactive({visible: false, x: 0, y: 0})
const tabContextMenu = reactive({visible: false, tabId: '', x: 0, y: 0})
const HOME_CONTEXT_MENU_WIDTH = 176
const HOME_CONTEXT_MENU_HEIGHT = 148
const TAB_CONTEXT_MENU_WIDTH = 188
const TAB_CONTEXT_MENU_HEIGHT = 146
let resizeObserver = null
let renderVersion = 0
let renderQueue = Promise.resolve()
let lastShownTabId = ''
let lastShownBounds = null
let sessionLoadingVersion = 0
const loadingCoveredTabIds = new Set()

// 版本更新检查：启动后立即检查一次，之后每 30 分钟自动定时检查
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000
let updateCheckTimer = null
const latestVersion = ref('')
const hasNewVersion = ref(false)
const releaseUrl = ref('')
const checkingUpdate = ref(false)

// AI 浏览器桥接地址保存在核心服务进程内存中；核心服务重启后需要重新登记。
// 启动页只登记一次，而启动页在进入主界面后会销毁，因此由常驻桌面壳负责保活。
const AI_BROWSER_BRIDGE_REGISTER_INTERVAL = 10 * 1000
let aiBrowserBridgeRegisterTimer = null
let aiBrowserBridgeRegisterPromise = null

function canRegisterAiBrowserBridge() {
  return typeof window.electronAPI?.aiBrowserWindow?.getBridgeAddress === 'function'
    && typeof systemAPI.setBrowserBridge === 'function'
}

async function registerAiBrowserBridge() {
  if (!canRegisterAiBrowserBridge()) return
  if (aiBrowserBridgeRegisterPromise) return aiBrowserBridgeRegisterPromise

  aiBrowserBridgeRegisterPromise = (async () => {
    try {
      const address = await window.electronAPI.aiBrowserWindow.getBridgeAddress()
      if (address) await systemAPI.setBrowserBridge(address, {silent: true})
    } catch (error) {
      // 后端或 Electron bridge 暂时未就绪时交给下一轮重试，不打断桌面主界面。
      console.warn('[desktop-shell] failed to register AI browser bridge:', error)
    } finally {
      aiBrowserBridgeRegisterPromise = null
    }
  })()
  return aiBrowserBridgeRegisterPromise
}

function startAiBrowserBridgeKeepalive() {
  if (aiBrowserBridgeRegisterTimer || !canRegisterAiBrowserBridge()) return
  void registerAiBrowserBridge()
  aiBrowserBridgeRegisterTimer = window.setInterval(() => {
    void registerAiBrowserBridge()
  }, AI_BROWSER_BRIDGE_REGISTER_INTERVAL)
}

function stopAiBrowserBridgeKeepalive() {
  if (aiBrowserBridgeRegisterTimer) {
    window.clearInterval(aiBrowserBridgeRegisterTimer)
    aiBrowserBridgeRegisterTimer = null
  }
}

async function checkForUpdates() {
  if (checkingUpdate.value) return
  checkingUpdate.value = true
  try {
    const res = await systemAPI.checkLatestVersion()
    if (res.success && res.data) {
      latestVersion.value = res.data.latestVersion || ''
      releaseUrl.value = res.data.releaseUrl || ''
      // 对比桌面端（Electron）版本：桌面端版本 < 最新版本即提示更新
      let desktopVersion = ''
      if (platform.isElectron) {
        try {
          desktopVersion = await window.electronAPI.getElectronVersion()
        } catch (error) {
          console.warn('[desktop-shell] 获取桌面端版本失败:', error)
        }
      }
      if (desktopVersion && desktopVersion !== '未知' && latestVersion.value) {
        hasNewVersion.value = compareVersions(desktopVersion, latestVersion.value) < 0
      } else {
        // 非桌面环境（Web 模式）无桌面端版本，退化为核心服务版本对比
        hasNewVersion.value = !!res.data.hasNewVersion
      }
    }
  } catch (error) {
    console.warn('[desktop-shell] 检查更新失败:', error)
  } finally {
    checkingUpdate.value = false
  }
}

// 版本对比：支持 v 前缀与 1~4 段数字版本（与 electron/version.cjs 保持一致）
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = String(b || '').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

// 点击更新按钮始终打开更新窗口，窗口内会自行检查版本
function onUpdateButtonClick() {
  void openUpdateWindow()
}

async function openUpdateWindow() {
  if (platform.isElectron) {
    try {
      await window.electronAPI?.updateWindow?.open()
    } catch (error) {
      console.warn('[desktop-shell] failed to open update window:', error)
      openReleasePage()
    }
  } else {
    openReleasePage()
  }
}

async function openReleasePage() {
  const url = (hasNewVersion.value && releaseUrl.value) || RELEASE_LATEST_URL
  if (platform.isElectron) {
    try {
      await window.electronAPI.openExternal(url)
    } catch {
      window.open(url, '_blank')
    }
  } else {
    window.open(url, '_blank')
  }
}

const tabId = (workspaceHash, sessionName) => `${workspaceHash || ''}:${sessionName}`
const tabTitle = (sessionName) => {
  const match = String(sessionName).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  return match ? '新建会话' : (String(sessionName).replace(/[-_]+/g, ' ').slice(0, 24) || '新建会话')
}

const nativeTabs = () => window.electronAPI?.desktopChatTabs

const stopNativeSidebarResizeMoveListener = window.electronAPI?.events?.listen('desktop-shell-sidebar-resize-move', (payload) => {
  const clientX = Number(payload?.clientX)
  if (Number.isFinite(clientX)) sidebarResizeMoveHandler?.(clientX)
})
const stopNativeSidebarResizeEndListener = window.electronAPI?.events?.listen('desktop-shell-sidebar-resize-end', () => {
  stopSidebarResize?.()
})

function beginSessionLoading(previousTabId) {
  const request = {version: ++sessionLoadingVersion}
  sessionLoading.value = true
  if (previousTabId) {
    loadingCoveredTabIds.add(previousTabId)
    request.shown = Promise.resolve(nativeTabs()?.setLoading?.(previousTabId, true)).catch((error) => {
      console.warn('[desktop-shell] failed to show session loading state:', error)
    })
  } else {
    request.shown = Promise.resolve()
  }
  return request
}

async function finishSessionLoading(request) {
  if (!request || request.version !== sessionLoadingVersion) return
  // 若打开和关闭 IPC 几乎同时发生，先等“显示”完成，避免迟到的 true 覆盖最终 false。
  await request.shown
  sessionLoading.value = false
  const coveredTabIds = [...loadingCoveredTabIds]
  loadingCoveredTabIds.clear()
  await Promise.all(coveredTabIds.map((id) => Promise.resolve(nativeTabs()?.setLoading?.(id, false)).catch((error) => {
    console.warn('[desktop-shell] failed to hide session loading state:', error)
  })))
}
const isElectronRuntime = () => {
  const hasNativeMenuAPI = Boolean(window.electronAPI?.desktopHomeMenu || window.electronAPI?.desktopTabMenu)
  const isDesktopShellRoute = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('desktopShell') === '1'
  return platform.isElectron || hasNativeMenuAPI || isDesktopShellRoute
}

// 项目图标：首字符 + 色调（与 TitleBar/DesktopHome 保持一致）
const initial = (name) => String(name || 'L').trim().charAt(0).toUpperCase() || 'L'
const badgeTone = (name) => {
  let hash = 0
  for (const char of String(name || '')) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
  return `tone-${hash % 8}`
}
const workspaceNameOf = (workspaceHash) => {
  if (!workspaceHash) return ''
  const ws = workspaces.value.find((item) => item.hash === workspaceHash)
  return ws ? ws.name : ''
}

function startTabReorder(event, tabId) {
  if (event.target.closest('button')) {
    event.preventDefault()
    return
  }
  draggedTabId.value = tabId
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', tabId)
}

function dragOverTab(event, tabId) {
  if (!draggedTabId.value || tabId === draggedTabId.value) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  dragOverTabId.value = tabId
}

function dropTab(event, targetTabId) {
  event.preventDefault()
  const sourceTabId = draggedTabId.value
  endTabReorder()
  if (!sourceTabId || sourceTabId === targetTabId) return
  const sourceIndex = tabs.value.findIndex((tab) => tab.id === sourceTabId)
  const targetIndex = tabs.value.findIndex((tab) => tab.id === targetTabId)
  if (sourceIndex < 0 || targetIndex < 0) return
  const reorderedTabs = [...tabs.value]
  const sourceTab = reorderedTabs[sourceIndex]
  reorderedTabs[sourceIndex] = reorderedTabs[targetIndex]
  reorderedTabs[targetIndex] = sourceTab
  tabs.value = reorderedTabs
}

function endTabReorder() {
  draggedTabId.value = ''
  dragOverTabId.value = ''
}

watch(theme, (value) => { void nativeTabs()?.setTheme(value) })
const stopTitleListener = window.electronAPI?.events?.listen('desktop-chat-tab-title', ({ tabId, title }) => {
  if (!tabId || !title) return
  tabs.value = tabs.value.map((tab) => tab.id === tabId ? { ...tab, title } : tab)
})
const stopWorkspaceListener = window.electronAPI?.events?.listen('desktop-chat-tab-workspace', ({ tabId, workspaceHash }) => {
  if (!tabId || !workspaceHash) return
  tabs.value = tabs.value.map((tab) => tab.id === tabId ? { ...tab, workspaceHash } : tab)
})
const stopOpenHomeListener = window.electronAPI?.events?.listen('desktop-shell-open-home', () => { void showHome() })
const stopOpenSettingsListener = window.electronAPI?.events?.listen('desktop-shell-open-model-channels', () => { void openModelChannels() })
// 更新窗口发起的「更新核心服务」：新建会话并由 Agent 在聊天框执行更新命令
const stopChatUpdateListener = window.electronAPI?.events?.listen('chat-update-request', ({ source }) => {
  void runChatUpdate(source)
})
const stopSearchActionListener = window.electronAPI?.events?.listen('desktop-shell-search-action', (action) => {
  handleDesktopSearchAction(action)
})
const stopPopupActionListener = window.electronAPI?.events?.listen('desktop-shell-popup-action', (action) => {
  handleDesktopPopupAction(action)
})
const stopPopupClosedListener = window.electronAPI?.events?.listen('desktop-shell-popup-closed', () => {
  closeContextMenus()
  dismissDeleteConfirm({notify: false})
})

function renderActiveTab(beforeShow = null) {
  const version = ++renderVersion
  const task = renderQueue.then(() => renderActiveTabNow(version, beforeShow))
  renderQueue = task.catch(() => {})
  return task
}

async function renderActiveTabNow(version, beforeShow = null) {
  const current = tabs.value.find((tab) => tab.id === activeTabId.value)
  const bridge = nativeTabs()
  if (!bridge) return true
  if (!current) {
    try { await bridge.hide() } catch (error) { console.warn('[desktop-shell] failed to hide tabs:', error) }
    lastShownTabId = ''
    lastShownBounds = null
    return true
  }
  await nextTick()
  if (!host.value) return true
  try {
    await bridge.create({
      id: current.id,
      sessionName: current.sessionName,
      sessionTitle: current.title || '',
      workspaceHash: current.workspaceHash,
      theme: theme.value,
      newSession: current.newSession === true
    })
    if (!tabs.value.some((tab) => tab.id === current.id)) {
      try { await bridge.close(current.id) } catch (cleanupError) { console.warn('[desktop-shell] failed to clean up closed tab:', cleanupError) }
      return false
    }
    if (beforeShow) await beforeShow
    if (version !== renderVersion) return false
    const bounds = host.value.getBoundingClientRect()
    const sameBounds = lastShownBounds
      && ['x', 'y', 'width', 'height'].every((key) => lastShownBounds[key] === Math.round(bounds[key]))
    // ResizeObserver、启动初始化和快速切换可能把同一目标排入多个渲染任务。
    // 已经是当前可见视图且尺寸没有变化时不再重复 show，避免原生视图重复
    // 参与合成而产生一两帧的闪烁。
    if (lastShownTabId === current.id && sameBounds) return true
    await bridge.show(current.id, {
      x: Math.round(bounds.left), y: Math.round(bounds.top), width: Math.round(bounds.width), height: Math.round(bounds.height)
    })
    lastShownTabId = current.id
    lastShownBounds = {
      x: Math.round(bounds.left), y: Math.round(bounds.top), width: Math.round(bounds.width), height: Math.round(bounds.height)
    }
    return true
  } catch (error) {
    if (!tabs.value.some((tab) => tab.id === current.id)) {
      try { await bridge.close(current.id) } catch (cleanupError) { console.warn('[desktop-shell] failed to clean up closed tab:', cleanupError) }
      return false
    }
    console.error('[desktop-shell] failed to show tab:', error)
    tabs.value = tabs.value.filter((tab) => tab.id !== current.id)
    try { await bridge.close(current.id) } catch (cleanupError) { console.warn('[desktop-shell] failed to clean up failed tab:', cleanupError) }
    if (activeTabId.value === current.id) {
      activeTabId.value = ''
      lastShownTabId = ''
      lastShownBounds = null
      try { await bridge.hide() } catch (hideError) { console.warn('[desktop-shell] failed to hide tabs after load error:', hideError) }
    }
    message.error('打开会话失败：' + (error.message || '未知错误'))
    return false
  }
}

async function createTab(workspaceHash = '') {
  if (creating.value) return
  const targetHash = workspaceHash || activeWorkspaceHash.value || (workspaces.value[0] && workspaces.value[0].hash)
  if (!targetHash) {
    startupError.value = '未找到可用项目，请先在网页版添加项目。'
    return
  }
  creating.value = true
  // 新建会话与打开历史会话使用同一套过渡：先遮住当前视图，
  // 等新会话原生视图创建完成后再切换，避免加载期间露出旧内容。
  const loadingRequest = beginSessionLoading(activeTabId.value)
  try {
    const response = await sessionsAPI.createNew({ workspaceHash: targetHash })
    if (!response.success || !response.data?.sessionName) throw new Error(response.message || '创建会话失败')
    const sessionName = response.data.sessionName
    const workspaceHash = response.data.workspaceHash || targetHash
    const id = tabId(workspaceHash, sessionName)
    hideStandaloneViews()
    tabs.value = [...tabs.value, { id, sessionName, workspaceHash, title: tabTitle(sessionName), newSession: true }]
    activeTabId.value = id
    startupError.value = ''
    await renderActiveTab(loadingRequest.shown)
  } catch (error) {
    const errorMessage = '新建会话失败：' + (error.message || '未知错误')
    message.error(errorMessage)
    if (tabs.value.length === 0) startupError.value = errorMessage
  } finally {
    await finishSessionLoading(loadingRequest)
    creating.value = false
  }
}

// 更新窗口「更新核心服务」：新建会话并由 Agent 在聊天框执行更新命令（优先于在线安装）
async function runChatUpdate(source) {
  if (creating.value) return
  const targetHash = activeWorkspaceHash.value || (workspaces.value[0] && workspaces.value[0].hash)
  if (!targetHash) {
    message.warning('未找到可用项目，请先添加项目')
    return
  }
  creating.value = true
  try {
    const response = await sessionsAPI.createNew({ workspaceHash: targetHash })
    if (!response.success || !response.data?.sessionName) throw new Error(response.message || '创建会话失败')
    const sessionName = response.data.sessionName
    const workspaceHash = response.data.workspaceHash || targetHash
    const id = tabId(workspaceHash, sessionName)
    hideStandaloneViews()
    tabs.value = [...tabs.value, { id, sessionName, workspaceHash, title: tabTitle(sessionName), newSession: true }]
    activeTabId.value = id
    startupError.value = ''
    if (!await renderActiveTab()) return
    // 发送更新命令（主进程会在标签加载完成后投递给聊天框）
    const delivered = await nativeTabs()?.sendCommand(id, buildUpdatePrompt(source, true))
    if (!delivered) throw new Error('更新命令未能投递到会话')
    message.success('已新建更新会话，正在聊天框中执行更新…')
  } catch (error) {
    message.error('新建更新会话失败：' + (error.message || '未知错误'))
  } finally {
    creating.value = false
  }
}

async function openSession({ workspaceHash, sessionName, title }) {
  if (!workspaceHash || !sessionName) {
    message.error('会话信息不完整，无法打开')
    return
  }
  hideStandaloneViews()
  const id = tabId(workspaceHash, sessionName)
  const isFirstOpen = !tabs.value.some((tab) => tab.id === id)
  const previousTabId = activeTabId.value
  if (isFirstOpen) {
    tabs.value = [...tabs.value, { id, sessionName, workspaceHash, title: title || tabTitle(sessionName) }]
  }
  activeTabId.value = id
  const loadingRequest = isFirstOpen ? beginSessionLoading(previousTabId) : null
  try {
    // 先把等待旧视图遮罩的 Promise 交给渲染任务；这样快速连续点击时，
    // 新请求仍能立即提升 renderVersion，但真正 show 前会等遮罩完成绘制。
    await renderActiveTab(loadingRequest?.shown)
  } catch (error) {
    message.error('打开会话失败：' + (error.message || '未知错误'))
  } finally {
    await finishSessionLoading(loadingRequest)
  }
  void selectWorkspace(workspaceHash).catch((error) => {
    console.warn('[desktop-shell] failed to synchronize workspace:', error)
  })
}

async function initializeWorkspaceContext() {
  const workspacesResult = await configAPI.listWorkspaces()
  if (!workspacesResult.success) {
    throw new Error(workspacesResult.message || '加载项目失败')
  }

  workspaces.value = workspacesResult.data || []
  if (workspaces.value.length === 0) {
    throw new Error('未找到可用项目，请先在网页版添加项目。')
  }

  const selectedWorkspace = workspaces.value[0]
  const switchResult = await configAPI.switchWorkspace(selectedWorkspace.path)
  if (!switchResult.success) {
    throw new Error(switchResult.message || '切换默认项目失败')
  }
  activeWorkspaceHash.value = selectedWorkspace.hash
}

async function initializeWorkspace() {
  if (creating.value) return false
  startupError.value = ''
  try {
    await initializeWorkspaceContext()
    return true
  } catch (error) {
    console.error('[desktop-shell] failed to initialize workspace:', error)
    startupError.value = error.message || '初始化默认项目失败'
    return false
  }
}

async function refreshHome() {
  if (refreshingHome.value) return
  refreshingHome.value = true
  try {
    const response = await configAPI.listWorkspaces()
    if (!response.success) throw new Error(response.message || '刷新项目列表失败')
    workspaces.value = response.data || []
    if (activeWorkspaceHash.value && !workspaces.value.some((workspace) => workspace.hash === activeWorkspaceHash.value)) {
      activeWorkspaceHash.value = ''
    }
    homeRefreshKey.value++
  } catch (error) {
    message.error('刷新失败：' + (error.message || '未知错误'))
  } finally {
    refreshingHome.value = false
  }
}

// 项目拖拽排序：本地立即重排，并持久化到服务端；失败时回滚重新加载
async function reorderWorkspaces(orderedHashes) {
  if (!Array.isArray(orderedHashes) || orderedHashes.length === 0) return
  const byHash = new Map(workspaces.value.map((workspace) => [workspace.hash, workspace]))
  const reordered = orderedHashes.map((hash) => byHash.get(hash)).filter(Boolean)
  if (reordered.length !== workspaces.value.length) return
  workspaces.value = reordered
  try {
    const response = await configAPI.saveWorkspaceOrder(orderedHashes)
    if (!response.success) throw new Error(response.message || '保存排序失败')
  } catch (error) {
    message.error('保存排序失败：' + (error.message || '未知错误'))
    await refreshHome()
  }
}

async function selectWorkspace(workspaceHash) {
  if (!workspaceHash) {
    // 取消选中，展示所有会话
    activeWorkspaceHash.value = ''
    return
  }
  const workspace = workspaces.value.find((item) => item.hash === workspaceHash)
  if (!workspace) throw new Error('项目不存在')
  if (workspaceHash === activeWorkspaceHash.value) return
  const response = await configAPI.switchWorkspace(workspace.path)
  if (!response.success) throw new Error(response.message || '切换项目失败')
  activeWorkspaceHash.value = workspaceHash
}

async function addWorkspaceFromFolder() {
  try {
    const path = await window.electronAPI?.loopraWebService?.pickFolder?.()
    if (!path) return
    const response = await configAPI.switchWorkspace(path)
    if (!response.success) throw new Error(response.message || '添加项目失败')
    const workspacesResult = await configAPI.listWorkspaces()
    if (!workspacesResult.success) throw new Error(workspacesResult.message || '刷新项目列表失败')
    workspaces.value = workspacesResult.data || []
    const selectedPath = response.data?.workspace || path
    const workspace = workspaces.value.find((item) => item.path === selectedPath)
    if (!workspace) throw new Error('项目添加成功，但未找到项目记录')
    activeWorkspaceHash.value = workspace.hash
    homeRefreshKey.value++
    message.success('项目已添加')
  } catch (error) {
    message.error('添加项目失败：' + (error.message || '未知错误'))
  }
}

function setContextMenuPosition(menu, event, rect, width, height) {
  const hasPointerPosition = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
    && (event.clientX !== 0 || event.clientY !== 0)
  const x = hasPointerPosition ? event.clientX : (rect?.left || 0)
  const y = hasPointerPosition ? event.clientY : (rect?.bottom || 0)
  const maxX = Math.max(8, window.innerWidth - width - 8)
  const maxY = Math.max(8, window.innerHeight - height - 8)
  menu.x = Math.max(8, Math.min(x, maxX))
  menu.y = Math.max(8, Math.min(y, maxY))
}

async function openHomeContextMenu(event = {}) {
  const nativePopup = window.electronAPI?.desktopPopup?.open
  if (nativePopup) {
    setContextMenuPosition(homeContextMenu, event, event.currentTarget?.getBoundingClientRect?.(), 210, 160)
    closeTabContextMenu()
    const opened = await openDesktopNativePopup('home-context', {x: homeContextMenu.x, y: homeContextMenu.y})
    homeContextMenu.visible = opened
    return
  }
  const nativeMenu = window.electronAPI?.desktopHomeMenu?.open
  if (isElectronRuntime()) {
    if (!nativeMenu) {
      console.warn('[desktop-shell] native home menu API is unavailable')
      return
    }
    closeContextMenus()
    try {
      const action = await nativeMenu(theme.value)
      if (action) chooseHomeContextAction(action)
    } catch (error) {
      console.warn('[desktop-shell] failed to open native home menu:', error)
    }
    return
  }

  setContextMenuPosition(homeContextMenu, event, event.currentTarget?.getBoundingClientRect?.(), HOME_CONTEXT_MENU_WIDTH, HOME_CONTEXT_MENU_HEIGHT)
  closeTabContextMenu()
  homeContextMenu.visible = true
}

async function openTabContextMenu(event, id) {
  const index = tabs.value.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const nativePopup = window.electronAPI?.desktopPopup?.open
  if (nativePopup) {
    setContextMenuPosition(tabContextMenu, event, event.currentTarget?.getBoundingClientRect(), 210, 150)
    closeHomeContextMenu()
    const opened = await openDesktopNativePopup('tab-context', {
      tabId: id,
      index,
      tabCount: tabs.value.length,
      canCloseLeft: index > 0,
      canCloseRight: index >= 0 && index < tabs.value.length - 1,
      x: tabContextMenu.x,
      y: tabContextMenu.y
    })
    tabContextMenu.tabId = id
    tabContextMenu.visible = opened
    return
  }
  const nativeMenu = window.electronAPI?.desktopTabMenu?.open
  if (isElectronRuntime()) {
    if (!nativeMenu) {
      console.warn('[desktop-shell] native tab menu API is unavailable')
      return
    }
    closeContextMenus()
    try {
      const action = await nativeMenu({
        tabId: id,
        index,
        tabCount: tabs.value.length,
        theme: theme.value
      })
      if (action) chooseTabContextAction(action, id)
    } catch (error) {
      console.warn('[desktop-shell] failed to open native tab menu:', error)
    }
    return
  }

  setContextMenuPosition(tabContextMenu, event, event.currentTarget?.getBoundingClientRect(), TAB_CONTEXT_MENU_WIDTH, TAB_CONTEXT_MENU_HEIGHT)
  closeHomeContextMenu()
  tabContextMenu.tabId = id
  tabContextMenu.visible = true
}

function closeHomeContextMenu() {
  homeContextMenu.visible = false
}

function closeTabContextMenu() {
  tabContextMenu.visible = false
  tabContextMenu.tabId = ''
}

function closeContextMenus() {
  closeHomeContextMenu()
  closeTabContextMenu()
}

function chooseHomeContextAction(action) {
  closeContextMenus()
  if (action === 'open-requirement-board') openRequirementBoard()
  else if (action === 'open-onboarding') void openOnboarding()
  else if (action === 'open-update') void openUpdateWindow()
  else if (action === 'toggle-theme') toggleTheme()
}

function hasTabsToClose(side) {
  const index = tabs.value.findIndex((tab) => tab.id === tabContextMenu.tabId)
  return side === 'left' ? index > 0 : index >= 0 && index < tabs.value.length - 1
}

function chooseTabContextAction(action, id = tabContextMenu.tabId) {
  closeContextMenus()
  if (!id) return
  if (action === 'reload') void reloadTab(id)
  else if (action === 'close') void closeTab(id)
  else if (action === 'close-left') void closeTabsToSide(id, 'left')
  else if (action === 'close-right') void closeTabsToSide(id, 'right')
}

function onWindowClick() {
  closeContextMenus()
}

function onWindowKeydown(event) {
  if (event.key === 'Escape') closeContextMenus()
}

async function showHome() {
  closeContextMenus()
  const returnTabId = settingsReturnTabId.value
  settingsReturnTabId.value = ''
  hideStandaloneViews()
  activeTabId.value = returnTabId && tabs.value.some((tab) => tab.id === returnTabId) ? returnTabId : ''
  await renderActiveTab()
}

async function openSkills() {
  hideStandaloneViews()
  showSkills.value = true
  activeTabId.value = ''
  await renderActiveTab()
}

function openRequirementBoard() {
  // 桌面端：打开独立 BrowserWindow；Web 端：新标签页打开看板
  if (window.electronAPI?.requirementBoardWindow?.open) {
    window.electronAPI.requirementBoardWindow.open().catch((error) => {
      message.error('打开需求池失败：' + (error.message || '未知错误'))
    })
  } else {
    window.open(`${window.location.pathname}?requirementBoard=1`, '_blank')
  }
}

async function openTools() {
  await openSettings('tools')
}

async function openSubAgents() {
  await openSettings('sub-agents')
}

async function openSettings(tab = 'general') {
  if (!showSettings.value) settingsReturnTabId.value = activeTabId.value
  settingsTab.value = tab
  hideStandaloneViews()
  showSettings.value = true
  activeTabId.value = ''
  await renderActiveTab()
}

async function openModelChannels({requireReload = false} = {}) {
  modelChannelsRequireReload.value = requireReload
  hideStandaloneViews()
  showModelChannels.value = true
  activeTabId.value = ''
  await renderActiveTab()
}

// 终端面板：转发给当前会话 tab 控制（与会话绑定、收起不销毁）
async function toggleTerminal() {
  if (!activeTabId.value) return
  try {
    await nativeTabs()?.toggleTerminal(activeTabId.value)
  } catch (error) {
    message.error('切换终端失败：' + (error.message || '未知错误'))
  }
}

async function openFileSearch() {
  if (!activeTabId.value) {
    message.info('请先打开一个会话')
    return
  }
  try {
    await nativeTabs()?.toggleFilePanel?.(activeTabId.value)
  } catch (error) {
    message.error('打开文件面板失败：' + (error.message || '未知错误'))
  }
}

function handleDesktopSearchAction(action = {}) {
  if (action.type === 'session') {
    void openSession(action)
    return
  }
  if (action.type !== 'action') return
  if (action.id === 'new-session') void createTab()
  else if (action.id === 'add-workspace') void addWorkspaceFromFolder()
  else if (action.id === 'open-file-search') void openFileSearch()
}

async function openDesktopNativePopup(type, payload = {}) {
  const popup = window.electronAPI?.desktopPopup
  if (!popup?.open) return false
  try {
    const response = await popup.open(toPlainIpcValue({type, theme: theme.value, ...payload}))
    return response?.success !== false
  } catch (error) {
    console.warn('[desktop-shell] failed to open native popup:', error)
    return false
  }
}

function handleDesktopPopupAction(action = {}) {
  if (action.type === 'home-context') {
    chooseHomeContextAction(action.action)
    return
  }
  if (action.type === 'tab-context') {
    chooseTabContextAction(action.action, action.tabId)
    return
  }
  if (action.type !== 'confirm') return
  const kind = action.kind || deleteConfirm.value.kind
  // 原生 WebContentsView 回传时 payload 可能被规范化为 null；此时仍使用
  // 主窗口里保留的确认对象，避免点击“删除”后没有目标可执行。
  const payload = action.payload == null ? deleteConfirm.value.payload : action.payload
  dismissDeleteConfirm({notify: false})
  if (action.action === 'confirm') runDeleteConfirmAction(kind, payload)
}

// 搜索使用独立的原生 WebContentsView，和聊天视图处在同一个 contentView 层级。
async function handleSearchVisibilityChange(visible) {
  const search = window.electronAPI?.desktopSearch
  if (!search) return
  try {
    if (visible) {
      const activeTab = tabs.value.find((tab) => tab.id === activeTabId.value)
      await search.open({
        activeSessionName: activeTab?.sessionName || '',
        activeWorkspaceHash: activeTab?.workspaceHash || activeWorkspaceHash.value,
        theme: theme.value
      })
    } else {
      await search.close()
    }
  } catch (error) {
    console.warn('[desktop-shell] failed to toggle native search overlay:', error)
  }
}

function hideStandaloneViews() {
  closeContextMenus()
  showSkills.value = false
  showSettings.value = false
  showModelChannels.value = false
}

function toggleTheme() {
  // 中心扩散动画：动画完成后再真正切换主题
  switchThemeWithReveal(theme.value === 'dark' ? 'gray' : 'dark', (v) => { store.settings.theme = v })
}

async function openElementInspector() {
  try {
    await window.electronAPI?.elementInspectorWindow?.open()
  } catch (error) {
    message.error('打开元素检查失败：' + (error.message || '未知错误'))
  }
}

async function openOnboarding() {
  try {
    await window.electronAPI?.onboarding?.open()
  } catch (error) {
    message.error('打开引导失败：' + (error.message || '未知错误'))
  }
}

async function toggleRightPanel() {
  if (!activeTabId.value) return
  try {
    await nativeTabs()?.toggleRightPanel(activeTabId.value)
  } catch (error) {
    message.error('切换右侧栏失败：' + (error.message || '未知错误'))
  }
}

async function activateTab(id) {
  if (id === activeTabId.value) return
  const tab = tabs.value.find((item) => item.id === id)
  if (!tab) return
  try {
    hideStandaloneViews()
    await selectWorkspace(tab.workspaceHash)
    activeTabId.value = id
    await renderActiveTab()
  } catch (error) {
    message.error('切换会话失败：' + (error.message || '未知错误'))
  }
}

async function closeTab(id) {
  const index = tabs.value.findIndex((tab) => tab.id === id)
  if (index < 0) return
  try { await nativeTabs()?.close(id) } catch (error) { console.warn('[desktop-shell] failed to close tab:', error) }
  const remaining = tabs.value.filter((tab) => tab.id !== id)
  const wasActive = activeTabId.value === id
  tabs.value = remaining
  if (wasActive) activeTabId.value = remaining[Math.min(index, remaining.length - 1)]?.id || ''
  await renderActiveTab()
}

async function reloadTab(id) {
  try {
    await nativeTabs()?.reload(id)
  } catch (error) {
    message.error('刷新会话失败：' + (error.message || '未知错误'))
  }
}

async function closeTabsToSide(id, side) {
  const index = tabs.value.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const removedTabs = tabs.value.filter((_, tabIndex) => side === 'left' ? tabIndex < index : tabIndex > index)
  if (!removedTabs.length) return
  await Promise.all(removedTabs.map(async (tab) => {
    try {
      await nativeTabs()?.close(tab.id)
    } catch (error) {
      console.warn('[desktop-shell] failed to close tab:', error)
    }
  }))
  const removedIds = new Set(removedTabs.map((tab) => tab.id))
  tabs.value = tabs.value.filter((tab) => !removedIds.has(tab.id))
  const activeWasRemoved = removedIds.has(activeTabId.value)
  if (activeWasRemoved) activeTabId.value = id
  if (activeWasRemoved) await renderActiveTab()
}

async function closeWorkspaceTabs(workspaceHash) {
  const removedTabs = tabs.value.filter((tab) => tab.workspaceHash === workspaceHash)
  if (!removedTabs.length) return
  await Promise.all(removedTabs.map(async (tab) => {
    try {
      await nativeTabs()?.close(tab.id)
    } catch (error) {
      console.warn('[desktop-shell] failed to close tab:', error)
    }
  }))
  const removedIds = new Set(removedTabs.map((tab) => tab.id))
  tabs.value = tabs.value.filter((tab) => !removedIds.has(tab.id))
  if (removedIds.has(activeTabId.value)) activeTabId.value = tabs.value[0]?.id || ''
  await renderActiveTab()
}

// 删除/清空确认对话框（系统统一 ActionConfirmDialog）
const deleteConfirm = ref({ visible: false, kind: '', title: '', message: '', payload: null })
const deleteConfirmActions = computed(() => {
  const okLabel = deleteConfirm.value.kind === 'deleteWorkspace' || deleteConfirm.value.kind === 'deleteWorkspaces' ? '删除项目'
    : deleteConfirm.value.kind === 'clearWorkspace' || deleteConfirm.value.kind === 'clearOldSessions' ? '清空'
    : '删除'
  return [
    { key: 'cancel', label: '取消' },
    { key: 'confirm', label: okLabel, variant: 'danger' }
  ]
})
const openDeleteConfirm = (kind, title, message, payload) => {
  deleteConfirm.value = { visible: true, kind, title, message, payload }
  if (popupUsesNativeOverlay.value) {
    void openDesktopNativePopup('confirm', {
      kind,
      title,
      message,
      actions: deleteConfirmActions.value,
      payload
    })
  }
}
const dismissDeleteConfirm = (options = {}) => {
  const wasVisible = deleteConfirm.value.visible
  deleteConfirm.value.visible = false
  deleteConfirm.value.payload = null
  if (wasVisible && options?.notify !== false && popupUsesNativeOverlay.value) {
    void window.electronAPI?.desktopPopup?.close?.()
  }
}
function runDeleteConfirmAction(kind, payload) {
  if (kind === 'session') void performDeleteSession(payload)
  else if (kind === 'sessions') void performDeleteSessions(payload)
  else if (kind === 'clearWorkspace') void performClearWorkspace(payload)
  else if (kind === 'clearOldSessions') void performClearOldSessions(payload)
  else if (kind === 'deleteWorkspace') void performDeleteWorkspace(payload)
  else if (kind === 'deleteWorkspaces') void performDeleteWorkspaces(payload)
}
const handleDeleteConfirmAction = (action) => {
  if (action !== 'confirm') return dismissDeleteConfirm()
  const { kind, payload } = deleteConfirm.value
  dismissDeleteConfirm()
  runDeleteConfirmAction(kind, payload)
}

function onSessionRenamed({ workspaceHash, sessionName, title }) {
  if (!sessionName || !title) return
  // 同步已打开标签页的标题，保持与列表一致
  tabs.value = tabs.value.map((tab) =>
    tab.sessionName === sessionName && tab.workspaceHash === workspaceHash ? { ...tab, title } : tab
  )
}

function confirmDeleteSession(session) {
  const title = session?.title || session?.name || '此会话'
  openDeleteConfirm('session', '删除会话？', `“${title}”将被永久删除，无法恢复。`, session)
}

async function performDeleteSession(session) {
  try {
    const response = await sessionsAPI.deleteSession(session.name, session.workspaceHash)
    if (!response.success) throw new Error(response.message || '删除会话失败')
    await closeTab(tabId(session.workspaceHash, session.name))
    homeRefreshKey.value++
    message.success('会话已删除')
  } catch (error) {
    message.error('删除会话失败：' + (error.message || '未知错误'))
  }
}

function confirmDeleteSessions(sessions) {
  const list = sessions || []
  const names = list.map((session) => `“${session.title || session.name}”`)
  const brief = names.length > 3 ? `选中的 ${names.length} 个会话（${names.slice(0, 3).join('、')} 等）` : names.join('、')
  openDeleteConfirm('sessions', '删除会话？', `${brief}将被永久删除，无法恢复。`, list)
}

async function performDeleteSessions(sessions) {
  const deleted = []
  const failed = []
  for (const session of sessions || []) {
    try {
      const response = await sessionsAPI.deleteSession(session.name, session.workspaceHash)
      if (response.success) deleted.push(session)
      else failed.push(session.title || session.name)
    } catch (error) {
      console.warn('[desktop-shell] failed to delete session:', session.name, error)
      failed.push(session.title || session.name)
    }
  }
  if (deleted.length) {
    // 关闭仍打开着但已被删除的会话标签
    await Promise.all(deleted.map(async (session) => {
      try { await closeTab(tabId(session.workspaceHash, session.name)) } catch (error) { console.warn('[desktop-shell] failed to close deleted session tab:', error) }
    }))
    homeRefreshKey.value++
  }
  if (deleted.length && !failed.length) {
    message.success(`已删除 ${deleted.length} 个会话`)
  } else if (deleted.length) {
    message.warning(`已删除 ${deleted.length} 个会话，${failed.length} 个失败：${failed.join('、')}`)
  } else {
    message.error(`删除失败：${failed.join('、')}`)
  }
}

function confirmClearWorkspace(workspace) {
  openDeleteConfirm('clearWorkspace', '清空项目会话？', `“${workspace.name}”中的全部会话将被永久删除，无法恢复。`, workspace)
}

async function performClearWorkspace(workspace) {
  try {
    const response = await sessionsAPI.clearAll(workspace.hash)
    if (!response.success) throw new Error(response.message || '清空会话失败')
    await closeWorkspaceTabs(workspace.hash)
    homeRefreshKey.value++
    message.success('项目会话已清空')
  } catch (error) {
    message.error('清空会话失败：' + (error.message || '未知错误'))
  }
}

function confirmClearOldSessions(workspace) {
  openDeleteConfirm('clearOldSessions', '清空三天前的会话？', `“${workspace.name}”中超过 3 天未活动的会话将被永久删除，无法恢复。`, workspace)
}

async function performClearOldSessions(workspace) {
  try {
    const before = Date.now() - 3 * 24 * 60 * 60 * 1000
    const response = await sessionsAPI.clearBefore(workspace.hash, before)
    if (!response.success) throw new Error(response.message || '清理会话失败')
    const deletedNames = new Set(response.data?.sessionNames || [])
    // 关闭仍打开着但已被删除的会话标签
    if (deletedNames.size) {
      const removedTabs = tabs.value.filter((tab) => tab.workspaceHash === workspace.hash && deletedNames.has(tab.sessionName))
      await Promise.all(removedTabs.map(async (tab) => {
        try { await nativeTabs()?.close(tab.id) } catch (error) { console.warn('[desktop-shell] failed to close tab:', error) }
      }))
      const removedIds = new Set(removedTabs.map((tab) => tab.id))
      tabs.value = tabs.value.filter((tab) => !removedIds.has(tab.id))
      if (removedIds.has(activeTabId.value)) activeTabId.value = tabs.value[0]?.id || ''
      await renderActiveTab()
    }
    homeRefreshKey.value++
    message.success(deletedNames.size ? `已清理 ${deletedNames.size} 个三天前的会话` : '没有需要清理的会话')
  } catch (error) {
    message.error('清理会话失败：' + (error.message || '未知错误'))
  }
}

function confirmDeleteWorkspace(workspace) {
  openDeleteConfirm('deleteWorkspace', '删除项目？', `“${workspace.name}”将从项目列表移除；项目文件不会被删除。`, workspace)
}

async function performDeleteWorkspace(workspace) {
  try {
    const response = await configAPI.deleteWorkspace(workspace.hash)
    if (!response.success) throw new Error(response.message || '删除项目失败')
    await closeWorkspaceTabs(workspace.hash)
    workspaces.value = workspaces.value.filter((item) => item.hash !== workspace.hash)
    if (activeWorkspaceHash.value === workspace.hash) {
      activeWorkspaceHash.value = ''
      if (workspaces.value[0]) await selectWorkspace(workspaces.value[0].hash)
    }
    homeRefreshKey.value++
    message.success('项目已删除')
  } catch (error) {
    message.error('删除项目失败：' + (error.message || '未知错误'))
  }
}

function confirmDeleteWorkspaces(workspaces) {
  const list = workspaces || []
  const names = list.map((workspace) => `“${workspace.name}”`)
  const brief = names.length > 3 ? `选中的 ${names.length} 个项目（${names.slice(0, 3).join('、')} 等）` : names.join('、')
  openDeleteConfirm('deleteWorkspaces', '删除项目？', `${brief}将从项目列表移除；项目文件不会被删除。`, list)
}

async function performDeleteWorkspaces(workspaceList) {
  const deleted = []
  const failed = []
  for (const workspace of workspaceList || []) {
    try {
      const response = await configAPI.deleteWorkspace(workspace.hash)
      if (response.success) deleted.push(workspace)
      else failed.push(workspace.name)
    } catch (error) {
      console.warn('[desktop-shell] failed to delete workspace:', workspace.hash, error)
      failed.push(workspace.name)
    }
  }
  if (deleted.length) {
    await Promise.all(deleted.map((workspace) => closeWorkspaceTabs(workspace.hash)))
    const removed = new Set(deleted.map((workspace) => workspace.hash))
    workspaces.value = workspaces.value.filter((workspace) => !removed.has(workspace.hash))
    if (deleted.some((workspace) => workspace.hash === activeWorkspaceHash.value)) {
      activeWorkspaceHash.value = ''
      if (workspaces.value[0]) await selectWorkspace(workspaces.value[0].hash)
    }
    homeRefreshKey.value++
  }
  if (deleted.length && !failed.length) {
    message.success(`已删除 ${deleted.length} 个项目`)
  } else if (deleted.length) {
    message.warning(`已删除 ${deleted.length} 个项目，${failed.length} 个失败：${failed.join('、')}`)
  } else {
    message.error(`删除失败：${failed.join('、')}`)
  }
}

onMounted(() => {
  // 服务已由启动窗口（SplashScreen）完成检测/安装/启动，主窗口直接初始化
  resizeObserver = new ResizeObserver(() => { void renderActiveTab() })
  if (host.value) resizeObserver.observe(host.value)
  window.addEventListener('resize', onSidebarViewportResize)
  startAiBrowserBridgeKeepalive()
  // 启动后立即检查更新，并开启定时检查
  void checkForUpdates()
  updateCheckTimer = setInterval(() => { void checkForUpdates() }, UPDATE_CHECK_INTERVAL)
  window.addEventListener('click', onWindowClick)
  window.addEventListener('keydown', onWindowKeydown)
  void (async () => {
    if (await redirectToModelChannelsWhenUnconfigured()) return
    // 桌面端打开后直接进入新建对话页，避免用户还要从欢迎页再点一次“新建会话”。
    if (await initializeWorkspace()) await createTab()
  })()
  // 首次运行（未完成过引导）自动打开引导窗口；失败静默，不阻塞主界面
  if (platform.isElectron && !localStorage.getItem('loopra-onboarding-done')) {
    setTimeout(() => { void openOnboarding() }, 1200)
  }
})

async function redirectToModelChannelsWhenUnconfigured() {
  try {
    const response = await configAPI.getConfig()
    if (response.success && !hasConfiguredModelChannel(response.data)) {
      await openModelChannels({requireReload: true})
      return true
    }
  } catch (error) {
    console.warn('[desktop-shell] failed to load model channels:', error)
  }
  return false
}

function reloadAfterModelChannelsSaved() {
  if (modelChannelsRequireReload.value) {
    window.location.reload()
    return
  }
  modelChannelsRequireReload.value = false
}

onBeforeUnmount(() => {
  stopSidebarResize?.()
  resizeObserver?.disconnect()
  stopAiBrowserBridgeKeepalive()
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
  window.removeEventListener('click', onWindowClick)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('resize', onSidebarViewportResize)
  stopTitleListener?.()
  stopWorkspaceListener?.()
  stopOpenHomeListener?.()
  stopOpenSettingsListener?.()
  stopChatUpdateListener?.()
  stopSearchActionListener?.()
  stopPopupActionListener?.()
  stopPopupClosedListener?.()
  stopNativeSidebarResizeMoveListener?.()
  stopNativeSidebarResizeEndListener?.()
  void nativeTabs()?.hide()
})
</script>

<style scoped>
.desktop-shell { width: 100vw; height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: var(--bg, #fbfbfc); color: var(--fg, #27272a); }
.desktop-titlebar {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  height: env(titlebar-area-height, 36px);
  min-height: 36px;
  padding: 0 12px;
  left: env(titlebar-area-x, 0);
  width: env(titlebar-area-width, 100%);
  box-sizing: border-box;
  -webkit-app-region: drag;
  background: var(--desktop-sidebar, #f1f1ef);
}
.desktop-titlebar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--desktop-muted, #969692);
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background-color .15s ease, color .15s ease;
}
.desktop-titlebar-button svg { width: 17px; height: 17px; }
.desktop-titlebar-button:hover,
.desktop-titlebar-button.active { color: var(--desktop-ink, #343432); }
.desktop-titlebar-button:hover,
.desktop-titlebar-button:focus-visible { background: var(--desktop-hover, #e7e7e5); outline: 0; }
.desktop-workbench { position: relative; }
.desktop-shell .desktop-workbench.settings-mode > .desktop-view-host {
  border-radius: 0;
}
.desktop-shell .desktop-workbench > .desktop-home {
  max-width: var(--desktop-sidebar-width, 280px);
  will-change: flex-basis, width, max-width, opacity, transform;
  transition: flex-basis .24s ease, width .24s ease, max-width .24s ease, opacity .18s ease, transform .24s ease;
}
.desktop-shell .desktop-workbench.sidebar-resizing > .desktop-home { transition: none; }
.desktop-shell .desktop-workbench.sidebar-collapsed > .desktop-home {
  flex: 0 0 0;
  width: 0;
  max-width: 0;
  min-width: 0;
  padding: 0;
  margin: 0;
  border-width: 0;
  overflow: hidden;
  opacity: 0;
  transform: translateX(-12px);
  pointer-events: none;
}
.desktop-sidebar-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  /* 整个热区留在主页面侧栏内，避免右半边被原生会话视图盖住。 */
  left: calc(var(--desktop-sidebar-width, 280px) - 12px);
  z-index: 30;
  width: 12px;
  cursor: ew-resize;
  outline: 0;
  -webkit-app-region: no-drag;
  user-select: none;
}
.desktop-sidebar-resize-handle::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 10.5px;
  width: 1px;
  background: transparent;
  content: '';
  transition: background-color .15s ease;
}
.desktop-sidebar-resize-handle:hover::after,
.desktop-sidebar-resize-handle.dragging::after,
.desktop-sidebar-resize-handle:focus-visible::after {
  background: color-mix(in srgb, var(--desktop-ink, #343432) 32%, transparent);
}
.desktop-sidebar-resize-handle:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--desktop-ink, #343432) 18%, transparent);
}
.desktop-shell .desktop-workbench.sidebar-collapsed > .desktop-sidebar-resize-handle {
  /* 收起态不再作为 flex 子项占位；通过顶部侧栏按钮重新展开。 */
  position: absolute;
  top: auto;
  right: auto;
  bottom: 0;
  left: 0;
  width: 0;
  height: 100%;
  flex: 0 0 0;
  pointer-events: none;
}
.desktop-shell .desktop-workbench.sidebar-collapsed > .desktop-sidebar-resize-handle::after { display: none; }
.desktop-sidebar-header-actions { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; }
.desktop-sidebar-header-button { position: relative; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--desktop-muted, #969692); cursor: pointer; transition: background-color .15s ease, color .15s ease; -webkit-app-region: no-drag; }
.desktop-sidebar-header-button:hover, .desktop-sidebar-header-button[aria-expanded="true"] { background: var(--desktop-hover, #e7e7e5); color: var(--desktop-ink, #343432); }
.desktop-sidebar-header-button svg { width: 18px; height: 18px; }
.desktop-notification-button.has-update { color: #c2413b; }
.desktop-notification-button.has-update:hover { color: #b42318; }
.desktop-update-dot { position: absolute; top: 6px; right: 6px; width: 5px; height: 5px; border-radius: 50%; background: #ef4444; }
.icon-button, .desktop-tab, .desktop-tab-add { border: 0; background: transparent; color: var(--fg-3, #71717a); }
.icon-button { width: 32px; height: 32px; padding: 6px; border-radius: 8px; transition: background-color var(--t), color var(--t); }
.icon-button svg, .desktop-tab svg, .desktop-tab-add svg { width: 18px; height: 18px; }
.icon-button:hover, .icon-button.active, .desktop-tab-add:hover { background: var(--bg-hover, #f6f6f7); color: var(--fg, #27272a); }
.desktop-tabs { height: 100%; display: flex; align-items: center; gap: 4px; min-width: 80px; flex: 1; overflow-x: auto; padding: 0 18px 0 8px; scrollbar-width: none; }
.desktop-tab.dragging { opacity: 0.55; }
.desktop-tab.drag-over { background: var(--bg-hover, #f6f6f7); box-shadow: inset 0 0 0 1px var(--border, #e8e8eb); }
.desktop-tabs::-webkit-scrollbar { display: none; }
.desktop-tab { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 10px; border-radius: 8px; cursor: pointer; flex: 0 1 16vw; min-width: 96px; max-width: 230px; text-align: left; container-type: inline-size; transition: background-color var(--t), color var(--t); }
.desktop-tab:hover { background: var(--bg-hover, #f6f6f7); color: var(--fg, #27272a); }
.desktop-tab.active { background: var(--bg-active, #f1f1f3); color: var(--fg, #27272a); }
.desktop-tab.active .desktop-tab-title { font-weight: 500; }
.desktop-tab-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1 1 auto; min-width: 0; font-size: var(--font-ui-size, 14px); font-weight: 400; }
.desktop-tab-monogram { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; border-radius: 4px; color: #fff; font-size: 10px; font-weight: 700; line-height: 1; text-shadow: 0 1px rgba(0, 0, 0, 0.25); box-shadow: inset 0 1px rgba(255, 255, 255, 0.25), 0 1px 1px rgba(0, 0, 0, 0.16); }
.desktop-tab-monogram.tone-0 { background: linear-gradient(135deg, #8b95a3, #5e6878); }
.desktop-tab-monogram.tone-1 { background: linear-gradient(135deg, #3dd0e8, #18b4d0); }
.desktop-tab-monogram.tone-2 { background: linear-gradient(135deg, #ffa86b, #ff7a3d); }
.desktop-tab-monogram.tone-3 { background: linear-gradient(135deg, #9aacf5, #6d80e8); }
.desktop-tab-monogram.tone-4 { background: linear-gradient(135deg, #6dd49d, #3eb878); }
.desktop-tab-monogram.tone-5 { background: linear-gradient(135deg, #f87fb5, #e85a9c); }
.desktop-tab-monogram.tone-6 { background: linear-gradient(135deg, #fcd34d, #f5b800); }
.desktop-tab-monogram.tone-7 { background: linear-gradient(135deg, #4dd9a6, #20c084); }
.desktop-tab-monogram-default { background: var(--bg-3, #f3f4f6); color: var(--fg-3, #9ca3af); box-shadow: none; text-shadow: none; }
.desktop-tab-monogram-default svg { width: 12px; height: 12px; }

.desktop-tab-add { display: inline-flex; width: 32px; height: 32px; align-items: center; justify-content: center; border-radius: 8px; flex: 0 0 auto; cursor: pointer; transition: background-color var(--t), color var(--t); }
.update-spinner { animation: update-spin 0.9s linear infinite; }
@keyframes update-spin { to { transform: rotate(360deg); } }
.close-mark { width: 14px; height: 14px; position: relative; }
.close-mark::before, .close-mark::after { content: ''; position: absolute; top: 6px; left: 0; width: 14px; border-top: 1.5px solid currentColor; transform: rotate(45deg); }
.close-mark::after { transform: rotate(-45deg); }
.desktop-view-host { position: relative; flex: 1; min-width: 0; min-height: 0; background: var(--bg, #fff); }
.desktop-session-loading { position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; background: var(--desktop-paper, var(--bg, #fff)); color: var(--desktop-muted, var(--fg-3, #8b8b87)); font-size: var(--font-ui-size, 14px); letter-spacing: .02em; }
.desktop-session-loading-spinner { width: 28px; height: 28px; box-sizing: border-box; border: 2px solid color-mix(in srgb, currentColor 22%, transparent); border-top-color: currentColor; border-radius: 50%; animation: desktop-session-loading-spin .75s linear infinite; }
@keyframes desktop-session-loading-spin { to { transform: rotate(360deg); } }
.desktop-settings { height: 100%; min-height: 0; overflow: hidden; }
.desktop-empty { height: 100%; display: grid; place-items: center; color: var(--fg-4, #9ca3af); font-size: var(--font-ui-size, 14px); }
.desktop-error { align-content: center; gap: 12px; }
.desktop-error button { justify-self: center; border: 1px solid var(--border, #e5e7eb); border-radius: 5px; background: var(--bg, #fff); color: var(--fg, #202124); padding: 6px 14px; cursor: pointer; }
.desktop-error button:hover { background: var(--bg-3, #f3f4f6); }
.desktop-shell-context-menu, .desktop-tab-context-menu { box-sizing: border-box; position: fixed; z-index: 1000; padding: 4px; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; background: var(--bg, #fff); box-shadow: var(--shadow-lg, 0 10px 28px rgba(0, 0, 0, 0.16)); }
.desktop-shell-context-menu { width: 176px; }
.desktop-tab-context-menu { width: 188px; }
.desktop-shell-context-menu button, .desktop-tab-context-menu button { width: 100%; height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent; color: var(--fg-2, #525866); font: inherit; font-size: var(--font-ui-size, 14px); text-align: left; cursor: pointer; }
.desktop-shell-context-menu button:hover, .desktop-shell-context-menu button:focus-visible, .desktop-tab-context-menu button:hover, .desktop-tab-context-menu button:focus-visible { color: var(--fg, #202124); background: var(--bg-3, #f2f3f5); outline: 0; }
.desktop-tab-context-menu button:disabled { opacity: 0.45; cursor: default; }
.desktop-shell-context-menu svg, .desktop-tab-context-menu svg { width: 15px; height: 15px; flex: 0 0 auto; }
</style>
