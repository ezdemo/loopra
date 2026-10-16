/* @vitest-environment jsdom */

import {flushPromises, shallowMount} from '@vue/test-utils'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createPinia} from 'pinia'
import {nextTick, watchEffect} from 'vue'
import DesktopChatTab from './DesktopChatTab.vue'

const {configAPI, gitAPI, sessionsAPI, subSessionsAPI} = vi.hoisted(() => ({
  configAPI: {
    listWorkspaces: vi.fn(),
    switchWorkspace: vi.fn()
  },
  gitAPI: {
    environment: vi.fn()
  },
  sessionsAPI: {
    list: vi.fn(),
    switchSession: vi.fn()
  },
  subSessionsAPI: {
    list: vi.fn(),
    events: vi.fn()
  }
}))

vi.mock('./services/api', () => ({configAPI, gitAPI, sessionsAPI, subSessionsAPI}))

const initialElectronAPI = window.electronAPI

beforeEach(() => {
  vi.clearAllMocks()
  configAPI.listWorkspaces.mockResolvedValue({success: true, data: []})
  gitAPI.environment.mockResolvedValue({success: true, data: {mode: 'local'}})
  sessionsAPI.switchSession.mockResolvedValue({success: true})
  subSessionsAPI.events.mockResolvedValue({success: true, data: []})
  window.electronAPI = {
    events: {listen: vi.fn(() => () => {})},
    desktopChatTabs: {ready: vi.fn(), reportTitle: vi.fn(), reportSessionUpdated: vi.fn(), reportSessionStatus: vi.fn(), reportWorkspace: vi.fn()},
    desktopChatHeaderMenu: {open: vi.fn().mockResolvedValue(null)},
    elementInspectorWindow: {open: vi.fn().mockResolvedValue({success: true})},
    aiBrowserWindow: {open: vi.fn().mockResolvedValue({success: true})},
    onboarding: {open: vi.fn().mockResolvedValue({success: true})}
  }
})

afterEach(() => {
  if (initialElectronAPI === undefined) delete window.electronAPI
  else window.electronAPI = initialElectronAPI
})

function mountTab() {
  const pinia = createPinia()
  return shallowMount(DesktopChatTab, {
    global: {
      plugins: [pinia],
      stubs: {
        ChatView: true,
        FileEditor: true,
        EditorTabs: true,
        SubAgentPanel: {
          name: 'SubAgentPanel',
          template: '<div class="sub-panel-stub" />',
          methods: {refresh: subPanelRefreshSpy}
        },
        EnvironmentPanel: true,
        DesktopToolPanel: {
          name: 'DesktopToolPanel',
          template: '<div class="desktop-tool-panel-stub" />',
          methods: {
            refreshSubAgents: subPanelRefreshSpy,
            refreshCapabilities: vi.fn(),
            refreshEnvironment: vi.fn(),
            refreshFiles: vi.fn()
          }
        },
        TerminalView: true,
        FileExplorer: true,
        ProjectCapabilitiesPanel: true,
        ActionConfirmDialog: true
      }
    }
  })
}

const subPanelRefreshSpy = vi.fn()

beforeEach(() => {
  subPanelRefreshSpy.mockClear()
})

const item = (overrides = {}) => ({
  subSessionId: 'sub-1',
  task: '探索项目结构',
  profile: 'explore',
  status: 'completed',
  startedAt: 1000,
  endedAt: 2000,
  eventCount: 5,
  mtime: 2000,
  ...overrides
})

