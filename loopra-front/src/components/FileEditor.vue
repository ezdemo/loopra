<template>
  <div class="file-editor">
    <div class="fe-body">
      <div ref="editorRef" class="fe-monaco"></div>
      <!-- 选中文本后的“添加到对话”浮动按钮（交互参照 DiffViewer 预览弹框） -->
      <button
        v-if="selectionAction.visible"
        type="button"
        class="fe-selection-action"
        :style="{ left: `${selectionAction.left}px`, top: `${selectionAction.top}px` }"
        @mousedown.prevent
        @click="addSelectionToSession"
      >
        添加到对话
      </button>
      <div v-if="loading" class="fe-state fe-overlay">
        <span class="loading-spinner"></span>
      </div>
      <div v-else-if="error" class="fe-state fe-error fe-overlay">{{ error }}</div>
    </div>
  </div>
</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue'
import {message} from 'ant-design-vue'
import {gitAPI} from '../services/api'
import {computeDirtyDiff, dirtyDiffDecorations} from '../utils/dirtyDiff'

const props = defineProps({
  activeFile: {type: Object, default: null},
  workspaceHash: {type: String, default: ''},
  workspacePath: {type: String, default: ''},
  theme: {type: String, default: 'gray'}
})

const emit = defineEmits(['saved', 'dirtyChange', 'addToSession'])

const editorRef = ref(null)
const editor = shallowRef(null)
const monaco = shallowRef(null)
const loadingPath = ref('')
const error = ref('')
const saving = ref(false)
const models = new Map()
const loadRequests = new Map()
let mouseDisposable = null
let mouseMoveDisposable = null
let mouseLeaveDisposable = null
let mouseUpDisposable = null
let selectionDisposable = null
let scrollDisposable = null
let keyDisposable = null
let stopFileChangeListener = null
let peekState = null
let disposed = false
let typographyObserver = null

const activePath = computed(() => props.activeFile?.path || '')
// 选中文本浮动按钮（与 DiffViewer 预览弹框的“添加到会话”交互一致）
const selectionAction = ref({visible: false, left: 0, top: 0, text: '', startLine: 0, endLine: 0})
const loading = computed(() => loadingPath.value === activePath.value)
const explorerAPI = () => window.electronAPI?.fileExplorer
const editorTheme = () => props.theme === 'dark' ? 'vs-dark' : 'vs'
const codeFontSize = () => {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-code-size'))
  return Number.isFinite(value) ? value : 12
}

function normalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function resolveChangedPaths(event) {
  const root = String(event?.rootPath || '').replace(/[\\/]+$/, '')
  const paths = Array.isArray(event?.paths) ? event.paths : [event?.path]
  return paths
    .filter(Boolean)
    .map((changedPath) => /^[a-z]:[\\/]/i.test(changedPath) || String(changedPath).startsWith('/')
      ? String(changedPath)
      : `${root}/${changedPath}`)
}

async function refreshExternalFile(path, entry) {
  if (!entry || entry.dirty) return
  const request = ++entry.externalRefreshRequest
  try {
    const response = await explorerAPI()?.read(path)
    if (!response?.success || disposed || models.get(path) !== entry || entry.dirty || request !== entry.externalRefreshRequest) return
    const content = response.data ?? ''
    if (entry.model.getValue() === content) return
    entry.changeDisposable?.dispose()
    entry.model.setValue(content)
    entry.savedVersion = entry.model.getAlternativeVersionId()
    entry.dirty = false
    entry.changeDisposable = listenForModelChanges(path, entry)
    applyDirtyDiff(entry)
  } catch {
    // 文件可能正处于外部工具的原子替换过程，等待下一次文件事件重试。
  }
}

function onFileSystemChange(event) {
  if (normalizePath(event?.rootPath) !== normalizePath(props.workspacePath)) return
  for (const changedPath of resolveChangedPaths(event)) {
    const normalizedChangedPath = normalizePath(changedPath)
    const match = [...models.entries()].find(([path]) => normalizePath(path) === normalizedChangedPath)
    if (match) void refreshExternalFile(match[0], match[1])
  }
}

