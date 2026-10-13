import type { Provider, Session } from './lib';
import type { ComposerOptions } from './composer';

export type SkillConfig = { id: string; name: string; description: string; enabled: boolean };
export type ToolConfig = { name: string; description: string; category: string; readOnly: boolean; enabled: boolean };
export type AgentProfile = { id: string; name: string; description: string; instructions: string; readOnly: boolean; enabled: boolean; modelId: string; tools: string[] };
export type IntegrationKind = 'mcp' | 'lsp' | 'openapi';
export type Integration = { id: string; kind: IntegrationKind; name: string; enabled: boolean; transport: string; url: string; command: string; args: string; env: string; headers: string; extensions: string; timeout: number; auth: string; token: string; tools: string[] };
export type Extension = { id: string; name: string; description: string; enabled: boolean; source?: string };
export type AgentSettings = {
  codeFontSize: number; defaultWorkspace: string; projectPath: string; agentName: string; systemPrompt: string;
  serverUrl: string; browserEnabled: boolean; browser: string; headless: boolean;
  validatorModel: string; imageModel: string; tools: ToolConfig[]; skills: SkillConfig[]; agents: AgentProfile[];
  integrations: Integration[]; plugins: Extension[]; extensions: Extension[]; petEnabled: boolean;
};
export const defaultSystemPrompt = '# Loopra\n\n你是一位编程助手。先理解需求与现有代码，再给出清晰、可验证的解决方案。\n保持现有项目风格，说明改动与验证结果。';
export const defaultTools: ToolConfig[] = [
  { name: 'read', description: '读取文件与目录', category: '文件', readOnly: true, enabled: true },
  { name: 'search', description: '搜索代码与文本', category: '文件', readOnly: true, enabled: true },
  { name: 'write', description: '创建或修改文件', category: '文件', readOnly: false, enabled: true },
  { name: 'bash', description: '执行终端命令', category: '终端', readOnly: false, enabled: true },
  { name: 'browser', description: '浏览页面与检查交互', category: '浏览器', readOnly: false, enabled: true },
  { name: 'ask_choice', description: '请求用户选择', category: '协作', readOnly: true, enabled: true },
  { name: 'sub_agent', description: '委派任务给子代理', category: '协作', readOnly: false, enabled: true },
  { name: 'finish', description: '返回最终结果', category: '协作', readOnly: true, enabled: true },
];
export const defaultAgentSettings: AgentSettings = {
  codeFontSize: 12, defaultWorkspace: 'comfyui', projectPath: '~\\Documents\\ChatGPT\\comfyui', agentName: '编程助手', systemPrompt: defaultSystemPrompt,
  serverUrl: 'http://127.0.0.1:8080', browserEnabled: true, browser: '内置浏览器', headless: false,
  validatorModel: '', imageModel: '', tools: defaultTools,
  skills: [
    { id: 'review', name: '代码审查', description: '检查逻辑、边界条件与潜在回归', enabled: true },
    { id: 'frontend', name: '前端开发', description: '组件、交互与响应式布局', enabled: true },
    { id: 'testing', name: '测试验证', description: '制定测试场景与验证步骤', enabled: true },
    { id: 'debug', name: '问题排查', description: '从日志和代码定位问题', enabled: true },
    { id: 'docs', name: '文档编写', description: '整理说明、接口与使用文档', enabled: true },
  ],
  agents: [
    { id: 'explore', name: '代码探索', description: '搜索项目结构，整理实现线索', instructions: '只读分析项目，返回关键文件、调用关系与证据。', readOnly: true, enabled: true, modelId: '', tools: ['read', 'search'] },
    { id: 'reviewer', name: '代码审查', description: '关注错误、回归和边界条件', instructions: '审查变更并给出具体位置、影响与验证建议。', readOnly: true, enabled: true, modelId: '', tools: ['read', 'search', 'ask_choice'] },
  ],
  integrations: [],
  plugins: [
    { id: 'workspace', name: '工作区工具', description: '文件读取、搜索和修改', enabled: true },
    { id: 'terminal', name: '终端工具', description: '命令执行与输出解析', enabled: true },
    { id: 'browser', name: '浏览器工具', description: '页面预览与交互检查', enabled: true },
  ],
  extensions: [{ id: 'core', name: 'Loopra Core', description: '基础 Agent 能力 · 内置演示', enabled: true }],
  petEnabled: false,
};

