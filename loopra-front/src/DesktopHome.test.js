/* @vitest-environment jsdom */

import {flushPromises, shallowMount} from '@vue/test-utils'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import DesktopHome from './DesktopHome.vue'
import ServiceProcessManager from './components/ServiceProcessManager.vue'
import {agentAPI, sessionsAPI} from './services/api'

const initialElectronAPI = window.electronAPI

vi.mock('./services/api', () => ({
  agentAPI: {
    getSessionStatus: vi.fn().mockResolvedValue({success: true, data: {running: false}})
  },
  sessionsAPI: {
    list: vi.fn().mockResolvedValue({success: true, data: []}),
    renameSession: vi.fn().mockResolvedValue({success: true, data: '新名称'})
  }
}))

const FIXTURES = [
  {hash: 'h1', name: 'A', path: '/p/a'},
  {hash: 'h2', name: 'B', path: '/p/b'},
  {hash: 'h3', name: 'C', path: '/p/c'}
]

function mountHome(props) {
  return shallowMount(DesktopHome, {
    props: {
      workspaces: FIXTURES,
      activeWorkspaceHash: '',
      theme: 'gray',
      refreshKey: 0,
      refreshing: false,
      ...props
    },
    global: {stubs: {ServiceProcessManager: true, Teleport: false}}
  })
}

/** 模拟元素几何信息（jsdom 默认全 0），height 32 与样式定义一致 */
function mockRect(element, {top = 0, height = 32} = {}) {
  element.getBoundingClientRect = () => ({
    top, height, bottom: top + height,
    left: 0, right: 200, width: 200, x: 0, y: top,
    toJSON: () => ({})
  })
}

/** 在目标元素上派发冒泡到容器的拖拽事件 */
function dispatchDragEvent(element, type, clientY) {
  element.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, clientY}))
}

function projectNames(wrapper) {
  return wrapper.findAll('.desktop-project').map((project) => {
    const spans = project.findAll('span')
    return spans[spans.length - 1].text()
  })
}

