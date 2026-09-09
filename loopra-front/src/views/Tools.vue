<template>
  <div class="tools-view">
    <!-- 头部 -->
    <div class="tools-header">
      <div class="header-left">
        <div class="header-title">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
          <h2>工具箱</h2>
        </div>
        <span class="tool-count">{{ filteredTools.length }} 个工具</span>
      </div>
      <div class="header-actions">
        <button 
          class="refresh-btn"
          :class="{ refreshing }"
          @click="loadTools"
          :disabled="loading || refreshing"
          title="刷新工具列表"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <div class="search-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input 
            v-model="searchQuery" 
            type="text" 
            placeholder="搜索工具..." 
            class="search-input"
          />
        </div>
      </div>
    </div>
    
    <!-- 概览 -->
    <div class="stats-grid" aria-label="工具概览">
      <div class="stat-card">
        <span class="stat-label">工具总数</span>
        <strong class="stat-value">{{ tools.length }}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">只读</span>
        <strong class="stat-value">{{ readonlyToolsCount }}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">写入</span>
        <strong class="stat-value">{{ writeToolsCount }}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">风暴豁免</span>
        <strong class="stat-value">{{ stormExemptCount }}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">已停用</span>
        <strong class="stat-value">{{ disabledToolsCount }}</strong>
      </div>
    </div>
    
    <!-- 筛选器 -->
    <div class="filters">
      <button 
        v-for="filter in filters" 
        :key="filter.value"
        class="filter-btn"
        :class="{ active: activeFilter === filter.value }"
        @click="activeFilter = filter.value"
      >
        <span class="filter-label">{{ filter.label }}</span>
        <span class="filter-count">{{ getFilterCount(filter.value) }}</span>
      </button>
    </div>
    
    <!-- 工具列表 -->
    <div class="tools-container">
      <div v-if="loading" class="loading-state">
        <div class="loading-spinner"></div>
        <p>加载中...</p>
      </div>
      
      <div v-else-if="error" class="error-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <p>{{ error }}</p>
        <button class="btn btn-secondary btn-sm" @click="loadTools">重试</button>
      </div>
      
      <div v-else-if="filteredTools.length === 0" class="empty-state">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <h3>未找到匹配的工具</h3>
        <p>尝试调整搜索条件或筛选器</p>
        <button class="btn btn-secondary" @click="resetFilters">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
          重置筛选
        </button>
      </div>
      
      <div v-else class="tools-grid">
        <div 
          v-for="tool in filteredTools" 
          :key="tool.name"
          class="tool-card"
          :class="{ 
            expanded: expandedTools.includes(tool.name),
            disabled: !tool.enabled 
          }"
        >
          <div class="tool-header" @click="toggleDetails(tool.name)">
            <div class="tool-info">
              <div class="tool-icon" :class="getToolType(tool)">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                </svg>
              </div>
              <div class="tool-details">
                <div class="tool-name-line">
                  <span class="tool-name">{{ tool.name }}</span>
                  <span v-if="!tool.enabled" class="badge disabled">已禁用</span>
                </div>
                <div class="tool-badges">
                  <span v-if="tool.readonly" class="badge readonly">只读</span>
                  <span v-if="tool.write" class="badge write">写入</span>
                  <span v-if="tool.readOnlyOverride !== null" class="badge override">自定义</span>
                  <span v-if="tool.stormExempt" class="badge exempt">豁免</span>
                </div>
              </div>
            </div>
            <div class="tool-actions" @click.stop>
              <button
                type="button"
                class="tool-control"
                :class="{ enabled: tool.enabled }"
                :aria-pressed="tool.enabled"
                :disabled="togglingTool === tool.name"
                @click="toggleTool(tool)"
                :title="tool.enabled ? '停用此工具' : '启用此工具'"
              >
                <span class="tool-control-label">启用工具</span>
                <span class="tool-control-state">{{ tool.enabled ? '已启用' : '已停用' }}</span>
              </button>
              <button
                type="button"
                class="tool-control auto-control"
                :class="{ enabled: tool.autoApproved }"
                :aria-pressed="tool.autoApproved"
                :disabled="togglingTool === tool.name"
                @click="toggleAutoTool(tool)"
                :title="tool.autoApproved ? '关闭自动放行，恢复审批' : '开启自动放行，无需审批'"
              >
                <span class="tool-control-label">自动放行</span>
                <span class="tool-control-state">{{ tool.autoApproved ? '已开启' : '需确认' }}</span>
              </button>
              <button
                class="tool-expand"
                type="button"
                :class="{ expanded: expandedTools.includes(tool.name) }"
                :aria-expanded="expandedTools.includes(tool.name)"
                :aria-label="expandedTools.includes(tool.name) ? `收起 ${tool.name} 详情` : `展开 ${tool.name} 详情`"
                @click.stop="toggleDetails(tool.name)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
            </div>
          </div>
          
          <div class="tool-description" :title="tool.description">{{ tool.description }}</div>
          
          <div v-if="expandedTools.includes(tool.name)" class="tool-expanded">
            <div class="tool-section classification-setting">
              <div class="section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>
                </svg>
                <span>权限分类</span>
              </div>
              <div class="classification-control" @click.stop>
                <span>执行权限</span>
                <div class="segmented-control" role="group" aria-label="工具执行权限">
                  <button type="button" :class="{ active: tool.readOnlyOverride === null }" :disabled="togglingTool === tool.name" @click="setReadOnlyMode(tool, null)">默认</button>
                  <button type="button" :class="{ active: tool.readOnlyOverride === true }" :disabled="togglingTool === tool.name" @click="setReadOnlyMode(tool, true)">只读</button>
                  <button type="button" :class="{ active: tool.readOnlyOverride === false }" :disabled="togglingTool === tool.name" @click="setReadOnlyMode(tool, false)">写入</button>
                </div>
              </div>
            </div>

            <!-- 参数 -->
            <div v-if="tool.params?.length" class="tool-section">
              <div class="section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="16 18 22 12 16 6"/>
                  <polyline points="8 6 2 12 8 18"/>
                </svg>
                <span>参数</span>
              </div>
              <div class="params-list">
                <div v-for="param in tool.params" :key="param.name" class="param-item">
                  <div class="param-header">
                    <span class="param-name">{{ param.name }}</span>
                    <span class="param-type">{{ param.type }}</span>
                    <span v-if="param.required" class="param-required">必填</span>
                  </div>
                  <div class="param-description">{{ param.description }}</div>
                </div>
              </div>
            </div>
            
            <!-- 示例 -->
            <div v-if="tool.example" class="tool-section">
              <div class="section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="16 18 22 12 16 6"/>
                  <polyline points="8 6 2 12 8 18"/>
                </svg>
                <span>示例</span>
              </div>
              <div class="code-block">
                <pre><code>{{ tool.example }}</code></pre>
              </div>
            </div>
            
            <!-- 注意事项 -->
            <div v-if="tool.notes?.length" class="tool-section">
              <div class="section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="16" x2="12" y2="12"/>
                  <line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span>注意事项</span>
              </div>
              <ul class="notes-list">
                <li v-for="(note, index) in tool.notes" :key="index">{{ note }}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import {computed, onMounted, ref} from 'vue'
