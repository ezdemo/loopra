<template>
  <div class="help-view">
    <!-- 头部 -->
    <div class="help-header">
      <div class="header-left">
        <div class="header-title">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <h2>帮助中心</h2>
        </div>
      </div>
      <div class="header-actions">
        <div class="search-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input 
            v-model="searchQuery" 
            type="text" 
            placeholder="搜索帮助文档..." 
            class="search-input"
          />
        </div>
      </div>
    </div>
    
    <!-- 内容区域 -->
    <div class="help-content">
      <!-- 侧边栏导航 -->
      <aside class="help-sidebar">
        <nav class="sidebar-nav">
          <div class="nav-section">
            <h3 class="nav-title">目录</h3>
            <ul class="nav-list">
              <li 
                v-for="section in sections" 
                :key="section.id"
                class="nav-item"
                :class="{ active: activeSection === section.id }"
                @click="scrollToSection(section.id)"
              >
                <span class="nav-icon">{{ section.icon }}</span>
                <span class="nav-label">{{ section.title }}</span>
              </li>
            </ul>
          </div>
          
          <div class="nav-section">
            <h3 class="nav-title">快捷键</h3>
            <div class="shortcuts-list">
              <div v-for="shortcut in shortcuts" :key="shortcut.keys" class="shortcut-item">
                <kbd class="shortcut-keys">{{ shortcut.keys }}</kbd>
                <span class="shortcut-desc">{{ shortcut.desc }}</span>
              </div>
            </div>
          </div>
        </nav>
      </aside>
      
      <!-- 主要内容 -->
      <main class="help-main" ref="helpMain">
        <!-- 搜索结果 -->
        <div v-if="searchQuery && filteredSections.length > 0" class="search-results">
          <div class="results-header">
            <h3>搜索结果</h3>
            <span class="results-count">{{ filteredSections.length }} 个结果</span>
          </div>
          <div class="results-list">
            <div 
              v-for="section in filteredSections" 
              :key="section.id"
              class="result-item"
              @click="scrollToSection(section.id)"
            >
              <div class="result-icon">{{ section.icon }}</div>
              <div class="result-content">
                <div class="result-title">{{ section.title }}</div>
                <div class="result-preview">{{ section.preview }}</div>
              </div>
            </div>
          </div>
        </div>
        
        <!-- 快速入门 -->
        <section id="quickstart" class="help-section">
          <div class="section-header">
            <div class="section-icon">🚀</div>
            <div class="section-title">
              <h3>快速入门</h3>
              <p>开始使用 Loopra 的基本步骤</p>
            </div>
          </div>
          
          <div class="section-content">
            <div class="steps-grid">
              <div class="step-card">
                <div class="step-number">1</div>
                <div class="step-content">
                  <h4>启动系统</h4>
                  <p>运行 Loopra 应用，系统会自动加载配置和工具。</p>
                  <div class="step-command">
                    <code>mvn exec:java -pl loopra</code>
                  </div>
                </div>
              </div>
              
              <div class="step-card">
                <div class="step-number">2</div>
                <div class="step-content">
                  <h4>配置 API</h4>
                  <p>在设置中配置您的 AI API 密钥和端点。</p>
                  <div class="step-command">
                    <code>~/.loopra/config.json</code>
                  </div>
                </div>
              </div>
              
              <div class="step-card">
                <div class="step-number">3</div>
                <div class="step-content">
                  <h4>开始对话</h4>
                  <p>在聊天界面输入消息，与 AI 助手进行交互。</p>
                  <div class="step-command">
                    <code>输入您的问题...</code>
                  </div>
                </div>
              </div>
              
              <div class="step-card">
                <div class="step-number">4</div>
                <div class="step-content">
                  <h4>使用工具</h4>
                  <p>AI 助手会自动调用合适的工具来完成任务。</p>
                  <div class="step-command">
                    <code>工具会自动执行</code>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        
        <!-- 命令参考 -->
        <section id="commands" class="help-section">
          <div class="section-header">
            <div class="section-icon">⌨️</div>
            <div class="section-title">
              <h3>命令参考</h3>
              <p>可用的斜杠命令和操作</p>
            </div>
          </div>
          
          <div class="section-content">
            <div class="commands-table">
              <div class="table-header">
                <div class="col-command">命令</div>
                <div class="col-description">描述</div>
                <div class="col-example">示例</div>
              </div>
              <div 
                v-for="cmd in commands" 
                :key="cmd.name"
                class="table-row"
              >
                <div class="col-command">
                  <code class="command-name">{{ cmd.name }}</code>
                </div>
                <div class="col-description">{{ cmd.desc }}</div>
                <div class="col-example">
                  <code class="command-example">{{ cmd.example }}</code>
                </div>
              </div>
            </div>
          </div>
        </section>
        
        <!-- 工具列表 -->
        <section id="tools" class="help-section">
          <div class="section-header">
            <div class="section-icon">🔧</div>
            <div class="section-title">
              <h3>工具列表</h3>
              <p>可用的 AI 工具和功能</p>
            </div>
          </div>
          
          <div class="section-content">
            <div class="tools-grid">
              <div 
                v-for="tool in tools" 
                :key="tool.name"
                class="tool-card"
              >
                <div class="tool-header">
                  <div class="tool-icon" :class="{ readonly: tool.readonly }">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                  </div>
                  <div class="tool-info">
                    <div class="tool-name">{{ tool.name }}</div>
                    <span v-if="tool.readonly" class="tool-badge readonly">只读</span>
                  </div>
                </div>
                <div class="tool-description">{{ tool.desc }}</div>
                <div class="tool-params">
                  <span class="params-label">参数:</span>
                  <span class="params-value">{{ tool.params }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
        
        <!-- 配置说明 -->
        <section id="config" class="help-section">
          <div class="section-header">
            <div class="section-icon">⚙️</div>
            <div class="section-title">
              <h3>配置说明</h3>
              <p>配置文件和选项说明</p>
            </div>
          </div>
          
          <div class="section-content">
            <div class="config-info">
              <div class="config-location">
                <h4>配置文件位置</h4>
                <div class="location-path">
                  <code>~/.loopra/config.json</code>
                </div>
              </div>
              
              <div class="config-example">
                <h4>配置文件示例</h4>
                <div class="code-block">
                  <pre><code>{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-your-api-key",
  "model": "deepseek-v4-flash",
  "workspaceDir": ".",
  "editMode": "auto",
  "reasoningEffort": "max",
  "lang": "ZH"
}</code></pre>
                </div>
              </div>
              
              <div class="config-options">
                <h4>配置选项</h4>
                <div class="options-list">
                  <div class="option-item">
                    <div class="option-name">baseUrl</div>
                    <div class="option-desc">OpenAI 兼容 API 的基础 URL</div>
                  </div>
                  <div class="option-item">
                    <div class="option-name">apiKey</div>
                    <div class="option-desc">API 密钥</div>
                  </div>
                  <div class="option-item">
                    <div class="option-name">model</div>
                    <div class="option-desc">使用的模型名称</div>
                  </div>
                  <div class="option-item">
                    <div class="option-name">workspaceDir</div>
                    <div class="option-desc">项目目录路径</div>
                  </div>
                  <div class="option-item">
                    <div class="option-name">editMode</div>
                    <div class="option-desc">编辑模式 (auto/confirm/preview)</div>
                  </div>
                  <div class="option-item">
                    <div class="option-name">reasoningEffort</div>
                    <div class="option-desc">推理强度 (low/medium/high/max)</div>
                  </div>
                  <div class="option-item">
                    <div class="option-name">modelChannels[].models[].maxTokens</div>
                    <div class="option-desc">按模型配置单次请求最大输出 token 数（包含推理 token）；未配置时使用默认值</div>
                  </div>
                  <div class="option-item">
                    <div class="option-name">lang</div>
                    <div class="option-desc">界面语言 (ZH/EN)</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        
        <!-- 故障排除 -->
        <section id="troubleshooting" class="help-section">
          <div class="section-header">
            <div class="section-icon">🔍</div>
            <div class="section-title">
              <h3>故障排除</h3>
              <p>常见问题和解决方案</p>
            </div>
          </div>
          
          <div class="section-content">
            <div class="issues-list">
              <div 
                v-for="issue in troubleshooting" 
                :key="issue.title"
                class="issue-card"
              >
                <div class="issue-header">
                  <h4 class="issue-title">{{ issue.title }}</h4>
                </div>
                <div class="issue-content">
                  <div class="issue-symptom">
                    <strong>症状:</strong>
                    <p>{{ issue.symptom }}</p>
                  </div>
                  <div class="issue-solution">
                    <strong>解决方案:</strong>
                    <p>{{ issue.solution }}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        
        <!-- API 文档 -->
        <section id="api" class="help-section">
          <div class="section-header">
            <div class="section-icon">📡</div>
            <div class="section-title">
              <h3>API 文档</h3>
              <p>RESTful API 接口说明</p>
            </div>
          </div>
          
          <div class="section-content">
            <div class="api-info">
              <p>Loopra 提供 RESTful API 接口，用于与外部系统集成。</p>
              
              <div class="endpoints-list">
                <div 
                  v-for="endpoint in apiEndpoints" 
                  :key="endpoint.path"
                  class="endpoint-item"
                >
                  <div class="endpoint-method" :class="endpoint.method.toLowerCase()">
                    {{ endpoint.method }}
                  </div>
                  <div class="endpoint-path">
                    <code>{{ endpoint.path }}</code>
                  </div>
                  <div class="endpoint-desc">{{ endpoint.desc }}</div>
                </div>
              </div>
            </div>
          </div>
        </section>
        
        <!-- 更新日志 -->
        <section id="changelog" class="help-section">
          <div class="section-header">
            <div class="section-icon">📝</div>
            <div class="section-title">
              <h3>更新日志</h3>
              <p>版本更新记录</p>
            </div>
          </div>
          
          <div class="section-content">
            <div class="changelog-list">
              <div 
                v-for="release in changelog" 
                :key="release.version"
                class="release-card"
              >
                <div class="release-header">
                  <div class="release-version">{{ release.version }}</div>
                  <div class="release-date">{{ release.date }}</div>
                </div>
                <div class="release-changes">
                  <div 
                    v-for="(change, index) in release.changes" 
                    :key="index"
                    class="change-item"
                  >
                    <span class="change-type" :class="change.type">{{ change.type }}</span>
                    <span class="change-desc">{{ change.desc }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup>
import {computed, nextTick, onMounted, ref} from 'vue'

// 状态
const searchQuery = ref('')
const activeSection = ref('quickstart')
const helpMain = ref(null)

// 目录配置
const sections = [
  { id: 'quickstart', title: '快速入门', icon: '🚀', preview: '开始使用 Loopra 的基本步骤' },
  { id: 'commands', title: '命令参考', icon: '⌨️', preview: '可用的斜杠命令和操作' },
  { id: 'tools', title: '工具列表', icon: '🔧', preview: '可用的 AI 工具和功能' },
  { id: 'config', title: '配置说明', icon: '⚙️', preview: '配置文件和选项说明' },
  { id: 'troubleshooting', title: '故障排除', icon: '🔍', preview: '常见问题和解决方案' },
  { id: 'api', title: 'API 文档', icon: '📡', preview: 'RESTful API 接口说明' },
  { id: 'changelog', title: '更新日志', icon: '📝', preview: '版本更新记录' }
]

// 快捷键配置
const shortcuts = [
  { keys: 'Enter', desc: '发送消息' },
  { keys: 'Shift+Enter', desc: '换行' },
  { keys: 'Ctrl+K', desc: '聚焦搜索' },
  { keys: 'Ctrl+Alt+N', desc: '新建对话' },
  { keys: 'Ctrl+B', desc: '切换侧边栏' },
  { keys: 'Escape', desc: '关闭弹窗' }
]

// 命令列表
const commands = [
  { name: '/new', desc: '开启新会话', example: '/new' },
  { name: '/compact', desc: '折叠历史消息', example: '/compact' },
  { name: '/retry', desc: '撤回最后一条消息并重试', example: '/retry' },
  { name: '/rewind', desc: '回退到第N轮对话', example: '/rewind 5' },
  { name: '/sessions', desc: '列出历史会话', example: '/sessions' },
  { name: '/load', desc: '加载指定会话', example: '/load 3' },
  { name: '/init', desc: '自动分析项目生成文档', example: '/init' },
  { name: '/goal', desc: '创建和管理当前会话 Goal', example: '/goal create 修复登录问题' },
  { name: '/hitl', desc: '切换 HITL 模式', example: '/hitl' },
  { name: '/help', desc: '显示帮助信息', example: '/help' },
  { name: '/exit', desc: '退出系统', example: '/exit' }
]

// 工具列表
const tools = [
  { name: 'read', desc: '读取文件内容', params: 'file_path, offset?, limit?', readonly: true },
  { name: 'edit', desc: '精准文本替换编辑', params: 'file_path, edits[{old_str,old_StrStartLine,new_str,replace_all}]', readonly: false },
  { name: 'write', desc: '创建或覆盖文件', params: 'file_path, content', readonly: false },
  { name: 'bash', desc: '执行 shell 命令', params: 'command, timeout?', readonly: false },
  { name: 'glob', desc: '按通配符模式搜索文件', params: 'pattern, path', readonly: true },
  { name: 'grep', desc: '递归搜索内容', params: 'pattern, path, include?', readonly: true },
  { name: 'ls', desc: '列出目录内容', params: 'path, recursive?, show_hidden?', readonly: true },
  { name: 'sub_agent', desc: '创建预设角色子代理', params: 'profile, task, instructions?', readonly: false },
  { name: 'goal_create / goal_update_step / goal_complete', desc: '创建、推进和验证会话 Goal', params: 'objective / stepIndex, status, evidence / summary', readonly: false }
]

// 故障排除
const troubleshooting = [
  {
    title: '无法连接到 AI 服务',
    symptom: '发送消息后长时间无响应，或显示连接错误',
    solution: '检查 ~/.loopra/config.json 中的 baseUrl 和 apiKey 是否正确。确保网络连接正常。'
  },
  {
    title: '工具调用失败',
    symptom: 'AI 尝试使用工具但返回错误',
    solution: '检查项目路径是否正确，确保有足够的文件操作权限。'
  },
  {
    title: '界面显示异常',
    symptom: '字符显示乱码或布局错乱',
    solution: '尝试切换主题或调整字体大小。确保终端支持 UTF-8 编码。'
  },
  {
    title: '会话历史丢失',
    symptom: '重新打开后之前的对话记录消失',
    solution: '检查 ~/.loopra/sessions/ 目录是否有写入权限。会话会自动保存到此目录。'
  }
]

// API 端点
const apiEndpoints = [
  { method: 'POST', path: '/api/chat', desc: '同步聊天' },
  { method: 'POST', path: '/api/chat/stream', desc: 'SSE 流式聊天' },
  { method: 'GET', path: '/api/agent/status', desc: '获取 Agent 状态' },
  { method: 'GET', path: '/api/agent/history', desc: '获取历史消息' },
  { method: 'POST', path: '/api/agent/retry', desc: '撤回并重试' },
  { method: 'POST', path: '/api/agent/rewind', desc: '回退到指定轮次' },
  { method: 'POST', path: '/api/agent/compact', desc: '折叠上下文' },
  { method: 'GET', path: '/api/agent/mode', desc: '查询会话计划模式和待审查计划' },
  { method: 'POST', path: '/api/agent/mode', desc: '切换会话计划模式' },
  { method: 'GET', path: '/api/sessions', desc: '列出所有会话' },
  { method: 'GET', path: '/api/sessions/current', desc: '获取当前会话' },
  { method: 'POST', path: '/api/sessions/new', desc: '新建会话' },
  { method: 'POST', path: '/api/sessions/{name}', desc: '切换会话' },
  { method: 'DELETE', path: '/api/sessions/{name}', desc: '删除会话' },
  { method: 'GET', path: '/api/tools', desc: '列出所有工具' },
  { method: 'GET', path: '/api/config', desc: '获取当前配置' },
  { method: 'GET', path: '/api/usage', desc: '获取 Token 用量统计' }
]

// 更新日志
const changelog = [
  {
    version: 'v1.0.0',
    date: '2024-03-20',
    changes: [
      { type: '新增', desc: '初始版本发布' },
      { type: '新增', desc: '支持 OpenAI 兼容 API' },
      { type: '新增', desc: '文件操作工具集' },
      { type: '新增', desc: '会话管理和持久化' },
      { type: '新增', desc: '流式输出支持' },
      { type: '新增', desc: '计划模式（/plan 只读探索 + submit_plan 提交计划 + /execute 批准执行）' },
      { type: '新增', desc: '深色/浅色主题' }
    ]
  }
]

// 计算属性
const filteredSections = computed(() => {
  if (!searchQuery.value) return []
  const query = searchQuery.value.toLowerCase()
  return sections.filter(section => 
    section.title.toLowerCase().includes(query) ||
    section.preview.toLowerCase().includes(query)
  )
})

// 方法
const scrollToSection = (sectionId) => {
  activeSection.value = sectionId
  const element = document.getElementById(sectionId)
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

// 生命周期
onMounted(() => {
  // 监听滚动事件，更新活动章节
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        activeSection.value = entry.target.id
      }
    })
  }, { threshold: 0.5 })
  
  // 观察所有章节
  nextTick(() => {
    sections.forEach(section => {
      const element = document.getElementById(section.id)
      if (element) {
        observer.observe(element)
      }
    })
  })
})
</script>

