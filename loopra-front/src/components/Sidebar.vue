<template>
  <aside ref="sidebarRoot" class="sidebar" :class="{ collapsed: !sideOpen }">
    <div class="sidebar-shortcuts">
      <button class="shortcut-row shortcut-row-primary" @click="$emit('new-chat')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 8v8M8 12h8"/>
        </svg>
        <span>新建任务</span>
        <kbd>Ctrl+Alt+N</kbd>
      </button>
      <button class="shortcut-row" @click="$emit('open-global-search')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="11" cy="11" r="6"/>
          <path d="m16 16 4 4"/>
        </svg>
        <span>搜索</span>
        <kbd>Ctrl+K</kbd>
      </button>
      <button class="shortcut-row" @click="$emit('show-skill-market')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>
        </svg>
        <span>技能</span>
      </button>
    </div>

    <div class="project-toolbar">
      <div class="project-tabs" aria-label="项目视图">
        <div class="project-tab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/>
          </svg>
          项目
        </div>
      </div>
      <div class="sidebar-section-actions">
        <button
          class="btn-icon-sm"
          title="定位当前会话"
          :disabled="!currentSession"
          @click="syncActiveSessionIntoView"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="8.5"/>
            <circle cx="12" cy="12" r="2"/>
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>
          </svg>
        </button>
        <button
          class="btn-icon-sm"
          :title="allProjectsExpanded ? '折叠所有项目会话' : '展开所有项目会话'"
          @click="toggleAllProjects"
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            :style="{ transform: allProjectsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }"
          >
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </button>
        <button class="btn-icon-sm" title="刷新项目列表" @click="$emit('refresh-sessions')">
          <svg fill="none" height="14" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="14">
            <path d="M23 4v6h-6"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="project-list">
      <div v-for="(p, idx) in projectsData" :key="p.workspace.hash" class="project-item"
            :class="{ 'drag-over': dragOverIndex === idx }"
            draggable="true"
            @dragstart="onDragStart($event, idx)"
            @dragover.prevent="onDragOver($event, idx)"
            @dragleave="onDragLeave"
            @drop.prevent="onDrop($event, idx)"
        @dragend="onDragEnd"
      >
        <div class="project-header" :class="{ active: p.workspace.hash === currentSessionWorkspace && !(currentSession && currentSessionWorkspace === p.workspace.hash) }" @click="toggleProject(p.workspace.hash)">
          <svg v-if="expandedWorkspaces.has(p.workspace.hash)" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="project-icon" aria-label="展开的项目">
            <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h4.2l1.9 2h5.4A2.5 2.5 0 0 1 20 10.5v6A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/>
            <path d="M3.5 10.5h17"/>
          </svg>
          <svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="project-icon" aria-label="折叠的项目">
            <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4.2l1.9 2h5.4A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/>
          </svg>
          <div class="project-info">
            <div class="project-name">{{ p.workspace.name }}</div>
            <div class="project-meta-row">
              <span class="project-path">{{ truncatePath(p.workspace.path) }}</span>
              
            </div>
          </div>
          <button class="btn-icon-sm project-new" title="新建会话" @click.stop="$emit('new-project-chat', p.workspace.hash)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button class="btn-icon-sm project-refresh" title="刷新该项目会话" @click.stop="$emit('refresh-project', p.workspace.hash)">
            <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
              <path d="M23 4v6h-6"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
          <button class="btn-icon-sm project-clear" title="管理项目会话" @click.stop="$emit('manage-project', p.workspace.hash)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>
              <path d="M22 21H7"/>
              <path d="m5 11 9 9"/>
            </svg>
          </button>
        </div>
        <div v-if="expandedWorkspaces.has(p.workspace.hash)" class="project-sessions">
          <div v-if="p.sessions.length === 0" class="project-empty">暂无会话</div>
          <div
            v-for="s in p.sessions"
            :key="s.name"
            class="session-item"
            :data-session-key="`${p.workspace.hash}:${s.name}`"
            :class="{ active: s.name === currentSession && currentSessionWorkspace === p.workspace.hash }"
            @click="$emit('select-session', { workspaceHash: p.workspace.hash, sessionName: s.name })"
          >
            <div class="session-info">
              <div class="session-name">
                {{ s.title || formatName(s.name) }}
                <span v-if="s.worktreeMode" class="wt-badge" title="隔离分支模式">🌲</span>
              </div>
            </div>
            <div class="session-item-actions">
              <button class="btn-icon-sm session-refresh" title="刷新" @click.stop="$emit('refresh-session-chat', s.name)">
                <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                  <path d="M23 4v6h-6"/>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
              </button>
              <button class="btn-icon-sm session-del" @click.stop="$emit('delete-session', { workspaceHash: p.workspace.hash, sessionName: s.name })">
                <svg fill="none" height="12" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="12">
                  <line x1="18" x2="6" y1="6" y2="18"/>
                  <line x1="6" x2="18" y1="6" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="workspaces.length === 0 && initialDataLoaded" class="sidebar-empty">
        暂无项目
      </div>
      <div v-if="!initialDataLoaded" class="sidebar-empty">
        加载中...
      </div>
    </div>

    <div class="sidebar-foot">
      <div class="sidebar-foot-actions">
      <button class="foot-icon" title="工具列表" @click="$emit('show-tools')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
      </button>
      <button class="foot-icon" title="子代理" @click="$emit('show-sub-agents')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A4 4 0 0 1 21 18v1"/></svg>
      </button>
      <button class="foot-icon" title="数据面板" @click="$emit('show-dashboard')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
      </button>
      <button class="foot-icon" title="切换主题" @click="$emit('toggle-theme')">
        <!-- 灰色：月亮图标 -->
        <svg v-if="theme === 'gray'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <!-- 深色：太阳图标 -->
        <svg v-else-if="theme === 'dark'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <!-- 黄色：书本图标 -->
        <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      </button>
      <button class="foot-icon" title="设置" @click="$emit('show-settings')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      </div>
    </div>
  </aside>

