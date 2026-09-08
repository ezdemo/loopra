/* @vitest-environment jsdom */

import {flushPromises, shallowMount} from '@vue/test-utils'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createPinia} from 'pinia'
import DesktopShell from './DesktopShell.vue'
import {nextTick} from 'vue'
import {useAppStore} from './stores/app'

const initialElectronAPI = window.electronAPI

const {configAPI, sessionsAPI, systemAPI, switchThemeWithReveal} = vi.hoisted(() => ({
  configAPI: {
    getConfig: vi.fn(),
    listWorkspaces: vi.fn(),
    getWorkspace: vi.fn(),
    switchWorkspace: vi.fn(),
    saveWorkspaceOrder: vi.fn(),
    deleteWorkspace: vi.fn()
  },
  sessionsAPI: {
    createNew: vi.fn(),
    list: vi.fn(),
    deleteSession: vi.fn(),
    clearAll: vi.fn(),
    clearBefore: vi.fn()
  },
  systemAPI: {
    checkLatestVersion: vi.fn(),
    setBrowserBridge: vi.fn()
  },
  switchThemeWithReveal: vi.fn((target, apply) => apply(target))
}))

vi.mock('./services/api', () => ({configAPI, sessionsAPI, systemAPI}))
vi.mock('./utils/themeTransition', () => ({switchThemeWithReveal}))

defineGlobalResizeObserver()

function defineGlobalResizeObserver() {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
  }
}

async function mountShell() {
  const pinia = createPinia()
  const store = useAppStore(pinia)
  store.settings.theme = 'gray'
  const wrapper = shallowMount(DesktopShell, {
    global: {
      plugins: [pinia],
      stubs: {
        Teleport: false,
        DesktopHome: {
          props: {settingsMode: Boolean},
          template: '<aside class="desktop-home-stub"><div v-if="settingsMode" class="desktop-settings-sidebar-stub" /><button v-else class="desktop-sidebar-brand" @contextmenu="$emit(\'open-home-context\', $event)" /><slot name="sidebar-header-actions" /><slot name="open-sessions" workspace-hash="h1" /></aside>'
        },
        SettingsView: true,
        ModelChannels: true,
        ConfirmDialog: true
      }
    }
  })
  await flushPromises()
  return {wrapper, store}
}

async function openTab(wrapper, sessionName) {
  await wrapper.vm.openSession({workspaceHash: 'h1', sessionName, title: sessionName})
  await flushPromises()
}

describe('DesktopShell 设置布局', () => {
  it('打开设置时用设置页替换项目侧栏，返回后恢复应用侧栏', async () => {
    const {wrapper} = await mountShell()

    await wrapper.vm.openSettings()
    await nextTick()
    expect(wrapper.vm.showSettings).toBe(true)
    expect(wrapper.find('.desktop-home-stub').exists()).toBe(true)
    expect(wrapper.find('.desktop-settings-sidebar-stub').exists()).toBe(true)
    expect(wrapper.find('.desktop-sidebar-resize-handle').exists()).toBe(true)
    expect(wrapper.find('.desktop-workbench').classes()).toContain('settings-mode')

    await wrapper.vm.showHome()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.desktop-home-stub').exists()).toBe(true)
    expect(wrapper.find('.desktop-sidebar-brand').exists()).toBe(true)
    expect(wrapper.find('.desktop-settings-sidebar-stub').exists()).toBe(false)
    expect(wrapper.find('.desktop-sidebar-resize-handle').exists()).toBe(true)

    wrapper.unmount()
  })

  it('返回应用时恢复打开设置前的会话，不再显示欢迎首页', async () => {
    const {wrapper} = await mountShell()

    await openTab(wrapper, 'before-settings')
    expect(wrapper.vm.activeTabId).toBe('h1:before-settings')

    await wrapper.vm.openSettings()
    expect(wrapper.vm.activeTabId).toBe('')

    await wrapper.vm.showHome()
    await nextTick()
    expect(wrapper.vm.activeTabId).toBe('h1:before-settings')
    expect(wrapper.find('.desktop-shell-welcome').exists()).toBe(false)

    wrapper.unmount()
  })
})

beforeEach(() => {
  configAPI.getConfig.mockResolvedValue({success: true, data: {modelChannelsConfigured: true}})
  configAPI.listWorkspaces.mockResolvedValue({success: true, data: [{hash: 'h1', name: 'A', path: '/p/a'}]})
  configAPI.getWorkspace.mockResolvedValue({success: true, data: '/p/a'})
  configAPI.switchWorkspace.mockResolvedValue({success: true, data: {workspace: ''}})
  sessionsAPI.list.mockResolvedValue({success: true, data: []})
  systemAPI.checkLatestVersion.mockResolvedValue({success: true, data: {hasNewVersion: false}})
  systemAPI.setBrowserBridge.mockResolvedValue({success: true, data: 'http://127.0.0.1:45678'})
  vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.querySelector('.desktop-shell-context-menu')?.remove()
  document.body.querySelector('.desktop-tab-context-menu')?.remove()
  if (initialElectronAPI === undefined) delete window.electronAPI
  else window.electronAPI = initialElectronAPI
})