import {toolsAPI} from '../services/api'

// 状态
const searchQuery = ref('')
const activeFilter = ref('all')
const expandedTools = ref([])
const loading = ref(false)
const refreshing = ref(false)
const error = ref('')
const tools = ref([])
const togglingTool = ref('')

// 筛选器配置
const filters = [
  { label: '全部', value: 'all' },
  { label: '只读', value: 'readonly' },
  { label: '写入', value: 'write' },
  { label: '豁免', value: 'exempt' },
  { label: '已停用', value: 'disabled' },
  { label: '自动放行', value: 'autoApproved' },
]

// 计算属性
const readonlyToolsCount = computed(() => tools.value.filter(t => t.readonly).length)
const writeToolsCount = computed(() => tools.value.filter(t => t.write).length)
const stormExemptCount = computed(() => tools.value.filter(t => t.stormExempt).length)
const disabledToolsCount = computed(() => tools.value.filter(t => !t.enabled).length)
const autoApprovedCount = computed(() => tools.value.filter(t => t.autoApproved).length)

const filteredTools = computed(() => {
  let result = tools.value
  
  // 搜索过滤
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    result = result.filter(tool => 
      tool.name.toLowerCase().includes(query) ||
      tool.description.toLowerCase().includes(query)
    )
  }
  
  // 类型过滤
  if (activeFilter.value !== 'all') {
    switch (activeFilter.value) {
      case 'readonly':
        result = result.filter(t => t.readonly)
        break
      case 'write':
        result = result.filter(t => t.write)
        break
      case 'exempt':
        result = result.filter(t => t.stormExempt)
        break
      case 'disabled':
        result = result.filter(t => !t.enabled)
        break
      case 'autoApproved':
        result = result.filter(t => t.autoApproved)
        break
    }
  }
  
  return result
})

