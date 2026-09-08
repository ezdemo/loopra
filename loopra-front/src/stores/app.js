import {defineStore} from 'pinia'
import {computed, ref, watch} from 'vue'
import {
  applyFontPreset,
  applyTypographyPreset,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_FONT,
  DEFAULT_UI_FONT_SIZE,
  normalizeFontSize
} from '../utils/fonts'

export const useAppStore = defineStore('app', () => {
  // 连接状态
  const connectionStatus = ref('disconnected')
  const isConnecting = ref(false)
  const lastError = ref(null)
  
  // 会话状态
  const currentSession = ref(null)
  const sessions = ref([])
  const isLoadingSessions = ref(false)
  
  // 消息状态
  const messages = ref([])
  const isStreaming = ref(false)
  const streamingMessage = ref(null)
  
  // 设置状态
  const settings = ref({
    language: 'zh-CN',
    theme: 'gray',
    fontSize: 14,
    uiFontSize: DEFAULT_UI_FONT_SIZE,
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
    fontFamily: DEFAULT_FONT,
    animations: true,
    server: {
      apiBaseUrl: '',
      autoConnect: true
    },
    ai: {
      baseUrl: '',
      apiKey: '',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
      temperature: 0.7
    },
    workspace: {
      dir: '.',
      editMode: 'auto',
      excludeDirs: 'node_modules, .git, target, dist',
      autoRefresh: true
    },
    security: {
      stormBreaker: true,
      pathTraversal: true,
      commandWhitelist: true,
      auditLog: true
    },
    advanced: {
      debugMode: false,
      contextFolding: true,
      messageHealing: true,
      autoSaveInterval: 30,
      maxHistory: 50
    }
  })
  
  // 工具状态
  const tools = ref([])
  const isLoadingTools = ref(false)
  
  // 统计状态
  const usageStats = ref({
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHit: 0
  })
  
  // UI 状态
  const activeModal = ref(null)
  const notifications = ref([])
  const isLoading = ref(false)
  
  // 宠物状态（用于跨组件同步）
  const activePetName = ref('')
  // 桌面端（Electron）环境标志：桌面宠物在独立悬浮窗口展示，对话框内永不显示内嵌宠物
  const isDesktopEnv = ref(typeof window !== 'undefined' && window.electronAPI !== undefined)
  // 桌面宠物独立窗口的可见性（仅供设置页“显示到桌面/隐藏桌面宠物”按钮使用）
  const desktopPetVisible = ref(typeof window !== 'undefined' && Boolean(window.electronAPI?.desktopPet))
  // 用户主动隐藏聊天内宠物（仅 web 端生效，持久化到 localStorage）
  const petHidden = ref(typeof window !== 'undefined' && localStorage.getItem('loopra-pet-hidden') === '1')

  const setPetHidden = (hidden) => {
    petHidden.value = Boolean(hidden)
    if (typeof window !== 'undefined') {
      localStorage.setItem('loopra-pet-hidden', petHidden.value ? '1' : '0')
    }
  }
  
  // 计算属性
  const isConnected = computed(() => connectionStatus.value === 'connected')
  const hasMessages = computed(() => messages.value.length > 0)
  const unreadNotifications = computed(() => 
    notifications.value.filter(n => !n.read).length
  )
  
  // 连接状态管理
  const setConnectionStatus = (status) => {
    connectionStatus.value = status
    isConnecting.value = status === 'connecting'
    if (status === 'connected') {
      lastError.value = null
    }
  }
  
  const setConnectionError = (error) => {
    lastError.value = error
    connectionStatus.value = 'error'
    isConnecting.value = false
  }
  
  // 会话管理
  const setCurrentSession = (session) => {
    currentSession.value = session
  }
  
  const setSessions = (sessionList) => {
    sessions.value = sessionList
    isLoadingSessions.value = false
  }
  
  const addSession = (session) => {
    sessions.value.unshift(session)
  }
  
  const removeSession = (sessionId) => {
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    if (currentSession.value?.id === sessionId) {
      currentSession.value = sessions.value[0] || null
    }
  }
  
  const updateSession = (sessionId, updates) => {
    const index = sessions.value.findIndex(s => s.id === sessionId)
    if (index > -1) {
      sessions.value[index] = { ...sessions.value[index], ...updates }
    }
    if (currentSession.value?.id === sessionId) {
      currentSession.value = { ...currentSession.value, ...updates }
    }
  }
  
  // 消息管理
  const addMessage = (message) => {
    messages.value.push({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      ...message
    })
  }
  
  const updateMessage = (messageId, updates) => {
    const index = messages.value.findIndex(m => m.id === messageId)
    if (index > -1) {
      messages.value[index] = { ...messages.value[index], ...updates }
    }
  }
  
  const removeMessage = (messageId) => {
    messages.value = messages.value.filter(m => m.id !== messageId)
  }
  
  const clearMessages = () => {
    messages.value = []
    streamingMessage.value = null
  }
  
  // 流式消息管理
  const startStreaming = (message) => {
    isStreaming.value = true
    streamingMessage.value = message
    addMessage(message)
  }
  
  const updateStreamingContent = (content) => {
    if (streamingMessage.value) {
      const index = messages.value.findIndex(m => m.id === streamingMessage.value.id)
      if (index > -1) {
        messages.value[index].content += content
      }
    }
  }
  
  const finishStreaming = () => {
    isStreaming.value = false
    streamingMessage.value = null
  }
  
  // 设置管理
  const persistSettings = () => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem('loopra-settings', JSON.stringify(settings.value))
    } catch (e) {
      console.warn('保存设置失败:', e)
    }
  }

  const normalizeTypographySettings = () => {
    const legacyUiFontSize = settings.value.uiFontSize ?? settings.value.fontSize
    const normalizedUiFontSize = normalizeFontSize(legacyUiFontSize, DEFAULT_UI_FONT_SIZE, 11, 18)
    settings.value.uiFontSize = normalizedUiFontSize
    // 保留旧字段并同步它，兼容仍读取 fontSize 的旧组件/配置。
    settings.value.fontSize = normalizedUiFontSize
    settings.value.codeFontSize = normalizeFontSize(settings.value.codeFontSize, DEFAULT_CODE_FONT_SIZE, 10, 16)
  }

  const updateSettings = (newSettings) => {
    settings.value = { ...settings.value, ...newSettings }
    if (!Object.prototype.hasOwnProperty.call(newSettings, 'uiFontSize') && newSettings.fontSize !== undefined) {
      settings.value.uiFontSize = newSettings.fontSize
    }
    normalizeTypographySettings()
    persistSettings()
  }
  
  const loadSettings = () => {
    const savedSettings = localStorage.getItem('loopra-settings')
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings)
        settings.value = { ...settings.value, ...parsed }
        // 旧版本只有 fontSize 字段；只有在新字段确实不存在时才迁移它。
        if (!Object.prototype.hasOwnProperty.call(parsed, 'uiFontSize') && parsed.fontSize !== undefined) {
          settings.value.uiFontSize = parsed.fontSize
        }
        normalizeTypographySettings()
      } catch (e) {
        console.error('加载设置失败:', e)
      }
    }
  }
  
  const resetSettings = () => {
    settings.value = {
      language: 'zh-CN',
      theme: 'gray',
      fontSize: 14,
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      codeFontSize: DEFAULT_CODE_FONT_SIZE,
      fontFamily: DEFAULT_FONT,
      animations: true,
      server: {
        apiBaseUrl: '',
        autoConnect: true
      },
      ai: {
        baseUrl: '',
        apiKey: '',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
        temperature: 0.7
      },
      workspace: {
        dir: '.',
        editMode: 'auto',
        excludeDirs: 'node_modules, .git, target, dist',
        autoRefresh: true
      },
      security: {
        stormBreaker: true,
        pathTraversal: true,
        commandWhitelist: true,
        auditLog: true
      },
      advanced: {
        debugMode: false,
        contextFolding: true,
        messageHealing: true,
        autoSaveInterval: 30,
        maxHistory: 50
      }
    }
    localStorage.removeItem('loopra-settings')
  }
  
  // 工具管理
  const setTools = (toolList) => {
    tools.value = toolList
    isLoadingTools.value = false
  }
  
  const getToolByName = (name) => {
    return tools.value.find(t => t.name === name)
  }
  
  // 统计管理
  const updateUsageStats = (stats) => {
    usageStats.value = { ...usageStats.value, ...stats }
  }
  
  const incrementTokens = (tokens) => {
    usageStats.value.totalTokens += tokens
  }
  
  // UI 管理
  const openModal = (modalName) => {
    activeModal.value = modalName
  }
  
  const closeModal = () => {
    activeModal.value = null
  }
  
  // 通知管理
  const addNotification = (notification) => {
    const id = Date.now()
    notifications.value.push({
      id,
      timestamp: new Date().toISOString(),
      read: false,
      ...notification
    })
    
    if (notification.duration) {
      setTimeout(() => {
        removeNotification(id)
      }, notification.duration)
    }
    
    return id
  }
  
  const removeNotification = (id) => {
    notifications.value = notifications.value.filter(n => n.id !== id)
  }
  
  const markNotificationRead = (id) => {
    const notification = notifications.value.find(n => n.id === id)
    if (notification) {
      notification.read = true
    }
  }
  
  const clearNotifications = () => {
    notifications.value = []
  }
  
  const setLoading = (loading) => {
    isLoading.value = loading
  }

    // ========== 会话隔离的消息/流状态 ==========
    const sessionMessages = ref({})
    const sessionStreaming = ref({})
    const sessionControllers = ref({})

    // ========== 快照检查点状态 ==========
    // 每条用户消息的快照ID映射: sessionId -> [{ msgId, snapshotId }]
    const sessionSnapshots = ref({})
    // Git仓库状态缓存: workspaceHash -> { gitRepo: boolean }
    const snapshotStatus = ref({})

    function ensureSession(name) {
        if (!name) return
        if (!sessionMessages.value[name]) {
            sessionMessages.value[name] = []
        }
    }

    /** 获取指定会话的消息列表 */
    function getSessionMessages(name) {
        if (!name) return []
        ensureSession(name)
        return sessionMessages.value[name]
    }

    /** 设置指定会话的消息列表（用于 loadHistory） */
    function setSessionMessages(name, msgs) {
        if (!name) return
        sessionMessages.value[name] = msgs || []
    }

    /** 向指定会话追加一条消息 */
    function addSessionMessage(name, msg) {
        if (!name) return
        ensureSession(name)
        sessionMessages.value[name].push(msg)
    }

    /** 更新指定会话中的某条消息（通过 id 查找）
     *  @param updater 回调，接收消息对象，直接修改它
     */
    function updateSessionMessage(name, msgId, updater) {
        if (!name) return
        const arr = sessionMessages.value[name]
        if (!arr) return
        const idx = arr.findIndex(m => m.id === msgId)
        if (idx === -1) return
        updater(arr[idx])
        // 替换数组引用触发 computed
        sessionMessages.value[name] = [...arr]
    }

    /** 清空指定会话的消息 */
    function clearSessionMessages(name) {
        if (!name) return
        sessionMessages.value[name] = []
        sessionStreaming.value[name] = false
    }

    /** 设置指定会话的流状态 */
    function setSessionStreaming(name, val) {
        if (name) sessionStreaming.value[name] = val
    }

    /** 获取指定会话的流状态 */
    function getSessionStreaming(name) {
        return name ? (sessionStreaming.value[name] ?? false) : false
    }

    /** 设置指定会话的 AbortController */
    function setSessionController(name, ctrl) {
        if (name) sessionControllers.value[name] = ctrl
    }

    /** 获取指定会话的 AbortController */
    function getSessionController(name) {
        return name ? sessionControllers.value[name] : null
    }

    // ========== 快照检查点管理 ==========

    /** 记录快照ID：将快照与消息关联 */
    function addSnapshot(name, msgId, snapshotId) {
        if (!name) return
        if (!sessionSnapshots.value[name]) sessionSnapshots.value[name] = []
        sessionSnapshots.value[name].push({ msgId, snapshotId })
    }

    /** 获取指定会话的快照列表 */
    function getSessionSnapshots(name) {
        if (!name) return []
        return sessionSnapshots.value[name] || []
    }

    /** 检查 Git 仓库状态是否可用 */
    function isGitRepoAvailable(workspaceHash) {
        if (!workspaceHash) return false
        return snapshotStatus.value[workspaceHash]?.gitRepo === true
    }

    /** 设置 Git 仓库状态缓存 */
    function setGitRepoStatus(workspaceHash, isGitRepo) {
        if (!workspaceHash) return
        snapshotStatus.value[workspaceHash] = { gitRepo: isGitRepo }
    }

    /** 撤回后清除该消息及之后的所有快照记录 */
    function truncateSnapshotsAfter(name, msgId) {
        if (!name || !sessionSnapshots.value[name]) return
        const idx = sessionSnapshots.value[name].findIndex(s => s.msgId === msgId)
        if (idx >= 0) {
            sessionSnapshots.value[name] = sessionSnapshots.value[name].slice(0, idx)
        }
    }

  // 桌面端：外观设置同步写入 userData/ui-settings.json；Web 端写入 localStorage。
  // 因为 file:// 页面 localStorage 在 Electron 中不可靠，桌面端不依赖它恢复外观。
  const persistUiSettings = () => {
    if (typeof window === 'undefined') return
    if (window.electronAPI?.uiSettings) {
      window.electronAPI.uiSettings.set({
        theme: settings.value.theme,
        fontFamily: settings.value.fontFamily,
        uiFontSize: settings.value.uiFontSize,
        codeFontSize: settings.value.codeFontSize
      }).catch(() => {})
      return
    }
    persistSettings()
  }

  // 初始化
  const initialize = () => {
    loadSettings()
    normalizeTypographySettings()
    
    // 从独立 key 读取主题
    const savedTheme = localStorage.getItem('loopra-theme')
    if (savedTheme) {
      settings.value.theme = savedTheme
    }

    const legacyThemes = {light: 'gray', retro: 'gray', 'retro-yellow': 'gray', yellow: 'gray'}
    if (legacyThemes[settings.value.theme]) {
      settings.value.theme = legacyThemes[settings.value.theme]
    }
    
    document.documentElement.setAttribute('data-theme', settings.value.theme)
    document.documentElement.style.fontSize = `${settings.value.uiFontSize}px`
    applyFontPreset(settings.value.fontFamily)
    applyTypographyPreset(settings.value.uiFontSize, settings.value.codeFontSize)

    // 桌面端：启动后从文件读回外观设置（文件优先于 localStorage，覆盖后 watch 自动应用）
    if (typeof window !== 'undefined' && window.electronAPI?.uiSettings) {
      window.electronAPI.uiSettings.get().then((saved) => {
        if (!saved || typeof saved !== 'object') return
        if (typeof saved.fontFamily === 'string') settings.value.fontFamily = saved.fontFamily
        if (typeof saved.theme === 'string') settings.value.theme = saved.theme
        if (saved.uiFontSize !== undefined) {
          settings.value.uiFontSize = normalizeFontSize(saved.uiFontSize, DEFAULT_UI_FONT_SIZE, 11, 18)
        }
        if (saved.codeFontSize !== undefined) {
          settings.value.codeFontSize = normalizeFontSize(saved.codeFontSize, DEFAULT_CODE_FONT_SIZE, 10, 16)
        }
      }).catch(() => {})
    }
  }

  // 监听主题变化，自动同步到全局
  watch(() => settings.value.theme, (val) => {
    document.documentElement.setAttribute('data-theme', val)
    localStorage.setItem('loopra-theme', val)
    persistUiSettings()
  })

  // 监听中文字体变化，即时切换 --sans/--mono
  watch(() => settings.value.fontFamily, (val) => {
    applyFontPreset(val)
    persistUiSettings()
  })

  // 监听字号变化：Web/Electron 使用同一组 CSS 变量，设置页修改后立即生效并持久化。
  watch(() => [settings.value.uiFontSize, settings.value.codeFontSize], ([uiFontSize, codeFontSize]) => {
    const normalizedUiFontSize = normalizeFontSize(uiFontSize, DEFAULT_UI_FONT_SIZE, 11, 18)
    const normalizedCodeFontSize = normalizeFontSize(codeFontSize, DEFAULT_CODE_FONT_SIZE, 10, 16)
    if (settings.value.uiFontSize !== normalizedUiFontSize) settings.value.uiFontSize = normalizedUiFontSize
    if (settings.value.codeFontSize !== normalizedCodeFontSize) settings.value.codeFontSize = normalizedCodeFontSize
    document.documentElement.style.fontSize = `${normalizedUiFontSize}px`
    applyTypographyPreset(normalizedUiFontSize, normalizedCodeFontSize)
    persistUiSettings()
  })
  
  return {
    connectionStatus,
    isConnecting,
    lastError,
    currentSession,
    sessions,
    isLoadingSessions,
    messages,
    isStreaming,
    streamingMessage,
    settings,
    tools,
    isLoadingTools,
    usageStats,
    activeModal,
    notifications,
    isLoading,
    activePetName,
    isDesktopEnv,
    desktopPetVisible,
    petHidden,
    setPetHidden,
    isConnected,
    hasMessages,
    unreadNotifications,
    setConnectionStatus,
    setConnectionError,
    setCurrentSession,
    setSessions,
    addSession,
    removeSession,
    updateSession,
    addMessage,
    updateMessage,
    removeMessage,
    clearMessages,
    startStreaming,
    updateStreamingContent,
    finishStreaming,
    updateSettings,
    loadSettings,
    resetSettings,
    setTools,
    getToolByName,
    updateUsageStats,
    incrementTokens,
    openModal,
    closeModal,
    addNotification,
    removeNotification,
    markNotificationRead,
    clearNotifications,
    setLoading,
      initialize,
      // 会话隔离
      sessionMessages,
      sessionStreaming,
      sessionControllers,
      sessionSnapshots,
      snapshotStatus,
      ensureSession,
      getSessionMessages,
      setSessionMessages,
      addSessionMessage,
      updateSessionMessage,
      clearSessionMessages,
      setSessionStreaming,
      getSessionStreaming,
      setSessionController,
      getSessionController,
      // 快照检查点
      addSnapshot,
      getSessionSnapshots,
      isGitRepoAvailable,
      setGitRepoStatus,
      truncateSnapshotsAfter
  }
})