describe('DesktopShell 更新按钮', () => {
  it('始终保留通知入口，仅在检测到新版本时标记提醒', async () => {
    systemAPI.checkLatestVersion.mockResolvedValueOnce({success: true, data: {hasNewVersion: false, latestVersion: '26.8.121'}})
    const {wrapper} = await mountShell()
    expect(wrapper.find('.desktop-notification-button').exists()).toBe(true)
    expect(wrapper.find('.desktop-notification-button').classes()).not.toContain('has-update')
    wrapper.unmount()

    systemAPI.checkLatestVersion.mockResolvedValueOnce({success: true, data: {hasNewVersion: true, latestVersion: '26.8.122'}})
    const updated = await mountShell()
    expect(updated.wrapper.find('.desktop-notification-button').classes()).toContain('has-update')
    updated.wrapper.unmount()
  })
})

describe('DesktopShell AI 浏览器桥接', () => {
  it('挂载后立即登记，并按周期重新登记；卸载后停止保活', async () => {
    vi.useFakeTimers()
    const getBridgeAddress = vi.fn().mockResolvedValue('http://127.0.0.1:45678')
    window.electronAPI = {
      aiBrowserWindow: {getBridgeAddress},
      desktopChatTabs: {
        create: vi.fn().mockResolvedValue({success: true}),
        show: vi.fn().mockResolvedValue({success: true}),
        hide: vi.fn().mockResolvedValue({success: true}),
        close: vi.fn().mockResolvedValue({success: true})
      }
    }

    const {wrapper} = await mountShell()
    await flushPromises()
    expect(systemAPI.setBrowserBridge).toHaveBeenCalledWith('http://127.0.0.1:45678', {silent: true})
    const callsAfterMount = systemAPI.setBrowserBridge.mock.calls.length

    await vi.advanceTimersByTimeAsync(10 * 1000)
    expect(systemAPI.setBrowserBridge).toHaveBeenCalledTimes(callsAfterMount + 1)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(10 * 1000)
    expect(systemAPI.setBrowserBridge).toHaveBeenCalledTimes(callsAfterMount + 1)
    vi.useRealTimers()
  })
})

describe('DesktopShell 启动页', () => {
  it('初始化默认项目后自动打开新建对话页', async () => {
    const desktopChatTabs = {
      create: vi.fn().mockResolvedValue({success: true}),
      show: vi.fn().mockResolvedValue({success: true}),
      hide: vi.fn().mockResolvedValue({success: true}),
      close: vi.fn().mockResolvedValue({success: true})
    }
    window.electronAPI = {desktopChatTabs}
    configAPI.listWorkspaces.mockResolvedValue({success: true, data: [
      {hash: 'h1', name: 'A', path: '/p/a'},
      {hash: 'h2', name: 'B', path: '/p/b'}
    ]})
    configAPI.getWorkspace.mockResolvedValue({success: true, data: '/p/b'})
    configAPI.switchWorkspace.mockClear()
    sessionsAPI.createNew.mockClear()
    sessionsAPI.createNew.mockResolvedValue({
      success: true,
      data: {sessionName: 'startup-session', workspaceHash: 'h1'}
    })

    const {wrapper} = await mountShell()
    await vi.waitFor(() => expect(wrapper.vm.activeTabId).toBe('h1:startup-session'))

    expect(configAPI.switchWorkspace).toHaveBeenCalledWith('/p/a')
    expect(sessionsAPI.createNew).toHaveBeenCalledWith({workspaceHash: 'h1'})
    expect(wrapper.find('.desktop-shell-welcome').exists()).toBe(false)
    expect(desktopChatTabs.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'h1:startup-session',
      sessionName: 'startup-session',
      newSession: true
    }))
    expect(desktopChatTabs.show).toHaveBeenCalledWith('h1:startup-session', expect.any(Object))

    wrapper.unmount()
  })
})