function gitRelativePath(path) {
  const file = String(path || '').replace(/\\/g, '/')
  const root = String(props.workspacePath || '').replace(/\\/g, '/').replace(/\/$/, '')
  if (root && file.toLowerCase().startsWith((root + '/').toLowerCase())) return file.slice(root.length + 1)
  return /^[a-z]:\//i.test(file) || file.startsWith('/') ? '' : file
}

function clearDirtyDiffHover(entry) {
  if (!entry || entry.hoveredChangeIndex === -1) return
  entry.hoverDecorationIds = entry.model.deltaDecorations(entry.hoverDecorationIds, [])
  entry.hoveredChangeIndex = -1
}

function setDirtyDiffHover(entry, index) {
  if (!entry || entry.hoveredChangeIndex === index) return
  clearDirtyDiffHover(entry)
  if (index < 0) return
  const change = entry.changes[index]
  entry.hoverDecorationIds = entry.model.deltaDecorations(entry.hoverDecorationIds, [{
    range: new monaco.value.Range(change.startLine, 1, change.endLine, 1),
    options: {
      linesDecorationsClassName: `dirty-diff-glyph dirty-diff-${change.type} dirty-diff-hover`
    }
  }])
  entry.hoveredChangeIndex = index
}

function applyDirtyDiff(entry) {
  if (!monaco.value || entry.model.isDisposed?.()) return
  clearDirtyDiffHover(entry)
  const changes = entry.baseline === null ? [] : computeDirtyDiff(entry.baseline, entry.model.getValue())
  entry.changes = changes
  entry.decorationIds = entry.model.deltaDecorations(
    entry.decorationIds,
    dirtyDiffDecorations(monaco.value, changes, props.theme)
  )
}

function linesInRange(content, startLine, endLine) {
  if (endLine < startLine) return []
  return String(content || '').replace(/\r\n/g, '\n').split('\n').slice(startLine - 1, endLine)
}

function closeDirtyDiffPeek() {
  if (!peekState) return
  const {entry, zoneId} = peekState
  if (zoneId && editor.value) {
    editor.value.changeViewZones((accessor) => accessor.removeZone(zoneId))
  }
  entry.peekDecorationIds = entry.model.deltaDecorations(entry.peekDecorationIds, [])
  peekState = null
}

function appendPeekLines(container, lines, startLine, className) {
  for (const [offset, text] of lines.entries()) {
    const row = document.createElement('div')
    row.className = `dirty-diff-peek-line ${className}`
    const number = document.createElement('span')
    number.className = 'dirty-diff-peek-number'
    number.textContent = String(startLine + offset)
    const code = document.createElement('span')
    code.className = 'dirty-diff-peek-code'
    code.textContent = text || ' '
    row.append(number, code)
    container.append(row)
  }
}

function createPeekButton(icon, title, handler) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dirty-diff-peek-button'
  button.title = title
  button.setAttribute('aria-label', title)
  const iconNode = document.createElement('i')
  iconNode.className = `codicon codicon-${icon}`
  button.append(iconNode)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    handler()
  })
  return button
}

function revertDirtyDiffChange(entry, change) {
  const currentLines = String(entry.model.getValue() || '').replace(/\r\n/g, '\n').split('\n')
  const oldLines = linesInRange(entry.baseline, change.originalStartLine, change.originalEndLine)
  const deleteCount = Math.max(0, change.modifiedEndLine - change.modifiedStartLine + 1)
  currentLines.splice(change.modifiedStartLine - 1, deleteCount, ...oldLines)

  closeDirtyDiffPeek()
  editor.value.pushUndoStop()
  editor.value.executeEdits('dirtyDiff.revert', [{
    range: entry.model.getFullModelRange(),
    text: currentLines.join(entry.model.getEOL()),
    forceMoveMarkers: true
  }])
  editor.value.pushUndoStop()
}

