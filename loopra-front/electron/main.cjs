const { app, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, nativeTheme, shell, Notification } = require('electron')
const http = require('http')
const https = require('https')
const path = require('path')
const { spawn, execFile, execSync } = require('child_process')
const { promisify } = require('util')
const { compareVersions } = require('./version.cjs')
const { registerTerminalIpc, killAllTerminals } = require('./terminal.cjs')
const { registerGitEnvironmentIpc } = require('./git-environment.cjs')
const { registerOnboardingIpc } = require('./onboarding.cjs')
const { DesktopNativeOverlayManager } = require('./desktop-overlay.cjs')
const fs = require('fs')
const net = require('net')

// ==================== Squirrel 安装事件处理 ====================
// Squirrel 安装/卸载时会以特定参数启动应用，需要处理并立即退出
const handleSquirrelEvent = () => {
  if (process.argv.length === 1) return false
  const appFolder = path.resolve(process.execPath, '..')
  const rootAtomFolder = path.resolve(appFolder, '..')
  const updateDotExe = path.resolve(rootAtomFolder, 'Update.exe')
  const exeName = path.basename(process.execPath)

  const spawnProcess = (command, args) => {
    try {
      return spawn(command, args, { detached: true })
    } catch { return null }
  }

  const squirrelEvent = process.argv[1]
  switch (squirrelEvent) {
    case '--squirrel-install':
    case '--squirrel-updated':
      // 创建开始菜单和桌面快捷方式
      spawnProcess(updateDotExe, ['--createShortcut', exeName])
      setTimeout(app.quit, 1000)
      return true
    case '--squirrel-uninstall':
      // 移除快捷方式
      spawnProcess(updateDotExe, ['--removeShortcut', exeName])
      setTimeout(app.quit, 1000)
      return true
    case '--squirrel-obsolete':
      app.quit()
      return true
  }
  return false
}

if (handleSquirrelEvent()) {
  // Squirrel 事件已处理，应用将在短暂延迟后退出
  // 这里不需要执行任何其他逻辑
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const isWin = process.platform === 'win32'
const shouldOpenDevTools = process.env.LOOPRA_OPEN_DEVTOOLS === '1'
const DESKTOP_CHAT_DEV_RENDERER_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000']
const DESKTOP_CHAT_LOAD_ATTEMPTS = DESKTOP_CHAT_DEV_RENDERER_ORIGINS.length
const DESKTOP_CHAT_LOAD_RETRY_DELAY_MS = 200
const DESKTOP_CHAT_LOAD_TIMEOUT_MS = 10000
// Keep developer context menus suppressed across the full resizable sidebar.
const DESKTOP_SIDEBAR_CONTEXT_WIDTH = 440

let mainWindow = null
let splashWindow = null
let updateWindow = null
let onboardingWindow = null
let loopraWebProcess = null
let currentPort = 0
const loopraWebWindows = new Map()
let elementWebView = null
let elementInspectorWindow = null
let elementInspectorReady = false
let elementInspectorPendingUrl = ''
let requirementBoardWindow = null
let aiBrowserWindow = null
let aiBrowserActiveTabId = null
let aiBrowserNextTabId = 1
let aiBrowserBridge = null
let aiBrowserBridgeReady = null
let aiBrowserBridgeAddress = ''
let aiBrowserActivity = { state: 'idle', message: '等待 AI 操作', timestamp: Date.now() }
let desktopPetWindow = null
let pendingDesktopPetReply = null
const aiBrowserTabs = new Map()
const AI_BROWSER_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024
const AI_BROWSER_SCREENSHOT_MAX_WIDTH = 1600
const desktopChatTabs = new Map()
const fileExplorerWatchers = new Map()
let desktopChatActiveTabId = null
let desktopChatLoadingRequestId = 0
const AI_BROWSER_BRIDGE_PREFERRED_PORT = Number(process.env.LOOPRA_BROWSER_BRIDGE_PORT || 0)
const AI_BROWSER_TAB_CLEANUP_THRESHOLD = 16
const AI_BROWSER_MAX_TABS = 20
const execFileAsync = promisify(execFile)
const appIconPath = path.join(__dirname, 'favicon.png')
const desktopOverlayManager = new DesktopNativeOverlayManager({
  getParentWindow: () => mainWindow,
  preloadPath: path.join(__dirname, 'preload.cjs'),
  rendererPath: path.join(__dirname, '../renderer/index.html'),
  isDev,
  devRendererOrigins: DESKTOP_CHAT_DEV_RENDERER_ORIGINS,
  loadAttempts: DESKTOP_CHAT_LOAD_ATTEMPTS,
  retryDelayMs: DESKTOP_CHAT_LOAD_RETRY_DELAY_MS,
  loadTimeoutMs: DESKTOP_CHAT_LOAD_TIMEOUT_MS
})
let desktopPopupContext = null
let desktopPopupContextRequestId = 0
const desktopPopupContextWaiters = new Map()

if (isWin) app.setAppUserModelId('com.loopra.desktop')

function parsePort(commandLine) {
  const match = String(commandLine || '').match(/--server\.port=(\d+)/i)
  return match ? Number(match[1]) : 0
}

function parseElapsedSeconds(value) {
  const match = String(value || '').trim().match(/(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)/)
  if (!match) return 0
  return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4])
}

function openLoopraWebWindow(port) {
  const existing = loopraWebWindows.get(port)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  const serviceWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: `Loopra 服务 (${port})`,
    icon: appIconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  loopraWebWindows.set(port, serviceWindow)
  serviceWindow.on('closed', () => loopraWebWindows.delete(port))
  serviceWindow.loadURL(`http://127.0.0.1:${port}/index.html`)
}

async function listLoopraJavaProcesses() {
  if (isWin) {
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
      "$items = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'java.exe' -or $_.Name -eq 'javaw.exe') -and $_.CommandLine -match '(?i)loopra-web\\.jar' } | ForEach-Object {",
      '  $native = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue',
      '  [PSCustomObject]@{',
      '    pid = [int]$_.ProcessId',
      '    parentPid = [int]$_.ParentProcessId',
      '    name = [string]$_.Name',
      '    commandLine = [string]$_.CommandLine',
      '    executablePath = [string]$_.ExecutablePath',
      "    startedAt = if ($native) { $native.StartTime.ToUniversalTime().ToString('o') } else { $null }",
      '    memoryBytes = if ($native) { [long]$native.WorkingSet64 } else { [long]0 }',
      '  }',
      '}',
      'if ($items) { @($items) | ConvertTo-Json -Compress } else { Write-Output "[]" }'
    ].join('\n')
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { windowsHide: true, maxBuffer: 1024 * 1024 })
    const items = JSON.parse(stdout.trim() || '[]')
    const managedPid = loopraWebProcess?.pid || 0
    return (Array.isArray(items) ? items : [items]).map((item) => ({
      ...item,
      port: parsePort(item.commandLine),
      managed: isLoopraGuiRuntime(item.commandLine) || item.parentPid === managedPid || parsePort(item.commandLine) === currentPort
    }))
  }

  // macOS 的 ps 默认会截断长命令行，导致 JVM 参数中的 loopra-web.jar 无法被识别。
  // 使用 -ww 保留完整 command 列，并避免依赖各平台不同的 comm/args 列布局。
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,ppid=,rss=,etime=,command='], {
    maxBuffer: 1024 * 1024
  })
  const managedPid = loopraWebProcess?.pid || 0
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) return []
    const [, pid, parentPid, rssKb, elapsed, commandLine] = match
    const executablePath = commandLine.trim().split(/\s+/, 1)[0]
    if (!/(?:^|\/)(?:java|javaw)(?:\s|$)/i.test(commandLine) || !/loopra-web\.jar/i.test(commandLine)) return []
    const port = parsePort(commandLine)
    return [{
      pid: Number(pid),
      parentPid: Number(parentPid),
      name: path.basename(executablePath),
      commandLine,
      executablePath,
      memoryBytes: Number(rssKb) * 1024,
      uptimeSeconds: parseElapsedSeconds(elapsed),
      port,
      managed: isLoopraGuiRuntime(commandLine) || Number(parentPid) === managedPid || Number(pid) === managedPid || port === currentPort
    }]
  })
}

// 获取随机可用端口
async function getRandomPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function getDefaultPort() {
  // 获取随机可用端口，避免占用固定端口
  const port = await getRandomPort()
  return port
}

async function healthCheck(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/system/health`, {
      signal: AbortSignal.timeout(3000)
    })
    return resp.ok
  } catch { return false }
}

// 获取运行中服务的版本（health API 返回的 data.version）
async function fetchServiceVersion(port) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/system/health`, {
      signal: AbortSignal.timeout(3000)
    })
    if (!resp.ok) return ''
    const body = await resp.json()
    return String(body?.data?.version || '').trim()
  } catch { return '' }
}

// 运行中的服务版本是否与本地安装的运行时版本一致：
// 本地版本读不到时保守复用；运行版本读不到时保守重启（保证更新后的 jar 生效）；
// 运行版本不低于本地版本即可复用（避免把更新的服务降级重启）。
async function isServiceVersionCurrent(port) {
  const installedVersion = readLoopraGuiVersion()
  if (!installedVersion) return true
  const runningVersion = await fetchServiceVersion(port)
  if (!runningVersion) return false
  return compareVersions(runningVersion, installedVersion) >= 0
}

// 终止指定端口上的 loopra-web 进程（用于替换旧版本服务）
async function stopLoopraWebOnPort(port) {
  try {
    const processes = await listLoopraJavaProcesses()
    const target = processes.find((item) => item.port === port)
    if (!target) return false
    await stopLoopraJavaProcess(target.pid)
    console.log(`Stopped stale loopra-web process ${target.pid} on port ${port}`)
    return true
  } catch (error) {
    console.warn(`Failed to stop loopra-web process on port ${port}: ${error.message}`)
    return false
  }
}

// 杀掉整个进程树（包括 java 子进程）
function killProcessTree(child) {
  if (!child) return
  const pid = child.pid
  if (!pid) return

  if (isWin) {
    // Windows: taskkill /T /F 同步杀掉整个进程树
    try {
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'ignore' })
    } catch { /* 进程可能已退出 */ }
  } else {
    // macOS/Linux: 杀掉整个进程组，同步等待
    try { process.kill(-pid, 'SIGTERM') } catch { return }
    // 同步等待进程退出，最多 5 秒
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        process.kill(-pid, 0) // 检查进程是否还在
        execSync('sleep 0.2')
      } catch {
        return // 已退出
      }
    }
    // 还没死，强杀
    try { process.kill(-pid, 'SIGKILL') } catch { /* already dead */ }
  }
}

function getLoopraPaths() {
  const home = app.getPath('home')
  const configDir = path.join(home, '.loopra')
  const runtimeDir = path.join(home, '.loopra-gui')
  const binDir = path.join(runtimeDir, 'bin')
  const binName = isWin ? 'loopra.ps1' : 'loopra'
  return {
    home,
    configDir,
    runtimeDir,
    binDir,
    binPath: path.join(binDir, binName),
    jarPath: path.join(binDir, 'loopra-web.jar'),
    versionPath: path.join(binDir, 'version.txt'),
    javaPath: isWin
      ? path.join(runtimeDir, 'jre25', 'bin', 'java.exe')
      : path.join(runtimeDir, 'jre25', 'bin', 'java'),
    javaMacPath: path.join(runtimeDir, 'jre25', 'Contents', 'Home', 'bin', 'java')
  }
}

function getLoopraBinPath() {
  const { binDir, binPath } = getLoopraPaths()
  return { binDir, binPath }
}

// 安装包内置核心运行时目录：打包时由 CI 把 web-dist 解压到 resources/loopra-core
// （开发模式读仓库内 resources/loopra-core，未嵌入时返回空路径由调用方回退在线）
function getLoopraCoreDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'loopra-core')
  return path.join(__dirname, '../resources/loopra-core')
}

// 安装包是否内置核心运行时（install 脚本存在即视为内置）
function isLoopraCoreBundled() {
  const scriptName = isWin ? 'install.ps1' : 'install.sh'
  return fs.existsSync(path.join(getLoopraCoreDir(), scriptName))
}

function readLoopraGuiVersion() {
  const { versionPath } = getLoopraPaths()
  try {
    return fs.readFileSync(versionPath, 'utf8').trim().replace(/^v/i, '')
  } catch {
    return ''
  }
}

function isLoopraGuiInstalled() {
  const { binPath, jarPath } = getLoopraPaths()
  // Java 由 launcher 解析：优先系统 java，回退已有捆绑 jre25（不再自动下载）
  return [binPath, jarPath].every((filePath) => fs.existsSync(filePath))
}

// ==================== JRE/JDK 环境检测 ====================
// 与安装脚本（install.ps1/install.sh）的 Pre-check 保持一致：
// 优先系统 Java 17+，回退已有捆绑 JRE（~/.loopra-gui/jre25），都不满足时提示安装。

// 解析 java -version 输出，返回主版本号（1.8.x -> 8，17.0.x -> 17）
function parseJavaMajor(versionText) {
  const m = /version "([^"]+)"/.exec(versionText || '')
  if (!m) return 0
  const first = /^(\d+)/.exec(m[1])
  if (!first) return 0
  const major = parseInt(first[1], 10)
  return major === 1 ? 8 : major
}

function getJavaVersionInfo(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ['-version'], { timeout: 8000, windowsHide: true }, (error, stdout, stderr) => {
      const raw = String(stderr || stdout || error?.message || '').trim()
      const m = /version "([^"]+)"/.exec(raw)
      resolve({ raw, version: m ? m[1] : '', major: parseJavaMajor(raw) })
    })
  })
}

// 定位系统 PATH 上的 java 可执行文件（Windows: where.exe / Unix: which）
function locateSystemJava() {
  return new Promise((resolve) => {
    execFile(isWin ? 'where' : 'which', ['java'], { timeout: 8000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve('')
      resolve(String(stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '')
    })
  })
}

// 检测 JRE/JDK 环境，返回系统 Java 与捆绑 JRE 的版本/路径/可用性及当前选用来源
async function detectJavaStatus() {
  const { runtimeDir } = getLoopraPaths()
  const bundledCandidates = isWin
    ? [path.join(runtimeDir, 'jre25', 'bin', 'java.exe')]
    : [
        path.join(runtimeDir, 'jre25', 'bin', 'java'),
        path.join(runtimeDir, 'jre25', 'Contents', 'Home', 'bin', 'java')
      ]
  const bundledPath = bundledCandidates.find((p) => fs.existsSync(p)) || ''

  const systemPath = await locateSystemJava()
  const [systemInfo, bundledInfo] = await Promise.all([
    systemPath ? getJavaVersionInfo(systemPath) : Promise.resolve({ version: '', major: 0, raw: '' }),
    bundledPath ? getJavaVersionInfo(bundledPath) : Promise.resolve({ version: '', major: 0, raw: '' })
  ])

  const system = {
    found: !!systemPath && systemInfo.major > 0,
    path: systemPath,
    version: systemInfo.version,
    major: systemInfo.major,
    raw: systemInfo.raw
  }
  const bundled = {
    found: !!bundledPath && bundledInfo.major > 0,
    path: bundledPath,
    version: bundledInfo.version,
    major: bundledInfo.major,
    raw: bundledInfo.raw
  }

  const systemUsable = system.found && system.major >= 17
  const used = systemUsable ? 'system' : (bundled.found ? 'bundled' : '')

  return {
    system,
    bundled,
    used,
    usable: systemUsable || bundled.found,
    requiredMajor: 17,
    hint: systemUsable
      ? `使用系统 Java ${system.version}`
      : bundled.found
        ? `使用捆绑 JRE ${bundled.version}`
        : '未检测到可用的 Java 17+，请先安装 JDK 或 JRE'
  }
}

// ==================== JRE 25 自动下载安装 ====================
// 通过 Adoptium assets API 获取最新 JRE 25 的 GitHub 下载直链，
// 支持 GitHub 直连 / gh-proxy 镜像（与核心服务下载源一致），下载后解压到 ~/.loopra-gui/jre25。

const ADOPTIUM_ASSETS_API = 'https://api.adoptium.net/v3/assets/latest/25/hotspot'
const GH_PROXY_PREFIX = 'https://gh-proxy.com/'

function getJre25Platform() {
  let os
  if (isWin) os = 'windows'
  else if (process.platform === 'darwin') os = 'mac'
  else if (process.platform === 'linux') os = 'linux'
  else return null

  let arch
  if (process.arch === 'x64') arch = 'x64'
  else if (process.arch === 'arm64') arch = 'aarch64'
  else return null

  return { os, arch }
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Loopra/Desktop' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return httpGetJson(res.headers.location).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`请求失败，HTTP ${res.statusCode}`))
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('解析 Adoptium API 响应失败')) }
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

// 解析最新 JRE 25 的 GitHub 下载直链（assets 接口，query 参数风格）
async function resolveJre25GitHubAsset(os, arch) {
  const query = `?os=${os}&architecture=${arch}&image_type=jre&heap_size=normal&vendor=eclipse`
  const list = await httpGetJson(ADOPTIUM_ASSETS_API + query)
  const asset = Array.isArray(list) ? list[0] : null
  const pkg = asset && asset.binary && asset.binary.package
  if (!pkg || !pkg.link || !pkg.name) throw new Error('未能从 Adoptium API 获取 JRE 25 下载地址')
  return {
    githubUrl: pkg.link,
    fileName: pkg.name,
    version: (asset.version && (asset.version.openjdk_version || asset.version.semver)) || ''
  }
}

// 流式下载文件，onProgress(received, total)
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    const cleanup = () => {
      file.close()
      fs.unlink(destPath, () => {})
    }
    const req = https.get(url, { headers: { 'User-Agent': 'Loopra/Desktop' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        cleanup()
        return downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        cleanup()
        return reject(new Error(`下载失败，HTTP ${res.statusCode}`))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      res.on('data', (chunk) => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('error', (err) => { cleanup(); reject(err) })
  })
}

async function extractJre25Archive(archivePath, extractDir) {
  if (archivePath.endsWith('.zip')) {
    // Windows: 使用系统自带 PowerShell Expand-Archive
    await execFileAsync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractDir}' -Force`], { windowsHide: true })
  } else {
    // macOS/Linux: tar.gz
    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], { windowsHide: true })
  }
}

// 归档根目录通常是 jdk-25.0.x+y-jre，把其中内容整体搬到目标目录
function installJre25FromExtracted(extractDir, targetDir) {
  const entries = fs.readdirSync(extractDir).filter((n) => n !== '.' && n !== '..')
  const root = entries.length === 1 ? path.join(extractDir, entries[0]) : extractDir
  fs.mkdirSync(targetDir, { recursive: true })
  for (const name of fs.readdirSync(root)) {
    const src = path.join(root, name)
    const dest = path.join(targetDir, name)
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(src, dest)
  }
}

// 推送 JRE 下载日志 / 进度到启动窗口
function sendJreLog(line) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('jre-download-output', { type: 'log', line })
  }
}
function sendJreProgress(received, total, percent) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('jre-download-progress', { received, total, percent })
  }
}

