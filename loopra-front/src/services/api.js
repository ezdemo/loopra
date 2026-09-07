import axios from 'axios'
import {message} from 'ant-design-vue'

/** 默认兜底值，运行时优先读 public/config.json */
export const DEFAULT_API_BASE = 'http://localhost:4567'

/** 应用启动时调用一次，从 public/config.json 加载默认地址到 localStorage */
export async function initConfig() {
  try {
    const resp = await fetch('/config.json')
    if (resp.ok) {
      const cfg = await resp.json()
      if (cfg.apiBase && !localStorage.getItem('loopra-api-base')) {
        localStorage.setItem('loopra-api-base', cfg.apiBase)
      }
    }
  } catch { /* 加载失败则用 DEFAULT_API_BASE */ }
}

// 读取持久化的 API 地址（用户在设置页配置的）
// 优先级：localStorage 用户设置 > config.json > 硬编码
export function getCustomBaseURL() {
  return localStorage.getItem('loopra-api-base') || DEFAULT_API_BASE
}

/**
 * 将后端返回的相对 API 路径（如 /api/pets/xxx/spritesheet）解析为完整 URL。
 * 与 axios baseURL 逻辑一致，适配用户在设置页/启动时配置的服务端端口；
 * 桌面端 Electron 以 file:// 协议加载页面，相对路径会解析到本地文件系统，必须使用完整地址。
 */
export function resolveApiUrl(path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  const base = (getCustomBaseURL() || DEFAULT_API_BASE).replace(/\/+$/, '')
  return base + (path.startsWith('/') ? path : '/' + path)
}

