<template>
  <section class="desktop-home" :class="{ 'sidebar-only': sidebarOnly, 'settings-mode': settingsMode }">
    <div id="desktop-settings-sidebar" v-show="settingsMode" class="desktop-settings-sidebar"></div>
    <div v-if="!settingsMode" class="desktop-home-grid">
      <aside class="desktop-projects">
        <div class="desktop-sidebar-header">
          <div
            class="desktop-sidebar-brand"
            @contextmenu.prevent.stop="emit('open-home-context', $event)"
          >
            <span>Loopra</span>
          </div>
          <div class="desktop-sidebar-header-actions">
            <button
              class="desktop-sidebar-header-button"
              type="button"
              title="搜索会话"
              aria-label="搜索会话"
              :aria-expanded="searchOpen"
              @click="toggleSearch"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
            </button>
            <slot name="sidebar-header-actions" />
          </div>
        </div>
        <nav class="desktop-home-nav" aria-label="快捷操作">
          <button type="button" @click="runFooterAction('new-session')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M9 15l2-6 7-7 5 5-7 7z"/></svg>
            <span>新对话</span>
            <span class="desktop-nav-plus" aria-hidden="true">+</span>
          </button>
        </nav>
        <div class="desktop-sidebar-scroll">
          <div class="desktop-project-footer desktop-top-actions">
            <div class="desktop-project-footer-menu">
              <button type="button" title="需求池" aria-label="需求池" @click="runFooterAction('open-requirement-board')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                需求池
              </button>
              <button type="button" @click="runFooterAction('open-skills')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                技能
              </button>
              <button type="button" title="工具" aria-label="工具" @click="runFooterAction('open-tools')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                插件
              </button>
            </div>
            <div class="desktop-project-footer-more" @click.stop>
              <button ref="exploreButton" class="desktop-more-button desktop-explore-button" type="button" :class="{ active: exploreOpen }" :aria-expanded="exploreOpen" aria-haspopup="menu" title="探索" aria-label="探索" @click.stop="toggleExplore">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
                <span>探索</span>
              </button>
              <div v-if="exploreOpen && !popupUsesNativeOverlay" class="desktop-footer-more-menu desktop-explore-menu" role="menu" aria-label="探索" @click.stop>
                <button class="desktop-footer-more-item desktop-explore-item" type="button" role="menuitem" @click="runFooterAction('open-skills')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>
                  <span>站点</span>
                </button>
                <button class="desktop-footer-more-item desktop-explore-item" type="button" role="menuitem" @click="runFooterAction('open-settings')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="var(--bg, #fff)"/><circle cx="15" cy="17" r="2" fill="var(--bg, #fff)"/></svg>
                  <span>自定义</span>
                </button>
                <div class="desktop-explore-divider"></div>
                <button class="desktop-footer-more-item desktop-explore-item" type="button" role="menuitem" @click="runFooterAction('open-sub-agents')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A4 4 0 0 1 21 18v1"/></svg>
                  <span>子代理</span>
                </button>
                <button class="desktop-footer-more-item desktop-explore-item" type="button" role="menuitem" @click="runFooterAction('open-tools')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                  <span>工具</span>
                </button>
                <ServiceProcessManager placement="bottom" :show-label="true" />
                <button class="desktop-footer-more-item desktop-explore-item" type="button" role="menuitem" @click="runFooterAction('toggle-theme')">
                  <svg v-if="theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.2 14.1A8.5 8.5 0 0 1 9.9 3.8 8.5 8.5 0 1 0 20.2 14.1Z"/></svg>
                  <span>{{ theme === 'dark' ? '浅色模式' : '深色模式' }}</span>
                </button>
              </div>
            </div>
          </div>



        <div class="desktop-home-heading desktop-project-heading" :class="{ 'multi-selecting': projectMultiSelect }">
          <span>项目</span>
          <div class="desktop-heading-actions">
            <template v-if="projectMultiSelect">
              <button v-if="displayWorkspaces.length > 0" class="desktop-select-all" type="button" :title="allProjectsSelected ? '取消全选' : '全部选择'" @click="toggleSelectAllProjects">
                {{ allProjectsSelected ? '取消全选' : '全选' }}
              </button>
              <button v-if="selectedHashes.size > 0" class="desktop-delete-selected" type="button" title="删除选中的项目" aria-label="删除选中的项目" @click="emit('delete-workspaces', selectedWorkspaces)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
                删除选中 ({{ selectedHashes.size }})
              </button>
            </template>
            <template v-else>
              <button class="desktop-refresh-projects" type="button" title="刷新项目和会话列表" aria-label="刷新项目和会话列表" :disabled="refreshing" @click="emit('refresh')">
                <ReloadOutlined :class="{ spinning: refreshing }" />
              </button>
              <button class="desktop-add-project" type="button" title="添加项目" aria-label="添加项目" @click="emit('add-workspace')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
              </button>
            </template>
            <button class="desktop-multi-toggle desktop-multi-toggle-project" type="button" :class="{ active: projectMultiSelect }" :title="projectMultiSelect ? '退出多选' : '开启多选'" :aria-label="projectMultiSelect ? '退出多选' : '开启多选'" :aria-pressed="projectMultiSelect" @click="toggleProjectMultiSelect">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>
            </button>
          </div>
        </div>
      <div class="desktop-sessions">
        <div v-show="!sidebarOnly && (!searchOpen || query)" class="desktop-home-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>
          <input ref="sidebarSearchInput" v-model="query" type="search" placeholder="搜索会话" />
        </div>
      </div>
        <div class="desktop-project-list" @dragover.prevent="onListDragOver" @drop.prevent="onListDrop" @dragend="onListDragEnd">
          <div v-if="loading && !sessionsLoaded" class="desktop-home-muted">加载会话...</div>
          <section v-for="workspace in visibleWorkspaces" :key="workspace.hash" class="desktop-project-group">
          <div class="desktop-project-row" :class="{ active: workspace.hash === activeWorkspaceHash && !activeSessionName, selected: selectedHashes.has(workspace.hash), 'session-multi-selecting': isSessionMultiSelect(workspace.hash) }">
            <button
              class="desktop-project"
              :class="{
                active: workspace.hash === activeWorkspaceHash && !activeSessionName,
                selected: selectedHashes.has(workspace.hash),
                collapsed: isProjectCollapsed(workspace.hash),
                dragging: draggingHash === workspace.hash,
                'drag-over-before': dragOverHash === workspace.hash && dragOverBefore,
                'drag-over-after': dragOverHash === workspace.hash && !dragOverBefore
              }"
              :data-hash="workspace.hash"
              type="button"
              :aria-expanded="String(!isProjectCollapsed(workspace.hash))"
              :title="isProjectCollapsed(workspace.hash) ? '展开项目会话' : '收起项目会话'"
              draggable="true"
              @dragstart="onProjectDragStart($event, workspace.hash)"
              @click="handleProjectClick(workspace, $event)"
              @contextmenu.prevent.stop="openContextMenu($event, 'workspace', workspace)"
            >
              <span
                v-if="projectMultiSelect"
                class="desktop-project-check"
                :class="{ checked: selectedHashes.has(workspace.hash) }"
                role="checkbox"
                :aria-checked="selectedHashes.has(workspace.hash)"
                :aria-label="`选择项目 ${workspace.name}`"
                @click.stop.prevent="toggleSelect(workspace.hash, $event)"
                @dragstart.stop.prevent
              >
                <svg v-if="selectedHashes.has(workspace.hash)" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
              </span>
              <svg
                v-if="isProjectCollapsed(workspace.hash)"
                class="desktop-folder-icon desktop-folder-icon-closed"
                data-state="closed"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
              </svg>
              <svg
                v-else
                class="desktop-folder-icon desktop-folder-icon-open"
                data-state="open"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M20 10V8a2 2 0 0 0-2-2h-5.93a2 2 0 0 1-1.66-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13"/>
                <path d="m2 18 2.17-6.5A2 2 0 0 1 6.07 10H20a2 2 0 0 1 1.9 2.63l-2 6A2 2 0 0 1 18 20H4a2 2 0 0 1-2-2Z"/>
              </svg>
              <span>{{ workspace.name }}</span>
            </button>
            <div class="desktop-project-session-actions" @click.stop>
              <template v-if="isSessionMultiSelect(workspace.hash)">
                <button v-if="projectSessions(workspace.hash).length > 0" class="desktop-select-all desktop-select-all-sessions" type="button" :title="allSessionsSelected(workspace.hash) ? '取消全选' : '全部选择'" @click.stop="toggleSelectAllSessions(workspace.hash)">
                  {{ allSessionsSelected(workspace.hash) ? '取消全选' : '全选' }}
                </button>
                <button v-if="selectedSessionsFor(workspace.hash).length > 0" class="desktop-delete-selected desktop-delete-sessions" type="button" title="删除选中的会话" :aria-label="`删除选中的会话（${selectedSessionsFor(workspace.hash).length}）`" @click.stop="emit('delete-sessions', selectedSessionsFor(workspace.hash))">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
                  删除选中 ({{ selectedSessionsFor(workspace.hash).length }})
                </button>
              </template>
              <button class="desktop-multi-toggle desktop-multi-toggle-session" type="button" :class="{ active: isSessionMultiSelect(workspace.hash) }" :title="isSessionMultiSelect(workspace.hash) ? '退出会话多选' : '开启会话多选'" :aria-label="isSessionMultiSelect(workspace.hash) ? '退出会话多选' : '开启会话多选'" :aria-pressed="isSessionMultiSelect(workspace.hash)" @click.stop="toggleSessionMultiSelect(workspace.hash)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>
              </button>
            </div>
          </div>
          <Transition name="desktop-project-collapse">
            <div v-if="shouldShowProjectSessions(workspace.hash)" class="desktop-project-children">
              <div class="desktop-project-children-inner">
                <button v-for="session in visibleProjectSessions(workspace.hash)" :key="`${session.workspaceHash}:${session.name}`" v-session-title-scroll class="desktop-session" :class="{ selected: selectedSessionKeys.has(sessionKey(session)), active: session.name === activeSessionName && session.workspaceHash === activeWorkspaceHash }" type="button" @mouseenter="prepareSessionTitleScroll" @mouseleave="resetSessionTitleScroll" @click="isSessionMultiSelect(session.workspaceHash) ? toggleSelectSession(session, $event) : openSession(session)" @contextmenu.prevent.stop="openContextMenu($event, 'session', session)">
                <span
                  v-if="isSessionMultiSelect(session.workspaceHash)"
                  class="desktop-session-check"
                  :class="{ checked: selectedSessionKeys.has(sessionKey(session)) }"
                  role="checkbox"
                  :aria-checked="selectedSessionKeys.has(sessionKey(session))"
                  :aria-label="`选择会话 ${session.title || session.name}`"
                  @click.stop.prevent="toggleSelectSession(session, $event)"
                  @dragstart.stop.prevent
                >
                  <svg v-if="selectedSessionKeys.has(sessionKey(session))" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                <span class="desktop-monogram desktop-session-monogram" :class="badgeTone(workspaceNameOf(session.workspaceHash))">{{ initial(workspaceNameOf(session.workspaceHash)) }}</span>
                <span class="desktop-session-name">
                  <span class="desktop-session-name-text">{{ session.title || session.name }}</span>
                </span>
                <span v-if="formatSessionTime(session)" class="desktop-session-time" :title="formatSessionTime(session, true)">{{ formatSessionTime(session) }}</span>
                </button>
                <button v-if="shouldShowSessionToggle(workspace.hash)" class="desktop-show-sessions" type="button" @click="expandedProjects.has(workspace.hash) ? expandedProjects.delete(workspace.hash) : expandedProjects.add(workspace.hash)">{{ expandedProjects.has(workspace.hash) ? '收起' : '展开显示' }}</button>
              </div>
            </div>
          </Transition>
          </section>
          <button
            v-if="shouldShowWorkspaceToggle"
            class="desktop-show-projects"
            type="button"
            :aria-expanded="String(allProjectsVisible)"
            @click="allProjectsVisible = !allProjectsVisible"
          >
            {{ allProjectsVisible ? '收起' : '展开显示' }}
          </button>
          <div v-if="!displayWorkspaces.length" class="desktop-home-muted">暂无项目</div>
        </div>
        </div>
        <div class="desktop-project-footer desktop-sidebar-settings">
          <div class="desktop-project-footer-settings">
            <button type="button" @click="runFooterAction('open-settings')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15.14 19a1.65 1.65 0 0 0-1 1.51V20.6a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.86 15a1.65 1.65 0 0 0-1.51-1H3.4a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 5 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9.32 4a1.65 1.65 0 0 0 1-1.51V2.4a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19 8.32a1.65 1.65 0 0 0 1.51 1h.09a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.11 1.68Z"/></svg>
              设置
            </button>
          </div>
        </div>
      </aside>
      <section v-if="!sidebarOnly" class="desktop-home-workspace" aria-label="开始会话">
        <div class="desktop-home-welcome">
          <svg class="desktop-welcome-symbol" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="34" height="34" rx="12"/><path d="m16 18 5 6-5 6M26 30h7"/></svg>
          <h1>你想让我们<span v-if="activeWorkspace">在 {{ activeWorkspace.name }} 中</span>构建什么？</h1>
        </div>
        <div class="desktop-home-start">
          <div class="desktop-home-context"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7h7l2 2h9l-2 11H3z"/><path d="M3 7V4h7l2 3"/></svg><span>{{ activeWorkspace?.name || '选择项目，开始工作' }}</span></div>
          <button class="desktop-start-session" type="button" @click="emit('new-session')"><span>新建会话</span><span class="desktop-start-arrow" aria-hidden="true">↑</span></button>
        </div>
      </section>
    </div>
    <Teleport to="body">
      <div v-if="searchOpen && !searchUsesNativeOverlay" class="desktop-search-mask" @mousedown.self="closeSearch">
        <section class="desktop-search-palette" role="dialog" aria-modal="true" aria-label="搜索聊天">
          <div class="desktop-search-input-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
            <input
              ref="searchInput"
              v-model="paletteQuery"
              type="search"
              placeholder="搜索聊天"
              aria-label="搜索聊天"
              autocomplete="off"
              @keydown="handleSearchKeydown"
            />
            <kbd>Esc</kbd>
          </div>
          <div class="desktop-search-content">
            <section v-if="searchChatResults.length" class="desktop-search-section" aria-labelledby="desktop-search-chats-title">
              <div id="desktop-search-chats-title" class="desktop-search-section-title">聊天</div>
              <div class="desktop-search-results" role="listbox" aria-label="聊天搜索结果">
                <button
                  v-for="(item, index) in searchChatResults"
                  :key="paletteItemKey(item)"
                  class="desktop-search-result"
                  :class="{ active: paletteActiveIndex === index }"
                  type="button"
                  role="option"
                  :aria-selected="paletteActiveIndex === index"
                  @mouseenter="paletteActiveIndex = index"
                  @click="selectPaletteItem(item)"
                >
                  <span class="desktop-search-result-icon desktop-search-chat-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 5h12l3 3v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="M7 12h10M7 16h6"/></svg>
                  </span>
                  <span class="desktop-search-result-title">{{ item.title }}</span>
                  <span class="desktop-search-result-workspace">{{ item.workspaceName }}</span>
                </button>
              </div>
            </section>

            <section v-if="searchActionResults.length" class="desktop-search-section" aria-labelledby="desktop-search-actions-title">
              <div id="desktop-search-actions-title" class="desktop-search-section-title">快捷操作</div>
              <div class="desktop-search-results" role="listbox" aria-label="快捷操作">
                <button
                  v-for="(item, index) in searchActionResults"
                  :key="paletteItemKey(item)"
                  class="desktop-search-result desktop-search-action"
                  :class="{ active: paletteActiveIndex === searchChatResults.length + index }"
                  type="button"
                  role="option"
                  :aria-selected="paletteActiveIndex === searchChatResults.length + index"
                  @mouseenter="paletteActiveIndex = searchChatResults.length + index"
                  @click="selectPaletteItem(item)"
                >
                  <span class="desktop-search-result-icon" aria-hidden="true">
                    <svg v-if="item.id === 'new-session'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 17.5V20h2.5L19.2 7.3a1.8 1.8 0 0 0-2.5-2.5L4 17.5Z"/><path d="m14.8 6.7 2.5 2.5"/></svg>
                    <svg v-else-if="item.id === 'add-workspace'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-15A2.5 2.5 0 0 1 1 17.5v-10Z"/><path d="M12 10v6M9 13h6"/></svg>
                    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
                  </span>
                  <span class="desktop-search-result-title">{{ item.title }}</span>
                  <kbd>{{ item.shortcut }}</kbd>
                </button>
              </div>
            </section>

            <div v-if="!searchChatResults.length && !searchActionResults.length" class="desktop-search-empty">
              未找到匹配内容
            </div>
          </div>
        </section>
      </div>
    </Teleport>
    <Teleport to="body">
      <div
        v-if="contextMenu.visible && !popupUsesNativeOverlay"
        class="desktop-context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @contextmenu.prevent
      >
        <template v-if="contextMenu.type === 'session'">
          <button type="button" @click="chooseContextAction('rename-session')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            重命名会话
          </button>
          <button class="danger" type="button" @click="chooseContextAction('delete-session')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
            删除会话
          </button>
        </template>
        <template v-else>
          <button type="button" @click="chooseContextAction('copy-workspace-path')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3"/></svg>
            复制项目路径
          </button>
          <div class="desktop-context-menu-divider"></div>
          <button type="button" @click="chooseContextAction('clear-workspace')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
            清空会话
          </button>
          <button type="button" @click="chooseContextAction('clear-old-sessions')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            清空三天前的会话
          </button>
          <div class="desktop-context-menu-divider"></div>
          <button class="danger" type="button" @click="chooseContextAction('delete-workspace')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
            删除项目
          </button>
        </template>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="renameDialog.visible && !popupUsesNativeOverlay"
        class="desktop-rename-mask"
        @click.self="closeRenameDialog"
      >
        <div class="desktop-rename-dialog" role="dialog" aria-label="重命名会话">
          <h3>重命名会话</h3>
          <input
            ref="renameInput"
            v-model="renameDialog.value"
            type="text"
            maxlength="100"
            placeholder="输入新的会话名称"
            @keydown.enter="confirmRename"
            @keydown.esc="closeRenameDialog"
          />
          <div class="desktop-rename-actions">
            <button type="button" class="desktop-rename-cancel" @click="closeRenameDialog">取消</button>
            <button type="button" class="desktop-rename-confirm" :disabled="!renameDialog.value.trim() || renaming" @click="confirmRename">确定</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch} from 'vue'
