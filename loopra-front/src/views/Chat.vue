<template>
  <div class="chat">
    <!-- 可选头部 -->
    <div v-if="!hideHeader" class="chat-head">
      <span class="chat-head-title">对话</span>
      <span class="chat-head-count">{{ messages.length }} 条</span>
      <div style="flex:1"></div>
      <button class="btn btn-ghost btn-sm" @click="clearChat">清空</button>
      <button class="btn btn-ghost btn-sm" @click="exportChat">导出</button>
        <button :disabled="loadingPrompt" class="btn btn-ghost btn-sm" @click="viewSystemPrompt">提示词</button>
    </div>

    <!-- 流式加载动画横线：本地流式或服务端后台执行中均展示（会话正在执行）；桌面端由外层布局接管（streamingBarHidden） -->
    <div v-if="!streamingBarHidden && (streaming || sessionTaskRunning)" class="streaming-bar">
      <div class="streaming-bar-inner"></div>
    </div>

    <!-- 悬浮日志通知（全局，不受消息滚动影响） -->
    <div class="log-stack">
      <TransitionGroup name="log-bar">
        <div v-for="log in currentLogs" :key="log.id" :class="'log-' + (log.level || 'info').toLowerCase()"
             class="log-bar"
             title="点击复制完整日志"
             @click="copyLog(log)">
          <span class="log-bar-icon">📋</span>
          <span class="log-bar-text">{{ log.text }}</span>
          <span class="log-bar-time">{{ formatTime(log.time) }}</span>
          <button class="log-bar-close" title="关闭通知" @click.stop="currentLogs = currentLogs.filter(l => l.id !== log.id)">✕</button>
        </div>
      </TransitionGroup>
    </div>

    <!-- 消息区 -->
    <div ref="messagesContainer" class="messages" :style="messagesBottomStyle" :class="{
      'messages-welcome': !props.sessionName || messages.length === 0,
      'messages-with-queue': queuedMessages.length > 0
    }">
      <!-- 空状态：无会话或新建的空会话（子代理会话模式不展示欢迎页） -->
      <div v-if="!props.sessionName || (messages.length === 0 && !props.subAgent)" class="empty welcome-screen">
        <section class="welcome-panel">
          <div v-if="store.isDesktopEnv" class="desktop-chat-welcome-title">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="L"><rect x="7" y="7" width="34" height="34" rx="8"/><path d="M18 14v20h13" stroke-width="3.5" stroke-linecap="square"/></svg>
            <button v-if="selectedWelcomeWorkspace" class="desktop-chat-welcome-workspace" type="button" :aria-expanded="welcomeWorkspaceMenuOpen" aria-haspopup="menu" @click="toggleWelcomeWorkspace">{{ selectedWelcomeWorkspace.name }}</button>
            <h1>{{ welcomeGreeting }}</h1>
          </div>
          <h1 v-else class="welcome-heading" aria-label="Loopra">
            <svg viewBox="0 0 174 42" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 6H6V30H24V36H0V6Z"/>
              <path fill-rule="evenodd" d="M30 6H54V36H30V6ZM36 12V30H48V12H36Z"/>
              <path fill-rule="evenodd" d="M60 6H84V36H60V6ZM66 12V30H78V12H66Z"/>
              <path fill-rule="evenodd" d="M90 6H114V36H96V42H90V6ZM96 12V30H108V12H96Z"/>
              <path d="M120 6H126V12H132V6H144V12H132V18H126V36H120V6Z"/>
              <path d="M156 6H174V36H150V18H168V12H156V18H150V12H156V6ZM156 24V30H168V24H156Z" fill-rule="evenodd"/>
            </svg>
          </h1>
          <div class="welcome-composer" :class="{ 'workspace-menu-open': welcomeWorkspaceMenuOpen }">
            <div ref="welcomeWorkspaceRow" class="welcome-workspace-row">
              <button class="welcome-workspace-button" type="button" @click="toggleWelcomeWorkspace">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>
                <span>{{ selectedWelcomeWorkspace?.name || '选择项目' }}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div v-if="welcomeWorkspaceMenuOpen" ref="welcomeWorkspaceMenu" class="welcome-workspace-menu"
                   :class="{ 'opens-above': welcomeWorkspaceMenuPlacement === 'above' }"
                   :style="{ '--welcome-workspace-menu-max-height': `${welcomeWorkspaceMenuMaxHeight}px` }">
                <div class="welcome-workspace-menu-actions">
                  <button class="welcome-workspace-manage" type="button" @click="openWelcomeWorkspaceManager">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10v6m-3-3h6"/></svg>
                    项目管理
                  </button>
                </div>
                <div class="welcome-workspace-list">
                  <button v-for="workspace in workspaces" :key="workspace.hash" type="button"
                          :class="{ active: workspace.hash === welcomeWorkspaceHash }"
                          @click="selectWelcomeWorkspace(workspace.hash)">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>
                    {{ workspace.name }}
                  </button>
                  <span v-if="workspaces.length === 0" class="welcome-workspace-empty">暂无可用项目</span>
                </div>
              </div>
              <div v-if="store.isDesktopEnv && props.sessionName" class="welcome-environment-switch" aria-label="任务环境">
                <button type="button" :class="{ active: !props.welcomeWorktreeMode }" :disabled="sessionTaskRunning || props.environmentSwitching" @click="selectWelcomeEnvironment(false)">
                  <span v-if="props.environmentSwitching && props.environmentSwitchTarget === 'local'" class="welcome-environment-spinner" />
                  本地
                </button>
                <button type="button" :class="{ active: props.welcomeWorktreeMode }" :disabled="sessionTaskRunning || props.environmentSwitching" @click="selectWelcomeEnvironment(true)">
                  <span v-if="props.environmentSwitching && props.environmentSwitchTarget === 'worktree'" class="welcome-environment-spinner" />
                  隔离分支
                </button>
              </div>
            </div>
            <ChatInput ref="welcomeInput" welcome-mode v-model:input-text="welcomeText" :usage="usage" :current-model="currentModel" :default-model="defaultModel" :default-model-channel-id="defaultModelChannelId" :setting-default-model="settingDefaultModel" :available-models="availableModels"
                       :initially-empty="props.initiallyEmpty"
                       :current-reasoning-effort="currentReasoningEffort" :terminate-on-no-tool-call="terminateOnNoToolCall" :fast-mode="currentFastMode" :current-permission="currentPermission"
                       :workspace-hash="welcomeWorkspaceHash" :session-name="props.sessionName" :plan-mode="planMode"
                       :session-running="sessionTaskRunning" :session-busy="sessionBusy" :session-status-stopping="sessionStatusStopping"
                       :current-skill="currentSkill" @send="sendWelcomeMessage" @toggle-plan="togglePlan" @switch-model="handleSwitchModel" @set-default-model="handleSetDefaultModel"
                       @switch-reasoning-effort="handleSwitchReasoningEffort" @switch-terminate-on-no-tool-call="handleSwitchTerminateOnNoToolCall" @switch-fast-mode="handleSwitchFastMode"
                       @switch-permission="handleSwitchPermission" @switch-skill="handleSwitchSkill" @picker-open="handleWelcomePickerOpen" @refresh-models="loadUsage" @manage-models="$emit('manageModels')" />
          </div>
        </section>
      </div>

      <!-- 子代理会话加载中占位（事件尚未拉取完成） -->
      <div v-else-if="props.subAgent && messages.length === 0" class="empty sub-agent-loading">
        <div class="ai-preparing">
          <span class="ai-dot"></span>
          <span class="ai-dot"></span>
          <span class="ai-dot"></span>
          <span class="ai-label">子代理会话加载中...</span>
        </div>
      </div>

      <!-- 消息列表：仅挂载可视区域附近的消息，保留上下占位以维持滚动位置。 -->
      <div v-if="virtualWindow.topHeight" class="virtual-spacer" :style="{ height: virtualWindow.topHeight + 'px' }"></div>
      <div v-for="item in virtualWindow.items" :key="item.msg.id"
           :ref="el => observeMessage(item.msg.id, el)"
           class="virtual-message-item"
           :class="{ 'message-role-transition': item.idx > 0 && messages[item.idx - 1]?.role !== item.msg.role }">
        <ChatMessage
            v-memo="[
              item.msg.id,
              item.msg.content,
              item.msg.blocks?.length,
              item.msg.rollbackId,
              item.msg.snapshotId,
              item.msg.rollbackTimestamp,
              item.msg.turnStartedAt,
              item.msg.turnFinishedAt,
              item.msg.elapsedMs,
              item.msg.startedAt,
              item.msg.finishedAt,
              item.idx === activeAssistantMessageIndex ? streamRenderVersion : 0,
              streaming,
              branchingSession,
              snapshotRollbackLoading.get(item.msg.rollbackId || item.msg.snapshotId || item.msg.rollbackTimestamp)
            ]"
            :idx="item.idx"
            :msg="item.msg"
            :workspace-path="activeWorkspacePath"
            :streaming="item.idx === activeAssistantMessageIndex"
            :snapshot-rollback-loading="snapshotRollbackLoading"
            :rollback-disabled="streaming"
            :branch-disabled="streaming || branchingSession"
            :interactive="!isSubAgentMode"
            @preview-image="previewImage"
            @rollback-snapshot="openRollbackDialog"
            @copy-message="copyMessage"
            @branch-session="branchSession"
            @send-choice="sendChoice"
            @open-file="openFile"
            @open-diff="openStoredDiff"
            @revert-file-changes="openFileRevertDialog"
            @view-raw-events="openRawEvents"
        />
      </div>
      <div v-if="virtualWindow.bottomHeight" class="virtual-spacer" :style="{ height: virtualWindow.bottomHeight + 'px' }"></div>



      <!-- 加载中：AI 准备中 -->
      <div v-if="waitingForAI" class="msg assistant">
        <div class="msg-body assistant-body">
          <div class="ai-preparing">
            <span class="ai-dot"></span>
            <span class="ai-dot"></span>
            <span class="ai-dot"></span>
            <span class="ai-label">AI 正在思考...</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 工作流 TODO 指示器（已迁移至 ChatInput 组件中） -->

    <!-- 消息缩略图 dock（右侧 dock 栏，仅用户消息） -->
    <div v-if="userMessages.length > 0" class="msg-thumb-dock">
      <div class="thumb-dock-inner">
        <div
          v-for="(um, ui) in userMessages"
          :key="um.id"
          class="thumb-item"
          @click="jumpToMessage(um.globalIdx)"
        >
          <span class="thumb-indicator"></span>
          <span class="thumb-preview">{{ truncateText(um.content, 40) }}</span>
        </div>
      </div>
    </div>

    <!-- 滚动到底部按钮（固定在消息区右下角） -->
    <button v-show="showScrollBtn" class="scroll-bottom-btn" @click="scrollToBottom" title="滚动到底部">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="7 13 12 18 17 13"/>
        <line x1="12" y1="18" x2="12" y2="6"/>
      </svg>
    </button>

    <!-- 一键折叠所有展开的折叠块（固定在滚动到底部按钮上方） -->
    <button v-if="hasHistory" class="collapse-all-btn" title="一键折叠所有展开的块" @click="collapseAllBlocks">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="7.41 4.5 12 9 16.59 4.5"/>
        <polyline points="7.41 19.5 12 15 16.59 19.5"/>
      </svg>
    </button>

    <!-- 系统提示词 Modal -->
    <Teleport to="body">
      <div v-if="promptModalOpen" class="prompt-modal-overlay" @click.self="promptModalOpen = false">
        <div class="prompt-modal">
          <div class="prompt-modal-head">
            <h3>系统提示词</h3>
            <span class="prompt-modal-size">{{ promptLength }} 字符</span>
            <div style="flex:1"></div>
            <button class="prompt-modal-close" @click="promptModalOpen = false">&times;</button>
          </div>
          <div class="prompt-modal-body">
            <div class="prompt-modal-content" v-html="fmtPrompt(promptContent)"></div>
          </div>
          <div class="prompt-modal-foot">
            <button class="btn btn-sm" @click="copyPrompt">复制</button>
            <button class="btn btn-sm" @click="promptModalOpen = false">关闭</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 图片预览弹窗 -->
    <Teleport to="body">
      <div v-if="imagePreviewOpen" class="image-preview-overlay" role="dialog" aria-modal="true" aria-label="图片预览" @click.self="closeImagePreview">
        <img :src="imagePreviewUrl" alt="图片预览" class="image-preview-full"/>
        <button type="button" class="image-preview-close" aria-label="关闭图片预览" title="关闭" @click="closeImagePreview">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </Teleport>

    <!-- Diff 查看器弹窗（复用 DiffViewer 组件） -->
    <DiffViewer
        :open="diffViewer.open"
        :file="diffViewer.file"
        :diff="diffViewer.diff"
        :content="diffViewer.content"
        :mode="diffViewer.mode"
        :loading="diffViewer.loading"
        :stat="diffViewer.stat"
        @close="closeDiffViewer"
        @change-mode="changeDiffViewerMode"
    />

    <!-- 原始事件日志弹窗：上下文压缩前的消息与 tool result -->
    <Teleport to="body">
      <div v-if="rawEventsOpen" class="raw-events-overlay" @click.self="closeRawEvents">
        <div class="raw-events-modal">
          <div class="raw-events-head">
            <h3>原始记录</h3>
            <span class="raw-events-count">{{ rawEventItems.length }} 条</span>
            <div style="flex:1"></div>
            <button class="raw-events-close" type="button" aria-label="关闭" @click="closeRawEvents">&times;</button>
          </div>
          <div class="raw-events-body">
            <div v-if="rawEventsLoading" class="raw-events-empty">加载中...</div>
            <div v-else-if="rawEventsError" class="raw-events-empty">{{ rawEventsError }}</div>
            <div v-else-if="rawEventItems.length === 0" class="raw-events-empty">暂无原始记录</div>
            <div v-else class="raw-events-list">
              <div v-for="(item, i) in rawEventItems" :key="item.id" class="raw-event" :class="'raw-event-' + item.role">
                <div class="raw-event-head">
                  <span class="raw-event-role">{{ rawEventRoleLabel(item.role) }}</span>
                  <span v-if="item.webHidden" class="raw-event-tag">隐藏消息</span>
                  <span class="raw-event-time">{{ item.time }}</span>
                  <span class="raw-event-spacer"></span>
                  <span v-if="item.role === 'assistant' && item.blocks.length" class="raw-event-count">{{ item.blocks.length }} 块</span>
                </div>
                <div v-if="item.role === 'user'" class="raw-event-user">
                  <template v-if="item.content">{{ item.content }}</template>
                  <template v-else-if="item.images?.length">
                    <span v-for="(img, ii) in item.images" :key="ii" class="raw-event-image" :title="img">{{ img }}</span>
                  </template>
                  <span v-else class="raw-event-empty">（空消息）</span>
                </div>
                <BlockRenderer v-else :blocks="item.blocks" />
              </div>
              <div v-if="rawEventExtras.length" class="raw-event-extra-title">未归属到消息的工具结果</div>
              <div v-for="(event, i) in rawEventExtras" :key="'extra-' + i" class="raw-event raw-event-tool">
                <div class="raw-event-head">
                  <span class="raw-event-role">工具结果</span>
                  <span v-if="event.tool_call_id" class="raw-event-tool">tool_call_id: {{ event.tool_call_id }}</span>
                </div>
                <pre class="raw-event-content">{{ rawEventText(event) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 输入区（独立组件） -->
    <Transition name="welcome-input-drop">
    <ChatInput v-if="props.sessionName && (props.subAgent || messages.length > 0)"
        ref="chatInput"
        v-model:inputText="inputText"
        :streaming="streaming"
        :usage="usage"
        :currentModel="currentModel"
        :default-model="defaultModel"
        :default-model-channel-id="defaultModelChannelId"
        :setting-default-model="settingDefaultModel"
        :availableModels="availableModels"
        :currentReasoningEffort="currentReasoningEffort"
        :terminateOnNoToolCall="terminateOnNoToolCall"
        :fast-mode="currentFastMode"
        :workspaceHash="props.workspaceHash"
        :sessionName="props.sessionName"
        :initially-empty="props.initiallyEmpty"
        :rightPanelOpen="props.rightPanelOpen"
        :hasHistory="hasHistory"
        :version="props.version"
        :currentSkill="currentSkill"
        :currentPermission="currentPermission"
        :petState="petState"
        :queued-messages="queuedMessages"
        :session-running="isSubAgentMode ? (props.subAgent?.status === '运行中') : sessionTaskRunning"
        :session-busy="isSubAgentMode ? (props.subAgent?.status === '运行中') : sessionBusy"
        :session-status-stopping="isSubAgentMode ? false : sessionStatusStopping"
        :plan-mode="planMode"
        @send="(imgs, text, linkedProjectHashes) => sendMessage(imgs, text, null, props.sessionName, props.workspaceHash, undefined, null, undefined, linkedProjectHashes)"
        @toggle-plan="togglePlan"
        @remove-queued="removeQueuedMessage"
        @guide-queued="guideQueuedMessage"
        @abort="onAbort"
        @clear="onClear"
        @export="onExport"
        @refreshUsage="loadUsage"
        @switchModel="handleSwitchModel"
        @set-default-model="handleSetDefaultModel"
        @switchReasoningEffort="handleSwitchReasoningEffort"
        @switchTerminateOnNoToolCall="handleSwitchTerminateOnNoToolCall"
        @switchFastMode="handleSwitchFastMode"
        @refreshModels="loadUsage"
        @continue="continueChat"
        @switchSkill="handleSwitchSkill"
        @switchPermission="handleSwitchPermission"
        @manageModels="$emit('manageModels')"
    >
      <template #plan-review>
        <Transition name="plan-review">
          <section v-if="planMode" class="plan-review-band">
            <div class="plan-review-head">
              <FileTextOutlined class="plan-review-icon" />
              <strong>计划模式</strong>
              <span class="plan-review-status">{{ pendingPlan ? '待审查' : '只读探索' }}</span>
              <span v-if="pendingPlan" class="plan-review-chevron" aria-hidden="true"></span>
              <div class="plan-review-actions">
                <button v-if="pendingPlan" type="button" class="plan-approve-btn" :disabled="streaming || sessionBusy || planModeBusy" @click="approvePendingPlan">
                  <CheckOutlined />
                  批准并执行
                </button>
                <button type="button" class="plan-exit-btn" :disabled="streaming || sessionBusy || planModeBusy" title="退出计划模式" aria-label="退出计划模式" @click="togglePlan">
                  <CloseOutlined />
                </button>
              </div>
            </div>
            <div v-if="pendingPlan" class="plan-review-body">
              <div class="plan-review-content markdown-body" v-html="fmtPlan(pendingPlan)"></div>
            </div>
          </section>
        </Transition>
      </template>
    </ChatInput>
    </Transition>

    <ActionConfirmDialog
        :model-value="discardPlanDialog.visible"
        title="退出计划模式"
        :message="pendingPlan ? '待审查计划将被丢弃，且无法恢复。' : '将退出计划模式并恢复全部工具。'"
        :actions="discardPlanActions"
        :pending="planModeBusy"
        @update:model-value="value => { if (!value) closeDiscardPlanDialog() }"
        @action="handleDiscardPlanAction"
    />
    <ActionConfirmDialog
        :model-value="rollbackDialog.visible"
        title="撤回消息"
        message="将删除当前消息及其后的会话内容。撤回代码会将项目恢复到发送此消息前的状态。"
        :actions="rollbackActions"
        @update:model-value="value => { if (!value) closeRollbackDialog() }"
        @action="handleRollbackAction"
    />
    <ActionConfirmDialog
        :model-value="fileRevertDialog.visible"
        title="撤销本次代码修改"
        message="将按该回复记录的 diff 反向回打补丁，只撤销本次 AI 修改，不删除会话消息。文件在之后被修改过时会拒绝撤销。"
        :actions="fileRevertActions"
        :pending="fileRevertDialog.pending"
        @update:model-value="value => { if (!value) closeFileRevertDialog() }"
        @action="handleFileRevertAction"
    />
  </div>
</template>

<script setup>
import {computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect} from 'vue'
import {message} from 'ant-design-vue'
import {CheckOutlined, CloseOutlined, FileTextOutlined} from '@ant-design/icons-vue'
import {agentAPI, chatAPI, configAPI, gitAPI, sessionsAPI, snapshotAPI, subSessionsAPI} from '../services/api'
import {legacySessionSettingsStorage} from '../services/sessionSettingsStorage'
import {basicMarkdown} from '../utils/basicMarkdown'
import {sanitize} from '../utils/sanitize'
import {buildHistoryItems, mergeFileChanges, moveFileChangesToEnd} from '../utils/chatHistory'
import {applySubAgentEvent, findSubAgentBlock} from '../utils/subAgentBlocks'
import {getAssistantTurnBoundaries} from '../utils/sessionBranch'
import ChatInput from '../components/ChatInput.vue'
import ActionConfirmDialog from '../components/ActionConfirmDialog.vue'

const ChatMessage = defineAsyncComponent(() => import('../components/ChatMessage.vue'))
const DiffViewer = defineAsyncComponent(() => import('../components/DiffViewer.vue'))
const BlockRenderer = defineAsyncComponent(() => import('../components/BlockRenderer.vue'))

import {useAppStore} from '../stores/app'

// ============= 模型切换 =============
const handleSwitchModel = async (modelName, channelId) => {
  const currentChannelId = availableModels.value.find((model) => model.active)?.channelId
  if (modelName === currentModel.value && (!channelId || channelId === currentChannelId)) return
  if (props.sessionName) {
    const selection = {model: modelName, channelId: channelId || currentChannelId || ''}
    sessionModelSelections.value = {...sessionModelSelections.value, [conversationKey()]: selection}
    currentModel.value = modelName
    availableModels.value = availableModels.value.map(model => ({
      ...model,
      active: model.name === selection.model && (model.channelId || '') === selection.channelId
    }))
    try {
      await sessionsAPI.setSettings(props.sessionName, props.workspaceHash, {
        model: selection.model,
        modelChannelId: selection.channelId
      })
    } catch (e) {
      // 内存状态仍保留本次会话选择，后续聊天请求也会把显式设置同步到后端。
      console.error('持久化会话模型失败:', e)
    }
    return
  }
  try {
    const payload = {model: modelName}
    if (channelId) payload.modelChannelId = channelId
    const r = await configAPI.updateConfig(payload)
    if (r.success) {
      currentModel.value = modelName
      defaultModel.value = modelName
      defaultModelChannelId.value = channelId || currentChannelId || ''
      availableModels.value.forEach(m => {
        m.active = m.name === modelName && (!channelId || m.channelId === channelId)
      })
      loadUsage()
    }
  } catch (e) {
    console.error('切换模型失败:', e)
  }
}

const handleSetDefaultModel = async (modelName, channelId) => {
  if (!modelName || settingDefaultModel.value) return
  if (modelName === defaultModel.value && (channelId || '') === defaultModelChannelId.value) return
  settingDefaultModel.value = true
  try {
    const payload = {model: modelName}
    if (channelId) payload.modelChannelId = channelId
    const response = await configAPI.updateConfig(payload)
    if (response.success) {
      defaultModel.value = modelName
      defaultModelChannelId.value = channelId || defaultModelChannelId.value
      message.success('默认模型已更新')
      await loadUsage()
    }
  } catch (error) {
    console.error('设定默认模型失败:', error)
  } finally {
    settingDefaultModel.value = false
  }
}

// ============= 推理强度切换 =============
const currentReasoningEffort = ref('max')
const terminateOnNoToolCall = ref(true)
const currentFastMode = ref(false)

const handleSwitchReasoningEffort = async (value) => {
  const reasoningEffort = String(value || '').trim()
  if (!reasoningEffort || reasoningEffort === currentReasoningEffort.value) return
  sessionReasoningEfforts.value = {
    ...sessionReasoningEfforts.value,
    [conversationKey()]: reasoningEffort
  }
  currentReasoningEffort.value = reasoningEffort
  if (props.sessionName) {
    try {
      await sessionsAPI.setSettings(props.sessionName, props.workspaceHash, {reasoningEffort})
    } catch (e) {
      // 内存状态仍保留本次会话选择，后续聊天请求也会把显式设置同步到后端。
      console.error('持久化会话思考强度失败:', e)
    }
    return
  }
  try {
    // 未绑定具体会话时，才更新全局默认值。
    await configAPI.updateConfig({reasoningEffort})
  } catch (e) {
    console.error('持久化推理强度失败:', e)
  }
}

const handleSwitchTerminateOnNoToolCall = async (value) => {
  if (value === terminateOnNoToolCall.value) return
  try {
    const r = await configAPI.updateConfig({terminateOnNoToolCall: value})
    if (r.success) {
      terminateOnNoToolCall.value = value
    }
  } catch (e) {
    console.error('更新无工具调用结束策略失败:', e)
  }
}

const handleSwitchFastMode = async (value) => {
  const fastMode = !!value
  if (fastMode === currentFastMode.value) return
  sessionFastModes.value = {
    ...sessionFastModes.value,
    [conversationKey()]: fastMode
  }
  currentFastMode.value = fastMode
  try {
    // 输入框的选择既作为当前会话覆盖，也更新全局默认值，保证刷新和新会话仍能恢复。
    await configAPI.updateConfig({fastMode})
  } catch (e) {
    // 请求失败时会话级 localStorage 缓存仍可继续使用。
    console.error('持久化快速模式失败:', e)
  }
}

// ============= 技能切换（多选） =============
const currentSkill = ref([])
const handleSwitchSkill = (skills) => {
  currentSkill.value = skills
}

// ============= 权限切换（hitl） =============
const currentPermission = ref('free')
const handleSwitchPermission = async (mode) => {
  if (mode === currentPermission.value) return
  try {
    const r = await configAPI.updateConfig({hitl: mode})
    if (r.success) {
      currentPermission.value = mode
    }
  } catch (e) {
    console.error('切换权限模式失败:', e)
  }
}

const props = defineProps({
  hideHeader: {type: Boolean, default: false},
  streamingBarHidden: {type: Boolean, default: false},
  workspaceHash: {type: String, default: null},
  sessionName: {type: String, default: null},
  initiallyEmpty: {type: Boolean, default: false},
  rightPanelOpen: {type: Boolean, default: false},
  welcomeWorktreeMode: {type: Boolean, default: false},
  environmentSwitching: {type: Boolean, default: false},
  environmentSwitchTarget: {type: String, default: ''},
  workspaces: {type: Array, default: () => []},
  version: {type: String, default: ''},
  /** 子代理会话容器块（非 null 时进入子代理会话模式：复用聊天界面，数据源与发送通道切换） */
  subAgent: {type: Object, default: null}
})

const emit = defineEmits(['sessionUpdated', 'sessionBranched', 'startTask', 'switchWorkspace', 'manageWorkspaces', 'manageModels', 'sessionActiveChange', 'welcomeChange', 'refresh-sessions', 'environmentModeChange', 'subAgentEvent', 'initialLoadComplete'])
const store = useAppStore()

const messagesContainer = ref(null)
const inputText = ref('')
const chatInput = ref(null)
const welcomeInput = ref(null)
const welcomeText = ref('')
const welcomeWorkspaceHash = ref('')
const welcomeWorkspaceMenuOpen = ref(false)
const welcomeWorkspaceRow = ref(null)
const welcomeWorkspaceMenu = ref(null)
const welcomeWorkspaceMenuPlacement = ref('below')
const welcomeWorkspaceMenuMaxHeight = ref(248)
const welcomeModelMenuOpen = ref(false)
const welcomePermissionSelector = ref(null)
const welcomeEffortSelector = ref(null)
const welcomeSkillSelector = ref(null)

const selectedWelcomeWorkspace = computed(() =>
  props.workspaces.find(workspace => workspace.hash === welcomeWorkspaceHash.value)
)
const activeWorkspacePath = computed(() =>
  props.workspaces.find(workspace => workspace.hash === props.workspaceHash)?.path || ''
)

const welcomeGreetingPools = {
  morning: ['早上好，今天想从什么开始？', '早安，先定一个小目标吧。', '新的一天，准备好一起动手了吗？'],
  noon: ['中午好，忙里偷个闲，接下来想做什么？', '午间好，带着一个想法来聊聊吧。', '中午好，吃饱了吗？我们继续把事情做好。'],
  afternoon: ['下午好，灵感正适合落地。', '下午好，接下来想一起解决什么？', '午后好，慢慢来，把难题拆开就好。'],
  evening: ['晚上好，今天想完成点什么？', '晚上好，留一点时间给你的新想法。', '夜幕降临，准备好开始了吗？'],
  lateNight: ['深夜了，慢慢来，想从哪里开始？', '夜深了，我还在，陪你把想法理清。', '深夜灵感也很珍贵，今天想做点什么？']
}

const getWelcomeGreetingPeriod = (date = new Date()) => {
  const hour = date.getHours()
  if (hour < 5) return 'lateNight'
  if (hour < 11) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

const pickWelcomeGreeting = (period = getWelcomeGreetingPeriod()) => {
  const choices = welcomeGreetingPools[period] || welcomeGreetingPools.morning
  return choices[Math.floor(Math.random() * choices.length)]
}

const welcomeGreeting = ref(pickWelcomeGreeting())
const refreshWelcomeGreeting = () => {
  welcomeGreeting.value = pickWelcomeGreeting()
}


watch(() => props.workspaceHash, (hash) => {
  if (hash) welcomeWorkspaceHash.value = hash
}, {immediate: true})

watch(() => props.workspaces, (workspaces) => {
  if (workspaces.length && !workspaces.some(workspace => workspace.hash === welcomeWorkspaceHash.value)) {
    welcomeWorkspaceHash.value = workspaces[0].hash
  }
}, {immediate: true})


const selectWelcomeWorkspace = (workspaceHash) => {
  welcomeWorkspaceMenuOpen.value = false
  emit('switchWorkspace', workspaceHash)
}

const openWelcomeWorkspaceManager = () => {
  welcomeWorkspaceMenuOpen.value = false
  emit('manageWorkspaces')
}

const updateWelcomeWorkspaceMenuPlacement = () => {
  if (!welcomeWorkspaceMenuOpen.value || !welcomeWorkspaceRow.value) return

  const rowRect = welcomeWorkspaceRow.value.getBoundingClientRect()
  const boundaryRect = messagesContainer.value?.getBoundingClientRect?.()
  const hasBoundary = boundaryRect && boundaryRect.height > 0
  const viewportTop = hasBoundary ? boundaryRect.top : 0
  const viewportBottom = hasBoundary
    ? boundaryRect.bottom
    : (typeof window !== 'undefined' ? window.innerHeight : 768)
  const menuHeight = welcomeWorkspaceMenu.value?.offsetHeight || 248
  const gap = 8
  const spaceAbove = Math.max(0, rowRect.top - viewportTop - gap)
  const spaceBelow = Math.max(0, viewportBottom - rowRect.bottom - gap)
  const opensAbove = spaceBelow < menuHeight && spaceAbove > spaceBelow
  const availableSpace = opensAbove ? spaceAbove : spaceBelow

  welcomeWorkspaceMenuPlacement.value = opensAbove ? 'above' : 'below'
  welcomeWorkspaceMenuMaxHeight.value = Math.max(0, Math.min(248, availableSpace))
}

const handleWelcomeWorkspaceViewportChange = () => {
  if (welcomeWorkspaceMenuOpen.value) updateWelcomeWorkspaceMenuPlacement()
}

const closeWelcomeMenus = (except = '') => {
  if (except !== 'workspace') welcomeWorkspaceMenuOpen.value = false
  if (except !== 'model') welcomeModelMenuOpen.value = false
  if (except !== 'permission') welcomePermissionSelector.value?.close()
  if (except !== 'effort') welcomeEffortSelector.value?.close()
  if (except !== 'skill') welcomeSkillSelector.value?.close()
}

const toggleWelcomeWorkspace = () => {
  const nextOpen = !welcomeWorkspaceMenuOpen.value
  closeWelcomeMenus('workspace')
  if (nextOpen) {
    welcomeInput.value?.closePickers?.()
    welcomeWorkspaceMenuPlacement.value = 'below'
    welcomeWorkspaceMenuMaxHeight.value = 248
    welcomeWorkspaceMenuOpen.value = true
    nextTick(updateWelcomeWorkspaceMenuPlacement)
    return
  }
  welcomeWorkspaceMenuOpen.value = nextOpen
}

const handleWelcomePickerOpen = () => {
  closeWelcomeMenus()
}

const selectWelcomeEnvironment = (worktreeMode) => {
  closeWelcomeMenus()
  emit('environmentModeChange', !!worktreeMode)
}

const toggleWelcomeModel = () => {
  const nextOpen = !welcomeModelMenuOpen.value
  closeWelcomeMenus('model')
  welcomeModelMenuOpen.value = nextOpen
}

const handleWelcomeOutsideClick = (event) => {
  const target = event.target
  if (target.closest('.desktop-chat-welcome-workspace, .welcome-workspace-row, .welcome-model-selector, .permission-selector, .reasoning-selector, .skill-selector')) return
  closeWelcomeMenus()
}

const selectWelcomeModel = async (modelName) => {
  welcomeModelMenuOpen.value = false
  await handleSwitchModel(modelName)
}


const sendWelcomeMessage = async (images, messageText) => {
  // 不拦截发送：会话后台运行/状态检查中 sendMessage 会自动排队，不会静默丢弃
  const prompt = messageText?.trim()
  if (!prompt) return

  if (props.sessionName) {
    welcomeText.value = ''
    await sendMessage(images, prompt)
    return
  }

  if (!welcomeWorkspaceHash.value) return
  welcomeText.value = ''
  emit('startTask', {prompt, workspaceHash: welcomeWorkspaceHash.value})
}

// 快照检查点：msgId -> snapshotId 映射（用于消息关联和撤回按钮显示）
const snapshotMap = ref(new Map())
const snapshotRollbackLoading = ref(new Map()) // msgId -> 是否正在撤回
const rollbackDialog = ref({visible: false, msgId: null, canRollbackCode: false})
const fileRevertDialog = ref({visible: false, pending: false, changes: []})
const fileRevertActions = [{key: 'cancel', label: '取消'}, {key: 'revert', label: '撤销代码', variant: 'danger'}]
const rollbackActions = computed(() => {
  const actions = [
    {key: 'cancel', label: '取消'},
    {key: 'message', label: '只撤回消息', variant: 'accent'}
  ]
  if (rollbackDialog.value.canRollbackCode) {
    actions.push({key: 'code', label: '撤回消息和代码', variant: 'danger'})
  }
  return actions
})

// 图片预览
const imagePreviewUrl = ref('')
const imagePreviewOpen = ref(false)
const previewImage = (url) => {
  imagePreviewUrl.value = url
  imagePreviewOpen.value = true
}
const closeImagePreview = () => {
  imagePreviewOpen.value = false
  imagePreviewUrl.value = ''
}
const handleImagePreviewKeydown = (event) => {
  if (event.key === 'Escape' && imagePreviewOpen.value) closeImagePreview()
}

// Diff 查看器
const diffViewer = ref({ open: false, file: '', diff: '', content: '', mode: 'content', loading: false, stat: '', diffStat: '', contentLoaded: false, contentExists: false, diffLoaded: false })

const loadDiffViewerContent = async () => {
  const file = diffViewer.value.file
  if (!file) return
  diffViewer.value.loading = true
  try {
    const r = await gitAPI.workingFileContent(props.workspaceHash, file)
    if (r.success && r.data) {
      if (diffViewer.value.file !== file || !diffViewer.value.open) return
      diffViewer.value.content = r.data.content ?? r.data.message ?? ''
      diffViewer.value.contentLoaded = true
      diffViewer.value.contentExists = Boolean(r.data.exists)
      if (diffViewer.value.mode === 'content') diffViewer.value.stat = diffViewer.value.contentExists ? '当前文件' : '文件不可用'
    }
  } catch (e) {
    if (diffViewer.value.file === file && diffViewer.value.open) {
      diffViewer.value.content = '加载文件失败: ' + (e.message || '')
      diffViewer.value.contentLoaded = true
    }
  } finally {
    if (diffViewer.value.file === file && diffViewer.value.open) diffViewer.value.loading = false
  }
}

const loadDiffViewerDiff = async () => {
  const file = diffViewer.value.file
  if (!file) return
  diffViewer.value.loading = true
  try {
    const r = await gitAPI.diffContent(props.workspaceHash, file)
    if (r.success && r.data) {
      if (diffViewer.value.file !== file || !diffViewer.value.open) return
      diffViewer.value.diff = r.data.diff || ''
      diffViewer.value.diffLoaded = true
      diffViewer.value.diffStat = r.data.stat || ''
      if (diffViewer.value.mode === 'diff') diffViewer.value.stat = diffViewer.value.diffStat
    }
  } catch (e) {
    if (diffViewer.value.file === file && diffViewer.value.open) {
      diffViewer.value.diff = '加载 Git diff 失败: ' + (e.message || '')
      diffViewer.value.diffLoaded = true
    }
  } finally {
    if (diffViewer.value.file === file && diffViewer.value.open) diffViewer.value.loading = false
  }
}

const changeDiffViewerMode = async (mode) => {
  if (!diffViewer.value.open || diffViewer.value.mode === mode) return
  diffViewer.value.mode = mode
  if (mode === 'content') {
    diffViewer.value.stat = diffViewer.value.contentLoaded ? (diffViewer.value.contentExists ? '当前文件' : '文件不可用') : ''
    if (!diffViewer.value.contentLoaded) await loadDiffViewerContent()
  }
  if (mode === 'diff') {
    diffViewer.value.stat = diffViewer.value.diffStat
    if (!diffViewer.value.diffLoaded) await loadDiffViewerDiff()
  }
}

const openDiff = async (filePath) => {
  diffViewer.value = { open: true, file: filePath, diff: '', content: '', mode: 'content', loading: true, stat: '当前文件', diffStat: '', contentLoaded: false, contentExists: false, diffLoaded: false }
  await loadDiffViewerContent()
}
const openStoredDiff = (change) => {
  // AI 消息底部的文件变更列表：点击默认展示 Git Diff（diff 已随 change 内联保存，无需等待）
  diffViewer.value = {
    open: true,
    file: change?.path || '',
    diff: change?.diff || '此历史记录没有保存差异快照。',
    content: '',
    mode: 'diff',
    loading: false,
    stat: `+${change?.additions || 0} -${change?.deletions || 0}`,
    diffStat: `+${change?.additions || 0} -${change?.deletions || 0}`,
    contentLoaded: false,
    contentExists: false,
    diffLoaded: true
  }
  // 当前文件内容懒加载：切到「当前文件」标签时由 changeDiffViewerMode 触发，避免打开 diff 时白等 content
}
const closeDiffViewer = () => {
  diffViewer.value = { open: false, file: '', diff: '', content: '', mode: 'content', loading: false, stat: '', diffStat: '', contentLoaded: false, contentExists: false, diffLoaded: false }
}

// 原始事件日志（上下文压缩前的消息与 tool result）
const rawEventsOpen = ref(false)
const rawEventsLoading = ref(false)
const rawEventsError = ref('')
const rawEvents = ref([])
const rawEventItems = ref([])
const rawEventExtras = ref([])

const openRawEvents = async () => {
  const workspaceHash = props.workspaceHash
  const sessionName = props.sessionName
  if (!workspaceHash || !sessionName) return
  rawEventsOpen.value = true
  rawEventsLoading.value = true
  rawEventsError.value = ''
  rawEvents.value = []
  try {
    const res = await agentAPI.getRawEvents(workspaceHash, sessionName)
    if (res?.success) {
      rawEvents.value = Array.isArray(res.data) ? res.data : []
      const built = buildHistoryItems(rawEvents.value, true)
      rawEventItems.value = built.items
      rawEventExtras.value = built.unmergedToolResults
    } else {
      rawEventsError.value = res?.message || '加载原始记录失败'
    }
  } catch (e) {
    rawEventsError.value = '加载原始记录失败: ' + (e?.message || '')
  } finally {
    rawEventsLoading.value = false
  }
}

const closeRawEvents = () => {
  rawEventsOpen.value = false
  rawEventsLoading.value = false
  rawEventsError.value = ''
  rawEvents.value = []
  rawEventItems.value = []
  rawEventExtras.value = []
}

const rawEventRoleLabel = (role) => {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'tool') return '工具结果'
  return role || '未知'
}

const rawEventText = (event) => {
  if (!event) return ''
  if (typeof event.content === 'string' && event.content) return event.content
  if (typeof event.contentParts === 'string' && event.contentParts) return event.contentParts
  if (Array.isArray(event.contentParts)) {
    const text = event.contentParts
      .map(part => (part && typeof part.text === 'string' ? part.text : part?.type || ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  if (Array.isArray(event.tool_calls) && event.tool_calls.length > 0) {
    return JSON.stringify(event.tool_calls, null, 2)
  }
  if (event.content != null) return String(event.content)
  return JSON.stringify(event, null, 2)
}

const messages = computed(() => props.subAgent ? subAgentMessages.value : store.getSessionMessages(props.sessionName))
const streaming = computed(() => isSubAgentMode.value
    ? props.subAgent?.status === '运行中'
    : store.getSessionStreaming(props.sessionName))

// ── 子代理会话模式：复用本组件，界面与主会话完全一致，数据源切换为子代理容器块 ──
// 容器块（tab.blocks）中 sub_user → 用户消息气泡，其余块累积为助手消息；
// 段落 id 按出现顺序固定，继续对话只追加，派生消息 id 保持稳定（虚拟滚动依赖）。
const isSubAgentMode = computed(() => !!props.subAgent)
// 子代理消息时间戳：不引用下方定义的 now（immediate watch 会提前求值本派生，触发 TDZ）
const subAgentMsgTime = () => new Date().toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit'})
const subAgentMessages = computed(() => {
  const blocks = props.subAgent?.blocks || []
  const msgs = []
  let assistant = null
  let assistantSeq = 0
  for (const b of blocks) {
    if (b.type === 'sub_user') {
      assistant = null
      msgs.push({
        id: 'sub-u-' + msgs.length,
        role: 'user',
        content: b.content || '',
        time: subAgentMsgTime(),
        snapshotId: null,
        rollbackId: null
      })
    } else {
      if (!assistant) {
        assistant = {id: 'sub-a-' + (++assistantSeq), role: 'assistant', time: subAgentMsgTime(), blocks: []}
        msgs.push(assistant)
      }
      assistant.blocks.push(b)
    }
  }
  return msgs
})
const queuedMessagesBySession = ref({})
const SESSION_FAST_MODE_STORAGE_KEY = 'loopra.session-fast-modes'
const loadSessionFastModes = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_FAST_MODE_STORAGE_KEY) || '{}')
    return stored && typeof stored === 'object' ? stored : {}
  } catch {
    return {}
  }
}
const legacySessionSettings = legacySessionSettingsStorage.load()
const legacySessionModelSelections = ref(legacySessionSettings.modelSelections)
const legacySessionReasoningEfforts = ref(legacySessionSettings.reasoningEfforts)
// 模型和思考强度以服务端会话元数据为主；内存状态只用于当前页面的即时响应和旧数据迁移。
const sessionModelSelections = ref({})
const sessionReasoningEfforts = ref({})
const sessionFastModes = ref(loadSessionFastModes())
const conversationKey = (workspaceHash = props.workspaceHash, sessionName = props.sessionName) => `${workspaceHash || ''}::${sessionName || ''}`
const queuedMessages = computed(() => queuedMessagesBySession.value[conversationKey()] || [])
const guidingQueuedMessage = ref(false)

watch(sessionFastModes, modes => {
  localStorage.setItem(SESSION_FAST_MODE_STORAGE_KEY, JSON.stringify(modes))
}, {deep: true})

const getSessionModelSelection = (sessionName = props.sessionName, workspaceHash = props.workspaceHash) => {
  const key = conversationKey(workspaceHash, sessionName)
  const selected = sessionModelSelections.value[key] || legacySessionModelSelections.value[key]
  if (selected) return selected
  const active = availableModels.value.find(model => model.active)
  return {model: currentModel.value, channelId: active?.channelId || ''}
}

const getSessionReasoningEffort = (sessionName = props.sessionName, workspaceHash = props.workspaceHash) => (
  sessionReasoningEfforts.value[conversationKey(workspaceHash, sessionName)]
  || legacySessionReasoningEfforts.value[conversationKey(workspaceHash, sessionName)]
  || currentReasoningEffort.value
)

const getSessionFastMode = (sessionName = props.sessionName, workspaceHash = props.workspaceHash) => (
  sessionFastModes.value[conversationKey(workspaceHash, sessionName)] ?? currentFastMode.value
)

/** 将旧版浏览器缓存迁移到服务端会话设置；成功后删除对应旧值，避免形成第二个事实来源。 */
const migrateLegacySessionSettings = async (sessionName, workspaceHash, sessionKey) => {
  const legacySelection = legacySessionModelSelections.value[sessionKey]
  const legacyReasoningEffort = legacySessionReasoningEfforts.value[sessionKey]
  if ((!legacySelection && !legacyReasoningEffort) || typeof sessionsAPI.setSettings !== 'function') return null

  const payload = {}
  if (legacySelection?.model) payload.model = legacySelection.model
  if (legacySelection?.channelId) payload.modelChannelId = legacySelection.channelId
  if (legacyReasoningEffort) payload.reasoningEffort = legacyReasoningEffort
  if (Object.keys(payload).length === 0) return null

  try {
    const response = await sessionsAPI.setSettings(sessionName, workspaceHash, payload)
    if (!response?.success) return null
    const resolved = response.data || {}
    const migrated = {
      model: resolved.model || payload.model,
      modelChannelId: resolved.modelChannelId || payload.modelChannelId,
      reasoningEffort: resolved.reasoningEffort || payload.reasoningEffort
    }
    if (legacySelection) {
      const remaining = {...legacySessionModelSelections.value}
      delete remaining[sessionKey]
      legacySessionModelSelections.value = remaining
      legacySessionSettingsStorage.removeModelSelection(sessionKey)
    }
    if (legacyReasoningEffort) {
      const remaining = {...legacySessionReasoningEfforts.value}
      delete remaining[sessionKey]
      legacySessionReasoningEfforts.value = remaining
      legacySessionSettingsStorage.removeReasoningEffort(sessionKey)
    }
    return migrated
  } catch (error) {
    // 服务端暂不可用时保留旧值，当前页面仍可继续使用兼容回退。
    console.error('迁移旧版会话设置失败:', error)
    return null
  }
}

const addQueuedMessage = (sessionName, workspaceHash, images, text, modelSelection, reasoningEffort, fastMode, linkedProjectHashes = []) => {
  if (!sessionName) return
  const key = conversationKey(workspaceHash, sessionName)
  const queue = queuedMessagesBySession.value[key] || []
  queuedMessagesBySession.value = {
    ...queuedMessagesBySession.value,
    [key]: [...queue, {id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, workspaceHash, images, text, modelSelection, reasoningEffort, fastMode, linkedProjectHashes}]
  }
}

const takeQueuedMessage = (sessionName, workspaceHash, id) => {
  const key = conversationKey(workspaceHash, sessionName)
  const queue = queuedMessagesBySession.value[key] || []
  const item = queue.find(message => message.id === id)
  if (!item) return null
  queuedMessagesBySession.value = {
    ...queuedMessagesBySession.value,
    [key]: queue.filter(message => message.id !== id)
  }
  return item
}

const removeQueuedMessage = (id) => {
  takeQueuedMessage(props.sessionName, props.workspaceHash, id)
}

const sendNextQueuedMessage = async (sessionName, workspaceHash) => {
  if (!sessionName || store.getSessionStreaming(sessionName)) return
  if (sessionName === props.sessionName && sessionBusy.value && !streaming.value) return
  const queue = queuedMessagesBySession.value[conversationKey(workspaceHash, sessionName)] || []
  const next = queue[0]
  if (!next) return
  takeQueuedMessage(sessionName, workspaceHash, next.id)
  await sendMessage(next.images, next.text, next.modelSelection, sessionName, workspaceHash, next.reasoningEffort, null, next.fastMode, next.linkedProjectHashes)
}

/** 等待指定会话的 SSE 流被服务端主动关闭（streaming=false）。 */
const waitForStreamClosed = (sessionName, timeoutMs) => new Promise(resolve => {
  const started = Date.now()
  const timer = setInterval(() => {
    if (!store.getSessionStreaming(sessionName) || Date.now() - started > timeoutMs) {
      clearInterval(timer)
      resolve()
    }
  }, 200)
})

const guideQueuedMessage = async (id) => {
  if (guidingQueuedMessage.value) return
  guidingQueuedMessage.value = true
  try {
    const queued = takeQueuedMessage(props.sessionName, props.workspaceHash, id)
    if (!queued) return
    // 无条件中止当前生成：无论流式输出还是后台任务运行，都先停止再发送排队消息
    if (streaming.value || sessionTaskRunning.value) {
      await abortChat()
      // 与停止按钮语义一致：等旧 SSE 流真正关闭（streaming=false，即服务端主动断流）后再发送新消息。
      // 否则旧运行在 abort 后的残留事件（推理/正文增量）会与新运行事件交错，
      // 在同一气泡里呈现为“思考被拆成多段、内容碎片混排”。
      if (store.getSessionStreaming(props.sessionName)) {
        await waitForStreamClosed(props.sessionName, 10000)
      }
      if (store.getSessionStreaming(props.sessionName)) {
        // 超时兜底：服务端未及时关闭旧流。放回队列，由旧流结束回调（onDone → sendNextQueuedMessage）自动续发。
        addQueuedMessage(props.sessionName, queued.workspaceHash, queued.images, queued.text,
            queued.modelSelection, queued.reasoningEffort, queued.fastMode, queued.linkedProjectHashes)
        message.warning('等待停止超时，消息已放回队列；旧流结束后将自动发送')
        return
      }
    }
    await sendMessage(queued.images, queued.text, queued.modelSelection, props.sessionName, queued.workspaceHash, queued.reasoningEffort, null, queued.fastMode, queued.linkedProjectHashes)
  } finally {
    guidingQueuedMessage.value = false
  }
}

const ESTIMATED_MESSAGE_HEIGHT = 320
const VIRTUAL_OVERSCAN = 1200
const VIRTUALIZATION_THRESHOLD = 60
const messageKey = message => String(message.id)
const messageHeights = reactive(new Map())
const virtualScrollTop = ref(0)
const virtualViewportHeight = ref(0)
const virtualWindow = computed(() => {
  const total = messages.value.length
  const offsets = new Array(total + 1).fill(0)
  for (let index = 0; index < total; index++) {
    offsets[index + 1] = offsets[index] + (messageHeights.get(messageKey(messages.value[index])) || ESTIMATED_MESSAGE_HEIGHT)
  }

  if (total <= VIRTUALIZATION_THRESHOLD) {
    return {
      items: messages.value.map((msg, idx) => ({msg, idx})),
      topHeight: 0,
      bottomHeight: 0,
      offsets
    }
  }

  const startOffset = Math.max(0, virtualScrollTop.value - VIRTUAL_OVERSCAN)
  const endOffset = virtualScrollTop.value + virtualViewportHeight.value + VIRTUAL_OVERSCAN
  let start = 0
  while (start < total && offsets[start + 1] < startOffset) start++
  let end = start
  while (end < total && offsets[end] < endOffset) end++
  return {
    items: messages.value.slice(start, end).map((msg, offset) => ({msg, idx: start + offset})),
    topHeight: offsets[start],
    bottomHeight: offsets[total] - offsets[end],
    offsets
  }
})

let messageResizeObserver = null
let pendingScrollAdjustment = 0
let scrollAdjustmentFrame = 0
const observedMessageElements = new Map()
const observeMessage = (id, element) => {
  const key = String(id)
  const previous = observedMessageElements.get(key)
  if (!element) {
    if (previous) messageResizeObserver?.unobserve(previous)
    observedMessageElements.delete(key)
    return
  }
  if (previous && previous !== element) messageResizeObserver?.unobserve(previous)
  element.dataset.virtualMessageId = key
  observedMessageElements.set(key, element)
  messageResizeObserver?.observe(element)
}

const updateVirtualViewport = () => {
  const el = messagesContainer.value
  if (!el) return
  virtualScrollTop.value = el.scrollTop
  virtualViewportHeight.value = el.clientHeight
}

const firstVisibleMessageIndex = offsets => {
  let index = 0
  while (index < messages.value.length && offsets[index + 1] <= virtualScrollTop.value) index++
  return index
}

const compensateScroll = adjustment => {
  if (!adjustment) return
  pendingScrollAdjustment += adjustment
  if (scrollAdjustmentFrame) return
  scrollAdjustmentFrame = requestAnimationFrame(() => {
    const el = messagesContainer.value
    if (el) el.scrollTop += pendingScrollAdjustment
    pendingScrollAdjustment = 0
    scrollAdjustmentFrame = 0
    updateVirtualViewport()
  })
}

watch(() => messages.value.map(messageKey), ids => {
  const activeIds = new Set(ids)
  for (const id of messageHeights.keys()) {
    if (!activeIds.has(id)) messageHeights.delete(id)
  }
  nextTick(updateVirtualViewport)
})

watch(() => props.sessionName, () => {
  cancelBottomAnchor()
  messageHeights.clear()
  virtualScrollTop.value = 0
  rawEventsOpen.value = false
  rawEventsLoading.value = false
  rawEventsError.value = ''
  rawEvents.value = []
  rawEventItems.value = []
  rawEventExtras.value = []
  void focusComposer()
})

// Only the active streaming message needs to repatch for every server event.
const streamRenderVersion = ref(0)
const activeAssistantMessageIndex = computed(() => {
  if (!streaming.value) return -1
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant') return i
  }
  return -1
})
const branchingSession = ref(false)
const hasHistory = computed(() => messages.value.length > 0)
const planMode = ref(false)
const pendingPlan = ref(null)