describe('DesktopHome 项目拖拽排序', () => {
  let wrapper

  beforeEach(() => {
    wrapper = mountHome()
  })

  afterEach(() => {
    wrapper.unmount()
  })

  it('按 workspaces prop 顺序渲染项目', async () => {
    await flushPromises()
    expect(projectNames(wrapper)).toEqual(['A', 'B', 'C'])
  })

  it('顶部导航保持 Codex 风格，设置固定在左侧底部，低频功能收进探索菜单', async () => {
    await flushPromises()
    const scrollRegion = wrapper.find('.desktop-sidebar-scroll')
    const menuButtons = wrapper.findAll('.desktop-project-footer-menu > button')
    expect(menuButtons.map((button) => button.text().trim())).toEqual(['技能'])
    expect(scrollRegion.find('.desktop-project-list').exists()).toBe(true)
    expect(scrollRegion.find('.desktop-more-button').text()).toContain('探索')
    expect(scrollRegion.find('.desktop-home-nav').exists()).toBe(false)
    expect(scrollRegion.find('.desktop-project-footer-settings').exists()).toBe(false)
    expect(wrapper.find('.desktop-sidebar-settings').text()).toContain('设置')
    expect(wrapper.find('.desktop-home-nav').text()).toContain('新对话')
    expect(wrapper.find('.desktop-nav-plus').exists()).toBe(false)
    expect(wrapper.find('.desktop-footer-more-menu').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('子代理')
  })

  it('Loopra 标题不再显示下拉按钮，也不响应左键点击', async () => {
    await flushPromises()
    const brand = wrapper.find('.desktop-sidebar-brand')

    expect(brand.element.tagName).toBe('DIV')
    expect(brand.find('svg').exists()).toBe(false)
    expect(brand.attributes('aria-haspopup')).toBeUndefined()
    expect(brand.attributes('aria-expanded')).toBeUndefined()

    await brand.trigger('click')
    expect(wrapper.emitted('show-home')).toBeUndefined()
  })

  it('项目操作按钮默认隐藏，悬停项目标题行时显示', async () => {
    await flushPromises()
    const heading = wrapper.find('.desktop-project-heading')
    expect(heading.exists()).toBe(true)
    expect(heading.classes()).not.toContain('multi-selecting')

    await heading.trigger('mouseenter')
    expect(heading.find('.desktop-refresh-projects').exists()).toBe(true)
    expect(heading.find('.desktop-add-project').exists()).toBe(true)
    expect(heading.find('.desktop-multi-toggle-project').exists()).toBe(true)
  })

  it('会话标题行不再提供新建会话按钮', async () => {
    const sidebarWrapper = mountHome({sidebarOnly: true})
    await flushPromises()
    expect(sidebarWrapper.find('.desktop-sessions .desktop-new-session').exists()).toBe(false)
    expect(sidebarWrapper.find('.desktop-sessions .desktop-home-heading').exists()).toBe(false)
    sidebarWrapper.unmount()
  })

  it('悬停项目行时显示项目内新增对话按钮，并携带项目标识', async () => {
    const sidebarWrapper = mountHome({sidebarOnly: true})
    await flushPromises()

    const firstProjectRow = sidebarWrapper.find('.desktop-project-row')
    const newSessionButton = firstProjectRow.find('.desktop-project-new-session')

    expect(newSessionButton.exists()).toBe(true)
    expect(newSessionButton.attributes('title')).toBe('在 A 中新增对话')
    expect(newSessionButton.attributes('aria-label')).toBe('在 A 中新增对话')

    await newSessionButton.trigger('click')

    expect(sidebarWrapper.emitted('new-session')).toEqual([['h1']])
    sidebarWrapper.unmount()
  })

  it('打开探索菜单后只保留子代理、工具和服务进程，选择工具后自动收起', async () => {
    await flushPromises()
    await wrapper.find('.desktop-more-button').trigger('click')

    const moreMenu = wrapper.find('.desktop-footer-more-menu')
    expect(moreMenu.exists()).toBe(true)
    expect(moreMenu.text()).toContain('子代理')
    expect(moreMenu.text()).toContain('工具')
    expect(moreMenu.findAll('.desktop-explore-item')).toHaveLength(2)
    expect(moreMenu.findComponent(ServiceProcessManager).exists()).toBe(true)
    expect(moreMenu.text()).not.toContain('站点')
    expect(moreMenu.text()).not.toContain('自定义')
    expect(moreMenu.text()).not.toContain('深色模式')

    const toolsButton = moreMenu.findAll('.desktop-footer-more-item').find((button) => button.text().trim() === '工具')
    await toolsButton.trigger('click')
    expect(wrapper.emitted('open-tools')).toBeTruthy()
    expect(wrapper.find('.desktop-footer-more-menu').exists()).toBe(false)
  })

  it('点击其他顶部入口时自动收起探索菜单', async () => {
    await flushPromises()
    await wrapper.find('.desktop-more-button').trigger('click')
    expect(wrapper.find('.desktop-footer-more-menu').exists()).toBe(true)

    await wrapper.findAll('.desktop-project-footer-menu > button')[0].trigger('click')
    expect(wrapper.emitted('open-skills')).toBeTruthy()
    expect(wrapper.find('.desktop-footer-more-menu').exists()).toBe(false)
  })

  it('拖拽过程中列表保持不动，仅显示插入指示，drop 后按新顺序发出 reorder-workspaces', async () => {
    await flushPromises()
    const projects = wrapper.findAll('.desktop-project')

    // 开始拖拽 A
    await projects[0].trigger('dragstart')
    expect(wrapper.find('.desktop-project.dragging').exists()).toBe(true)
    // 悬停到 C 的下半部（before = false → 插入到 C 之后）
    mockRect(projects[2].element, {top: 0, height: 32})
    dispatchDragEvent(projects[2].element, 'dragover', 40)
    await flushPromises()

    // 拖动中列表不变，只出现行间指示
    expect(projectNames(wrapper)).toEqual(['A', 'B', 'C'])
    expect(projects[2].classes()).toContain('drag-over-after')

    await wrapper.find('.desktop-project-list').trigger('drop')
    expect(projectNames(wrapper)).toEqual(['B', 'C', 'A'])
    expect(wrapper.emitted('reorder-workspaces')).toBeTruthy()
    expect(wrapper.emitted('reorder-workspaces')[0]).toEqual([['h2', 'h3', 'h1']])
  })

  it('拖拽到另一项目上方时显示上侧指示，drop 后插入到其前', async () => {
    await flushPromises()
    const projects = wrapper.findAll('.desktop-project')

    await projects[2].trigger('dragstart')
    // 悬停到 A 的上半部（before = true → 插入到 A 之前）
    mockRect(projects[0].element, {top: 0, height: 32})
    dispatchDragEvent(projects[0].element, 'dragover', 4)
    await flushPromises()

    expect(projectNames(wrapper)).toEqual(['A', 'B', 'C'])
    expect(projects[0].classes()).toContain('drag-over-before')

    await wrapper.find('.desktop-project-list').trigger('drop')
    expect(projectNames(wrapper)).toEqual(['C', 'A', 'B'])
    expect(wrapper.emitted('reorder-workspaces')[0]).toEqual([['h3', 'h1', 'h2']])
  })

  it('拖到列表空白处 drop 后移到末尾', async () => {
    await flushPromises()
    const projects = wrapper.findAll('.desktop-project')

    await projects[1].trigger('dragstart')
    // 在容器空白处悬停（target 为容器自身），指示落在最后一项下方
    dispatchDragEvent(wrapper.find('.desktop-project-list').element, 'dragover', 999)
    await flushPromises()

    expect(projectNames(wrapper)).toEqual(['A', 'B', 'C'])
    expect(projects[2].classes()).toContain('drag-over-after')

    await wrapper.find('.desktop-project-list').trigger('drop')
    expect(projectNames(wrapper)).toEqual(['A', 'C', 'B'])
    expect(wrapper.emitted('reorder-workspaces')[0]).toEqual([['h1', 'h3', 'h2']])
  })

  it('拖起后放回原位不发出排序事件', async () => {
    await flushPromises()
    const projects = wrapper.findAll('.desktop-project')

    await projects[1].trigger('dragstart')
    await wrapper.find('.desktop-project-list').trigger('drop')

    expect(projectNames(wrapper)).toEqual(['A', 'B', 'C'])
    expect(wrapper.emitted('reorder-workspaces')).toBeUndefined()
  })

  it('未拖拽时 drop 不发出排序事件', async () => {
    await flushPromises()
    await wrapper.find('.desktop-project-list').trigger('drop')
    expect(wrapper.emitted('reorder-workspaces')).toBeUndefined()
  })
})

describe('DesktopHome 项目右键菜单', () => {
  let wrapper

  beforeEach(() => {
    wrapper = mountHome()
  })

  afterEach(() => {
    wrapper.unmount()
  })

  it('项目右键提供清空会话/清空三天前的会话/删除项目，点击发出 clear-old-sessions', async () => {
    await flushPromises()
    await wrapper.find('.desktop-project').trigger('contextmenu', {clientX: 200, clientY: 200})

    const menu = document.body.querySelector('.desktop-context-menu')
    expect(menu).not.toBeNull()
    expect(menu.textContent).toContain('清空会话')
    expect(menu.textContent).toContain('清空三天前的会话')
    expect(menu.textContent).toContain('删除项目')

    menu.querySelectorAll('button')[2].click()
    await flushPromises()
    expect(wrapper.emitted('clear-old-sessions')).toBeTruthy()
    expect(wrapper.emitted('clear-old-sessions')[0][0]).toEqual({hash: 'h1', name: 'A', path: '/p/a'})
  })
})

describe('DesktopHome 项目多选删除', () => {
  let wrapper

  beforeEach(() => {
    wrapper = mountHome()
  })

  afterEach(() => {
    wrapper.unmount()
  })

  it('未开启多选时不渲染复选框，点击开关后进入多选模式', async () => {
    await flushPromises()
    expect(wrapper.find('.desktop-project-check').exists()).toBe(false)

    await wrapper.find('.desktop-multi-toggle-project').trigger('click')
    expect(wrapper.findAll('.desktop-project-check')).toHaveLength(3)
    // 多选模式下隐藏刷新/添加按钮
    expect(wrapper.find('.desktop-add-project').exists()).toBe(false)
    expect(wrapper.find('.desktop-multi-toggle-project').classes()).toContain('active')
  })

  it('勾选复选框后出现删除选中按钮，点击发出 delete-workspaces（含全部选中项）', async () => {
    await flushPromises()
    await wrapper.find('.desktop-multi-toggle-project').trigger('click')
    const projects = wrapper.findAll('.desktop-project')

    await projects[0].find('.desktop-project-check').trigger('click')
    await projects[2].find('.desktop-project-check').trigger('click')
    expect(projects[0].classes()).toContain('selected')
    expect(projects[2].classes()).toContain('selected')
    expect(projects[1].classes()).not.toContain('selected')

    const deleteButton = wrapper.find('.desktop-delete-selected')
    expect(deleteButton.exists()).toBe(true)
    expect(deleteButton.text()).toContain('2')

    await deleteButton.trigger('click')
    expect(wrapper.emitted('delete-workspaces')[0][0]).toEqual([
      {hash: 'h1', name: 'A', path: '/p/a'},
      {hash: 'h3', name: 'C', path: '/p/c'}
    ])
  })

  it('再次点击复选框取消勾选，关闭开关退出多选并清空全部选中', async () => {
    await flushPromises()
    await wrapper.find('.desktop-multi-toggle-project').trigger('click')
    const projects = wrapper.findAll('.desktop-project')

    await projects[0].find('.desktop-project-check').trigger('click')
    await projects[1].find('.desktop-project-check').trigger('click')
    await projects[0].find('.desktop-project-check').trigger('click')
    expect(wrapper.find('.desktop-delete-selected').text()).toContain('1')

    // 关闭开关：退出多选并清空，恢复刷新/添加按钮
    await wrapper.find('.desktop-multi-toggle-project').trigger('click')
    expect(wrapper.find('.desktop-delete-selected').exists()).toBe(false)
    expect(wrapper.findAll('.desktop-project-check')).toHaveLength(0)
    expect(wrapper.findAll('.desktop-project.selected')).toHaveLength(0)
    expect(wrapper.find('.desktop-add-project').exists()).toBe(true)
  })

  it('Shift+点击复选框按区间批量选中', async () => {
    await flushPromises()
    await wrapper.find('.desktop-multi-toggle-project').trigger('click')
    const projects = wrapper.findAll('.desktop-project')

    await projects[0].find('.desktop-project-check').trigger('click')
    await projects[2].find('.desktop-project-check').trigger('click', {shiftKey: true})
    expect(wrapper.findAll('.desktop-project.selected')).toHaveLength(3)
    expect(wrapper.find('.desktop-delete-selected').text()).toContain('3')
  })

  it('全选按钮全选全部项目，再次点击取消全选', async () => {
    await flushPromises()
    await wrapper.find('.desktop-multi-toggle-project').trigger('click')

    await wrapper.find('.desktop-select-all').trigger('click')
    expect(wrapper.findAll('.desktop-project.selected')).toHaveLength(3)
    expect(wrapper.find('.desktop-delete-selected').text()).toContain('3')
    expect(wrapper.find('.desktop-select-all').text()).toContain('取消全选')

    await wrapper.find('.desktop-select-all').trigger('click')
    expect(wrapper.findAll('.desktop-project.selected')).toHaveLength(0)
    expect(wrapper.find('.desktop-delete-selected').exists()).toBe(false)
    expect(wrapper.find('.desktop-select-all').text()).toContain('全选')
  })

  it('全选后取消一个勾选，按钮恢复为全选', async () => {
    await flushPromises()
    await wrapper.find('.desktop-multi-toggle-project').trigger('click')
    await wrapper.find('.desktop-select-all').trigger('click')

    const projects = wrapper.findAll('.desktop-project')
    await projects[0].find('.desktop-project-check').trigger('click')
    expect(wrapper.findAll('.desktop-project.selected')).toHaveLength(2)
    expect(wrapper.find('.desktop-select-all').text()).toContain('全选')
  })

  it('开启多选后点击整行与点击复选框效果一致（切换选择，不触发切换项目）', async () => {
    await flushPromises()
    await wrapper.find('.desktop-multi-toggle-project').trigger('click')
    const projects = wrapper.findAll('.desktop-project')

    // 点击复选框：切换选择
    await projects[1].find('.desktop-project-check').trigger('click')
    expect(projects[1].classes()).toContain('selected')
    expect(wrapper.emitted('select-workspace')).toBeUndefined()

    // 点击行主体：同样切换选择
    await projects[1].trigger('click')
    expect(projects[1].classes()).not.toContain('selected')
    expect(wrapper.emitted('select-workspace')).toBeUndefined()
    expect(wrapper.findAll('.desktop-project.selected')).toHaveLength(0)

    await projects[1].trigger('click')
    expect(wrapper.findAll('.desktop-project.selected')).toHaveLength(1)
    expect(wrapper.emitted('select-workspace')).toBeUndefined()
  })

  it('关闭多选后点击行主体恢复切换项目行为', async () => {
    await flushPromises()
    const projects = wrapper.findAll('.desktop-project')

    await projects[1].trigger('click')
    expect(wrapper.emitted('select-workspace')[0]).toEqual(['h2'])
    expect(wrapper.findAll('.desktop-project.selected')).toHaveLength(0)
  })

  it('项目从列表中移除后自动清理选中项（批量删除后不残留）', async () => {
    await flushPromises()
    await wrapper.find('.desktop-multi-toggle-project').trigger('click')
    const projects = wrapper.findAll('.desktop-project')

    await projects[0].find('.desktop-project-check').trigger('click')
    expect(wrapper.find('.desktop-delete-selected').text()).toContain('1')

    await wrapper.setProps({workspaces: FIXTURES.filter((workspace) => workspace.hash !== 'h1')})
    expect(wrapper.find('.desktop-delete-selected').exists()).toBe(false)
    expect(wrapper.findAll('.desktop-project')).toHaveLength(2)
  })
})

describe('DesktopHome 项目内会话多选删除', () => {
  let wrapper

  function mountWithSessions(sessions) {
    sessionsAPI.list.mockResolvedValue({success: true, data: sessions})
    wrapper = mountHome({sidebarOnly: true})
  }

  const SESSIONS = [
    {name: 's1', title: '会话一', mtime: Date.now()},
    {name: 's2', title: '会话二', mtime: Date.now() - 3600_000},
    {name: 's3', title: '会话三', mtime: Date.now() - 7200_000}
  ]

  function projectGroup(index) {
    return wrapper.findAll('.desktop-project-group')[index]
  }

  afterEach(() => {
    wrapper.unmount()
  })

  it('会话多选按钮位于项目行，开启后只显示该项目的会话复选框', async () => {
    mountWithSessions(SESSIONS)
    await flushPromises()
    const groups = wrapper.findAll('.desktop-project-group')
    expect(groups).toHaveLength(3)
    expect(wrapper.findAll('.desktop-multi-toggle-session')).toHaveLength(3)
    expect(wrapper.findAll('.desktop-session-check')).toHaveLength(0)

    await groups[0].find('.desktop-multi-toggle-session').trigger('click')
    expect(groups[0].findAll('.desktop-session-check')).toHaveLength(3)
    expect(groups[1].findAll('.desktop-session-check')).toHaveLength(0)
    expect(groups[2].findAll('.desktop-session-check')).toHaveLength(0)
    expect(groups[0].find('.desktop-multi-toggle-session').attributes('aria-pressed')).toBe('true')
  })

  it('项目内勾选和删除只发出当前项目的会话', async () => {
    mountWithSessions(SESSIONS)
    await flushPromises()
    const group = projectGroup(0)
    await group.find('.desktop-multi-toggle-session').trigger('click')
    const sessions = group.findAll('.desktop-session')

    await sessions[0].find('.desktop-session-check').trigger('click')
    await sessions[2].find('.desktop-session-check').trigger('click')
    expect(sessions[0].classes()).toContain('selected')
    expect(sessions[2].classes()).toContain('selected')
    expect(projectGroup(1).findAll('.desktop-session.selected')).toHaveLength(0)

    const deleteButton = group.find('.desktop-delete-sessions')
    expect(deleteButton.text()).toContain('2')
    await deleteButton.trigger('click')
    const emitted = wrapper.emitted('delete-sessions')[0][0]
    expect(emitted).toHaveLength(2)
    expect(emitted.every((session) => session.workspaceHash === 'h1')).toBe(true)
  })

  it('Shift+点击只在当前项目内按显示顺序选择区间', async () => {
    mountWithSessions(SESSIONS)
    await flushPromises()
    const group = projectGroup(0)
    await group.find('.desktop-multi-toggle-session').trigger('click')
    const sessions = group.findAll('.desktop-session')

    await sessions[2].find('.desktop-session-check').trigger('click')
    await sessions[0].find('.desktop-session-check').trigger('click', {shiftKey: true})
    expect(group.findAll('.desktop-session.selected')).toHaveLength(3)
    expect(projectGroup(1).findAll('.desktop-session.selected')).toHaveLength(0)
    expect(group.find('.desktop-delete-sessions').text()).toContain('3')
  })

  it('全选按钮只全选当前项目的会话', async () => {
    mountWithSessions(SESSIONS)
    await flushPromises()
    const group = projectGroup(0)
    await group.find('.desktop-multi-toggle-session').trigger('click')

    await group.find('.desktop-select-all-sessions').trigger('click')
    expect(group.findAll('.desktop-session.selected')).toHaveLength(3)
    expect(projectGroup(1).findAll('.desktop-session.selected')).toHaveLength(0)
    expect(group.find('.desktop-select-all-sessions').text()).toContain('取消全选')

    await group.find('.desktop-select-all-sessions').trigger('click')
    expect(group.findAll('.desktop-session.selected')).toHaveLength(0)
    expect(group.find('.desktop-delete-sessions').exists()).toBe(false)
  })

  it('只有开启多选的项目拦截会话点击，其他项目仍可打开会话', async () => {
    mountWithSessions(SESSIONS)
    await flushPromises()
    const selectedGroup = projectGroup(0)
    const normalGroup = projectGroup(1)
    await selectedGroup.find('.desktop-multi-toggle-session').trigger('click')

    await selectedGroup.findAll('.desktop-session')[0].trigger('click')
    expect(selectedGroup.findAll('.desktop-session.selected')).toHaveLength(1)
    expect(wrapper.emitted('open-session')).toBeUndefined()

    await normalGroup.findAll('.desktop-session')[0].trigger('click')
    expect(wrapper.emitted('open-session')[0][0]).toMatchObject({workspaceHash: 'h2', sessionName: 's1'})
  })

  it('关闭一个项目的多选只清空该项目，其他项目状态保留', async () => {
    mountWithSessions(SESSIONS)
    await flushPromises()
    const first = projectGroup(0)
    const second = projectGroup(1)
    await first.find('.desktop-multi-toggle-session').trigger('click')
    await second.find('.desktop-multi-toggle-session').trigger('click')
    await first.findAll('.desktop-session')[0].find('.desktop-session-check').trigger('click')
    await second.findAll('.desktop-session')[0].find('.desktop-session-check').trigger('click')

    await first.find('.desktop-multi-toggle-session').trigger('click')
    expect(first.findAll('.desktop-session-check')).toHaveLength(0)
    expect(first.findAll('.desktop-session.selected')).toHaveLength(0)
    expect(second.findAll('.desktop-session-check')).toHaveLength(3)
    expect(second.findAll('.desktop-session.selected')).toHaveLength(1)
    expect(second.find('.desktop-delete-sessions').text()).toContain('1')
  })

  it('会话列表刷新后清理当前项目内已删除的勾选', async () => {
    mountWithSessions(SESSIONS)
    await flushPromises()
    const group = projectGroup(0)
    await group.find('.desktop-multi-toggle-session').trigger('click')
    const sessions = group.findAll('.desktop-session')
    await sessions[0].find('.desktop-session-check').trigger('click')
    await sessions[1].find('.desktop-session-check').trigger('click')
    expect(group.find('.desktop-delete-sessions').text()).toContain('2')

    sessionsAPI.list.mockResolvedValue({success: true, data: [SESSIONS[2]]})
    await wrapper.setProps({refreshKey: 1})
    await flushPromises()
    expect(group.find('.desktop-delete-sessions').exists()).toBe(false)
    expect(group.findAll('.desktop-session')).toHaveLength(1)
  })
})

describe('DesktopHome 会话重命名', () => {
  let wrapper

  beforeEach(() => {
    sessionsAPI.renameSession.mockClear()
  })

  function mountWithSessions(sessions) {
    sessionsAPI.list.mockResolvedValue({success: true, data: sessions})
    wrapper = mountHome()
  }

  afterEach(() => {
    wrapper.unmount()
  })

  it('会话右键菜单提供重命名入口，弹窗预填当前显示名称', async () => {
    mountWithSessions([{name: 's1', title: '会话一', mtime: Date.now()}])
    await flushPromises()
    await wrapper.find('.desktop-session').trigger('contextmenu', {clientX: 200, clientY: 200})

    const menu = document.body.querySelector('.desktop-context-menu')
    expect(menu).not.toBeNull()
    expect(menu.textContent).toContain('重命名会话')

    const renameButton = [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('重命名会话'))
    await renameButton.click()
    await flushPromises()

    const dialog = document.body.querySelector('.desktop-rename-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog.querySelector('input').value).toBe('会话一')
  })

  it('确认重命名：调用 renameSession 并发出 session-renamed / refresh', async () => {
    mountWithSessions([{name: 's1', title: '会话一', mtime: Date.now()}])
    await flushPromises()
    await wrapper.find('.desktop-session').trigger('contextmenu', {clientX: 200, clientY: 200})
    const menu = document.body.querySelector('.desktop-context-menu')
    const renameButton = [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('重命名会话'))
    await renameButton.click()
    await flushPromises()

    const input = document.body.querySelector('.desktop-rename-dialog input')
    input.value = '新名称'
    input.dispatchEvent(new Event('input'))
    const confirm = [...document.body.querySelectorAll('.desktop-rename-dialog button')].find((b) => b.textContent.includes('确定'))
    await confirm.click()
    await flushPromises()

    expect(sessionsAPI.renameSession).toHaveBeenCalledWith('s1', 'h1', '新名称')
    expect(wrapper.emitted('session-renamed')[0][0]).toEqual({workspaceHash: 'h1', sessionName: 's1', title: '新名称'})
    expect(wrapper.emitted('refresh')).toBeTruthy()
  })

  it('取消重命名不调用接口', async () => {
    mountWithSessions([{name: 's1', title: '会话一', mtime: Date.now()}])
    await flushPromises()
    await wrapper.find('.desktop-session').trigger('contextmenu', {clientX: 200, clientY: 200})
    const menu = document.body.querySelector('.desktop-context-menu')
    const renameButton = [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('重命名会话'))
    await renameButton.click()
    await flushPromises()

    const cancel = [...document.body.querySelectorAll('.desktop-rename-dialog button')].find((b) => b.textContent.includes('取消'))
    await cancel.click()
    await flushPromises()

    expect(sessionsAPI.renameSession).not.toHaveBeenCalled()
    expect(document.body.querySelector('.desktop-rename-dialog')).toBeNull()
  })
})

describe('DesktopHome 会话原生右键菜单', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    if (initialElectronAPI === undefined) delete window.electronAPI
    else window.electronAPI = initialElectronAPI
  })

  it('桌面浮层可用时优先通过浮层回传会话菜单动作', async () => {
    const openNativeSessionMenu = vi.fn().mockResolvedValue(null)
    const openPopup = vi.fn().mockResolvedValue({success: true})
    const listeners = new Map()
    window.electronAPI = {
      desktopSessionMenu: {open: openNativeSessionMenu},
      desktopPopup: {open: openPopup},
      events: {listen: vi.fn((eventName, callback) => {
        listeners.set(eventName, callback)
        return () => listeners.delete(eventName)
      })}
    }
    sessionsAPI.list.mockResolvedValue({success: true, data: [{name: 's1', title: '会话一', mtime: Date.now()}]})
    wrapper = mountHome({sidebarOnly: true})
    await flushPromises()

    await wrapper.find('.desktop-session').trigger('contextmenu', {clientX: 200, clientY: 200})
    await flushPromises()

    expect(openNativeSessionMenu).not.toHaveBeenCalled()
    expect(openPopup).toHaveBeenCalledWith(expect.objectContaining({
      type: 'context-menu',
      menuType: 'session',
      item: expect.objectContaining({workspaceHash: 'h1', name: 's1', title: '会话一'})
    }))
    expect(listeners.has('desktop-shell-popup-action')).toBe(true)
  })

  it('Electron 环境下右键会话调用系统菜单，并接收主进程回传的重命名动作', async () => {
    const openNativeSessionMenu = vi.fn().mockResolvedValue(null)
    const listeners = new Map()
    window.electronAPI = {
      desktopSessionMenu: {open: openNativeSessionMenu},
      events: {listen: vi.fn((eventName, callback) => {
        listeners.set(eventName, callback)
        return () => listeners.delete(eventName)
      })}
    }
    sessionsAPI.list.mockResolvedValue({success: true, data: [{name: 's1', title: '会话一', mtime: Date.now()}]})
    wrapper = mountHome()
    await flushPromises()

    await wrapper.find('.desktop-session').trigger('contextmenu', {clientX: 200, clientY: 200})
    await flushPromises()
    listeners.get('desktop-session-context-action')({
      action: 'rename-session',
      item: {workspaceHash: 'h1', name: 's1', title: '会话一'}
    })
    await flushPromises()

    expect(openNativeSessionMenu).toHaveBeenCalledWith({
      theme: 'gray',
      workspaceHash: 'h1',
      sessionName: 's1',
      sessionTitle: '会话一'
    })
    expect(document.body.querySelector('.desktop-rename-dialog')).not.toBeNull()
    expect(document.body.querySelector('.desktop-context-menu')).toBeNull()
  })

  it('Electron 环境下接收删除动作并发出 delete-session', async () => {
    const listeners = new Map()
    window.electronAPI = {
      desktopSessionMenu: {open: vi.fn().mockResolvedValue(null)},
      events: {listen: vi.fn((eventName, callback) => {
        listeners.set(eventName, callback)
        return () => listeners.delete(eventName)
      })}
    }
    sessionsAPI.list.mockResolvedValue({success: true, data: [{name: 's1', title: '会话一', mtime: Date.now()}]})
    wrapper = mountHome()
    await flushPromises()

    await wrapper.find('.desktop-session').trigger('contextmenu', {clientX: 200, clientY: 200})
    listeners.get('desktop-session-context-action')({
      action: 'delete-session',
      item: {workspaceHash: 'h1', name: 's1', title: '会话一'}
    })
    await flushPromises()

    expect(wrapper.emitted('delete-session')[0][0]).toEqual({workspaceHash: 'h1', name: 's1', title: '会话一'})
  })
})

