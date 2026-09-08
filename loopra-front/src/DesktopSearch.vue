<template>
  <main
    class="desktop-search-root"
    :data-theme="theme"
    tabindex="-1"
    @mousedown.self="closeSearch"
  >
    <section class="desktop-search-palette" role="dialog" aria-modal="true" aria-label="搜索聊天">
      <div class="desktop-search-input-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
        <input
          ref="searchInput"
          v-model="paletteQuery"
          type="search"
          placeholder="搜索聊天"
          aria-label="搜索聊天"
          autocomplete="off"
          @keydown="handleSearchKeydown"
        />
        <kbd>Esc</kbd>
      </div>

      <div class="desktop-search-content">
        <section v-if="searchChatResults.length" class="desktop-search-section" aria-labelledby="desktop-search-chats-title">
          <div id="desktop-search-chats-title" class="desktop-search-section-title">聊天</div>
          <div class="desktop-search-results" role="listbox" aria-label="聊天搜索结果">
            <button
              v-for="(item, index) in searchChatResults"
              :key="paletteItemKey(item)"
              class="desktop-search-result"
              :class="{ active: paletteActiveIndex === index }"
              type="button"
              role="option"
              :aria-selected="paletteActiveIndex === index"
              @mouseenter="paletteActiveIndex = index"
              @click="selectPaletteItem(item)"
            >
              <span class="desktop-search-result-icon desktop-search-chat-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 5h12l3 3v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="M7 12h10M7 16h6"/></svg>
              </span>
              <span class="desktop-search-result-title">{{ item.title }}</span>
              <span class="desktop-search-result-workspace">{{ item.workspaceName }}</span>
            </button>
          </div>
        </section>

        <section v-if="searchActionResults.length" class="desktop-search-section" aria-labelledby="desktop-search-actions-title">
          <div id="desktop-search-actions-title" class="desktop-search-section-title">快捷操作</div>
          <div class="desktop-search-results" role="listbox" aria-label="快捷操作">
            <button
              v-for="(item, index) in searchActionResults"
              :key="paletteItemKey(item)"
              class="desktop-search-result desktop-search-action"
              :class="{ active: paletteActiveIndex === searchChatResults.length + index }"
              type="button"
              role="option"
              :aria-selected="paletteActiveIndex === searchChatResults.length + index"
              @mouseenter="paletteActiveIndex = searchChatResults.length + index"
              @click="selectPaletteItem(item)"
            >
              <span class="desktop-search-result-icon" aria-hidden="true">
                <svg v-if="item.id === 'new-session'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 17.5V20h2.5L19.2 7.3a1.8 1.8 0 0 0-2.5-2.5L4 17.5Z"/><path d="m14.8 6.7 2.5 2.5"/></svg>
                <svg v-else-if="item.id === 'add-workspace'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-15A2.5 2.5 0 0 1 1 17.5v-10Z"/><path d="M12 10v6M9 13h6"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
              </span>
              <span class="desktop-search-result-title">{{ item.title }}</span>
              <kbd>{{ item.shortcut }}</kbd>
            </button>
          </div>
        </section>

        <div v-if="loading && !searchChatResults.length" class="desktop-search-empty">正在加载会话...</div>
        <div v-else-if="!searchChatResults.length && !searchActionResults.length" class="desktop-search-empty">未找到匹配内容</div>
      </div>
    </section>
  </main>
</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {configAPI, sessionsAPI} from './services/api'

const page = new URLSearchParams(window.location.search)
const theme = ref(page.get('theme') === 'dark' ? 'dark' : 'gray')
const activeSessionName = ref(page.get('activeSessionName') || '')
const activeWorkspaceHash = ref(page.get('activeWorkspaceHash') || '')
const paletteQuery = ref('')
const paletteActiveIndex = ref(0)
const searchInput = ref(null)
const workspaces = ref([])
const sessions = ref([])
const loading = ref(false)
let loadVersion = 0
let stopContextListener = null

const paletteActions = [
  { kind: 'action', id: 'new-session', title: '新聊天', shortcut: 'Ctrl+N', keywords: '新对话 新建会话 chat new' },
  { kind: 'action', id: 'add-workspace', title: '打开文件夹', shortcut: 'Ctrl+O', keywords: '项目 工作区 文件夹 folder workspace' },
  { kind: 'action', id: 'open-file-search', title: '搜索文件', shortcut: 'Ctrl+P', keywords: '文件 查找 file search' }
]

function workspaceNameOf(workspaceHash) {
  const workspace = workspaces.value.find((item) => item.hash === workspaceHash)
  return workspace?.name || ''
}

