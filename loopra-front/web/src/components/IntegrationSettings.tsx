import { useState } from 'react';
import { Button } from '@nextui-org/react';
import { ArrowLeft, Check, Pencil, Plus, Plug, Trash2 } from 'lucide-react';
import { newIntegration, validateIntegration } from '../settings-data';
import type { AgentSettings, Integration, IntegrationKind } from '../settings-data';
import { Enter } from './Motion';
import { EmptySetting, Field, PageHeader, SelectField, SettingSwitch, TextField, SettingDisclosure } from './SettingControls';

const labels = { mcp: 'MCP 服务器', lsp: 'LSP 服务器', openapi: 'OpenAPI 接口源' };
type Props = { kind: IntegrationKind; config: AgentSettings; onConfig: (value: AgentSettings) => void; notify: (text: string) => void };
export default function IntegrationSettings({ kind, config, onConfig, notify }: Props) {
  const [draft, setDraft] = useState<Integration | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Integration | null>(null);
  const list = config.integrations.filter(item => item.kind === kind && `${item.name} ${item.url} ${item.command}`.toLowerCase().includes(query.toLowerCase()));
  function edit(item?: Integration) { setError(''); setDraft(item ? { ...item, tools: [...item.tools] } : newIntegration(kind)); }
  function save() {
    if (!draft) return;
    const reason = validateIntegration(draft);
    if (reason) { setError(reason); return; }
    if (config.integrations.some(item => item.kind === kind && item.id !== draft.id && item.name.toLowerCase() === draft.name.trim().toLowerCase())) { setError('此分类中已存在同名配置'); return; }
    for (const [name, value] of [['环境变量', draft.env], ['请求头', draft.headers]]) {
      if (!value.trim()) continue;
      try { const parsed = JSON.parse(value); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some(item => typeof item !== 'string')) throw new Error(); }
      catch { setError(`${name}应为值为字符串的 JSON 对象`); return; }
    }
    const entry = { ...draft, id: draft.id || crypto.randomUUID(), name: draft.name.trim() };
    onConfig({ ...config, integrations: draft.id ? config.integrations.map(item => item.id === draft.id ? entry : item) : [...config.integrations, entry] });
    setChecked(current => current.filter(id => id !== entry.id)); setDraft(null); notify('集成配置已保存到本地');
  }
  if (draft) return <Enter>
    <PageHeader title={`${draft.id ? '编辑' : '添加'}${labels[kind]}`} description="仅保存演示配置，不启动进程、不访问网络。"><Button isIconOnly variant="light" aria-label="返回集成列表" onPress={() => setDraft(null)}><ArrowLeft size="1.125rem" /></Button></PageHeader>
    <form className="rich-settings-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <Field label="配置名称" value={draft.name} onChange={name => setDraft({ ...draft, name })} placeholder={kind === 'mcp' ? '例如：filesystem' : kind === 'lsp' ? '例如：typescript' : '例如：项目接口文档'} />
      {kind === 'mcp' && <SelectField label="传输方式" value={draft.transport} onChange={transport => setDraft({ ...draft, transport })} options={['stdio', 'SSE', 'Streamable HTTP']} />}
      {kind === 'lsp' || (kind === 'mcp' && draft.transport === 'stdio') ? <>
        <Field label="启动命令" value={draft.command} onChange={command => setDraft({ ...draft, command })} placeholder={kind === 'lsp' ? 'typescript-language-server --stdio' : 'npx'} />
        <TextField label="命令参数（每行一项）" value={draft.args} onChange={args => setDraft({ ...draft, args })} rows={2} placeholder="--stdio" />
        <TextField label="环境变量（JSON）" value={draft.env} onChange={env => setDraft({ ...draft, env })} placeholder={'{"EXAMPLE": "demo"}'} rows={2} />
      </> : <><Field label={kind === 'openapi' ? '文档地址' : '服务器 URL'} value={draft.url} onChange={url => setDraft({ ...draft, url })} placeholder={kind === 'openapi' ? 'http://localhost:8080/openapi.json' : 'http://localhost:3000/mcp'} /><TextField label="请求头（JSON）" value={draft.headers} onChange={headers => setDraft({ ...draft, headers })} placeholder={'{"X-Demo": "example"}'} rows={2} /></>}
      {kind === 'lsp' && <Field label="关联扩展名" value={draft.extensions} onChange={extensions => setDraft({ ...draft, extensions })} placeholder=".ts, .tsx, .js" />}
      {kind === 'openapi' && <><SelectField label="认证方式" value={draft.auth} onChange={auth => setDraft({ ...draft, auth })} options={[{ value: 'none', label: '无认证' }, { value: 'bearer', label: 'Bearer Token' }, { value: 'apiKey', label: 'API Key' }, { value: 'basic', label: 'Basic Auth' }]} />{draft.auth !== 'none' && <Field label="演示认证值" type="password" value={draft.token} onChange={token => setDraft({ ...draft, token })} placeholder="仅填写演示值" />}</>}
      <Field label="超时（秒）" type="number" min={1} max={600} value={draft.timeout} onChange={value => setDraft({ ...draft, timeout: Number(value) })} />
      <div className="settings-inline-heading"><span>启用此配置</span><SettingSwitch label="启用集成配置" value={draft.enabled} onChange={enabled => setDraft({ ...draft, enabled })} /></div>
      {kind === 'mcp' && <div><h3 className="settings-small-title">工具权限（演示白名单）</h3><div className="settings-choice-chips">{config.tools.map(tool => <Button type="button" size="sm" variant={draft.tools.includes(tool.name) ? 'flat' : 'bordered'} color={draft.tools.includes(tool.name) ? 'primary' : 'default'} key={tool.name} aria-pressed={draft.tools.includes(tool.name)} onPress={() => setDraft({ ...draft, tools: draft.tools.includes(tool.name) ? draft.tools.filter(name => name !== tool.name) : [...draft.tools, tool.name] })}>{draft.tools.includes(tool.name) && <Check size="0.75rem" />}{tool.name}</Button>)}</div></div>}
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="settings-save-row"><Button variant="light" onPress={() => setDraft(null)}>取消</Button><Button color="primary" type="submit">保存配置</Button></div>
    </form>
  </Enter>;
  return <>
    <PageHeader title={labels[kind]} description={kind === 'mcp' ? '传输方式、命令、环境变量和工具白名单。' : kind === 'lsp' ? '语言服务器、扩展名和环境变量。' : '接口文档、认证方式和请求头。'}><Button size="sm" variant="bordered" startContent={<Plus size="0.9375rem" />} onPress={() => edit()}>添加配置</Button></PageHeader>
    <div className="settings-search"><Field label="搜索集成配置" value={query} onChange={setQuery} placeholder="按名称、地址或命令搜索…" /></div>
    {list.map(item => <div className="settings-integration-card" key={item.id}><div className="settings-inline-heading"><div className="settings-resource-title"><Plug size="1.125rem" /><strong>{item.name}</strong><span className="tag">{item.transport}</span></div><SettingSwitch label={`启用集成：${item.name}`} value={item.enabled} onChange={enabled => { onConfig({ ...config, integrations: config.integrations.map(entry => entry.id === item.id ? { ...entry, enabled } : entry) }); }} /></div>
      <p className="settings-resource-description">{item.command || item.url}</p>
      <div className="settings-inline-heading"><span className={`settings-local-status ${checked.includes(item.id) ? 'checked' : ''}`}>{checked.includes(item.id) ? '配置有效 · 未连接真实服务' : '已保存 · 未连接'}</span><div className="settings-action-group"><Button size="sm" variant="light" onPress={() => { const reason = validateIntegration(item); if (reason) notify(reason); else { setChecked(current => [...new Set([...current, item.id])]); notify('模拟检查完成，未启动或连接任何服务'); } }}>模拟检查</Button><Button isIconOnly size="sm" variant="light" aria-label={`编辑配置：${item.name}`} onPress={() => edit(item)}><Pencil size="0.9375rem" /></Button><Button isIconOnly size="sm" variant="light" aria-label={`移除配置：${item.name}`} onPress={() => { setRemoved(item); onConfig({ ...config, integrations: config.integrations.filter(entry => entry.id !== item.id) }); }}><Trash2 size="0.9375rem" /></Button></div></div>
      <SettingDisclosure className="settings-advanced" heading="配置详情"><dl className="settings-detail-list"><dt>超时</dt><dd>{item.timeout} 秒</dd>{item.kind === 'lsp' && <><dt>扩展名</dt><dd>{item.extensions}</dd></>}{item.kind === 'mcp' && <><dt>工具白名单</dt><dd>{item.tools.join('、') || '无'}</dd></>}{item.kind === 'openapi' && <><dt>认证方式</dt><dd>{item.auth}</dd></>}<dt>环境变量 / 请求头</dt><dd>仅保存在当前浏览器，不发送</dd></dl></SettingDisclosure>
    </div>)}
    {!list.length && <EmptySetting><Plug size="1.75rem" /><h3>{query ? '没有匹配的配置' : `还没有${labels[kind]}`}</h3><p>添加本地演示配置，预览后续接入流程。</p></EmptySetting>}
    {removed && <div className="settings-undo"><span>已移除 {removed.name}</span><Button size="sm" variant="light" onPress={() => { if (!config.integrations.some(item => item.id === removed.id)) onConfig({ ...config, integrations: [...config.integrations, removed] }); setRemoved(null); }}>撤销移除</Button></div>}
  </>;
}