describe('DesktopHome 会话列表时间字段', () => {
  let wrapper

  function mountWithSessions(sessions) {
    sessionsAPI.list.mockResolvedValue({success: true, data: sessions})
    wrapper = mountHome()
  }

  afterEach(() => {
    wrapper.unmount()
  })

  it('会话行保留时间字段供悬停显示：今天 HH:mm、昨天「昨天」、跨年 Y/M/D，title 为完整日期时间', async () => {
    const today = Date.now()
    const d = new Date(today)
    const pad = (n) => String(n).padStart(2, '0')
    mountWithSessions([
      {name: 'today', title: '今天会话', mtime: today},
      {name: 'yesterday', title: '昨天会话', mtime: today - 86400000},
      {name: 'old', title: '更早会话', mtime: new Date('2024-03-15T10:00:00').getTime()}
    ])
    await flushPromises()

    // 未选中项目时加载全部 3 个项目（h1/h2/h3），同一组内按时间降序、项目顺序稳定
    const times = wrapper.findAll('.desktop-session-time')
    expect(times).toHaveLength(9)
    const todayText = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    expect(times.map(time => time.text())).toEqual([
      todayText, '昨天', '2024/3/15',
      todayText, '昨天', '2024/3/15',
      todayText, '昨天', '2024/3/15'
    ])
    expect(times[0].attributes('title')).toBe(`${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${todayText}`)
  })

  it('无 mtime 的会话不渲染时间字段', async () => {
    mountWithSessions([{name: 'no-time', title: '无时间'}])
    await flushPromises()
    // 每个项目都有一条无时间会话（共 3 行），但均不渲染时间
    expect(wrapper.findAll('.desktop-session-time')).toHaveLength(0)
    expect(wrapper.findAll('.desktop-session')).toHaveLength(3)
  })
})