// 自动下载并安装最新 JRE 25 到 ~/.loopra-gui/jre25
async function downloadAndInstallJre25(source) {
  const tmpDir = path.join(app.getPath('temp'), 'loopra-jre25')
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    const plat = getJre25Platform()
    if (!plat) throw new Error(`不支持当前平台 (${process.platform}/${process.arch})`)

    // 1) Adoptium API 获取最新 JRE 25 的 GitHub 直链
    const asset = await resolveJre25GitHubAsset(plat.os, plat.arch)
    sendJreLog(`>> 最新版本: ${asset.version || '未知'} (${asset.fileName})`)

    // 2) 拼接直连 / 镜像下载地址（source 为 'normal' 或镜像前缀 URL；兼容旧值 'mirror' → 默认 gh-proxy）
    const mirrorPrefix = source && source !== 'normal' && source !== 'mirror'
      ? String(source).replace(/\/+$/, '') + '/'
      : (source === 'mirror' ? GH_PROXY_PREFIX : '')
    const downloadUrl = mirrorPrefix + asset.githubUrl
    sendJreLog(`>> 下载源: ${mirrorPrefix ? mirrorPrefix.replace(/\/+$/, '') : 'GitHub 直连'}`)

    // 3) 下载（带进度）
    const archivePath = path.join(tmpDir, asset.fileName)
    sendJreLog('>> 开始下载 ...')
    await downloadFile(downloadUrl, archivePath, (received, total) => {
      const percent = total > 0 ? Math.round((received / total) * 100) : -1
      sendJreProgress(received, total, percent)
      if (percent >= 0 && percent % 10 === 0) {
        sendJreLog(`    下载进度: ${percent}% (${(received / 1048576).toFixed(1)} MB)`)
      }
    })
    sendJreLog(`>> 下载完成 (${(fs.statSync(archivePath).size / 1048576).toFixed(1)} MB)`)

    // 4) 解压
    const extractDir = path.join(tmpDir, 'extract')
    fs.mkdirSync(extractDir, { recursive: true })
    sendJreLog('>> 解压中 ...')
    await extractJre25Archive(archivePath, extractDir)

    // 5) 安装到 ~/.loopra-gui/jre25
    const { runtimeDir } = getLoopraPaths()
    const targetDir = path.join(runtimeDir, 'jre25')
    sendJreLog(`>> 安装到 ${targetDir} ...`)
    installJre25FromExtracted(extractDir, targetDir)

    sendJreLog('')
    sendJreLog('>> ✅ JRE 25 安装完成')
    return { success: true, version: asset.version, dir: targetDir }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ==================== 镜像测速 ====================
// 与 JRE / 更新脚本共用同一份测速目标（release 压缩包，Range 取前 1KB），并发测各镜像延迟。
// 放在主进程执行：镜像代理大多不支持浏览器跨域，node https 无 CORS 限制。

const MIRROR_TEST_ASSET = 'https://github.com/ezdemo/loopra/releases/download/v26.8.211/loopra-dist.tar.gz'

// 测单个镜像：返回延迟(ms)，失败/超时返回 null
function measureMirrorLatency(mirrorBase, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const url = String(mirrorBase || '').replace(/\/+$/, '') + '/' + MIRROR_TEST_ASSET
    const start = Date.now()
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    const req = https.get(url, {
      headers: { 'User-Agent': 'Loopra/Desktop', Range: 'bytes=0-1023' },
      timeout: timeoutMs
    }, (res) => {
      const status = res.statusCode || 0
      if (status !== 200 && status !== 206) {
        res.resume()
        return done(null)
      }
      res.once('data', () => { res.destroy(); done(Date.now() - start) })
      res.on('error', () => done(null))
    })
    req.on('timeout', () => { req.destroy(); done(null) })
    req.on('error', () => done(null))
  })
}

function isLoopraGuiRuntime(commandLine) {
  return /(?:^|[\\/])\.loopra-gui(?:[\\/])/i.test(String(commandLine || ''))
}

// 启动 loopra web <port>
function startLoopraWeb(port) {
  const { binDir, binPath } = getLoopraBinPath()

  if (!isLoopraGuiInstalled()) {
    throw new Error(`loopra desktop runtime not found: ${path.dirname(binDir)}`)
  }

  console.log(`Starting: ${binPath} web ${port}`)

  let child
  if (isWin) {
    // Windows: 用 PowerShell 执行 .ps1 脚本
    child = spawn('powershell', [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-File', binPath,
      'web', String(port)
    ], {
      cwd: binDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  } else {
    // macOS/Linux: 直接执行
    child = spawn(binPath, ['web', String(port)], {
      cwd: binDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }

  child.stdout.on('data', (d) => console.log(`[loopra-web] ${d}`))
  child.stderr.on('data', (d) => console.error(`[loopra-web] ${d}`))

  child.on('exit', (code) => {
    console.log(`loopra-web exited with code ${code}`)
    loopraWebProcess = null
    currentPort = 0
  })

  child.on('error', (err) => {
    console.error('loopra-web spawn error:', err)
    loopraWebProcess = null
    currentPort = 0
  })

  loopraWebProcess = child
  return child
}

// 统一清理
function cleanupLoopraWeb() {
  if (loopraWebProcess) {
    killProcessTree(loopraWebProcess)
    loopraWebProcess = null
    currentPort = 0
  }
}

// ==================== 窗口 ====================

// 启动窗口：承载检测/安装/服务启动全流程，完成后关闭并创建主窗口。
// force=true：即使主窗口已存在也打开（复用该窗口承载更新等场景）；from 标记打开场景（如 update）
function createSplashWindow(options = {}) {
  const { force = false, from = '' } = options || {}
  if (!force && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return
  }
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.show()
    splashWindow.focus()
    return splashWindow
  }

  splashWindow = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 800,
    minHeight: 560,
    useContentSize: true,
    resizable: true,
    frame: false,
    title: 'Loopra',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  splashWindow.on('closed', () => {
    splashWindow = null
    // 启动窗口被用户关闭（未完成启动）时退出应用，避免留下无主窗口的空进程
    if (!mainWindow || mainWindow.isDestroyed()) app.quit()
  })

  // 加载失败回退：直接创建主窗口
  splashWindow.webContents.on('did-fail-load', (event, errorCode) => {
    if (errorCode === -3) return // ERR_ABORTED：主动中断，忽略
    console.error('[main] splash window failed to load:', errorCode)
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
  })

  const query = { desktopSplash: '1' }
  if (from) query.from = from
  if (isDev) {
    const url = new URL('http://localhost:3000/')
    url.searchParams.set('desktopSplash', '1')
    if (from) url.searchParams.set('from', from)
    splashWindow.loadURL(url.toString())
  } else {
    splashWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query })
  }
  return splashWindow
}

// 更新入口：直接复用启动页窗口承载更新（核心管理 / 依赖管理），不再单独创建更新窗口
function openUpdateWindow() {
  return createSplashWindow({ force: true, from: 'update' })
}

// 引导页窗口：独立窗口承载首次使用引导流程（设置模型/导入 Skills/迁移 AGENTS.md/MCP）
function openOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    onboardingWindow.focus()
    return onboardingWindow
  }

  onboardingWindow = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 720,
    minHeight: 600,
    title: 'Loopra 引导',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  onboardingWindow.on('closed', () => { onboardingWindow = null })

  if (isDev) {
    onboardingWindow.loadURL('http://localhost:3000/?desktopOnboarding=1')
  } else {
    onboardingWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { desktopOnboarding: '1' } })
  }
  return onboardingWindow
}

const NATIVE_TITLEBAR_LIGHT = '#f1f1ef'
const NATIVE_TITLEBAR_DARK = '#20201f'
const NATIVE_TITLEBAR_INK_LIGHT = '#343432'
const NATIVE_TITLEBAR_INK_DARK = '#ededeb'
const NATIVE_TITLEBAR_MODAL_MASK = '#16181b'
const NATIVE_TITLEBAR_MODAL_MASK_OPACITY = 0.24
let nativeTitleBarTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'gray'
let nativeTitleBarDimmed = false

function blendHexColors(background, foreground, opacity) {
  const parse = (color, offset) => Number.parseInt(color.slice(offset, offset + 2), 16)
  const channel = (offset) => Math.round(
    parse(background, offset) * (1 - opacity) + parse(foreground, offset) * opacity
  ).toString(16).padStart(2, '0')
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

function nativeTitleBarOverlay(isDark, dimmed = nativeTitleBarDimmed) {
  const color = isDark ? NATIVE_TITLEBAR_DARK : NATIVE_TITLEBAR_LIGHT
  const symbolColor = isDark ? NATIVE_TITLEBAR_INK_DARK : NATIVE_TITLEBAR_INK_LIGHT
  return {
    // Windows 的原生标题栏按钮绘制在 renderer/WebContentsView 之上，网页遮罩
    // 无法覆盖它；模态浮层显示时用相同颜色与透明度合成，视觉上保持连续。
    color: dimmed ? blendHexColors(color, NATIVE_TITLEBAR_MODAL_MASK, NATIVE_TITLEBAR_MODAL_MASK_OPACITY) : color,
    symbolColor: dimmed ? blendHexColors(symbolColor, NATIVE_TITLEBAR_MODAL_MASK, NATIVE_TITLEBAR_MODAL_MASK_OPACITY) : symbolColor,
    height: 36
  }
}

function applyTitleBarOverlayTheme(rawTheme) {
  nativeTitleBarTheme = rawTheme === 'dark' ? 'dark' : 'gray'
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setTitleBarOverlay(nativeTitleBarOverlay(nativeTitleBarTheme === 'dark'))
  } catch (error) {
    console.warn('[desktop-shell] failed to update native titlebar overlay:', error.message)
  }
}

function setTitleBarOverlayDimmed(dimmed) {
  const next = dimmed === true
  if (nativeTitleBarDimmed === next) return
  nativeTitleBarDimmed = next
  applyTitleBarOverlayTheme(nativeTitleBarTheme)
}

function createWindow() {
  const titleBarOptions = process.platform === 'win32'
    ? {
      frame: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: nativeTitleBarOverlay(nativeTitleBarTheme === 'dark')
    }
    : process.platform === 'darwin'
      ? { frame: false, titleBarStyle: 'hiddenInset' }
      : { frame: true }
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 800, minHeight: 600,
    icon: appIconPath,
    ...titleBarOptions,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 开发模式：加载 Vite dev server；生产模式：加载打包后的 renderer
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000/?desktopShell=1')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { desktopShell: '1' } })
  }

  if (shouldOpenDevTools) mainWindow.webContents.openDevTools()

  mainWindow.on('focus', () => {
    const activeOverlay = desktopOverlayManager.getTopVisible()
    if (activeOverlay && !activeOverlay.view.webContents.isDestroyed()) {
      activeOverlay.view.webContents.focus()
      return
    }
    const tab = desktopChatTabs.get(desktopChatActiveTabId)
    const wc = tab?.view.webContents
    if (!tab || !tab.visible || !wc || wc.isDestroyed()) return
    wc.focus()
    sendDesktopChatTabEvent(tab, 'desktop-chat-tab-focus-composer')
  })
  const syncNativeOverlays = () => desktopOverlayManager.syncAll()
  mainWindow.on('resize', syncNativeOverlays)
  mainWindow.on('maximize', syncNativeOverlays)
  mainWindow.on('unmaximize', syncNativeOverlays)
  mainWindow.on('restore', syncNativeOverlays)

  mainWindow.webContents.on('context-menu', (event, params) => {
    // 侧栏项目/会话由渲染进程分别请求自己的菜单；不要再让旧的开发菜单覆盖它。
    if (Number(params?.x) < DESKTOP_SIDEBAR_CONTEXT_WIDTH) {
      event.preventDefault()
      return
    }
    const menu = Menu.buildFromTemplate([
      { label: '检查元素', click: () => mainWindow.webContents.inspectElement(params.x, params.y) },
      { type: 'separator' },
      { role: 'reload', label: '刷新' },
      { role: 'forceReload', label: '强制刷新' },
      { role: 'toggleDevTools', label: '开发者工具' }
    ])
    menu.popup()
  })

  mainWindow.on('closed', () => {
    if (elementInspectorWindow && !elementInspectorWindow.isDestroyed()) elementInspectorWindow.close()
    if (aiBrowserWindow && !aiBrowserWindow.isDestroyed()) aiBrowserWindow.close()
    if (desktopPetWindow && !desktopPetWindow.isDestroyed()) desktopPetWindow.close()
    if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close()
    if (elementWebView && !elementWebView.webContents.isDestroyed()) elementWebView.webContents.close()
    desktopOverlayManager.destroyAll()
    destroyDesktopChatTabs()
    elementWebView = null
    mainWindow = null
  })
}

function isDesktopChatSender(sender) {
  return sender === mainWindow?.webContents
    || [...desktopChatTabs.values()].some((tab) => tab.view.webContents === sender)
}

function sendPendingDesktopPetReply() {
  if (!pendingDesktopPetReply || !desktopPetWindow || desktopPetWindow.isDestroyed()) return
  desktopPetWindow.webContents.send('desktop-pet-reply', pendingDesktopPetReply)
  pendingDesktopPetReply = null
}

function deliverAssistantReply(rawReply) {
  const text = String(rawReply || '').trim()
  if (!text) return false
  const payload = {text: text.slice(0, 180)}

  if (desktopPetWindow && !desktopPetWindow.isDestroyed() && desktopPetWindow.isVisible()) {
    pendingDesktopPetReply = payload
    if (desktopPetWindow.webContents.isLoading()) return true
    sendPendingDesktopPetReply()
    return true
  }

  if (!Notification.isSupported()) return false
  const notification = new Notification({
    title: 'Loopra 收到 AI 回复',
    body: payload.text
  })
  notification.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  notification.show()
  return true
}

function getDesktopPetStatePath() {
  return path.join(getLoopraPaths().configDir, 'pet', 'desktop.json')
}

function readDesktopPetState() {
  try {
    const state = JSON.parse(fs.readFileSync(getDesktopPetStatePath(), 'utf8'))
    return state && typeof state === 'object' ? state : {}
  } catch {
    return {}
  }
}

function saveDesktopPetState(changes) {
  try {
    const statePath = getDesktopPetStatePath()
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify({ ...readDesktopPetState(), ...changes }), 'utf8')
  } catch (error) {
    console.error('[desktop-pet] failed to persist state:', error.message)
  }
}

function isDesktopPetEnabled() {
  return readDesktopPetState().visible === true
}

function getDesktopPetPosition() {
  const { x, y } = readDesktopPetState()
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null
}

function setDesktopPetEnabled(visible) {
  saveDesktopPetState({ visible: Boolean(visible) })
}

function setDesktopPetPosition(x, y) {
  saveDesktopPetState({ x: Math.round(x), y: Math.round(y) })
}

// 初始位置：主窗口右下角偏移（无持久化位置时的默认落点，也用于“重置位置”）
function getDesktopPetInitialPosition() {
  return {
    x: Math.max(0, (mainWindow?.getBounds().x || 0) + (mainWindow?.getBounds().width || 800) - 260),
    y: Math.max(0, (mainWindow?.getBounds().y || 0) + (mainWindow?.getBounds().height || 600) - 300)
  }
}

function openDesktopPetWindow() {
  if (desktopPetWindow && !desktopPetWindow.isDestroyed()) {
    desktopPetWindow.showInactive()
    return desktopPetWindow
  }

  const persistedPosition = getDesktopPetPosition()
  const initialPosition = persistedPosition || getDesktopPetInitialPosition()
  if (!persistedPosition) setDesktopPetPosition(initialPosition.x, initialPosition.y)

  desktopPetWindow = new BrowserWindow({
    width: 240,
    height: 240,
    x: initialPosition.x,
    y: initialPosition.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  desktopPetWindow.setAlwaysOnTop(true, 'floating')
  desktopPetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  desktopPetWindow.setIgnoreMouseEvents(true, { forward: true })
  desktopPetWindow.on('closed', () => { desktopPetWindow = null })
  desktopPetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  desktopPetWindow.once('ready-to-show', () => desktopPetWindow?.showInactive())
  desktopPetWindow.webContents.on('did-finish-load', sendPendingDesktopPetReply)

  if (isDev) {
    desktopPetWindow.loadURL('http://localhost:3000/?desktopPet=1')
  } else {
    desktopPetWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { desktopPet: '1' } })
  }
  return desktopPetWindow
}

app.whenReady().then(() => {
  // The renderer provides its own toolbar; do not expose Electron's default menu bar.
  Menu.setApplicationMenu(null)
  startAiBrowserBridge().catch((error) => console.error('[ai-browser] failed to start bridge:', error.message))
  createSplashWindow()
  if (isDesktopPetEnabled()) openDesktopPetWindow()
  app.on('activate', () => {
    // macOS dock 点击时无窗口则重新走启动窗口流程（服务已就绪时快速通过）
    if (BrowserWindow.getAllWindows().length === 0) createSplashWindow()
  })
})

app.on('window-all-closed', () => {
  cleanupLoopraWeb()
  app.quit()
})

app.on('before-quit', () => {
  cleanupLoopraWeb()
  closeAllFileExplorerWatchers()
  stopAiBrowserBridge()
  killAllTerminals()
})

// ==================== IPC ====================

registerTerminalIpc()
registerGitEnvironmentIpc(ipcMain)
registerOnboardingIpc(ipcMain, { getOnboardingWindow: () => onboardingWindow })

// ==================== 桌面端 UI 设置持久化 ====================
// file:// 页面 localStorage 不可靠，主题/中文字体等外观设置写入 userData/ui-settings.json
const uiSettingsFile = () => path.join(app.getPath('userData'), 'ui-settings.json')

const isUiSettingsSender = (event) => {
  try {
    const url = event.senderFrame?.url || event.sender?.getURL() || ''
    return /^(file:|http:\/\/(localhost|127\.0\.0\.1):\d+)/.test(url)
  } catch {
    return false
  }
}

ipcMain.handle('ui-settings-get', (event) => {
  if (!isUiSettingsSender(event)) return null
  try {
    if (!fs.existsSync(uiSettingsFile())) return null
    return JSON.parse(fs.readFileSync(uiSettingsFile(), 'utf-8'))
  } catch (error) {
    console.warn('[ui-settings] read failed:', error.message)
    return null
  }
})

ipcMain.handle('ui-settings-set', (event, payload = {}) => {
  if (!isUiSettingsSender(event)) return false
  try {
    const sanitized = {}
    if (typeof payload.theme === 'string') sanitized.theme = payload.theme
    if (typeof payload.fontFamily === 'string') sanitized.fontFamily = payload.fontFamily
    // 原子写：先写临时文件再替换，避免中途断电损坏配置
    const file = uiSettingsFile()
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
    return true
  } catch (error) {
    console.warn('[ui-settings] write failed:', error.message)
    return false
  }
})

// ==================== 系统字体枚举 ====================
// 枚举本机已安装字体供设置页选择（Windows 用 PowerShell 读注册表并输出 UTF-8，避免 GBK 乱码；
// Linux/macOS 用 fc-list）。结果进程内缓存，仅首次调用有开销。
let systemFontsCache = null

// 文件级样式变体（如 'Arial Bold'、'Calibri Light Italic'）不是独立字体家族，过滤掉
const FONT_STYLE_WORDS = ['Bold', 'Italic', 'Oblique', 'Light', 'Thin', 'Black', 'Heavy', 'Medium', 'SemiBold', 'DemiBold', 'ExtraBold', 'ExtraLight', 'SemiLight', 'Regular', 'Condensed', 'Expanded', 'SemiCondensed', 'ExtraCondensed']
const FONT_STYLE_RE = new RegExp(`\\s+(${FONT_STYLE_WORDS.join('|')})(\\s+(${FONT_STYLE_WORDS.join('|')}))*$`, 'i')

// 注册表字体名常为 '微软雅黑 & Microsoft YaHei (TrueType)' 复合名，按 & 拆成独立可匹配名
const normalizeFontName = (raw) => {
  const parts = raw.replace(/\s+\((TrueType|OpenType)\)\s*$/i, '').split(/\s*&\s*/)
  const names = []
  for (const part of parts) {
    const name = part.trim()
    // 空名 / 纯样式变体 / 异常长的复合名跳过
    if (!name || FONT_STYLE_RE.test(name) || name.length > 60) continue
    names.push(name)
  }
  return names
}

async function listSystemFonts() {
  if (process.platform === 'win32') {
    const script = [
      '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
      '$names = @()',
      "foreach ($hive in 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts') {",
      '  if (Test-Path $hive) {',
      '    $p = Get-ItemProperty $hive',
      '    foreach ($prop in $p.PSObject.Properties) {',
      '      $v = $prop.Value',
      "      if ($v -is [string] -and $v -match '\\.(ttf|ttc|otf|fon)$') { $names += $prop.Name }",
      '    }',
      '  }',
      '}',
      '$names | Sort-Object -Unique | ConvertTo-Json -Compress'
    ].join('\n')
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      const rawNames = JSON.parse(stdout.trim() || '[]')
      const names = new Set()
      for (const raw of rawNames) for (const name of normalizeFontName(raw)) names.add(name)
      return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    } catch (error) {
      console.warn('[system-fonts] list failed:', error.message)
      return []
    }
  }
  // Linux：fc-list（fontconfig 是 X 环境标配）
  if (process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('fc-list', ['--format=%{family}\n'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      const names = new Set()
      for (const line of stdout.split(/\r?\n/)) {
        for (const part of line.split(',')) {
          const name = part.trim()
          if (name && !FONT_STYLE_RE.test(name) && name.length <= 60) names.add(name)
        }
      }
      return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    } catch {
      return []
    }
  }
  // macOS：fc-list 非系统自带（需安装 fontconfig），优先尝试，失败回退 system_profiler
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('fc-list', ['--format=%{family}\n'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
      const names = new Set()
      for (const line of stdout.split(/\r?\n/)) {
        for (const part of line.split(',')) {
          const name = part.trim()
          if (name && !FONT_STYLE_RE.test(name) && name.length <= 60) names.add(name)
        }
      }
      return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    } catch {
      /* fc-list 不可用时用 system_profiler 枚举（较慢，但只调用一次） */
    }
    try {
      const { stdout } = await execFileAsync('system_profiler', ['SPFontsDataType', '-json'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 })
      const data = JSON.parse(stdout)
      const names = new Set()
      for (const item of data.SPFontsDataType || []) {
        const fam = item.family
        const list = Array.isArray(fam) ? fam : [fam]
        for (const raw of list) {
          for (const part of String(raw || '').split(',')) {
            const name = part.trim()
            if (name && !FONT_STYLE_RE.test(name) && name.length <= 60) names.add(name)
          }
        }
      }
      return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    } catch (error) {
      console.warn('[system-fonts] darwin list failed:', error.message)
      return []
    }
  }
  return []
}

