/* @vitest-environment jsdom */

import {flushPromises, mount} from '@vue/test-utils'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {isProxy} from 'vue'
import DesktopPopup from './DesktopPopup.vue'

const initialElectronAPI = window.electronAPI

afterEach(() => {
  if (initialElectronAPI === undefined) delete window.electronAPI
  else window.electronAPI = initialElectronAPI
})

function mountPopup() {
  const listeners = {}
  const desktopPopup = {
    ready: vi.fn(),
    closeEvent: vi.fn(),
    actionEvent: vi.fn(),
    close: vi.fn(),
    action: vi.fn()
  }
  window.electronAPI = {
    desktopPopup,
    events: {
      listen: vi.fn((eventName, callback) => {
        listeners[eventName] = callback
        return () => delete listeners[eventName]
      })
    }
  }
  const wrapper = mount(DesktopPopup, {
    global: {
      stubs: {ServiceProcessManager: true}
    }
  })
  return {wrapper, listeners, desktopPopup}
}

describe('DesktopPopup 原生浮层动作', () => {
  it('确认弹窗的取消和确定都通过事件通道回传', async () => {
    const {wrapper, listeners, desktopPopup} = mountPopup()
    expect(desktopPopup.ready).toHaveBeenCalledTimes(1)
    listeners['desktop-popup-context']({
      type: 'confirm',
      kind: 'session',
      title: '删除会话？',
      message: '会话将被永久删除。',
      payload: {workspaceHash: 'h1', sessionName: 's1'},
      actions: [
        {key: 'cancel', label: '取消'},
        {key: 'confirm', label: '删除', variant: 'danger'}
      ]
    })
    await flushPromises()

    const buttons = wrapper.findAll('.desktop-popup-confirm-button')
    await buttons[0].trigger('click')
    expect(isProxy(desktopPopup.actionEvent.mock.calls[0][0])).toBe(false)
    expect(isProxy(desktopPopup.actionEvent.mock.calls[0][0].payload)).toBe(false)
    expect(desktopPopup.actionEvent).toHaveBeenCalledWith({
      type: 'confirm',
      action: 'cancel',
      kind: 'session',
      payload: {workspaceHash: 'h1', sessionName: 's1'}
    })

    await buttons[1].trigger('click')
    expect(desktopPopup.actionEvent).toHaveBeenCalledWith({
      type: 'confirm',
      action: 'confirm',
      kind: 'session',
      payload: {workspaceHash: 'h1', sessionName: 's1'}
    })
    expect(desktopPopup.action).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('重命名的取消、确定分别关闭并回传动作', async () => {
    const {wrapper, listeners, desktopPopup} = mountPopup()
    listeners['desktop-popup-context']({
      type: 'rename-session',
      item: {workspaceHash: 'h1', name: 's1', title: '旧名称'},
      value: '旧名称'
    })
    await flushPromises()

    await wrapper.find('.desktop-popup-cancel').trigger('click')
    expect(desktopPopup.closeEvent).toHaveBeenCalledTimes(1)

    await wrapper.find('input').setValue('新名称')
    await wrapper.find('.desktop-popup-primary').trigger('click')
    expect(isProxy(desktopPopup.actionEvent.mock.calls[0][0])).toBe(false)
    expect(isProxy(desktopPopup.actionEvent.mock.calls[0][0].item)).toBe(false)
    expect(desktopPopup.actionEvent).toHaveBeenCalledWith({
      type: 'rename-session',
      action: 'confirm',
      value: '新名称',
      item: {workspaceHash: 'h1', name: 's1', title: '旧名称'}
    })
    expect(desktopPopup.action).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
