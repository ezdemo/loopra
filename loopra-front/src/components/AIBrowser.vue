 <template>
   <main class="ai-browser-shell">
     <!-- 标签栏（Chrome 风格） -->
     <header class="ai-browser-tabstrip">
      <nav ref="tabStripRef" class="ai-browser-tabs" aria-label="浏览器标签页">
         <button
           v-for="tab in state.tabs"
           :key="tab.id"
           class="ai-browser-tab"
           :class="{ active: tab.id === state.activeTabId }"
           :title="tab.title || tab.url || '新标签页'"
           @click="activate(tab.id)"
           @auxclick="onTabAuxClick($event, tab.id)"
         >
           <span class="ai-browser-tab-icon">
             <span v-if="tab.loading" class="ai-browser-spinner"></span>
             <img
               v-else-if="tab.favicon"
               class="ai-browser-favicon-img"
               :src="tab.favicon"
               alt=""
               @error="onFaviconError(tab.id)"
             />
             <span v-else class="ai-browser-favicon" :style="{ background: siteColor(tab.url) }">{{ tabLetter(tab) }}</span>
           </span>
           <span class="ai-browser-tab-title">{{ tab.title || '新标签页' }}</span>
           <span class="ai-browser-tab-close" title="关闭标签页 (Ctrl+W)" @click.stop="closeTab(tab.id)">
             <i class="codicon codicon-chrome-close"></i>
           </span>
         </button>
       </nav>
      <button class="ai-browser-new-tab" title="新建标签页 (Ctrl+T)" @click="newTab()">
        <i class="codicon codicon-add"></i>
      </button>
    </header>
 
     <!-- 工具栏 / Omnibox -->
     <div class="ai-browser-toolbar">
       <div class="ai-browser-toolbar-left">
         <button class="ai-browser-icon-button" title="后退 (Alt+←)" :disabled="!activeTab?.canGoBack" @click="history('back')">
           <i class="codicon codicon-chevron-left"></i>
         </button>
         <button class="ai-browser-icon-button" title="前进 (Alt+→)" :disabled="!activeTab?.canGoForward" @click="history('forward')">
          <i class="codicon codicon-chevron-right"></i>
        </button>
          <button class="ai-browser-icon-button ai-inspector-toggle" :class="{ active: elementMode }" title="元素抓取：在页面上拾取元素" @click="toggleElementMode()">
            <i class="codicon codicon-inspect"></i>
          </button>
      </div>
 
       <form class="ai-browser-omnibox" @submit.prevent="submitOmnibox">
         <span class="ai-browser-omnibox-icon" :class="{ secure: isSecure && !isBlankTab }" :title="isBlankTab ? '' : (isSecure ? '连接是安全的' : '连接未加密')">
           <i :class="securityIcon"></i>
         </span>
         <input
           ref="omniboxRef"
           v-model="address"
           class="ai-browser-address"
           autocomplete="off"
           spellcheck="false"
           placeholder="搜索或输入网址"
           @keydown.esc="syncAddress()"
         />
         <span v-if="activeTab?.loading" class="ai-browser-omnibox-spinner"><span class="ai-browser-spinner"></span></span>
         <button
           v-else
           type="button"
           class="ai-browser-icon-button ai-browser-omnibox-action"
           title="刷新 (Ctrl+R)"
           :disabled="!activeTab || isBlankTab"
           @click="history('reload')"
         >
           <i class="codicon codicon-refresh"></i>
         </button>
       </form>
 
       <div class="ai-browser-toolbar-right">
         <div class="ai-browser-activity" :class="activity.state" :title="activity.message">
           <span class="ai-browser-activity-dot"></span>
           <span class="ai-browser-activity-message">{{ activity.message }}</span>
         </div>
       </div>
     </div>
 
      <!-- 页面内容区（原生 WebContentsView 覆盖于 viewport；空白页/新标签页显示内置新标签页） -->
      <section class="ai-browser-content">
        <div class="ai-browser-stage" :class="{ 'with-inspector': elementMode }">
          <div ref="nativeHostRef" class="ai-browser-viewport">
            <div v-if="!state.tabs.length" class="ai-browser-blank">
              <div class="ai-browser-blank-inner">
                <div class="ai-browser-newtab-logo">AI</div>
                <p class="ai-browser-blank-title">还没有打开的标签页</p>
                <button class="ai-browser-primary" @click="newTab()">新建标签页</button>
              </div>
            </div>
 
            <div v-else-if="isBlankTab" class="ai-browser-blank">
              <div class="ai-browser-blank-inner">
                <div class="ai-browser-newtab-logo">AI</div>
                <h1 class="ai-browser-newtab-title">新标签页</h1>
                <form class="ai-browser-newtab-search" @submit.prevent="submitNewTabSearch">
                  <i class="codicon codicon-search"></i>
                  <input
                    ref="newTabInputRef"
                    v-model="newTabQuery"
                    class="ai-browser-newtab-input"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="搜索或输入网址"
                  />
                  <button type="submit" class="ai-browser-newtab-go" title="转到">
                    <i class="codicon codicon-arrow-right"></i>
                  </button>
                </form>
                <div class="ai-browser-shortcuts">
                  <button v-for="site in shortcuts" :key="site.title" class="ai-browser-shortcut" :title="site.url" @click="openShortcut(site.url)">
                    <span class="ai-browser-shortcut-icon" :style="{ background: site.color }">{{ site.title[0] }}</span>
                    <span class="ai-browser-shortcut-name">{{ site.title }}</span>
                  </button>
                </div>
                <p class="ai-browser-blank-hint">也可以直接让 AI 帮你搜索、打开网页并操作页面</p>
              </div>
            </div>
          </div>
 
          <!-- 元素抓取侧栏 -->
          <aside v-if="elementMode" class="ai-browser-inspector">
            <header class="ai-inspector-head">
              <span class="ai-inspector-title"><i class="codicon codicon-inspect"></i>元素抓取</span>
              <span v-if="pickActive" class="ai-inspector-state on"><i class="codicon codicon-eye"></i>拾取中</span>
              <button class="ai-inspector-close" title="关闭元素抓取" @click="toggleElementMode(false)"><i class="codicon codicon-close"></i></button>
            </header>
 
            <div class="ai-inspector-actions">
              <button class="ai-inspector-btn" :class="{ primary: !pickActive }" :disabled="!canPickPage || inspectBusy" @click="startPick">
                <i class="codicon codicon-crosshair"></i>
                {{ pickActive ? '退出拾取' : '开始拾取' }}
              </button>
              <span v-if="!canPickPage" class="ai-inspector-warn">请先在浏览器中打开一个网页标签页</span>
            </div>
 
            <p v-if="inspectStatus" class="ai-inspector-status" :class="{ error: inspectFailed }">{{ inspectStatus }}</p>
 
            <div v-if="picked" class="ai-inspector-body">
              <div class="ai-inspector-fields">
                <div class="ai-inspector-row"><label>名称</label><span>{{ picked.name }}</span></div>
                <div class="ai-inspector-row"><label>标签</label><code>{{ picked.tag }}</code></div>
                <div class="ai-inspector-row" v-if="picked.text"><label>文本</label><span :title="picked.text">{{ picked.text }}</span></div>
                <div class="ai-inspector-row" v-if="picked.selector"><label>选择器</label><code :title="picked.selector">{{ picked.selector }}</code></div>
                <div class="ai-inspector-row" v-if="picked.file"><label>文件</label><code :title="picked.file">{{ picked.file }}</code></div>
                <div class="ai-inspector-row" v-if="picked.path && picked.path.length"><label>组件路径</label><span>{{ picked.path.join(' › ') }}</span></div>
                <div class="ai-inspector-row" v-if="picked.attrs && picked.attrs.length">
                  <label>属性</label>
                  <div class="ai-inspector-attrs">
                    <span v-for="(attr, idx) in picked.attrs" :key="idx" class="ai-inspector-attr">{{ attr.key }}="{{ attr.val }}"</span>
                  </div>
                </div>
              </div>
              <textarea v-model="inspectMsg" class="ai-inspector-msg" rows="3" placeholder="给 AI 的说明（可选，默认为元素摘要）"></textarea>
              <button class="ai-inspector-send" :disabled="!inspectMsg.trim()" @click="sendPicked">
                <i class="codicon codicon-send"></i>发送到当前会话
              </button>
            </div>
 
            <div v-else class="ai-inspector-empty">
              <i class="codicon codicon-crosshair"></i>
              <p>开始拾取后，在页面中悬停高亮、点击元素即可抓取</p>
            </div>
          </aside>
        </div>
      </section>
 
     <footer class="ai-browser-status">
       <span class="ai-browser-status-left">
         <span v-if="activeTab?.loading" class="ai-browser-status-spinner"></span>
         <span class="ai-browser-status-text">{{ statusText }}</span>
       </span>
       <span class="ai-browser-status-right">AI 可帮你浏览与操作网页</span>
     </footer>
   </main>
 </template>
 
 <script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
 