ipcMain.handle('system-fonts-list', async (event) => {
  if (!isUiSettingsSender(event)) return []
  if (!systemFontsCache) systemFontsCache = await listSystemFonts()
  return systemFontsCache
})

ipcMain.handle('get_loopra_web_port', async () => currentPort)

ipcMain.handle('get_electron_version', async () => {
  return app.getVersion()
})

ipcMain.handle('get_loopra_web_status', async () => {
  const { runtimeDir } = getLoopraPaths()
  return {
    installed: isLoopraGuiInstalled(),
    running: loopraWebProcess !== null,
    install_dir: runtimeDir,
    config_dir: path.join(app.getPath('home'), '.loopra'),
    bundled_core: isLoopraCoreBundled(),
    runtime_version: readLoopraGuiVersion(),
    desktop_version: app.getVersion().replace(/^v/i, '')
  }
})

// JRE/JDK 环境检测：系统 Java 与捆绑 JRE 的版本/路径/可用性（供启动窗口「依赖管理」页展示）
ipcMain.handle('detect_java_status', async () => {
  try {
    return await detectJavaStatus()
  } catch (error) {
    console.error('Failed to detect Java status:', error)
    return {
      system: { found: false, path: '', version: '', major: 0 },
      bundled: { found: false, path: '', version: '', major: 0 },
      used: '',
      usable: false,
      requiredMajor: 17,
      hint: 'Java 环境检测失败: ' + error.message,
      error: error.message
    }
  }
})

ipcMain.handle('list_loopra_java_processes', async () => {
  try {
    const processes = await listLoopraJavaProcesses()
    return { processes: processes.filter((item) => isLoopraGuiRuntime(item.commandLine)) }
  } catch (error) {
    console.error('Failed to list Loopra Java processes:', error)
    return { processes: [], error: error.message }
  }
})

ipcMain.handle('terminate_loopra_java_process', async (event, rawPid) => {
  const pid = Number(rawPid)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process id')

  const processes = await listLoopraJavaProcesses()
  const processInfo = processes.find((item) => item.pid === pid && isLoopraGuiRuntime(item.commandLine))
  if (!processInfo) {
    throw new Error('Loopra desktop runtime process no longer exists')
  }

  if (isWin) {
    await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
  } else {
    process.kill(pid, 'SIGTERM')
  }

  if (loopraWebProcess && (loopraWebProcess.pid === pid || processInfo.port === currentPort)) {
    loopraWebProcess = null
    currentPort = 0
  }
  return { success: true }
})

ipcMain.handle('open_loopra_java_process', async (event, rawPid) => {
  const pid = Number(rawPid)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process id')

  const processes = await listLoopraJavaProcesses()
  const processInfo = processes.find((item) => item.pid === pid && isLoopraGuiRuntime(item.commandLine))
  if (!processInfo) throw new Error('Loopra desktop runtime process no longer exists')
  if (!Number.isInteger(processInfo.port) || processInfo.port < 1 || processInfo.port > 65535) {
    throw new Error('No HTTP port was found for this Loopra backend process')
  }

  openLoopraWebWindow(processInfo.port)
  return { success: true, port: processInfo.port }
})

ipcMain.handle('get_resource_dir', async () => {
  if (app.isPackaged) return path.join(process.resourcesPath, 'resources')
  return path.join(__dirname, '../resources')
})

ipcMain.handle('check_install_needed', async () => {
  if (!isLoopraGuiInstalled()) {
    return { needed: true, reason: 'not_installed' }
  }

  const runtimeVersion = readLoopraGuiVersion()
  const desktopVersion = app.getVersion().replace(/^v/i, '')
  const versionResult = compareVersions(runtimeVersion, desktopVersion)
  if (versionResult < 0) {
    return { needed: true, reason: 'version_mismatch', runtimeVersion, desktopVersion }
  }
  if (versionResult > 0) {
    return { needed: true, reason: 'desktop_outdated', runtimeVersion, desktopVersion }
  }

  return { needed: false, reason: '', runtimeVersion, desktopVersion }
})
ipcMain.handle('install_loopra_web', async () => ({
  success: false,
  error: '桌面运行时需要通过在线安装部署到 ~/.loopra-gui'
}))

ipcMain.handle('start_loopra_web', async () => {
  // 无论服务由 CLI、旧版 GUI 或当前 GUI 启动，优先复用稳定的默认端口。
  const preferredPort = 4567

  // 桌面端重启后，核心服务也应随之重新启动：
  // 终止上次遗留的 GUI 运行时进程（~/.loopra-gui），避免直接复用旧进程/旧版本服务；
  // CLI（~/.loopra）启动的服务不在清理范围，仍按上面的约定优先复用 4567。
  try {
    const existingProcesses = await listLoopraJavaProcesses()
    for (const item of existingProcesses.filter((p) => isLoopraGuiRuntime(p.commandLine) && p.port > 0)) {
      try {
        await stopLoopraJavaProcess(item.pid)
        console.log(`Stopped stale GUI loopra-web process ${item.pid} on port ${item.port}`)
      } catch (error) {
        console.warn(`Failed to stop stale GUI loopra-web process ${item.pid}: ${error.message}`)
      }
    }
  } catch (error) {
    console.warn('Failed to list loopra java processes:', error.message)
  }

  if (await healthCheck(preferredPort)) {
    // 复用前校验版本：运行中的服务若与本地安装的运行时版本不一致（如刚更新过核心服务），
    // 终止旧进程并继续走启动逻辑，避免更新后的 jar 不生效。
    if (await isServiceVersionCurrent(preferredPort)) {
      if (loopraWebProcess && currentPort !== preferredPort) cleanupLoopraWeb()
      console.log(`Loopra Web already running on port ${preferredPort}, reusing`)
      currentPort = preferredPort
      await closeOtherLoopraJavaProcesses(currentPort)
      return preferredPort
    }
    console.log(`Loopra Web on port ${preferredPort} is outdated, restarting with installed runtime`)
    await stopLoopraWebOnPort(preferredPort)
  }

  if (loopraWebProcess) {
    await closeOtherLoopraJavaProcesses(currentPort)
    return currentPort
  }

  // 桌面端只复用自己的运行时进程，不接管命令行安装在 ~/.loopra 下的非默认端口服务。
  const guiProcesses = await listLoopraJavaProcesses()
  const existingGui = guiProcesses.find((item) => isLoopraGuiRuntime(item.commandLine) && item.port > 0)
  if (existingGui && await healthCheck(existingGui.port)) {
    console.log(`Loopra GUI Web already running on port ${existingGui.port}, reusing`)
    currentPort = existingGui.port
    await closeOtherLoopraJavaProcesses(currentPort)
    return existingGui.port
  }

  const port = await getDefaultPort()

  // 未运行，启动
  try {
    startLoopraWeb(port)
    currentPort = port
    await closeOtherLoopraJavaProcesses(currentPort)
    return port
  } catch (error) {
    throw new Error(`Failed to start loopra web: ${error.message}`)
  }
})

// 推送安装日志到前端（广播给主窗口/启动窗口/更新窗口）
function sendInstallLog(line) {
  const payload = { type: 'log', line }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('install-output', payload)
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('install-output', payload)
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.webContents.send('install-output', payload)
}

// 执行核心运行时安装子进程，输出逐行推送到前端（复用 sendInstallLog）
function runLoopraCoreInstaller(child) {
  return new Promise((resolve, reject) => {
    sendInstallLog('>> 安装进程已启动，等待输出...')
    sendInstallLog('')

    let installOutputBuffer = ''

    function onInstallOutput(data) {
      installOutputBuffer += data.toString()
      const lines = installOutputBuffer.split('\n')
      // 保留最后一段（可能不完整），其余发送
      installOutputBuffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, '')
        if (trimmed.length > 0) {
          sendInstallLog(trimmed)
        }
      }
    }

    child.stdout.on('data', onInstallOutput)
    child.stderr.on('data', onInstallOutput)
    child.on('exit', (code) => {
      // 刷出 buffer 中剩余的内容
      if (installOutputBuffer.length > 0) {
        const trimmed = installOutputBuffer.replace(/\r$/, '')
        if (trimmed.length > 0) {
          sendInstallLog(trimmed)
        }
      }
      installOutputBuffer = ''
      sendInstallLog('')
      sendInstallLog(`>> 安装进程已退出，退出码: ${code}`)
      if (code === 0) {
        resolve({ success: true })
      } else {
        reject(new Error(`安装失败，退出码: ${code}`))
      }
    })
    child.on('error', (err) => {
      sendInstallLog(`>> ❌ 启动安装进程失败: ${err.message}`)
      reject(new Error(`安装进程启动失败: ${err.message}`))
    })
  })
}

// 从安装包内置核心运行时本地安装（无需下载核心包；JRE 缺失时由安装脚本在线下载）
function installLoopraCoreLocal() {
  const coreDir = getLoopraCoreDir()
  const installScript = path.join(coreDir, isWin ? 'install.ps1' : 'install.sh')
  sendInstallLog(`>> 使用安装包内置核心: ${coreDir}`)

  let child
  if (isWin) {
    child = spawn('powershell', [
      '-ExecutionPolicy', 'Bypass', '-NoProfile',
      '-File', installScript, '-Gui', '-Setup'
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    sendInstallLog('>> 执行: install.ps1 -Gui -Setup')
  } else {
    // bash 显式执行，不依赖 tar 解压后的可执行权限
    child = spawn('bash', [installScript, '--gui', '--setup'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    sendInstallLog('>> 执行: install.sh --gui --setup')
  }
  return runLoopraCoreInstaller(child)
}

// 在线一键安装 loopra（走远程脚本，支持直连/镜像源；作为内置核心缺失或本地安装失败的回退）
ipcMain.handle('install_loopra_web_online', async (event, options = {}) => {
  const source = options && options.source === 'mirror' ? 'mirror' : 'normal'
  sendInstallLog('='.repeat(50))
  sendInstallLog('  Loopra 核心服务安装')
  sendInstallLog('='.repeat(50))

  // 优先使用安装包内置核心运行时：安装包已带核心包，用户无需再下载第二遍；
  // 内置缺失（开发模式/旧版安装包）或本地安装失败时，回退在线下载安装。
  if (isLoopraCoreBundled()) {
    sendInstallLog('>> 检测到安装包内置核心运行时，使用本地安装（无需下载核心包）')
    sendInstallLog('>> 桌面运行时将安装到 ~/.loopra-gui，配置继续使用 ~/.loopra')
    sendInstallLog('')
    try {
      await installLoopraCoreLocal()
      sendInstallLog('')
      sendInstallLog('>> ✅ Loopra 安装成功！')
      return { success: true }
    } catch (error) {
      sendInstallLog(`>> ⚠️ 本地安装失败（${error.message}），回退在线下载安装`)
      sendInstallLog('')
    }
  }

  // 镜像源使用 setup-gui-mirror 脚本（安装包经 gh-proxy 加速下载）
  const scriptName = source === 'mirror' ? 'setup-gui-mirror' : 'setup-gui'
  sendInstallLog(`>> 下载源: ${source === 'mirror' ? '镜像 (gh-proxy)' : 'GitHub 直连'}`)
  sendInstallLog('>> 桌面运行时将安装到 ~/.loopra-gui，配置继续使用 ~/.loopra')
  sendInstallLog('')

  try {
    let child
    if (isWin) {
      // Windows: irm ... | iex
      sendInstallLog('>> 检测到 Windows 系统，使用 PowerShell 安装...')
      const psCmd = [
        '-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command',
        `irm https://raw.giteeusercontent.com/ezdemo/loopra/raw/main/.release/${scriptName}.ps1 | iex`
      ]
      child = spawn('powershell', psCmd, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      sendInstallLog(`>> 执行: irm ${scriptName}.ps1 | iex`)
    } else {
      // macOS/Linux: curl ... | bash
      sendInstallLog('>> 检测到 Unix 系统，使用 curl 安装...')
      // 下载脚本并管道给 bash 执行，-fsSL = 静默+显示错误+跟随跳转
      child = spawn('bash', ['-c',
        `curl -fsSL https://raw.giteeusercontent.com/ezdemo/loopra/raw/main/.release/${scriptName}.sh | bash`
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      sendInstallLog(`>> 执行: curl ${scriptName}.sh | bash`)
    }

    await runLoopraCoreInstaller(child)
    sendInstallLog('')
    sendInstallLog('>> ✅ Loopra 安装成功！')
    return { success: true }
  } catch (error) {
    sendInstallLog('>> ❌ 安装失败，请检查网络连接后重试')
    throw error
  }
})

// 仅使用安装包内置核心运行时进行本地安装/更新（不做在线回退）。
// 安装包内置核心时，桌面端与核心服务随版本一起发布，本地更新即可保持同步。
ipcMain.handle('install_loopra_web_local', async () => {
  sendInstallLog('='.repeat(50))
  sendInstallLog('  Loopra 核心服务本地更新')
  sendInstallLog('='.repeat(50))

  if (!isLoopraCoreBundled()) {
    sendInstallLog('>> ❌ 当前安装包未内置核心运行时，无法本地安装/更新')
    throw new Error('当前安装包未内置核心运行时，无法本地安装/更新')
  }

  sendInstallLog('>> 使用安装包内置核心运行时本地安装/更新（无需下载核心包）')
  sendInstallLog('>> 桌面运行时将安装到 ~/.loopra-gui，配置继续使用 ~/.loopra')
  sendInstallLog('')
  try {
    await installLoopraCoreLocal()
    sendInstallLog('')
    sendInstallLog('>> ✅ Loopra 安装/更新成功！')
    return { success: true }
  } catch (error) {
    sendInstallLog(`>> ❌ 本地安装/更新失败: ${error.message}`)
    throw error
  }
})

// 自动下载并安装最新 JRE 25（Adoptium assets API 获取 GitHub 直链，支持直连/指定镜像源）
ipcMain.handle('download_jre25', async (event, options = {}) => {
  const source = options && options.source ? options.source : 'normal'
  sendJreLog('='.repeat(50))
  sendJreLog('  JRE 25 自动下载安装')
  sendJreLog('='.repeat(50))
  try {
    return await downloadAndInstallJre25(source)
  } catch (error) {
    sendJreLog(`>> ❌ ${error.message}`)
    throw error
  }
})

// 镜像测速：并发测各镜像延迟，返回 [{ value, latency }]（失败/超时 latency=null）
ipcMain.handle('measure_mirror_latencies', async (event, options = {}) => {
  const mirrors = Array.isArray(options && options.mirrors) ? options.mirrors : []
  const timeout = Number((options && options.timeout) || 8000)
  const list = await Promise.all(mirrors.map(async (m) => ({
    value: m && m.value ? m.value : '',
    latency: m && m.value ? await measureMirrorLatency(m.value, timeout) : null
  })))
  return { success: true, list: list.filter((item) => item.value) }
})

ipcMain.handle('stop_loopra_web', async () => {
  cleanupLoopraWeb()
})

ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize() })
ipcMain.handle('window-maximize', () => {
  if (mainWindow) mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.handle('window-close', (event) => {
  // 按调用方窗口关闭，供主窗口/启动窗口/更新窗口通用
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) win.close()
})
ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false)
// A native menu remains above WebContentsView-backed desktop chat tabs.
function applyNativeMenuTheme(rawTheme) {
  const themeSource = rawTheme === 'dark' ? 'dark' : 'light'
  if (nativeTheme.themeSource !== themeSource) nativeTheme.themeSource = themeSource
}

ipcMain.handle('desktop-home-context-menu', (event, rawTheme) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop home menu request')
  if (!mainWindow || mainWindow.isDestroyed()) return null
  applyNativeMenuTheme(rawTheme)

  return new Promise((resolve) => {
    let settled = false
    const finish = (action) => {
      if (settled) return
      settled = true
      resolve(action)
    }
    const menu = Menu.buildFromTemplate([
      { label: '需求池', click: () => finish('open-requirement-board') },
      { label: '引导', click: () => finish('open-onboarding') },
      { label: '更新', click: () => finish('open-update') },
      { label: rawTheme === 'dark' ? '浅色' : '暗色', click: () => finish('toggle-theme') }
    ])
    menu.popup({
      window: mainWindow,
      callback: () => finish(null)
    })
  })
})

ipcMain.handle('desktop-chat-header-menu', (event, rawTheme) => {
  if (!isDesktopChatSender(event.sender)) throw new Error('Unauthorized desktop chat header menu request')
  if (!mainWindow || mainWindow.isDestroyed()) return null
  applyNativeMenuTheme(rawTheme)

  return new Promise((resolve) => {
    let settled = false
    const finish = (action) => {
      if (settled) return
      settled = true
      resolve(action)
    }
    const menu = Menu.buildFromTemplate([
      { label: '刷新会话', click: () => finish('refresh-session') },
      { label: '项目能力', click: () => finish('project-capabilities') },
      { label: '终端', click: () => finish('terminal') },
      { label: '侧边栏', click: () => finish('sidebar') }
    ])
    menu.popup({
      window: mainWindow,
      callback: () => finish(null)
    })
  })
})

ipcMain.handle('desktop-session-context-menu', (event, rawPayload = {}) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop session menu request')
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const workspaceHash = String(rawPayload?.workspaceHash || '').trim()
  const sessionName = String(rawPayload?.sessionName || '').trim()
  const sessionTitle = String(rawPayload?.sessionTitle || '').trim().slice(0, 240)
  if (!workspaceHash || !sessionName || workspaceHash.length > 240 || sessionName.length > 240) return null
  applyNativeMenuTheme(rawPayload?.theme)

  return new Promise((resolve) => {
    let settled = false
    const finish = (action) => {
      if (settled) return
      settled = true
      if (action && mainWindow && !mainWindow.isDestroyed()) {
        const item = { workspaceHash, name: sessionName }
        if (sessionTitle) item.title = sessionTitle
        mainWindow.webContents.send('desktop-session-context-action', { action, item })
      }
      // 菜单点击通过事件回传，避免依赖原生菜单关闭时的 IPC Promise 时序。
      resolve(null)
    }
    const menu = Menu.buildFromTemplate([
      { label: '重命名会话', click: () => finish('rename-session') },
      { label: '删除会话', click: () => finish('delete-session') }
    ])
    menu.popup({
      window: mainWindow,
      callback: () => finish(null)
    })
  })
})

ipcMain.handle('desktop-tab-context-menu', (event, rawPayload = {}) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop tab menu request')
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const tabId = String(rawPayload?.tabId || '').trim()
  const tab = desktopChatTabs.get(tabId)
  if (!tab || tab.view.webContents.isDestroyed()) return null
  const index = Number.isInteger(rawPayload?.index) ? rawPayload.index : -1
  const tabCount = Number.isInteger(rawPayload?.tabCount) ? rawPayload.tabCount : 0
  applyNativeMenuTheme(rawPayload?.theme)
  const canCloseLeft = index > 0
  const canCloseRight = index >= 0 && index < tabCount - 1

  return new Promise((resolve) => {
    let settled = false
    const finish = (action) => {
      if (settled) return
      settled = true
      resolve(action)
    }
    const menu = Menu.buildFromTemplate([
      { label: '刷新', click: () => finish('reload') },
      { label: '关闭', click: () => finish('close') },
      { type: 'separator' },
      { label: '关闭上方会话', enabled: canCloseLeft, click: () => finish('close-left') },
      { label: '关闭下方会话', enabled: canCloseRight, click: () => finish('close-right') }
    ])
    menu.popup({
      window: mainWindow,
      callback: () => finish(null)
    })
  })
})

// 启动窗口完成检测/安装/启动后：创建主窗口并关闭启动窗口
ipcMain.handle('splash_ready', () => {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  return true
})

// 更新窗口管理
ipcMain.handle('open-update-window', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized update window request')
  openUpdateWindow()
  return { success: true }
})
ipcMain.handle('update-window-close', () => {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close()
})

// 更新窗口发起「更新核心服务」：转发给主窗口（DesktopShell 新建会话后由 Agent 在聊天框执行）
ipcMain.handle('chat-update-request', (event, payload = {}) => {
  if (event.sender !== updateWindow?.webContents) throw new Error('Unauthorized chat update request')
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const source = payload && payload.source === 'mirror' ? 'mirror' : 'normal'
  mainWindow.webContents.send('chat-update-request', { source })
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return true
})

// 引导页窗口管理：桌面聊天界面打开；引导页自身关闭
ipcMain.handle('onboarding-window-open', (event) => {
  if (!isDesktopChatSender(event.sender)) throw new Error('Unauthorized onboarding window request')
  openOnboardingWindow()
  return { success: true }
})
ipcMain.handle('onboarding-window-close', (event) => {
  if (event.sender !== onboardingWindow?.webContents) throw new Error('Unauthorized onboarding window close')
  if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close()
  return true
})

// 主窗口（DesktopShell）向指定聊天标签发送命令；渲染器未挂载时由 tab 队列暂存。
ipcMain.handle('desktop-chat-tab-send-command', async (event, tabId, command) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tab = desktopChatTabs.get(String(tabId || ''))
  const cmd = String(command || '').trim()
  if (!tab || !cmd || !await waitForDesktopChatReady(tab)) return false
  return sendDesktopChatTabEvent(tab, 'desktop-chat-tab-send-command', cmd)
})
ipcMain.handle('desktop-pet-open', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop pet request')
  setDesktopPetEnabled(true)
  openDesktopPetWindow()
  return true
})
ipcMain.handle('desktop-pet-close', (event) => {
  // 主窗口与宠物窗口均可主动关闭（宠物右键菜单“关闭宠物”由宠物窗口发起）
  if (event.sender !== mainWindow?.webContents && event.sender !== desktopPetWindow?.webContents) {
    throw new Error('Unauthorized desktop pet request')
  }
  setDesktopPetEnabled(false)
  if (desktopPetWindow && !desktopPetWindow.isDestroyed()) desktopPetWindow.close()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-pet-closed')
  return false
})
ipcMain.handle('desktop-pet-is-visible', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop pet request')
  return Boolean(desktopPetWindow && !desktopPetWindow.isDestroyed() && desktopPetWindow.isVisible())
})
ipcMain.handle('desktop-pet-refresh', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop pet request')
  if (desktopPetWindow && !desktopPetWindow.isDestroyed()) desktopPetWindow.webContents.send('desktop-pet-refresh')
})
ipcMain.handle('desktop-pet-move-by', (event, delta) => {
  if (event.sender !== desktopPetWindow?.webContents) throw new Error('Unauthorized desktop pet move')
  const dx = Number(delta?.x)
  const dy = Number(delta?.y)
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 2000 || Math.abs(dy) > 2000) {
    throw new Error('Invalid desktop pet move')
  }
  const bounds = desktopPetWindow.getBounds()
  const nextX = Math.round(bounds.x + dx)
  const nextY = Math.round(bounds.y + dy)
  desktopPetWindow.setPosition(nextX, nextY)
  setDesktopPetPosition(nextX, nextY)
})
ipcMain.handle('desktop-pet-reset-position', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop pet reset position')
  const initial = getDesktopPetInitialPosition()
  // 宠物窗口已显示时立即移动；未显示时更新持久化位置，下次打开即落在初始位置
  if (desktopPetWindow && !desktopPetWindow.isDestroyed()) {
    desktopPetWindow.setPosition(initial.x, initial.y)
  }
  setDesktopPetPosition(initial.x, initial.y)
  return { x: initial.x, y: initial.y }
})
ipcMain.on('desktop-pet-set-interactive', (event, interactive) => {
  if (event.sender !== desktopPetWindow?.webContents || !desktopPetWindow || desktopPetWindow.isDestroyed()) return
  desktopPetWindow.setIgnoreMouseEvents(!interactive, { forward: true })
})
ipcMain.handle('desktop-pet-activate-main', (event) => {
  if (event.sender !== desktopPetWindow?.webContents) throw new Error('Unauthorized desktop pet activation')
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return true
})