// 会话级后台任务状态：请求序号保证旧会话的轮询结果不能覆盖当前会话。
const sessionTaskRunning = ref(false)
const sessionStatusChecking = ref(false)
const sessionStatusStopping = ref(false)
const sessionStatusRequestId = ref(null)
const sessionStatusToken = ref(0)
let sessionStatusTimer = null
let sessionStatusObservedRunning = false
let sessionStatusPollingStarted = false
const sessionStatusBusy = computed(() => sessionStatusChecking.value || sessionTaskRunning.value)
const sessionBusy = computed(() => sessionStatusBusy.value)

// 会话执行状态上报：外层布局（桌面端横跨两侧边栏的波动条）据此显隐（子代理模式不涉及主会话任务）
watch([streaming, sessionTaskRunning], ([s, r]) => {
  if (isSubAgentMode.value) return
  emit('sessionActiveChange', Boolean(s || r))
}, { immediate: true })

// 欢迎页（无会话或空会话）状态上报：外层布局据此收起左侧文件栏（子代理模式恒为非欢迎态）
const welcomeActive = computed(() => isSubAgentMode.value
    ? false
    : !props.sessionName || messages.value.length === 0)
watch(welcomeActive, (active) => {
  if (active) refreshWelcomeGreeting()
  emit('welcomeChange', active)
}, { immediate: true })

