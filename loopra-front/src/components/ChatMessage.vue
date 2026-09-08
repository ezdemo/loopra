<template>
  <div ref="msgRef" class="msg" :class="msg.role" :data-msg-idx="idx">
    <!-- 用户消息 -->
    <template v-if="msg.role === 'user'">
      <div v-if="isCompactedSummary" class="msg-body compacted-body">
        <div class="compacted-summary">
          <div class="compacted-summary-head">
            <svg class="compacted-summary-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h10"/>
            </svg>
            <span class="compacted-summary-title">较早对话已压缩</span>
            <button class="compacted-summary-btn" type="button" @click="compactedExpanded = !compactedExpanded">
              {{ compactedExpanded ? '收起摘要' : '查看摘要' }}
            </button>
            <button class="compacted-summary-btn primary" type="button" @click="$emit('viewRawEvents', msg)">
              查看原始记录
            </button>
          </div>
          <CollapseTransition>
            <div v-if="compactedExpanded" class="compacted-summary-content">{{ compactedCheckpoint }}</div>
          </CollapseTransition>
        </div>
        <div class="msg-footer">
          <span class="msg-time">{{ msg.time }}</span>
        </div>
      </div>
      <div v-if="!isCompactedSummary" class="msg-body user-body">
        <div v-if="userCollapsedBlock" class="user-auto-message">
          <button class="user-auto-message-trigger" type="button" :aria-expanded="userAutoMessageExpanded"
                  @click="userAutoMessageExpanded = !userAutoMessageExpanded">
            <span class="user-auto-message-title">附加上下文</span>
            <svg class="user-auto-message-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <CollapseTransition>
            <div v-if="userAutoMessageExpanded" class="user-auto-message-detail">
              <div class="user-auto-message-content">{{ userCollapsedBlock }}</div>
            </div>
          </CollapseTransition>
        </div>
        <div v-if="userDisplayText" class="msg-text">{{ userDisplayText }}</div>
        <button v-if="isUserLong" class="user-expand-btn" @click="userExpanded = !userExpanded">
          {{ userExpanded ? '收起' : '展开全部' }}
        </button>
        <div v-if="msg.images && msg.images.length > 0" class="user-images">
          <button v-for="(img, i) in msg.images" :key="i" type="button" class="user-image-button" :aria-label="`预览图片 ${i + 1}`" @click="$emit('previewImage', img)">
            <img :src="img" :alt="`图片 ${i + 1}`" class="user-image"/>
          </button>
        </div>
        <div class="msg-footer">
          <span class="msg-time">{{ msg.time }}</span>
          <span class="msg-actions">
          <button v-if="interactive" class="rollback-btn"
                  :class="{ loading: snapshotRollbackLoading.get(rollbackKey) }"
                  :disabled="rollbackDisabled"
                  @click="$emit('rollbackSnapshot', rollbackId, Boolean(msg.snapshotId), msg.rollbackTimestamp)"
                  :title="rollbackDisabled ? 'AI 输出中，无法撤回' : '撤回此消息及其后的会话内容'"
                  v-html="ROLLBACK_ICON"></button>
          <button class="copy-msg-btn" @click="$emit('copyMessage', msg)" title="复制消息" v-html="COPY_ICON"></button>
          </span>
        </div>
      </div>
    </template>

    <!-- 助手消息 -->
    <template v-else-if="msg.role === 'assistant' && (streaming || (msg.blocks && msg.blocks.length > 0))">
      <div class="msg-body assistant-body">
        <div class="msg-blocks">
          <section v-if="showAssistantProcessSummary" class="assistant-process-summary"
                   :class="{ expanded: hasAssistantProcess && assistantProcessExpanded, live: assistantHasLiveProcess }">
            <button
                type="button"
                class="assistant-process-toggle"
                :aria-expanded="hasAssistantProcess ? assistantProcessExpanded : false"
                :aria-controls="hasAssistantProcess ? assistantProcessId : undefined"
                :disabled="!hasAssistantProcess"
                @click="hasAssistantProcess && (assistantProcessExpanded = !assistantProcessExpanded)">
              <span>{{ assistantProcessLabel }}</span>
              <svg class="assistant-process-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polyline points="9 6 15 12 9 18"/>
              </svg>
            </button>
            <CollapseTransition>
              <div v-if="assistantProcessExpanded" :id="assistantProcessId" class="assistant-process-detail">
                <BlockRenderer :blocks="assistantProcessBlocks" :streaming="false" @send-choice="(val, block) => $emit('sendChoice', val, block)" @open-file="(filePath) => $emit('openFile', filePath)" @open-diff="change => $emit('openDiff', change)" @revert-file-changes="changes => $emit('revertFileChanges', changes)" />
              </div>
            </CollapseTransition>
          </section>
          <BlockRenderer :blocks="assistantFinalBlocks" :streaming="streaming" @send-choice="(val, block) => $emit('sendChoice', val, block)" @open-file="(filePath) => $emit('openFile', filePath)" @open-diff="change => $emit('openDiff', change)" @revert-file-changes="changes => $emit('revertFileChanges', changes)" />
        </div>
        <div class="msg-footer">
          <span class="msg-time-group">
            <span class="msg-time">{{ msg.time }}</span>
            <template v-if="fileStats">
              <span v-if="fileStats.edited > 0" class="msg-file-stat clickable" @mouseenter="showFileListDelayed('edited', $event)" @mouseleave="hideFileListDelayed">修改 {{ fileStats.edited }} 文件</span>
              <span v-if="fileStats.created > 0" class="msg-file-stat clickable" @mouseenter="showFileListDelayed('created', $event)" @mouseleave="hideFileListDelayed">新增 {{ fileStats.created }} 文件</span>
            </template>
          </span>
          <span class="msg-actions">
          <button class="copy-msg-btn" @click="$emit('copyMessage', msg)" title="复制消息" v-html="COPY_ICON"></button>
          <button v-if="interactive" class="copy-msg-btn" :disabled="branchDisabled" @click="$emit('branchSession', msg, idx)" title="继续到新会话" v-html="BRANCH_ICON"></button>
          </span>
        </div>
      </div>
    </template>
  </div>

  <!-- 文件列表弹出 -->
  <Teleport to="body">
    <div v-if="showFileList" class="file-list-popover" :class="{ above: fileListPos.above }" :style="{ position: 'fixed', left: fileListPos.x + 'px', top: fileListPos.y + 'px' }" @mouseenter="cancelHideFileList" @mouseleave="hideFileListDelayed">
      <div class="file-list-header">
        <span class="file-list-title">{{ fileListType === 'edited' ? '修改的文件' : '新增的文件' }}</span>
        <span class="file-list-count">{{ fileList.length }} 个</span>
      </div>
      <div class="file-list-body">
        <div v-for="fp in fileList" :key="fp" class="file-list-item" @click="showFileList = false; $emit('openFile', fp)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span class="file-list-path" :title="fp">{{ fp }}</span>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 链接悬停浮层 -->
  <Teleport to="body">
    <div v-if="linkPopover.visible"
         class="link-popover"
         :style="{ left: linkPopover.x + 'px', top: linkPopover.y + 'px' }"
         @mouseenter="onPopoverMouseEnter"
         @mouseleave="onPopoverMouseLeave">
      <button v-if="isElectron" class="link-popover-btn" @click="openInElement">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        元素界面打开
      </button>
      <button class="link-popover-btn" @click="openInBrowser">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        浏览器打开
      </button>
    </div>
  </Teleport>