ipcMain.handle('desktop-pet-reply', (event, rawReply) => {
  if (!isDesktopChatSender(event.sender)) throw new Error('Unauthorized desktop pet reply')
  return deliverAssistantReply(rawReply)
})

ipcMain.handle('pick_loopra_workspace_folder', async (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized folder picker request')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择项目文件夹',
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? '' : (result.filePaths[0] || '')
})

ipcMain.handle('pick_jar_file', async (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized jar picker request')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择拓展包 jar 文件',
    properties: ['openFile'],
    filters: [{ name: 'JAR 拓展包', extensions: ['jar'] }]
  })
  return result.canceled ? '' : (result.filePaths[0] || '')
})

// ==================== Desktop Search Overlay ====================

function normalizeDesktopSearchContext(rawContext = {}) {
  const limit = (value) => String(value || '').trim().slice(0, 240)
  return {
    activeSessionName: limit(rawContext?.activeSessionName),
    activeWorkspaceHash: limit(rawContext?.activeWorkspaceHash),
    theme: rawContext?.theme === 'dark' ? 'dark' : 'gray'
  }
}

function normalizeDesktopSearchAction(rawAction = {}) {
  const type = rawAction?.type === 'session' ? 'session' : 'action'
  if (type === 'session') {
    const workspaceHash = String(rawAction?.workspaceHash || '').trim().slice(0, 240)
    const sessionName = String(rawAction?.sessionName || '').trim().slice(0, 240)
    if (!workspaceHash || !sessionName) return null
    return {
      type,
      workspaceHash,
      sessionName,
      title: String(rawAction?.title || '').trim().slice(0, 120)
    }
  }
  const allowedActions = new Set(['new-session', 'add-workspace', 'open-file-search'])
  const id = String(rawAction?.id || '').trim()
  return allowedActions.has(id) ? { type, id } : null
}

function refocusDesktopShell() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  const tab = desktopChatTabs.get(desktopChatActiveTabId)
  const wc = tab?.view.webContents
  if (tab?.visible && wc && !wc.isDestroyed()) {
    wc.focus()
    sendDesktopChatTabEvent(tab, 'desktop-chat-tab-focus-composer')
  } else {
    mainWindow.webContents.focus()
  }
}

function isDesktopOverlaySender(key, sender) {
  const webContents = desktopOverlayManager.get(key)?.view?.webContents
  if (!webContents || webContents.isDestroyed() || !sender) return false
  // WebContentsView 在不同 Electron 版本中可能返回不同的 JS 包装对象，
  // 但同一个原生 WebContents 的 id 是稳定的。
  return sender === webContents || sender.id === webContents.id
}

function hideDesktopSearchView({ notify = true, refocus = true } = {}) {
  if (!desktopOverlayManager.hide('search')) return false
  if (notify && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-shell-search-closed')
  }
  if (refocus) refocusDesktopShell()
  return true
}

async function openDesktopSearchView(rawContext = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const context = normalizeDesktopSearchContext(rawContext)
  const entry = await desktopOverlayManager.open('search', {
    query: {
      desktopSearch: '1',
      activeSessionName: context.activeSessionName,
      activeWorkspaceHash: context.activeWorkspaceHash,
      theme: context.theme
    },
    backgroundColor: '#00000000',
    contextChannel: 'desktop-search-context',
    context
  })
  return Boolean(entry)
}

ipcMain.handle('desktop-search-open', async (event, rawContext) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop search request')
  try {
    return { success: await openDesktopSearchView(rawContext) }
  } catch (error) {
    console.error('[desktop-search] failed to open search overlay:', error)
    throw error
  }
})

ipcMain.handle('desktop-search-close', (event) => {
  const overlaySender = isDesktopOverlaySender('search', event.sender)
  if (event.sender !== mainWindow?.webContents && !overlaySender) throw new Error('Unauthorized desktop search close')
  hideDesktopSearchView()
  return { success: true }
})

ipcMain.handle('desktop-search-action', (event, rawAction) => {
  if (!isDesktopOverlaySender('search', event.sender)) throw new Error('Unauthorized desktop search action')
  const action = normalizeDesktopSearchAction(rawAction)
  if (!action || !mainWindow || mainWindow.isDestroyed()) return { success: false }
  hideDesktopSearchView()
  mainWindow.webContents.send('desktop-shell-search-action', action)
  return { success: true }
})

// ==================== Desktop Popup Overlay ====================

const DESKTOP_POPUP_TYPES = new Set(['explore', 'home-context', 'tab-context', 'context-menu', 'rename-session', 'confirm'])
const DESKTOP_POPUP_MODAL_TYPES = new Set(['rename-session', 'confirm'])
const DESKTOP_POPUP_ACTIONS = new Set([
  'open-skills', 'open-settings', 'open-sub-agents', 'open-tools', 'toggle-theme',
  'open-requirement-board', 'open-onboarding', 'open-update', 'reload', 'close', 'close-left', 'close-right',
  'rename-session', 'delete-session', 'copy-workspace-path', 'clear-workspace',
  'clear-old-sessions', 'delete-workspace', 'confirm', 'cancel'
])
const DESKTOP_POPUP_CONFIRM_KINDS = new Set([
  'session', 'sessions', 'clearWorkspace', 'clearOldSessions', 'deleteWorkspace', 'deleteWorkspaces'
])

function popupText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeDesktopPopupItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null
  const item = {}
  for (const key of ['hash', 'workspaceHash', 'name', 'title', 'path']) {
    const value = popupText(rawItem[key], key === 'path' ? 1000 : 240)
    if (value) item[key] = value
  }
  if (typeof rawItem.mtime === 'number' && Number.isFinite(rawItem.mtime)) item.mtime = rawItem.mtime
  return item
}

function normalizeDesktopPopupData(value, depth = 0) {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, 1000)
  if (depth >= 3 || typeof value !== 'object') return null
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => normalizeDesktopPopupData(item, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, entry]) => [popupText(key, 80), normalizeDesktopPopupData(entry, depth + 1)]))
}

function normalizeDesktopPopupActions(rawActions) {
  if (!Array.isArray(rawActions)) return []
  return rawActions.slice(0, 4).map((action) => ({
    key: popupText(action?.key, 40),
    label: popupText(action?.label, 80),
    variant: action?.variant === 'danger' ? 'danger' : 'default',
    disabled: action?.disabled === true
  })).filter((action) => action.key && action.label)
}

function normalizeDesktopPopupContext(rawContext = {}) {
  const type = popupText(rawContext?.type, 40)
  if (!DESKTOP_POPUP_TYPES.has(type)) return null
  const context = {
    type,
    theme: rawContext?.theme === 'dark' ? 'dark' : 'gray'
  }
  if (type === 'explore') {
    context.x = Number.isFinite(Number(rawContext?.x)) ? Math.round(Number(rawContext.x)) : 8
    context.y = Number.isFinite(Number(rawContext?.y)) ? Math.round(Number(rawContext.y)) : 8
    return context
  }
  if (type === 'home-context') {
    context.x = Number.isFinite(Number(rawContext?.x)) ? Math.round(Number(rawContext.x)) : 8
    context.y = Number.isFinite(Number(rawContext?.y)) ? Math.round(Number(rawContext.y)) : 8
    return context
  }
  if (type === 'tab-context') {
    const tabId = popupText(rawContext?.tabId)
    if (!tabId) return null
    context.tabId = tabId
    context.x = Number.isFinite(Number(rawContext?.x)) ? Math.round(Number(rawContext.x)) : 8
    context.y = Number.isFinite(Number(rawContext?.y)) ? Math.round(Number(rawContext.y)) : 8
    context.canCloseLeft = rawContext?.canCloseLeft === true
    context.canCloseRight = rawContext?.canCloseRight === true
    return context
  }
  if (type === 'context-menu') {
    const menuType = rawContext?.menuType === 'session' ? 'session' : 'workspace'
    const item = normalizeDesktopPopupItem(rawContext?.item)
    if (!item) return null
    context.menuType = menuType
    context.item = item
    context.x = Number.isFinite(Number(rawContext?.x)) ? Math.round(Number(rawContext.x)) : 8
    context.y = Number.isFinite(Number(rawContext?.y)) ? Math.round(Number(rawContext.y)) : 8
    return context
  }
  if (type === 'rename-session') {
    const item = normalizeDesktopPopupItem(rawContext?.item)
    if (!item?.name || !item?.workspaceHash) return null
    context.item = item
    context.value = popupText(rawContext?.value, 100)
    return context
  }
  const kind = popupText(rawContext?.kind, 40)
  if (!DESKTOP_POPUP_CONFIRM_KINDS.has(kind)) return null
  context.kind = kind
  context.title = popupText(rawContext?.title, 120)
  context.message = popupText(rawContext?.message, 1000)
  context.actions = normalizeDesktopPopupActions(rawContext?.actions)
  context.payload = normalizeDesktopPopupData(rawContext?.payload)
  return context
}

function normalizeDesktopPopupAction(rawAction = {}) {
  const type = popupText(rawAction?.type, 40)
  const action = popupText(rawAction?.action, 60)
  if (!DESKTOP_POPUP_TYPES.has(type) || !DESKTOP_POPUP_ACTIONS.has(action)) return null
  if (type === 'explore') {
    return ['open-skills', 'open-settings', 'open-sub-agents', 'open-tools', 'toggle-theme'].includes(action)
      ? { type, action }
      : null
  }
  if (type === 'home-context') {
    return ['open-requirement-board', 'open-onboarding', 'open-update', 'toggle-theme'].includes(action)
      ? { type, action }
      : null
  }
  if (type === 'tab-context') {
    const tabId = popupText(rawAction?.tabId)
    return tabId && ['reload', 'close', 'close-left', 'close-right'].includes(action)
      ? { type, action, tabId }
      : null
  }
  if (type === 'context-menu') {
    const menuType = rawAction?.menuType === 'session' ? 'session' : 'workspace'
    const allowed = menuType === 'session'
      ? ['rename-session', 'delete-session']
      : ['copy-workspace-path', 'clear-workspace', 'clear-old-sessions', 'delete-workspace']
    const item = normalizeDesktopPopupItem(rawAction?.item)
    return item && allowed.includes(action) ? { type, menuType, action, item } : null
  }
  if (type === 'rename-session') {
    if (action === 'confirm') {
      const currentContext = desktopPopupContext?.type === type ? desktopPopupContext : null
      const item = normalizeDesktopPopupItem(rawAction?.item || currentContext?.item)
      const value = popupText(rawAction?.value || currentContext?.value, 100)
      return item?.name && item?.workspaceHash
        ? { type, action, value, item }
        : null
    }
    return action === 'cancel' ? { type, action } : null
  }
  const currentContext = desktopPopupContext?.type === type ? desktopPopupContext : null
  const kind = popupText(rawAction?.kind || currentContext?.kind, 40)
  if (!DESKTOP_POPUP_CONFIRM_KINDS.has(kind) || !['confirm', 'cancel'].includes(action)) return null
  const payload = rawAction?.payload == null ? currentContext?.payload : rawAction.payload
  return { type, action, kind, payload: normalizeDesktopPopupData(payload) }
}

function resolveDesktopPopupContextWaiter(requestId, entry, painted) {
  const waiter = desktopPopupContextWaiters.get(requestId)
  if (!waiter || (entry && waiter.entry !== entry)) return false
  desktopPopupContextWaiters.delete(requestId)
  clearTimeout(waiter.timeout)
  waiter.resolve(painted)
  return true
}

function cancelDesktopPopupContextWaiters() {
  for (const [requestId, waiter] of desktopPopupContextWaiters) {
    desktopPopupContextWaiters.delete(requestId)
    clearTimeout(waiter.timeout)
    waiter.resolve(false)
  }
}

function waitForDesktopPopupContext(entry, requestId, timeoutMs = 2_000) {
  if (!entry || entry.view.webContents.isDestroyed()) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolveDesktopPopupContextWaiter(requestId, entry, false), timeoutMs)
    desktopPopupContextWaiters.set(requestId, {entry, resolve, timeout})
  })
}

function sendDesktopPopupContext(entry = desktopOverlayManager.get('popup')) {
  if (!entry || entry.view.webContents.isDestroyed() || !desktopPopupContext) return false
  entry.view.webContents.send('desktop-popup-context', {
    ...desktopPopupContext,
    __desktopPopupRequestId: desktopPopupContextRequestId
  })
  return true
}

function hideDesktopPopup({ notify = true, refocus = true } = {}) {
  const hidden = desktopOverlayManager.hide('popup')
  setTitleBarOverlayDimmed(false)
  const type = desktopPopupContext?.type || ''
  const hadContext = Boolean(desktopPopupContext)
  desktopPopupContext = null
  desktopPopupContextRequestId += 1
  cancelDesktopPopupContextWaiters()
  if (!hidden && !hadContext) return false
  if (notify && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-shell-popup-closed', { type })
  }
  if (refocus) refocusDesktopShell()
  return hidden || hadContext
}

async function openDesktopPopupView(rawContext = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const context = normalizeDesktopPopupContext(rawContext)
  if (!context) return false
  cancelDesktopPopupContextWaiters()
  const requestId = ++desktopPopupContextRequestId
  desktopPopupContext = context
  const entry = await desktopOverlayManager.open('popup', {
    query: {
      desktopPopup: '1',
      popupType: context.type,
      theme: context.theme
    },
    backgroundColor: '#00000000',
    show: false
  })
  if (!entry || requestId !== desktopPopupContextRequestId || desktopPopupContext !== context) return false

  const contextPainted = waitForDesktopPopupContext(entry, requestId)
  sendDesktopPopupContext(entry)
  if (!await contextPainted) return false
  if (requestId !== desktopPopupContextRequestId || desktopPopupContext !== context) return false

  const shown = desktopOverlayManager.show('popup')
  if (shown) setTitleBarOverlayDimmed(DESKTOP_POPUP_MODAL_TYPES.has(context.type))
  return shown
}

ipcMain.handle('desktop-popup-open', async (event, rawContext) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop popup request')
  try {
    return { success: await openDesktopPopupView(rawContext) }
  } catch (error) {
    console.error('[desktop-popup] failed to open popup overlay:', error)
    throw error
  }
})

// did-finish-load 可能早于异步 Vue 根组件挂载；由浮层在监听器安装完成后主动
// 握手并补取当前上下文，避免首次打开时丢失 item/payload。
ipcMain.on('desktop-popup-ready', (event) => {
  if (!isDesktopOverlaySender('popup', event.sender) || !desktopPopupContext) return
  sendDesktopPopupContext(desktopOverlayManager.get('popup'))
})

ipcMain.on('desktop-popup-context-ready', (event, requestId) => {
  if (!isDesktopOverlaySender('popup', event.sender) || !Number.isSafeInteger(requestId)) return
  resolveDesktopPopupContextWaiter(requestId, desktopOverlayManager.get('popup'), true)
})

ipcMain.handle('desktop-popup-close', (event) => {
  const overlaySender = isDesktopOverlaySender('popup', event.sender)
  if (event.sender !== mainWindow?.webContents && !overlaySender) throw new Error('Unauthorized desktop popup close')
  hideDesktopPopup()
  return { success: true }
})

function dispatchDesktopPopupAction(event, rawAction) {
  if (!isDesktopOverlaySender('popup', event.sender)) throw new Error('Unauthorized desktop popup action')
  const action = normalizeDesktopPopupAction(rawAction)
  if (!action || !mainWindow || mainWindow.isDestroyed()) return { success: false }
  // 动作事件要先于 popup-closed 到达主窗口；否则确认弹窗的监听器会先清空
  // deleteConfirm.payload，导致“删除”按钮看似点击成功但没有删除目标。
  hideDesktopPopup({notify: false, refocus: false})
  mainWindow.webContents.send('desktop-shell-popup-action', action)
  refocusDesktopShell()
  return { success: true }
}

ipcMain.handle('desktop-popup-action', dispatchDesktopPopupAction)

