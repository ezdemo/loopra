<template>
  <div class="input-area" :class="{ 'welcome-mode': welcomeMode, 'right-panel-open': rightPanelOpen }">
    <!-- @ 文件引用弹窗 -->
    <Transition name="slash-popup">
      <div v-if="fileMentionOpen" class="file-mention-popup">
        <div class="file-mention-header">
          <span class="file-mention-title">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            引用文件
          </span>
          <span class="file-mention-hint">输入文件名筛选</span>
        </div>
        <div v-if="fileMentionLoading" class="file-mention-state"><span class="loading-dot"></span> 搜索文件中...</div>
        <div v-else-if="fileMentionError" class="file-mention-state">{{ fileMentionError }}</div>
        <div v-else-if="fileMentionFiles.length === 0" class="file-mention-state">未找到文件</div>
        <div v-else class="file-mention-list">
          <button v-for="(entry, index) in fileMentionFiles" :key="entry.path" type="button"
                  class="file-mention-item" :class="{ active: index === activeFileMentionIndex }"
                  @click="selectMentionFile(entry)" @mouseenter="activeFileMentionIndex = index">
            <span class="file-mention-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </span>
            <span class="file-mention-info"><span>{{ entry.name }}</span><small>{{ entry.path }}</small></span>
          </button>
        </div>
      </div>
    </Transition>

    <!-- 斜杠命令弹窗 -->
    <Transition name="slash-popup">
      <div v-if="slashPopupOpen" class="slash-popup">
        <div class="slash-popup-header">
          <span class="slash-popup-title">可用命令</span>
          <span class="slash-popup-hint">输入 / 触发</span>
        </div>
        <div v-if="!commandsLoaded" class="slash-popup-loading">
          <span class="loading-dot"></span> 加载命令中...
        </div>
        <div v-else-if="filteredSlashCmds.length === 0" class="slash-popup-empty">无匹配命令</div>
        <div v-else class="slash-popup-list">
          <div v-for="(cmd, index) in filteredSlashCmds" :key="cmd.cmd"
               class="slash-popup-item" :class="{ active: index === activePopupIdx }"
               @click="selectSlashCmd(cmd)" @mouseenter="activePopupIdx = index">
            <div class="slash-popup-icon">{{ getSlashIcon(cmd.cmd) }}</div>
            <div class="slash-popup-info">
              <div class="slash-popup-cmd">
                {{ cmd.cmd }}
                <span v-if="cmd.type === 'skill'" class="slash-popup-badge skill">skill</span>
                <span v-else-if="cmd.type === 'mode'" class="slash-popup-badge mode">模式</span>
                <span v-else-if="cmd.type === 'session'" class="slash-popup-badge session">会话</span>
              </div>
              <div class="slash-popup-desc">{{ cmd.desc }}</div>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="workflow-float">
      <section v-if="goalData" class="workflow-float goal-float" aria-label="当前 Goal"
               @mouseenter="goalHover = true" @mouseleave="goalHover = false"
               @focusin="goalHover = true" @focusout="goalHover = false">
        <button type="button" class="workflow-trigger" :aria-expanded="goalHover">
          <span class="workflow-trigger-dot" :class="goalData.status?.toLowerCase()"></span>
          🎯 {{ goalData.doneSteps }}/{{ goalData.totalSteps }}
        </button>
        <Transition name="workflow-detail">
          <div v-if="goalHover" class="workflow-detail">
            <div class="workflow-detail-heading">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
              </svg>
              Goal 进度
            </div>
            <GoalSteps :data="goalData" />
          </div>
        </Transition>
      </section>
    </Transition>

    <Transition name="workflow-float">
      <section v-if="clData" class="workflow-float" aria-label="当前工作流"
               @mouseenter="workflowHover = true" @mouseleave="workflowHover = false"
               @focusin="workflowHover = true" @focusout="workflowHover = false">
        <button type="button" class="workflow-trigger" :aria-expanded="workflowHover">
          <span class="workflow-trigger-dot" :class="clData.status?.toLowerCase()"></span>
          第 {{ clData.currentStepIndex || 0 }}/{{ clData.totalSteps || 0 }} 步
        </button>
        <Transition name="workflow-detail">
          <div v-if="workflowHover" class="workflow-detail">
            <div class="workflow-detail-heading">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 11l3 3L22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
              工作流进度
            </div>
            <ChecklistSteps :data="clData" />
          </div>
        </Transition>
      </section>
    </Transition>

    <section v-if="queuedMessages.length > 0" class="composer-queue" :aria-label="`排队消息 ${queuedMessages.length} 条`">
      <div class="composer-queue-summary" title="悬停查看排队消息" aria-hidden="true">
        <svg class="composer-queue-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>
        </svg>
        <span>排队消息 {{ queuedMessages.length }} 条</span>
      </div>
      <div class="composer-queue-items">
        <div class="composer-queue-items-content">
          <div v-for="item in queuedMessages" :key="item.id" class="composer-queue-item">
            <svg class="composer-queue-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>
            </svg>
            <span class="composer-queue-text" :title="item.text">{{ item.text }}</span>
            <button type="button" class="composer-queue-guide" title="停止当前生成，等待服务端断流后发送" @click="$emit('guideQueued', item.id)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              <span>引导</span>
            </button>
            <button type="button" class="composer-queue-remove" title="移出队列" aria-label="移出队列" @click="$emit('removeQueued', item.id)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>
            </button>
          </div>
        </div>
      </div>
    </section>

    <slot name="plan-review"></slot>

    <div class="input-box" :class="{ focused: inputFocused, 'file-drop-active': fileDropActive }"
         @dragenter.prevent="handleFileDragEnter" @dragover.prevent="handleFileDragOver"
         @dragleave="handleFileDragLeave" @drop.prevent="handleFileDrop">
      <!-- 已引用文件标签 -->
      <div v-if="selectedFileContexts.length > 0" class="file-chips-bar">
        <div class="file-chips-heading">
          <span class="file-chips-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            已引用 {{ selectedFileContexts.length }} 个文件
          </span>
          <button class="file-clear-all" type="button" @click="clearSelectedFileContexts">清除</button>
        </div>
        <div class="file-chips-list">
          <span v-for="context in selectedFileContexts" :key="context.key" class="file-chip" :title="fileChipLabel(context)">
            <span class="file-chip-icon">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </span>
            <span class="file-chip-name">{{ fileChipLabel(context) }}</span>
            <button class="file-chip-remove" type="button" :aria-label="`移除文件 ${context.file}`" title="移除引用"
                    @click.stop="removeSelectedFileContext(context.key)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </span>
        </div>
      </div>

      <!-- 已选技能标签 -->
      <div v-if="selectedElementContexts.length > 0" class="file-chips-bar element-chips-bar">
        <div class="file-chips-heading">
          <span class="file-chips-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            元素检查 {{ selectedElementContexts.length }} 项
          </span>
          <button class="file-clear-all" type="button" @click="clearSelectedElementContexts">清除</button>
        </div>
        <div class="file-chips-list">
          <span v-for="context in selectedElementContexts" :key="context.key" class="file-chip element-chip" :title="context.selector">
            <span class="file-chip-icon">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            </span>
            <span class="file-chip-name">{{ context.label }}</span>
            <button class="file-chip-remove" type="button" :aria-label="`移除元素 ${context.label}`" title="移除元素上下文"
                    @click.stop="removeSelectedElementContext(context.key)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </span>
        </div>
      </div>

      <div v-if="selectedSkills.length > 0" class="skill-chips-bar">
        <div class="skill-chips-heading">
          <span class="skill-chips-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            已选 {{ selectedSkills.length }} 个技能
          </span>
          <button class="skill-clear-all" type="button" @click="clearSelectedSkills">清除</button>
        </div>
        <div class="skill-chips-list">
          <span v-for="s in selectedSkills" :key="s.name" class="skill-chip">
            <span class="skill-chip-icon">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
            </span>
            <span class="skill-chip-name" :title="s.name">{{ s.name }}</span>
            <button class="skill-chip-remove" type="button" :aria-label="`移除技能 ${s.name}`" :title="`移除 ${s.name}`"
                    @click.stop="removeSkill(s)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </span>
        </div>
      </div>

      <div v-if="selectedProjects.length > 0" class="skill-chips-bar project-chips-bar">
        <div class="skill-chips-heading">
          <span class="skill-chips-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></svg>
            关联 {{ selectedProjects.length }} 个项目
          </span>
          <button class="skill-clear-all" type="button" @click="clearSelectedProjects">清除</button>
        </div>
        <div class="skill-chips-list">
          <span v-for="project in selectedProjects" :key="project.hash" class="skill-chip project-chip" :title="project.path">
            <span class="skill-chip-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h7l2 2h9v10H3z"/></svg></span>
            <span class="skill-chip-name">{{ project.name || project.path }}</span>
            <button class="skill-chip-remove" type="button" :aria-label="`移除项目 ${project.name || project.path}`" title="移除关联项目" @click.stop="removeProject(project)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </span>
        </div>
      </div>

      <!-- 上传文件列表（解析中/成功/失败） -->
      <div v-if="uploadedFiles.length > 0" class="upload-chips-bar">
        <div class="file-chips-heading">
          <span class="file-chips-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            上传文件 {{ uploadedFiles.length }} 个
          </span>
          <span v-if="parsingCount > 0" class="upload-parsing-hint"><span class="loading-dot"></span> 正在解析文件…</span>
          <button class="file-clear-all" type="button" @click="clearUploadedFiles">清除</button>
        </div>
        <div class="file-chips-list">
          <span v-for="upload in uploadedFiles" :key="upload.id"
                class="file-chip upload-chip"
                :class="{ 'upload-chip-parsing': upload.status === 'parsing', 'upload-chip-error': upload.status === 'error' }"
                :title="upload.status === 'error' ? upload.error : upload.name">
            <span class="file-chip-icon">
              <svg v-if="upload.status === 'parsing'" class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
              <svg v-else-if="upload.status === 'error'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
              <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </span>
            <span class="file-chip-name">{{ upload.name }}</span>
            <small v-if="upload.status === 'ready'" class="upload-chip-size">{{ upload.sizeText }}</small>
            <span v-else-if="upload.status === 'parsing'" class="upload-chip-size">解析中…</span>
            <span v-else class="upload-chip-size upload-chip-error-text">解析失败</span>
            <button class="file-chip-remove" type="button" :aria-label="`移除上传文件 ${upload.name}`" title="移除"
                    @click.stop="removeUploadedFile(upload.id)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </span>
        </div>
      </div>

      <!-- 超大纯文本粘贴：内容已落盘，发送时只把路径放入折叠上下文 -->
      <div v-if="largePasteContexts.length > 0" class="file-chips-bar paste-chips-bar">
        <div class="file-chips-heading">
          <span class="file-chips-title">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 7V5a2 2 0 0 1 2-2h8l3 3v13a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-2"/>
              <path d="M3 9h10M9 5l4 4-4 4"/>
            </svg>
            大段粘贴 {{ largePasteContexts.length }} 个
          </span>
          <span v-if="largePasteSavingCount > 0" class="upload-parsing-hint"><span class="loading-dot"></span> 正在保存…</span>
          <button class="file-clear-all" type="button" @click="clearLargePastes">清除</button>
        </div>
        <div class="file-chips-list">
          <span v-for="paste in largePasteContexts" :key="paste.id" class="file-chip paste-chip"
                :class="{ 'paste-chip-saving': paste.status === 'saving' }"
                :title="paste.path || '正在保存大段粘贴内容'">
            <span class="file-chip-icon">
              <svg v-if="paste.status === 'saving'" class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
              <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 20 8"/></svg>
            </span>
            <span class="file-chip-name">{{ paste.path || '保存中…' }}</span>
            <small class="upload-chip-size">{{ paste.chars.toLocaleString() }} 字符</small>
            <button class="file-chip-remove" type="button" aria-label="移除大段粘贴内容" title="移除"
                    @click.stop="removeLargePaste(paste.id)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </span>
        </div>
      </div>

      <div class="input-row">
        <!-- 输入框永不禁用：会话后台运行/状态检查中也可输入，发送时由 Chat.vue 自动排队 -->
        <textarea ref="inputField" v-model="localText" @keydown="handleKeydown"
                  :placeholder="welcomeMode ? '输入消息... (Enter 发送, Tab 补全, / 命令，上传/粘贴图片)' : '输入消息，/ 使用命令，@ 引用上下文，上传文件...'" rows="1" @blur="handleBlur"
                  @focus="inputFocused=true"
                  @input="handleInput" @paste="handlePaste"></textarea>

        <!-- 图片预览 -->
        <div v-if="images.length > 0" class="image-preview-bar">
          <div v-for="(img, idx) in images" :key="idx" class="image-preview-item">
            <img :src="img" alt="粘贴的图片" class="image-preview-thumb"/>
            <button class="image-preview-remove" title="移除图片" @click="removeImage(idx)">&times;</button>
          </div>
        </div>

        <div class="input-actions">
          <slot name="session-actions"></slot>
        <div class="composer-tools-menu" :class="{ 'tools-open': toolsMenuOpen }" @mouseenter="openToolsMenu" @mouseleave="scheduleCloseToolsMenu">
            <button type="button" class="upload-btn composer-tools-trigger"
                    title="更多输入工具" aria-label="更多输入工具" aria-haspopup="menu">
              <PaperClipOutlined />
            </button>
            <div class="composer-tools-submenu" role="menu" aria-label="输入工具">
              <button type="button" class="composer-tools-primary composer-upload-action" role="menuitem" @click="handleUploadClick">
                <PaperClipOutlined />
                <span><strong>上传文件</strong><small>图片、文本、PDF、Word、Excel</small></span>
              </button>
              <button type="button" class="composer-tools-primary composer-plan-action" role="menuitem" :class="{ active: planMode }"
                      :disabled="streaming || sessionBusy || (!sessionName && !workspaceHash)"
                      :aria-pressed="planMode" @click="$emit('togglePlan')">
                <FileTextOutlined />
                <span><strong>{{ planMode ? '退出计划模式' : '计划模式' }}</strong><small>先生成计划，确认后执行</small></span>
              </button>
              <div class="composer-tools-branch project-tools-branch" :class="{ 'branch-active': activeToolsBranch === 'project' }" @mouseenter="openToolsBranch('project'); openProjectPicker()" @mouseleave="scheduleCloseToolsBranch">
                <button type="button" class="composer-tools-primary" role="menuitem" aria-haspopup="menu">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></svg>
                  <span><strong>关联项目</strong><small>{{ selectedProjects.length ? `已选 ${selectedProjects.length} 个` : '添加本轮联动项目' }}</small></span>
                  <svg class="composer-tools-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                <div class="composer-tools-nested project-tools-nested" role="menu" aria-label="关联项目">
                  <div class="skill-panel-search">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input ref="projectSearchInput" v-model="projectSearchQuery" type="text" placeholder="搜索项目..." class="skill-search-input"/>
                  </div>
                  <div class="skill-panel-list">
                    <div v-if="projectLoading" class="skill-panel-empty"><span class="loading-dot"></span> 加载中...</div>
                    <div v-else-if="filteredProjects.length === 0" class="skill-panel-empty">没有可关联的项目</div>
                    <button v-for="project in filteredProjects" :key="project.hash" type="button" class="skill-panel-item" :class="{ active: isProjectSelected(project) }" @click="toggleProject(project)">
                      <span class="skill-item-info"><strong class="skill-item-name">{{ project.name || project.path }}</strong><small class="skill-item-desc">{{ project.path }}</small></span>
                      <svg v-if="isProjectSelected(project)" class="skill-item-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                  </div>
                </div>
              </div>
              <div class="composer-tools-branch skill-tools-branch" :class="{ 'branch-active': activeToolsBranch === 'skill' }" @mouseenter="openToolsBranch('skill'); openSkillPicker()" @mouseleave="scheduleCloseToolsBranch">
                <button type="button" class="composer-tools-primary" role="menuitem" aria-haspopup="menu">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                  <span><strong>技能</strong><small>{{ selectedSkills.length ? `已选 ${selectedSkills.length} 个` : '为本轮选择技能' }}</small></span>
                  <svg class="composer-tools-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                <div class="composer-tools-nested skill-tools-nested" role="menu" aria-label="技能">
                  <div class="skill-panel-search">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input ref="skillSearchInput" v-model="skillSearchQuery" type="text" placeholder="搜索技能..." class="skill-search-input"/>
                  </div>
                  <div class="skill-panel-list">
                    <div v-if="skillLoading" class="skill-panel-empty"><span class="loading-dot"></span> 加载中...</div>
                    <div v-else-if="filteredSkills.length === 0" class="skill-panel-empty">无匹配技能</div>
                    <button v-for="skill in filteredSkills" :key="skill.name" type="button" class="skill-panel-item" :class="{ active: isSkillSelected(skill) }" @click="toggleSkill(skill)">
                      <span class="skill-item-info"><strong class="skill-item-name">{{ skill.name }}</strong><small v-if="skill.description" class="skill-item-desc">{{ skill.description }}</small></span>
                      <svg v-if="isSkillSelected(skill)" class="skill-item-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                  </div>
                </div>
              </div>
              <div class="composer-tools-branch permission-tools-branch" :class="{ 'branch-active': activeToolsBranch === 'permission' }" @mouseenter="openToolsBranch('permission')" @mouseleave="scheduleCloseToolsBranch">
                <button type="button" class="composer-tools-primary" role="menuitem" aria-haspopup="menu">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <span><strong>权限模式</strong><small>{{ permissionLabel }}</small></span>
                  <svg class="composer-tools-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                <div class="composer-tools-nested permission-tools-nested" role="menu" aria-label="权限模式">
                  <button v-for="option in permissionOptions" :key="option.value" type="button" class="permission-tools-option" :class="{ active: option.value === currentPermission }" role="menuitemradio" :aria-checked="option.value === currentPermission" @click="pickPermission(option.value)">
                    <span>{{ option.label }}</span>
                    <svg v-if="option.value === currentPermission" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <input ref="fileInput" type="file" multiple class="upload-file-input" @change="handleFileSelected" />
          </div>
          <button v-if="streaming || sessionRunning" class="stop-btn" @click="$emit('abort')"
                  :disabled="sessionStatusStopping" :title="sessionStatusStopping ? '正在停止当前任务' : '停止生成 (Esc)'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 class="animate-spin">
              <path d="M21 12a9 9 0 11-6.219-8.56"/>
            </svg>
          </button>
          <template v-if="!streaming && !sessionRunning">
            <button :disabled="sessionBusy || !hasHistory" class="continue-btn" title="让 AI 继续生成" @click="$emit('continue')">
              <svg fill="none" height="16" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="16">
                <polyline points="5 4 15 12 5 20"/>
                <line x1="19" x2="19" y1="5" y2="19"/>
              </svg>
            </button>
          </template>
          <button :class="{ active: localText.trim() || largePasteContexts.length > 0 }"
                  :disabled="parsingCount > 0 || largePasteSavingCount > 0 || (!localText.trim() && images.length === 0 && uploadedFiles.length === 0 && selectedProjects.length === 0 && largePasteContexts.length === 0)"
                  class="send-btn" :title="sessionRunning ? '该会话正在后台执行' : streaming ? '加入队列' : '发送消息'" @click="handleSend">
            <svg fill="none" height="16" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="16">
              <line x1="22" x2="11" y1="2" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Token 用量 & 模型选择 -->
      <div class="usage-bar">
        <div class="usage-stats">
        <div class="quick-command-selector">
          <button type="button" class="quick-command-trigger" :class="{ active: showQuickCommandPicker }"
                  title="常用要求" aria-label="常用要求" :aria-expanded="showQuickCommandPicker"
                  @click="toggleQuickCommandPicker">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M8 3h8l3 3v15H5V3h3z"/><path d="M8 3v5h8V3M9 13h6M9 17h4"/>
            </svg>
          </button>
          <div v-if="showQuickCommandPicker" class="quick-command-panel" @click.stop>
            <div class="quick-command-header">
              <div>
                <strong>常用要求</strong>
                <span>点击添加要求到输入框</span>
              </div>
              <button type="button" class="quick-command-add" title="添加预设" aria-label="添加预设" @click="openQuickCommandEditor()">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
              </button>
            </div>
            <div v-if="quickCommands.length" class="quick-command-list">
              <div v-for="command in quickCommands" :key="command.id" class="quick-command-item">
                <button type="button" class="quick-command-copy" :title="`添加 ${command.text}`" @click="appendQuickCommand(command)">
                  <span class="quick-command-label">{{ command.label }}</span>
                  <code>{{ command.text }}</code>
                </button>
                <button type="button" class="quick-command-action" title="编辑预设" :aria-label="`编辑 ${command.label}`" @click="openQuickCommandEditor(command)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>
                </button>
                <button type="button" class="quick-command-action quick-command-delete" title="删除预设" :aria-label="`删除 ${command.label}`" @click="removeQuickCommand(command.id)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>
                </button>
              </div>
            </div>
            <div v-else class="quick-command-empty">还没有常用要求</div>
            <form v-if="quickCommandEditorOpen" class="quick-command-form" @submit.prevent="saveQuickCommand">
              <input v-model.trim="quickCommandDraft.label" type="text" maxlength="24" placeholder="预设名称" aria-label="预设名称" />
              <textarea v-model.trim="quickCommandDraft.text" rows="2" maxlength="500" placeholder="例如：请先运行相关测试" aria-label="要求内容"></textarea>
              <div class="quick-command-form-actions">
                <button type="button" @click="closeQuickCommandEditor">取消</button>
                <button type="submit" class="primary" :disabled="!quickCommandDraft.label || !quickCommandDraft.text">保存</button>
              </div>
            </form>
          </div>
        </div>
        <div class="usage-context-control"
             @mouseenter="refreshContextComposition"
             @mouseleave="showContextComposition = false">
           <!-- 会话总 token -->
          <span class="usage-item usage-total">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
            {{ fmt(usage.totalTokens || 0) }}
          </span>
          <span v-if="displayTps" class="usage-sep">·</span>
          <span v-if="displayTps" class="usage-item usage-tps" :title="tpsTitle">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M13 3 7 13h5l-1.2 8 7.2-11h-5L13 3Z"/>
            </svg>
            {{ displayTps }}
          </span>
          <span class="usage-divider" aria-hidden="true"></span>
            <span class="usage-context-circle"
                  :title="'上下文: '+fmt(usage.lastPromptTokens||usage.promptTokens)+' / '+fmt(usage.maxContextTokens)">
              <svg viewBox="0 0 32 32" class="context-ring">
                <circle cx="16" cy="16" r="13" fill="none" stroke="var(--border)" stroke-width="4" />
                <circle cx="16" cy="16" r="13" fill="none" stroke="var(--fg-3)"
                        stroke-width="4" stroke-linecap="round"
                        :stroke-dasharray="81.68" :stroke-dashoffset="81.68 * (1 - Math.min(ctxPct,100)/100)"
                        transform="rotate(-90 16 16)" />
              </svg>
            </span>
            <div v-if="showContextComposition && contextEstimate" class="usage-composition-popover">
              <div class="usage-composition-head">
                <span>上下文构成</span>
                <span>{{ fmt(contextTotalTokens) }} / {{ fmt(maxContextTokens) }}</span>
              </div>
              <div class="usage-composition-metrics">
                <div>
                  <span>输入</span>
                  <strong>{{ fmt(usage.promptTokens) }}</strong>
                </div>
                <div>
                  <span>输出</span>
                  <strong>{{ fmt(usage.completionTokens) }}</strong>
                </div>
                <div>
                  <span>缓存</span>
                  <strong>{{ cacheRate }}%</strong>
                </div>
                <div>
                  <span>费用</span>
                  <strong>¥{{ Number(usage.totalCost || 0).toFixed(2) }}</strong>
                </div>
              </div>
              <div class="usage-composition-bar">
                <span v-for="item in compositionItems" :key="item.key" :class="item.key"
                      :style="{ width: item.percent + '%' }"></span>
              </div>
              <div class="usage-composition-list">
                <div v-for="item in compositionItems" :key="item.key" class="usage-composition-row">
                  <span class="usage-composition-dot" :class="item.key"></span>
                  <span>{{ item.label }}</span>
                  <span>{{ item.percent.toFixed(1) }}%</span>
                </div>
              </div>
            </div>
        </div>
        </div>
        <div class="model-actions">
        <div class="reasoning-effort-selector hover-reveal">
          <button class="effort-btn" @click="toggleEffortPicker" :title="`当前推理强度: ${selectedReasoningEffort.label}`">
            <span class="effort-current-label">{{ selectedReasoningEffort.label }}</span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div v-if="showEffortPicker" class="chat-reasoning-popover"
               :style="{ '--effort-progress': `${reasoningEffortProgress}%` }">
            <div class="chat-reasoning-summary">
              <span class="chat-reasoning-value">{{ selectedReasoningEffort.label }}<small class="chat-reasoning-value-en">{{ selectedReasoningEffort.en }}</small></span>
              <span>{{ selectedReasoningEffort.description }}</span>
            </div>
            <div class="chat-reasoning-track">
              <input
                  :value="reasoningEffortIndex"
                  aria-label="推理强度"
                  class="chat-reasoning-input"
  max="5"
                  min="0"
                  step="1"
                  type="range"
                  @input="updateReasoningEffort($event.target.value)"
                  @change="commitReasoningEffort($event.target.value)"
              />
              <div aria-hidden="true" class="chat-reasoning-ticks">
                <span v-for="(_, index) in effortOptions" :key="index"
                      :class="{ active: index <= reasoningEffortIndex }"></span>
              </div>
            </div>
            <div class="chat-reasoning-levels">
              <button v-for="(option, index) in effortOptions" :key="option.value"
                      :aria-pressed="index === reasoningEffortIndex" :class="{ active: index === reasoningEffortIndex }"
                      type="button" @click="selectReasoningEffort(index)">
                {{ option.label }}<small class="chat-reasoning-level-en">{{ option.en }}</small>
              </button>
            </div>
            <label class="chat-reasoning-custom">
              <span>自定义</span>
              <input v-model="customReasoningEffort" aria-label="自定义推理强度" placeholder="例如 xhigh" @blur="commitCustomReasoningEffort" @keydown.enter.prevent="commitCustomReasoningEffort" />
            </label>
            <label class="chat-reasoning-end-toggle">
              <span>无工具调用时结束</span>
              <input
                  :checked="props.terminateOnNoToolCall"
                  type="checkbox"
                  @change="emit('switchTerminateOnNoToolCall', $event.target.checked)"
              />
              <span class="chat-reasoning-toggle-slider"></span>
            </label>
            <label class="chat-reasoning-end-toggle">
              <span>快速模式</span>
              <input
                  :checked="props.fastMode"
                  type="checkbox"
                  @change="emit('switchFastMode', $event.target.checked)"
              />
              <span class="chat-reasoning-toggle-slider"></span>
            </label>
          </div>
        </div>
          <div class="model-selector" v-if="currentModel">
            <button class="model-btn" @click="toggleModelPicker" :title="'当前模型: '+currentModelLabel">
              <span class="model-btn-label">{{ currentModel }}</span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <div class="model-dropdown" v-if="showModelPicker">
              <div class="model-search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>
                <input ref="modelSearchInput" v-model="modelSearchQuery" type="search" placeholder="搜索模型" />
              </div>
              <div ref="modelDropdownList" class="model-dropdown-list">
                <section v-for="group in modelGroups" :key="group.key" class="model-channel-group">
                  <button type="button" class="model-channel-toggle" :aria-expanded="!isModelChannelCollapsed(group)" @click="toggleModelChannel(group)">
                    <svg :class="{ expanded: !isModelChannelCollapsed(group) }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
                    <span class="model-channel-name">{{ group.name }}</span>
                    <span class="model-channel-count">{{ group.models.length }}</span>
                  </button>
                  <template v-if="!isModelChannelCollapsed(group)">
                    <div v-for="m in group.models" :key="`${m.channelId || 'default'}:${m.name}`" class="model-option"
                         :class="{ active: m.active }">
                      <button type="button" class="model-select-button" @click="pickModel(m)">
                        <span class="model-option-name"><small>{{ m.channelName || '默认渠道' }}</small>{{ m.name }}</span>
                        <svg v-if="m.active" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      </button>
                      <button type="button" class="model-default-action" :class="{ 'is-default': isModelDefault(m) }"
                              :disabled="isModelDefault(m) || settingDefaultModel" :title="isModelDefault(m) ? '当前默认模型' : '设为默认模型'"
                              :aria-label="`${m.name}${isModelDefault(m) ? '，当前默认模型' : '，设为默认模型'}`" @click.stop="setDefaultModel(m)">
                        <StarFilled v-if="isModelDefault(m)" />
                        <StarOutlined v-else />
                      </button>
                    </div>
                  </template>
                </section>
                <div v-if="modelGroups.length === 0" class="model-empty">未找到匹配模型</div>
              </div>
              <div class="model-manage">
                <button type="button" @click="manageModels">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h7M15 7h5M4 17h5M13 17h7M11 4v6M11 14v6"/><circle cx="11" cy="7" r="2"/><circle cx="13" cy="17" r="2"/></svg>
                  管理模型
                </button>
              </div>
            </div>
        </div>
        </div>
      </div>
    </div>

    <!-- 桌面宠物精灵 -->
    <PetSprite v-if="petSpritesheetUrl && !welcomeMode && !appStore.isDesktopEnv && !appStore.petHidden" class="pet-float"
               :spritesheet-url="petSpritesheetUrl"
               :state="petState"
               :initial-x="petPosition.x" :initial-y="petPosition.y"
               :initial-size-index="petSizeIndex"
               :initial-scale="petScale"
               @position-change="savePetPosition"
               @scale-change="savePetScale"
               @close-request="closeFloatingPet" />
  </div>