const nativeHostRef = ref(null)
const tabStripRef = ref(null)
const omniboxRef = ref(null)
 const newTabInputRef = ref(null)
 const state = ref({ activeTabId: null, tabs: [] })
 const address = ref('')
 const newTabQuery = ref('')
const activity = ref({ state: 'idle', message: '等待 AI 操作', targetId: null })
 const elementMode = ref(false)
 const pickActive = ref(false)
 const picked = ref(null)
 const inspectMsg = ref('')
 const inspectStatus = ref('')
 const inspectFailed = ref(false)
 const inspectBusy = ref(false)

 const SEARCH_ENGINE_URL = 'https://www.bing.com/search?q='
 const shortcuts = [
   { title: '百度', url: 'https://www.baidu.com', color: '#4e6ef2' },
   { title: 'Bing', url: 'https://www.bing.com', color: '#008373' },
   { title: 'GitHub', url: 'https://github.com', color: '#24292f' },
   { title: '哔哩哔哩', url: 'https://www.bilibili.com', color: '#fb7299' },
   { title: '知乎', url: 'https://www.zhihu.com', color: '#1772f6' },
   { title: '掘金', url: 'https://juejin.cn', color: '#1e80ff' }
 ]
 const AVATAR_COLORS = ['#5b8def', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#c678dd', '#d19a66', '#61afef']
 
 const activeTab = computed(() => state.value.tabs.find((tab) => tab.id === state.value.activeTabId) || null)
 const isBlankTab = computed(() => !activeTab.value || !activeTab.value.url || activeTab.value.url === 'about:blank')
 const isSecure = computed(() => /^https:\/\//i.test(activeTab.value?.url || ''))
 const securityIcon = computed(() => {
   if (isBlankTab.value) return 'codicon codicon-globe'
   return isSecure.value ? 'codicon codicon-lock' : 'codicon codicon-unlock'
 })
 const hostLabel = computed(() => {
   const raw = activeTab.value?.url || ''
   try {
     const host = new URL(raw).host
     return host || raw
   } catch {
     return raw
   }
 })
 const statusText = computed(() => {
   if (!activeTab.value) return '就绪'
   if (activeTab.value.loading) return `正在加载 ${hostLabel.value || '页面'} ...`
   if (isBlankTab.value) return '新标签页'
   return `已连接到 ${hostLabel.value}`
 })
 
 // 记录加载失败的 favicon（按标签页 + url 记忆），避免每次刷新状态后重复请求失败图标
 const failedFavicons = new Map()
 function onFaviconError(tabId) {
   const tab = state.value.tabs.find((item) => item.id === tabId)
   if (!tab || !tab.favicon) return
   failedFavicons.set(tabId, { url: tab.url, favicon: tab.favicon })
   state.value = {
     ...state.value,
     tabs: state.value.tabs.map((item) => (item.id === tabId ? { ...item, favicon: null } : item))
   }
 }
 
 function siteColor(url) {
   const text = String(url || '')
   let hash = 0
   for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
   return AVATAR_COLORS[hash % AVATAR_COLORS.length]
 }
 
 function tabLetter(tab) {
   const text = String(tab.title || tab.url || '新标签页').trim()
   const ch = text.replace(/^https?:\/\/(www\.)?/i, '').charAt(0)
   return ch ? ch.toUpperCase() : '新'
 }
 
 function syncAddress() {
   address.value = activeTab.value?.url || ''
 }
 
 function showBrowserError(prefix, error) {
   activity.value = {
     state: 'failed',
     message: `${prefix}：${error?.message || '未知错误'}`,
     targetId: null
   }
 }
 
 function resolveAddress(input) {
   const value = String(input || '').trim()
   if (!value) return ''
   if (/^https?:\/\//i.test(value)) return value
   if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(value)) return value
   if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(value)) return value
   if (/^[^\s/]+\.[^\s/]+(:\d+)?(\/.*)?$/.test(value)) return value
   if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
   return SEARCH_ENGINE_URL + encodeURIComponent(value)
 }
 
 async function refreshState() {
   try {
     await applyState(await window.electronAPI.aiBrowser.getState())
   } catch (error) {
     console.warn('[ai-browser] failed to refresh state:', error)
   }
 }
 
 async function newTab(url) {
   try {
     await window.electronAPI.aiBrowser.newTab(url)
     await refreshState()
   } catch (error) {
     console.error('[ai-browser] failed to create tab:', error)
     showBrowserError('新建标签页失败', error)
   }
 }
 
 async function activate(tabId) {
   try {
     await window.electronAPI.aiBrowser.activateTab(tabId)
     await refreshState()
   } catch (error) {
     console.error('[ai-browser] failed to activate tab:', error)
     showBrowserError('切换标签页失败', error)
   }
 }
 
 async function closeTab(tabId) {
   try {
     await window.electronAPI.aiBrowser.closeTab(tabId)
     await refreshState()
   } catch (error) {
     console.error('[ai-browser] failed to close tab:', error)
     showBrowserError('关闭标签页失败', error)
   }
 }
 
 async function navigateTo(target) {
   if (!activeTab.value) return
   try {
     await window.electronAPI.aiBrowser.navigate(activeTab.value.id, target)
     await refreshState()
   } catch (error) {
     console.error('[ai-browser] navigation failed:', error)
     showBrowserError('页面跳转失败', error)
   }
 }
 
 async function history(action) {
   if (!activeTab.value) return
   try {
     await window.electronAPI.aiBrowser.history(activeTab.value.id, action)
     await refreshState()
   } catch (error) {
     console.error('[ai-browser] history action failed:', error)
     showBrowserError('浏览器操作失败', error)
   }
 }
 
 async function submitOmnibox() {
   const target = resolveAddress(address.value)
   if (!target) return
   newTabQuery.value = ''
   await navigateTo(target)
 }
 
 async function submitNewTabSearch() {
   const target = resolveAddress(newTabQuery.value)
   if (!target) return
   address.value = target
   await navigateTo(target)
 }
 
 async function openShortcut(url) {
   if (activeTab.value && isBlankTab.value) {
     newTabQuery.value = ''
     await navigateTo(url)
   } else {
     await newTab(url)
   }
 }
 
 function focusOmnibox() {
   omniboxRef.value?.focus()
   omniboxRef.value?.select?.()
 }
 
 function onTabAuxClick(event, tabId) {
   if (event.button === 1) {
     event.preventDefault()
     void closeTab(tabId)
   }
 }
 
 function onKeydown(event) {
   const mod = event.ctrlKey || event.metaKey
   const key = event.key.toLowerCase()
   if (mod && key === 'l') {
     event.preventDefault()
     focusOmnibox()
   } else if (mod && key === 't') {
     event.preventDefault()
     void newTab()
   } else if (mod && key === 'w') {
     event.preventDefault()
     if (activeTab.value) void closeTab(activeTab.value.id)
   } else if ((mod && key === 'r') || event.key === 'F5') {
     event.preventDefault()
     if (activeTab.value && !isBlankTab.value) void history('reload')
   } else if (event.altKey && event.key === 'ArrowLeft') {
     event.preventDefault()
     if (activeTab.value) void history('back')
   } else if (event.altKey && event.key === 'ArrowRight') {
     event.preventDefault()
     if (activeTab.value) void history('forward')
   }
}

function onTabStripWheel(event) {
  const el = tabStripRef.value
  if (!el || el.scrollWidth <= el.clientWidth) return
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault()
    el.scrollLeft += event.deltaY
  }
}

 // ============ 元素抓取（AI 浏览器内拾取当前标签页） ============
 let inspectReinjectTimer = null
 let lastInspectTarget = ''
 let removeElementInspectedListener = null
 
 const canPickPage = computed(() => Boolean(activeTab.value && !isBlankTab.value))
 
 function elementTargetKey() {
   return activeTab.value ? `${activeTab.value.id}:${activeTab.value.url || ''}` : ''
 }
 
 async function toggleElementMode(force) {
   const next = typeof force === 'boolean' ? force : !elementMode.value
   elementMode.value = next
   if (!next) {
     await stopPick()
     picked.value = null
     inspectMsg.value = ''
     inspectStatus.value = ''
     return
   }
   picked.value = null
   inspectMsg.value = ''
   inspectStatus.value = ''
   if (canPickPage.value) await startPick()
 }
 
 async function startPick() {
   if (!canPickPage.value || pickActive.value) return
   if (!window.electronAPI?.inspector) {
     inspectStatus.value = '当前环境不支持元素拾取'
     inspectFailed.value = true
     return
   }
   inspectBusy.value = true
   inspectStatus.value = ''
   try {
     const result = await window.electronAPI.inspector.inject()
     if (!result || result.success !== true) {
       const reason = result?.reason || ''
       inspectStatus.value = reason === 'no_active_tab' ? '没有可拾取的标签页'
         : reason === 'no_page' ? '当前标签页没有页面内容'
           : reason === 'no_preview' ? '没有找到可注入的页面'
             : '开启失败：' + reason
       inspectFailed.value = true
       return
     }
     pickActive.value = true
     lastInspectTarget = elementTargetKey()
     inspectStatus.value = '拾取中：在页面上悬停高亮，点击元素抓取'
   } catch (error) {
     inspectStatus.value = '开启失败：' + (error?.message || '未知原因')
     inspectFailed.value = true
   } finally {
     inspectBusy.value = false
   }
 }
 
 async function stopPick() {
   clearTimeout(inspectReinjectTimer)
   if (pickActive.value) {
     try {
       await window.electronAPI?.inspector?.remove?.()
     } catch { /* ignore */ }
     pickActive.value = false
   }
   lastInspectTarget = ''
 }
 
 function selectInspectedElement(data) {
   if (!data || data.type !== 'loopra-element-click') return
   if (!elementMode.value) return
   const vue = data.vueComponent || {}
   picked.value = {
     name: vue.name || '原生元素（无 Vue 组件包裹）',
     tag: data.tag || '?',
     text: data.text || '',
     selector: data.selector || '',
     attrs: Array.isArray(data.attrs) ? data.attrs : [],
     file: vue.file || '',
     path: Array.isArray(data.path) ? data.path : []
   }
   const label = picked.value.selector || picked.value.text || `${picked.value.tag} 元素`
   inspectMsg.value = `页面元素：${label}`
   inspectStatus.value = ''
 }
 
 async function sendPicked() {
   const sel = picked.value
   if (!sel || !inspectMsg.value.trim()) return
   const payload = {
     message: inspectMsg.value.trim(),
     component: {
       name: sel.name,
       tag: sel.tag,
       text: sel.text,
       selector: sel.selector,
       attrs: sel.attrs,
       file: sel.file,
       path: sel.path
     }
   }
   try {
     await window.electronAPI.aiBrowser.sendElement(payload)
     inspectStatus.value = '已发送到当前会话'
     inspectFailed.value = false
     picked.value = null
     inspectMsg.value = ''
   } catch (error) {
     inspectStatus.value = '发送失败：' + (error?.message || '未知原因')
     inspectFailed.value = true
   }
 }
 
 watch([() => state.value.activeTabId, () => activeTab.value?.url], () => {
   if (!elementMode.value || !pickActive.value) return
   clearTimeout(inspectReinjectTimer)
   if (!canPickPage.value) {
     void stopPick()
     return
   }
   const key = elementTargetKey()
   if (key !== lastInspectTarget) {
     inspectReinjectTimer = setTimeout(() => {
       pickActive.value = false
       void startPick()
     }, 350)
   }
 })
