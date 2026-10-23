<template>
  <div v-show="visible" ref="reactHost" class="startup-react-host workspace-theme" :class="{ dark: theme === 'dark' }" :data-theme="theme" />
</template>

<script setup>
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue'
import {platform} from '@/services/platform'
import {
  MIRROR_SOURCES,
  applyLatencies,
  loadCachedLatencies,
  loadSelectedMirrorSource,
  measureMirrors,
  saveSelectedMirrorSource,
  sortMirrors
} from '@/utils/mirrors'
import {useAppStore} from '@/stores/app'
import {mountStartupScreen} from '../../web/src/startup-screen'

const { loopraWebService } = platform.implementation

const emit = defineEmits(['ready', 'error'])

const store = useAppStore()
const colorScheme = window.matchMedia?.('(prefers-color-scheme: dark)')
const systemDark = ref(colorScheme?.matches ?? false)
const workspacePreferences = ref(readWorkspacePreferences())
const theme = computed(() => {
  const selected = workspacePreferences.value?.theme
  if (selected) return selected === '深色' || selected === '月之暗面' || (selected === '跟随系统' && systemDark.value) ? 'dark' : 'light'
  return store.settings.theme === 'dark' ? 'dark' : 'light'
})

function readWorkspacePreferences() {
  try { return JSON.parse(localStorage.getItem('loopra:preferences') || 'null') }
  catch { return null }
}

function syncWorkspacePreferences(event) {
  if (event.key === 'loopra:preferences' || event.key === null) workspacePreferences.value = readWorkspacePreferences()
}

function syncSystemTheme(event) { systemDark.value = event.matches }

onMounted(() => {
  window.addEventListener('storage', syncWorkspacePreferences)
  colorScheme?.addEventListener('change', syncSystemTheme)
})

onUnmounted(() => {
  window.removeEventListener('storage', syncWorkspacePreferences)
  colorScheme?.removeEventListener('change', syncSystemTheme)
})

const visible = ref(true)
const menu = ref('core') // core | deps

// 更新窗口无更新时保留管理页；完成更新或启动后自动进入主界面。
const updateMode = new URLSearchParams(window.location.search).get('from') === 'update'

// 核心端状态
const installed = ref(false)
const running = ref(false)
const port = ref(0)
const bundledCore = ref(false)
const bundledVersion = ref('')
const installDir = ref('')
const runtimeVersion = ref('')
const desktopVersion = ref('')
const coreBusy = ref(false)
const installing = ref(false)
const starting = ref(false)
const errorMessage = ref('')

// 依赖状态
const java = ref({
  system: {found: false, path: '', version: '', major: 0},
  bundled: {found: false, path: '', version: '', major: 0},
  used: '',
  usable: false,
  requiredMajor: 17,
  hint: ''
})
const javaChecking = ref(false)
let waitingForJava = false

// JRE 25 自动下载
const jreDownloading = ref(false)
const jrePercent = ref(0)
const jreLogs = ref([])
const jreLogRef = ref(null)
// JRE 下载源：'normal'（GitHub 直连）或具体镜像 URL；镜像下拉从 MIRROR_SOURCES 获取，自动测速排序
const jreSource = ref(loadSelectedMirrorSource())
watch(jreSource, (value) => saveSelectedMirrorSource(value))

// 镜像列表（latency 由测速填充），按延迟升序排列（未测/失败的排末尾）
const mirrorList = ref(sortMirrors(applyLatencies(MIRROR_SOURCES, loadCachedLatencies())))
const testingMirrors = ref(false)
const jreOptions = computed(() => mirrorList.value)

// 自动测速：并发测速所有镜像并按延迟排序（结果缓存 30 分钟，过期自动重测）
async function runMirrorSpeedTest() {
  if (testingMirrors.value) return
  testingMirrors.value = true
  try {
    mirrorList.value = await measureMirrors(MIRROR_SOURCES)
  } catch (e) {
    console.warn('[Splash] mirror speed test failed:', e)
  } finally {
    testingMirrors.value = false
  }
}

