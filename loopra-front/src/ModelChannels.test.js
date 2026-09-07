/* @vitest-environment jsdom */

import {flushPromises, shallowMount} from '@vue/test-utils'
import {describe, expect, it, vi} from 'vitest'
import ModelChannels from './ModelChannels.vue'
import {configAPI} from './services/api'

vi.mock('./stores/app', () => ({
  useAppStore: () => ({settings: {theme: 'gray'}})
}))

vi.mock('ant-design-vue', () => ({
  message: {error: vi.fn(), success: vi.fn(), warning: vi.fn()}
}))

vi.mock('./services/api', () => ({
  configAPI: {
    getConfig: vi.fn().mockResolvedValue({
      success: true,
      data: {
        model: 'main-large',
        modelChannelId: 'main',
        validationModel: 'guard-mini',
        validationModelChannelId: 'guard',
        imageUnderstandingModel: 'main-large',
        imageUnderstandingModelChannelId: 'main',
        modelChannels: [
          {
            id: 'main',
            name: 'Main',
            baseUrl: 'https://main.test/v1',
            apiKey: '****',
            models: [{name: 'main-large', imageInput: true, maxTokens: 65536}]
          },
          {
            id: 'guard',
            name: 'Guard',
            baseUrl: 'https://guard.test/v1',
            apiKey: '****',
            models: [{name: 'guard-mini', imageInput: true}]
          }
        ]
      }
    }),
    updateConfig: vi.fn().mockResolvedValue({success: true}),
    probeRemoteModels: vi.fn()
  }
}))

describe('ModelChannels validation model', () => {
  it('requires confirmation before dismissing the first-use notice', async () => {
    const requiredWrapper = shallowMount(ModelChannels, {props: {setupRequired: true}})
    await flushPromises()

    expect(requiredWrapper.find('.model-channels-setup-notice').text()).toContain('首次使用需要完成模型配置')
    await requiredWrapper.find('.model-channels-setup-overlay').trigger('click')
    expect(requiredWrapper.find('.model-channels-setup-notice').exists()).toBe(true)

    await requiredWrapper.find('.model-channels-setup-confirm').trigger('click')
    expect(requiredWrapper.find('.model-channels-setup-notice').exists()).toBe(false)
    requiredWrapper.unmount()

    const regularWrapper = shallowMount(ModelChannels)
    await flushPromises()
    expect(regularWrapper.find('.model-channels-setup-notice').exists()).toBe(false)
    regularWrapper.unmount()
  })

  it('loads and saves a model selected from another channel', async () => {
    const wrapper = shallowMount(ModelChannels)
    await flushPromises()

    const select = wrapper.find('.model-validator select')
    expect(select.element.value).toBe(JSON.stringify(['guard', 'guard-mini']))

    await wrapper.find('.model-channels-save').trigger('click')
    await flushPromises()

    expect(configAPI.updateConfig).toHaveBeenCalledWith(expect.objectContaining({
      validationModel: 'guard-mini',
      validationModelChannelId: 'guard',
      imageUnderstandingModel: 'main-large',
      imageUnderstandingModelChannelId: 'main',
      modelChannels: expect.arrayContaining([
        expect.objectContaining({
          id: 'main',
          specialCompatibility: '',
          models: expect.arrayContaining([
            expect.objectContaining({name: 'main-large', maxTokens: 65536})
          ])
        })
      ])
    }))
    wrapper.unmount()
  })

  it('offers OpenCode as a separate optional compatibility', async () => {
    const wrapper = shallowMount(ModelChannels)
    await flushPromises()

    const selects = wrapper.findAll('.model-channel-fields select')
    const protocolSelect = selects[0]
    const compatibilitySelect = selects[1]
    expect(protocolSelect.find('option[value="opencode"]').exists()).toBe(false)
    expect(protocolSelect.findAll('option')).toHaveLength(3)
    expect(compatibilitySelect.find('option[value="opencode"]').text()).toBe('OpenCode 兼容')
    expect(compatibilitySelect.element.value).toBe('')

    await wrapper.find('.model-channel-add').trigger('click')
    expect(wrapper.findAll('.model-channel-fields select')[0].element.value).toBe('chat_completions')
    expect(wrapper.findAll('.model-channel-fields select')[1].element.value).toBe('')
    wrapper.unmount()
  })

  it('loads and saves a separately selected image understanding model', async () => {
    const wrapper = shallowMount(ModelChannels)
    await flushPromises()

    const selects = wrapper.findAll('.model-validator select')
    expect(selects).toHaveLength(2)
    expect(selects[1].element.value).toBe(JSON.stringify(['main', 'main-large']))
    await selects[1].setValue(JSON.stringify(['guard', 'guard-mini']))
    await wrapper.find('.model-channels-save').trigger('click')
    await flushPromises()

    expect(configAPI.updateConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      imageUnderstandingModel: 'guard-mini',
      imageUnderstandingModelChannelId: 'guard'
    }))
    wrapper.unmount()
  })

  it('keeps validation enabled when the selected model is renamed', async () => {
    const wrapper = shallowMount(ModelChannels)
    await flushPromises()

    await wrapper.findAll('.model-channel-toggle')[1].trigger('click')
    await wrapper.findAll('.model-config-toggle')[0].trigger('click')
    const modelName = wrapper.find('.model-config-main input[type="text"]')
    await modelName.setValue('guard-mini-v2')
    await modelName.trigger('change')
    await wrapper.find('.model-channels-save').trigger('click')
    await flushPromises()

    expect(configAPI.updateConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      validationModel: 'guard-mini-v2',
      validationModelChannelId: 'guard'
    }))
    wrapper.unmount()
  })

  it('persists empty values when validation is disabled', async () => {
    const wrapper = shallowMount(ModelChannels)
    await flushPromises()

    await wrapper.find('.model-validator select').setValue('')
    await wrapper.find('.model-channels-save').trigger('click')
    await flushPromises()

    expect(configAPI.updateConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      validationModel: '',
      validationModelChannelId: ''
    }))
    wrapper.unmount()
  })
})
