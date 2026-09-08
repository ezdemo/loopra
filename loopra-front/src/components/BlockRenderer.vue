<template>
  <template v-if="processedBlocks.length > 0" v-for="(block, bi) in processedBlocks" :key="getBlockKey(block, bi)">
    <!-- 思考 -->
    <div v-if="block.type === 'reasoning'" class="block-reasoning">
      <div class="reasoning-head" @click="block.showContent = !block.showContent">
        <span class="default-icon" v-html="THINKING_ICON"></span>
        <span>思考</span>
        <span class="default-icon"
              v-html="CHEVRON_DOWN_ICON"
              :style="{
                  transform: block.showContent ? 'rotate(180deg)' : 'rotate(0deg)',
                  display: 'inline-block',
                  transition: 'transform 0.25s ease',
                  lineHeight: 0
                }">
        </span>
      </div>
      <CollapseTransition>
        <div v-if="block.showContent" class="reasoning-text" v-html="getReasoningHtml(block)" @click="onCodeBlockClick"></div>
      </CollapseTransition>
    </div>

    <!-- 加密推理沿用普通思考折叠样式，展开后只显示固定文案 -->
    <div v-else-if="block.type === 'reasoning_started'" class="block-reasoning">
      <div class="reasoning-head" @click="block.showContent = !block.showContent">
        <span class="default-icon" v-html="THINKING_ICON"></span>
        <span>思考</span>
        <span class="default-icon"
              v-html="CHEVRON_DOWN_ICON"
              :style="{
                transform: block.showContent ? 'rotate(180deg)' : 'rotate(0deg)',
                display: 'inline-block',
                transition: 'transform 0.25s ease',
                lineHeight: 0
              }">
        </span>
      </div>
      <CollapseTransition>
        <div v-if="block.showContent" class="reasoning-text" role="status">加密思考</div>
      </CollapseTransition>
    </div>

    <!-- 内容 -->
    <div v-else-if="block.type === 'content' && block.content" class="block-content" v-html="fmt(block.content)" @click="onCodeBlockClick"></div>
 <!-- 用户消息气泡（子代理会话标签页中的继续对话输入） -->
 <div v-else-if="block.type === 'sub_user' && block.content" class="block-sub-user">
   <span class="sub-user-label">我</span>
   <div class="sub-user-content">{{ block.content }}</div>
 </div>

    <!-- 本轮 AI 实际写入的文件（仅在回复结束后追加） -->
    <div v-else-if="block.type === 'file_changes' && block.changes?.length" class="block-file-changes">
      <div class="file-changes-head" :class="{ clickable: block.changes.length === 1 }"
           :role="block.changes.length === 1 ? 'button' : undefined"
           :tabindex="block.changes.length === 1 ? 0 : undefined"
           @click="block.changes.length === 1 && $emit('openDiff', block.changes[0])"
           @keydown.enter="block.changes.length === 1 && $emit('openDiff', block.changes[0])"
           @keydown.space.prevent="block.changes.length === 1 && $emit('openDiff', block.changes[0])">
        <span class="file-changes-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M12 7v6M9 10h6M9 16h6"/>
          </svg>
        </span>
        <span class="file-changes-summary">
          <strong class="file-changes-title">{{ getFileChangeTitle(block) }}</strong>
          <span class="file-changes-total">
            <b v-if="getFileChangeTotals(block).additions" class="file-change-add">+{{ getFileChangeTotals(block).additions }}</b>
            <b v-if="getFileChangeTotals(block).deletions" class="file-change-del">-{{ getFileChangeTotals(block).deletions }}</b>
          </span>
        </span>
        <button type="button" class="file-changes-undo" @click.stop="$emit('revertFileChanges', block.changes)">
          撤销
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 14 4 9l5-5"/><path d="M4 9h7a5 5 0 0 1 0 10h-1"/>
          </svg>
        </button>
      </div>
      <template v-if="block.changes.length > 1">
      <button v-for="change in getVisibleFileChanges(block)" :key="change.path" type="button" class="file-change-row"
              :title="change.path" @click="$emit('openDiff', change)">
        <span class="file-change-path">{{ change.path }}</span>
        <span class="file-change-stats">
          <b v-if="change.additions" class="file-change-add">+{{ change.additions }}</b>
          <b v-if="change.deletions" class="file-change-del">-{{ change.deletions }}</b>
        </span>
      </button>
      </template>
      <button v-if="block.changes.length > FILE_CHANGE_COLLAPSE_LIMIT" type="button" class="file-changes-expand"
              @click="block.showAll = !block.showAll">
        {{ block.showAll ? '收起文件' : `再显示 ${block.changes.length - FILE_CHANGE_COLLAPSE_LIMIT} 个文件` }}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             :style="{ transform: block.showAll ? 'rotate(180deg)' : 'rotate(0deg)' }">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
    </div>

    <!-- 工具调用分组（连续多个工具合并，样式与普通工具栏一致） -->
    <div v-else-if="block.type === 'tool_group'" class="block-tool">
      <div class="tool-head" @click="toggleToolGroup(block._groupId)">
        <span class="tool-icon default-icon" :class="block._groupRunning ? '执行中' : '成功'">
          <span v-if="block._groupRunning" v-html="SPINNER_ICON"></span>
          <span v-else-if="block._groupAllDone" v-html="CHECK_ICON_SM"></span>
          <span v-else v-html="CIRCLE_ICON"></span>
        </span>
        <code class="tool-name">{{ block._tools.length }} 个工具</code>
        <span class="tool-status" :class="block._groupRunning ? '执行中' : '成功'">{{ block._groupRunning ? '执行中' : '成功' }}</span>
        <span class="tool-param" :title="getToolGroupOrder(block)">{{ getToolGroupOrderTruncated(block) }}</span>
        <span class="default-icon"
              v-html="CHEVRON_DOWN_ICON"
              :style="{
                transform: toolGroupsExpanded[block._groupId] ? 'rotate(180deg)' : 'rotate(0deg)',
                display: 'inline-block',
                transition: 'transform 0.25s ease',
                lineHeight: 0
              }">
        </span>
      </div>
      <CollapseTransition>
      <div v-if="toolGroupsExpanded[block._groupId]" class="tool-group-detail">
        <div v-for="(t, ti) in block._tools" :key="ti" class="tool-group-item-block">
          <div class="block-tool">
            <div class="tool-head" @click="t.expanded = !t.expanded">
              <span class="tool-icon default-icon" :class="t.status">
                <span v-if="t.status === '执行中'" v-html="SPINNER_ICON"></span>
                <span v-else-if="t.status === '成功'" v-html="CHECK_ICON_SM"></span>
                <span v-else v-html="CIRCLE_ICON"></span>
              </span>
              <code class="tool-name">{{ t.name }}</code>
              <span class="tool-status" :class="t.status">{{ t.status }}</span>
              <span v-if="t.name === 'bash' && getBashCommand(t)" class="tool-param"
                    :title="getBashCommandFull(t)">{{ getBashCommand(t) }}</span>
              <span v-else-if="t.name === 'grep' && getGrepPath(t)" class="tool-param"
                    :title="getGrepPathFull(t)">{{ getGrepPath(t) }}</span>
              <span v-else-if="t.name === 'glob' && getGlobPath(t)" class="tool-param"
                    :title="getGlobPathFull(t)">{{ getGlobPath(t) }}</span>
              <span v-else-if="t.name === 'ls' && getLsPath(t)" class="tool-param"
                    :title="getLsPath(t)">{{ getLsPath(t) }}</span>
              <button v-else-if="shouldShowOpenFile(t)" class="tool-file" @click.stop="openFile(t)"
                      :title="getFilePath(t)">{{ getFileName(t) }}
              </button>
              <span v-else-if="t.name === 'ask_choice' && getChoiceQuestion(t)" class="tool-param tool-param-wide"
                    :title="getChoiceQuestion(t)">{{ getChoiceQuestion(t) }}</span>
              <span v-if="formatToolDuration(t)" class="tool-duration">{{ formatToolDuration(t) }}</span>
              <span class="default-icon" v-html="CHEVRON_DOWN_ICON"
                    :style="{
                      transform: t.expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      display: 'inline-block',
                      transition: 'transform 0.25s ease',
                      lineHeight: 0
                    }">
              </span>
            </div>
            <CollapseTransition>
              <div v-if="t.expanded" class="tool-detail">
                <pre v-if="t.args"><code>{{ fmtArgs(t.args) }}</code></pre>
                <pre v-if="t.result"><code>{{ t.result }}</code></pre>
              </div>
            </CollapseTransition>
          </div>
        </div>
      </div>
      </CollapseTransition>
    </div>

    <!-- 路径组（连续 reasoning + tool_call 折叠） -->
    <div v-else-if="block.type === 'path_group'" class="block-tool">
      <div class="tool-head" @click="togglePathGroup(block._groupId)">
        <span class="tool-icon default-icon" :class="block._running ? '执行中' : '成功'">
          <span v-if="block._running" v-html="SPINNER_ICON"></span>
          <span v-else-if="block._allDone" v-html="CHECK_ICON_SM"></span>
          <span v-else v-html="CIRCLE_ICON"></span>
        </span>
        <span class="path-steps" :title="block._pathNames">{{ getPathGroupLabel(block) }}</span>
        <span class="default-icon"
              v-html="CHEVRON_DOWN_ICON"
              :style="{
                transform: pathGroupsExpanded[block._groupId] ? 'rotate(180deg)' : 'rotate(0deg)',
                display: 'inline-block',
                transition: 'transform 0.25s ease',
                lineHeight: 0
              }">
        </span>
      </div>
      <CollapseTransition>
      <div v-if="pathGroupsExpanded[block._groupId]" class="tool-group-detail">
        <template v-for="(ib, ibi) in block._blocks" :key="ibi">
          <!-- 内层思考 -->
          <div v-if="ib.type === 'reasoning'" class="tool-group-item-block">
            <div class="block-reasoning">
              <div class="reasoning-head" @click="togglePathItem(block._groupId, ibi)">
                <span class="default-icon" v-html="THINKING_ICON"></span>
                <span>思考</span>
                <span class="default-icon"
                      v-html="CHEVRON_DOWN_ICON"
                      :style="{
                        transform: pathItemExpanded[getPathItemKey(block._groupId, ibi)] ? 'rotate(180deg)' : 'rotate(0deg)',
                        display: 'inline-block',
                        transition: 'transform 0.25s ease',
                        lineHeight: 0
                      }">
                </span>
              </div>
              <CollapseTransition>
                <div v-if="pathItemExpanded[getPathItemKey(block._groupId, ibi)]" class="reasoning-text" v-html="fmt(ib.content)"></div>
              </CollapseTransition>
            </div>
          </div>
          <!-- 内层加密思考 -->
          <div v-else-if="ib.type === 'reasoning_started'" class="tool-group-item-block">
            <div class="block-reasoning">
              <div class="reasoning-head" @click="togglePathItem(block._groupId, ibi)">
                <span class="default-icon" v-html="THINKING_ICON"></span>
                <span>思考</span>
                <span class="default-icon"
                      v-html="CHEVRON_DOWN_ICON"
                      :style="{
                        transform: pathItemExpanded[getPathItemKey(block._groupId, ibi)] ? 'rotate(180deg)' : 'rotate(0deg)',
                        display: 'inline-block',
                        transition: 'transform 0.25s ease',
                        lineHeight: 0
                      }">
                </span>
              </div>
              <CollapseTransition>
                <div v-if="pathItemExpanded[getPathItemKey(block._groupId, ibi)]" class="reasoning-text" role="status">加密思考</div>
              </CollapseTransition>
            </div>
          </div>
          <!-- 内层工具 -->
          <div v-else-if="ib.type === 'tool_call'" class="tool-group-item-block">
            <div class="block-tool">
              <div class="tool-head" @click="togglePathItem(block._groupId, ibi)">
                <span class="tool-icon default-icon" :class="ib.status">
                  <span v-if="ib.status === '执行中'" v-html="SPINNER_ICON"></span>
                  <span v-else-if="ib.status === '成功'" v-html="CHECK_ICON_SM"></span>
                  <span v-else v-html="CIRCLE_ICON"></span>
                </span>
                <code class="tool-name">{{ ib.name }}</code>
                <span class="tool-status" :class="ib.status">{{ ib.status }}</span>
                <span v-if="ib.name === 'bash' && getBashCommand(ib)" class="tool-param"
                      :title="getBashCommandFull(ib)">{{ getBashCommand(ib) }}</span>
                <span v-else-if="ib.name === 'grep' && getGrepPath(ib)" class="tool-param"
                      :title="getGrepPathFull(ib)">{{ getGrepPath(ib) }}</span>
                <span v-else-if="ib.name === 'glob' && getGlobPath(ib)" class="tool-param"
                      :title="getGlobPathFull(ib)">{{ getGlobPath(ib) }}</span>
                <span v-else-if="ib.name === 'ls' && getLsPath(ib)" class="tool-param"
                      :title="getLsPath(ib)">{{ getLsPath(ib) }}</span>
                <button v-else-if="shouldShowOpenFile(ib)" class="tool-file" @click.stop="openFile(ib)"
                        :title="getFilePath(ib)">{{ getFileName(ib) }}
                </button>
                <span v-else-if="ib.name === 'ask_choice' && getChoiceQuestion(ib)" class="tool-param tool-param-wide"
                      :title="getChoiceQuestion(ib)">{{ getChoiceQuestion(ib) }}</span>
                <span v-if="formatToolDuration(ib)" class="tool-duration">{{ formatToolDuration(ib) }}</span>
                <span class="default-icon"
                      v-html="CHEVRON_DOWN_ICON"
                      :style="{
                        transform: pathItemExpanded[getPathItemKey(block._groupId, ibi)] ? 'rotate(180deg)' : 'rotate(0deg)',
                        display: 'inline-block',
                        transition: 'transform 0.25s ease',
                        lineHeight: 0
                      }">
                </span>
              </div>
              <CollapseTransition>
                <div v-if="pathItemExpanded[getPathItemKey(block._groupId, ibi)]" class="tool-detail">
                  <!-- 清单工具：用 ChecklistSteps 渲染 -->
                  <div v-if="isChecklistTool(ib)" class="checklist-tool-detail">
                    <ChecklistSteps :data="getChecklistData(ib)" />
                  </div>
                  <!-- 其他工具：正常显示 -->
                  <template v-else>
                    <pre v-if="ib.args"><code>{{ fmtArgs(ib.args) }}</code></pre>
                    <pre v-if="ib.result"><code>{{ ib.result }}</code></pre>
                  </template>
                </div>
              </CollapseTransition>
            </div>
          </div>
        </template>
      </div>
      </CollapseTransition>
    </div>

    <!-- 单个工具调用（非连续时不合并） -->
    <template v-else-if="block.type === 'tool_call'">
      <!-- finish 工具：完成时将 content 渲染为模型输出样式 -->
      <div v-if="block.name === 'finish' && block.result" class="block-tool block-finish">
        <div class="tool-head">
          <span class="tool-icon default-icon 成功" v-html="CHECK_ICON_SM"></span>
          <code class="tool-name" >最终回答</code>
        </div>
        <div class="tool-detail finish-content" v-html="fmt(block.result)" @click="onCodeBlockClick"></div>
      </div>
      <!-- finish 执行中 -->
      <div v-else-if="block.name === 'finish' && block.status" class="block-tool">
        <div class="tool-head">
          <span class="tool-icon default-icon" :class="block.status" v-html="SPINNER_ICON"></span>
          <code class="tool-name">finish</code>
          <span class="tool-status" :class="block.status">{{ block.status }}</span>
        </div>
      </div>
      <!-- 清单工具 -->
      <div v-else-if="isChecklistTool(block) && block.result" class="block-checklist">
        <div class="checklist-tool-head" @click="block.expanded = !block.expanded">
          <span class="tool-icon default-icon" :class="block.status">
            <span v-if="block.status === '执行中'" v-html="SPINNER_ICON"></span>
            <span v-else-if="block.status === '成功'" v-html="CHECK_ICON_SM"></span>
            <span v-else v-html="CIRCLE_ICON"></span>
          </span>
          <code class="tool-name">{{ block.name }}</code>
          <span class="tool-status" :class="block.status">{{ block.status }}</span>
          <span class="checklist-tool-title">{{ getChecklistTitle(block) }}</span>
          <span class="default-icon"
                v-html="CHEVRON_DOWN_ICON"
                :style="{
                  transform: block.expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  display: 'inline-block',
                  transition: 'transform 0.25s ease',
                  lineHeight: 0
                }">
          </span>
        </div>
        <CollapseTransition>
          <div v-if="block.expanded" class="checklist-tool-detail">
            <ChecklistSteps :data="getChecklistData(block)" />
          </div>
        </CollapseTransition>
      </div>
      <!-- 清单工具执行中 -->
      <div v-else-if="isChecklistTool(block) && block.status" class="block-tool">
        <div class="tool-head">
          <span class="tool-icon default-icon" :class="block.status" v-html="SPINNER_ICON"></span>
          <code class="tool-name">{{ block.name }}</code>
          <span class="tool-status" :class="block.status">{{ block.status }}</span>
        </div>
      </div>
      <!-- Goal 工具 -->
      <div v-else-if="isGoalTool(block) && block.result" class="block-tool block-goal">
        <div class="tool-head" @click="block.expanded = !block.expanded">
          <span class="tool-icon default-icon" :class="block.status">
            <span v-if="block.status === '执行中'" v-html="SPINNER_ICON"></span>
            <span v-else-if="block.status === '成功'" v-html="CHECK_ICON_SM"></span>
            <span v-else v-html="CIRCLE_ICON"></span>
          </span>
          <code class="tool-name">{{ block.name }}</code>
          <span class="tool-status" :class="block.status">{{ block.status }}</span>
          <span class="tool-param">{{ getGoalTitle(block) }}</span>
          <span class="default-icon"
                v-html="CHEVRON_DOWN_ICON"
                :style="{
                  transform: block.expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  display: 'inline-block',
                  transition: 'transform 0.25s ease',
                  lineHeight: 0
                }">
          </span>
        </div>
        <CollapseTransition>
          <div v-if="block.expanded" class="tool-detail goal-detail">
            <pre><code>{{ block.result }}</code></pre>
          </div>
        </CollapseTransition>
      </div>
      <!-- Goal 工具执行中 -->
      <div v-else-if="isGoalTool(block) && block.status" class="block-tool">
        <div class="tool-head">
          <span class="tool-icon default-icon" :class="block.status" v-html="SPINNER_ICON"></span>
          <code class="tool-name">{{ block.name }}</code>
          <span class="tool-status" :class="block.status">{{ block.status }}</span>
        </div>
      </div>
      <!-- 其他工具 -->
      <div v-else class="block-tool">
        <div class="tool-head" @click="block.expanded = !block.expanded">
          <span class="tool-icon default-icon" :class="block.status">
            <span v-if="block.status === '执行中'" v-html="SPINNER_ICON"></span>
            <span v-else-if="block.status === '成功'" v-html="CHECK_ICON_SM"></span>
            <span v-else v-html="CIRCLE_ICON"></span>
          </span>
          <code class="tool-name">{{ block.name }}</code>
          <span class="tool-status" :class="block.status">{{ block.status }}</span>
          <span v-if="block.name === 'bash' && getBashCommand(block)" class="tool-param"
                :title="getBashCommandFull(block)">{{ getBashCommand(block) }}</span>
          <span v-else-if="block.name === 'grep' && getGrepPath(block)" class="tool-param"
                :title="getGrepPathFull(block)">{{ getGrepPath(block) }}</span>
          <span v-else-if="block.name === 'glob' && getGlobPath(block)" class="tool-param"
                :title="getGlobPathFull(block)">{{ getGlobPath(block) }}</span>
          <span v-else-if="block.name === 'ls' && getLsPath(block)" class="tool-param"
                :title="getLsPath(block)">{{ getLsPath(block) }}</span>
          <button v-else-if="shouldShowOpenFile(block)" class="tool-file" @click.stop="openFile(block)"
                  :title="getFilePath(block)">{{ getFileName(block) }}
          </button>
          <span v-else-if="block.name === 'ask_choice' && getChoiceQuestion(block)" class="tool-param tool-param-wide"
                :title="getChoiceQuestion(block)">{{ getChoiceQuestion(block) }}</span>
          <span v-if="formatToolDuration(block)" class="tool-duration">{{ formatToolDuration(block) }}</span>
          <span class="default-icon"
                v-html="CHEVRON_DOWN_ICON"
                :style="{
                  transform: block.showContent ? 'rotate(180deg)' : 'rotate(0deg)',
                  display: 'inline-block',
                  transition: 'transform 0.25s ease',
                  lineHeight: 0
                }">
        </span>
        </div>
        <CollapseTransition>
          <div v-if="block.expanded" class="tool-detail">
            <pre v-if="block.args"><code>{{ fmtArgs(block.args) }}</code></pre>
            <pre v-if="block.result"><code>{{ block.result }}</code></pre>
          </div>
        </CollapseTransition>
      </div>
    </template>

    <!-- 子代理块（工具调用风格折叠块） -->
    <div v-else-if="block.type === 'sub_agent'" class="block-tool">
      <div class="tool-head" @click="toggleSubAgent(block)">
        <span class="tool-icon default-icon 成功">
          <span v-html="CHECK_ICON_SM"></span>
        </span>
        <code class="tool-name">子代理</code>
        <span class="tool-status 成功">{{ block.status }}</span>
        <span class="tool-param">{{ block.blocks?.length || 0 }} 步</span>
        <span class="default-icon"
              v-html="CHEVRON_DOWN_ICON"
              :style="{
                transform: isSubAgentExpanded(block) ? 'rotate(180deg)' : 'rotate(0deg)',
                display: 'inline-block',
                transition: 'transform 0.25s ease',
                lineHeight: 0
              }">
        </span>
      </div>
      <CollapseTransition>
      <div v-if="isSubAgentExpanded(block)" class="tool-group-detail">
        <div v-for="(sb, sbi) in block.blocks" :key="sbi" class="tool-group-item-block">
          <!-- 子代理内层工具 -->
          <div v-if="sb.type === 'tool_call'" class="block-tool">
            <div class="tool-head" @click="sb.expanded = !sb.expanded">
              <span class="tool-icon default-icon" :class="sb.status">
                <span v-if="sb.status === '执行中'" v-html="SPINNER_ICON"></span>
                <span v-else-if="sb.status === '成功'" v-html="CHECK_ICON_SM"></span>
                <span v-else v-html="CIRCLE_ICON"></span>
              </span>
              <code class="tool-name">{{ sb.name }}</code>
              <span class="tool-status" :class="sb.status">{{ sb.status }}</span>
              <span v-if="formatToolDuration(sb)" class="tool-duration">{{ formatToolDuration(sb) }}</span>
              <span class="default-icon"
                    v-html="CHEVRON_DOWN_ICON"
                    :style="{
                      transform: sb.expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      display: 'inline-block',
                      transition: 'transform 0.25s ease',
                      lineHeight: 0
                    }">
              </span>
            </div>
            <CollapseTransition>
              <div v-if="sb.expanded" class="tool-detail">
                <pre v-if="sb.args"><code>{{ fmtArgs(sb.args) }}</code></pre>
                <pre v-if="sb.result"><code>{{ sb.result }}</code></pre>
              </div>
            </CollapseTransition>
          </div>
          <!-- 子代理内层 reasoning -->
          <div v-else-if="sb.type === 'reasoning'" class="block-reasoning">
            <div class="reasoning-head" @click="sb.showContent = !sb.showContent">
              <span class="default-icon" v-html="THINKING_ICON"></span>
              <span>思考</span>
              <span class="default-icon"
                    v-html="CHEVRON_DOWN_ICON"
                    :style="{
                      transform: sb.showContent ? 'rotate(180deg)' : 'rotate(0deg)',
                      display: 'inline-block',
                      transition: 'transform 0.25s ease',
                      lineHeight: 0
                    }">
              </span>
            </div>
            <CollapseTransition>
              <div v-if="sb.showContent" class="reasoning-text" v-html="fmt(sb.content)"></div>
            </CollapseTransition>
          </div>
          <div v-else-if="sb.type === 'reasoning_started'" class="block-reasoning">
            <div class="reasoning-head" @click="sb.showContent = !sb.showContent">
              <span class="default-icon" v-html="THINKING_ICON"></span>
              <span>思考</span>
              <span class="default-icon"
                    v-html="CHEVRON_DOWN_ICON"
                    :style="{
                      transform: sb.showContent ? 'rotate(180deg)' : 'rotate(0deg)',
                      display: 'inline-block',
                      transition: 'transform 0.25s ease',
                      lineHeight: 0
                    }">
              </span>
            </div>
            <CollapseTransition>
              <div v-if="sb.showContent" class="reasoning-text" role="status">加密思考</div>
            </CollapseTransition>
          </div>
          <!-- 子代理内层 content -->
          <div v-else-if="sb.type === 'content' && sb.content" class="block-content" v-html="fmt(sb.content)"></div>
        </div>
      </div>
      </CollapseTransition>
    </div>

    <!-- 选项按钮（choice） -->
    <div v-else-if="block.type === 'choice'" class="block-choice">
      <!-- 未选择：显示问题 + 选项卡片 -->
      <div v-if="!block.resolved">
        <div class="choice-question" v-if="block.question">
          <span class="choice-q-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle
                cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01"
                                                                                              y2="17"/></svg>
          </span>
          <span class="choice-badge">HITL 审批</span>
          <span class="choice-q-text">{{ block.question }}</span>
        </div>
        <pre v-if="block.description" class="choice-desc"><code>{{ block.description }}</code></pre>
        <div class="choice-buttons">
          <button
              v-for="opt in (block.options || [])"
              :key="opt.value || opt.title"
              class="choice-btn"
              :title="opt.summary || opt.title"
              @click="$emit('sendChoice', opt.value, block)"
          >
            <span class="choice-btn-title">{{ opt.title }}</span>
            <span v-if="opt.summary" class="choice-btn-sep">·</span>
            <span v-if="opt.summary" class="choice-btn-summary">{{ opt.summary }}</span>
          </button>
        </div>
      </div>
      <!-- 已选择 -->
      <div v-else class="choice-resolved">
        <span class="choice-resolved-icon default-icon" v-html="CHECK_ICON_SM"></span>
        <span class="choice-resolved-label">已选择</span>
        <span class="choice-resolved-value">{{ block.selectedTitle || block.options?.[0]?.title || '—' }}</span>
      </div>
    </div>
  </template>
