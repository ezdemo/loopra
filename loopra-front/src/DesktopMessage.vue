<template>
  <div
    v-if="message"
    class="desktop-message-root"
    :data-theme="message.theme"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <Transition name="desktop-message-fade" appear>
      <div :key="message.id" class="desktop-message-toast" :class="`is-${message.type}`">
        <span class="desktop-message-icon" aria-hidden="true">
          <svg v-if="message.type === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 12 4.5 4.5L19 7"/></svg>
          <svg v-else-if="message.type === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>
          <svg v-else-if="message.type === 'warning'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m12 3 9 17H3L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg>
          <svg v-else-if="message.type === 'loading'" class="desktop-message-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/></svg>
        </span>
        <span class="desktop-message-text">{{ message.content }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import {nextTick, onBeforeUnmount, onMounted, ref} from 'vue'

const message = ref(null)
let nextId = 0
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
    fallbackTimer = setTimeout(finish, 150)
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(tick)
    else setTimeout(tick, 0)
  })
}

async function applyContext(context = {}) {
  const requestId = Number(context.__desktopMessageRequestId)
  const next = {
    id: ++nextId,
    type: ['success', 'error', 'warning', 'info', 'loading'].includes(context.type) ? context.type : 'info',
    content: String(context.content || ''),
    theme: context.theme === 'dark' ? 'dark' : 'gray'
  }
  message.value = next
  await nextTick()
  await waitForPaint()
  if (Number.isSafeInteger(requestId)) window.electronAPI?.desktopMessage?.contextReady?.(requestId)
}

onMounted(() => {
  stopContextListener = window.electronAPI?.events?.listen('desktop-message-context', applyContext)
  window.electronAPI?.desktopMessage?.ready?.()
})

onBeforeUnmount(() => {
  stopContextListener?.()
})
</script>

<style scoped>
.desktop-message-root {
  position: fixed;
  z-index: 2147483647;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12px 16px 0;
  box-sizing: border-box;
  pointer-events: none;
  color: var(--desktop-ink, #343432);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.desktop-message-root[data-theme="dark"] {
  --desktop-message-bg: #30302e;
  --desktop-message-border: #4b4b47;
  --desktop-message-text: #f3f3ef;
  --desktop-message-shadow: rgba(0, 0, 0, .42);
}

.desktop-message-root:not([data-theme="dark"]) {
  --desktop-message-bg: rgba(255, 255, 255, .98);
  --desktop-message-border: #deded9;
  --desktop-message-text: #343432;
  --desktop-message-shadow: rgba(0, 0, 0, .18);
}

.desktop-message-toast {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-height: 36px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 0 15px;
  box-sizing: border-box;
  border: 1px solid var(--desktop-message-border);
  border-radius: 9px;
  background: var(--desktop-message-bg);
  color: var(--desktop-message-text);
  box-shadow: 0 8px 24px var(--desktop-message-shadow), 0 1px 3px rgba(0, 0, 0, .08);
  font-size: 13px;
  line-height: 20px;
}

.desktop-message-icon {
  display: inline-flex;
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
}

.desktop-message-icon svg {
  width: 17px;
  height: 17px;
}

.desktop-message-toast.is-success .desktop-message-icon { color: #38a169; }
.desktop-message-toast.is-error .desktop-message-icon { color: #d14343; }
.desktop-message-toast.is-warning .desktop-message-icon { color: #c58a16; }
.desktop-message-toast.is-info .desktop-message-icon { color: #4f78c9; }
.desktop-message-toast.is-loading .desktop-message-icon { color: #6b7280; }
.desktop-message-spinner { animation: desktop-message-spin .8s linear infinite; }
.desktop-message-text { min-width: 0; overflow-wrap: anywhere; }

.desktop-message-fade-enter-active,
.desktop-message-fade-leave-active { transition: opacity .16s ease, transform .16s ease; }
.desktop-message-fade-enter-from,
.desktop-message-fade-leave-to { opacity: 0; transform: translateY(-8px); }

@keyframes desktop-message-spin { to { transform: rotate(360deg); } }
</style>
