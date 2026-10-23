<template>
  <div v-if="isElementInspectorWindow" class="element-inspector-window" :data-theme="theme">
    <ElementPanel ref="elemPanelRef" :visible="true" @send="forwardElementInspection" />
  </div>

  <div v-else class="app" :data-theme="theme">
    <!-- 启动画面 (仅桌面环境) -->
    <SplashScreen
      v-if="showSetup && isDesktopEnv"
      ref="splashRef"
      @ready="onSplashReady"
      @error="onSplashError"
    />

    <!-- 连接设置（Web 环境，后端未连上时显示） -->
    <SetupScreen
      v-if="showSetup && !isDesktopEnv"
      @connected="onConnected"
      @close="onSetupClose"
    />

    <!-- 自定义标题栏 -->
    <TitleBar
      :session="currentSessionTitle"
      :workspaceName="currentSessionWorkspaceName"
      :sideOn="sideOpen"
      :hasMessages="true"
      :hasSession="!!currentSession"
      :gitOn="rightPanelOpen"
      :elementOn="elementPanelOpen"
      :version="appVersion"
      :hasNewVersion="hasNewVersion || desktopHasNewVersion"
      @toggleSide="sideOpen = !sideOpen"
      @openSettings="openSettings"
      @toggleGit="toggleRightPanel()"
      @toggleElement="toggleElementPanel()"
      @viewPrompt="viewSystemPrompt"
      @showUpdate="openUpdateWindow"
    />

    <!-- 主体区域 -->
    <div class="app-body">
    <!-- 侧边栏 -->
    <Sidebar
      v-model:sideOpen="sideOpen"
      :theme="theme"
      :currentSession="currentSession"
      :currentSessionWorkspace="currentSessionWorkspace"
      :workspaces="workspaces"
      :workspaceSessions="workspaceSessions"
      :initialDataLoaded="initialDataLoaded"
      @new-chat="createNewChat"
      @open-global-search="openGlobalSearch"
      @refresh-sessions="refreshSessionList"
      @new-project-chat="newProjectChat"
      @refresh-project="refreshProjectSessions"
      @manage-project="openProjectSessionDialog"
      @select-session="onSidebarSelectSession"
      @refresh-session-chat="refreshSessionChat"
      @delete-session="onSidebarDeleteSession"
      @toggle-theme="toggleTheme"
      @show-skill-market="mainView = 'skills'"
      @show-tools="openSettingsTab('tools')"
      @show-sub-agents="openSettingsTab('sub-agents')"
      @show-dashboard="openSettingsTab('dashboard')"
      @show-settings="openSettings"
      @reorder="handleReorderWorkspaces"
    />

    <!-- 主区域 -->
    <main class="main">
      <SettingsView v-if="mainView === 'skills'" market-only />
      <ModelChannels
        v-else-if="mainView === 'model-channels'"
        :setup-required="modelChannelsRequireReload"
        @back="closeModelChannels"
        @saved="reloadAfterModelChannelsSaved"
      />
      <ChatView 
        v-else
        ref="chatRef" 
        hide-header 
        :workspace-hash="currentSessionWorkspace"
        @manage-models="openModelChannels"
        :session-name="currentSession"
        :right-panel-open="rightPanelOpen"
        :workspaces="workspaces"
        :version="appVersion"
        style="flex:1;min-height:0"
        @session-updated="onSessionUpdated"
        @session-branched="onSessionBranched"
        @start-task="startTaskFromWelcome"
        @switch-workspace="switchWelcomeWorkspace"
        @manage-workspaces="showWorkspacePicker = true"
        @refresh-sessions="refreshSessionList"
      />
    </main>

    <!-- 右侧面板 -->
    <RightPanel
      :open="rightPanelOpen"
      v-model="rightPanelTab"
      :workspace-hash="currentSessionWorkspace"
      :session-name="currentSession"
      :sessions="sessions"
      @close="rightPanelOpen = false"
      @add-to-session="addFileSelectionToSession"
    />

      <!-- 系统提示词 Modal -->
      <Teleport to="body">
        <div v-if="promptModalOpen" class="modal-mask" @click.self="promptModalOpen = false">
          <div class="modal" style="width:80vw;max-width:900px;height:80vh;display:flex;flex-direction:column">
            <div class="modal-head">
              <span>系统提示词</span>
              <span style="font-size:11px;color:var(--fg-4);background:var(--bg-3);padding:2px 8px;border-radius:4px">{{
                  promptLength
                }} 字符</span>
              <div style="flex:1"></div>
              <button class="btn-icon-sm" @click="promptModalOpen = false">×</button>
            </div>
            <div class="modal-body" style="flex:1;overflow:auto;padding:20px 24px">
              <div class="prompt-rendered" v-html="fmtPrompt(promptContent)"></div>
            </div>
            <div class="modal-foot"
                 style="display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--border)">
              <button class="btn btn-sm" @click="copyPrompt">复制</button>
              <button class="btn btn-sm" @click="promptModalOpen = false">关闭</button>
            </div>
          </div>
        </div>
      </Teleport>

    </div><!-- .app-body -->

    <Teleport to="body">
      <div v-if="showGlobalSearch" class="global-search-mask" @mousedown.self="closeGlobalSearch">
        <section class="global-search-panel" role="dialog" aria-modal="true" aria-label="搜索会话">
          <div class="global-search-input-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>
            <input
              ref="globalSearchInput"
              v-model="globalSearchQuery"
              type="search"
              placeholder="搜索会话..."
              @keydown="handleGlobalSearchKeydown"
            />
            <kbd>Esc</kbd>
          </div>
          <div class="global-search-results" role="listbox">
            <button
              v-for="(item, index) in globalSearchResults"
              :key="`${item.workspaceHash}:${item.sessionName}`"
              class="global-search-result"
              :class="{ active: index === globalSearchActiveIndex }"
              type="button"
              role="option"
              :aria-selected="index === globalSearchActiveIndex"
              @mouseenter="globalSearchActiveIndex = index"
              @click="selectGlobalSearchResult(item)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h12l4 4v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M6 13h12M6 17h8"/></svg>
              <span class="global-search-result-main">{{ item.title }}</span>
              <span class="global-search-result-workspace">{{ item.workspaceName }}</span>
            </button>
            <div v-if="globalSearchResults.length === 0" class="global-search-empty">未找到会话</div>
          </div>
        </section>
      </div>
    </Teleport>

    <!-- 项目选择弹窗 -->
    <WorkspacePickerModal
      v-model:show="showWorkspacePicker"
      :workspaces="workspaces"
      :current-session-workspace="currentSessionWorkspace"
      :is-desktop-env="isDesktopEnv"
      @switch-workspace="handleSwitchWorkspace"
      @add-workspace="handleAddWorkspace"
      @reorder="handleReorderWorkspaces"
    />

    <ActionConfirmDialog
        :model-value="projectSessionDialog.visible"
        title="管理项目会话"
        :message="`“${projectSessionDialog.name}”的会话可单独清空，或连同项目记录一起删除。`"
        :actions="projectSessionActions"
        :pending="projectSessionDialog.pending"
        @update:model-value="value => { if (!value) closeProjectSessionDialog() }"
        @action="handleProjectSessionAction"
    >
      <template #icon>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>
          <path d="M22 21H7"/><path d="m5 11 9 9"/>
        </svg>
      </template>
    </ActionConfirmDialog>

    <!-- 配置弹窗 -->
    <Teleport to="body">
      <div v-if="showConfig" class="modal-mask" @click.self="showConfig = false">
        <div class="modal">
          <div class="modal-head">
            <span>系统配置</span>
            <button class="btn-icon-sm" @click="showConfig = false">×</button>
          </div>
          <div class="modal-body">
            <!-- 系统配置 -->
            <div class="config-section">
              <div class="config-section-title">系统配置</div>
              <div v-for="(v, k) in config" :key="k" class="config-row">
                <span class="config-key">{{ k }}</span>
                <span class="config-val">{{ v }}</span>
              </div>
              <div v-if="!Object.keys(config).length" class="modal-empty">加载中...</div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 设置弹窗 -->
    <Teleport to="body">
      <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
        <div class="modal modal-settings">
          <div class="modal-head">
            <span>设置</span>
            <button class="btn-icon-sm" @click="showSettings = false">×</button>
          </div>
          <div class="modal-body">
            <SettingsView :initial-tab="settingsInitialTab" @auto-update="handleAutoUpdate" @init-pet="handleInitPet" />
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 数据面板已并入设置页（左侧菜单「数据面板」） -->

    <!-- OpenAPI 管理弹窗 -->
    <!-- 确认对话框 -->
    <ConfirmDialog />

    <!-- 更新面板（Web 端点击版本号在页面内展示，类似更新窗口） -->
    <Teleport to="body">
      <div v-if="showUpdatePanel" class="update-panel-mask" @click.self="showUpdatePanel = false">
        <div class="update-panel" role="dialog" aria-modal="true" aria-label="Loopra 更新">
          <DesktopUpdate embedded @close="showUpdatePanel = false" @auto-update="handleAutoUpdate" />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import {computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {useRouter} from 'vue-router'
import {message} from 'ant-design-vue'
import {useConfirm} from './composables/useConfirm'
import {md} from './utils/highlight'
import {applyHighlightTheme} from './utils/highlight'
import {sanitize} from './utils/sanitize'
import {useAppStore} from './stores/app'
import {agentAPI, configAPI, sessionsAPI, systemAPI, toolsAPI} from './services/api'
// 设置页含 工具/子代理/数据面板 等重组件，按需异步加载，避免拖慢首屏与弹窗打开
const SettingsView = defineAsyncComponent(() => import('./views/Settings.vue'))
import {buildUpdatePrompt, loadUpdateSource} from './utils/updateScripts'
import SetupScreen from './components/SetupScreen.vue'
import DesktopUpdate from './DesktopUpdate.vue'
import TitleBar from './components/TitleBar.vue'
import SplashScreen from './components/SplashScreen.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import Sidebar from './components/Sidebar.vue'
import RightPanel from './components/RightPanel.vue'
import ElementPanel from './components/ElementPanel.vue'
import WorkspacePickerModal from './components/WorkspacePickerModal.vue'
import ActionConfirmDialog from './components/ActionConfirmDialog.vue'
import ChatView from './views/Chat.vue'
import ModelChannels from './ModelChannels.vue'
import {platform} from '@/services/platform'
import {hasConfiguredModelChannel} from '@/utils/modelChannels'
import {RELEASE_LATEST_URL} from '@/utils/constants'
import {switchThemeWithReveal} from './utils/themeTransition'

const isElementInspectorWindow = new URLSearchParams(window.location.search).get('elementInspector') === '1'

const store = useAppStore()
const router = useRouter()
const { confirm } = useConfirm()

// 主题：统一从 Pinia store 读写，确保设置页和主页一致
const theme = computed({ get: () => store.settings.theme, set: (v) => { store.settings.theme = v } })
watch(theme, applyHighlightTheme, {immediate: true})
const sideOpen = ref(true)
const mainView = ref('chat')
const modelChannelsRequireReload = ref(false)
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1024
const collapseSidebarForNarrowViewport = () => {
  if (window.innerWidth < SIDEBAR_AUTO_COLLAPSE_WIDTH) sideOpen.value = false
}
const sessions = ref([])
const currentSession = ref('')
const status = ref({})
const usage = ref({})
const tools = ref([])
const config = ref({})
const isDesktopEnv = ref(false)
const showSetup = ref(true)  // SplashScreen (桌面) 或 SetupScreen (Web) 成功后设为 false

// 异步检测环境
async function detectEnvironment() {
  if (platform.isElectron) {
    isDesktopEnv.value = true
    console.log('[App] Electron environment detected')
  } else {
    isDesktopEnv.value = false
    console.log('[App] Browser environment detected')
  }
}
const showConfig = ref(false)
const showSettings = ref(false)
const showUpdatePanel = ref(false) // Web 端更新面板（类似更新窗口的页面内弹层）
const settingsInitialTab = ref('general')
const rightPanelOpen = ref(false)
const openSettings = () => {
  settingsInitialTab.value = 'general'
  showSettings.value = true
}
// 从侧栏打开设置弹窗并定位到对应 tab（工具/子代理/数据面板已收进设置页）
const openSettingsTab = (tab) => {
  settingsInitialTab.value = tab
  showSettings.value = true
}
const createNewChat = async () => {
  mainView.value = 'chat'
  await newChat()
}
const rightPanelTab = ref('git')
const elementPanelOpen = ref(false)
const elementPanelWidth = ref(360)
const isElementDragging = ref(false)
const initialDataLoaded = ref(false)
const elemPanelRef = ref(null)
let unlistenInspectorLoadUrl = null
let unlistenInspectorDraft = null

// 从 AI 消息中的链接点击「在元素界面打开」
function onOpenInElement(e) {
  const url = e.detail?.url
  if (!url) return
  if (platform.isElectron) {
    window.electronAPI.elementInspectorWindow.open(url)
  }
}

function onElementInspectorDraft(payload) {
  onElementSend(payload?.detail ?? payload)
}

// 切换右侧面板（直接 toggle，不关心当前 tab）
function toggleRightPanel() {
  rightPanelOpen.value = !rightPanelOpen.value
}

// Agent 调用 bash_start 时自动展开右侧栏并切到“命令”页签
function onBashStart() {
  rightPanelOpen.value = true
  rightPanelTab.value = 'bash'
}

// 切换元素面板
function toggleElementPanel() {
  if (platform.isElectron) window.electronAPI.elementInspectorWindow.open()
}

// 元素面板拖拽调整宽度
const ELEMENT_MIN_WIDTH = 280
const ELEMENT_MAX_WIDTH = 800

function onElementResizeStart(e) {
  isElementDragging.value = true
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onElementResizeMove)
  document.addEventListener('mouseup', onElementResizeEnd)
}