// 方法
const loadTools = async () => {
  // 已有数据则为刷新模式，否则首次加载
  const isRefresh = tools.value.length > 0
  if (isRefresh) {
    refreshing.value = true
  } else {
    loading.value = true
  }
  error.value = ''
  
  try {
    const response = await toolsAPI.list()
    if (response.success && response.data) {
      tools.value = response.data.map(tool => ({
        name: tool.name,
        description: tool.description,
        readonly: tool.readOnly || false,
        readOnlyOverride: tool.readOnlyOverride === true ? true : (tool.readOnlyOverride === false ? false : null),
        write: !tool.readOnly,
        stormExempt: tool.stormExempt || false,
        enabled: tool.enabled !== undefined ? tool.enabled : true,
        autoApproved: tool.autoApproved || false,
        params: tool.parameters ? Object.entries(tool.parameters).map(([name, param]) => ({
          name,
          type: param.type || 'string',
          required: param.required || false,
          description: param.description || ''
        })) : [],
        example: tool.example || '',
        notes: tool.notes || []
      }))
    } else {
      error.value = response.error || '加载工具列表失败'
    }
  } catch (err) {
    console.error('加载工具列表失败:', err)
    error.value = '加载工具列表失败: ' + err.message
    
    // 使用默认工具列表作为后备
    tools.value = getDefaultTools().map(tool => ({ ...tool, readOnlyOverride: null }))
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

const getDefaultTools = () => [
  {
    name: 'read',
    description: '读取文件内容。支持大文件分页。支持逻辑路径（如 @pool）。优先尝试不限制读取（即尝试完整读取）',
    readonly: true,
    write: false,
    stormExempt: true,
    enabled: true,
    params: [
      { name: 'file_path', type: 'string', required: true, description: '文件相对路径（如 \"src/demo.md\"）或逻辑路径（如 \"@pool\"）。\".\" 表示当前根目录。' },
      { name: 'offset', type: 'int', required: false, description: '开始读取的行号（默认从1开始索引）' },
      { name: 'limit', type: 'int', required: false, description: '需要读取的最大行数（默认不限制）。注意：单次读取受 128KB 物理长度保护' }
    ],
    example: 'read({ file_path: "src/main.java" })',
    notes: ['支持逻辑路径：如 @pool 表示挂载点', '大文件保护：单次读取受 128KB 物理长度保护，若触发截断，请根据输出提示调整 offset 分页读取']
  },
  {
    name: 'edit',
    description: '对文件进行精准文本替换。支持单次调用执行一处或多处编辑。具有原子性：所有编辑成功才会写入，否则全部回滚。',
    readonly: false,
    write: true,
    stormExempt: false,
    enabled: true,
    params: [
      { name: 'file_path', type: 'string', required: true, description: '文件相对路径（如 \"src/demo.md\"）。\".\" 表示当前根目录。' },
      { name: 'edits', type: 'array', required: true, description: '编辑操作列表，每个元素包含 old_str、old_StrStartLine、new_str、replace_all' }
    ],
    example: 'edit({ file_path: "src/Hello.java", edits: [{ old_str: "Hello!", old_StrStartLine: 10, new_str: "Hello, World!" }] })',
    notes: ['old_str 必须唯一：要搜索的文本在文件中只能出现一次（除非指定 old_StrStartLine）', '精确匹配：old_str 文本必须与文件中完全一致', '原子性：所有编辑成功才会写入，否则全部回滚']
  },
  {
    name: 'write',
    description: '创建新文件或覆盖现有文件。',
    readonly: false,
    write: true,
    stormExempt: false,
    enabled: true,
    params: [
      { name: 'file_path', type: 'string', required: true, description: '文件相对路径（如 \"src/demo.md\"）。\".\" 表示当前根目录。' },
      { name: 'content', type: 'string', required: true, description: '完整文本内容。' }
    ],
    example: 'write({ file_path: "src/NewFile.java", content: "public class NewFile {}" })',
    notes: ['创建新文件：指定 file_path 和 content，父目录不存在时会自动创建', '覆盖已有文件：会直接覆盖，不可恢复', '编辑已有文件：推荐使用 edit 而非 write']
  },
  {
    name: 'bash',
    description: '在终端执行非交互式 Shell 指令。支持多行脚本，支持逻辑路径（如 @pool）自动转环境变量。',
    readonly: false,
    write: true,
    stormExempt: false,
    enabled: true,
    params: [
      { name: 'command', type: 'string', required: true, description: '要执行的指令。' },
      { name: 'timeout', type: 'int', required: false, description: '可选超时时间，单位为毫秒（默认 120000）' }
    ],
    example: 'bash({ command: "mvn compile" })',
    notes: ['支持逻辑路径：如 @pool 会自动转为环境变量', '支持多行脚本', '支持管道、重定向等 shell 特性']
  }
]

const getToolType = (tool) => {
  if (tool.readonly) return 'readonly'
  if (tool.write) return 'write'
  if (tool.stormExempt) return 'exempt'
  return 'default'
}

const getFilterCount = (filter) => {
  switch (filter) {
    case 'all': return tools.value.length
    case 'readonly': return readonlyToolsCount.value
    case 'write': return writeToolsCount.value
    case 'exempt': return stormExemptCount.value
    case 'disabled': return disabledToolsCount.value
    case 'autoApproved': return autoApprovedCount.value
    default: return 0
  }
}

const toggleDetails = (toolName) => {
  const index = expandedTools.value.indexOf(toolName)
  if (index > -1) {
    expandedTools.value.splice(index, 1)
  } else {
    expandedTools.value.push(toolName)
  }
}

const resetFilters = () => {
  searchQuery.value = ''
  activeFilter.value = 'all'
}

// 切换工具启用/禁用状态
const toggleTool = async (tool) => {
  togglingTool.value = tool.name
  try {
    await toolsAPI.toggle(tool.name)
    tool.enabled = !tool.enabled
    // 刷新列表确保数据一致
    await loadTools()
  } catch (err) {
    console.error('切换工具状态失败:', err)
  } finally {
    togglingTool.value = ''
  }
}

// 切换工具自动放行状态
const toggleAutoTool = async (tool) => {
  togglingTool.value = tool.name
  try {
    await toolsAPI.autoToggle(tool.name)
    tool.autoApproved = !tool.autoApproved
    await loadTools()
  } catch (err) {
    console.error('切换自动放行状态失败:', err)
  } finally {
    togglingTool.value = ''
  }
}

// 设置工具只读分类；null 表示恢复默认
const setReadOnlyMode = async (tool, readOnly) => {
  if (tool.readOnlyOverride === readOnly) return
  togglingTool.value = tool.name
  try {
    await toolsAPI.setReadOnly(tool.name, readOnly)
    await loadTools()
  } catch (err) {
    console.error('设置工具权限分类失败:', err)
  } finally {
    togglingTool.value = ''
  }
}

// 生命周期
onMounted(() => {
  loadTools()
})
</script>

<style scoped>
.tools-view {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 18px 22px 24px;
  max-width: none;
  margin: 0 auto;
}

/* 头部 */
.tools-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.header-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg);
}