</template>

<script setup>
import {md, highlightVersion} from '../utils/highlight'
import {sanitize} from '../utils/sanitize'
import {CHECK_ICON_SM, CHEVRON_DOWN_ICON, CIRCLE_ICON, SPINNER_ICON, THINKING_ICON} from '../utils/icons'
import {LRUCache} from '../utils/cache'
import {computed, onBeforeUnmount, onMounted, ref, watchEffect} from 'vue'
import ChecklistSteps from './ChecklistSteps.vue'
import CollapseTransition from './CollapseTransition.vue'

const props = defineProps({
  blocks: {type: Array, required: true},
  streaming: {type: Boolean, default: false}
})

const clock = ref(Date.now())
let durationTimer = null
onMounted(() => {
  durationTimer = window.setInterval(() => { clock.value = Date.now() }, 1000)
  window.addEventListener('loopra:collapse-all-blocks', onCollapseAllBlocks)
})
onBeforeUnmount(() => {
  if (durationTimer != null) window.clearInterval(durationTimer)
  window.removeEventListener('loopra:collapse-all-blocks', onCollapseAllBlocks)
})

const formatToolDuration = (block) => {
  let duration = Number(block?.toolDurationMs)
  if (!Number.isFinite(duration)) {
    if (block?.status !== '执行中') return ''
    const startedAt = Number(block?.toolStartedAt)
    if (!Number.isFinite(startedAt)) return ''
    duration = Math.max(0, clock.value - startedAt)
  }
  if (duration < 1000) return `${Math.round(duration)}ms`
  if (duration < 10000) return `${(duration / 1000).toFixed(1)}s`
  if (duration < 60000) return `${Math.round(duration / 1000)}s`
  const minutes = Math.floor(duration / 60000)
  const seconds = Math.floor((duration % 60000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

const emit = defineEmits(['sendChoice', 'openFile', 'openDiff', 'revertFileChanges'])

// 清单工具列表（需要在 processedBlocks 之前定义）
const CHECKLIST_TOOLS = ['checklist_start', 'checklist_step', 'checklist_status']
const GOAL_TOOLS = ['goal_create', 'goal_status', 'goal_update_step', 'goal_complete', 'goal_block', 'goal_resume']
const FILE_CHANGE_COLLAPSE_LIMIT = 3

const getVisibleFileChanges = (block) => block.showAll
    ? block.changes
    : block.changes.slice(0, FILE_CHANGE_COLLAPSE_LIMIT)

const getFileChangeTotals = (block) => block.changes.reduce((totals, change) => ({
  additions: totals.additions + Number(change.additions || 0),
  deletions: totals.deletions + Number(change.deletions || 0)
}), {additions: 0, deletions: 0})

const getFileChangeTitle = (block) => {
  if (block.changes.length !== 1) return `已编辑 ${block.changes.length} 个文件`
  const path = block.changes[0].path || '文件'
  return `已编辑 ${path.replace(/\\/g, '/').split('/').pop()}`
}

// ── 工具分组折叠状态 ──

const toolGroupsExpanded = ref({})

// Stream events may replace a sub-agent block while it is still running. Keep
// the user's explicit expansion choice separate from those transient objects.
const subAgentExpanded = ref({})

const getSubAgentKey = block => `sub-agent-${block.subId || block._id || ''}`

const isSubAgentExpanded = block => {
  const key = getSubAgentKey(block)
  return Object.hasOwn(subAgentExpanded.value, key)
      ? subAgentExpanded.value[key]
      : Boolean(block.expanded)
}

const toggleSubAgent = block => {
  const key = getSubAgentKey(block)
  subAgentExpanded.value = {
    ...subAgentExpanded.value,
    [key]: !isSubAgentExpanded(block)
  }
}

const getBlockKey = (block, index) => {
  if (block.type === 'sub_agent') return getSubAgentKey(block)
  if (block.type === 'path_group' || block.type === 'tool_group') return block._groupId
  return block._id || `${block.type}-${index}`
}

const toggleToolGroup = (groupId) => {
  toolGroupsExpanded.value = {...toolGroupsExpanded.value, [groupId]: !toolGroupsExpanded.value[groupId]}
}

// ── 路径组折叠状态 ──
const pathGroupsExpanded = ref({})

const togglePathGroup = (groupId) => {
  pathGroupsExpanded.value = {...pathGroupsExpanded.value, [groupId]: !pathGroupsExpanded.value[groupId]}
}

// ── 路径组内层块折叠状态（key = groupId-index） ──
const pathItemExpanded = ref({})

const getPathItemKey = (groupId, index) => `${groupId}-${index}`

const togglePathItem = (groupId, index) => {
  const key = getPathItemKey(groupId, index)
  pathItemExpanded.value = {...pathItemExpanded.value, [key]: !pathItemExpanded.value[key]}
}

const isTerminalResponseBlock = (block) => {
  if (!block) return false
  if (block.type === 'content') return Boolean(block.content?.trim())
  if (block.type === 'choice') return true
  return block.type === 'tool_call' && (block.name === 'finish' || block.name === 'ask_choice')
}

const isReasoningBlock = block => block?.type === 'reasoning' || block?.type === 'reasoning_started'
const isPathBlock = block => isReasoningBlock(block) || (block?.type === 'tool_call' && block.name !== 'finish')
// 纯空白正文块（如思考间隙流出的 \n\n）：不打断 path 合并，也不渲染
const isBlankContent = block => block?.type === 'content' && !(block.content || '').trim()

/** 将连续思考块 + tool_call(非 finish) 合并为 path_group */
const processedBlocks = computed(() => {
  const src = props.blocks
  if (!src || src.length === 0) return []
  const out = []
  let i = 0
  while (i < src.length) {
    const b = src[i]
    // 收集连续的普通/加密思考 + tool_call(非 finish)
    if (isPathBlock(b)) {
      const group = [b]
      let j = i + 1
      while (j < src.length) {
        const nb = src[j]
        if (isPathBlock(nb)) {
          group.push(nb)
          j++
        } else if (isBlankContent(nb)) {
          // 空白正文夹在思考/工具之间：跳过，不打断合并
          j++
        } else {
          break
        }
      }
      // 不管几个都合并为 path_group（单个思考块也要折叠）
      const gid = `pg-${i}`
      // 工作流工具在 path_group 中自动展开
      // (已移到 watchEffect 中处理，避免 computed 内修改 reactive 状态)
      const toolCount = group.filter(x => x.type === 'tool_call').length
      const thinkCount = group.filter(isReasoningBlock).length
      const pathNames = group.map(x => isReasoningBlock(x) ? 'think' : x.name).join(' → ')
      // Unique tool names for inline display (Cowork style)
      const uniqueToolNames = [...new Set(group.filter(x => x.type === 'tool_call').map(x => x.name))].join(' › ')
      const allDone = group.filter(x => x.type === 'tool_call').every(t => t.status === '成功')
      const toolRunning = group.filter(x => x.type === 'tool_call').some(t => t.status === '执行中')
      // A successful tool result only finishes a step. Until a response, finish, or
      // user-choice boundary arrives, the trailing group is still part of the active run.
      const awaitingTerminalResponse = props.streaming
          && !group.some(isTerminalResponseBlock)
          && !src.slice(j).some(isTerminalResponseBlock)
      out.push({
        type: 'path_group',
        _groupId: gid,
        _blocks: group,
        _toolCount: toolCount,
        _thinkCount: thinkCount,
        _pathNames: pathNames,
        _uniqueToolNames: uniqueToolNames,
        _allDone: toolCount === 0 ? true : allDone,
        _running: toolRunning || awaitingTerminalResponse
      })
      i = j
    } else if (isBlankContent(b)) {
      // 独立空白正文块不渲染
      i++
    } else {
      out.push(b)
      i++
    }
  }
  return out
})

// ── 工具分组顺序辅助 ──
const getToolGroupOrder = (block) => {
  if (!block || !block._tools) return ''
  return block._tools.map(t => t.name).join(' → ')
}

const getToolGroupOrderTruncated = (block) => {
  const order = getToolGroupOrder(block)
  if (!order) return ''
  return order.length > 60 ? order.slice(0, 57) + '...' : order
}

const truncatePath = (text, max) => {
  if (!text) return ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// 路径组折叠头统计：按工具类型分类计数（读文件/改文件/执行命令/记忆/子代理/其他）
const READ_TOOLS = ['read', 'glob', 'grep', 'ls', 'codesearch', 'java_source', 'read_image']
const WRITE_TOOLS = ['write', 'edit']
const isBashTool = name => name === 'bash' || name.startsWith('bash_')
const isMemoryTool = name => name === 'memory'
const isSubAgentTool = name => name === 'sub_agent'

const getPathGroupLabel = (block) => {
  const stats = {read: 0, write: 0, bash: 0, memory: 0, subAgent: 0, other: 0}
  for (const x of block._blocks || []) {
    if (x.type !== 'tool_call') continue
    if (READ_TOOLS.includes(x.name)) stats.read++
    else if (WRITE_TOOLS.includes(x.name)) stats.write++
    else if (isBashTool(x.name)) stats.bash++
    else if (isMemoryTool(x.name)) stats.memory++
    else if (isSubAgentTool(x.name)) stats.subAgent++
    else stats.other++
  }
  const parts = []
  if (block._thinkCount > 0) parts.push(`思考${block._thinkCount}轮`)
  if (stats.read > 0) parts.push(`读${stats.read}次文件`)
  if (stats.write > 0) parts.push(`改${stats.write}次文件`)
  if (stats.bash > 0) parts.push(`执行${stats.bash}次命令`)
  if (stats.memory > 0) parts.push(`记忆${stats.memory}次`)
  if (stats.subAgent > 0) parts.push(`子代理${stats.subAgent}次`)
  if (stats.other > 0) parts.push(`其他${stats.other}次`)
  if (parts.length === 0) return '推理'
  // 思考轮数与其余项之间用 . 分隔，其余用 、
  return parts.length > 1 && parts[0].startsWith('思考')
    ? parts[0] + '.' + parts.slice(1).join('、')
    : parts.join('、')
}

// Markdown 渲染缓存（含渲染版本：主题切换 / 异步高亮就绪后自动失效并重渲染）
const renderCache = new LRUCache(200)

const fmt = c => {
  if (!c) return ''
  const key = highlightVersion.value + '|' + c
  const cached = renderCache.get(key)
  if (cached) return cached
  const result = sanitize(md.render(c))
  renderCache.set(key, result)
  return result
}

// 带缓存的 reasoning Markdown 渲染
const getReasoningHtml = (block) => {
  if (!block.showContent) return ''
  if (!block.content) return ''
  if (block._cachedContent === block.content && block._cachedHtml) {
    return block._cachedHtml
  }
  block._cachedContent = block.content
  block._cachedHtml = fmt(block.content)
  return block._cachedHtml
}

// 代码块展开/收起（>6 行折叠；与思考/工具折叠块统一：点击顶部条整行切换；点击复制按钮不触发）
const onCodeBlockClick = (e) => {
  if (e.target.closest('.code-copy-btn')) return
  const top = e.target.closest('.code-block-top')
  if (!top) return
  const wrap = top.closest('.code-block-wrap')
  if (!wrap || !wrap.classList.contains('collapsible')) return
  wrap.classList.toggle('expanded')
}

const fmtArgs = a => {
  if (typeof a === 'string') {
    try {
      return JSON.stringify(JSON.parse(a), null, 2)
    } catch {
      return a
    }
  }
  return JSON.stringify(a, null, 2)
}

// 解析 args
const parseArgs = (block) => {
  if (!block || block.type !== 'tool_call') return null
  let args = block.args
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  return args && typeof args === 'object' ? args : null
}

// 检查是否显示打开文件按钮
const shouldShowOpenFile = (block) => {
  const args = parseArgs(block)
  if (!args) return false
  const toolName = block.name
  // 对 write、edit、read 工具显示打开文件按钮
  if (toolName !== 'write' && toolName !== 'edit' && toolName !== 'read') return false
  return !!args.file_path
}

// 获取文件路径（完整路径）
const getFilePath = (block) => {
  const args = parseArgs(block)
  return args?.file_path || null
}

// 获取文件名（从路径中提取最后一段）
const getFileName = (block) => {
  const fp = getFilePath(block)
  if (!fp) return null
  const parts = fp.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1]
}

// 获取 bash 命令（截断显示版）
const getBashCommand = (block) => {
  const args = parseArgs(block)
  const cmd = args?.command
  if (!cmd) return null
  return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
}

// 获取 bash 命令（完整版，用于 title）
const getBashCommandFull = (block) => {
  const args = parseArgs(block)
  return args?.command || null
}

// 获取 grep path（截断显示版）
const getGrepPath = (block) => {
  const args = parseArgs(block)
  const p = args?.path
  if (!p) return null
  return p.length > 50 ? p.slice(0, 47) + '...' : p
}

// 获取 grep path（完整版，用于 title）
const getGrepPathFull = (block) => {
  const args = parseArgs(block)
  return args?.path || null
}

// 获取 ls path
const getLsPath = (block) => {
  const args = parseArgs(block)
  return args?.path || null
}

// 获取 glob path（截断显示版）
const getGlobPath = (block) => {
  const args = parseArgs(block)
  const p = args?.path
  if (!p) return null
  return p.length > 50 ? p.slice(0, 47) + '...' : p
}

// 获取 glob path（完整版，用于 title）
const getGlobPathFull = (block) => {
  const args = parseArgs(block)
  return args?.path || null
}

// 触发打开文件事件
const openFile = (block) => {
  const filePath = getFilePath(block)
  openFilePath(filePath)
}

const openFilePath = (filePath) => {
  if (filePath) emit('openFile', filePath)
}

// 获取 ask_choice 的问题文字
const getChoiceQuestion = (block) => {
  const args = parseArgs(block)
  const q = args?.question
  if (!q) return null
  const options = args?.options
  const count = Array.isArray(options) ? options.length : 0
  const suffix = count > 0 ? ` (${count} 项)` : ''
  return q.length > 40 ? q.slice(0, 37) + '...' + suffix : q + suffix
}

// 清单工具相关方法
const isChecklistTool = (block) => {
  return CHECKLIST_TOOLS.includes(block.name)
}

// 清单工具默认展开
const initChecklistToolExpanded = (block) => {
  if (isChecklistTool(block) && block.expanded === undefined) {
    block.expanded = true
  }
}

const isGoalTool = (block) => GOAL_TOOLS.includes(block?.name)

const getGoalTitle = (block) => {
  if (!block.result) return ''
  // 从 "Goal [ACTIVE] 标题\n进度: ..." 中提取标题
  const match = block.result.match(/^Goal \[\w+\] (.+)$/m)
  return match ? match[1] : ''
}

const getChecklistTitle = (block) => {
  try {
    if (block.name === 'checklist_start') {
      const result = parseResult(block)
      return result?.title || ''
    }
    if (block.name === 'checklist_status' || block.name === 'checklist_step') {
      const result = parseResult(block)
      return result?.title || ''
    }
  } catch (e) {
    // ignore
  }
  return ''
}

const getChecklistData = (block) => {
  try {
    const result = parseResult(block)
    if (result) return result
  } catch (e) {
    // ignore
  }
  return {}
}

const parseResult = (block) => {
  if (!block.result) return null
  try {
    return JSON.parse(block.result)
  } catch (e) {
    return null
  }
}

// ── 副作用：从 computed 中移出，用 watchEffect 处理自动展开 ──

watchEffect(() => {
  const blocks = processedBlocks.value
  if (!blocks) return
  for (const block of blocks) {
    if (block.type === 'path_group' && block._blocks) {
      block._blocks.forEach((item, idx) => {
        const key = getPathItemKey(block._groupId, idx)
        if (item.type === 'tool_call' && isChecklistTool(item) && !pathItemExpanded.value[key]) {
          pathItemExpanded.value = {...pathItemExpanded.value, [key]: true}
        }
      })
    }
    // 独立工具块：工作流工具自动展开
    if (block.type === 'tool_call' && isChecklistTool(block) && block.expanded === undefined) {
      block.expanded = true
    }
  }
})

// ── 一键折叠全部展开的块（由 Chat 界面「折叠」按钮派发 window 事件触发） ──
// 分组折叠状态存于本组件 ref，无法从外部按对象改写，需在事件中重置；
// 块级状态（showContent/expanded/t.expanded 等）由 Chat.vue 直接改 store 消息对象完成。
const onCollapseAllBlocks = () => {
  toolGroupsExpanded.value = {}
  pathGroupsExpanded.value = {}
  pathItemExpanded.value = {}
  subAgentExpanded.value = {}
  // 路径组内的清单工具：写入显式 false，防止 watchEffect 自动展开再次打开
  for (const block of processedBlocks.value) {
    if (block.type === 'path_group' && block._blocks) {
      block._blocks.forEach((item, idx) => {
        if (item.type === 'tool_call' && isChecklistTool(item)) {
          const key = getPathItemKey(block._groupId, idx)
          pathItemExpanded.value = {...pathItemExpanded.value, [key]: false}
        }
      })
    }
  }
}
</script>

<style scoped>
/* 思考块 */
.block-reasoning {
  background: var(--bg-subtle, #fafafb);
  border: 1px solid var(--border, #e8e8eb);
  border-radius: 9px;
  overflow: hidden;
  margin-bottom: 6px;
}

.reasoning-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 8px 12px;
  font-size: var(--font-message-size, 14px);
  line-height: 20px;
  font-weight: 500;
  color: var(--fg-2);
  cursor: pointer;
}

.reasoning-head :deep(svg:last-child) {
  transition: transform var(--t);
}

.reasoning-text {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border-soft, var(--border, #eeeef0));
  font-size: var(--font-message-size, 14px);
  font-family: var(--mono);
  color: var(--fg-3);
  line-height: 1.6;
}

.reasoning-text :deep(p) {
  margin: 0.4em 0;
}

.reasoning-text :deep(ul) {
  margin: 0.4em 0;
  padding-left: 1.5em;
}

.reasoning-text :deep(ol) {
  margin: 0.4em 0;
  padding-left: 1.5em;
}

.reasoning-text :deep(li) {
  margin: 0.2em 0;
}

.reasoning-text :deep(blockquote) {
  margin: 0.4em 0;
  padding: 0.3em 0.8em;
  border-left: 3px solid var(--accent);
  background: var(--bg-3);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
}

.reasoning-text :deep(pre) {
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  margin: 4px 0;
  overflow-x: auto;
  font-size: var(--font-code-size, 12px);
  line-height: 1.5;
}

.reasoning-text :deep(pre code) {
  background: none;
  padding: 0;
}

.reasoning-text :deep(code) {
  font-size: var(--font-code-size, 12px);
  background: var(--bg-3);
  padding: 0 4px;
  border-radius: 3px;
}

/* 内容块 */
.block-content {
  font-size: var(--font-message-size, 14px);
  line-height: 1.7;
  color: var(--fg);
  margin-bottom: 4px;
}

/* 子代理内层用户消息气泡（继续对话输入） */
.block-sub-user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin: 4px 0 8px;
}

.block-sub-user .sub-user-label {
  font-size: 11px;
  color: var(--fg-3);
  margin-bottom: 2px;
}

.block-sub-user .sub-user-content {
  max-width: 88%;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.6;
  color: var(--fg);
  background: var(--accent-bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 6px 10px;
}

.block-content :deep(pre) {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 8px 10px;
  margin: 6px 0;
  font-size: var(--font-code-size, 12px);
  overflow-x: auto;
}

.block-content :deep(code) {
  font-family: var(--mono);
  font-size: var(--font-code-size, 12px);
}

.block-content :deep(pre code) {
  background: none;
  padding: 0;
  line-height: 1.5;
}

.block-content :deep(strong) {
  font-weight: 600;
}

.block-content :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.block-content :deep(a:hover) {
  text-decoration: underline;
}

.block-content :deep(h1) {
  font-size: 1.3em;
  margin: 0.5em 0;
  font-weight: 600;
}

.block-content :deep(h2) {
  font-size: 1.15em;
  margin: 0.5em 0;
  font-weight: 600;
}

.block-content :deep(h3) {
  font-size: 1.05em;
  margin: 0.5em 0;
  font-weight: 600;
}

.block-content :deep(h4) {
  font-size: 1em;
  margin: 0.5em 0;
  font-weight: 600;
}

.block-content :deep(h5) {
  font-size: 0.95em;
  margin: 0.5em 0;
  font-weight: 600;
}

.block-content :deep(h6) {
  font-size: 0.9em;
  margin: 0.5em 0;
  font-weight: 600;
}

.block-content :deep(ul) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.block-content :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.block-content :deep(li) {
  margin: 0.25em 0;
}

.block-content :deep(blockquote) {
  margin: 0.5em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--accent);
  background: var(--bg-3);
  border-radius: 0 var(--r) var(--r) 0;
}

.block-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.block-content :deep(th),
.block-content :deep(td) {
  border: 1px solid var(--glass-border);
  padding: 7px 12px;
  text-align: left;
}

.block-content :deep(th) {
  background: var(--bg-subtle);
  font-weight: 600;
}

.block-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

.block-content :deep(p) {
  margin: 0.5em 0;
}

.block-content :deep(p:first-child) {
  margin-top: 0;
}

.block-content :deep(p:last-child) {
  margin-bottom: 0;
}

/* 完成块（finish 工具输出）— 复用 block-tool 样式 */
.block-finish {
  border-color: var(--green-bg);
}

.block-finish .tool-name {
  color: var(--fg-2);
  font-weight: 500;
}

.finish-content {
  font-size: var(--font-message-size, 14px);
  line-height: 1.7;
  color: var(--fg);
}

.finish-content :deep(pre) {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: 10px;
  margin: 6px 0;
  font-size: var(--font-code-size, 12px);
  overflow-x: auto;
}

.finish-content :deep(code) {
  font-family: var(--mono);
  font-size: var(--font-code-size, 12px);
}

.finish-content :deep(pre code) {
  background: none;
  padding: 0;
}

.finish-content :deep(strong) {
  font-weight: 600;
}

.finish-content :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.finish-content :deep(a:hover) {
  text-decoration: underline;
}

.finish-content :deep(h1) {
  font-size: 1.3em;
  margin: 0.5em 0;
  font-weight: 600;
}

.finish-content :deep(h2) {
  font-size: 1.15em;
  margin: 0.5em 0;
  font-weight: 600;
}

.finish-content :deep(h3) {
  font-size: 1.05em;
  margin: 0.5em 0;
  font-weight: 600;
}

.finish-content :deep(h4) {
  font-size: 1em;
  margin: 0.5em 0;
  font-weight: 600;
}

.finish-content :deep(h5) {
  font-size: 0.95em;
  margin: 0.5em 0;
  font-weight: 600;
}

.finish-content :deep(h6) {
  font-size: 0.9em;
  margin: 0.5em 0;
  font-weight: 600;
}

.finish-content :deep(ul) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.finish-content :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}

.finish-content :deep(li) {
  margin: 0.25em 0;
}

.finish-content :deep(blockquote) {
  margin: 0.5em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--green);
  background: var(--bg-3);
  border-radius: 0 var(--r) var(--r) 0;
}

.finish-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.finish-content :deep(th),
.finish-content :deep(td) {
  border: 1px solid var(--glass-border);
  padding: 7px 12px;
  text-align: left;
}

.finish-content :deep(th) {
  background: var(--bg-subtle);
  font-weight: 600;
}

.finish-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

.finish-content :deep(p) {
  margin: 0.5em 0;
}

.finish-content :deep(p:first-child) {
  margin-top: 0;
}

.finish-content :deep(p:last-child) {
  margin-bottom: 0;
}

/* 代码块容器：与思考块/执行块同款玻璃卡片 */
.block-content :deep(.code-block-wrap),
.finish-content :deep(.code-block-wrap) {
  position: relative;
  margin: 8px 0;
  background: var(--glass-bg-2);
  backdrop-filter: blur(var(--blur-sm));
  -webkit-backdrop-filter: blur(var(--blur-sm));
  border: 1px solid var(--glass-border);
  border-radius: var(--r);
  overflow: hidden;
}

.block-content :deep(.code-block-wrap pre),
.finish-content :deep(.code-block-wrap pre) {
  position: relative;
  margin: 0 !important;
  background: none;
  border: none;
  border-radius: 0;
}

/* 复制按钮：位于头部右侧（margin-left: auto 推到最右），常显 */
.block-content :deep(.code-copy-btn),
.finish-content :deep(.code-copy-btn) {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 2px 5px;
  background: none;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-4);
  cursor: pointer;
  transition: color var(--t), background var(--t);
}

.block-content :deep(.code-copy-btn:hover),
.finish-content :deep(.code-copy-btn:hover) {
  color: var(--fg-1);
  background: var(--bg-2);
}

/* ============ 代码块头部行：与执行折叠块 (.tool-head) 同构 ============ */
/* [代码图标] 语言 行数 + chevron；玻璃卡片底 + 透明头部行，padding/gap/hover 全部同 tool-head */
.block-content :deep(.code-block-top),
.finish-content :deep(.code-block-top) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-3);
  cursor: pointer;
  user-select: none;
  transition: background var(--t);
}