// 原生 WebContentsView 中的按钮只需要把动作送回主进程，不依赖 invoke 的 Promise
// 生命周期。保留上面的 invoke 通道兼容旧版 preload，同时使用事件通道处理当前浮层。
ipcMain.on('desktop-popup-action-event', (event, rawAction) => {
  try {
    dispatchDesktopPopupAction(event, rawAction)
  } catch (error) {
    console.warn('[desktop-popup] failed to dispatch popup action event:', error.message)
  }
})

ipcMain.on('desktop-popup-close-event', (event) => {
  const overlaySender = isDesktopOverlaySender('popup', event.sender)
  if (event.sender !== mainWindow?.webContents && !overlaySender) {
    console.warn('[desktop-popup] rejected popup close event')
    return
  }
  hideDesktopPopup()
})

// ==================== Desktop Chat Tabs ====================

ipcMain.handle('desktop-chat-tab-create', async (event, rawTab) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tabId = String(rawTab?.id || '').trim()
  const sessionName = String(rawTab?.sessionName || '').trim()
  const sessionTitle = String(rawTab?.sessionTitle || '').trim()
  const workspaceHash = String(rawTab?.workspaceHash || '').trim()
  const theme = rawTab?.theme === 'dark' ? 'dark' : 'gray'
  const newSession = rawTab?.newSession === true
  if (!tabId || !sessionName || tabId.length > 240 || sessionName.length > 240 || workspaceHash.length > 240) {
    throw new Error('Invalid desktop chat tab')
  }
  await getOrCreateDesktopChatTab(tabId, sessionName, workspaceHash, theme, newSession, sessionTitle)
  return { success: true, tabId }
})

ipcMain.handle('desktop-chat-tab-set-loading', (event, tabId, loading) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tab = desktopChatTabs.get(String(tabId || ''))
  if (!tab || tab.view.webContents.isDestroyed()) return { success: false }
  const requestId = ++desktopChatLoadingRequestId
  const waitForPaint = waitForDesktopChatLoadingPaint(tab, requestId)
  const sent = sendDesktopChatTabEvent(tab, 'desktop-chat-tab-global-loading', {
    loading: loading === true,
    requestId
  })
  if (!sent) {
    tab.loadingWaiters.delete(requestId)
    return { success: false }
  }
  return waitForPaint.then(() => ({ success: true }))
})

ipcMain.handle('desktop-chat-tab-show', async (event, tabId, rawBounds) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tab = desktopChatTabs.get(String(tabId || ''))
  if (!tab) throw new Error('Desktop chat tab no longer exists')
  if (tab.ready) await tab.ready
  if (tab.view.webContents.isDestroyed()) throw new Error('Desktop chat tab no longer exists')
  // index.html 的旧启动动画在桌面聊天页被禁用；等 Vue 根组件与会话级
  // Loading 已挂载后再显示新视图，避免旧动画或空白首帧闪现。
  if (!tab.rendererReady && !await waitForDesktopChatReady(tab)) {
    throw new Error('Desktop chat tab did not become ready')
  }
  if (!tab.attached) {
    mainWindow.contentView.addChildView(tab.view)
    tab.attached = true
  }
  tab.view.setBounds(normalizeDesktopChatBounds(rawBounds))
  tab.view.setVisible(true)
  tab.view.webContents.focus()
  sendDesktopChatTabEvent(tab, 'desktop-chat-tab-focus-composer')
  tab.visible = true
  hideDesktopChatViews(tab.id)
  desktopChatActiveTabId = tab.id
  return { success: true }
})

// 侧边栏拖拽从主窗口 renderer 开始，但鼠标移入原生聊天 WebContentsView 后，
// 后续 mousemove 会由聊天 renderer 接收。这里把拖拽生命周期和坐标在两个视图间转发。
ipcMain.handle('desktop-chat-tab-sidebar-resize-start', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop sidebar resize request')
  const tab = desktopChatTabs.get(desktopChatActiveTabId)
  if (!tab || !tab.visible || !tab.rendererReady) return { success: false }
  return { success: sendDesktopChatTabEvent(tab, 'desktop-shell-sidebar-resize-start') }
})

ipcMain.handle('desktop-chat-tab-sidebar-resize-end-request', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop sidebar resize request')
  const tab = desktopChatTabs.get(desktopChatActiveTabId)
  if (tab && tab.visible) sendDesktopChatTabEvent(tab, 'desktop-shell-sidebar-resize-end')
  return { success: true }
})

ipcMain.handle('desktop-chat-tab-hide', async (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  hideDesktopChatViews()
  return { success: true }
})

ipcMain.handle('desktop-chat-tab-close', (event, tabId) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tab = desktopChatTabs.get(String(tabId || ''))
  if (!tab) return { success: true }
  destroyDesktopChatTab(tab)
  return { success: true }
})

ipcMain.handle('desktop-chat-tab-reload', (event, tabId) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tab = desktopChatTabs.get(String(tabId || ''))
  if (!tab) throw new Error('Desktop chat tab no longer exists')
  sendDesktopChatTabEvent(tab, 'desktop-chat-tab-refresh-history')
  return { success: true }
})

ipcMain.handle('desktop-chat-tab-toggle-right-panel', (event, tabId) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tab = desktopChatTabs.get(String(tabId || ''))
  if (!tab) throw new Error('Desktop chat tab no longer exists')
  sendDesktopChatTabEvent(tab, 'desktop-chat-tab-toggle-right-panel')
  return { success: true }
})

ipcMain.handle('desktop-chat-tab-toggle-file-panel', (event, tabId) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tab = desktopChatTabs.get(String(tabId || ''))
  if (!tab) throw new Error('Desktop chat tab no longer exists')
  sendDesktopChatTabEvent(tab, 'desktop-chat-tab-toggle-file-panel')
  return { success: true }
})

ipcMain.handle('desktop-chat-tab-toggle-terminal', (event, tabId) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const tab = desktopChatTabs.get(String(tabId || ''))
  if (!tab) throw new Error('Desktop chat tab no longer exists')
  sendDesktopChatTabEvent(tab, 'desktop-chat-tab-toggle-terminal')
  return { success: true }
})

ipcMain.handle('desktop-chat-tab-set-theme', (event, rawTheme) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop chat tab request')
  const theme = rawTheme === 'dark' ? 'dark' : 'gray'
  for (const tab of desktopChatTabs.values()) sendDesktopChatTabEvent(tab, 'desktop-chat-tab-theme', theme)
  return { success: true }
})

ipcMain.handle('desktop-titlebar-theme', (event, rawTheme) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Unauthorized desktop titlebar request')
  applyTitleBarOverlayTheme(rawTheme)
  return { success: true }
})

ipcMain.on('desktop-chat-tab-ready', (event) => {
  const tab = [...desktopChatTabs.values()].find((item) => item.view.webContents === event.sender)
  if (!tab || tab.view.webContents.isDestroyed()) return
  tab.rendererReady = true
  for (const resolve of tab.readyWaiters.splice(0)) resolve(true)
  for (const [channel, payload] of tab.pendingEvents.splice(0)) {
    tab.view.webContents.send(channel, payload)
  }
})

ipcMain.on('desktop-chat-tab-loading-ready', (event, requestId) => {
  const tab = [...desktopChatTabs.values()].find((item) => item.view.webContents === event.sender)
  if (!tab || !Number.isSafeInteger(requestId)) return
  const resolve = tab.loadingWaiters.get(requestId)
  if (!resolve) return
  tab.loadingWaiters.delete(requestId)
  resolve(true)
})

ipcMain.on('desktop-chat-tab-sidebar-resize-move', (event, payload) => {
  const tab = [...desktopChatTabs.values()].find((item) => item.view.webContents === event.sender)
  if (!tab || tab.id !== desktopChatActiveTabId || !tab.visible || !mainWindow || mainWindow.isDestroyed()) return
  const localClientX = Number(payload?.clientX)
  if (!Number.isFinite(localClientX)) return
  const bounds = tab.view.getBounds()
  mainWindow.webContents.send('desktop-shell-sidebar-resize-move', {clientX: bounds.x + localClientX})
})

ipcMain.on('desktop-chat-tab-sidebar-resize-end', (event) => {
  const tab = [...desktopChatTabs.values()].find((item) => item.view.webContents === event.sender)
  if (!tab || tab.id !== desktopChatActiveTabId || !tab.visible || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop-shell-sidebar-resize-end')
})

ipcMain.on('desktop-chat-tab-report-title', (event, payload) => {
  const tab = [...desktopChatTabs.values()].find((item) => item.view.webContents === event.sender)
  const title = String(payload?.title || '').trim()
  if (!tab || !title || title.length > 120 || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop-chat-tab-title', { tabId: tab.id, title })
})

ipcMain.on('desktop-chat-tab-report-workspace', (event, payload) => {
  const tab = [...desktopChatTabs.values()].find((item) => item.view.webContents === event.sender)
  const workspaceHash = String(payload?.workspaceHash || '')
  if (!tab || !workspaceHash || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop-chat-tab-workspace', { tabId: tab.id, workspaceHash })
})

ipcMain.on('desktop-chat-tab-open-home', (event) => {
  const tab = [...desktopChatTabs.values()].find((item) => item.view.webContents === event.sender)
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop-shell-open-home')
})

ipcMain.on('desktop-chat-tab-open-model-channels', (event) => {
  const tab = [...desktopChatTabs.values()].find((item) => item.view.webContents === event.sender)
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop-shell-open-model-channels')
})

// ==================== AI Browser ====================

function normalizeAiBrowserUrl(rawUrl, allowBlank = false) {
  const value = String(rawUrl || '').trim()
  if (!value) {
    if (allowBlank) return 'about:blank'
    throw new Error('Only HTTP(S) URLs are supported')
  }
  if (allowBlank && /^about:blank$/i.test(value)) return 'about:blank'
  const isLocalHost = /^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(value)
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(value)
  const withScheme = (hasExplicitScheme && !isLocalHost)
    ? value
    : (isLocalHost ? `http://${value}` : `https://${value}`)
  const url = new URL(withScheme)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported')
  return url.href
}

function waitForDesktopChatReady(tab, timeoutMs = 15_000) {
  if (!tab || tab.view.webContents.isDestroyed()) return Promise.resolve(false)
  if (tab.rendererReady) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (ready) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      tab.readyWaiters = tab.readyWaiters.filter((waiter) => waiter !== finish)
      resolve(ready)
    }
    const timeout = setTimeout(() => finish(false), timeoutMs)
    tab.readyWaiters.push(finish)
  })
}

function sendDesktopChatTabEvent(tab, channel, payload) {
  if (!tab) return false
  const wc = tab.view.webContents
  if (!wc || wc.isDestroyed()) return false
  if (!tab.rendererReady) {
    tab.pendingEvents.push([channel, payload])
    return true
  }
  tab.view.webContents.send(channel, payload)
  return true
}

function detachDesktopChatTab(tab) {
  if (!tab) return
  if (tab.attached && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.contentView.removeChildView(tab.view) } catch { /* window may already be closing */ }
  }
  tab.attached = false
}

function waitForDesktopChatLoadingPaint(tab, requestId, timeoutMs = 2_000) {
  if (!tab || tab.view.webContents.isDestroyed()) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const finish = (painted) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      tab.loadingWaiters.delete(requestId)
      resolve(painted)
    }
    const timeout = setTimeout(() => finish(false), timeoutMs)
    tab.loadingWaiters.set(requestId, finish)
  })
}

function destroyDesktopChatTab(tab) {
  if (!tab) return
  for (const resolve of tab.readyWaiters.splice(0)) resolve(false)
  for (const resolve of tab.loadingWaiters.values()) resolve(false)
  tab.loadingWaiters.clear()
  tab.pendingEvents.length = 0
  const wc = tab.view.webContents
  if (wc && !wc.isDestroyed()) tab.view.setVisible(false)
  tab.visible = false
  detachDesktopChatTab(tab)
  if (desktopChatTabs.get(tab.id)?.view === tab.view) desktopChatTabs.delete(tab.id)
  if (desktopChatActiveTabId === tab.id) desktopChatActiveTabId = null
  if (wc && !wc.isDestroyed()) wc.close()
}

function hideDesktopChatViews(exceptTabId = null) {
  const targets = [...desktopChatTabs.values()].filter((tab) => tab.id !== exceptTabId && tab.visible)
  for (const tab of targets) {
    tab.view.setVisible(false)
    tab.visible = false
  }
}

function destroyDesktopChatTabs() {
  for (const tab of [...desktopChatTabs.values()]) destroyDesktopChatTab(tab)
  desktopChatTabs.clear()
  desktopChatActiveTabId = null
}

function normalizeDesktopChatBounds(rawBounds) {
  if (!mainWindow || !rawBounds || typeof rawBounds !== 'object') throw new Error('Invalid desktop chat view bounds')
  const contentBounds = mainWindow.getContentBounds()
  const values = ['x', 'y', 'width', 'height'].map((key) => Math.round(Number(rawBounds[key])))
  if (!values.every(Number.isFinite)) throw new Error('Invalid desktop chat view bounds')
  const x = Math.max(0, Math.min(values[0], contentBounds.width - 1))
  const y = Math.max(0, Math.min(values[1], contentBounds.height - 1))
  return { x, y, width: Math.max(1, Math.min(values[2], contentBounds.width - x)), height: Math.max(1, Math.min(values[3], contentBounds.height - y)) }
}

function waitForDesktopChatLoad(view, load, target) {
  return new Promise((resolve, reject) => {
    let settled = false
    let failure = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const wc = view.webContents
      if (wc && !wc.isDestroyed()) {
        wc.removeListener('destroyed', onDestroyed)
        wc.removeListener('did-fail-load', onFailedLoad)
      }
      callback(value)
    }
    const onDestroyed = () => finish(reject, new Error('Desktop chat tab was destroyed while loading'))
    const onFailedLoad = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) failure = { errorCode, errorDescription, url: validatedURL }
    }
    const timeout = setTimeout(() => finish(reject, new Error(`Timed out loading desktop chat tab: ${target}`)), DESKTOP_CHAT_LOAD_TIMEOUT_MS)
    view.webContents.once('destroyed', onDestroyed)
    view.webContents.on('did-fail-load', onFailedLoad)
    Promise.resolve()
      .then(load)
      .then(() => finish(resolve))
      .catch((error) => {
        const detail = failure ? ` (${failure.errorCode} ${failure.errorDescription}: ${failure.url})` : ''
        finish(reject, new Error(`${error.message || 'Failed to load desktop chat tab'}${detail}`))
      })
  })
}