<style scoped>
.help-view {
  padding: var(--space-6);
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* 头部 */
.help-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-6);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.header-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg);
}

.header-title svg {
  color: var(--brand-primary);
}

.header-title h2 {
  font-size: var(--text-2xl);
  font-weight: var(--font-bold);
}

.header-actions {
  display: flex;
  gap: var(--space-3);
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
  width: 280px;
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

/* 内容区域 */
.help-content {
  display: flex;
  gap: var(--space-6);
  flex: 1;
}

/* 侧边栏 */
.help-sidebar {
  width: 240px;
  flex-shrink: 0;
  position: sticky;
  top: var(--space-6);
  align-self: flex-start;
  max-height: calc(100vh - 200px);
  overflow-y: auto;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.nav-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
}

.nav-title {
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--fg);
  margin-bottom: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.nav-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  color: var(--fg-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.nav-item:hover {
  background: var(--surface-hover);
  color: var(--fg);
}

.nav-item.active {
  background: var(--accent-soft);
  color: var(--brand-primary);
}

.nav-icon {
  font-size: 14px;
}

/* 快捷键列表 */
.shortcuts-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.shortcut-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.shortcut-keys {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 var(--space-1);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: var(--font-medium);
  color: var(--fg-secondary);
}

.shortcut-desc {
  color: var(--fg-muted);
}

/* 主要内容 */
.help-main {
  flex: 1;
  min-width: 0;
}

/* 搜索结果 */
.search-results {
  margin-bottom: var(--space-6);
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.results-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.results-header h3 {
  font-size: var(--text-lg);
  font-weight: var(--font-semibold);
  color: var(--fg);
}

.results-count {
  font-size: var(--text-sm);
  color: var(--fg-muted);
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.result-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.result-item:hover {
  background: var(--surface-hover);
}

.result-icon {
  font-size: 16px;
}

.result-content {
  flex: 1;
}

.result-title {
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--fg);
  margin-bottom: 0.25rem;
}

.result-preview {
  font-size: var(--text-xs);
  color: var(--fg-muted);
}

/* 帮助章节 */
.help-section {
  margin-bottom: var(--space-8);
  scroll-margin-top: var(--space-6);
}

.section-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-6);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.section-icon {
  font-size: 24px;
}

.section-title h3 {
  font-size: var(--text-xl);
  font-weight: var(--font-bold);
  color: var(--fg);
  margin-bottom: 0.25rem;
}

.section-title p {
  font-size: var(--text-sm);
  color: var(--fg-muted);
}

/* 步骤网格 */
.steps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: var(--space-4);
}

.step-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  transition: all var(--transition-fast);
}

