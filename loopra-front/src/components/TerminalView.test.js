/* @vitest-environment jsdom */

import {flushPromises, mount} from '@vue/test-utils'
import {nextTick} from 'vue'
import {createPinia} from 'pinia'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import TerminalView from './TerminalView.vue'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    onData() {}
    refresh() {}
    dispose() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  }
}))

const initialElectronAPI = window.electronAPI
const originalInnerWidth = window.innerWidth
const originalInnerHeight = window.innerHeight

const terminalAPI = {
  create: vi.fn(),
  listShells: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn())
}

function mockRect({left, top, width, height}) {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  }
}

beforeEach(() => {
  terminalAPI.listShells.mockResolvedValue([
    {id: 'powershell', name: 'PowerShell'},
    {id: 'pwsh', name: 'PowerShell 7 (pwsh)'}
  ])
  terminalAPI.create.mockResolvedValue({id: 'pty-1', pid: 1234})
  terminalAPI.kill.mockResolvedValue({success: true})
  terminalAPI.onData.mockReturnValue(vi.fn())
  terminalAPI.onExit.mockReturnValue(vi.fn())
  window.electronAPI = {terminal: terminalAPI}
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: 320})
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: 200})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.querySelector('.terminal-shell-menu')?.remove()
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: originalInnerWidth})
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: originalInnerHeight})
  if (initialElectronAPI === undefined) delete window.electronAPI
  else window.electronAPI = initialElectronAPI
})

describe('TerminalView Shell 菜单', () => {
  it('keeps horizontal bottom-panel height resizable', async () => {
    Object.defineProperty(window, 'innerHeight', {configurable: true, value: 400})
    const wrapper = mount(TerminalView, {
      props: {open: true},
      global: {plugins: [createPinia()]}
    })
    await flushPromises()

    expect(wrapper.find('.terminal-panel').classes()).not.toContain('vertical')
    expect(wrapper.find('.terminal-panel').attributes('style')).toContain('height: 187px')

    await wrapper.find('.terminal-resize-handle').trigger('mousedown', {clientY: 100})
    window.dispatchEvent(new MouseEvent('mousemove', {clientY: 80}))
    await nextTick()
    expect(wrapper.find('.terminal-panel').attributes('style')).toContain('height: 207px')

    window.dispatchEvent(new MouseEvent('mouseup', {clientY: 80}))
    wrapper.unmount()
  })

  it('靠近视口左下角时完整显示并向上展开', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('terminal-tab-add')) {
        return mockRect({left: 8, top: 160, width: 24, height: 24})
      }
      if (this.classList.contains('terminal-shell-menu')) {
        return mockRect({left: 0, top: 0, width: 150, height: 100})
      }
      return mockRect({left: 0, top: 0, width: 0, height: 0})
    })

    const wrapper = mount(TerminalView, {
      props: {open: false},
      global: {plugins: [createPinia()]}
    })
    await flushPromises()

    await wrapper.find('.terminal-tab-add').trigger('click')
    await flushPromises()

    const menu = document.body.querySelector('.terminal-shell-menu')
    expect(menu).not.toBeNull()
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.left).toBe('8px')
    expect(menu.style.top).toBe('56px')
    expect(menu.textContent).toContain('PowerShell 7 (pwsh)')

    wrapper.unmount()
  })
})