</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'

const props = defineProps({
  sideOpen: { type: Boolean, default: true },
  theme: { type: String, default: 'gray' },
  currentSession: { type: String, default: '' },
  currentSessionWorkspace: { type: String, default: null },
  workspaces: { type: Array, default: () => [] },
  workspaceSessions: { type: Object, default: () => ({}) },
  initialDataLoaded: { type: Boolean, default: false }
})

const emit = defineEmits([
  'update:sideOpen',
  'new-chat',
  'open-global-search',
  'refresh-sessions',
  'new-project-chat',
  'refresh-project',
  'manage-project',
  'select-session',
  'refresh-session-chat',
  'delete-session',
  'toggle-theme',
  'show-skill-market',
  'show-tools',
  'show-sub-agents',
  'show-dashboard',
  'show-settings',
  'reorder'
])

const dragIndex = ref(null)
const dragOverIndex = ref(null)
const sidebarRoot = ref(null)

// 本地展开/折叠状态
const expandedWorkspaces = ref(new Set())
const allProjectsExpanded = ref(true)

const handleShortcut = (event) => {
  if (!event.ctrlKey && !event.metaKey) return
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault()
    emit('open-global-search')
  }
  if (event.altKey && event.key.toLowerCase() === 'n') {
    event.preventDefault()
    emit('new-chat')
  }
}