function onElementResizeMove(e) {
  if (!isElementDragging.value) return
  const viewportWidth = window.innerWidth
  const newWidth = viewportWidth - e.clientX
  elementPanelWidth.value = Math.min(ELEMENT_MAX_WIDTH, Math.max(ELEMENT_MIN_WIDTH, newWidth))
}

function onElementResizeEnd() {
  isElementDragging.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onElementResizeMove)
  document.removeEventListener('mouseup', onElementResizeEnd)
  // 持久化宽度
  try {
    localStorage.setItem('loopra-element-panel-width', String(elementPanelWidth.value))
  } catch { /* ignore */ }
}

// 加载保存的元素面板宽度
onMounted(() => {
  collapseSidebarForNarrowViewport()
  window.addEventListener('resize', collapseSidebarForNarrowViewport)
  try {
    const saved = localStorage.getItem('loopra-element-panel-width')
    if (saved) {
      const w = parseInt(saved, 10)
      if (w >= ELEMENT_MIN_WIDTH && w <= ELEMENT_MAX_WIDTH) {
        elementPanelWidth.value = w
      }
    }
  } catch { /* ignore */ }
})

// 元素面板发送消息 → 直接发给当前会话的 AI
async function onElementSend(payload) {
  await nextTick()
  if (!chatRef.value?.appendElementInspection || !chatRef.value?.setDraft) return false
  const attached = await chatRef.value.appendElementInspection(payload)
  if (!attached) return false
  await chatRef.value.setDraft(payload.message || '')
  return true
}