.header-title svg {
  width: 22px;
  height: 22px;
  color: var(--brand-primary);
}

.header-title h2 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--font-bold);
}

.tool-count {
  font-size: var(--text-xs);
  color: var(--fg-muted);
  background: var(--bg-tertiary);
  padding: 0.25rem 0.6rem;
  border-radius: var(--radius-full);
  white-space: nowrap;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}

/* 刷新按钮 */
.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
  flex-shrink: 0;
}

.refresh-btn:hover {
  color: var(--brand-primary);
  border-color: var(--brand-primary);
  background: var(--accent-soft);
}

.refresh-btn:active {
  transform: scale(0.95);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-btn.refreshing svg {
  animation: spin 0.8s linear infinite;
}

/* 搜索框 */
.search-box {
  position: relative;
  display: flex;
  align-items: center;
}

.search-box svg {
  position: absolute;
  left: var(--space-3);
  color: var(--fg-muted);
  pointer-events: none;
}

.search-input {
  width: 240px;
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-8);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  color: var(--fg);
  transition: all var(--transition-fast);
}

.search-input:focus {
  background: var(--surface);
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
  outline: none;
}

/* 统计卡片 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0;
  height: 52px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  margin-bottom: 14px;
}

.stat-card {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 10px 14px;
  border-right: 1px solid var(--border);
  background: transparent;
  transition: background var(--transition-fast);
}

.stat-card:last-child {
  border-right: 0;
}

.stat-card:hover {
  background: var(--bg-secondary);
}

.stat-value {
  font-size: 16px;
  font-weight: var(--font-bold);
  color: var(--fg);
  line-height: 1.2;
}

.stat-label {
  font-size: var(--text-xs);
  color: var(--fg-muted);
  white-space: nowrap;
}

/* 筛选器 */
.filters {
  display: grid;
  grid-template-columns: repeat(6, 96px);
  gap: 2px;
  padding: 3px;
  height: 42px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  margin-bottom: 14px;
}