function openDirtyDiffPeek(entry, index) {
  const changes = entry.changes || []
  if (!changes.length || editor.value?.getModel() !== entry.model) return
  closeDirtyDiffPeek()

  const nextIndex = (index + changes.length) % changes.length
  const change = changes[nextIndex]
  const oldLines = linesInRange(entry.baseline, change.originalStartLine, change.originalEndLine)
  const domNode = document.createElement('div')
  domNode.className = 'dirty-diff-peek-zone'
  const panel = document.createElement('div')
  panel.className = 'dirty-diff-peek'

  const header = document.createElement('div')
  header.className = 'dirty-diff-peek-header'
  const title = document.createElement('span')
  title.className = 'dirty-diff-peek-title'
  title.textContent = `${nextIndex + 1} / ${changes.length}`
  const actions = document.createElement('div')
  actions.className = 'dirty-diff-peek-actions'
  actions.append(
    createPeekButton('arrow-up', '上一个更改', () => openDirtyDiffPeek(entry, nextIndex - 1)),
    createPeekButton('arrow-down', '下一个更改', () => openDirtyDiffPeek(entry, nextIndex + 1)),
    createPeekButton('discard', '回滚此更改', () => revertDirtyDiffChange(entry, change)),
    createPeekButton('close', '关闭', closeDirtyDiffPeek)
  )
  header.append(actions, title)
  panel.append(header)
  appendPeekLines(panel, oldLines, change.originalStartLine, 'dirty-diff-peek-removed')
  domNode.append(panel)

  const hasCurrentLines = change.modifiedEndLine >= change.modifiedStartLine
  const peekStartLine = hasCurrentLines ? change.modifiedStartLine : change.startLine
  const peekEndLine = hasCurrentLines ? change.modifiedEndLine : change.endLine
  const peekDecorations = [{
    range: new monaco.value.Range(peekStartLine, 1, peekEndLine, 1),
    options: {
      isWholeLine: hasCurrentLines,
      className: hasCurrentLines ? 'dirty-diff-peek-current' : undefined,
      linesDecorationsClassName: `dirty-diff-glyph dirty-diff-${change.type} dirty-diff-active`
    }
  }]
  entry.peekDecorationIds = entry.model.deltaDecorations(entry.peekDecorationIds, peekDecorations)

  let zoneId = null
  editor.value.changeViewZones((accessor) => {
    zoneId = accessor.addZone({
      afterLineNumber: Math.max(0, change.modifiedStartLine - 1),
      heightInPx: 34 + oldLines.length * 21,
      domNode,
      suppressMouseDown: false
    })
  })
  peekState = {entry, index: nextIndex, zoneId}
  editor.value.revealLineInCenter(change.startLine)
}