async function loadDesktopChatTab(view, sessionName, workspaceHash, theme, newSession, sessionTitle = '') {
  const queryParams = {
    desktopChatTab: '1',
    sessionName,
    sessionTitle,
    workspaceHash: workspaceHash || '',
    theme,
    newSession: newSession ? '1' : '0'
  }
  const query = new URLSearchParams(queryParams).toString()
  const rendererPath = path.join(__dirname, '../renderer/index.html')
  const targets = isDev
    ? DESKTOP_CHAT_DEV_RENDERER_ORIGINS.map((origin) => `${origin}/?${query}`)
    : [rendererPath]
  let lastError = null

  for (let attempt = 0; attempt < DESKTOP_CHAT_LOAD_ATTEMPTS; attempt++) {
    const target = targets[Math.min(attempt, targets.length - 1)]
    try {
      if (isDev) {
        await waitForDesktopChatLoad(view, () => view.webContents.loadURL(target), target)
      } else {
        await waitForDesktopChatLoad(view, () => view.webContents.loadFile(target, {
          query: queryParams
        }), target)
      }
      return
    } catch (error) {
      lastError = error
      const wc = view.webContents
      if (!wc || wc.isDestroyed() || attempt === DESKTOP_CHAT_LOAD_ATTEMPTS - 1) break
      const nextTarget = targets[Math.min(attempt + 1, targets.length - 1)]
      console.warn(`[desktop-chat-tab] load failed from ${target}, retrying with ${nextTarget}: ${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, DESKTOP_CHAT_LOAD_RETRY_DELAY_MS))
    }
  }

  throw lastError || new Error('Failed to load desktop chat tab')
}

async function getOrCreateDesktopChatTab(tabId, sessionName, workspaceHash, theme = 'gray', newSession = false, sessionTitle = '') {
  let existing = desktopChatTabs.get(tabId)
  if (existing) {
    const wc = existing.view.webContents
    if (!wc || wc.isDestroyed()) {
      desktopChatTabs.delete(tabId)
      existing = null
    }
  }
  if (existing) {
    if (existing.ready) await existing.ready
    if (sessionTitle && sessionTitle !== existing.sessionTitle) {
      existing.sessionTitle = sessionTitle
      sendDesktopChatTabEvent(existing, 'desktop-chat-tab-session-title', sessionTitle)
    }
    sendDesktopChatTabEvent(existing, 'desktop-chat-tab-theme', theme)
    return existing
  }
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not available')
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  view.setBackgroundColor(theme === 'dark' ? '#141518' : '#ffffff')
  const tab = {
    id: tabId,
    sessionName,
    sessionTitle,
    workspaceHash,
    newSession,
    view,
    attached: false,
    visible: false,
    rendererReady: false,
    readyWaiters: [],
    loadingWaiters: new Map(),
    pendingEvents: [],
    ready: null
  }
  desktopChatTabs.set(tabId, tab)
  view.setVisible(false)
  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  view.webContents.on('did-start-loading', () => {
    tab.rendererReady = false
  })
  view.webContents.on('destroyed', () => {
    for (const resolve of tab.readyWaiters.splice(0)) resolve(false)
    for (const resolve of [...tab.loadingWaiters.values()]) resolve(false)
    tab.loadingWaiters.clear()
    tab.pendingEvents.length = 0
    tab.attached = false
    tab.visible = false
    if (desktopChatTabs.get(tabId)?.view !== view) return
    desktopChatTabs.delete(tabId)
    if (desktopChatActiveTabId === tabId) desktopChatActiveTabId = null
  })

  try {
    // Keep the view attached while it loads so a concurrent show call cannot interrupt navigation.
    mainWindow.contentView.addChildView(view)
    tab.attached = true
    tab.ready = loadDesktopChatTab(view, sessionName, workspaceHash, theme, newSession, sessionTitle)
    await tab.ready
    return tab
  } catch (error) {
    destroyDesktopChatTab(tab)
    throw error
  }
}

async function stopLoopraJavaProcess(pid) {
  if (isWin) {
    await execFileAsync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
  } else {
    process.kill(pid, 'SIGTERM')
  }
}

async function closeOtherLoopraJavaProcesses(keepPort) {
  if (!Number.isSafeInteger(keepPort) || keepPort <= 0) return
  try {
    const processes = await listLoopraJavaProcesses()
    for (const processInfo of processes.filter((item) => isLoopraGuiRuntime(item.commandLine) && item.port !== keepPort)) {
      try {
        await stopLoopraJavaProcess(processInfo.pid)
        console.log(`Closed stale loopra-web process ${processInfo.pid} on port ${processInfo.port || 'unknown'}`)
      } catch (error) {
        console.warn(`Failed to close stale loopra-web process ${processInfo.pid}: ${error.message}`)
      }
    }
  } catch (error) {
    console.warn('Failed to clean up stale loopra-web processes:', error.message)
  }
}

function aiBrowserTabSummary(tab) {
  const contents = tab.view.webContents
  return {
    id: tab.id,
    url: contents.isDestroyed() ? tab.url : (contents.getURL() || tab.url),
    title: tab.title || '新标签页',
    favicon: tab.favicon || null,
    loading: tab.loading,
    canGoBack: !contents.isDestroyed() && contents.canGoBack(),
    canGoForward: !contents.isDestroyed() && contents.canGoForward()
  }
}

function sendAiBrowserState() {
  if (!aiBrowserWindow || aiBrowserWindow.isDestroyed()) return
  aiBrowserWindow.webContents.send('ai-browser-state', {
    activeTabId: aiBrowserActiveTabId,
    tabs: [...aiBrowserTabs.values()].map(aiBrowserTabSummary)
  })
}

function sendAiBrowserActivity(state, message, details = {}) {
  aiBrowserActivity = { state, message, timestamp: Date.now(), ...details }
  if (!aiBrowserWindow || aiBrowserWindow.isDestroyed()) return
  aiBrowserWindow.webContents.send('ai-browser-activity', aiBrowserActivity)
}

function hideAiBrowserViews() {
  for (const tab of aiBrowserTabs.values()) tab.view.setVisible(false)
}

function closeAiBrowserTab(tabId) {
  const tab = aiBrowserTabs.get(tabId)
  if (!tab) return false
  tab.view.setVisible(false)
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  aiBrowserTabs.delete(tabId)
  if (aiBrowserActiveTabId === tabId) aiBrowserActiveTabId = aiBrowserTabs.keys().next().value || null
  return true
}

function destroyAiBrowserTabs() {
  for (const id of [...aiBrowserTabs.keys()]) closeAiBrowserTab(id)
  aiBrowserActiveTabId = null
}

function getAiBrowserTab(tabId) {
  const tab = aiBrowserTabs.get(String(tabId || ''))
  if (!tab) throw new Error(`Unknown browser tab: ${tabId}`)
  return tab
}

async function createAiBrowserTab(rawUrl = 'about:blank') {
  if (aiBrowserTabs.size >= AI_BROWSER_MAX_TABS) {
    throw new Error(`BROWSER_TAB_LIMIT: 已达到 ${AI_BROWSER_MAX_TABS} 个标签页硬上限。请先调用 browser_tabs，关闭不再需要的非活动标签页，再创建新标签页。`)
  }
  const url = normalizeAiBrowserUrl(rawUrl, true)
  const id = `tab-${aiBrowserNextTabId++}`
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'element-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const tab = { id, url, title: '新标签页', favicon: null, loading: false, lastLoadError: null, snapshotVersion: 0, snapshotId: null, view, attached: false }
  aiBrowserTabs.set(id, tab)
  view.setVisible(false)
  view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    createAiBrowserTab(targetUrl)
      .then((newTab) => activateAiBrowserTab(newTab.id))
      .catch((error) => sendAiBrowserActivity('failed', `无法打开新标签页：${error.message}`))
    return { action: 'deny' }
  })
  view.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    tab.title = String(title || '').trim().slice(0, 160) || '新标签页'
    sendAiBrowserState()
  })
  view.webContents.on('page-favicon-updated', (event, favicons) => {
    const favicon = (Array.isArray(favicons) ? favicons : []).find((item) => /^https?:\/\//i.test(item || ''))
    if (favicon && favicon !== tab.favicon) {
      tab.favicon = favicon
      sendAiBrowserState()
    }
  })
  view.webContents.on('did-start-loading', () => {
    tab.loading = true
    sendAiBrowserState()
  })
  view.webContents.on('did-start-navigation', (event, targetUrl, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    tab.loading = true
    tab.lastLoadError = null
    tab.favicon = null
    tab.url = targetUrl || tab.url
    sendAiBrowserState()
  })
  view.webContents.on('did-finish-load', () => {
    tab.loading = false
    tab.lastLoadError = null
    tab.url = view.webContents.getURL() || tab.url
    sendAiBrowserState()
  })
  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    tab.loading = false
    tab.lastLoadError = { errorCode, errorDescription, url: validatedURL || tab.url }
    sendAiBrowserState()
  })
  view.webContents.on('did-stop-loading', () => {
    tab.loading = false
    tab.url = view.webContents.getURL() || tab.url
    sendAiBrowserState()
  })
  view.webContents.on('did-navigate', (event, targetUrl) => {
    tab.url = targetUrl
    sendAiBrowserState()
  })
  view.webContents.on('did-navigate-in-page', (event, targetUrl) => {
    tab.url = targetUrl
    sendAiBrowserState()
  })
  view.webContents.on('destroyed', () => {
    aiBrowserTabs.delete(id)
    if (aiBrowserActiveTabId === id) aiBrowserActiveTabId = aiBrowserTabs.keys().next().value || null
    sendAiBrowserState()
  })
  aiBrowserActiveTabId = id
  sendAiBrowserState()
  if (url !== 'about:blank') {
    try {
      await view.webContents.loadURL(url)
    } catch (error) {
      tab.loading = false
      tab.title = '页面加载失败'
      sendAiBrowserState()
      throw error
    }
  }
  return aiBrowserTabSummary(tab)
}

function activateAiBrowserTab(tabId) {
  getAiBrowserTab(tabId)
  aiBrowserActiveTabId = tabId
  hideAiBrowserViews()
  sendAiBrowserState()
  return { activeTabId: aiBrowserActiveTabId }
}

function openAiBrowserWindow() {
  if (aiBrowserWindow && !aiBrowserWindow.isDestroyed()) {
    aiBrowserWindow.show()
    aiBrowserWindow.focus()
    return aiBrowserWindow
  }
  aiBrowserWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'Loopra AI 浏览器',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  aiBrowserWindow.on('closed', () => {
    destroyAiBrowserTabs()
    aiBrowserWindow = null
  })
  aiBrowserWindow.webContents.on('did-finish-load', async () => {
    if (!aiBrowserTabs.size) {
      try {
        await createAiBrowserTab('about:blank')
      } catch (error) {
        sendAiBrowserActivity('failed', `创建浏览器标签失败：${error.message}`)
      }
    }
    sendAiBrowserState()
    aiBrowserWindow?.webContents.send('ai-browser-activity', aiBrowserActivity)
  })
  if (isDev) {
    aiBrowserWindow.loadURL('http://localhost:3000/?aiBrowser=1')
  } else {
    aiBrowserWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { aiBrowser: '1' } })
  }
  return aiBrowserWindow
}

async function aiBrowserNewTab(rawUrl) {
  if (!aiBrowserWindow || aiBrowserWindow.isDestroyed()) openAiBrowserWindow()
  const tab = await createAiBrowserTab(rawUrl || 'about:blank')
  const tabCount = aiBrowserTabs.size
  const cleanupRecommended = tabCount > AI_BROWSER_TAB_CLEANUP_THRESHOLD
  return {
    tab,
    activeTabId: aiBrowserActiveTabId,
    tabCount,
    cleanupRecommended,
    warning: cleanupRecommended
      ? `当前已有 ${tabCount} 个标签页。请在完成当前步骤后调用 browser_tabs，并关闭不再需要的非活动标签页；达到 ${AI_BROWSER_MAX_TABS} 个后将无法新建。`
      : undefined
  }
}

async function aiBrowserNavigate(tabId, rawUrl) {
  const tab = getAiBrowserTab(tabId)
  const url = normalizeAiBrowserUrl(rawUrl)
  tab.loading = true
  sendAiBrowserState()
  await tab.view.webContents.loadURL(url)
  tab.url = tab.view.webContents.getURL() || url
  return aiBrowserTabSummary(tab)
}

function aiBrowserHistory(tabId, action) {
  const tab = getAiBrowserTab(tabId)
  const contents = tab.view.webContents
  if (action === 'back' && contents.canGoBack()) contents.goBack()
  else if (action === 'forward' && contents.canGoForward()) contents.goForward()
  else if (action === 'reload') contents.reload()
  return aiBrowserTabSummary(tab)
}

function normalizeAiBrowserBounds(rawBounds) {
  if (!aiBrowserWindow || !rawBounds || typeof rawBounds !== 'object') throw new Error('Invalid native view bounds')
  const contentBounds = aiBrowserWindow.getContentBounds()
  const values = ['x', 'y', 'width', 'height'].map((key) => Math.round(Number(rawBounds[key])))
  if (!values.every(Number.isFinite) || values[2] < 1 || values[3] < 1) throw new Error('Invalid native view bounds')
  const x = Math.max(0, Math.min(values[0], contentBounds.width - 1))
  const y = Math.max(0, Math.min(values[1], contentBounds.height - 1))
  return { x, y, width: Math.max(1, Math.min(values[2], contentBounds.width - x)), height: Math.max(1, Math.min(values[3], contentBounds.height - y)) }
}

function waitForAiBrowserPageLoad(tab, timeoutMs = 30_000) {
  const contents = tab.view.webContents
  if (contents.isDestroyed()) return Promise.reject(new Error('Browser tab was closed while loading'))
  if (tab.lastLoadError) {
    return Promise.reject(new Error(`Page load failed: ${tab.lastLoadError.errorDescription} (${tab.lastLoadError.errorCode})`))
  }
  if (!tab.loading && !contents.isLoadingMainFrame()) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      contents.removeListener('did-finish-load', handleFinish)
      contents.removeListener('did-fail-load', handleFailure)
      contents.removeListener('destroyed', handleDestroyed)
    }
    const handleFinish = () => {
      cleanup()
      resolve()
    }
    const handleFailure = (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      cleanup()
      reject(new Error(`Page load failed: ${errorDescription} (${errorCode})`))
    }
    const handleDestroyed = () => {
      cleanup()
      reject(new Error('Browser tab was closed while loading'))
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Page load timed out after ${Math.round(timeoutMs / 1000)} seconds`))
    }, timeoutMs)
    contents.once('did-finish-load', handleFinish)
    contents.on('did-fail-load', handleFailure)
    contents.once('destroyed', handleDestroyed)
  })
}

async function captureAiBrowserScreenshot(tab) {
  let image = await tab.view.webContents.capturePage()
  if (image.getSize().width > AI_BROWSER_SCREENSHOT_MAX_WIDTH) {
    image = image.resize({ width: AI_BROWSER_SCREENSHOT_MAX_WIDTH })
  }
  let png = image.toPNG()
  for (let attempt = 0; png.length > AI_BROWSER_SCREENSHOT_MAX_BYTES && attempt < 4; attempt++) {
    const size = image.getSize()
    if (size.width <= 320 || size.height <= 180) break
    image = image.resize({ width: Math.max(320, Math.floor(size.width * 0.7)) })
    png = image.toPNG()
  }
  if (png.length > AI_BROWSER_SCREENSHOT_MAX_BYTES) {
    throw new Error('Browser screenshot exceeds the 5 MiB visual-context limit')
  }
  return `data:image/png;base64,${png.toString('base64')}`
}

async function aiBrowserSnapshot(tabId) {
  const tab = getAiBrowserTab(tabId)
  if (tab.loading || tab.view.webContents.isLoadingMainFrame()) {
    sendAiBrowserActivity('running', 'AI 正在等待页面加载完成', { method: 'screenshot', tabId: tab.id })
  }
  await waitForAiBrowserPageLoad(tab)
  await tab.view.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const afterPaint = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
      if (document.readyState === 'complete') afterPaint();
      else window.addEventListener('load', afterPaint, { once: true });
    })
  `, true)
  await tab.view.webContents.executeJavaScript(`
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(maxWait);
        clearTimeout(quietWait);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietWait);
        quietWait = setTimeout(finish, 250);
      });
      let quietWait = setTimeout(finish, 250);
      const maxWait = setTimeout(finish, 1500);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    })
  `, true)
  const snapshot = await tab.view.webContents.executeJavaScript(`
    (() => {
      const MAX_NODES = 180;
      const MAX_DEPTH = 7;
      const MAX_ELEMENTS = 120;
      let count = 0;
      let targetIndex = 0;
      const targetIds = new WeakMap();
      const clean = (value, max = 240) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
      const styleCache = new WeakMap();
      const hiddenCache = new WeakMap();
      const styleOf = (el) => {
        let style = styleCache.get(el);
        if (!style) {
          style = getComputedStyle(el);
          styleCache.set(el, style);
        }
        return style;
      };
      const parentOf = (el) => el.parentElement || el.getRootNode?.().host || null;
      const hidden = (el) => {
        if (hiddenCache.has(el)) return hiddenCache.get(el);
        let result = false;
        for (let node = el; node; node = parentOf(node)) {
          const style = styleOf(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || node.getAttribute('aria-hidden') === 'true') {
            result = true;
            break;
          }
        }
        hiddenCache.set(el, result);
        return result;
      };
      const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'SVG', 'PATH']);
      const textEditable = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
      const structuralInteractive = (el) => textEditable(el) || el.matches('a[href],button,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="textbox"],[role="slider"],[role="treeitem"],[onclick],[aria-expanded],[aria-haspopup],[tabindex]:not([tabindex="-1"])');
      const interactive = (el) => structuralInteractive(el) || styleOf(el).cursor === 'pointer';
      const collectElements = (root, result = []) => {
        for (const el of root.querySelectorAll('*')) {
          result.push(el);
          if (el.shadowRoot) collectElements(el.shadowRoot, result);
        }
        return result;
      };
      const allElements = collectElements(document);
      const labelledBy = (el) => clean(String(el.getAttribute('aria-labelledby') || '').split(/\\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' '), 180);
      const labelText = (el) => clean([
        el.getAttribute('aria-label'),
        labelledBy(el),
        ...(el.labels ? Array.from(el.labels).map((label) => label.innerText) : []),
        el.closest('label')?.innerText,
        el.getAttribute('placeholder'),
        el.getAttribute('title'),
        el.getAttribute('alt')
      ].find(Boolean), 180);
      const attrs = (el) => {
        const out = {};
        for (const name of ['aria-label', 'aria-expanded', 'aria-haspopup', 'aria-invalid', 'placeholder', 'title', 'alt', 'role', 'type', 'href']) {
          const value = clean(el.getAttribute(name), 180);
          if (value) out[name] = value;
        }
        if (el instanceof HTMLInputElement && el.type !== 'password' && el.value) out.value = clean(el.value, 120);
        return out;
      };
      const textOf = (el, max = 180) => clean(labelText(el) || el.innerText || el.getAttribute('alt') || el.getAttribute('title'), max);
      const directText = (el) => clean(Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(' '), 180);
      const actionsFor = (el) => textEditable(el)
        ? ['fill', 'press', 'scroll']
        : (el.matches('select') ? ['select', 'scroll'] : ['click', 'scroll']);
      const stateFor = (el) => {
        const state = {};
        const name = labelText(el);
        if (name) state.name = name;
        for (const name of ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled', 'aria-invalid', 'aria-required']) {
          const value = el.getAttribute(name);
          if (value != null) state[name.slice(5)] = value;
        }
        if (textEditable(el)) state.editable = true;
        if (el.isContentEditable) state.contentEditable = true;
        if ('disabled' in el) state.disabled = Boolean(el.disabled);
        if ('required' in el && el.required) state.required = true;
        if (el instanceof HTMLInputElement) {
          state.inputType = el.type;
          if (el.type === 'checkbox' || el.type === 'radio') state.checked = el.checked;
          if (el.type === 'password') state.sensitive = true;
          else if (el.value) state.value = clean(el.value, 120);
        } else if (el instanceof HTMLTextAreaElement && el.value) {
          state.value = clean(el.value, 120);
        } else if (el instanceof HTMLSelectElement) {
          state.value = clean(el.value, 120);
          state.selectedText = clean(el.selectedOptions[0]?.text, 120);
          state.options = Array.from(el.options).slice(0, 30).map((option) => ({ value: clean(option.value, 120), text: clean(option.text, 120), selected: option.selected }));
        }
        return state;
      };
      const closestActionTarget = (el) => {
        for (let node = el; node && node !== document.body; node = parentOf(node)) {
          if (!ignored.has(node.tagName) && !hidden(node) && interactive(node)) return node;
        }
        return null;
      };
      const overlayRole = (el) => /^(dialog|alertdialog|listbox|menu|tree|grid)$/.test(el.getAttribute('role') || '') || el.matches('dialog[open],[aria-modal="true"],[popover]:not([popover="manual"])');
      const overlayOf = (el) => {
        for (let node = el; node && node !== document.body; node = parentOf(node)) if (overlayRole(node)) return node;
        return null;
      };
      const visibleInViewport = (rect) => rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
      const occluded = (el, rect) => {
        if (!visibleInViewport(rect)) return false;
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + Math.min(rect.width / 2, 12)));
        const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + Math.min(rect.height / 2, 12)));
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && hit !== el && !el.contains(hit) && !hit.contains(el));
      };
      const targetIdFor = (el) => {
        let id = targetIds.get(el);
        if (!id) {
          id = 'e' + (++targetIndex);
          targetIds.set(el, id);
          el.setAttribute('data-loopra-ai-id', id);
        }
        return id;
      };
      // IDs are a snapshot-scoped contract. Remove stale IDs before assigning the next set.
      allElements.filter((el) => el.hasAttribute('data-loopra-ai-id')).forEach((el) => el.removeAttribute('data-loopra-ai-id'));
      const depthOf = (el) => {
        let depth = 0;
        for (let node = parentOf(el); node; node = parentOf(node)) depth++;
        return depth;
      };
      const candidateByTarget = new Map();
      for (const source of allElements) {
        if (ignored.has(source.tagName) || hidden(source) || (!interactive(source) && source.children.length > 0)) continue;
        const target = closestActionTarget(source);
        if (!target) continue;
        const rect = target.getBoundingClientRect();
        const text = textOf(source) || textOf(target) || (textEditable(target) ? '可编辑区域' : '');
        if (rect.width < 2 || rect.height < 2 || (!text && !textEditable(target) && !target.matches('select'))) continue;
        const candidate = { el: target, rect, text, overlay: overlayOf(target) };
        const existing = candidateByTarget.get(target);
        if (!existing || (text.length && text.length < existing.text.length)) candidateByTarget.set(target, candidate);
      }
      const candidateElements = [...candidateByTarget.values()]
        .sort((a, b) => {
          const aOverlay = Boolean(a.overlay);
          const bOverlay = Boolean(b.overlay);
          if (aOverlay !== bOverlay) return aOverlay ? -1 : 1;
          const aVisible = visibleInViewport(a.rect);
          const bVisible = visibleInViewport(b.rect);
          if (aVisible !== bVisible) return aVisible ? -1 : 1;
          const aDepth = depthOf(a.el);
          const bDepth = depthOf(b.el);
          if (aDepth !== bDepth) return bDepth - aDepth;
          return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
        });
      const selectedTargets = [];
      for (const item of candidateElements) {
        if (selectedTargets.length >= MAX_ELEMENTS) break;
        // The list is leaf-first. Keep the specific child control and skip its broader wrapper.
        if (selectedTargets.some((existing) => existing.text === item.text && item.el.contains(existing.el))) continue;
        selectedTargets.push(item);
      }
      const elements = selectedTargets.map(({ el, rect, text, overlay }) => ({
        id: targetIdFor(el),
        tag: el.tagName.toLowerCase(),
        text,
        attrs: attrs(el),
        state: stateFor(el),
        actions: actionsFor(el),
        context: overlay ? 'overlay' : (el.closest('main,[role="main"]') ? 'main' : 'page'),
        inViewport: visibleInViewport(rect),
        occluded: occluded(el, rect),
        rect: {
          x: Math.round(rect.left), y: Math.round(rect.top),
          width: Math.round(rect.width), height: Math.round(rect.height)
        }
      }));
      const build = (el, depth) => {
        if (!el || count >= MAX_NODES || depth > MAX_DEPTH || ignored.has(el.tagName) || hidden(el)) return null;
        const children = [];
        for (const child of el.children) {
          const item = build(child, depth + 1);
          if (item) children.push(item);
          if (count >= MAX_NODES) break;
        }
        const id = targetIds.get(el);
        const text = children.length ? directText(el) : textOf(el, 240);
        const semantic = /^(H[1-6]|P|LI|MAIN|ARTICLE|SECTION|NAV|IMG|LABEL|TABLE|TR|TD|TH)$/.test(el.tagName);
        const meaningful = Boolean(id) || children.length > 0 || semantic;
        if (!meaningful || (!text && !id && children.length === 0)) return null;
        if (!id && !semantic && !text && children.length === 1) return children[0];
        const node = { tag: el.tagName.toLowerCase() };
        if (text) node.text = text;
        const nodeAttrs = attrs(el);
        if (Object.keys(nodeAttrs).length) node.attrs = nodeAttrs;
        if (id) {
          node.id = id;
          node.actions = actionsFor(el);
        }
        if (children.length) node.children = children;
        count++;
        return node;
      };
      const body = build(document.body, 0);
      const overlays = allElements.filter((el) => !hidden(el) && overlayRole(el)).slice(0, 8).map((el) => {
        const rect = el.getBoundingClientRect();
        return { role: el.getAttribute('role') || el.tagName.toLowerCase(), text: textOf(el, 220), inViewport: visibleInViewport(rect) };
      });
      const notices = allElements.filter((el) => !hidden(el) && (el.getAttribute('role') === 'alert' || el.hasAttribute('aria-live')))
        .slice(0, 8).map((el) => ({ text: textOf(el, 220), level: el.getAttribute('aria-live') || 'alert' })).filter((notice) => notice.text);
      const sensitiveInputs = allElements.filter((el) => {
        if (!(el instanceof HTMLInputElement)) return false;
        const hint = [el.type, el.name, el.id, el.autocomplete, el.getAttribute('aria-label') || ''].join(' ').toLowerCase();
        return el.type === 'password' || /(captcha|verification|verify|otp|one-time|passcode|password)/.test(hint);
      });
      return {
        title: clean(document.title, 160),
        url: location.href,
        truncated: count >= MAX_NODES,
        nodeCount: count,
        viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), documentWidth: Math.round(document.documentElement.scrollWidth), documentHeight: Math.round(document.documentElement.scrollHeight) },
        overlays,
        notices,
        userActionRequired: sensitiveInputs.length ? { recommended: true, reason: '检测到登录或验证相关输入框，请调用 browser_request_user_action 让用户手动完成。' } : undefined,
        elements,
        html: body || { tag: 'body', text: clean(document.body && document.body.innerText, 240) }
      };
    })()
  `, true)
  const imageUrl = await captureAiBrowserScreenshot(tab)
  tab.snapshotId = `${tab.id}-s${++tab.snapshotVersion}`
  return { tabId: tab.id, snapshotId: tab.snapshotId, imageUrl, imageDetail: 'auto', ...snapshot }
}

async function aiBrowserAct(tabId, targetId, action, value, snapshotId) {
  const tab = getAiBrowserTab(tabId)
  const normalizedTargetId = String(targetId || '').trim().toLowerCase()
  const normalizedAction = String(action || '').trim().toLowerCase()
  if (!/^e\d+$/.test(normalizedTargetId)) throw new Error(`Invalid browser target id: ${targetId || '(empty)'}`)
  if (snapshotId && snapshotId !== tab.snapshotId) throw new Error('Snapshot is stale. Call browser_screenshot again.')
  if (!['click', 'fill', 'select', 'press', 'scroll'].includes(normalizedAction)) throw new Error('Unsupported browser action')
  const result = await tab.view.webContents.executeJavaScript(`
    (() => {
      const id = ${JSON.stringify(normalizedTargetId)};
      const action = ${JSON.stringify(normalizedAction)};
      const value = ${JSON.stringify(value == null ? '' : String(value))};
      const el = document.querySelector('[data-loopra-ai-id="' + id + '"]');
      if (!el) throw new Error('Target no longer exists. Call browser_screenshot again.');
      let style = document.getElementById('__loopra_ai_action_style');
      if (!style) {
        style = document.createElement('style');
        style.id = '__loopra_ai_action_style';
        style.textContent = '[data-loopra-ai-active="true"]{outline:3px solid #0d9488!important;outline-offset:3px!important;box-shadow:0 0 0 6px rgba(13,148,136,.18)!important}#__loopra_ai_action_badge{position:fixed;z-index:2147483647;padding:5px 9px;border-radius:5px;background:#0f766e;color:#fff;font:600 12px system-ui;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.25)}';
        document.documentElement.appendChild(style);
      }
      document.querySelectorAll('[data-loopra-ai-active="true"]').forEach((node) => node.removeAttribute('data-loopra-ai-active'));
      document.getElementById('__loopra_ai_action_badge')?.remove();
      el.setAttribute('data-loopra-ai-active', 'true');
      const rect = el.getBoundingClientRect();
      const badge = document.createElement('div');
      badge.id = '__loopra_ai_action_badge';
      badge.textContent = ({ click: 'AI 点击', fill: 'AI 输入', select: 'AI 选择', press: 'AI 按键', scroll: 'AI 定位' })[action] || 'AI 操作';
      badge.style.left = Math.max(8, Math.min(window.innerWidth - 90, rect.left)) + 'px';
      badge.style.top = Math.max(8, rect.top - 32) + 'px';
      document.documentElement.appendChild(badge);
      setTimeout(() => {
        el.removeAttribute('data-loopra-ai-active');
        badge.remove();
      }, 1600);
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (action === 'scroll') return { action, targetId: id };
      if (action === 'click') { el.click(); return { action, targetId: id }; }
      if (action === 'fill') {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) throw new Error('Target cannot accept text');
        el.focus();
        if (el.isContentEditable) el.textContent = value;
        else {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
          setter.call(el, value);
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { action, targetId: id };
      }
      if (action === 'select') {
        if (!(el instanceof HTMLSelectElement)) throw new Error('Target is not a select element');
        el.value = value;
        if (el.value !== value) throw new Error('Option not found');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { action, targetId: id };
      }
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: value || 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: value || 'Enter', bubbles: true }));
      return { action, targetId: id };
    })()
  `, true)
  return result
}

function readBridgeBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 128 * 1024) reject(new Error('Request body too large'))
    })
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('Invalid JSON body')) }
    })
    request.on('error', reject)
  })
}

function writeBridgeResponse(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

function startAiBrowserBridge() {
  if (aiBrowserBridgeReady) return aiBrowserBridgeReady
  aiBrowserBridgeReady = new Promise((resolve, reject) => {
    aiBrowserBridge = http.createServer(async (request, response) => {
    if (request.socket.remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
      writeBridgeResponse(response, 403, { success: false, error: 'Local requests only' })
      return
    }
    if (request.method === 'GET' && request.url === '/health') {
      writeBridgeResponse(response, 200, { success: true, data: { service: 'loopra-ai-browser' } })
      return
    }
    if (request.method !== 'POST' || !request.url?.startsWith('/browser/')) {
      writeBridgeResponse(response, 404, { success: false, error: 'Not found' })
      return
    }
    try {
      const payload = await readBridgeBody(request)
      const method = request.url.slice('/browser/'.length).split('?')[0]
      const targetTabId = String(payload.tabId || aiBrowserActiveTabId || '')
      const actionLabels = { click: '点击元素', fill: '输入内容', select: '选择选项', press: '发送按键', scroll: '定位元素' }
      const runningMessages = {
        'new-tab': 'AI 正在打开新标签页',
        tabs: 'AI 正在查看标签页',
        navigate: 'AI 正在跳转页面',
        screenshot: 'AI 正在捕获页面快照',
        act: `AI 正在${actionLabels[payload.action] || '操作页面'}`,
        'request-user-action': 'AI 正在请求你手动完成浏览器操作',
        'close-tab': 'AI 正在关闭标签页'
      }
      if (targetTabId && ['navigate', 'screenshot', 'act', 'request-user-action', 'close-tab'].includes(method) && aiBrowserTabs.has(targetTabId)) {
        activateAiBrowserTab(targetTabId)
      }
      if (method === 'request-user-action') {
        const browserWindow = openAiBrowserWindow()
        if (browserWindow.isMinimized()) browserWindow.restore()
        browserWindow.show()
        browserWindow.focus()
      }
      sendAiBrowserActivity('running', runningMessages[method] || 'AI 正在操作浏览器', {
        method,
        tabId: targetTabId || null,
        targetId: payload.targetId || null,
        action: payload.action || null
      })
      let data
      if (method === 'new-tab') data = await aiBrowserNewTab(payload.url)
      else if (method === 'tabs') data = { activeTabId: aiBrowserActiveTabId, tabs: [...aiBrowserTabs.values()].map(aiBrowserTabSummary) }
      else if (method === 'navigate') data = await aiBrowserNavigate(payload.tabId, payload.url)
      else if (method === 'screenshot') data = await aiBrowserSnapshot(payload.tabId || aiBrowserActiveTabId)
      else if (method === 'act') data = await aiBrowserAct(payload.tabId || aiBrowserActiveTabId, payload.targetId, payload.action, payload.value, payload.snapshotId)
      else if (method === 'request-user-action') {
        data = { activeTabId: aiBrowserActiveTabId }
      }
      else if (method === 'close-tab') {
        const closed = closeAiBrowserTab(String(payload.tabId || aiBrowserActiveTabId || ''))
        sendAiBrowserState()
        data = { closed, activeTabId: aiBrowserActiveTabId }
      } else throw new Error('Unknown browser method')
      const completedMessages = {
        'new-tab': 'AI 已打开新标签页',
        tabs: 'AI 已读取标签页列表',
        navigate: 'AI 已完成页面跳转',
        screenshot: 'AI 已捕获页面快照',
        act: `AI 已完成${actionLabels[payload.action] || '页面操作'}`,
        'close-tab': 'AI 已关闭标签页'
      }
      const isUserTakeover = method === 'request-user-action'
      sendAiBrowserActivity(isUserTakeover ? 'waiting' : 'completed', isUserTakeover
        ? `等待你手动完成：${String(payload.message || '请在浏览器中完成操作').slice(0, 180)}`
        : (completedMessages[method] || 'AI 操作已完成'), {
        method,
        tabId: targetTabId || aiBrowserActiveTabId,
        targetId: payload.targetId || null,
        action: payload.action || null
      })
      writeBridgeResponse(response, 200, { success: true, data })
    } catch (error) {
      sendAiBrowserActivity('failed', `AI 操作失败：${error.message || '未知错误'}`)
      writeBridgeResponse(response, 400, { success: false, error: error.message || 'Browser request failed' })
    }
    })

    const listen = (port) => {
      const handleStartError = (error) => {
        if (error.code === 'EADDRINUSE' && port !== 0) {
          console.warn(`[ai-browser] port ${port} is busy; falling back to a dynamic port`)
          listen(0)
          return
        }
        aiBrowserBridge = null
        aiBrowserBridgeReady = null
        aiBrowserBridgeAddress = ''
        reject(error)
      }
      aiBrowserBridge.once('error', handleStartError)
      aiBrowserBridge.listen(port, '127.0.0.1', () => {
        aiBrowserBridge.removeListener('error', handleStartError)
        const address = aiBrowserBridge.address()
        aiBrowserBridgeAddress = `http://127.0.0.1:${address.port}`
        aiBrowserBridge.on('error', (error) => console.error('[ai-browser] local bridge failed:', error.message))
        console.log(`[ai-browser] local bridge listening on ${aiBrowserBridgeAddress}`)
        resolve(aiBrowserBridgeAddress)
      })
    }

    listen(Number.isInteger(AI_BROWSER_BRIDGE_PREFERRED_PORT) && AI_BROWSER_BRIDGE_PREFERRED_PORT > 0
      ? AI_BROWSER_BRIDGE_PREFERRED_PORT
      : 0)
  })
  return aiBrowserBridgeReady
}

