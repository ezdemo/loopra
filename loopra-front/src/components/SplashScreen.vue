<template>
  <div class="startup-window" :data-theme="theme" v-if="visible">
    <!-- 启动等待：中央转圈，可取消 -->
    <div v-if="autoStarting" class="sw-starting-overlay">
      <div class="sw-loading-mark">
        <img src="@/assets/logo.svg" alt="Loopra" class="sw-loading-logo" />
        <span class="sw-loading-ring"></span>
      </div>
      <div class="sw-loading-text">
        {{ startingMsg }}
        <span class="sw-loading-dots">...</span>
      </div>
      <button class="sw-loading-cancel" type="button" @click="cancelStart">取消</button>
    </div>

    <!-- 顶栏 -->
    <header class="sw-header">
      <div class="sw-brand">
        <img src="@/assets/logo.svg" alt="Loopra" class="sw-logo" />
        <div class="sw-brand-text">
          <span class="sw-title">Loopra 桌面端管理</span>
          <span class="sw-subtitle">核心服务 · 运行环境</span>
        </div>
      </div>
      <div class="sw-header-right">
        <span class="sw-pill" :class="running ? 'ok' : 'off'">
          <span class="sw-pill-dot"></span>
          <span>{{ running ? `核心服务运行中${port ? ' · 端口 ' + port : ''}` : '核心服务未运行' }}</span>
        </span>
        <button class="sw-close" type="button" title="关闭程序" @click="closeApp">✕</button>
      </div>
    </header>

    <div class="sw-body">
      <!-- 左侧菜单 -->
      <aside class="sw-sidebar">
        <nav class="sw-nav">
          <button
            type="button"
            class="sw-nav-item"
            :class="{ active: menu === 'core' }"
            @click="switchMenu('core')"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
            <span>核心管理</span>
          </button>
          <button
            type="button"
            class="sw-nav-item"
            :class="{ active: menu === 'deps' }"
            @click="switchMenu('deps')"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
            <span>依赖管理</span>
          </button>
        </nav>
        <div class="sw-sidebar-foot">
          <button v-if="running" class="btn btn-primary btn-enter-sidebar" :class="{ breathing: enterPulse }" type="button" @click="enterLoopra">
            进入 Loopra
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </button>
          <span v-else class="sw-sidebar-hint">核心服务启动后可进入主界面</span>
        </div>
      </aside>

      <!-- 右侧内容 -->
      <main class="sw-content">
        <!-- ============ 核心管理 ============ -->
        <section v-if="menu === 'core'" class="sw-pane">
          <div class="sw-pane-head">
            <h2 class="sw-pane-title">核心管理</h2>
            <button class="btn btn-ghost" type="button" :disabled="coreBusy" @click="refreshCore">
              {{ coreBusy ? '检测中...' : '刷新状态' }}
            </button>
          </div>

          <!-- 状态卡片 -->
          <div class="sw-cards">
            <div class="sw-card" :class="installed ? 'ok' : 'warn'">
              <span class="sw-card-label">安装状态</span>
              <span class="sw-card-value">{{ installed ? '已安装' : '未安装' }}</span>
            </div>
            <div class="sw-card" :class="running ? 'ok' : ''">
              <span class="sw-card-label">运行状态</span>
              <span class="sw-card-value">{{ running ? '运行中' : '未运行' }}</span>
            </div>
            <div class="sw-card">
              <span class="sw-card-label">服务端口</span>
              <span class="sw-card-value">{{ port || '—' }}</span>
            </div>
            <div class="sw-card">
              <span class="sw-card-label">核心来源</span>
              <span class="sw-card-value">{{ bundledCore ? '安装包内置' : '在线下载' }}</span>
            </div>
            <div class="sw-card" title="开启后，核心服务启动完成将自动进入 Loopra 主界面">
              <span class="sw-card-label">跳过等待</span>
              <label class="sw-switch">
                <input type="checkbox" v-model="skipWait" />
                <span class="sw-switch-track"><span class="sw-switch-knob"></span></span>
              </label>
            </div>
          </div>

          <!-- 版本对比 -->
          <div class="sw-section">
            <div class="sw-section-title">版本</div>
            <div class="sw-version-row">
              <span class="sw-version-label">桌面端</span>
              <code class="sw-version-code">{{ desktopVersion || '—' }}</code>
              <span class="sw-version-label">核心服务</span>
              <code class="sw-version-code">{{ runtimeVersion || '—' }}</code>
              <span class="sw-version-state" :class="versionStateClass">{{ versionStateText }}</span>
            </div>
          </div>

          <!-- 安装目录 -->
          <div class="sw-section" v-if="installDir">
            <div class="sw-section-title">安装目录</div>
            <code class="sw-path">{{ installDir }}</code>
          </div>

          <!-- 安装 / 更新 -->
          <div class="sw-section">
            <div class="sw-section-title">安装 / 更新核心服务</div>

            <div class="sw-bundle-note" v-if="bundledCore">
              安装包已内置核心运行时<template v-if="bundledVersion">（版本 {{ bundledVersion }}）</template>，仅从本地安装/更新（无需下载）
            </div>
            <div class="sw-bundle-missing" v-else>
              当前安装包未内置核心运行时，无法在此安装/更新
            </div>

            <div class="sw-actions">
              <button
                class="btn btn-primary"
                type="button"
                :disabled="busy || !bundledCore"
                :title="!bundledCore ? '当前安装包未内置核心运行时' : ''"
                @click="installOrUpdate"
              >
                {{ installing ? '安装中...' : (installed ? '更新核心服务' : '安装核心服务') }}
              </button>
              <button class="btn" type="button" :disabled="busy || running || !installed" @click="startService">
                {{ starting ? '启动中...' : '启动服务' }}
              </button>
              <button class="btn" type="button" :disabled="busy || !running" @click="stopService">
                停止服务
              </button>
              <button class="btn" type="button" :disabled="busy || !running" @click="restartService">
                重启服务
              </button>
            </div>
          </div>

          <!-- 安装日志 -->
          <div v-if="installLogs.length" class="sw-section">
            <div class="sw-section-title">安装日志</div>
            <div class="install-log" ref="logContainer">
              <div v-for="(line, i) in installLogs" :key="i" class="log-line">{{ line }}</div>
            </div>
          </div>

          <!-- 错误 -->
          <div v-if="errorMessage" class="sw-error">
            <span class="sw-error-mark">⚠</span>
            <span>{{ errorMessage }}</span>
          </div>
        </section>

        <!-- ============ 依赖管理 · JRE/JDK ============ -->
        <section v-else class="sw-pane">
          <div class="sw-pane-head">
            <h2 class="sw-pane-title">依赖管理 · JRE/JDK</h2>
            <button class="btn btn-ghost" type="button" :disabled="javaChecking" @click="refreshJava">
              {{ javaChecking ? '检测中...' : '重新检测' }}
            </button>
          </div>

          <!-- 总体可用状态 -->
          <div class="sw-java-summary" :class="java.usable ? 'ok' : 'err'">
            <span class="sw-java-badge">{{ java.usable ? '✓' : '✕' }}</span>
            <div class="sw-java-summary-body">
              <div class="sw-java-summary-title">
                {{ java.usable ? 'Java 环境可用' : '未检测到可用的 Java 17+' }}
              </div>
              <div class="sw-java-summary-desc">{{ java.hint || '—' }}</div>
            </div>
          </div>

          <!-- 系统 Java -->
          <div class="sw-java-card" :class="systemStateClass">
            <div class="sw-java-card-head">
              <span class="sw-java-card-name">系统 Java</span>
              <span class="sw-java-card-state" :class="systemStateClass">{{ systemStateText }}</span>
            </div>
            <div class="sw-java-row">
              <span class="sw-java-row-label">版本</span>
              <code class="sw-java-row-value">{{ java.system.version || '—' }}</code>
            </div>
            <div class="sw-java-row">
              <span class="sw-java-row-label">路径</span>
              <code class="sw-java-row-value sw-java-path">{{ java.system.path || 'PATH 中未找到 java' }}</code>
            </div>
            <div v-if="java.system.found && java.system.major > 0 && java.system.major < 17" class="sw-java-warn">
              版本过低（Java {{ java.system.major }}），需要 17+
            </div>
          </div>

          <!-- 捆绑 JRE -->
          <div class="sw-java-card" :class="bundledStateClass">
            <div class="sw-java-card-head">
              <span class="sw-java-card-name">捆绑 JRE</span>
              <span class="sw-java-card-state" :class="bundledStateClass">{{ bundledStateText }}</span>
            </div>

            <!-- 版本行 + 安装控件（同行） -->
            <div class="sw-java-row sw-java-row-tools">
              <span class="sw-java-row-label">版本</span>
              <code class="sw-java-row-value">{{ java.bundled.version || '—' }}</code>
              <span class="sw-java-tools">
                <select v-model="jreSource" class="sw-java-source-select" :disabled="jreDownloading" :title="jreSource === 'normal' ? 'GitHub 直连' : '当前镜像: ' + jreSource">
                  <option value="normal">GitHub 直连</option>
                  <option v-for="m in jreOptions" :key="m.value" :value="m.value">
                    {{ m.label }}<template v-if="m.latency != null"> ({{ m.latency }}ms)</template>
                  </option>
                </select>
                <button class="btn sw-speedtest-btn" type="button" :disabled="testingMirrors || jreDownloading" title="重新测速并按延迟排序" @click="runMirrorSpeedTest">
                  <svg v-if="!testingMirrors" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                  <svg v-else class="sw-speedtest-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
                  {{ testingMirrors ? '测速中' : '重新测速' }}
                </button>
                <button class="btn btn-primary" :class="{ breathing: jrePulse }" type="button" :disabled="jreDownloading" @click="downloadJre">
                  {{ jreDownloading ? '安装中...' : (java.bundled.found ? '重新安装 JRE 25' : '安装 JRE 25') }}
                </button>
              </span>
            </div>

            <div class="sw-java-row">
              <span class="sw-java-row-label">路径</span>
              <code class="sw-java-row-value sw-java-path">{{ java.bundled.path || '~/.loopra-gui/jre25 下未找到' }}</code>
            </div>
            <div v-if="java.bundled.found" class="sw-java-note">捆绑 JRE 随核心服务安装到 ~/.loopra-gui/jre25</div>
            <div v-if="java.bundled.found && running" class="sw-java-warn">
              核心服务正在运行，重装前请先到「核心管理」停止服务，避免文件占用导致失败
            </div>

            <!-- 下载进度 -->
            <div v-if="jreDownloading || jrePercent > 0" class="sw-java-progress">
              <div class="sw-java-progress-bar">
                <div class="sw-java-progress-fill" :style="{ width: jrePercent + '%' }"></div>
              </div>
              <span class="sw-java-progress-text">{{ jrePercent >= 100 ? '安装完成' : (jrePercent + '%') }}</span>
            </div>
            <div v-if="jreLogs.length" class="install-log" ref="jreLogRef">
              <div v-for="(line, i) in jreLogs" :key="i" class="log-line">{{ line }}</div>
            </div>
          </div>

          <!-- 缺失指引（手动方案） -->
          <div v-if="!java.usable" class="sw-java-help">
            <div class="sw-java-help-title">或手动安装 Java 17 或更高版本：</div>
            <ul class="sw-java-help-list">
              <li>清华大学 Adoptium 镜像：<code>https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/</code></li>
              <li>injdk.cn：<code>https://injdk.cn</code></li>
            </ul>
            <button class="btn btn-secondary" type="button" @click="openJavaDownload">打开下载页面</button>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup>
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue'
import {platform} from '@/services/platform'
import {systemAPI} from '@/services/api'
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

