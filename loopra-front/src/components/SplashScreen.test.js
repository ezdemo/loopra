/* @vitest-environment jsdom */
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SplashScreen from './SplashScreen.vue'
import { useAppStore } from '@/stores/app'

const startupView = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn(), mount: vi.fn() }))
vi.mock('../../web/src/startup-screen', () => ({ mountStartupScreen: (...args) => {
  startupView.mount(...args)
  startupView.render(args[1])
  return { render: startupView.render, unmount: startupView.unmount }
} }))

const service = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({ installed: true, running: true, runtime_version: '26.9.91', desktop_version: '26.9.91' })),
  getCurrentPort: vi.fn(async () => 4567),
  detectJavaStatus: vi.fn(async () => ({ usable: true })),
  start: vi.fn(),
  stop: vi.fn(),
  installLocal: vi.fn(),
  downloadJre25: vi.fn(),
}))
vi.mock('@/services/platform', () => ({ platform: { isElectron: true, implementation: { loopraWebService: service, events: { listen: async () => () => {} } } } }))
vi.mock('@/services/api', () => ({ systemAPI: {} }))
vi.mock('@/utils/mirrors', () => ({
  MIRROR_SOURCES: [], applyLatencies: () => [], loadCachedLatencies: () => ({}),
  loadSelectedMirrorSource: () => 'normal', measureMirrors: async () => [],
  saveSelectedMirrorSource: () => {}, sortMirrors: () => [],
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

it('clears the startup overlay when the core is already running', async () => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    expect(startupView.render.mock.calls.at(-1)[0].autoStarting).toBe(false)
    expect(service.start).not.toHaveBeenCalled()
    expect(wrapper.emitted('ready')).toHaveLength(1)
    expect(localStorage.getItem('loopra-api-base')).toBe('http://127.0.0.1:4567')
  } finally { wrapper.unmount() }
})

it('follows workspace and system theme changes while checking the service, and removes listeners on unmount', async () => {
  let onSystemTheme
  const colorScheme = {
    matches: false,
    addEventListener: vi.fn((_, listener) => { onSystemTheme = listener }),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => colorScheme))
  localStorage.setItem('loopra:preferences', JSON.stringify({ theme: '跟随系统' }))
  service.getStatus.mockImplementationOnce(() => new Promise(() => {}))
  const pinia = createPinia()
  useAppStore(pinia).settings.theme = 'dark'
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [pinia] } })
  try {
    await flushPromises()
    expect(wrapper.attributes('data-theme')).toBe('light')
    expect(startupView.render.mock.calls.at(-1)[0].autoStarting).toBe(true)
    expect(startupView.render.mock.calls.at(-1)[0].startingMsg).toBe('正在检查核心服务...')

    onSystemTheme({ matches: true })
    await flushPromises()
    expect(wrapper.attributes('data-theme')).toBe('dark')

    localStorage.setItem('loopra:preferences', JSON.stringify({ theme: '浅色' }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'loopra:preferences' }))
    await flushPromises()
    expect(wrapper.attributes('data-theme')).toBe('light')

    localStorage.removeItem('loopra:preferences')
    window.dispatchEvent(new StorageEvent('storage', { key: 'loopra:preferences' }))
    await flushPromises()
    expect(wrapper.attributes('data-theme')).toBe('dark')
  } finally { wrapper.unmount() }
  expect(colorScheme.removeEventListener).toHaveBeenCalledWith('change', onSystemTheme)
})

function bundledService({ javaUsable = true, version = '26.9.90', runningInitially = true } = {}) {
  let running = runningInitially
  let runtimeVersion = version
  let usable = javaUsable
  service.getStatus.mockImplementation(async () => ({ installed: true, running, bundled_core: true, bundled_version: '26.9.91', runtime_version: runtimeVersion, desktop_version: '26.9.91' }))
  service.getCurrentPort.mockImplementation(async () => running ? 4567 : 0)
  service.detectJavaStatus.mockImplementation(async () => ({ usable }))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: running })))
  service.stop.mockImplementation(async () => { running = false })
  service.installLocal.mockImplementation(async () => { runtimeVersion = '26.9.91' })
  service.start.mockImplementation(async () => { running = true; return 4567 })
  service.downloadJre25.mockImplementation(async () => { usable = true; return { success: true } })
}

