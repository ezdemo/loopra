// Ported from the legacy src/utils/updateScripts.js + src/utils/constants.js so
// the web About page can render the same update commands and auto-update prompt.

export const GITEE_HOME_URL = 'https://gitee.com/ezdemo/loopra';
export const GITHUB_HOME_URL = 'https://github.com/ezdemo/loopra';
export const RELEASE_LATEST_URL = 'https://github.com/ezdemo/loopra-release/releases/latest';
export const RELEASES_URL = 'https://github.com/ezdemo/loopra-release/releases';

export type MirrorSource = { value: string; label: string };

// GitHub 下载镜像（gh-proxy 加速）。与旧前端保持同一份列表。
export const MIRROR_SOURCES: MirrorSource[] = [
  { value: 'https://gh-proxy.org/', label: 'gh-proxy.org' },
  { value: 'https://github.boki.moe/', label: 'github.boki.moe' },
  { value: 'https://wget.la/', label: 'wget.la' },
  { value: 'https://gh.monlor.com/', label: 'gh.monlor.com' },
  { value: 'https://fastgit.cc/', label: 'fastgit.cc' },
  { value: 'https://ghproxy.net/', label: 'ghproxy.net' },
  { value: 'https://ghfast.top/', label: 'ghfast.top' },
  { value: 'https://gh-proxy.com/', label: 'gh-proxy.com' },
  { value: 'https://down.npee.cn/', label: 'down.npee.cn' },
  { value: 'https://ghproxy.vip/', label: 'ghproxy.vip' },
];

export const UPDATE_SOURCE_NORMAL = 'normal';
export const UPDATE_SOURCE_MIRROR = 'mirror';

const STORAGE_KEY = 'loopra.updateSource';

export function isMirrorSource(source: string) {
  return source === UPDATE_SOURCE_MIRROR || MIRROR_SOURCES.some(mirror => mirror.value === source);
}

export function loadUpdateSource() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === UPDATE_SOURCE_NORMAL || value === UPDATE_SOURCE_MIRROR) return value;
    if (value && MIRROR_SOURCES.some(mirror => mirror.value === value)) return value;
  } catch { /* localStorage 不可用时忽略 */ }
  return UPDATE_SOURCE_NORMAL;
}

export function saveUpdateSource(source: string) {
  try {
    if (source === UPDATE_SOURCE_NORMAL) localStorage.removeItem(STORAGE_KEY);
    else if (isMirrorSource(source)) localStorage.setItem(STORAGE_KEY, source);
  } catch { /* localStorage 不可用时忽略 */ }
}

const SCRIPT_BASE = 'https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release';

export function updateScriptName(source: string, electron: boolean, ext: string) {
  const gui = electron ? '-gui' : '';
  const mirror = isMirrorSource(source) ? '-mirror' : '';
  return `setup${gui}${mirror}.${ext}`;
}

// 构建当前平台的更新命令（Windows PowerShell / macOS·Linux bash）。
export function buildUpdateCommand(source: string, electron = false) {
  const windowsScript = updateScriptName(source, electron, 'ps1');
  const unixScript = updateScriptName(source, electron, 'sh');
  const mirrorUrl = isMirrorSource(source) && source !== UPDATE_SOURCE_MIRROR ? source.replace(/\/+$/, '') : '';
  const scriptBase = isMirrorSource(source) ? `${mirrorUrl || 'https://gh-proxy.org'}/${SCRIPT_BASE}` : SCRIPT_BASE;
  const envWin = mirrorUrl ? `$env:LOOPRA_MIRROR='${mirrorUrl}'; ` : '';
  const envUnix = mirrorUrl ? `export LOOPRA_MIRROR='${mirrorUrl}'; ` : '';
  return {
    windows: `${envWin}irm ${scriptBase}/${windowsScript} | iex`,
    windowsLabel: `${envWin ? '$env:LOOPRA_MIRROR=…; ' : ''}irm ...${windowsScript} | iex`,
    unix: `${envUnix}curl -fsSL ${scriptBase}/${unixScript} | bash`,
    unixLabel: `${envUnix ? 'export LOOPRA_MIRROR=…; ' : ''}curl ...${unixScript} | bash`,
  };
}

// 构建发给 Agent 的自动更新指令（Web 端「更新核心服务」新建会话后发送）。
export function buildUpdatePrompt(source: string, electron = false) {
  const commands = buildUpdateCommand(source, electron);
  const sourceDesc = source === UPDATE_SOURCE_NORMAL
    ? 'GitHub 直连'
    : source === UPDATE_SOURCE_MIRROR ? '镜像（脚本默认 gh-proxy）' : `镜像（${source}）`;
  if (electron) {
    return `请帮我执行 Loopra 桌面端自动更新。请使用当前操作系统对应的桌面运行时更新脚本，下载源为${sourceDesc}：\n\n- Windows 系统：在 PowerShell 中运行 \`${commands.windows}\`\n- macOS / Linux 系统：在终端中运行 \`${commands.unix}\`\n\n桌面运行时必须安装到 ~/.loopra-gui，配置继续使用 ~/.loopra。执行完成后请报告结果。`;
  }
  return `请帮我执行 Loopra 自动更新。根据当前操作系统平台，选择并运行对应的更新脚本，下载源为${sourceDesc}：\n\n- Windows 系统：在 PowerShell 中运行 \`${commands.windows}\`\n- macOS / Linux 系统：在终端中运行 \`${commands.unix}\`\n\n请先判断当前系统平台，然后执行对应的脚本。执行完成后请报告结果。`;
}

// 语义化版本比较：a > b 返回正数，a < b 返回负数，相等返回 0。
export function compareVersions(a: string, b: string) {
  const partA = String(a).split('.').map(value => parseInt(value.replace(/^[vV]/, ''), 10) || 0);
  const partB = String(b).split('.').map(value => parseInt(value.replace(/^[vV]/, ''), 10) || 0);
  for (let index = 0; index < Math.max(partA.length, partB.length); index++) {
    const left = partA[index] || 0;
    const right = partB[index] || 0;
    if (left !== right) return left - right;
  }
  return 0;
}