const { loopraWebService } = platform.implementation

const emit = defineEmits(['ready', 'error'])

const store = useAppStore()
const theme = computed(() => store.settings.theme)

const visible = ref(true)
const menu = ref('core') // core | deps

// 更新模式：复用启动页窗口承载更新时（?from=update），不自动启动服务、不自动进入主界面
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

// 跳过等待：开启后核心服务启动完成即自动进入 Loopra 主界面
const skipWait = ref(localStorage.getItem('loopra.skipWait') === '1')
watch(skipWait, (value) => {
  localStorage.setItem('loopra.skipWait', value ? '1' : '0')
})
let autoEntered = false // 本次窗口会话最多自动进入一次

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
  // 更新模式（复用启动页窗口承载更新）：不自动启动服务、不自动进入，仅刷新状态供管理/更新
  if (updateMode) {
    await Promise.all([refreshCore(), refreshJava()])
    return
  }
  // 打开即进入启动等待：先检测核心/Java 状态，据此决定是否需要先自动更新再启动
  autoStarting.value = true
  startCancelled = false
  startingMsg.value = '正在检查核心服务...'
  await Promise.all([refreshCore(), refreshJava()])
  if (startCancelled) {
    autoStarting.value = false
    return
  }

  // 无 Java 且核心服务未在运行：中止启动等待，切到依赖管理页并高亮安装 JRE 按钮
  // （服务已在运行（如 CLI 启动）时不打断，继续走自动更新/启动流程）
  if (!java.value.usable && !running.value) {
    autoStarting.value = false
    menu.value = 'deps'
    jrePulse.value = true
    return
  }

  // 包内核心较新（或核心尚未安装且包内有核心）：自动静默更新。
  // 更新失败时不继续启动（可能残留半成品 jar），停留在管理页展示错误供手动重试
  const autoUpdateResult = await runAutoUpdateIfNeeded()
  if (autoUpdateResult === 'failed') return
  // 自动更新期间用户点了「取消」：更新已完成但不再自动启动，停留在管理页（可手动启动新版本）
  if (startCancelled) {
    autoStarting.value = false
    return
  }
  // 启动核心服务：未更新时启动原版本，更新成功后这里统一拉起新版本
  await startService({ overlay: true })
})

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

    // 运行状态：进程在管 + 端口健康检查兜底（CLI 启动的 4567 服务也视为运行中）
    let p = 0
    try { p = await loopraWebService.getCurrentPort() } catch {}
    let isRunning = !!(status && status.running)
    let livePort = p
    if (p > 0) {
      const ok = await healthCheck(p)
      isRunning = isRunning || ok
      livePort = ok ? p : 0
    }
    if (!isRunning || !livePort) {
      // 兜底探测默认端口 4567
      const ok = await healthCheck(4567)
      if (ok) {
        isRunning = true
        livePort = 4567
      }
    }
    // 同步端口到 localStorage：复用已运行服务时（如 CLI 启动的 4567）refreshCore 会先于
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
      // 跳过等待：打开时已在运行则自动进入主界面（更新模式不自动进入）
      if (!updateMode && skipWait.value && !autoEntered) {
        autoEntered = true
        setTimeout(() => enterLoopra(), 600)
      }
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
  await performCoreUpdate({ auto: false })
}

