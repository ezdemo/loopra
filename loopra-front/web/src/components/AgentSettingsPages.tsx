import { useState } from 'react';
import { Button } from '@nextui-org/react';
import type { AgentSettings } from '../settings-data';
import { defaultSystemPrompt } from '../settings-data';
import { effortLevels, type ComposerOptions } from '../composer';
import type { Provider, Session } from '../lib';
import { PageActions, SelectField, SettingRow, SettingSwitch, TextField } from './SettingControls';

// 设置页里只有「会话默认」和「系统提示词」仍走本地 props（由 App 统一持久化到后端）。
// 服务器 / 项目 / 工具 / 技能 / 子代理 / 数据面板 / 拓展包 / 集成（MCP·OpenAPI）
// 都已迁移到后端驱动页（BackendSettings / ResourceManagers / UsageDashboard / IntegrationManager）。
// 历史上这里还有一批本地 mock 实现，与旧 legacy.html 的「演示配置」语义混淆，已删除。
export type SettingsPageProps = { config: AgentSettings; onConfig: (value: AgentSettings) => void | Promise<void>; options: ComposerOptions; onOptions: (value: ComposerOptions) => void; providers: Provider[]; sessions: Session[]; notify: (text: string) => void };
export function AgentDefaults({ options, onOptions }: SettingsPageProps) {
  return <>
    <div className="settings-card">
      <SettingRow title="默认权限模式" description="与输入栏的权限选择保持同步"><SelectField compact label="默认权限模式" value={options.mode} onChange={mode => onOptions({ ...options, mode })} options={['完全自动', '按需审批', '自动审批']} /></SettingRow>
      <SettingRow title="推理强度" description="与输入栏推理设置保持同步"><SelectField compact label="默认推理强度" value={options.effort} onChange={effort => onOptions({ ...options, effort })} options={[...(!effortLevels.some(level => level.value === options.effort) ? [options.effort] : []), ...effortLevels.map(level => ({ value: level.value, label: `${level.label} · ${level.description}` }))]} /></SettingRow>
      <SettingRow title="计划模式" description="启用 Loopra 会话计划模式"><SettingSwitch label="默认计划模式" value={options.plan} onChange={plan => onOptions({ ...options, plan })} /></SettingRow>
      <SettingRow title="快速模式" description="发送快速模式参数，需模型支持"><SettingSwitch label="默认快速模式" value={options.fast} onChange={fast => onOptions({ ...options, fast })} /></SettingRow>
    </div>
  </>;
}
export function PromptSettings({ config, onConfig, notify }: SettingsPageProps) {
  const [prompt, setPrompt] = useState(config.systemPrompt);
  return <><PageActions title="系统提示词" /><form className="rich-settings-form" onSubmit={event => { event.preventDefault(); void Promise.resolve(onConfig({ ...config, systemPrompt: prompt })).catch(error => notify(error instanceof Error ? error.message : '保存失败')); }}><TextField label="系统提示词内容" value={prompt} onChange={setPrompt} rows={12} placeholder="输入 Markdown 格式的系统提示词…" /><div className="settings-inline-heading"><span className="settings-local-status">{prompt.length} 字符{prompt !== config.systemPrompt ? ' · 有未保存修改' : ' · 已保存'}</span><div className="settings-action-group"><Button size="sm" variant="light" onPress={() => setPrompt(defaultSystemPrompt)}>恢复默认内容</Button><Button size="sm" color="primary" type="submit" isDisabled={prompt === config.systemPrompt}>保存提示词</Button></div></div></form><p className="section-note">保存到 Loopra 的 ~/.loopra/loopra.md 文件。</p></>;
}