import {ReloadOutlined} from '@ant-design/icons-vue'
import {message} from 'ant-design-vue'
import {sessionsAPI} from './services/api'
import {copyToClipboard} from './utils/helpers'
import {toPlainIpcValue} from './utils/ipcPayload'
import ServiceProcessManager from './components/ServiceProcessManager.vue'

const props = defineProps({
  sidebarOnly: { type: Boolean, default: false },
  settingsMode: { type: Boolean, default: false },
  activeSessionName: { type: String, default: '' },
  workspaces: { type: Array, default: () => [] },
  activeWorkspaceHash: { type: String, default: '' },
  theme: { type: String, default: 'gray' },
  refreshKey: { type: Number, default: 0 },
  refreshing: { type: Boolean, default: false }
})
const emit = defineEmits(['select-workspace', 'new-session', 'open-session', 'open-skills', 'open-requirement-board', 'open-tools', 'open-sub-agents', 'open-settings', 'toggle-theme', 'add-workspace', 'open-file-search', 'search-visibility-change', 'refresh', 'delete-session', 'delete-sessions', 'clear-workspace', 'clear-old-sessions', 'delete-workspace', 'delete-workspaces', 'reorder-workspaces', 'session-renamed', 'open-home-context'])

const query = ref('')
const searchOpen = ref(false)
const searchUsesNativeOverlay = computed(() => props.sidebarOnly && Boolean(window.electronAPI?.desktopSearch))
const popupUsesNativeOverlay = computed(() => props.sidebarOnly && Boolean(window.electronAPI?.desktopPopup))
const searchInput = ref(null)
const paletteQuery = ref('')
const paletteActiveIndex = ref(0)
const sessions = ref([])
const loading = ref(false)
const sessionsLoaded = ref(false)
// 项目拖拽排序：本地副本用于实时预览，props 变化时同步
const displayWorkspaces = ref([])
const draggingHash = ref('')
const dragOverHash = ref('')
const dragOverBefore = ref(false)
const contextMenu = reactive({ visible: false, type: '', item: null, x: 0, y: 0 })
const exploreOpen = ref(false)
const exploreButton = ref(null)
// 会话重命名弹窗
const renameDialog = reactive({ visible: false, item: null, value: '' })
const renaming = ref(false)
const renameInput = ref(null)
let stopNativeSearchClosed = null
let stopNativePopupAction = null
let stopNativePopupClosed = null
let stopNativeSessionAction = null
const activeWorkspace = computed(() => props.workspaces.find((workspace) => workspace.hash === props.activeWorkspaceHash))
const PROJECT_PREVIEW_LIMIT = 10
const allProjectsVisible = ref(false)
const visibleWorkspaces = computed(() => {
  if (!props.sidebarOnly || projectMultiSelect.value || allProjectsVisible.value) return displayWorkspaces.value
  return displayWorkspaces.value.slice(0, PROJECT_PREVIEW_LIMIT)
})
const shouldShowWorkspaceToggle = computed(() =>
  props.sidebarOnly && !projectMultiSelect.value && displayWorkspaces.value.length > PROJECT_PREVIEW_LIMIT
)
const filteredSessions = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return sessions.value.filter((session) => !keyword || `${session.title || ''} ${session.name || ''}`.toLowerCase().includes(keyword))
})
const paletteActions = [
  { kind: 'action', id: 'new-session', title: '新聊天', shortcut: 'Ctrl+N', keywords: '新对话 新建会话 chat new' },
  { kind: 'action', id: 'add-workspace', title: '打开文件夹', shortcut: 'Ctrl+O', keywords: '项目 工作区 文件夹 folder workspace' },
  { kind: 'action', id: 'open-file-search', title: '搜索文件', shortcut: 'Ctrl+P', keywords: '文件 查找 file search' }
]
const searchChatResults = computed(() => {
  const keyword = paletteQuery.value.trim().toLowerCase()
  return [...sessions.value]
    .filter((session) => {
      if (!keyword) return true
      return `${session.title || ''} ${session.name || ''} ${workspaceNameOf(session.workspaceHash)}`.toLowerCase().includes(keyword)
    })
    .sort((a, b) => {
      const aActive = a.name === props.activeSessionName && (!props.activeWorkspaceHash || a.workspaceHash === props.activeWorkspaceHash)
      const bActive = b.name === props.activeSessionName && (!props.activeWorkspaceHash || b.workspaceHash === props.activeWorkspaceHash)
      if (aActive !== bActive) return aActive ? -1 : 1
      return sessionTime(b) - sessionTime(a)
    })
    .slice(0, keyword ? 50 : 10)
    .map((session) => ({
      kind: 'session',
      id: sessionKey(session),
      name: session.name,
      title: session.title || session.name || '未命名会话',
      workspaceHash: session.workspaceHash,
      workspaceName: workspaceNameOf(session.workspaceHash) || '默认项目'
    }))
})
const searchActionResults = computed(() => {
  const keyword = paletteQuery.value.trim().toLowerCase()
  return paletteActions.filter((action) => !keyword || `${action.title} ${action.keywords}`.toLowerCase().includes(keyword))
})
const expandedProjects = reactive(new Set())
// 项目会话的展开状态独立于“展开显示更多会话”状态。
// 折叠项目时隐藏该项目的全部会话；搜索或项目内多选仍会临时展示匹配/可选内容。
const collapsedProjects = reactive(new Set())
const initializedProjectHashes = new Set()