// 自动更新判定：安装包内置核心比已安装核心新（或核心尚未安装且包内有核心）→ true。
// 以包内核心版本文件为权威，与桌面端版本号（app.getVersion()）解耦——两者可能不同步
function shouldAutoUpdateCore() {
  if (!bundledCore.value || !bundledVersion.value) return false
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
    // 安装后刷新核心与 Java 状态
    await Promise.all([refreshCore(), refreshJava()])

    // 更新完成后自动重启服务，加载新版本
    installLogs.value.push('')
    if (running.value) {
      // 停止后端口仍有服务在运行（如 CLI 启动的 4567，不属于本次更新对象）：不打断，仅提示
      installLogs.value.push('>> 检测到端口已有其他进程运行服务（可能由 CLI 启动），已跳过自动重启；新版本将在下次启动服务时生效')
      return true
    }
    if (auto) {
      // 自动模式不在此重启：由启动流程统一 startService
      installLogs.value.push('✅ 自动更新完成，正在启动核心服务...')
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
      installLogs.value.push(`>> ❌ 自动更新失败: ${e.message || e}。可点击「更新核心服务」手动重试`)
    }
    return false
  } finally {
    if (unlistenInstallOutput) {
      unlistenInstallOutput()
      unlistenInstallOutput = null
    }
    installing.value = false
    if (auto) autoStarting.value = false
  }
}