const isCurrentSessionStatus = (token, workspaceHash, sessionName) =>
  token === sessionStatusToken.value
  && workspaceHash === props.workspaceHash
  && sessionName === props.sessionName

const clearSessionStatusTimer = () => {
  if (sessionStatusTimer) {
    clearTimeout(sessionStatusTimer)
    sessionStatusTimer = null
  }
}

const resetSessionStatus = () => {
  sessionStatusToken.value++
  clearSessionStatusTimer()
  sessionTaskRunning.value = false
  sessionStatusChecking.value = false
  sessionStatusStopping.value = false
  sessionStatusRequestId.value = null
  sessionStatusObservedRunning = false
  sessionStatusPollingStarted = false
}

const scheduleSessionStatusPoll = (token, workspaceHash, sessionName) => {
  clearSessionStatusTimer()
  if (!isCurrentSessionStatus(token, workspaceHash, sessionName)) return
  sessionStatusTimer = setTimeout(() => {
    void pollSessionStatus(token, workspaceHash, sessionName)
  }, 3000)
}

const pollSessionStatus = async (token, workspaceHash, sessionName) => {
  if (!isCurrentSessionStatus(token, workspaceHash, sessionName)) return
  // 前端 SSE 流式运行中不发起自动刷新：此时本地消息即最新事实，
  // 轮询返回的持久化历史可能滞后（最后一条消息尚未完整落盘），
  // 整体替换会打断/吞掉正在流式输出的消息（表现为 AI 消息消失）。
  // 流结束后下一轮轮询自然恢复，后台运行状态感知不受影响。
  if (store.getSessionStreaming(sessionName)) {
    scheduleSessionStatusPoll(token, workspaceHash, sessionName)
    return
  }
  try {
    const response = await agentAPI.getSessionStatus(workspaceHash, sessionName)
    if (!isCurrentSessionStatus(token, workspaceHash, sessionName)) return

    const running = Boolean(response?.success && response.data?.running)
    if (running) sessionStatusObservedRunning = true
    sessionTaskRunning.value = running
    sessionStatusRequestId.value = response?.data?.requestId || null
    sessionStatusChecking.value = false

    // 运行期间每次状态采样都刷新一次持久化历史；停止后再做一次最终刷新。
    if (running || sessionStatusObservedRunning) {
      await loadHistory(sessionName, true, workspaceHash, token)
    }
    if (!running) {
      sessionStatusObservedRunning = false
      sessionStatusStopping.value = false
      if (!isCurrentSessionStatus(token, workspaceHash, sessionName)) return
      // 后台任务停止后补发排队消息：流结束瞬间任务状态可能仍为 running，
      // sendNextQueuedMessage 的 sessionBusy 守卫会暂停队列，这里兜底恢复
      if (queuedMessages.value.length > 0) nextTick(() => sendNextQueuedMessage(sessionName, workspaceHash))
    }
    scheduleSessionStatusPoll(token, workspaceHash, sessionName)
  } catch {
    // 状态未知时继续锁定发送入口，避免重复提交；轮询会自动重试且不弹出网络错误提示。
    if (!isCurrentSessionStatus(token, workspaceHash, sessionName)) return
    sessionStatusChecking.value = true
    scheduleSessionStatusPoll(token, workspaceHash, sessionName)
  }
}