watch(
  () => [props.sidebarOnly, props.activeWorkspaceHash, props.workspaces],
  ([sidebarOnly, activeWorkspaceHash, workspaces]) => {
    if (!sidebarOnly || !activeWorkspaceHash || !workspaces?.length) return

    const firstWorkspaceHash = workspaces[0].hash
    const validHashes = new Set(workspaces.map((workspace) => workspace.hash))
    for (const hash of initializedProjectHashes) {
      if (!validHashes.has(hash)) {
        initializedProjectHashes.delete(hash)
        collapsedProjects.delete(hash)
      }
    }
    for (const workspace of workspaces) {
      if (initializedProjectHashes.has(workspace.hash)) continue
      if (workspace.hash === firstWorkspaceHash) collapsedProjects.delete(workspace.hash)
      else collapsedProjects.add(workspace.hash)
      initializedProjectHashes.add(workspace.hash)
    }
  },
  {immediate: true, deep: true}
)

function isProjectCollapsed(hash) {
  return props.sidebarOnly && collapsedProjects.has(hash)
}

function shouldShowProjectSessions(hash) {
  return !isProjectCollapsed(hash) || query.value || isSessionMultiSelect(hash)
}

function shouldShowSessionToggle(hash) {
  return props.sidebarOnly && !query.value && !isSessionMultiSelect(hash) && projectSessions(hash).length > 5
}

function toggleProjectSessions(hash) {
  if (!props.sidebarOnly) return
  if (collapsedProjects.has(hash)) collapsedProjects.delete(hash)
  else collapsedProjects.add(hash)
}

function handleProjectClick(workspace, event) {
  if (projectMultiSelect.value) {
    toggleSelect(workspace.hash, event)
    return
  }

  toggleProjectSessions(workspace.hash)
  emit('select-workspace', workspace.hash === props.activeWorkspaceHash ? '' : workspace.hash)
}

function visibleProjectSessions(hash) {
  const list = projectSessions(hash)
  return !props.sidebarOnly || query.value || isSessionMultiSelect(hash) || expandedProjects.has(hash) ? list : list.slice(0, 5)
}

function measureSessionTitle(row) {
  const container = row?.querySelector('.desktop-session-name')
  const title = container?.querySelector('.desktop-session-name-text')
  if (!container || !title) return null

  // The time and optional checkbox are flex siblings, so clientWidth is the
  // title's real remaining width for the current row/sidebar size.
  const availableWidth = container.clientWidth || container.getBoundingClientRect().width
  if (availableWidth <= 0) return null
  // The title is absolutely positioned at max-content width. offsetWidth is
  // therefore its natural rendered width instead of the clipped flex width.
  const titleWidth = Math.max(title.offsetWidth, title.scrollWidth, title.getBoundingClientRect().width)
  const scrollDistance = Math.max(0, Math.ceil(titleWidth - availableWidth))
  const overflowing = scrollDistance > 1
  const fadeWidth = Math.max(12, Math.min(36, Math.round(availableWidth * 0.18)))

  container.classList.toggle('is-overflowing', overflowing)
  container.style.setProperty('--desktop-session-fade-width', `${fadeWidth}px`)
  row.dataset.sessionTitleScrollDistance = overflowing ? String(scrollDistance) : '0'

  if (!overflowing) {
    title.style.transition = 'none'
    title.style.transform = 'translateX(0)'
  } else if (row.classList.contains('is-title-scrolling')) {
    title.style.transform = `translateX(-${scrollDistance}px)`
  }

  return {title, scrollDistance, overflowing}
}

const sessionTitleObservers = new WeakMap()
const vSessionTitleScroll = {
  mounted(row) {
    nextTick(() => measureSessionTitle(row))
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measureSessionTitle(row))
    observer.observe(row)
    sessionTitleObservers.set(row, observer)
  },
  updated(row) {
    nextTick(() => measureSessionTitle(row))
  },
  beforeUnmount(row) {
    sessionTitleObservers.get(row)?.disconnect()
    sessionTitleObservers.delete(row)
  }
}