export function availableTools(settings: AgentSettings, mode: string) {
  return settings.tools.filter(tool => tool.enabled && (mode !== '只读模式' || tool.readOnly)
    && (tool.category !== '文件' || settings.plugins.find(plugin => plugin.id === 'workspace')?.enabled !== false)
    && (tool.name !== 'bash' || settings.plugins.find(plugin => plugin.id === 'terminal')?.enabled !== false)
    && (tool.name !== 'browser' || (settings.browserEnabled && settings.plugins.find(plugin => plugin.id === 'browser')?.enabled !== false)));
}
export function runtimeSnapshot(settings: AgentSettings, workspace: string, options: ComposerOptions, autoContext: boolean) {
  const role = settings.agents.find(agent => agent.enabled && agent.name === settings.agentName);
  const tools = availableTools(settings, role?.readOnly ? '只读模式' : options.mode).filter(tool => !role || role.tools.includes(tool.name));
  return [
    `智能体：${settings.agentName}`,
    ...(autoContext ? [`当前工作区：${workspace}${workspace === settings.defaultWorkspace ? ` (${settings.projectPath})` : ''}`] : []),
    ...(settings.systemPrompt.trim() ? [`系统提示词：\n${settings.systemPrompt}`] : []),
    ...(role ? [`角色提示词：\n${role.instructions}`, `角色模型：${role.modelId || '继承主模型'}`] : []),
    `可用工具（演示）：${tools.map(tool => tool.name).join('、') || '无'}`,
    `启用集成：${settings.integrations.filter(item => item.enabled).map(item => item.name).join('、') || '无'}`,
    ...(settings.validatorModel ? [`命令校验模型：${settings.validatorModel}`] : []),
    ...(settings.imageModel ? [`图片理解模型：${settings.imageModel}`] : []),
  ];
}
// Preset endpoints from legacy `views/Settings.vue` (AI模型自动填入 → 选择服务商).
export type ProviderPreset = { name: string; baseUrl: string; type: string; compatibility?: string };
export const providerPresets: ProviderPreset[] = [
  { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', type: 'chat_completions' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', type: 'chat_completions' },
  { name: '小米', baseUrl: 'https://api.xiaomimimo.com/v1', type: 'chat_completions' },
  { name: '小米TokenPlan', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', type: 'chat_completions' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', type: 'chat_completions' },
  { name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', type: 'chat_completions', compatibility: 'opencode' },
];

/** Which preset the current address came from (empty when the user typed it). */
export function providerPresetFor(baseUrl?: string) {
  const normalized = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';
  return providerPresets.find(preset => preset.baseUrl.replace(/\/+$/, '') === normalized)?.name || '';
}

/** Filling a preset keeps a name the user already typed, like the legacy dialog. */
export function applyProviderPreset(provider: Provider, preset: ProviderPreset): Provider {
  return { ...provider, name: provider.name?.trim() ? provider.name : preset.name, baseUrl: preset.baseUrl, type: preset.type, compatibility: preset.compatibility || '' };
}

export function validateProvider(provider: Provider) {
  if (!provider.name.trim()) return '请输入供应商名称';
  if (provider.baseUrl) { try { if (!['http:', 'https:'].includes(new URL(provider.baseUrl).protocol)) return '请输入有效的 HTTP / HTTPS API 地址'; } catch { return '请输入有效的 HTTP / HTTPS API 地址'; } }
  const names = new Set<string>();
  for (const model of provider.models || []) {
    if (!model.name.trim()) return '请填写所有模型的名称';
    if (names.has(model.name.trim())) return '同一供应商内的模型名称不能重复';
    names.add(model.name.trim());
    if (![model.contextTokens, model.maxTokens].every(value => Number.isInteger(value) && value > 0)) return '上下文和最大输出必须是正整数';
    if (model.maxTokens > model.contextTokens) return '最大输出不能超过上下文窗口';
    if (![model.inputPrice, model.cachePrice, model.outputPrice].every(value => Number.isFinite(value) && value >= 0)) return '模型价格必须是非负数';
  }
  return '';
}
export function newIntegration(kind: IntegrationKind): Integration {
  return { id: '', kind, name: '', enabled: true, transport: kind === 'mcp' ? 'stdio' : kind, url: '', command: '', args: '', env: '', headers: '', extensions: '.ts, .tsx, .js', timeout: 30, auth: 'none', token: '', tools: [] };
}
export function validateIntegration(item: Integration) {
  if (!item.name.trim()) return '请输入配置名称';
  if (item.kind === 'lsp' || (item.kind === 'mcp' && item.transport === 'stdio')) { if (!item.command.trim()) return '请输入启动命令'; }
  else { try { if (!['http:', 'https:'].includes(new URL(item.url).protocol)) throw new Error(); } catch { return '请输入有效的 HTTP / HTTPS 地址'; } }
  if (!Number.isInteger(item.timeout) || item.timeout < 1 || item.timeout > 600) return '超时应为 1–600 秒的整数';
  return '';
}
export function usageSummary(sessions: Session[]) {
  const messages = sessions.flatMap(session => session.messages);
  const tokens = (role: string) => messages.filter(message => message.role === role).reduce((sum, message) => sum + Math.ceil(Array.from(message.text).length / 2), 0);
  return { sessions: sessions.filter(session => !session.archived).length, messages: messages.length, input: tokens('user'), output: tokens('assistant'), completed: messages.filter(message => message.role === 'assistant' && message.finishedAt).length };
}