const startSessionStatusPolling = (workspaceHash = props.workspaceHash, sessionName = props.sessionName) => {
  resetSessionStatus()
  if (!workspaceHash || !sessionName) return
  sessionStatusPollingStarted = true
  const token = sessionStatusToken.value
  sessionStatusChecking.value = true
  void pollSessionStatus(token, workspaceHash, sessionName)
}

// 输入区实际高度测量：消息区底部预留空间跟随输入区真实高度，
// 计划条/排队消息/用量条等高度变化时自动适配，避免遮挡消息
// （输入区自身含上下 padding 透明区，无需额外余量，精确对齐顶边）
const composerHeight = ref(0)
let composerResizeObserver = null
watchEffect(() => {
  const el = chatInput.value && chatInput.value.$el
  if (composerResizeObserver) {
    composerResizeObserver.disconnect()
    composerResizeObserver = null
  }
  if (!el) {
    composerHeight.value = 0
    return
  }
  composerResizeObserver = new ResizeObserver(entries => {
    composerHeight.value = entries[0].target.getBoundingClientRect().height
  })
  composerResizeObserver.observe(el)
  composerHeight.value = el.getBoundingClientRect().height
})
onBeforeUnmount(() => composerResizeObserver && composerResizeObserver.disconnect())

const messagesBottomStyle = computed(() =>
    composerHeight.value > 0 ? {paddingBottom: composerHeight.value + 'px'} : undefined)
const planModeBusy = ref(false)
const discardPlanDialog = ref({visible: false})
const discardPlanActions = [
  {key: 'cancel', label: '取消'},
  {key: 'discard', label: '退出计划模式', type: 'danger'}
]
let planModeRequestId = 0

// Usage 相关
const usage = ref({
  promptTokens: 0,
  completionTokens: 0,
  cacheHit: 0,
  cacheMiss: 0,
  maxContextTokens: 128000,
  lastPromptTokens: 0
})
let usageRequestId = 0
const currentModel = ref('')
const defaultModel = ref('')
const defaultModelChannelId = ref('')
const settingDefaultModel = ref(false)
const availableModels = ref([])

// ==================== 工作流 TODO（已迁移至 ChatInput 组件中）====================

const loadUsage = async (override) => {
  const requestId = ++usageRequestId
  try {
    const params = {}
    const wsHash = override?.workspaceHash ?? props.workspaceHash
    const sessName = override?.sessionName ?? props.sessionName
    if (wsHash) params.workspaceHash = wsHash
    if (sessName) params.sessionName = sessName

    const sessionSettingsRequest = wsHash && sessName && typeof sessionsAPI.getSettings === 'function'
      ? sessionsAPI.getSettings(sessName, wsHash)
      : Promise.resolve(null)
    const [usageRes, modelsRes, configRes, sessionSettingsRes] = await Promise.allSettled([
      wsHash && !override?.skipSessionUsage ? configAPI.getUsage(params) : Promise.resolve(null),
      configAPI.getModels(),
      configAPI.getConfig(),
      sessionSettingsRequest
    ])
    // 会话切换可能在请求返回前再次发生，过期响应不得覆盖当前会话的用量。
    if (requestId !== usageRequestId) return
    if (usageRes.status === 'fulfilled' && usageRes.value?.success) {
      usage.value = {...usage.value, ...usageRes.value.data}
    }
    const configuredModel = configRes.status === 'fulfilled' && configRes.value.success
      ? configRes.value.data?.model || ''
      : ''
    let sessionSettings = sessionSettingsRes.status === 'fulfilled' && sessionSettingsRes.value?.success
      ? sessionSettingsRes.value.data || {}
      : {}
    const sessionKey = conversationKey(wsHash, sessName)
    const migratedSettings = wsHash && sessName
      ? await migrateLegacySessionSettings(sessName, wsHash, sessionKey)
      : null
    if (migratedSettings) sessionSettings = {...sessionSettings, ...migratedSettings}
    // 迁移可能跨越一次会话切换，避免旧会话的设置覆盖新会话。
    if (requestId !== usageRequestId) return
    if (modelsRes.status === 'fulfilled' && modelsRes.value.success) {
      const defaultModel = modelsRes.value.data?.current
        || modelsRes.value.data?.models?.find(model => model.active)?.name
        || configuredModel
        || currentModel.value
      const defaultChannelId = modelsRes.value.data?.currentChannelId
        || modelsRes.value.data?.models?.find(model => model.active)?.channelId
        || ''
      const localSelection = sessionModelSelections.value[sessionKey]
        || legacySessionModelSelections.value[sessionKey]
      const selection = {
        model: localSelection?.model || sessionSettings.model || defaultModel,
        channelId: localSelection?.channelId || sessionSettings.modelChannelId || defaultChannelId
      }
      currentModel.value = selection.model
      availableModels.value = (modelsRes.value.data?.models || []).map(model => ({
        ...model,
        active: model.name === selection.model && (model.channelId || '') === selection.channelId
      }))
    }
    if (configRes.status === 'fulfilled' && configRes.value.success) {
      defaultModel.value = configuredModel
      defaultModelChannelId.value = configRes.value.data?.modelChannelId || ''
      if (!currentModel.value) currentModel.value = sessionSettings.model || configuredModel
      currentReasoningEffort.value = sessionReasoningEfforts.value[sessionKey]
        || legacySessionReasoningEfforts.value[sessionKey]
        || sessionSettings.reasoningEffort
        || configRes.value.data?.reasoningEffort || 'max'
      terminateOnNoToolCall.value = configRes.value.data?.terminateOnNoToolCall !== false
      currentFastMode.value = sessionFastModes.value[sessionKey]
        ?? configRes.value.data?.fastMode ?? false
      currentPermission.value = configRes.value.data?.hitl || 'free'
    }
  } catch {
  }
}

// 日志通知列表（逐条堆叠，每条6秒后自动移除）
const currentLogs = ref([])

const addLog = (log) => {
  const id = Date.now() + Math.random()
  currentLogs.value.unshift({...log, id})
  setTimeout(() => {
    currentLogs.value = currentLogs.value.filter(l => l.id !== id)
  }, 6000)
}

// 单击日志通知 → 复制完整日志（时间 + 内容），成功后再次弹出通知
const copyLog = async (log) => {
  const content = `[${formatTime(log.time)}] ${log.text}`
  try {
    await navigator.clipboard.writeText(content)
  } catch {
    // 剪贴板 API 不可用时退回 execCommand
    const textarea = document.createElement('textarea')
    textarea.value = content
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
  addLog({level: 'INFO', text: '✅ 日志已复制', time: Date.now()})
}

// Agent 调用 bash_start 时通知宿主自动展开右侧栏“命令”页签
const notifyBashStart = () => {
  window.dispatchEvent(new CustomEvent('loopra:bash-start', {
    detail: {workspaceHash: props.workspaceHash, sessionName: props.sessionName}
  }))
}

const formatTime = (t) => {
  if (!t) return ''
  const d = new Date(t)
  return d.toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'})
}

// 监听 workspace 和 session 变化，重新加载 usage 和计划状态
watch([() => props.workspaceHash, () => props.sessionName], ([ws, sess]) => {
  startSessionStatusPolling(ws, sess)
  if (ws || sess) loadUsage()
  syncPlanMode()
})

// 从后端同步计划模式状态（会话切换/页面刷新后恢复，服务端为唯一事实来源）
const syncPlanMode = async () => {
  const requestId = ++planModeRequestId
  const workspaceHash = props.workspaceHash
  const sessionName = props.sessionName
  if (!workspaceHash || !sessionName) {
    if (requestId === planModeRequestId) {
      planMode.value = false
      pendingPlan.value = null
    }
    return
  }
  try {
    const res = await agentAPI.getMode(workspaceHash, sessionName)
    if (requestId !== planModeRequestId || workspaceHash !== props.workspaceHash || sessionName !== props.sessionName) return
    planMode.value = !!(res && res.success && res.data && res.data.mode === 'plan')
    pendingPlan.value = res?.success ? (res.data?.pendingPlan || null) : null
  } catch (e) {
    if (requestId === planModeRequestId && workspaceHash === props.workspaceHash && sessionName === props.sessionName) {
      planMode.value = false
      pendingPlan.value = null
    }
  }
}

onMounted(() => {
  if (!props.subAgent) loadUsage(props.initiallyEmpty ? {skipSessionUsage: true} : undefined)
  if (!props.initiallyEmpty && !props.subAgent) startSessionStatusPolling()
  window.addEventListener('keydown', handleImagePreviewKeydown)
  window.addEventListener('resize', updateVirtualViewport)
  window.addEventListener('resize', handleWelcomeWorkspaceViewportChange)
  window.addEventListener('scroll', handleWelcomeWorkspaceViewportChange, true)
  // 监听复制成功事件
  window.addEventListener('copy-success', (e) => {
    addLog({level: 'INFO', text: '✅ ' + (e.detail || '已复制'), time: Date.now()})
  })
  // 通用通知事件（如后台进程手动关闭）
  window.addEventListener('app-notify', (e) => {
    addLog({level: 'INFO', text: e.detail || '', time: Date.now()})
  })
  messageResizeObserver = new ResizeObserver(entries => {
    const offsets = virtualWindow.value.offsets
    const firstVisible = firstVisibleMessageIndex(offsets)
    let adjustment = 0
    for (const entry of entries) {
      const id = entry.target.dataset.virtualMessageId
      const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height)
      const index = messages.value.findIndex(message => String(message.id) === id)
      const previousHeight = messageHeights.get(id) || ESTIMATED_MESSAGE_HEIGHT
      if (id && index >= 0 && height > 0 && previousHeight !== height) {
        if (index < firstVisible) adjustment += height - previousHeight
        messageHeights.set(id, height)
      }
    }
    compensateScroll(adjustment)
    nextTick(updateVirtualViewport)
  })
  for (const element of observedMessageElements.values()) {
    messageResizeObserver.observe(element)
  }
  // 监听消息容器滚动 + 初始检查
  const el = messagesContainer.value
  if (el) {
    el.addEventListener('scroll', onScroll)
    requestAnimationFrame(() => {
      updateVirtualViewport()
      onScroll()
    })
  }
})

onBeforeUnmount(() => {
  resetSessionStatus()
  cancelBottomAnchor()
  window.removeEventListener('keydown', handleImagePreviewKeydown)
  window.removeEventListener('resize', updateVirtualViewport)
  window.removeEventListener('resize', handleWelcomeWorkspaceViewportChange)
  window.removeEventListener('scroll', handleWelcomeWorkspaceViewportChange, true)
  messageResizeObserver?.disconnect()
  messageResizeObserver = null
  if (scrollAdjustmentFrame) cancelAnimationFrame(scrollAdjustmentFrame)
  scrollAdjustmentFrame = 0
  pendingScrollAdjustment = 0
  observedMessageElements.clear()
  window.removeEventListener('copy-success', () => {
  })
  const el = messagesContainer.value
  if (el) el.removeEventListener('scroll', onScroll)
})

const suggestions = ['解释这段代码', '优化这个函数', '写个单元测试', '检查潜在问题']

// 不在聊天区显示的静默命令（只发给后端，不加用户消息气泡）
const SILENT_CMDS = new Set(['/agree', '/deny', '/exit', '/continue'])

const hasAssistant = computed(() => {
  if (!streaming.value) return false
  // 检查最后一条助手消息是否有内容
  const msgs = messages.value
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      return msgs[i].blocks?.length > 0
    }
  }
  return false
})

// 是否正在等待 AI 回复（用于显示加载动画）
const waitingForAI = computed(() => {
  return streaming.value && !hasAssistant.value
})

// ── 宠物状态：根据流式事件推断当前阶段 ──
const petState = computed(() => {
  if (!streaming.value) return 'idle'
  // 等待 AI 响应
  if (!hasAssistant.value) return 'waiting'
  // 有流了，取最后一条 assistant 的最后一个 block 判断
  const msgs = messages.value
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].blocks?.length) {
      const lastBlock = msgs[i].blocks[msgs[i].blocks.length - 1]
      if (lastBlock.type === 'reasoning') return 'thinking'
      if (lastBlock.type === 'tool_call') return 'tool_call'
      if (lastBlock.type === 'content') return 'content'
    }
  }
  return 'waiting'
})

// ===== 消息缩略图 dock =====
/** 只取 role === 'user' 的消息，并记录全局索引用于跳转 */
const userMessages = computed(() => {
  return messages.value
    .map((m, idx) => ({...m, globalIdx: idx}))
    .filter(m => m.role === 'user')
})

