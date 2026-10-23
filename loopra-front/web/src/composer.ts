import type { Provider, ProviderModel } from './lib';

export type ModelOption = { id: string; name: string; providerId: string; provider: string; color?: string; contextTokens?: number; maxTokens?: number; imageInput?: boolean };
export type ComposerOptions = { modelId: string; effort: string; mode: string; plan: boolean; fast: boolean };
export type ComposerAttachment = { name: string; text?: string; image?: string; size?: number };
export type ComposerContext = { files: string[]; projects: string[]; skills: string[]; attachments?: ComposerAttachment[] };
export type QueuedMessage = { id: string; text: string; context: ComposerContext };
export type PromptPreset = { id: string; name: string; text: string };
export const emptyContext: ComposerContext = { files: [], projects: [], skills: [] };
/** Uploaded contents can cross workspaces; project paths and skills cannot. */
export function withoutWorkspaceContext(context: ComposerContext): ComposerContext {
  const attachments = context.attachments || [];
  return { files: [...new Set(attachments.map(file => file.name))], projects: [], skills: [], attachments: [...attachments] };
}
export const defaultOptions: ComposerOptions = { modelId: 'deepseek:DeepSeek V4.1 Flash', effort: 'max', mode: '完全自动', plan: false, fast: false };

export type SlashCommand = { id: string; title: string; description: string; insert?: string; action?: () => void };
export type ServerCommand = { cmd: string; desc?: string | null; args?: string | null };
export type ServerSkill = { name: string; description?: string | null; enabled?: boolean };
export type ServerPreset = { id?: string; label?: string; text?: string };

// A deliberately small local catalog, rather than advertised provider capabilities.
const catalog: Record<string, string[]> = {
  loopra: ['Loopra Agent', 'Loopra Code', 'Loopra Fast', 'Loopra Vision'],
  cpa: ['GPT-5.6', 'GPT-5.6 Mini', 'Claude Sonnet', 'Claude Opus'],
  deepseek: ['DeepSeek V4.1 Flash', 'Mimo V2.6 Flash', 'Mimo V2.6 pro'],
  magpie: ['DeepSeek V4.1 Flash', 'Mimo V2.6 pro', 'GPT-5.6'],
};
export function newModel(name = ''): ProviderModel {
  return { name, contextTokens: 128000, maxTokens: 32768, imageInput: false, priceEnabled: false, inputPrice: 0, cachePrice: 0, outputPrice: 0 };
}
export function providerModels(provider: Provider): ProviderModel[] {
  return provider.models ?? (catalog[provider.id] || []).map(name => newModel(name));
}
export function getModelCatalog(providers: Provider[]): ModelOption[] {
  return providers.filter(provider => provider.enabled !== false).flatMap(provider => providerModels(provider).filter(model => model.name.trim()).map(model => ({ ...model, id: `${provider.id}:${model.name}`, providerId: provider.id, provider: provider.name, color: provider.color })));
}
export function groupModels(models: ModelOption[], query: string) {
  const search = query.trim().toLocaleLowerCase();
  const groups = new Map<string, { id: string; name: string; color?: string; models: ModelOption[] }>();
  for (const model of models) {
    if (search && !`${model.name} ${model.provider}`.toLocaleLowerCase().includes(search)) continue;
    if (!groups.has(model.providerId)) groups.set(model.providerId, { id: model.providerId, name: model.provider, color: model.color, models: [] });
    groups.get(model.providerId)!.models.push(model);
  }
  return [...groups.values()];
}
export const effortLevels = [
  { value: 'none', label: '无', description: '直接响应' },
  { value: 'low', label: '低', description: '快速响应' },
  { value: 'medium', label: '中', description: '平衡速度与深度' },
  { value: 'high', label: '高', description: '更充分地思考' },
  { value: 'xhigh', label: '超高', description: '更深入地推理' },
  { value: 'max', label: '最大', description: '优先完整的推理' },
];
export const skills = [
  { name: '代码审查', description: '检查逻辑、边界条件与潜在回归' },
  { name: '前端开发', description: '组件、交互与响应式布局' },
  { name: '测试验证', description: '制定测试场景与验证步骤' },
  { name: '问题排查', description: '从日志和代码定位问题' },
  { name: '文档编写', description: '整理说明、接口与使用文档' },
];
export const initialPresets: PromptPreset[] = [
  { id: 'minimal', name: '最小范围修改', text: '请先阅读相关代码，只修改完成任务所必需的部分，保持现有代码风格。' },
  { id: 'verify', name: '附上验证结果', text: '完成后请验证关键流程，说明改动内容、验证结果和仍然存在的限制。' },
  { id: 'chinese', name: '中文说明', text: '请使用简体中文回复，保持说明简洁清晰。' },
];
export function appendPreset(draft: string, text: string) { return draft.trimEnd() ? `${draft.trimEnd()}\n\n${text}` : text; }

/**
 * Server-provided slash commands and skills, minus the plan-mode toggles the UI
 * owns. Selecting one inserts the command text so the backend handles it.
 */