function dirtyDiffIndexAt(event, entry) {
  if (event.target.type !== monaco.value.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return -1
  if (!event.target.element?.classList?.contains('dirty-diff-glyph')) return -1
  const line = event.target.position?.lineNumber
  return entry?.changes?.findIndex((change) => line >= change.startLine && line <= change.endLine) ?? -1
}

function onEditorMouseDown(event) {
  hideSelectionAction()
  const entry = models.get(activePath.value)
  const index = dirtyDiffIndexAt(event, entry)
  if (index >= 0) openDirtyDiffPeek(entry, index)
}

function hideSelectionAction() {
  selectionAction.value.visible = false
}

function onEditorMouseUp(event) {
  const model = editor.value?.getModel()
  const selection = editor.value?.getSelection()
  if (!model || !selection || selection.isEmpty()) {
    hideSelectionAction()
    return
  }
  const text = model.getValueInRange(selection).trim()
  if (!text) {
    hideSelectionAction()
    return
  }
  const clientX = event.event?.browserEvent?.clientX ?? 0
  const clientY = event.event?.browserEvent?.clientY ?? 0
  const rect = editorRef.value?.getBoundingClientRect()
  const buttonWidth = 112
  const buttonHeight = 28
  selectionAction.value = {
    visible: true,
    text,
    startLine: selection.startLineNumber,
    endLine: selection.endLineNumber,
    left: rect
      ? Math.min(Math.max(rect.left + 4, clientX + 6), window.innerWidth - buttonWidth - 4)
      : clientX,
    top: rect ? Math.max(rect.top + 4, clientY - buttonHeight - 6) : clientY
  }
}

function onSelectionChange() {
  const selection = editor.value?.getSelection()
  if (!selection || selection.isEmpty()) hideSelectionAction()
}

function onEditorScroll() {
  hideSelectionAction()
}

function addSelectionToSession() {
  const action = selectionAction.value
  if (!action.text) return
  emit('addToSession', {
    file: activePath.value,
    content: action.text,
    startLine: action.startLine,
    endLine: action.endLine
  })
  hideSelectionAction()
}

function onEditorMouseMove(event) {
  const entry = models.get(activePath.value)
  setDirtyDiffHover(entry, dirtyDiffIndexAt(event, entry))
}

function onEditorMouseLeave() {
  clearDirtyDiffHover(models.get(activePath.value))
}

function scheduleDirtyDiff(entry) {
  clearTimeout(entry.diffTimer)
  entry.diffTimer = setTimeout(() => applyDirtyDiff(entry), 300)
}

async function refreshBaseline(path, entry) {
  const relativePath = gitRelativePath(path)
  const request = ++entry.baselineRequest
  if (!props.workspaceHash || !relativePath) {
    entry.baseline = null
    applyDirtyDiff(entry)
    return
  }
  try {
    const response = await gitAPI.fileContent(props.workspaceHash, relativePath, 'HEAD', {silent: true})
    if (disposed || models.get(path) !== entry || entry.baselineRequest !== request) return
    entry.baseline = response?.data?.content ?? null
  } catch {
    if (models.get(path) !== entry || entry.baselineRequest !== request) return
    entry.baseline = null
  }
  applyDirtyDiff(entry)
}

function refreshAllBaselines() {
  for (const [path, entry] of models) void refreshBaseline(path, entry)
}

function onGitChanged(event) {
  if (event.detail?.workspaceHash && event.detail.workspaceHash !== props.workspaceHash) return
  refreshAllBaselines()
}

function listenForModelChanges(path, entry) {
  return entry.model.onDidChangeContent(() => {
    if (peekState?.entry === entry) closeDirtyDiffPeek()
    scheduleDirtyDiff(entry)
    const nextDirty = entry.model.getAlternativeVersionId() !== entry.savedVersion
    if (nextDirty === entry.dirty) return
    entry.dirty = nextDirty
    emit('dirtyChange', path, nextDirty)
  })
}

function createEntry(path, content, dirty = false) {
  const uri = monaco.value.Uri.file(path)
  const language = /\.vue$/i.test(path) ? 'html' : undefined
  const model = monaco.value.editor.createModel(content, language, uri)
  const entry = {
    model,
    dirty,
    savedVersion: dirty ? -1 : model.getAlternativeVersionId(),
    viewState: null,
    baseline: null,
    baselineRequest: 0,
    changes: [],
    decorationIds: [],
    hoverDecorationIds: [],
    hoveredChangeIndex: -1,
    peekDecorationIds: [],
    diffTimer: null,
    externalRefreshRequest: 0,
    changeDisposable: null
  }
  entry.changeDisposable = listenForModelChanges(path, entry)
  models.set(path, entry)
  void refreshBaseline(path, entry)
  return entry
}

function showEntry(path, entry) {
  clearDirtyDiffHover(models.get(activePath.value))
  closeDirtyDiffPeek()
  const currentPath = activePath.value
  const currentEntry = models.get(currentPath)
  if (currentEntry && editor.value?.getModel() === currentEntry.model) {
    currentEntry.viewState = editor.value.saveViewState()
  }
  editor.value?.setModel(entry?.model || null)
  if (entry?.viewState) editor.value?.restoreViewState(entry.viewState)
  if (path) editor.value?.focus()
}

async function activateFile(path) {
  if (!path || !monaco.value || !editor.value) {
    editor.value?.setModel(null)
    return
  }
  error.value = ''
  const existing = models.get(path)
  if (existing) {
    showEntry(path, existing)
    await nextTick()
    editor.value.layout()
    return
  }

  editor.value.setModel(null)
  const request = Symbol(path)
  loadRequests.set(path, request)
  loadingPath.value = path
  try {
    const response = await explorerAPI()?.read(path)
    if (!response?.success) throw new Error(response?.error || '读取失败')
    if (disposed || loadRequests.get(path) !== request) return
    const entry = createEntry(path, response.data)
    if (activePath.value === path) showEntry(path, entry)
  } catch (e) {
    if (loadRequests.get(path) === request && activePath.value === path) {
      error.value = e.message || '读取文件失败'
    }
  } finally {
    if (loadRequests.get(path) === request) {
      loadRequests.delete(path)
      if (loadingPath.value === path) loadingPath.value = ''
    }
  }
}

async function save() {
  const path = activePath.value
  const entry = models.get(path)
  if (!entry?.dirty || saving.value) return
  saving.value = true
  const savingVersion = entry.model.getAlternativeVersionId()
  const savingContent = entry.model.getValue()
  try {
    const response = await explorerAPI()?.write(path, savingContent)
    if (!response?.success) throw new Error(response?.error || '保存失败')
    if (models.get(path) !== entry) return
    entry.savedVersion = savingVersion
    const nextDirty = entry.model.getAlternativeVersionId() !== savingVersion
    entry.dirty = nextDirty
    emit('dirtyChange', path, nextDirty)
    message.success('已保存')
    emit('saved', path)
  } catch (e) {
    message.error('保存失败：' + (e.message || '未知错误'))
  } finally {
    saving.value = false
  }
}

function disposeEntry(path) {
  const entry = models.get(path)
  if (!entry) return
  if (editor.value?.getModel() === entry.model) editor.value.setModel(null)
  clearTimeout(entry.diffTimer)
  entry.baselineRequest++
  if (peekState?.entry === entry) closeDirtyDiffPeek()
  clearDirtyDiffHover(entry)
  entry.decorationIds = entry.model.deltaDecorations(entry.decorationIds, [])
  entry.changeDisposable?.dispose()
  entry.model.dispose()
  models.delete(path)
}

function closeFile(path) {
  loadRequests.delete(path)
  disposeEntry(path)
}

function renameFile(oldPath, newPath) {
  loadRequests.delete(oldPath)
  const entry = models.get(oldPath)
  if (!entry || oldPath === newPath) return
  const existingTarget = models.get(newPath)
  if (existingTarget) disposeEntry(newPath)
  const wasActive = editor.value?.getModel() === entry.model
  if (wasActive) entry.viewState = editor.value.saveViewState()
  const content = entry.model.getValue()
  const dirty = entry.dirty
  const viewState = entry.viewState
  const nextEntry = createEntry(newPath, content, dirty)
  nextEntry.viewState = viewState
  disposeEntry(oldPath)
  if (wasActive) showEntry(newPath, nextEntry)
}

function closeAll() {
  loadRequests.clear()
  for (const path of [...models.keys()]) disposeEntry(path)
}

async function initializeEditor() {
  loadingPath.value = activePath.value
  try {
    await import('monaco-editor/nls/lang/zh-cn')
    const module = await import('../utils/monaco')
    if (disposed || !editorRef.value) return
    monaco.value = module.default
    editor.value = monaco.value.editor.create(editorRef.value, {
      automaticLayout: true,
      fontFamily: "'JetBrains Mono Variable', Consolas, 'Courier New', monospace",
      fontSize: codeFontSize(),
      glyphMargin: true,
      lineHeight: 21,
      minimap: {enabled: true},
      padding: {top: 8, bottom: 8},
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      theme: editorTheme()
    })
    editor.value.addCommand(monaco.value.KeyMod.CtrlCmd | monaco.value.KeyCode.KeyS, () => { void save() })
    mouseDisposable = editor.value.onMouseDown(onEditorMouseDown)
    mouseMoveDisposable = editor.value.onMouseMove(onEditorMouseMove)
    mouseLeaveDisposable = editor.value.onMouseLeave(onEditorMouseLeave)
    mouseUpDisposable = editor.value.onMouseUp(onEditorMouseUp)
    selectionDisposable = editor.value.onDidChangeCursorSelection(onSelectionChange)
    scrollDisposable = editor.value.onDidScrollChange(onEditorScroll)
    keyDisposable = editor.value.onKeyDown((event) => {
      if (event.keyCode !== monaco.value.KeyCode.Escape || !peekState) return
      event.preventDefault()
      event.stopPropagation()
      closeDirtyDiffPeek()
    })
    await activateFile(activePath.value)
  } catch (e) {
    error.value = e.message || '编辑器加载失败'
    loadingPath.value = ''
  }
}

watch(activePath, (path, previousPath) => {
  const previousEntry = models.get(previousPath)
  if (previousEntry && editor.value?.getModel() === previousEntry.model) {
    previousEntry.viewState = editor.value.saveViewState()
  }
  void activateFile(path)
})

watch(() => props.theme, () => {
  if (monaco.value) {
    monaco.value.editor.setTheme(editorTheme())
    for (const entry of models.values()) applyDirtyDiff(entry)
  }
})

watch([() => props.workspaceHash, () => props.workspacePath], refreshAllBaselines)

onMounted(() => {
  window.addEventListener('loopra:git-changed', onGitChanged)
  stopFileChangeListener = explorerAPI()?.onDidChange?.(onFileSystemChange) || null
  if (typeof MutationObserver !== 'undefined') {
    typographyObserver = new MutationObserver(() => {
      editor.value?.updateOptions?.({fontSize: codeFontSize()})
    })
    typographyObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['style']})
  }
  void initializeEditor()
})

onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('loopra:git-changed', onGitChanged)
  typographyObserver?.disconnect()
  typographyObserver = null
  stopFileChangeListener?.()
  closeDirtyDiffPeek()
  mouseDisposable?.dispose()
  mouseMoveDisposable?.dispose()
  mouseLeaveDisposable?.dispose()
  mouseUpDisposable?.dispose()
  selectionDisposable?.dispose()
  scrollDisposable?.dispose()
  keyDisposable?.dispose()
  editor.value?.setModel(null)
  closeAll()
  editor.value?.dispose()
})

defineExpose({closeAll, closeFile, renameFile, save})
</script>

<style scoped>
.file-editor {
  --dirty-diff-added: #81b88b;
  --dirty-diff-modified: #66afe0;
  --dirty-diff-deleted: #ca4b51;
  --dirty-diff-peek-bg: #f8f8f8;
  --dirty-diff-peek-border: #d0d0d0;
  --dirty-diff-peek-header: #ececec;
  --dirty-diff-peek-removed-bg: rgba(202, 75, 81, 0.18);
  --dirty-diff-peek-current-bg: rgba(129, 184, 139, 0.18);
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  background: var(--bg);
}

[data-theme="dark"] .file-editor {
  --dirty-diff-added: #587c0c;
  --dirty-diff-modified: #0c7d9d;
  --dirty-diff-deleted: #94151b;
  --dirty-diff-peek-bg: #1e1e1e;
  --dirty-diff-peek-border: #454545;
  --dirty-diff-peek-header: #2d2d30;
  --dirty-diff-peek-removed-bg: rgba(148, 21, 27, 0.32);
  --dirty-diff-peek-current-bg: rgba(88, 124, 12, 0.3);
}