let removeStateListener = null
 let removeActivityListener = null
 let resizeObserver = null
 let boundsFrame = 0
 
 function scheduleNativeView() {
   cancelAnimationFrame(boundsFrame)
   boundsFrame = requestAnimationFrame(async () => {
     const host = nativeHostRef.value
     if (!host || !window.electronAPI?.aiBrowser) return
     // 新标签页/空白页：隐藏原生视图，展示内置的新标签页 UI
     if (!activeTab.value || isBlankTab.value) {
       try {
         await window.electronAPI.aiBrowser.hideView()
       } catch (error) {
         console.warn('[ai-browser] failed to hide page view:', error)
       }
       return
     }
     const rect = host.getBoundingClientRect()
     if (rect.width < 1 || rect.height < 1) return
     try {
       await window.electronAPI.aiBrowser.showView(activeTab.value.id, {
         x: rect.x,
         y: rect.y,
         width: rect.width,
         height: rect.height
       })
     } catch (error) {
       console.warn('[ai-browser] failed to show page view:', error)
     }
   })
 }
 
 async function applyState(nextState) {
   const nextTabs = (Array.isArray(nextState?.tabs) ? nextState.tabs : []).map((tab) => {
     if (!tab) return tab
     const failure = failedFavicons.get(tab.id)
     if (failure && failure.url === tab.url) {
       if (tab.favicon && failure.favicon === tab.favicon) return { ...tab, favicon: null }
     } else {
       failedFavicons.delete(tab.id)
     }
     return { ...tab }
   })
   state.value = {
     activeTabId: nextState?.activeTabId || null,
     tabs: nextTabs
   }
  syncAddress()
  await nextTick()
  tabStripRef.value?.querySelector('.ai-browser-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  scheduleNativeView()
   if (isBlankTab.value && newTabInputRef.value) {
     const focused = document.activeElement
     if (!focused || !['INPUT', 'TEXTAREA'].includes(focused.tagName)) newTabInputRef.value.focus()
   }
 }
 
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  tabStripRef.value?.addEventListener('wheel', onTabStripWheel, { passive: false })
  removeStateListener = window.electronAPI.events.listen('ai-browser-state', applyState)
  removeElementInspectedListener = window.electronAPI.events.listen('element-inspected', selectInspectedElement)
   removeActivityListener = window.electronAPI.events.listen('ai-browser-activity', (nextActivity) => {
     activity.value = nextActivity || { state: 'idle', message: '等待 AI 操作', targetId: null }
   })
   try {
     const initialState = await window.electronAPI.aiBrowser.getState()
     await applyState(initialState)
   } catch (error) {
     showBrowserError('浏览器初始化失败', error)
   }
   resizeObserver = new ResizeObserver(scheduleNativeView)
   if (nativeHostRef.value) resizeObserver.observe(nativeHostRef.value)
 })
 
