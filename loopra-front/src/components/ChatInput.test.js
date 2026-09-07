/* @vitest-environment jsdom */

import {flushPromises, shallowMount} from '@vue/test-utils'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {message} from 'ant-design-vue'
import {getDocument} from 'pdfjs-dist'
import {extractRawText} from 'mammoth/mammoth.browser'
import {read as xlsxRead, utils as xlsxUtils} from 'xlsx'
import {configAPI, filesAPI, promptPresetsAPI} from '../services/api'
import ChatInput from './ChatInput.vue'

Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: vi.fn()
})

// jsdom 的 File 未实现 arrayBuffer()，补一个基于 FileReader 的实现（与真实浏览器行为一致）
if (typeof File !== 'undefined' && !File.prototype.arrayBuffer) {
  File.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('FileReader error'))
      reader.readAsArrayBuffer(this)
    })
  }
}

vi.mock('ant-design-vue', () => ({
  message: {info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn()}
}))

vi.mock('pdfjs-dist', () => ({
  // workerPort 预设非空，避免测试中触发 ?worker 动态导入
  GlobalWorkerOptions: {workerPort: {}, workerSrc: ''},
  getDocument: vi.fn()
}))

vi.mock('mammoth/mammoth.browser', () => ({
  extractRawText: vi.fn()
}))

vi.mock('xlsx', () => ({
  read: vi.fn(),
  utils: {sheet_to_csv: vi.fn()}
}))

vi.mock('../stores/app', () => ({
  useAppStore: () => ({desktopPetVisible: false, isDesktopEnv: false, activePetName: '', petHidden: false, setPetHidden: vi.fn()})
}))

vi.mock('../services/api', () => ({
  agentAPI: {
    getCommands: vi.fn().mockResolvedValue({success: true, data: []}),
    getSkills: vi.fn().mockResolvedValue({success: true, data: []})
  },
  configAPI: {
    listWorkspaces: vi.fn().mockResolvedValue({success: true, data: []})
  },
  filesAPI: {
    search: vi.fn().mockResolvedValue({success: true, data: []}),
    remove: vi.fn().mockResolvedValue({success: true}),
    savePaste: vi.fn().mockResolvedValue({
      success: true,
      data: {name: 'paste-test.txt', path: '.loopra/paste/paste-test.txt', chars: 32769, bytes: 32769}
    })
  },
  petAPI: {
    getInfo: vi.fn().mockResolvedValue({data: null}),
    resolveUrl: vi.fn((url) => url),
    savePosition: vi.fn().mockResolvedValue({success: true})
  },
  promptPresetsAPI: {
    list: vi.fn().mockResolvedValue({
      success: true,
      data: [
        {id: 'quick-test', label: '要求测试', text: '请先运行与本次修改相关的测试，确认通过后再报告结果。'}
      ]
    }),
    save: vi.fn().mockResolvedValue({success: true})
  }
}))

function mountInput(props) {
  return shallowMount(ChatInput, {
    props: {
      currentModel: 'gpt-5.6-terra',
      defaultModel: 'gpt-5.6-terra',
      defaultModelChannelId: 'bearjia',
      availableModels: [
        {name: 'gpt-5.6-terra', channelId: 'bearjia', channelName: 'bearjia', active: true},
        {name: 'gpt-image-1', channelId: 'bearjia', channelName: 'bearjia', active: false}
      ],
      ...props
    },
    global: {stubs: {PetSprite: true, ChecklistSteps: true}}
  })
}

