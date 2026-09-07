/* @vitest-environment jsdom */

import {shallowMount} from '@vue/test-utils'
import {describe, expect, it} from 'vitest'
import ChatMessage from './ChatMessage.vue'

const BlockRendererStub = {
  name: 'BlockRenderer',
  props: {blocks: {type: Array, required: true}, streaming: {type: Boolean, default: false}},
  template: '<div class="block-renderer-stub"></div>'
}

const CollapseTransitionStub = {
  name: 'CollapseTransition',
  template: '<div><slot /></div>'
}

const mountMessage = (msg, branchDisabled = false, streaming = false) => shallowMount(ChatMessage, {
  props: {msg, idx: 1, snapshotRollbackLoading: new Map(), branchDisabled, streaming},
  global: {stubs: {Teleport: true, BlockRenderer: BlockRendererStub, CollapseTransition: CollapseTransitionStub}}
})

describe('ChatMessage branching', () => {
  it('expands automatic user blocks on demand while keeping the user text visible', async () => {
    const wrapper = mountMessage({
      id: 1,
      role: 'user',
      content: '```折叠块\n调用技能：\n/skill:hv-analysis\n```\n\n你好啊'
    })

    expect(wrapper.find('.user-auto-message').exists()).toBe(true)
    expect(wrapper.find('.user-auto-message-trigger').text()).toContain('附加上下文')
    expect(wrapper.find('.user-auto-message-detail').exists()).toBe(false)
    await wrapper.find('.user-auto-message-trigger').trigger('click')
    expect(wrapper.find('.user-auto-message-detail').text()).toContain('/skill:hv-analysis')
    expect(wrapper.find('.msg-text').text()).toBe('你好啊')
  })

  it('does not offer branching for user messages', () => {
    expect(mountMessage({id: 1, role: 'user', content: 'hello'}).find('[title="继续到新会话"]').exists()).toBe(false)
  })

  it('offers branching for assistant messages and respects disabled state', async () => {
    const message = {id: 2, role: 'assistant', blocks: [{type: 'content', content: 'hi'}]}
    const disabled = mountMessage(message, true)
    expect(disabled.find('[title="继续到新会话"]').attributes('disabled')).toBeDefined()

    const enabled = mountMessage(message)
    await enabled.find('[title="继续到新会话"]').trigger('click')
    expect(enabled.emitted('branchSession')).toEqual([[message, 1]])
  })
})

describe('ChatMessage compacted summary', () => {
  const compactedMessage = {
    id: 10,
    role: 'user',
    time: '10:00',
    content: '[历史上下文折叠]\n<compacted-summary>\n主要意图：实现登录页\n当前进度：已完成\n</compacted-summary>'
  }

  it('renders a compacted notice instead of a normal user bubble', () => {
    const wrapper = mountMessage(compactedMessage)

    expect(wrapper.find('.user-body').exists()).toBe(false)
    expect(wrapper.find('.compacted-summary').exists()).toBe(true)
    expect(wrapper.find('.compacted-summary-title').text()).toBe('较早对话已压缩')
    expect(wrapper.find('.compacted-summary-content').exists()).toBe(false)
  })

  it('expands the checkpoint content on demand', async () => {
    const wrapper = mountMessage(compactedMessage)

    expect(wrapper.find('.compacted-summary-content').exists()).toBe(false)
    await wrapper.find('.compacted-summary-btn').trigger('click')
    expect(wrapper.find('.compacted-summary-content').exists()).toBe(true)
    expect(wrapper.find('.compacted-summary-content').text()).toContain('实现登录页')
  })

  it('emits viewRawEvents when the raw record button is clicked', async () => {
    const wrapper = mountMessage(compactedMessage)

    await wrapper.find('.compacted-summary-btn.primary').trigger('click')
    expect(wrapper.emitted('viewRawEvents')).toEqual([[compactedMessage]])
  })
})

describe('ChatMessage assistant process summary', () => {
  it('folds the process before the final finish response and keeps the finish visible', async () => {
    const processBlocks = [
      {type: 'reasoning', content: '先检查项目', showContent: false},
      {type: 'tool_call', name: 'read', status: '成功', result: 'ok'},
      {type: 'content', content: '检查完成，继续处理。'}
    ]
    const finish = {type: 'tool_call', name: 'finish', status: '成功', result: '最终结果'}
    const wrapper = mountMessage({id: 20, role: 'assistant', blocks: [...processBlocks, finish]})

    expect(wrapper.find('.assistant-process-summary').exists()).toBe(true)
    expect(wrapper.find('.assistant-process-toggle').text()).toContain('思考过程')
    expect(wrapper.findAllComponents({name: 'BlockRenderer'})).toHaveLength(1)
    expect(wrapper.findComponent({name: 'BlockRenderer'}).props('blocks')).toEqual([finish])

    await wrapper.find('.assistant-process-toggle').trigger('click')
    expect(wrapper.findAllComponents({name: 'BlockRenderer'})).toHaveLength(2)
    expect(wrapper.findAllComponents({name: 'BlockRenderer'})[0].props('blocks')).toEqual(processBlocks)
    expect(wrapper.findAllComponents({name: 'BlockRenderer'})[1].props('blocks')).toEqual([finish])
  })

  it('uses the last final content as the visible response when finish is absent', () => {
    const blocks = [
      {type: 'reasoning', content: '思考', showContent: false},
      {type: 'tool_call', name: 'read', status: '成功', result: 'ok'},
      {type: 'content', content: '最终正文'}
    ]
    const wrapper = mountMessage({id: 21, role: 'assistant', blocks})

    expect(wrapper.find('.assistant-process-summary').exists()).toBe(true)
    const renderers = wrapper.findAllComponents({name: 'BlockRenderer'})
    expect(renderers).toHaveLength(1)
    expect(renderers[0].props('blocks')).toEqual([{type: 'content', content: '最终正文'}])
  })

  it('shows the recorded turn duration and collapses the process with the global collapse action', async () => {
    const wrapper = mountMessage({
      id: 22,
      role: 'assistant',
      startedAt: 1000,
      finishedAt: 43000,
      blocks: [
        {type: 'reasoning', content: '思考', showContent: false},
        {type: 'content', content: '最终正文'}
      ]
    })

    expect(wrapper.find('.assistant-process-toggle').text()).toContain('用时 42秒')
    await wrapper.find('.assistant-process-toggle').trigger('click')
    expect(wrapper.find('.assistant-process-detail').exists()).toBe(true)

    window.dispatchEvent(new CustomEvent('loopra:collapse-all-blocks'))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.assistant-process-detail').exists()).toBe(false)
  })

  it('shows the elapsed time while live process blocks are still streaming', () => {
    const wrapper = mountMessage({
      id: 24,
      role: 'assistant',
      turnStartedAt: Date.now() - 5000,
      blocks: [{type: 'reasoning', content: '正在思考', showContent: false}]
    }, false, true)

    expect(wrapper.find('.assistant-process-summary').exists()).toBe(true)
    expect(wrapper.find('.assistant-process-toggle').text()).toContain('用时')
    expect(wrapper.find('.block-renderer-stub').exists()).toBe(true)
    wrapper.unmount()
  })

  it('does not add a process summary when the message only contains its final response', () => {
    const wrapper = mountMessage({
      id: 23,
      role: 'assistant',
      blocks: [{type: 'tool_call', name: 'finish', status: '成功', result: '完成'}]
    })

    expect(wrapper.find('.assistant-process-summary').exists()).toBe(false)
    expect(wrapper.findAllComponents({name: 'BlockRenderer'})).toHaveLength(1)
  })
})