// 安装日志
const installLogs = ref([])
const logContainer = ref(null)
let unlistenInstallOutput = null

const busy = computed(() => installing.value || starting.value || coreBusy.value)

// 呼吸闪烁（吸引注意）：核心服务启动成功后提示进入；无 Java 时提示安装 JRE
const enterPulse = ref(false)
const jrePulse = ref(false)

let autoEntered = false // 本次窗口会话最多自动进入一次
let enterWhenReady = !updateMode

function maybeAutoEnter() {
  if (!enterWhenReady || autoEntered || startCancelled || !running.value || !java.value.usable || autoStarting.value || starting.value || installing.value || errorMessage.value) return
  autoEntered = true
  void enterLoopra()
}

// 启动等待：窗口中央转圈，可取消
const autoStarting = ref(false)
const startingMsg = ref('')
let startCancelled = false

function cancelStart() {
  startCancelled = true
}

// 版本状态
const versionStateClass = computed(() => {
  if (runtimeVersion.value && desktopVersion.value) {
    const cmp = compareVersions(runtimeVersion.value, desktopVersion.value)
    if (cmp === 0) return 'ok'
    if (cmp < 0) return 'warn'
    return 'info'
  }
  return ''
})
const versionStateText = computed(() => {
  if (!installed.value) return '未安装'
  if (!runtimeVersion.value) return '版本未知'
  const cmp = compareVersions(runtimeVersion.value, desktopVersion.value)
  if (cmp === 0) return '版本一致'
  if (cmp < 0) return '核心服务可更新'
  return '核心服务较新'
})

// Java 各卡片状态
const systemStateClass = computed(() => {
  if (java.value.system.found && java.value.system.major >= 17) return 'ok'
  if (java.value.system.found) return 'warn'
  return 'off'
})
const systemStateText = computed(() => {
  if (java.value.system.found && java.value.system.major >= 17) return '可用'
  if (java.value.system.found) return '版本过低'
  return '未找到'
})
const bundledStateClass = computed(() => {
  if (java.value.bundled.found && java.value.bundled.major >= 17) return 'ok'
  if (java.value.bundled.found) return 'warn'
  return 'off'
})
const bundledStateText = computed(() => {
  if (java.value.bundled.found && java.value.bundled.major >= 17) return '可用'
  if (java.value.bundled.found) return '版本过低'
  return '未找到'
})

onMounted(async () => {
  // 镜像测速：无新鲜缓存（30 分钟内）时自动重测并按延迟排序，不阻塞主流程
  if (!loadCachedLatencies()) void runMirrorSpeedTest()
  await prepareService()
})

function showJavaSetup() {
  waitingForJava = true
  autoStarting.value = false
  menu.value = 'deps'
  jrePulse.value = true
}

async function prepareService({ refresh = true, resume = false } = {}) {
  // 打开即进入启动等待：先检测核心/Java 状态，据此决定是否需要先自动更新再启动
  autoStarting.value = true
  startCancelled = false
  startingMsg.value = '正在检查核心服务...'
  try {
    if (refresh) await refreshCore()
    if (startCancelled) return

    // 核心文件更新优先，不依赖本机是否已经配置 Java。
    const autoUpdateResult = await runAutoUpdateIfNeeded()
    if (autoUpdateResult === 'failed' || startCancelled) return
    await refreshJava()
    if (startCancelled) return
    if (!java.value.usable) {
      showJavaSetup()
      return
    }
    waitingForJava = false

    menu.value = 'core'
    if (!updateMode || autoUpdateResult === 'updated' || resume) await startService({ overlay: true })
  } finally {
    autoStarting.value = false
    maybeAutoEnter()
  }
}

onUnmounted(() => {
  if (unlistenInstallOutput) unlistenInstallOutput()
})