describe('DesktopChatTab 子代理回放标签', () => {
  it('首条消息产生时立即向主窗口上报会话更新', async () => {
    const originalHref = window.location.href
    window.history.replaceState({}, '', '/?desktopChatTab=1&sessionName=new-session&workspaceHash=h1')
    sessionsAPI.list.mockResolvedValue({success: true, data: []})
    const wrapper = mountTab()
    await flushPromises()

    await wrapper.vm.onSessionUpdated('new-session', true)

    expect(window.electronAPI.desktopChatTabs.reportSessionUpdated).toHaveBeenCalledWith({
      tabId: 'h1:new-session',
      sessionName: 'new-session',
      workspaceHash: 'h1',
      optimistic: true
    })

    wrapper.unmount()
    window.history.replaceState({}, '', originalHref)
  })

  it('把输入框的运行状态同步上报给主窗口侧栏', async () => {
    const originalHref = window.location.href
    window.history.replaceState({}, '', '/?desktopChatTab=1&sessionName=running-session&workspaceHash=h1')
    const wrapper = mountTab()
    await flushPromises()
    window.electronAPI.desktopChatTabs.reportSessionStatus.mockClear()

    wrapper.vm.onSessionActiveChange(true)
    expect(window.electronAPI.desktopChatTabs.reportSessionStatus).toHaveBeenLastCalledWith({
      tabId: 'h1:running-session',
      sessionName: 'running-session',
      workspaceHash: 'h1',
      running: true
    })

    wrapper.vm.onSessionActiveChange(false)
    expect(window.electronAPI.desktopChatTabs.reportSessionStatus).toHaveBeenLastCalledWith({
      tabId: 'h1:running-session',
      sessionName: 'running-session',
      workspaceHash: 'h1',
      running: false
    })

    wrapper.unmount()
    window.history.replaceState({}, '', originalHref)
  })

  it('renders a Codex-style chat header with only terminal and sidebar actions', async () => {
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.find('.desktop-chat-header').exists()).toBe(true)
    expect(wrapper.find('.desktop-chat-header-title').text()).toBe('新对话')
    expect(wrapper.find('.desktop-activity-bar').exists()).toBe(false)
    expect(wrapper.find('.desktop-right-activity-bar').exists()).toBe(false)
    expect(wrapper.find('.desktop-chat-header-actions').exists()).toBe(true)
    expect(wrapper.findAll('.desktop-chat-header-action')).toHaveLength(2)
    expect(wrapper.find('.desktop-chat-header-action[aria-label="终端"]').exists()).toBe(true)
    await wrapper.find('.desktop-chat-header-action[aria-label="侧边栏"]').trigger('click')
    expect(wrapper.vm.rightPanelOpen).toBe(true)
    expect(wrapper.vm.rightPanelTab).toBe('launcher')

    wrapper.vm.openToolPanel('browser')
    expect(wrapper.vm.rightPanelTab).toBe('browser')
  })

  it('opens the native session menu and handles its selected action', async () => {
    const wrapper = mountTab()
    await flushPromises()

    const trigger = wrapper.find('.desktop-chat-header-menu-trigger')
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    window.electronAPI.desktopChatHeaderMenu.open.mockResolvedValue('project-capabilities')
    await trigger.trigger('click')
    await flushPromises()

    expect(window.electronAPI.desktopChatHeaderMenu.open).toHaveBeenCalledWith('gray')
    expect(wrapper.vm.rightPanelOpen).toBe(true)
    expect(wrapper.vm.rightPanelTab).toBe('project-capabilities')
    expect(wrapper.find('.desktop-chat-header-menu').exists()).toBe(false)
  })

  it('keeps chat tab fixed at first position', async () => {
    const wrapper = mountTab()
    await flushPromises()
    expect(wrapper.vm.editorTabs[0]).toMatchObject({id: 'chat', closable: false})
  })

  it('renders the session title instead of the session id', async () => {
    const originalHref = window.location.href
    window.history.replaceState({}, '', '/?desktopChatTab=1&sessionName=loopra-20260907120754&sessionTitle=%E5%88%9B%E5%BB%BA%E4%B8%80%E4%B8%AAHTML')
    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.find('.desktop-chat-header-title').text()).toBe('创建一个HTML')
    expect(wrapper.find('.desktop-chat-header-title').text()).not.toContain('loopra-20260907120754')

    wrapper.unmount()
    window.history.replaceState({}, '', originalHref)
  })

  it('keeps a global loading layer inside the native chat view until history is ready', async () => {
    const originalHref = window.location.href
    const listeners = {}
    window.history.replaceState({}, '', '/?desktopChatTab=1&sessionName=slow-session&workspaceHash=h1')
    window.electronAPI.events.listen.mockImplementation((channel, callback) => {
      listeners[channel] = callback
      return vi.fn()
    })

    const wrapper = mountTab()
    await flushPromises()

    expect(wrapper.find('.desktop-chat-global-loading').exists()).toBe(true)
    expect(wrapper.find('.desktop-chat-global-loading').attributes('role')).toBe('status')

    // ChatView 的 initial-load-complete 事件会更新这个独立的首次历史加载状态。
    wrapper.vm.initialLoading = false
    await nextTick()
    expect(wrapper.find('.desktop-chat-global-loading').exists()).toBe(false)

    listeners['desktop-chat-tab-global-loading'](true)
    await nextTick()
    expect(wrapper.find('.desktop-chat-global-loading').exists()).toBe(true)

    listeners['desktop-chat-tab-global-loading'](false)
    await nextTick()
    expect(wrapper.find('.desktop-chat-global-loading').exists()).toBe(false)

    wrapper.unmount()
    window.history.replaceState({}, '', originalHref)
  })

  it('openSubAgentTab creates tab, loads events and activates it', async () => {
    subSessionsAPI.events.mockResolvedValue({
      success: true,
      data: [
        {type: 'sub_start', subId: 1, subSessionId: 'sub-1', task: '探索项目结构', startedAt: 1000},
        {type: 'sub_content', subId: 1, content: '完成'},
        {type: 'sub_end', subId: 1, status: 'completed', endedAt: 2000}
      ]
    })
    const wrapper = mountTab()
    await flushPromises()

    await wrapper.vm.openSubAgentTab(item())
    await flushPromises()

    expect(subSessionsAPI.events).toHaveBeenCalledWith('sub-1', null, '')
    expect(wrapper.vm.subAgentTabs).toHaveLength(1)
    expect(wrapper.vm.activeTabId).toBe('sub:sub-1')
    const tab = wrapper.vm.subAgentTabs[0]
    expect(tab.status).toBe('已完成')
    // 任务描述以用户气泡置顶展示，回放块紧随其后
    expect(tab.blocks.map(b => b.type)).toEqual(['sub_user', 'content'])
    expect(tab.blocks[0]).toMatchObject({type: 'sub_user', content: '探索项目结构'})
    // 编辑器标签栏映射：Chat 固定 + 子代理标签（codicon-branch 图标，可关闭）
    const editorTab = wrapper.vm.editorTabs.find(t => t.id === 'sub:sub-1')
    expect(editorTab).toMatchObject({label: '探索项目结构', icon: 'codicon-branch'})
    expect(editorTab.closable).toBeUndefined()
    expect(wrapper.vm.editorTabs[0].id).toBe('chat')
  })

  it('reopening existing sub agent tab only activates it', async () => {
    subSessionsAPI.events.mockResolvedValue({
      success: true,
      data: [
        {type: 'sub_start', subId: 1, subSessionId: 'sub-1', task: '探索项目结构'},
        {type: 'sub_content', subId: 1, content: '完成'},
        {type: 'sub_end', subId: 1, status: 'completed'}
      ]
    })
    const wrapper = mountTab()
    await flushPromises()
    await wrapper.vm.openSubAgentTab(item())
    await flushPromises()
    await wrapper.vm.openSubAgentTab(item())
    await flushPromises()
    expect(wrapper.vm.subAgentTabs).toHaveLength(1)
    expect(subSessionsAPI.events).toHaveBeenCalledTimes(1)
  })

  it('closeTab removes sub agent tab and falls back to chat', async () => {
    const wrapper = mountTab()
    await flushPromises()
    await wrapper.vm.openSubAgentTab(item())
    await flushPromises()
    wrapper.vm.closeTab('sub:sub-1')
    expect(wrapper.vm.subAgentTabs).toHaveLength(0)
    expect(wrapper.vm.activeTabId).toBe('chat')
  })

  it('removing a sub agent session closes its replay tab', async () => {
    subSessionsAPI.events.mockResolvedValue({
      success: true,
      data: [
        {type: 'sub_start', subId: 1, subSessionId: 'sub-1', task: '探索项目结构'},
        {type: 'sub_end', subId: 1, status: 'completed'}
      ]
    })
    const wrapper = mountTab()
    await flushPromises()
    await wrapper.vm.openSubAgentTab(item())
    await flushPromises()
    expect(wrapper.vm.subAgentTabs).toHaveLength(1)

    // 面板删除成功后通过 @removed 通知关闭对应标签
    wrapper.vm.onSubAgentRemoved('sub-1')
    expect(wrapper.vm.subAgentTabs).toHaveLength(0)
    expect(wrapper.vm.activeTabId).toBe('chat')
  })

  it('closeTab still guards dirty file tabs', async () => {
    const wrapper = mountTab()
    wrapper.vm.fileTabs.push({id: 'file-1', path: 'a.java', name: 'a.java', dirty: true})
    wrapper.vm.activeTabId = 'file-1'
    wrapper.vm.closeTab('file-1')
    expect(wrapper.vm.fileTabs).toHaveLength(1)
    expect(wrapper.vm.closeConfirm.visible).toBe(true)
  })

  it('live sub events auto-open tab, apply incrementally and refresh panel list', async () => {
    const wrapper = mountTab()
    await flushPromises()

    wrapper.vm.handleSubAgentEvent({type: 'sub_start', subId: 3, subSessionId: 'sub-live', task: '实时任务'})
    await nextTick()
    expect(wrapper.vm.subAgentTabs).toHaveLength(1)
    expect(wrapper.vm.activeTabId).toBe('chat') // 不打断主聊天

    wrapper.vm.handleSubAgentEvent({type: 'sub_content', subId: 3, subSessionId: 'sub-live', token: '进展'})
    await nextTick()
    expect(wrapper.vm.subAgentTabs[0].blocks[0].content).toBe('进展')

    wrapper.vm.handleSubAgentEvent({type: 'sub_end', subId: 3, subSessionId: 'sub-live', status: 'completed'})
    await nextTick()
    expect(wrapper.vm.subAgentTabs[0].status).toBe('已完成')
  })

  it('ignores live events without subSessionId', async () => {
    const wrapper = mountTab()
    await flushPromises()
    wrapper.vm.handleSubAgentEvent({type: 'sub_usage', subId: 1})
    await nextTick()
    wrapper.vm.handleSubAgentEvent({type: 'sub_log', subId: 1, subSessionId: 'sub-x'})
    await nextTick()
    expect(wrapper.vm.subAgentTabs).toHaveLength(0)
  })

  it('renders ChatView in sub agent mode when sub agent tab is active', async () => {
    subSessionsAPI.events.mockResolvedValue({
      success: true,
      data: [
        {type: 'sub_start', subId: 1, subSessionId: 'sub-1', task: '探索项目结构'},
        {type: 'sub_content', subId: 1, content: '完成'},
        {type: 'sub_end', subId: 1, status: 'completed'}
      ]
    })
    const wrapper = mountTab()
    await flushPromises()
    await wrapper.vm.openSubAgentTab(item())
    await flushPromises()

    // 子代理标签内容区复用 ChatView（subAgent 模式）：界面与主会话完全一致
    const chatViews = wrapper.findAllComponents({name: 'ChatView'})
    const subView = chatViews.find((cv) => cv.props('subAgent')?.subSessionId === 'sub-1')
    expect(subView).toBeTruthy()
    expect(subView.props('subAgent')).toBe(wrapper.vm.subAgentTabs[0])
    expect(subView.props('hideHeader')).toBe(true)
    expect(subView.props('streamingBarHidden')).toBe(true)
  })

  it('refreshes sub agent list on sub_start so running sessions are visible', async () => {
    const wrapper = mountTab()
    await flushPromises()
    // 打开子代理面板（挂载后 ref 才可用）
    wrapper.vm.toggleSubAgentPanel()
    await nextTick()
    expect(wrapper.vm.rightPanelOpen).toBe(true)
    expect(wrapper.vm.rightPanelTab).toBe('sub-agents')
    expect(wrapper.vm.toolPanelRef).toBeTruthy()

    wrapper.vm.handleSubAgentEvent({type: 'sub_start', subId: 3, subSessionId: 'sub-live', task: '实时任务'})
    await nextTick()
    // 运行中的子代理会话立即可见：sub_start 触发列表刷新
    expect(subPanelRefreshSpy).toHaveBeenCalled()
  })

  it('opens project capabilities in the unified workspace panel', async () => {
    const wrapper = mountTab()
    await flushPromises()

    wrapper.vm.toggleProjectCapabilitiesPanel()
    await nextTick()

    expect(wrapper.vm.rightPanelOpen).toBe(true)
    expect(wrapper.vm.rightPanelTab).toBe('project-capabilities')
    expect(wrapper.findAll('.desktop-chat-header-action')).toHaveLength(2)
  })

  it('openSubAgentTab fills blocks through the reactive proxy (ChatView perceives updates)', async () => {
    subSessionsAPI.events.mockResolvedValue({
      success: true,
      data: [
        {type: 'sub_start', subId: 1, subSessionId: 'sub-1', task: '探索项目结构'},
        {type: 'sub_content', subId: 1, content: '完成'},
        {type: 'sub_end', subId: 1, status: 'completed'}
      ]
    })
    const wrapper = mountTab()
    await flushPromises()

    // 追踪数组内元素 blocks 的响应式变化（ChatView 的 subAgent prop 即此代理对象）
    let blocksLength = -1
    const stop = watchEffect(() => {
      blocksLength = wrapper.vm.subAgentTabs[0]?.blocks.length ?? -1
    })
    await nextTick()
    expect(blocksLength).toBe(-1) // 尚未打开标签

    await wrapper.vm.openSubAgentTab(item())
    await flushPromises()
    // 事件拉取完成（sub_user + content 两块）：必须经由响应式代理修改，派生才会重算
    expect(blocksLength).toBe(2)
    stop()
  })

  it('live events update tab blocks through the reactive proxy', async () => {
    const wrapper = mountTab()
    await flushPromises()

    let blocksLength = -1
    const stop = watchEffect(() => {
      blocksLength = wrapper.vm.subAgentTabs[0]?.blocks.length ?? -1
    })
    wrapper.vm.handleSubAgentEvent({type: 'sub_start', subId: 3, subSessionId: 'sub-live', task: '实时任务'})
    await nextTick()
    expect(blocksLength).toBe(0)

    wrapper.vm.handleSubAgentEvent({type: 'sub_content', subId: 3, subSessionId: 'sub-live', token: '进展'})
    await nextTick()
    expect(blocksLength).toBe(1)
    stop()
  })

  it('keeps every streamed delta: high-frequency sub_content events must not be dropped', async () => {
    const wrapper = mountTab()
    await flushPromises()

    wrapper.vm.handleSubAgentEvent({type: 'sub_start', subId: 3, subSessionId: 'sub-live', task: '实时任务'})
    // 模拟流式高频 delta：同一同步批次内连发 10 条（旧 ref+watch 通道每 tick 只留最后一条 → 缺字）
    for (let i = 0; i < 10; i++) {
      wrapper.vm.handleSubAgentEvent({type: 'sub_content', subId: 3, subSessionId: 'sub-live', token: '字' + i})
    }
    await nextTick()

    const blocks = wrapper.vm.subAgentTabs[0].blocks
    expect(blocks.filter((b) => b.type === 'content')).toHaveLength(1)
    expect(blocks[0].content).toBe('字0字1字2字3字4字5字6字7字8字9')
  })

  it('clears sub agent tabs when workspace changes', async () => {
    const wrapper = mountTab()
    await flushPromises()
    await wrapper.vm.openSubAgentTab(item())
    await flushPromises()
    wrapper.vm.workspaceHash = 'h2'
    await nextTick()
    expect(wrapper.vm.subAgentTabs).toHaveLength(0)
  })
})