function stopAiBrowserBridge() {
  if (aiBrowserBridge) aiBrowserBridge.close()
  aiBrowserBridge = null
  aiBrowserBridgeReady = null
  aiBrowserBridgeAddress = ''
}

ipcMain.handle('open-ai-browser-window', (event) => {
  if (!isDesktopChatSender(event.sender)) throw new Error('Unauthorized browser request')
  openAiBrowserWindow()
  return { success: true }
})

ipcMain.handle('get-ai-browser-bridge-address', async (event) => {
  if (!isDesktopChatSender(event.sender)) throw new Error('Unauthorized browser request')
  await startAiBrowserBridge()
  if (!aiBrowserBridgeAddress) throw new Error('AI browser bridge is not listening')
  return aiBrowserBridgeAddress
})

ipcMain.handle('ai-browser-new-tab', async (event, rawUrl) => {
  if (event.sender !== aiBrowserWindow?.webContents) throw new Error('Unauthorized browser request')
  return aiBrowserNewTab(rawUrl)
})

ipcMain.handle('ai-browser-navigate', async (event, tabId, rawUrl) => {
  if (event.sender !== aiBrowserWindow?.webContents) throw new Error('Unauthorized browser request')
  return aiBrowserNavigate(tabId, rawUrl)
})

ipcMain.handle('ai-browser-history', (event, tabId, action) => {
  if (event.sender !== aiBrowserWindow?.webContents) throw new Error('Unauthorized browser request')
  return aiBrowserHistory(tabId, action)
})

ipcMain.handle('ai-browser-activate-tab', (event, tabId) => {
  if (event.sender !== aiBrowserWindow?.webContents) throw new Error('Unauthorized browser request')
  return activateAiBrowserTab(tabId)
})

ipcMain.handle('ai-browser-close-tab', (event, tabId) => {
  if (event.sender !== aiBrowserWindow?.webContents) throw new Error('Unauthorized browser request')
  const closed = closeAiBrowserTab(tabId)
  sendAiBrowserState()
  return { closed, activeTabId: aiBrowserActiveTabId }
})

ipcMain.handle('ai-browser-get-state', (event) => {
  if (event.sender !== aiBrowserWindow?.webContents) throw new Error('Unauthorized browser request')
  return { activeTabId: aiBrowserActiveTabId, tabs: [...aiBrowserTabs.values()].map(aiBrowserTabSummary) }
})

ipcMain.handle('ai-browser-view-show', (event, tabId, rawBounds) => {
  if (event.sender !== aiBrowserWindow?.webContents) throw new Error('Unauthorized browser request')
  const tab = getAiBrowserTab(tabId)
  if (!tab.attached) {
    aiBrowserWindow.contentView.addChildView(tab.view)
    tab.attached = true
  }
  hideAiBrowserViews()
  tab.view.setBounds(normalizeAiBrowserBounds(rawBounds))
  tab.view.setVisible(true)
  return { success: true }
})

ipcMain.handle('ai-browser-view-hide', (event) => {
  if (event.sender !== aiBrowserWindow?.webContents) throw new Error('Unauthorized browser request')
  hideAiBrowserViews()
  return { success: true }
})

// ==================== Element Inspector ====================

function openElementInspectorWindow(initialUrl = '') {
  if (elementInspectorWindow && !elementInspectorWindow.isDestroyed()) {
    elementInspectorWindow.show()
    elementInspectorWindow.focus()
    if (initialUrl) {
      if (elementInspectorReady) elementInspectorWindow.webContents.send('element-inspector-load-url', initialUrl)
      else elementInspectorPendingUrl = initialUrl
    }
    return elementInspectorWindow
  }

  elementInspectorReady = false
  elementInspectorPendingUrl = initialUrl

  elementInspectorWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 840,
    minHeight: 540,
    title: 'Loopra 元素检查',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  elementInspectorWindow.on('closed', () => {
    if (elementWebView && !elementWebView.webContents.isDestroyed()) elementWebView.webContents.close()
    elementWebView = null
    elementInspectorWindow = null
    elementInspectorReady = false
    elementInspectorPendingUrl = ''
  })
  if (isDev) {
    elementInspectorWindow.loadURL('http://localhost:3000/?elementInspector=1')
  } else {
    elementInspectorWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { elementInspector: '1' } })
  }
  return elementInspectorWindow
}

ipcMain.handle('open-element-inspector-window', (event, rawUrl) => {
  const isMainWindow = event.sender === mainWindow?.webContents
  const isDesktopChatTab = [...desktopChatTabs.values()].some((tab) => tab.view.webContents === event.sender)
  if (!isMainWindow && !isDesktopChatTab) throw new Error('Unauthorized inspector request')
  const url = rawUrl ? validateInspectableUrl(rawUrl) : ''
  openElementInspectorWindow(url)
  return { success: true }
})

// ==================== Requirement Board ====================

function openRequirementBoardWindow() {
  if (requirementBoardWindow && !requirementBoardWindow.isDestroyed()) {
    requirementBoardWindow.show()
    requirementBoardWindow.focus()
    return requirementBoardWindow
  }
  requirementBoardWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'Loopra 需求池',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  requirementBoardWindow.on('closed', () => {
    requirementBoardWindow = null
  })
  if (isDev) {
    requirementBoardWindow.loadURL('http://localhost:3000/?requirementBoard=1')
  } else {
    requirementBoardWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { requirementBoard: '1' } })
  }
  return requirementBoardWindow
}

ipcMain.handle('open-requirement-board-window', (event) => {
  const isMainWindow = event.sender === mainWindow?.webContents
  const isDesktopChatTab = [...desktopChatTabs.values()].some((tab) => tab.view.webContents === event.sender)
  if (!isMainWindow && !isDesktopChatTab) throw new Error('Unauthorized requirement board request')
  openRequirementBoardWindow()
  return { success: true }
})

ipcMain.on('element-inspector-ready', (event) => {
  if (event.sender !== elementInspectorWindow?.webContents) return
  elementInspectorReady = true
  if (!elementInspectorPendingUrl) return
  event.sender.send('element-inspector-load-url', elementInspectorPendingUrl)
  elementInspectorPendingUrl = ''
})

ipcMain.on('element-inspector-send', (event, payload) => {
  const isElementWindow = event.sender === elementInspectorWindow?.webContents
  const isAiBrowserSender = event.sender === aiBrowserWindow?.webContents
  if ((!isElementWindow && !isAiBrowserSender) || !payload || typeof payload !== 'object') return
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow?.focus()
  const activeDesktopTab = desktopChatTabs.get(desktopChatActiveTabId)
  if (activeDesktopTab && !activeDesktopTab.view.webContents.isDestroyed()) {
    activeDesktopTab.view.webContents.send('desktop-chat-tab-element-inspection', payload)
    return
  }
  mainWindow.webContents.send('element-inspector-draft', payload)
})

function getOrCreateElementWebView() {
  if (elementWebView && !elementWebView.webContents.isDestroyed()) return elementWebView

  elementWebView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'element-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  elementWebView.setVisible(false)
  elementWebView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  elementWebView.webContents.on('did-finish-load', () => {
    elementInspectorWindow?.webContents.send('element-webview-loaded', { url: elementWebView.webContents.getURL() })
  })
  elementWebView.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) elementInspectorWindow?.webContents.send('element-webview-failed', { errorCode, errorDescription, url: validatedURL })
  })
  elementWebView.webContents.on('destroyed', () => { elementWebView = null })
  return elementWebView
}

function normalizeElementViewBounds(rawBounds) {
  if (!elementInspectorWindow || !rawBounds || typeof rawBounds !== 'object') throw new Error('Invalid native view bounds')
  const contentBounds = elementInspectorWindow.getContentBounds()
  const values = ['x', 'y', 'width', 'height'].map((key) => Math.round(Number(rawBounds[key])))
  if (!values.every(Number.isFinite) || values[2] < 1 || values[3] < 1) throw new Error('Invalid native view bounds')
  const x = Math.max(0, Math.min(values[0], contentBounds.width - 1))
  const y = Math.max(0, Math.min(values[1], contentBounds.height - 1))
  return {
    x,
    y,
    width: Math.max(1, Math.min(values[2], contentBounds.width - x)),
    height: Math.max(1, Math.min(values[3], contentBounds.height - y))
  }
}