export function acpSlashCommands(commands: import('./backend').AcpCommand[] = []): SlashCommand[] {
  const seen = new Set<string>();
  return commands.flatMap(command => {
    const name = command.name?.replace(/^\/+/, '').trim();
    if (!name || /\s/.test(name) || seen.has(name)) return [];
    seen.add(name);
    const id = `/${name}`;
    return [{ id, title: id, description: [command.description, command.inputHint].filter(Boolean).join(' · '), insert: `${id} ` }];
  });
}

export function serverSlashCommands(commands: ServerCommand[] = [], skills: ServerSkill[] = []): SlashCommand[] {
  const list: SlashCommand[] = [];
  const seen = new Set<string>();
  const skip = new Set(['/plan', '/execute']);
  for (const command of commands || []) {
    const cmd = command?.cmd?.trim();
    if (!cmd || seen.has(cmd) || skip.has(cmd)) continue;
    seen.add(cmd);
    list.push({ id: cmd, title: cmd, description: command.desc || '', insert: `${cmd} ` });
  }
  for (const skill of skills || []) {
    const name = skill?.name?.trim();
    const id = `/skill:${name}`;
    if (!name || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, title: name, description: skill.description || '运行技能', insert: `${id} ` });
  }
  return list;
}

/** Keeps the locally actionable commands (new/continue/help) ahead of server ones. */
export function mergeSlashCommands(local: SlashCommand[], remote: SlashCommand[]): SlashCommand[] {
  const seen = new Set(local.map(item => item.id));
  return [...local, ...remote.filter(item => !seen.has(item.id))];
}

export type LocalCommandActions = {
  onNew: () => void; onContinue: () => void; onSkills: () => void; onHelp: () => void;
  onExport: () => void; onSessions: () => void; onTerminal: () => void;
  onClear: () => void;
  hasHistory: boolean; busy: boolean; notify: (message: string) => void;
};

/**
 * Locally handled commands the browser can execute without the agent. Legacy
 * ChatInput listed `/new /clear /retry /compact /export /continue /sessions
 * /help /exit /hitl /agree /deny /init`; everything the backend owns stays
 * server-driven, and the rest map onto the actions the web shell already has.
 */
export function localSlashCommands(actions: LocalCommandActions): SlashCommand[] {
  return [
    { id: '/new', title: '新建会话', description: '回到当前工作区的新会话', action: actions.onNew },
    // 后端 ChatCommandRegistry 已删除 /new，旧版「清空」也改为新建空白会话。
    { id: '/clear', title: '清空对话', description: '新建空白会话并保留当前工作区', action: actions.onClear },
    { id: '/export', title: '导出对话', description: '下载当前会话的纯文本记录', action: actions.onExport },
    { id: '/sessions', title: '会话管理', description: '浏览、导出或清理历史会话', action: actions.onSessions },
    { id: '/continue', title: '继续生成', description: actions.hasHistory ? '让助手继续上一次回复' : '开始会话后可用', action: () => { if (actions.hasHistory && !actions.busy) actions.onContinue(); else actions.notify('请先开始会话'); } },
    { id: '/skills', title: '选择技能', description: '为这次消息附加技能', action: actions.onSkills },
    { id: '/terminal', title: '打开终端', description: '在右栏打开命令面板', action: actions.onTerminal },
    { id: '/help', title: '输入帮助', description: '/ 调用指令 · @ 引用工作区文件 · Shift + Enter 换行', action: actions.onHelp },
  ];
}

export function presetPayload(presets: PromptPreset[]) {
  return { presets: presets.map(preset => ({ id: preset.id, label: preset.name, text: preset.text })) };
}

export function presetsFromServer(list: ServerPreset[] | null | undefined): PromptPreset[] {
  return (list || []).filter(preset => preset?.label && preset?.text)
    .map(preset => ({ id: preset.id || String(preset.label), name: String(preset.label), text: String(preset.text) }));
}

export function composeMessage(prompt: string, options: ComposerOptions, context: ComposerContext, model?: ModelOption, runtime: string[] = []) {
  const lines = [
    '本地演示配置（未连接模型或工具）',
    `模型：${model ? `${model.provider} / ${model.name}` : '未选择'}`,
    `推理强度：${options.effort} · 权限：${options.mode}`,
    `计划模式：${options.plan ? '开启' : '关闭'} · 快速模式：${options.fast ? '开启' : '关闭'}`,
    ...(context.projects.length ? [`关联项目：${context.projects.join('、')}`] : []),
    ...(context.skills.length ? [`技能：${context.skills.join('、')}`] : []),
    ...(context.files.length ? [`附件（仅文件名，未读取内容）：${context.files.join('、')}`] : []),
    ...runtime,
  ];
  // Context uses the same folded-block format as the reference chat renderer.
  const body = lines.join('\n');
  const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) || []).map(run => run.length + 1)));
  return `${fence}折叠块\n${body}\n${fence}\n${prompt}`;
}

