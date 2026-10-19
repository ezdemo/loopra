// 更新源选择：直连（GitHub 官方发布） / 镜像（gh-proxy 加速下载）
// 镜像脚本与安装包仍从 GitHub 下载，但经由镜像代理，国内网络更快。
// source 取值：'normal'（直连） | 'mirror'（旧镜像开关，脚本内默认镜像） | 具体镜像 URL（如 https://gh-proxy.org/）
import {MIRROR_SOURCES} from './mirrors'

export const UPDATE_SOURCE_NORMAL = 'normal'
export const UPDATE_SOURCE_MIRROR = 'mirror'

const STORAGE_KEY = 'loopra.updateSource'

// 判断是否为合法镜像值（'mirror' 或列表内镜像 URL）
export function isMirrorSource(source) {
  return source === UPDATE_SOURCE_MIRROR || (typeof source === 'string' && MIRROR_SOURCES.some((m) => m.value === source))
}

// 读取持久化的更新源（默认直连）
export function loadUpdateSource() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === UPDATE_SOURCE_NORMAL || value === UPDATE_SOURCE_MIRROR) return value
    if (value && MIRROR_SOURCES.some((m) => m.value === value)) return value
  } catch { /* ignore */ }
  return UPDATE_SOURCE_NORMAL
}

// 持久化更新源选择（'normal' 清除；'mirror' 或列表内镜像 URL 保存）
export function saveUpdateSource(source) {
  try {
    if (source === UPDATE_SOURCE_NORMAL) {
      localStorage.removeItem(STORAGE_KEY)
    } else if (isMirrorSource(source)) {
      localStorage.setItem(STORAGE_KEY, source)
    }
  } catch { /* localStorage 不可用时忽略 */ }
}

// 脚本发布前缀（脚本本体从独立发版仓库 raw 拉取，脚本内部再从对应源下载安装包）
const SCRIPT_BASE = 'https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release'

// 生成更新脚本文件名，例如：setup.ps1 / setup-mirror.sh / setup-gui.ps1 / setup-gui-mirror.sh
export function updateScriptName(source, isElectron, ext) {
  const gui = isElectron ? '-gui' : ''
  const mirror = isMirrorSource(source) ? '-mirror' : ''
  return `setup${gui}${mirror}.${ext}`
}

// 构建当前平台的更新命令（Windows PowerShell / macOS·Linux bash）
// source 为具体镜像 URL 时，通过 LOOPRA_MIRROR 环境变量把用户选择的镜像传给脚本
export function buildUpdateCommand(source, isElectron) {
  const windowsScript = updateScriptName(source, isElectron, 'ps1')
  const unixScript = updateScriptName(source, isElectron, 'sh')
  const mirrorUrl = isMirrorSource(source) && source !== UPDATE_SOURCE_MIRROR ? source.replace(/\/+$/, '') : ''
  const scriptBase = isMirrorSource(source) ? `${mirrorUrl || 'https://gh-proxy.org'}/${SCRIPT_BASE}` : SCRIPT_BASE
  const envWin = mirrorUrl ? `$env:LOOPRA_MIRROR='${mirrorUrl}'; ` : ''
  const envUnix = mirrorUrl ? `export LOOPRA_MIRROR='${mirrorUrl}'; ` : ''
  return {
    windows: `${envWin}irm ${scriptBase}/${windowsScript} | iex`,
    windowsLabel: `${envWin ? '$env:LOOPRA_MIRROR=…; ' : ''}irm ...${windowsScript} | iex`,
    unix: `${envUnix}curl -fsSL ${scriptBase}/${unixScript} | bash`,
    unixLabel: `${envUnix ? 'export LOOPRA_MIRROR=…; ' : ''}curl ...${unixScript} | bash`
  }
}

// 构建发给 Agent 的自动更新指令（聊天框更新逻辑共用：新建会话后由 Agent 执行脚本）
export function buildUpdatePrompt(source, isElectron) {
  const commands = buildUpdateCommand(source, isElectron)
  const sourceDesc = source === UPDATE_SOURCE_NORMAL
    ? 'GitHub 直连'
    : (source === UPDATE_SOURCE_MIRROR ? '镜像（脚本默认 gh-proxy）' : `镜像（${source}）`)
  if (isElectron) {
    return `请帮我执行 Loopra 桌面端自动更新。请使用当前操作系统对应的桌面运行时更新脚本，下载源为${sourceDesc}：\n\n- Windows 系统：在 PowerShell 中运行 \`${commands.windows}\`\n- macOS / Linux 系统：在终端中运行 \`${commands.unix}\`\n\n桌面运行时必须安装到 ~/.loopra-gui，配置继续使用 ~/.loopra。执行完成后请报告结果。`
  }
  return `请帮我执行 Loopra 自动更新。根据当前操作系统平台，选择并运行对应的更新脚本，下载源为${sourceDesc}：\n\n- Windows 系统：在 PowerShell 中运行 \`${commands.windows}\`\n- macOS / Linux 系统：在终端中运行 \`${commands.unix}\`\n\n请先判断当前系统平台，然后执行对应的脚本。执行完成后请报告结果。`
}
