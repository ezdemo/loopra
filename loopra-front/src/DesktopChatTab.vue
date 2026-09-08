<template>
  <main class="desktop-chat-tab" :data-theme="theme">
    <!-- 会话进行中的波动条：横跨两侧边栏之上 -->
    <div v-if="sessionActive" class="desktop-streaming-bar">
      <div class="desktop-streaming-bar-inner"></div>
    </div>
    <div
      v-if="globalLoading"
      class="desktop-chat-global-loading"
      role="status"
      aria-live="polite"
      aria-label="正在加载会话"
    >
      <span class="desktop-chat-global-loading-spinner" aria-hidden="true"></span>
      <span>正在加载会话…</span>
    </div>
    <aside
      class="desktop-files-left"
      :class="{ collapsed: !leftPanelOpen }"
      :style="leftPanelOpen ? { width: `${leftPanelWidth}px`, transition: leftPanelDragging ? 'none' : undefined } : null"
      :aria-label="leftPanelView === 'environment' ? '环境信息' : leftPanelView === 'sub-agents' ? '子代理' : leftPanelView === 'project-capabilities' ? '项目能力' : '项目文件'"
    >
      <FileExplorer
        v-if="filePanelMounted"
        v-show="leftPanelView === 'files'"
        ref="fileExplorerRef"
        :root-path="activeWorkspacePath"
        :workspace-hash="workspaceHash"
        @add-to-session="addFileToSession"
        @open-file="openFileTab"
        @file-deleted="onFileDeleted"
        @file-renamed="onFileRenamed"
      />
      <EnvironmentPanel
        v-if="environmentPanelMounted"
        v-show="leftPanelView === 'environment'"
        ref="environmentPanelRef"
        :workspace-hash="workspaceHash || ''"
        :session-name="sessionName"
        @mode-change="welcomeWorktreeMode = $event"
        @close="leftPanelOpen = false"
      />
      <SubAgentPanel
        v-if="subAgentPanelMounted"
        v-show="leftPanelView === 'sub-agents'"
        ref="subAgentPanelRef"
        :workspace-hash="workspaceHash"
        :session-name="sessionName"
        @open="openSubAgentTab"
        @removed="onSubAgentRemoved"
      />
      <ProjectCapabilitiesPanel
        v-if="projectCapabilitiesPanelMounted"
        v-show="leftPanelView === 'project-capabilities'"
        ref="projectCapabilitiesPanelRef"
        :workspace-hash="workspaceHash"
        :workspace-name="activeWorkspaceName"
      />
      <div
        class="desktop-files-resize-handle"
        :class="{ dragging: leftPanelDragging }"
        title="拖动调整左侧面板宽度"
        aria-hidden="true"
        @mousedown.prevent="startLeftPanelResize"
      />
    </aside>
    <div class="desktop-chat-area">
      <header class="desktop-chat-header">
        <div class="desktop-chat-header-leading">
          <span class="desktop-chat-header-folder" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4.2l1.9 2h5.4A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/></svg>
          </span>
          <span class="desktop-chat-header-title" :title="chatHeaderTitle">{{ chatHeaderTitle }}</span>
          <button
            type="button"
            class="desktop-chat-header-menu-trigger"
            title="会话菜单"
            aria-label="会话菜单"
            aria-haspopup="menu"
            :aria-expanded="chatHeaderMenuOpen"
            @click.stop="openChatHeaderMenu"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
          </button>
        </div>
        <div class="desktop-chat-header-actions" aria-label="聊天工具栏">
          <button
            type="button"
            class="desktop-chat-header-action"
            title="审查"
            aria-label="审查"
            @click="openElementInspector"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 16.5V21M8 10l2.5 2.5L8 15M13 15h3.5"/></svg>
          </button>
          <button
            type="button"
            class="desktop-chat-header-action"
            :class="{ active: showTerminal }"
            title="终端"
            aria-label="终端"
            @click="toggleTerminalFromHeader"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>
          </button>
          <button
            type="button"
            class="desktop-chat-header-action"
            title="浏览器"
            aria-label="浏览器"
            @click="openAiBrowser"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
          </button>
          <button
            type="button"
            class="desktop-chat-header-action"
            :class="{ active: leftPanelOpen && leftPanelView === 'files' }"
            title="文件"
            aria-label="文件"
            @click="toggleFilePanel"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4.2l1.9 2h5.4A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/></svg>
          </button>
          <button
            type="button"
            class="desktop-chat-header-action"
            :class="{ active: leftPanelOpen && leftPanelView === 'environment', 'environment-attention': environmentAttention }"
            title="环境信息"
            aria-label="环境信息"
            @click="toggleEnvironmentPanel"
            @animationend="environmentAttention = false"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="7" r="2.5"/><circle cx="7.5" cy="17" r="2.5"/><circle cx="17.5" cy="17" r="2.5"/><path d="M7.5 9.5v5M10 7h4a3.5 3.5 0 0 1 3.5 3.5V14.5"/></svg>
          </button>
          <button
            type="button"
            class="desktop-chat-header-action"
            :class="{ active: leftPanelOpen && leftPanelView === 'sub-agents' }"
            title="子代理"
            aria-label="子代理"
            @click="toggleSubAgentPanel"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="6" r="2"/><circle cx="18.5" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M5.5 8v3.5A2.5 2.5 0 0 0 8 14h8a2.5 2.5 0 0 0 2.5-2.5V8"/></svg>
          </button>
          <button
            type="button"
            class="desktop-chat-header-action"
            :class="{ active: leftPanelOpen && leftPanelView === 'project-capabilities' }"
            title="项目能力"
            aria-label="项目能力"
            @click="toggleProjectCapabilitiesFromHeader"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="11" cy="18" r="1.5"/></svg>
          </button>
          <button
            type="button"
            class="desktop-chat-header-action"
            :class="{ active: rightPanelOpen }"
            title="侧边栏"
            aria-label="侧边栏"
            @click="toggleRightPanelFromHeader"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18M7 8h4M7 12h4M7 16h4"/></svg>
          </button>
          <button
            type="button"
            class="desktop-chat-header-action"
            title="引导"
            aria-label="引导"
            @click="openOnboarding"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4V2M15 10V8M11.5 5.5H9.5M20.5 5.5H18.5M17.99 8.5 19.5 10M12.01 8.5 10.5 10"/><path d="m3 21 8-8"/></svg>
          </button>
        </div>
      </header>
      <!-- 编辑器标签栏：Chat 固定第一且不可关闭，文件标签可关闭 -->
      <EditorTabs v-if="fileTabs.length > 0 || subAgentTabs.length > 0" :tabs="editorTabs" :active-id="activeTabId" @set-active="setActiveTab" @close="closeTab" />
      <!-- 内容区：Chat 保活 + 单个 Monaco 实例复用多个文件 model + 子代理回放视图 -->
      <div v-show="activeTabId === CHAT_TAB_ID" class="editor-pane">
        <ChatView
          ref="chatRef"
          class="desktop-chat-view"
          hide-header
          :streaming-bar-hidden="true"
          :workspace-hash="workspaceHash"
          :session-name="sessionName"
          :initially-empty="newSession"
          :right-panel-open="rightPanelOpen"
          :welcome-worktree-mode="welcomeWorktreeMode"
          :environment-switching="environmentSwitching"
          :environment-switch-target="environmentSwitchTarget"
          :workspaces="workspaces"
          @switch-workspace="switchWorkspace"
          @session-updated="refreshTabTitle"
          @session-active-change="sessionActive = $event"
          @initial-load-complete="initialLoading = false"
          @welcome-change="onWelcomeChange"
          @environment-mode-change="setWelcomeEnvironmentMode"
          @manage-workspaces="requestHome"
          @manage-models="requestModelSettings"
          @sub-agent-event="handleSubAgentEvent"
        />
      </div>
      <div v-if="fileTabs.length > 0 || subAgentTabs.length > 0" v-show="activeTabId !== CHAT_TAB_ID" class="editor-pane">
        <FileEditor
          v-show="activeFileTab"
          ref="fileEditorRef"
          :active-file="activeFileTab"
          :workspace-hash="workspaceHash"
          :workspace-path="activeWorkspacePath"
          :theme="theme"
          @saved="onFileSaved"
          @dirty-change="onFileDirtyChange"
          @add-to-session="addFileToSession"
        />
        <ChatView
            v-if="activeSubAgentTab"
            class="desktop-chat-view"
            hide-header
            :streaming-bar-hidden="true"
            :workspace-hash="workspaceHash"
            :session-name="sessionName"
            :sub-agent="activeSubAgentTab"
            @sub-agent-event="handleSubAgentEvent"
        />
      </div>
      <!-- 终端：聊天区底部面板，保留高度拖拽 -->
      <TerminalView v-if="terminalMounted" :open="showTerminal" :cwd="activeWorkspacePath" :theme="theme" @close="showTerminal = false" />
    </div>
    <RightPanel
      v-if="rightPanelMounted"
      :open="rightPanelOpen"
      resizable
      v-model="rightPanelTab"
      :show-files-tab="false"
      :show-git-tab="false"
      :workspace-hash="workspaceHash"
      :session-name="sessionName"
      :sessions="sessions"
      @close="rightPanelOpen = false"
      @add-to-session="addFileToSession"
    />
    <ActionConfirmDialog
      :model-value="closeConfirm.visible"
      title="关闭未保存文件"
      :message="`“${closeConfirm.name}”包含未保存的修改。关闭后，这些修改将丢失。`"
      :actions="closeConfirmActions"
      @update:model-value="dismissCloseConfirm"
      @action="handleCloseConfirmAction"
    />
  </main>