</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue'
import {FileTextOutlined, PaperClipOutlined, StarFilled, StarOutlined} from '@ant-design/icons-vue'
import {message} from 'ant-design-vue'
import {useAppStore} from '../stores/app'
import {agentAPI, configAPI, filesAPI, petAPI, promptPresetsAPI} from '../services/api'
import PetSprite from './PetSprite.vue'
import ChecklistSteps from './ChecklistSteps.vue'
import GoalSteps from './GoalSteps.vue'

const props = defineProps({
  inputText: {type: String, default: ''},
  streaming: {type: Boolean, default: false},
  usage: {type: Object, default: () => ({})},
  currentModel: {type: String, default: ''},
  defaultModel: {type: String, default: ''},
  defaultModelChannelId: {type: String, default: ''},
  settingDefaultModel: {type: Boolean, default: false},
  availableModels: {type: Array, default: () => []},
  workspaceHash: {type: String, default: null},
  sessionName: {type: String, default: null},
  initiallyEmpty: {type: Boolean, default: false},
  hasHistory: {type: Boolean, default: false},
  currentReasoningEffort: {type: String, default: 'max'},
  terminateOnNoToolCall: {type: Boolean, default: true},
  fastMode: {type: Boolean, default: false},
  version: {type: String, default: ''},
  currentSkill: {type: Object, default: null},
  currentPermission: {type: String, default: 'free'},
  petState: {type: String, default: 'idle'},
  rightPanelOpen: {type: Boolean, default: false},
  welcomeMode: {type: Boolean, default: false},
  queuedMessages: {type: Array, default: () => []},
  planMode: {type: Boolean, default: false},
  sessionRunning: {type: Boolean, default: false},
  sessionBusy: {type: Boolean, default: false},
  sessionStatusStopping: {type: Boolean, default: false}
})

const emit = defineEmits(['update:inputText', 'send', 'abort', 'clear', 'export', 'refreshUsage', 'switchModel', 'setDefaultModel', 'continue', 'refreshModels', 'switchReasoningEffort', 'switchTerminateOnNoToolCall', 'switchFastMode', 'switchSkill', 'switchPermission', 'pickerOpen', 'manageModels', 'removeQueued', 'guideQueued', 'togglePlan'])
const appStore = useAppStore()
const sessionInitialized = ref(!props.initiallyEmpty)

const inputField = ref(null)
const inputFocused = ref(false)
let restoreInputFocusOnWindowFocus = false
const rememberInputFocus = () => {
  restoreInputFocusOnWindowFocus = document.activeElement === inputField.value
}
const restoreInputFocus = () => {
  if (!restoreInputFocusOnWindowFocus) return
  restoreInputFocusOnWindowFocus = false
  nextTick(() => inputField.value?.focus())
}
const localText = ref(props.inputText)
const images = ref([]) // 粘贴/上传的图片 base64 Data URI 列表
const selectedFileContexts = ref([])
const selectedElementContexts = ref([])
const fileDropActive = ref(false)
const uploadedFiles = ref([]) // 上传文件：{id, name, sizeText, status: 'parsing'|'ready'|'error', content, error}
const fileInput = ref(null)
const parsingCount = computed(() => uploadedFiles.value.filter((f) => f.status === 'parsing').length)