async function forwardElementInspection(payload) {
  try {
    const component = payload?.component || {}
    const safePayload = {
      message: String(payload?.message || ''),
      component: {
        name: String(component.name || ''),
        tag: String(component.tag || ''),
        text: String(component.text || ''),
        selector: String(component.selector || ''),
        file: String(component.file || ''),
        path: Array.isArray(component.path) ? component.path.map((item) => String(item)) : [],
        attrs: Array.isArray(component.attrs)
          ? component.attrs.map((attr) => ({ key: String(attr?.key || ''), val: String(attr?.val || '') }))
          : []
      }
    }
    window.electronAPI.elementInspectorWindow.send(safePayload)
    message.success('已发送到主窗口')
  } catch (error) {
    console.error('[ElementInspector] Failed to send selection:', error)
    message.error('发送失败：' + (error.message || '主窗口输入框未就绪'))
  }
}

if (!isElementInspectorWindow && window.electronAPI?.elementInspectorWindow) {
  unlistenInspectorDraft = window.electronAPI.elementInspectorWindow.onDraft(onElementInspectorDraft)
}

function addFileSelectionToSession(selection) {
  if (!selection?.content?.trim()) return
  chatRef.value?.appendFileSelection?.(selection)
}

const chatRef = ref(null)
watch(mainView, async (view) => {
  if (view !== 'chat') return
  await nextTick()
  await chatRef.value?.focusComposer?.()
})
const workspace = ref('')

// 版本信息
const appVersion = ref('')
const hasNewVersion = ref(false)
const latestVersion = ref('')
const releaseUrl = ref('')
const autoUpdating = ref(false)

// Electron 桌面端版本
const electronVersion = ref('')
const desktopHasNewVersion = ref(false)
const checkingVersion = ref(false)
const desktopAppVersion = ref('')

// 系统提示词弹窗
const promptModalOpen = ref(false)
const promptContent = ref('')
const promptLength = ref(0)
const loadingPrompt = ref(false)

const viewSystemPrompt = async () => {
  loadingPrompt.value = true
  try {
    const params = {}
    if (currentSessionWorkspace.value) params.workspaceHash = currentSessionWorkspace.value
    if (currentSession.value) params.sessionName = currentSession.value
    const {agentAPI} = await import('./services/api')
    const res = await agentAPI.getSystemPrompt(params)
    if (res.success && res.data) {
      promptContent.value = res.data.content || ''
      promptLength.value = res.data.length || 0
      promptModalOpen.value = true
    } else {
      message.error(res.message || '获取提示词失败')
    }
  } catch (e) {
    message.error('获取提示词失败: ' + (e.message || '未知错误'))
  } finally {
    loadingPrompt.value = false
  }
}

const fmtPrompt = c => {
  if (!c) return ''
  return sanitize(md.render(c))
}

const copyPrompt = () => {
  if (!promptContent.value) return
  navigator.clipboard.writeText(promptContent.value).then(() => {
    message.success('提示词已复制')
  }).catch(() => {
  })
}

// 项目相关
const showWorkspacePicker = ref(false)
const pendingStarterPrompt = ref('')
const workspaces = ref([])

// 按项目 hash 分组的会话
const workspaceSessions = ref({})
const showGlobalSearch = ref(false)
const globalSearchQuery = ref('')
const globalSearchInput = ref(null)
const globalSearchActiveIndex = ref(0)

const globalSearchResults = computed(() => {
  const query = globalSearchQuery.value.trim().toLowerCase()
  const items = workspaces.value.flatMap(workspace =>
    (workspaceSessions.value[workspace.hash] || []).map(session => ({
      workspaceHash: workspace.hash,
      workspaceName: workspace.name,
      sessionName: session.name,
      title: session.title || formatName(session.name),
      mtime: session.mtime || 0
    }))
  )

  return items
    .filter(item => !query || [item.title, item.sessionName, item.workspaceName]
      .some(value => value?.toLowerCase().includes(query)))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 50)
})

const currentSessionTitle = computed(() => {
  if (!currentSession.value) return '新对话'
  const s = sessions.value.find(s => s.name === currentSession.value)
  return (s && s.title) || formatName(currentSession.value)
})

const workspaceName = computed(() => {
  if (!workspace.value) return '选择项目'
  const parts = workspace.value.split(/[\\/]/)
  return parts[parts.length - 1] || workspace.value
})

// 当前会话所属项目的名称（用于顶栏项目图标）
const currentSessionWorkspaceName = computed(() => {
  if (!currentSessionWorkspace.value) return ''
  const ws = workspaces.value.find(w => w.hash === currentSessionWorkspace.value)
  return ws ? ws.name : ''
})

// 当前会话所属的项目 hash
const currentSessionWorkspace = ref(null)

// 当前项目下的会话列表
const currentWorkspaceSessions = computed(() => {
  if (!currentSessionWorkspace.value) return []
  return workspaceSessions.value[currentSessionWorkspace.value] || []
})

const fmtTokens = n => !n ? '0' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)

