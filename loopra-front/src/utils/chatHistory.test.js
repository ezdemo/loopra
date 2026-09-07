import {describe, expect, it} from 'vitest'
import {buildHistoryItems} from './chatHistory'

describe('buildHistoryItems', () => {
  it('merges tool results into assistant tool_call blocks and keeps reasoning folded', () => {
    const raw = [
      {role: 'user', content: '实现登录页', timestamp: 1},
      {
        role: 'assistant',
        reasoning_content: '先看现有页面',
        tool_calls: [{id: 'call_1', function: {name: 'grep', arguments: '{"path":"src"}'}}],
        content: '开始',
        timestamp: 2
      },
      {role: 'tool', tool_call_id: 'call_1', content: '找到 3 个文件', timestamp: 3}
    ]

    const {items, unmergedToolResults} = buildHistoryItems(raw)

    expect(items).toHaveLength(2)
    expect(items[0].role).toBe('user')
    expect(items[0].content).toBe('实现登录页')
    const assistant = items[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.blocks[0].type).toBe('reasoning')
    expect(assistant.blocks[0].content).toBe('先看现有页面')
    expect(assistant.blocks[0].showContent).toBe(false)
    const tool = assistant.blocks[1]
    expect(tool.type).toBe('tool_call')
    expect(tool.name).toBe('grep')
    expect(tool.status).toBe('成功')
    expect(tool.result).toBe('找到 3 个文件')
    expect(tool.expanded).toBe(false)
    expect(assistant.blocks[2].content).toBe('开始')
    expect(unmergedToolResults).toHaveLength(0)
  })

  it('keeps tool results without a matching call as unmerged extras', () => {
    const raw = [
      {role: 'assistant', content: '完成', timestamp: 1},
      {role: 'tool', tool_call_id: 'orphan_1', content: '孤立结果', timestamp: 2}
    ]

    const {items, unmergedToolResults} = buildHistoryItems(raw)

    expect(items).toHaveLength(1)
    expect(unmergedToolResults).toHaveLength(1)
    expect(unmergedToolResults[0].tool_call_id).toBe('orphan_1')
    expect(unmergedToolResults[0].content).toBe('孤立结果')
  })

  it('preserves assistant turn time bounds for the process summary', () => {
    const raw = [
      {role: 'user', content: '检查项目', timestamp: 1000},
      {
        role: 'assistant',
        reasoning_content: '开始检查',
        tool_calls: [{id: 'call_1', function: {name: 'read', arguments: '{}'}}],
        timestamp: 1100
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'ok',
        tool_started_at: 1200,
        tool_finished_at: 42000,
        timestamp: 42000
      },
      {role: 'assistant', content: '完成', timestamp: 43000}
    ]

    const {items} = buildHistoryItems(raw)

    expect(items[1].startedAt).toBe(1000)
    expect(items[1].finishedAt).toBe(43000)
  })

  it('uses the preceding user timestamp for a plain assistant response without tool timing', () => {
    const raw = [
      {role: 'user', content: '你好', timestamp: 1000},
      {role: 'assistant', content: '你好，很高兴见到你', timestamp: 6000}
    ]

    const {items} = buildHistoryItems(raw)

    expect(items[1].startedAt).toBe(1000)
    expect(items[1].finishedAt).toBe(6000)
  })

  it('restores encrypted reasoning as a fixed placeholder without exposing ciphertext', () => {
    const raw = [{
      role: 'assistant',
      response_reasoning: JSON.stringify({type: 'reasoning', encrypted_content: 'secret-ciphertext'}),
      content: '完成',
      timestamp: 1
    }]

    const {items} = buildHistoryItems(raw)

    expect(items[0].blocks[0]).toEqual({type: 'reasoning_started', showContent: false})
    expect(JSON.stringify(items[0].blocks)).not.toContain('secret-ciphertext')
  })

  it('excludes web-hidden user messages by default but can include them for audit', () => {
    const raw = [
      {role: 'user', content: '普通消息', timestamp: 1},
      {role: 'user', content: '[历史上下文折叠]', web_hidden: true, timestamp: 2},
      {role: 'assistant', content: '回复', timestamp: 3}
    ]

    const hiddenOut = buildHistoryItems(raw)
    expect(hiddenOut.items.map(item => item.role === 'assistant' ? item.blocks[0].content : item.content)).toEqual(['普通消息', '回复'])

    const auditOut = buildHistoryItems(raw, true)
    expect(auditOut.items.map(item => item.role === 'assistant' ? item.blocks[0].content : item.content)).toEqual(['普通消息', '[历史上下文折叠]', '回复'])
    expect(auditOut.items[1].webHidden).toBe(true)
  })
})