describe('DesktopHome 项目与会话层级', () => {
  it('会话已高亮时不再同时高亮所属项目', async () => {
    sessionsAPI.list.mockResolvedValue({success: true, data: [
      {name: 's1', title: '会话一', mtime: 300}
    ]})
    const wrapper = mountHome({sidebarOnly: true, activeWorkspaceHash: 'h1', activeSessionName: 's1'})
    await flushPromises()

    const activeSession = wrapper.find('.desktop-session.active')
    const firstProjectRow = wrapper.findAll('.desktop-project-row')[0]
    const firstProject = firstProjectRow.find('.desktop-project')
    expect(activeSession.exists()).toBe(true)
    expect(firstProjectRow.classes()).not.toContain('active')
    expect(firstProject.classes()).not.toContain('active')

    await wrapper.setProps({activeSessionName: ''})
    expect(firstProjectRow.classes()).toContain('active')
    expect(firstProject.classes()).toContain('active')
    wrapper.unmount()
  })

  it('项目超过十个时默认只显示前十个，并可展开和收起完整列表', async () => {
    const workspaces = Array.from({length: 12}, (_, index) => ({
      hash: `h${index + 1}`,
      name: `项目 ${index + 1}`,
      path: `/p/${index + 1}`
    }))
    sessionsAPI.list.mockResolvedValue({success: true, data: []})
    const wrapper = mountHome({sidebarOnly: true, workspaces})
    await flushPromises()

    expect(wrapper.findAll('.desktop-project')).toHaveLength(10)
    expect(wrapper.find('.desktop-show-projects').text()).toBe('展开显示')
    expect(wrapper.find('.desktop-show-projects').attributes('aria-expanded')).toBe('false')

    await wrapper.find('.desktop-show-projects').trigger('click')
    expect(wrapper.findAll('.desktop-project')).toHaveLength(12)
    expect(wrapper.find('.desktop-show-projects').text()).toBe('收起')
    expect(wrapper.find('.desktop-show-projects').attributes('aria-expanded')).toBe('true')

    await wrapper.find('.desktop-show-projects').trigger('click')
    expect(wrapper.findAll('.desktop-project')).toHaveLength(10)
    wrapper.unmount()
  })

  it('侧边栏切换项目时不重复加载会话', async () => {
    sessionsAPI.list.mockResolvedValue({success: true, data: [
      {name: 's1', title: '会话一', mtime: 300}
    ]})
    const wrapper = mountHome({sidebarOnly: true, activeWorkspaceHash: 'h1'})
    await flushPromises()
    const requestCount = sessionsAPI.list.mock.calls.length

    await wrapper.findAll('.desktop-project')[1].trigger('click')
    await flushPromises()

    expect(sessionsAPI.list.mock.calls.length).toBe(requestCount)
    expect(wrapper.find('.desktop-home-muted').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击项目行可以收起和展开该项目的全部会话', async () => {
    sessionsAPI.list.mockResolvedValue({success: true, data: [
      {name: 's1', title: '会话一', mtime: 300},
      {name: 's2', title: '会话二', mtime: 200}
    ]})
    const wrapper = mountHome({sidebarOnly: true})
    await flushPromises()

    const firstGroup = wrapper.findAll('.desktop-project-group')[0]
    const project = firstGroup.find('.desktop-project')
    expect(project.attributes('aria-expanded')).toBe('true')
    expect(project.find('.desktop-folder-icon-open').exists()).toBe(true)
    expect(project.find('.desktop-folder-icon-closed').exists()).toBe(false)
    expect(firstGroup.findAll('.desktop-session')).toHaveLength(2)

    await project.trigger('click')
    expect(project.attributes('aria-expanded')).toBe('false')
    expect(project.find('.desktop-folder-icon-open').exists()).toBe(false)
    expect(project.find('.desktop-folder-icon-closed').exists()).toBe(true)
    expect(firstGroup.findAll('.desktop-session')).toHaveLength(0)
    expect(wrapper.findAll('.desktop-project-group')[1].findAll('.desktop-session')).toHaveLength(2)

    await project.trigger('click')
    expect(project.attributes('aria-expanded')).toBe('true')
    expect(project.find('.desktop-folder-icon-open').exists()).toBe(true)
    expect(firstGroup.findAll('.desktop-session')).toHaveLength(2)
    wrapper.unmount()
  })

  it('默认只展开并选中第一个项目，其他项目可手动展开', async () => {
    sessionsAPI.list.mockImplementation(async hash => ({success: true, data:
      Array.from({length: 7}, (_, i) => ({name: hash + '-' + i, title: hash + ' 会话 ' + i, mtime: 100 - i}))
    }))
    const wrapper = mountHome({sidebarOnly: true, activeWorkspaceHash: 'h1'})
    await flushPromises()
    const groups = wrapper.findAll('.desktop-project-group')
    expect(groups).toHaveLength(3)
    expect(groups[0].find('.desktop-project').classes()).toContain('active')
    expect(groups[0].find('.desktop-project').attributes('aria-expanded')).toBe('true')
    expect(groups[0].findAll('.desktop-session')).toHaveLength(5)
    expect(groups[1].find('.desktop-project').attributes('aria-expanded')).toBe('false')
    expect(groups[1].findAll('.desktop-session')).toHaveLength(0)
    expect(groups[2].find('.desktop-project').attributes('aria-expanded')).toBe('false')
    expect(groups[2].findAll('.desktop-session')).toHaveLength(0)

    await groups[1].find('.desktop-project').trigger('click')
    expect(groups[1].findAll('.desktop-session')).toHaveLength(5)
    expect(groups[1].find('.desktop-session-name').text()).toBe('h2 会话 0')
    await groups[0].find('.desktop-show-sessions').trigger('click')
    expect(groups[0].findAll('.desktop-session')).toHaveLength(7)
    expect(groups[1].findAll('.desktop-session')).toHaveLength(5)
    await wrapper.find('input[type="search"]').setValue('h2 会话 6')
    expect(wrapper.findAll('.desktop-session')).toHaveLength(1)
    expect(groups[1].find('.desktop-session-name').text()).toBe('h2 会话 6')
    wrapper.unmount()
  })

  it('悬停超长会话标题时滚动到右侧，移开后回到开头', async () => {
    sessionsAPI.list.mockResolvedValue({success: true, data: [
      {name: 's1', title: '这是一个足够长的会话标题，用来测试悬停横向滚动', mtime: 100}
    ]})
    const wrapper = mountHome({sidebarOnly: true})
    await flushPromises()

    const session = wrapper.find('.desktop-session')
    const name = session.find('.desktop-session-name').element
    const title = session.find('.desktop-session-name-text').element
    Object.defineProperty(name, 'clientWidth', {configurable: true, value: 120})
    Object.defineProperty(title, 'scrollWidth', {configurable: true, value: 280})
    await session.trigger('mouseenter')
    expect(name.classList.contains('is-overflowing')).toBe(true)
    expect(name.style.getPropertyValue('--desktop-session-fade-width')).toBe('22px')
    expect(title.style.transform).toBe('translateX(-160px)')

    await session.trigger('mouseleave')
    expect(title.style.transform).toBe('translateX(0)')

    Object.defineProperty(title, 'scrollWidth', {configurable: true, value: 100})
    await session.trigger('mouseenter')
    expect(name.classList.contains('is-overflowing')).toBe(false)
    expect(title.style.transform).toBe('translateX(0)')
    wrapper.unmount()
  })
})

describe('DesktopHome 会话状态图标', () => {
  let wrapper
  const recentMtime = Date.now()
  const sessions = [
    {name: 'running', title: '你好', messageCount: 2, mtime: recentMtime},
    {name: 'completed', title: '回应问候', messageCount: 2, mtime: recentMtime - 1000},
    {name: 'empty', title: '新会话', messageCount: 0, mtime: recentMtime - 2000},
    {name: 'old-completed', title: '旧会话', messageCount: 2, mtime: recentMtime - 2 * 24 * 60 * 60 * 1000}
  ]

  beforeEach(() => {
    window.localStorage.removeItem('loopra.desktop.session-read-state')
    sessionsAPI.list.mockImplementation(async (hash) => ({
      success: true,
      data: hash === 'h1' ? sessions : []
    }))
    agentAPI.getSessionStatus.mockImplementation(async (_workspaceHash, sessionName) => ({
      success: true,
      data: {running: sessionName === 'running'}
    }))
    wrapper = mountHome({sidebarOnly: true})
  })

  afterEach(() => {
    wrapper.unmount()
    window.localStorage.removeItem('loopra.desktop.session-read-state')
  })

  it('运行中的会话显示动态图标，已完成会话显示彩色小点，空会话不显示状态', async () => {
    await flushPromises()
    const rows = wrapper.findAll('.desktop-project-group')[0].findAll('.desktop-session')

    expect(rows[0].find('.desktop-session-status-running').exists()).toBe(true)
    expect(rows[0].find('.desktop-session-status-completed').exists()).toBe(false)
    expect(rows[1].find('.desktop-session-status-completed').exists()).toBe(true)
    expect(rows[1].find('.desktop-session-status-completed').attributes('aria-label')).toBe('已完成')
    expect(rows[2].find('.desktop-session-status').exists()).toBe(false)
    expect(rows[3].find('.desktop-session-status').exists()).toBe(false)

    await rows[1].trigger('click')
    expect(rows[1].find('.desktop-session-status-completed').exists()).toBe(false)
    expect(JSON.parse(window.localStorage.getItem('loopra.desktop.session-read-state'))).toEqual({
      'h1:completed': {mtime: sessions[1].mtime, messageCount: 2}
    })
  })

  it('输入框同步上报的运行状态优先于侧栏轮询结果', async () => {
    wrapper.unmount()
    agentAPI.getSessionStatus.mockResolvedValue({success: true, data: {running: false}})
    wrapper = mountHome({
      sidebarOnly: true,
      liveSessionStatuses: {'h1:running': true}
    })
    await flushPromises()
    const rows = wrapper.findAll('.desktop-project-group')[0].findAll('.desktop-session')

    expect(rows[0].find('.desktop-session-status-running').exists()).toBe(true)
    expect(rows[0].find('.desktop-session-status-completed').exists()).toBe(false)
  })

  it('当前打开的已完成会话不显示彩色小点', async () => {
    wrapper.unmount()
    wrapper = mountHome({
      sidebarOnly: true,
      activeWorkspaceHash: 'h1',
      activeSessionName: 'completed'
    })
    await flushPromises()
    const rows = wrapper.findAll('.desktop-project-group')[0].findAll('.desktop-session')

    expect(rows[1].find('.desktop-session-status-completed').exists()).toBe(false)
  })
})

describe('DesktopHome 左侧会话顺序', () => {
  it('首条消息到达时先显示尚未落盘的乐观会话', async () => {
    sessionsAPI.list.mockResolvedValue({success: true, data: []})
    const wrapper = mountHome({
      sidebarOnly: true,
      optimisticSessions: [{
        workspaceHash: 'h1',
        name: 'loopra-new-session',
        title: '你好啊',
        messageCount: 1,
        mtime: Date.now()
      }]
    })
    await flushPromises()

    const rows = wrapper.findAll('.desktop-project-group')[0].findAll('.desktop-session')
    expect(rows).toHaveLength(1)
    expect(rows[0].find('.desktop-session-name').text()).toBe('你好啊')

    wrapper.unmount()
  })

  it('激活会话后仍保留在原列表位置，只更新当前高亮', async () => {
    sessionsAPI.list.mockImplementation(async () => ({success: true, data: [
      {name: 's1', title: '会话一', mtime: 300},
      {name: 's2', title: '会话二', mtime: 200},
      {name: 's3', title: '会话三', mtime: 100}
    ]}))
    const wrapper = mountHome({sidebarOnly: true})
    await flushPromises()

    const sessionNames = () => wrapper.findAll('.desktop-project-group')[0]
      .findAll('.desktop-session-name')
      .map((item) => item.text())
    expect(sessionNames()).toEqual(['会话一', '会话二', '会话三'])

    await wrapper.setProps({
      activeSessionName: 's2',
      activeWorkspaceHash: 'h1'
    })

    expect(sessionNames()).toEqual(['会话一', '会话二', '会话三'])
    expect(wrapper.findAll('.desktop-project-group')[0].findAll('.desktop-session')[1].classes()).toContain('active')
    wrapper.unmount()
  })
})

describe('DesktopHome 会话拖拽排序', () => {
  let wrapper
  const storageKey = 'loopra.desktop.session-order'
  const sessions = [
    {name: 's1', title: '会话一', mtime: 300},
    {name: 's2', title: '会话二', mtime: 200},
    {name: 's3', title: '会话三', mtime: 100}
  ]

  beforeEach(() => {
    window.localStorage.removeItem(storageKey)
    sessionsAPI.list.mockImplementation(async (hash) => ({
      success: true,
      data: hash === 'h1' ? sessions : []
    }))
    wrapper = mountHome({sidebarOnly: true})
  })

  afterEach(() => {
    wrapper.unmount()
    window.localStorage.removeItem(storageKey)
  })

  it('拖拽会话时保持列表位置，松手后按上下插入并记住顺序', async () => {
    await flushPromises()
    const group = wrapper.findAll('.desktop-project-group')[0]
    const sessionRows = () => group.findAll('.desktop-session')

    expect(sessionRows().map((row) => row.find('.desktop-session-name').text())).toEqual(['会话一', '会话二', '会话三'])

    await sessionRows()[0].trigger('dragstart')
    expect(sessionRows()[0].classes()).toContain('dragging')

    const target = sessionRows()[2]
    mockRect(target.element, {top: 0, height: 32})
    dispatchDragEvent(target.element, 'dragover', 40)
    await flushPromises()

    expect(sessionRows().map((row) => row.find('.desktop-session-name').text())).toEqual(['会话一', '会话二', '会话三'])
    expect(target.classes()).toContain('drag-over-after')

    await target.trigger('drop')
    expect(sessionRows().map((row) => row.find('.desktop-session-name').text())).toEqual(['会话二', '会话三', '会话一'])
    expect(JSON.parse(window.localStorage.getItem(storageKey))).toEqual({h1: ['s2', 's3', 's1']})
  })
})

describe('DesktopHome 桌面搜索面板', () => {
  let wrapper

  beforeEach(() => {
    sessionsAPI.list.mockImplementation(async hash => ({success: true, data: [
      {name: `${hash}-0`, title: `${hash} 会话 0`, mtime: 300},
      {name: `${hash}-1`, title: `${hash} 会话 1`, mtime: 200}
    ]}))
    wrapper = mountHome({sidebarOnly: true, activeWorkspaceHash: 'h1', activeSessionName: 'h1-0'})
  })

  afterEach(() => {
    wrapper.unmount()
  })

  it('点击放大镜打开居中的聊天面板，并展示最近会话与快捷操作', async () => {
    await flushPromises()
    await wrapper.find('[aria-label="搜索会话"]').trigger('click')

    const palette = document.body.querySelector('.desktop-search-palette')
    expect(palette).not.toBeNull()
    expect(wrapper.emitted('search-visibility-change')[0]).toEqual([true])
    expect(palette.querySelector('input[aria-label="搜索聊天"]')).not.toBeNull()
    expect(palette.textContent).toContain('聊天')
    expect(palette.textContent).toContain('h1 会话 0')
    expect(palette.textContent).toContain('快捷操作')
    expect(palette.textContent).toContain('打开文件夹')
    expect(palette.textContent).toContain('Ctrl+P')
  })

  it('输入内容后筛选结果，Enter 可触发快捷操作，Esc 关闭面板', async () => {
    await flushPromises()
    await wrapper.find('[aria-label="搜索会话"]').trigger('click')
    const input = document.body.querySelector('input[aria-label="搜索聊天"]')

    input.value = '搜索文件'
    input.dispatchEvent(new Event('input', {bubbles: true}))
    await flushPromises()
    expect(document.body.querySelectorAll('.desktop-search-result')).toHaveLength(1)
    expect(document.body.querySelector('.desktop-search-result-title').textContent).toBe('搜索文件')
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
    await flushPromises()
    expect(wrapper.emitted('open-file-search')).toBeTruthy()
    expect(document.body.querySelector('.desktop-search-palette')).toBeNull()

    await wrapper.find('[aria-label="搜索会话"]').trigger('click')
    document.body.querySelector('input[aria-label="搜索聊天"]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
    await flushPromises()
    expect(document.body.querySelector('.desktop-search-palette')).toBeNull()
    expect(wrapper.emitted('search-visibility-change').at(-1)).toEqual([false])
  })
})
