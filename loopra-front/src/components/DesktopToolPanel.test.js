/* @vitest-environment jsdom */

import {flushPromises, shallowMount} from '@vue/test-utils'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {nextTick} from 'vue'
import DesktopToolPanel from './DesktopToolPanel.vue'

const initialElectronAPI = window.electronAPI

beforeEach(() => {
  localStorage.clear()
  window.electronAPI = {
    events: {listen: vi.fn(() => () => {})}
  }
})

afterEach(() => {
  if (initialElectronAPI === undefined) delete window.electronAPI
  else window.electronAPI = initialElectronAPI
})

function mountPanel(props = {}) {
  return shallowMount(DesktopToolPanel, {
    props: {open: false, modelValue: 'launcher', ...props},
    global: {
      stubs: {
        FileExplorer: true,
        EnvironmentPanel: true,
        SubAgentPanel: true,
        ProjectCapabilitiesPanel: true,
        SchedulePanel: true,
        BashSessionManager: true,
        TerminalView: true
      }
    }
  })
}

describe('DesktopToolPanel', () => {
  it('opens the files tab by default when an empty panel is opened', async () => {
    const wrapper = mountPanel()

    expect(wrapper.vm.openTabs).toHaveLength(0)

    await wrapper.setProps({open: true})
    await nextTick()

    expect(wrapper.vm.openTabs.map((tab) => tab.id)).toEqual(['files'])
    expect(wrapper.vm.activeTabId).toBe('files')
    expect(wrapper.find('.desktop-tool-empty').exists()).toBe(false)
  })

  it('opens a choice menu from the plus button', async () => {
    const wrapper = mountPanel({open: true})

    expect(wrapper.find('.desktop-tool-rail').exists()).toBe(false)
    expect(wrapper.find('.desktop-tool-tabs').text()).toContain('文件')
    expect(wrapper.find('.desktop-tool-add-menu').exists()).toBe(false)

    await wrapper.find('.desktop-tool-add-button').trigger('click')
    expect(wrapper.find('.desktop-tool-add-menu').exists()).toBe(true)
    expect(wrapper.findAll('.desktop-tool-add-item')).toHaveLength(8)
    expect(wrapper.find('.desktop-tool-add-menu').text()).toContain('终端')
    expect(wrapper.find('.desktop-tool-add-menu').text()).toContain('文件')
    expect(wrapper.find('.desktop-tool-add-menu').text()).not.toContain('浏览器')
  })

  it('uses the native tool menu when Electron provides it', async () => {
    const openNativeMenu = vi.fn().mockResolvedValue('files')
    window.electronAPI.desktopToolMenu = {open: openNativeMenu}
    const wrapper = mountPanel({open: false})

    await wrapper.find('.desktop-tool-add-button').trigger('click')
    await flushPromises()

    expect(openNativeMenu).toHaveBeenCalledWith('')
    expect(wrapper.find('.desktop-tool-add-menu').exists()).toBe(false)
    expect(wrapper.vm.openTabs.map((tab) => tab.id)).toEqual(['files'])
    expect(wrapper.vm.activeTabId).toBe('files')
  })

  it('opens tools as independent closable tabs', async () => {
    const wrapper = mountPanel()

    wrapper.vm.openTool('files')
    wrapper.vm.openTool('schedule')
    await nextTick()

    expect(wrapper.vm.openTabs.map((tab) => tab.id)).toEqual(['files', 'schedule'])
    expect(wrapper.vm.activeTabId).toBe('schedule')
    expect(wrapper.findAll('.desktop-tool-tab')).toHaveLength(2)
    expect(wrapper.find('.desktop-tool-tabs').text()).toContain('文件')
    expect(wrapper.find('.desktop-tool-tabs').text()).toContain('定时任务')

    await wrapper.find('.desktop-tool-tab[title="文件"] .desktop-tool-tab-close').trigger('click')
    expect(wrapper.vm.openTabs.map((tab) => tab.id)).toEqual(['schedule'])
    expect(wrapper.vm.activeTabId).toBe('schedule')
  })

  it('does not duplicate a tool when it is selected again', async () => {
    const wrapper = mountPanel()

    wrapper.vm.openTool('files')
    wrapper.vm.openTool('files')
    await nextTick()

    expect(wrapper.vm.openTabs).toHaveLength(1)
    expect(wrapper.emitted('update:modelValue')).toEqual([['files'], ['files']])
  })

})