.step-card:hover {
  border-color: var(--border-focus);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

.step-number {
  width: 32px;
  height: 32px;
  background: var(--gradient-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: var(--font-bold);
  color: white;
  margin-bottom: var(--space-3);
}

.step-content h4 {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--fg);
  margin-bottom: var(--space-2);
}

.step-content p {
  font-size: var(--text-sm);
  color: var(--fg-secondary);
  line-height: 1.6;
  margin-bottom: var(--space-3);
}

.step-command {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}

.step-command code {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--brand-primary);
}

/* 命令表格 */
.commands-table {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.table-header {
  display: grid;
  grid-template-columns: 120px 1fr 200px;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--fg);
}

.table-row {
  display: grid;
  grid-template-columns: 120px 1fr 200px;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  font-size: var(--text-sm);
  transition: background var(--transition-fast);
}

.table-row:last-child {
  border-bottom: none;
}

.table-row:hover {
  background: var(--surface-hover);
}

.command-name {
  font-family: var(--font-mono);
  font-weight: var(--font-semibold);
  color: var(--brand-primary);
}

.command-example {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--fg-muted);
}

/* 工具网格 */
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--space-4);
}

.tool-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  transition: all var(--transition-fast);
}

.tool-card:hover {
  border-color: var(--border-focus);
  box-shadow: var(--shadow-md);
}