function prepareSessionTitleScroll(event) {
  const row = event.currentTarget
  const title = row?.querySelector('.desktop-session-name-text')
  if (!title) return

  // Always measure from the origin. Otherwise a second pointer entry could
  // read the transformed rectangle and underestimate the natural text width.
  row.classList.remove('is-title-scrolling')
  title.style.transition = 'none'
  title.style.transform = 'translateX(0)'
  void title.offsetWidth
  const metrics = measureSessionTitle(row)
  if (!metrics?.overflowing) return
  const {scrollDistance} = metrics

  row.classList.add('is-title-scrolling')
  const duration = Math.max(0.8, Math.min(2.8, scrollDistance / 90))
  title.style.transition = `transform ${duration}s ease-in-out`
  title.style.transform = `translateX(-${scrollDistance}px)`
}

function resetSessionTitleScroll(event) {
  const row = event.currentTarget
  const container = row?.querySelector('.desktop-session-name')
  const title = container?.querySelector('.desktop-session-name-text')
  if (!title) return
  row.classList.remove('is-title-scrolling')
  title.style.transition = 'transform .25s ease-out'
  title.style.transform = 'translateX(0)'
}

function projectSessions(hash) {
  return filteredSessions.value
    // 左侧列表只由会话数据决定；打开状态不会额外插入或移除列表项。
    .filter(session => session.workspaceHash === hash)
    .sort((a, b) => sessionTime(b) - sessionTime(a))
}

function initial(name) {
  return String(name || 'L').trim().charAt(0).toUpperCase() || 'L'
}

function badgeTone(name) {
  let hash = 0
  for (const char of String(name || '')) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
  return `tone-${hash % 8}`
}

function workspaceNameOf(workspaceHash) {
  if (!workspaceHash) return ''
  const ws = props.workspaces.find((item) => item.hash === workspaceHash)
  return ws ? ws.name : ''
}

