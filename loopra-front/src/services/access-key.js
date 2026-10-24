// Shared by the React Web workspace and all Vue desktop/legacy windows.
const HEADER = 'X-Loopra-Key'
const keys = new Map()
const pending = new Map()
const aliases = new Map()
let originalFetch

export function accessOrigin(server) {
  const origin = new URL(server || '/', window.location.href).origin
  return aliases.get(origin) || origin
}

// Vite's /api proxy and direct requests address the same backend process.
export function setAccessProxy(proxy, server) {
  aliases.set(new URL(proxy).origin, new URL(server).origin)
}

function storageName(origin) { return `loopra:access-key:${origin}` }
export function getAccessKey(server) {
  const origin = accessOrigin(server)
  if (keys.has(origin)) return keys.get(origin)
  try { return localStorage.getItem(storageName(origin)) || '' } catch { return '' }
}

export function saveAccessKey(server, key) {
  const origin = accessOrigin(server)
  keys.set(origin, key)
  try { localStorage.setItem(storageName(origin), key) } catch { /* Memory-only access still works. */ }
}

async function rememberVerifiedAccessKey(origin, key) {
  saveAccessKey(origin, key)
  const url = new URL(origin)
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    // The main process keeps manually entered development credentials only in
    // memory, so native requests can use them too. No credential file is used.
    try {
      await window.electronAPI?.loopraWebService?.setAccessKey?.(Number(url.port || (url.protocol === 'https:' ? 443 : 80)), key)
    } catch { /* Browser access remains usable if the optional bridge is unavailable. */ }
  }
}

export async function getAccessHeaders(server) {
  const url = new URL(accessOrigin(server))
  // The bridge returns keys from child services or a verified dev connection.
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    const key = await window.electronAPI?.loopraWebService?.getAccessKey?.(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
    if (key) saveAccessKey(url.origin, key)
  }
  const key = getAccessKey(url.origin)
  return key ? { [HEADER]: key } : {}
}

export function authenticatedAssetUrl(value) {
  const url = new URL(value, window.location.href)
  if (!/^\/api\/pets\/[^/]+\/spritesheet$/.test(url.pathname)) return value
  const key = getAccessKey(url.origin)
  if (key) url.searchParams.set('rk', key)
  return url.href
}

async function validate(origin, key) {
  const response = await (originalFetch || window.fetch.bind(window))(`${origin}/api/system/health`, {
    headers: key ? { [HEADER]: key } : {}, signal: AbortSignal.timeout(5000), redirect: 'error'
  })
  if (response.status === 401) return false
  if (!response.ok) throw new Error(`服务连接失败（HTTP ${response.status}）`)
  const result = await response.json()
  if (result.success !== true) throw new Error('服务返回了无效的健康检查结果')
  return true
}

function inputKey(origin, initialError) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', 'Loopra 访问密钥')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#101827b8;padding:24px;font:14px system-ui;color:#172033'
    const form = document.createElement('form')
    form.style.cssText = 'width:min(420px,100%);box-sizing:border-box;padding:30px;border-radius:18px;background:#fff;box-shadow:0 24px 80px #0004'
    const title = document.createElement('h2')
    title.textContent = '输入 Loopra 访问密钥'
    title.style.cssText = 'font-size:21px;margin:0 0 14px'
    const description = document.createElement('p')
    description.textContent = `连接 ${origin}。请复制服务启动日志中链接的 rk 参数，验证后会保存在此浏览器。`
    description.style.cssText = 'line-height:1.7;margin:0 0 18px;overflow-wrap:anywhere'
    const label = document.createElement('label')
    label.textContent = '访问密钥'
    const input = document.createElement('input')
    input.type = 'password'
    input.required = true
    input.autocomplete = 'off'
    input.placeholder = '粘贴 rk 密钥'
    input.style.cssText = 'display:block;box-sizing:border-box;width:100%;margin-top:8px;padding:12px;border:1px solid #bbc5d3;border-radius:8px;background:#fff;color:#172033'
    label.append(input)
    const error = document.createElement('p')
    error.setAttribute('role', 'alert')
    error.textContent = initialError
    error.style.cssText = 'min-height:20px;color:#bb263d;line-height:1.5'
    const button = document.createElement('button')
    button.type = 'submit'
    button.textContent = '验证并连接'
    button.style.cssText = 'width:100%;padding:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;font:inherit;cursor:pointer'
    form.append(title, description, label, error, button)
    overlay.append(form)
    document.body.append(overlay)
    input.focus()
    form.addEventListener('submit', async event => {
      event.preventDefault()
      const key = input.value.trim()
      if (!key || button.disabled) return
      button.disabled = true
      button.textContent = '正在验证…'
      try {
        if (!await validate(origin, key)) { error.textContent = '密钥不正确或已失效，请使用本次启动生成的密钥。'; input.select(); return }
        await rememberVerifiedAccessKey(origin, key)
        overlay.remove()
        resolve()
      } catch (cause) { error.textContent = cause.message || '无法连接服务，请检查服务是否已启动。' }
      finally { button.disabled = false; button.textContent = '验证并连接' }
    })
  })
}

export function ensureAccess(server, usePageKey = false) {
  const origin = accessOrigin(server)
  if (pending.has(origin)) return pending.get(origin)
  const task = (async () => {
    let key = (await getAccessHeaders(origin))[HEADER] || ''
    if (usePageKey) {
      const page = new URL(window.location.href)
      if (page.searchParams.has('rk')) {
        key = page.searchParams.get('rk') || ''
        page.searchParams.delete('rk')
        history.replaceState(history.state, '', page.href)
      }
    }
    let error = ''
    if (key) {
      try { if (await validate(origin, key)) { await rememberVerifiedAccessKey(origin, key); return } }
      catch (cause) { error = cause.message || '无法连接服务' }
      if (!error) error = '密钥不正确或已失效，请使用本次启动生成的密钥。'
    }
    await inputKey(origin, error)
  })().finally(() => pending.delete(origin))
  pending.set(origin, task)
  return task
}

export function installAccessKeyProtocol() {
  if (originalFetch) return
  originalFetch = window.fetch.bind(window)
  // URL-bearing elements (pet sprites) use a narrowly scoped read-only URL key.
  window.loopraAssetUrl = authenticatedAssetUrl
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
    if (!/^\/api(?:\/|$)/.test(url.pathname)) return originalFetch(input, init)
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    const access = await getAccessHeaders(url.origin)
    if (access[HEADER]) headers.set(HEADER, access[HEADER])
    const retryInput = input instanceof Request ? input.clone() : input
    const response = await originalFetch(input, { ...init, headers, ...(headers.has(HEADER) ? { redirect: 'error' } : {}) })
    if (response.status !== 401 || (init?.signal || (input instanceof Request && input.signal))?.aborted) return response
    const result = await response.clone().json().catch(() => ({}))
    if (result.reason !== 'access_key_required') return response
    await ensureAccess(url.origin)
    headers.set(HEADER, getAccessKey(url.origin))
    return originalFetch(retryInput, { ...init, headers, redirect: 'error' })
  }
}
