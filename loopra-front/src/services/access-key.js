// Shared by the React Web workspace and all Vue desktop/legacy windows.
const HEADER = 'X-Loopra-Key'
const keys = new Map()
const pending = new Map()
const aliases = new Map()
let originalFetch
let dialogId = 0

// Authentication appears before either renderer mounts, so its styles are self-contained.
const dialogStyles = `
.loopra-access { position:fixed; inset:0; z-index:2147483647; display:grid; place-items:center; padding:24px; box-sizing:border-box; overflow:auto; background:#17191d66; backdrop-filter:blur(6px); font:14px/1.5 var(--workspace-font, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif); color:var(--text, #1c1c1a); }
.loopra-access *, .loopra-access *::before, .loopra-access *::after { box-sizing:border-box; }
.loopra-access form { width:min(420px, 100%); margin:auto; padding:28px; border:1px solid var(--line, #e7e7e4); border-radius:22px; background:var(--surface, #fff); box-shadow:0 24px 80px #00000026, 0 4px 16px #0000000a; }
.loopra-access .access-icon { display:grid; place-items:center; width:44px; height:44px; margin-bottom:20px; border:1px solid var(--line, #e7e7e4); border-radius:14px; background:var(--sidebar, #fafaf9); }
.loopra-access svg { display:block; width:22px; height:22px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.loopra-access h2 { margin:0; font-size:22px; line-height:1.35; font-weight:600; letter-spacing:-.5px; color:inherit; }
.loopra-access .access-description { margin:9px 0 18px; color:var(--secondary, #5f5f5a); font-size:13px; line-height:1.7; }
.loopra-access code { padding:1px 4px; border-radius:4px; background:var(--soft, #f5f5f4); font:12px ui-monospace, Consolas, monospace; color:inherit; }
.loopra-access .access-server { display:flex; align-items:center; gap:8px; margin-bottom:24px; padding:10px 12px; border:1px solid var(--line, #e7e7e4); border-radius:10px; background:var(--sidebar, #fafaf9); font:12px/1.5 ui-monospace, Consolas, monospace; color:var(--secondary, #5f5f5a); overflow-wrap:anywhere; }
.loopra-access .access-server svg { width:15px; height:15px; flex-shrink:0; color:var(--muted, #8f8f89); }
.loopra-access label { display:block; font-size:13px; font-weight:500; }
.loopra-access input { display:block; width:100%; height:46px; margin-top:8px; padding:0 13px; border:1px solid var(--line-strong, #d6d6d2); border-radius:10px; outline:none; background:var(--surface, #fff); color:inherit; font:inherit; transition:border-color .15s, box-shadow .15s; }
.loopra-access input::placeholder { color:var(--muted, #8f8f89); }
.loopra-access input:focus { border-color:var(--blue, #3b6cf6); box-shadow:0 0 0 3px color-mix(in srgb, var(--blue, #3b6cf6) 12%, transparent); }
.loopra-access input[aria-invalid=true] { border-color:var(--danger, #d6453d); }
.loopra-access .access-error { margin:12px 0 0; padding:10px 12px; border-radius:8px; background:color-mix(in srgb, var(--danger, #d6453d) 7%, var(--surface, #fff)); color:var(--danger, #d6453d); font-size:12px; line-height:1.6; }
.loopra-access .access-error:empty { display:none; }
.loopra-access button { display:flex; align-items:center; justify-content:center; gap:8px; width:100%; height:44px; margin-top:20px; padding:0 16px; border:0; border-radius:10px; background:var(--blue, #3b6cf6); color:#fff; font:inherit; font-size:13px; font-weight:500; cursor:pointer; transition:filter .15s, opacity .15s; }
.loopra-access button:hover { filter:brightness(.94); }
.loopra-access button:focus-visible { outline:2px solid var(--blue, #3b6cf6); outline-offset:3px; }
.loopra-access button:disabled { opacity:.6; cursor:wait; }
.loopra-access button svg { width:16px; height:16px; }
.loopra-access .access-note { margin:16px 0 0; color:var(--muted, #8f8f89); font-size:11px; line-height:1.7; text-align:center; }
@media (max-width:480px) { .loopra-access { padding:16px; } .loopra-access form { padding:24px; border-radius:18px; } }
`

function accessIcon(path) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  const shape = document.createElementNS(icon.namespaceURI, 'path')
  shape.setAttribute('d', path)
  icon.append(shape)
  return icon
}

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
    overlay.className = 'loopra-access'
    const style = document.createElement('style')
    style.textContent = dialogStyles
    const form = document.createElement('form')
    const id = `loopra-access-${++dialogId}`
    const icon = document.createElement('div')
    icon.className = 'access-icon'
    icon.append(accessIcon('M12 3 4 6v6c0 4.5 8 9 8 9s8-4.5 8-9V6l-8-3Z M9 12l2 2 4-4'))
    const title = document.createElement('h2')
    title.id = `${id}-title`
    title.textContent = '连接到 Loopra'
    overlay.setAttribute('aria-labelledby', title.id)
    const description = document.createElement('p')
    description.id = `${id}-description`
    description.className = 'access-description'
    const parameter = document.createElement('code')
    parameter.textContent = 'rk'
    description.append('粘贴服务启动链接中的 ', parameter, ' 密钥以继续。')
    overlay.setAttribute('aria-describedby', description.id)
    const server = document.createElement('div')
    server.className = 'access-server'
    server.append(accessIcon('M4 4h16v12H4z M8 20h8 M12 16v4'), document.createTextNode(origin))
    const label = document.createElement('label')
    label.textContent = '访问密钥'
    const input = document.createElement('input')
    input.type = 'password'
    input.required = true
    input.autocomplete = 'off'
    input.placeholder = '请输入访问密钥'
    label.append(input)
    const error = document.createElement('p')
    error.setAttribute('role', 'alert')
    error.id = `${id}-error`
    error.className = 'access-error'
    error.textContent = initialError
    input.setAttribute('aria-describedby', error.id)
    if (initialError) input.setAttribute('aria-invalid', 'true')
    input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid') })
    const button = document.createElement('button')
    button.type = 'submit'
    const resetButton = () => button.replaceChildren('验证并连接', accessIcon('M5 12h14 M13 6l6 6-6 6'))
    resetButton()
    const note = document.createElement('p')
    note.className = 'access-note'
    note.textContent = '验证后保存在此浏览器 · 服务重启后请使用新密钥'
    form.append(icon, title, description, server, label, error, button, note)
    overlay.append(style, form)
    document.body.append(overlay)
    input.focus()
    form.addEventListener('submit', async event => {
      event.preventDefault()
      const key = input.value.trim()
      if (!key || button.disabled) return
      button.disabled = true
      button.textContent = '正在验证…'
      try {
        if (!await validate(origin, key)) { error.textContent = '密钥不正确或已失效，请使用本次启动生成的密钥。'; input.setAttribute('aria-invalid', 'true'); input.select(); return }
        await rememberVerifiedAccessKey(origin, key)
        overlay.remove()
        resolve()
      } catch (cause) { error.textContent = cause.message || '无法连接服务，请检查服务是否已启动。' }
      finally { button.disabled = false; resetButton() }
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