// ---------- 启动 / 停止 / 重启 ----------
async function startService(options = {}) {
  if (starting.value || running.value) return
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
        await registerBrowserBridge()
        // 跳过等待：启动完成即自动进入 Loopra 主界面（更新窗口不自动跳转，由用户确认后进入）
        if (!updateMode && skipWait.value && !autoEntered) {
          autoEntered = true
          setTimeout(() => enterLoopra(), 600)
        }
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

async function registerBrowserBridge() {
  if (!window.electronAPI?.aiBrowserWindow?.getBridgeAddress) return
  try {
    const address = await window.electronAPI.aiBrowserWindow.getBridgeAddress()
    await systemAPI.setBrowserBridge(address, {silent: true})
  } catch (error) {
    console.warn('[Splash] Failed to register AI browser bridge:', error)
  }
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

defineExpose({
  refreshCore,
  refreshJava,
  hide: () => { visible.value = false }
})
</script>

<style scoped>
.startup-window {
  position: fixed;
  inset: 0;
  background: var(--bg);
  color: var(--fg);
  display: flex;
  flex-direction: column;
  z-index: 9999;
  /* 无边框窗口：整体作为拖动区域，交互元素单独排除 */
  -webkit-app-region: drag;
}

.startup-window .btn,
.startup-window .sw-close,
.startup-window .sw-nav-item,
.startup-window .sw-content,
.startup-window .install-log,
.startup-window .sw-java-help button {
  -webkit-app-region: no-drag;
}

/* 启动等待遮罩：Logo + 中性灰光弧（与系统简洁工具风格一致） */
.sw-starting-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(4px);
}

.sw-loading-mark {
  position: relative;
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sw-loading-logo {
  width: 36px;
  height: 36px;
  animation: loading-breathe 2.8s ease-in-out infinite;
}

/* 中性灰渐变光弧（细、克制） */
.sw-loading-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 220deg,
    var(--fg-4) 300deg,
    var(--fg-2) 350deg,
    transparent 360deg
  );
  mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 1.5px));
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 1.5px));
  animation: loading-rotate 1.4s linear infinite;
  opacity: 0.75;
}

