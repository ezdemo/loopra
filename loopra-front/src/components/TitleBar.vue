<template>
  <header class="titlebar" @dblclick="toggleMaximize">
    <!-- 左侧：侧边栏切换 + Logo + 会话名 -->
    <div class="titlebar-left">
      <button class="tb-btn sidebar-toggle" @click="$emit('toggleSide')" @dblclick.stop :class="{ active: sideOn }" title="切换侧边栏">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <line x1="9" y1="3" x2="9" y2="21"/>
        </svg>
      </button>

      <div class="tb-brand">
        <img src="../assets/logo.svg" alt="Loopra Logo" class="titlebar-logo-img" />
        <span class="tb-brand-name">Loopra</span>
        <span class="tb-version" :class="{ 'has-update': hasNewVersion }" @click.stop="$emit('showUpdate')" :title="hasNewVersion ? '有新版本可用，点击查看' : ''">
          <template v-if="version && version !== '未知版本'">v{{ version }}</template>
          <template v-else-if="!version">loading...</template>
          <template v-else>未知版本</template>
          <span v-if="hasNewVersion" class="tb-version-dot"></span>
        </span>
      </div>

      <div v-if="session" class="tb-breadcrumb">
        <span v-if="workspaceName" class="tb-monogram" :class="badgeTone(workspaceName)">{{ initial(workspaceName) }}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span class="tb-session">{{ session }}</span>
      </div>
      <div class="tb-community" aria-label="开源主页">
        <a :href="GITEE_HOME_URL" @click.prevent="openExternal(GITEE_HOME_URL)" class="tb-btn star-btn" title="Gitee 上给我们点个 Star 吧">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.984 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.016 0zm6.09 5.333c.328 0 .593.266.592.593v1.482a.594.594 0 0 1-.593.592H9.777c-.982 0-1.778.796-1.778 1.778v5.63c0 .327.266.592.593.592h5.63c.982 0 1.778-.796 1.778-1.778v-.296a.593.593 0 0 0-.592-.593h-4.15a.592.592 0 0 1-.592-.592v-1.482a.593.593 0 0 1 .593-.592h6.815c.327 0 .593.265.593.592v3.408a4 4 0 0 1-4 4H5.926a.593.593 0 0 1-.593-.593V9.778a4.444 4.444 0 0 1 4.445-4.444h8.296Z"/>
          </svg>
        </a>
        <a href="https://github.com/ezdemo/loopra" @click.prevent="openExternal('https://github.com/ezdemo/loopra')" class="tb-btn star-btn" title="GitHub 上给我们点个 Star 吧">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
          </svg>
        </a>
        <ServiceProcessManager v-if="isDesktop" />
      </div>
    </div>

    <!-- 右侧：操作按钮 + 窗口控制 -->
    <div class="titlebar-right">
      <button v-if="isDesktop" class="tb-btn" title="元素检查" @click.stop="$emit('toggleElement')" @dblclick.stop :class="{ active: elementOn }">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </button>

      <button class="tb-btn" :class="{ active: gitOn }" :disabled="!hasSession" @click.stop="hasSession && $emit('toggleGit')" @dblclick.stop title="面板">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <line x1="15" y1="3" x2="15" y2="21"/>
        </svg>
      </button>

      <template v-if="isDesktop">
        <!-- 分隔线 -->
        <div class="tb-sep"></div>

        <!-- 窗口控制按钮 -->
        <button class="tb-win-btn minimize" @click.stop="minimize" @dblclick.stop title="最小化">
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor"/>
          </svg>
        </button>
        <button class="tb-win-btn maximize" @click.stop="toggleMaximize" @dblclick.stop :title="isMaximized ? '还原' : '最大化'">
          <!-- 还原图标 -->
          <svg v-if="isMaximized" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="2.5" y="0.5" width="9" height="9" rx="1"/>
            <rect x="0.5" y="2.5" width="9" height="9" rx="1" fill="var(--bg)" stroke="currentColor"/>
          </svg>
          <!-- 最大化图标 -->
          <svg v-else width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="0.5" y="0.5" width="11" height="11" rx="1.5"/>
          </svg>
        </button>
        <button class="tb-win-btn close" @click.stop="closeWindow" @dblclick.stop title="关闭">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <line x1="1" y1="1" x2="11" y2="11"/>
            <line x1="11" y1="1" x2="1" y2="11"/>
          </svg>
        </button>
      </template>
    </div>
  </header>
</template>

<script setup>
import {onMounted, ref} from 'vue'
import {platform} from '@/services/platform'
import {GITEE_HOME_URL} from '@/utils/constants'
import ServiceProcessManager from './ServiceProcessManager.vue'

defineProps({
  session: { type: String, default: '' },
  workspaceName: { type: String, default: '' },
  sideOn: { type: Boolean, default: true },
  hasMessages: { type: Boolean, default: false },
  hasSession: { type: Boolean, default: false },
  gitOn: { type: Boolean, default: false },
  elementOn: { type: Boolean, default: false },
  version: { type: String, default: '' },
  hasNewVersion: { type: Boolean, default: false }
})

defineEmits(['toggleSide', 'openSettings', 'clear', 'export', 'toggleGit', 'toggleElement', 'showUpdate'])

const isMaximized = ref(false)
const isDesktop = ref(false)

onMounted(async () => {
  try {
    isMaximized.value = await platform.implementation.window.isMaximized()
    isDesktop.value = platform.isElectron
  } catch {
    // 非桌面环境（浏览器），静默忽略
  }
})