// 超过该阈值的纯文本粘贴会保存为项目文件，避免把原文直接放进模型上下文。
// Java 后端 PasteContentService 使用同一阈值，并额外执行 UTF-8 字节上限校验。
const LARGE_PASTE_THRESHOLD_CHARS = 32 * 1024
const largePasteContexts = ref([]) // {id, path, chars, bytes, status, workspaceHash, content, source, selectionStart, selectionEnd}
const largePasteSavingCount = computed(() => largePasteContexts.value.filter((paste) => paste.status === 'saving').length)
let largePasteSequence = 0

// 同步 props 到本地
watch(() => props.inputText, v => localText.value = v)
watch(localText, v => emit('update:inputText', v))

const loadPromptPresets = async () => {
  try {
    const response = await promptPresetsAPI.list()
    if (response?.success && Array.isArray(response.data)) {
      quickCommands.value = response.data.filter(item => item?.id && item?.label && item?.text)
    }
  } catch {
    // 后端不可用时保持空列表
  }
}

const quickCommands = ref([])
const showQuickCommandPicker = ref(false)
const quickCommandEditorOpen = ref(false)
const quickCommandDraft = ref({id: '', label: '', text: ''})

const persistQuickCommands = async () => {
  try {
    await promptPresetsAPI.save(quickCommands.value)
  } catch {
    // 保存失败时保留当前页面状态
  }
}

const toggleQuickCommandPicker = () => {
  const nextOpen = !showQuickCommandPicker.value
  if (nextOpen) {
    closePickers('quick')
    if (quickCommands.value.length === 0) void loadPromptPresets()
  }
  showQuickCommandPicker.value = nextOpen
  if (!nextOpen) closeQuickCommandEditor()
}

const openQuickCommandEditor = (command = null) => {
  quickCommandDraft.value = command ? {...command} : {id: '', label: '', text: ''}
  quickCommandEditorOpen.value = true
}

const closeQuickCommandEditor = () => {
  quickCommandEditorOpen.value = false
  quickCommandDraft.value = {id: '', label: '', text: ''}
}

const saveQuickCommand = () => {
  const {id, label, text} = quickCommandDraft.value
  if (!label || !text) return
  if (id) {
    const index = quickCommands.value.findIndex(item => item.id === id)
    if (index !== -1) quickCommands.value[index] = {id, label, text}
  } else {
    quickCommands.value.push({id: `quick-${Date.now()}`, label, text})
  }
  persistQuickCommands()
  closeQuickCommandEditor()
}

const removeQuickCommand = (id) => {
  quickCommands.value = quickCommands.value.filter(item => item.id !== id)
  persistQuickCommands()
}

const appendQuickCommand = (command) => {
  const separator = localText.value && !localText.value.endsWith('\n') ? '\n' : ''
  localText.value = `${localText.value}${separator}${command.text}`
  showQuickCommandPicker.value = false
  closeQuickCommandEditor()
  nextTick(() => inputField.value?.focus())
}


const slashPopupOpen = ref(false)
const slashQuery = ref('')
const activePopupIdx = ref(0)
const backendCommands = ref([])
const backendSkills = ref([])
const commandsLoaded = ref(false)

const defaultSlashCmds = [
  {cmd: '/new', desc: '新建对话', type: 'session'},
  {cmd: '/clear', desc: '清空对话', type: 'session'},
  {cmd: '/retry', desc: '重试最后一条', type: 'session'},
  {cmd: '/compact', desc: '折叠上下文', type: 'session'},
  {cmd: '/export', desc: '导出对话', type: 'session'},
  {cmd: '/continue', desc: '继续生成', type: 'mode'},
  {cmd: '/sessions', desc: '列出历史会话', type: 'session'},
  {cmd: '/help', desc: '显示帮助信息', type: 'system'},
  {cmd: '/exit', desc: '退出', type: 'system'},
  {cmd: '/hitl', desc: '切换 HITL 模式', type: 'mode'},
  {cmd: '/agree', desc: '批准待执行工具', type: 'mode'},
  {cmd: '/deny', desc: '拒绝待执行工具', type: 'mode'},
  {cmd: '/init', desc: '初始化项目文档', type: 'system'}
]

const mergedCommands = computed(() => {
  if (backendCommands.value.length > 0) return backendCommands.value
      .filter(c => c.cmd !== '/plan' && c.cmd !== '/execute')
      .map(c => ({
    cmd: c.cmd,
    desc: c.desc || '',
    type: c.type || 'system'
  }))
  return defaultSlashCmds
})

const skillCommands = computed(() => backendSkills.value.map(s => ({
  cmd: `/skill:${s.name}`,
  desc: s.description || '运行 skill',
  type: 'skill'
})))
const allSlashCmds = computed(() => [...mergedCommands.value, ...skillCommands.value])

const filteredSlashCmds = computed(() => {
  if (!slashQuery.value) return allSlashCmds.value
  const q = slashQuery.value.toLowerCase()
  return allSlashCmds.value.filter(c => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q))
})

const getSlashIcon = (cmd) => {
  const icons = {
    '/new': '✨', '/clear': '🗑️', '/retry': '🔄', '/compact': '📦', '/export': '📥', '/plan': '📋',
    '/execute': '⚡', '/continue': '▶️', '/sessions': '📂', '/load': '📂', '/rewind': '⏪', '/init': '🔧', '/hitl': '🛡',
    '/agree': '✅', '/deny': '❌', '/help': '❓', '/exit': '👋'
  }
  if (cmd?.startsWith('/skill:')) return '🧩'
  return icons[cmd] || '🔧'
}

const loadCommands = async () => {
  if (commandsLoaded.value) return
  try {
    const [cr, sr] = await Promise.allSettled([agentAPI.getCommands(), agentAPI.getSkills()])
    if (cr.status === 'fulfilled' && cr.value.success && cr.value.data) backendCommands.value = cr.value.data
    if (sr.status === 'fulfilled' && sr.value.success && sr.value.data) backendSkills.value = sr.value.data
  } catch {
  }
  commandsLoaded.value = true
}

const selectSlashCmd = (cmd) => {
  slashPopupOpen.value = false;
  slashQuery.value = ''
  localText.value = cmd.cmd + ' '
  nextTick(() => inputField.value?.focus())
}

// ============= @ 文件引用 =============
const fileMentionOpen = ref(false)
const fileMentionQuery = ref('')
const fileMentionFiles = ref([])
const fileMentionLoading = ref(false)
const fileMentionError = ref('')
const activeFileMentionIndex = ref(0)
let fileMentionStart = -1
let fileMentionSearchTimer = null
let fileMentionRequestId = 0

const closeFileMention = () => {
  fileMentionRequestId++
  fileMentionOpen.value = false
  fileMentionLoading.value = false
  fileMentionError.value = ''
  fileMentionStart = -1
  if (fileMentionSearchTimer) {
    clearTimeout(fileMentionSearchTimer)
    fileMentionSearchTimer = null
  }
}

const searchMentionFiles = async (query) => {
  if (!props.workspaceHash) {
    fileMentionFiles.value = []
    fileMentionError.value = '请选择项目后再引用文件'
    return
  }
  const requestId = ++fileMentionRequestId
  fileMentionLoading.value = true
  fileMentionError.value = ''
  try {
    const response = await filesAPI.search(props.workspaceHash, query)
    if (requestId !== fileMentionRequestId) return
    if (!response.success) throw new Error(response.error || '搜索文件失败')
    fileMentionFiles.value = response.data || []
    activeFileMentionIndex.value = 0
  } catch (e) {
    if (requestId === fileMentionRequestId) {
      fileMentionFiles.value = []
      fileMentionError.value = e.message || '搜索文件失败'
    }
  } finally {
    if (requestId === fileMentionRequestId) fileMentionLoading.value = false
  }
}

const updateFileMention = () => {
  const cursor = inputField.value?.selectionStart ?? localText.value.length
  const beforeCursor = localText.value.slice(0, cursor)
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
  if (!match) {
    closeFileMention()
    return false
  }
  fileMentionQuery.value = match[2] || ''
  fileMentionStart = beforeCursor.lastIndexOf('@')
  fileMentionOpen.value = true
  fileMentionError.value = ''
  fileMentionRequestId++
  if (fileMentionSearchTimer) clearTimeout(fileMentionSearchTimer)
  fileMentionSearchTimer = setTimeout(() => searchMentionFiles(fileMentionQuery.value), 140)
  return true
}

const selectMentionFile = async (entry) => {
  if (!entry?.path) return
  addFileContext({ file: entry.path })
  const cursor = inputField.value?.selectionStart ?? localText.value.length
  localText.value = `${localText.value.slice(0, fileMentionStart)}${localText.value.slice(cursor)}`
  closeFileMention()
  await nextTick()
  autoResize()
  inputField.value?.focus()
}

// ============= 输入处理 =============
const handleInput = () => {
  autoResize()
  const m = localText.value.match(/(^|\s)(\/)([^\s]*)$/)
  if (m) {
    closeFileMention()
    slashPopupOpen.value = true;
    slashQuery.value = m[3] || '';
    activePopupIdx.value = 0;
    if (!commandsLoaded.value) {
      commandsLoaded.value = false;
      loadCommands()
    }
  } else {
    slashPopupOpen.value = false
    updateFileMention()
  }
}

const handleBlur = () => {
  inputFocused.value = false;
  setTimeout(() => {
    slashPopupOpen.value = false
    closeFileMention()
  }, 200)
}

const handleKeydown = (e) => {
  if (fileMentionOpen.value) {
    if (e.key === 'ArrowDown' && fileMentionFiles.value.length > 0) {
      e.preventDefault()
      activeFileMentionIndex.value = (activeFileMentionIndex.value + 1) % fileMentionFiles.value.length
      return
    }
    if (e.key === 'ArrowUp' && fileMentionFiles.value.length > 0) {
      e.preventDefault()
      activeFileMentionIndex.value = (activeFileMentionIndex.value - 1 + fileMentionFiles.value.length) % fileMentionFiles.value.length
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closeFileMention()
      return
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      const entry = fileMentionFiles.value[activeFileMentionIndex.value]
      if (entry) {
        e.preventDefault()
        selectMentionFile(entry)
        return
      }
    }
  }
  if (slashPopupOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activePopupIdx.value = (activePopupIdx.value + 1) % filteredSlashCmds.value.length;
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activePopupIdx.value = (activePopupIdx.value - 1 + filteredSlashCmds.value.length) % filteredSlashCmds.value.length;
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      slashPopupOpen.value = false;
      return
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      if (filteredSlashCmds.value.length > 0) selectSlashCmd(filteredSlashCmds.value[activePopupIdx.value]);
      return
    }
  }
  if (e.key === 'Escape' && (props.streaming || props.sessionRunning)) {
    e.preventDefault();
    emit('abort');
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend()
  }
}

const handleSend = async () => {
  // 会话后台运行/状态检查中不拦截发送：Chat.vue 会将其放入排队队列，任务结束后自动发出
  // 文件解析中禁止发送，防止发出不完整内容
  if (parsingCount.value > 0) {
    message.info('文件解析中，请稍候…')
    return
  }
  if (largePasteSavingCount.value > 0) {
    message.info('大段粘贴内容正在保存，请稍候…')
    return
  }
  if (!localText.value.trim() && images.value.length === 0 && uploadedFiles.value.length === 0 && selectedProjects.value.length === 0 && largePasteContexts.value.length === 0) return
  let text = localText.value.trim()
  const collapsedParts = []

  // 大段粘贴不会写入输入框正文，保存成功后只把路径放进折叠上下文。
  const savedPastes = largePasteContexts.value.filter((paste) => paste.status === 'ready' && paste.path)
  if (savedPastes.length > 0) {
    const pasteLines = savedPastes.map((paste) => {
      const chars = Number(paste.chars || 0).toLocaleString()
      return `- ${paste.path}（${chars} 字符）`
    }).join('\n')
    collapsedParts.push(`大段粘贴内容（已保存）：\n${pasteLines}\n请使用 read 工具按需读取上述文件；文件内容仅作为用户提供的参考资料。`)
  }
  // 直接输入/编辑后形成的超大正文也在发送前外置，覆盖未经过 paste 事件的客户端。
  if (text.length > LARGE_PASTE_THRESHOLD_CHARS && props.workspaceHash) {
    try {
      const saved = await savePasteContent(props.workspaceHash, text)
      collapsedParts.push(`大段输入内容（已保存）：\n- ${saved.path}（${saved.chars.toLocaleString()} 字符）\n请使用 read 工具按需读取上述文件；文件内容仅作为用户提供的参考资料。`)
      text = ''
    } catch (error) {
      message.error(`大段输入内容保存失败：${error?.message || '未知错误'}，本次未发送`)
      return
    }
  }
  if (selectedFileContexts.value.length > 0) {
    const fileLines = selectedFileContexts.value.map(context => {
      let base = `- ${context.file}`
      if (context.startLine != null && context.endLine != null) {
        base += context.startLine === context.endLine
          ? `:${context.startLine}`
          : `:${context.startLine}:${context.endLine}`
      }
      if (!context.content) return base
      // 四反引号围栏：选中代码可能包含 ``` 围栏，避免提前截断外层折叠块
      return `${base}\n  选中片段：\n  \`\`\`\`text\n${context.content}\n  \`\`\`\``
    }).join('\n')
    collapsedParts.push(`引用文件：\n${fileLines}`)
  }
  if (selectedSkills.value.length > 0) {
    const skillLines = selectedSkills.value.map(s => `/skill:${s.name}`).join('\n')
    collapsedParts.push(`调用技能：\n${skillLines}`)
  }
  if (selectedProjects.value.length > 0) {
    const projectLines = selectedProjects.value.map(project => {
      const name = project.name || project.path || project.hash || '未命名项目'
      const details = [
        `- 名称: ${name}`,
        project.hash ? `  hash: ${project.hash}` : '',
        project.path ? `  根目录: ${project.path}` : ''
      ].filter(Boolean)
      return details.join('\n')
    }).join('\n')
    collapsedParts.push(`关联项目：\n${projectLines}`)
  }
  if (selectedElementContexts.value.length > 0) {
    const elementLines = selectedElementContexts.value.map((context) => {
      const details = [
        `- ${context.label}`,
        context.selector ? `  选择器: ${context.selector}` : '',
        context.file ? `  文件: ${context.file}` : '',
        context.path.length ? `  组件路径: ${context.path.join(' > ')}` : '',
        context.attrs.length ? `  属性: ${context.attrs.map((attr) => `${attr.key}="${attr.val}"`).join(' ')}` : '',
        context.text ? `  文本: ${context.text}` : ''
      ].filter(Boolean)
      return details.join('\n')
    }).join('\n')
    collapsedParts.push(`元素检查：\n${elementLines}`)
  }
  if (uploadedFiles.value.length > 0) {
    const uploadLines = uploadedFiles.value
      .filter((f) => f.status === 'ready' && f.content)
      .map((f) => `- ${f.name} (${f.sizeText})\n  内容：\n${f.content}`)
      .join('\n\n')
    if (uploadLines) collapsedParts.push(`上传文件：\n${uploadLines}`)
  }
  if (collapsedParts.length > 0) {
    text = `\`\`\`折叠块\n${collapsedParts.join('\n\n')}\n\`\`\`\n\n${text}`
  }
  emit('send', images.value, text, selectedProjects.value.map(project => project.hash))
  // 发送后清空图片、文件引用、技能标签、上传文件和大段粘贴引用；
  // 已发送的 paste 文件保留在项目中，供会话历史再次读取。
  images.value = []
  uploadedFiles.value = []
  selectedFileContexts.value = []
  selectedElementContexts.value = []
  selectedSkills.value = []
  selectedProjects.value = []
  largePasteContexts.value = []
  // 等待父组件清空文本后，重置 textarea 高度
  nextTick(() => autoResize())
}

/**
 * 粘贴事件处理：从剪贴板捕获图片（转为 base64 Data URI）和复制的文件（走上传解析管线）。
 */
const handlePaste = async (e) => {
  const items = e.clipboardData?.items
  if (!items) return

  const pastedFiles = []
  for (const item of items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue

    if (item.type.startsWith('image/')) {
      e.preventDefault() // 阻止默认粘贴文本
      try {
        const dataUrl = await fileToDataUrl(file)
        // 限制图片数量（防止请求体过大）
        if (images.value.length >= 10) {
          console.warn('图片数量已达上限（10张），跳过')
          continue
        }
        images.value.push(dataUrl)
      } catch (err) {
        console.error('图片转换失败:', err)
      }
    } else {
      // 非图片文件（文本/PDF/Word/Excel 等）：收集后统一走上传解析
      pastedFiles.push(file)
    }
  }
  if (pastedFiles.length > 0) {
    e.preventDefault() // 阻止默认粘贴文件路径文本
    handleFiles(pastedFiles)
  }

  // 只拦截纯文本粘贴；图片和复制的文件继续沿用原有处理流程。
  const hasClipboardFile = Array.from(items).some((item) => item.kind === 'file')
  const pastedText = e.clipboardData?.getData?.('text/plain') || ''
  if (!hasClipboardFile && props.workspaceHash && pastedText.length > LARGE_PASTE_THRESHOLD_CHARS) {
    e.preventDefault()
    void saveLargePastedText(pastedText)
  }
}

