<template>
  <div ref="rootRef" class="service-manager" :class="{ 'opens-up': placement === 'top', 'has-label': showLabel }">
    <button
      class="tb-service-btn"
      :class="{ active: open, 'with-label': showLabel }"
      :role="showLabel ? 'menuitem' : undefined"
      title="服务进程管理"
      @click.stop="toggle"
      @dblclick.stop
    >
      <ApiOutlined />
      <span v-if="showLabel" class="service-trigger-label">服务进程</span>
      <span v-if="processes.length" class="service-live-dot"></span>
    </button>

    <section v-if="open" class="service-popover" @click.stop @dblclick.stop>
      <header class="service-header">
        <div>
          <h3>服务进程</h3>
          <p>{{ summary }}</p>
        </div>
        <button class="icon-btn" title="刷新进程列表" :disabled="loading" @click="refresh">
          <ReloadOutlined :class="{ spinning: loading }" />
        </button>
      </header>

      <div v-if="error" class="service-error">{{ error }}</div>

      <div v-if="loading && !processes.length" class="service-empty">
        <LoadingOutlined class="spinning" />
        <span>正在读取系统进程</span>
      </div>

      <div v-else-if="!processes.length" class="service-empty">
        <CloudServerOutlined />
        <span>未发现 Loopra Java 后端进程</span>
      </div>

      <div v-else class="process-list">
        <article v-for="processItem in processes" :key="processItem.pid" class="process-row">
          <div class="process-status"><span></span></div>
          <div class="process-main">
            <div class="process-title">
              <strong>loopra-web</strong>
              <span v-if="processItem.managed" class="managed-tag">当前应用</span>
              <span class="pid">PID {{ processItem.pid }}</span>
            </div>
            <div class="process-meta">
              <span v-if="processItem.port">端口 {{ processItem.port }}</span>
              <span>{{ formatBytes(processItem.memoryBytes) }}</span>
              <span>{{ formatUptime(processItem) }}</span>
            </div>
            <div class="process-command" :title="processItem.commandLine">{{ processItem.commandLine }}</div>
          </div>
          <div class="process-actions">
            <button
              class="icon-btn"
              :disabled="!processItem.port"
              :title="processItem.port ? `打开 127.0.0.1:${processItem.port}` : '未识别到服务端口'"
              @click="openProcess(processItem)"
            >
              <ExportOutlined />
            </button>
            <button
              class="icon-btn danger"
              :title="`结束进程 ${processItem.pid}`"
              :disabled="busyPid === processItem.pid"
              @click="terminate(processItem)"
            >
              <LoadingOutlined v-if="busyPid === processItem.pid" />
              <PoweroffOutlined v-else />
            </button>
          </div>
        </article>
      </div>

    </section>
  </div>
</template>

<script setup>
import {computed, onBeforeUnmount, ref} from 'vue'
import {
  ApiOutlined,
  CloudServerOutlined,
  ExportOutlined,
  LoadingOutlined,
  PoweroffOutlined,
  ReloadOutlined
} from '@ant-design/icons-vue'
import {platform} from '@/services/platform'

defineProps({
  placement: { type: String, default: 'bottom' },
  showLabel: { type: Boolean, default: false }
})

const rootRef = ref(null)
const open = ref(false)
const loading = ref(false)
const busyPid = ref(0)
const processes = ref([])
const error = ref('')
let refreshTimer = null