function switchMenu(name) {
  menu.value = name
  if (name === 'deps' && !java.value.checked) refreshJava()
}

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(Number)
  const pb = String(b || '').replace(/^v/i, '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

// ---------- 核心端状态刷新 ----------
async function refreshCore() {
  coreBusy.value = true
  errorMessage.value = ''
  try {
    const status = await loopraWebService.getStatus()
    if (status) {
      installed.value = !!status.installed
      bundledCore.value = !!status.bundled_core
      bundledVersion.value = status.bundled_version || ''
      installDir.value = status.install_dir || ''
      runtimeVersion.value = status.runtime_version || ''
      desktopVersion.value = status.desktop_version || ''
    }

    // The main process decides whether an external development service can be reused.
    let p = 0
    try { p = await loopraWebService.getCurrentPort() } catch {}
    let isRunning = !!(status && status.running)
    let livePort = p
    if (p > 0) {
      const ok = await healthCheck(p)
      isRunning = isRunning || ok
      livePort = ok ? p : 0
    }
    // 同步端口到 localStorage：复用已运行服务时（如开发模式下的 CLI 服务）refreshCore 会先于
    // startService 完成，若不在此同步，用户快速进入主窗口会读到上次会话遗留的旧地址（随机端口已失效）→ Network Error
    if (livePort > 0) {
      localStorage.setItem('loopra-port', String(livePort))
      localStorage.setItem('loopra-api-base', `http://127.0.0.1:${livePort}`)
    }
    running.value = isRunning
    port.value = livePort
    // 服务运行中：进入按钮呼吸闪提示
    if (isRunning) {
      enterPulse.value = true
    }
  } catch (e) {
    console.warn('[Splash] refresh core status failed:', e)
    errorMessage.value = e.message || '获取核心状态失败'
  } finally {
    coreBusy.value = false
  }
}

// ---------- JRE/JDK 检测 ----------
async function refreshJava() {
  javaChecking.value = true
  try {
    const result = await loopraWebService.detectJavaStatus()
    if (result) {
      java.value = {
        system: result.system || {found: false, path: '', version: '', major: 0},
        bundled: result.bundled || {found: false, path: '', version: '', major: 0},
        used: result.used || '',
        usable: !!result.usable,
        requiredMajor: result.requiredMajor || 17,
        hint: result.hint || '',
        checked: true
      }
    }
  } catch (e) {
    console.warn('[Splash] refresh java status failed:', e)
    java.value.hint = 'Java 环境检测失败: ' + (e.message || e)
    java.value.checked = true
  } finally {
    javaChecking.value = false
  }
}

async function recheckJava() {
  await refreshJava()
  if (waitingForJava && java.value.usable) await prepareService({ refresh: false, resume: true })
}

// ---------- JRE 25 自动下载安装 ----------
async function downloadJre() {
  if (jreDownloading.value) return
  jreDownloading.value = true
  jrePercent.value = 0
  jreLogs.value = []
  jrePulse.value = false

  const unlisteners = []
  try {
    // 监听主进程推送的下载日志 / 进度
    const un1 = await platform.implementation.events.listen('jre-download-output', (payload) => {
      if (payload && payload.line) {
        jreLogs.value.push(payload.line)
        nextTick(() => {
          const el = jreLogRef.value
          if (el) el.scrollTop = el.scrollHeight
        })
      }
    })
    const un2 = await platform.implementation.events.listen('jre-download-progress', (payload) => {
      if (payload && typeof payload.percent === 'number' && payload.percent >= 0) {
        jrePercent.value = payload.percent
      }
    })
    unlisteners.push(un1, un2)
  } catch (e) {
    console.warn('[Splash] Failed to listen jre download events:', e)
  }

  try {
    const result = await loopraWebService.downloadJre25(jreSource.value)
    jrePercent.value = 100
    if (result && result.success) {
      jreLogs.value.push('✅ JRE 25 已安装到 ' + (result.dir || '~/.loopra-gui/jre25'))
      // 安装后刷新 Java 与核心状态
      await Promise.all([refreshJava(), refreshCore()])
      if (java.value.usable) await prepareService({ refresh: false, resume: true })
    }
  } catch (e) {
    jreLogs.value.push(`❌ 下载安装失败: ${e.message || e}`)
  } finally {
    unlisteners.forEach((fn) => { try { fn && fn() } catch {} })
    jreDownloading.value = false
  }
}

// ---------- 安装 / 更新 ----------
// 手动按钮入口：点击「安装核心服务 / 更新核心服务」
async function installOrUpdate() {
  startCancelled = false
  autoStarting.value = true
  try {
    const updated = await performCoreUpdate({ auto: true })
    if (updated && !startCancelled) await prepareService({ refresh: false, resume: true })
  } finally {
    autoStarting.value = false
  }
}

// 自动更新判定：安装包内置核心比已安装核心新（或核心尚未安装且包内有核心）→ true。
// 以包内核心版本文件为权威，与桌面端版本号（app.getVersion()）解耦——两者可能不同步
function shouldAutoUpdateCore() {
  if (!bundledCore.value || !bundledVersion.value) return false
  if (!installed.value) return true
  if (runtimeVersion.value && compareVersions(runtimeVersion.value, bundledVersion.value) >= 0) return false
  return true
}

// 启动流程静默更新入口：返回 'updated'（已成功更新）/ 'skipped'（无需更新）/ 'failed'（更新失败）
async function runAutoUpdateIfNeeded() {
  if (!shouldAutoUpdateCore()) return 'skipped'
  const ok = await performCoreUpdate({ auto: true })
  return ok ? 'updated' : 'failed'
}

// 安装/更新核心服务：
// - auto=false（手动按钮）：更新完成后自动重启服务，加载新版本
// - auto=true（启动流程静默触发）：仅安装，重启交由调用方统一 startService；
//   失败时停止自动流程并停留在管理页（errorMessage + 日志），避免启动可能被写坏的 jar
async function performCoreUpdate({ auto = false } = {}) {
  if (installing.value) return false
  installing.value = true
  errorMessage.value = ''
  installLogs.value = []
  const versionDesc = runtimeVersion.value && bundledVersion.value ? `（${runtimeVersion.value} → ${bundledVersion.value}）` : ''

  try {
    unlistenInstallOutput = await platform.implementation.events.listen('install-output', (payload) => {
      if (payload && payload.line) {
        installLogs.value.push(payload.line)
        nextTick(() => {
          const el = logContainer.value
          if (el) el.scrollTop = el.scrollHeight
        })
      }
    })
  } catch (e) {
    console.warn('[Splash] Failed to listen install output:', e)
  }

  try {
    if (auto) {
      menu.value = 'core'
      installLogs.value.push(`>> 检测到安装包内置核心更新${versionDesc}，正在自动更新（无需操作）...`)
      startingMsg.value = `正在自动更新核心服务${versionDesc} ...`
    }

    // 更新前先停止运行中的旧服务：释放 Windows 下 loopra-web.jar 文件占用，
    // 避免 install.ps1 覆盖 jar 失败；更新完成后自动重启以加载新版本
    const wasRunning = running.value
    if (wasRunning) {
      installLogs.value.push('>> 检测到核心服务正在运行，先停止旧服务...')
      await stopService()
      if (errorMessage.value) {
        installLogs.value.push(`>> ❌ 停止旧服务失败: ${errorMessage.value}，已中止更新`)
        return false
      }
      installLogs.value.push('>> 旧服务已停止')
    }

    // 仅使用安装包内置核心运行时本地安装/更新（不做在线下载回退）
    await loopraWebService.installLocal()
    installLogs.value.push('')
    installLogs.value.push('✅ 安装完成')
    installed.value = true
    // 先完成核心文件更新，Java 检查交给后续启动流程。
    await refreshCore()

    // 更新完成后自动重启服务，加载新版本
    installLogs.value.push('')
    if (running.value) {
      // 停止后端口仍有服务在运行（如 CLI 启动的 4567，不属于本次更新对象）：不打断，仅提示
      installLogs.value.push('>> 检测到端口已有其他进程运行服务（可能由 CLI 启动），已跳过自动重启；新版本将在下次启动服务时生效')
      return true
    }
    if (auto) {
      // 自动模式不在此重启：由启动流程统一 startService
      installLogs.value.push('✅ 核心自动更新完成，接下来检查 JRE/JDK 并启动服务')
      return true
    }
    installLogs.value.push('✅ 更新完成，正在自动重启服务...')
    await startService({ overlay: true })
    if (errorMessage.value) {
      installLogs.value.push(`>> ⚠️ 服务自动重启失败: ${errorMessage.value}，可点击「启动服务」手动启动`)
      return false
    }
    installLogs.value.push('✅ 服务已重启，当前使用新版本')
    return true
  } catch (e) {
    errorMessage.value = `安装失败: ${e.message || e}`
    if (auto) {
      installLogs.value.push(`>> ❌ 自动更新失败: ${e.message || e}。可点击「重试自动更新」重试`)
    }
    return false
  } finally {
    if (unlistenInstallOutput) {
      unlistenInstallOutput()
      unlistenInstallOutput = null
    }
    installing.value = false
  }
}

// ---------- 启动 / 停止 / 重启 ----------
async function startService(options = {}) {
  if (starting.value) return
  if (!java.value.usable) { showJavaSetup(); return }
  enterWhenReady = true
  if (running.value) {
    autoStarting.value = false
    return
  }
  starting.value = true
  startCancelled = false
  errorMessage.value = ''
  const withOverlay = !!options.overlay
  if (withOverlay) {
    autoStarting.value = true
    startingMsg.value = '正在启动核心服务...'
  }
  try {
    let targetPort = 0
    try { targetPort = await loopraWebService.getCurrentPort() } catch {}
    if (targetPort <= 0) {
      targetPort = await loopraWebService.start()
    }
    if (startCancelled) {
      // 用户取消等待：停止轮询并清理刚启动的进程
      if (targetPort > 0) {
        try { await loopraWebService.stop() } catch {}
      }
      return
    }
    if (targetPort > 0) {
      localStorage.setItem('loopra-port', String(targetPort))
      localStorage.setItem('loopra-api-base', `http://127.0.0.1:${targetPort}`)
      const ready = await pollHealthCheck(
        targetPort, 20, 1500,
        () => startCancelled,
        (i, max) => { startingMsg.value = `等待服务就绪... (${i}/${max})` }
      )
      if (startCancelled) {
        // 用户取消等待：停止轮询并清理刚启动的进程
        try { await loopraWebService.stop() } catch {}
        return
      }
      if (ready) {
        running.value = true
        port.value = targetPort
        enterPulse.value = true
      } else {
        errorMessage.value = `服务启动超时，端口 ${targetPort} 未响应健康检查`
      }
    } else {
      errorMessage.value = '未找到可用端口，请检查服务是否已启动'
    }
  } catch (e) {
    if (/loopra (?:not found|desktop runtime not found):/i.test(e.message || '')) {
      errorMessage.value = '核心服务未安装，请先点击「安装核心服务」'
    } else {
      errorMessage.value = `启动失败: ${e.message || e}`
    }
  } finally {
    starting.value = false
    if (withOverlay) autoStarting.value = false
    maybeAutoEnter()
  }
}

async function stopService() {
  if (!running.value) return
  errorMessage.value = ''
  try {
    await loopraWebService.stop()
    running.value = false
    port.value = 0
  } catch (e) {
    errorMessage.value = `停止失败: ${e.message || e}`
  }
}

async function restartService() {
  await stopService()
  if (!errorMessage.value) await startService()
}


async function enterLoopra() {
  enterPulse.value = false
  // 通知外层（DesktopSplash）调用 splash.ready：创建主窗口并关闭本窗口
  emit('ready')
}

// ---------- 健康检查 ----------
async function healthCheck(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/system/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    })
    return resp.ok
  } catch {
    return false
  }
}