:global(.monaco-editor .dirty-diff-glyph) {
  margin-left: 4px;
  z-index: 5;
  cursor: pointer;
}

:global(.monaco-editor .dirty-diff-added::before),
:global(.monaco-editor .dirty-diff-modified::before) {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  border-radius: 1px;
  transition: width 150ms cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
}

:global(.monaco-editor .dirty-diff-added::before) {
  background: var(--dirty-diff-added);
}

:global(.monaco-editor .dirty-diff-modified::before) {
  background: var(--dirty-diff-modified);
}

:global(.monaco-editor .dirty-diff-deleted::after) {
  content: '';
  position: absolute;
  bottom: -4px;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 4px solid var(--dirty-diff-deleted);
  transform: scale(1);
  transform-origin: left center;
  transition: transform 150ms cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
}

:global(.monaco-editor .dirty-diff-added:hover::before),
:global(.monaco-editor .dirty-diff-modified:hover::before),
:global(.monaco-editor .dirty-diff-added.dirty-diff-hover::before),
:global(.monaco-editor .dirty-diff-modified.dirty-diff-hover::before),
:global(.monaco-editor .dirty-diff-added.dirty-diff-active::before),
:global(.monaco-editor .dirty-diff-modified.dirty-diff-active::before) {
  width: 9px;
}

