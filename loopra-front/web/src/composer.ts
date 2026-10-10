import type { Provider, ProviderModel } from './lib';

export type ModelOption = { id: string; name: string; providerId: string; provider: string; color?: string; contextTokens?: number; maxTokens?: number; imageInput?: boolean };
export type ComposerOptions = { modelId: string; effort: string; mode: string; plan: boolean; fast: boolean; finishWithoutTools: boolean };
export type ComposerContext = { files: string[]; projects: string[]; skills: string[]; attachments?: { name: string; text?: string; image?: string }[] };
export type PromptPreset = { id: string; name: string; text: string };
export const emptyContext: ComposerContext = { files: [], projects: [], skills: [] };
export const defaultOptions: ComposerOptions = { modelId: 'deepseek:DeepSeek V4.1 Flash', effort: 'max', mode: '完全自动', plan: false, fast: false, finishWithoutTools: false };

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

export function composeMessage(prompt: string, options: ComposerOptions, context: ComposerContext, model?: ModelOption, runtime: string[] = []) {
  const lines = [
    '本地演示配置（未连接模型或工具）',
    `模型：${model ? `${model.provider} / ${model.name}` : '未选择'}`,
    `推理强度：${options.effort} · 权限：${options.mode}`,
    `计划模式：${options.plan ? '开启' : '关闭'} · 快速模式：${options.fast ? '开启' : '关闭'} · 无工具调用时结束：${options.finishWithoutTools ? '开启' : '关闭'}`,
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