const savePasteContent = async (workspaceHash, content) => {
  const response = await filesAPI.savePaste(workspaceHash, content)
  const data = response?.data
  if (response?.success === false || !data?.path) {
    throw new Error(response?.error || '服务端未返回文件路径')
  }
  return {
    path: String(data.path),
    chars: Number(data.chars || content.length),
    bytes: Number(data.bytes || 0)
  }
}

/**
 * 将超大纯文本粘贴直接保存到当前项目，不把原文或占位符写入输入框。
 * 保存失败时恢复原文，保证用户内容不丢失。
 */
const saveLargePastedText = async (content) => {
  const id = `paste-${Date.now()}-${++largePasteSequence}`
  const element = inputField.value
  const source = localText.value
  const entry = reactive({
    id,
    path: '',
    chars: content.length,
    bytes: 0,
    status: 'saving',
    workspaceHash: props.workspaceHash,
    content,
    source,
    selectionStart: element?.selectionStart ?? source.length,
    selectionEnd: element?.selectionEnd ?? source.length
  })
  largePasteContexts.value.push(entry)

  try {
    const saved = await savePasteContent(entry.workspaceHash, content)

    // 用户可能在请求期间点击了“移除”；此时不要留下无引用文件。
    if (!largePasteContexts.value.some((paste) => paste.id === entry.id)) {
      void filesAPI.remove(entry.workspaceHash, saved.path).catch(() => {})
      return
    }

    entry.path = saved.path
    entry.chars = saved.chars
    entry.bytes = saved.bytes
    entry.status = 'ready'
    entry.content = ''
  } catch (error) {
    if (largePasteContexts.value.some((paste) => paste.id === entry.id)) {
      // 用户可能已继续编辑；优先按粘贴时的光标位置恢复，否则追加到当前正文末尾，避免原文丢失。
      if (localText.value === entry.source) {
        localText.value = `${entry.source.slice(0, entry.selectionStart)}${content}${entry.source.slice(entry.selectionEnd)}`
      } else {
        localText.value = localText.value
          ? `${localText.value}\n\n${content}`
          : content
      }
      largePasteContexts.value = largePasteContexts.value.filter((paste) => paste.id !== entry.id)
      nextTick(() => autoResize())
      message.error(`大段粘贴内容保存失败：${error?.message || '未知错误'}，已恢复原文`)
    }
  }
}

const restoreImages = (nextImages) => {
  images.value = Array.isArray(nextImages)
    ? nextImages.filter((image) => typeof image === 'string' && image).slice(0, 10)
    : []
}

const removeImage = (idx) => {
  images.value.splice(idx, 1)
}

const addFileContext = ({ file, content, startLine, endLine }) => {
  const path = String(file || '未命名文件')
  const snippet = String(content || '').trim()
  // 纯文件引用按路径去重；带片段时按“文件+行号范围”去重（无行号时按片段内容去重），
  // 同一文件的不同代码块可以同时引用
  const key = snippet
    ? (startLine != null && endLine != null
      ? `${path}:L${startLine}-L${endLine}`
      : `${path}:snippet:${snippet}`)
    : path
  if (selectedFileContexts.value.some(context => context.key === key)) return true
  selectedFileContexts.value.push({
    key,
    file: path,
    content: snippet,
    startLine: startLine ?? null,
    endLine: endLine ?? null
  })
  return true
}

// chip 显示：带行号的片段在文件名后追加 行号:行号，便于区分同一文件的多个引用
const fileChipLabel = (context) => {
  if (context.startLine == null || context.endLine == null) return context.file
  return context.startLine === context.endLine
    ? `${context.file}:${context.startLine}`
    : `${context.file}:${context.startLine}:${context.endLine}`
}

const removeSelectedFileContext = (key) => {
  selectedFileContexts.value = selectedFileContexts.value.filter(context => context.key !== key)
}

const clearSelectedFileContexts = () => {
  selectedFileContexts.value = []
}

const addElementContext = (context) => {
  const component = context?.component || context || {}
  const name = String(component.name || component.tag || '未命名元素')
  const tag = String(component.tag || '')
  const selector = String(component.selector || '')
  const key = selector || `${name}:${tag}:${component.file || ''}`
  if (selectedElementContexts.value.some((item) => item.key === key)) return true
  selectedElementContexts.value.push({
    key,
    label: tag ? `${name} <${tag}>` : name,
    selector,
    file: String(component.file || ''),
    text: String(component.text || ''),
    path: Array.isArray(component.path) ? component.path.map((item) => String(item)) : [],
    attrs: Array.isArray(component.attrs)
      ? component.attrs.map((attr) => ({ key: String(attr?.key || ''), val: String(attr?.val || '') }))
      : []
  })
  return true
}

const removeSelectedElementContext = (key) => {
  selectedElementContexts.value = selectedElementContexts.value.filter((context) => context.key !== key)
}

const clearSelectedElementContexts = () => {
  selectedElementContexts.value = []
}

const hasAgentFilePath = (event) => Array.from(event.dataTransfer?.types || []).includes('application/x-loopra-file-path')

const handleFileDragEnter = (event) => {
  if (hasAgentFilePath(event)) fileDropActive.value = true
}

const handleFileDragOver = (event) => {
  if (hasAgentFilePath(event)) {
    event.dataTransfer.dropEffect = 'copy'
    fileDropActive.value = true
  }
}

const handleFileDragLeave = (event) => {
  if (!event.currentTarget.contains(event.relatedTarget)) fileDropActive.value = false
}

const handleFileDrop = (event) => {
  fileDropActive.value = false
  // 项目文件引用（应用内拖拽）优先
  const path = event.dataTransfer?.getData('application/x-loopra-file-path')
  if (path) {
    addFileContext({ file: path })
    nextTick(() => inputField.value?.focus())
    return
  }
  // 本地文件拖拽：走上传解析逻辑（与项目文件引用并存）
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length > 0) {
    handleFiles(files)
    nextTick(() => inputField.value?.focus())
  }
}

/**
 * 将 File 对象转为 base64 Data URI
 */
const fileToDataUrl = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ============= 上传文件解析 =============
const MAX_UPLOAD_FILES = 10 // 上传文件数量上限
const MAX_TEXT_FILE_SIZE = 512 * 1024 // 文本直读上限 512KB
const MAX_DOC_FILE_SIZE = 30 * 1024 * 1024 // PDF/docx/xlsx 单文件上限 30MB
const MAX_EXTRACT_CHARS = 500000 // 单文件提取文本上限
const MAX_TOTAL_EXTRACT_CHARS = 1000000 // 全部上传文本总量上限
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'htm', 'css', 'scss', 'less',
  'xml', 'yaml', 'yml', 'csv', 'log', 'properties', 'ini', 'toml', 'cfg', 'conf', 'env',
  'gitignore', 'dockerfile', 'vue', 'svelte'
])