@keyframes loading-rotate {
  to { transform: rotate(360deg); }
}

@keyframes loading-breathe {
  0%, 100% { opacity: 0.8; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.02); }
}

.sw-loading-text {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--fg-3);
}

.sw-loading-dots {
  display: inline-block;
  width: 1.2em;
  text-align: left;
  animation: loading-dots 1.6s steps(4, end) infinite;
  overflow: hidden;
  vertical-align: bottom;
}

@keyframes loading-dots {
  0% { width: 0; }
  100% { width: 1.2em; }
}

.sw-loading-cancel {
  padding: 6px 24px;
  border: 1px solid var(--border);
  border-radius: 9999px;
  background: var(--bg-2);
  color: var(--fg-3);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--t);
  -webkit-app-region: no-drag;
}

.sw-loading-cancel:hover {
  color: var(--fg);
  border-color: var(--border-2);
  background: var(--bg-3);
}

/* ============ 顶栏 ============ */
.sw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
  flex-shrink: 0;
}

.sw-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sw-logo {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.sw-brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.sw-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--fg);
}

.sw-subtitle {
  font-size: 11px;
  color: var(--fg-4);
}

.sw-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sw-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 9999px;
  font-size: 12px;
  background: var(--bg-3);
  color: var(--fg-3);
}

.sw-pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-4);
}

.sw-pill.ok .sw-pill-dot {
  background: var(--green);
  animation: none;
}

.sw-pill.ok {
  background: var(--green-bg);
  color: var(--green);
}

.sw-pill.off .sw-pill-dot {
  background: var(--fg-4);
}

.sw-close {
  width: 30px;
  height: 30px;
  border: none;
  background: var(--bg-3);
  border-radius: 8px;
  color: var(--fg-3);
  font-size: 15px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--t);
}

.sw-close:hover {
  background: var(--bg-active);
  color: var(--fg);
}

/* ============ 主体布局 ============ */
.sw-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* ============ 左侧菜单 ============ */
.sw-sidebar {
  width: 172px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  padding: 12px 8px;
}