.tool-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.tool-icon {
  width: 32px;
  height: 32px;
  background: var(--accent-soft);
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand-primary);
}

.tool-icon.readonly {
  background: var(--success-bg);
  color: var(--success);
}

.tool-info {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tool-name {
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  font-family: var(--font-mono);
  color: var(--fg);
}

.tool-badge {
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-full);
}

.tool-badge.readonly {
  background: var(--success-bg);
  color: var(--success);
}

.tool-description {
  font-size: var(--text-sm);
  color: var(--fg-secondary);
  line-height: 1.5;
  margin-bottom: var(--space-3);
}

.tool-params {
  font-size: var(--text-xs);
  color: var(--fg-muted);
}

.params-label {
  font-weight: var(--font-semibold);
}

.params-value {
  font-family: var(--font-mono);
}

/* 配置信息 */
.config-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.config-location,
.config-example,
.config-options {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
}

.config-location h4,
.config-example h4,
.config-options h4 {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--fg);
  margin-bottom: var(--space-3);
}

.location-path {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
}

.location-path code {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--brand-primary);
}

.code-block {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow-x: auto;
}

.code-block pre {
  margin: 0;
  padding: var(--space-4);
  background: none;
  border: none;
}

.code-block code {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--fg);
  background: none;
  padding: 0;
}