const getFileKind = (file) => {
  const name = String(file.name || '')
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  const type = String(file.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) return 'text'
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf'
  if (ext === 'docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (ext === 'xlsx' || type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
  return 'unsupported'
}

const formatFileSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const truncateText = (text, max) => {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n...[内容过长，已截断，共 ${text.length} 字符]`
}

const handleUploadClick = () => {
  // 上传文件与后台任务不冲突，任何时候都允许选择文件
  fileInput.value?.click()
}

const handleFileSelected = (event) => {
  handleFiles(Array.from(event.target.files || []))
  event.target.value = '' // 允许重复选择同一文件
}

const handleFiles = (files) => {
  files.forEach((file) => addUploadFile(file))
}

const addUploadFile = (file) => {
  if (!file) return
  const kind = getFileKind(file)
  if (kind === 'image') {
    handleImageFile(file)
    return
  }
  if (kind === 'unsupported') {
    message.warning(`暂不支持解析 ${file.name}（仅支持图片/文本/PDF/Word/Excel）`)
    return
  }
  if (uploadedFiles.value.length >= MAX_UPLOAD_FILES) {
    message.warning(`上传文件数量已达上限（${MAX_UPLOAD_FILES} 个）`)
    return
  }
  const maxSize = kind === 'text' ? MAX_TEXT_FILE_SIZE : MAX_DOC_FILE_SIZE
  if (file.size > maxSize) {
    message.warning(`${file.name} 超过大小限制（${kind === 'text' ? '512KB' : '30MB'}）`)
    return
  }
  const entry = reactive({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    sizeText: formatFileSize(file.size),
    status: 'parsing',
    content: '',
    error: ''
  })
  uploadedFiles.value.push(entry)
  parseUploadedFile(file, kind, entry)
}

const handleImageFile = async (file) => {
  if (images.value.length >= 10) {
    message.warning('图片数量已达上限（10 张）')
    return
  }
  try {
    const dataUrl = await fileToDataUrl(file)
    if (images.value.length < 10) images.value.push(dataUrl)
    else message.warning('图片数量已达上限（10 张）')
  } catch (err) {
    console.error('图片转换失败:', err)
    message.error(`图片读取失败: ${file.name}`)
  }
}

const parseUploadedFile = async (file, kind, entry) => {
  try {
    let content = ''
    if (kind === 'text') {
      content = await readFileAsText(file)
    } else if (kind === 'pdf') {
      content = await parsePdfFile(file)
    } else if (kind === 'docx') {
      content = await parseDocxFile(file)
    } else if (kind === 'xlsx') {
      content = await parseXlsxFile(file)
    }
    content = truncateText(content, MAX_EXTRACT_CHARS)
    if (!content.trim()) {
      entry.status = 'error'
      entry.error = '未能提取到文本内容'
      return
    }
    // 总量限制：所有已就绪文件内容之和不得超过上限
    const total = uploadedFiles.value.reduce((sum, f) => sum + (f.status === 'ready' ? f.content.length : 0), 0)
    if (total + content.length > MAX_TOTAL_EXTRACT_CHARS) {
      entry.status = 'error'
      entry.error = '上传文本总量超限（1M 字符）'
      message.warning(`${file.name} 未加入：上传文本总量超限（1M 字符）`)
      return
    }
    entry.content = content
    entry.status = 'ready'
  } catch (err) {
    console.error('文件解析失败:', err)
    entry.status = 'error'
    entry.error = `解析失败: ${err?.message || '未知错误'}`
  }
}

const readFileAsText = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result || ''))
  reader.onerror = () => reject(new Error('文件读取失败'))
  reader.readAsText(file)
})

const parsePdfFile = async (file) => {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    const {default: PdfWorker} = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
  }
  const doc = await pdfjs.getDocument({data: await file.arrayBuffer()}).promise
  try {
    const maxPages = Math.min(doc.numPages, 50)
    let text = ''
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const page = await doc.getPage(pageNum)
      const content = await page.getTextContent()
      text += content.items.map((item) => item.str || '').join(' ') + '\n'
      if (text.length > MAX_EXTRACT_CHARS) break
    }
    if (doc.numPages > maxPages) text += `\n...[仅提取前 ${maxPages} 页，共 ${doc.numPages} 页]`
    return text
  } finally {
    doc.destroy?.()
  }
}

const parseDocxFile = async (file) => {
  const mammoth = await import('mammoth/mammoth.browser')
  const result = await mammoth.extractRawText({arrayBuffer: await file.arrayBuffer()})
  return String(result?.value || '')
}

const parseXlsxFile = async (file) => {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), {type: 'array'})
  const parts = []
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    parts.push(`[工作表: ${sheetName}]\n${XLSX.utils.sheet_to_csv(sheet)}`)
  }
  return parts.join('\n\n')
}

const removeUploadedFile = (id) => {
  uploadedFiles.value = uploadedFiles.value.filter((f) => f.id !== id)
}

const clearUploadedFiles = () => {
  uploadedFiles.value = []
}

const removeLargePaste = (id) => {
  const entry = largePasteContexts.value.find((paste) => paste.id === id)
  if (!entry) return
  largePasteContexts.value = largePasteContexts.value.filter((paste) => paste.id !== id)
  if (entry.path && entry.workspaceHash) {
    void filesAPI.remove(entry.workspaceHash, entry.path).catch(() => {
      // 文件清理失败不影响输入框操作；项目中的 paste 文件仍可手动删除。
    })
  }
  nextTick(() => autoResize())
}

const clearLargePastes = () => {
  const entries = [...largePasteContexts.value]
  for (const entry of entries) {
    if (entry.path && entry.workspaceHash) {
      void filesAPI.remove(entry.workspaceHash, entry.path).catch(() => {})
    }
  }
  largePasteContexts.value = []
}

const autoResize = () => {
  const el = inputField.value;
  if (el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }
}

// ============= 模型切换 =============
const showModelPicker = ref(false)
const modelSearchQuery = ref('')
const modelSearchInput = ref(null)
const modelDropdownList = ref(null)
const collapsedModelChannels = ref({})
const filteredModels = computed(() => {
  const keyword = modelSearchQuery.value.trim().toLowerCase()
  return props.availableModels.filter((model) => !keyword ||
    String(model.name || '').toLowerCase().includes(keyword) ||
    String(model.channelName || '').toLowerCase().includes(keyword))
})
const modelGroups = computed(() => {
  const groups = new Map()
  filteredModels.value.forEach((model) => {
    const key = model.channelId || 'default'
    if (!groups.has(key)) groups.set(key, {key, name: model.channelName || '默认渠道', models: []})
    groups.get(key).models.push(model)
  })
  return [...groups.values()]
})
const selectedModel = computed(() => props.availableModels.find((model) => model.active))
const currentModelLabel = computed(() => {
  const current = selectedModel.value
  return current?.channelName ? `${current.channelName} / ${current.name}` : props.currentModel
})
const isModelDefault = (model) => Boolean(model && model.name === props.defaultModel
  && (model.channelId || '') === (props.defaultModelChannelId || ''))
const activeModelChannelKey = computed(() => {
  const activeModel = props.availableModels.find((model) => model.active)
  return activeModel?.channelId || 'default'
})
const isModelChannelCollapsed = (group) => {
  if (modelSearchQuery.value) return false
  const collapsed = collapsedModelChannels.value[group.key]
  return collapsed === undefined ? group.key !== activeModelChannelKey.value : collapsed
}
const expandActiveModelChannel = () => {
  collapsedModelChannels.value[activeModelChannelKey.value] = false
}
const toggleModelChannel = (group) => {
  collapsedModelChannels.value[group.key] = !isModelChannelCollapsed(group)
}
const scrollToActiveModel = () => {
  modelDropdownList.value?.querySelector('.model-option.active')?.scrollIntoView({block: 'nearest'})
}
const toggleModelPicker = () => {
  const nextOpen = !showModelPicker.value
  if (nextOpen) closePickers('model')
  showModelPicker.value = nextOpen
  if (nextOpen) {
    modelSearchQuery.value = ''
    expandActiveModelChannel()
    emit('pickerOpen', 'model')
    emit('refreshModels')
    nextTick(() => {
      modelSearchInput.value?.focus()
      scrollToActiveModel()
    })
  }
}
watch([showModelPicker, filteredModels], ([isOpen]) => {
  if (isOpen && !modelSearchQuery.value) {
    expandActiveModelChannel()
    nextTick(scrollToActiveModel)
  }
})
const pickModel = async (model) => {
  const name = typeof model === 'string' ? model : model?.name
  const channelId = typeof model === 'object' ? model?.channelId : null
  if (!name) return
  if (name === props.currentModel && (!channelId || props.availableModels.find((item) => item.active)?.channelId === channelId)) {
    showModelPicker.value = false;
    return
  }
  emit('switchModel', name, channelId)
  showModelPicker.value = false
}
const setDefaultModel = (model) => {
  if (!model || isModelDefault(model) || props.settingDefaultModel) return
  emit('setDefaultModel', model.name, model.channelId || '')
}
const manageModels = () => {
  showModelPicker.value = false
  emit('manageModels')
}

// ============= 技能选择（多选） =============
const showSkillPicker = ref(false)
const availableSkills = ref([])
const skillLoading = ref(false)
const selectedSkills = ref([])
const skillSearchQuery = ref('')
const skillSearchInput = ref(null)

const filteredSkills = computed(() => {
  if (!skillSearchQuery.value) return availableSkills.value
  const q = skillSearchQuery.value.toLowerCase()
  return availableSkills.value.filter(s =>
    (s.name || '').toLowerCase().includes(q) ||
    (s.description || '').toLowerCase().includes(q)
  )
})

const isSkillSelected = (skill) => selectedSkills.value.some(s => s.name === skill.name)

const toggleSkillPicker = async () => {
  const nextOpen = !showSkillPicker.value
  if (nextOpen) closePickers('skill')
  showSkillPicker.value = nextOpen
  if (nextOpen) emit('pickerOpen', 'skill')
  if (nextOpen && availableSkills.value.length === 0 && !skillLoading.value) {
    skillLoading.value = true
    try {
      const r = await agentAPI.getSkills()
      if (r.success && r.data) availableSkills.value = r.data
    } catch {}
    skillLoading.value = false
  }
  if (nextOpen) {
    skillSearchQuery.value = ''
    nextTick(() => skillSearchInput.value?.focus())
  }
}

const toggleSkill = (skill) => {
  const idx = selectedSkills.value.findIndex(s => s.name === skill.name)
  if (idx >= 0) {
    selectedSkills.value.splice(idx, 1)
  } else {
    selectedSkills.value.push(skill)
  }
  emit('switchSkill', [...selectedSkills.value])
}

const removeSkill = (skill) => {
  selectedSkills.value = selectedSkills.value.filter(s => s.name !== skill.name)
  emit('switchSkill', [...selectedSkills.value])
}

const clearSelectedSkills = () => {
  if (selectedSkills.value.length === 0) return
  selectedSkills.value = []
  emit('switchSkill', [])
}

// ============= 更多输入工具菜单（hover 宽限期：离开后延迟收起，避免移到二级面板时弹框瞬失） =============
const toolsMenuOpen = ref(false)
const activeToolsBranch = ref('') // '' | 'project' | 'skill' | 'permission'
let toolsMenuTimer = null
let toolsBranchTimer = null

const openToolsMenu = () => {
  if (toolsMenuTimer) { clearTimeout(toolsMenuTimer); toolsMenuTimer = null }
  toolsMenuOpen.value = true
}
const scheduleCloseToolsMenu = () => {
  if (toolsMenuTimer) clearTimeout(toolsMenuTimer)
  toolsMenuTimer = setTimeout(() => {
    toolsMenuTimer = null
    toolsMenuOpen.value = false
    activeToolsBranch.value = ''
  }, 250)
}
const openToolsBranch = (name) => {
  if (toolsBranchTimer) { clearTimeout(toolsBranchTimer); toolsBranchTimer = null }
  activeToolsBranch.value = name
}
const scheduleCloseToolsBranch = () => {
  if (toolsBranchTimer) clearTimeout(toolsBranchTimer)
  toolsBranchTimer = setTimeout(() => {
    toolsBranchTimer = null
    activeToolsBranch.value = ''
  }, 250)
}

const openSkillPicker = async () => {
  if (showSkillPicker.value && availableSkills.value.length > 0) return
  showSkillPicker.value = true
  if (availableSkills.value.length > 0 || skillLoading.value) return
  skillLoading.value = true
  try {
    const response = await agentAPI.getSkills()
    if (response.success && response.data) availableSkills.value = response.data
  } finally {
    skillLoading.value = false
  }
}

// ============= 项目联动（本轮多选） =============
const showProjectPicker = ref(false)
const availableProjects = ref([])
const selectedProjects = ref([])
const projectLoading = ref(false)
const projectSearchQuery = ref('')
const projectSearchInput = ref(null)
const filteredProjects = computed(() => {
  const projects = availableProjects.value.filter(project => project.hash !== props.workspaceHash)
  const query = projectSearchQuery.value.trim().toLowerCase()
  if (!query) return projects
  return projects.filter(project => (project.name || '').toLowerCase().includes(query) || (project.path || '').toLowerCase().includes(query))
})
const isProjectSelected = project => selectedProjects.value.some(item => item.hash === project.hash)
const toggleProjectPicker = async () => {
  const nextOpen = !showProjectPicker.value
  if (nextOpen) closePickers('project')
  showProjectPicker.value = nextOpen
  if (!nextOpen) return
  emit('pickerOpen', 'project')
  projectSearchQuery.value = ''
  projectLoading.value = true
  try {
    const response = await configAPI.listWorkspaces()
    if (response?.success) availableProjects.value = response.data || []
  } finally {
    projectLoading.value = false
  }
  nextTick(() => projectSearchInput.value?.focus())
}
const openProjectPicker = async () => {
  showProjectPicker.value = true
  if (availableProjects.value.length > 0 || projectLoading.value) return
  projectLoading.value = true
  try {
    const response = await configAPI.listWorkspaces()
    if (response?.success) availableProjects.value = response.data || []
  } finally {
    projectLoading.value = false
  }
}
const toggleProject = project => {
  selectedProjects.value = isProjectSelected(project)
    ? selectedProjects.value.filter(item => item.hash !== project.hash)
    : [...selectedProjects.value, project]
}
const removeProject = project => {
  selectedProjects.value = selectedProjects.value.filter(item => item.hash !== project.hash)
}
const clearSelectedProjects = () => { selectedProjects.value = [] }

// ============= 清单 TODO =============
const clData = ref(null)
const workflowHover = ref(false)
let clRefreshTimer = null

const loadChecklist = async () => {
  if (!sessionInitialized.value || !props.workspaceHash || !props.sessionName) {
    clData.value = null
    return
  }
  try {
    const { sessionsAPI } = await import('../services/api')
    const res = await sessionsAPI.getChecklist(props.sessionName, props.workspaceHash)
    if (res.success && res.data) {
      clData.value = res.data
    } else {
      clData.value = null
    }
  } catch {
    clData.value = null
  }
}

const stopChecklistPolling = () => {
  if (clRefreshTimer) clearInterval(clRefreshTimer)
  clRefreshTimer = null
}

const startChecklistPolling = () => {
  stopChecklistPolling()
  if (!props.streaming) return
  clRefreshTimer = setInterval(loadChecklist, 3000)
}

// ============= Goal =============
const goalData = ref(null)
const goalHover = ref(false)
let goalRefreshTimer = null

const loadGoal = async () => {
  if (!sessionInitialized.value || !props.workspaceHash || !props.sessionName) {
    goalData.value = null
    return
  }
  try {
    const { sessionsAPI } = await import('../services/api')
    const res = await sessionsAPI.getGoal(props.sessionName, props.workspaceHash)
    if (res.success && res.data && !['COMPLETED', 'CANCELLED'].includes(res.data.status)) {
      goalData.value = res.data
    } else {
      goalData.value = null
    }
  } catch {
    goalData.value = null
  }
}

const stopGoalPolling = () => {
  if (goalRefreshTimer) clearInterval(goalRefreshTimer)
  goalRefreshTimer = null
}

const startGoalPolling = () => {
  stopGoalPolling()
  if (!props.streaming) return
  goalRefreshTimer = setInterval(loadGoal, 3000)
}

watch([() => props.workspaceHash, () => props.sessionName], () => {
  clData.value = null
  workflowHover.value = false
  goalData.value = null
  goalHover.value = false
  loadChecklist()
  startChecklistPolling()
  loadGoal()
  startGoalPolling()
}, { immediate: true })

watch(() => props.streaming, (streaming, wasStreaming) => {
  if (streaming) {
    sessionInitialized.value = true
    loadChecklist()
    startChecklistPolling()
    loadGoal()
    startGoalPolling()
  } else {
    stopChecklistPolling()
    stopGoalPolling()
    if (wasStreaming) {
      loadChecklist()
      loadGoal()
    }
  }
})

// ============= 权限切换 =============
const showPermissionPicker = ref(false)
const permissionOptions = [
  {value: 'free', label: '自由模式'},
  {value: 'approval', label: '审批模式'},
  {value: 'auto', label: '自动模式'}
]
const permissionLabel = computed(() => {
  const found = permissionOptions.find(o => o.value === props.currentPermission)
  return found ? found.label : props.currentPermission
})
const togglePermissionPicker = () => {
  const nextOpen = !showPermissionPicker.value
  if (nextOpen) closePickers('permission')
  showPermissionPicker.value = nextOpen
  if (nextOpen) emit('pickerOpen', 'permission')
}
const pickPermission = (level) => {
  emit('switchPermission', level)
  showPermissionPicker.value = false
}

// 点击外部关闭选择器
const handleOutside = (e) => {
  if (!e.target.closest('.model-selector')) showModelPicker.value = false;
  if (!e.target.closest('.reasoning-effort-selector')) showEffortPicker.value = false
  if (!e.target.closest('.skill-selector')) showSkillPicker.value = false
  if (!e.target.closest('.project-selector')) showProjectPicker.value = false
  if (!e.target.closest('.permission-hitl-selector')) showPermissionPicker.value = false
  if (!e.target.closest('.quick-command-selector')) {
    showQuickCommandPicker.value = false
    closeQuickCommandEditor()
  }
}

// ============= 推理强度切换 =============
const showEffortPicker = ref(false)
const closePickers = (except = '') => {
  if (except !== 'model') showModelPicker.value = false
  if (except !== 'skill') showSkillPicker.value = false
  if (except !== 'project') showProjectPicker.value = false
  if (except !== 'permission') showPermissionPicker.value = false
  if (except !== 'effort') showEffortPicker.value = false
  if (except !== 'quick') showQuickCommandPicker.value = false
  showContextComposition.value = false
}
const effortOptions = [
  {value: 'none', label: '无', en: 'none', description: '直接响应'},
  {value: 'low', label: '低', en: 'low', description: '快速响应'},
  {value: 'medium', label: '中', en: 'medium', description: '速度与深度兼顾'},
  {value: 'high', label: '高', en: 'high', description: '更充分地思考'},
  {value: 'xhigh', label: '超高', en: 'xhigh', description: '接近极限的深度推理'},
  {value: 'max', label: '最大', en: 'max', description: '优先获得最完整的推理'}
]
const reasoningEffortIndex = ref(5)
const customReasoningEffort = ref('')
const selectedReasoningEffort = computed(() => {
  const option = effortOptions[reasoningEffortIndex.value]
  return customReasoningEffort.value ? {
    value: customReasoningEffort.value,
    label: '自定义',
    en: customReasoningEffort.value,
    description: customReasoningEffort.value
  } : option
})
const reasoningEffortProgress = computed(() => (
  reasoningEffortIndex.value / (effortOptions.length - 1)
) * 100)
watch(() => props.currentReasoningEffort, (value) => {
  const index = effortOptions.findIndex(option => option.value === value)
  reasoningEffortIndex.value = index === -1 ? effortOptions.length - 1 : index
  customReasoningEffort.value = index === -1 ? value || '' : ''
}, {immediate: true})
const updateReasoningEffort = (index) => {
  const nextIndex = Number(index)
  const next = effortOptions[nextIndex]
  if (!next) return
  reasoningEffortIndex.value = nextIndex
  // 一拉动滑块，自定义值立即作废，回到滑块指向的档位
  customReasoningEffort.value = ''
}
const commitReasoningEffort = (index) => {
  updateReasoningEffort(index)
  customReasoningEffort.value = ''
  const next = effortOptions[reasoningEffortIndex.value]
  if (next.value !== props.currentReasoningEffort) emit('switchReasoningEffort', next.value)
  showEffortPicker.value = false
}
const commitCustomReasoningEffort = () => {
  const value = customReasoningEffort.value.trim()
  if (!value) return
  if (value !== props.currentReasoningEffort) emit('switchReasoningEffort', value)
  showEffortPicker.value = false
}
const selectReasoningEffort = (index) => commitReasoningEffort(index)
const toggleEffortPicker = () => {
  const nextOpen = !showEffortPicker.value
  if (nextOpen) closePickers('effort')
  showEffortPicker.value = nextOpen
  if (nextOpen) emit('pickerOpen', 'effort')
}

// ============= Usage =============
const fmt = (n) => {
  if (!n || n === 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n)
}
const cacheRate = computed(() => {
  const t = props.usage.cacheHit + props.usage.cacheMiss;
  return t === 0 ? '0' : ((props.usage.cacheHit / t) * 100).toFixed(1)
})
const ctxPct = computed(() => {
  const m = props.usage.maxContextTokens || 128000
  const c = props.usage.lastPromptTokens || props.usage.promptTokens || 0
  if (m <= 0 || c <= 0) return 0
  const pct = Math.round((c / m) * 100)
  // 小于 5% 时至少展示 5%，让填充条肉眼可见
  return Math.max(5, Math.min(pct, 100))
})
const contextEstimate = computed(() => props.usage.contextEstimate || null)
const contextTotalTokens = computed(() => Number(props.usage.lastPromptTokens) || 0)
const maxContextTokens = computed(() => Number(props.usage.maxContextTokens) || 128000)
const streamingTps = computed(() => {
  const v = props.usage.tokensPerSecond
  if (v == null || Number.isNaN(Number(v))) return null
  const n = Number(v)
  return n > 0 ? n : null
})
const avgTps = computed(() => {
  const v = props.usage.avgTokensPerSecond
  if (v == null || Number.isNaN(Number(v))) return null
  const n = Number(v)
  return n > 0 ? n : null
})
const displayTps = computed(() => {
  const done = props.usage.tokenSpeedDone
  const n = done ? (avgTps.value ?? streamingTps.value) : streamingTps.value
  if (n == null) return ''
  return n >= 100 ? `${n.toFixed(0)} t/s` : `${n.toFixed(1)} t/s`
})
const tpsTitle = computed(() => {
  const s = streamingTps.value
  const a = avgTps.value
  if (a != null && s != null && props.usage.tokenSpeedDone) return `平均 ${a >= 100 ? a.toFixed(0) : a.toFixed(1)} t/s · 实时 ${s >= 100 ? s.toFixed(0) : s.toFixed(1)} t/s · ${props.usage.completionTokens||0} tokens`
  if (displayTps.value) return `生成速度 ${displayTps.value} · ${props.usage.completionTokens||0} tokens`
  return ''
})
const showContextComposition = ref(false)
const refreshContextComposition = () => {
  showContextComposition.value = true
  emit('refreshUsage')
}
const compositionItems = computed(() => {
  const estimate = contextEstimate.value
  if (!estimate || estimate.totalTokens <= 0) return []
  const total = estimate.totalTokens
  const items = [
    { key: 'system', label: '系统提示', value: estimate.systemTokens || 0 },
    { key: 'tools', label: '工具定义', value: estimate.toolDefinitionTokens || 0 },
    { key: 'user', label: '用户消息', value: estimate.userTokens || 0 },
    { key: 'assistant', label: '助手历史', value: estimate.assistantTokens || 0 },
    { key: 'result', label: '工具结果', value: estimate.toolResultTokens || 0 }
  ]
  return items.filter(item => item.value > 0).map(item => ({
    ...item,
    percent: total > 0 ? Math.min(100, item.value / total * 100) : 0
  }))
})

onMounted(() => {
  document.addEventListener('click', handleOutside)
  window.addEventListener('blur', rememberInputFocus)
  window.addEventListener('focus', restoreInputFocus)
})
onBeforeUnmount(() => {
  stopChecklistPolling()
  if (fileMentionSearchTimer) clearTimeout(fileMentionSearchTimer)
  if (toolsMenuTimer) clearTimeout(toolsMenuTimer)
  if (toolsBranchTimer) clearTimeout(toolsBranchTimer)
  document.removeEventListener('click', handleOutside)
  window.removeEventListener('blur', rememberInputFocus)
  window.removeEventListener('focus', restoreInputFocus)
})

// ── 桌面宠物精灵图 ──
const petSpritesheetUrl = ref('')
const petPosition = ref({ x: 0, y: 0 })
const petSizeIndex = ref(1)
const petScale = ref(null)

// 聊天内宠物被右键关闭：隐藏宠物（不重新出现，直到用户重新打开）
function closeFloatingPet() {
  appStore.setPetHidden(true)
}

async function loadPet() {
  try {
    const resp = await petAPI.getInfo()
    const petData = resp.data
    if (petData && petData.active && (petData.spritesheetUrl || petData.spritesheetPath)) {
      // 兼容新旧字段名：spritesheetUrl（新）或 spritesheetPath（旧）
      // 统一解析为完整 URL，桌面端 file:// 协议下才能加载（适配服务端端口）
      const url = petAPI.resolveUrl(petData.spritesheetUrl || petData.spritesheetPath)
      if (url) {
        petSpritesheetUrl.value = url + '?t=' + Date.now()
      }
      if (petData.position) {
        petPosition.value = { x: petData.position.x || 0, y: petData.position.y || 0 }
      }
      if (typeof petData.sizeIndex === 'number') {
        petSizeIndex.value = petData.sizeIndex
      }
      if (typeof petData.scale === 'number') {
        petScale.value = petData.scale
      }
    }
  } catch { /* pet 不可用时静默 */ }
}
if (!appStore.isDesktopEnv) loadPet()

// 当其他组件（如设置页）切换宠物时，重新加载
watch(() => appStore.activePetName, (newName, oldName) => {
  if (!appStore.isDesktopEnv && newName && newName !== oldName) {
    loadPet()
  }
})

async function savePetPosition(pos) {
  try {
    await petAPI.savePosition(pos)
  } catch { /* 保存失败静默 */ }
}

async function savePetScale(scale) {
  petScale.value = scale
  try {
    await petAPI.savePosition({scale})
  } catch { /* 保存失败静默 */ }
}

// 暴露焦點方法给父组件
defineExpose({focus: () => inputField.value?.focus(), addFileContext, addElementContext, restoreImages, autoResize, closePickers})
</script>

<style scoped>
.input-area {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 12px 10px;
  background: transparent;
  z-index: 10;
}

.input-box {
  display: flex;
  flex-direction: column;
  gap: 0;
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: 15px;
  padding: 6px 8px 0;
  transition: border-color 120ms ease, box-shadow 120ms ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03), 0 8px 24px rgba(0, 0, 0, 0.04);
  position: relative;
  z-index: 10;
}

.input-box.focused {
  border-color: var(--focus-border, #b7b7c0);
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.025), 0 8px 24px rgba(0, 0, 0, 0.05);
}

.input-box.file-drop-active {
  border-color: #4f7cac;
  box-shadow: 0 0 0 2px color-mix(in srgb, #4f7cac 18%, transparent), var(--glass-shadow);
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.input-box textarea {
  flex: 1;
  min-height: 22px;
  max-height: 160px;
  padding: 0;
  background: none;
  border: none;
  outline: none;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg);
  resize: none;
}

.input-box textarea::placeholder {
  color: var(--fg-4);
}

/* Unified conversation composer for both the web and desktop shells. */
/* 背景只覆盖输入区底部 padding（与背景同色）：消息滚到输入框下方时被干净遮住，
   不露出半截；输入框上方保持透明，消息进入输入区时仍可透出 */
.input-area:not(.welcome-mode) {
  padding: 14px clamp(16px, 2vw, 24px) 16px;
  background: linear-gradient(to top, var(--bg) 16px, transparent 16px);
}

.composer-queue {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 2px;
}

.composer-queue:hover,
.composer-queue:focus-within {
  margin-bottom: 8px;
}

.composer-queue-summary {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  gap: 7px;
  padding: 4px 9px;
  color: var(--fg-2);
  background: color-mix(in srgb, var(--accent) 6%, var(--bg));
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
  border-radius: 9px;
  box-shadow: 0 2px 7px color-mix(in srgb, var(--accent) 8%, transparent);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}

.composer-queue-summary::after {
  width: 6px;
  height: 6px;
  margin-left: auto;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  content: '';
  opacity: .55;
  transform: rotate(45deg) translate(-1px, -1px);
  transition: opacity 120ms ease, transform 120ms ease;
}

.composer-queue:hover .composer-queue-summary,
.composer-queue:focus-within .composer-queue-summary {
  color: var(--fg);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg));
  border-color: color-mix(in srgb, var(--accent) 34%, var(--border));
  box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 12%, transparent);
}

.composer-queue:hover .composer-queue-summary::after,
.composer-queue:focus-within .composer-queue-summary::after {
  opacity: .85;
  transform: rotate(225deg) translate(-1px, -1px);
}

.composer-queue-items {
  display: grid;
  grid-template-rows: 0fr;
  overflow: hidden;
  opacity: 0;
  transition: grid-template-rows 160ms ease, opacity 120ms ease;
}

.composer-queue:hover .composer-queue-items,
.composer-queue:focus-within .composer-queue-items {
  grid-template-rows: 1fr;
  opacity: 1;
}

.composer-queue-items > * {
  min-height: 0;
  overflow: hidden;
}

.composer-queue-items-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.composer-queue-item {
  display: flex;
  align-items: center;
  min-height: 38px;
  gap: 8px;
  padding: 7px 8px 7px 10px;
  color: var(--fg-2);
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.composer-queue-icon {
  flex: 0 0 auto;
  color: var(--accent);
  opacity: .82;
}

.composer-queue-text {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: 14px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-queue-guide,
.composer-queue-remove {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--fg-3);
  cursor: pointer;
}

.composer-queue-guide {
  gap: 3px;
  padding: 3px 6px;
  font-size: 13px;
  line-height: 20px;
}

.composer-queue-guide:hover {
  color: var(--accent);
}

.composer-queue-remove {
  width: 28px;
  height: 28px;
  border-radius: 5px;
}

.composer-queue-remove:hover {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 10%, transparent);
}

.input-area:not(.welcome-mode) .input-box,
.input-area:not(.welcome-mode) .composer-queue {
  width: 100%;
  max-width: 1040px;
  margin-right: auto;
  margin-left: auto;
  box-sizing: border-box;
}

.input-area:not(.welcome-mode) .input-box {
  min-height: 98px;
  padding: 14px 16px 9px;
  border-color: var(--border-2);
  border-radius: 15px;
  background: var(--bg-2);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03), 0 8px 24px rgba(0, 0, 0, 0.04);
}

.input-area:not(.welcome-mode) .input-box.focused {
  border-color: var(--focus-border, #b7b7c0);
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.025), 0 8px 24px rgba(0, 0, 0, 0.05);
}

.input-area:not(.welcome-mode) .input-row {
  min-height: 48px;
  align-items: stretch;
}

.input-area:not(.welcome-mode) .input-box textarea {
  min-height: 44px;
  max-height: 150px;
  padding: 1px 2px;
  font-size: 16px;
  line-height: 1.55;
}

.input-area:not(.welcome-mode) .input-actions {
  align-self: flex-end;
  padding-bottom: 1px;
}

.input-area:not(.welcome-mode) .send-btn,
.input-area:not(.welcome-mode) .upload-btn,
.input-area:not(.welcome-mode) .plan-mode-btn,
.input-area:not(.welcome-mode) .continue-btn {
  width: 38px;
  height: 38px;
  border-radius: 10px;
}

.input-area:not(.welcome-mode) .send-btn svg,
.input-area:not(.welcome-mode) .upload-btn :deep(svg),
.input-area:not(.welcome-mode) .plan-mode-btn :deep(svg),
.input-area:not(.welcome-mode) .continue-btn svg {
  width: 18px;
  height: 18px;
}

.input-area:not(.welcome-mode) .usage-bar {
  min-height: 24px;
  margin-top: 4px;
  padding: 0;
  border-top-color: var(--border-soft, #eeeeF0);
  flex-direction: row;
  justify-content: space-between;
  gap: 0;
}

.input-area:not(.welcome-mode) .usage-stats {
  margin-left: 0;
  opacity: 1;
}

.input-area:not(.welcome-mode) .model-actions {
  flex-direction: row;
  gap: 8px;
  padding-top: 6px;
  padding-bottom: 2px;
}

.input-area:not(.welcome-mode) .effort-btn,
.input-area:not(.welcome-mode) .model-btn {
  padding: 4px 7px;
  font-size: 13px;
  font-weight: 500;
}

[data-theme="dark"] .input-area:not(.welcome-mode) .input-box {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
}

/* 图片预览 */
.image-preview-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0 4px 0;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}

.image-preview-item {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.image-preview-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.image-preview-remove {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.image-preview-remove:hover {
  background: rgba(239, 68, 68, 0.9);
}

.input-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn-icon-sm {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  color: var(--fg-4);
  transition: all var(--t);
  cursor: pointer;
}

.btn-icon-sm:hover {
  background: var(--bg-3);
  color: var(--fg-2);
}

.btn-icon-sm.active {
  background: var(--accent-bg);
  color: var(--accent);
}

.send-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  color: var(--fg-4);
  transition: all var(--t);
}

.send-btn.active {
  background: var(--accent-btn);
  color: #fff;
}

.send-btn.active:hover {
  background: var(--blue-dark);
}

[data-theme="dark"] .send-btn.active {
  background: #d4d4d8;
  color: #18181b;
}

[data-theme="dark"] .send-btn.active:hover {
  background: #f4f4f5;
}

[data-theme="dark"] .send-btn:disabled {
  color: #686d78;
  opacity: 1;
}

.send-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.upload-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  color: var(--fg-4);
  transition: all var(--t);
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
}

.upload-btn:hover {
  background: var(--bg-3);
  color: var(--accent);
}

.upload-btn:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.upload-btn :deep(svg) {
  width: 16px;
  height: 16px;
}

.upload-file-input {
  display: none;
}

.composer-tools-menu {
  position: relative;
  display: inline-flex;
}

.composer-tools-submenu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 220;
  display: grid;
  width: 270px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: var(--shadow-lg);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(4px);
  transition: opacity var(--t), transform var(--t), visibility var(--t);
}

.composer-tools-submenu::after {
  position: absolute;
  right: 0;
  bottom: -9px;
  width: 44px;
  height: 9px;
  content: '';
}

.composer-tools-menu.tools-open .composer-tools-submenu {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
}

.composer-tools-primary {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 48px;
  padding: 6px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-2);
  text-align: left;
  cursor: pointer;
}

.composer-tools-primary:hover,
.composer-tools-primary:focus-visible,
.composer-tools-primary.active,
.composer-tools-branch.branch-active > .composer-tools-primary {
  background: var(--bg-3);
  color: var(--accent);
  outline: none;
}

.composer-tools-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.composer-tools-primary > :deep(svg) {
  width: 17px;
  height: 17px;
  justify-self: center;
}

.composer-tools-primary span,
.composer-tools-primary strong,
.composer-tools-primary small {
  display: block;
  min-width: 0;
}

.composer-tools-primary strong {
  overflow: hidden;
  color: inherit;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-tools-primary small {
  margin-top: 2px;
  overflow: hidden;
  color: var(--fg-4);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-tools-branch {
  position: relative;
}

.composer-tools-branch > .composer-tools-primary {
  grid-template-columns: 28px minmax(0, 1fr) 16px;
}

.composer-tools-chevron {
  color: var(--fg-4);
}

.composer-tools-nested {
  position: absolute;
  right: calc(100% + 6px);
  bottom: 0;
  z-index: 230;
  display: flex;
  width: 330px;
  max-height: 360px;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: var(--shadow-lg);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateX(4px);
  transition: opacity var(--t), transform var(--t), visibility var(--t);
}

.composer-tools-nested::after {
  position: absolute;
  top: 0;
  right: -7px;
  width: 7px;
  height: 100%;
  content: '';
}

.composer-tools-branch.branch-active > .composer-tools-nested {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateX(0);
}

.composer-tools-nested .skill-panel-list {
  display: grid;
  align-content: start;
  gap: 4px;
  min-height: 46px;
  max-height: 300px;
  padding: 5px;
}

.composer-tools-nested .skill-panel-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 56px;
  padding: 9px 10px;
  box-sizing: border-box;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-2);
  text-align: left;
  cursor: pointer;
}

.composer-tools-nested .skill-panel-item:hover,
.composer-tools-nested .skill-panel-item.active {
  color: var(--accent);
  transform: none;
}

.composer-tools-nested .skill-panel-item:hover {
  background: var(--bg-2);
}

.composer-tools-nested .skill-panel-item.active {
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
  background: color-mix(in srgb, var(--accent) 9%, var(--bg));
  box-shadow: none;
}

.composer-tools-nested .skill-item-info,
.composer-tools-nested .skill-item-name,
.composer-tools-nested .skill-item-desc {
  display: block;
  min-width: 0;
}

.composer-tools-nested .skill-item-name,
.composer-tools-nested .skill-item-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.permission-tools-nested {
  width: 180px;
  padding: 5px;
}

.permission-tools-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 36px;
  padding: 0 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-2);
  cursor: pointer;
}

.permission-tools-option:hover,
.permission-tools-option.active {
  background: var(--bg-3);
  color: var(--accent);
}

.plan-mode-btn,
.continue-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  color: var(--fg-4);
  transition: all var(--t);
  cursor: pointer;
}

.plan-mode-btn:hover,
.continue-btn:hover {
  background: var(--bg-3);
  color: var(--accent);
}

.plan-mode-btn.active {
  background: var(--accent-bg);
  color: var(--accent);
}

.plan-mode-btn:disabled,
.continue-btn:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.stop-btn {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: center;
  padding: 0;
  background: var(--red);
  color: #fff;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition: all var(--t);
  animation: pulse-red 1.5s infinite;
}

.stop-btn:hover {
  background: #b91c1c;
}

.stop-btn svg {
  width: 18px;
  height: 18px;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes pulse-red {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(239, 68, 68, 0);
  }
}

.todo-trigger {
  position: relative;
  flex-shrink: 0;
}

.todo-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-4);
  transition: all var(--t);
  position: relative;
  cursor: pointer;
}

.todo-btn:hover {
  background: var(--bg-3);
  color: var(--fg-2);
}

.todo-btn.has-todos {
  color: var(--accent);
}

.todo-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  background: var(--accent-btn);
  color: white;
  font-size: 9px;
  font-weight: 700;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.todo-tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  width: 280px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  z-index: 100;
  overflow: hidden;
}

.todo-tooltip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}

.todo-tooltip-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
}

.todo-tooltip-stats {
  font-size: 11px;
  color: var(--fg-4);
  background: var(--bg-3);
  padding: 2px 6px;
  border-radius: var(--r-sm);
}

.todo-tooltip-empty {
  padding: 16px;
  text-align: center;
  color: var(--fg-4);
  font-size: 12px;
}

.todo-tooltip-list {
  max-height: 200px;
  overflow-y: auto;
  padding: 4px;
}

.todo-tooltip-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  transition: background var(--t);
}

.todo-tooltip-item:hover {
  background: var(--bg-2);
}

.todo-status-icon {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.5;
}

.todo-content {
  font-size: 12px;
  color: var(--fg-2);
  line-height: 1.5;
}

.todo-content.completed {
  text-decoration: line-through;
  color: var(--fg-4);
}

.todo-content.in_progress {
  color: var(--accent);
  font-weight: 500;
}

.todo-tooltip-footer {
  padding: 6px 12px 8px;
  border-top: 1px solid var(--border);
}

.todo-progress-bar {
  height: 3px;
  background: var(--bg-3);
  border-radius: 2px;
  overflow: hidden;
}

.todo-progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.todo-completed-section {
  border-top: 1px solid var(--border);
  margin-top: 4px;
}

.todo-completed-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--fg-4);
  cursor: pointer;
  transition: all var(--t);
}

.todo-completed-toggle:hover {
  color: var(--fg-2);
  background: var(--bg-2);
}

.todo-completed-toggle svg {
  transition: transform 0.2s ease;
}

.collapse-enter-active, .collapse-leave-active {
  transition: all 0.2s ease;
  max-height: 200px;
}

.collapse-enter-from, .collapse-leave-to {
  max-height: 0;
  opacity: 0;
}

.tooltip-enter-active, .tooltip-leave-active {
  transition: all 0.2s ease;
}

.tooltip-enter-from, .tooltip-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* 斜杠命令弹窗 */
.file-mention-popup {
  position: absolute;
  right: 16px;
  bottom: 100%;
  left: 16px;
  z-index: 100;
  overflow: hidden;
  margin-bottom: 4px;
  border: 1px solid var(--border);
  border-radius: var(--r);
  background: var(--bg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}

.file-mention-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
}

.file-mention-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--fg-2);
  font-size: 12px;
  font-weight: 600;
}

.file-mention-title svg { color: #4f7cac; }
.file-mention-hint { color: var(--fg-4); font-size: 11px; }

.file-mention-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 76px;
  gap: 8px;
  padding: 16px;
  color: var(--fg-4);
  font-size: 12px;
}

.file-mention-list { max-height: 280px; overflow-y: auto; padding: 4px; }

.file-mention-item {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fg-2);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.file-mention-item:hover, .file-mention-item.active { background: var(--bg-2); color: var(--fg); }

.file-mention-icon {
  display: inline-grid;
  width: 24px;
  height: 24px;
  place-items: center;
  flex-shrink: 0;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, #4f7cac 12%, var(--bg));
  color: #4f7cac;
}

.file-mention-info {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.file-mention-info > span, .file-mention-info small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-mention-info > span { font-size: 12px; font-weight: 600; }
.file-mention-info small { color: var(--fg-4); font: 11px var(--mono); }

.slash-popup {
  position: absolute;
  bottom: 100%;
  left: 16px;
  right: 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  z-index: 100;
  overflow: hidden;
  margin-bottom: 4px;
}

.slash-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
}

.slash-popup-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
}

.slash-popup-hint {
  font-size: 11px;
  color: var(--fg-4);
}

.slash-popup-list {
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
}

.slash-popup-loading, .slash-popup-empty {
  padding: 24px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--fg-4);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.slash-popup-loading {
  color: var(--accent);
}

.slash-popup-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: background var(--t);
}

.slash-popup-item:hover, .slash-popup-item.active {
  background: var(--bg-2);
}

.slash-popup-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  background: var(--bg-3);
  border-radius: var(--r-sm);
  flex-shrink: 0;
}

.slash-popup-info {
  flex: 1;
  min-width: 0;
}

.slash-popup-cmd {
  font-size: 13px;
  font-weight: 600;
  font-family: var(--mono);
  color: var(--fg);
  display: flex;
  align-items: center;
  gap: 4px;
}

.slash-popup-badge {
  display: inline-flex;
  align-items: center;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 500;
  border-radius: var(--r-sm);
  line-height: 1.4;
}

.slash-popup-badge.skill {
  background: #dcfce7;
  color: #16a34a;
}

.slash-popup-badge.mode {
  background: #dbeafe;
  color: #2563eb;
}

.slash-popup-badge.session {
  background: #fef3c7;
  color: #d97706;
}

.slash-popup-desc {
  font-size: 11px;
  color: var(--fg-4);
  margin-top: 1px;
}

[data-theme="dark"] .slash-popup-badge.skill {
  background: #052e16;
  color: #4ade80;
}

[data-theme="dark"] .slash-popup-badge.mode {
  background: #1e3a5f;
  color: #60a5fa;
}

[data-theme="dark"] .slash-popup-badge.session {
  background: #422006;
  color: #fbbf24;
}

.slash-popup-enter-active, .slash-popup-leave-active {
  transition: all 0.15s ease;
}

.slash-popup-enter-from, .slash-popup-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.quick-command-selector {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
}

.quick-command-trigger,
.quick-command-add,
.quick-command-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--fg-4);
  cursor: pointer;
}

.quick-command-trigger {
  width: 24px;
  height: 24px;
  border-radius: var(--r-sm);
  transition: color var(--t), background var(--t);
}

.quick-command-trigger:hover,
.quick-command-trigger.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.quick-command-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  left: -8px;
  z-index: 120;
  width: min(330px, calc(100vw - 32px));
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
}

.quick-command-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
}

.quick-command-header > div {
  display: grid;
  gap: 2px;
}

.quick-command-header strong { color: var(--fg-2); font-size: 12px; }
.quick-command-header span { color: var(--fg-4); font-size: 11px; }
.quick-command-add { width: 26px; height: 26px; border-radius: var(--r-sm); }
.quick-command-add:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.quick-command-list { max-height: 240px; overflow-y: auto; padding: 4px; }
.quick-command-item { display: flex; align-items: center; min-width: 0; gap: 2px; padding: 2px; border-radius: var(--r-sm); }
.quick-command-item:hover { background: var(--bg-2); }
.quick-command-copy { display: grid; flex: 1; min-width: 0; gap: 2px; padding: 6px 7px; border: 0; background: transparent; color: var(--fg-2); cursor: pointer; text-align: left; }
.quick-command-label { overflow: hidden; color: var(--fg-2); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.quick-command-copy code { overflow: hidden; color: var(--fg-4); font: 11px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.quick-command-action { width: 26px; height: 26px; flex: 0 0 auto; border-radius: var(--r-sm); }
.quick-command-action:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.quick-command-delete:hover { color: var(--red); background: color-mix(in srgb, var(--red) 10%, transparent); }
.quick-command-empty { padding: 18px 12px; color: var(--fg-4); font-size: 12px; text-align: center; }
.quick-command-form { display: grid; gap: 7px; padding: 9px; border-top: 1px solid var(--border); background: var(--bg-2); }
.quick-command-form input,
.quick-command-form textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; outline: none; }
.quick-command-form input { height: 28px; padding: 0 8px; }
.quick-command-form textarea { min-height: 48px; padding: 6px 8px; resize: vertical; }
.quick-command-form input:focus,
.quick-command-form textarea:focus { border-color: var(--accent); }
.quick-command-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.quick-command-form-actions button { padding: 4px 9px; border: 1px solid var(--border); border-radius: var(--r-sm); background: transparent; color: var(--fg-3); cursor: pointer; font: inherit; font-size: 11px; }
.quick-command-form-actions button:hover { color: var(--fg); background: var(--bg); }
.quick-command-form-actions button.primary { border-color: var(--accent-btn); background: var(--accent-btn); color: #fff; }
.quick-command-form-actions button:disabled { cursor: not-allowed; opacity: .45; }

/* Usage bar — 融入 input-box 底部 */
.usage-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 4px 4px 12px;
  font-size: 11px;
  color: var(--fg-3);
  border-top: 1px solid var(--border-soft, #eeeeF0);
  margin-top: 4px;
  position: relative;
}

.usage-stats {
  display: flex;
  align-items: center;
  gap: 4px;
}

.usage-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: default;
  color: var(--fg-3);
}

.usage-item svg {
  color: var(--fg-4);
  flex-shrink: 0;
}

.usage-sep {
  color: var(--border);
  font-size: 14px;
}

.usage-divider {
  width: 1px;
  height: 14px;
  margin: 0 5px;
  flex-shrink: 0;
  background: var(--border);
}

.usage-context-control {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.usage-context-circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.context-ring {
  width: 14px;
  height: 14px;
}

.usage-progress {
  display: none;
}

.usage-value {
  display: none;
}

.usage-value.high {
  color: var(--red);
  font-weight: 600;
}

.usage-value.medium {
  color: var(--yellow);
}


.usage-composition-popover {
  position: absolute;
  z-index: 500;
  bottom: calc(100% + 6px);
  left: 0;
  transform: none;
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 10px;
  border: 1px solid var(--glass-border);
  border-radius: var(--r);
  background: var(--bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
  font-size: 11px;
}

.usage-composition-head,
.usage-composition-row {
  display: flex;
  align-items: center;
}

.usage-composition-head {
  justify-content: space-between;
  color: var(--fg-2);
  font-weight: 600;
}

.usage-composition-head span:last-child,
.usage-composition-row span:last-child {
  margin-left: auto;
  color: var(--fg-4);
  font-family: var(--mono);
}

.usage-composition-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 9px;
}

.usage-composition-metrics div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 6px;
  border-radius: var(--r-sm);
  background: var(--bg-2);
}

.usage-composition-metrics span {
  color: var(--fg-4);
}

.usage-composition-metrics strong {
  color: var(--fg-2);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
}

.usage-composition-bar {
  display: flex;
  height: 7px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--bg-3);
  margin: 8px 0;
}

.usage-composition-bar span { min-width: 0; }
.usage-composition-bar .system, .usage-composition-dot.system { background: #566274; }
.usage-composition-bar .tools, .usage-composition-dot.tools { background: #8b6048; }
.usage-composition-bar .user, .usage-composition-dot.user { background: var(--green); }
.usage-composition-bar .assistant, .usage-composition-dot.assistant { background: var(--yellow); }
.usage-composition-bar .result, .usage-composition-dot.result { background: var(--red); }

.usage-composition-list { display: grid; gap: 5px; }

.usage-composition-row {
  gap: 6px;
  color: var(--fg-3);
}

.usage-composition-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .usage-composition-popover {
    left: 0;
    transform: none;
  }
}

.model-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 技能/权限/思考强度默认隐藏，鼠标进入输入框或聚焦时渐显（模型选择常驻） */
.model-actions .hover-reveal {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease;
}

.input-box:hover .model-actions .hover-reveal,
.input-box:focus-within .model-actions .hover-reveal {
  opacity: 1;
  pointer-events: auto;
}

/* ============= 技能选择器 ============= */
.skill-selector,
.permission-hitl-selector {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}

/* 技能面板 */
.skill-panel {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  width: 340px;
  max-height: 420px;
  background: var(--bg);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
  border-radius: var(--r);
  box-shadow: var(--shadow);
  z-index: 200;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.skill-panel-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.skill-panel-search svg {
  color: var(--fg-4);
  flex-shrink: 0;
}

.skill-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  font-size: 13px;
  color: var(--fg);
}

.skill-search-input::placeholder {
  color: var(--fg-4);
}

.skill-selection-count {
  display: inline-grid;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  place-items: center;
  border-radius: 999px;
  background: var(--accent-btn);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.skill-panel-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.skill-panel-empty {
  padding: 24px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--fg-4);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.skill-panel-item {
  display: flex;
  align-items: flex-start;
  width: 100%;
  min-height: 54px;
  gap: 10px;
  padding: 8px 10px;
  box-sizing: border-box;
  border-radius: var(--r-sm);
  cursor: pointer;
  border: 1px solid transparent;
  text-align: left;
  transition: background var(--t), border-color var(--t), transform var(--t);
}

.skill-panel-item:hover {
  background: var(--bg-2);
  transform: translateX(1px);
}

.skill-panel-item.active {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 13%, var(--bg));
  box-shadow: inset 3px 0 var(--accent);
}

.skill-item-info {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  flex: 1;
  min-width: 0;
  text-align: left;
}

.skill-item-name {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skill-item-desc {
  display: block;
  font-size: 11px;
  color: var(--fg-4);
  margin-top: 1px;
  line-height: 1.35;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skill-item-check {
  padding: 3px;
  border-radius: 50%;
  background: var(--accent-btn);
  color: #fff;
  flex-shrink: 0;
}

/* 已选技能标签 */
.file-chips-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 4px;
  padding: 7px 2px 8px;
  border-bottom: 1px solid color-mix(in srgb, #4f7cac 24%, var(--border));
}

.file-chips-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}

.file-chips-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--fg-3);
  font-size: 11px;
  font-weight: 600;
}

.file-chips-title svg { color: #4f7cac; }

.element-chips-bar { border-bottom-color: color-mix(in srgb, #168f9f 24%, var(--border)); }
.element-chips-bar .file-chips-title svg { color: #168f9f; }
.element-chip { border-color: color-mix(in srgb, #168f9f 38%, var(--border)); background: color-mix(in srgb, #168f9f 10%, var(--bg)); }
.element-chip .file-chip-icon { background: color-mix(in srgb, #168f9f 16%, var(--bg)); color: #168f9f; }

.upload-chips-bar { border-bottom-color: color-mix(in srgb, #7c9a4f 26%, var(--border)); }
.upload-chips-bar .file-chips-title svg { color: #7c9a4f; }
.upload-chip { border-color: color-mix(in srgb, #7c9a4f 38%, var(--border)); background: color-mix(in srgb, #7c9a4f 10%, var(--bg)); }
.upload-chip .file-chip-icon { background: color-mix(in srgb, #7c9a4f 16%, var(--bg)); color: #7c9a4f; }
.paste-chips-bar { border-bottom-color: color-mix(in srgb, #a66a3f 28%, var(--border)); }
.paste-chips-bar .file-chips-title svg { color: #a66a3f; }
.paste-chip { border-color: color-mix(in srgb, #a66a3f 38%, var(--border)); background: color-mix(in srgb, #a66a3f 10%, var(--bg)); }
.paste-chip .file-chip-icon { background: color-mix(in srgb, #a66a3f 16%, var(--bg)); color: #a66a3f; }
.paste-chip-saving { border-color: color-mix(in srgb, #4f7cac 45%, var(--border)); background: color-mix(in srgb, #4f7cac 12%, var(--bg)); }
.paste-chip-saving .file-chip-icon { background: color-mix(in srgb, #4f7cac 16%, var(--bg)); color: #4f7cac; }
.upload-chip-parsing { border-color: color-mix(in srgb, #4f7cac 45%, var(--border)); background: color-mix(in srgb, #4f7cac 12%, var(--bg)); }
.upload-chip-parsing .file-chip-icon { background: color-mix(in srgb, #4f7cac 16%, var(--bg)); color: #4f7cac; }
.upload-chip-error { border-color: color-mix(in srgb, #ef4444 45%, var(--border)); background: color-mix(in srgb, #ef4444 10%, var(--bg)); }
.upload-chip-error .file-chip-icon { background: color-mix(in srgb, #ef4444 16%, var(--bg)); color: #ef4444; }
.upload-chip-size { color: var(--fg-4); font-size: 10px; font-weight: 400; line-height: 1.4; }
.upload-chip-error-text { color: var(--red); }
.upload-parsing-hint { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); font-size: 11px; font-weight: 600; }
.upload-parsing-hint .loading-dot { width: 6px; height: 6px; }

.file-clear-all {
  border: none;
  background: transparent;
  color: var(--fg-4);
  cursor: pointer;
  font-family: var(--sans);
  font-size: 11px;
  line-height: 1;
  transition: color var(--t);
}

.file-clear-all:hover { color: var(--red); }

.file-chips-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.file-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  gap: 5px;
  padding: 3px 4px 3px 5px;
  border: 1px solid color-mix(in srgb, #4f7cac 38%, var(--border));
  border-radius: var(--r-sm);
  background: color-mix(in srgb, #4f7cac 10%, var(--bg));
  color: var(--fg-2);
  cursor: default;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
}

.file-chip-icon {
  display: inline-grid;
  width: 17px;
  height: 17px;
  place-items: center;
  flex-shrink: 0;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, #4f7cac 16%, var(--bg));
  color: #4f7cac;
}

.file-chip svg { flex-shrink: 0; }

.file-chip-name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-chip-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fg-4);
  cursor: pointer;
  transition: all var(--t);
}

.file-chip-remove:hover { background: var(--red); color: #fff; }

.skill-chips-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 4px;
  padding: 7px 2px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));
}

.skill-chips-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}

.skill-chips-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--fg-3);
  font-size: 11px;
  font-weight: 600;
}

.skill-chips-title svg {
  color: var(--accent);
}

.skill-clear-all {
  border: none;
  background: transparent;
  color: var(--fg-4);
  cursor: pointer;
  font-family: var(--sans);
  font-size: 11px;
  line-height: 1;
  transition: color var(--t);
}

.skill-clear-all:hover {
  color: var(--red);
}

.skill-chips-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.skill-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  gap: 5px;
  padding: 3px 4px 3px 5px;
  background: color-mix(in srgb, var(--accent) 11%, var(--bg));
  color: var(--fg-2);
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border));
  border-radius: var(--r-sm);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  cursor: default;
}

.skill-chip-icon {
  display: inline-grid;
  width: 17px;
  height: 17px;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--accent-bg);
  color: var(--accent);
  flex-shrink: 0;
}

.skill-chip svg {
  flex-shrink: 0;
}

.skill-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-chip-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--fg-4);
  padding: 0;
  cursor: pointer;
  border-radius: var(--r-sm);
  transition: all var(--t);
}

.skill-chip-remove:hover {
  background: var(--red);
  color: #fff;
}

/* 权限选择器（下拉式） */
.tool-dropdown {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  min-width: 160px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  z-index: 100;
  overflow: hidden;
}

.tool-dropdown-title {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-4);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.tool-dropdown-list {
  max-height: 200px;
  overflow-y: auto;
  padding: 4px;
}

.tool-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--fg-2);
  cursor: pointer;
  border-radius: var(--r-sm);
  transition: all var(--t);
}

.tool-option:hover {
  background: var(--bg-2);
}

.tool-option.active {
  color: var(--accent);
  font-weight: 500;
}

.tool-option svg {
  color: var(--accent);
  flex-shrink: 0;
}

.reasoning-effort-selector {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}

.effort-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
  padding: 2px 6px;
  border-radius: var(--r-sm);
  transition: all var(--t);
  cursor: pointer;
  background: none;
  border: none;
  white-space: nowrap;
}

.effort-btn:hover {
  background: var(--bg-3);
}

.effort-btn svg {
  color: var(--fg-4);
  width: 8px;
  height: 8px;
  flex-shrink: 0;
}

.effort-current-label {
  display: inline-grid;
  width: 2em;
  place-items: center;
}

.effort-dropdown {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  min-width: 140px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  z-index: 100;
  overflow: hidden;
}

.effort-dropdown-title {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-4);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.effort-dropdown-list {
  max-height: 200px;
  overflow-y: auto;
}

.effort-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--fg-2);
  cursor: pointer;
  transition: all var(--t);
}

.effort-option:hover {
  background: var(--bg-2);
}

.effort-option.active {
  color: var(--accent);
  font-weight: 500;
}

.effort-option svg {
  color: var(--accent);
}

.chat-reasoning-popover {
  position: absolute;
  right: 0;
  bottom: 100%;
  z-index: 100;
  width: min(340px, calc(100vw - 28px));
  margin-bottom: 8px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border));
  border-radius: var(--r);
  background: linear-gradient(135deg, var(--bg), color-mix(in srgb, var(--accent) 7%, var(--bg)));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #ffffff 12%, transparent), var(--shadow), 0 12px 28px color-mix(in srgb, var(--accent) 13%, transparent);
}

.chat-reasoning-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 11px;
  color: var(--fg-3);
  font-size: 11px;
  line-height: 1.2;
}

.chat-reasoning-value {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.chat-reasoning-value-en {
  margin-left: 5px;
  color: var(--fg-4);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.2px;
}

.chat-reasoning-track {
  position: relative;
  display: flex;
  align-items: center;
  height: 22px;
}

.chat-reasoning-input {
  position: relative;
  z-index: 2;
  width: 100%;
  height: 6px;
  margin: 0;
  appearance: none;
  outline: none;
  cursor: pointer;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent) 0 var(--effort-progress), var(--bg-3) var(--effort-progress) 100%);
  box-shadow: inset 0 1px 2px color-mix(in srgb, #000000 18%, transparent);
}

.chat-reasoning-input:focus-visible {
  box-shadow: 0 0 0 3px var(--accent-bg), inset 0 1px 2px color-mix(in srgb, #000000 18%, transparent);
}

.chat-reasoning-input::-webkit-slider-thumb {
  width: 18px;
  height: 18px;
  appearance: none;
  border: 3px solid var(--bg);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent), 0 0 14px color-mix(in srgb, var(--accent) 70%, transparent);
  transition: transform var(--t), box-shadow var(--t);
}

.chat-reasoning-input:hover::-webkit-slider-thumb,
.chat-reasoning-input:focus-visible::-webkit-slider-thumb {
  transform: scale(1.15);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent), 0 0 18px color-mix(in srgb, var(--accent) 80%, transparent);
}

.chat-reasoning-input::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border: 3px solid var(--bg);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent), 0 0 14px color-mix(in srgb, var(--accent) 70%, transparent);
}

.chat-reasoning-ticks {
  position: absolute;
  top: 50%;
  left: 7px;
  right: 7px;
  z-index: 3;
  display: flex;
  justify-content: space-between;
  pointer-events: none;
  transform: translateY(-50%);
}

.chat-reasoning-ticks span {
  width: 4px;
  height: 4px;
  border: 1px solid var(--bg);
  border-radius: 50%;
  background: var(--fg-4);
  transition: background var(--t), transform var(--t);
}

.chat-reasoning-ticks span.active {
  background: var(--bg);
  transform: scale(1.18);
}

.chat-reasoning-levels {
  display: flex;
  justify-content: space-between;
  padding: 0 7px;
  margin-top: 6px;
}

.chat-reasoning-levels button {
  flex: none;
  width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  white-space: nowrap;
  padding: 3px 0;
  border: 0;
  background: transparent;
  color: var(--fg-4);
  cursor: pointer;
  font-family: var(--sans);
  font-size: 10px;
  line-height: 1.2;
  transition: color var(--t), text-shadow var(--t), transform var(--t);
}

.chat-reasoning-levels button:hover {
  color: var(--fg-2);
  transform: translateY(-1px);
}

.chat-reasoning-levels button.active {
  color: var(--accent);
  font-weight: 700;
  text-shadow: 0 0 8px color-mix(in srgb, var(--accent) 50%, transparent);
}

.chat-reasoning-level-en {
  display: block;
  margin-top: 1px;
  color: var(--fg-4);
  font-size: 8px;
  font-weight: 500;
  line-height: 1;
  opacity: 0.85;
}

.chat-reasoning-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  color: var(--fg-3);
  font-size: 11px;
}

.chat-reasoning-custom input {
  min-width: 0;
  flex: 1;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
}

.chat-reasoning-custom input:focus {
  border-color: var(--accent);
  outline: none;
}

.input-area.welcome-mode {
  position: relative;
  padding: 0;
  z-index: 30;
  overflow: visible;
}

.input-area.welcome-mode .input-box {
  width: 100%;
  overflow: visible;
}

.input-area.welcome-mode .skill-selector {
  z-index: 120;
}

/* Welcome keeps its project selector, but uses the same composer surface as an active conversation. */
.input-area.welcome-mode .input-box {
  min-height: 98px;
  padding: 14px 16px 9px;
  border-color: var(--border-2);
  border-radius: 15px;
  background: var(--bg-2);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03), 0 8px 24px rgba(0, 0, 0, 0.04);
}

.input-area.welcome-mode .input-box.focused {
  border-color: var(--focus-border, #b7b7c0);
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.025), 0 8px 24px rgba(0, 0, 0, 0.05);
}

.input-area.welcome-mode .input-row {
  min-height: 48px;
  align-items: stretch;
}

.input-area.welcome-mode .input-box textarea {
  min-height: 44px;
  max-height: 150px;
  padding: 1px 2px;
  font-size: 16px;
  line-height: 1.55;
}

.input-area.welcome-mode .input-actions {
  align-self: flex-end;
  padding-bottom: 1px;
}

.input-area.welcome-mode .send-btn,
.input-area.welcome-mode .upload-btn,
.input-area.welcome-mode .plan-mode-btn,
.input-area.welcome-mode .continue-btn {
  width: 38px;
  height: 38px;
  border-radius: 10px;
}

.input-area.welcome-mode .send-btn svg,
.input-area.welcome-mode .upload-btn :deep(svg),
.input-area.welcome-mode .plan-mode-btn :deep(svg),
.input-area.welcome-mode .continue-btn svg {
  width: 18px;
  height: 18px;
}

.input-area.welcome-mode .usage-bar {
  min-height: 24px;
  margin-top: 4px;
  padding: 0;
  border-top-color: var(--border);
  flex-direction: row;
  justify-content: space-between;
  gap: 0;
}

.input-area.welcome-mode .usage-stats {
  margin-left: 0;
  opacity: 1;
}

.input-area.welcome-mode .model-actions {
  flex-direction: row;
  gap: 8px;
  padding-top: 6px;
  padding-bottom: 2px;
}

.input-area.welcome-mode .effort-btn,
.input-area.welcome-mode .model-btn {
  padding: 4px 7px;
  font-size: 13px;
  font-weight: 500;
}

[data-theme="dark"] .input-area.welcome-mode .input-box {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
}

/* Keep compact controls visually consistent. */
.effort-btn,
.model-btn,
.model-btn-label {
  font-family: inherit !important;
  font-size: 13px !important;
  font-weight: 400 !important;
  font-variant-numeric: proportional-nums;
  letter-spacing: 0;
}

.model-btn {
  display: inline-flex;
  align-items: center;
}

.model-btn-label {
  white-space: nowrap;
}

.model-btn > svg {
  flex: 0 0 auto;
  margin-left: 4px;
}

.chat-reasoning-end-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--border);
  color: var(--fg-2);
  font-size: 11px;
  cursor: pointer;
}

.chat-reasoning-end-toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.chat-reasoning-toggle-slider {
  position: relative;
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: var(--bg-3);
  transition: background var(--t);
}

.chat-reasoning-toggle-slider::before {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fg-4);
  content: '';
  transition: transform var(--t), background var(--t);
}

.chat-reasoning-end-toggle input:checked + .chat-reasoning-toggle-slider {
  background: var(--accent);
}

.chat-reasoning-end-toggle input:checked + .chat-reasoning-toggle-slider::before {
  transform: translateX(14px);
  background: var(--bg);
}

.chat-reasoning-end-toggle input:focus-visible + .chat-reasoning-toggle-slider {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.model-selector {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}

.model-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
  font-family: var(--mono);
  padding: 2px 6px;
  border-radius: var(--r-sm);
  transition: all var(--t);
  cursor: pointer;
  background: none;
  border: none;
  white-space: nowrap;
}

.model-btn:hover {
  background: var(--bg-3);
}

.model-dropdown {
  position: absolute;
  bottom: 100%;
  right: 0;
  display: flex;
  flex-direction: column;
  width: min(300px, calc(100vw - 24px));
  height: 340px;
  margin-bottom: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  z-index: 100;
  overflow: hidden;
}

.model-search { flex: 0 0 44px; display: flex; align-items: center; gap: 9px; padding: 0 14px; border-bottom: 1px solid var(--border); color: var(--fg-4); }.model-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: 14px; }.model-search input::placeholder { color: var(--fg-4); }

.model-dropdown-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  background: var(--bg-2);
}

.model-option { width: 100%; display: flex; align-items: stretch; position: relative; min-height: 44px; background: var(--bg); color: var(--fg); }
.model-select-button { min-width: 0; flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 14px; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.model-option:hover { background: var(--bg-2); }
.model-option:hover .model-select-button { background: transparent; }
.model-channel-group + .model-channel-group { border-top: 1px solid var(--border); }
.model-channel-toggle {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 34px;
  gap: 8px;
  padding: 7px 14px;
  border: 0;
  background: var(--bg-2);
  color: var(--fg-3);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.model-channel-toggle:hover { color: var(--fg); background: var(--bg-3); }
.model-channel-toggle svg { flex: 0 0 auto; transition: transform var(--t); }
.model-channel-toggle svg.expanded { transform: rotate(90deg); }
.model-channel-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-channel-count { margin-left: auto; color: var(--fg-4); font-size: 11px; }
.model-option-name { min-width: 0; display: flex; flex-direction: column; gap: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-option-name small { color: var(--fg-4); font-size: 10px; font-weight: 400; }
.model-option.active { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.model-option.active::before { position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--accent); content: ''; }
.model-option.active .model-option-name small { color: var(--accent); opacity: 0.72; }
.model-option svg { color: var(--accent); }
.model-default-action { width: 40px; flex: 0 0 40px; display: grid; place-items: center; padding: 0; border: 0; background: transparent; color: var(--fg-4); cursor: pointer; }
.model-default-action:hover:not(:disabled) { background: transparent; color: var(--accent); }
.model-default-action:disabled { cursor: default; }
.model-default-action.is-default { color: var(--accent); }
.model-default-action svg { width: 15px; height: 15px; }

.model-empty { padding: 18px 14px; color: var(--fg-4); font-size: 13px; text-align: center; }
.model-manage { flex: 0 0 44px; border-top: 1px solid var(--border); }
.model-manage button { width: 100%; height: 100%; display: flex; align-items: center; gap: 9px; padding: 0 14px; border: 0; background: transparent; color: var(--fg-2); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.model-manage button:hover { background: var(--bg-2); color: var(--fg); }

.loading-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: loadBounce 0.6s infinite alternate;
}

@keyframes loadBounce {
  from {
    opacity: 0.3;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1.2);
  }
}

/* ===== 移动端适配 ===== */
@media (max-width: 640px) {
  .input-area {
    padding: 8px 6px;
  }

  .input-box {
    padding: 4px 6px 0;
    border-radius: var(--r);
  }

  .input-box textarea {
    font-size: 16px;
    min-height: 20px;
  }

  .input-row {
    gap: 4px;
  }

  .btn-icon-sm, .send-btn, .plan-mode-btn, .continue-btn, .stop-btn {
    width: 32px;
    height: 32px;
  }

  .hide-mobile {
    display: none !important;
  }

  .model-btn {
    font-size: 11px;
    padding: 2px 4px;
  }

  .model-dropdown {
    min-width: 160px;
  }

  .effort-btn {
    font-size: 11px;
    padding: 2px 4px;
  }

  .effort-dropdown {
    min-width: 120px;
  }

  .workflow-detail {
    left: calc(50% - 4px);
    width: min(380px, calc(100vw - 16px));
    max-height: min(44vh, 360px);
  }

  .slash-popup {
    left: 8px;
    right: 8px;
  }

  .tool-btn {
    font-size: 11px;
    padding: 2px 4px;
  }

  .tool-dropdown {
    min-width: 140px;
  }
}

/* 宠物精灵浮层 — 优先级低于输入面板 */
:deep(.pet-float) {
  position: absolute;
  bottom: 60px;
  right: 16px;
  z-index: 1;
  pointer-events: auto;
  transition: right 0.2s ease;
}

/* 抵消右侧面板占用的 320px，保持宠物相对窗口的位置不变。 */
.input-area.right-panel-open :deep(.pet-float) {
  right: -304px;
}

@media (max-width: 768px) {
  .input-area.right-panel-open :deep(.pet-float) {
    right: 16px;
  }
}

/* ============= 工作流浮层 ============= */
.workflow-float {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  z-index: 11;
  transform: translateX(-50%);
}

.workflow-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 5px 11px;
  border: 1px solid color-mix(in srgb, var(--glass-border) 58%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--glass-bg) 68%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 5px 16px color-mix(in srgb, #000000 10%, transparent);
  color: var(--fg-3);
  font: 600 12px var(--sans);
  white-space: nowrap;
  cursor: default;
  transition: background var(--t), border-color var(--t), box-shadow var(--t);
}

.workflow-float:hover .workflow-trigger,
.workflow-trigger:focus-visible {
  border-color: var(--glass-border);
  background: color-mix(in srgb, var(--glass-bg) 92%, var(--accent-bg));
}

.workflow-trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.workflow-trigger-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-4);
}

.workflow-trigger-dot.active {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}

.workflow-trigger-dot.completed {
  background: var(--green, #2e7d32);
}

.workflow-trigger-dot.failed {
  background: var(--red, #c62828);
}

.workflow-detail {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  width: min(380px, calc(100vw - 32px));
  max-height: min(48vh, 400px);
  overflow: auto;
  padding: 10px 12px 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--glass-border));
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--glass-bg) 94%, var(--accent-bg));
  backdrop-filter: blur(var(--blur-sm));
  -webkit-backdrop-filter: blur(var(--blur-sm));
  box-shadow: var(--glass-shadow), 0 14px 34px color-mix(in srgb, var(--accent) 12%, transparent);
  transform: translateX(-50%);
}

.workflow-detail-heading {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  color: var(--fg-3);
  font-size: 12px;
}

.workflow-detail-heading svg {
  margin-right: 6px;
  flex-shrink: 0;
  color: var(--accent);
}

.workflow-detail-heading {
  color: var(--fg-2);
  font-weight: 600;
}

.workflow-detail :deep(.cl) {
  font-size: 14px;
}

.workflow-detail :deep(.cl-title),
.workflow-detail :deep(.cl-desc) {
  font-size: 14px;
}

.workflow-detail :deep(.cl-title),
.workflow-detail :deep(.cl-row.current .cl-desc) {
  font-weight: 600;
}

.workflow-detail :deep(.cl-badge),
.workflow-detail :deep(.cl-progress),
.workflow-detail :deep(.cl-result),
.workflow-detail :deep(.cl-err) {
  font-size: 12px;
}

.workflow-detail :deep(.cl-tag) {
  font-size: 11px;
}

/* Goal 浮层复用 workflow 样式，补充 goal 专属 deep 覆盖 */
.goal-float {
  left: auto;
  right: 12px;
  transform: none;
}
.goal-float .workflow-detail {
  left: auto;
  right: 0;
  transform: none;
}
.workflow-float-enter-from,
.workflow-float-leave-to {
  opacity: 0;
}
.goal-float.workflow-float-enter-from,
.goal-float.workflow-float-leave-to {
  transform: translateY(8px);
}

.workflow-detail :deep(.gl) {
  font-size: 14px;
}
.workflow-detail :deep(.gl-title),
.workflow-detail :deep(.gl-desc) {
  font-size: 14px;
}
.workflow-detail :deep(.gl-title),
.workflow-detail :deep(.gl-row.current .gl-desc) {
  font-weight: 600;
}
.workflow-detail :deep(.gl-badge),
.workflow-detail :deep(.gl-progress),
.workflow-detail :deep(.gl-evidence) {
  font-size: 12px;
}
.workflow-trigger-dot.blocked {
  background: var(--red, #c62828);
  box-shadow: 0 0 0 3px var(--red-bg, #ffebee);
}
.workflow-trigger-dot.paused {
  background: var(--yellow, #f57f17);
}

.workflow-float-enter-active,
.workflow-float-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.workflow-float-enter-from,
.workflow-float-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}

.workflow-detail-enter-active,
.workflow-detail-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.workflow-detail-enter-from,
.workflow-detail-leave-to {
  opacity: 0;
  transform: translate(-50%, 6px);
}
</style>