describe('ChatInput quick commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the preset list empty when no presets can be loaded', async () => {
    promptPresetsAPI.list.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountInput()

    expect(promptPresetsAPI.list).not.toHaveBeenCalled()
    await wrapper.find('.quick-command-trigger').trigger('click')
    await flushPromises()

    expect(wrapper.find('.quick-command-list').exists()).toBe(false)
    expect(wrapper.find('.quick-command-empty').text()).toBe('还没有常用要求')
    wrapper.unmount()
  })

  it('appends a preset command to the input', async () => {
    const wrapper = mountInput({inputText: '已有内容'})

    expect(promptPresetsAPI.list).not.toHaveBeenCalled()
    await wrapper.find('.quick-command-trigger').trigger('click')
    await flushPromises()
    await wrapper.find('.quick-command-copy').trigger('click')

    expect(wrapper.find('.input-row textarea').element.value).toBe(
      '已有内容\n请先运行与本次修改相关的测试，确认通过后再报告结果。'
    )
    expect(wrapper.emitted('update:inputText').at(-1)).toEqual([
      '已有内容\n请先运行与本次修改相关的测试，确认通过后再报告结果。'
    ])
    wrapper.unmount()
  })

  it('persists a newly added preset', async () => {
    const wrapper = mountInput()
    await wrapper.find('.quick-command-trigger').trigger('click')
    await wrapper.find('.quick-command-add').trigger('click')
    const fields = wrapper.findAll('.quick-command-form input, .quick-command-form textarea')
    await fields[0].setValue('检查状态')
    await fields[1].setValue('请检查当前状态并报告结果')
    await wrapper.find('.quick-command-form').trigger('submit')

    expect(promptPresetsAPI.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({label: '检查状态', text: '请检查当前状态并报告结果'})
      ])
    )
    wrapper.unmount()
  })
})

describe('ChatInput linked projects', () => {
  beforeEach(() => {
    configAPI.listWorkspaces.mockResolvedValue({
      success: true,
      data: [
        {hash: 'primary', name: 'primary-app', path: 'C:/code/primary'},
        {hash: 'backend', name: 'backend-service', path: 'C:/code/backend'}
      ]
    })
  })

  it('excludes the current project and sends selected hashes as structured context', async () => {
    const wrapper = mountInput({workspaceHash: 'primary', inputText: '检查接口联动'})
    await wrapper.find('.project-tools-branch').trigger('mouseenter')
    await flushPromises()

    const projects = wrapper.findAll('.project-tools-nested .skill-panel-item')
    expect(projects).toHaveLength(1)
    expect(projects[0].text()).toContain('backend-service')

    await projects[0].trigger('click')
    expect(wrapper.find('.project-chips-bar').text()).toContain('backend-service')
    await wrapper.find('.send-btn').trigger('click')

    const [, text, hashes] = wrapper.emitted('send')[0]
    expect(text).toContain('关联项目：')
    expect(text).toContain('backend-service')
    expect(text).toContain('hash: backend')
    expect(text).toContain('根目录: C:/code/backend')
    expect(hashes).toEqual(['backend'])
    expect(wrapper.find('.project-chips-bar').exists()).toBe(false)
  })
})