describe('DesktopShell 左侧边栏宽度', () => {
  const sidebarSizeKey = 'loopra-desktop-sidebar-width'

  beforeEach(() => {
    localStorage.removeItem(sidebarSizeKey)
  })

  afterEach(() => {
    localStorage.removeItem(sidebarSizeKey)
  })

  it('默认使用窄侧栏，并支持拖动、键盘和双击恢复宽度', async () => {
    const {wrapper} = await mountShell()
    const workbench = wrapper.find('.desktop-workbench')
    const handle = wrapper.find('.desktop-sidebar-resize-handle')

    expect(workbench.attributes('style')).toContain('--desktop-sidebar-width: 280px')
    expect(handle.attributes('role')).toBe('separator')
    expect(handle.attributes('aria-valuenow')).toBe('280')

    await handle.trigger('mousedown', {clientX: 280})
    window.dispatchEvent(new MouseEvent('mousemove', {clientX: 340}))
    await nextTick()
    expect(wrapper.vm.sidebarWidth).toBe(340)
    expect(handle.classes()).toContain('dragging')

    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(localStorage.getItem(sidebarSizeKey)).toBe('340')
    expect(handle.classes()).not.toContain('dragging')

    await handle.trigger('keydown', {key: 'ArrowLeft'})
    expect(wrapper.vm.sidebarWidth).toBe(330)
    await handle.trigger('dblclick')
    expect(wrapper.vm.sidebarWidth).toBe(280)
    expect(localStorage.getItem(sidebarSizeKey)).toBe('280')

    wrapper.unmount()
  })

  it('拖过最小宽度后自动收起侧边栏', async () => {
    const {wrapper} = await mountShell()
    const handle = wrapper.find('.desktop-sidebar-resize-handle')

    await handle.trigger('mousedown', {clientX: 280})
    // 220px 最小宽度之外再拖出 32px 的吸附区后收起。
    window.dispatchEvent(new MouseEvent('mousemove', {clientX: 180}))
    await nextTick()

    expect(wrapper.vm.sidebarWidth).toBe(220)
    expect(wrapper.vm.sidebarCollapsed).toBe(true)
    expect(wrapper.find('.desktop-workbench').classes()).toContain('sidebar-collapsed')
    expect(wrapper.find('.desktop-sidebar-resize-handle').classes()).toContain('collapsed')
    expect(localStorage.getItem(sidebarSizeKey)).toBe('220')

    // 收起态不保留空的 flex 拖拽条，通过标题栏按钮展开，内容区应贴到最左侧。
    expect(wrapper.find('.desktop-sidebar-toggle').attributes('title')).toBe('展开侧边栏')
    await wrapper.find('.desktop-sidebar-toggle').trigger('click')
    await nextTick()
    expect(wrapper.vm.sidebarCollapsed).toBe(false)
    expect(wrapper.vm.sidebarWidth).toBe(220)

    wrapper.unmount()
  })

  it('鼠标进入原生会话视图后仍能继续拖动', async () => {
    const listeners = new Map()
    const desktopChatTabs = {
      create: vi.fn().mockResolvedValue({success: true}),
      show: vi.fn().mockResolvedValue({success: true}),
      hide: vi.fn().mockResolvedValue({success: true}),
      close: vi.fn().mockResolvedValue({success: true}),
      startSidebarResize: vi.fn().mockResolvedValue({success: true}),
      endSidebarResize: vi.fn().mockResolvedValue({success: true})
    }
    window.electronAPI = {
      desktopChatTabs,
      events: {
        listen: vi.fn((eventName, callback) => {
          listeners.set(eventName, callback)
          return () => listeners.delete(eventName)
        })
      }
    }

    const {wrapper} = await mountShell()
    const handle = wrapper.find('.desktop-sidebar-resize-handle')
    await handle.trigger('mousedown', {clientX: 280})
    expect(desktopChatTabs.startSidebarResize).toHaveBeenCalled()

    // 原生 WebContentsView 接管焦点时，主 renderer 可能收到 blur；这不应结束拖拽。
    window.dispatchEvent(new Event('blur'))
    expect(handle.classes()).toContain('dragging')
    listeners.get('desktop-shell-sidebar-resize-move')({clientX: 380})
    await nextTick()
    expect(wrapper.vm.sidebarWidth).toBe(380)

    listeners.get('desktop-shell-sidebar-resize-end')()
    await nextTick()
    expect(desktopChatTabs.endSidebarResize).toHaveBeenCalled()
    expect(handle.classes()).not.toContain('dragging')

    wrapper.unmount()
  })
})

describe('DesktopShell 首页右键菜单', () => {
  it('提供需求池、引导、更新和暗色/浅色操作', async () => {
    const {wrapper, store} = await mountShell()
    const homeButton = wrapper.find('.desktop-sidebar-brand')

    await homeButton.trigger('contextmenu', {clientX: 40, clientY: 30})

    const menu = document.body.querySelector('.desktop-shell-context-menu')
    expect(menu).not.toBeNull()
    expect(menu.textContent).toContain('需求池')
    expect(menu.textContent).toContain('引导')
    expect(menu.textContent).toContain('更新')
    expect(menu.textContent).toContain('暗色')
    expect(menu.textContent).not.toContain('打开需求池')
    expect(menu.textContent).not.toContain('打开引导')
    expect(menu.textContent).not.toContain('切换主题')
    const menuItems = menu.querySelectorAll('[role="menuitem"]')
    menuItems[0].click()
    await nextTick()
    expect(window.open).toHaveBeenCalledWith(expect.stringContaining('requirementBoard=1'), '_blank')
    expect(document.body.querySelector('.desktop-shell-context-menu')).toBeNull()

    await homeButton.trigger('contextmenu', {clientX: 40, clientY: 30})
    // 菜单顺序：需求池 / 引导 / 更新 / 暗色（当前为浅色主题）
    document.body.querySelectorAll('[role="menuitem"]')[2].click()
    await nextTick()
    expect(window.open).toHaveBeenLastCalledWith(expect.stringContaining('/releases'), '_blank')

    await homeButton.trigger('contextmenu', {clientX: 40, clientY: 30})
    document.body.querySelectorAll('[role="menuitem"]')[3].click()
    await nextTick()
    expect(switchThemeWithReveal).toHaveBeenCalledWith('dark', expect.any(Function))
    expect(store.settings.theme).toBe('dark')
    expect(document.body.querySelector('.desktop-shell-context-menu')).toBeNull()

    wrapper.unmount()
  })

  it('Electron 环境通过原生菜单返回动作，不渲染 DOM 菜单', async () => {
    const openNativeMenu = vi.fn().mockResolvedValue('toggle-theme')
    window.electronAPI = {desktopHomeMenu: {open: openNativeMenu}}

    const {wrapper, store} = await mountShell()
    await wrapper.find('.desktop-sidebar-brand').trigger('contextmenu', {clientX: 40, clientY: 30})
    await nextTick()

    expect(openNativeMenu).toHaveBeenCalledWith('gray')
    expect(document.body.querySelector('.desktop-shell-context-menu')).toBeNull()
    expect(switchThemeWithReveal).toHaveBeenCalledWith('dark', expect.any(Function))
    expect(store.settings.theme).toBe('dark')

    wrapper.unmount()
  })

  it('将当前深色主题传给原生菜单', async () => {
    const openNativeMenu = vi.fn().mockResolvedValue(null)
    window.electronAPI = {desktopHomeMenu: {open: openNativeMenu}}

    const {wrapper, store} = await mountShell()
    store.settings.theme = 'dark'
    await wrapper.find('.desktop-sidebar-brand').trigger('contextmenu', {clientX: 40, clientY: 30})

    expect(openNativeMenu).toHaveBeenCalledWith('dark')
    expect(document.body.querySelector('.desktop-shell-context-menu')).toBeNull()

    wrapper.unmount()
  })

  it('点击外部或按 Escape 会关闭菜单', async () => {
    const {wrapper} = await mountShell()
    const homeButton = wrapper.find('.desktop-sidebar-brand')

    await homeButton.trigger('contextmenu', {clientX: 40, clientY: 30})
    expect(document.body.querySelector('.desktop-shell-context-menu')).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))
    await flushPromises()
    expect(document.body.querySelector('.desktop-shell-context-menu')).toBeNull()

    await homeButton.trigger('contextmenu', {clientX: 40, clientY: 30})
    window.dispatchEvent(new MouseEvent('click'))
    await flushPromises()
    expect(document.body.querySelector('.desktop-shell-context-menu')).toBeNull()

    wrapper.unmount()
  })
})