.sw-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sw-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: none;
  border-radius: var(--r);
  background: transparent;
  color: var(--fg-3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: all var(--t);
  width: 100%;
}

.sw-nav-item svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.sw-nav-item:hover {
  background: var(--bg-3);
  color: var(--fg);
}

.sw-nav-item.active {
  background: var(--accent-bg);
  color: var(--fg);
  font-weight: 600;
}

.sw-sidebar-foot {
  margin-top: auto;
  padding: 8px 4px;
}

.sw-sidebar-hint {
  font-size: 11px;
  color: var(--fg-4);
  line-height: 1.5;
}

/* ============ 右侧内容 ============ */
.sw-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px 24px;
}

.sw-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sw-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sw-pane-title {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
}

/* 按钮通用 */
.btn {
  padding: 7px 16px;
  border-radius: var(--r);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--fg);
  transition: all var(--t);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn:hover:not(:disabled) {
  background: var(--bg-3);
}

.btn-primary {
  background: var(--accent-btn);
  border-color: transparent;
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
  /* 关键：重设主色背景，避免 .btn:hover 的浅灰背景盖掉白字 */
  background: var(--accent-btn);
}

.btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--fg-3);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-3);
  color: var(--fg);
}

/* ============ 状态卡片 ============ */
.sw-cards {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}

.sw-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--bg);
}

.sw-card-label {
  font-size: 11px;
  color: var(--fg-4);
}

.sw-card-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}

/* 跳过等待开关 */
.sw-switch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 18px;
  flex-shrink: 0;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.sw-switch input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}

.sw-switch-track {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  background: var(--bg-3);
  border: 1px solid var(--border-2);
  transition: all var(--t);
}

.sw-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-3);
  transition: all var(--t);
}

.sw-switch input:checked + .sw-switch-track {
  background: var(--green);
  border-color: var(--green);
}

.sw-switch input:checked + .sw-switch-track .sw-switch-knob {
  left: 18px;
  background: #fff;
}

.sw-card.ok .sw-card-value {
  color: var(--green);
}

.sw-card.warn .sw-card-value {
  color: var(--yellow);
}

/* ============ 分区 ============ */
.sw-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--bg);
}

.sw-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* 版本对比 */
.sw-version-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.sw-version-label {
  color: var(--fg-3);
}

.sw-version-code {
  font-family: var(--mono);
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--r-sm);
  background: var(--bg-3);
  color: var(--fg-2);
}

.sw-version-state {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9999px;
}

.sw-version-state.ok {
  background: var(--green-bg);
  color: var(--green);
}

.sw-version-state.warn {
  background: var(--yellow-bg);
  color: var(--yellow);
}

.sw-version-state.info {
  background: var(--accent-bg);
  color: var(--fg-2);
}

/* 路径 */
.sw-path {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--fg-2);
  background: var(--bg-3);
  padding: 6px 10px;
  border-radius: var(--r-sm);
  word-break: break-all;
}

/* 内置核心提示 */
.sw-bundle-note {
  font-size: 12px;
  color: var(--green);
  background: var(--green-bg);
  padding: 6px 10px;
  border-radius: var(--r-sm);
}

.sw-bundle-missing {
  font-size: 12px;
  color: var(--yellow);
  background: var(--yellow-bg);
  padding: 6px 10px;
  border-radius: var(--r-sm);
}

/* 操作按钮 */
.sw-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 侧栏底部：进入主界面 */
.btn-enter-sidebar {
  width: 100%;
  justify-content: center;
  background: var(--green);
  border-color: transparent;
  color: #fff;
}

.btn-enter-sidebar:hover:not(:disabled) {
  opacity: 0.9;
  /* 关键：重设绿色背景，避免 .btn:hover 的浅灰背景盖掉白字 */
  background: var(--green);
}

/* 呼吸闪烁：吸引注意（启动成功提示进入 / 无 Java 提示安装） */
@keyframes breathe-pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.45);
  }
  50% {
    transform: scale(1.04);
    box-shadow: 0 0 0 10px rgba(22, 163, 74, 0);
  }
}

.breathing {
  animation: breathe-pulse 2s ease-in-out infinite;
}