.block-content :deep(.code-block-top:hover),
.finish-content :deep(.code-block-top:hover) {
  background: var(--bg-2);
}

/* 代码图标：与执行块 tool-icon 同款 20×20 圆角底 */
.block-content :deep(.code-block-icon),
.finish-content :deep(.code-block-icon) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--r-sm);
  color: var(--fg-2);
  flex-shrink: 0;
}

/* 代码块语言标识（同执行块 .path-label 样式） */
.block-content :deep(.code-block-lang),
.finish-content :deep(.code-block-lang) {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  color: var(--fg-2);
  text-transform: lowercase;
  pointer-events: none;
}

/* 行数（同执行块 .path-steps 样式） */
.block-content :deep(.code-block-meta),
.finish-content :deep(.code-block-meta) {
  font-size: 10px;
  font-weight: 400;
  color: var(--fg-4);
  flex-shrink: 0;
}

/* chevron（与思考/工具折叠块一致：紧跟文字，展开后旋转 180°） */
.block-content :deep(.code-block-chevron),
.finish-content :deep(.code-block-chevron) {
  display: inline-flex;
  transition: transform var(--t);
}

.block-content :deep(.code-block-wrap.expanded .code-block-chevron),
.finish-content :deep(.code-block-wrap.expanded .code-block-chevron) {
  transform: rotate(180deg);
}

