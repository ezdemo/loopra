import {createApp} from 'vue'
import {createPinia} from 'pinia'
import 'ant-design-vue/dist/reset.css'
import 'katex/dist/katex.min.css' // 数学公式渲染样式（含字体）
import '@vscode/codicons/dist/codicon.css' // VS Code 图标字体（codicon）
import '@fontsource-variable/jetbrains-mono' // JetBrains Mono 全局字体（含 @font-face）
// 中文字体：不预置，桌面端可在设置 → 外观 → 中文字体 中选择系统已安装字体
import './utils/highlight' // 高亮初始化（Shiki 预载在模块加载时自动开始，不阻塞首屏）
import './assets/styles/main.css'
import './assets/styles/desktop.css'
import {installDesktopMessageBridge} from './utils/desktopMessage'

const resolveRootComponent = (page) => {
  if (page.get('desktopShell') === '1') return () => import('./DesktopShell.vue')
  if (page.get('desktopSplash') === '1') return () => import('./DesktopSplash.vue')
  if (page.get('desktopUpdate') === '1') return () => import('./DesktopUpdate.vue')
  if (page.get('desktopOnboarding') === '1') return () => import('./DesktopOnboarding.vue')
  if (page.get('desktopChatTab') === '1') return () => import('./DesktopChatTab.vue')
  if (page.get('desktopSearch') === '1') return () => import('./DesktopSearch.vue')
  if (page.get('desktopMessage') === '1') return () => import('./DesktopMessage.vue')
  if (page.get('desktopPopup') === '1') return () => import('./DesktopPopup.vue')
  if (page.get('desktopPet') === '1') return () => import('./DesktopPet.vue')
  if (page.get('requirementBoard') === '1') return () => import('./views/RequirementBoard.vue')
  return () => import('./App.vue')
}

// 初始化应用
const initApp = async () => {
  const page = new URLSearchParams(window.location.search)
  const desktopShell = page.get('desktopShell') === '1'
  const desktopChatTab = page.get('desktopChatTab') === '1'
  const desktopSearch = page.get('desktopSearch') === '1'
  const desktopMessage = page.get('desktopMessage') === '1'
  const desktopPopup = page.get('desktopPopup') === '1'
  const webApp = ![...page.keys()].some((key) => [
    'desktopShell', 'desktopSplash', 'desktopUpdate', 'desktopOnboarding', 'desktopChatTab', 'desktopSearch', 'desktopMessage', 'desktopPopup', 'desktopPet', 'requirementBoard'
  ].includes(key) && page.get(key) === '1')

  // 根页面代码与运行时配置并行加载，避免每个桌面子窗口加载无关页面。
  const [rootModule] = await Promise.all([
    resolveRootComponent(page)(),
    import('./services/api').then(({initConfig}) => initConfig())
  ])
  const app = createApp(rootModule.default)

  if (desktopShell || desktopChatTab) installDesktopMessageBridge()

  // 添加 Pinia 状态管理
  const pinia = createPinia()
  app.use(pinia)

  // 只有 Web 主应用使用路由，桌面子窗口均由查询参数决定根页面。
  if (webApp) {
    const {default: router} = await import('./router')
    app.use(router)
  }

  // Pinia 初始化后，执行 store 的 initialize
  const { useAppStore } = await import('./stores/app')
  const store = useAppStore()
  store.initialize()

  // 全局错误处理
  app.config.errorHandler = (err, vm, info) => {
    console.error('全局错误:', err, info)
  }

  // 全局警告处理（开发环境）
  if (import.meta.env.DEV) {
    app.config.warnHandler = (msg, vm, trace) => {
      console.warn('Vue警告:', msg, trace)
    }
  }

  // 全局属性
  app.config.globalProperties.$appName = 'Loopra'
  app.config.globalProperties.$version = '1.0.0'

  // 挂载应用
  app.mount('#app')

  // 桌面聊天标签优先展示可交互首屏；其他窗口保留原加载动画。
  const loader = document.getElementById('app-loader')
  if (loader) {
    if (desktopChatTab || desktopSearch || desktopMessage || desktopPopup) {
      requestAnimationFrame(() => loader.remove())
    } else {
      setTimeout(() => {
        loader.style.opacity = '0'
        setTimeout(() => {
          loader.remove()
        }, 300)
      }, 500)
    }
  }

  console.log('Loopra v' + app.config.globalProperties.$version + ' 已启动')
}

// 等待DOM加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp)
} else {
  initApp()
}