/* 安装日志 */
.install-log {
  max-height: 200px;
  overflow-y: auto;
  background: #1a1a2e;
  border-radius: var(--r);
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
}

.log-line {
  color: #a0aec0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 错误 */
.sw-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--r);
  background: var(--red-bg);
  border: 1px solid rgba(220, 38, 38, 0.25);
  color: var(--red);
  font-size: 13px;
}

.sw-error-mark {
  flex-shrink: 0;
}

/* ============ 依赖管理 ============ */
.sw-java-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--r-lg);
  border: 1px solid var(--border);
}

.sw-java-summary.ok {
  background: var(--green-bg);
  border-color: rgba(22, 163, 74, 0.3);
}

.sw-java-summary.err {
  background: var(--red-bg);
  border-color: rgba(220, 38, 38, 0.3);
}

.sw-java-badge {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 700;
  flex-shrink: 0;
}

.sw-java-summary.ok .sw-java-badge {
  background: var(--green);
  color: #fff;
}

.sw-java-summary.err .sw-java-badge {
  background: var(--red);
  color: #fff;
}

.sw-java-summary-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sw-java-summary-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--fg);
}

.sw-java-summary-desc {
  font-size: 12px;
  color: var(--fg-3);
}

.sw-java-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--bg);
}

.sw-java-card.ok {
  border-color: rgba(22, 163, 74, 0.4);
}

.sw-java-card.warn {
  border-color: rgba(202, 138, 4, 0.4);
}

.sw-java-card.off {
  opacity: 0.85;
}

.sw-java-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sw-java-card-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--fg);
}

.sw-java-card-state {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 9999px;
}

.sw-java-card-state.ok {
  background: var(--green-bg);
  color: var(--green);
}

.sw-java-card-state.warn {
  background: var(--yellow-bg);
  color: var(--yellow);
}

.sw-java-card-state.off {
  background: var(--bg-3);
  color: var(--fg-4);
}

.sw-java-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}

.sw-java-row-label {
  width: 34px;
  flex-shrink: 0;
  color: var(--fg-3);
}

.sw-java-row-value {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--fg-2);
  word-break: break-all;
}

.sw-java-path {
  color: var(--fg-3);
}

.sw-java-warn {
  font-size: 12px;
  color: var(--yellow);
  background: var(--yellow-bg);
  padding: 5px 10px;
  border-radius: var(--r-sm);
}

.sw-java-note {
  font-size: 12px;
  color: var(--fg-4);
}

.sw-java-help {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: var(--r-lg);
  border: 1px dashed var(--border-2);
  background: var(--bg-2);
}

.sw-java-help-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-2);
}

/* JRE 安装 / 重装：下拉框 + 安装按钮（与版本行同行） */
.sw-java-row-tools {
  align-items: center;
}

.sw-java-tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.sw-java-source-select {
  min-width: 145px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
  outline: none;
  transition: all var(--t);
  -webkit-app-region: no-drag;
}

.sw-java-source-select:hover {
  border-color: var(--accent);
}

.sw-java-source-select:focus {
  border-color: var(--accent);
}

.sw-java-source-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 镜像重新测速按钮 */
.sw-speedtest-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
}

.sw-speedtest-btn svg {
  flex-shrink: 0;
}

.sw-speedtest-spin {
  animation: sw-speedtest-rotate 0.9s linear infinite;
}

@keyframes sw-speedtest-rotate {
  to { transform: rotate(360deg); }
}

/* JRE 下载进度 */
.sw-java-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sw-java-progress-bar {
  flex: 1;
  height: 6px;
  border-radius: 9999px;
  background: var(--bg-3);
  overflow: hidden;
}

.sw-java-progress-fill {
  height: 100%;
  border-radius: 9999px;
  background: var(--accent);
  transition: width 0.2s ease;
}

.sw-java-progress-text {
  font-size: 12px;
  color: var(--fg-3);
  font-variant-numeric: tabular-nums;
  min-width: 48px;
  text-align: right;
}

.sw-java-help-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-3);
}

.sw-java-help-list code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg-2);
}

.sw-java-help .btn {
  align-self: flex-start;
}
</style>