</template>

<script setup>
import {message} from 'ant-design-vue'
import {computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {useAppStore} from './stores/app'
import {configAPI, gitAPI, sessionsAPI, subSessionsAPI} from './services/api'
import {applySubAgentEvent, createSubAgentContainer} from './utils/subAgentBlocks'
import ChatView from './views/Chat.vue'
import EditorTabs from './components/EditorTabs.vue'
import FileEditor from './components/FileEditor.vue'
import ActionConfirmDialog from './components/ActionConfirmDialog.vue'
import ProjectCapabilitiesPanel from './components/ProjectCapabilitiesPanel.vue'
import {fileIconFor} from './utils/fileIcons'
import {applyHighlightTheme} from './utils/highlight'

const EnvironmentPanel = defineAsyncComponent(() => import('./components/EnvironmentPanel.vue'))
const RightPanel = defineAsyncComponent(() => import('./components/RightPanel.vue'))
const TerminalView = defineAsyncComponent(() => import('./components/TerminalView.vue'))
const FileExplorer = defineAsyncComponent(() => import('./components/FileExplorer.vue'))
const SubAgentPanel = defineAsyncComponent(() => import('./components/SubAgentPanel.vue'))

const params = new URLSearchParams(window.location.search)
const sessionName = params.get('sessionName') || ''
const initialSessionTitle = params.get('sessionTitle') || ''
const newSession = params.get('newSession') === '1'
const workspaceHash = ref(params.get('workspaceHash') || null)
const store = useAppStore()
const pageTheme = ref(params.get('theme') === 'dark' ? 'dark' : store.settings.theme)
const theme = computed(() => pageTheme.value)
// 页面主题（dark | gray）同步 Shiki 高亮主题：桌面 Chat Tab 不挂载 App.vue，需自行跟随，否则暗色下代码 token 仍为浅色主题配色
watch(pageTheme, applyHighlightTheme, {immediate: true})
const workspaces = ref([])
const sessions = ref([])
const chatRef = ref(null)
const sessionTitle = ref(initialSessionTitle)
const chatHeaderMenuOpen = ref(false)
const chatHeaderTitle = computed(() => sessionTitle.value || '新对话')
const rightPanelOpen = ref(false)
const rightPanelMounted = ref(false)
const leftPanelOpen = ref(false)
const leftPanelView = ref('files')
const LEFT_PANEL_SIZE_KEY = 'loopra-left-panel-width'
const LEFT_PANEL_DEFAULT_WIDTH = 300
const LEFT_PANEL_MIN_WIDTH = 240
const LEFT_PANEL_MAX_WIDTH_RATIO = 0.34
const savedLeftPanelWidth = Number(localStorage.getItem(LEFT_PANEL_SIZE_KEY))
const leftPanelWidth = ref(Number.isFinite(savedLeftPanelWidth) && savedLeftPanelWidth >= LEFT_PANEL_MIN_WIDTH
  ? savedLeftPanelWidth
  : LEFT_PANEL_DEFAULT_WIDTH)
const leftPanelDragging = ref(false)
const filePanelMounted = ref(false)
const environmentPanelMounted = ref(false)
const subAgentPanelMounted = ref(false)
const subAgentPanelRef = ref(null)
const projectCapabilitiesPanelMounted = ref(false)
const projectCapabilitiesPanelRef = ref(null)
// 子代理回放标签：与文件标签共用编辑器标签栏（id 带 sub: 前缀避免与文件 id 冲突）
const subAgentTabs = ref([]) // [{ id, subSessionId, taskName, status, blocks, loading }]
const activeSubAgentTab = computed(() => subAgentTabs.value.find((tab) => tab.id === activeTabId.value) || null)
const environmentPanelRef = ref(null)
const welcomeWorktreeMode = ref(false)
const environmentSwitching = ref(false)
const environmentSwitchTarget = ref('')
const environmentAttention = ref(false)
const showTerminal = ref(false)
const terminalMounted = ref(false)
const sessionActive = ref(false)
// 会话首次创建 WebContentsView 时，在视图自己的 DOM 中覆盖全局 Loading。
// 主窗口里的普通元素无法盖住原生 WebContentsView，因此切换期间旧视图也会通过 IPC 打开同一遮罩。
// 新会话也先经过同一层遮罩，避免欢迎页、工作区信息和输入区在初始化过程中逐帧变化。
const initialLoading = ref(Boolean(sessionName))
const hostSwitchLoading = ref(false)
const globalLoading = computed(() => initialLoading.value || hostSwitchLoading.value)
const rightPanelTab = ref('schedule')
// 编辑器标签：Chat 固定第一且不可关闭，文件标签可关闭
const CHAT_TAB_ID = 'chat'
const fileExplorerRef = ref(null)
const fileEditorRef = ref(null)
const fileTabs = ref([]) // [{ id, path, name, dirty }]
const activeTabId = ref(CHAT_TAB_ID)
const closeConfirm = ref({visible: false, tabId: '', name: ''})
const closeConfirmActions = [
  {key: 'cancel', label: '取消'},
  {key: 'close', label: '关闭文件', variant: 'danger'}
]
const activeFileTab = computed(() => fileTabs.value.find((tab) => tab.id === activeTabId.value) || null)
let fileTabSeq = 0
// 终端初始工作目录 = 当前项目路径（终端面板与当前会话绑定）
const activeWorkspacePath = computed(() => {
  const workspace = workspaces.value.find((item) => item.hash === workspaceHash.value)
  return workspace?.path || ''
})
const activeWorkspaceName = computed(() => {
  const workspace = workspaces.value.find((item) => item.hash === workspaceHash.value)
  return workspace?.name || ''
})
const tabId = `${workspaceHash.value || ''}:${sessionName}`
let stopRightPanelListener = null
let stopFilePanelListener = null
let stopTerminalListener = null
let stopThemeListener = null
let stopElementInspectionListener = null
let stopRefreshHistoryListener = null
let stopFocusComposerListener = null
let stopSendCommandListener = null
let stopSessionTitleListener = null
let stopGlobalLoadingListener = null
let stopSidebarResizeStartListener = null
let stopSidebarResizeEndListener = null
let stopSidebarResizeRelay = null
let stopLeftPanelResize = null

function finishSidebarResizeRelay(notifyMain = true) {
  const stop = stopSidebarResizeRelay
  stopSidebarResizeRelay = null
  stop?.()
  if (notifyMain) window.electronAPI?.desktopChatTabs?.reportSidebarResizeEnd?.()
}

function startSidebarResizeRelay() {
  finishSidebarResizeRelay(false)
  const previousCursor = document.body.style.cursor
  const previousUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'
  const onMove = (event) => {
    const clientX = Number(event.clientX)
    if (Number.isFinite(clientX)) {
      window.electronAPI?.desktopChatTabs?.reportSidebarResizeMove?.({clientX})
    }
  }
  const onUp = () => finishSidebarResizeRelay(true)
  stopSidebarResizeRelay = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('pointercancel', onUp)
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousUserSelect
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('pointercancel', onUp)
}

function waitForPaint(frames = 2) {
  return new Promise((resolve) => {
    let remaining = Math.max(1, frames)
    let settled = false
    let fallbackTimer = null
    const finish = () => {
      if (settled) return
      settled = true
      if (fallbackTimer) clearTimeout(fallbackTimer)
      resolve()
    }
    const tick = () => {
      if (settled) return
      remaining -= 1
      if (remaining <= 0) {
        finish()
        return
      }
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(tick)
      else setTimeout(tick, 0)
    }
    // 隐藏的 WebContentsView 在部分 Electron 版本中可能暂停 RAF；超时只作
    // 兜底，正常可见帧仍优先通过 RAF 完成确认。
    fallbackTimer = setTimeout(finish, 150)
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(tick)
    else setTimeout(tick, 0)
  })
}

async function signalRendererReady() {
  await nextTick()
  await waitForPaint()
  window.electronAPI?.desktopChatTabs?.ready?.()
}

onMounted(() => {
  // 先注册主进程事件，避免初始化请求期间丢失聚焦或自动发送命令。
  stopRightPanelListener = window.electronAPI?.events?.listen('desktop-chat-tab-toggle-right-panel', toggleRightPanel)
  stopFilePanelListener = window.electronAPI?.events?.listen('desktop-chat-tab-toggle-file-panel', toggleFilePanel)
  stopTerminalListener = window.electronAPI?.events?.listen('desktop-chat-tab-toggle-terminal', toggleTerminal)
  stopThemeListener = window.electronAPI?.events?.listen('desktop-chat-tab-theme', (nextTheme) => {
    const applied = nextTheme === 'dark' ? 'dark' : 'gray'
    // 同步 store 与高亮主题：store 的 theme watcher 会更新 documentElement data-theme 并持久化，避免仅改页面视觉、token 配色滞留旧主题
    store.settings.theme = applied
    pageTheme.value = applied
    document.documentElement.setAttribute('data-theme', applied)
  })
  stopElementInspectionListener = window.electronAPI?.events?.listen('desktop-chat-tab-element-inspection', addElementInspectionToSession)
  stopRefreshHistoryListener = window.electronAPI?.events?.listen('desktop-chat-tab-refresh-history', () => chatRef.value?.refreshHistory())
  stopFocusComposerListener = window.electronAPI?.events?.listen('desktop-chat-tab-focus-composer', () => {
    void chatRef.value?.focusComposer?.()
  })
  // 主窗口（DesktopShell）发来的命令（如「更新核心服务」由 Agent 在聊天框执行）
  stopSendCommandListener = window.electronAPI?.events?.listen('desktop-chat-tab-send-command', (command) => {
    if (command) void chatRef.value?.sendCommand?.(command)
  })
  stopSessionTitleListener = window.electronAPI?.events?.listen('desktop-chat-tab-session-title', (title) => {
    if (title) sessionTitle.value = title
  })
  stopGlobalLoadingListener = window.electronAPI?.events?.listen('desktop-chat-tab-global-loading', (payload) => {
    const loading = typeof payload === 'object' ? payload?.loading === true : payload === true
    hostSwitchLoading.value = loading
    const requestId = typeof payload === 'object' ? payload?.requestId : null
    if (Number.isSafeInteger(requestId)) {
      void (async () => {
        await nextTick()
        await waitForPaint()
        window.electronAPI?.desktopChatTabs?.loadingReady?.(requestId)
      })()
    }
  })
  // 主窗口开始调整左侧栏后，鼠标会进入当前原生 WebContentsView；
  // 在这里继续采集坐标并回传，避免主窗口 renderer 丢失 mousemove。
  stopSidebarResizeStartListener = window.electronAPI?.events?.listen('desktop-shell-sidebar-resize-start', startSidebarResizeRelay)
  stopSidebarResizeEndListener = window.electronAPI?.events?.listen('desktop-shell-sidebar-resize-end', () => {
    finishSidebarResizeRelay(false)
  })
  // Agent 调用 bash_start 时自动展开右侧栏“命令”页签（仅当前 tab 响应）
  window.addEventListener('loopra:bash-start', onBashStart)
  document.documentElement.setAttribute('data-theme', pageTheme.value)
  // `onMounted` 只代表 Vue 已提交 DOM，不代表原生 WebContentsView 已经
  // 绘出首帧；等两帧后再通知主进程，避免 show 后先露出空白/旧 Logo。
  void signalRendererReady()
  void initializeTabContext()
})

async function initializeTabContext() {
  const tasks = [loadWorkspaces()]
  if (!newSession) {
    tasks.push(sessionsAPI.switchSession(sessionName, workspaceHash.value).catch((error) => {
      console.warn('[desktop-chat-tab] failed to synchronize session:', error)
    }))
  }
  await Promise.all(tasks)
  await refreshWelcomeEnvironmentMode()
}

async function loadWorkspaces() {
  try {
    const response = await configAPI.listWorkspaces()
    if (response.success) workspaces.value = response.data || []
  } catch (error) {
    console.error('[desktop-chat-tab] failed to load workspaces:', error)
  }
}

// 活动栏「文件」：在左侧切换文件面板（左右面板可并存，不干扰右侧栏）
function toggleFilePanel() {
  if (leftPanelOpen.value && leftPanelView.value === 'files') {
    leftPanelOpen.value = false
    return
  }
  leftPanelView.value = 'files'
  filePanelMounted.value = true
  leftPanelOpen.value = true
}

// 活动栏「环境信息」：显示当前本地项目或会话隔离分支
function toggleEnvironmentPanel() {
  if (leftPanelOpen.value && leftPanelView.value === 'environment') {
    leftPanelOpen.value = false
    return
  }
  leftPanelView.value = 'environment'
  environmentPanelMounted.value = true
  leftPanelOpen.value = true
}

// 活动栏「子代理」：多标签子代理会话查看窗口（只读回放）
function toggleSubAgentPanel() {
  if (leftPanelOpen.value && leftPanelView.value === 'sub-agents') {
    leftPanelOpen.value = false
    return
  }
  leftPanelView.value = 'sub-agents'
  subAgentPanelMounted.value = true
  leftPanelOpen.value = true
  // 面板已挂载时静默刷新，运行中的子代理会话立即可见
  subAgentPanelRef.value?.refresh?.()
}

// 活动栏「项目能力」：展示当前项目独有的 Skill/MCP
function toggleProjectCapabilitiesPanel() {
  if (leftPanelOpen.value && leftPanelView.value === 'project-capabilities') {
    leftPanelOpen.value = false
    return
  }
  leftPanelView.value = 'project-capabilities'
  projectCapabilitiesPanelMounted.value = true
  leftPanelOpen.value = true
  projectCapabilitiesPanelRef.value?.load?.()
}

async function refreshWelcomeEnvironmentMode() {
  if (!workspaceHash.value || !sessionName) return
  try {
    const response = await gitAPI.environment(workspaceHash.value, sessionName, {silent: true})
    if (response?.success) welcomeWorktreeMode.value = response.data?.mode === 'worktree'
  } catch (error) {
    console.warn('[desktop-chat-tab] failed to read environment mode:', error)
  }
}

async function refreshEnvironmentPanel() {
  await nextTick()
  await environmentPanelRef.value?.refresh?.()
}

function signalEnvironmentAttention() {
  if (leftPanelOpen.value && leftPanelView.value === 'environment') return
  environmentAttention.value = false
  requestAnimationFrame(() => {
    environmentAttention.value = true
  })
}

async function setWelcomeEnvironmentMode(enabled) {
  if (environmentSwitching.value) return
  environmentSwitching.value = true
  environmentSwitchTarget.value = enabled ? 'worktree' : 'local'
  signalEnvironmentAttention()
  try {
    if (!workspaceHash.value || !sessionName) return
    const environmentResponse = await gitAPI.environment(workspaceHash.value, sessionName, {silent: true})
    if (!environmentResponse?.success) throw new Error(environmentResponse?.message || '环境读取失败')
    const environment = environmentResponse.data
    if (environment?.agentRunning) throw new Error('Agent 正在运行，暂不可切换')
    if ((environment?.mode === 'worktree') === enabled) {
      welcomeWorktreeMode.value = enabled
      await refreshEnvironmentPanel()
      return
    }
    if (!enabled && environment?.currentPath) {
      const status = await window.electronAPI?.gitEnvironment?.status?.(environment.currentPath)
      if (status?.dirty) throw new Error('请先提交隔离分支变更')
    }

    const response = await sessionsAPI.setWorktreeMode(sessionName, workspaceHash.value, {worktreeMode: enabled}, {silent: true})
    if (!response?.success) throw new Error(response?.message || '切换失败')
    if (enabled) {
      try {
        const created = await gitAPI.worktreeCreate(workspaceHash.value, sessionName, {silent: true})
        if (!created?.success) throw new Error(created?.message || '隔离分支创建失败')
      } catch (error) {
        await sessionsAPI.setWorktreeMode(sessionName, workspaceHash.value, {worktreeMode: false}, {silent: true}).catch(() => {})
        throw error
      }
    }
    welcomeWorktreeMode.value = enabled
    await refreshEnvironmentPanel()
  } catch (error) {
    message.error(error?.message || '环境切换失败')
    await refreshWelcomeEnvironmentMode()
    await refreshEnvironmentPanel()
  } finally {
    environmentSwitching.value = false
    environmentSwitchTarget.value = ''
  }
}

function toggleRightPanel() {
  if (!rightPanelOpen.value) {
    rightPanelMounted.value = true
    if (sessions.value.length === 0) void loadSessions()
  }
  rightPanelOpen.value = !rightPanelOpen.value
}

// Agent 调用 bash_start 时自动展开右侧栏并切到“命令”页签（仅当前 tab 响应）
function onBashStart(event) {
  const detail = event?.detail || {}
  if (detail.workspaceHash && detail.workspaceHash !== workspaceHash.value) return
  if (detail.sessionName && detail.sessionName !== sessionName) return
  if (!rightPanelOpen.value) {
    rightPanelMounted.value = true
    if (sessions.value.length === 0) void loadSessions()
  }
  rightPanelOpen.value = true
  rightPanelTab.value = 'bash'
}

async function toggleTerminal() {
  if (showTerminal.value) {
    showTerminal.value = false
    return
  }
  if (!activeWorkspacePath.value) await loadWorkspaces()
  if (!activeWorkspacePath.value) {
    message.warning('项目路径尚未加载完成，请稍后重试')
    return
  }
  terminalMounted.value = true
  showTerminal.value = true
}

async function refreshChatFromHeader() {
  await chatRef.value?.refreshHistory?.()
}

function toggleProjectCapabilitiesFromHeader() {
  toggleProjectCapabilitiesPanel()
}

function toggleRightPanelFromHeader() {
  toggleRightPanel()
}

async function toggleTerminalFromHeader() {
  await toggleTerminal()
}

async function openChatHeaderMenu() {
  if (chatHeaderMenuOpen.value) return
  const openNativeMenu = window.electronAPI?.desktopChatHeaderMenu?.open
  if (!openNativeMenu) return
  chatHeaderMenuOpen.value = true
  try {
    const action = await openNativeMenu(theme.value)
    if (action === 'refresh-session') await refreshChatFromHeader()
    else if (action === 'project-capabilities') toggleProjectCapabilitiesFromHeader()
    else if (action === 'terminal') await toggleTerminalFromHeader()
    else if (action === 'sidebar') toggleRightPanelFromHeader()
  } catch (error) {
    message.error('打开会话菜单失败：' + (error?.message || '未知错误'))
  } finally {
    chatHeaderMenuOpen.value = false
  }
}

async function switchWorkspace(nextWorkspaceHash) {
  if (!nextWorkspaceHash || nextWorkspaceHash === workspaceHash.value) return
  const workspace = workspaces.value.find((item) => item.hash === nextWorkspaceHash)
  if (!workspace) {
    message.error('项目不存在')
    return
  }
  try {
    const response = await configAPI.switchWorkspace(workspace.path)
    if (!response.success) throw new Error(response.message || '切换项目失败')
    workspaceHash.value = nextWorkspaceHash
    await loadSessions()
    await refreshTabTitle()
    await refreshWelcomeEnvironmentMode()
  } catch (error) {
    console.error('[desktop-chat-tab] failed to switch workspace:', error)
    message.error('切换项目失败：' + (error.message || '未知错误'))
  }
}

async function refreshTabTitle() {
  if (!workspaceHash.value || !sessionName) return
  try {
    const response = await sessionsAPI.list(workspaceHash.value)
    const session = response.success ? (response.data || []).find((item) => item.name === sessionName) : null
    const title = String(session?.title || '').trim()
    if (title) sessionTitle.value = title
    if (title) window.electronAPI?.desktopChatTabs?.reportTitle({ tabId, title })
  } catch (error) {
    console.warn('[desktop-chat-tab] failed to refresh session title:', error)
  }
}

async function loadSessions() {
  if (!workspaceHash.value) { sessions.value = []; return }
  try {
    const response = await sessionsAPI.list(workspaceHash.value)
    if (response.success) sessions.value = response.data || []
  } catch (error) {
    console.warn('[desktop-chat-tab] failed to load sessions:', error)
  }
}

async function addFileToSession(payload) {
  // 从文件标签添加时先切回对话标签，让文件引用 chip 与输入框可见
  activeTabId.value = CHAT_TAB_ID
  await chatRef.value?.appendFileSelection(payload)
}

// ── 编辑器标签（VS Code 风格：Chat 固定 + 文件/子代理回放可关闭） ──
const editorTabs = computed(() => [
  { id: CHAT_TAB_ID, label: '对话', icon: 'codicon-comment-discussion', closable: false, title: '对话（固定标签）' },
  ...fileTabs.value.map((tab) => ({
    id: tab.id,
    label: tab.name,
    title: tab.path,
    fileIcon: fileIconFor(tab.name),
    dirty: tab.dirty
  })),
  ...subAgentTabs.value.map((tab) => ({
    id: tab.id,
    label: tab.taskName,
    title: tab.taskName,
    icon: 'codicon-branch'
  }))
])

function fileBaseName(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/')
  return parts.pop() || String(path || '')
}

function openFileTab(path) {
  if (!path) return
  const existing = fileTabs.value.find((tab) => tab.path === path)
  if (existing) {
    activeTabId.value = existing.id
    return
  }
  const tab = { id: `file-${++fileTabSeq}`, path, name: fileBaseName(path), dirty: false }
  fileTabs.value.push(tab)
  activeTabId.value = tab.id
}

function setActiveTab(id) {
  activeTabId.value = id
}

function closeTab(id, force = false) {
  const index = fileTabs.value.findIndex((tab) => tab.id === id)
  if (index >= 0) {
    const tab = fileTabs.value[index]
    if (!force && tab.dirty) {
      closeConfirm.value = {visible: true, tabId: tab.id, name: tab.name}
      return
    }
    removeFileTab(index)
    return
  }
  closeSubAgentTab(id)
}

// ── 子代理回放标签（双击子代理列表打开，与文件标签同一套标签栏） ──
const subAgentStatusText = (status) => status === 'completed' ? '已完成'
  : status === 'aborted' ? '已取消'
    : status === 'error' ? '失败'
      : status === 'running' ? '运行中' : (status || '已完成')

async function openSubAgentTab(item) {
  if (!item?.subSessionId) return
  const existing = subAgentTabs.value.find((tab) => tab.subSessionId === item.subSessionId)
  if (existing) {
    activeTabId.value = existing.id
    if (existing.blocks.length === 0) await loadSubAgentEvents(existing)
    return
  }
  const tab = createSubAgentContainer(item.subSessionId, {
    id: `sub:${item.subSessionId}`,
    subSessionId: item.subSessionId,
    taskName: item.task || '子代理',
    status: subAgentStatusText(item.status),
    loading: true
  })
  subAgentTabs.value.push(tab)
  activeTabId.value = tab.id
  // 数组内存储的是响应式代理：后续填充必须经由它修改，ChatView 才能感知更新
  await loadSubAgentEvents(subAgentTabs.value[subAgentTabs.value.length - 1])
}

/** 从事件流重建回放块（历史回放：sub_content 等为完整段，追加语义与实时一致）。 */
async function loadSubAgentEvents(tab) {
  // 调用方可能持有 push 前的原始对象：统一改用数组内的响应式代理再修改
  const target = subAgentTabs.value.find((t) => t.id === tab.id) || tab
  target.loading = true
  // 请求期间实时事件（handleSubAgentEvent）可能已追加到 blocks 尾部：快照保留，避免被覆盖
  const liveTail = target.blocks.slice()
  try {
    const res = await subSessionsAPI.events(target.subSessionId, workspaceHash.value, sessionName)
    if (res?.success && Array.isArray(res.data)) {
      const container = createSubAgentContainer(target.subId)
      for (const evt of res.data) applySubAgentEvent(container, evt)
      // 首个 sub_start 的任务描述以用户气泡展示（仅首次加载时插入一次）
      if (!target.taskBubble) {
        const firstStart = res.data.find((e) => e.type === 'sub_start')
        if (firstStart?.task) {
          container.blocks.unshift({type: 'sub_user', content: firstStart.task})
          target.taskBubble = true
        }
      }
      // REST 落盘段 + 请求期间实时增量（保留尾部，避免丢字）
      target.blocks.splice(0, target.blocks.length, ...container.blocks, ...liveTail)
      target.taskName = container.taskName || target.taskName
      target.status = container.status || target.status
      target.expanded = true
    }
  } catch (e) {
    console.warn('[desktop-chat-tab] 加载子代理会话事件失败:', e)
    target.blocks.push({type: 'content', content: '❌ 回放加载失败'})
  } finally {
    target.loading = false
  }
}

function closeSubAgentTab(id) {
  const index = subAgentTabs.value.findIndex((tab) => tab.id === id)
  if (index < 0) return
  subAgentTabs.value.splice(index, 1)
  if (activeTabId.value === id) {
    activeTabId.value = subAgentTabs.value[index] ? subAgentTabs.value[index].id : CHAT_TAB_ID
  }
}

/** 子代理会话被删除：同步关闭其回放标签（如已打开）。 */
function onSubAgentRemoved(subSessionId) {
  closeSubAgentTab(`sub:${subSessionId}`)
}

/**
 * 子代理实时事件（ChatView SSE 同步转发）：自动打开回放标签（不打断主聊天）、
 * 就地增量更新、结束时静默刷新左侧列表。
 * 必须以同步方法处理：流式 sub_content/sub_reasoning 是高频 delta，
 * 若经 ref+watch 传递会被 Vue 批处理吞掉中间事件（每 tick 只留最后一条），导致缺字。
 */
function handleSubAgentEvent(evt) {
  if (!evt?.subSessionId) return
  let tab = subAgentTabs.value.find((t) => t.subSessionId === evt.subSessionId)
  if (!tab) {
    if (evt.type !== 'sub_start') return
    tab = createSubAgentContainer(evt.subId, {
      id: `sub:${evt.subSessionId}`,
      subSessionId: evt.subSessionId,
      taskName: evt.task || '子代理',
      status: '运行中'
    })
    subAgentTabs.value.push(tab)
    // 取数组内的响应式代理（push 后局部变量仍指向原始对象）
    tab = subAgentTabs.value.find((t) => t.subSessionId === evt.subSessionId) || tab
  }
  applySubAgentEvent(tab, evt)
  // 开始/结束都刷新左侧列表：运行中的子代理会话立即可见（status=running）
  if (evt.type === 'sub_start' || evt.type === 'sub_end' || evt.type === 'sub_complete') {
    subAgentPanelRef.value?.refresh?.()
  }
}

function dismissCloseConfirm() {
  closeConfirm.value = {visible: false, tabId: '', name: ''}
}

function handleCloseConfirmAction(action) {
  if (action === 'close') {
    const index = fileTabs.value.findIndex((tab) => tab.id === closeConfirm.value.tabId)
    if (index >= 0) removeFileTab(index)
  }
  dismissCloseConfirm()
}

function removeFileTab(index) {
  const tab = fileTabs.value[index]
  const id = tab?.id
  if (tab) fileEditorRef.value?.closeFile?.(tab.path)
  fileTabs.value.splice(index, 1)
  // 关闭的是当前标签 → 激活相邻标签，否则回 Chat
  if (activeTabId.value === id) {
    activeTabId.value = fileTabs.value[index] ? fileTabs.value[index].id : CHAT_TAB_ID
  }
}

function onFileDeleted(path) {
  const index = fileTabs.value.findIndex((tab) => tab.path === path)
  if (index >= 0) removeFileTab(index)
}

function onFileRenamed(oldPath, newPath) {
  const tab = fileTabs.value.find((item) => item.path === oldPath)
  if (tab) {
    fileEditorRef.value?.renameFile?.(oldPath, newPath)
    tab.path = newPath
    tab.name = fileBaseName(newPath)
  }
}

function onFileDirtyChange(path, dirty) {
  const tab = fileTabs.value.find((item) => item.path === path)
  if (tab) tab.dirty = dirty
}

function onFileSaved() {
  // 保存后刷新文件树 Git 装饰
  fileExplorerRef.value?.refresh?.()
}

function startLeftPanelResize(event) {
  stopLeftPanelResize?.()
  const startX = event.clientX
  const startWidth = leftPanelWidth.value
  leftPanelDragging.value = true

  const onMove = (moveEvent) => {
    const maxWidth = Math.floor(window.innerWidth * LEFT_PANEL_MAX_WIDTH_RATIO)
    leftPanelWidth.value = Math.min(
      Math.max(startWidth + moveEvent.clientX - startX, LEFT_PANEL_MIN_WIDTH),
      Math.max(maxWidth, LEFT_PANEL_MIN_WIDTH)
    )
  }

  const onUp = () => {
    leftPanelDragging.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    stopLeftPanelResize = null
    try {
      localStorage.setItem(LEFT_PANEL_SIZE_KEY, String(leftPanelWidth.value))
    } catch (error) {
      // 存储不可用时忽略
    }
  }

  stopLeftPanelResize = onUp
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// 欢迎页不展示左侧文件栏；进入会话保持当前状态（默认折叠，不覆盖用户手动开关）
function onWelcomeChange(active) {
  if (active) leftPanelOpen.value = false
}

async function addElementInspectionToSession(payload) {
  await nextTick()
  const attached = await chatRef.value?.appendElementInspection?.(payload)
  if (attached) await chatRef.value?.setDraft?.(payload?.message || '')
}

function requestHome() {
  window.electronAPI?.desktopChatTabs?.openHome()
}

function requestModelSettings() {
  window.electronAPI?.desktopChatTabs?.openModelChannels()
}

onBeforeUnmount(() => {
  stopRightPanelListener?.()
  stopFilePanelListener?.()
  stopTerminalListener?.()
  stopThemeListener?.()
  stopElementInspectionListener?.()
  stopRefreshHistoryListener?.()
  stopFocusComposerListener?.()
  stopSendCommandListener?.()
  stopSessionTitleListener?.()
  stopGlobalLoadingListener?.()
  stopSidebarResizeStartListener?.()
  stopSidebarResizeEndListener?.()
  finishSidebarResizeRelay(false)
  window.removeEventListener('loopra:bash-start', onBashStart)
  stopLeftPanelResize?.()
  leftPanelDragging.value = false
})

// 项目变化时自动上报，确保标签栏图标实时更新；同时清空已打开的文件/子代理标签
watch(workspaceHash, (hash) => {
  if (hash) window.electronAPI?.desktopChatTabs?.reportWorkspace({ tabId, workspaceHash: hash })
  fileEditorRef.value?.closeAll?.()
  subAgentTabs.value = []
  fileTabs.value = []
  activeTabId.value = CHAT_TAB_ID
}, { immediate: true })

async function openElementInspector() {
  try {
    await window.electronAPI?.elementInspectorWindow?.open?.()
  } catch (error) {
    message.error('打开审查失败：' + (error.message || '未知错误'))
  }
}

async function openAiBrowser() {
  try {
    await window.electronAPI?.aiBrowserWindow?.open?.()
  } catch (error) {
    message.error('打开浏览器失败：' + (error.message || '未知错误'))
  }
}

async function openOnboarding() {
  try {
    await window.electronAPI?.onboarding?.open?.()
  } catch (error) {
    message.error('打开引导失败：' + (error.message || '未知错误'))
  }
}
</script>

<style scoped>
.desktop-chat-tab {
  width: 100vw;
  height: 100vh;
  display: flex;
  overflow: hidden;
  background: var(--bg);
  position: relative;
}

/* 左侧固定活动栏 */
.desktop-activity-bar {
  width: 50px;
  flex: 0 0 50px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 5px;
  gap: 4px;
  background: var(--bg);
  border-right: 1px solid var(--border);
  box-shadow: none;
  z-index: 40;
  user-select: none;
}

.activity-bar-item {
  position: relative;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 40px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-3);
  font-size: 21px;
  line-height: 1;
  cursor: pointer;
  outline: none;
  transition: color var(--t), background-color var(--t), border-color var(--t);
}

.desktop-chat-global-loading {
  position: absolute;
  inset: 0;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: var(--desktop-paper, var(--bg, #fff));
  color: var(--desktop-muted, var(--fg-3, #8b8b87));
  font-size: 13px;
  letter-spacing: .02em;
}

.desktop-chat-global-loading-spinner {
  width: 28px;
  height: 28px;
  box-sizing: border-box;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: desktop-chat-global-loading-spin .75s linear infinite;
}

@keyframes desktop-chat-global-loading-spin {
  to { transform: rotate(360deg); }
}

.activity-bar-item:hover {
  color: var(--fg);
  background: var(--bg-3);
}

.activity-bar-item:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 72%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent);
}

.activity-bar-item.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 11%, transparent);
}

.desktop-chat-header-action.environment-attention {
  animation: environment-attention-pulse 1s ease-in-out 2;
}

.desktop-chat-header-action.environment-attention svg {
  animation: environment-attention-icon 1s ease-in-out 2;
}

@keyframes environment-attention-pulse {
  0%, 100% { color: var(--fg-2); background: transparent; box-shadow: none; }
  50% { color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 6%, transparent), 0 0 7px color-mix(in srgb, var(--accent) 12%, transparent); }
}