onMounted(() => window.addEventListener('keydown', handleShortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', handleShortcut))

// 根据 props 计算项目列表
const projectsData = computed(() => {
  if (!props.workspaces.length) return []
  return props.workspaces.map(w => ({
    workspace: w,
    sessions: props.workspaceSessions[w.hash] || []
  }))
})



function onDragStart(e, index) {
  dragIndex.value = index
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', String(index))
}

function onDragOver(e, index) {
  dragOverIndex.value = index
}

function onDragLeave() {
  dragOverIndex.value = null
}

function onDrop(e, index) {
  const from = dragIndex.value
  if (from === null || from === index) return
  const list = [...props.workspaces]
  const [item] = list.splice(from, 1)
  list.splice(index, 0, item)
  emit('reorder', list)
  dragIndex.value = null
  dragOverIndex.value = null
}

function onDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}

// 展开/折叠单个项目
const toggleProject = (hash) => {
  const s = new Set(expandedWorkspaces.value)
  if (s.has(hash)) {
    s.delete(hash)
  } else {
    s.add(hash)
  }
  expandedWorkspaces.value = s
}

// 一键展开/折叠所有项目会话
const toggleAllProjects = () => {
  allProjectsExpanded.value = !allProjectsExpanded.value
  const s = new Set()
  if (allProjectsExpanded.value) {
    props.workspaces.forEach(w => s.add(w.hash))
  }
  expandedWorkspaces.value = s
}

const syncActiveSessionIntoView = async () => {
  const workspaceHash = props.currentSessionWorkspace
  const sessionName = props.currentSession
  if (!workspaceHash || !sessionName) return

  if (!expandedWorkspaces.value.has(workspaceHash)) {
    expandedWorkspaces.value = new Set(expandedWorkspaces.value).add(workspaceHash)
  }

  await nextTick()
  requestAnimationFrame(() => {
    const activeSession = sidebarRoot.value?.querySelector('.session-item.active')
    activeSession?.scrollIntoView({behavior: 'smooth', block: 'nearest'})
  })
}

watch(
  () => [props.currentSessionWorkspace, props.currentSession, props.workspaceSessions],
  syncActiveSessionIntoView,
  {immediate: true}
)

// 工具函数
const truncatePath = (p) => {
  if (!p) return ''
  if (p.length <= 40) return p
  return p.slice(0, 36) + '...'
}



const formatName = (n) => {
  const m = n.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}${n.slice(m.index + m[0].length)}` : n.replace(/[-_]+/g, ' ').slice(0, 24)
}
</script>

<style scoped>
.sidebar { width: 272px; flex-shrink: 0; display: flex; flex-direction: column; overflow-x: hidden; background: var(--glass-bg-2);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  border-right: 1px solid var(--glass-border);
  transition: width 0.24s ease, opacity 0.18s ease, transform 0.24s ease;
  will-change: width, opacity, transform;
  overflow: hidden;
}
.sidebar.collapsed {
  width: 0;
  opacity: 0;
  transform: translateX(-10px);
  overflow: hidden;
  pointer-events: none;
}

.sidebar-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--glass-border);
  display: flex;
  align-items: center;
  gap: 10px;
}

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sidebar-logo-icon {
  width: 26px;
  height: 26px;
  background: var(--text, var(--fg));
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
}

.sidebar-logo-text {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.3px;
}

.new-task-btn {
  background: var(--fg);
  color: var(--bg);
  border: none;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 6px;
  transition: all 0.15s;
  font-family: inherit;
}

.new-task-btn:hover {
  opacity: 0.85;
}

.sidebar-search {
  padding: 12px 12px 8px;
}

.search-wrapper {
  position: relative;
}

.search-wrapper i {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--fg-4);
  font-size: 12px;
}

.search-input {
  width: 100%;
  background: var(--bg-3);
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 7px 10px 7px 30px;
  color: var(--fg);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: all 0.15s;
}

.search-input::placeholder {
  color: var(--fg-4);
}

.search-input:focus {
  background: var(--bg);
  border-color: var(--border-2);
}



.section-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--fg-4);
  padding: 12px 8px 6px;
}

.sidebar-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 4px;
  font-size: 12px;
  font-weight: 700;
  color: var(--fg-4);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--border);
}

.sidebar-section-title button {
  opacity: 0.5;
  transition: opacity 0.15s;
}
.sidebar-section-title button:hover {
  opacity: 1;
  color: var(--accent);
}
.sidebar-section-title button:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

.sidebar-section-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.project-list { flex: 1; overflow-x: hidden; overflow-y: auto; padding: 4px 0; }

.project-item.drag-over {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.project-item.dragging {
  opacity: 0.4;
}
.project-item + .project-item {
  border-top: 1px solid var(--border);
}

.project-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background var(--t);
  user-select: none;
}
.project-header:hover {
  background: var(--bg-3);
}
.project-header.active {
  background: transparent;
}
.project-header.active .project-name {
  color: var(--accent);
}

.project-chevron {
  flex-shrink: 0;
  color: var(--fg-4);
  transition: transform 0.2s;
}
.project-chevron.open {
  transform: rotate(90deg);
}

.project-icon {
  flex-shrink: 0;
  color: var(--fg-3);
}

.project-info {
  flex: 1;
  min-width: 0;
}

.project-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-meta-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-path {
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
  min-width: 0;
}





.project-count {
  font-size: 11px;
  color: var(--fg-3);
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: var(--r-sm);
  flex-shrink: 0;
}

.project-clear,
.project-refresh,
.project-new {
  opacity: 0;
  flex-shrink: 0;
  transition: opacity var(--t);
}
.project-clear:hover {
  color: var(--red);
}
.project-refresh:hover {
  color: var(--accent);
}
.project-new:hover {
  color: var(--green);
}
.project-header:hover .project-clear,
.project-header:hover .project-refresh,
.project-header:hover .project-new {
  opacity: 0.6;
}
.project-header:hover .project-clear:hover,
.project-header:hover .project-refresh:hover,
.project-header:hover .project-new:hover {
  opacity: 1;
}

.project-sessions {
  padding: 0 0 4px;
}

.project-empty {
  padding: 8px 16px 8px 32px;
  font-size: 12px;
  color: var(--fg-4);
}

.project-sessions .session-item {
  padding: 5px 12px 5px 38px;
}

.sidebar-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--fg-4);
}

.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--r);
  cursor: pointer;
  transition: background var(--t);
}
.session-item:hover { background: var(--bg-3); }
.session-item.active { background: var(--accent-bg); }

.session-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fg-4);
  flex-shrink: 0;
}
.session-dot.on { background: var(--accent); }

.session-info { flex: 1; min-width: 0; }
.session-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wt-badge {
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.85;
}
.session-meta { font-size: 11px; color: var(--fg-4); margin-top: 1px; }

.session-item-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.session-refresh,
.session-del {
  opacity: 0.3;
  transition: opacity var(--t);
}

.session-item:hover .session-refresh,
.session-item:hover .session-del { opacity: 1; }

.session-refresh:hover {
  color: var(--accent);
}
.session-del:hover { color: var(--red); }



.sidebar-foot {
  padding: 8px;
  border-top: 1px solid var(--glass-border);
  display: flex;
  gap: 2px;
}
.foot-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 4px;
  white-space: nowrap;
  border-radius: var(--r);
  font-size: 12px;
  color: var(--fg-3);
  transition: all var(--t);
}
.foot-btn:hover { background: var(--bg-3); color: var(--fg); }
.foot-btn.active { background: var(--accent-bg); color: var(--accent); }

/* 响应式 */
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    left: -272px;
    top: 33px;
    bottom: 0;
    z-index: 200;
    transition: left 0.24s ease, width 0.24s ease, opacity 0.18s ease, transform 0.24s ease;
  }
  .sidebar:not(.collapsed) { left: 0; }
}


</style>

<style scoped>
.sidebar {
  width: 260px;
  background: #fcfcfd;
  border-right: 1px solid #eeeef0;
  box-shadow: none;
}

.sidebar-shortcuts {
  display: grid;
  gap: 4px;
  padding: 12px 10px;
  border-bottom: 1px solid #eeeef0;
  background: #ffffff;
}

.shortcut-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg-2);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background var(--t), color var(--t);
}

.shortcut-row:hover,
.shortcut-row:focus-visible {
  background: #f6f6f7;
  color: var(--fg);
  outline: none;
}

.shortcut-row svg { color: var(--fg-3); }
.shortcut-row kbd {
  color: var(--fg-4);
  font: 12px var(--sans);
}

.shortcut-row-primary {
  background: #f1f1f3;
  box-shadow: none;
  color: #27272a;
  font-weight: 600;
}

.shortcut-row-primary svg,
.shortcut-row-primary kbd {
  color: #50525b;
}

.shortcut-row-primary:hover,
.shortcut-row-primary:focus-visible {
  background: #f6f6f7;
  color: #18181b;
}

.sidebar-search {
  padding: 10px 12px 4px;
}

.search-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg-4);
}

.search-wrapper i { display: none; }
.search-wrapper > svg { flex: 0 0 auto; }
.search-input {
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.search-input:focus {
  background: transparent;
  border: 0;
}

.project-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid #eeeef0;
  background: #fafafa;
}

.project-tabs,
.sidebar-section-actions,
.sidebar-foot-actions {
  display: flex;
  align-items: center;
}

.project-tabs { gap: 3px; }
.project-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 27px;
  padding: 0 5px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-3);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: default;
}

.sidebar-section-actions { gap: 1px; }
.sidebar .btn-icon-sm {
  display: inline-grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-4);
  cursor: pointer;
  transition: background var(--t), color var(--t);
}

.foot-icon {
  display: inline-grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg-4);
  cursor: pointer;
  transition: background var(--t), color var(--t);
}

.sidebar .btn-icon-sm:hover,
.foot-icon:hover {
  background: var(--bg);
  color: var(--fg-2);
}

.project-list {
  padding: 8px;
  background: #fcfcfd;
}

.project-item + .project-item { border-top: 0; }
.project-item + .project-item { margin-top: 5px; }
.project-header {
  gap: 7px;
  min-height: 38px;
  padding: 6px 7px 6px 9px;
  border-radius: 5px;
}

.project-header:hover { background: #f6f6f7; }
.project-header.active {
  background: #f1f1f3;
  box-shadow: none;
}

.project-header.active .project-name { color: var(--fg); }
.project-chevron { display: none; }
.project-icon { color: #6b6f7c; }
.project-name { font-size: 13px; font-weight: 600; }
.project-meta-row { display: none; }

.project-new,
.project-refresh,
.project-clear {
  width: 24px !important;
  height: 24px !important;
}

.project-sessions {
  margin: 1px 0 4px 18px;
  padding: 2px 0 2px 5px;
  border-left: 1px solid #dedfe3;
}
.project-empty {
  padding: 7px 8px;
  color: var(--fg-4);
  font-size: 13px;
}

.project-sessions .session-item {
  padding: 6px 7px;
  border-radius: 5px;
}

.session-item { gap: 7px; }
.session-item:hover { background: #f6f6f7; }
.session-item.active {
  background: #f1f1f3;
  box-shadow: none;
}
.session-name { font-size: 13px; }
.session-item.active .session-name { font-weight: 600; }
.sidebar-empty { padding: 28px 16px; }

.sidebar-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 58px;
  padding: 9px 12px;
  border-top: 1px solid #eeeef0;
  background: #fafafa;
}

.sidebar-foot-actions {
  display: flex;
  flex: 1;
  justify-content: space-evenly;
  align-items: center;
}

[data-theme="dark"] .sidebar,
[data-theme="dark"] .project-list,
[data-theme="dark"] .sidebar-foot {
  background: #202124;
  border-color: #3b3c43;
}

[data-theme="dark"] .sidebar-shortcuts,
[data-theme="dark"] .project-toolbar {
  border-color: #3b3c43;
  background: #27282d;
}

[data-theme="dark"] .shortcut-row:hover,
[data-theme="dark"] .shortcut-row:focus-visible {
  background: #36373d;
  color: #f1f1f3;
}

[data-theme="dark"] .shortcut-row svg,
[data-theme="dark"] .shortcut-row kbd {
  color: #b6bac3;
}

[data-theme="dark"] .project-header:hover,
[data-theme="dark"] .project-header.active,
[data-theme="dark"] .session-item:hover,
[data-theme="dark"] .session-item.active {
  background: #303137;
}

[data-theme="dark"] .shortcut-row-primary {
  background: #36373d;
  box-shadow: inset 0 0 0 1px #4a4d55;
  color: #f1f1f2;
}

[data-theme="dark"] .shortcut-row-primary svg,
[data-theme="dark"] .shortcut-row-primary kbd {
  color: #bdbec3;
}

[data-theme="dark"] .shortcut-row-primary:hover,
[data-theme="dark"] .shortcut-row-primary:focus-visible {
  background: #484a52;
  color: #f8f8fa;
}

[data-theme="dark"] .project-sessions {
  border-color: #42444b;
}

@media (max-width: 768px) {
  .sidebar { left: -260px; }
}
</style>