/* 头部与代码之间的分割线（同执行块 .tool-detail 的 border-top） */
.block-content :deep(.code-block-wrap.has-top pre),
.finish-content :deep(.code-block-wrap.has-top pre) {
  border-top: 1px solid var(--border);
}

/* ============ 代码块折叠（>6 行）：默认展示前 6 行 + 底部渐隐 + 头部展开 ============ */
.block-content :deep(.code-block-wrap.collapsible:not(.expanded) pre),
.finish-content :deep(.code-block-wrap.collapsible:not(.expanded) pre) {
  /* 6 行 × 18px 行高 + 上下 padding 16px + 边框 2px */
  max-height: 126px;
  overflow-y: hidden;
}

.block-content :deep(.code-block-wrap.collapsible:not(.expanded)::before),
.finish-content :deep(.code-block-wrap.collapsible:not(.expanded)::before) {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 36px;
  z-index: 1;
  background: linear-gradient(to top, var(--glass-bg-2), transparent);
  border-radius: 0 0 var(--r) var(--r);
  pointer-events: none;
}

/* 思考内容里的折叠代码块（在思考卡片内，沿用其玻璃底） */
.reasoning-text :deep(.code-block-wrap) {
  position: relative;
  margin: 4px 0;
}

/* 头部行与执行块 (.tool-head) 一致：8px 10px、hover 背景 */
.reasoning-text :deep(.code-block-top) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-3);
  cursor: pointer;
  user-select: none;
  transition: background var(--t);
}