</template>

<script setup>
import {BRANCH_ICON, COPY_ICON, ROLLBACK_ICON} from '../utils/icons'
import BlockRenderer from './BlockRenderer.vue'
import CollapseTransition from './CollapseTransition.vue'
import {computed, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue'
import platform from '../services/platform'

const props = defineProps({
  msg: {type: Object, required: true},
  idx: {type: Number, default: 0},
  workspacePath: {type: String, default: ''},
  snapshotRollbackLoading: {type: Object, required: true},
  rollbackDisabled: {type: Boolean, default: false},
  branchDisabled: {type: Boolean, default: false},
  streaming: {type: Boolean, default: false},
  /** 消息操作按钮（撤回/分支）开关：子代理会话标签关闭，避免误操作主会话 */
  interactive: {type: Boolean, default: true}
})

const emit = defineEmits(['previewImage', 'rollbackSnapshot', 'copyMessage', 'branchSession', 'sendChoice', 'openFile', 'openDiff', 'revertFileChanges', 'viewRawEvents'])

const isElectron = platform.isElectron

// 用户消息截断
const USER_MAX_LEN = 300
const userExpanded = ref(false)
const COLLAPSIBLE_USER_BLOCK = /^```折叠块[ \t]*\r?\n([\s\S]*?)\r?\n```(?:\r?\n)*/
const userCollapsedBlock = computed(() => {
  const match = (props.msg.content || '').match(COLLAPSIBLE_USER_BLOCK)
  return match ? match[1] : ''
})
const userBodyText = computed(() => (
  (props.msg.content || '').replace(COLLAPSIBLE_USER_BLOCK, '')
))
const isUserLong = computed(() => userBodyText.value.length > USER_MAX_LEN)
const userDisplayText = computed(() => {
  const c = userBodyText.value
  if (userExpanded.value || c.length <= USER_MAX_LEN) return c
  return c.slice(0, USER_MAX_LEN) + '...'
})
const userAutoMessageExpanded = ref(false)
const COMPACTED_SUMMARY_PREFIX = '[历史上下文折叠'
const compactedExpanded = ref(false)
const isCompactedSummary = computed(() =>
  props.msg.role === 'user' && (props.msg.content || '').startsWith(COMPACTED_SUMMARY_PREFIX)
)
const compactedCheckpoint = computed(() => {
  const content = props.msg.content || ''
  const start = content.indexOf('<compacted-summary>')
  if (start < 0) return content
  const end = content.indexOf('</compacted-summary>', start)
  return end > start ? content.slice(start + '<compacted-summary>'.length, end).trim() : content
})
const rollbackId = computed(() => props.msg.rollbackId || props.msg.snapshotId)
const rollbackKey = computed(() => rollbackId.value || props.msg.rollbackTimestamp)

// 助手消息文件统计（edit=修改, write=新增，按 file_path 去重）
const fileStats = computed(() => {
  const blocks = props.msg.blocks
  if (!blocks) return null
  const edited = new Set(), created = new Set()
  for (const b of blocks) {
    if (b.type !== 'tool_call' || b.name === 'finish') continue
    const fp = b.args?.file_path
    if (!fp) continue
    if (b.name === 'edit') edited.add(fp)
    else if (b.name === 'write') created.add(fp)
  }
  if (edited.size === 0 && created.size === 0) return null
  return { edited: edited.size, created: created.size, editedFiles: [...edited], createdFiles: [...created] }
})

// 助手回合摘要：将最后一个终止响应之前的思考/工具/中间正文收进顶部折叠块。
// finish 和 ask_choice 是明确的终止响应；没有工具结束信号时，最后一段非空正文就是最终回答。
const isTerminalResponseBlock = (block) => {
  if (!block) return false
  if (block.type === 'content') return Boolean(block.content?.trim())
  if (block.type === 'choice') return true
  return block.type === 'tool_call' && (block.name === 'finish' || block.name === 'ask_choice')
}

const assistantResponseStart = computed(() => {
  const blocks = props.msg.blocks || []
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (isTerminalResponseBlock(blocks[index])) return index
  }
  return -1
})