function validateInspectableUrl(rawUrl) {
  const url = new URL(String(rawUrl || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported')
  return url.href
}

ipcMain.handle('element-webview-load', async (event, rawUrl) => {
  if (event.sender !== elementInspectorWindow?.webContents) throw new Error('Unauthorized native view request')
  const view = getOrCreateElementWebView()
  const url = validateInspectableUrl(rawUrl)
  await view.webContents.loadURL(url)
  return { success: true, url }
})

ipcMain.handle('element-webview-show', (event, rawBounds) => {
  if (event.sender !== elementInspectorWindow?.webContents) throw new Error('Unauthorized native view request')
  const view = getOrCreateElementWebView()
  elementInspectorWindow.contentView.addChildView(view)
  view.setBounds(normalizeElementViewBounds(rawBounds))
  view.setVisible(true)
  return { success: true }
})

ipcMain.handle('element-webview-hide', (event) => {
  if (event.sender !== elementInspectorWindow?.webContents) throw new Error('Unauthorized native view request')
  elementWebView?.setVisible(false)
  return { success: true }
})

ipcMain.on('element-inspected', (event, payload) => {
  if (!payload || typeof payload !== 'object') return
  if (event.sender === elementWebView?.webContents) {
    elementInspectorWindow?.webContents.send('element-inspected', payload)
    return
  }
  const isAiBrowserTab = [...aiBrowserTabs.values()].some((tab) => tab.view.webContents === event.sender)
  if (isAiBrowserTab) aiBrowserWindow?.webContents.send('element-inspected', payload)
})

/** 在主窗口的 child frame 中寻找 ElementPanel 的 iframe */
function findIframeFrame(frame) {
  if (!frame || !frame.frames) return null
  // 优先找第一个 loaded 的直接子 frame
  for (const child of frame.frames) {
    if (child.url && child.url !== 'about:blank') {
      return child
    }
  }
  // 没有直接子 frame，递归查找
  for (const child of frame.frames) {
    const found = findIframeFrame(child)
    if (found) return found
  }
  return null
}

/**
 * 注入元素检测脚本到 iframe
 * 利用 Electron 主进程权限，跨域 iframe 也能执行 JS
 */
ipcMain.handle('inspector-inject', async (event) => {
  const isElementWindow = event.sender === elementInspectorWindow?.webContents
  const isAiBrowserSender = event.sender === aiBrowserWindow?.webContents
  if (!isElementWindow && !isAiBrowserSender) throw new Error('Unauthorized inspector request')
  let inspectorTarget = null
  if (isAiBrowserSender) {
    const activeTab = aiBrowserTabs.get(String(aiBrowserActiveTabId || ''))
    inspectorTarget = activeTab?.view?.webContents
    if (!inspectorTarget || inspectorTarget.isDestroyed()) return { success: false, reason: 'no_active_tab' }
    if (!activeTab.url || activeTab.url === 'about:blank') return { success: false, reason: 'no_page' }
  } else {
    if (!elementInspectorWindow) return { success: false, reason: 'no_window' }
    inspectorTarget = elementWebView?.webContents || findIframeFrame(elementInspectorWindow.webContents.mainFrame)
  }
  if (!inspectorTarget) return { success: false, reason: 'no_preview' }

  const code = `
(function(){
  // 已注入则跳过（但允许重新激活）
  if(window.__loopraInspectorInjected) return;
  window.__loopraInspectorInjected = true;

  var oldStyle = document.getElementById('__loopra_elem_style');
  if(oldStyle) oldStyle.remove();

  // ---- 注入高亮样式 ----
  var style = document.createElement('style');
  style.id = '__loopra_elem_style';
  style.textContent = '*.__loopra-highlight{outline:2px dashed #2563eb !important;outline-offset:2px !important;background:rgba(37,99,235,0.08) !important;cursor:crosshair !important}';
  document.head.appendChild(style);

  function report(payload){
    if(window.loopraElementInspector && typeof window.loopraElementInspector.report === 'function'){
      window.loopraElementInspector.report(payload);
    }else if(window.parent){
      window.parent.postMessage(payload, '*');
    }
  }

  // ---- 工具函数：安全序列化值（postMessage 要求可结构化克隆） ----
  function safeProp(v){
    if(v===null||v===undefined) return '';
    var t=typeof v;
    if(t==='string'||t==='number'||t==='boolean') return v;
    if(t==='function') return '\u0192()';
    if(t==='symbol') return v.toString();
    try{ return JSON.parse(JSON.stringify(v)); }catch(e){ return String(v); }
  }

  // ---- 工具函数：提取 Vue 组件信息 ----
  function getVueInfo(el){
    try{
      var vn = el.__vueParentComponent;
      if(vn){
        var type = vn.type;
        var name = typeof type === 'object' ? (type.name || type.__name || type.displayName || 'Anonymous') : '' + type;
        var props = {};
        if(vn.props) for(var k in vn.props){
          if(vn.props.hasOwnProperty(k) && k.indexOf('on')!==0 && k.indexOf('$')!==0)
            props[k] = safeProp(vn.props[k]);
        }
        var children = [];
        try{ if(type.components) children = Object.keys(type.components).filter(function(x){return x!=='Fragment'&&x!=='Teleport'&&x!=='Suspense'}); }catch(e){}
        return {name:name, props:props, file:type.__file||type.__source||'', children:children};
      }
      // 尝试 __vnode
      var vnd = el.__vnode;
      if(vnd && vnd.component){
        var comp = vnd.component, type2 = comp.type;
        var name2 = typeof type2 === 'object' ? (type2.name||type2.__name||type2.displayName||'Anonymous') : ''+type2;
        var props2 = {};
        if(comp.props) for(var k2 in comp.props){ if(k2.indexOf('on')!==0) props2[k2] = safeProp(comp.props[k2]); }
        var children2 = [];
        try{ if(type2.components) children2 = Object.keys(type2.components).filter(function(x){return x!=='Fragment'&&x!=='Teleport'&&x!=='Suspense'}); }catch(e){}
        return {name:name2, props:props2, file:type2.__file||type2.__source||'', children:children2};
      }
    }catch(e){}
    return null;
  }

  // ---- 工具函数：提取元素属性 ----
  function getAttrs(el){
    if(!el||!el.attributes) return [];
    var keep = ['id','class','type','name','value','placeholder','href','src','alt','title','role','for','data-v-','aria-'];
    var r = [];
    for(var i=0;i<el.attributes.length;i++){
      var a=el.attributes[i], n=a.name, v=a.value;
      if(!v&&v!=='') continue;
      if(n==='style'||n==='class') continue;
      if(v.length>50) continue;
      for(var j=0;j<keep.length;j++){ if(n===keep[j]||n.indexOf(keep[j])===0){ r.push({key:n, val:v.length>40?v.substring(0,40)+'\u2026':v}); break; } }
    }
    return r;
  }

  // ---- 工具函数：构建 CSS 选择器 ----
  function getSelector(el){
    var parts=[], cur=el, max=10;
    while(cur&&cur!==document.body&&max-->0){
      var seg=cur.tagName.toLowerCase();
      if(cur.id){ parts.unshift('#'+cur.id); break; }
      if(cur.className&&typeof cur.className==='string'){
        var cls=cur.className.trim().split(/\\s+/).filter(function(c){return c&&c.indexOf('__loopra')!==0&&c!=='active'&&c!=='selected'&&c!=='hover';}).slice(0,2);
        if(cls.length) seg+='.'+cls.join('.');
      }
      var p=cur.parentElement;
      if(p){
        var sib=[].filter.call(p.children,function(s){return s.tagName===cur.tagName;});
        if(sib.length>1){ var idx=sib.indexOf(cur)+1; seg+=':nth-child('+idx+')'; }
      }
      parts.unshift(seg);
      cur=cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ---- 组件路径（向上查找） ----
  function buildCompPath(el, vueInfo){
    var path=[];
    if(vueInfo&&vueInfo.name&&vueInfo.name!=='Anonymous'){
      var cur=el.parentElement;
      while(cur&&cur!==document.body){
        var pinfo=getVueInfo(cur);
        if(pinfo&&pinfo.name!=='Anonymous'&&pinfo.name!=='Transition'&&pinfo.name!=='KeepAlive'&&pinfo.name.indexOf('V')!==0){
          if(path.indexOf(pinfo.name)===-1) path.unshift(pinfo.name);
        }
        cur=cur.parentElement;
      }
      if(path.indexOf(vueInfo.name)===-1) path.push(vueInfo.name);
    }
    return path;
  }

  // ---- 点击元素（具名函数，便于 removeEventListener） ----
  function __loopraClickHandler(e){
    // 仅在设计模式激活时阻止事件
    if(!window.__loopraInspectorInjected) return;
    e.stopPropagation();
    e.preventDefault();
    var el=e.target; if(!el) return;
    try{
      var vueInfo=getVueInfo(el);
      var attrs=getAttrs(el);
      var selector=getSelector(el);
      var text=(el.textContent||'').trim();
      if(text.length>60) text=text.substring(0,60)+'\u2026';
      var path=buildCompPath(el, vueInfo);

      report({
        type:'loopra-element-click',
        tag:el.tagName?el.tagName.toLowerCase():'?',
        text:text,
        selector:selector,
        attrs:attrs,
        id:el.id||'',
        vueComponent:vueInfo,
        path:path,
        children:vueInfo?vueInfo.children:[]
      });
    }catch(pe){
      try{
        report({
          type:'loopra-element-click',
          tag:el.tagName?el.tagName.toLowerCase():'?',
          text:(el.textContent||'').trim().substring(0,60),
          selector:'',
          attrs:[],
          id:el.id||'',
          vueComponent:{name:'\u6dfb\u52a0\u7ec4\u4ef6',props:{},file:'',children:[]},
          path:[],
          children:[]
        });
      }catch(e2){}
    }
  }

  function __loopraMouseoverHandler(e){
    // 仅在设计模式激活时高亮
    if(!window.__loopraInspectorInjected) return;
    try{
      [].forEach.call(document.querySelectorAll('.__loopra-highlight'), function(el){el.classList.remove('__loopra-highlight');});
      e.target.classList.add('__loopra-highlight');
    }catch(ex){}
  }

  function __loopraMouseoutHandler(e){
    // 仅在设计模式激活时移除高亮
    if(!window.__loopraInspectorInjected) return;
    try{ e.target.classList.remove('__loopra-highlight'); }catch(ex){}
  }

  // 存储引用，便于 remove 时精确移除
  window.__loopraHandlers = {
    click: __loopraClickHandler,
    mouseover: __loopraMouseoverHandler,
    mouseout: __loopraMouseoutHandler
  };

  document.addEventListener('click', __loopraClickHandler, true);
  document.addEventListener('mouseover', __loopraMouseoverHandler, true);
  document.addEventListener('mouseout', __loopraMouseoutHandler, true);
})();
`

  try {
    await inspectorTarget.executeJavaScript(code)
    return { success: true }
  } catch (e) {
    return { success: false, reason: e.message }
  }
})

/** 移除 iframe 中的检测脚本 */
ipcMain.handle('inspector-remove', async (event) => {
  const isElementWindow = event.sender === elementInspectorWindow?.webContents
  const isAiBrowserSender = event.sender === aiBrowserWindow?.webContents
  if (!isElementWindow && !isAiBrowserSender) throw new Error('Unauthorized inspector request')
  let inspectorTarget = null
  if (isAiBrowserSender) {
    const activeTab = aiBrowserTabs.get(String(aiBrowserActiveTabId || ''))
    inspectorTarget = activeTab?.view?.webContents
    if (!inspectorTarget || inspectorTarget.isDestroyed()) return { success: false, reason: 'no_active_tab' }
  } else {
    if (!elementInspectorWindow) return { success: false, reason: 'no_window' }
    inspectorTarget = elementWebView?.webContents || findIframeFrame(elementInspectorWindow.webContents.mainFrame)
  }
  if (!inspectorTarget) return { success: false, reason: 'no_preview' }

  try {
    await inspectorTarget.executeJavaScript(`
      (function(){
        // 精确移除事件监听器
        if(window.__loopraHandlers){
          try{document.removeEventListener('click', window.__loopraHandlers.click, true);}catch(e){}
          try{document.removeEventListener('mouseover', window.__loopraHandlers.mouseover, true);}catch(e){}
          try{document.removeEventListener('mouseout', window.__loopraHandlers.mouseout, true);}catch(e){}
          window.__loopraHandlers = null;
        }
        // 清理样式和高亮
        var s=document.getElementById('__loopra_elem_style');
        if(s) s.remove();
        [].forEach.call(document.querySelectorAll('.__loopra-highlight'),function(el){el.classList.remove('__loopra-highlight');});
        window.__loopraInspectorInjected = false;
      })();
    `)
    console.log('[Main] inspector-remove: 成功移除检测脚本')
    return { success: true }
  } catch (e) {
    console.error('[Main] inspector-remove: 移除失败:', e.message)
    return { success: false, reason: e.message }
  }
})

// 打开外部链接
ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url)
    return { success: true }
  } catch (e) {
    console.error('Failed to open external URL:', e)
    return { success: false, error: e.message }
  }
})

// 打开本地文件
ipcMain.handle('open-file', async (event, filePath) => {
  try {
    // 路径验证
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: '无效的文件路径' }
    }
    // 防止路径遍历攻击
    if (filePath.includes('..') || filePath.includes('~')) {
      return { success: false, error: '文件路径包含非法字符' }
    }
    // 确保路径是绝对路径
    const absolutePath = path.resolve(filePath)
    // 检查文件是否存在
    if (!fs.existsSync(absolutePath)) {
      return { success: false, error: '文件不存在' }
    }
    // 检查是否是文件（不是目录）
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile()) {
      return { success: false, error: '路径不是文件' }
    }
    await shell.openPath(absolutePath)
    return { success: true }
  } catch (e) {
    console.error('Failed to open file:', e)
    return { success: false, error: e.message }
  }
})

// 打开本地文件夹（系统原生文件管理器，如 Windows 资源管理器）
ipcMain.handle('open-folder', async (event, folderPath) => {
  try {
    // 路径验证
    if (!folderPath || typeof folderPath !== 'string') {
      return { success: false, error: '无效的文件夹路径' }
    }
    // 防止路径遍历攻击
    if (folderPath.includes('..') || folderPath.includes('~')) {
      return { success: false, error: '文件夹路径包含非法字符' }
    }
    // 确保路径是绝对路径
    const absolutePath = path.resolve(folderPath)
    // 检查文件夹是否存在
    if (!fs.existsSync(absolutePath)) {
      return { success: false, error: '文件夹不存在' }
    }
    // 目录直接打开；文件则打开其所在目录（供“在文件管理器中显示”使用）
    const stat = fs.statSync(absolutePath)
    if (!stat.isDirectory() && !stat.isFile()) {
      return { success: false, error: '路径不是文件夹' }
    }
    await shell.openPath(stat.isDirectory() ? absolutePath : path.dirname(absolutePath))
    return { success: true }
  } catch (e) {
    console.error('Failed to open folder:', e)
    return { success: false, error: e.message }
  }
})

// ── 文件资源管理器（桌面端，直接操作本地文件系统，不接后端 API） ──

const FILE_EXPLORER_WATCH_DELAY = 100

function isIgnoredFileExplorerPath(filename) {
  const firstSegment = String(filename || '').replace(/\\/g, '/').split('/')[0].toLowerCase()
  return firstSegment === '.git' || firstSegment === '.loopra'
}

function closeFileExplorerWatcher(webContentsId) {
  const state = fileExplorerWatchers.get(webContentsId)
  if (!state) return
  clearTimeout(state.timer)
  state.watcher.close()
  state.sender.removeListener('destroyed', state.onDestroyed)
  fileExplorerWatchers.delete(webContentsId)
}

function closeAllFileExplorerWatchers() {
  for (const webContentsId of [...fileExplorerWatchers.keys()]) closeFileExplorerWatcher(webContentsId)
}

// 解析并校验绝对路径（防 `..`/`~` 穿越）
function resolveExplorerPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') throw new Error('无效的路径')
  if (rawPath.includes('..') || rawPath.includes('~')) throw new Error('路径包含非法字符')
  return path.resolve(rawPath)
}

// 校验目录存在
function validateExplorerDir(rawPath) {
  const absolutePath = resolveExplorerPath(rawPath)
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) throw new Error('目录不存在')
  return absolutePath
}

// 校验新建/重命名名称（仅名字，不允许路径分隔符）
function validateExplorerName(rawName) {
  if (!rawName || typeof rawName !== 'string') throw new Error('名称不能为空')
  const name = rawName.trim()
  if (!name || name === '.' || name === '..') throw new Error('名称不能为空')
  if (name.includes('/') || name.includes('\\')) throw new Error('名称不能包含路径分隔符')
  if (name.includes('\u0000')) throw new Error('名称包含非法字符')
  return name
}

// 排序：目录优先，再按名称忽略大小写
function sortExplorerEntries(entries) {
  return entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
}

// 实时监听工作区变化；同一渲染进程只保留一个 watcher，事件在主进程先合并一次。
ipcMain.handle('file-explorer-watch', (event, dirPath) => {
  const webContentsId = event.sender.id
  try {
    const root = validateExplorerDir(dirPath)
    closeFileExplorerWatcher(webContentsId)
    const onDestroyed = () => closeFileExplorerWatcher(webContentsId)
    const state = {watcher: null, timer: null, root, eventType: 'change', relativePath: '', relativePaths: new Set(), sender: event.sender, onDestroyed}
    const notify = () => {
      state.timer = null
      const paths = [...state.relativePaths]
      state.relativePaths.clear()
      if (!event.sender.isDestroyed()) {
        event.sender.send('file-explorer-changed', {
          rootPath: state.root,
          eventType: state.eventType,
          path: state.relativePath,
          paths
        })
      }
    }
    const onChange = (eventType, filename) => {
      if (isIgnoredFileExplorerPath(filename)) return
      state.eventType = eventType
      state.relativePath = filename ? String(filename) : ''
      state.relativePaths.add(state.relativePath)
      clearTimeout(state.timer)
      state.timer = setTimeout(notify, FILE_EXPLORER_WATCH_DELAY)
    }
    try {
      state.watcher = fs.watch(root, {recursive: true, persistent: false}, onChange)
    } catch (error) {
      // Linux 上原生递归监听可能不可用，至少监听工作区根目录。
      state.watcher = fs.watch(root, {persistent: false}, onChange)
    }
    state.watcher.on('error', (error) => {
      console.warn(`File explorer watcher failed for ${root}:`, error.message)
      closeFileExplorerWatcher(webContentsId)
    })
    fileExplorerWatchers.set(webContentsId, state)
    event.sender.once('destroyed', onDestroyed)
    return {success: true}
  } catch (e) {
    closeFileExplorerWatcher(webContentsId)
    return {success: false, error: e.message}
  }
})

ipcMain.handle('file-explorer-unwatch', (event) => {
  closeFileExplorerWatcher(event.sender.id)
  return {success: true}
})

// 列出目录的直接子项
ipcMain.handle('file-explorer-list', (event, dirPath) => {
  try {
    const absolutePath = validateExplorerDir(dirPath)
    const entries = fs.readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      path: path.join(absolutePath, entry.name),
      directory: entry.isDirectory()
    }))
    return { success: true, data: sortExplorerEntries(entries) }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 重命名（仅同目录改名）
ipcMain.handle('file-explorer-rename', (event, payload = {}) => {
  try {
    const { filePath, newName } = payload
    const source = resolveExplorerPath(filePath)
    if (!fs.existsSync(source)) throw new Error('文件或目录不存在')
    const safeName = validateExplorerName(newName)
    const target = path.join(path.dirname(source), safeName)
    const directory = fs.statSync(source).isDirectory()
    if (target !== source) {
      if (fs.existsSync(target)) throw new Error('同名文件或目录已存在')
      fs.renameSync(source, target)
    }
    return { success: true, data: { name: safeName, path: target, directory } }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 删除文件或目录（递归）
ipcMain.handle('file-explorer-delete', (event, filePath) => {
  try {
    const target = resolveExplorerPath(filePath)
    if (!fs.existsSync(target)) throw new Error('文件或目录不存在')
    fs.rmSync(target, { recursive: true, force: true })
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 读取文件内容（预览用，1MB 上限，拒绝二进制）
const FILE_EXPLORER_READ_LIMIT = 1024 * 1024
ipcMain.handle('file-explorer-read', (event, filePath) => {
  try {
    const target = resolveExplorerPath(filePath)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('文件不存在')
    const size = fs.statSync(target).size
    if (size > FILE_EXPLORER_READ_LIMIT) throw new Error(`文件过大（${Math.round(size / 1024)}KB），超过 1MB 预览上限`)
    const content = fs.readFileSync(target, 'utf8')
    if (content.includes('\u0000')) throw new Error('二进制文件无法预览')
    return { success: true, data: content }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 写文件内容（编辑器保存用，10MB 上限）
const FILE_EXPLORER_WRITE_LIMIT = 10 * 1024 * 1024
ipcMain.handle('file-explorer-write', (event, payload = {}) => {
  try {
    const { filePath, content } = payload
    const target = resolveExplorerPath(filePath)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('文件不存在')
    if (typeof content !== 'string') throw new Error('内容无效')
    if (content.length > FILE_EXPLORER_WRITE_LIMIT) throw new Error('内容过大，超过 10MB 保存上限')
    fs.writeFileSync(target, content, 'utf8')
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 搜索工作区文件（文件名/路径关键字，忽略常见大目录，最多 16 层 / 100 条）
const FILE_EXPLORER_IGNORED_DIRS = new Set(['.git', '.loopra', 'node_modules', 'target', 'dist', 'build', '.idea'])
const FILE_EXPLORER_SEARCH_DEPTH = 16
const FILE_EXPLORER_SEARCH_LIMIT = 100
ipcMain.handle('file-explorer-search', (event, payload = {}) => {
  try {
    const { dirPath, keyword } = payload
    const root = validateExplorerDir(dirPath)
    const key = (keyword || '').trim().toLowerCase()
    if (!key) return { success: true, data: [] }
    const results = []
    const stack = [{ dir: root, depth: 0 }]
    while (stack.length > 0 && results.length < FILE_EXPLORER_SEARCH_LIMIT) {
      const { dir, depth } = stack.pop()
      if (depth > FILE_EXPLORER_SEARCH_DEPTH) continue
      let children
      try {
        children = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of children) {
        if (results.length >= FILE_EXPLORER_SEARCH_LIMIT) break
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!FILE_EXPLORER_IGNORED_DIRS.has(entry.name)) stack.push({ dir: full, depth: depth + 1 })
        } else if (entry.name.toLowerCase().includes(key)) {
          results.push({ name: entry.name, path: full, directory: false })
        }
      }
    }
    return { success: true, data: results }
  } catch (e) {
    return { success: false, error: e.message }
  }
})
