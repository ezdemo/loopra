/* @vitest-environment jsdom */
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import SplashScreen from './SplashScreen.vue'

const service = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({ installed: true, running: true, runtime_version: '26.9.91', desktop_version: '26.9.91' })),
  getCurrentPort: vi.fn(async () => 4567),
  detectJavaStatus: vi.fn(async () => ({ usable: true })),
  start: vi.fn(),
}))
vi.mock('@/services/platform', () => ({ platform: { isElectron: true, implementation: { loopraWebService: service } } }))
vi.mock('@/services/api', () => ({ systemAPI: {} }))
vi.mock('@/utils/mirrors', () => ({
  MIRROR_SOURCES: [], applyLatencies: () => [], loadCachedLatencies: () => ({}),
  loadSelectedMirrorSource: () => 'normal', measureMirrors: async () => [],
  saveSelectedMirrorSource: () => {}, sortMirrors: () => [],
}))
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

it('clears the startup overlay when the core is already running', async () => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
  const wrapper = shallowMount(SplashScreen, { global: { plugins: [createPinia()] } })
  try {
    await flushPromises()
    expect(wrapper.find('.startup-overlay').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('正在检查核心服务...')
    expect(service.start).not.toHaveBeenCalled()
    expect(localStorage.getItem('loopra-api-base')).toBe('http://127.0.0.1:4567')
  } finally { wrapper.unmount() }
})