/** 截取文本前 N 个字符 */
const truncateText = (text, max) => {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 点击缩略图跳转到对应消息 */
const jumpToMessage = (globalIdx) => {
  const el = messagesContainer.value
  const offset = virtualWindow.value.offsets[globalIdx]
  if (el && Number.isFinite(offset)) {
    el.scrollTo({top: offset, behavior: 'smooth'})
  }
}

const now = () => new Date().toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit'})

const assistantPreview = (blocks) => {
  if (!Array.isArray(blocks)) return ''
  const text = blocks.flatMap(block => {
    if (block?.type === 'content') return [block.content || '']
    if (block?.type === 'sub_agent') return assistantPreview(block.blocks)
    return []
  }).join(' ').replace(/\s+/g, ' ').trim()
  return text.length > 150 ? text.slice(0, 150) + '…' : text
}

const notifyAssistantReply = (msg) => {
  const preview = assistantPreview(msg?.blocks)
  if (!preview) return
  window.electronAPI?.desktopPet?.showReply(preview).catch?.(() => {})
}

// 全局函数：代码复制（被 onclick 引用）
window.copyCode = (btn) => {
  const wrap = btn.closest('.code-block-wrap')
  const code = wrap?.querySelector('code')?.textContent || ''
  navigator.clipboard.writeText(code).then(() => {
    window.dispatchEvent(new CustomEvent('copy-success', {detail: '代码已复制'}))
  }).catch(() => {
  })
}

// 系统提示词和计划预览不需要代码高亮，避免空会话加载完整高亮引擎。
const fmtPrompt = c => {
  if (!c) return ''
  return sanitize(basicMarkdown.render(c))
}

const fmtPlan = c => {
  if (!c) return ''
  return sanitize(basicMarkdown.render(c))
}

// 复制整条消息内容
const copyMessage = (msg) => {
  let text = ''
  if (msg.role === 'user') {
    text = msg.content || ''
  } else if (msg.role === 'assistant' && msg.blocks) {
    text = msg.blocks
        .filter(b => b.type === 'content' || b.type === 'reasoning')
        .map(b => b.content || '')
        .join('\n\n')
  }
  if (!text) return
  navigator.clipboard.writeText(text).then(() => {
    window.dispatchEvent(new CustomEvent('copy-success', {detail: '消息已复制'}))
  }).catch(() => {
  })
}

// 分支到新会话：复制当前消息及之前的消息到新会话
const branchSession = async (msg, msgIdx) => {
  if (!props.sessionName || !props.workspaceHash || streaming.value || sessionBusy.value || branchingSession.value) return
  branchingSession.value = true
  try {
    let count = msg.sourceMessageCount
    if (!count) {
      const history = await agentAPI.getHistory(props.workspaceHash, props.sessionName)
      const assistantOrdinal = messages.value.slice(0, msgIdx + 1)
          .filter(item => item.role === 'assistant').length - 1
      count = history.success ? getAssistantTurnBoundaries(history.data || [])[assistantOrdinal] : null
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('无法确定完整的助手消息边界')
    }
    const r = await sessionsAPI.branchSession(props.sessionName, props.workspaceHash, count)
    if (r.success && r.data?.sessionName) {
      window.dispatchEvent(new CustomEvent('copy-success', {detail: '已分支到新会话'}))
      emit('sessionBranched', r.data.sessionName)
    } else {
      window.dispatchEvent(new CustomEvent('copy-success', {detail: r.error || '分支失败'}))
    }
  } catch (err) {
    window.dispatchEvent(new CustomEvent('copy-success', {detail: '分支失败: ' + (err.message || err)}))
  } finally {
    branchingSession.value = false
  }
}

// 输入框事件已迁移到 ChatInput 组件

const showScrollBtn = ref(false)

// 用户是否主动滚离了底部（区别于被内容推上去）
let userScrolledAway = false

// 程序主动滚动保护：scroll() 主动滚动引发的 scroll 事件不应视为用户滚离。
// 否则流式内容渲染滞后（scrollTo 目标仍是旧 scrollHeight，事件派发时高度已增长）
// 会被误判为“用户离开”而永久停止自动下滚。
let programmaticScrollGuard = false
let programmaticScrollTarget = -1
// 上一次滚动位置，用于区分滚动方向（只有向上滚才视为用户主动离开）
let lastScrollTop = 0

const SCROLL_THRESHOLD = 80

const isNearBottom = () => {
  const el = messagesContainer.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD
}

const scroll = async (force = false, smooth = false) => {
  await nextTick()
  const el = messagesContainer.value
  if (!el) return
  // 流式渲染中只要用户没主动滚走就一直滚；否则按阈值
  if (force || (streaming.value && !userScrolledAway) || isNearBottom()) {
    programmaticScrollGuard = true
    programmaticScrollTarget = el.scrollHeight
    el.scrollTo({top: programmaticScrollTarget, behavior: smooth ? 'smooth' : 'auto'})
  }
  updateScrollBtn()
  // 强制跳底（打开旧会话/加载历史/发送消息）后：虚拟滚动下未渲染消息的高度按估算值参与布局，
  // 真实高度由 ResizeObserver 异步测量。若实测整体高于估算（长助手消息常见），
  // 首次 scrollTo 会停在真实底部的上方，这里等在测量收敛期间持续对齐底部，
  // 用户主动滚离则立即停止。
  if (force && !smooth) {
    userScrolledAway = false
    startBottomAnchor(el)
  }
}

// —— 底部锚定：等虚拟滚动高度测量收敛后重新对齐到底部 ——
const ANCHOR_MIN_FRAMES = 4
const ANCHOR_STABLE_FRAMES = 3
const ANCHOR_MAX_FRAMES = 120
let bottomAnchorActive = false
let bottomAnchorFrame = 0
let bottomAnchorFrames = 0
let bottomAnchorStable = 0
let bottomAnchorLastHeight = 0

const startBottomAnchor = (el) => {
  if (bottomAnchorActive) return
  bottomAnchorActive = true
  bottomAnchorFrames = 0
  bottomAnchorStable = 0
  bottomAnchorLastHeight = el.scrollHeight
  const probe = () => {
    bottomAnchorFrame = 0
    if (!bottomAnchorActive || userScrolledAway || !el.isConnected) {
      bottomAnchorActive = false
      return
    }
    bottomAnchorFrames++
    const height = el.scrollHeight
    if (Math.abs(height - bottomAnchorLastHeight) > 1) {
      bottomAnchorStable = 0
      bottomAnchorLastHeight = height
      programmaticScrollGuard = true
      programmaticScrollTarget = height
      el.scrollTo({top: height, behavior: 'auto'})
    } else {
      bottomAnchorStable++
    }
    const converged = bottomAnchorFrames >= ANCHOR_MIN_FRAMES && bottomAnchorStable >= ANCHOR_STABLE_FRAMES
    if (!converged && bottomAnchorFrames < ANCHOR_MAX_FRAMES) {
      bottomAnchorFrame = requestAnimationFrame(probe)
    } else {
      bottomAnchorActive = false
    }
  }
  bottomAnchorFrame = requestAnimationFrame(probe)
}

const cancelBottomAnchor = () => {
  bottomAnchorActive = false
  if (bottomAnchorFrame) cancelAnimationFrame(bottomAnchorFrame)
  bottomAnchorFrame = 0
}

watch(() => queuedMessages.value.length > 0, (hasQueue, hadQueue) => {
  if (hasQueue !== hadQueue) void scroll(true, true)
})

const scrollToBottom = () => {
  userScrolledAway = false
  scroll(true, true)
}

// 一键折叠当前会话所有展开的折叠块（思考/工具/路径组/子代理/代码块等）。
// 块级状态（showContent/expanded 等）直接改 store 中的消息对象（深响应式）：
// 已挂载的 BlockRenderer 通过响应式自动更新，虚拟滚动未挂载的消息下次进入视口时也是折叠态。
const collapseAllBlocks = () => {
  for (const msg of messages.value) {
    for (const block of (msg.blocks || [])) {
      block.showContent = false
      block.expanded = false
      block.showAll = false
      if (block.type === 'sub_agent') {
        for (const sb of (block.blocks || [])) {
          sb.expanded = false
          sb.showContent = false
        }
      }
      for (const t of (block._tools || [])) t.expanded = false
    }
  }
  // 已渲染代码块的折叠状态挂在 DOM class 上（.expanded），直接收起
  messagesContainer.value?.querySelectorAll('.code-block-wrap.expanded')
      .forEach(wrap => wrap.classList.remove('expanded'))
  // 通知已挂载的 BlockRenderer 重置组件内的分组折叠状态（工具组/路径组/子代理展开覆盖）
  window.dispatchEvent(new CustomEvent('loopra:collapse-all-blocks'))
  // 折叠后内容整体变矮，若原本在底部附近则保持贴底
  nextTick(() => void scroll())
}

// 监听容器的滚动事件，检测用户是否主动滚离底部
const updateScrollBtn = () => {
  const nearBottom = isNearBottom()
  showScrollBtn.value = !nearBottom
  // userScrolledAway 统一由 onScroll 维护（区分程序滚动与用户方向），避免误判
}

// 额外监听 wheel / touch 事件：滚动中如果用户向上滚，标记为主动离开
const onScroll = () => {
  const el = messagesContainer.value
  if (!el) return
  updateVirtualViewport()
  const nearBottom = isNearBottom()
  showScrollBtn.value = !nearBottom

  if (programmaticScrollGuard) {
    // 程序滚动引发的 scroll 事件不视为用户离开；
    // 用户明确向上滚动可立即中断保护并恢复“主动离开”判定
    if (el.scrollTop < lastScrollTop) {
      programmaticScrollGuard = false
      userScrolledAway = true
    } else if (Math.abs(el.scrollTop - programmaticScrollTarget) <= 4) {
      programmaticScrollGuard = false
    }
    lastScrollTop = el.scrollTop
    return
  }

  if (!nearBottom) {
    userScrolledAway = true
  } else {
    userScrolledAway = false
  }
  lastScrollTop = el.scrollTop
}

/** 用户点击选项按钮 → 直接发送 value 作为消息，清理旧工具卡片 */
// HITL 审批 question 格式化：将工具名转为 `tool` 形式的展示文本
const formatHitlQuestion = (title) => {
  return '将执行 ' + title.split('、').map(n => '`' + n + '`').join('、')
}

const sendChoice = async (value, block) => {
  // 子代理 HITL 审批：调用 REST API 而非发送聊天消息
  if (block?.subId != null) {
    // 解析 action：/agree → approve, /deny → deny
    const action = value === '/agree' ? 'approve' : 'deny'
    try {
      await fetch('/api/chat/sub-hitl/' + block.subId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      })
      // 标记已选择
      block.resolved = true
      block.selectedTitle = action === 'approve' ? '同意执行' : '拒绝执行'
    } catch (e) {
      console.error('子代理 HITL 审批请求失败:', e)
    }
    return
  }
  // 主代理 HITL 审批：发送聊天消息
  // 标记已选择
  if (block) {
    block.resolved = true
    const opt = (block.options || []).find(o => o.value === value)
    block.selectedTitle = opt ? opt.title : value
  }
  // 只清理本轮拦截、尚未执行的 tool_call 块（无 result），
  // 保留已完成（有结果）的历史工具卡片，避免连续审批时误删上一轮的工具渲染。
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'assistant' && last.blocks) {
    last.blocks = last.blocks.filter(b =>
        b === block || b.type !== 'tool_call' || b.result
    )
  }
  inputText.value = value
  sendMessage()
}

// 打开文件（显示当前项目代码预览）
const openFile = async (filePath) => {
  await openDiff(filePath)
}

// 键盘事件已迁移到 ChatInput 组件

/**
 * 核心发送逻辑：
 * - 普通消息：加用户气泡 → 创建助手占位 → 流式填充
 * - 静默命令（SILENT_CMDS 中的命令，如 /new、/agree、/deny 等）：不加气泡直接发后端；
 *   收到有内容的 SSE 事件时才创建助手气泡
 * - /skill: 命令：显示用户气泡 + 助手气泡（正常流程）
 */
/**
 * 子代理会话模式发送：追加一轮继续对话。
 * 用户消息以 sub_user 气泡加入容器块（派生为消息流中的用户气泡），
 * SSE 返回的 sub_* 事件增量渲染（回放/实时共用同一累积逻辑），结束时通知上层刷新会话列表。
 */
const sendSubAgentMessage = async (images = [], overrideText = null) => {
  const text = overrideText ?? inputText.value.trim()
  if (!text) return
  const tab = props.subAgent
  if (tab.status === '运行中') return
  if (images && images.length > 0) {
    message.warning('子代理会话暂不支持图片')
    return
  }
  inputText.value = ''
  tab.blocks.push({type: 'sub_user', content: text})
  tab.status = '运行中'
  userScrolledAway = false
  await scroll(true) // 用户刚发送，强制滚到底

  subSessionsAPI.chat(tab.subSessionId, {
    message: text,
    workspaceHash: props.workspaceHash,
    sessionName: props.sessionName
  }, (evt) => {
    if (evt.type === 'error') {
      // 后端发送的 SSE 错误事件（HTTP 200 流内错误）
      tab.status = '失败'
      tab.blocks.push({type: 'content', content: '❌ 继续对话失败：' + (evt.error || evt.content || '未知错误')})
      return
    }
    applySubAgentEvent(tab, evt)
  }, () => {
    // 本轮结束（sub_end 已由事件流更新状态）：通知上层刷新子代理会话列表（重复 apply 幂等）
    emit('subAgentEvent', {type: 'sub_end', subSessionId: tab.subSessionId, status: tab.status})
  }, (err) => {
    tab.status = '失败'
    tab.blocks.push({type: 'content', content: '❌ 继续对话失败：' + (err?.message || err)})
    emit('subAgentEvent', {type: 'sub_end', subSessionId: tab.subSessionId, status: 'error'})
  })
}

/** 停止按钮：子代理会话暂不支持中断（后端无对应取消通道），仅提示。 */
const onAbort = () => {
  if (isSubAgentMode.value) {
    message.info('子代理会话暂不支持中断，可关闭标签页等待其自行结束')
    return
  }
  abortChat()
}

/** 清空/导出：仅主会话可用（子代理会话数据由后端 JSONL 管理） */
const onClear = () => {
  if (isSubAgentMode.value) {
    message.info('子代理会话不支持清空')
    return
  }
  clearChat()
}

const onExport = () => {
  if (isSubAgentMode.value) {
    message.info('子代理会话不支持导出')
    return
  }
  exportChat()
}