.reasoning-text :deep(.code-block-top:hover) {
  background: var(--bg-2);
}

/* pre 透明化，融入思考卡片玻璃底（无边框分隔） */
.reasoning-text :deep(.code-block-wrap pre) {
  background: none;
  border: none;
  border-radius: 0;
}

.reasoning-text :deep(.code-block-lang) {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  color: var(--fg-2);
  text-transform: lowercase;
  pointer-events: none;
}

.reasoning-text :deep(.code-block-icon) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--r-sm);
  color: var(--fg-2);
  flex-shrink: 0;
}

.reasoning-text :deep(.code-block-meta) {
  font-size: 10px;
  font-weight: 400;
  color: var(--fg-4);
  flex-shrink: 0;
}

.reasoning-text :deep(.code-block-wrap.collapsible:not(.expanded) pre) {
  /* 6 行 × 16.5px 行高 + 上下 padding 12px + 边框 2px */
  max-height: 113px;
  overflow-y: hidden;
}

.reasoning-text :deep(.code-block-wrap.collapsible:not(.expanded)::before) {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 32px;
  z-index: 1;
  background: linear-gradient(to top, var(--glass-bg-2), transparent);
  border-radius: 0 0 var(--r-sm) var(--r-sm);
  pointer-events: none;
}

/* chevron（与思考/工具折叠块一致：紧跟文字，展开后旋转 180°） */
.reasoning-text :deep(.code-block-chevron) {
  display: inline-flex;
  transition: transform var(--t);
}

