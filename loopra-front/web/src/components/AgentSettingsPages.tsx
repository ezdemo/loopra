import { useRef, useState } from 'react';
import { Button, Input } from '@nextui-org/react';
import { Bot, Check, FolderClosed, Pencil, Plus, Search, Sparkles, Trash2, Wrench } from 'lucide-react';
import type { AgentProfile, AgentSettings, Extension, SkillConfig } from '../settings-data';
import { availableTools, defaultSystemPrompt, usageSummary } from '../settings-data';
import { getModelCatalog, effortLevels, type ComposerOptions } from '../composer';
import { getSessionMessages, workspaces, type Provider, type Session } from '../lib';
import { Enter } from './Motion';
import { EmptySetting, Field, ModelSelect, PageHeader, SelectField, SettingRow, SettingSwitch, TextField, SettingDisclosure, SettingSegments } from './SettingControls';
import { LoopraMark } from './ui';

export type SettingsPageProps = { config: AgentSettings; onConfig: (value: AgentSettings) => void | Promise<void>; options: ComposerOptions; onOptions: (value: ComposerOptions) => void; providers: Provider[]; sessions: Session[]; notify: (text: string) => void };
export function AgentDefaults({ config, onConfig, options, onOptions, providers }: SettingsPageProps) {
  return <>
    <div className="settings-card">
      <SettingRow title="默认权限模式" description="与输入栏的权限选择保持同步"><SelectField compact label="默认权限模式" value={options.mode} onChange={mode => onOptions({ ...options, mode })} options={['完全自动', '按需审批', '自动审批']} /></SettingRow>
      <SettingRow title="推理强度" description="与输入栏推理设置保持同步"><SelectField compact label="默认推理强度" value={options.effort} onChange={effort => onOptions({ ...options, effort })} options={[...(!effortLevels.some(level => level.value === options.effort) ? [options.effort] : []), ...effortLevels.map(level => ({ value: level.value, label: `${level.label} · ${level.description}` }))]} /></SettingRow>
      <SettingRow title="计划模式" description="启用 Loopra 会话计划模式"><SettingSwitch label="默认计划模式" value={options.plan} onChange={plan => onOptions({ ...options, plan })} /></SettingRow>
      <SettingRow title="快速模式" description="发送快速模式参数，需模型支持"><SettingSwitch label="默认快速模式" value={options.fast} onChange={fast => onOptions({ ...options, fast })} /></SettingRow>
      <SettingRow title="无工具调用时结束" description="同步到 Loopra 运行配置"><SettingSwitch label="默认无工具调用时结束" value={options.finishWithoutTools} onChange={finishWithoutTools => onOptions({ ...options, finishWithoutTools })} /></SettingRow>
    </div>
    <h2>辅助模型</h2><div className="settings-card rich-settings-card"><div className="settings-field-grid"><ModelSelect label="命令校验模型" optional models={getModelCatalog(providers)} value={config.validatorModel} onChange={validatorModel => onConfig({ ...config, validatorModel })} /><ModelSelect label="图片理解模型" optional models={getModelCatalog(providers).filter(model => model.imageInput)} value={config.imageModel} onChange={imageModel => onConfig({ ...config, imageModel })} /></div></div>
  </>;
}
export function ProjectSettings({ config, onConfig }: SettingsPageProps) {
  return <><PageHeader title="项目" description="设置新会话工作区与项目路径。" /><div className="settings-card rich-settings-card"><div className="rich-settings-form"><SelectField label="新会话默认工作区" value={config.defaultWorkspace} onChange={defaultWorkspace => onConfig({ ...config, defaultWorkspace, projectPath: workspaces.find(item => item.name === defaultWorkspace)?.path || '' })} options={workspaces.map(item => item.name)} /><Field label="项目路径" value={config.projectPath} onChange={projectPath => onConfig({ ...config, projectPath })} placeholder="例如：C:\Projects\my-app" /><p className="form-hint">路径仅用于消息上下文和复制，不读取本地目录。</p></div></div><h2>工作区</h2><div className="settings-card">{workspaces.map(item => <SettingRow key={item.name} title={item.name} description={item.name === config.defaultWorkspace ? config.projectPath : item.path}><FolderClosed size="1.25rem" /></SettingRow>)}</div></>;
}
export function ServerSettings({ config, onConfig, notify }: SettingsPageProps) {
  const [url, setUrl] = useState(config.serverUrl);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  function validate() { try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(); setError(''); return true; } catch { setError('请输入有效的 HTTP / HTTPS 地址'); return false; } }
  return <><PageHeader title="服务器" description="预览后端连接配置，当前使用浏览器本地 mock。" /><form className="settings-card rich-settings-card rich-settings-form" onSubmit={event => { event.preventDefault(); if (validate()) { onConfig({ ...config, serverUrl: url.trim() }); notify('服务器地址已保存，仅作为演示配置'); } }}><Field label="后端 API 地址" value={url} onChange={value => { setUrl(value); setChecked(false); }} placeholder="http://127.0.0.1:8080" /><div className="settings-inline-heading"><span className="settings-local-status">{checked ? '地址格式有效 · 未发起连接' : '本地 mock · 未连接后端'}</span><Button size="sm" variant="flat" onPress={() => { if (validate()) setChecked(true); }}>模拟检查</Button></div>{error && <p role="alert" className="settings-error">{error}</p>}<div className="settings-save-row"><Button color="primary" type="submit">保存地址</Button></div></form></>;
}
export function ToolSettings({ config, onConfig, options }: SettingsPageProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('全部');
  const usable = availableTools(config, options.mode);
  const filtered = config.tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()) && (filter === '全部' || (filter === '只读' ? tool.readOnly : filter === '写入' ? !tool.readOnly : !tool.enabled)));
  return <><PageHeader title="工具" description="真实工具注册表；工具开关保存到 Loopra disabledTools 配置。" /><div className="settings-metrics"><Metric label="工具总数" value={config.tools.length} /><Metric label="当前可用" value={usable.length} /><Metric label="已停用" value={config.tools.filter(tool => !tool.enabled).length} /></div><div className="settings-toolbar"><Field label="搜索工具" value={query} onChange={setQuery} placeholder="工具名称或描述…" /><SettingSegments label="工具筛选" options={['全部', '只读', '写入', '停用']} value={filter} onChange={setFilter} /></div>
    {filtered.map(tool => <div className="settings-tool-card" key={tool.name}><div className="settings-inline-heading"><div className="settings-resource-title"><Wrench size="1.0625rem" /><strong>{tool.name}</strong><span className="tag">{tool.readOnly ? '只读' : '写入'}</span></div><SettingSwitch label={`启用工具：${tool.name}`} value={tool.enabled} onChange={enabled => onConfig({ ...config, tools: config.tools.map(item => item.name === tool.name ? { ...item, enabled } : item) })} /></div><p className="settings-resource-description">{tool.description} · {tool.category}</p>{tool.enabled && !usable.some(item => item.name === tool.name) && <p className="settings-local-status">受当前权限模式或插件开关限制</p>}<SettingDisclosure className="settings-advanced" heading="参数说明"><pre className="settings-code-preview">{JSON.stringify({ name: tool.name, access: tool.readOnly ? 'read_only' : 'write', enabled: tool.enabled, mode: 'loopra', input: { task: '任务说明（示例）' } }, null, 2)}</pre></SettingDisclosure></div>)}{!filtered.length && <EmptySetting><Search size="1.5625rem" />没有匹配的工具</EmptySetting>}
  </>;
}
export function SkillSettings({ config, onConfig, notify }: SettingsPageProps) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<SkillConfig | null>(null);
  const [error, setError] = useState('');
  function save() {
    if (!draft?.name.trim() || !draft.description.trim()) { setError('请填写技能名称和描述'); return; }
    if (config.skills.some(skill => skill.id !== draft.id && skill.name === draft.name.trim())) { setError('技能名称不能重复'); return; }
    const entry = { ...draft, id: draft.id || crypto.randomUUID(), name: draft.name.trim(), description: draft.description.trim() };
    onConfig({ ...config, skills: draft.id ? config.skills.map(skill => skill.id === draft.id ? entry : skill) : [...config.skills, entry] }); setDraft(null); notify('技能已保存，可在输入栏中选择');
  }
  return <><PageHeader title="技能" description="管理本地演示技能，与输入栏技能选择同步。"><Button size="sm" variant="bordered" onPress={() => { setDraft({ id: '', name: '', description: '', enabled: true }); setError(''); }}><Plus size="0.9375rem" />添加技能</Button></PageHeader>
    {draft ? <Enter><form className="rich-settings-form settings-editor-card" onSubmit={event => { event.preventDefault(); save(); }}><Field label="技能名称" value={draft.name} onChange={name => setDraft({ ...draft, name })} /><TextField label="技能描述" value={draft.description} onChange={description => setDraft({ ...draft, description })} />{error && <p role="alert" className="settings-error">{error}</p>}<div className="settings-save-row"><Button variant="light" onPress={() => setDraft(null)}>取消</Button><Button color="primary" type="submit">保存技能</Button></div></form></Enter> : <div className="settings-search"><Field label="搜索技能设置" value={query} onChange={setQuery} placeholder="按名称或描述搜索…" /></div>}
    {config.skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())).map(skill => <div className="settings-tool-card" key={skill.id}><div className="settings-inline-heading"><div className="settings-resource-title"><Sparkles size="1.125rem" /><strong>{skill.name}</strong></div><div className="settings-action-group"><Button isIconOnly size="sm" variant="light" aria-label={`编辑技能：${skill.name}`} onPress={() => { setDraft({ ...skill }); setError(''); }}><Pencil size="0.9375rem" /></Button><SettingSwitch label={`启用技能：${skill.name}`} value={skill.enabled} onChange={enabled => onConfig({ ...config, skills: config.skills.map(item => item.id === skill.id ? { ...item, enabled } : item) })} /></div></div><p className="settings-resource-description">{skill.description}</p></div>)}
    {!config.skills.some(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())) && <EmptySetting>没有匹配的技能</EmptySetting>}<p className="section-note">这里只管理演示条目，不访问技能市场或安装脚本。停用后可随时重新启用。</p>
  </>;
}
export function SubAgentSettings({ config, onConfig, providers, notify }: SettingsPageProps) {
  const [draft, setDraft] = useState<AgentProfile | null>(null);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<AgentProfile | null>(null);
  const [isNewRole, setIsNewRole] = useState(false);
  const models = getModelCatalog(providers);
  function save() {
    if (!draft) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(draft.id) || !draft.name.trim() || !draft.instructions.trim()) { setError('请填写角色名称、提示词和有效 ID（字母、数字、_、-）'); return; }
    const existing = config.agents.find(agent => agent.id === draft.id);
    if (existing && isNewRole) { setError('角色 ID 已存在'); return; }
    const entry = { ...draft, name: draft.name.trim() };
    onConfig({ ...config, agentName: existing?.name === config.agentName ? entry.name : config.agentName, agents: existing ? config.agents.map(agent => agent.id === draft.id ? entry : agent) : [...config.agents, entry] }); setDraft(null); notify('子代理角色已保存');
  }
  return <><PageHeader title="子代理" description="角色、模型、只读属性与工具白名单。"><Button size="sm" variant="bordered" onPress={() => { setError(''); setIsNewRole(true); setDraft({ id: '', name: '', description: '', instructions: '', readOnly: true, enabled: true, modelId: '', tools: [] }); }}><Plus size="0.9375rem" />新增角色</Button></PageHeader>
    {draft ? <Enter><form className="rich-settings-form settings-editor-card" onSubmit={event => { event.preventDefault(); save(); }}><div className="settings-field-grid"><Field label="角色 ID" readOnly={!isNewRole} value={draft.id} onChange={id => { if (isNewRole) setDraft({ ...draft, id }); }} /><Field label="角色名称" value={draft.name} onChange={name => setDraft({ ...draft, name })} /></div><Field label="角色描述" value={draft.description} onChange={description => setDraft({ ...draft, description })} /><TextField label="角色系统提示词" value={draft.instructions} onChange={instructions => setDraft({ ...draft, instructions })} /><ModelSelect optional label="角色模型" models={models} value={draft.modelId} onChange={modelId => setDraft({ ...draft, modelId })} /><div className="settings-inline-heading"><span>只读角色</span><SettingSwitch label="只读角色" value={draft.readOnly} onChange={readOnly => setDraft({ ...draft, readOnly, tools: readOnly ? draft.tools.filter(name => config.tools.find(tool => tool.name === name)?.readOnly) : draft.tools })} /></div><h3 className="settings-small-title">工具白名单</h3><div className="settings-choice-chips">{config.tools.filter(tool => !draft.readOnly || tool.readOnly).map(tool => <Button type="button" size="sm" variant={draft.tools.includes(tool.name) ? 'flat' : 'bordered'} color={draft.tools.includes(tool.name) ? 'primary' : 'default'} key={tool.name} aria-pressed={draft.tools.includes(tool.name)} onPress={() => setDraft({ ...draft, tools: draft.tools.includes(tool.name) ? draft.tools.filter(name => name !== tool.name) : [...draft.tools, tool.name] })}>{draft.tools.includes(tool.name) && <Check size="0.75rem" />}{tool.name}</Button>)}</div>{error && <p role="alert" className="settings-error">{error}</p>}<div className="settings-save-row"><Button variant="light" onPress={() => setDraft(null)}>取消</Button><Button color="primary" type="submit">保存角色</Button></div></form></Enter> : config.agents.map(agent => <div className="settings-tool-card" key={agent.id}><div className="settings-inline-heading"><div className="settings-resource-title"><Bot size="1.125rem" /><strong>{agent.name}</strong><span className="tag">{agent.readOnly ? '只读' : '可写'}</span></div><SettingSwitch label={`启用角色：${agent.name}`} value={agent.enabled} onChange={enabled => onConfig({ ...config, agents: config.agents.map(item => item.id === agent.id ? { ...item, enabled } : item) })} /></div><p className="settings-resource-description">{agent.description}</p><div className="settings-choice-chips">{agent.tools.map(name => <span key={name}>{name}</span>)}</div><SettingDisclosure className="settings-advanced" heading="角色提示词"><pre className="settings-code-preview">{agent.instructions}</pre></SettingDisclosure><div className="settings-inline-heading"><span className="settings-local-status">{models.find(model => model.id === agent.modelId)?.name || '继承主模型'}</span><div className="settings-action-group"><Button size="sm" variant="light" onPress={() => { setError(''); setIsNewRole(false); setDraft({ ...agent }); }}>编辑角色</Button><Button isIconOnly size="sm" variant="light" aria-label={`移除角色：${agent.name}`} onPress={() => { setRemoved(agent); onConfig({ ...config, agents: config.agents.filter(item => item.id !== agent.id) }); }}><Trash2 size="0.875rem" /></Button></div></div></div>)}
    {!draft && !config.agents.length && <EmptySetting>暂无子代理角色</EmptySetting>}{removed && <div className="settings-undo"><span>已移除 {removed.name}</span><Button size="sm" variant="light" onPress={() => { if (!config.agents.some(agent => agent.id === removed.id)) onConfig({ ...config, agents: [...config.agents, removed] }); setRemoved(null); }}>撤销移除</Button></div>}
  </>;
}
export function PromptSettings({ config, onConfig, notify }: SettingsPageProps) {
  const [prompt, setPrompt] = useState(config.systemPrompt);
  return <><PageHeader title="系统提示词" description="编辑 Loopra 的 loopra.md，保存后重新初始化 Agent。" /><form className="rich-settings-form" onSubmit={event => { event.preventDefault(); void Promise.resolve(onConfig({ ...config, systemPrompt: prompt })).catch(error => notify(error instanceof Error ? error.message : '保存失败')); }}><TextField label="系统提示词内容" value={prompt} onChange={setPrompt} rows={12} placeholder="输入 Markdown 格式的系统提示词…" /><div className="settings-inline-heading"><span className="settings-local-status">{prompt.length} 字符{prompt !== config.systemPrompt ? ' · 有未保存修改' : ' · 已保存'}</span><div className="settings-action-group"><Button size="sm" variant="light" onPress={() => setPrompt(defaultSystemPrompt)}>恢复默认内容</Button><Button size="sm" color="primary" type="submit" isDisabled={prompt === config.systemPrompt}>保存提示词</Button></div></div></form><p className="section-note">保存到 Loopra 的 ~/.loopra/loopra.md 文件。</p></>;
}
function Metric({ label, value }: { label: string; value: number | string }) { return <div className="settings-metric"><span>{label}</span><strong>{value}</strong></div>; }
export function DashboardSettings({ sessions }: SettingsPageProps) {
  const usage = usageSummary(sessions);
  const rows = sessions.filter(session => !session.archived).map(session => ({ ...session, count: getSessionMessages(session).length }));
  const max = Math.max(1, ...rows.map(row => row.count));
  return <><PageHeader title="数据面板" description="当前浏览器保存的本地会话统计，Token 为文字长度估算。" /><div className="settings-metrics"><Metric label="活跃会话" value={usage.sessions} /><Metric label="新增消息" value={usage.messages} /><Metric label="已结束回复" value={usage.completed} /></div><div className="settings-metrics"><Metric label="输入估算 tokens" value={usage.input.toLocaleString()} /><Metric label="输出估算 tokens" value={usage.output.toLocaleString()} /><Metric label="实际费用" value="未接入" /></div><h2>会话消息量</h2><div className="settings-card rich-settings-card">{rows.map(row => <div className="settings-activity-row" key={row.id}><span title={row.title}>{row.title}</span><div><i style={{ width: `${row.count / max * 100}%` }} /></div><strong>{row.count}</strong></div>)}</div><p className="section-note">图表含内置演示消息；新增消息和 Token 估算仅统计浏览器中发送的内容，不代表供应商账单。</p></>;
}
export function ExtensionSettings({ config, onConfig, notify }: SettingsPageProps) {
  const [source, setSource] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  function add(name: string) {
    if (!name.trim()) return;
    if (config.extensions.some(item => item.source === name.trim())) { notify('此演示拓展包已存在'); return; }
    const entry: Extension = { id: crypto.randomUUID(), name: name.split(/[\\/]/).pop() || name, description: '用户添加的本地演示包', source: name.trim(), enabled: true };
    onConfig({ ...config, extensions: [...config.extensions, entry] }); setSource(''); notify('已添加演示条目，不下载或执行拓展包');
  }
  return <><PageHeader title="拓展包" description="预览 Solon H-SPI 拓展包管理，不下载、加载或执行包。" /><form className="rich-settings-form settings-editor-card" onSubmit={event => { event.preventDefault(); add(source); }}><Field label="拓展包来源" value={source} onChange={setSource} placeholder="例如：demo-tools.jar 或包地址" /><div className="settings-save-row"><Button variant="light" onPress={() => fileInput.current?.click()}>选择本地包</Button><Button color="primary" type="submit" isDisabled={!source.trim()}>添加演示条目</Button></div><Input type="file" aria-label="选择拓展包文件" className="hidden" ref={fileInput} accept=".jar,.zip" onChange={event => { if (event.target.files?.[0]) add(event.target.files[0].name); event.target.value = ''; }} /></form><div className="settings-card">{config.extensions.map(item => <SettingRow key={item.id} title={item.name} description={item.description}><SettingSwitch label={`启用拓展包：${item.name}`} value={item.enabled} onChange={enabled => onConfig({ ...config, extensions: config.extensions.map(entry => entry.id === item.id ? { ...entry, enabled } : entry) })} /></SettingRow>)}</div></>;
}
export function PetSettings({ config, onConfig }: SettingsPageProps) {
  return <><PageHeader title="宠物" description="在设置中预览 Loopra 吉祥物，也可显示在欢迎页。" /><div className={`settings-pet-preview pet-${config.petStyle === 'Loopra 蓝' ? 'blue' : 'violet'}`}><LoopraMark /><div className="pet-sparkle"><Sparkles size="1.5rem" /></div><strong>你好，Loopra</strong><p>一起把想法变成现实</p></div><div className="settings-card"><SettingRow title="欢迎页吉祥物" description="显示输入框上方的小标识"><SettingSwitch label="欢迎页吉祥物" value={config.petEnabled} onChange={petEnabled => onConfig({ ...config, petEnabled })} /></SettingRow><SettingRow title="预览风格"><SettingSegments label="宠物预览风格" options={['Loopra 蓝', '柔和紫']} value={config.petStyle} onChange={petStyle => onConfig({ ...config, petStyle })} /></SettingRow></div><p className="section-note">当前为 Web 图形预览，不创建系统桌面宠物窗口。</p></>;
}