.filter-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 34px;
  box-sizing: border-box;
  gap: 6px;
  padding: 6px 10px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  font-size: var(--text-xs);
  color: var(--fg-secondary);
  transition: all var(--transition-fast);
}

.filter-btn:hover {
  background: var(--surface-hover);
}

.filter-btn.active {
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .08);
}

.filter-label {
  font-weight: var(--font-medium);
}

.filter-count {
  font-size: var(--text-xs);
  color: var(--fg-muted);
  padding: 0;
}

.filter-btn.active .filter-count {
  color: var(--fg-2);
}

/* 工具容器 */
.tools-container {
  margin-bottom: 0;
}

/* 加载状态 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-12);
  color: var(--fg-muted);
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: var(--space-4);
}

/* 错误状态 */
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-12);
  text-align: center;
  color: var(--fg-muted);
}

.error-state svg {
  color: var(--danger);
  margin-bottom: var(--space-4);
}

.error-state p {
  margin-bottom: var(--space-4);
  color: var(--danger);
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-12);
  text-align: center;
  color: var(--fg-muted);
}

.empty-state svg {
  color: var(--fg-muted);
  opacity: 0.5;
  margin-bottom: var(--space-4);
}

.empty-state h3 {
  font-size: var(--text-xl);
  font-weight: var(--font-semibold);
  color: var(--fg);
  margin-bottom: var(--space-2);
}

.empty-state p {
  margin-bottom: var(--space-6);
}

/* 工具网格 */
.tools-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 工具卡片 */
.tool-card {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  transition: all var(--transition-fast);
}

.tool-card:hover {
  border-color: var(--border-focus);
  box-shadow: var(--shadow-md);
}

.tool-card.expanded {
  border-color: var(--fg-muted);
  box-shadow: none;
}

.tool-card:not(.expanded) {
  height: 112px;
}

/* 工具头部 */
.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  min-height: 56px;
  box-sizing: border-box;
  padding: 10px 12px;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.tool-header:hover {
  background: var(--surface-hover);
}

.tool-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.tool-icon {
  width: 30px;
  height: 30px;
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.tool-icon.readonly {
  background: var(--bg-tertiary);
  color: var(--fg-2);
}

.tool-icon.write {
  background: var(--bg-tertiary);
  color: var(--fg-2);
}

.tool-icon.exempt {
  background: var(--bg-tertiary);
  color: var(--fg-2);
}

.tool-icon.default {
  background: var(--bg-tertiary);
  color: var(--fg-2);
}

.tool-details {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.tool-name-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tool-name {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: var(--font-semibold);
  font-family: var(--font-mono);
  color: var(--fg);
}

.tool-badges {
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.badge {
  font-size: 10px;
  font-weight: var(--font-medium);
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-full);
}

.badge.readonly {
  background: var(--bg-tertiary);
  color: var(--fg-secondary);
}

.badge.write {
  background: var(--bg-tertiary);
  color: var(--fg-secondary);
}

.badge.override {
  background: var(--bg-tertiary);
  color: var(--fg-secondary);
}

.badge.exempt {
  background: var(--bg-tertiary);
  color: var(--fg-secondary);
}

.tool-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 28px;
  width: 28px;
  min-width: 28px;
  height: 28px;
  box-sizing: border-box;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  transition: transform var(--transition-fast);
}

.tool-expand:hover {
  background: var(--bg-tertiary);
  color: var(--fg);
}

.tool-expand.expanded svg {
  transform: rotate(180deg);
}

/* 工具描述 */
.tool-description {
  display: -webkit-box;
  height: 54px;
  box-sizing: border-box;
  overflow: hidden;
  padding: 0 14px 12px 52px;
  color: var(--fg-secondary);
  font-size: 13px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/* 展开内容 */
.tool-expanded {
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}

.tool-section {
  margin-bottom: 12px;
}

.tool-section:last-child {
  margin-bottom: 0;
}

.section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
  font-weight: var(--font-semibold);
  color: var(--fg);
  margin-bottom: 8px;
}

.section-title svg {
  color: var(--brand-primary);
}

.classification-control {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--fg-secondary);
  font-size: 12px;
}

.segmented-control {
  display: inline-grid;
  grid-template-columns: repeat(3, 56px);
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-tertiary);
}

.segmented-control button {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
}