const assistantProcessBlocks = computed(() => {
  const start = assistantResponseStart.value
  return start > 0 ? (props.msg.blocks || []).slice(0, start) : []
})

const assistantFinalBlocks = computed(() => {
  const blocks = props.msg.blocks || []
  const start = assistantResponseStart.value
  return start >= 0 ? blocks.slice(start) : blocks
})

const hasAssistantProcess = computed(() => assistantProcessBlocks.value.length > 0 && assistantFinalBlocks.value.length > 0)
// 流式输出尚未产生最终正文/finish 时，过程块仍会直接渲染在消息主体里；
// 摘要行也要提前出现，避免顶部留下空白。
const assistantHasLiveProcess = computed(() => {
  if (!props.streaming) return false
  const blocks = props.msg.blocks || []
  return blocks.length === 0 || blocks.some(block => !isTerminalResponseBlock(block))
})
const showAssistantProcessSummary = computed(() => hasAssistantProcess.value || assistantHasLiveProcess.value)
const assistantProcessExpanded = ref(false)
const assistantProcessId = computed(() => `assistant-process-${String(props.msg.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`)

const toTimestamp = (value) => {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const assistantDurationClock = ref(Date.now())
let assistantDurationTimer = null

const syncAssistantDurationTimer = () => {
  if (props.msg.role === 'assistant' && props.streaming && assistantDurationTimer == null) {
    assistantDurationTimer = window.setInterval(() => { assistantDurationClock.value = Date.now() }, 1000)
  } else if ((!props.streaming || props.msg.role !== 'assistant') && assistantDurationTimer != null) {
    window.clearInterval(assistantDurationTimer)
    assistantDurationTimer = null
  }
}

const assistantDurationMs = computed(() => {
  const explicit = toTimestamp(props.msg.elapsedMs ?? props.msg.turnDurationMs ?? props.msg.durationMs)
  if (explicit != null && explicit >= 0) return explicit

  const starts = [props.msg.turnStartedAt, props.msg.startedAt].map(toTimestamp).filter(Number.isFinite)
  const finishes = [props.msg.turnFinishedAt, props.msg.finishedAt].map(toTimestamp).filter(Number.isFinite)
  const visitBlock = (block) => {
    if (!block) return
    const startedAt = toTimestamp(block.toolStartedAt ?? block.startedAt)
    const finishedAt = toTimestamp(block.toolFinishedAt ?? block.finishedAt)
    if (startedAt != null) starts.push(startedAt)
    if (finishedAt != null) finishes.push(finishedAt)
    for (const child of block.blocks || []) visitBlock(child)
  }
  for (const block of props.msg.blocks || []) visitBlock(block)

  if (starts.length === 0) return null
  const start = Math.min(...starts)
  const explicitFinish = toTimestamp(props.msg.turnFinishedAt ?? props.msg.finishedAt)
  const end = props.streaming && explicitFinish == null
    ? assistantDurationClock.value
    : (finishes.length > 0 ? Math.max(...finishes) : explicitFinish)
  return end == null ? null : Math.max(0, end - start)
})

const formatAssistantDuration = (duration) => {
  if (duration < 1000) return `${Math.round(duration)}毫秒`
  const totalSeconds = Math.max(1, Math.round(duration / 1000))
  if (totalSeconds < 60) return `${totalSeconds}秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分`
}

const assistantProcessLabel = computed(() => {
  const duration = assistantDurationMs.value
  return duration == null ? '思考过程' : `用时 ${formatAssistantDuration(duration)}`
})

watch(() => props.streaming, syncAssistantDurationTimer)

const onCollapseAllBlocks = () => {
  assistantProcessExpanded.value = false
}

// 文件列表弹出
const showFileList = ref(false)
const fileListType = ref('') // 'edited' | 'created'
const fileList = computed(() => {
  if (!fileStats.value) return []
  return fileListType.value === 'edited' ? fileStats.value.editedFiles : fileStats.value.createdFiles
})
const fileListPos = ref({ x: 0, y: 0, above: false })
let fileHideTimer = null
let fileShowTimer = null

const showFileListDelayed = (type, event) => {
  clearTimeout(fileHideTimer)
  clearTimeout(fileShowTimer)
  // 必须在 setTimeout 外捕获，Vue 事件回调结束后 event 会被回收
  const rect = event.currentTarget.getBoundingClientRect()
  fileShowTimer = setTimeout(() => {
    fileListType.value = type
    const popH = Math.min(fileList.value.length * 32 + 40, 320)
    const spaceBelow = window.innerHeight - rect.bottom
    const above = spaceBelow < popH + 8 && rect.top > popH
    fileListPos.value = {
      x: Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
      y: above ? rect.top - 4 : rect.bottom + 4,
      above
    }
    showFileList.value = true
  }, 150)
}

const hideFileListDelayed = () => {
  clearTimeout(fileShowTimer)
  fileHideTimer = setTimeout(() => { showFileList.value = false }, 200)
}

const cancelHideFileList = () => {
  clearTimeout(fileHideTimer)
}

// SVG 图标已迁移至 ../utils/icons.js

// ═══════════════════════════════════════════
// 链接悬停浮层
// ═══════════════════════════════════════════
const msgRef = ref(null)
const linkPopover = reactive({ visible: false, x: 0, y: 0, url: '' })
let hideTimer = null

function showLinkPopover(el) {
  clearTimeout(hideTimer)
  if (el.dataset.filePath) return
  const href = el.getAttribute('href')
  if (!href) return
  const rect = el.getBoundingClientRect()
  linkPopover.url = normalizeActionUrl(href)
  if (!linkPopover.url) return
  // 居中对齐，超出视口时修正
  const centerX = rect.left + rect.width / 2
  linkPopover.x = Math.max(80, Math.min(centerX, window.innerWidth - 80))
  linkPopover.y = rect.bottom + 4
  linkPopover.visible = true
}

function scheduleHide() {
  hideTimer = setTimeout(() => {
    linkPopover.visible = false
  }, 150)
}

function onPopoverMouseEnter() {
  clearTimeout(hideTimer)
}

function onPopoverMouseLeave() {
  scheduleHide()
}

function onMsgMouseOver(e) {
  const link = e.target.closest('.ai-link')
  if (!link) return
  showLinkPopover(link)
}

function onMsgMouseOut(e) {
  const link = e.target.closest('.ai-link')
  if (!link) return
  const related = e.relatedTarget
  if (related && (link.contains(related) || related.closest?.('.link-popover'))) return
  scheduleHide()
}

function onMsgClick(e) {
  // 代码复制按钮（sanitize 会剥离内联 onclick，统一走事件委托）
  const copyBtn = e.target.closest('.code-copy-btn')
  if (copyBtn) {
    e.preventDefault()
    e.stopPropagation()
    const wrap = copyBtn.closest('.code-block-wrap')
    const code = wrap?.querySelector('code')?.textContent || ''
    navigator.clipboard.writeText(code).then(() => {
      window.dispatchEvent(new CustomEvent('copy-success', {detail: '代码已复制'}))
    }).catch(() => {})
    return
  }

  const link = e.target.closest('.ai-link')
  if (!link) return
  e.preventDefault()
  e.stopPropagation()

  const filePath = link.dataset.filePath || getWorkspaceFilePath(link.getAttribute('href'))
  if (filePath) {
    linkPopover.visible = false
    emit('openFile', filePath)
    return
  }

  // 浏览器环境直接打开
  if (!isElectron) {
    window.open(link.getAttribute('href'), '_blank')
  }
  // 桌面环境由浮层按钮处理
}

async function openInBrowser() {
  const url = linkPopover.url
  linkPopover.visible = false
  if (!url) return
  if (window.electronAPI?.openExternal) {
    await window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

async function openInElement() {
  const url = linkPopover.url
  linkPopover.visible = false
  if (!url) return
  if (window.electronAPI?.elementInspectorWindow?.open) {
    try {
      await window.electronAPI.elementInspectorWindow.open(url)
      return
    } catch (error) {
      console.error('[chat-message] failed to open element inspector:', error)
    }
  }
  window.dispatchEvent(new CustomEvent('loopra:open-in-element', { detail: { url } }))
}

function normalizeActionUrl(rawUrl) {
  const match = String(rawUrl || '').trim().match(/^https?:\/\/[^\s,，。；;！？!?"'`<>()[\]{}]+/i)
  if (!match) return ''
  try {
    const url = new URL(match[0])
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

function getWorkspaceFilePath(rawUrl) {
  const workspacePath = props.workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
  let path = decodeURIComponent(String(rawUrl || '').trim()).replace(/\\/g, '/')
  path = path.replace(/^\/(?:[A-Za-z]:\/)/, match => match.slice(1))
  path = path.replace(/:(\d+)$/, '')
  if (!workspacePath || !path) return ''

  const normalizedPath = path.replace(/\/{2,}/g, '/')
  const normalizedWorkspace = workspacePath.replace(/\/{2,}/g, '/')
  if (normalizedPath === normalizedWorkspace) return ''
  if (normalizedPath.startsWith(normalizedWorkspace + '/')) {
    return normalizedPath.slice(normalizedWorkspace.length + 1)
  }
  if (/^(?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[\w-]+$/i.test(normalizedPath)) {
    return normalizedPath.replace(/^\.\//, '')
  }
  return ''
}

onMounted(() => {
  const el = msgRef.value
  if (!el) return
  el.addEventListener('mouseover', onMsgMouseOver)
  el.addEventListener('mouseout', onMsgMouseOut)
  el.addEventListener('click', onMsgClick)
  if (props.msg.role === 'assistant') {
    window.addEventListener('loopra:collapse-all-blocks', onCollapseAllBlocks)
    syncAssistantDurationTimer()
  }
})
onBeforeUnmount(() => {
  const el = msgRef.value
  if (el) {
    el.removeEventListener('mouseover', onMsgMouseOver)
    el.removeEventListener('mouseout', onMsgMouseOut)
    el.removeEventListener('click', onMsgClick)
  }
  if (props.msg.role === 'assistant') window.removeEventListener('loopra:collapse-all-blocks', onCollapseAllBlocks)
  clearTimeout(hideTimer)
  if (assistantDurationTimer != null) window.clearInterval(assistantDurationTimer)
  assistantDurationTimer = null
})


</script>

<style scoped>
/* 消息 */
.msg {
  margin-bottom: 8px;
}

/* 角色切换时增大间距 */
.msg.user + .msg.assistant,
.msg.assistant + .msg.user {
  margin-top: 20px;
  margin-bottom: 20px;
}

.msg.user {
  display: flex;
  justify-content: flex-end;
}

.msg.user .msg-body {
  box-sizing: border-box;
  width: min(480px, 85vw);
}

.msg.assistant .msg-body {
  width: 100%;
  max-width: 100%;
}

.msg-body {
  max-width: 85%;
  user-select: text;
  -webkit-user-select: text;
}

.user-body {
  background: var(--blue-bg);
  border: 1px solid var(--glass-border);
  color: var(--fg);
  padding: 9px 13px;
  border-radius: 14px;
  border-top-right-radius: 7px;
  box-shadow: none;
  font-size: var(--font-message-size, 14px);
}

.compacted-body {
  width: min(720px, 100%);
}

.compacted-summary {
  overflow: hidden;
  border: 1px dashed var(--border-2);
  border-radius: var(--r);
  background: var(--bg-2);
}

.compacted-summary-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
}

.compacted-summary-icon {
  flex-shrink: 0;
  color: var(--fg-4);
}

.compacted-summary-title {
  flex: 1;
  color: var(--fg-2);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.compacted-summary-btn {
  flex-shrink: 0;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--fg-3);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.compacted-summary-btn.primary {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}

.compacted-summary-btn:hover {
  background: var(--bg-3);
  color: var(--fg);
}

.compacted-summary-content {
  max-height: 340px;
  overflow: auto;
  margin: 0 8px 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--fg-2);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.user-body ::selection {
  background: var(--accent);
  color: #fff;
}

.assistant-body {
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 0;
  box-shadow: none;
  font-size: var(--font-message-size, 14px);
}

.msg-blocks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 回合过程折叠：保留最后的 finish/最终正文，历史执行路径收拢到消息顶部。 */
.assistant-process-summary {
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.assistant-process-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 32px;
  padding: 4px 2px 8px;
  border: 0;
  background: transparent;
  color: var(--fg-3);
  font: inherit;
  font-size: var(--font-message-size, 14px);
  text-align: left;
  cursor: pointer;
  transition: color var(--t), background-color var(--t);
}

.assistant-process-toggle:hover,
.assistant-process-toggle:focus-visible {
  color: var(--fg-2);
  outline: none;
}

.assistant-process-chevron {
  flex-shrink: 0;
  color: var(--fg-4);
  transition: transform var(--t);
}

.assistant-process-summary.expanded .assistant-process-chevron {
  transform: rotate(90deg);
}

.assistant-process-detail {
  padding: 0 0 4px;
}

.assistant-body ::selection {
  background: var(--accent);
  color: #fff;
}

.user-body .msg-time,
.assistant-body .msg-time {
  font-size: 12px;
  color: var(--fg-4);
  opacity: 1;
  margin-top: 0;
  font-variant-numeric: tabular-nums;
}

.msg-text {
  font-size: var(--font-message-size, 14px);
  line-height: 1.7;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
}

.user-auto-message {
  display: block;
  margin: 0 0 6px;
  overflow: hidden;
  border: 1px solid var(--glass-border);
  border-radius: var(--r);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--blur-sm));
  -webkit-backdrop-filter: blur(var(--blur-sm));
}

.user-auto-message-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--fg-3);
  cursor: pointer;
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  user-select: none;
}

.user-auto-message-trigger svg {
  flex-shrink: 0;
}

.user-auto-message-trigger:hover,
.user-auto-message-trigger:focus-visible {
  background: var(--bg-2);
  outline: none;
}

.user-auto-message-title {
  color: var(--fg-2);
  font-size: 12px;
  font-weight: 500;
}

.user-auto-message-chevron {
  margin-left: auto;
  flex-shrink: 0;
  transition: transform var(--t);
  color: var(--fg-4);
}

.user-auto-message-trigger[aria-expanded="true"] .user-auto-message-chevron {
  transform: rotate(180deg);
}

.user-auto-message-detail {
  padding: 10px 10px 8px;
  border-top: 1px solid var(--border);
}

.user-auto-message-content {
  margin: 0;
  color: var(--fg-2);
  font-family: var(--mono);
  font-size: var(--font-code-size, 12px);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 用户消息中的图片 */
.user-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.user-image-button {
  display: block;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: zoom-in;
}

.user-image {
  display: block;
  width: 80px;
  height: 80px;
  object-fit: cover;
  border: 1px solid var(--border);
  border-radius: 6px;
  transition: transform 0.15s, box-shadow 0.15s;
}

.user-image-button:hover .user-image,
.user-image-button:focus-visible .user-image {
  transform: scale(1.05);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.user-image-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 消息底部栏 */
.msg-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.user-body .msg-footer {
  justify-content: space-between;
  align-items: center;
}

.assistant-body .msg-footer {
  justify-content: space-between;
}

.msg-time-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.msg-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.msg-file-stat {
  font-size: 12px;
  color: var(--fg-3);
}

.msg-file-stat.clickable {
  cursor: pointer;
  transition: color var(--t);
}

.msg-file-stat.clickable:hover {
  color: var(--accent);
}

.copy-msg-btn {
  opacity: 0;
  background: none;
  border: none;
  font-size: 12px;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: var(--r-sm);
  transition: opacity 120ms ease, color 120ms ease, background-color 120ms ease;
  line-height: 1;
  color: var(--fg-4);
}

.assistant-body .copy-msg-btn,
.user-body .copy-msg-btn {
  opacity: 1;
}

.msg-body:hover .copy-msg-btn {
  opacity: 1;
}

.copy-msg-btn:hover {
  opacity: 1 !important;
  background: var(--bg-3);
  color: var(--fg-2);
  border-radius: 6px;
}

/* 用户消息展开/收起按钮 */
.user-expand-btn {
  background: none;
  border: none;
  color: var(--fg-3);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 0;
  margin-top: 2px;
  text-decoration: underline;
  text-underline-offset: 2px;
  transition: color var(--t);
}

.user-expand-btn:hover {
  color: var(--accent);
}

/* 撤回按钮 */
.rollback-btn {
  opacity: 0.5;
  background: none;
  border: none;
  font-size: 12px;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: var(--r-sm);
  transition: opacity 120ms ease, color 120ms ease, background-color 120ms ease;
  line-height: 1;
  color: var(--fg-4);
}

.rollback-btn.loading {
  opacity: 0.5;
  pointer-events: none;
}

.rollback-btn:disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.msg-body:hover .rollback-btn {
  opacity: 0.8;
}

.rollback-btn:hover {
  opacity: 1 !important;
  background: var(--bg-3);
  color: var(--fg-2);
  border-radius: 6px;
}

/* 链接悬停浮层 */
.link-popover {
  position: fixed;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  gap: 2px;
  background: var(--bg, #fff);
  border: 1px solid var(--border, #e0e0e0);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.08);
  animation: link-popover-in 0.15s ease-out;
}

@keyframes link-popover-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-4px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.link-popover-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fg, #333);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.link-popover-btn:hover {
  background: var(--accent-btn, var(--accent));
  color: #fff;
}

.link-popover-btn svg {
  flex-shrink: 0;
}
/* Keep automatically attached files and skills visually aligned with tool-call rows. */
.user-auto-message {
  display: block;
  width: 100%;
  padding: 0;
  margin: 0 0 10px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.user-auto-message-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box !important;
  height: 36px !important;
  min-height: 36px !important;
  max-height: 36px;
  padding: 0 16px !important;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: 13px;
  font-weight: 600;
  line-height: 1 !important;
  letter-spacing: 0;
  text-align: left;
  cursor: pointer;
}

.user-auto-message-trigger:hover {
  border-color: var(--border-2);
  background: var(--bg-3);
  color: var(--fg);
}

.user-auto-message-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.user-auto-message-title::before {
  content: "✓";
  color: var(--fg-4);
  font-size: 14px;
  font-weight: 500;
}

.user-auto-message-trigger svg {
  width: 14px;
  height: 14px;
  margin-left: auto;
  color: var(--fg-4);
}

.user-auto-message-content {
  margin-top: -1px;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: 0 0 6px 6px;
  background: var(--bg-2);
  color: var(--fg-3);
  font-size: var(--font-code-size, 12px);
  line-height: 1.55;
  white-space: pre-wrap;
}
</style>

<style>
/* 文件列表弹出（非 scoped，因为 Teleport 到 body） */
.file-list-popover {
  z-index: 9999;
  min-width: 280px;
  max-width: 480px;
  max-height: 320px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: 0 8px 32px rgba(0,0,0,0.12);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.file-list-popover.above {
  transform: translateY(-100%);
}

.file-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.file-list-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
}

.file-list-count {
  font-size: 11px;
  color: var(--fg-4);
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: var(--r-sm);
}

.file-list-body {
  overflow-y: auto;
  padding: 4px;
}

.file-list-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background var(--t);
}

.file-list-item:hover {
  background: var(--bg-2);
}

.file-list-item svg {
  color: var(--fg-4);
  flex-shrink: 0;
}

.file-list-path {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