onBeforeUnmount(() => {
  cancelAnimationFrame(boundsFrame)
  window.removeEventListener('keydown', onKeydown)
  tabStripRef.value?.removeEventListener('wheel', onTabStripWheel)
  resizeObserver?.disconnect()
   removeStateListener?.()
  removeElementInspectedListener?.()
  clearTimeout(inspectReinjectTimer)
  void stopPick()
   removeActivityListener?.()
   window.electronAPI?.aiBrowser?.hideView?.()
 })
 </script>
 
 <style scoped>
 .ai-browser-shell {
   height: 100vh;
   display: flex;
   flex-direction: column;
   color: var(--fg);
   background: var(--bg);
   overflow: hidden;
 }
 
 /* ---------- 标签栏 ---------- */
 .ai-browser-tabstrip {
   position: relative;
   z-index: 2;
   display: flex;
   align-items: flex-end;
   gap: 8px;
   padding: 7px 10px 0;
   background: var(--bg-2);
 }
 .ai-browser-tabstrip::after {
   content: '';
   position: absolute;
   left: 0;
   right: 0;
   bottom: 0;
   height: 1px;
   background: var(--border);
   pointer-events: none;
 }
.ai-browser-tabs {
  flex: 0 1 auto;
  min-width: 0;
  max-width: calc(100% - 46px);
  display: flex;
  align-items: flex-end;
  overflow-x: auto;
  scrollbar-width: none;
}
.ai-browser-tabs::-webkit-scrollbar { display: none; }