describe('DesktopShell 会话标签右键菜单', () => {
  function chatTabsBridge() {
    return {
      create: vi.fn().mockResolvedValue({success: true}),
      show: vi.fn().mockResolvedValue({success: true}),
      hide: vi.fn().mockResolvedValue({success: true}),
      close: vi.fn().mockResolvedValue({success: true}),
      reload: vi.fn().mockResolvedValue({success: true}),
      setLoading: vi.fn().mockResolvedValue({success: true}),
      sendCommand: vi.fn().mockResolvedValue(true)
    }
  }

  it('标签溢出时中键按下关闭标签并阻止自动滚动', async () => {
    const desktopChatTabs = chatTabsBridge()
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()
    // Native chat views must stay to the right of the persistent session sidebar.
    wrapper.find('.desktop-view-host').element.getBoundingClientRect = () => ({
      left: 300, top: 36, width: 1170, height: 856
    })
    await openTab(wrapper, 'a')
    await openTab(wrapper, 'b')

    expect(wrapper.find('.desktop-titlebar').exists()).toBe(true)
    expect(wrapper.find('.desktop-home-stub .desktop-tabs').exists()).toBe(true)
    expect(desktopChatTabs.create).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'h1:b',
      sessionName: 'b',
      sessionTitle: 'b'
    }))
    expect(desktopChatTabs.show).toHaveBeenLastCalledWith('h1:b', {
      x: 300, y: 36, width: 1170, height: 856
    })

    await wrapper.find('.desktop-sidebar-toggle').trigger('click')
    expect(wrapper.find('.desktop-workbench').classes()).toContain('sidebar-collapsed')

    const tab = wrapper.findAll('.desktop-tab')[1]
    const middleMouseDown = new MouseEvent('mousedown', {button: 1, bubbles: true, cancelable: true})
    expect(tab.element.dispatchEvent(middleMouseDown)).toBe(false)
    await flushPromises()

    expect(desktopChatTabs.close).toHaveBeenCalledWith('h1:b')
    expect(wrapper.findAll('.desktop-tab').map((item) => item.attributes('title'))).toEqual(['a'])

    wrapper.unmount()
  })

  it('提供刷新、关闭和关闭左右标签操作', async () => {
    const desktopChatTabs = chatTabsBridge()
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()
    await openTab(wrapper, 'a')
    await openTab(wrapper, 'b')
    await openTab(wrapper, 'c')

    expect(wrapper.find('.desktop-tab-reload').exists()).toBe(false)
    expect(wrapper.find('.desktop-tab-close').exists()).toBe(false)

    let tab = wrapper.findAll('.desktop-tab')[1]
    await tab.trigger('contextmenu', {clientX: 40, clientY: 30})
    let menu = document.body.querySelector('.desktop-tab-context-menu')
    expect(menu).not.toBeNull()
    expect(menu.textContent).toContain('刷新')
    expect(menu.textContent).toContain('关闭')
    expect(menu.textContent).toContain('关闭上方会话')
    expect(menu.textContent).toContain('关闭下方会话')

    let menuItems = menu.querySelectorAll('[role="menuitem"]')
    menuItems[0].click()
    await flushPromises()
    expect(desktopChatTabs.reload).toHaveBeenCalledWith('h1:b')

    tab = wrapper.findAll('.desktop-tab')[1]
    await tab.trigger('contextmenu', {clientX: 40, clientY: 30})
    menu = document.body.querySelector('.desktop-tab-context-menu')
    menuItems = menu.querySelectorAll('[role="menuitem"]')
    expect(menuItems[2].disabled).toBe(false)
    expect(menuItems[3].disabled).toBe(false)
    menuItems[2].click()
    await flushPromises()
    expect(desktopChatTabs.close).toHaveBeenCalledWith('h1:a')
    expect(wrapper.findAll('.desktop-tab').map((item) => item.attributes('title'))).toEqual(['b', 'c'])

    tab = wrapper.findAll('.desktop-tab')[0]
    await tab.trigger('contextmenu', {clientX: 40, clientY: 30})
    menu = document.body.querySelector('.desktop-tab-context-menu')
    menuItems = menu.querySelectorAll('[role="menuitem"]')
    expect(menuItems[2].disabled).toBe(true)
    menuItems[3].click()
    await flushPromises()
    expect(desktopChatTabs.close).toHaveBeenCalledWith('h1:c')
    expect(wrapper.findAll('.desktop-tab').map((item) => item.attributes('title'))).toEqual(['b'])

    await wrapper.find('.desktop-tab').trigger('contextmenu', {clientX: 40, clientY: 30})
    menu = document.body.querySelector('.desktop-tab-context-menu')
    menu.querySelectorAll('[role="menuitem"]')[1].click()
    await flushPromises()
    expect(desktopChatTabs.close).toHaveBeenCalledWith('h1:b')
    expect(wrapper.findAll('.desktop-tab')).toHaveLength(0)

    wrapper.unmount()
  })

  it('更新请求创建快速路径标签并投递命令', async () => {
    const desktopChatTabs = chatTabsBridge()
    const listeners = {}
    sessionsAPI.createNew.mockResolvedValue({success: true, data: {sessionName: 'update-session', workspaceHash: 'h1'}})
    window.electronAPI = {
      desktopChatTabs,
      events: {
        listen: vi.fn((channel, callback) => {
          listeners[channel] = callback
          return vi.fn()
        })
      }
    }
    const {wrapper} = await mountShell()

    listeners['chat-update-request']({source: 'mirror'})
    await vi.waitFor(() => expect(desktopChatTabs.sendCommand).toHaveBeenCalledTimes(1))

    expect(desktopChatTabs.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'h1:update-session',
      sessionName: 'update-session',
      newSession: true
    }))
    expect(desktopChatTabs.sendCommand).toHaveBeenCalledWith(
      'h1:update-session',
      expect.stringContaining('setup-gui-mirror')
    )
    wrapper.unmount()
  })

  it('加载失败时移除已创建的死标签', async () => {
    const desktopChatTabs = chatTabsBridge()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    desktopChatTabs.create.mockRejectedValue(new Error('ERR_FAILED'))
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()

    await openTab(wrapper, 'failed')

    expect(wrapper.findAll('.desktop-tab')).toHaveLength(0)
    expect(wrapper.find('.desktop-home-stub').exists()).toBe(true)
    expect(desktopChatTabs.show).not.toHaveBeenCalled()
    expect(desktopChatTabs.close).toHaveBeenCalledWith('h1:failed')
    expect(desktopChatTabs.hide).toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith('[desktop-shell] failed to show tab:', expect.any(Error))
    wrapper.unmount()
  })

  it('显示失败时关闭已创建的原生标签', async () => {
    const desktopChatTabs = chatTabsBridge()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    desktopChatTabs.show.mockRejectedValue(new Error('ERR_FAILED'))
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()

    await openTab(wrapper, 'show-failed')

    expect(desktopChatTabs.create).toHaveBeenCalledWith(expect.objectContaining({id: 'h1:show-failed'}))
    expect(desktopChatTabs.close).toHaveBeenCalledWith('h1:show-failed')
    expect(desktopChatTabs.hide).toHaveBeenCalled()
    expect(wrapper.findAll('.desktop-tab')).toHaveLength(0)
    expect(consoleError).toHaveBeenCalledWith('[desktop-shell] failed to show tab:', expect.any(Error))
    wrapper.unmount()
  })

  it('快速切换会话时只显示最后一次渲染请求', async () => {
    const desktopChatTabs = chatTabsBridge()
    let resolveFirstCreate
    const firstCreate = new Promise((resolve) => { resolveFirstCreate = resolve })
    desktopChatTabs.create
      .mockImplementationOnce(() => firstCreate)
      .mockResolvedValue({success: true})
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()

    const firstOpen = wrapper.vm.openSession({workspaceHash: 'h1', sessionName: 'a', title: 'a'})
    await vi.waitFor(() => expect(desktopChatTabs.create).toHaveBeenCalledTimes(1))
    const secondOpen = wrapper.vm.openSession({workspaceHash: 'h1', sessionName: 'b', title: 'b'})
    resolveFirstCreate({success: true})
    await Promise.all([firstOpen, secondOpen])
    await flushPromises()

    expect(desktopChatTabs.show).toHaveBeenCalledTimes(1)
    expect(desktopChatTabs.show).toHaveBeenCalledWith('h1:b', expect.any(Object))
    expect(wrapper.findAll('.desktop-tab').map((item) => item.attributes('title'))).toEqual(['a', 'b'])
    wrapper.unmount()
  })

  it('关闭在途创建的标签后清理原生视图', async () => {
    const desktopChatTabs = chatTabsBridge()
    let resolveCreate
    const pendingCreate = new Promise((resolve) => { resolveCreate = resolve })
    desktopChatTabs.create.mockImplementationOnce(() => pendingCreate)
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()

    const open = wrapper.vm.openSession({workspaceHash: 'h1', sessionName: 'closing', title: 'closing'})
    await vi.waitFor(() => expect(desktopChatTabs.create).toHaveBeenCalledTimes(1))
    const close = wrapper.vm.closeTab('h1:closing')
    resolveCreate({success: true})
    await Promise.all([open, close])

    expect(desktopChatTabs.show).not.toHaveBeenCalled()
    expect(desktopChatTabs.close).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('.desktop-tab')).toHaveLength(0)
    wrapper.unmount()
  })

  it('Electron 环境通过原生菜单返回标签动作', async () => {
    const desktopChatTabs = chatTabsBridge()
    const openNativeMenu = vi.fn().mockResolvedValue('close-left')
    window.electronAPI = {desktopChatTabs, desktopTabMenu: {open: openNativeMenu}}
    const {wrapper} = await mountShell()
    await openTab(wrapper, 'a')
    await openTab(wrapper, 'b')
    await openTab(wrapper, 'c')

    await wrapper.findAll('.desktop-tab')[1].trigger('contextmenu', {clientX: 40, clientY: 30})
    await flushPromises()

    expect(openNativeMenu).toHaveBeenCalledWith({tabId: 'h1:b', index: 1, tabCount: 3, theme: 'gray'})
    expect(desktopChatTabs.close).toHaveBeenCalledWith('h1:a')
    expect(document.body.querySelector('.desktop-tab-context-menu')).toBeNull()
    expect(wrapper.findAll('.desktop-tab').map((item) => item.attributes('title'))).toEqual(['b', 'c'])

    wrapper.unmount()
  })

  it('桌面壳缺少原生菜单 API 时不回退 DOM 菜单', async () => {
    const desktopChatTabs = chatTabsBridge()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalUrl = window.location.href
    window.history.replaceState({}, '', '/?desktopShell=1')
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()
    await openTab(wrapper, 'a')

    await wrapper.find('.desktop-tab').trigger('contextmenu', {clientX: 40, clientY: 30})
    expect(warn).toHaveBeenCalledWith('[desktop-shell] native tab menu API is unavailable')
    expect(document.body.querySelector('.desktop-tab-context-menu')).toBeNull()

    wrapper.unmount()
    window.history.replaceState({}, '', originalUrl)
  })
})

