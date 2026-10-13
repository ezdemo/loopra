// Requirement board helpers, ported from legacy `src/views/RequirementBoard.vue`.
// Pure functions only: the board component owns polling, and these helpers keep
// the comment/log split and formatting rules testable.
import type { Message } from './chat';
import { historyMessages, type HistoryMessage } from './backend';

export const REQUIREMENT_STATUS_LABELS: Record<string, string> = {
  todo: '待执行',
  doing: '执行中',
  done: '已完成',
  failed: '已失败',
};

export const REQUIREMENT_PRIORITY_LABELS: Record<string, string> = { high: '高', medium: '中', low: '低' };

export const REQUIREMENT_COLUMNS = [
  { key: 'todo', label: '待执行', color: '#9ca3af' },
  { key: 'doing', label: '执行中', color: '#3b82f6' },
  { key: 'done', label: '已完成', color: '#22c55e' },
  { key: 'failed', label: '已失败', color: '#ef4444' },
] as const;

export const REQUIREMENT_PRIORITY_OPTIONS = [
  { value: 'high', label: '高', dot: '#ef4444' },
  { value: 'medium', label: '中', dot: '#f59e0b' },
  { value: 'low', label: '低', dot: '#6b7280' },
];

export const REQUIREMENT_EFFORT_OPTIONS = [
  { value: 'none', label: '无' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最大' },
];

export const REQUIREMENT_HITL_OPTIONS = [
  { value: 'free', label: '自由模式' },
  { value: 'approval', label: '审批模式' },
  { value: 'auto', label: '自动模式' },
];

export type Requirement = {
  id: string; title: string; description?: string; priority?: string;
  projectHash?: string; projectName?: string; status?: string;
  scheduleMode?: string; scheduledAt?: number; summary?: string;
  sessionName?: string; approvalPending?: boolean;
  model?: string; modelChannelId?: string; reasoningEffort?: string; hitl?: string;
  createdAt?: number; updatedAt?: number;
};

export type RequirementChannel = { id: string; name?: string; models?: { name: string }[] };

/** `channel::model` value used by the create dialog's model picker. */
export function requirementModelOptions(channels: RequirementChannel[] | undefined) {
  return (channels || []).flatMap(channel => (channel.models || []).map(model => ({
    value: `${channel.id}::${model.name}`,
    label: `${model.name} (${channel.name || channel.id})`,
  })));
}

export function splitRequirementModel(selection: string) {
  const [modelChannelId = '', model = ''] = String(selection || '').split('::');
  return { modelChannelId: modelChannelId || null, model: model || null };
}

export function requirementStatusLabel(status?: string) {
  return (status && REQUIREMENT_STATUS_LABELS[status]) || status || '';
}

export function requirementPriorityLabel(priority?: string) {
  return (priority && REQUIREMENT_PRIORITY_LABELS[priority]) || priority || '';
}

export function isScheduledRequirement(item: Requirement | undefined) {
  return !!item && item.scheduleMode === 'scheduled' && Number(item.scheduledAt) > 0;
}

export function requirementScheduleDescription(item: Requirement | undefined) {
  if (!item) return '';
  return isScheduledRequirement(item)
    ? `定时执行：${formatRequirementTime(item.scheduledAt)} 自动启动`
    : '立即执行：创建后直接进入执行队列';
}

/** Legacy `fmtTime`: 今天 / 昨天 / M/D + HH:mm. */
export function formatRequirementTime(timestamp?: number) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** Legacy `fmtRelative` for the comment list. */
export function formatRequirementRelative(timestamp?: number) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function requirementScheduleMin(now = Date.now()) {
  const date = new Date(now + 60 * 1000 - new Date(now + 60 * 1000).getTimezoneOffset() * 60 * 1000);
  return date.toISOString().slice(0, 16);
}

const finishComment = (content: string) => content.startsWith('✅') || content.startsWith('❌');
const internalExecutionPrompt = (content: string) => content.startsWith('请执行需求。执行期间用户评论会作为消息进入本会话');
const hidden = (message: HistoryMessage) => !!(message.web_hidden || message.webHidden);

export type RequirementComment = { id: string; role: 'user' | 'assistant'; content: string; timestamp?: number };

/**
 * Comment tab: user comments plus the AI reply that follows each one, and
 * standalone finish summaries. Legacy also keeps the AI reply that follows a
 * web-hidden instruction and hides early internal execution prompts.
 */
export function requirementComments(messages: HistoryMessage[]): RequirementComment[] {
  const items: RequirementComment[] = [];
  let pendingUser = false;
  messages.forEach((message, index) => {
    const content = typeof message.content === 'string' ? message.content : '';
    if (message.role === 'user' && content) {
      if (!hidden(message) && !internalExecutionPrompt(content)) {
        items.push({ id: `user_${message.timestamp || index}_${index}`, role: 'user', content, timestamp: message.timestamp });
      }
      pendingUser = true;
      return;
    }
    if (message.role !== 'assistant' || !content) return;
    if (pendingUser) {
      items.push({ id: `assistant_${message.timestamp || index}_${index}`, role: 'assistant', content, timestamp: message.timestamp });
      pendingUser = false;
    } else if (finishComment(content)) {
      items.push({ id: `assistant_${message.timestamp || index}_${index}`, role: 'assistant', content, timestamp: message.timestamp });
    }
  });
  return items;
}

export function requirementCommentCount(messages: HistoryMessage[]) {
  return messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content
    && !hidden(message) && !internalExecutionPrompt(message.content)).length;
}

export function requirementLogCount(messages: HistoryMessage[]) {
  return messages.filter(message => message.role === 'assistant' && typeof message.content === 'string' && message.content).length;
}

/** Execution log tab: the same assistant-turn assembly the chat view uses. */
export function requirementLogMessages(messages: HistoryMessage[]): Message[] {
  return historyMessages(messages.filter(message => message.role !== 'user'));
}

/** Legacy normalizes `✅`/`❌` summaries that packed `1) 2)` items onto one line. */
export function normalizeRequirementComment(source: string) {
  const text = String(source || '');
  if (!text.startsWith('✅') && !text.startsWith('❌')) return text;
  const numbered = text.match(/\d+\)\s/g);
  if (!numbered || numbered.length < 2) return text;
  return text.replace(/(^|\s|[：:；;])\s*\d+\)\s*/g, '$1\n\n- ');
}