.reasoning-text :deep(.code-block-wrap.expanded .code-block-chevron) {
  transform: rotate(180deg);
}

/* 头部与代码之间的分割线（同执行块 .tool-detail 的 border-top） */
.reasoning-text :deep(.code-block-wrap.has-top pre) {
  border-top: 1px solid var(--border);
}

/* ============ GitHub 风格排版 ============ */
.block-content :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}

.block-content :deep(img) {
  max-width: 100%;
  border-radius: var(--r);
}

.block-content :deep(ul), .block-content :deep(ol) {
  /* 2em 与 GitHub 一致：marker(序号/圆点) 画在 padding 区，太窄会与文字挤压 */
  padding-left: 2em;
  margin: 0.4em 0;
}

.block-content :deep(li) {
  margin: 0.2em 0;
}

/* 序号/圆点用次要色，避免与正文同色显得重 */
.block-content :deep(li::marker) {
  color: var(--fg-3);
}

.block-content :deep(li > input[type="checkbox"]) {
  margin-right: 0.4em;
  vertical-align: middle;
  accent-color: var(--accent);
}

/* 任务列表：checkbox 用负 margin 拉回 marker 区，多行内容与首行对齐（GitHub 同款） */
.block-content :deep(li.task-list-item) {
  list-style: none;
}