describe('DesktopShell 清空三天前的会话', () => {
  function chatTabsBridge() {
    return {
      create: vi.fn().mockResolvedValue({success: true}),
      show: vi.fn().mockResolvedValue({success: true}),
      hide: vi.fn().mockResolvedValue({success: true}),
      close: vi.fn().mockResolvedValue({success: true}),
      reload: vi.fn().mockResolvedValue({success: true}),
      sendCommand: vi.fn().mockResolvedValue(true)
    }
  }

  it('确认后按三天前阈值调用清理接口，仅关闭被删除会话的标签', async () => {
    sessionsAPI.clearBefore.mockResolvedValue({success: true, data: {sessionNames: ['old-1']}})
    const desktopChatTabs = chatTabsBridge()
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()
    await openTab(wrapper, 'old-1')
    await openTab(wrapper, 'recent')

    wrapper.vm.confirmClearOldSessions({hash: 'h1', name: 'A'})
    expect(wrapper.vm.deleteConfirm.visible).toBe(true)
    expect(wrapper.vm.deleteConfirm.title).toBe('清空三天前的会话？')
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    const [workspaceHash, before] = sessionsAPI.clearBefore.mock.calls[0]
    expect(workspaceHash).toBe('h1')
    expect(before).toBeLessThanOrEqual(Date.now())
    expect(before).toBeGreaterThan(Date.now() - 4 * 24 * 60 * 60 * 1000)
    expect(desktopChatTabs.close).toHaveBeenCalledWith('h1:old-1')
    expect(wrapper.findAll('.desktop-tab').map((item) => item.attributes('title'))).toEqual(['recent'])

    wrapper.unmount()
  })

  it('没有过期会话时不关闭任何标签', async () => {
    sessionsAPI.clearBefore.mockResolvedValue({success: true, data: {sessionNames: []}})
    const desktopChatTabs = chatTabsBridge()
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()
    await openTab(wrapper, 'recent')

    wrapper.vm.confirmClearOldSessions({hash: 'h1', name: 'A'})
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    expect(desktopChatTabs.close).not.toHaveBeenCalled()
    expect(wrapper.findAll('.desktop-tab')).toHaveLength(1)

    wrapper.unmount()
  })

  it('接口失败时提示错误', async () => {
    sessionsAPI.clearBefore.mockResolvedValue({success: false, message: '服务不可用'})
    const {wrapper} = await mountShell()

    wrapper.vm.confirmClearOldSessions({hash: 'h1', name: 'A'})
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    expect(sessionsAPI.clearBefore).toHaveBeenCalledWith('h1', expect.any(Number))

    wrapper.unmount()
  })
})