describe('ChatInput plan mode', () => {
  it('groups upload and plan mode under one secondary tools menu', async () => {
    const wrapper = mountInput({workspaceHash: 'workspace-1', welcomeMode: true})
    const menu = wrapper.find('.composer-tools-menu')

    expect(menu.findAll(':scope > .composer-tools-trigger')).toHaveLength(1)
    expect(menu.find('.composer-tools-submenu').attributes('role')).toBe('menu')
    expect(menu.findAll('.composer-tools-primary')).toHaveLength(5)
    expect(menu.text()).toContain('上传文件')
    expect(menu.text()).toContain('计划模式')
    expect(menu.text()).toContain('关联项目')
    expect(menu.text()).toContain('技能')
    expect(menu.text()).toContain('权限模式')
    expect(wrapper.find('.model-actions .project-selector').exists()).toBe(false)
    expect(wrapper.find('.model-actions .skill-selector').exists()).toBe(false)
    expect(wrapper.find('.model-actions .permission-hitl-selector').exists()).toBe(false)

    const fileInput = wrapper.find('.upload-file-input').element
    const click = vi.spyOn(fileInput, 'click')
    await menu.find('.composer-upload-action').trigger('click')
    expect(click).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('switches permission from the nested tools menu', async () => {
    const wrapper = mountInput({workspaceHash: 'workspace-1', currentPermission: 'free'})
    const options = wrapper.findAll('.permission-tools-option')
    expect(options).toHaveLength(3)
    expect(options[0].attributes('aria-checked')).toBe('true')

    await options[1].trigger('click')
    expect(wrapper.emitted('switchPermission')).toEqual([['approval']])
    wrapper.unmount()
  })

  it('allows plan mode before a session exists when a workspace is selected', async () => {
    const wrapper = mountInput({workspaceHash: 'workspace-1', welcomeMode: true})

    expect(wrapper.find('.composer-plan-action').attributes('disabled')).toBeUndefined()
    await wrapper.find('.composer-plan-action').trigger('click')
    expect(wrapper.emitted('togglePlan')).toEqual([[]])
    wrapper.unmount()
  })

  it('emits a UI event without inserting a slash command', async () => {
    const wrapper = mountInput({sessionName: 'session-1', planMode: true})
    await wrapper.find('.composer-plan-action').trigger('click')

    expect(wrapper.emitted('togglePlan')).toEqual([[]])
    expect(wrapper.find('.input-row textarea').element.value).toBe('')
    expect(wrapper.find('.composer-plan-action').attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })
  it('keeps input and send available while the session task is running but locks plan controls', async () => {
    const wrapper = mountInput({
      inputText: '不要重复发送',
      sessionName: 'session-1',
      sessionRunning: true,
      sessionBusy: true
    })

    // 输入区永不禁用：后台运行中也允许输入并发送（Chat.vue 侧自动排队）
    expect(wrapper.find('textarea').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.composer-plan-action').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.continue-btn').exists()).toBe(false)
    expect(wrapper.find('.stop-btn').exists()).toBe(true)

    await wrapper.find('.send-btn').trigger('click')
    expect(wrapper.emitted('send')).toBeDefined()
    wrapper.unmount()
  })

  it('allows stopping a remotely running session after a stop request is sent', async () => {
    const wrapper = mountInput({
      sessionName: 'session-1',
      sessionRunning: true,
      sessionBusy: true,
      sessionStatusStopping: true
    })

    expect(wrapper.find('.stop-btn').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.stop-btn').attributes('title')).toContain('正在停止')
    wrapper.unmount()
  })
})

describe('ChatInput reasoning effort', () => {
  it('emits the selected reasoning effort', async () => {
    const wrapper = mountInput({currentReasoningEffort: 'max'})

    await wrapper.find('.model-actions > .reasoning-effort-selector .effort-btn').trigger('click')
    await wrapper.findAll('.chat-reasoning-levels button')[1].trigger('click')

    expect(wrapper.emitted('switchReasoningEffort')).toEqual([['low']])
    wrapper.unmount()
  })

  it('clears the custom effort once the slider is dragged', async () => {
    const wrapper = mountInput({currentReasoningEffort: 'max'})

    await wrapper.find('.model-actions > .reasoning-effort-selector .effort-btn').trigger('click')
    const customInput = wrapper.find('.chat-reasoning-custom input')
    await customInput.setValue('xhigh2')
    expect(wrapper.find('.chat-reasoning-value').text()).toContain('自定义')

    const slider = wrapper.find('.chat-reasoning-input')
    slider.element.value = '4'
    await slider.trigger('input')
    expect(wrapper.find('.chat-reasoning-value').text()).toContain('超高')

    await slider.trigger('change')
    expect(wrapper.emitted('switchReasoningEffort')).toEqual([['xhigh']])
    wrapper.unmount()
  })
})

describe('ChatInput fast mode', () => {
  it('emits fast mode toggle', async () => {
    const wrapper = mountInput({fastMode: false})

    await wrapper.find('.model-actions > .reasoning-effort-selector .effort-btn').trigger('click')
    const fastModeToggle = wrapper.findAll('.chat-reasoning-end-toggle')[1]
    expect(fastModeToggle.text()).toContain('快速模式')
    await fastModeToggle.find('input').setValue(true)

    expect(wrapper.emitted('switchFastMode')).toEqual([[true]])
    wrapper.unmount()
  })
})

describe('ChatInput default model actions', () => {
  it('renders queued messages behind a compact summary and preserves queue actions', async () => {
    const wrapper = mountInput({
      queuedMessages: [{id: 'queued-1', text: '继续处理当前任务'}]
    })

    expect(wrapper.find('.composer-queue-summary').text()).toBe('排队消息 1 条')
    expect(wrapper.find('.composer-queue-items-content').exists()).toBe(true)

    await wrapper.find('.composer-queue-guide').trigger('click')
    expect(wrapper.emitted('guideQueued')).toEqual([['queued-1']])

    await wrapper.find('.composer-queue-remove').trigger('click')
    expect(wrapper.emitted('removeQueued')).toEqual([['queued-1']])
    wrapper.unmount()
  })

  it('emits the selected row model and channel when setting a default model', async () => {
    const wrapper = mountInput()

    await wrapper.find('.model-btn').trigger('click')
    const buttons = wrapper.findAll('.model-default-action')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].attributes('disabled')).toBeDefined()

    await buttons[1].trigger('click')
    expect(wrapper.emitted('setDefaultModel')).toEqual([['gpt-image-1', 'bearjia']])
    wrapper.unmount()
  })
})

describe('ChatInput file upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  const selectFiles = async (wrapper, files) => {
    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', {configurable: true, value: files})
    await input.trigger('change')
    // FileReader 回调需要数个 event loop tick 才能完成
    for (let i = 0; i < 5; i++) {
      await tick()
      await flushPromises()
    }
  }

  it('parses a text file into a collapsible block and appends it to the message', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    await selectFiles(wrapper, [new File(['文件内容 Hello'], 'note.txt', {type: 'text/plain'})])

    expect(wrapper.find('.upload-chip').exists()).toBe(true)
    expect(wrapper.find('.upload-chip').text()).toContain('note.txt')

    await wrapper.find('textarea').setValue('请阅读这个文件')
    await wrapper.find('.send-btn').trigger('click')

    const sends = wrapper.emitted('send')
    expect(sends).toHaveLength(1)
    const [images, text] = sends[0]
    expect(images).toEqual([])
    expect(text).toContain('```折叠块')
    expect(text).toContain('上传文件：')
    expect(text).toContain('note.txt')
    expect(text).toContain('文件内容 Hello')
    expect(text).toContain('请阅读这个文件')
    // 发送后清空上传文件
    expect(wrapper.find('.upload-chip').exists()).toBe(false)
    wrapper.unmount()
  })

  it('disables sending while files are being parsed and restores it afterwards', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    let resolvePdf
    getDocument.mockReturnValueOnce({promise: new Promise((resolve) => { resolvePdf = resolve }) })

    await selectFiles(wrapper, [new File(['%PDF-1.4'], 'doc.pdf', {type: 'application/pdf'})])

    // 解析中：chip 显示解析状态、等待动画提示、发送按钮禁用
    expect(wrapper.find('.upload-chip-parsing').exists()).toBe(true)
    expect(wrapper.find('.upload-parsing-hint').exists()).toBe(true)
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeDefined()

    // Enter 发送也被 handleSend 守卫拦截
    await wrapper.find('textarea').setValue('请解析')
    await wrapper.find('textarea').trigger('keydown', {key: 'Enter', shiftKey: false})
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(message.info).toHaveBeenCalledWith('文件解析中，请稍候…')

    // 解析完成后恢复发送
    const mockPage = {getTextContent: vi.fn().mockResolvedValue({items: [{str: 'PDF 文本内容'}]})}
    resolvePdf({numPages: 1, getPage: vi.fn().mockResolvedValue(mockPage), destroy: vi.fn()})
    await flushPromises()

    expect(wrapper.find('.upload-chip-parsing').exists()).toBe(false)
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeUndefined()
    await wrapper.find('.send-btn').trigger('click')
    const text = wrapper.emitted('send')[0][1]
    expect(text).toContain('PDF 文本内容')
    wrapper.unmount()
  })

  it('routes image files to the base64 image channel', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    await selectFiles(wrapper, [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'pic.png', {type: 'image/png'})])

    expect(wrapper.find('.image-preview-item').exists()).toBe(true)
    expect(wrapper.find('.upload-chip').exists()).toBe(false)

    await wrapper.find('textarea').setValue('看看这张图')
    await wrapper.find('.send-btn').trigger('click')
    const [images, text] = wrapper.emitted('send')[0]
    expect(images).toHaveLength(1)
    expect(images[0]).toContain('data:image/png;base64')
    expect(text).not.toContain('上传文件：')
    wrapper.unmount()
  })

  it('parses docx files via mammoth', async () => {
    extractRawText.mockResolvedValue({value: 'Word 文档内容'})
    const wrapper = mountInput({sessionName: 'session-1'})
    await selectFiles(wrapper, [
      new File(['zip'], 'report.docx', {type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})
    ])

    expect(extractRawText).toHaveBeenCalledWith({arrayBuffer: expect.any(ArrayBuffer)})
    expect(wrapper.find('.upload-chip').text()).toContain('report.docx')

    await wrapper.find('textarea').setValue('读取')
    await wrapper.find('.send-btn').trigger('click')
    expect(wrapper.emitted('send')[0][1]).toContain('Word 文档内容')
    wrapper.unmount()
  })

  it('parses xlsx files via SheetJS and includes sheet names', async () => {
    xlsxRead.mockReturnValue({SheetNames: ['Sheet1'], Sheets: {Sheet1: {}}})
    xlsxUtils.sheet_to_csv.mockReturnValue('a,b\n1,2')
    const wrapper = mountInput({sessionName: 'session-1'})
    await selectFiles(wrapper, [
      new File(['xlsx'], 'data.xlsx', {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
    ])

    expect(wrapper.find('.upload-chip').text()).toContain('data.xlsx')
    await wrapper.find('textarea').setValue('读取')
    await wrapper.find('.send-btn').trigger('click')
    const text = wrapper.emitted('send')[0][1]
    expect(text).toContain('[工作表: Sheet1]')
    expect(text).toContain('a,b')
    wrapper.unmount()
  })

  it('rejects unsupported file types with a warning', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    await selectFiles(wrapper, [new File(['OLE'], 'old.doc', {type: 'application/msword'})])

    expect(message.warning).toHaveBeenCalledWith(expect.stringContaining('暂不支持解析'))
    expect(wrapper.find('.upload-chip').exists()).toBe(false)
    wrapper.unmount()
  })

  it('carries a file selection snippet with line numbers into the collapsible block on send', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    wrapper.vm.addFileContext({
      file: 'C:/workspace/demo.txt',
      content: 'const a = 1\n```\nnot a fence\nconst b = 2',
      startLine: 12,
      endLine: 30
    })
    await flushPromises()
    // chip 显示文件名 + 行号范围
    expect(wrapper.find('.file-chip').text()).toContain('demo.txt:12:30')

    await wrapper.find('textarea').setValue('看看这段')
    await wrapper.find('.send-btn').trigger('click')

    const [images, text] = wrapper.emitted('send')[0]
    expect(images).toEqual([])
    expect(text).toContain('```折叠块')
    expect(text).toContain('引用文件：')
    expect(text).toContain('- C:/workspace/demo.txt:12:30')
    expect(text).toContain('选中片段：')
    // 四反引号围栏包裹，内容中的 ``` 不会提前截断折叠块
    expect(text).toContain('````text')
    expect(text).toContain('const a = 1\n```\nnot a fence\nconst b = 2')
    expect(text).toContain('看看这段')
    // 发送后清空文件引用
    expect(wrapper.find('.file-chip').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps distinct snippets from the same file as separate references', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    // 同一文件的两个不同代码块
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const a = 1', startLine: 12, endLine: 30})
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const b = 2', startLine: 45, endLine: 60})
    await flushPromises()
    expect(wrapper.findAll('.file-chip')).toHaveLength(2)
    expect(wrapper.findAll('.file-chip-name')[0].text()).toContain('demo.txt:12:30')
    expect(wrapper.findAll('.file-chip-name')[1].text()).toContain('demo.txt:45:60')

    await wrapper.find('textarea').setValue('分析')
    await wrapper.find('.send-btn').trigger('click')
    const text = wrapper.emitted('send')[0][1]
    expect(text).toContain('- C:/workspace/demo.txt:12:30')
    expect(text).toContain('- C:/workspace/demo.txt:45:60')
    expect(text).toContain('const a = 1')
    expect(text).toContain('const b = 2')
    wrapper.unmount()
  })

  it('de-duplicates the same snippet range and a single-line range format', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const a = 1', startLine: 12, endLine: 30})
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const a = 1', startLine: 12, endLine: 30})
    await flushPromises()
    expect(wrapper.findAll('.file-chip')).toHaveLength(1)

    // 单行选区：行号只显示一次
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const a = 1', startLine: 5, endLine: 5})
    await flushPromises()
    expect(wrapper.findAll('.file-chip-name')[1].text()).toContain('demo.txt:5')

    await wrapper.find('textarea').setValue('分析')
    await wrapper.find('.send-btn').trigger('click')
    const text = wrapper.emitted('send')[0][1]
    expect(text).toContain('- C:/workspace/demo.txt:5')
    wrapper.unmount()
  })

  it('de-duplicates snippet references without line numbers by content', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    // DiffViewer 预览弹框等来源无行号：同一内容不重复引用，不同内容各自保留
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const a = 1'})
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const a = 1'})
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const b = 2'})
    await flushPromises()
    expect(wrapper.findAll('.file-chip')).toHaveLength(2)
    wrapper.unmount()
  })

  it('keeps a plain file reference and a snippet reference from the same file independent', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    // 右键“添加到对话”的纯文件引用与选中片段互不覆盖
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt'})
    wrapper.vm.addFileContext({file: 'C:/workspace/demo.txt', content: 'const a = 1', startLine: 3, endLine: 8})
    await flushPromises()
    expect(wrapper.findAll('.file-chip')).toHaveLength(2)

    await wrapper.find('textarea').setValue('分析')
    await wrapper.find('.send-btn').trigger('click')
    const text = wrapper.emitted('send')[0][1]
    expect(text).toContain('- C:/workspace/demo.txt')
    expect(text).toContain('- C:/workspace/demo.txt:3:8')
    expect(text).toContain('const a = 1')
    wrapper.unmount()
  })

  it('removes a single uploaded file and clears all at once', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    await selectFiles(wrapper, [new File(['内容'], 'a.txt', {type: 'text/plain'})])
    expect(wrapper.findAll('.upload-chip')).toHaveLength(1)

    await wrapper.find('.upload-chip .file-chip-remove').trigger('click')
    expect(wrapper.findAll('.upload-chip')).toHaveLength(0)

    await selectFiles(wrapper, [new File(['内容'], 'b.txt', {type: 'text/plain'})])
    await wrapper.find('.file-clear-all').trigger('click')
    expect(wrapper.findAll('.upload-chip')).toHaveLength(0)
    wrapper.unmount()
  })

  it('pastes files copied from the clipboard into the upload pipeline', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    const file = new File(['剪贴板内容'], 'pasted.txt', {type: 'text/plain'})
    const clipboardData = {
      items: [{kind: 'file', type: 'text/plain', getAsFile: () => file}]
    }
    await wrapper.find('textarea').trigger('paste', {clipboardData})
    for (let i = 0; i < 5; i++) {
      await tick()
      await flushPromises()
    }

    expect(wrapper.find('.upload-chip').text()).toContain('pasted.txt')
    await wrapper.find('textarea').setValue('读这个')
    await wrapper.find('.send-btn').trigger('click')
    expect(wrapper.emitted('send')[0][1]).toContain('剪贴板内容')
    wrapper.unmount()
  })

  it('pastes images to the base64 channel and other files to the upload pipeline together', async () => {
    const wrapper = mountInput({sessionName: 'session-1'})
    const imgFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'clip.png', {type: 'image/png'})
    const txtFile = new File(['混合内容'], 'clip.txt', {type: 'text/plain'})
    const clipboardData = {
      items: [
        {kind: 'file', type: 'image/png', getAsFile: () => imgFile},
        {kind: 'file', type: 'text/plain', getAsFile: () => txtFile}
      ]
    }
    await wrapper.find('textarea').trigger('paste', {clipboardData})
    for (let i = 0; i < 5; i++) {
      await tick()
      await flushPromises()
    }

    expect(wrapper.find('.image-preview-item').exists()).toBe(true)
    expect(wrapper.find('.upload-chip').text()).toContain('clip.txt')
    wrapper.unmount()
  })
})