.ai-browser-tab {
  position: relative;
  z-index: 1;
  flex: 0 1 220px;
  min-width: 108px;
  height: 34px;
   display: flex;
   align-items: center;
   gap: 7px;
   padding: 0 6px 0 12px;
   border: 0;
   border-radius: 9px 9px 0 0;
   background: transparent;
   color: var(--fg-4);
   cursor: pointer;
   font: inherit;
 }
 .ai-browser-tab:hover { background: var(--bg-3); color: var(--fg-2); }
 .ai-browser-tab.active { background: var(--bg); color: var(--fg); }
 
 .ai-browser-tab-icon {
   width: 16px;
   height: 16px;
   flex-shrink: 0;
   display: grid;
   place-items: center;
 }
 .ai-browser-favicon-img {
   width: 16px;
   height: 16px;
   border-radius: 3px;
   object-fit: contain;
 }
 .ai-browser-favicon {
   width: 16px;
   height: 16px;
   display: grid;
   place-items: center;
   border-radius: 50%;
   color: #fff;
   font-size: 9px;
   font-weight: 700;
   line-height: 1;
 }
 .ai-browser-spinner {
   width: 12px;
   height: 12px;
   border: 2px solid var(--border);
   border-top-color: var(--accent);
   border-radius: 50%;
   animation: ai-browser-spin 0.8s linear infinite;
 }
 .ai-browser-tab-title {
   flex: 1;
   min-width: 0;
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
   font-size: 12px;
   text-align: left;
 }
 .ai-browser-tab-close {
   width: 18px;
   height: 18px;
   flex-shrink: 0;
   display: none;
   place-items: center;
   border-radius: 5px;
   color: var(--fg-4);
   cursor: pointer;
 }
 .ai-browser-tab-close i { font-size: 14px; }
 .ai-browser-tab:hover .ai-browser-tab-close,
 .ai-browser-tab.active .ai-browser-tab-close { display: grid; }
 .ai-browser-tab-close:hover { background: var(--bg-3); color: var(--fg); }
 