.block-content :deep(li.task-list-item > input[type="checkbox"]) {
  margin: 0 0.35em 0 -1.5em;
  vertical-align: middle;
  accent-color: var(--accent);
}

/* 表格 */
.block-content :deep(table) {
  display: block;
  max-width: 100%;
  width: max-content;
  overflow-x: auto;
  overflow-y: hidden;
  border-collapse: collapse;
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-2);
  font-size: 14px;
}

.block-content :deep(th), .block-content :deep(td) {
  border: 1px solid var(--glass-border);
  padding: 7px 12px;
  text-align: left;
}

.block-content :deep(th) {
  background: var(--bg-subtle);
  font-weight: 600;
}

.block-content :deep(tr:nth-child(2n) td) {
  background: transparent;
}

/* 引用块 */
.block-content :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 14px;
  border-left: 3px solid var(--border-2);
  background: var(--bg-2);
  border-radius: 0 var(--r) var(--r) 0;
  color: var(--fg-2);
}

.block-content :deep(blockquote p) {
  margin: 4px 0;
}

/* GitHub 告警框（> [!NOTE] 或 :::note） */
.block-content :deep(.markdown-alert) {
  display: block;
  margin: 10px 0;
  padding: 8px 12px 8px 32px;
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--r);
  position: relative;
  font-size: 13px;
  line-height: 1.55;
}

.block-content :deep(.markdown-alert > p) {
  margin: 4px 0;
}

.block-content :deep(.markdown-alert:first-child > p:first-child) {
  margin-top: 0;
}

.block-content :deep(.markdown-alert:last-child > p:last-child) {
  margin-bottom: 0;
}

.block-content :deep(.markdown-alert::before) {
  position: absolute;
  left: 10px;
  top: 8px;
  font-size: 14px;
  line-height: 1.3;
}

.block-content :deep(.markdown-alert-note) {
  color: #0969da;
  border-color: rgba(9, 105, 218, 0.35);
  background: rgba(9, 105, 218, 0.06);
}

.block-content :deep(.markdown-alert-note::before) {
  content: 'ℹ️';
}

.block-content :deep(.markdown-alert-tip) {
  color: #1a7f37;
  border-color: rgba(26, 127, 55, 0.35);
  background: rgba(26, 127, 55, 0.06);
}

.block-content :deep(.markdown-alert-tip::before) {
  content: '💡';
}

.block-content :deep(.markdown-alert-important) {
  color: #8250df;
  border-color: rgba(130, 80, 223, 0.35);
  background: rgba(130, 80, 223, 0.06);
}

.block-content :deep(.markdown-alert-important::before) {
  content: '❕';
}

.block-content :deep(.markdown-alert-warning) {
  color: #9a6700;
  border-color: rgba(154, 103, 0, 0.35);
  background: rgba(154, 103, 0, 0.07);
}

.block-content :deep(.markdown-alert-warning::before) {
  content: '⚠️';
}

.block-content :deep(.markdown-alert-caution) {
  color: #cf222e;
  border-color: rgba(207, 34, 46, 0.35);
  background: rgba(207, 34, 46, 0.06);
}

.block-content :deep(.markdown-alert-caution::before) {
  content: '⛔';
}

[data-theme="dark"] .block-content :deep(.markdown-alert-note) {
  color: #58a6ff;
  border-color: rgba(88, 166, 255, 0.35);
  background: rgba(88, 166, 255, 0.08);
}

[data-theme="dark"] .block-content :deep(.markdown-alert-tip) {
  color: #3fb950;
  border-color: rgba(63, 185, 80, 0.35);
  background: rgba(63, 185, 80, 0.08);
}

[data-theme="dark"] .block-content :deep(.markdown-alert-important) {
  color: #d2a8ff;
  border-color: rgba(210, 168, 255, 0.35);
  background: rgba(210, 168, 255, 0.08);
}

[data-theme="dark"] .block-content :deep(.markdown-alert-warning) {
  color: #d29922;
  border-color: rgba(210, 153, 34, 0.35);
  background: rgba(210, 153, 34, 0.08);
}

