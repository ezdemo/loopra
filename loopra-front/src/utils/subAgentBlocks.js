/**
 * 子代理事件 → blocks 重建纯函数。
 *
 * 实时 SSE 事件（Chat.vue 流式处理）与历史回放事件（子代理会话面板拉取 JSONL）
 * 共用同一套累积逻辑：sub_content 既可能是实时 delta 也可能是回放完整段，
 * 均以追加语义写入 content 块，两种场景行为一致。
 *
 * 事件类型与负载（payload 均含 subId / subSessionId）：
 *   sub_start / sub_end / sub_content / sub_reasoning / sub_reasoning_started
 *   sub_tool_call / sub_tool_result / sub_error / sub_choice / sub_complete
 */

/** 创建子代理容器块（挂在主消息流或回放面板的 blocks 数组中）。 */
export const createSubAgentContainer = (subId, extra = {}) => ({
  type: 'sub_agent',
  subId,
  blocks: [],
  status: '运行中',
  taskName: '子代理',
  expanded: true,
  ...extra
})

/** 在 blocks 数组中按 subId 查找子代理容器块，不存在则创建。 */
export const findSubAgentBlock = (blocks, subId) => {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'sub_agent' && blocks[i].subId === subId) {
      return blocks[i]
    }
  }
  const container = createSubAgentContainer(subId)
  blocks.push(container)
  return container
}

/**
 * 应用一条 sub_* 事件到子代理容器块（就地修改）。
 *
 * @param container sub_agent 容器块
 * @param data      事件数据
 * @param options   { attachChoice: 是否把 sub_choice 追加进容器（默认 true；
 *                   主消息流中 HITL 审批需提升为顶级 choice 块，传 false） }
 * @returns {boolean} 是否消费了该事件（未知类型返回 false）
 */
export const applySubAgentEvent = (container, data, options = {}) => {
  const attachChoice = options.attachChoice !== false
  const type = data.type

  if (type === 'sub_start') {
    // 元数据：任务名（不创建内容块，仅更新容器信息）
    container.subSessionId = data.subSessionId || container.subSessionId
    if (data.task) container.taskName = data.task
    return true
  }

  if (type === 'sub_content') {
    const content = data.token ?? data.content ?? ''
    const lb = container.blocks[container.blocks.length - 1]
    if (lb?.type === 'content') lb.content += content
    // 纯空白正文（思考间隙流出的 \n\n）不创建独立块，避免拆散连续思考
    else if (content.trim()) container.blocks.push({type: 'content', content})
    return true
  }

  if (type === 'sub_reasoning') {
    const reasoningContent = data.token ?? data.content ?? ''
    const lb = container.blocks[container.blocks.length - 1]
    if (lb?.type === 'reasoning') lb.content += reasoningContent
    else if (lb?.type === 'reasoning_started') {
      Object.assign(lb, {type: 'reasoning', content: reasoningContent, showContent: false})
    } else container.blocks.push({type: 'reasoning', content: reasoningContent, showContent: false})
    return true
  }

  if (type === 'sub_reasoning_started') {
    const lb = container.blocks[container.blocks.length - 1]
    if (lb?.type !== 'reasoning_started') {
      container.blocks.push({type: 'reasoning_started', showContent: false})
    }
    return true
  }

  if (type === 'sub_tool_call') {
    let name = data.name || ''
    let args = data.args ?? data.arguments ?? ''
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        // 保持原字符串
      }
    }
    container.blocks.push({
      type: 'tool_call',
      toolCallId: data.toolCallId,
      name: name || 'unknown',
      status: '执行中',
      args,
      result: '',
      // 回放场景用事件自带时间戳，实时流用当前时间
      toolStartedAt: data.startedAt || Date.now(),
      expanded: true
    })
    return true
  }

  if (type === 'sub_tool_result') {
    let result = data.result ?? data.content ?? ''
    const rn = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    const targetName = data.name || ''
    let matched = false
    if (targetName) {
      for (let j = container.blocks.length - 1; j >= 0; j--) {
        const b = container.blocks[j]
        if (b.type === 'tool_call' && (data.toolCallId ? b.toolCallId === data.toolCallId : b.name === targetName && !b.result)) {
          fillToolResult(b, rn, data)
          matched = true
          break
        }
      }
    }
    if (!matched && !data.toolCallId) {
      for (let j = container.blocks.length - 1; j >= 0; j--) {
        const b = container.blocks[j]
        if (b.type === 'tool_call' && !b.result) {
          fillToolResult(b, rn, data)
          break
        }
      }
    }
    return true
  }

  if (type === 'sub_error') {
    const errText = data.error || data.content || '未知错误'
    container.blocks.push({type: 'content', content: '❌ ' + errText})
    return true
  }

  if (type === 'sub_choice') {
    // 默认追加进容器（回放面板）；主消息流中 HITL 审批需提升为顶级 choice 块，
    // 传 { attachChoice: false } 时返回 false 由调用方自行处理。
    if (!attachChoice) return false
    let optionsList = data.options || []
    if (typeof optionsList === 'string') {
      try {
        optionsList = JSON.parse(optionsList)
      } catch {
        optionsList = []
      }
    }
    container.blocks.push({
      type: 'choice',
      subId: data.subId,
      options: optionsList,
      question: data.title ? '子代理 ' + data.title : '子代理工具调用需要审批',
      description: data.description || '',
      resolved: false
    })
    return true
  }

  if (type === 'sub_complete') {
    container.status = '已完成'
    if (data.task) container.taskName = data.task
    container.expanded = false
    return true
  }

  if (type === 'sub_end') {
    container.status = data.status === 'aborted' ? '已取消'
      : data.status === 'error' ? '失败'
        : data.status === 'running' ? '运行中' : '已完成'
    return true
  }

  // sub_usage / sub_log 等暂不消费
  return false
}

const fillToolResult = (block, result, data = {}) => {
  block.result = result
  block.status = data.status === 'failed' ? '失败' : '成功'
  if (data.finishedAt) {
    block.toolDurationMs = data.finishedAt - (block.toolStartedAt || data.finishedAt)
  } else {
    block.toolDurationMs = Date.now() - (block.toolStartedAt || Date.now())
  }
  block.expanded = false
}