describe('ChatInput large text paste', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves oversized plain text and sends only its path in the folded context', async () => {
    const wrapper = mountInput({workspaceHash: 'workspace-1', sessionName: 'session-1'})
    const content = '大段内容\n'.repeat(7000)
    const clipboardData = {
      items: [{kind: 'string', type: 'text/plain'}],
      getData: vi.fn(() => content)
    }

    await wrapper.find('textarea').trigger('paste', {clipboardData})
    await flushPromises()

    expect(filesAPI.savePaste).toHaveBeenCalledWith('workspace-1', content)
    expect(wrapper.find('.paste-chip').text()).toContain('.loopra/paste/paste-test.txt')
    expect(wrapper.find('textarea').element.value).toBe('')
    expect(wrapper.find('textarea').element.value).not.toContain('大段粘贴内容')

    await wrapper.find('textarea').setValue('请分析这段内容')
    await wrapper.find('.send-btn').trigger('click')

    const sentText = wrapper.emitted('send')[0][1]
    expect(sentText).toContain('大段粘贴内容（已保存）')
    expect(sentText).toContain('.loopra/paste/paste-test.txt')
    expect(sentText).toContain('请分析这段内容')
    expect(sentText).not.toContain(content)
    wrapper.unmount()
  })

  it('externalizes oversized text entered without a paste event before sending', async () => {
    const wrapper = mountInput({workspaceHash: 'workspace-1', sessionName: 'session-1'})
    const content = '直接输入内容'.repeat(9000)

    await wrapper.find('textarea').setValue(content)
    await wrapper.find('.send-btn').trigger('click')
    await flushPromises()

    expect(filesAPI.savePaste).toHaveBeenCalledWith('workspace-1', content)
    const sentText = wrapper.emitted('send')[0][1]
    expect(sentText).toContain('大段输入内容（已保存）')
    expect(sentText).toContain('.loopra/paste/paste-test.txt')
    expect(sentText).not.toContain(content)
    wrapper.unmount()
  })

  it('restores the original text when saving the oversized paste fails', async () => {
    filesAPI.savePaste.mockRejectedValueOnce(new Error('磁盘不可写'))
    const wrapper = mountInput({workspaceHash: 'workspace-1', sessionName: 'session-1'})
    const content = 'x'.repeat(32 * 1024 + 1)
    const clipboardData = {
      items: [{kind: 'string', type: 'text/plain'}],
      getData: () => content
    }

    await wrapper.find('textarea').trigger('paste', {clipboardData})
    await flushPromises()

    expect(wrapper.find('.paste-chip').exists()).toBe(false)
    expect(wrapper.find('textarea').element.value).toBe(content)
    expect(message.error).toHaveBeenCalledWith(expect.stringContaining('已恢复原文'))
    wrapper.unmount()
  })
})