.segmented-control button:hover:not(:disabled) {
  color: var(--fg);
}

.segmented-control button.active {
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.segmented-control button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 参数列表 */
.params-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.param-item {
  padding: 9px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.param-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.param-name {
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  font-family: var(--font-mono);
  color: var(--fg);
}

.param-type {
  font-size: var(--text-xs);
  color: var(--fg-muted);
  background: var(--bg-tertiary);
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-sm);
}

.param-required {
  font-size: var(--text-xs);
  color: var(--danger);
  background: var(--danger-bg);
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-sm);
}

.param-description {
  font-size: 12px;
  color: var(--fg-secondary);
  line-height: 1.5;
}

/* 代码块 */
.code-block {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow-x: auto;
}

.code-block pre {
  margin: 0;
  padding: 9px;
  background: none;
  border: none;
}

.code-block code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg);
  background: none;
  padding: 0;
}

/* 注意事项 */
.notes-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.notes-list li {
  padding: 9px 9px 9px 26px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--fg-secondary);
  line-height: 1.5;
  position: relative;
  padding-left: var(--space-6);
}

.notes-list li::before {
  content: '•';
  position: absolute;
  left: var(--space-3);
  color: var(--brand-primary);
  font-weight: bold;
}

/* 动画 */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 响应式设计 */
@media (max-width: 900px) {
  .filters {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    height: auto;
  }

  .tool-actions {
    gap: 6px;
  }
}

@media (max-width: 768px) {
  .tools-view {
    padding: 14px;
  }
  
  .tools-header {
    flex-direction: column;
    gap: var(--space-4);
    align-items: flex-start;
  }
  
  .header-actions {
    width: 100%;
  }
  
  .search-input {
    width: 100%;
    min-width: 0;
  }

  .search-box {
    flex: 1;
    min-width: 0;
  }
  
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
    height: auto;
    grid-auto-rows: 52px;
  }
  
  .filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    height: auto;
  }
  
  .filter-btn {
    flex: none;
    min-width: 0;
    justify-content: space-between;
  }
  
  .tool-header {
    gap: 10px;
    height: 92px;
    min-height: 92px;
    flex-wrap: wrap;
    align-content: center;
    align-items: center;
    row-gap: 4px;
  }

  .tool-card:not(.expanded) {
    height: 148px;
  }

  .tool-info {
    flex: 1 1 100%;
  }

  .tool-actions {
    width: 100%;
  }

  .tool-control {
    width: 112px;
    min-width: 112px;
  }

  .tool-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .tool-description {
    padding-left: 14px;
  }
  
  .param-header {
    flex-wrap: wrap;
  }
}

/* 深色模式调整 */
[data-theme="dark"] .tool-card {
  background: var(--bg-secondary);
  border-color: var(--border);
}

[data-theme="dark"] .tool-card:hover {
  border-color: var(--brand-primary-light);
}

[data-theme="dark"] .tool-expanded {
  background: var(--bg-tertiary);
}

[data-theme="dark"] .stat-card {
  background: var(--bg-secondary);
  border-color: var(--border);
}

[data-theme="dark"] .param-item {
  background: var(--bg-tertiary);
  border-color: var(--border);
}

/* ========== 禁用工具相关样式 ========== */

/* 已禁用工具卡片 */
.tool-card.disabled {
  opacity: 0.72;
  border-color: var(--border-muted);
}

.tool-card.disabled:hover {
  border-color: var(--border-muted);
  box-shadow: none;
}

.tool-card.disabled .tool-name {
  opacity: 0.7;
}

/* 已禁用徽标 */
.badge.disabled {
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: var(--radius-sm);
  margin-left: 0.4rem;
}

/* 工具卡片右侧操作区 */
.tool-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 292px;
  box-sizing: border-box;
  gap: 8px;
  flex-shrink: 0;
}

/* 带文案的工具状态控制 */
.tool-control {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 124px;
  min-width: 124px;
  height: 30px;
  min-height: 30px;
  box-sizing: border-box;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--fg-2);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}

.tool-control:hover:not(:disabled) {
  background: var(--bg-secondary);
  border-color: var(--fg-muted);
}

.tool-control.enabled {
  background: var(--bg-secondary);
}

.tool-control:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.tool-control:focus-visible,
.tool-expand:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
}

.tool-control-label {
  color: var(--fg-2);
}

.tool-control-state {
  color: var(--fg-4);
}

.tool-control.enabled .tool-control-state {
  color: var(--fg-2);
}

</style>
