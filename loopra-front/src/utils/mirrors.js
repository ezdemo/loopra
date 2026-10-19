// GitHub 下载镜像列表（gh-proxy 加速）
// 每条结构：{ value: 镜像前缀 URL, label: 展示名, latency: 延迟(ms) | null }
// latency 初始为 null，由测速接口填充；测速超时/失败的镜像 latency 保持 null 并排在末尾。
//
// 已实测延迟（2026-08-22，Range 请求前 1KB）：gh-proxy.org 627 / github.boki.moe 855 / wget.la 930
// gh.monlor.com 976 / fastgit.cc 977 / ghproxy.net 1160 / ghfast.top 1346 / gh-proxy.com 2012
// down.npee.cn 2728 / ghproxy.vip 3604；ghproxy.1888866.xyz 超时（15s）已删除。

export const MIRROR_SOURCES = [
  { value: 'https://gh-proxy.org/', label: 'gh-proxy.org', latency: null },
  { value: 'https://github.boki.moe/', label: 'github.boki.moe', latency: null },
  { value: 'https://wget.la/', label: 'wget.la', latency: null },
  { value: 'https://gh.monlor.com/', label: 'gh.monlor.com', latency: null },
  { value: 'https://fastgit.cc/', label: 'fastgit.cc', latency: null },
  { value: 'https://ghproxy.net/', label: 'ghproxy.net', latency: null },
  { value: 'https://ghfast.top/', label: 'ghfast.top', latency: null },
  { value: 'https://gh-proxy.com/', label: 'gh-proxy.com', latency: null },
  { value: 'https://down.npee.cn/', label: 'down.npee.cn', latency: null },
  { value: 'https://ghproxy.vip/', label: 'ghproxy.vip', latency: null }
]

// 测速目标：release 里实际下载的压缩包（仅 Range 请求前 1KB，避免下载大文件）
export const MIRROR_TEST_ASSET = 'https://github.com/ezdemo/loopra-release/releases/latest/download/loopra-dist.tar.gz'

// 单个镜像测速超时（ms）
export const MIRROR_TEST_TIMEOUT = 8000

// 测速结果缓存：30 分钟内复用，过期自动重测
const LATENCY_KEY = 'loopra.mirrorLatencies'
const LATENCY_TTL = 30 * 60 * 1000

// 选中的下载源（'normal' 或镜像 value），独立于更新脚本的 normal/mirror 开关
const SELECT_KEY = 'loopra.mirrorSource'

export function loadSelectedMirrorSource() {
  try {
    const value = localStorage.getItem(SELECT_KEY)
    if (value && (value === 'normal' || MIRROR_SOURCES.some((m) => m.value === value))) return value
  } catch { /* ignore */ }
  return 'normal'
}

export function saveSelectedMirrorSource(value) {
  try {
    if (value && value !== 'normal' && MIRROR_SOURCES.some((m) => m.value === value)) {
      localStorage.setItem(SELECT_KEY, value)
    } else {
      localStorage.removeItem(SELECT_KEY)
    }
  } catch { /* localStorage 不可用时忽略 */ }
}

// 读取缓存的测速结果 [{ value, latency }]，未缓存/已过期返回 null
export function loadCachedLatencies() {
  try {
    const raw = JSON.parse(localStorage.getItem(LATENCY_KEY) || 'null')
    if (raw && raw.timestamp && Date.now() - raw.timestamp < LATENCY_TTL && Array.isArray(raw.list)) {
      return raw.list
    }
  } catch { /* ignore */ }
  return null
}

export function saveLatencies(list) {
  try {
    localStorage.setItem(LATENCY_KEY, JSON.stringify({ timestamp: Date.now(), list }))
  } catch { /* ignore */ }
}

// 按延迟升序排序，latency 为 null（未测/失败）的排到末尾
export function sortMirrors(mirrors) {
  return [...mirrors].sort((a, b) => {
    const la = a.latency == null ? Infinity : a.latency
    const lb = b.latency == null ? Infinity : b.latency
    return la - lb
  })
}

// 把缓存/新测的 latency 应用到镜像列表
export function applyLatencies(mirrors, latencies) {
  const map = new Map((latencies || []).map((item) => [item.value, item.latency]))
  return mirrors.map((m) => ({ ...m, latency: m.latency != null ? m.latency : (map.get(m.value) ?? null) }))
}

// 测速单个镜像（浏览器 fetch 兜底，CORS 不支持时返回 null；Electron 走主进程 IPC 更可靠）
async function measureMirrorFetch(mirror) {
  const url = mirror.value.replace(/\/+$/, '') + '/' + MIRROR_TEST_ASSET
  const start = performance.now()
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(MIRROR_TEST_TIMEOUT)
    })
    if (resp.status !== 200 && resp.status !== 206) return null
    const reader = resp.body && resp.body.getReader
      ? resp.body.getReader()
      : null
    if (reader) {
      const { value } = await reader.read()
      if (value) reader.cancel()
    }
    return Math.round(performance.now() - start)
  } catch {
    return null
  }
}

// 并行测速所有镜像：返回按延迟升序排序、latency 已填充的新列表
// Electron 下走主进程 IPC（node https，无 CORS 限制）；Web 下用 fetch 兜底。
export async function measureMirrors(mirrors = MIRROR_SOURCES) {
  let list
  if (typeof window !== 'undefined' && window.electronAPI?.mirror?.measureLatencies) {
    try {
      const res = await window.electronAPI.mirror.measureLatencies({
        mirrors: mirrors.map((m) => ({ value: m.value })),
        timeout: MIRROR_TEST_TIMEOUT
      })
      list = res && res.success ? res.list : null
    } catch (e) {
      console.warn('[mirrors] main-process speed test failed, fallback to fetch:', e)
    }
  }
  if (!list) {
    const results = await Promise.all(mirrors.map(async (m) => ({ m, latency: await measureMirrorFetch(m) })))
    list = results.map(({ m, latency }) => ({ value: m.value, latency }))
  }
  const merged = applyLatencies(mirrors, list)
  const sorted = sortMirrors(merged)
  saveLatencies(sorted.map(({ value, latency }) => ({ value, latency })))
  return sorted
}