.options-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.option-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-secondary);
  border-radius: var(--radius);
}

.option-name {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--brand-primary);
  min-width: 120px;
}

.option-desc {
  font-size: var(--text-sm);
  color: var(--fg-secondary);
  line-height: 1.5;
}

/* 问题列表 */
.issues-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.issue-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.issue-header {
  padding: var(--space-4);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.issue-title {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--fg);
}

.issue-content {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.issue-symptom,
.issue-solution {
  font-size: var(--text-sm);
  line-height: 1.6;
}

.issue-symptom strong,
.issue-solution strong {
  color: var(--fg);
  display: block;
  margin-bottom: var(--space-1);
}

.issue-symptom p,
.issue-solution p {
  color: var(--fg-secondary);
  margin: 0;
}

/* API 端点 */
.api-info {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
}

.api-info > p {
  font-size: var(--text-sm);
  color: var(--fg-secondary);
  margin-bottom: var(--space-4);
}

.endpoints-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.endpoint-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-secondary);
  border-radius: var(--radius);
  transition: all var(--transition-fast);
}

.endpoint-item:hover {
  background: var(--surface-hover);
}

.endpoint-method {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--font-bold);
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-sm);
  min-width: 50px;
  text-align: center;
}

.endpoint-method.get {
  background: var(--success-bg);
  color: var(--success);
}