.ai-browser-new-tab {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  margin: 0 0 2px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-3);
  cursor: pointer;
}
.ai-browser-new-tab:hover { background: var(--bg-3); color: var(--fg); }
.ai-browser-new-tab i { font-size: 16px; }

/* ---------- 工具栏 ---------- */
 .ai-browser-toolbar {
   display: grid;
   grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
   align-items: center;
   gap: 12px;
   padding: 6px 14px 7px 8px;
   background: var(--bg);
 }
 .ai-browser-toolbar-left { display: flex; gap: 2px; justify-self: start; }
 .ai-browser-toolbar-right { justify-self: end; min-width: 0; }
 
 .ai-browser-icon-button {
   width: 28px;
   height: 28px;
   display: inline-grid;
   place-items: center;
   border: 0;
   border-radius: 7px;
   background: transparent;
   color: var(--fg-3);
   cursor: pointer;
   font-size: 16px;
   line-height: 1;
 }
 .ai-browser-icon-button i { font-size: 17px; }
 .ai-browser-icon-button:hover:not(:disabled) { background: var(--bg-3); color: var(--fg); }
 .ai-browser-icon-button:disabled { opacity: 0.35; cursor: default; }
 
 .ai-browser-omnibox {
   width: min(620px, 42vw);
   min-width: 220px;
   height: 32px;
   display: flex;
   align-items: center;
   gap: 6px;
   padding: 0 6px 0 11px;
   border: 1px solid var(--border);
   border-radius: 999px;
   background: var(--bg-2);
   transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
 }
 .ai-browser-omnibox:focus-within {
   background: var(--bg);
   border-color: var(--accent);
   box-shadow: 0 0 0 2px var(--accent-bg);
 }
 .ai-browser-omnibox-icon {
   flex-shrink: 0;
   display: grid;
   place-items: center;
   color: var(--fg-4);
 }
 .ai-browser-omnibox-icon i { font-size: 14px; }
 .ai-browser-omnibox-icon.secure { color: var(--accent); }
 .ai-browser-address {
   flex: 1;
   min-width: 0;
   border: 0;
   outline: 0;
   background: transparent;
   color: var(--fg);
   font: inherit;
   font-size: 13px;
 }
 .ai-browser-address::placeholder { color: var(--fg-4); }
 .ai-browser-omnibox-spinner {
   width: 22px;
   height: 22px;
   flex-shrink: 0;
   display: grid;
   place-items: center;
 }
 .ai-browser-omnibox-action { width: 24px; height: 24px; }
 .ai-browser-omnibox-action i { font-size: 15px; }
 
 .ai-browser-activity {
   max-width: 260px;
   display: flex;
   align-items: center;
   gap: 6px;
   padding: 3px 9px 3px 8px;
   border-radius: 999px;
   background: var(--bg-2);
   color: var(--fg-3);
   font-size: 11px;
 }
 .ai-browser-activity-message {
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
 }
 .ai-browser-activity-dot {
   width: 7px;
   height: 7px;
   flex-shrink: 0;
   border-radius: 50%;
   background: var(--fg-4);
 }
 .ai-browser-activity.running .ai-browser-activity-dot {
   background: #0d9488;
   box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.15);
   animation: ai-browser-pulse 1s ease-in-out infinite;
 }
 .ai-browser-activity.completed .ai-browser-activity-dot { background: #16a34a; }
 .ai-browser-activity.failed { color: #dc2626; }
 .ai-browser-activity.failed .ai-browser-activity-dot { background: #dc2626; }
 
 /* ---------- 内容区 / 新标签页 ---------- */
 .ai-browser-content {
   position: relative;
   flex: 1;
   min-height: 0;
   background: linear-gradient(180deg, var(--bg-2), var(--bg) 220px);
   overflow: hidden;
 }
 .ai-browser-blank {
   height: 100%;
   display: grid;
   place-items: center;
   overflow: auto;
   padding: 24px 16px 40px;
 }
 .ai-browser-blank-inner {
   width: min(620px, 100%);
   display: flex;
   flex-direction: column;
   align-items: center;
   gap: 18px;
   text-align: center;
 }
 .ai-browser-newtab-logo {
   width: 64px;
   height: 64px;
   display: grid;
   place-items: center;
   border-radius: 20px;
   background: var(--accent);
   color: #fff;
   font-size: 24px;
   font-weight: 800;
   box-shadow: 0 10px 26px -8px var(--accent);
 }
 .ai-browser-blank-title { color: var(--fg-3); font-size: 14px; }
 .ai-browser-newtab-title {
   color: var(--fg);
   font-size: 22px;
   font-weight: 600;
 }
 
 .ai-browser-newtab-search {
   width: 100%;
   max-width: 560px;
   height: 44px;
   display: flex;
   align-items: center;
   gap: 8px;
   padding: 0 8px 0 16px;
   border: 1px solid var(--border);
   border-radius: 999px;
   background: var(--bg);
   box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
   transition: border-color 0.15s, box-shadow 0.15s;
 }
 .ai-browser-newtab-search:focus-within {
   border-color: var(--accent);
   box-shadow: 0 0 0 3px var(--accent-bg);
 }
 .ai-browser-newtab-search > .codicon-search { color: var(--fg-4); font-size: 15px; }
 .ai-browser-newtab-input {
   flex: 1;
   min-width: 0;
   border: 0;
   outline: 0;
   background: transparent;
   color: var(--fg);
   font: inherit;
   font-size: 14px;
 }
 .ai-browser-newtab-input::placeholder { color: var(--fg-4); }
 .ai-browser-newtab-go {
   width: 28px;
   height: 28px;
   flex-shrink: 0;
   display: grid;
   place-items: center;
   border: 0;
   border-radius: 50%;
   background: var(--accent);
   color: #fff;
   cursor: pointer;
 }
 .ai-browser-newtab-go i { font-size: 15px; }
 .ai-browser-newtab-go:hover { filter: brightness(1.08); }
 
 .ai-browser-shortcuts {
   width: 100%;
   display: flex;
   justify-content: center;
   flex-wrap: wrap;
   gap: 6px 16px;
   margin-top: 4px;
 }
 .ai-browser-shortcut {
   width: 88px;
   display: flex;
   flex-direction: column;
   align-items: center;
   gap: 8px;
   padding: 8px 4px;
   border: 0;
   border-radius: 12px;
   background: transparent;
   color: var(--fg-3);
   cursor: pointer;
   font: inherit;
 }
 .ai-browser-shortcut:hover { background: var(--bg-2); color: var(--fg); }
 .ai-browser-shortcut-icon {
   width: 40px;
   height: 40px;
   display: grid;
   place-items: center;
   border-radius: 50%;
   color: #fff;
   font-size: 15px;
   font-weight: 600;
   box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
 }
 .ai-browser-shortcut-name {
   max-width: 100%;
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
   font-size: 12px;
 }
 .ai-browser-blank-hint { color: var(--fg-4); font-size: 12px; }
 .ai-browser-primary {
   padding: 8px 16px;
   border: 0;
   border-radius: 8px;
   background: var(--accent-btn);
   color: #fff;
   cursor: pointer;
   font: inherit;
   font-size: 13px;
 }
 
 /* ---------- 状态栏 ---------- */
 .ai-browser-status {
   height: 25px;
   flex-shrink: 0;
   display: flex;
   align-items: center;
   justify-content: space-between;
   gap: 12px;
   padding: 0 14px;
   border-top: 1px solid var(--border);
   background: var(--bg);
   color: var(--fg-4);
   font-size: 11px;
 }
 .ai-browser-status-left,
 .ai-browser-status-right {
   display: flex;
   align-items: center;
   gap: 6px;
   min-width: 0;
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
 }
 .ai-browser-status-text { overflow: hidden; text-overflow: ellipsis; }
 .ai-browser-status-right { color: var(--fg-3); flex-shrink: 0; }
 .ai-browser-status-spinner {
   width: 10px;
   height: 10px;
   flex-shrink: 0;
   border: 1.5px solid var(--border);
   border-top-color: var(--accent);
   border-radius: 50%;
   animation: ai-browser-spin 0.8s linear infinite;
 }
 
 @keyframes ai-browser-spin { to { transform: rotate(360deg); } }
 @keyframes ai-browser-pulse { 50% { opacity: 0.45; transform: scale(0.8); } }
 
 /* ---------- 元素抓取 ---------- */
 .ai-browser-content { display: flex; }
 .ai-browser-stage { flex: 1; min-width: 0; display: flex; align-items: stretch; }
 .ai-browser-stage.with-inspector .ai-browser-viewport { border-right: 1px solid var(--border); }
 .ai-browser-viewport { position: relative; flex: 1; min-width: 0; overflow: hidden; }
 .ai-browser-icon-button.active { background: var(--accent-bg); color: var(--accent); }
 
 .ai-browser-inspector {
   width: 330px;
   flex-shrink: 0;
   display: flex;
   flex-direction: column;
   min-height: 0;
   background: var(--bg);
   color: var(--fg);
   overflow: hidden;
 }
 .ai-inspector-head {
   display: flex;
   align-items: center;
   gap: 8px;
   padding: 8px 10px;
   border-bottom: 1px solid var(--border);
 }
 .ai-inspector-title {
   display: flex;
   align-items: center;
   gap: 6px;
   font-size: 13px;
   font-weight: 600;
 }
 .ai-inspector-title i { color: var(--accent); font-size: 15px; }
 .ai-inspector-state {
   display: flex;
   align-items: center;
   gap: 4px;
   margin-left: auto;
   padding: 2px 8px;
   border-radius: 999px;
   background: rgba(13, 148, 136, 0.12);
   color: #0d9488;
   font-size: 11px;
 }
 .ai-inspector-state i { font-size: 12px; }
 .ai-inspector-close {
   width: 24px;
   height: 24px;
   display: grid;
   place-items: center;
   border: 0;
   border-radius: 6px;
   background: transparent;
   color: var(--fg-4);
   cursor: pointer;
 }
 .ai-inspector-close:hover { background: var(--bg-3); color: var(--fg); }
 .ai-inspector-close i { font-size: 14px; }
 
 .ai-inspector-actions { display: flex; align-items: center; gap: 10px; padding: 10px 10px 4px; }
 .ai-inspector-btn {
   display: inline-flex;
   align-items: center;
   gap: 6px;
   padding: 6px 12px;
   border: 1px solid var(--border);
   border-radius: 7px;
   background: var(--bg-2);
   color: var(--fg);
   cursor: pointer;
   font: inherit;
   font-size: 12px;
 }
 .ai-inspector-btn.primary { background: var(--accent-btn); border-color: transparent; color: #fff; }
 .ai-inspector-btn:disabled { opacity: 0.5; cursor: default; }
 .ai-inspector-btn i { font-size: 13px; }
 .ai-inspector-warn { color: var(--fg-4); font-size: 11px; }
 .ai-inspector-status { padding: 4px 12px; color: var(--fg-3); font-size: 11px; }
 .ai-inspector-status.error { color: #dc2626; }
 .ai-inspector-empty {
   flex: 1;
   display: flex;
   flex-direction: column;
   align-items: center;
   justify-content: center;
   gap: 10px;
   color: var(--fg-4);
   font-size: 12px;
   text-align: center;
   padding: 0 20px;
 }
 .ai-inspector-empty i { font-size: 30px; color: var(--fg-4); opacity: 0.6; }
 
 .ai-inspector-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 8px 10px 12px; overflow: auto; }
 .ai-inspector-fields { display: flex; flex-direction: column; gap: 6px; }
 .ai-inspector-row { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.5; }
 .ai-inspector-row label { flex-shrink: 0; width: 56px; color: var(--fg-4); }
 .ai-inspector-row span { flex: 1; min-width: 0; word-break: break-all; }
 .ai-inspector-row code { flex: 1; min-width: 0; color: var(--accent); word-break: break-all; font-size: 11px; }
 .ai-inspector-attrs { flex: 1; display: flex; flex-wrap: wrap; gap: 4px; }
 .ai-inspector-attr { padding: 1px 6px; border-radius: 4px; background: var(--bg-2); color: var(--fg-3); font-size: 10px; }
 .ai-inspector-msg {
   width: 100%;
   padding: 7px 9px;
   border: 1px solid var(--border);
   border-radius: 7px;
   background: var(--bg-2);
   color: var(--fg);
   font: inherit;
   font-size: 12px;
   resize: none;
   outline: 0;
 }
 .ai-inspector-msg:focus { border-color: var(--accent); }
 .ai-inspector-send {
   display: inline-flex;
   align-items: center;
   justify-content: center;
   gap: 6px;
   padding: 7px 0;
   border: 0;
   border-radius: 7px;
   background: var(--accent-btn);
   color: #fff;
   cursor: pointer;
   font: inherit;
   font-size: 12px;
 }
 .ai-inspector-send:disabled { opacity: 0.5; cursor: default; }
 .ai-inspector-send i { font-size: 13px; }
 
@media (max-width: 860px) {
  .ai-browser-omnibox { width: min(620px, 60vw); }
  .ai-browser-activity { max-width: 150px; }
}
@media (max-width: 640px) {
  .ai-browser-activity-message { max-width: 90px; }
  .ai-browser-tab { flex-basis: 170px; min-width: 96px; }
  .ai-browser-status-right { display: none; }
}
 </style>