const api = axios.create({
  baseURL: '/api',  // 默认值，请求拦截器中会动态覆盖
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// 请求拦截器
api.interceptors.request.use(
  (config) => {
    // 动态 baseURL：优先使用用户配置的服务端地址
    const customBase = getCustomBaseURL()
    if (customBase) {
      config.baseURL = customBase.replace(/\/+$/, '') + '/api'
    }
    
    // 添加认证令牌
    const token = localStorage.getItem('loopra-token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    
    // 添加请求ID用于追踪
    config.headers['X-Request-ID'] = generateRequestId()
    
    // 添加时间戳
    config.headers['X-Timestamp'] = Date.now().toString()
    
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器
api.interceptors.response.use(
  (response) => {
    // 记录响应时间
    const requestTime = response.config.headers['X-Timestamp']
    if (requestTime) {
      const duration = Date.now() - parseInt(requestTime)
      console.debug(`API请求完成: ${response.config.url} (${duration}ms)`)
    }

    const data = response.data
    // 后端业务错误（HTTP 200 但 success=false）
    if (data && data.success === false) {
      const errMsg = data.error || data.message || '操作失败'
      if (!response.config.silent) message.error(errMsg)
      return Promise.reject({ code: response.status, message: errMsg, data })
    }

    return data
  },
  (error) => {
    if (error.config?.silent) return Promise.reject(error)
    console.error('API Error:', error)

    if (error.response) {
      const { status, data } = error.response
      const errorMsg = data?.error || data?.message || error.message || '未知错误'

      switch (status) {
        case 401:
          localStorage.removeItem('loopra-token')
          window.location.href = '/login'
          break
        case 403:
          message.error('权限不足: ' + errorMsg)
          break
        case 404:
          message.error('资源不存在: ' + (error.config?.url || ''))
          break
        case 429:
          message.warning('请求过于频繁，请稍后重试')
          break
        default:
          if (status >= 500) {
            message.error('服务器错误: ' + errorMsg)
          } else {
            message.error(errorMsg)
          }
      }

      return Promise.reject({
        code: status,
        message: errorMsg,
        data: data
      })
    }

    if (error.code === 'ECONNABORTED') {
      message.error('请求超时，请检查网络连接')
      return Promise.reject({
        code: 'TIMEOUT',
        message: '请求超时，请检查网络连接'
      })
    }

    if (!window.navigator.onLine) {
      message.error('网络连接已断开')
      return Promise.reject({
        code: 'OFFLINE',
        message: '网络连接已断开'
      })
    }

    message.error('请求失败: ' + (error.message || '未知错误'))
    return Promise.reject(error)
  }
)

// 生成请求ID
function generateRequestId() {
  return 'req_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36)
}

// 聊天 API
export const chatAPI = {
  // 同步聊天 - POST /api/chat
  sendMessage: (message) => {
    return api.post('/chat', { message })
  },
  
  // 中断当前聊天 - POST /api/chat/abort
  abort: (options = {}) => {
    const body = {}
    if (options.workspaceHash) body.workspaceHash = options.workspaceHash
    if (options.sessionName) body.sessionName = options.sessionName
    if (options.requestId) body.requestId = options.requestId
    return api.post('/chat/abort', body)
  },

    // SSE流式聊天 - POST /api/chat/stream
  sendMessageStream: (message, onMessage, onDone, onError, options = {}) => {
    const abortController = new AbortController()
    const requestId = generateRequestId()

    ;(async () => {
      try {
        const requestBody = { message, requestId }
        // 添加项目和会话信息
        if (options.workspaceHash) requestBody.workspaceHash = options.workspaceHash
        if (options.sessionName) requestBody.sessionName = options.sessionName
        if (options.model) requestBody.model = options.model
        if (options.modelChannelId) requestBody.modelChannelId = options.modelChannelId
        if (options.reasoningEffort) requestBody.reasoningEffort = options.reasoningEffort
        if (options.fastMode) requestBody.fastMode = options.fastMode
        if (options.action) requestBody.action = options.action
        if (options.linkedProjectHashes?.length) requestBody.linkedProjectHashes = options.linkedProjectHashes
          // 添加图片（base64 Data URI 列表）
          if (options.images && options.images.length > 0) {
              requestBody.images = options.images
          }

          // 剔除尾部斜杠，防止 apiBase 为 '/' 时产生协议相对 URL
          const base = (getCustomBaseURL() || '').replace(/\/+$/, '')
          // base 剔除斜杠后若为空，使用相对路径（由 Vite 代理转发到后端）
        const url = base ? `${base}/api/chat/stream` : '/api/chat/stream'
        const res = await fetch(url, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'X-Request-ID': requestId,
            'X-Timestamp': Date.now().toString()
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal
        })

        if (!res.ok) {
          const text = await res.text()
          if (onError) onError(new Error(`HTTP ${res.status}: ${text}`))
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEventType = null

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop()

          for (const line of lines) {
            const trimmed = line.trim()

            if (trimmed === '') {
              currentEventType = null
              continue
            }
            if (trimmed.startsWith(':')) continue

            if (trimmed.startsWith('event:')) {
              currentEventType = trimmed.slice(6).trim()
            } else if (trimmed.startsWith('data:')) {
              const payload = trimmed.slice(5).trim()
              if (payload === '[DONE]') {
                if (onDone) onDone()
                return
              }

              try {
                const parsed = JSON.parse(payload)
                if (typeof parsed === 'string') {
                  if (onMessage) onMessage({ type: currentEventType, content: parsed })
                } else if (parsed && typeof parsed === 'object') {
                  if (onMessage) onMessage({ type: currentEventType, ...parsed })
                } else {
                  if (onMessage) onMessage({ type: currentEventType, content: payload })
                }
              } catch (e) {
                if (onMessage) onMessage({ type: currentEventType, content: payload })
              }
              currentEventType = null
            }
          }
        }
        if (onDone) onDone()
      } catch (err) {
        if (err.name !== 'AbortError' && onError) onError(err)
      }
    })()

    return { requestId, abort: () => abortController.abort() }
  }
}

// Agent API
export const agentAPI = {
  // 获取Agent状态 - GET /api/agent/status
  getStatus: () => {
    return api.get('/agent/status')
  },
  
  // 获取指定会话运行状态 - GET /api/agent/session-status?workspaceHash=xxx&sessionName=xxx
  getSessionStatus: (workspaceHash, sessionName) => {
    return api.get('/agent/session-status', {
      params: {workspaceHash, sessionName},
      silent: true
    })
  },

  // 获取 bash 后台命令会话 - GET /api/agent/bash-sessions?workspaceHash=xxx（可选，空则全部项目）
  getBashSessions: (workspaceHash) => {
    const params = {}
    if (workspaceHash) params.workspaceHash = workspaceHash
    return api.get('/agent/bash-sessions', {
      params,
      silent: true
    })
  },

  // 手动关闭 bash 后台会话 - POST /api/agent/bash-sessions/terminate
  terminateBashSession: (sessionId, workspaceHash) => {
    const body = {sessionId}
    if (workspaceHash) body.workspaceHash = workspaceHash
    return api.post('/agent/bash-sessions/terminate', body, {
      silent: true
    })
  },

  // 获取 bash 后台会话累积输出日志 - GET /api/agent/bash-sessions/log?sessionId=xxx&workspaceHash=xxx（可选）
  getBashSessionLog: (sessionId, workspaceHash) => {
    const params = {sessionId}
    if (workspaceHash) params.workspaceHash = workspaceHash
    return api.get('/agent/bash-sessions/log', {
      params,
      silent: true
    })
  },

  // 获取历史消息 - GET /api/agent/history?workspaceHash=xxx&sessionName=xxx
  getHistory: (workspaceHash, sessionName) => {
    const params = {}
    if (workspaceHash) params.workspaceHash = workspaceHash
    if (sessionName) params.sessionName = sessionName
    return api.get('/agent/history', { params })
  },

  // 获取原始事件日志（压缩前消息与 tool result） - GET /api/agent/history/events?workspaceHash=xxx&sessionName=xxx
  getRawEvents: (workspaceHash, sessionName) => {
    const params = {}
    if (workspaceHash) params.workspaceHash = workspaceHash
    if (sessionName) params.sessionName = sessionName
    return api.get('/agent/history/events', { params })
  },

  // 获取会话计划模式 - GET /api/agent/mode?workspaceHash=xxx&sessionName=xxx
  getMode: (workspaceHash, sessionName) => {
    const params = {}
    if (workspaceHash) params.workspaceHash = workspaceHash
    if (sessionName) params.sessionName = sessionName
    return api.get('/agent/mode', { params })
  },

  // 通过 Web UI 切换会话计划模式 - POST /api/agent/mode
  setMode: (workspaceHash, sessionName, enabled) => {
    return api.post('/agent/mode', { workspaceHash, sessionName, enabled })
  },
  
  // 执行命令 - POST /api/chat
  runCommand: (command) => {
    return api.post('/chat', { message: command })
  },
  
  // 获取Agent信息 - GET /api/agent/info
  getInfo: () => {
    return api.get('/agent/info')
  },
  
  // 获取Agent统计 - GET /api/agent/stats
  getStats: () => {
    return api.get('/agent/stats')
  },
  
  // 获取可用命令列表 - GET /api/agent/commands
  getCommands: () => {
    return api.get('/agent/commands')
  },
  
  // 获取可用skill列表 - GET /api/agent/skills
  getSkills: () => {
    return api.get('/agent/skills')
  },

  // 获取当前项目的 Skill/MCP 能力摘要 - GET /api/agent/project-capabilities?workspaceHash=xxx
  getProjectCapabilities: (workspaceHash) => {
    return api.get('/agent/project-capabilities', {
      params: {workspaceHash},
      silent: true
    })
  },

  // 重新加载当前项目的 Skill/MCP 配置 - POST /api/agent/project-capabilities/refresh?workspaceHash=xxx
  refreshProjectCapabilities: (workspaceHash) => {
    return api.post('/agent/project-capabilities/refresh', null, {
      params: {workspaceHash},
      silent: true
    })
  },

    // 获取当前会话的系统提示词 - GET /api/agent/prompt?workspaceHash=xxx&sessionName=xxx
    getSystemPrompt: (params) => {
        return api.get('/agent/prompt', {params: params || {}})
  }
}

// 常用要求预设 API
export const promptPresetsAPI = {
  list: () => api.get('/prompt-presets'),
  save: (presets) => api.put('/prompt-presets', {presets})
}

// 会话 API
const sessionPathName = (name) => encodeURIComponent(name)

export const sessionsAPI = {
  // 列出所有会话 - GET /api/sessions?workspaceHash=xxx
  list: (workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get('/sessions', { params })
  },
  
  // 获取当前会话信息 - GET /api/sessions/current
  getCurrent: () => {
    return api.get('/sessions/current')
  },
  
  // 新建空白会话 - POST /api/sessions/new?workspaceHash=xxx&sessionName=xxx
  createNew: (params) => {
    return api.post('/sessions/new', null, { params: params || {} })
  },

  // 获取会话固定的模型、渠道和思考强度
  getSettings: (name, workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get(`/sessions/${sessionPathName(name)}/settings`, { params })
  },

  // 更新会话固定的模型、渠道和思考强度（未提供的字段由后端保持不变）
  setSettings: (name, workspaceHash, settings) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.put(`/sessions/${sessionPathName(name)}/settings`, settings || {}, { params })
  },

  // 按助手消息持久化的 diff 反向回打补丁，不影响会话历史
  revertFileChanges: (workspaceHash, changes) => {
    return api.post('/sessions/file-changes/revert', { workspaceHash, changes })
  },
  // 分支会话 - POST /api/sessions/{name}/branch?workspaceHash=xxx&messageCount=N
  branchSession: (name, workspaceHash, messageCount) => {
    const params = { workspaceHash, messageCount }
    return api.post(`/sessions/${sessionPathName(name)}/branch`, null, { params })
  },
  
  // 切换会话 - POST /api/sessions/{name}?workspaceHash=xxx
  switchSession: (name, workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.post(`/sessions/${sessionPathName(name)}`, null, { params })
  },
  
  // 删除会话 - DELETE /api/sessions/{name}?workspaceHash=xxx
  deleteSession: (name, workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.delete(`/sessions/${sessionPathName(name)}`, { params })
  },

  // 清空所有会话 - DELETE /api/sessions?workspaceHash=xxx
  clearAll: (workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.delete('/sessions', { params })
  },

  // 清理早于指定时间（epoch 毫秒）的过期会话 - DELETE /api/sessions/cleanup?workspaceHash=xxx&before=xxx
  clearBefore: (workspaceHash, before) => {
    return api.delete('/sessions/cleanup', { params: { workspaceHash, before } })
  },
  
  // 获取会话详情 - GET /api/sessions/{name}
  getDetails: (name) => {
    return api.get(`/sessions/${sessionPathName(name)}`)
  },
  
  // 重命名会话（修改显示名称） - PUT /api/sessions/{name}/title?workspaceHash=xxx  body: { title }
  renameSession: (name, workspaceHash, title) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.put(`/sessions/${sessionPathName(name)}/title`, { title }, { params })
  },
  
  // 导出会话 - GET /api/sessions/{name}/export
  exportSession: (name) => {
    return api.get(`/sessions/${sessionPathName(name)}/export`, { responseType: 'blob' })
  },
  
  // 导入会话 - POST /api/sessions/import
  importSession: (file) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/sessions/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
  
  // 获取会话清单 - GET /api/sessions/{name}/checklist?workspaceHash=xxx
  getChecklist: (name, workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get(`/sessions/${sessionPathName(name)}/checklist`, { params })
  },

  // 获取会话 Goal - GET /api/sessions/{name}/goal?workspaceHash=xxx
  getGoal: (name, workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get(`/sessions/${sessionPathName(name)}/goal`, { params })
  },

  // 查询会话隔离分支模式 - GET /api/sessions/{name}/worktree?workspaceHash=xxx
  getWorktreeMode: (name, workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get(`/sessions/${sessionPathName(name)}/worktree`, { params })
  },

  // 切换会话隔离分支模式 - PUT /api/sessions/{name}/worktree?workspaceHash=xxx  body: { worktreeMode, mergeMode }
  setWorktreeMode: (name, workspaceHash, body, options = {}) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.put(`/sessions/${sessionPathName(name)}/worktree`, body || {}, { params, silent: options.silent })
  },

}

// 子代理会话 API（只读回放：子代理会话挂在主代理会话下）
export const subSessionsAPI = {
  // 列出某主代理会话下的子代理会话 - GET /api/sub-sessions?workspaceHash=xxx&sessionName=xxx
  list: (workspaceHash, sessionName) => {
    return api.get('/sub-sessions', { params: { workspaceHash, sessionName } })
  },

  // 读取子代理会话事件（重建回放块） - GET /api/sub-sessions/{subSessionId}/events?workspaceHash=xxx&sessionName=xxx
  events: (subSessionId, workspaceHash, sessionName) => {
    return api.get(`/sub-sessions/${subSessionId}/events`, { params: { workspaceHash, sessionName } })
  },

  // 删除子代理会话 - DELETE /api/sub-sessions/{subSessionId}?workspaceHash=xxx&sessionName=xxx
  remove: (subSessionId, workspaceHash, sessionName) => {
    return api.delete(`/sub-sessions/${subSessionId}`, { params: { workspaceHash, sessionName } })
  },

  // 继续对话 - POST /api/sub-sessions/{subSessionId}/chat?workspaceHash=xxx&sessionName=xxx
  // SSE 流式返回 sub_* 事件；options: { message, workspaceHash, sessionName }
  chat: (subSessionId, options = {}, onMessage, onDone, onError) => {
    const abortController = new AbortController()

    ;(async () => {
      try {
        const query = new URLSearchParams()
        if (options.workspaceHash) query.set('workspaceHash', options.workspaceHash)
        if (options.sessionName) query.set('sessionName', options.sessionName)
        // 剔除尾部斜杠，防止 apiBase 为 '/' 时产生协议相对 URL
        const base = (getCustomBaseURL() || '').replace(/\/+$/, '')
        const url = `${base ? base : ''}/api/sub-sessions/${subSessionId}/chat?${query.toString()}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: options.message }),
          signal: abortController.signal
        })

        if (!res.ok) {
          let detail = ''
          try {
            detail = await res.text()
          } catch {
            /* ignore */
          }
          if (onError) onError(new Error(`HTTP ${res.status}: ${detail}`))
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEventType = null

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop()

          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed === '') {
              currentEventType = null
              continue
            }
            if (trimmed.startsWith(':')) continue

            if (trimmed.startsWith('event:')) {
              currentEventType = trimmed.slice(6).trim()
            } else if (trimmed.startsWith('data:')) {
              const payload = trimmed.slice(5).trim()
              if (payload === '[DONE]') {
                if (onDone) onDone()
                return
              }

              try {
                const parsed = JSON.parse(payload)
                if (typeof parsed === 'string') {
                  if (onMessage) onMessage({ type: currentEventType, content: parsed })
                } else if (parsed && typeof parsed === 'object') {
                  if (onMessage) onMessage({ type: currentEventType, ...parsed })
                } else {
                  if (onMessage) onMessage({ type: currentEventType, content: payload })
                }
              } catch (e) {
                if (onMessage) onMessage({ type: currentEventType, content: payload })
              }
              currentEventType = null
            }
          }
        }
        if (onDone) onDone()
      } catch (err) {
        if (err.name !== 'AbortError' && onError) onError(err)
      }
    })()

    return { abort: () => abortController.abort() }
  }
}

// 工具 API
export const toolsAPI = {
  // 列出所有已注册工具（含已禁用的）- GET /api/tools
  list: () => {
    return api.get('/tools')
  },
  
  // 获取工具详情 - GET /api/tools/{name}
  getDetails: (name) => {
    return api.get(`/tools/${name}`)
  },
  
  // 切换工具启用/禁用状态 - POST /api/tools/{name}/toggle
  toggle: (name) => {
    return api.post(`/tools/${name}/toggle`)
  },
  
  // 设置工具只读分类；null 恢复默认 - POST /api/tools/{name}/read-only
  setReadOnly: (name, readOnly) => {
    return api.post(`/tools/${name}/read-only`, { readOnly })
  },

  // 直接执行工具 - POST /api/tools/{name}/execute
  execute: (name, args) => {
    return api.post(`/tools/${name}/execute`, { arguments: args })
  },
  
  // 切换工具自动放行状态 - POST /api/tools/{name}/auto-toggle
  autoToggle: (name) => {
    return api.post(`/tools/${name}/auto-toggle`)
  },
  
  // 搜索工具 - GET /api/tools/search
  search: (query) => {
    return api.get('/tools/search', { params: { q: query } })
  },
  
  // 获取子代理及其实时可用工具 - GET /api/sub-agents
  listSubAgents: () => {
    return api.get('/sub-agents')
  },

  // 全量保存子代理配置（含新增/修改/禁用） - PUT /api/sub-agents
  saveSubAgents: (profiles) => {
    return api.put('/sub-agents', {profiles})
  },

  // 子代理不可用工具清单 - GET /api/sub-agents/denied-tools
  listSubAgentDeniedTools: () => {
    return api.get('/sub-agents/denied-tools')
  },

  // 获取工具分类 - GET /api/tools/categories
  getCategories: () => {
    return api.get('/tools/categories')
  }
}

// 配置 API
export const configAPI = {
  // 获取当前配置 - GET /api/config
  getConfig: () => {
    return api.get('/config')
  },
  
  // 更新配置 - PUT /api/config
  updateConfig: (config) => {
    return api.put('/config', config)
  },
  
  // 获取可用模型列表 - GET /api/models
  getModels: () => {
    return api.get('/models')
  },

  // 从远程 API 获取模型列表 - GET /api/remote-models
  getRemoteModels: (channelId) => {
    return api.get('/remote-models', { params: channelId ? { channelId } : {} })
  },

  // 使用尚未保存的渠道地址/密钥探测远端模型列表 - POST /api/remote-models
  probeRemoteModels: (channel) => {
    return api.post('/remote-models', channel)
  },

  // 获取Token用量统计 - GET /api/usage?workspaceHash=xxx&sessionName=xxx
  getUsage: (params) => {
    return api.get('/usage', { params })
  },

  // 获取数据面板 - GET /api/usage/dashboard?days=365
  getDashboard: (days) => {
    const params = days ? { days } : {}
    return api.get('/usage/dashboard', { params })
  },
  
  
  // 获取使用历史 - GET /api/usage/history
  getUsageHistory: (params) => {
    return api.get('/usage/history', { params })
  },
  
  // 重置统计 - POST /api/usage/reset
  resetUsage: () => {
    return api.post('/usage/reset')
  },
  
  // 获取当前工作目录 - GET /api/workspace
  getWorkspace: () => {
    return api.get('/workspace')
  },
  
  // 切换工作目录 - POST /api/workspace
  switchWorkspace: (path) => {
    return api.post('/workspace', { path })
  },
  
  // 获取所有项目列表 - GET /api/workspaces
  listWorkspaces: () => {
    return api.get('/workspaces')
  },
  
  // 删除项目 - DELETE /api/workspaces/{hash}
  deleteWorkspace: (hash) => {
    return api.delete(`/workspaces/${hash}`)
  },

  // 保存项目排序 - PUT /api/workspaces/order
  saveWorkspaceOrder: (order) => {
    return api.put('/workspaces/order', order)
  },

  // 获取项目排序 - GET /api/workspaces/order
  getWorkspaceOrder: () => {
    return api.get('/workspaces/order')
  },

  // 获取 loopra.md 内容 - GET /api/loopra-md
  getLoopraMd: () => {
    return api.get('/loopra-md')
  },

  // 更新 loopra.md 内容 - PUT /api/loopra-md
  updateLoopraMd: (content) => {
    return api.put('/loopra-md', content, {
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}

// 记忆 API
export const memoryAPI = {
  // 列出所有记忆 - GET /api/memory
  list: () => {
    return api.get('/memory')
  },
  
  // 获取记忆详情 - GET /api/memory/{name}
  getDetails: (name) => {
    return api.get(`/memory/${name}`)
  },
  
  // 保存记忆 - POST /api/memory
  save: (memory) => {
    return api.post('/memory', memory)
  },
  
  // 删除记忆 - DELETE /api/memory/{name}
  delete: (name) => {
    return api.delete(`/memory/${name}`)
  },
  
  // 搜索记忆 - GET /api/memory/search
  search: (query) => {
    return api.get('/memory/search', { params: { q: query } })
  }
}

// 作业 API
export const jobAPI = {
  // 列出所有作业 - GET /api/jobs
  list: () => {
    return api.get('/jobs')
  },
  
  // 获取作业详情 - GET /api/jobs/{id}
  getDetails: (id) => {
    return api.get(`/jobs/${id}`)
  },
  
  // 获取作业输出 - GET /api/jobs/{id}/output
  getOutput: (id, params) => {
    return api.get(`/jobs/${id}/output`, { params })
  },
  
  // 停止作业 - POST /api/jobs/{id}/stop
  stop: (id) => {
    return api.post(`/jobs/${id}/stop`)
  }
}

// 系统 API
export const systemAPI = {
  // 获取系统状态
  getStatus: () => {
    return agentAPI.getStatus()
  },
  
  // 获取系统信息
  getInfo: () => {
    return configAPI.getConfig()
  },
  
  // 健康检查 - GET /api/system/health
  healthCheck: () => {
    return api.get('/system/health')
  },
  
  // 获取系统版本 - GET /api/system/version
  getVersion: () => {
    return api.get('/system/version')
  },

  // Electron 启动后登记本机 AI 浏览器桥接地址 - POST /api/system/browser-bridge
  setBrowserBridge: (address) => {
    return api.post('/system/browser-bridge', { address })
  },

  // 获取当前版本（新版） - GET /api/version/
  getCurrentVersion: () => {
    return api.get('/version/')
  },

  // 检查最新版本 - GET /api/version/check
  checkLatestVersion: () => {
    return api.get('/version/check')
  },
  
  // 获取系统日志
  getLogs: (params) => {
    return api.get('/logs', { params })
  }
}

// Cutin/Loopra 插件运行时 API
export const pluginAPI = {
  list: () => api.get('/plugins'),
  setEnabled: (id, enabled) => api.post(`/plugins/${encodeURIComponent(id)}/toggle`, {enabled})
}

// Solon H-SPI 拓展包管理 API（~/.loopra/extpacks）
export const extpackAPI = {
  list: () => api.get('/extpacks'),
  install: (source) => api.post('/extpacks/install', {source}),
  start: (id) => api.post(`/extpacks/${encodeURIComponent(id)}/start`),
  stop: (id) => api.post(`/extpacks/${encodeURIComponent(id)}/stop`),
  uninstall: (id) => api.post(`/extpacks/${encodeURIComponent(id)}/uninstall`),
  setEnabled: (id, enabled) => api.post(`/extpacks/${encodeURIComponent(id)}/toggle`, {enabled})
}

// OpenAPI 管理 API
export const openApiAPI = {
    getSources: () => {
        return api.get('/openapi/sources')
    },

    searchApis: (keyword) => {
        return api.get('/openapi/search', {params: {keyword}})
    },

    addSource: (docUrl, headers, authType, authConfig) => {
        return api.post('/openapi/sources', {docUrl, headers, authType, authConfig})
    },

    removeSource: (docUrl) => {
        return api.delete('/openapi/sources', {data: {docUrl}})
    },

    refreshSource: (docUrl, headers, authType, authConfig) => {
        return api.put('/openapi/sources/refresh', {docUrl, headers, authType, authConfig})
    }
}

// MCP 服务器管理 API
export const mcpAPI = {
    // 获取所有 MCP 服务器列表 - GET /api/mcp/servers
    listServers: () => {
        return api.get('/mcp/servers')
    },

    // 新增 MCP 服务器 - POST /api/mcp/servers/add
    addServer: (server) => {
        return api.post('/mcp/servers/add', server)
    },

    // 更新 MCP 服务器 - POST /api/mcp/servers/update
    updateServer: (originalName, server) => {
        return api.post('/mcp/servers/update', { originalName, server })
    },

    // 删除 MCP 服务器 - POST /api/mcp/servers/remove
    removeServer: (name) => {
        return api.post('/mcp/servers/remove', { name })
    },

    // 启用/禁用 MCP 服务器 - POST /api/mcp/servers/toggle
    toggleServer: (name, enabled) => {
        return api.post('/mcp/servers/toggle', { name, enabled })
    },

    // 检测 MCP 服务器连接 - POST /api/mcp/servers/check
    checkConnection: (server) => {
        return api.post('/mcp/servers/check', server)
    },

    // 查看服务器工具列表 - GET /api/mcp/servers/tools?name=xxx
    listTools: (name) => {
        return api.get('/mcp/servers/tools', { params: { name } })
    },

    // 保存工具权限 - POST /api/mcp/servers/tools/save
    saveToolPermissions: (serverName, disallowedTools) => {
        return api.post('/mcp/servers/tools/save', { serverName, disallowedTools })
    },

    // 获取 Loopra 内置工具 MCP 发布配置 - GET /api/mcp/export
    getExportConfig: () => {
        return api.get('/mcp/export')
    },

    // 保存 Loopra 内置工具 MCP 发布配置 - PUT /api/mcp/export
    saveExportConfig: (config) => {
        return api.put('/mcp/export', config)
    },

    // 刷新 Loopra 内置工具 MCP 发布清单 - POST /api/mcp/export/refresh
    refreshExportTools: () => {
        return api.post('/mcp/export/refresh')
    },

    // 获取 Cloudflare Quick Tunnel 状态 - GET /api/mcp/tunnel
    getTunnelStatus: () => {
        return api.get('/mcp/tunnel')
    },

    // 保存 Cloudflare Quick Tunnel 配置 - PUT /api/mcp/tunnel/config
    saveTunnelConfig: (config) => {
        return api.put('/mcp/tunnel/config', config)
    },

    // 启动 Cloudflare Quick Tunnel - POST /api/mcp/tunnel/start
    startTunnel: (config) => {
        return api.post('/mcp/tunnel/start', config)
    },

    // 停止 Cloudflare Quick Tunnel - POST /api/mcp/tunnel/stop
    stopTunnel: () => {
        return api.post('/mcp/tunnel/stop')
    }
}

// Git API
export const gitAPI = {
  // 获取当前分支 - GET /api/git/branch?workspaceHash=xxx
  branch: (workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get('/git/branch', { params })
  },

  // 获取变更文件列表 - GET /api/git/diff?workspaceHash=xxx
  diff: (workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get('/git/diff', { params })
  },

  // 综合状态检测（git 可用性 + 仓库状态 + 分支 + 变更文件） - GET /api/git/status?workspaceHash=xxx
  status: (workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get('/git/status', { params })
  },

  // 初始化 Git 仓库 - POST /api/git/init?workspaceHash=xxx&initialCommit=true
  init: (workspaceHash, initialCommit) => {
    const params = workspaceHash ? { workspaceHash } : {}
    if (initialCommit !== undefined) params.initialCommit = initialCommit
    return api.post('/git/init', null, { params })
  },

  // 获取 Diff 内容（unified diff 文本 + stat 摘要） - GET /api/git/diff-content?workspaceHash=xxx&path=xxx
  diffContent: (workspaceHash, path) => {
    const params = workspaceHash ? { workspaceHash } : {}
    if (path) params.path = path
    return api.get('/git/diff-content', { params })
  },

  // 获取 Git 仓库中指定版本的文件内容 - GET /api/git/file-content?workspaceHash=xxx&path=xxx&ref=HEAD
  fileContent: (workspaceHash, path, ref, options = {}) => {
    const params = {}
    if (workspaceHash) params.workspaceHash = workspaceHash
    if (path) params.path = path
    if (ref) params.ref = ref
    return api.get('/git/file-content', { params, silent: options.silent })
  },

  // 获取项目当前文件原文，用于代码预览 - GET /api/git/working-file-content
  workingFileContent: (workspaceHash, path) => {
    const params = { workspaceHash, path }
    return api.get('/git/working-file-content', { params })
  },

  // Git 提交 - POST /api/git/commit?workspaceHash=xxx  body: { message, files, authorName, authorEmail }
  commit: (workspaceHash, message, files, authorName, authorEmail) => {
    const params = workspaceHash ? { workspaceHash } : {}
    const body = { message }
    if (files && files.length) body.files = files
    if (authorName) body.authorName = authorName
    if (authorEmail) body.authorEmail = authorEmail
    return api.post('/git/commit', body, { params })
  },

  // 获取提交作者配置 (已保存 > git config > Loopra 默认) - GET /api/git/config?workspaceHash=xxx
  getConfig: (workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get('/git/config', { params })
  },

  // 保存提交作者配置到项目 - POST /api/git/config?workspaceHash=xxx  body: { authorName, authorEmail, model, modelChannelId }
  saveConfig: (workspaceHash, authorName, authorEmail, model, modelChannelId) => {
    const params = workspaceHash ? { workspaceHash } : {}
    const body = { authorName, authorEmail }
    if (model) body.model = model
    if (modelChannelId) body.modelChannelId = modelChannelId
    return api.post('/git/config', body, { params })
  },

  // 切换文件状态 - POST /api/git/toggle?workspaceHash=xxx  body: { path }
  toggle: (workspaceHash, path) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.post('/git/toggle', { path }, { params })
  },

  // AI 自动生成提交消息 - POST /api/git/generate-commit-message?workspaceHash=xxx  body: { files, model, modelChannelId }
  generateCommitMessage: (workspaceHash, files, model, modelChannelId) => {
    const params = workspaceHash ? { workspaceHash } : {}
    const body = {}
    if (files && files.length) body.files = files
    if (model) body.model = model
    if (modelChannelId) body.modelChannelId = modelChannelId
    return api.post('/git/generate-commit-message', body, { params, timeout: 120000 })
  },

  // AI 生成当前会话环境（隔离分支优先，否则主项目）的提交消息 - POST /api/git/generate-environment-commit-message?workspaceHash=xxx&sessionName=xxx  body: { files, model, modelChannelId }
  generateEnvironmentCommitMessage: (workspaceHash, sessionName, files, model, modelChannelId) => {
    const body = {}
    if (files && files.length) body.files = files
    if (model) body.model = model
    if (modelChannelId) body.modelChannelId = modelChannelId
    return api.post('/git/generate-environment-commit-message', body, { params: { workspaceHash, sessionName }, timeout: 120000 })
  },

  // 获取提交历史记录 - GET /api/git/log?workspaceHash=xxx&limit=50
  commitHistory: (workspaceHash, limit) => {
    const params = workspaceHash ? { workspaceHash } : {}
    if (limit) params.limit = limit
    return api.get('/git/log', { params })
  },

  // 获取当前会话实际使用的环境 - GET /api/git/environment?workspaceHash=xxx&sessionName=xxx
  environment: (workspaceHash, sessionName, options = {}) => {
    return api.get('/git/environment', { params: { workspaceHash, sessionName }, silent: options.silent })
  },

  // 创建会话隔离分支 - POST /api/git/worktree/create  body: { workspaceHash, sessionName }
  worktreeCreate: (workspaceHash, sessionName, options = {}) => {
    return api.post('/git/worktree/create', { workspaceHash, sessionName }, {silent: options.silent})
  },

  // 获取可用模型列表 - GET /api/models
  getModels: () => {
    return api.get('/models')
  }
}

// 快照检查点 API
export const snapshotAPI = {
  // 创建快照检查点 - POST /api/snapshots/checkpoint?workspaceHash=xxx&msgId=xxx
  createCheckpoint: (workspaceHash, msgId) => {
    const params = {}
    if (workspaceHash) params.workspaceHash = workspaceHash
    params.msgId = msgId
    return api.post('/snapshots/checkpoint', null, { params })
  },

    // 撤回消息，可选恢复项目代码 - POST /api/snapshots/rollback?workspaceHash=xxx&msgId=xxx&sessionName=xxx&rollbackCode=true
    rollback: (workspaceHash, msgId, sessionName, rollbackCode = true, rollbackTimestamp = null) => {
      const params = {}
      if (workspaceHash) params.workspaceHash = workspaceHash
    if (msgId) params.msgId = msgId
        if (sessionName) params.sessionName = sessionName
        params.rollbackCode = rollbackCode
        if (rollbackTimestamp) params.rollbackTimestamp = rollbackTimestamp
    return api.post('/snapshots/rollback', null, { params })
  },

  // 列出快照 - GET /api/snapshots?workspaceHash=xxx&sessionName=xxx
  list: (workspaceHash, sessionName) => {
    const params = {}
    if (workspaceHash) params.workspaceHash = workspaceHash
    if (sessionName) params.sessionName = sessionName
    return api.get('/snapshots', { params })
  },

  // 检查 Git 仓库状态 - GET /api/snapshots/status?workspaceHash=xxx
  getStatus: (workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get('/snapshots/status', { params })
  },

  // 删除快照 - DELETE /api/snapshots/{msgId}?workspaceHash=xxx
  deleteSnapshot: (msgId, workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.delete(`/snapshots/${msgId}`, { params })
  }
}

// 工具函数
export const utils = {
  // 格式化错误消息
  formatError: (error) => {
    if (typeof error === 'string') return error
    if (error.message) return error.message
    if (error.data?.message) return error.data.message
    return '未知错误'
  },
  
  // 检查是否为网络错误
  isNetworkError: (error) => {
    return error.code === 'OFFLINE' || error.code === 'TIMEOUT' || !error.response
  },
  
  // 检查是否为认证错误
  isAuthError: (error) => {
    return error.code === 401
  },
  
  // 检查是否为权限错误
  isPermissionError: (error) => {
    return error.code === 403
  },
  
  // 重试请求
  retryRequest: async (requestFn, maxRetries = 3, delay = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await requestFn()
      } catch (error) {
        if (i === maxRetries - 1) throw error
        if (!utils.isNetworkError(error)) throw error
        
        console.warn(`请求失败，${delay}ms 后重试 (${i + 1}/${maxRetries})`)
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)))
      }
    }
  }
}

// 技能市场 API
export const skillMarketAPI = {
  // 获取可用市场列表 - GET /api/skill-market/markets
  getMarkets: () => {
    return api.get('/skill-market/markets')
  },

  // 浏览/搜索技能 - GET /api/skill-market/proxy
  proxy: (params) => {
    return api.get('/skill-market/proxy', { params })
  },

  // 获取技能详情 - GET /api/skill-market/detail
  getDetail: (slug, marketName) => {
    const params = { slug }
    if (marketName) params.marketName = marketName
    return api.get('/skill-market/detail', { params })
  },

  // 安装技能 - POST /api/skill-market/install
  install: (slug, marketName) => {
    const params = new URLSearchParams()
    params.append('slug', slug)
    if (marketName) params.append('marketName', marketName)
    return api.post('/skill-market/install', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
  },

  // 卸载技能 - POST /api/skill-market/uninstall
  uninstall: (slug) => {
    const params = new URLSearchParams()
    params.append('slug', slug)
    return api.post('/skill-market/uninstall', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
  }
}

// LSP 服务器管理 API
export const lspAPI = {
    listServers: () => api.get('/lsp/servers'),
    addServer: (server) => api.post('/lsp/servers/add', server),
    updateServer: (originalName, server) => api.post('/lsp/servers/update', { originalName, server }),
    removeServer: (name) => api.post('/lsp/servers/remove', { name }),
    toggleServer: (name, enabled) => api.post('/lsp/servers/toggle', { name, enabled }),
}

// 项目文件 API
export const filesAPI = {
  // 获取指定目录的直接子项 - GET /api/files/tree?workspaceHash=xxx&path=src
  list: (workspaceHash, path = '') => {
    return api.get('/files/tree', { params: { workspaceHash, path } })
  },
  // 搜索项目内文件 - GET /api/files/search?workspaceHash=xxx&query=foo
  search: (workspaceHash, query = '') => {
    return api.get('/files/search', { params: { workspaceHash, query } })
  },
  // 删除项目内文件或目录 - DELETE /api/files/delete?workspaceHash=xxx&path=src/a.js
  remove: (workspaceHash, path) => {
    return api.delete('/files/delete', { params: { workspaceHash, path } })
  },
  // 保存超大粘贴文本 - POST /api/files/paste
  savePaste: (workspaceHash, content) => {
    return api.post('/files/paste', { workspaceHash, content })
  }
}

// 定时任务 API
export const scheduleAPI = {
  // 列出指定项目的所有定时任务 - GET /api/schedules?workspaceHash=xxx
  list: (workspaceHash) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get('/schedules', { params })
  },

  // 获取单个定时任务 - GET /api/schedules/{id}?workspaceHash=xxx
  get: (workspaceHash, id) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.get(`/schedules/${id}`, { params })
  },

  // 创建定时任务 - POST /api/schedules?workspaceHash=xxx
  create: (workspaceHash, task) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.post('/schedules', task, { params })
  },

  // 更新定时任务 - PUT /api/schedules/{id}?workspaceHash=xxx
  update: (workspaceHash, id, task) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.put(`/schedules/${id}`, task, { params })
  },

  // 启用/禁用定时任务 - POST /api/schedules/{id}/toggle?workspaceHash=xxx
  toggle: (workspaceHash, id) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.post(`/schedules/${id}/toggle`, null, { params })
  },

  // 手动触发执行 - POST /api/schedules/{id}/run?workspaceHash=xxx
  runNow: (workspaceHash, id) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.post(`/schedules/${id}/run`, null, { params })
  },

  // 删除定时任务 - DELETE /api/schedules/{id}?workspaceHash=xxx
  delete: (workspaceHash, id) => {
    const params = workspaceHash ? { workspaceHash } : {}
    return api.delete(`/schedules/${id}`, { params })
  }
}

// 需求池 API
// 需求绑定项目与专属执行会话，评论/执行日志从会话消息流读取（GET /{id}/messages）
export const requirementAPI = {
  // 列出全部需求 - GET /api/requirements
  list: () => api.get('/requirements'),

  // 创建需求 - POST /api/requirements  body: { title, description, priority, projectHash, projectName }
  create: (requirement) => api.post('/requirements', requirement),

  // 更新需求（仅描述/优先级） - PUT /api/requirements/{id}
  update: (id, update) => api.put(`/requirements/${id}`, update),

  // 删除需求 - DELETE /api/requirements/{id}
  delete: (id) => api.delete(`/requirements/${id}`),

  // 追加评论（写入需求专属会话） - POST /api/requirements/{id}/comments  body: { text }
  addComment: (id, text) => api.post(`/requirements/${id}/comments`, { text }),

  // 触发执行（todo/failed 入队，状态 → doing） - POST /api/requirements/{id}/run
  run: (id) => api.post(`/requirements/${id}/run`),

  // 处理审批模式下的待审批工具调用 - POST /api/requirements/{id}/approval
  resolveApproval: (id, action) => api.post(`/requirements/${id}/approval`, { action }),

  // 取消执行（中断会话，状态回退 todo） - POST /api/requirements/{id}/abort
  abort: (id) => api.post(`/requirements/${id}/abort`),

  // 拉取需求消息流（评论 + 执行日志） - GET /api/requirements/{id}/messages
  getMessages: (id) => api.get(`/requirements/${id}/messages`)
}

export const petAPI = {
  /** 获取宠物元数据（旧版兼容，同 getActive） */
  getInfo: () => api.get('/pets/active', {silent: true}),
  /** 保存位置/大小 */
  savePosition: (pos) => api.put('/pets/position', pos, {silent: true}),
  /** 将后端返回的相对 spritesheet 路径解析为完整 URL（适配服务端端口） */
  resolveUrl: resolveApiUrl,
  /** 获取当前活跃宠物的 spritesheet URL（完整地址） */
  getSpritesheetUrl: () => resolveApiUrl('/api/pets/active/spritesheet'),

  /** 列出所有可用宠物 */
  listPets: () => api.get('/pets'),
  /** 获取指定宠物元数据 */
  getPetInfo: (name) => api.get(`/pets/${name}`),
  /** 获取指定宠物的 spritesheet URL（完整地址） */
  getPetSpritesheetUrl: (name) => resolveApiUrl(`/api/pets/${name}/spritesheet`),
  /** 删除指定宠物（清空文件夹） */
  deletePet: (name) => api.delete(`/pets/${name}`),
  /** 获取当前活跃宠物信息 */
  getActive: () => api.get('/pets/active', {silent: true}),
  /** 设置活跃宠物 */
  setActive: (name) => api.put('/pets/active', { name }),
}

export default api