.endpoint-method.post {
  background: var(--info-bg);
  color: var(--info);
}

.endpoint-method.delete {
  background: var(--danger-bg);
  color: var(--danger);
}

.endpoint-path {
  flex: 1;
}

.endpoint-path code {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--fg);
}

.endpoint-desc {
  font-size: var(--text-sm);
  color: var(--fg-muted);
}

/* 更新日志 */
.changelog-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.release-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.release-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.release-version {
  font-family: var(--font-mono);
  font-size: var(--text-base);
  font-weight: var(--font-bold);
  color: var(--brand-primary);
}

.release-date {
  font-size: var(--text-sm);
  color: var(--fg-muted);
}

.release-changes {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.change-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.change-type {
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  padding: 0.125rem 0.375rem;
  border-radius: var(--radius-full);
  min-width: 40px;
  text-align: center;
}

.change-type.新增 {
  background: var(--success-bg);
  color: var(--success);
}

.change-type.修复 {
  background: var(--warning-bg);
  color: var(--warning);
}

.change-type.优化 {
  background: var(--info-bg);
  color: var(--info);
}

.change-desc {
  color: var(--fg-secondary);
}

/* 响应式设计 */
@media (max-width: 1024px) {
  .help-sidebar {
    display: none;
  }
}

@media (max-width: 768px) {
  .help-view {
    padding: var(--space-4);
  }
  
  .help-header {
    flex-direction: column;
    gap: var(--space-4);
    align-items: flex-start;
  }
  
  .header-actions {
    width: 100%;
  }
  
  .search-input {
    width: 100%;
  }
  
  .steps-grid {
    grid-template-columns: 1fr;
  }
  
  .table-header,
  .table-row {
    grid-template-columns: 1fr;
    gap: var(--space-2);
  }
  
  .table-header .col-example,
  .table-row .col-example {
    display: none;
  }
  
  .tools-grid {
    grid-template-columns: 1fr;
  }
  
  .endpoint-item {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }
}

/* 深色模式调整 */
[data-theme="dark"] .nav-section {
  background: var(--bg-secondary);
  border-color: var(--border);
}

[data-theme="dark"] .step-card,
[data-theme="dark"] .tool-card,
[data-theme="dark"] .config-location,
[data-theme="dark"] .config-example,
[data-theme="dark"] .config-options,
[data-theme="dark"] .issue-card,
[data-theme="dark"] .api-info,
[data-theme="dark"] .release-card {
  background: var(--bg-secondary);
  border-color: var(--border);
}

[data-theme="dark"] .commands-table {
  background: var(--bg-secondary);
  border-color: var(--border);
}

[data-theme="dark"] .table-header {
  background: var(--bg-tertiary);
}

[data-theme="dark"] .issue-header,
[data-theme="dark"] .release-header {
  background: var(--bg-tertiary);
}

[data-theme="dark"] .endpoint-item {
  background: var(--bg-tertiary);
}

[data-theme="dark"] .option-item {
  background: var(--bg-tertiary);
}
</style>
