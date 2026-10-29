export type ToolStatus = '成功' | '执行中' | '失败';
export type FileChange = { path: string; additions: number; deletions: number; created?: boolean; diff?: string };
export type ChatBlock =
  // `reasoning_started` marks a slot the model opened without streaming visible
  // tokens (encrypted reasoning); it upgrades to `reasoning` on the first delta.
  | { id: string; type: 'content' | 'reasoning' | 'reasoning_started'; content: string }
  | { id: string; type: 'tool_call'; toolCallId?: string; name: string; status: ToolStatus; args?: Record<string, unknown>; result?: string; duration?: string }
  | { id: string; type: 'file_changes'; changes: FileChange[] }
  | { id: string; type: 'checklist'; title: string; steps: { description: string; status: 'done' | 'active' | 'pending'; result?: string }[] }
  | { id: string; type: 'sub_agent'; name: string; status: ToolStatus; blocks: ChatBlock[] }
  | { id: string; type: 'choice'; question: string; description?: string; subId?: string; permissionRequestId?: string; options: { title: string; value?: string; description?: string }[]; selected?: string };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; blocks?: ChatBlock[]; time?: string; startedAt?: number; finishedAt?: number; historyCount?: number; rollbackId?: string; snapshotId?: string; rollbackTimestamp?: number; images?: string[] };