const sendMessage = async (images = [], overrideText = null, modelSelection = null,
                            targetSessionName = props.sessionName, targetWorkspaceHash = props.workspaceHash,
                            reasoningEffort = getSessionReasoningEffort(targetSessionName, targetWorkspaceHash),
                            requestAction = null,
                            fastMode = getSessionFastMode(targetSessionName, targetWorkspaceHash),
                            linkedProjectHashes = []) => {
  // 子代理会话模式：继续对话走子代理 SSE 通道（界面复用，发送通道切换）
  if (props.subAgent) return sendSubAgentMessage(images, overrideText)
  const text = requestAction ? '' : (overrideText ?? inputText.value.trim())
  if (!text && images.length === 0 && !requestAction) return
  const sessionName = targetSessionName
  if (!sessionName) return
  const selectedModel = modelSelection || getSessionModelSelection(sessionName, targetWorkspaceHash)
  const selectedReasoningEffort = reasoningEffort || getSessionReasoningEffort(sessionName, targetWorkspaceHash)
  const selectedFastMode = fastMode ?? getSessionFastMode(sessionName, targetWorkspaceHash)
  // 流式输出中发送 → 排队（原行为）；会话后台任务运行/状态检查中发送 → 也排队，避免静默丢弃
  if (store.getSessionStreaming(sessionName) || (!requestAction && sessionName === props.sessionName && sessionBusy.value)) {
    addQueuedMessage(sessionName, targetWorkspaceHash, images, text, selectedModel, selectedReasoningEffort, selectedFastMode, linkedProjectHashes)
    inputText.value = ''
    return
  }

  const firstWord = text.split(/\s+/)[0].toLowerCase()
  // 静默命令不显示用户气泡（系统命令、模式切换、HITL 审批等）
  const isSilent = !!requestAction || SILENT_CMDS.has(firstWord)


  // 静默命令不显示用户气泡
  if (!isSilent) {
    const userMsg = {id: Date.now(), role: 'user', content: text, time: now(), snapshotId: null, rollbackId: null}
    if (images.length > 0) userMsg.images = images
    store.addSessionMessage(sessionName, userMsg)
    // Empty sessions are intentionally hidden. Show the session as soon as it has a user message.
    emit('sessionUpdated', sessionName, true)
  }
  userScrolledAway = false
  if (!requestAction) inputText.value = ''
  await scroll(true)  // 用户刚发送，强制滚到底

  store.setSessionStreaming(sessionName, true)
  if (!sessionStatusPollingStarted && sessionName === props.sessionName) {
    startSessionStatusPolling(targetWorkspaceHash, sessionName)
  }

  // 使用唯一 ID 追踪当前 assistant 消息
  const assistantId = Date.now() + 1
  const assistantTurnStartedAt = Date.now()
  let silentAssistantId = null
  // ReasonBreaker 重试回滚点：本轮第一个思考块在 blocks 中的索引（-1 表示尚未定位）
  let streamResetIndex = -1

  // 静默命令不预创建助手占位
  if (!isSilent) {
    store.addSessionMessage(sessionName, {
      id: assistantId,
      role: 'assistant',
      time: now(),
      blocks: [],
      turnStartedAt: assistantTurnStartedAt
    })
  }

  let getMsg = () => {
    const msgs = store.getSessionMessages(sessionName)
    const targetId = silentAssistantId || assistantId
    if (!targetId) return null
    return msgs.find(m => m.id === targetId)
  }
  let silentBubbleCreated = false

  try {
    const processStreamEvent = (data) => {
          // 模式事件不依赖消息气泡，直接更新会话状态（需在 msg 守卫前处理）
          if (data.type === 'mode_changed') {
            if (sessionName === props.sessionName) {
              planMode.value = data.mode === 'plan'
              if (!planMode.value) pendingPlan.value = null
            }
            return
          }
          if (data.type === 'plan_submitted') {
            if (sessionName === props.sessionName) {
              pendingPlan.value = data.plan || null
              planMode.value = true
              addLog({level: 'INFO', text: '执行计划已提交，等待审查', time: Date.now()})
            }
            return
          }
          // 静默命令：首次收到有内容的数据时才创建助手气泡（只创建一次）
          if (isSilent && !silentBubbleCreated) {
            if (!data.type || data.type === 'done') return
            const hasContent = (data.type === 'content' && data.content?.trim()) ||
                (data.type === 'reasoning' && data.content?.trim()) ||
                data.type === 'reasoning_started' ||
                data.type === 'tool_call' || data.type === 'tool_result' || data.type === 'file_changes' || data.type === 'error'
            if (!hasContent) return
            // 有实际内容了，插入助手气泡
            silentAssistantId = Date.now()
            store.addSessionMessage(sessionName, {
              id: silentAssistantId,
              role: 'assistant',
              time: now(),
              blocks: [],
              turnStartedAt: assistantTurnStartedAt
            })
            silentBubbleCreated = true
          }

          const msg = getMsg()
          if (!msg) return

          // ===== 子代理事件：注入 sub_agent 容器块，内部渲染 =====
          // 主消息流保持既有行为（sub_choice 提升为顶级 choice 块，不进容器）；
          // 事件同时 emit 给上层（桌面端子代理会话面板增量更新）。
          if (data.type === 'sub_choice') {
            // 子代理 HITL 审批 → 作为顶级 choice 块渲染在主消息流中
            let options = data.options || []
            if (typeof options === 'string') {
              try { options = JSON.parse(options) } catch {}
            }
            const title = data.title || ''
            const desc = data.description || ''
            const question = title
                ? '子代理 ' + formatHitlQuestion(title)
                : '子代理工具调用需要审批'
            msg.blocks.push({
              type: 'choice',
              subId: data.subId,
              options: options,
              question,
              description: desc,
              resolved: false
            })
            emit('subAgentEvent', data)
          } else if (data.type === 'sub_usage' || data.type === 'sub_log') {
            // 暂不处理
          } else if (data.type && data.type.startsWith('sub_')) {
            const container = findSubAgentBlock(msg.blocks, data.subId)
            applySubAgentEvent(container, data, {attachChoice: false})
            if (data.type === 'sub_tool_call' && data.name === 'bash_start') notifyBashStart()
            emit('subAgentEvent', data)
          } else if (data.type === 'reasoning') {
            const lb = msg.blocks[msg.blocks.length - 1]
            if (lb?.type === 'reasoning') lb.content += (data.content || '')
            else if (lb?.type === 'reasoning_started') {
              Object.assign(lb, {type: 'reasoning', content: data.content || '', showContent: false})
            }
            else {
              msg.blocks.push({type: 'reasoning', content: data.content || '', showContent: false})
              // 记录本轮思考起点：ReasonBreaker 重试时服务端发 stream_reset，回滚到这里
              if (streamResetIndex === -1) streamResetIndex = msg.blocks.length - 1
            }
          } else if (data.type === 'stream_reset') {
            // ReasonBreaker 检测到思考循环后重试：作废本轮已流出的思考/正文，
            // 回滚到本轮第一个思考块之前（保留工具卡片、choice、子代理容器等既有内容）
            if (streamResetIndex >= 0 && msg.blocks) {
              msg.blocks.splice(streamResetIndex)
            }
            streamResetIndex = -1
          } else if (data.type === 'reasoning_started') {
            const lb = msg.blocks[msg.blocks.length - 1]
            if (lb?.type !== 'reasoning_started') {
              msg.blocks.push({type: 'reasoning_started', showContent: false})
            }
          } else if (data.type === 'content') {
            const lb = msg.blocks[msg.blocks.length - 1]
            if (lb?.type === 'content') lb.content += (data.content || '')
            // 纯空白正文（思考间隙流出的 \n\n）不创建独立块，避免拆散连续思考
            else if ((data.content || '').trim()) msg.blocks.push({type: 'content', content: data.content || ''})
          } else if (data.type === 'tool_call') {
            let name = data.name || '', args = data.args || data.arguments || ''
            if (typeof args === 'string') try {
              args = JSON.parse(args)
            } catch {
            }
            if (name === 'bash_start') notifyBashStart()
            msg.blocks.push({
              type: 'tool_call',
              name: name || 'unknown',
              status: '执行中',
              args,
              result: '',
              toolStartedAt: Date.now(),
              expanded: true
            })
          } else if (data.type === 'tool_result') {
            let result = data.result || data.content || ''
            const rn = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            let targetName = data.name || ''
            // 优先按 name 匹配（异步执行时完成顺序与调用顺序可能不同）
            let matched = false
            if (targetName) {
              for (let i = msg.blocks.length - 1; i >= 0; i--) {
                if (msg.blocks[i].type === 'tool_call' && msg.blocks[i].name === targetName && !msg.blocks[i].result) {
                  msg.blocks[i].result = rn;
                  msg.blocks[i].status = '成功';
                  msg.blocks[i].toolFinishedAt = Date.now();
                  msg.blocks[i].toolDurationMs = msg.blocks[i].toolFinishedAt - msg.blocks[i].toolStartedAt;
                  msg.blocks[i].expanded = false;
                  matched = true
                  break
                }
              }
            }
            // 按 name 没匹配到，fallback 到从后往前找第一个无结果的
            if (!matched) {
              for (let i = msg.blocks.length - 1; i >= 0; i--) {
                if (msg.blocks[i].type === 'tool_call' && !msg.blocks[i].result) {
                  msg.blocks[i].result = rn;
                  msg.blocks[i].status = '成功';
                  msg.blocks[i].toolFinishedAt = Date.now();
                  msg.blocks[i].toolDurationMs = msg.blocks[i].toolFinishedAt - msg.blocks[i].toolStartedAt;
                  msg.blocks[i].expanded = false;
                  break
                }
              }
            }
          } else if (data.type === 'file_changes') {
            const changes = Array.isArray(data.changes) ? data.changes : []
            mergeFileChanges(msg.blocks, changes)
            moveFileChangesToEnd(msg.blocks)
          } else if (data.type === 'error') {
            msg.blocks.push({type: 'content', content: '错误: ' + (data.error || data.content || '未知')})
          } else if (data.type === 'token_speed') {
            usage.value = {...usage.value, tokensPerSecond: data.tokensPerSecond, avgTokensPerSecond: data.avgTokensPerSecond ?? data.tokensPerSecond, tokenSpeedDone: !!data.done, completionTokens: data.completionTokens ?? usage.value.completionTokens}
          } else if (data.type === 'usage') {
            // 更新 usage 数据
            if (data.promptTokens !== undefined) {
              usage.value = {...usage.value, ...data}
            }
          } else if (data.type === 'choice') {
            // 选项按钮（如 HITL 审批、ask_choice）
            let options = data.options || []
            if (typeof options === 'string') {
              try {
                options = JSON.parse(options)
              } catch {
              }
            }
            if (Array.isArray(options) && options.length > 0) {
              // HITL 审批：使用后端传入的 title/description
              let question = data.title
                ? formatHitlQuestion(data.title)
                : (data.question || '')
              const description = data.description || ''
              let toolOptions = null
              // 尝试从同消息的 ask_choice tool_call 中获取 question 和 summary（向后兼容）
              if (!question && msg.blocks) {
                for (let i = msg.blocks.length - 1; i >= 0; i--) {
                  const b = msg.blocks[i]
                  if (b.type === 'tool_call' && b.name === 'ask_choice') {
                    try {
                      const args = typeof b.args === 'string' ? JSON.parse(b.args) : b.args
                      if (args?.question && !question) question = args.question
                      if (args?.options) toolOptions = args.options
                    } catch {}
                  }
                }
              }
              // 如果后端 choice 事件没带 summary，从 tool_call args 补上
              if (toolOptions && Array.isArray(toolOptions)) {
                options = options.map((opt, idx) => {
                  const toolOpt = toolOptions[idx]
                  if (toolOpt && !opt.summary && toolOpt.summary) {
                    return { ...opt, summary: toolOpt.summary }
                  }
                  return opt
                })
              }
              msg.blocks.push({type: 'choice', options, question, description})
            }
          } else if (data.type === 'log') {
            // 系统日志（如 [compact] 折叠结果）→ 仅展示 INFO 及以上级别
            const level = (data.level || 'INFO').toUpperCase()
            if (level === 'DEBUG') return
            const text = data.message || data.content || ''
            addLog({level, text, time: Date.now()})
          } else if (data.type === 'snapshot') {
            // 每条用户消息都会收到撤回定位 ID；只有实际创建快照时才可撤回代码。
            if (data.msgId) {
              if (data.hasCodeSnapshot) {
                store.addSnapshot(sessionName, data.msgId, data.msgId)
                snapshotMap.value.set(data.msgId, data.msgId)
              }
              // 将撤回定位 ID 关联到最后一条尚未关联的用户消息
              const msgs = store.getSessionMessages(sessionName)
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'user' && !msgs[i].rollbackId) {
                  msgs[i].rollbackId = data.msgId
                  if (data.hasCodeSnapshot) msgs[i].snapshotId = data.msgId
                  break
                }
              }
            }
          }
    }

    const pendingStreamEvents = []
    let streamFrameId = 0
    const flushStreamEvents = () => {
      if (streamFrameId) {
        cancelAnimationFrame(streamFrameId)
        streamFrameId = 0
      }
      if (pendingStreamEvents.length === 0) return

      const events = pendingStreamEvents.splice(0)
      for (const event of events) processStreamEvent(event)
      streamRenderVersion.value++
      scroll()
    }
    const enqueueStreamEvent = (data) => {
      pendingStreamEvents.push(data)
      if (streamFrameId) return
      streamFrameId = requestAnimationFrame(() => {
        streamFrameId = 0
        flushStreamEvents()
      })
    }

    const streamResult = chatAPI.sendMessageStream(text,
        enqueueStreamEvent,
        () => {
          flushStreamEvents()
          const completedMessage = getMsg()
          if (completedMessage) {
            completedMessage.turnFinishedAt = Date.now()
            completedMessage.elapsedMs = Math.max(0, completedMessage.turnFinishedAt - (completedMessage.turnStartedAt || assistantTurnStartedAt))
          }
          notifyAssistantReply(completedMessage)
          store.setSessionStreaming(sessionName, false)
          if (requestAction === 'execute_plan') {
            planModeBusy.value = false
            void syncPlanMode()
          }
          // 流结束后清理空的助手气泡
          const msgs = store.getSessionMessages(sessionName)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && (!last.blocks || last.blocks.length === 0)) {
            store.setSessionMessages(sessionName, msgs.slice(0, -1))
          }
          // 刷新 usage 数据
          loadUsage()
          // 通知父组件刷新会话列表（标题可能已更新）
          emit('sessionUpdated')
          nextTick(() => sendNextQueuedMessage(sessionName, targetWorkspaceHash))
        },
        () => {
          flushStreamEvents()
          store.setSessionStreaming(sessionName, false)
          if (requestAction === 'execute_plan') {
            planModeBusy.value = false
            void syncPlanMode()
          }
          const msg = getMsg()
          if (msg) {
            msg.turnFinishedAt = Date.now()
            msg.elapsedMs = Math.max(0, msg.turnFinishedAt - (msg.turnStartedAt || assistantTurnStartedAt))
            if (!msg.blocks.length) msg.blocks.push({type: 'content', content: '连接错误'})
          }
          emit('sessionUpdated')
          nextTick(() => sendNextQueuedMessage(sessionName, targetWorkspaceHash))
        },
        // 传递项目、会话和图片信息
        {
          workspaceHash: targetWorkspaceHash,
          sessionName,
          images,
          model: selectedModel.model,
          modelChannelId: selectedModel.channelId,
          reasoningEffort: selectedReasoningEffort,
          fastMode: selectedFastMode,
          action: requestAction,
          linkedProjectHashes
        }
    )
    store.setSessionController(sessionName, streamResult)
  } catch {
    store.setSessionStreaming(sessionName, false)
    if (requestAction === 'execute_plan') {
      planModeBusy.value = false
      void syncPlanMode()
    }
    emit('sessionUpdated')
    nextTick(() => sendNextQueuedMessage(sessionName, targetWorkspaceHash))
  }
  await scroll()
}

const abortChat = async (targetSessionName = props.sessionName, targetWorkspaceHash = props.workspaceHash) => {
  const ctrl = store.getSessionController(targetSessionName)
  const stoppingRemoteTask = targetSessionName === props.sessionName && sessionTaskRunning.value
  if (stoppingRemoteTask) sessionStatusStopping.value = true
  try {
    // 保持 SSE 读取，等待服务端取消 Agent 并主动关闭 emitter。
    await chatAPI.abort({
      workspaceHash: targetWorkspaceHash,
      sessionName: targetSessionName,
      requestId: ctrl?.requestId || (stoppingRemoteTask ? sessionStatusRequestId.value : null)
    })
  } catch {
    if (stoppingRemoteTask) sessionStatusStopping.value = false
  }
  // 停止超时兜底：10 秒后主动查询后端实时状态确认停止是否生效。
  // 不直接依赖本地 streaming/sessionTaskRunning（可能残留停止前的陈旧值，
  // 或停止后队列自动续发新任务导致误报）；用 requestId 区分“旧任务没停”和“新任务已开始”。
  if (targetSessionName === props.sessionName) {
    const stoppedRequestId = ctrl?.requestId || (stoppingRemoteTask ? sessionStatusRequestId.value : null)
    setTimeout(async () => {
      try {
        const res = await agentAPI.getSessionStatus(targetWorkspaceHash, targetSessionName)
        const stillRunning = Boolean(res?.success && res.data?.running)
        if (!stillRunning) return
        // 仍在运行，但 requestId 已变化（停止后新开始的任务）→ 不是停止失败，不提示
        if (stoppedRequestId && res.data?.requestId && res.data.requestId !== stoppedRequestId) return
        if (stoppingRemoteTask) sessionStatusStopping.value = false
        message.warning('停止请求已发出，但生成仍在进行，可能未能中断')
      } catch {
        // 状态查询失败时不打扰用户，按钮由轮询/SSE 状态自然恢复
      }
    }, 10000)
  }
}

const openRollbackDialog = (msgId, canRollbackCode, rollbackTimestamp) => {
  const rollbackKey = msgId || rollbackTimestamp
  if (streaming.value || sessionBusy.value || !rollbackKey || snapshotRollbackLoading.value.get(rollbackKey)) return
  rollbackDialog.value = {visible: true, msgId, rollbackTimestamp, canRollbackCode}
}

const openFileRevertDialog = (changes) => {
  if (streaming.value || sessionBusy.value || !Array.isArray(changes) || changes.length === 0) return
  fileRevertDialog.value = {visible: true, pending: false, changes}
}

const closeFileRevertDialog = () => {
  if (fileRevertDialog.value.pending) return
  fileRevertDialog.value = {visible: false, pending: false, changes: []}
}

const handleFileRevertAction = async (action) => {
  if (action === 'cancel') {
    closeFileRevertDialog()
    return
  }
  const changes = fileRevertDialog.value.changes
  if (!changes.length || fileRevertDialog.value.pending) return
  fileRevertDialog.value.pending = true
  try {
    const res = await sessionsAPI.revertFileChanges(props.workspaceHash, changes)
    if (res.success) {
      addLog({level: 'INFO', text: `✅ ${res.data?.message || '已撤销本次 AI 的文件修改'}`, time: Date.now()})
      fileRevertDialog.value = {visible: false, pending: false, changes: []}
      await refreshHistory()
      emit('sessionUpdated')
    }
  } catch {
    // The API interceptor already displays the failure notification.
  } finally {
    if (fileRevertDialog.value.visible) fileRevertDialog.value.pending = false
  }
}

const closeRollbackDialog = () => {
  rollbackDialog.value = {visible: false, msgId: null, rollbackTimestamp: null, canRollbackCode: false}
}

const confirmRollback = (rollbackCode) => {
  const msgId = rollbackDialog.value.msgId
  const rollbackTimestamp = rollbackDialog.value.rollbackTimestamp
  closeRollbackDialog()
  rollbackSnapshot(msgId, rollbackCode, rollbackTimestamp)
}

const handleRollbackAction = (action) => {
  if (action === 'cancel') {
    closeRollbackDialog()
    return
  }
  confirmRollback(action === 'code')
}

/** 撤回会话消息，并按选择决定是否恢复 AI 修改的代码。 */
const rollbackSnapshot = async (msgId, rollbackCode, rollbackTimestamp) => {
  const loadingKey = msgId || rollbackTimestamp
  if (streaming.value || sessionBusy.value || !loadingKey) return
  if (snapshotRollbackLoading.value.get(loadingKey)) return // 防止重复点击
  snapshotRollbackLoading.value.set(loadingKey, true)

  try {
    const res = await snapshotAPI.rollback(props.workspaceHash, msgId, props.sessionName, rollbackCode, rollbackTimestamp)
    if (res.success) {
      addLog({level: 'INFO', text: `✅ ${res.data?.message || '项目已恢复'}`, time: Date.now()})
      // 截断该消息之后的所有快照记录
      store.truncateSnapshotsAfter(props.sessionName, msgId)
      // 从 snapshotMap 中移除
      snapshotMap.value.delete(msgId)

      // 找到对应用户消息及其位置，截断会话消息，回填输入框
      const msgs = store.getSessionMessages(props.sessionName)
      let targetIdx = -1
      // 优先使用后端返回的 rollbackUserText（从 JSONL 持久化数据中取得）
      let rollbackContent = res.data?.rollbackUserText || ''
      let rollbackImages = []
      for (let i = 0; i < msgs.length; i++) {
        if ((msgId && (msgs[i].rollbackId === msgId || msgs[i].snapshotId === msgId))
            || (!msgId && msgs[i].rollbackTimestamp === rollbackTimestamp)) {
          targetIdx = i
          // 如果后端没返回文本，从前端消息中取
          if (!rollbackContent) rollbackContent = msgs[i].content || ''
          rollbackImages = msgs[i].images || []
          break
        }
      }
      if (targetIdx >= 0) {
        // 截断：保留目标消息之前的所有消息，删除目标消息及之后的所有消息
        const kept = msgs.slice(0, targetIdx)
        store.setSessionMessages(props.sessionName, kept)
        const useWelcomeInput = kept.length === 0
        if (useWelcomeInput) {
          welcomeText.value = rollbackContent
        } else {
          inputText.value = rollbackContent
        }
        await nextTick()
        const targetInput = useWelcomeInput ? welcomeInput.value : chatInput.value
        targetInput?.restoreImages?.(rollbackImages)
        targetInput?.focus?.()
      }

      // 通知父组件刷新会话列表和 Git 状态
      emit('sessionUpdated')
    } else {
      addLog({level: 'ERROR', text: `❌ 撤回失败: ${res.error || '未知错误'}`, time: Date.now()})
    }
  } catch (e) {
    addLog({level: 'ERROR', text: `❌ 撤回失败: ${e.message || e}`, time: Date.now()})
  } finally {
    snapshotRollbackLoading.value.delete(loadingKey)
  }
}

const clearChat = async () => {
  store.clearSessionMessages(props.sessionName)
  // 发送 /new 给后端清空会话
  store.setSessionStreaming(props.sessionName, true)
  try {
    chatAPI.sendMessageStream('/new', () => {
    }, () => {
      store.setSessionStreaming(props.sessionName, false);
      loadUsage()
    }, () => {
      store.setSessionStreaming(props.sessionName, false)
    })
  } catch {
    store.setSessionStreaming(props.sessionName, false)
  }
}

// 暴露给父组件的清空方法（/new 属于 SILENT_CMDS，不显示气泡）
const clearMessages = () => {
  store.clearSessionMessages(props.sessionName)
  store.setSessionStreaming(props.sessionName, true)
  try {
    chatAPI.sendMessageStream('/new', () => {
    }, () => {
      store.setSessionStreaming(props.sessionName, false);
      loadUsage()
    }, () => {
      store.setSessionStreaming(props.sessionName, false)
    })
  } catch {
    store.setSessionStreaming(props.sessionName, false)
  }
}

/** 继续生成：触发 /continue，后端不追加用户消息，直接复用现有上下文继续推理 */
const continueChat = async () => {
  if (!props.sessionName || streaming.value || sessionBusy.value) return
  inputText.value = '/continue'
  nextTick(() => sendMessage())
}

