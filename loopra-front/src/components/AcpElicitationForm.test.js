/* @vitest-environment jsdom */
import {mount, flushPromises} from '@vue/test-utils'
import {describe, expect, it, vi} from 'vitest'
import AcpElicitationForm from './AcpElicitationForm.vue'

const request = {elicitationRequestId: 'input-1', message: '午餐吃什么？', schema: {required: ['food'], properties: {
  food: {type: 'string', title: '选择午餐', oneOf: [{const: 'chicken', title: '黄焖鸡'}, {const: 'kfc', title: '肯德基'}]},
  note: {type: 'string', title: '补充说明', _meta: {codex: {role: 'user_note', questionId: 'food'}}}
}}}

describe('ACP form input', () => {
  it('keeps Claude Other on its question page and accepts a custom-only answer', async () => {
    const answer = vi.fn().mockResolvedValue(undefined)
    const questions = {...request, schema: {properties: {
      question_0: {type: 'string', title: '午饭', oneOf: [{const: '面食', title: '面食'}]},
      question_0_custom: {type: 'string', title: 'Other'},
      question_1: {type: 'array', title: '饮料', items: {anyOf: [{const: '茶', title: '茶'}]}},
      question_1_custom: {type: 'string', title: 'Other'}
    }}}
    const view = mount(AcpElicitationForm, {props: {request: questions, answer}})
    try {
      expect(view.text()).toContain('问题 1 / 2')
      await view.get('select').setValue('0')
      await view.get('textarea[aria-label="Other"]').setValue('少辣')
      await view.findAll('button').find(button => button.text().includes('下一题')).trigger('click')
      expect(view.text()).toContain('问题 2 / 2')
      await view.get('textarea[aria-label="Other"]').setValue('白水')
      await view.findAll('button').find(button => button.text().includes('上一题')).trigger('click')
      expect(view.get('select').element.value).toBe('0')
      expect(view.get('textarea').element.value).toBe('少辣')
      await view.findAll('button').find(button => button.text().includes('下一题')).trigger('click')
      await view.get('form').trigger('submit')
      expect(answer).toHaveBeenCalledWith(questions, 'accept', {question_0: '面食', question_0_custom: '少辣', question_1_custom: '白水'})
    } finally { view.unmount() }
  })
  it('switches questions while retaining the selection and submits every page together', async () => {
    const answer = vi.fn().mockResolvedValue(undefined)
    const questions = {...request, schema: {...request.schema, required: ['food', 'time'], properties: {
      ...request.schema.properties, time: {type: 'string', title: '时间', enum: ['15分钟', '30分钟']}
    }}}
    const view = mount(AcpElicitationForm, {props: {request: questions, answer}})
    await view.get('select').setValue('0')
    await view.get('textarea').setValue('少辣')
    await view.findAll('button').find(button => button.text().includes('下一题')).trigger('click')
    expect(view.text()).toContain('问题 2 / 2')
    expect(view.find('textarea').exists()).toBe(false)
    await view.get('select').setValue('1')
    await view.findAll('button').find(button => button.text().includes('上一题')).trigger('click')
    expect(view.get('select').element.value).toBe('0')
    expect(view.get('textarea').element.value).toBe('少辣')
    await view.findAll('button').find(button => button.text().includes('下一题')).trigger('click')
    await view.get('form').trigger('submit')
    expect(answer).toHaveBeenCalledWith(questions, 'accept', {food: 'chicken', note: '少辣', time: '30分钟'})
    view.unmount()
  })
  it('renders the options and submits the original value and note', async () => {
    const answer = vi.fn().mockResolvedValue(undefined)
    const view = mount(AcpElicitationForm, {props: {request, answer}})
    await view.get('select').setValue('0')
    await view.get('textarea').setValue('少辣')
    await view.get('form').trigger('submit')
    await flushPromises()
    expect(answer).toHaveBeenCalledWith(request, 'accept', {food: 'chicken', note: '少辣'})
    view.unmount()
  })
  it('validates required answers and allows skipping', async () => {
    const answer = vi.fn().mockResolvedValue(undefined)
    const view = mount(AcpElicitationForm, {props: {request, answer}})
    await view.get('form').trigger('submit')
    expect(answer).not.toHaveBeenCalled()
    expect(view.get('[role=alert]').text()).toContain('选择午餐')
    await view.get('button[type=button]').trigger('click')
    expect(answer).toHaveBeenCalledWith(request, 'decline', {})
    view.unmount()
  })
  it('keeps a failed request available for retry', async () => {
    const answer = vi.fn().mockRejectedValue(new Error('网络错误'))
    const view = mount(AcpElicitationForm, {props: {request, answer}})
    await view.get('select').setValue('1')
    await view.get('form').trigger('submit')
    await flushPromises()
    expect(view.get('[role=alert]').text()).toBe('网络错误')
    expect(view.get('button[type=submit]').attributes('disabled')).toBeUndefined()
    view.unmount()
  })
})