const openExternal = async (url) => {
  if (platform.isElectron) {
    // 桌面环境：尝试使用 electronAPI 打开外部链接
    if (window.electronAPI && window.electronAPI.openExternal) {
      await window.electronAPI.openExternal(url)
    } else {
      // 回退：使用 window.open，希望 Electron 能在默认浏览器中打开
      window.open(url, '_system')
    }
  } else {
    // 非桌面环境：使用 window.open
    window.open(url, '_blank')
  }
}

const minimize = async () => {
  try {
    await platform.implementation.window.minimize()
  } catch (e) {
    console.warn('[TitleBar] Failed to minimize:', e)
  }
}

const toggleMaximize = async () => {
  try {
    await platform.implementation.window.maximize()
    isMaximized.value = !isMaximized.value
  } catch (e) {
    console.warn('[TitleBar] Failed to toggle maximize:', e)
  }
}

const closeWindow = async () => {
  try {
    await platform.implementation.window.close()
  } catch (e) {
    console.warn('[TitleBar] Failed to close window:', e)
    // 浏览器环境：尝试关闭标签页
    window.close()
  }
}

// 项目图标：首字符 + 色调
const initial = (name) => String(name || 'L').trim().charAt(0).toUpperCase() || 'L'
const badgeTone = (name) => {
  let hash = 0
  for (const char of String(name || '')) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
  return `tone-${hash % 8}`
}
</script>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 46px;
  min-height: 46px;
  padding: 0 8px 0 10px;
  background: var(--bg);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  border-bottom: 1px solid var(--glass-border);
  border-radius: 0;
  user-select: none;
  -webkit-app-region: drag;
  z-index: 200;
}

/* ── 左侧 ── */
.titlebar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tb-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  color: var(--fg-3);
  transition: all var(--t);
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}
.tb-btn:hover {
  background: var(--bg-3);
  color: var(--fg);
}
.tb-btn:disabled {
  opacity: 0.35;
  pointer-events: none;
}
.tb-btn.active {
  background: var(--accent-bg);
  color: var(--accent);
}

.sidebar-toggle.active {
  background: var(--bg-3);
  color: var(--fg);
}

.tb-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-right: 10px;
  border-right: 1px solid var(--border);
  flex-shrink: 0;
}

.titlebar-logo-img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.tb-brand-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--fg);
  letter-spacing: 0;
}

.tb-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 30px;
  margin-left: 0;
  padding: 0 9px 0 5px;
  border-radius: 5px;
  background: var(--bg-2);
}
.tb-breadcrumb svg {
  color: var(--fg-4);
  flex-shrink: 0;
  opacity: 0.7;
}
.tb-monogram {
  width: 17px;
  height: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border-radius: 4px;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  text-shadow: 0 1px rgba(0, 0, 0, 0.25);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.25), 0 1px 1px rgba(0, 0, 0, 0.16);
}
.tb-monogram.tone-0 { background: linear-gradient(135deg, #8b95a3, #5e6878); }
.tb-monogram.tone-1 { background: linear-gradient(135deg, #3dd0e8, #18b4d0); }
.tb-monogram.tone-2 { background: linear-gradient(135deg, #ffa86b, #ff7a3d); }
.tb-monogram.tone-3 { background: linear-gradient(135deg, #9aacf5, #6d80e8); }
.tb-monogram.tone-4 { background: linear-gradient(135deg, #6dd49d, #3eb878); }
.tb-monogram.tone-5 { background: linear-gradient(135deg, #f87fb5, #e85a9c); }
.tb-monogram.tone-6 { background: linear-gradient(135deg, #fcd34d, #f5b800); }
.tb-monogram.tone-7 { background: linear-gradient(135deg, #4dd9a6, #20c084); }
.tb-session {
  font-size: 13px;
  color: var(--fg-2);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}

.tb-community {
  display: flex;
  align-items: center;
  gap: 1px;
  margin-left: 2px;
  padding-left: 6px;
  border-left: 1px solid var(--border);
}

/* ── 右侧 ── */
.titlebar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.tb-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
}

/* ── 窗口控制按钮 ── */
.tb-win-btn {
  width: 40px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  color: var(--fg-3);
  transition: all 80ms ease;
  -webkit-app-region: no-drag;
}

.tb-win-btn.minimize:hover,
.tb-win-btn.maximize:hover {
  background: var(--bg-3);
  color: var(--fg);
}

.tb-win-btn.close:hover {
  background: #e81123;
  color: #fff;
}

/* ── 响应式 ── */
@media (max-width: 768px) {
  .titlebar {
    height: 38px;
    min-height: 38px;
  }
  .tb-breadcrumb {
    display: none;
  }
  .tb-brand-name {
    display: none;
  }
  .tb-win-btn {
    width: 32px;
  }
}

/* 深色模式微调 */
[data-theme="dark"] .titlebar {
  background: var(--glass-bg-2);
  border-color: var(--glass-border);
}

[data-theme="dark"] .tb-win-btn.close:hover {
  background: #c42b1c;
}

/* 版本号 */
.tb-version {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-4);
  margin-left: 2px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: all var(--t);
  position: relative;
  -webkit-app-region: no-drag;
  user-select: none;
}

.tb-version:hover {
  color: var(--accent);
  background: var(--bg-3);
}

.tb-version.has-update {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.tb-version.has-update:hover {
  background: rgba(239, 68, 68, 0.2);
}

.tb-version-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  background: #ef4444;
  border-radius: 50%;
  animation: tb-version-pulse 1.5s ease-in-out infinite;
}

@keyframes tb-version-pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(1.3);
  }
}

@media (max-width: 768px) {
  .tb-version {
    display: none;
  }
}

a.tb-btn {
  text-decoration: none;
}

.star-btn:hover {
  color: var(--fg);
  background: var(--bg-3);
}
</style>
