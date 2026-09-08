/* @vitest-environment jsdom */

import {flushPromises, shallowMount} from '@vue/test-utils'
import {createPinia} from 'pinia'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {nextTick, reactive} from 'vue'
import ChatView from './Chat.vue'

// jsdom 缺失的 DOM API：Chat.vue 的消息容器使用 ResizeObserver / scrollTo
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = ResizeObserverStub
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}

const api = vi.hoisted(() => {
  const fn = () => vi.fn()
  return {
    agentAPI: {
      getSessionStatus: fn(), getUsage: fn(), getInfo: fn(), getStats: fn(),
      getCommands: fn(), getSkills: fn(), getSystemPrompt: fn(), getMode: fn(), getHistory: fn()
    },
    chatAPI: {abort: fn()},
    configAPI: {
      listWorkspaces: fn(), updateConfig: fn(), getConfig: fn(),
      getCustomBaseURL: fn(), getBaseURL: fn()
    },
    gitAPI: {environment: fn(), workingFileContent: fn()},
    sessionsAPI: {list: fn(), getDetails: fn(), getChecklist: fn(), getGoal: fn(), getMode: fn()},
    snapshotAPI: {list: fn(), create: fn(), rollback: fn()},
    subSessionsAPI: {chat: fn(), events: fn(), list: fn()}
  }
})

vi.mock('../services/api', () => api)
vi.mock('ant-design-vue', () => ({
  message: {info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn()}
}))
vi.mock('@ant-design/icons-vue', () => ({
  CheckOutlined: {template: '<span />'},
  CloseOutlined: {template: '<span />'},
  FileTextOutlined: {template: '<span />'}
}))

function mountChat(subAgent, extraProps = {}) {
  return shallowMount(ChatView, {
    props: {
      sessionName: 'sess-1',
      workspaceHash: 'h1',
      hideHeader: true,
      streamingBarHidden: true,
      subAgent,
      ...extraProps
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        ChatInput: {template: '<div class="chat-input-stub" />'},
        ChatMessage: {template: '<div class="chat-message-stub" />'},
        BlockRenderer: {template: '<div />'},
        DiffViewer: {template: '<div />'},
        ActionConfirmDialog: {template: '<div />'}
      }
    }
  })
}

const makeTab = (overrides = {}) => ({
  type: 'sub_agent',
  subId: 'sub-1',
  subSessionId: 'sub-1',
  taskName: '审查代码',
  status: '已完成',
  expanded: true,
  loading: false,
  blocks: [
    {type: 'sub_user', content: '请审查这段代码'},
    {type: 'content', content: '审查完成，发现 1 个问题。'}
  ],
  ...overrides
})

describe('ChatView 子代理会话模式（复用主会话聊天界面）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.agentAPI.getHistory.mockResolvedValue({success: true, data: []})
  })

  it('shows placeholder while subAgent blocks are empty', async () => {
    const wrapper = mountChat(makeTab({blocks: []}))
    await flushPromises()
    expect(wrapper.find('.sub-agent-loading').exists()).toBe(true)
    expect(wrapper.findAllComponents({name: 'ChatMessage'}).length).toBe(0)
  })

  it('derives user/assistant messages from subAgent blocks and hides placeholder', async () => {
    const tab = makeTab()
    const wrapper = mountChat(tab)
    await flushPromises()

    expect(wrapper.find('.sub-agent-loading').exists()).toBe(false)
    // ChatMessage 为异步组件，shallowMount 不 stub：断言消息容器（v-for 派生）数量
    expect(wrapper.findAll('.virtual-message-item').length).toBe(2)
  })

  it('reacts to blocks appended after mount (loading flow)', async () => {
    // 产品中 tab 来自 ref 数组（reactive 代理）；用 reactive 包装保持同一语义
    const tab = reactive(makeTab({blocks: []}))
    const wrapper = mountChat(tab)
    await flushPromises()
    expect(wrapper.find('.sub-agent-loading').exists()).toBe(true)

    // 模拟 loadSubAgentEvents 填充 blocks
    tab.blocks.push({type: 'sub_user', content: '任务'})
    tab.blocks.push({type: 'content', content: '完成'})
    await nextTick()
    await flushPromises()

    expect(wrapper.find('.sub-agent-loading').exists()).toBe(false)
    expect(wrapper.findAll('.virtual-message-item').length).toBe(2)
  })

  it('sends continue-chat via subSessionsAPI and appends events to tab blocks', async () => {
    const tab = makeTab()
    const wrapper = mountChat(tab)
    await flushPromises()

    api.subSessionsAPI.chat.mockImplementation((id, options, onMessage, onDone) => {
      onMessage({type: 'sub_content', content: '好的，继续执行。'})
      onMessage({type: 'sub_end', status: 'completed'})
      onDone()
      return {abort: vi.fn()}
    })

    wrapper.vm.sendSubAgentMessage([], '继续审查')
    await flushPromises()

    expect(api.subSessionsAPI.chat).toHaveBeenCalledWith(
        'sub-1',
        expect.objectContaining({message: '继续审查', workspaceHash: 'h1', sessionName: 'sess-1'}),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function)
    )
    // 用户气泡 + 追加的子代理内容
    expect(tab.blocks.some((b) => b.type === 'sub_user' && b.content === '继续审查')).toBe(true)
    expect(tab.blocks.some((b) => b.type === 'content' && b.content.includes('好的，继续执行'))).toBe(true)
    expect(tab.status).toBe('已完成')
    // 界面更新为 4 条消息：任务、回放助手、续对话用户 + 助手
    await nextTick()
    expect(wrapper.findAll('.virtual-message-item').length).toBe(4)
  })

  it('does not show welcome screen in sub agent mode', async () => {
    const wrapper = mountChat(makeTab())
    await flushPromises()
    expect(wrapper.find('.welcome-screen').exists()).toBe(false)
  })

  it('notifies the native host after initial session history finishes loading', async () => {
    let resolveHistory
    api.agentAPI.getHistory.mockImplementationOnce(() => new Promise((resolve) => { resolveHistory = resolve }))
    const wrapper = mountChat(null)
    await nextTick()

    expect(wrapper.emitted('initialLoadComplete')).toBeUndefined()

    resolveHistory({success: true, data: []})
    await flushPromises()

    expect(wrapper.emitted('initialLoadComplete')).toHaveLength(1)
  })

  it('opens the workspace menu upward when the space below is insufficient', async () => {
    const wrapper = mountChat(null, {
      sessionName: null,
      workspaceHash: null,
      workspaces: [{hash: 'h1', name: '项目一', path: '/tmp/project'}]
    })
    const row = wrapper.find('.welcome-workspace-row').element
    const messages = wrapper.find('.messages').element
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({top: 640, bottom: 684, height: 44})
    vi.spyOn(messages, 'getBoundingClientRect').mockReturnValue({top: 100, bottom: 720, height: 620})

    await wrapper.find('.welcome-workspace-button').trigger('click')
    await nextTick()

    expect(wrapper.find('.welcome-workspace-menu').classes()).toContain('opens-above')
  })
})