// Accept longer fences when a system prompt itself contains Markdown code blocks.
export function splitUserContext(text: string) {
  const match = /^(`{3,})折叠块[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(?:\r?\n|$)(?:\r?\n)*/.exec(text);
  return match ? { context: match[2], text: text.slice(match[0].length) } : { context: '', text };
}

// Same final-response boundary as the reference WEB ChatMessage.vue.
// File changes remain visible alongside the answer, outside the folded process.
export function splitAssistantBlocks(blocks: ChatBlock[]) {
  const body = blocks.filter(block => block.type !== 'file_changes');
  let start = -1;
  for (let index = body.length - 1; index >= 0; index--) {
    const block = body[index];
    if ((block.type === 'content' && block.content.trim()) || block.type === 'choice' || (block.type === 'tool_call' && ['finish', 'ask_choice'].includes(block.name))) {
      start = index;
      break;
    }
  }
  return {
    process: start > 0 ? body.slice(0, start) : [],
    final: [...(start >= 0 ? body.slice(start) : body), ...blocks.filter(block => block.type === 'file_changes')],
  };
}

export type BlockGroup = { id: string; type: 'tool_group'; tools: Extract<ChatBlock, { type: 'tool_call' }>[] };

/** Legacy `Chat.vue` scroll threshold: within this distance of the bottom counts as "at bottom". */
export const CHAT_SCROLL_THRESHOLD = 80;

/** Legacy `isNearBottom()` for the message scroller. */
export function chatNearBottom(element: { scrollHeight: number; scrollTop: number; clientHeight: number } | null, threshold = CHAT_SCROLL_THRESHOLD) {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
}

/** Legacy `truncateText()` used by the message thumbnail dock. */
export function truncatePreview(text: string, max = 40) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** Legacy dock lists user messages only, with their index in the full message list. */
export function userMessageDock(messages: { id: string; role: string; text: string }[]) {
  return messages.map((message, index) => ({ ...message, globalIndex: index })).filter(message => message.role === 'user');
}

/**
 * Legacy `onScroll()` decision: streamed content pushes the viewport up without
 * the user leaving, so only an upward movement (or staying away from the
 * bottom) marks `away`; returning near the bottom resumes auto-follow.
 */
export function chatScrollState(element: { scrollHeight: number; scrollTop: number; clientHeight: number } | null, previousTop: number, away: boolean, threshold = CHAT_SCROLL_THRESHOLD) {
  if (!element) return { away, showScrollButton: false };
  const nearBottom = chatNearBottom(element, threshold);
  const next = element.scrollTop < previousTop - 2 ? true : nearBottom ? false : away;
  return { away: next, showScrollButton: !nearBottom };
}

export function groupToolBlocks(blocks: ChatBlock[]): (ChatBlock | BlockGroup)[] {
  const groups: (ChatBlock | BlockGroup)[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type !== 'tool_call' || ['finish', 'ask_choice'].includes(block.name)) { groups.push(block); continue; }
    const tools = [block];
    while (index + 1 < blocks.length) {
      const next = blocks[index + 1];
      if (next.type !== 'tool_call' || ['finish', 'ask_choice'].includes(next.name)) break;
      tools.push(next); index++;
    }
    groups.push(tools.length > 1 ? { id: `group-${block.id}`, type: 'tool_group', tools } : block);
  }
  return groups;
}

export type ChainGroup = { id: string; type: 'chain'; steps: ChatBlock[] };

const isChainStep = (block: ChatBlock) => block.type === 'reasoning' || block.type === 'reasoning_started' || block.type === 'sub_agent'
  || (block.type === 'tool_call' && !['finish', 'ask_choice'].includes(block.name));

/**
 * Folds runs of consecutive thinking / tool / sub-agent steps into one "reasoning chain".
 * A lone step stays a plain block; the final answer, file changes, checklists and
 * choices break a chain.
 */
export function chainBlocks(blocks: ChatBlock[]): (ChatBlock | ChainGroup)[] {
  const out: (ChatBlock | ChainGroup)[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!isChainStep(block)) { out.push(block); continue; }
    const steps = [block];
    while (index + 1 < blocks.length && isChainStep(blocks[index + 1])) steps.push(blocks[++index]);
    out.push(steps.length > 1 ? { id: `chain-${block.id}`, type: 'chain', steps } : block);
  }
  return out;
}

export type ChoiceBlockData = Extract<ChatBlock, { type: 'choice' }>;

/**
 * Unresolved choice cards (HITL approval / ask_choice) in declaration order,
 * including ones nested inside sub-agent containers. The composer popup walks
 * these one by one; `resolveChoiceBlock` marks each answered card so it drops
 * out of the list.
 */
export function collectPendingChoices(messages: Message[]): ChoiceBlockData[] {
  const found: ChoiceBlockData[] = [];
  const visit = (blocks?: ChatBlock[]) => {
    for (const block of blocks || []) {
      if (block.type === 'choice') { if (!block.selected) found.push(block); }
      else if (block.type === 'sub_agent') visit(block.blocks);
    }
  };
  for (const message of messages) if (message.role === 'assistant') visit(message.blocks);
  return found;
}

/** Marks one choice card (by id) resolved with the picked option label. */
export function resolveChoiceBlock(blocks: ChatBlock[], id: string, label: string): ChatBlock[] {
  return blocks.map(block => block.id === id && block.type === 'choice'
    ? { ...block, selected: label }
    : block.type === 'sub_agent' ? { ...block, blocks: resolveChoiceBlock(block.blocks, id, label) } : block);
}

/** The choice cards a just-finished stream left unanswered (HITL pending). */
export function unresolvedChoices(blocks?: ChatBlock[]): ChoiceBlockData[] {
  return (blocks || []).filter((block): block is ChoiceBlockData => block.type === 'choice' && !block.selected);
}

/**
 * Reattaches client-only pending choices to a reloaded transcript. The server
 * folds a whole approval loop (prompt → approve ×N) into one assistant turn and
 * never persists the suspended turn, so the reload drops the pending card; this
 * puts it back on the last assistant message.
 */
export function attachPendingChoices(messages: Message[], choices: ChoiceBlockData[]): Message[] {
  if (!choices.length) return messages;
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') return [...messages.slice(0, -1), { ...last, blocks: [...(last.blocks || []), ...choices] }];
  return [...messages, { id: `pending-${choices[0].id}`, role: 'assistant', text: '', blocks: [...choices] }];
}

const apiAnswer = `可以的，ComfyUI 提供了 HTTP API 和 WebSocket 接口，可以直接接入自研前端。

### 常用接口

| 接口 | 用途 |
| --- | --- |
| \`POST /prompt\` | 提交工作流，返回任务 ID |
| \`POST /upload/image\` | 上传输入图片 |
| \`GET /history/{prompt_id}\` | 查询任务结果与输出文件 |
| \`GET /view\` | 按文件名读取生成图片 |
| \`GET /object_info\` | 查询节点及其参数 |
| \`GET /system_stats\` | 查询显存与系统状态 |

### 最小调用示例

把工作流导出为 API 格式后，通过 \`/prompt\` 提交：

\`\`\`python
import json
import uuid
import requests

with open("workflow_api.json", encoding="utf-8") as file:
    workflow = json.load(file)

response = requests.post(
    "http://127.0.0.1:8188/prompt",
    json={"prompt": workflow, "client_id": str(uuid.uuid4())},
    timeout=30,
)
response.raise_for_status()
print(response.json()["prompt_id"])
\`\`\`

### 实时进度

使用 \`ws://127.0.0.1:8188/ws\` 订阅进度，处理 \`executing\`、\`progress\`、\`executed\` 和 \`execution_error\` 消息。任务完成后，再查询 history 取得输出文件。

> 默认监听本机地址。对外提供访问时，需要自行配置鉴权与跨域。

以上为本地示例，代码尚未实际调用 ComfyUI。`;

export const demoMessages: Record<'api' | 'repair' | 'demo', Message[]> = {
  api: [
    { id: 'api-user', role: 'user', text: 'comfui支持传出api嘛?', time: '14:24' },
    { id: 'api-answer', role: 'assistant', text: apiAnswer, time: '14:25', startedAt: 1000, finishedAt: 19000, blocks: [
      { id: 'api-reasoning', type: 'reasoning', content: '示例执行计划：查看服务端路由和调用示例，整理 HTTP 接口、WebSocket 进度与前端接入方式。' },
      { id: 'api-read', type: 'tool_call', name: 'read', status: '成功', args: { file_path: 'server.py', offset: 700, limit: 160 }, result: '已找到 /prompt、/history、/view、/object_info 和 /system_stats 路由。', duration: '0.3s' },
      { id: 'api-grep', type: 'tool_call', name: 'grep', status: '成功', args: { pattern: 'websocket|progress|executed', path: 'script_examples/' }, result: 'script_examples/websockets_api_example.py: WebSocket 进度订阅示例', duration: '0.2s' },
      { id: 'api-finish', type: 'tool_call', name: 'finish', status: '成功', result: apiAnswer },
    ] },
  ],
  repair: [
    { id: 'repair-user', role: 'user', text: 'Loopra 有个会话坏了，帮我修复下 400 [code=upstream_error]，重启后也要能正常恢复。', time: '21:07' },
    { id: 'repair-answer', role: 'assistant', text: '已修复会话事件日志，并同步服务端副本。', time: '21:08', startedAt: 1000, finishedAt: 43000, blocks: [
      { id: 'repair-reasoning', type: 'reasoning', content: '示例执行计划：检查会话事件的完整性，备份原始数据，再同步修复本地记录和服务端副本。' },
      { id: 'repair-read', type: 'tool_call', name: 'read', status: '成功', args: { file_path: 'server/events/session_1f2583b1.json' }, result: '读取 128 条事件，发现 1 条未完成的工具响应。', duration: '0.3s' },
      { id: 'repair-grep', type: 'tool_call', name: 'grep', status: '成功', args: { pattern: 'upstream_error|tool_call', path: 'server/events/' }, result: '已定位到错误事件与对应的工具调用。', duration: '0.2s' },
      { id: 'repair-bash', type: 'tool_call', name: 'bash', status: '成功', args: { command: 'cd ~/.loopra && python repair_session.py --backup --sync' }, result: 'Backup created: session_1f2583b1.json.bak\nValidated 128 events\nRepaired 1 incomplete tool response\nServer copy synchronized\nSession restored successfully.', duration: '1.4s' },
      { id: 'repair-checklist', type: 'checklist', title: '修复与验证', steps: [
        { description: '备份原始会话记录', status: 'done', result: '已保留 .bak 副本' },
        { description: '补全工具响应并同步服务端副本', status: 'done', result: '128 条事件校验通过' },
        { description: '验证重启后的会话恢复', status: 'done', result: '示例验证通过' },
      ] },
      { id: 'repair-finish', type: 'tool_call', name: 'finish', status: '成功', result: '已修复会话事件日志，并同步了服务端副本。\n\n- **原因**：一次工具调用缺少对应的响应，导致恢复会话时请求返回 400。\n- **处理**：备份原始事件，补全异常记录，重新校验事件顺序。\n- **结果**：128 条事件校验通过，重启后可以从修复后的副本恢复。\n\n> 这是 mock 修复记录，未读写真实会话文件。' },
      { id: 'repair-files', type: 'file_changes', changes: [{ path: 'input/editweb/_hack_scan.py', additions: 25, deletions: 3 }] },
    ] },
  ],
  demo: [
    { id: 'demo-user', role: 'user', text: '```折叠块\n工作区：loopra-web-ui\n界面模式：本地 mock\n```\n展示一下 Agent 的聊天内容块。', time: '10:30' },
    { id: 'demo-answer', role: 'assistant', text: '已整理聊天内容块示例。', time: '10:31', startedAt: 1000, finishedAt: 27000, blocks: [
      { id: 'demo-reasoning', type: 'reasoning', content: '示例执行计划：检查消息结构，展示工具调用、子代理、Markdown 与文件改动。所有记录均为静态演示数据。' },
      { id: 'demo-tool-read', type: 'tool_call', name: 'read', status: '成功', args: { file_path: 'src/components/Conversation.tsx' }, result: '已读取聊天组件。', duration: '0.2s' },
      { id: 'demo-tool-bash', type: 'tool_call', name: 'bash', status: '成功', args: { command: 'npm run build' }, result: 'TypeScript 检查通过\n✓ built in 5.99s\n（示例输出）', duration: '6.0s' },
      { id: 'demo-sub', type: 'sub_agent', name: '界面检查', status: '成功', blocks: [
        { id: 'demo-sub-read', type: 'tool_call', name: 'read', status: '成功', args: { file_path: 'src/styles.css' }, result: '已检查明暗主题与窄屏样式。', duration: '0.1s' },
        { id: 'demo-sub-content', type: 'content', content: '消息内容与工具块使用相同的主题变量，窄屏下可正常换行。' },
      ] },
      { id: 'demo-finish', type: 'tool_call', name: 'finish', status: '成功', result: '### 聊天内容块已就绪\n\n沿用 Loopra WEB 的消息结构：\n\n- [x] 用户消息与附加上下文\n- [x] 可折叠的执行过程与工具分组\n- [x] Markdown、表格和代码块\n- [x] 文件改动、子代理与选项交互\n\n```tsx\nfunction Welcome() {\n  return <h1>Hello, Loopra</h1>;\n}\n```\n\n> 展开上方「用时 26秒」可以查看示例工具与子代理记录。' },
    ] },
    { id: 'demo-choice', role: 'assistant', text: '接下来想看哪种示例？', time: '10:31', blocks: [
      { id: 'demo-choice-block', type: 'choice', question: '接下来想看哪种示例？', description: '选择后会填入输入框，你可以继续发送。', options: [
        { title: 'API 接入', description: '查看接口说明、表格与代码示例' },
        { title: '排查错误', description: '查看执行过程、工具结果与修复建议' },
      ] },
    ] },
  ],
};

// Sub-second turns floor to 0, which would read as a stuck clock; say "<1秒" instead.
export function formatTurnDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 1) return '<1秒';
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes + '分' + (seconds % 60 ? (seconds % 60) + '秒' : '');
}

export function mockProcess(prompt: string): ChatBlock[] {
  return [{ id: 'mock-plan', type: 'reasoning', content: `示例执行计划：梳理「${prompt.slice(0, 80)}」的需求，整理相关上下文，再给出处理建议。当前未调用模型或真实工具。` }];
}