it.each(['', '?from=update'])('automatically installs a bundled update and restarts the service in %s mode', async query => {
  window.history.replaceState({}, '', `/${query}`)
  bundledService()
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    expect(service.stop).toHaveBeenCalledTimes(1)
    expect(service.installLocal).toHaveBeenCalledTimes(1)
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(service.stop.mock.invocationCallOrder[0]).toBeLessThan(service.installLocal.mock.invocationCallOrder[0])
    expect(service.installLocal.mock.invocationCallOrder[0]).toBeLessThan(service.start.mock.invocationCallOrder[0])
    expect(startupView.render.mock.calls.at(-1)[0]).toMatchObject({ running: true, runtimeVersion: '26.9.91', autoStarting: false })
    expect(wrapper.emitted('ready')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it.each(['', '?from=update'])('updates the core before opening Java setup, then starts automatically after JRE installation in %s mode', async query => {
  window.history.replaceState({}, '', `/${query}`)
  bundledService({ javaUsable: false })
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    expect(startupView.render.mock.calls.at(-1)[0]).toMatchObject({ menu: 'deps', jrePulse: true, autoStarting: false })
    expect(service.installLocal).toHaveBeenCalledTimes(1)
    expect(service.stop).toHaveBeenCalledTimes(1)
    expect(service.start).not.toHaveBeenCalled()
    expect(service.installLocal.mock.invocationCallOrder[0]).toBeLessThan(service.detectJavaStatus.mock.invocationCallOrder[0])
    expect(service.downloadJre25).not.toHaveBeenCalled()
    expect(wrapper.emitted('ready')).toBeUndefined()
    await startupView.mount.mock.calls.at(-1)[2].downloadJre()
    await flushPromises()
    expect(service.downloadJre25).toHaveBeenCalledWith('normal')
    expect(service.installLocal).toHaveBeenCalledTimes(1)
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(startupView.render.mock.calls.at(-1)[0]).toMatchObject({ menu: 'core', running: true, java: { usable: true } })
    expect(wrapper.emitted('ready')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it('waits for the bundled update then enters immediately even if the old skip-wait option is disabled', async () => {
  vi.useFakeTimers()
  bundledService()
  localStorage.setItem('loopra.skipWait', '0')
  let finishInstall
  const installed = service.installLocal.getMockImplementation()
  service.installLocal.mockImplementationOnce(() => new Promise(resolve => { finishInstall = async () => { await installed(); resolve() } }))
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    await vi.advanceTimersByTimeAsync(700)
    expect(wrapper.emitted('ready')).toBeUndefined()
    await finishInstall()
    await flushPromises()
    expect(wrapper.emitted('ready')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it('keeps an update failure visible without starting or entering the workspace', async () => {
  vi.useFakeTimers()
  bundledService()
  localStorage.setItem('loopra.skipWait', '1')
  service.installLocal.mockRejectedValueOnce(new Error('installer failed'))
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1000)
    expect(service.start).not.toHaveBeenCalled()
    expect(wrapper.emitted('ready')).toBeUndefined()
    expect(startupView.render.mock.calls.at(-1)[0]).toMatchObject({ autoStarting: false, errorMessage: '安装失败: installer failed' })
  } finally { wrapper.unmount() }
})

it('does not downgrade a runtime newer than the bundled core', async () => {
  bundledService({ version: '26.9.92' })
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    expect(service.installLocal).not.toHaveBeenCalled()
    expect(service.stop).not.toHaveBeenCalled()
  } finally { wrapper.unmount() }
})

it('resumes automatic updating after detecting a manually installed Java runtime', async () => {
  bundledService({ javaUsable: false })
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    service.detectJavaStatus.mockResolvedValue({ usable: true })
    await startupView.mount.mock.calls.at(-1)[2].refreshJava()
    await flushPromises()
    expect(service.installLocal).toHaveBeenCalledTimes(1)
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(startupView.render.mock.calls.at(-1)[0]).toMatchObject({ menu: 'core', running: true })
    expect(wrapper.emitted('ready')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it('starts after JRE installation in the update window even when the core is already current', async () => {
  window.history.replaceState({}, '', '/?from=update')
  bundledService({ javaUsable: false, version: '26.9.91', runningInitially: false })
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    await startupView.mount.mock.calls.at(-1)[2].downloadJre()
    await flushPromises()
    expect(service.installLocal).not.toHaveBeenCalled()
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('ready')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it.each([false, true])('waits for the startup health check and respects cancellation: %s', async cancelled => {
  bundledService({ version: '26.9.91', runningInitially: false })
  let finishHealthCheck
  const originalFetch = fetch.getMockImplementation()
  fetch.mockImplementation((...args) => service.start.mock.calls.length
    ? new Promise(resolve => { finishHealthCheck = resolve })
    : originalFetch(...args))
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('ready')).toBeUndefined()
    if (cancelled) startupView.mount.mock.calls.at(-1)[2].cancelStart()
    finishHealthCheck({ ok: true })
    await flushPromises()
    if (cancelled) {
      expect(wrapper.emitted('ready')).toBeUndefined()
      expect(service.stop).toHaveBeenCalledTimes(1)
    } else expect(wrapper.emitted('ready')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it('starts its own service when the main process has not selected the default service', async () => {
  let running = false
  service.getStatus.mockImplementation(async () => ({
    installed: true, running, runtime_version: '26.9.91', desktop_version: '26.9.91',
  }))
  service.getCurrentPort.mockImplementation(async () => running ? 51234 : 0)
  service.detectJavaStatus.mockResolvedValue({ usable: true })
  service.start.mockImplementation(async () => { running = true; return 51234 })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
  localStorage.setItem('loopra-api-base', 'http://127.0.0.1:4567')
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalled()
    expect(fetch.mock.calls.every(([url]) => !String(url).includes(':4567/'))).toBe(true)
    expect(localStorage.getItem('loopra-api-base')).toBe('http://127.0.0.1:51234')
    expect(wrapper.emitted('ready')).toHaveLength(1)
  } finally { wrapper.unmount() }
})