// 仅清空本地消息，不请求后端（配合 REST API 创建新会话时使用）
const resetLocalMessages = () => {
  store.clearSessionMessages(props.sessionName)
}

const exportChat = () => {
  const text = messages.value.map(m => {
    const h = `[${m.time}] ${m.role === 'user' ? '用户' : '助手'}:`
    let c = h + '\n'
    if (m.blocks) for (const b of m.blocks) {
      if (b.type === 'reasoning') c += '\n思考: ' + b.content + '\n'
      else if (b.type === 'content') c += b.content + '\n'
      else if (b.type === 'tool_call') c += `工具 ${b.name}: ${JSON.stringify(b.args)}\n`
    }
    return c
  }).join('\n---\n\n')
  const blob = new Blob([text], {type: 'text/plain'})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `chat-${new Date().toISOString().slice(0, 10)}.txt`
  a.click()
}

// 查看系统提示词
const loadingPrompt = ref(false)
const promptModalOpen = ref(false)
const promptContent = ref('')
const promptLength = ref(0)

const copyPrompt = () => {
  if (!promptContent.value) return
  navigator.clipboard.writeText(promptContent.value).then(() => {
    addLog({level: 'INFO', text: '✅ 提示词已复制', time: Date.now()})
  }).catch(() => {
  })
}

const viewSystemPrompt = async () => {
  loadingPrompt.value = true
  try {
    const params = {}
    if (props.workspaceHash) params.workspaceHash = props.workspaceHash
    if (props.sessionName) params.sessionName = props.sessionName
    const res = await agentAPI.getSystemPrompt(params)
    if (res.success && res.data) {
      promptContent.value = res.data.content || ''
      promptLength.value = res.data.length || 0
      promptModalOpen.value = true
    } else {
      addLog({level: 'ERROR', text: '获取提示词失败', time: Date.now()})
    }
  } catch (e) {
    addLog({level: 'ERROR', text: '获取提示词失败: ' + (e.message || '未知错误'), time: Date.now()})
  } finally {
    loadingPrompt.value = false
  }
}

const setPlanMode = async (enabled) => {
  if (!props.workspaceHash || !props.sessionName || streaming.value || sessionBusy.value || planModeBusy.value) return
  planModeBusy.value = true
  try {
    const res = await agentAPI.setMode(props.workspaceHash, props.sessionName, enabled)
    if (!res?.success) throw new Error(res?.message || '计划模式切换失败')
    planMode.value = res.data?.mode === 'plan'
    pendingPlan.value = res.data?.pendingPlan || null
  } catch (error) {
    message.error(error?.message || '计划模式切换失败')
  } finally {
    planModeBusy.value = false
  }
}

const togglePlan = () => {
  if (streaming.value || sessionBusy.value || planModeBusy.value) return
  if (!props.sessionName) {
    if (welcomeWorkspaceHash.value) {
      emit('startTask', {prompt: '', workspaceHash: welcomeWorkspaceHash.value, planMode: true})
    }
    return
  }
  if (planMode.value) {
    discardPlanDialog.value = {visible: true}
    return
  }
  void setPlanMode(true)
}

const closeDiscardPlanDialog = () => {
  if (!planModeBusy.value) discardPlanDialog.value = {visible: false}
}

const handleDiscardPlanAction = async (action) => {
  if (action === 'cancel') {
    closeDiscardPlanDialog()
    return
  }
  await setPlanMode(false)
  closeDiscardPlanDialog()
}

const approvePendingPlan = async () => {
  if (!pendingPlan.value || streaming.value || sessionBusy.value || planModeBusy.value) return
  planModeBusy.value = true
  try {
    await sendMessage([], '', null, props.sessionName, props.workspaceHash, null, 'execute_plan')
  } catch {
    planModeBusy.value = false
  }
}

const loadHistory = async (sessionName, force = false, workspaceHash = props.workspaceHash, statusToken = null) => {
  const targetSession = sessionName || props.sessionName
  const targetWorkspace = workspaceHash ?? props.workspaceHash
  if (!targetSession) return
  
  // 如果 force=true 强制从后端刷新，跳过缓存
  const existing = store.getSessionMessages(targetSession)
  if (!force && existing.length > 0) {
    if (targetSession === props.sessionName && targetWorkspace === props.workspaceHash) await scroll(true)
    return
  }
  
  try {
    const r = await agentAPI.getHistory(targetWorkspace, targetSession)
    if (r.success && r.data) {
      const raw = r.data
      const visibleRaw = raw.filter(m => !(m.web_hidden || m.webHidden))
      const assistantBoundaries = getAssistantTurnBoundaries(visibleRaw)
      const {items: merged} = buildHistoryItems(visibleRaw)
      let assistantTurn = 0
      for (const item of merged) {
        if (item.role === 'assistant') item.sourceMessageCount = assistantBoundaries[assistantTurn++]
      }
      if (statusToken !== null && !isCurrentSessionStatus(statusToken, targetWorkspace, targetSession)) return
      // 本地 SSE 流正在活跃输出时禁止用持久化历史整体替换消息数组：
      // 否则流式消息对象引用失效，后续 SSE 事件无处落地（表现为刷新中断了正在运行的流）。
      if (store.getSessionStreaming(targetSession)) return
      store.setSessionMessages(targetSession, merged)
      if (targetSession === props.sessionName && targetWorkspace === props.workspaceHash) await scroll(true)
    }
  } catch {
  }
}

// 强制从后端刷新指定会话的历史（跳过缓存）
// 刷新当前展示的会话后跳至底部，后台会话不影响当前视图。
const refreshHistory = async (name) => {
  const target = name || props.sessionName
  if (!target) return
  try {
    await loadHistory(target, true)
    if (target === props.sessionName) {
      userScrolledAway = false
      await scroll(true)
    }
    addLog({level: 'INFO', text: '聊天记录已刷新', time: Date.now()})
  } catch (e) {
    addLog({level: 'ERROR', text: '刷新失败: ' + (e.message || '未知错误'), time: Date.now()})
  }
}

const loadSession = async (name, workspaceHash) => {
  try {
    const {sessionsAPI} = await import('../services/api')
    await sessionsAPI.switchSession(name, workspaceHash)
    const existing = store.getSessionMessages(name)
    if (existing.length === 0) {
      await loadHistory(name, false, workspaceHash)
    } else {
      // 缓存命中，直接滚动到底部
      await scroll(true)
    }
    await focusComposer()
    await loadUsage({sessionName: name, workspaceHash})
  } catch (e) {
    console.error('切换会话失败:', e)
  }
}

const sendCommand = async cmd => {
  inputText.value = cmd;
  await sendMessage()
}

const startWelcomePrompt = async (prompt) => {
  inputText.value = prompt || ''
  await nextTick()
  await sendMessage()
}

const appendFileSelection = async ({ file, content, startLine, endLine }) => {
  const path = String(file || '').trim()
  if (!path) return false
  const useSessionInput = Boolean(props.sessionName && messages.value.length > 0)
  const targetInput = useSessionInput ? chatInput.value : welcomeInput.value
  if (!targetInput?.addFileContext?.({ file: path, content, startLine, endLine })) return false
  await nextTick()
  targetInput.focus?.()
  return true
}

const appendElementInspection = async (inspection) => {
  const useSessionInput = Boolean(props.sessionName && messages.value.length > 0)
  const targetInput = useSessionInput ? chatInput.value : welcomeInput.value
  if (!targetInput?.addElementContext?.(inspection)) return false
  await nextTick()
  targetInput.focus?.()
  return true
}

// 加载历史消息（仅在明确选了 session 时）
onMounted(() => {
  document.addEventListener('click', handleWelcomeOutsideClick)
  void (async () => {
    try {
      if (props.sessionName) {
        if (props.subAgent) {
          // 子代理会话模式：消息来自容器块，不加载主会话历史
          await focusComposer()
        } else if (!props.initiallyEmpty) {
          await loadHistory()
          await focusComposer()
          void syncPlanMode()
        } else {
          await focusComposer()
        }
      } else {
        await focusComposer()
      }
    } finally {
      // 桌面原生会话视图据此移除首次加载遮罩；历史请求失败时也不能让界面永久锁住。
      emit('initialLoadComplete')
    }
  })()
})

onBeforeUnmount(() => document.removeEventListener('click', handleWelcomeOutsideClick))

const focusComposer = async () => {
  await nextTick()
  const target = props.sessionName && messages.value.length > 0 ? chatInput.value : welcomeInput.value
  target?.focus?.()
}

const setDraft = async (text) => {
  const draft = text || ''
  if (!props.sessionName || messages.value.length === 0) {
    welcomeText.value = draft
    await nextTick()
    welcomeInput.value?.focus?.()
    return
  }
  inputText.value = draft
  await nextTick()
  chatInput.value?.focus?.()
}

const enablePlanMode = () => setPlanMode(true)

defineExpose({clearMessages, resetLocalMessages, loadSession, sendCommand, startWelcomePrompt, appendFileSelection, appendElementInspection, exportChat, refreshHistory, focusComposer, setDraft, enablePlanMode})
</script>

<style scoped>
.chat {
  --conversation-content-max-width: 1000px;
  --conversation-composer-max-width: 1040px;
  --conversation-content-width-gap: 40px;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  position: relative;
}

.plan-review-band {
  width: 100%;
  max-width: 1040px;
  max-height: min(42vh, 360px);
  margin: 0 auto 6px;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: none;
}

.plan-review-head {
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--border);
}

.plan-review-icon {
  color: var(--accent);
  font-size: 15px;
}

.plan-review-head strong {
  font-size: 13px;
  font-weight: 600;
}

.plan-review-status {
  color: var(--fg-4);
  font-size: 12px;
}

.plan-review-chevron {
  width: 6px;
  height: 6px;
  margin-left: 2px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  content: '';
  opacity: .55;
  transform: rotate(45deg) translate(-1px, -1px);
  transition: opacity 120ms ease, transform 120ms ease;
}

.plan-review-band:hover .plan-review-chevron,
.plan-review-band:focus-within .plan-review-chevron {
  opacity: .85;
  transform: rotate(225deg) translate(-1px, -1px);
}

.plan-review-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.plan-approve-btn,
.plan-exit-btn {
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: var(--r);
  transition: background var(--t), color var(--t);
}

.plan-approve-btn {
  padding: 0 10px;
  background: var(--accent-btn);
  color: #fff;
  font-size: 12px;
}

.plan-approve-btn:hover:not(:disabled) {
  background: var(--blue-dark);
}

.plan-exit-btn {
  width: 28px;
  color: var(--fg-3);
}

.plan-exit-btn:hover:not(:disabled) {
  background: var(--bg-3);
  color: var(--red);
}

.plan-approve-btn:disabled,
.plan-exit-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* 待审查计划自动折叠：悬停/聚焦展开（与排队消息交互一致） */
.plan-review-body {
  display: grid;
  grid-template-rows: 0fr;
  overflow: hidden;
  opacity: 0;
  transition: grid-template-rows 160ms ease, opacity 120ms ease;
}

.plan-review-band:hover .plan-review-body,
.plan-review-band:focus-within .plan-review-body {
  grid-template-rows: 1fr;
  opacity: 1;
}

.plan-review-body > * {
  min-height: 0;
  overflow: hidden;
}

.plan-review-content {
  max-height: calc(min(42vh, 360px) - 38px);
  overflow: auto;
  padding: 12px 16px;
  color: var(--fg-2);
  font-size: var(--font-message-size, 14px);
  line-height: 1.7;
}

/* markdown 排版（与消息内容块一致；全局 reset 清掉了列表缩进，需恢复） */
.plan-review-content :deep(p) {
  margin: 0.5em 0;
}

.plan-review-content :deep(h1) {
  font-size: 1.3em;
  margin: 0.5em 0;
  font-weight: 600;
}

.plan-review-content :deep(h2) {
  font-size: 1.15em;
  margin: 0.5em 0;
  font-weight: 600;
}

.plan-review-content :deep(h3) {
  font-size: 1.05em;
  margin: 0.5em 0;
  font-weight: 600;
}

.plan-review-content :deep(h4) {
  font-size: 1em;
  margin: 0.5em 0;
  font-weight: 600;
}

.plan-review-content :deep(h5) {
  font-size: 0.95em;
  margin: 0.5em 0;
  font-weight: 600;
}

.plan-review-content :deep(h6) {
  font-size: 0.9em;
  margin: 0.5em 0;
  font-weight: 600;
}

.plan-review-content :deep(ul),
.plan-review-content :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.plan-review-content :deep(li) {
  margin: 0.25em 0;
}

.plan-review-content :deep(strong) {
  font-weight: 600;
}

.plan-review-content :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.plan-review-content :deep(a:hover) {
  text-decoration: underline;
}

.plan-review-content :deep(pre) {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 10px;
  margin: 6px 0;
  font-size: var(--font-code-size, 12px);
  overflow-x: auto;
}

.plan-review-content :deep(code) {
  font-family: var(--mono);
  font-size: var(--font-code-size, 12px);
}

.plan-review-content :deep(pre code) {
  background: none;
  padding: 0;
}

.plan-review-content :deep(blockquote) {
  margin: 0.5em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--accent);
  background: var(--bg-3);
  border-radius: 0 var(--r) var(--r) 0;
}

.plan-review-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.plan-review-content :deep(th),
.plan-review-content :deep(td) {
  border: 1px solid var(--glass-border);
  padding: 7px 12px;
  text-align: left;
}

.plan-review-content :deep(th) {
  background: var(--bg-subtle);
  font-weight: 600;
}

.plan-review-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

.plan-review-content :deep(:first-child) {
  margin-top: 0;
}

.plan-review-content :deep(:last-child) {
  margin-bottom: 0;
}

.plan-review-enter-active,
.plan-review-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.plan-review-enter-from,
.plan-review-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.chat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
}

.chat-head-title {
  font-size: 14px;
  font-weight: 600;
}

.chat-head-count {
  font-size: 12px;
  color: var(--fg-4);
}

/* 流式加载动画横线 */
.streaming-bar {
  height: 2px;
  background: var(--bg-3, rgba(0,0,0,0.06));
  overflow: hidden;
  position: relative;
}

.streaming-bar-inner {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 40%;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  border-radius: 1px;
  will-change: transform;
  animation: streaming-slide 1.4s ease-in-out infinite;
}

@keyframes streaming-slide {
  0% { transform: translate3d(-100%, 0, 0); }
  100% { transform: translate3d(250%, 0, 0); }
}

/* 消息区 */
.messages {
  flex: 1;
  overflow-y: auto;
  overflow-anchor: none;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
  padding: 16px clamp(16px, 2vw, 24px) 146px;
  position: relative;
  transition: padding-bottom 180ms ease;
}

.messages.messages-with-queue {
  padding-bottom: 184px;
}

.messages::-webkit-scrollbar {
  width: 3px;
}

.messages::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
}

.messages:hover {
  scrollbar-color: var(--fg-4) transparent;
}

.messages:hover::-webkit-scrollbar-thumb {
  background: var(--fg-4);
}

.virtual-message-item,
.messages > .msg.assistant {
  width: min(
    calc(100% - var(--conversation-content-width-gap)),
    var(--conversation-content-max-width)
  );
  max-width: var(--conversation-content-max-width);
  margin-right: auto;
  margin-left: auto;
  box-sizing: border-box;
}

.virtual-message-item {
  display: flow-root;
  padding-bottom: 8px;
}

.virtual-message-item.message-role-transition {
  padding-top: 12px;
}

.virtual-message-item > :deep(.msg) {
  margin: 0;
}


/* 空状态 */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--fg-3);
  text-align: center;
}

.empty-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 2px dashed var(--border);
  border-radius: 50%;
  margin-bottom: 12px;
  color: var(--fg-4);
}

.empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 4px;
}

.empty-desc {
  font-size: 13px;
  color: var(--fg-3);
  margin-bottom: 16px;
}

.empty-suggestions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
}

.suggestion {
  padding: 4px 10px;
  font-size: 12px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--r);
  color: var(--fg-2);
  transition: all var(--t);
}

.suggestion:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.quick-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.quick-action {
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 9px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fg-2);
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  transition: all 0.15s;
  font-weight: 500;
}

.quick-action:hover {
  border-color: var(--text, var(--fg));
  color: var(--text, var(--fg));
}

.quick-action i {
  font-size: 12px;
  color: var(--fg-4);
}

.quick-action:hover i {
  color: var(--text, var(--fg));
}

/* AI 准备中动画 */
.ai-preparing {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
}

/* 助手消息气泡样式（Chat.vue 中的加载状态需要） */
.msg.assistant {
  display: flex;
  justify-content: flex-start;
}

.msg.assistant .msg-body {
  width: 100%;
  max-width: 100%;
}

.assistant-body {
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 0;
  box-shadow: none;
}

.ai-dot {
  width: 8px;
  height: 8px;
  background: var(--accent);
  border-radius: 50%;
  opacity: 0.4;
  animation: ai-pulse 1.4s ease-in-out infinite;
}

.ai-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.ai-dot:nth-child(3) {
  animation-delay: 0.4s;
}

.ai-label {
  font-size: 13px;
  color: var(--fg-3);
  margin-left: 4px;
}

@keyframes ai-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1); }
}

/* 全部输入区样式已迁移到 ChatInput.vue 组件中（.input-area, .input-box, .usage-bar, .todo-*, .slash-popup, .model-selector 等） */

/* 滚动到底部按钮（固定在消息区右下角，不随内容滚动） */
.scroll-bottom-btn {
  position: absolute;
  right: 24px;
  bottom: 110px;
  z-index: 60;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent-btn);
  color: #fff;
  border: 2px solid var(--bg);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.scroll-bottom-btn:hover {
  transform: scale(1.1);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.scroll-bottom-btn svg {
  animation: bounce-down 1.5s ease-in-out infinite;
}

.collapse-all-btn {
  position: absolute;
  right: 24px;
  bottom: 154px;
  z-index: 60;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--glass-bg-2);
  color: var(--fg-2);
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.collapse-all-btn:hover {
  transform: scale(1.1);
  color: var(--accent);
  border-color: var(--accent);
}

@keyframes bounce-down {
  0%, 100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(3px);
  }
}

/* 使用 v-show 控制显隐 */