const service = platform.implementation.loopraWebService
const summary = computed(() => processes.value.length ? `${processes.value.length} 个 Loopra Java 进程正在运行` : '系统进程视图')

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (!bytes) return '内存未知'
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`
  return `${Math.floor(seconds / 86400)} 天`
}

function formatUptime(processItem) {
  if (processItem.uptimeSeconds) return `已运行 ${formatDuration(processItem.uptimeSeconds)}`
  if (processItem.startedAt) {
    const seconds = (Date.now() - new Date(processItem.startedAt).getTime()) / 1000
    if (Number.isFinite(seconds)) return `已运行 ${formatDuration(seconds)}`
  }
  return '启动时间未知'
}

async function refresh() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await service.listProcesses()
    processes.value = result.processes || []
    error.value = result.error || ''
  } catch (cause) {
    error.value = cause?.message || '读取系统进程失败'
  } finally {
    loading.value = false
  }
}

function handleOutsideClick(event) {
  if (!rootRef.value?.contains(event.target)) close()
}

function handleKeydown(event) {
  if (event.key === 'Escape') close()
}

function close() {
  open.value = false
  clearInterval(refreshTimer)
  refreshTimer = null
  document.removeEventListener('pointerdown', handleOutsideClick)
  document.removeEventListener('keydown', handleKeydown)
}

async function toggle() {
  if (open.value) {
    close()
    return
  }
  processes.value = []
  error.value = ''
  open.value = true
  document.addEventListener('pointerdown', handleOutsideClick)
  document.addEventListener('keydown', handleKeydown)
  await refresh()
  refreshTimer = setInterval(refresh, 3000)
}

async function terminate(processItem) {
  busyPid.value = processItem.pid
  error.value = ''
  try {
    await service.terminateProcess(processItem.pid)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await refresh()
  } catch (cause) {
    error.value = cause?.message || `无法结束进程 ${processItem.pid}`
  } finally {
    busyPid.value = 0
  }
}

async function openProcess(processItem) {
  error.value = ''
  try {
    await service.openProcess(processItem.pid)
  } catch (cause) {
    error.value = cause?.message || `无法打开进程 ${processItem.pid}`
  }
}

onBeforeUnmount(close)
</script>

<style scoped>
.service-manager {
  position: relative;
  display: flex;
  -webkit-app-region: no-drag;
}

.tb-service-btn,
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-3);
  transition: background var(--t), color var(--t);
}

.tb-service-btn {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: var(--r);
  font-size: 16px;
}

.service-manager.has-label {
  width: 100%;
}

.tb-service-btn.with-label {
  width: 100%;
  min-height: 34px;
  height: 34px;
  justify-content: flex-start;
  gap: 9px;
  padding: 0 9px;
  font: inherit;
  font-size: 13px;
}

.tb-service-btn.with-label > :deep(.anticon) {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 16px;
  font-size: 16px;
  line-height: 1;
}

.tb-service-btn.with-label > :deep(.anticon > svg) {
  width: 16px;
  height: 16px;
}

.service-trigger-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tb-service-btn:hover,
.tb-service-btn.active,
.icon-btn:hover:not(:disabled) {
  color: var(--fg);
  background: var(--bg-3);
}

.service-live-dot {
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 6px;
  height: 6px;
  border: 1px solid var(--bg);
  border-radius: 50%;
  background: #22a06b;
}

.service-popover {
  position: absolute;
  top: 38px;
  left: -8px;
  z-index: 600;
  width: min(440px, calc(100vw - 24px));
  max-height: min(620px, calc(100vh - 64px));
  overflow: hidden;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  box-shadow: var(--shadow-lg);
}

.service-manager.opens-up .service-popover {
  top: auto;
  bottom: 38px;
}

.service-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 12px;
  border-bottom: 1px solid var(--border);
}

.service-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.service-header p {
  margin: 3px 0 0;
  color: var(--fg-4);
  font-size: 11px;
}

.icon-btn {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 5px;
}

.icon-btn:disabled,
.service-action:disabled {
  cursor: default;
  opacity: 0.4;
}

.icon-btn.danger:hover:not(:disabled) {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.1);
}

.service-error {
  padding: 9px 14px;
  color: #b42318;
  background: rgba(220, 38, 38, 0.08);
  border-bottom: 1px solid rgba(220, 38, 38, 0.18);
  font-size: 12px;
}

.service-empty {
  min-height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fg-4);
  font-size: 12px;
}

.service-empty :deep(svg) {
  font-size: 25px;
  opacity: 0.65;
}

.process-list {
  max-height: 410px;
  overflow-y: auto;
}

.process-row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 60px;
  gap: 9px;
  align-items: start;
  padding: 12px 12px 11px 14px;
  border-bottom: 1px solid var(--border);
}

.process-status {
  height: 22px;
  display: flex;
  align-items: center;
}

.process-status span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22a06b;
  box-shadow: 0 0 0 3px rgba(34, 160, 107, 0.12);
}

.process-main {
  min-width: 0;
}

.process-actions {
  display: flex;
  gap: 4px;
}

.process-title,
.process-meta {
  display: flex;
  align-items: center;
  gap: 7px;
}

.process-title strong {
  font-size: 12px;
}

.managed-tag {
  padding: 1px 5px;
  color: var(--accent);
  background: var(--accent-bg);
  border-radius: 3px;
  font-size: 10px;
}

.pid {
  margin-left: auto;
  color: var(--fg-4);
  font-family: var(--font-mono);
  font-size: 10px;
}

.process-meta {
  margin-top: 5px;
  color: var(--fg-3);
  font-size: 11px;
}

.process-meta span + span::before {
  content: '';
  display: inline-block;
  width: 2px;
  height: 2px;
  margin: 0 7px 3px 0;
  border-radius: 50%;
  background: var(--fg-4);
}

.process-command {
  margin-top: 6px;
  overflow: hidden;
  color: var(--fg-4);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spinning {
  animation: service-spin 0.8s linear infinite;
}

@keyframes service-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 680px) {
  .service-popover {
    position: fixed;
    top: 44px;
    left: 8px;
    right: 8px;
    width: auto;
  }

  .service-action {
    padding: 0 6px;
  }
}

[data-theme="dark"] .service-popover {
  background: var(--bg-2);
  border-color: var(--glass-border);
}
</style>
