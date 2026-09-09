<template>
  <main
    class="desktop-popup-root"
    :class="{ dimmed: isDimmed, 'is-menu': isMenu }"
    :data-theme="theme"
    tabindex="-1"
    @mousedown.self="closePopup"
  >
    <section
      v-if="type === 'explore'"
      class="desktop-popup-menu desktop-popup-explore-menu"
      :style="menuStyle"
      role="menu"
      aria-label="探索"
      @mousedown.stop
      @contextmenu.prevent
    >
      <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="send('open-sub-agents')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A4 4 0 0 1 21 18v1"/></svg>
        <span>子代理</span>
      </button>
      <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="send('open-tools')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        <span>工具</span>
      </button>
      <ServiceProcessManager placement="bottom" :show-label="true" />
    </section>

    <section
      v-else-if="type === 'home-context'"
      class="desktop-popup-menu desktop-popup-context-menu"
      :style="menuStyle"
      role="menu"
      aria-label="首页菜单"
      @mousedown.stop
      @contextmenu.prevent
    >
      <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendShellAction('open-requirement-board')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
        <span>需求池</span>
      </button>
      <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendShellAction('open-onboarding')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4V2M15 10V8M11.5 5.5H9.5M20.5 5.5H18.5M17.99 8.5 19.5 10M12.01 8.5 10.5 10"/><path d="m3 21 8-8"/></svg>
        <span>引导</span>
      </button>
      <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendShellAction('open-update')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>更新</span>
      </button>
      <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendShellAction('toggle-theme')">
        <svg v-if="theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.2 14.1A8.5 8.5 0 1 1 9.9 3.8 8.5 8.5 0 0 0 20.2 14.1Z"/></svg>
        <span>{{ theme === 'dark' ? '浅色' : '暗色' }}</span>
      </button>
    </section>

    <section
      v-else-if="type === 'tab-context'"
      class="desktop-popup-menu desktop-popup-context-menu"
      :style="menuStyle"
      role="menu"
      aria-label="会话操作菜单"
      @mousedown.stop
      @contextmenu.prevent
    >
      <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendShellAction('reload')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0 2 5"/><path d="M20 4v7h-7"/></svg>
        <span>刷新</span>
      </button>
      <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendShellAction('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
        <span>关闭</span>
      </button>
      <button class="desktop-popup-menu-item" type="button" role="menuitem" :disabled="!context.canCloseLeft" @click="sendShellAction('close-left')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5v14M9 8h10M9 12h7M9 16h10"/></svg>
        <span>关闭上方会话</span>
      </button>
      <button class="desktop-popup-menu-item" type="button" role="menuitem" :disabled="!context.canCloseRight" @click="sendShellAction('close-right')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 5v14M5 8h10M8 12h7M5 16h10"/></svg>
        <span>关闭下方会话</span>
      </button>
    </section>

    <section
      v-else-if="type === 'context-menu'"
      class="desktop-popup-menu desktop-popup-context-menu"
      :style="menuStyle"
      role="menu"
      :aria-label="context.menuType === 'session' ? '会话菜单' : '项目菜单'"
      @mousedown.stop
      @contextmenu.prevent
    >
      <template v-if="context.menuType === 'session'">
        <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendContextAction('rename-session')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          <span>重命名会话</span>
        </button>
        <button class="desktop-popup-menu-item danger" type="button" role="menuitem" @click="sendContextAction('delete-session')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
          <span>删除会话</span>
        </button>
      </template>
      <template v-else>
        <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendContextAction('copy-workspace-path')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>
          <span>复制项目路径</span>
        </button>
        <div class="desktop-popup-divider"></div>
        <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendContextAction('clear-workspace')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
          <span>清空会话</span>
        </button>
        <button class="desktop-popup-menu-item" type="button" role="menuitem" @click="sendContextAction('clear-old-sessions')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          <span>清空三天前的会话</span>
        </button>
        <div class="desktop-popup-divider"></div>
        <button class="desktop-popup-menu-item danger" type="button" role="menuitem" @click="sendContextAction('delete-workspace')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
          <span>删除项目</span>
        </button>
      </template>
    </section>

    <section v-else-if="type === 'rename-session'" class="desktop-popup-dialog desktop-popup-rename-dialog" role="dialog" aria-modal="true" aria-label="重命名会话" @mousedown.stop>
      <h3>重命名会话</h3>
      <input
        ref="renameInput"
        v-model="renameValue"
        type="text"
        maxlength="100"
        placeholder="输入新的会话名称"
        autofocus
        @keydown.enter="sendRename"
        @keydown.esc="closePopup"
      />
      <div class="desktop-popup-dialog-actions">
        <button type="button" class="desktop-popup-cancel" @click="closePopup">取消</button>
        <button type="button" class="desktop-popup-primary" :disabled="!renameValue.trim()" @click="sendRename">确定</button>
      </div>
    </section>

    <section v-else-if="type === 'confirm'" class="desktop-popup-dialog desktop-popup-confirm-dialog" role="alertdialog" aria-modal="true" aria-label="确认操作" @mousedown.stop>
      <div class="desktop-popup-confirm-heading">
        <div class="desktop-popup-confirm-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div class="desktop-popup-confirm-title">{{ context.title }}</div>
      </div>
      <p class="desktop-popup-confirm-copy">{{ context.message }}</p>
      <div class="desktop-popup-dialog-actions" :style="{ '--action-count': Math.max(1, context.actions?.length || 0) }">
        <button
          v-for="action in context.actions || []"
          :key="action.key"
          type="button"
          class="desktop-popup-confirm-button"
          :class="{ danger: action.variant === 'danger' }"
          :disabled="action.disabled"
          @click="sendConfirm(action.key)"
        >
          {{ action.label }}
        </button>
      </div>
    </section>
  </main>
</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import ServiceProcessManager from './components/ServiceProcessManager.vue'
import {toPlainIpcValue} from './utils/ipcPayload'

const page = new URLSearchParams(window.location.search)
const type = ref(page.get('popupType') || '')
const theme = ref(page.get('theme') === 'dark' ? 'dark' : 'gray')
const context = ref({type: type.value, theme: theme.value})
const renameValue = ref('')
const renameInput = ref(null)
let stopContextListener = null

function waitForPaint(frames = 2) {
  return new Promise((resolve) => {
    let remaining = Math.max(1, frames)
    let settled = false
    let fallbackTimer = null
    const finish = () => {
      if (settled) return
      settled = true
      if (fallbackTimer) clearTimeout(fallbackTimer)
      resolve()
    }
    const tick = () => {
      if (settled) return
      remaining -= 1
      if (remaining <= 0) {
        finish()
        return
      }
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(tick)
      else setTimeout(tick, 0)
    }
    // 隐藏的 WebContentsView 在部分 Electron 版本中可能暂停 RAF；超时只作兜底。
    fallbackTimer = setTimeout(finish, 150)
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(tick)
    else setTimeout(tick, 0)
  })
}

const isMenu = computed(() => ['explore', 'home-context', 'tab-context', 'context-menu'].includes(type.value))
const isDimmed = computed(() => !isMenu.value)
const menuStyle = computed(() => ({
  left: `${Math.max(8, Number(context.value.x) || 8)}px`,
  top: `${Math.max(8, Number(context.value.y) || 8)}px`
}))

async function applyContext(payload = {}) {
  const incoming = payload && typeof payload === 'object' ? payload : {}
  const requestId = Number(incoming.__desktopPopupRequestId)
  const next = {...incoming}
  delete next.__desktopPopupRequestId
  type.value = String(next.type || type.value || '')
  theme.value = next.theme === 'dark' ? 'dark' : 'gray'
  context.value = {...next, type: type.value, theme: theme.value}
  if (type.value === 'rename-session') renameValue.value = String(next.value || '')
  await nextTick()
  if (type.value === 'rename-session') renameInput.value?.focus()
  await waitForPaint()
  if (Number.isSafeInteger(requestId)) {
    window.electronAPI?.desktopPopup?.contextReady?.(requestId)
  }
}

function closePopup() {
  const popup = window.electronAPI?.desktopPopup
  if (popup?.closeEvent) {
    popup.closeEvent()
    return
  }
  void popup?.close?.()
}

function sendPopupAction(payload) {
  const popup = window.electronAPI?.desktopPopup
  const ipcPayload = toPlainIpcValue(payload)
  if (popup?.actionEvent) {
    try {
      popup.actionEvent(ipcPayload)
      return
    } catch (error) {
      console.warn('[desktop-popup] failed to send action event, falling back to invoke:', error)
    }
  }
  const action = popup?.action
  if (!action) {
    console.warn('[desktop-popup] action API is unavailable')
    return
  }
  void Promise.resolve(action(ipcPayload)).then((response) => {
    if (response?.success === false) console.warn('[desktop-popup] action was rejected', ipcPayload)
  }).catch((error) => {
    console.warn('[desktop-popup] failed to send action:', error)
  })
}

function send(action) {
  sendPopupAction({type: 'explore', action})
}

function sendShellAction(action) {
  sendPopupAction({
    type: type.value,
    action,
    tabId: context.value.tabId
  })
}

function sendContextAction(action) {
  sendPopupAction({
    type: 'context-menu',
    menuType: context.value.menuType,
    action,
    item: context.value.item
  })
}

function sendRename() {
  if (!renameValue.value.trim()) return
  sendPopupAction({
    type: 'rename-session',
    action: 'confirm',
    value: renameValue.value,
    item: context.value.item
  })
}

function sendConfirm(action) {
  sendPopupAction({
    type: 'confirm',
    action,
    kind: context.value.kind,
    payload: context.value.payload
  })
}

function onWindowKeydown(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closePopup()
}

watch(() => [type.value, context.value.value], ([nextType]) => {
  if (nextType === 'rename-session') nextTick(() => renameInput.value?.focus())
})

onMounted(() => {
  stopContextListener = window.electronAPI?.events?.listen('desktop-popup-context', applyContext)
  window.addEventListener('keydown', onWindowKeydown)
  window.electronAPI?.desktopPopup?.ready?.()
  nextTick(() => {
    if (type.value === 'rename-session') renameInput.value?.focus()
  })
})

onBeforeUnmount(() => {
  stopContextListener?.()
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<style>
.desktop-popup-root {
  position: fixed;
  inset: 0;
  z-index: 1;
  box-sizing: border-box;
  outline: 0;
  color: var(--desktop-ink, var(--fg, #27272a));
  -webkit-font-smoothing: antialiased;
}
.desktop-popup-root.dimmed {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(22, 24, 27, .24);
}
.desktop-popup-root[data-theme="dark"] { color-scheme: dark; }
.desktop-popup-menu {
  position: absolute;
  width: 220px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow: auto;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--desktop-line, var(--border, #e5e7eb));
  border-radius: 15px;
  background: var(--desktop-paper, var(--bg, #fff));
  color: var(--desktop-ink, var(--fg, #27272a));
  box-shadow: 0 16px 38px rgba(0, 0, 0, .18), 0 3px 10px rgba(0, 0, 0, .08);
}
.desktop-popup-context-menu { width: 210px; }
.desktop-popup-explore-menu { overflow: visible; }
.desktop-popup-menu-item {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.desktop-popup-menu-item:hover,
.desktop-popup-menu-item:focus-visible { background: var(--desktop-hover, var(--bg-3, #f2f3f5)); outline: 0; }
.desktop-popup-menu-item:disabled { cursor: default; opacity: .45; }
.desktop-popup-menu-item:disabled:hover { background: transparent; }
.desktop-popup-menu-item.danger { color: var(--red, #c2413a); }
.desktop-popup-menu-item svg { width: 16px; height: 16px; flex: 0 0 auto; }
.desktop-popup-menu-item > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desktop-popup-divider { height: 1px; margin: 7px 4px; background: var(--desktop-line, var(--border, #e5e7eb)); }
.desktop-popup-dialog {
  width: min(460px, 100%);
  box-sizing: border-box;
  padding: 22px;
  border: 1px solid var(--desktop-line, var(--border, #e5e7eb));
  border-radius: 16px;
  background: var(--desktop-paper, var(--bg, #fff));
  color: var(--desktop-ink, var(--fg, #27272a));
  box-shadow: 0 18px 46px rgba(0, 0, 0, .25);
}
.desktop-popup-rename-dialog { width: min(420px, 100%); }
.desktop-popup-dialog h3 { margin: 0 0 16px; font-size: 16px; font-weight: 650; }
.desktop-popup-dialog input {
  width: 100%;
  min-height: 38px;
  box-sizing: border-box;
  padding: 0 11px;
  border: 1px solid var(--desktop-line, var(--border, #e5e7eb));
  border-radius: 9px;
  outline: 0;
  background: var(--desktop-sidebar, var(--bg-2, #f7f7f6));
  color: inherit;
  font: inherit;
  font-size: 14px;
}
.desktop-popup-dialog input:focus { border-color: var(--desktop-muted, var(--fg-3, #8d8d89)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--desktop-muted, #999) 18%, transparent); }
.desktop-popup-dialog-actions {
  display: grid;
  grid-template-columns: repeat(var(--action-count, 2), minmax(0, 1fr));
  gap: 8px;
  margin-top: 18px;
}
.desktop-popup-dialog-actions button {
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--desktop-line, var(--border, #e5e7eb));
  border-radius: 9px;
  background: var(--desktop-sidebar, var(--bg-2, #f7f7f6));
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.desktop-popup-dialog-actions button:hover:not(:disabled) { background: var(--desktop-hover, var(--bg-3, #f2f3f5)); }
.desktop-popup-dialog-actions button:disabled { cursor: not-allowed; opacity: .5; }
.desktop-popup-dialog-actions .desktop-popup-primary { border-color: color-mix(in srgb, var(--accent, #2563eb) 38%, var(--desktop-line, #e5e7eb)); color: var(--accent, #2563eb); }
.desktop-popup-confirm-dialog { width: min(460px, 100%); }
.desktop-popup-confirm-heading { display: flex; align-items: center; gap: 10px; }
.desktop-popup-confirm-icon { display: inline-grid; width: 34px; height: 34px; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--yellow, #ca8a04) 16%, transparent); color: var(--yellow, #ca8a04); }
.desktop-popup-confirm-title { color: inherit; font-size: 16px; font-weight: 700; }
.desktop-popup-confirm-copy { margin: 7px 0 20px; color: var(--desktop-muted, var(--fg-3, #71717a)); font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
.desktop-popup-confirm-button.danger { border-color: color-mix(in srgb, var(--red, #c2413a) 38%, var(--desktop-line, #e5e7eb)); background: color-mix(in srgb, var(--red, #c2413a) 9%, var(--desktop-paper, #fff)); color: var(--red, #c2413a); }
.desktop-popup-confirm-button.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--red, #c2413a) 14%, var(--desktop-paper, #fff)); }
@media (max-width: 640px) {
  .desktop-popup-dialog-actions { grid-template-columns: 1fr; }
}
</style>