[data-theme="dark"] .block-content :deep(.markdown-alert-caution) {
  color: #ff7b72;
  border-color: rgba(255, 123, 114, 0.35);
  background: rgba(255, 123, 114, 0.08);
}

/* ============ 暗色主题：代码块纯色深底（提升 token 对比度） ============
 * 消息气泡与代码块均为半透明玻璃底（--glass-bg-2）叠加 backdrop blur，
 * 暗色下两层玻璃混合出浑浊偏亮的底色，Shiki token 颜色被削弱、看起来发灰看不清。
 * 暗色下改为不透明纯深色底，去掉 blur，与 github-dark 底色同源，token 对比度最大化。
 */
[data-theme="dark"] .block-content :deep(.code-block-wrap),
[data-theme="dark"] .finish-content :deep(.code-block-wrap) {
  background: #1c1e23;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-color: rgba(255, 255, 255, 0.10);
}

[data-theme="dark"] .block-content :deep(.code-block-wrap.collapsible:not(.expanded)::before),
[data-theme="dark"] .finish-content :deep(.code-block-wrap.collapsible:not(.expanded)::before) {
  background: linear-gradient(to top, #1c1e23, transparent);
}

/* 思考卡片内代码块：同样叠加在玻璃底上，统一深底 */
[data-theme="dark"] .reasoning-text :deep(.code-block-wrap) {
  background: #1c1e23;
  border-radius: var(--r-sm);
}

[data-theme="dark"] .reasoning-text :deep(.code-block-wrap.collapsible:not(.expanded)::before) {
  background: linear-gradient(to top, #1c1e23, transparent);
}

/* 代码默认前景色：无 token 的空白/回退文本在暗色下也要亮色显示 */
[data-theme="dark"] .block-content :deep(pre code),
[data-theme="dark"] .finish-content :deep(pre code),
[data-theme="dark"] .reasoning-text :deep(pre code) {
  color: var(--fg);
}

/* 本轮文件变更 */
.block-file-changes {
  overflow: hidden;
  margin: 10px 0 4px;
  border: 1px solid var(--border, #e8e8eb);
  border-radius: 9px;
  background: var(--bg-subtle, #fafafb);
}

.file-changes-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 76px;
  padding: 12px 16px;
}

.file-changes-head.clickable { cursor: pointer; }
.file-changes-head.clickable:hover { background: var(--bg-hover); }
.file-changes-head.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.file-changes-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: var(--r);
  background: var(--bg-3);
  color: var(--fg-2);
}

.file-changes-summary { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }

.file-changes-title {
  color: var(--fg);
  font-size: 15px;
  font-weight: 600;
}

.file-changes-total, .file-change-stats {
  display: inline-flex;
  gap: 7px;
  font: 600 12px var(--mono);
}

.file-changes-undo {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fg-2);
  font-size: 13px;
  cursor: pointer;
}

.file-changes-undo:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); }

.file-change-row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 12px;
  padding: 11px 16px;
  border: 0;
  border-top: 1px solid var(--border-soft, var(--border, #eeeef0));
  background: transparent;
  color: var(--fg-2);
  cursor: pointer;
  text-align: left;
}

.file-change-row:hover {
  background: var(--bg-hover);
}

.file-change-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 500 12px var(--mono);
}

.file-change-stats { margin-left: auto; }

.file-change-add { color: var(--green); }
.file-change-del { color: var(--red); }

.file-changes-expand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px 12px;
  border: 0;
  background: transparent;
  color: var(--fg-2);
  font-size: 14px;
  cursor: pointer;
}

.file-changes-expand svg { transition: transform var(--t); }
.file-changes-expand:hover { color: var(--accent); }

/* 工具分组展开内容 */
.tool-group-detail {
  border-top: 1px solid var(--border-soft, var(--border, #eeeef0));
  padding: 6px 8px;
}

.tool-group-item-block + .tool-group-item-block {
  margin-top: 2px;
}

/* 路径组折叠头统计文案 */
.path-steps {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 工具块 */
.block-tool {
  background: var(--bg-subtle, #fafafb);
  border: 1px solid var(--border, #e8e8eb);
  border-radius: 9px;
  overflow: hidden;
  margin-bottom: 6px;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background var(--t);
}

.tool-head:hover {
  background: var(--bg-hover);
}

.tool-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--r-sm);
}

.tool-icon.执行中 {
  color: var(--yellow);
}

.tool-icon.成功 {
  color: var(--green);
}

.tool-name {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}

.tool-status {
  font-size: 10px;
  padding: 0 4px;
  font-weight: 500;
  border-radius: var(--r-sm);
  font-family: var(--mono);
}

.tool-duration {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--fg-4);
  font-size: 10px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.tool-status.执行中 {
  background: var(--yellow-bg);
  color: var(--yellow);
}

.tool-status.成功 {
  background: var(--green-bg);
  color: var(--green);
}

.tool-head :deep(svg:last-child) {
  margin-left: auto;
  transition: transform var(--t);
  color: var(--fg-4);
}

.tool-detail {
  padding: 10px 10px 8px;
  border-top: 1px solid var(--border);
}

.tool-detail pre {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 8px;
  margin-top: 6px;
  font-size: var(--font-code-size, 12px);
  max-height: 150px;
  overflow: auto;
}

/* 清单工具 */
.block-checklist {
  background: var(--bg-2, #f9fafb);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 4px;
}

.checklist-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
}

.checklist-tool-head:hover {
  background: var(--bg-3, #f3f4f6);
}

.checklist-tool-title {
  font-size: 12px;
  color: var(--fg-2, #6b7280);
  margin-left: 4px;
}

.checklist-tool-detail {
  padding: 8px;
  border-top: 1px solid var(--border, #e5e7eb);
}

.block-goal {
  border-left: 2px solid var(--accent, #6366f1);
}

.goal-detail pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--font-code-size, 12px);
  line-height: 1.5;
  color: var(--fg-2);
}

.tool-param {
  font-size: 10px;
  color: var(--fg-3);
  background: var(--bg-3);
  border-radius: 3px;
  padding: 0 6px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1.5;
  font-family: var(--mono);
}

/* 长文本参数（ask_choice 问题等），允许更宽 */
.tool-param-wide {
  max-width: 320px;
}

/* 文件工具（edit/write/read 显示文件名，可点击打开，标签风格） */
.tool-file {
  font-size: 10px;
  color: var(--fg-3);
  background: var(--bg-3);
  border-radius: 3px;
  padding: 0 6px;
  max-width: 180px;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1.5;
  border: none;
  cursor: pointer;
  transition: color var(--t), background var(--t);
}

.tool-file:hover {
  color: var(--accent);
  background: var(--accent-bg);
  font-family: var(--mono);
}

/* 选项按钮（choice / ask_choice） */
.block-choice {
  background: var(--glass-bg-2);
  backdrop-filter: blur(var(--blur-sm));
  -webkit-backdrop-filter: blur(var(--blur-sm));
  border: 1px solid var(--glass-border);
  border-radius: var(--r);
  margin-bottom: 4px;
  overflow: hidden;
}

/* 问题头部 */
.choice-question {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px 4px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg);
}

.choice-q-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: var(--r-sm);
  color: var(--accent);
}

.choice-q-text {
  flex: 1;
  font-weight: 500;
}

/* 选项描述 — 工具参数详情等（代码块风格） */
.choice-desc {
  margin: 0 12px 8px;
  padding: 6px 10px;
  background: var(--color-code-bg, #f6f8fa);
  border-radius: 6px;
  font-size: 0.82em;
  line-height: 1.45;
  overflow-x: auto;
}
.choice-desc code {
  background: none;
  padding: 0;
  font-family: var(--font-mono, 'JetBrains Mono Variable', 'SF Mono', 'Fira Code', 'Consolas', monospace);
  color: var(--color-text-primary, #1a1a2e);
}

/* HITL 审批小徽章 */
.choice-badge {
  display: inline-block;
  padding: 1px 8px;
  margin-right: 6px;
  background: #f0a02020;
  border: 1px solid #f0a02040;
  border-radius: 4px;
  font-size: 0.78em;
  font-weight: 600;
  color: #b8780a;
  vertical-align: middle;
}

/* 选项列表 — 横向 wrap */
.choice-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 12px 10px;
}

.choice-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--t);
  white-space: nowrap;
  line-height: 1.4;
}

.choice-btn:hover {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}

.choice-btn:active {
  transform: scale(0.96);
}

.choice-btn-title {
  font-weight: 600;
}

.choice-btn-sep {
  color: var(--fg-4);
  margin: 0 1px;
}

.choice-btn-summary {
  color: var(--fg-4);
  font-size: 11px;
}

/* 已选择状态 */
.choice-resolved {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--green);
  background: var(--green-bg);
}

.choice-resolved-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.choice-resolved-label {
  font-weight: 500;
  flex-shrink: 0;
}

.choice-resolved-value {
  font-size: 11px;
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