function sessionTime(session) {
  const value = session?.mtime
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sessionKey(session) {
  return `${session.workspaceHash}:${session.name}`
}

const searchChatResults = computed(() => {
  const keyword = paletteQuery.value.trim().toLowerCase()
  return [...sessions.value]
    .filter((session) => {
      if (!keyword) return true
      return `${session.title || ''} ${session.name || ''} ${workspaceNameOf(session.workspaceHash)}`.toLowerCase().includes(keyword)
    })
    .sort((a, b) => {
      const aActive = a.name === activeSessionName.value && (!activeWorkspaceHash.value || a.workspaceHash === activeWorkspaceHash.value)
      const bActive = b.name === activeSessionName.value && (!activeWorkspaceHash.value || b.workspaceHash === activeWorkspaceHash.value)
      if (aActive !== bActive) return aActive ? -1 : 1
      return sessionTime(b) - sessionTime(a)
    })
    .slice(0, keyword ? 50 : 10)
    .map((session) => ({
      kind: 'session',
      id: sessionKey(session),
      name: session.name,
      title: session.title || session.name || '未命名会话',
      workspaceHash: session.workspaceHash,
      workspaceName: workspaceNameOf(session.workspaceHash) || '默认项目'
    }))
})

const searchActionResults = computed(() => {
  const keyword = paletteQuery.value.trim().toLowerCase()
  return paletteActions.filter((action) => !keyword || `${action.title} ${action.keywords}`.toLowerCase().includes(keyword))
})

function paletteItemKey(item) {
  return `${item.kind}:${item.id}`
}

function paletteItemAt(index) {
  return index < searchChatResults.value.length
    ? searchChatResults.value[index]
    : searchActionResults.value[index - searchChatResults.value.length]
}

function selectPaletteItem(item) {
  if (!item) return
  const bridge = window.electronAPI?.desktopSearch
  if (!bridge?.action) return
  if (item.kind === 'session') {
    void bridge.action({
      type: 'session',
      workspaceHash: item.workspaceHash,
      sessionName: item.name,
      title: item.title
    })
    return
  }
  void bridge.action({ type: 'action', id: item.id })
}

function closeSearch() {
  void window.electronAPI?.desktopSearch?.close?.()
}

function handleSearchKeydown(event) {
  event.stopPropagation()
  const key = event.key.toLowerCase()
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && key === 'n') {
    event.preventDefault()
    selectPaletteItem(paletteActions[0])
    return
  }
  if (modifier && key === 'o') {
    event.preventDefault()
    selectPaletteItem(paletteActions[1])
    return
  }
  if (modifier && key === 'p') {
    event.preventDefault()
    selectPaletteItem(paletteActions[2])
    return
  }
  const resultCount = searchChatResults.value.length + searchActionResults.value.length
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSearch()
  } else if (event.key === 'ArrowDown' && resultCount > 0) {
    event.preventDefault()
    paletteActiveIndex.value = (paletteActiveIndex.value + 1) % resultCount
  } else if (event.key === 'ArrowUp' && resultCount > 0) {
    event.preventDefault()
    paletteActiveIndex.value = (paletteActiveIndex.value - 1 + resultCount) % resultCount
  } else if (event.key === 'Home' && resultCount > 0) {
    event.preventDefault()
    paletteActiveIndex.value = 0
  } else if (event.key === 'End' && resultCount > 0) {
    event.preventDefault()
    paletteActiveIndex.value = resultCount - 1
  } else if (event.key === 'Enter' && resultCount > 0) {
    event.preventDefault()
    selectPaletteItem(paletteItemAt(paletteActiveIndex.value))
  }
}

watch(paletteQuery, () => {
  paletteActiveIndex.value = 0
})

watch([searchChatResults, searchActionResults], ([chats, actions]) => {
  const resultCount = chats.length + actions.length
  if (resultCount === 0) paletteActiveIndex.value = 0
  else if (paletteActiveIndex.value >= resultCount) paletteActiveIndex.value = resultCount - 1
})

async function loadSessions() {
  const version = ++loadVersion
  loading.value = true
  try {
    const workspaceResult = await configAPI.listWorkspaces()
    if (!workspaceResult.success) throw new Error(workspaceResult.message || '加载项目失败')
    const nextWorkspaces = workspaceResult.data || []
    const allSessions = []
    await Promise.all(nextWorkspaces.map(async (workspace) => {
      try {
        const response = await sessionsAPI.list(workspace.hash)
        if (response.success && response.data) {
          for (const session of response.data) allSessions.push({ ...session, workspaceHash: workspace.hash })
        }
      } catch (error) {
        console.warn('[desktop-search] failed to load sessions:', workspace.hash, error)
      }
    }))
    if (version !== loadVersion) return
    workspaces.value = nextWorkspaces
    sessions.value = allSessions
  } catch (error) {
    if (version === loadVersion) {
      workspaces.value = []
      sessions.value = []
      console.warn('[desktop-search] failed to load workspaces:', error)
    }
  } finally {
    if (version === loadVersion) loading.value = false
  }
}