function sessionTime(session) {
  const value = session?.mtime
  if (typeof value === 'number') return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// 会话每行末尾的时间：今天显示 HH:mm，昨天显示「昨天」，今年显示 M/D，更早显示 Y/M/D；full 为 true 时返回完整日期时间（用于悬浮提示）
function formatSessionTime(session, full = false) {
  const ts = sessionTime(session)
  if (!ts) return ''
  const date = new Date(ts)
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (full) return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hm}`
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart.getTime() - 86400000)
  if (ts >= todayStart.getTime()) return hm
  if (ts >= yesterdayStart.getTime()) return '昨天'
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function openSession(session) {
  emit('open-session', {
    workspaceHash: session.workspaceHash,
    sessionName: session.name,
    title: session.title
  })
}

// ============ 会话多选 ============
// 会话多选模式按项目独立开启，只影响该项目下的会话。
const sessionMultiSelectProjects = reactive(new Set())
function isSessionMultiSelect(hash) {
  return sessionMultiSelectProjects.has(hash)
}

function toggleSessionMultiSelect(hash) {
  if (sessionMultiSelectProjects.has(hash)) {
    sessionMultiSelectProjects.delete(hash)
    clearSessionSelection(hash)
  } else {
    sessionMultiSelectProjects.add(hash)
  }
}

// 全选/取消全选（按当前项目内的显示顺序）
function allSessionsSelected(hash) {
  const list = projectSessions(hash)
  return list.length > 0 && list.every((session) => selectedSessionKeys.value.has(sessionKey(session)))
}

function toggleSelectAllSessions(hash) {
  const list = projectSessions(hash)
  const next = allSessionsSelected(hash)
    ? new Set()
    : new Set(list.map((session) => sessionKey(session)))
  const selectedFromOtherProjects = [...selectedSessionKeys.value].filter((key) => !key.startsWith(`${hash}:`))
  selectedSessionKeys.value = new Set([...selectedFromOtherProjects, ...next])
  sessionSelectionAnchors.delete(hash)
}

// 会话跨项目同名可能重复，选中 key 用 workspaceHash:name
function sessionKey(session) {
  return `${session.workspaceHash}:${session.name}`
}

const selectedSessionKeys = ref(new Set())
const sessionSelectionAnchors = new Map()

function selectedSessionsFor(hash) {
  return projectSessions(hash).filter((session) => selectedSessionKeys.value.has(sessionKey(session)))
}

function toggleSelectSession(session, event) {
  const key = sessionKey(session)
  const hash = session.workspaceHash
  const next = new Set(selectedSessionKeys.value)
  const sessionSelectionAnchor = sessionSelectionAnchors.get(hash)
  if (event.shiftKey && sessionSelectionAnchor) {
    // Shift+点击：只在当前项目内按显示顺序选择区间
    const list = projectSessions(hash)
    const from = list.findIndex((item) => sessionKey(item) === sessionSelectionAnchor)
    const to = list.findIndex((item) => sessionKey(item) === key)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      for (let index = lo; index <= hi; index++) next.add(sessionKey(list[index]))
    } else if (!next.has(key)) {
      next.add(key)
    }
  } else {
    sessionSelectionAnchors.set(hash, key)
    if (next.has(key)) next.delete(key)
    else next.add(key)
  }
  selectedSessionKeys.value = next
}

function clearSessionSelection(hash = '') {
  if (!hash) {
    selectedSessionKeys.value = new Set()
    sessionSelectionAnchors.clear()
    return
  }
  const prefix = `${hash}:`
  selectedSessionKeys.value = new Set([...selectedSessionKeys.value].filter((key) => !key.startsWith(prefix)))
  sessionSelectionAnchors.delete(hash)
}

// 项目多选模式：开启后才能勾选
const projectMultiSelect = ref(false)
function toggleProjectMultiSelect() {
  projectMultiSelect.value = !projectMultiSelect.value
  if (!projectMultiSelect.value) clearSelection()
}

// 全选/取消全选
const allProjectsSelected = computed(() =>
  displayWorkspaces.value.length > 0 && selectedHashes.value.size === displayWorkspaces.value.length
)
function toggleSelectAllProjects() {
  selectedHashes.value = allProjectsSelected.value
    ? new Set()
    : new Set(displayWorkspaces.value.map((workspace) => workspace.hash))
  selectionAnchor = null
}

// 项目多选：勾选集合 + Shift 区间选择的锚点
const selectedHashes = ref(new Set())
let selectionAnchor = null
const selectedWorkspaces = computed(() =>
  displayWorkspaces.value.filter((workspace) => selectedHashes.value.has(workspace.hash))
)

function toggleSelect(hash, event) {
  const list = displayWorkspaces.value.map((workspace) => workspace.hash)
  const next = new Set(selectedHashes.value)
  if (event.shiftKey && selectionAnchor) {
    // Shift+点击：将锚点到当前项之间的项目全部加入选择
    const from = list.indexOf(selectionAnchor)
    const to = list.indexOf(hash)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      for (let index = lo; index <= hi; index++) next.add(list[index])
    } else if (!next.has(hash)) {
      next.add(hash)
    }
  } else {
    selectionAnchor = hash
    if (next.has(hash)) next.delete(hash)
    else next.add(hash)
  }
  selectedHashes.value = next
}

function clearSelection() {
  selectedHashes.value = new Set()
  selectionAnchor = null
}

// ============ 项目拖拽排序 ============

watch(() => props.workspaces, (list) => {
  displayWorkspaces.value = (list || []).map((workspace) => ({ ...workspace }))
  // 清理已不在列表中的选中项（如批量删除后），避免残留失效勾选
  const valid = new Set((list || []).map((workspace) => workspace.hash))
  const kept = [...selectedHashes.value].filter((hash) => valid.has(hash))
  if (kept.length !== selectedHashes.value.size) {
    selectedHashes.value = new Set(kept)
    if (!kept.length) selectionAnchor = null
  }
  for (const hash of sessionMultiSelectProjects) {
    if (!valid.has(hash)) {
      sessionMultiSelectProjects.delete(hash)
      clearSessionSelection(hash)
    }
  }
}, { immediate: true, deep: true })

function onProjectDragStart(_event, hash) {
  draggingHash.value = hash
  dragOverHash.value = ''
}

function onListDragOver(event) {
  if (!draggingHash.value) return
  event.preventDefault()
  // 项目行右侧的会话操作按钮也属于该项目，拖拽经过按钮时仍按项目行计算位置。
  const itemEl = event.target.closest?.('.desktop-project') || event.target.closest?.('.desktop-project-row')?.querySelector('.desktop-project')
  if (!itemEl) {
    // 拖到列表空白处：视为插入到末尾
    const last = displayWorkspaces.value[displayWorkspaces.value.length - 1]
    dragOverHash.value = last ? last.hash : ''
    dragOverBefore.value = false
    return
  }
  const targetHash = itemEl.getAttribute('data-hash')
  if (!targetHash || targetHash === draggingHash.value) {
    // 悬停在自己上方：清除插入指示（保持原位）
    dragOverHash.value = ''
    return
  }
  const rect = itemEl.getBoundingClientRect()
  dragOverBefore.value = event.clientY < rect.top + rect.height / 2
  dragOverHash.value = targetHash
}

function onListDrop() {
  if (!draggingHash.value) return
  // 列表保持静止，松手时一次性计算新顺序
  const next = [...displayWorkspaces.value]
  const fromIndex = next.findIndex((workspace) => workspace.hash === draggingHash.value)
  const dragged = fromIndex !== -1 ? next.splice(fromIndex, 1)[0] : null
  if (dragged) {
    if (dragOverHash.value) {
      let insertAt = next.findIndex((workspace) => workspace.hash === dragOverHash.value)
      if (insertAt === -1) insertAt = next.length
      next.splice(dragOverBefore.value ? insertAt : insertAt + 1, 0, dragged)
    } else {
      // 没有有效插入目标（拖回原位）：恢复原位置
      next.splice(fromIndex, 0, dragged)
    }
  }
  const orderedHashes = next.map((workspace) => workspace.hash)
  clearDragState()
  if (orderedHashes.join('\u0000') !== displayWorkspaces.value.map((workspace) => workspace.hash).join('\u0000')) {
    displayWorkspaces.value = next
    emit('reorder-workspaces', orderedHashes)
  }
}

function onListDragEnd() {
  clearDragState()
}

function clearDragState() {
  draggingHash.value = ''
  dragOverHash.value = ''
}

async function openContextMenu(event, type, item) {
  const nativeSessionMenu = type === 'session' && !popupUsesNativeOverlay.value
    ? window.electronAPI?.desktopSessionMenu?.open
    : null
  if (nativeSessionMenu) {
    closeContextMenu()
    try {
      const action = await nativeSessionMenu({
        theme: props.theme,
        workspaceHash: item?.workspaceHash,
        sessionName: item?.name,
        sessionTitle: item?.title
      })
      const resolvedAction = typeof action === 'string' ? action : action?.action
      if (resolvedAction) handleContextAction(resolvedAction, action?.item || item)
    } catch (error) {
      console.warn('[desktop-home] failed to open native session menu:', error)
    }
    return
  }

  const menuWidth = popupUsesNativeOverlay.value ? 210 : 156
  const menuHeight = popupUsesNativeOverlay.value ? (type === 'session' ? 84 : 190) : (type === 'session' ? 38 : 157)
  contextMenu.type = type
  contextMenu.item = item
  contextMenu.x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8))
  contextMenu.y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
  if (!popupUsesNativeOverlay.value) {
    contextMenu.visible = true
    return
  }
  const opened = await openNativePopup('context-menu', {
    menuType: type,
    item,
    x: contextMenu.x,
    y: contextMenu.y
  })
  contextMenu.visible = opened
}

function closeContextMenu(options = {}) {
  const wasVisible = contextMenu.visible
  contextMenu.visible = false
  contextMenu.type = ''
  contextMenu.item = null
  if (wasVisible && options?.notify !== false && popupUsesNativeOverlay.value) void closeNativePopup()
}

async function toggleExplore() {
  closeContextMenu({notify: false})
  if (popupUsesNativeOverlay.value) {
    if (exploreOpen.value) {
      closeExplore()
      return
    }
    const rect = exploreButton.value?.getBoundingClientRect?.()
    const x = Math.max(8, Math.min(Math.round(rect?.right || 8) + 8, window.innerWidth - 228))
    const y = Math.max(8, Math.min(Math.round(rect?.top || 8) - 8, window.innerHeight - 330))
    const opened = await openNativePopup('explore', {x, y})
    exploreOpen.value = opened
    return
  }
  exploreOpen.value = !exploreOpen.value
}

function toggleSearch() {
  if (searchOpen.value) {
    closeSearch()
    return
  }
  closeContextMenu()
  closeExplore()
  paletteQuery.value = ''
  paletteActiveIndex.value = 0
  searchOpen.value = true
  emit('search-visibility-change', true)
  nextTick(() => searchInput.value?.focus())
}

function closeSearch(options = {}) {
  if (!searchOpen.value) return
  searchOpen.value = false
  paletteQuery.value = ''
  paletteActiveIndex.value = 0
  if (options?.notify !== false) emit('search-visibility-change', false)
}

function paletteItemKey(item) {
  return `${item.kind}:${item.id}`
}

function paletteItemAt(index) {
  return index < searchChatResults.value.length
    ? searchChatResults.value[index]
    : searchActionResults.value[index - searchChatResults.value.length]
}

function selectPaletteItem(item) {
  if (!item) return
  closeSearch()
  if (item.kind === 'session') {
    openSession(item)
    return
  }
  if (item.id === 'new-session') emit('new-session')
  else if (item.id === 'add-workspace') emit('add-workspace')
  else if (item.id === 'open-file-search') emit('open-file-search')
}

function handleSearchKeydown(event) {
  event.stopPropagation()
  const key = event.key.toLowerCase()
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && key === 'n') {
    event.preventDefault()
    selectPaletteItem(paletteActions[0])
    return
  }
  if (modifier && key === 'o') {
    event.preventDefault()
    selectPaletteItem(paletteActions[1])
    return
  }
  if (modifier && key === 'p') {
    event.preventDefault()
    selectPaletteItem(paletteActions[2])
    return
  }
  const resultCount = searchChatResults.value.length + searchActionResults.value.length
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSearch()
  } else if (event.key === 'ArrowDown' && resultCount > 0) {
    event.preventDefault()
    paletteActiveIndex.value = (paletteActiveIndex.value + 1) % resultCount
  } else if (event.key === 'ArrowUp' && resultCount > 0) {
    event.preventDefault()
    paletteActiveIndex.value = (paletteActiveIndex.value - 1 + resultCount) % resultCount
  } else if (event.key === 'Home' && resultCount > 0) {
    event.preventDefault()
    paletteActiveIndex.value = 0
  } else if (event.key === 'End' && resultCount > 0) {
    event.preventDefault()
    paletteActiveIndex.value = resultCount - 1
  } else if (event.key === 'Enter' && resultCount > 0) {
    event.preventDefault()
    selectPaletteItem(paletteItemAt(paletteActiveIndex.value))
  }
}

watch(paletteQuery, () => {
  paletteActiveIndex.value = 0
})

watch([searchChatResults, searchActionResults], ([chats, actions]) => {
  const resultCount = chats.length + actions.length
  if (resultCount === 0) paletteActiveIndex.value = 0
  else if (paletteActiveIndex.value >= resultCount) paletteActiveIndex.value = resultCount - 1
})

async function openNativePopup(type, payload = {}) {
  const popup = window.electronAPI?.desktopPopup
  if (!popup?.open) return false
  try {
    const response = await popup.open(toPlainIpcValue({type, theme: props.theme, ...payload}))
    return response?.success !== false
  } catch (error) {
    console.warn('[desktop-home] failed to open native popup:', error)
    return false
  }
}

function closeNativePopup() {
  return window.electronAPI?.desktopPopup?.close?.()
}

function closeExplore(options = {}) {
  const wasOpen = exploreOpen.value
  exploreOpen.value = false
  if (wasOpen && options?.notify !== false && popupUsesNativeOverlay.value) void closeNativePopup()
}

function runFooterAction(action) {
  closeContextMenu({notify: false})
  closeExplore({notify: false})
  if (action === 'new-session') emit('new-session')
  else emit(action)
}

async function copyWorkspacePath(workspace) {
  const text = String(workspace?.path || '').trim()
  if (!text) {
    message.warning('项目路径为空')
    return
  }
  const ok = await copyToClipboard(text)
  if (ok) message.success('已复制项目路径')
  else message.error('复制失败')
}

function handleContextAction(action, item) {
  if (!item) return
  if (action === 'copy-workspace-path') {
    void copyWorkspacePath(item)
    return
  }
  if (action === 'rename-session') {
    openRenameDialog(item)
    return
  }
  if (action === 'delete-session') emit('delete-session', item)
  else if (action === 'clear-workspace') emit('clear-workspace', item)
  else if (action === 'clear-old-sessions') emit('clear-old-sessions', item)
  else if (action === 'delete-workspace') emit('delete-workspace', item)
}

function handleNativeSessionAction(payload = {}) {
  const action = String(payload?.action || '')
  if (!['rename-session', 'delete-session'].includes(action)) return
  const item = payload?.item || contextMenu.item
  if (item) handleContextAction(action, item)
}

function chooseContextAction(action) {
  const item = contextMenu.item
  closeContextMenu({notify: false})
  handleContextAction(action, item)
}

// ============ 会话重命名 ============
async function openRenameDialog(session) {
  renameDialog.item = session
  renameDialog.value = session?.title || session?.name || ''
  renameDialog.visible = true
  if (popupUsesNativeOverlay.value) {
    const opened = await openNativePopup('rename-session', {
      item: session,
      value: renameDialog.value
    })
    if (!opened) closeRenameDialog({notify: false})
    return
  }
  nextTick(() => renameInput.value?.focus())
}

function closeRenameDialog(options = {}) {
  if (renaming.value) return
  const wasVisible = renameDialog.visible
  renameDialog.visible = false
  renameDialog.item = null
  renameDialog.value = ''
  if (wasVisible && options?.notify !== false && popupUsesNativeOverlay.value) void closeNativePopup()
}

async function confirmRename(valueOverride) {
  const item = renameDialog.item
  const value = String(typeof valueOverride === 'string' ? valueOverride : renameDialog.value).trim()
  renameDialog.value = value
  if (!item || !value || renaming.value) return
  renaming.value = true
  try {
    const response = await sessionsAPI.renameSession(item.name, item.workspaceHash, value)
    if (!response.success) throw new Error(response.message || '重命名失败')
    message.success('会话已重命名')
    renameDialog.visible = false
    renameDialog.item = null
    renameDialog.value = ''
    emit('session-renamed', { workspaceHash: item.workspaceHash, sessionName: item.name, title: value })
    emit('refresh')
    await loadSessions()
  } catch (error) {
    message.error('重命名失败：' + (error.message || '未知错误'))
    if (popupUsesNativeOverlay.value && item) {
      renameDialog.item = item
      renameDialog.value = value
      renameDialog.visible = true
      void openNativePopup('rename-session', {item, value})
    }
  } finally {
    renaming.value = false
  }
}

async function loadSessions() {
  loading.value = true
  try {
    if (props.activeWorkspaceHash && !props.sidebarOnly) {
      const response = await sessionsAPI.list(props.activeWorkspaceHash)
      sessions.value = response.success ? (response.data || []).map((session) => ({ ...session, workspaceHash: props.activeWorkspaceHash })) : []
    } else {
      // 未选中项目时加载所有项目的会话
      const all = []
      await Promise.all(props.workspaces.map(async (ws) => {
        try {
          const response = await sessionsAPI.list(ws.hash)
          if (response.success && response.data) {
            for (const session of response.data) all.push({ ...session, workspaceHash: ws.hash })
          }
        } catch (error) {
          console.error('[desktop-home] failed to load sessions for workspace:', ws.hash, error)
        }
      }))
      sessions.value = all
    }
  } catch (error) {
    console.error('[desktop-home] failed to load sessions:', error)
    sessions.value = []
  } finally {
    loading.value = false
    sessionsLoaded.value = true
  }
}

// 侧边栏模式一次加载所有项目会话，切换项目只改变高亮，不需要重复请求并闪出加载占位。
watch(() => [props.sidebarOnly ? null : props.activeWorkspaceHash, props.refreshKey, props.workspaces], loadSessions, { immediate: true })
// 会话列表刷新后清理失效选中项（如批量删除后），避免残留勾选
watch(sessions, (list) => {
  const valid = new Set((list || []).map((session) => sessionKey(session)))
  const kept = [...selectedSessionKeys.value].filter((key) => valid.has(key))
  if (kept.length !== selectedSessionKeys.value.size) {
    selectedSessionKeys.value = new Set(kept)
  }
  for (const [hash, anchor] of sessionSelectionAnchors) {
    if (!valid.has(anchor)) sessionSelectionAnchors.delete(hash)
  }
})

function handleNativePopupAction(action = {}) {
  if (!popupUsesNativeOverlay.value) return
  if (action.type === 'explore') {
    closeContextMenu({notify: false})
    closeExplore({notify: false})
    runFooterAction(action.action)
    return
  }
  if (action.type === 'context-menu') {
    const item = action.item || contextMenu.item
    closeContextMenu({notify: false})
    handleContextAction(action.action, item)
    return
  }
  if (action.type === 'rename-session') {
    if (action.action === 'confirm') {
      renameDialog.item = action.item || renameDialog.item
      renameDialog.value = action.value || renameDialog.value
      renameDialog.visible = true
      void confirmRename(action.value)
    }
    else closeRenameDialog({notify: false})
  }
}

function onWindowClick() {
  closeContextMenu()
  closeExplore()
}
function onWindowKeydown(event) {
  if (searchOpen.value && event.key === 'Escape') {
    closeSearch()
    return
  }
  if (event.key === 'Escape') {
    closeContextMenu()
    closeExplore()
    if (renameDialog.visible) closeRenameDialog()
  }
}
onMounted(() => {
  window.addEventListener('click', onWindowClick)
  window.addEventListener('keydown', onWindowKeydown)
  stopNativeSearchClosed = window.electronAPI?.events?.listen('desktop-shell-search-closed', () => {
    if (props.sidebarOnly) closeSearch({notify: false})
  })
  stopNativePopupAction = window.electronAPI?.events?.listen('desktop-shell-popup-action', handleNativePopupAction)
  stopNativeSessionAction = window.electronAPI?.events?.listen('desktop-session-context-action', handleNativeSessionAction)
  stopNativePopupClosed = window.electronAPI?.events?.listen('desktop-shell-popup-closed', () => {
    if (!props.sidebarOnly) return
    closeContextMenu({notify: false})
    closeExplore({notify: false})
    closeRenameDialog({notify: false})
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('click', onWindowClick)
  window.removeEventListener('keydown', onWindowKeydown)
  stopNativeSearchClosed?.()
  stopNativeSearchClosed = null
  stopNativePopupAction?.()
  stopNativePopupAction = null
  stopNativeSessionAction?.()
  stopNativeSessionAction = null
  stopNativePopupClosed?.()
  stopNativePopupClosed = null
})
</script>

<style scoped>
.desktop-home { --project-column: 236px; --column-gap: 32px; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding: 20px clamp(16px, 3vw, 56px) 24px; box-sizing: border-box; background: var(--bg, #fbfbfc); }
.desktop-settings-sidebar { display: flex; flex: 1 1 auto; width: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--desktop-sidebar, var(--bg, #fbfbfc)); }
.desktop-sidebar-header { display: flex; align-items: center; flex: 0 0 auto; min-height: 38px; padding: 0 10px 8px; }
.desktop-sidebar-brand { display: inline-flex; align-items: center; gap: 5px; color: var(--fg, #27272a); font-size: 18px; font-weight: 650; letter-spacing: -.35px; }
.desktop-home-nav { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
.desktop-home-nav button { position: relative; width: 100%; min-height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--fg-2, #52525b); font: inherit; font-size: 14px; text-align: left; cursor: pointer; transition: background-color var(--t), color var(--t); }
.desktop-home-nav button:hover, .desktop-home-nav button.active { background: var(--bg-hover, #e7e7e5); color: var(--fg, #27272a); }
.desktop-home-nav button svg { width: 19px; height: 19px; flex: 0 0 auto; }
.desktop-nav-plus { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; margin-left: auto; border: 1px solid currentColor; border-radius: 50%; color: var(--fg-4, #9a9a95); font-size: 15px; font-weight: 400; line-height: 1; }
.desktop-home-search { height: 40px; margin: 0 0 14px; display: flex; align-items: center; gap: 10px; padding: 0 12px; box-sizing: border-box; color: var(--fg-4, #a1a1aa); background: var(--bg-3, #f5f5f6); border: 1px solid transparent; border-radius: 10px; flex: 0 0 auto; transition: background-color var(--t), border-color var(--t), box-shadow var(--t); }
.desktop-home-search:hover { background: var(--bg-hover, #f6f6f7); }
.desktop-home-search:focus-within { border-color: var(--border, #e8e8eb); background: var(--bg-3, #f5f5f6); box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.02); }
.desktop-home-search svg { width: 16px; height: 16px; flex: 0 0 auto; }
.desktop-home-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--fg, #27272a); font: inherit; font-size: 14px; }
.desktop-home-search input::placeholder { color: var(--fg-4, #a1a1aa); }
.desktop-search-mask { position: fixed; inset: 0; z-index: 1600; display: flex; align-items: flex-start; justify-content: center; padding: clamp(92px, 16vh, 156px) 18px 24px; box-sizing: border-box; background: rgba(22, 24, 27, .2); backdrop-filter: blur(1.5px); }
.desktop-search-palette { width: min(650px, calc(100vw - 36px)); max-height: min(650px, calc(100vh - 120px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid color-mix(in srgb, var(--border, #e5e7eb) 86%, transparent); border-radius: 20px; background: var(--bg, #fff); color: var(--fg, #27272a); box-shadow: 0 20px 54px rgba(0, 0, 0, .2), 0 3px 12px rgba(0, 0, 0, .08); }
.desktop-search-input-wrap { min-height: 64px; display: flex; align-items: center; gap: 12px; padding: 0 18px; box-sizing: border-box; border-bottom: 1px solid color-mix(in srgb, var(--border, #e5e7eb) 70%, transparent); color: var(--fg-4, #a1a1aa); }
.desktop-search-input-wrap > svg { width: 18px; height: 18px; flex: 0 0 auto; }
.desktop-search-input-wrap input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--fg, #27272a); font: inherit; font-size: 16px; }
.desktop-search-input-wrap input::placeholder { color: var(--fg-4, #a1a1aa); }
.desktop-search-input-wrap kbd { flex: 0 0 auto; padding: 3px 7px; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; background: var(--bg-3, #f4f4f5); color: var(--fg-4, #a1a1aa); font-family: inherit; font-size: 11px; }
.desktop-search-content { min-height: 0; overflow: auto; padding: 10px 8px 12px; scrollbar-width: thin; }
.desktop-search-section + .desktop-search-section { margin-top: 10px; }
.desktop-search-section-title { padding: 4px 12px 7px; color: var(--fg-4, #a1a1aa); font-size: 13px; font-weight: 500; }
.desktop-search-results { display: grid; gap: 2px; }
.desktop-search-result { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 11px; padding: 0 11px; border: 0; border-radius: 11px; background: transparent; color: var(--fg-2, #52525b); font: inherit; font-size: 14px; text-align: left; cursor: pointer; transition: background-color .12s ease, color .12s ease; }
.desktop-search-result:hover, .desktop-search-result.active { background: var(--bg-hover, #f1f1f2); color: var(--fg, #27272a); }
.desktop-search-result-icon { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; color: var(--fg-3, #71717a); }
.desktop-search-result-icon svg { width: 17px; height: 17px; }
.desktop-search-chat-icon { color: var(--fg-4, #92959c); }
.desktop-search-result-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desktop-search-result-workspace { min-width: 0; max-width: 42%; margin-left: auto; overflow: hidden; color: var(--fg-4, #a1a1aa); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.desktop-search-result kbd { min-width: 42px; margin-left: auto; padding: 3px 7px; border: 1px solid transparent; border-radius: 999px; background: var(--bg-3, #f1f1f2); color: var(--fg-4, #999ca3); font-family: inherit; font-size: 11px; text-align: center; white-space: nowrap; }
.desktop-search-result.active kbd, .desktop-search-result:hover kbd { border-color: color-mix(in srgb, var(--border, #e5e7eb) 85%, transparent); background: var(--bg, #fff); color: var(--fg-3, #71717a); }
.desktop-search-empty { padding: 30px 12px 34px; color: var(--fg-4, #a1a1aa); font-size: 13px; text-align: center; }
.desktop-home-grid { min-height: 0; flex: 1; display: grid; grid-template-columns: var(--project-column) minmax(0, 1fr); gap: var(--column-gap); width: 100%; overflow: hidden; }
.desktop-projects, .desktop-sessions { min-height: 0; display: flex; flex-direction: column; }
.desktop-sidebar-scroll { min-height: 0; display: flex; flex: 1 1 auto; flex-direction: column; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: transparent transparent; }
.desktop-home-heading { min-height: 32px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; color: var(--fg, #27272a); font-size: 14px; font-weight: 600; flex: 0 0 auto; order: 1; }.desktop-home-heading > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desktop-home-heading button { display: inline-flex; align-items: center; gap: 5px; border: 0; background: transparent; color: var(--fg-3, #71717a); font: inherit; font-size: 13px; cursor: pointer; padding: 4px; border-radius: 8px; transition: background-color var(--t), color var(--t); }.desktop-home-heading button:hover { background: var(--bg-hover, #f6f6f7); color: var(--fg, #27272a); }.desktop-home-heading button svg { width: 15px; height: 15px; }
.desktop-heading-actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; white-space: nowrap; }.desktop-project-heading .desktop-heading-actions { opacity: 0; pointer-events: none; transition: opacity var(--t); }.desktop-project-heading:hover .desktop-heading-actions, .desktop-project-heading:focus-within .desktop-heading-actions, .desktop-project-heading.multi-selecting .desktop-heading-actions { opacity: 1; pointer-events: auto; }.desktop-home-heading .desktop-refresh-projects, .desktop-home-heading .desktop-add-project { width: 24px; height: 24px; justify-content: center; padding: 3px; box-sizing: border-box; flex: 0 0 24px; color: var(--fg-3, #727987); }.desktop-home-heading .desktop-refresh-projects:disabled { cursor: wait; opacity: 0.65; }.desktop-home-heading .desktop-refresh-projects :deep(svg) { width: 12px; height: 12px; }.desktop-home-heading .desktop-add-project svg { width: 16px; height: 16px; }.spinning { animation: desktop-spin 0.8s linear infinite; } @keyframes desktop-spin { to { transform: rotate(360deg); } }
    .desktop-project-list, .desktop-session-timeline { min-height: 0; overflow: auto; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: transparent transparent; }.desktop-project-list { display: grid; gap: 2px; flex: 1; align-content: start; order: 3; }.desktop-sessions { order: 2; }.desktop-session-timeline { padding-right: 4px; }.desktop-session-list { display: grid; gap: 2px; }.desktop-session-group + .desktop-session-group { margin-top: 16px; }.desktop-session-group h3 { height: 24px; display: flex; align-items: center; margin: 0 0 8px; color: var(--fg-3, #71717a); font-size: 13px; font-weight: 500; }
.desktop-sidebar-scroll > .desktop-project-list { min-height: auto; flex: 0 0 auto; overflow: visible; scrollbar-gutter: auto; }
.desktop-sidebar-scroll::-webkit-scrollbar, .desktop-project-list::-webkit-scrollbar, .desktop-session-timeline::-webkit-scrollbar { width: 4px; height: 4px; }
.desktop-sidebar-scroll::-webkit-scrollbar-thumb, .desktop-project-list::-webkit-scrollbar-thumb, .desktop-session-timeline::-webkit-scrollbar-thumb { background: transparent; border-radius: 999px; }
.desktop-sidebar-scroll:hover, .desktop-project-list:hover, .desktop-session-timeline:hover { scrollbar-color: var(--fg-4, #9ca3af) transparent; }
.desktop-sidebar-scroll:hover::-webkit-scrollbar-thumb, .desktop-project-list:hover::-webkit-scrollbar-thumb, .desktop-session-timeline:hover::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg-4, #9ca3af) 55%, transparent); border-radius: 6px; }
.desktop-sidebar-scroll::-webkit-scrollbar-track, .desktop-sidebar-scroll::-webkit-scrollbar-track-piece, .desktop-sidebar-scroll::-webkit-scrollbar-corner, .desktop-project-list::-webkit-scrollbar-track, .desktop-project-list::-webkit-scrollbar-track-piece, .desktop-session-timeline::-webkit-scrollbar-track, .desktop-session-timeline::-webkit-scrollbar-track-piece, .desktop-project-list::-webkit-scrollbar-corner, .desktop-session-timeline::-webkit-scrollbar-corner { background: transparent; border: 0; }
    .desktop-project-row { width: 100%; min-width: 0; min-height: 38px; display: flex; align-items: center; gap: 2px; box-sizing: border-box; border-radius: 8px; background: transparent; transition: background-color var(--t), color var(--t); }
    .desktop-project-group { width: 100%; min-width: 0; }
    .desktop-project-row > .desktop-project { width: auto; min-width: 0; flex: 1 1 auto; }
    .desktop-project-session-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; opacity: 0; pointer-events: none; transition: opacity var(--t); }
    .desktop-project-row:hover .desktop-project-session-actions, .desktop-project-row:focus-within .desktop-project-session-actions, .desktop-project-row.session-multi-selecting .desktop-project-session-actions { opacity: 1; pointer-events: auto; }
    .desktop-project-row:hover { background: var(--desktop-hover, var(--bg-hover, #e7e7e5)); color: var(--fg, #27272a); }
    .desktop-project-row.active, .desktop-project-row.selected { background: var(--desktop-hover, var(--bg-active, #e7e7e5)); color: var(--fg, #27272a); }
    .desktop-project-row:hover > .desktop-project, .desktop-project-row.active > .desktop-project, .desktop-project-row.selected > .desktop-project { background: transparent; color: var(--fg, #27272a); }
    .desktop-project-session-actions .desktop-multi-toggle { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 3px; box-sizing: border-box; border: 0; border-radius: 8px; background: transparent; color: var(--fg-3, #71717a); cursor: pointer; }
    .desktop-project-session-actions .desktop-multi-toggle:hover, .desktop-project-session-actions .desktop-multi-toggle.active { background: transparent; color: var(--fg, #27272a); }
    .desktop-project-session-actions .desktop-multi-toggle svg { width: 15px; height: 15px; }
    .desktop-project-children {
      display: grid;
      grid-template-rows: 1fr;
      min-height: 0;
      overflow: hidden;
      padding-top: 4px;
    }
    .desktop-project-children-inner { min-height: 0; display: grid; gap: 3px; overflow: hidden; }
    .desktop-project-collapse-enter-active,
    .desktop-project-collapse-leave-active {
      display: grid;
      grid-template-rows: 1fr;
      min-height: 0;
      overflow: hidden;
      opacity: 1;
      transition: grid-template-rows .24s ease, opacity .18s ease;
    }
    .desktop-project-collapse-enter-from,
    .desktop-project-collapse-leave-to {
      grid-template-rows: 0fr;
      opacity: 0;
    }
    .desktop-project { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 8px; background: transparent; color: var(--fg-2, #52525b); font: inherit; font-size: 13px; text-align: left; cursor: pointer; padding: 0 10px; box-sizing: border-box; transition: background-color var(--t), color var(--t); }
    .desktop-project:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #52525b) 45%, transparent); outline-offset: -2px; }
    .desktop-session { width: 100%; min-height: 40px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 8px; background: transparent; color: var(--fg-2, #52525b); font: inherit; font-size: 13px; text-align: left; cursor: pointer; padding: 4px 10px; box-sizing: border-box; transition: background-color var(--t), color var(--t); }
    .desktop-project:hover, .desktop-session:hover { background: var(--bg-hover, #f6f6f7); color: var(--fg, #27272a); }.desktop-project.active, .desktop-project.selected, .desktop-session.selected, .desktop-session.active { background: var(--bg-active, #f1f1f3); color: var(--fg, #27272a); }.desktop-project > span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; flex: 1; }.desktop-session-name { --desktop-session-fade-width: clamp(12px, 18%, 36px); position: relative; height: 20px; overflow: hidden; white-space: nowrap; text-overflow: clip; min-width: 0; flex: 1; -webkit-mask-image: linear-gradient(to right, #000 0, #000 calc(100% - var(--desktop-session-fade-width)), transparent 100%); mask-image: linear-gradient(to right, #000 0, #000 calc(100% - var(--desktop-session-fade-width)), transparent 100%); }.desktop-session-name-text { position: absolute; top: 0; left: 0; display: block; width: max-content; white-space: nowrap; line-height: 20px; transform: translateX(0); transition: transform .25s ease-out; will-change: transform; }.desktop-session-time { flex: 0 0 auto; margin-left: auto; color: var(--fg-4, #a1a1aa); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; visibility: hidden; opacity: 0; transition: opacity .12s ease, visibility .12s ease; }.desktop-session:hover .desktop-session-time, .desktop-session:focus-visible .desktop-session-time { visibility: visible; opacity: 1; }.desktop-project-check, .desktop-session-check { width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; border: 1px solid var(--fg-4, #a1a1aa); border-radius: 4px; color: #fff; opacity: 0; transition: opacity .12s ease, background-color .12s ease, border-color .12s ease; }.desktop-project:hover .desktop-project-check, .desktop-project.selected .desktop-project-check, .desktop-session:hover .desktop-session-check, .desktop-session.selected .desktop-session-check { opacity: 1; }.desktop-project-check.checked, .desktop-session-check.checked { background: var(--accent, #52525b); border-color: var(--accent, #52525b); opacity: 1; }.desktop-session { font-weight: 400; }.desktop-home-muted { padding: 12px 8px; color: var(--fg-4, #a1a1aa); font-size: 12px; }
.desktop-project.dragging { opacity: 0.55; }.desktop-project.drag-over-before, .desktop-project.drag-over-after { background: var(--accent-bg, var(--bg-3, #f2f3f5)); }.desktop-project.drag-over-before { box-shadow: inset 0 2px 0 0 var(--blue, #52525b); }.desktop-project.drag-over-after { box-shadow: inset 0 -2px 0 0 var(--blue, #52525b); }
.desktop-monogram { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; border-radius: 5px; color: #fff; font-size: 11px; font-weight: 600; line-height: 1; text-shadow: none; box-shadow: none; }.desktop-monogram.tone-0 { background: linear-gradient(135deg, #8b95a3, #5e6878); }.desktop-monogram.tone-1 { background: linear-gradient(135deg, #3dd0e8, #18b4d0); }.desktop-monogram.tone-2 { background: linear-gradient(135deg, #ffa86b, #ff7a3d); }.desktop-monogram.tone-3 { background: linear-gradient(135deg, #9aacf5, #6d80e8); }.desktop-monogram.tone-4 { background: linear-gradient(135deg, #6dd49d, #3eb878); }.desktop-monogram.tone-5 { background: linear-gradient(135deg, #f87fb5, #e85a9c); }.desktop-monogram.tone-6 { background: linear-gradient(135deg, #fcd34d, #f5b800); }.desktop-monogram.tone-7 { background: linear-gradient(135deg, #4dd9a6, #20c084); }.desktop-session-monogram { background: linear-gradient(135deg, #737373, #4c4c4c); }
.desktop-project-footer { position: relative; display: contents; }
.desktop-project-footer-menu { display: grid; gap: 2px; width: 100%; order: 0; }
.desktop-project-footer-menu > button { width: 100%; }
.desktop-project-footer-settings { display: contents; }
.desktop-project-footer-settings > button:first-child { width: 100%; min-width: 0; flex: 0 0 auto; order: 4; margin-top: 6px; border-top: 1px solid var(--border, #e8e8e8); border-radius: 0; }
.desktop-sidebar-settings { display: block; flex: 0 0 auto; padding-top: 6px; border-top: 1px solid var(--border, #e8e8e8); }
.desktop-sidebar-settings .desktop-project-footer-settings { display: block; }
.desktop-sidebar-settings .desktop-project-footer-settings > button:first-child { margin-top: 0; border-top: 0; border-radius: 8px; }
.desktop-project-footer-more { position: relative; width: 100%; flex: 0 0 auto; order: 0; }
.desktop-project-footer button { height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--fg-3, #71717a); font: inherit; font-size: 13px; cursor: pointer; transition: background-color var(--t), color var(--t); }
.desktop-project-footer button:hover, .desktop-project-footer button.active { background: var(--bg-hover, #f6f6f7); color: var(--fg, #27272a); }
.desktop-project-footer svg { width: 16px; height: 16px; flex: 0 0 auto; }
.desktop-more-button { width: 100%; }
.desktop-footer-more-menu { position: absolute; left: calc(100% + 8px); top: -8px; right: auto; bottom: auto; z-index: 500; width: 220px; padding: 8px; border: 1px solid var(--border, #e5e7eb); border-radius: 16px; background: var(--bg, #fff); box-shadow: 0 12px 28px rgba(0, 0, 0, 0.14); }
.desktop-footer-more-item { width: 100%; justify-content: flex-start; }
.desktop-footer-more-item:hover { background: var(--bg-3, #f2f3f5); }
.desktop-explore-divider { height: 1px; margin: 7px 4px; background: var(--border, #e5e7eb); }
.desktop-explore-item { width: 100%; justify-content: flex-start; min-height: 34px; }
.desktop-footer-more-menu :deep(.service-manager) { width: 100%; }
.desktop-footer-more-menu :deep(.tb-service-btn) { width: 100%; height: 32px; justify-content: flex-start; gap: 8px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: var(--fg-3, #727987); font: inherit; font-size: 13px; cursor: pointer; }
.desktop-footer-more-menu :deep(.tb-service-btn:hover), .desktop-footer-more-menu :deep(.tb-service-btn.active) { background: var(--bg-3, #f2f3f5); color: var(--fg, #202124); }
.desktop-footer-more-menu :deep(.tb-service-btn > svg) { width: 16px; height: 16px; }
.desktop-heading-actions .desktop-delete-selected, .desktop-project-session-actions .desktop-delete-selected { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 2px 8px; border-radius: 5px; background: rgba(220, 38, 38, 0.09); color: #c2413b; font-size: 12px; font-weight: 600; }.desktop-heading-actions .desktop-delete-selected:hover, .desktop-project-session-actions .desktop-delete-selected:hover { background: rgba(220, 38, 38, 0.15); color: #b42318; }.desktop-delete-selected svg { width: 12px; height: 12px; }.desktop-heading-actions .desktop-clear-selection { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 3px; border-radius: 5px; color: var(--fg-3, #727987); }.desktop-heading-actions .desktop-clear-selection:hover { background: var(--bg-3, #f2f3f5); color: var(--fg, #202124); }.desktop-clear-selection svg { width: 13px; height: 13px; }
.desktop-heading-title { display: flex; align-items: center; gap: 6px; min-width: 0; }.desktop-heading-title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desktop-home-heading .desktop-multi-toggle { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 3px; box-sizing: border-box; flex: 0 0 24px; color: var(--fg-3, #727987); }.desktop-home-heading .desktop-multi-toggle:hover { background: var(--bg-3, #f2f3f5); color: var(--fg, #202124); }.desktop-home-heading .desktop-multi-toggle.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }.desktop-multi-toggle svg { width: 15px; height: 15px; }
.desktop-heading-actions .desktop-select-all, .desktop-project-session-actions .desktop-select-all { display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 2px 8px; border-radius: 5px; background: var(--bg-3, #f2f3f5); color: var(--fg-2, #525866); font-size: 12px; font-weight: 600; }.desktop-heading-actions .desktop-select-all:hover, .desktop-project-session-actions .desktop-select-all:hover { background: var(--bg-4, #e8e9eb); color: var(--fg, #202124); }
.desktop-sidebar-header { position: relative; }
.desktop-sidebar-header-actions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.desktop-sidebar-header-button { position: relative; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--fg-3, #71717a); cursor: pointer; transition: background-color var(--t), color var(--t); }
.desktop-sidebar-header-button:hover, .desktop-sidebar-header-button[aria-expanded="true"] { background: var(--bg-hover, #e7e7e5); color: var(--fg, #27272a); }
.desktop-sidebar-header-button svg { width: 18px; height: 18px; }
.desktop-context-menu { position: fixed; z-index: 1000; width: 156px; padding: 4px; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; background: var(--bg, #fff); box-shadow: var(--shadow-lg, 0 10px 28px rgba(0, 0, 0, 0.16)); }.desktop-context-menu button { width: 100%; height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 4px; background: transparent; color: var(--fg-2, #525866); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }.desktop-context-menu button:hover { color: var(--fg, #202124); background: var(--bg-3, #f2f3f5); }.desktop-context-menu button.danger { color: #c2413b; }.desktop-context-menu button.danger:hover { color: #b42318; background: rgba(220, 38, 38, 0.09); }.desktop-context-menu svg { width: 15px; height: 15px; }.desktop-context-menu-divider { height: 1px; margin: 4px; background: var(--border, #e5e7eb); }
.desktop-rename-mask { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; background: rgba(15, 17, 20, 0.4); }
.desktop-rename-dialog { width: 320px; padding: 18px; border-radius: 10px; background: var(--bg, #fff); box-shadow: var(--shadow-lg, 0 10px 28px rgba(0, 0, 0, 0.16)); box-sizing: border-box; }
.desktop-rename-dialog h3 { margin: 0 0 12px; font-size: 14px; font-weight: 650; color: var(--fg, #202124); }
.desktop-rename-dialog input { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; outline: none; background: var(--bg-2, #fafafa); color: var(--fg, #202124); font: inherit; font-size: 13px; box-sizing: border-box; }
.desktop-rename-dialog input:focus { border-color: var(--accent, #4f7cff); }
.desktop-rename-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.desktop-rename-actions button { height: 30px; padding: 0 14px; border: 0; border-radius: 6px; font: inherit; font-size: 13px; cursor: pointer; }
.desktop-rename-cancel { background: var(--bg-3, #f2f3f5); color: var(--fg-2, #525866); }.desktop-rename-cancel:hover { background: var(--bg-4, #e8e9eb); }
.desktop-rename-confirm { background: var(--accent-btn, var(--accent)); color: #fff; }.desktop-rename-confirm:hover { filter: brightness(1.05); }.desktop-rename-confirm:disabled { opacity: 0.55; cursor: not-allowed; }
@media (max-width: 1000px) { .desktop-home { --project-column: 220px; --column-gap: 24px; padding-inline: 24px; } }
@media (max-width: 720px) { .desktop-home { --project-column: 1fr; --column-gap: 24px; padding: 18px 18px 22px; overflow: auto; }.desktop-home-search { margin-bottom: 16px; }.desktop-home-grid { flex: initial; grid-template-columns: 1fr; overflow: visible; }.desktop-project-list, .desktop-session-timeline { overflow: visible; } }
</style>