const formatName = n => {
  const m = n.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}${n.slice(m.index + m[0].length)}` : n.replace(/[-_]+/g, ' ').slice(0, 24)
}

const themeOrder = ['gray', 'dark']
const toggleTheme = () => {
  const idx = themeOrder.indexOf(store.settings.theme)
  const target = themeOrder[(idx + 1) % themeOrder.length]
  // 中心扩散动画：动画完成后再真正切换主题，实现从中间向四周变黑/变白
  switchThemeWithReveal(target, (v) => { store.settings.theme = v })
}

let heartbeatTimer = null

const startHeartbeat = () => {
  stopHeartbeat()
  heartbeatTimer = setInterval(async () => {
    if (showSetup.value) return  // 已在设置页，跳过
    try {
      await agentAPI.getStatus()
    } catch {
      console.warn('[heartbeat] 后端不可达，切换到设置页')
      showSetup.value = true
    }
  }, 5000)
}

const stopHeartbeat = () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

// 连接设置页回调：后端连接成功
const onConnected = async () => {
  showSetup.value = false
  if (await loadData()) openModelChannelsWhenUnconfigured()
  startHeartbeat()
}

// 用户关闭设置页（仅 Web 环境走到这里）
const onSetupClose = async () => {
  showSetup.value = false
  if (await loadData()) openModelChannelsWhenUnconfigured()
  startHeartbeat()
}

// 服务就绪回调（SplashScreen 安装/启动完成后调用）
const onSplashReady = async () => {
  console.log('Loopra Web service is ready')
  showSetup.value = false
  if (await loadData()) openModelChannelsWhenUnconfigured()
  startHeartbeat()
}

// 服务错误回调
const onSplashError = (error) => {
  console.error('Loopra Web service error:', error)
}

// 加载数据
const loadData = async () => {
  let configLoaded = false
  try {
    const [s, t, cf] = await Promise.allSettled([
      agentAPI.getStatus(), toolsAPI.list(), configAPI.getConfig()
    ])
    if (s.status === 'fulfilled' && s.value.success) {
      status.value = s.value.data || {}
      if (s.value.data?.workspace) {
        workspace.value = s.value.data.workspace
      }
    }
    if (t.status === 'fulfilled' && t.value.success) tools.value = t.value.data || []
    if (cf.status === 'fulfilled' && cf.value.success) {
      configLoaded = true
      config.value = cf.value.data || {}
      if (cf.value.data?.workspace && !workspace.value) {
        workspace.value = cf.value.data.workspace
      }
    }
  } catch {}
  await loadWorkspaces()
  await initializeWorkspaceContext()
  await loadSessions()
  initialDataLoaded.value = true
  return configLoaded
}

function openModelChannelsWhenUnconfigured() {
  if (!hasConfiguredModelChannel(config.value)) {
    modelChannelsRequireReload.value = true
    mainView.value = 'model-channels'
  }
}

function openModelChannels() {
  modelChannelsRequireReload.value = false
  mainView.value = 'model-channels'
}

function closeModelChannels() {
  modelChannelsRequireReload.value = false
  mainView.value = 'chat'
}

function reloadAfterModelChannelsSaved() {
  if (modelChannelsRequireReload.value) {
    window.location.reload()
    return
  }
  config.value = {...config.value, modelChannelsConfigured: true}
  mainView.value = 'chat'
}

const openGlobalSearch = async () => {
  globalSearchQuery.value = ''
  globalSearchActiveIndex.value = 0
  showGlobalSearch.value = true
  await nextTick()
  globalSearchInput.value?.focus()
}

const closeGlobalSearch = () => {
  showGlobalSearch.value = false
  globalSearchQuery.value = ''
}

const selectGlobalSearchResult = (item) => {
  closeGlobalSearch()
  onSidebarSelectSession(item)
}

const handleGlobalSearchKeydown = (event) => {
  const resultCount = globalSearchResults.value.length
  if (event.key === 'Escape') {
    closeGlobalSearch()
  } else if (event.key === 'ArrowDown' && resultCount > 0) {
    event.preventDefault()
    globalSearchActiveIndex.value = Math.min(globalSearchActiveIndex.value + 1, resultCount - 1)
  } else if (event.key === 'ArrowUp' && resultCount > 0) {
    event.preventDefault()
    globalSearchActiveIndex.value = Math.max(globalSearchActiveIndex.value - 1, 0)
  } else if (event.key === 'Enter' && resultCount > 0) {
    event.preventDefault()
    selectGlobalSearchResult(globalSearchResults.value[globalSearchActiveIndex.value])
  }
}

watch(globalSearchQuery, () => {
  globalSearchActiveIndex.value = 0
})

const loadSessions = async () => {
  try {
    // 获取所有项目
    const wsList = workspaces.value
    if (wsList.length === 0) {
      workspaceSessions.value = {}
      return
    }
    
    // 并行加载每个项目的会话
    const results = await Promise.all(
      wsList.map(w =>
        sessionsAPI.list(w.hash)
          .then(r => r.success ? (r.data || []) : [])
          .catch(() => [])
      )
    )
    
    const grouped = {}
    wsList.forEach((w, i) => {
      grouped[w.hash] = results[i] || []
    })
    workspaceSessions.value = grouped
    
    // 也更新 flat sessions（兼容旧代码）
    const wsHash = currentSessionWorkspace.value
    if (wsHash && grouped[wsHash]) {
      sessions.value = grouped[wsHash] || []
    }
  } catch {}
}

const onSessionUpdated = (sessionName, optimistic = false) => {
  if (!optimistic || !sessionName || !currentSessionWorkspace.value) {
    return loadSessions()
  }

  const workspaceHash = currentSessionWorkspace.value
  const existing = workspaceSessions.value[workspaceHash] || []
  if (existing.some(session => session.name === sessionName)) return

  const addedSession = {
    name: sessionName,
    title: null,
    messageCount: 1,
    active: sessionName === currentSession.value,
    mtime: Date.now()
  }
  const updated = [addedSession, ...existing]
  workspaceSessions.value = {...workspaceSessions.value, [workspaceHash]: updated}
  if (workspaceHash === currentSessionWorkspace.value) {
    sessions.value = updated
  }
}

// 分支会话：切换到新会话并刷新列表
const onSessionBranched = async (newSessionName) => {
  currentSession.value = newSessionName
  await nextTick()
  await Promise.all([
    loadSessions(),
    chatRef.value?.loadSession(newSessionName, currentSessionWorkspace.value)
  ])
  message.success("已分支到新会话")
}

// 加载项目列表
const loadWorkspaces = async () => {
  try {
    const r = await configAPI.listWorkspaces()
    if (r.success) workspaces.value = await applyWorkspaceOrder(r.data || [])
  } catch (e) {
    console.error('加载项目列表失败:', e)
  }
}

// 从服务端恢复项目排序
async function applyWorkspaceOrder(list) {
  if (!list || list.length === 0) return list
  try {
    const r = await configAPI.getWorkspaceOrder()
    if (r.success && r.data && r.data.length) {
      const map = new Map(list.map(w => [w.hash, w]))
      const ordered = r.data.filter(h => map.has(h)).map(h => map.get(h))
      const rest = list.filter(w => !r.data.includes(w.hash))
      return [...ordered, ...rest]
    }
  } catch {}
  return list
}

// 拖拽排序后保存到服务端
async function handleReorderWorkspaces(newList) {
  workspaces.value = newList
  try {
    await configAPI.saveWorkspaceOrder(newList.map(w => w.hash))
  } catch (e) {
    console.error('保存项目排序失败:', e)
  }
}

// 切换项目（仅持久化上下文，不新建会话）
const switchWorkspaceContext = async (hash) => {
  const ws = workspaces.value.find(w => w.hash === hash)
  if (!ws) return
  await configAPI.switchWorkspace(ws.path)
  workspace.value = ws.path
}

const initializeWorkspaceContext = async () => {
  if (currentSessionWorkspace.value || workspaces.value.length === 0) return
  const activeWorkspace = workspaces.value.find(item => item.path === workspace.value)
  const targetWorkspace = activeWorkspace || workspaces.value[0]
  await switchWorkspaceContext(targetWorkspace.hash)
  currentSessionWorkspace.value = targetWorkspace.hash
}

// 切换项目（用户主动操作，切换后新建会话）
const handleSwitchWorkspace = async (hash) => {
  try {
    const ws = workspaces.value.find(w => w.hash === hash)
    if (!ws) { message.error('项目不存在'); return }
    const r = await configAPI.switchWorkspace(ws.path)
    if (r.success) {
      workspace.value = r.data.workspace
      showWorkspacePicker.value = false
      await loadWorkspaces()
      await loadSessions()
      currentSessionWorkspace.value = hash
      await newChat(true)
      await applyPendingStarterPrompt()
      message.success('已切换项目')
    } else {
      message.error(r.message || '切换项目失败')
    }
  } catch (e) {
    message.error('切换项目失败: ' + e.message)
  }
}

// 添加新项目
const handleAddWorkspace = async (path) => {
  if (!path) return
  
  try {
    const r = await configAPI.switchWorkspace(path)
    if (r.success) {
      workspace.value = r.data.workspace
      showWorkspacePicker.value = false
      await loadWorkspaces()
      await loadSessions()
      // 通过路径匹配新项目的 hash 并切换上下文
      const newWs = workspaces.value.find(w => w.path === r.data.workspace)
      if (newWs) currentSessionWorkspace.value = newWs.hash
      await newChat(true)
      await applyPendingStarterPrompt()
      message.success('已添加项目')
    } else {
      message.error(r.message || '添加项目失败')
    }
  } catch (e) {
    message.error('添加项目失败: ' + e.message)
  }
}

// 删除项目
const deleteWorkspace = async (hash) => {
  try {
    const r = await configAPI.deleteWorkspace(hash)
    if (r.success) {
      if (currentSessionWorkspace.value === hash) {
        currentSession.value = ''
        currentSessionWorkspace.value = null
        chatRef.value?.resetLocalMessages()
      }
      await loadWorkspaces()
      await loadSessions()
      message.success('项目已删除')
      return true
    } else {
      message.error(r.message || '删除项目失败')
      return false
    }
  } catch (e) {
    message.error('删除项目失败: ' + e.message)
    return false
  }
}

// 加载指定项目下的会话
const loadProjectSession = async (wsHash, sessionName) => {
  await switchWorkspaceContext(wsHash)
  currentSession.value = sessionName
  currentSessionWorkspace.value = wsHash
  chatRef.value?.loadSession(sessionName, wsHash)
}

// 删除指定项目下的会话
const deleteProjectSession = async (wsHash, sessionName) => {
  const ok = await confirm({ message: `确定要删除此会话吗？` })
  if (!ok) return
  try {
    await sessionsAPI.deleteSession(sessionName, wsHash)
    await loadSessions()
    message.success('会话已删除')
  } catch (e) {
    message.error('删除会话失败: ' + e.message)
  }
}

// 在指定项目中创建新会话
const newProjectChat = async (wsHash) => {
  if (!wsHash) return
  try {
    const r = await sessionsAPI.createNew({ workspaceHash: wsHash })
    if (r.success && r.data?.sessionName) {
      await switchWorkspaceContext(wsHash)
      currentSession.value = r.data.sessionName
      currentSessionWorkspace.value = wsHash
      mainView.value = 'chat'
      await nextTick()
      chatRef.value?.resetLocalMessages()
      await loadSessions()
      message.success('已新建对话')
    } else {
      message.error('新建对话失败')
    }
  } catch (e) {
    console.error('新建会话失败:', e)
    message.error('新建对话失败: ' + e.message)
  }
}

// 刷新指定项目的会话列表
const refreshProjectSessions = async (wsHash) => {
  if (!wsHash) return
  try {
    const r = await sessionsAPI.list(wsHash)
    if (r.success) {
      const grouped = { ...workspaceSessions.value }
      grouped[wsHash] = r.data || []
      workspaceSessions.value = grouped
      // 更新 flat sessions
      if (currentSessionWorkspace.value === wsHash) {
        sessions.value = grouped[wsHash] || []
      }
    }
    message.success('会话列表已刷新')
  } catch (e) {
    message.error('刷新失败: ' + (e.message || '未知错误'))
  }
}

// 清空指定项目（或当前活跃项目）的所有会话
const clearProjectSessions = async (wsHash) => {
  const hash = wsHash || currentSessionWorkspace.value
  if (!hash) return
  try {
    await sessionsAPI.clearAll(hash)
    await loadSessions()
    if (currentSessionWorkspace.value === hash) {
      currentSession.value = ''
      chatRef.value?.resetLocalMessages()
    }
    message.success('会话已清空')
    return true
  } catch (e) {
    message.error('清空会话失败: ' + e.message)
    return false
  }
}

const projectSessionDialog = ref({visible: false, workspaceHash: null, name: '', pending: false})
const projectSessionActions = [
  {key: 'cancel', label: '取消'},
  {key: 'clear', label: '清空会话列表', variant: 'accent'},
  {key: 'delete', label: '删除项目', variant: 'danger'}
]

const openProjectSessionDialog = (workspaceHash) => {
  const workspace = workspaces.value.find(w => w.hash === workspaceHash)
  projectSessionDialog.value = {
    visible: true,
    workspaceHash,
    name: workspace?.name || workspaceHash,
    pending: false
  }
}

const closeProjectSessionDialog = () => {
  if (projectSessionDialog.value.pending) return
  projectSessionDialog.value.visible = false
}

const confirmClearProjectSessions = async () => {
  const {workspaceHash} = projectSessionDialog.value
  if (!workspaceHash) return
  projectSessionDialog.value.pending = true
  const cleared = await clearProjectSessions(workspaceHash)
  projectSessionDialog.value.pending = false
  if (cleared) projectSessionDialog.value.visible = false
}

const confirmDeleteWorkspace = async () => {
  const {workspaceHash} = projectSessionDialog.value
  if (!workspaceHash) return
  projectSessionDialog.value.pending = true
  const deleted = await deleteWorkspace(workspaceHash)
  projectSessionDialog.value.pending = false
  if (deleted) projectSessionDialog.value.visible = false
}

const handleProjectSessionAction = (action) => {
  if (action === 'cancel') {
    closeProjectSessionDialog()
  } else if (action === 'clear') {
    confirmClearProjectSessions()
  } else if (action === 'delete') {
    confirmDeleteWorkspace()
  }
}

// Sidebar 事件：选择会话
const onSidebarSelectSession = ({ workspaceHash, sessionName }) => {
  mainView.value = 'chat'
  loadProjectSession(workspaceHash, sessionName)
}

// Sidebar 事件：删除会话
const onSidebarDeleteSession = ({ workspaceHash, sessionName }) => {
  deleteProjectSession(workspaceHash, sessionName)
}

const newChat = async (skipReload = false, worktreeMode = null) => {
  try {
    const params = {}
    if (currentSessionWorkspace.value) params.workspaceHash = currentSessionWorkspace.value
    if (worktreeMode != null) params.worktreeMode = worktreeMode
    const r = await sessionsAPI.createNew(params)
    if (r.success && r.data?.sessionName) {
      currentSession.value = r.data.sessionName
      if (r.data.workspaceHash) currentSessionWorkspace.value = r.data.workspaceHash
      chatRef.value?.resetLocalMessages()
      if (!skipReload) {
        await loadSessions()
        await loadWorkspaces()
        message.success('已新建对话')
      }
    } else {
      message.error('新建对话失败')
    }
  } catch (e) {
    console.error('新建会话失败:', e)
    message.error('新建对话失败: ' + e.message)
  }
}

const startTaskFromWelcome = async (request) => {
  const prompt = typeof request === 'string' ? request : request?.prompt || ''
  const workspaceHash = typeof request === 'string' ? null : request?.workspaceHash

  if (!workspaceHash) {
    pendingStarterPrompt.value = prompt
    showWorkspacePicker.value = true
    return
  }

  try {
    await switchWorkspaceContext(workspaceHash)
    currentSessionWorkspace.value = workspaceHash
    await newChat(true, request?.worktreeMode == null ? null : !!request.worktreeMode)
    await nextTick()
    chatRef.value?.setAgentEngine(request?.agentId || 'native')
    if (request?.configOnly) {
      await chatRef.value?.prepareAgentConfiguration()
    } else if (request?.planMode) {
      await chatRef.value?.enablePlanMode()
    } else {
      await chatRef.value?.startWelcomePrompt(prompt)
    }
  } catch (e) {
    console.error('从欢迎页创建会话失败:', e)
    message.error('创建新会话失败: ' + (e.message || '未知错误'))
  }
}

const switchWelcomeWorkspace = async (workspaceHash) => {
  if (!workspaceHash || workspaceHash === currentSessionWorkspace.value) return
  try {
    await switchWorkspaceContext(workspaceHash)
    currentSessionWorkspace.value = workspaceHash
  } catch (e) {
    console.error('从欢迎页切换项目失败:', e)
    message.error('切换项目失败: ' + (e.message || '未知错误'))
  }
}

const applyPendingStarterPrompt = async () => {
  const prompt = pendingStarterPrompt.value
  pendingStarterPrompt.value = ''
  if (!prompt) return
  await nextTick()
  chatRef.value?.setDraft(prompt)
}

const loadSession = name => {
  currentSession.value = name
  chatRef.value?.loadSession(name, null)
}

// 刷新侧边栏会话列表
const refreshSessionList = async () => {
  try {
    await loadSessions()
    message.success('会话列表已刷新')
  } catch (e) {
    message.error('刷新失败: ' + (e.message || '未知错误'))
  }
}

// 刷新指定会话的聊天记录（强制从后端加载）
const refreshSessionChat = async (name) => {
  chatRef.value?.refreshHistory(name)
}

const deleteSession = async name => {
  const ok = await confirm({ message: `确定要删除此会话吗？` })
  if (!ok) return
  try {
    // 从 workspaceSessions 中找到该会话所属的项目
    let workspaceHash = null
    for (const [hash, sessions] of Object.entries(workspaceSessions.value)) {
      if (sessions.some(s => s.name === name)) {
        workspaceHash = hash
        break
      }
    }
    await sessionsAPI.deleteSession(name, workspaceHash)
    await loadSessions()
    message.success('会话已删除')
  } catch (e) {
    message.error('删除会话失败: ' + e.message)
  }
}

const clearAllSessions = async () => {
  const ok = await confirm({ message: '确定要清空所有会话吗？此操作不可恢复。' })
  if (!ok) return
  try {
    let workspaceHash = currentSessionWorkspace.value
    await sessionsAPI.clearAll(workspaceHash)
    sessions.value = []
    currentSession.value = ''
    chatRef.value?.resetLocalMessages()
    message.success('所有会话已清空')
  } catch (e) {
    message.error('清空会话失败: ' + e.message)
  }
}

const clearChat = async () => {
  const ok = await confirm({ message: '确定要清空当前对话吗？' })
  if (!ok) return
  try {
    const r = await sessionsAPI.createNew({})
    if (r.success && r.data?.sessionName) {
      currentSession.value = r.data.sessionName
      chatRef.value?.resetLocalMessages()
      await loadSessions()
      await loadWorkspaces()
      message.success('对话已清空')
    } else {
      message.error('清空对话失败')
    }
  } catch (e) {
    console.error('清空对话失败:', e)
    message.error('清空对话失败: ' + e.message)
  }
}

onMounted(async () => {
  if (isElementInspectorWindow) {
    unlistenInspectorLoadUrl = window.electronAPI.events.listen('element-inspector-load-url', (url) => {
      nextTick(() => elemPanelRef.value?.loadUrl?.(url))
    })
    window.electronAPI.elementInspectorWindow.ready()
    return
  }
  // 先检测环境，再决定显示哪个启动屏
  await detectEnvironment()
  // 清空过期的 localStorage 端口（桌面端每次启动端口都不同）
  localStorage.removeItem('loopra-port')
  if (isDesktopEnv.value) {
    // 仅桌面环境清除 api-base（端口每次启动都变，由 SplashScreen 重新检测）
    localStorage.removeItem('loopra-api-base')
  }
  console.log('[App] Cleared stale port from localStorage')

  // 异步获取版本信息（不阻塞启动）
  fetchVersionInfo()

  // 监听从 ChatMessage 发出的「在元素界面打开」事件
  window.addEventListener('loopra:open-in-element', onOpenInElement)

  // Agent 调用 bash_start 时自动展开右侧栏“命令”页签
  window.addEventListener('loopra:bash-start', onBashStart)

  // 监听更新窗口（Web 新标签页）发起的自动更新请求
  window.addEventListener('message', onWindowMessage)
})

onBeforeUnmount(() => {
  unlistenInspectorLoadUrl?.()
  unlistenInspectorDraft?.()
  stopHeartbeat()
  window.removeEventListener('resize', collapseSidebarForNarrowViewport)
  window.removeEventListener('loopra:open-in-element', onOpenInElement)
  window.removeEventListener('loopra:bash-start', onBashStart)
  window.removeEventListener('message', onWindowMessage)
})

// 获取版本信息 — 纯后端获取，最多重试 3 次（每次间隔 3 秒）
async function fetchVersionInfo(retryCount = 0) {
  try {
    // 先尝试获取当前版本
    const res = await systemAPI.getCurrentVersion()
    if (res.success && res.data && res.data.version) {
      appVersion.value = res.data.version
    }
    // 再检查最新版本
    try {
      const checkRes = await systemAPI.checkLatestVersion()
      if (checkRes.success && checkRes.data) {
        hasNewVersion.value = checkRes.data.hasNewVersion
        latestVersion.value = checkRes.data.latestVersion || ''
        if (checkRes.data.currentVersion) {
          appVersion.value = checkRes.data.currentVersion
        }
      }
    } catch { /* 版本检查失败 */ }
    // 两个接口都失败了且未获取到版本
    if (!appVersion.value) {
      throw new Error('version not obtained')
    }
  } catch {
    if (retryCount < 2) {
      // 3 秒后重试
      await new Promise(r => setTimeout(r, 3000))
      return fetchVersionInfo(retryCount + 1)
    }
    // 3 次都失败，显示未知版本
    appVersion.value = '未知版本'
  }
  // 桌面端：额外获取 Electron 版本并对比
  if (platform.isElectron) {
    await fetchElectronVersion()
    // 检查核心服务版本是否落后于桌面端版本
    checkCoreServiceVersion()
  }
}

// 版本对比工具
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

// 获取 Electron 版本并判断是否落后
async function fetchElectronVersion() {
  if (!platform.isElectron) return
  try {
    const ver = await window.electronAPI.getElectronVersion()
    electronVersion.value = ver
    desktopAppVersion.value = ver
    if (latestVersion.value && ver && ver !== '未知') {
      desktopHasNewVersion.value = compareVersions(ver, latestVersion.value) < 0
    }
  } catch (e) {
    electronVersion.value = '未知'
    console.warn('获取 Electron 版本失败:', e)
  }
}

// 检查核心服务版本是否落后于桌面端版本
function checkCoreServiceVersion() {
  if (!platform.isElectron) return
  if (!appVersion.value || !desktopAppVersion.value) return
  if (appVersion.value === '未知版本' || desktopAppVersion.value === '未知') return
  
  try {
    // 比较核心服务版本和桌面端版本
    const compareResult = compareVersions(appVersion.value, desktopAppVersion.value)
    if (compareResult < 0) {
      // 核心服务版本落后于桌面端版本，打开独立更新窗口
      console.log(`[App] 核心服务版本落后: 服务版本=${appVersion.value}, 桌面端版本=${desktopAppVersion.value}`)
      openUpdateWindow()
    }
  } catch (e) {
    console.warn('[App] 版本比较失败:', e)
  }
}

// 检查最新版本（后端 + Electron 统一检查）
async function handleCheckVersion() {
  checkingVersion.value = true
  try {
    const res = await systemAPI.checkLatestVersion()
    if (res.success && res.data) {
      hasNewVersion.value = res.data.hasNewVersion
      latestVersion.value = res.data.latestVersion || ''
      releaseUrl.value = res.data.releaseUrl || ''
      if (res.data.currentVersion) {
        appVersion.value = res.data.currentVersion
      }
      // 刷新后重新对比 Electron 版本
      if (platform.isElectron) {
        await fetchElectronVersion()
      }
    }
  } catch { /* 忽略 */ }
  checkingVersion.value = false
}

// 打开下载页面
async function openDesktopDownloadUrl() {
  const url = RELEASE_LATEST_URL
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

// 打开更新界面：Electron 复用启动页窗口承载更新（核心管理/依赖管理）；Web 在页面内展示更新面板（不弹新网页）
function openUpdateWindow() {
  if (platform.isElectron) {
    window.electronAPI?.updateWindow?.open()
  } else {
    showUpdatePanel.value = true
  }
}

// 更新窗口（Web 新标签页）发起的自动更新请求
function onWindowMessage(event) {
  if (event.data && event.data.type === 'loopra-auto-update') {
    void handleAutoUpdate()
  }
}

// 复制文本到剪贴板
function copyText(text) {
  try {
    navigator.clipboard.writeText(text)
    message.success('已复制到剪贴板')
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    message.success('已复制到剪贴板')
  }
}

// 公共流程：选择项目 → 创建新会话 → 关闭弹窗 → 等待一帧 → 发送命令
// 用于"自动更新"、"初始化宠物"等需要跳到聊天界面跑命令的场景
const runInFreshSession = async (cmd, opts = {}) => {
  const {
    successMessage = '已新建会话',
    closeSettings = true
  } = opts

  // 1. 获取项目列表
  const wsRes = await configAPI.listWorkspaces()
  let wsHash = null
  if (wsRes.success && wsRes.data && wsRes.data.length > 0) {
    // 优先使用当前项目，否则选择第一个
    const currentWs = wsRes.data.find(w => w.hash === currentSessionWorkspace.value)
    if (currentWs) {
      wsHash = currentWs.hash
    } else {
      wsHash = wsRes.data[0].hash
    }
  } else {
    message.error('没有可用的项目，请先打开一个项目')
    return false
  }

  // 2. 切换项目上下文
  const ws = wsRes.data.find(w => w.hash === wsHash)
  if (ws) {
    await configAPI.switchWorkspace(ws.path)
    workspaces.value = await applyWorkspaceOrder(wsRes.data)
  }

  // 3. 创建新会话
  const params = { workspaceHash: wsHash }
  const r = await sessionsAPI.createNew(params)
  if (r.success && r.data?.sessionName) {
    currentSession.value = r.data.sessionName
    if (r.data.workspaceHash) currentSessionWorkspace.value = r.data.workspaceHash
    chatRef.value?.resetLocalMessages()
    await loadSessions()
    await loadWorkspaces()
    message.success(successMessage)
  } else {
    message.error('新建会话失败')
    return false
  }

  // 4. 关闭弹窗
  if (closeSettings) showSettings.value = false

  // 5. 稍等一帧让 UI 刷新，然后发送命令
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 300)))
  await chatRef.value?.sendCommand(cmd)
  return true
}

// 自动更新：复用 runInFreshSession 跳到聊天界面发送更新命令（按当前下载源拼接脚本）
const handleAutoUpdate = async () => {
  // 更新转由聊天框执行，关闭 Web 端更新面板（Electron/Settings 场景下无面板，无副作用）
  showUpdatePanel.value = false
  autoUpdating.value = true
  try {
    const updateSource = loadUpdateSource()
    const updateCommand = buildUpdatePrompt(updateSource, platform.isElectron)
    await runInFreshSession(updateCommand, {
      successMessage: '已新建更新会话',
      closeSettings: true
    })
  } catch (e) {
    console.error('自动更新失败:', e)
    message.error('自动更新失败: ' + (e.message || '未知错误'))
  } finally {
    autoUpdating.value = false
  }
}

// 初始化宠物：复用 runInFreshSession 跳到聊天界面发送 npx petdex install 命令
const handleInitPet = async () => {
  try {
    const initCommand = '调用 npx petdex@latest install boba 初始化一个宠物'
    await runInFreshSession(initCommand, {
      successMessage: '已新建宠物初始化会话',
      closeSettings: true
    })
  } catch (e) {
    console.error('初始化宠物失败:', e)
    message.error('初始化宠物失败: ' + (e.message || '未知错误'))
  }
}

// 设置弹窗关闭时刷新项目和会话（用户可能在设置中切换了工作目录）
watch(showSettings, (newVal) => {
  if (!newVal) {
    loadWorkspaces()
    loadSessions()
  }
})
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  border-radius: 10px;
  border: 1px solid var(--border-2);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
  background: var(--bg);
}

.element-inspector-window {
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
}

.app input,
.app textarea,
.app [contenteditable="true"] {
  user-select: text;
  -webkit-user-select: text;
}

:global(body > [class*="modal"]),
:global(body > [class*="dialog"]) {
  user-select: none;
  -webkit-user-select: none;
}

:global(body > [class*="modal"] input),
:global(body > [class*="modal"] textarea),
:global(body > [class*="modal"] [contenteditable="true"]),
:global(body > [class*="dialog"] input),
:global(body > [class*="dialog"] textarea),
:global(body > [class*="dialog"] [contenteditable="true"]) {
  user-select: text;
  -webkit-user-select: text;
}

[data-theme="dark"] .app {
  border-color: var(--border);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
}

/* 主体区域（侧边栏 + 主区域） */
.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
  /* 不能 overflow: hidden，否则会裁剪 Chat.vue 中
     绝对定位的斜杠命令弹出框（position: absolute; bottom: 100%） */
  overflow: visible;
}


/* 主区域 */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg);
  position: relative;
}

.global-search-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: min(16vh, 140px) 16px 24px;
  background: rgba(18, 18, 20, 0.1);
}

.global-search-panel {
  width: min(680px, 100%);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.18);
}

.global-search-input-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-4);
}

.global-search-input-wrap input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 15px;
}

.global-search-input-wrap input::placeholder { color: var(--fg-4); }

.global-search-input-wrap kbd {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-4);
  font-family: var(--mono);
  font-size: 11px;
}

.global-search-results {
  max-height: min(55vh, 440px);
  overflow-y: auto;
  padding: 6px;
}

.global-search-result {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 42px;
  padding: 8px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-3);
  cursor: pointer;
  text-align: left;
}

.global-search-result:hover,
.global-search-result.active {
  background: var(--bg-3);
  color: var(--fg);
}

.global-search-result-main,
.global-search-result-workspace {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.global-search-result-main {
  color: var(--fg);
  font-size: 14px;
}

.global-search-result-workspace {
  max-width: 180px;
  color: var(--fg-4);
  font-size: 12px;
}

.global-search-empty {
  padding: 28px 12px;
  color: var(--fg-4);
  font-size: 13px;
  text-align: center;
}

/* Git 面板滑动动画 */
.git-panel-enter-active,
.git-panel-leave-active {
  transition: width 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}
.git-panel-enter-from,
.git-panel-leave-to {
  width: 0;
  opacity: 0;
}

/* 弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.25);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal {
  width: min(520px, 90vw);
  max-height: 70vh;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  border: 1px solid var(--glass-border);
  border-radius: var(--r-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--glass-shadow);
}

.modal-settings {
  width: min(1400px, 96vw);
  height: min(920px, 94vh);
  max-width: 96vw;
  max-height: 94vh;
  background: var(--bg);
  border-color: var(--border);
}

/* 设置页撑满弹窗（左侧菜单 + 内容区），内部自行滚动 */
.modal-settings .modal-body {
  display: flex;
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
  font-weight: 600;
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
}

.modal-empty {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--fg-4);
}

/* 当前项目 CSS 已迁移到 .modal .workspace-* 下 */

/* 工作目录切换 */
.config-section {
  margin-bottom: 16px;
}

.config-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.modal-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.config-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.config-row:last-child { border-bottom: none; }
.config-key {
  font-family: var(--mono);
  font-weight: 500;
  color: var(--fg-2);
}
.config-val {
  font-family: var(--mono);
  color: var(--fg-3);
  word-break: break-all;
  text-align: right;
  max-width: 60%;
}

/* 提示词 Markdown 渲染样式 */
.prompt-rendered {
  font-size: 14px;
  line-height: 1.7;
  color: var(--fg);
  overflow-x: hidden;
}

.prompt-rendered h1, .prompt-rendered h2, .prompt-rendered h3, .prompt-rendered h4 {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
}

.prompt-rendered h1 {
  font-size: 1.4em;
}

.prompt-rendered h2 {
  font-size: 1.25em;
}

.prompt-rendered h3 {
  font-size: 1.1em;
}

.prompt-rendered p {
  margin: 0.6em 0;
}

.prompt-rendered ul, .prompt-rendered ol {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.prompt-rendered li {
  margin: 0.25em 0;
}

.prompt-rendered pre {
  margin: 0.8em 0;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow-x: auto;
}

.prompt-rendered code {
  font-family: var(--mono);
  font-size: 12px;
}

.prompt-rendered pre code {
  background: none;
  padding: 0;
}

.prompt-rendered strong {
  font-weight: 600;
}

.prompt-rendered a {
  color: var(--accent);
  text-decoration: none;
}

.prompt-rendered a:hover {
  text-decoration: underline;
}

.prompt-rendered blockquote {
  margin: 0.6em 0;
  padding: 0.6em 1em;
  border-left: 3px solid var(--accent);
  background: var(--bg-3);
  border-radius: 0 var(--r) var(--r) 0;
}

.prompt-rendered table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.6em 0;
}

.prompt-rendered th, .prompt-rendered td {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}

.prompt-rendered hr {
  margin: 1em 0;
  border: none;
  border-top: 1px solid var(--border);
}

/* ==================== 元素面板 ==================== */
.element-panel-wrapper {
  position: fixed;
  top: 36px;
  right: 0;
  bottom: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: var(--glass-bg-2);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  border-left: 1px solid var(--glass-border);
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.1);
  transition: width 0.05s;
}

.element-panel-wrapper.dragging {
  transition: none !important;
}

/* 拖拽手柄 */
.element-resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  z-index: 10;
  cursor: ew-resize;
  background: transparent;
  transition: background 0.15s;
}

.element-resize-handle:hover,
.element-panel-wrapper.dragging .element-resize-handle {
  background: var(--accent);
  opacity: 0.5;
}

.element-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--glass-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  min-height: 36px;
}

.element-panel-header .btn-icon-sm {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--fg-4);
  cursor: pointer;
  border-radius: var(--r);
  transition: all 0.12s;
}

.element-panel-header .btn-icon-sm:hover {
  background: var(--bg-3);
  color: var(--fg);
}

/* 更新面板（Web 端页面内弹层，类似更新窗口） */
.update-panel-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}

.update-panel {
  width: min(680px, 92vw);
  height: min(760px, 88vh);
  background: var(--bg);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 25px 80px rgba(0, 0, 0, 0.35);
}



</style>