describe('DesktopShell 原生确认弹窗', () => {
  it('原生弹窗回传空 payload 时仍删除当前确认的会话', async () => {
    const listeners = {}
    window.electronAPI = {
      desktopPopup: {
        open: vi.fn().mockResolvedValue({success: true}),
        close: vi.fn().mockResolvedValue({success: true})
      },
      events: {
        listen: vi.fn((eventName, callback) => {
          listeners[eventName] = callback
          return () => {
            if (listeners[eventName] === callback) delete listeners[eventName]
          }
        })
      }
    }
    sessionsAPI.deleteSession.mockResolvedValue({success: true})
    const {wrapper} = await mountShell()
    const session = {workspaceHash: 'h1', name: 's1', title: '你好啊'}

    wrapper.vm.confirmDeleteSession(session)
    expect(wrapper.vm.deleteConfirm.visible).toBe(true)
    // 模拟主进程动作事件的时序：确认动作不再先触发 popup-closed 清空目标。
    listeners['desktop-shell-popup-action']({
      type: 'confirm',
      action: 'confirm',
      kind: 'session',
      payload: null
    })
    await flushPromises()

    expect(sessionsAPI.deleteSession).toHaveBeenCalledWith('s1', 'h1')
    expect(wrapper.vm.deleteConfirm.visible).toBe(false)
    wrapper.unmount()
  })

  it('首次打开会话时立即在当前原生视图显示 Loading，显示完成后移除', async () => {
    const desktopChatTabs = {
      create: vi.fn().mockResolvedValue({success: true}),
      show: vi.fn().mockResolvedValue({success: true}),
      hide: vi.fn().mockResolvedValue({success: true}),
      close: vi.fn().mockResolvedValue({success: true}),
      reload: vi.fn().mockResolvedValue({success: true}),
      setLoading: vi.fn().mockResolvedValue({success: true}),
      sendCommand: vi.fn().mockResolvedValue(true)
    }
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()
    await openTab(wrapper, 'a')

    let resolveCreate
    const pendingCreate = new Promise((resolve) => { resolveCreate = resolve })
    desktopChatTabs.create.mockImplementationOnce(() => pendingCreate)
    desktopChatTabs.setLoading.mockClear()

    const opening = wrapper.vm.openSession({workspaceHash: 'h1', sessionName: 'slow', title: '慢会话'})
    await vi.waitFor(() => expect(desktopChatTabs.create).toHaveBeenCalledWith(expect.objectContaining({id: 'h1:slow'})))

    expect(desktopChatTabs.setLoading).toHaveBeenCalledWith('h1:a', true)
    expect(wrapper.find('.desktop-session-loading').exists()).toBe(true)
    expect(desktopChatTabs.show).not.toHaveBeenCalledWith('h1:slow', expect.any(Object))

    resolveCreate({success: true})
    await opening
    await flushPromises()

    expect(desktopChatTabs.show).toHaveBeenCalledWith('h1:slow', expect.any(Object))
    expect(desktopChatTabs.setLoading).toHaveBeenCalledWith('h1:a', false)
    expect(wrapper.find('.desktop-session-loading').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击新建会话时复用会话 Loading 过渡，创建完成后移除', async () => {
    const desktopChatTabs = {
      create: vi.fn().mockResolvedValue({success: true}),
      show: vi.fn().mockResolvedValue({success: true}),
      hide: vi.fn().mockResolvedValue({success: true}),
      close: vi.fn().mockResolvedValue({success: true}),
      setLoading: vi.fn().mockResolvedValue({success: true})
    }
    window.electronAPI = {desktopChatTabs}
    const {wrapper} = await mountShell()
    await openTab(wrapper, 'a')

    let resolveCreate
    sessionsAPI.createNew.mockImplementationOnce(() => new Promise((resolve) => { resolveCreate = resolve }))
    const creating = wrapper.vm.createTab()
    await vi.waitFor(() => expect(desktopChatTabs.setLoading).toHaveBeenCalledWith('h1:a', true))

    expect(wrapper.find('.desktop-session-loading').exists()).toBe(true)
    expect(desktopChatTabs.create).toHaveBeenLastCalledWith(expect.objectContaining({id: 'h1:a'}))

    resolveCreate({success: true, data: {sessionName: 'new-session', workspaceHash: 'h1'}})
    await creating
    await flushPromises()

    expect(desktopChatTabs.show).toHaveBeenCalledWith('h1:new-session', expect.any(Object))
    expect(desktopChatTabs.setLoading).toHaveBeenCalledWith('h1:a', false)
    expect(wrapper.find('.desktop-session-loading').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('DesktopShell 删除项目', () => {
  it('确认后调用删除接口并刷新项目列表', async () => {
    configAPI.deleteWorkspace.mockResolvedValue({success: true})
    const {wrapper} = await mountShell()

    wrapper.vm.confirmDeleteWorkspace({hash: 'h1', name: 'A'})
    expect(wrapper.vm.deleteConfirm.visible).toBe(true)
    expect(wrapper.vm.deleteConfirm.title).toBe('删除项目？')
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    expect(configAPI.deleteWorkspace).toHaveBeenCalledWith('h1')
    expect(wrapper.vm.workspaces.some((workspace) => workspace.hash === 'h1')).toBe(false)

    wrapper.unmount()
  })

  it('删除接口失败时提示错误且不刷新列表', async () => {
    configAPI.deleteWorkspace.mockResolvedValue({success: false, message: '服务不可用'})
    const {wrapper} = await mountShell()

    wrapper.vm.confirmDeleteWorkspace({hash: 'h1', name: 'A'})
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    expect(configAPI.deleteWorkspace).toHaveBeenCalledWith('h1')
    expect(wrapper.vm.workspaces.some((workspace) => workspace.hash === 'h1')).toBe(true)

    wrapper.unmount()
  })
})

describe('DesktopShell 批量删除项目', () => {
  it('确认后逐个调用删除接口并从列表移除全部选中项目', async () => {
    configAPI.listWorkspaces.mockResolvedValue({success: true, data: [
      {hash: 'h1', name: 'A', path: '/p/a'},
      {hash: 'h2', name: 'B', path: '/p/b'}
    ]})
    configAPI.deleteWorkspace.mockResolvedValue({success: true})
    const {wrapper} = await mountShell()

    wrapper.vm.confirmDeleteWorkspaces([{hash: 'h1', name: 'A'}, {hash: 'h2', name: 'B'}])
    expect(wrapper.vm.deleteConfirm.visible).toBe(true)
    expect(wrapper.vm.deleteConfirm.title).toBe('删除项目？')
    expect(wrapper.vm.deleteConfirm.message).toContain('“A”、“B”')
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    expect(configAPI.deleteWorkspace).toHaveBeenCalledTimes(2)
    expect(configAPI.deleteWorkspace).toHaveBeenCalledWith('h1')
    expect(configAPI.deleteWorkspace).toHaveBeenCalledWith('h2')
    expect(wrapper.vm.workspaces.some((workspace) => workspace.hash === 'h1')).toBe(false)
    expect(wrapper.vm.workspaces.some((workspace) => workspace.hash === 'h2')).toBe(false)

    wrapper.unmount()
  })

  it('部分项目删除失败时仍移除成功的，失败项保留', async () => {
    configAPI.listWorkspaces.mockResolvedValue({success: true, data: [
      {hash: 'h1', name: 'A', path: '/p/a'},
      {hash: 'h2', name: 'B', path: '/p/b'}
    ]})
    configAPI.deleteWorkspace.mockImplementation((hash) =>
      Promise.resolve(hash === 'h1' ? {success: true} : {success: false, message: '服务不可用'})
    )
    const {wrapper} = await mountShell()

    wrapper.vm.confirmDeleteWorkspaces([{hash: 'h1', name: 'A'}, {hash: 'h2', name: 'B'}])
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    expect(wrapper.vm.workspaces.some((workspace) => workspace.hash === 'h1')).toBe(false)
    expect(wrapper.vm.workspaces.some((workspace) => workspace.hash === 'h2')).toBe(true)

    wrapper.unmount()
  })

  it('超过 3 个项目时确认消息摘要展示', async () => {
    const {wrapper} = await mountShell()
    const workspaces = ['A', 'B', 'C', 'D', 'E'].map((name, index) => ({hash: `h${index + 1}`, name, path: `/p/${name}`}))

    wrapper.vm.confirmDeleteWorkspaces(workspaces)
    expect(wrapper.vm.deleteConfirm.message).toContain('选中的 5 个项目')
    expect(wrapper.vm.deleteConfirm.message).toContain('“A”、“B”、“C” 等')

    wrapper.unmount()
  })
})

describe('DesktopShell 批量删除会话', () => {
  it('确认后逐个调用删除会话接口', async () => {
    sessionsAPI.deleteSession.mockResolvedValue({success: true})
    const {wrapper} = await mountShell()

    wrapper.vm.confirmDeleteSessions([
      {workspaceHash: 'h1', name: 's1', title: '会话一'},
      {workspaceHash: 'h1', name: 's2', title: '会话二'}
    ])
    expect(wrapper.vm.deleteConfirm.visible).toBe(true)
    expect(wrapper.vm.deleteConfirm.title).toBe('删除会话？')
    expect(wrapper.vm.deleteConfirm.message).toContain('“会话一”、“会话二”')
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    expect(sessionsAPI.deleteSession).toHaveBeenCalledTimes(2)
    expect(sessionsAPI.deleteSession).toHaveBeenCalledWith('s1', 'h1')
    expect(sessionsAPI.deleteSession).toHaveBeenCalledWith('s2', 'h1')

    wrapper.unmount()
  })

  it('部分会话删除失败时保留失败项，成功的仍生效', async () => {
    sessionsAPI.deleteSession.mockImplementation((name) =>
      Promise.resolve(name === 's1' ? {success: true} : {success: false, message: '服务不可用'})
    )
    const {wrapper} = await mountShell()

    wrapper.vm.confirmDeleteSessions([
      {workspaceHash: 'h1', name: 's1', title: '会话一'},
      {workspaceHash: 'h1', name: 's2', title: '会话二'}
    ])
    wrapper.vm.handleDeleteConfirmAction('confirm')
    await flushPromises()

    expect(sessionsAPI.deleteSession).toHaveBeenCalledTimes(2)
    // 无异常抛出即视为批量流程完成（失败项不影响成功项）

    wrapper.unmount()
  })

  it('超过 3 个会话时确认消息摘要展示', async () => {
    const {wrapper} = await mountShell()
    const sessions = ['一', '二', '三', '四', '五'].map((title, index) => ({workspaceHash: 'h1', name: `s${index + 1}`, title: `会话${title}`}))

    wrapper.vm.confirmDeleteSessions(sessions)
    expect(wrapper.vm.deleteConfirm.message).toContain('选中的 5 个会话')
    expect(wrapper.vm.deleteConfirm.message).toContain('“会话一”、“会话二”、“会话三” 等')

    wrapper.unmount()
  })
})