function applyContext(payload = {}) {
  if (payload.theme === 'dark' || payload.theme === 'gray') theme.value = payload.theme
  if (typeof payload.activeSessionName === 'string') activeSessionName.value = payload.activeSessionName
  if (typeof payload.activeWorkspaceHash === 'string') activeWorkspaceHash.value = payload.activeWorkspaceHash
  void loadSessions()
}

function onWindowKeydown(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeSearch()
}

onMounted(() => {
  stopContextListener = window.electronAPI?.events?.listen('desktop-search-context', applyContext)
  window.addEventListener('keydown', onWindowKeydown)
  void loadSessions()
  nextTick(() => searchInput.value?.focus())
})

onBeforeUnmount(() => {
  stopContextListener?.()
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<style>
.desktop-search-root {
  position: fixed;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: clamp(92px, 16vh, 156px) 18px 24px;
  box-sizing: border-box;
  background: rgba(22, 24, 27, .24);
  color: var(--fg, #27272a);
  outline: 0;
  -webkit-font-smoothing: antialiased;
}
.desktop-search-root[data-theme="dark"] { color-scheme: dark; }
.desktop-search-palette {
  width: min(650px, calc(100vw - 36px));
  max-height: min(650px, calc(100vh - 120px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border, #e5e7eb) 86%, transparent);
  border-radius: 20px;
  background: var(--bg, #fff);
  color: var(--fg, #27272a);
  box-shadow: 0 20px 54px rgba(0, 0, 0, .22), 0 3px 12px rgba(0, 0, 0, .1);
}
.desktop-search-input-wrap {
  min-height: 64px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 18px;
  box-sizing: border-box;
  border-bottom: 1px solid color-mix(in srgb, var(--border, #e5e7eb) 70%, transparent);
  color: var(--fg-4, #a1a1aa);
}
.desktop-search-input-wrap > svg { width: 18px; height: 18px; flex: 0 0 auto; }
.desktop-search-input-wrap input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--fg, #27272a);
  font: inherit;
  font-size: 16px;
}
.desktop-search-input-wrap input::placeholder { color: var(--fg-4, #a1a1aa); }
.desktop-search-input-wrap kbd {
  flex: 0 0 auto;
  padding: 3px 7px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  background: var(--bg-3, #f4f4f5);
  color: var(--fg-4, #a1a1aa);
  font-family: inherit;
  font-size: 11px;
}
.desktop-search-content { min-height: 0; overflow: auto; padding: 10px 8px 12px; scrollbar-width: thin; }
.desktop-search-section + .desktop-search-section { margin-top: 10px; }
.desktop-search-section-title { padding: 4px 12px 7px; color: var(--fg-4, #a1a1aa); font-size: 13px; font-weight: 500; }
.desktop-search-results { display: grid; gap: 2px; }
.desktop-search-result {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 11px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: var(--fg-2, #52525b);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.desktop-search-result:hover, .desktop-search-result.active { background: var(--bg-hover, #f1f1f2); color: var(--fg, #27272a); }
.desktop-search-result-icon { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; color: var(--fg-3, #71717a); }
.desktop-search-result-icon svg { width: 17px; height: 17px; }
.desktop-search-chat-icon { color: var(--fg-4, #92959c); }
.desktop-search-result-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desktop-search-result-workspace { min-width: 0; max-width: 42%; margin-left: auto; overflow: hidden; color: var(--fg-4, #a1a1aa); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.desktop-search-result kbd { min-width: 42px; margin-left: auto; padding: 3px 7px; border: 1px solid transparent; border-radius: 999px; background: var(--bg-3, #f1f1f2); color: var(--fg-4, #999ca3); font-family: inherit; font-size: 11px; text-align: center; white-space: nowrap; }
.desktop-search-result.active kbd, .desktop-search-result:hover kbd { border-color: color-mix(in srgb, var(--border, #e5e7eb) 85%, transparent); background: var(--bg, #fff); color: var(--fg-3, #71717a); }
.desktop-search-empty { padding: 30px 12px 34px; color: var(--fg-4, #a1a1aa); font-size: 13px; text-align: center; }
</style>