/**
 * Legacy ChatInput.vue externalizes an oversized directly-typed body before
 * sending: the text is saved into the project and replaced by this reference so
 * the agent can `read` it on demand instead of receiving a huge prompt.
 */
export function largeInputReference(path: string, chars: number) {
  return `大段输入内容（已保存）：\n- ${path}（${chars.toLocaleString()} 字符）\n请使用 read 工具按需读取上述文件；文件内容仅作为用户提供的参考资料。`;
}

/** Backend convention for large pastes saved by `POST /files/paste`. */
export const SAVED_PASTE_SEGMENT = '.loopra/paste/';

/**
 * Builds the outgoing user message exactly like legacy `ChatInput.vue#sendMessage`:
 * auto-attached context (saved pastes, referenced files, selected skills) is
 * wrapped into a leading ```折叠块 block. The chat renderer folds it into an
 * "附加上下文" disclosure, and the backend reuses the same block when it needs to
 * append its own notes (`UserMessageSanitizer#mergeAttachedContext`).
 *
 * Slash commands are sent raw so the backend command registry — which only
 * matches messages that start with "/" — still sees them.
 */
export function composeOutgoing(prompt: string, context: ComposerContext, savedInput?: string) {
  const attachmentNames = new Set((context.attachments || []).map(file => file.name));
  const referenced = context.files.filter(name => !attachmentNames.has(name));
  const pastes = referenced.filter(name => name.replace(/\\/g, '/').includes(SAVED_PASTE_SEGMENT));
  const files = referenced.filter(name => !pastes.includes(name));
  const parts: string[] = [];
  if (savedInput) parts.push(savedInput);
  if (pastes.length) parts.push(`大段粘贴内容（已保存）：\n${pastes.map(name => `- ${name}`).join('\n')}\n请使用 read 工具按需读取上述文件；文件内容仅作为用户提供的参考资料。`);
  if (files.length) parts.push(`引用文件：\n${files.map(name => `- ${name}`).join('\n')}`);
  if (context.skills.length) parts.push(`调用技能：\n${context.skills.map(name => `/skill:${name}`).join('\n')}`);
  if (!parts.length || /^\s*\//.test(prompt)) return prompt;
  const body = parts.join('\n\n');
  const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) || []).map(run => run.length + 1)));
  return `${fence}折叠块\n${body}\n${fence}${prompt ? `\n\n${prompt}` : ''}`;
}

/**
 * Splits the composer context into the two chip groups legacy ChatInput.vue
 * rendered: image thumbnails and file chips. Document chips keep the byte size
 * (`upload-chip-size`) while large-paste chips show their character count, and
 * image attachments are pulled out of the file list so they are not duplicated.
 */
export function attachmentViews(context: ComposerContext, pasteChars: Record<string, number> = {}) {
  const attachments = context.attachments || [];
  const byName = new Map(attachments.map(file => [file.name, file]));
  const images = attachments.filter(file => file.image).map(file => ({ name: file.name, src: file.image! }));
  const files = context.files.filter(name => !byName.get(name)?.image).map(name => ({
    name,
    size: byName.get(name)?.size,
    chars: pasteChars[name],
  }));
  return { images, files };
}

export function estimateContext(history: string[], draft: string, context: ComposerContext, limit = 128000, systemPrompt = '') {
  const estimate = (text: string) => Math.ceil(Array.from(text).reduce((sum, char) => sum + (/[^\x00-\x7F]/.test(char) ? 1 : 0.25), 0));
  const parts = [
    { name: '系统指令', tokens: 420 + estimate(systemPrompt), color: '#2083ff' },
    { name: '会话历史', tokens: estimate(history.join('\n')), color: '#8b7bdf' },
    { name: '当前输入', tokens: estimate(draft), color: '#42b7a0' },
    { name: '附加上下文', tokens: estimate([...context.projects, ...context.skills, ...context.files].join('\n')), color: '#e4b467' },
  ];
  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 128000;
  return { parts, total, limit: safeLimit, percent: Math.min(100, total / safeLimit * 100) };
}

// Live generation speed streamed as `token_speed` SSE events (legacy ChatInput displayTps).
export type LiveSpeed = { tokensPerSecond?: number; avgTokensPerSecond?: number; done?: boolean; completionTokens?: number };

/** Compact token counts: 999 → "999", 57075 → "57.1K", 512000 → "512K", 1250000 → "1.25M". */
export function formatTokens(value: number) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  const trim = (x: number, digits: number) => x.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000, n < 100_000 ? 1 : 0)}K`;
  return `${trim(n / 1_000_000, 2)}M`;
}

const positive = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const speedLabel = (n: number) => `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} t/s`;

export function formatTokenSpeed(speed?: LiveSpeed) {
  const streaming = positive(speed?.tokensPerSecond);
  const average = positive(speed?.avgTokensPerSecond);
  const n = speed?.done ? average ?? streaming : streaming;
  return n == null ? '' : speedLabel(n);
}