/* ===== 日志堆叠容器 ===== */
.log-stack {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 12px 16px;
  z-index: 100;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 确保在消息滚动时仍固定在顶部 */
  overflow: visible;
}

.log-stack > * {
  pointer-events: auto;
}

/* 🎯 灵动岛风格日志通知 — 大气居中，超长省略 */
.log-bar {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
  margin: 0 auto;

  background: rgba(30, 30, 40, 0.78);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.4;
  color: #f0f0f0;
  cursor: pointer;
  transition: all 0.25s ease;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
}

.log-bar:hover {
  background: rgba(40, 40, 55, 0.92);
  border-radius: 10px;
  padding: 8px 20px;
}

.log-bar.log-warn {
  border-color: rgba(245, 158, 11, 0.5);
}

.log-bar.log-error {
  border-color: rgba(239, 68, 68, 0.5);
}

.log-bar-icon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
}

.log-bar-text {
  min-width: 0;
  max-width: 50ch;
  white-space: pre-wrap;
  word-break: break-all;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 14px;
  font-weight: 500;
  transition: max-width 0.3s ease;
}

.log-bar:hover .log-bar-text {
  max-width: 100ch;
  -webkit-line-clamp: unset;
}

.log-bar-time {
  flex-shrink: 0;
  font-size: 10px;
  opacity: 0.4;
  font-family: var(--mono);
}

.log-bar-close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  color: rgba(240, 240, 240, 0.45);
  background: transparent;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s;
}

.log-bar:hover .log-bar-close {
  opacity: 1;
}

.log-bar-close:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.12);
}

/* 进出动画：从顶部滑入 + 淡入 */
.log-bar-enter-active {
  transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.log-bar-leave-active {
  transition: all 0.2s ease;
}

.log-bar-enter-from {
  opacity: 0;
  transform: translateY(-16px) scale(0.92);
}

.log-bar-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.95);
}


/* ===== 系统提示词弹窗 ===== */
.prompt-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.prompt-modal {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  border: 1px solid var(--glass-border);
  border-radius: var(--r-lg);
  width: 80vw;
  max-width: 900px;
  height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--glass-shadow);
}

.prompt-modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.prompt-modal-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.prompt-modal-size {
  font-size: 11px;
  color: var(--fg-4);
  background: var(--bg-3);
  padding: 2px 8px;
  border-radius: var(--r-sm);
}

.prompt-modal-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--fg-3);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.prompt-modal-close:hover {
  color: var(--fg);
}

.prompt-modal-body {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
}

.prompt-modal-content {
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
  overflow-x: hidden;
}

.prompt-modal-content :deep(pre) {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 10px;
  margin: 6px 0;
  overflow-x: auto;
}

.prompt-modal-content :deep(code) {
  font-family: var(--mono);
  font-size: 12px;
}

.prompt-modal-content :deep(pre code) {
  background: none;
  padding: 0;
}

.prompt-modal-content :deep(strong) {
  font-weight: 600;
}

.prompt-modal-content :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.prompt-modal-content :deep(h1),
.prompt-modal-content :deep(h2),
.prompt-modal-content :deep(h3),
.prompt-modal-content :deep(h4) {
  margin: 0.5em 0;
  font-weight: 600;
}

.prompt-modal-content :deep(ul),
.prompt-modal-content :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.prompt-modal-content :deep(blockquote) {
  margin: 0.5em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--accent);
  background: var(--bg-3);
  border-radius: 0 var(--r) var(--r) 0;
}

.prompt-modal-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
}

.prompt-modal-content :deep(th),
.prompt-modal-content :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}

.prompt-modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}

/* 图片预览 */
.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 40px;
  background: rgba(0, 0, 0, 0.72);
}

.image-preview-full {
  display: block;
  max-width: min(92vw, 1440px);
  max-height: calc(100vh - 80px);
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}

.image-preview-close {
  position: fixed;
  top: 16px;
  right: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  cursor: pointer;
}

.image-preview-close:hover,
.image-preview-close:focus-visible {
  border-color: #fff;
  background: rgba(0, 0, 0, 0.6);
}

.image-preview-close:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

/* 原始事件日志弹窗 */
.raw-events-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: 24px;
}

.raw-events-modal {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--blur));
  -webkit-backdrop-filter: blur(var(--blur));
  border: 1px solid var(--glass-border);
  border-radius: var(--r-lg);
  width: min(900px, 94vw);
  height: min(78vh, 720px);
  display: flex;
  flex-direction: column;
  box-shadow: var(--glass-shadow);
  overflow: hidden;
}

.raw-events-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.raw-events-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.raw-events-count {
  font-size: 11px;
  color: var(--fg-4);
  background: var(--bg-3);
  padding: 2px 8px;
  border-radius: var(--r-sm);
}

.raw-events-close {
  background: none;
  border: none;
  font-size: 20px;
  color: var(--fg-3);
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.raw-events-close:hover {
  color: var(--fg);
}

.raw-events-body {
  flex: 1;
  overflow: auto;
  padding: 14px 16px;
}

.raw-events-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--fg-4);
  font-size: 13px;
}

.raw-events-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.raw-event {
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--bg);
  overflow: hidden;
}

.raw-event-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-3);
}

.raw-event-role {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
}

.raw-event-tag {
  font-size: 11px;
  color: var(--fg-4);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 1px 6px;
}

.raw-event-time {
  font-size: 11px;
  color: var(--fg-4);
}

.raw-event-spacer {
  flex: 1;
}

.raw-event-count {
  font-size: 11px;
  color: var(--fg-4);
}

.raw-event-tool {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg-4);
}

.raw-event-user {
  padding: 10px 12px;
  color: var(--fg-2);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.raw-event-image {
  display: block;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--accent);
  word-break: break-all;
  margin-top: 4px;
}

.raw-event-extra-title {
  margin-top: 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-3);
}

.raw-event-content {
  margin: 0;
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-2);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}

/* ===== 无会话时禁用输入条 ===== */
.no-session-input-bar {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.no-session-input-placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  border: 1px dashed var(--border-2);
  border-radius: var(--r);
  color: var(--fg-4);
  font-size: 13px;
  cursor: default;
  user-select: none;
}

/* ===== 工作流 TODO（已迁移至 ChatInput 组件中） ===== */

/* ===== 消息缩略图 dock（右侧 dock 栏） ===== */
.msg-thumb-dock {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 50;
  pointer-events: none;
}

.thumb-dock-inner {
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  max-height: min(360px, calc(100vh - 240px));
  padding: 8px 4px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--blur-sm));
  -webkit-backdrop-filter: blur(var(--blur-sm));
  border: 1px solid var(--glass-border);
  border-radius: var(--r-lg);
  box-shadow: var(--glass-shadow);
  pointer-events: auto;
  opacity: 0.35;
  transition: opacity 0.25s ease, box-shadow 0.25s ease;
  overflow-y: auto;
  overscroll-behavior: contain;
  min-width: 10px;
}

.thumb-dock-inner:hover {
  opacity: 0.95;
  box-shadow: 0 4px 20px rgba(0,0,0,0.12);
}

.thumb-dock-inner {
  scrollbar-width: none;
}

.thumb-dock-inner::-webkit-scrollbar {
  display: none;
}

.thumb-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  box-sizing: border-box;
  padding: 3px 6px;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  overflow: hidden;
}

.thumb-item:hover {
  background: var(--accent-bg);
}

.thumb-item:hover .thumb-indicator {
  background: var(--accent);
  transform: scale(1.2);
}

.thumb-indicator {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fg-4);
  transition: all 0.2s ease;
}

.thumb-preview {
  font-size: 11px;
  color: var(--fg-3);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 0;
  opacity: 0;
  transition: max-width 0.25s ease, opacity 0.25s ease, margin-left 0.25s ease;
}

.thumb-dock-inner:hover .thumb-preview {
  max-width: 180px;
  opacity: 1;
  margin-left: 2px;
}

.empty-welcome {
  color: var(--fg);
  padding: 40px 24px 96px;
}

.empty-welcome-mark {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  margin-bottom: 26px;
  color: var(--fg-4);
}

.empty-welcome-title {
  margin: 0 0 42px;
  color: var(--fg);
  font-size: 30px;
  font-weight: 500;
  letter-spacing: 0;
}

.welcome-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(180px, 1fr));
  gap: 16px;
  width: min(100%, 980px);
}

.welcome-action {
  min-height: 142px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 8px;
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--t), background var(--t), box-shadow var(--t), transform var(--t);
}

.welcome-action:hover {
  background: var(--bg-2);
  border-color: var(--border-2);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.welcome-action svg { margin-bottom: auto; }
.welcome-action span { font-size: 16px; font-weight: 600; }
.welcome-action small { color: var(--fg-3); font-size: 12px; line-height: 1.45; }
.welcome-action.explore svg { color: var(--blue); }
.welcome-action.build svg { color: #7c3aed; }
.welcome-action.review svg { color: var(--green); }
.welcome-action.fix svg { color: var(--red); }

/* ===== 移动端适配 ===== */
@media (max-width: 1100px) {
  .welcome-actions {
    grid-template-columns: repeat(2, minmax(180px, 1fr));
    max-width: 620px;
  }
}

@media (max-width: 640px) {
  .chat { --conversation-content-width-gap: 16px; }
  .messages { padding: 12px 8px 100px; }
  .messages.messages-with-queue { padding-bottom: 138px; }
  .msg-body { max-width: 95%; }
  .empty-title { font-size: 14px; }
  .empty-desc { font-size: 12px; }
  .empty-welcome { padding: 28px 16px 72px; }
  .empty-welcome-mark { margin-bottom: 16px; }
  .empty-welcome-title { margin-bottom: 24px; font-size: 24px; }
  .welcome-actions { grid-template-columns: 1fr 1fr; gap: 10px; }
  .welcome-action { min-height: 118px; padding: 14px; }
  .welcome-action span { font-size: 14px; }
  .welcome-action small { font-size: 11px; }
  .suggestion { font-size: 11px; padding: 3px 8px; }
  .scroll-bottom-btn { right: 12px; bottom: 100px; width: 32px; height: 32px; }
  .collapse-all-btn { right: 12px; bottom: 140px; width: 32px; height: 32px; }
  .ai-preparing { padding: 6px 10px; }
  .ai-dot { width: 6px; height: 6px; }
  .ai-label { font-size: 12px; }
  .msg-thumb-dock { display: none; } /* 手机端隐藏缩略图dock */
  .chat-head { padding: 6px 10px; }
    .chat-head-title { font-size: 13px; }
}

.messages.messages-welcome { padding: 0; }

.welcome-input-drop-enter-active {
  transition: opacity 220ms ease-out, transform 420ms cubic-bezier(0.22, 0.8, 0.24, 1);
}

.welcome-input-drop-enter-from {
  opacity: 0.35;
  transform: translateY(-180px);
}

</style>

<style scoped>
.welcome-screen {
  position: relative;
  min-height: 100%;
  padding: 40px 24px 132px;
  overflow: hidden;
  isolation: isolate;
}

.welcome-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(100%, 800px);
  margin: auto;
  transform: translateY(34px);
}

.welcome-heading {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 168px;
  margin: 0 0 54px;
  color: #f0f0f1;
  line-height: 0;
}

.welcome-heading svg {
  display: block;
  width: 92%;
  height: 154px;
  fill: currentColor;
}

.welcome-composer {
  position: relative;
  z-index: 20;
  width: 100%;
  padding: 0;
  background: transparent;
}

.welcome-composer.workspace-menu-open {
  z-index: 80;
}

.welcome-workspace-row {
  position: relative;
  z-index: 0;
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 6px;
}

.workspace-menu-open .welcome-workspace-row {
  z-index: 60;
}

.welcome-workspace-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 8px 14px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg-2);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
}

.welcome-workspace-button:hover,
.welcome-workspace-button:focus-visible {
  background: #e7e7e9;
  outline: none;
}

.welcome-workspace-button span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.welcome-workspace-button > svg:first-child { color: var(--fg-3); }
.welcome-workspace-button > svg:last-child { color: var(--fg-4); }

.welcome-environment-switch {
  display: inline-flex;
  gap: 2px;
  margin-left: auto;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2);
}

.welcome-environment-switch button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 52px;
  padding: 5px 9px;
  border: 0;
  border-radius: 4px;
  color: var(--fg-3);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
}

.welcome-environment-switch button:hover:not(:disabled) { color: var(--fg); }
.welcome-environment-switch button.active { color: var(--fg); background: var(--bg); box-shadow: var(--shadow-sm); }
.welcome-environment-switch button:disabled { opacity: .55; cursor: default; }
.welcome-environment-spinner { width: 11px; height: 11px; border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent); border-top-color: currentColor; border-radius: 50%; animation: welcome-environment-spin .65s linear infinite; }
@keyframes welcome-environment-spin { to { transform: rotate(360deg); } }

.welcome-workspace-menu,
.welcome-model-menu {
  position: absolute;
  z-index: 20;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  box-shadow: var(--shadow-lg);
}

.welcome-workspace-menu {
  top: calc(100% - 3px);
  left: 8px;
  width: min(300px, calc(100vw - 64px));
  height: 248px;
  max-height: var(--welcome-workspace-menu-max-height, 248px);
  padding: 4px;
  display: flex;
  flex-direction: column;
}

.welcome-workspace-menu.opens-above {
  top: auto;
  bottom: calc(100% - 3px);
}

.welcome-workspace-menu-actions {
  flex-shrink: 0;
  padding-bottom: 4px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.welcome-workspace-manage {
  font-weight: 600;
}

.welcome-workspace-list {
  min-height: 0;
  overflow-y: auto;
}

.welcome-workspace-menu button,
.welcome-model-menu button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 34px;
  padding: 7px 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-2);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.welcome-workspace-menu button:hover,
.welcome-workspace-menu button.active,
.welcome-model-menu button:hover,
.welcome-model-menu button.active {
  background: var(--bg-3);
  color: var(--fg);
}

.welcome-workspace-empty {
  display: block;
  padding: 10px;
  color: var(--fg-4);
  font-size: 12px;
}

.welcome-composer textarea {
  display: block;
  width: 100%;
  min-height: 96px;
  padding: 16px;
  border: 1px solid #dedee1;
  border-bottom: 0;
  border-radius: 10px 10px 0 0;
  outline: none;
  resize: none;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 15px;
  line-height: 1.55;
}

.welcome-composer textarea::placeholder { color: #aaaaaf; }
.welcome-composer textarea:focus { border-color: var(--accent); }
.welcome-composer:focus-within .welcome-composer-footer { border-color: var(--accent); }

.welcome-composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 54px;
  padding: 8px 10px 8px 15px;
  border: 1px solid #dedee1;
  border-top: 0;
  border-radius: 0 0 10px 10px;
  background: var(--bg);
}

.welcome-composer-options,
.welcome-composer-actions,
.welcome-option {
  display: flex;
  align-items: center;
}

.welcome-composer-options { gap: 16px; }
.welcome-option {
  gap: 6px;
  color: var(--fg-2);
  font-size: 13px;
  white-space: nowrap;
}

.welcome-option:first-child { color: var(--fg-3); }
.welcome-composer-actions { gap: 10px; }

.welcome-model-selector { position: relative; }
.welcome-model-button {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 210px;
  padding: 5px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-2);
  font: 13px var(--mono);
  cursor: pointer;
}

.welcome-model-button:hover { background: var(--bg-3); }
.welcome-model-button:disabled { cursor: default; opacity: 0.7; }
.welcome-model-button:disabled:hover { background: transparent; }
.welcome-model-button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.welcome-model-button svg { flex: 0 0 auto; color: var(--fg-4); }

.welcome-model-menu {
  right: 0;
  bottom: calc(100% + 8px);
  min-width: 190px;
  padding: 4px;
}

.welcome-model-menu button { font-family: var(--mono); }

.welcome-control { position: relative; }
.welcome-control-button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-2);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.welcome-control-button:hover { background: var(--bg-3); }
.welcome-control-button svg { color: var(--fg-4); }

.welcome-control-menu,
.welcome-effort-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 30;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  box-shadow: var(--shadow-lg);
}

.welcome-control-menu {
  min-width: 128px;
  padding: 4px;
}

.welcome-control-menu button {
  width: 100%;
  min-height: 32px;
  padding: 6px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-2);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.welcome-control-menu button:hover,
.welcome-control-menu button.active {
  background: var(--bg-3);
  color: var(--accent);
}

.welcome-effort-menu {
  width: min(270px, calc(100vw - 28px));
  padding: 12px;
}

.welcome-effort-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  color: var(--fg-3);
  font-size: 11px;
}

.welcome-effort-summary strong { color: var(--accent); font-size: 13px; }
.welcome-effort-range { width: 100%; accent-color: var(--accent); cursor: pointer; }
.welcome-effort-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  color: var(--fg-4);
  font-size: 10px;
}

.welcome-send-button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: #707177;
  color: #fff;
  cursor: pointer;
  transition: background var(--t), transform var(--t);
}

.welcome-send-button:hover:not(:disabled) {
  background: #4e4f54;
  transform: translateY(-1px);
}

.welcome-send-button:disabled { cursor: not-allowed; opacity: 0.42; }

[data-theme="dark"] .welcome-heading { color: #29292d; }
[data-theme="dark"] .welcome-composer { background: var(--bg); }
[data-theme="dark"] .welcome-workspace-button:hover,
[data-theme="dark"] .welcome-workspace-button:focus-visible { background: var(--bg-hover); }
[data-theme="dark"] .welcome-composer textarea,
[data-theme="dark"] .welcome-composer-footer {
  border-color: #303030;
  background: #171717;
}

@media (max-width: 768px) {
  .welcome-screen { padding: 24px 8px 84px; }
  .welcome-panel { transform: translateY(16px); }
  .welcome-heading { height: 112px; margin-bottom: 28px; }
  .welcome-heading svg { height: 103px; }
  .welcome-composer-options { gap: 10px; }
  .welcome-model-button { max-width: 130px; }
}

@media (max-width: 520px) {
  .welcome-heading { height: 88px; }
  .welcome-heading svg { height: 81px; }
  .welcome-composer-footer { align-items: flex-end; gap: 10px; }
  .welcome-composer-options { flex-direction: column; align-items: flex-start; gap: 4px; }
  .welcome-model-button { max-width: 94px; }
  .welcome-control-button { padding-inline: 4px; }
  .welcome-composer-actions { gap: 4px; }
}
</style>
