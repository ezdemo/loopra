import {toRaw} from 'vue'

/**
 * Electron 的 contextBridge / IPC 不接受 Vue 响应式 Proxy。
 * popup 上下文只包含可序列化数据，因此递归复制即可安全跨越进程边界。
 */
export function toPlainIpcValue(value) {
  const raw = toRaw(value)
  if (Array.isArray(raw)) return raw.map(toPlainIpcValue)
  if (raw && typeof raw === 'object') {
    return Object.fromEntries(Object.entries(raw).map(([key, entry]) => [key, toPlainIpcValue(entry)]))
  }
  return raw
}