:global(.monaco-editor .dirty-diff-deleted:hover::after),
:global(.monaco-editor .dirty-diff-deleted.dirty-diff-hover::after),
:global(.monaco-editor .dirty-diff-deleted.dirty-diff-active::after) {
  transform: scale(1.6);
}

:global(.monaco-editor .dirty-diff-peek-current) {
  background: transparent;
  box-shadow: inset 540px 0 var(--dirty-diff-peek-current-bg);
}

:global(.dirty-diff-peek-zone) {
  height: 100%;
}

:global(.dirty-diff-peek) {
  box-sizing: border-box;
  width: min(540px, calc(100% - 12px));
  height: 100%;
  overflow: hidden auto;
  border-top: 1px solid var(--dirty-diff-peek-border);
  border-right: 1px solid var(--dirty-diff-peek-border);
  border-bottom: 1px solid var(--dirty-diff-peek-border);
  background: var(--dirty-diff-peek-bg);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 21px;
}

:global(.dirty-diff-peek-header) {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 33px;
  padding: 0 8px;
  border-bottom: 1px solid var(--dirty-diff-peek-border);
  background: var(--dirty-diff-peek-header);
}

:global(.dirty-diff-peek-title) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-subtle);
  font-family: var(--font);
  font-size: 11px;
}

:global(.dirty-diff-peek-actions) {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

:global(.dirty-diff-peek-button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg-muted);
  font: 16px/1 codicon;
  cursor: pointer;
}

:global(.dirty-diff-peek-button:hover) {
  background: var(--hover);
  color: var(--fg);
}

:global(.dirty-diff-peek-line) {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  min-height: 21px;
}

:global(.dirty-diff-peek-removed) {
  background: var(--dirty-diff-peek-removed-bg);
}

:global(.dirty-diff-peek-number) {
  padding-right: 12px;
  color: var(--fg-subtle);
  text-align: right;
  user-select: none;
}

:global(.dirty-diff-peek-code) {
  overflow: hidden;
  padding-left: 8px;
  border-left: 1px solid var(--dirty-diff-peek-border);
  white-space: pre;
}

.fe-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.fe-monaco {
  width: 100%;
  height: 100%;
  min-width: 0;
}

.fe-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

/* 选中文本后的“添加到对话”浮动按钮（样式与 DiffViewer 的 diff-selection-action 一致） */
.fe-selection-action {
  position: fixed;
  z-index: 1000;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  box-shadow: 0 5px 16px rgba(0, 0, 0, 0.16);
  color: var(--fg-2);
  cursor: pointer;
  font: 600 12px var(--sans);
}

.fe-selection-action:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-2);
}

.fe-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: var(--bg);
}

.fe-error {
  color: var(--danger);
  padding: 24px;
  text-align: center;
}
</style>
