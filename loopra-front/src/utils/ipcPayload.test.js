import {isProxy, reactive, ref} from 'vue'
import {describe, expect, it} from 'vitest'
import {toPlainIpcValue} from './ipcPayload'

describe('toPlainIpcValue', () => {
  it('递归移除 Vue Proxy 并保留弹窗上下文数据', () => {
    const source = ref({
      type: 'confirm',
      payload: reactive({
        workspaceHash: 'h1',
        sessions: [{name: 's1'}]
      })
    })

    const plain = toPlainIpcValue(source.value)

    expect(plain).toEqual({
      type: 'confirm',
      payload: {workspaceHash: 'h1', sessions: [{name: 's1'}]}
    })
    expect(isProxy(plain)).toBe(false)
    expect(isProxy(plain.payload)).toBe(false)
    expect(isProxy(plain.payload.sessions)).toBe(false)
    expect(isProxy(plain.payload.sessions[0])).toBe(false)
  })
})