async function pollHealthCheck(port, maxAttempts = 20, intervalMs = 1500, isCancelled, onProgress) {
  const baseUrl = `http://127.0.0.1:${port}`
  const healthUrl = `${baseUrl}/api/system/health`
  for (let i = 1; i <= maxAttempts; i++) {
    if (isCancelled && isCancelled()) {
      console.log('[Splash] Health check cancelled by user')
      return false
    }
    if (onProgress) onProgress(i, maxAttempts)
    try {
      const resp = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      })
      if (resp.ok) {
        console.log(`[Splash] Health check OK on attempt ${i}/${maxAttempts}, port ${port}`)
        return true
      }
    } catch (e) {
      console.log(`[Splash] Health check failed on attempt ${i}/${maxAttempts}: ${e.message || e}`)
    }
    await sleep(intervalMs)
  }
  console.error(`[Splash] Health check timed out after ${maxAttempts} attempts on port ${port}`)
  return false
}

function openJavaDownload() {
  const url = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/'
  if (platform.isElectron && window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

async function closeApp() {
  try {
    await platform.implementation.window.close()
    return
  } catch (e) {
    console.warn('[Splash] Failed to close window via platform API:', e)
  }
  window.close()
  setTimeout(() => {
    alert('请手动关闭此窗口')
  }, 200)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}


// Vue owns the existing service lifecycle; React renders the complete NextUI view.
const reactHost = ref(null)
let reactView
const viewState = computed(() => ({
  visible: visible.value,
  theme: theme.value,
  menu: menu.value,
  autoStarting: autoStarting.value,
  startingMsg: startingMsg.value,
  installed: installed.value,
  running: running.value,
  port: port.value,
  bundledCore: bundledCore.value,
  bundledVersion: bundledVersion.value,
  installDir: installDir.value,
  runtimeVersion: runtimeVersion.value,
  desktopVersion: desktopVersion.value,
  coreBusy: coreBusy.value,
  installing: installing.value,
  starting: starting.value,
  busy: busy.value,
  errorMessage: errorMessage.value,
  javaChecking: javaChecking.value,
  versionStateClass: versionStateClass.value,
  versionStateText: versionStateText.value,
  systemStateClass: systemStateClass.value,
  systemStateText: systemStateText.value,
  bundledStateClass: bundledStateClass.value,
  bundledStateText: bundledStateText.value,
  jreSource: jreSource.value,
  testingMirrors: testingMirrors.value,
  jreDownloading: jreDownloading.value,
  jrePercent: jrePercent.value,
  enterPulse: enterPulse.value,
  jrePulse: jrePulse.value,
  java: { ...java.value, system: { ...java.value.system }, bundled: { ...java.value.bundled } },
  jreOptions: jreOptions.value.map(item => ({ ...item })),
  installLogs: [...installLogs.value],
  jreLogs: [...jreLogs.value],
}))
const actions = {
  cancelStart, closeApp, switchMenu, enterLoopra, refreshCore, refreshJava: recheckJava,
  installOrUpdate, startService: () => startService(), stopService, restartService,
  downloadJre, runMirrorSpeedTest, openJavaDownload,
  setJreSource: value => { jreSource.value = value },
  setInstallLogElement: element => { logContainer.value = element },
  setJreLogElement: element => { jreLogRef.value = element },
}
onMounted(() => { reactView = mountStartupScreen(reactHost.value, viewState.value, actions) })
watch(viewState, value => reactView?.render(value), { flush: 'post' })
onUnmounted(() => reactView?.unmount())

defineExpose({
  refreshCore,
  refreshJava,
  hide: () => { visible.value = false }
})
</script>