@keyframes environment-attention-icon {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}

.activity-bar-icon {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
}


/* 会话进行中的波动条：从最左侧向右运行，固定活动栏覆盖其起始段 */
.desktop-streaming-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--bg-3, rgba(0,0,0,0.06));
  overflow: hidden;
  z-index: 30;
  pointer-events: none;
}

.desktop-streaming-bar-inner {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  border-radius: 1px;
  will-change: transform;
  animation: desktop-streaming-slide 1.4s ease-in-out infinite;
}

@keyframes desktop-streaming-slide {
  0% { transform: translate3d(-100%, 0, 0); }
  100% { transform: translate3d(250%, 0, 0); }
}

.desktop-files-left {
  position: relative;
  width: 300px;
  min-width: 240px;
  max-width: 34vw;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
  background: #fcfcfd;
  border-right: 1px solid var(--border);
  transition: width 0.2s, opacity 0.2s;
}

.desktop-files-left.collapsed {
  width: 0;
  min-width: 0;
  opacity: 0;
  border-right: none;
  pointer-events: none;
}

.desktop-files-left :deep(.file-explorer),
.desktop-files-left :deep(.git-panel),
.desktop-files-left :deep(.environment-panel) {
  width: 100%;
  min-height: 0;
  flex: 1;
}

.desktop-files-resize-handle {
  position: absolute;
  top: 0;
  right: -4px;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
  z-index: 2;
}

.desktop-files-resize-handle:hover,
.desktop-files-resize-handle.dragging {
  background: rgba(82, 82, 91, 0.25);
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}

.desktop-chat-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 内容区面板（Chat / 文件编辑器）：v-show 切换时保持 flex 布局 */
.editor-pane {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}

.desktop-chat-view {
  flex: 1;
  min-height: 0;
  min-width: 0;
}
[data-theme="dark"] .desktop-files-left {
  background: var(--bg-2, #222327);
}
</style>
