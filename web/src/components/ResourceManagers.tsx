import { useState } from 'react';
import { Button } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { ConfirmAction, errorText, RemoteState, useRemote } from './RemoteControls';
import { PageActions, Field, SettingDisclosure, ResourceIcon, ResourceEmpty } from './SettingControls';

type ToolParam = { name: string; description?: string; type?: string; required?: boolean };
type Tool = { name: string; description: string; readOnly: boolean; readOnlyOverride: boolean | null; stormExempt: boolean; enabled: boolean; autoApproved: boolean; params?: ToolParam[] };
export { default as SubAgentManager } from './SubAgentManager';
type Pack = { id: string; displayName?: string; remark?: string; description?: string; enabled: boolean; source?: string; sourceUrl?: string; state?: string; error?: string; tools?: string[]; hooks?: string[]; version?: string };
function pluginMeta(pack: Pack) {
  const parts = [pack.tools?.join('、'), pack.hooks?.length ? `钩子 ${pack.hooks.join('、')}` : ''].filter(Boolean);
  return parts.join(' · ') || pack.source || pack.sourceUrl || pack.id;
}
export function ExtensionManager({ api }: { api: LoopraClient }) {
  const [revision, setRevision] = useState(0); const state = useRemote<Pack[]>(api, '/plugins', revision); const [source, setSource] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [deleting, setDeleting] = useState<Pack>();
  async function act(path: string, body?: unknown, clearSource = false) {
    setBusy(true); setError('');
    try { await api.request(`/plugins${path}`, 'POST', body); if (clearSource) setSource(''); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); setRevision(value => value + 1); }
  }
  return <div className="settings-resource-page">
    <PageActions title="插件"><Button className="settings-outlined-action" size="sm" variant="light" onPress={() => setRevision(value => value + 1)}>刷新</Button></PageActions>
    <form className="resource-toolbar resource-install" onSubmit={event => { event.preventDefault(); const value = source.trim(); if (value) void act('/install', { source: value }, true); }}>
      <Field label="npm 包、GitHub 或本地路径" required value={source} onChange={setSource} placeholder="left-pad、GitHub 地址，或本地目录 / .tgz / .js" />
      <Button size="sm" color="primary" type="submit" isLoading={busy} isDisabled={!source.trim()}>安装插件</Button>
    </form>
    <p className="section-note">插件是 JavaScript 或 TypeScript 模块，由 moejs 执行。导出的函数会变成工具；也可以导出 tools() 和 call()。turnBefore、toolBefore、llmRequest 这些钩子可以改写一轮对话。可以用 fetch 访问网络，用 node:fs 读写本机文件。入口写在 package.json 的 loopra 字段。</p>
    <RemoteState {...state} />{error && <p role="alert" className="settings-error">{error}</p>}
    {state.data?.length === 0 && <ResourceEmpty kind="plugin" title="尚未安装插件">填写 npm 包名或 GitHub 地址，例如 left-pad@1.3.0 或 github:owner/repo。</ResourceEmpty>}
    <div className="resource-list">{state.data?.map(pack => <section className="workbench-card resource-row" key={pack.id}>
      <ResourceIcon kind="plugin" />
      <div className="resource-row-info">
        <div className="resource-name"><strong>{pack.displayName || pack.id}</strong>{pack.version && <code className="resource-version">v{pack.version}</code>}<span className={`resource-status ${pack.enabled && pack.state !== '加载失败' ? 'is-on' : ''}`}>{pack.state || (pack.enabled ? '已启用' : '已停用')}</span></div>
        <p>{pack.description || pack.remark || pack.source || '暂无描述'}</p>
        {pack.error && <p role="alert" className="settings-error">{pack.error}</p>}
        <code className="resource-meta">{pluginMeta(pack)}</code>
      </div>
      <div className="resource-row-actions">
        <Button size="sm" variant={pack.enabled ? 'flat' : 'light'} color={pack.enabled ? 'primary' : 'default'} isDisabled={busy} onPress={() => void act(`/${encodeURIComponent(pack.id)}/toggle`, { enabled: !pack.enabled })}>{pack.enabled ? '停用' : '启用'}</Button>
        <Button size="sm" variant="light" color="danger" isDisabled={busy} onPress={() => setDeleting(pack)}>卸载</Button>
      </div>
    </section>)}</div>
    {deleting && <ConfirmAction title="卸载插件" onClose={() => setDeleting(undefined)} action={() => api.request(`/plugins/${encodeURIComponent(deleting.id)}/remove`, 'POST')} onDone={() => setRevision(value => value + 1)}><p>卸载 {deleting.displayName || deleting.id}？已安装的文件和它贡献的工具会一起移除。</p></ConfirmAction>}
  </div>;
}
export function ToolManager({ api, onRefresh }: { api: LoopraClient; onRefresh: () => Promise<void> }) {
  const [revision, setRevision] = useState(0); const state = useRemote<Tool[]>(api, '/tools', revision);
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all'); const [error, setError] = useState(''); const [busy, setBusy] = useState('');
  async function act(name: string, action: string, body?: unknown) { setBusy(name); setError(''); try { await api.request(`/tools/${encodeURIComponent(name)}/${action}`, 'POST', body); setRevision(value => value + 1); await onRefresh(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(''); } }
  const tools = state.data || [];
  const count = (id: string) => id === 'all' ? tools.length : id === 'readOnly' ? tools.filter(tool => tool.readOnly).length : id === 'write' ? tools.filter(tool => !tool.readOnly).length : id === 'exempt' ? tools.filter(tool => tool.stormExempt).length : tools.filter(tool => !tool.enabled).length;
  const visible = tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(search.toLowerCase()))
    .filter(tool => filter === 'all' || (filter === 'readOnly' ? tool.readOnly : filter === 'write' ? !tool.readOnly : filter === 'exempt' ? tool.stormExempt : !tool.enabled));
  return <div className="settings-resource-page resource-tools-page"><PageActions title="工具"><Field label="搜索工具" className="settings-tool-search" aria-label="搜索工具" placeholder="搜索工具…" value={search} onChange={setSearch} /><Button className="settings-outlined-action" size="sm" variant="light" onPress={() => setRevision(value => value + 1)}>刷新</Button></PageActions>
    <div className="tools-stats" aria-label="工具概览">{([['工具总数', tools.length], ['只读', count('readOnly')], ['写入', count('write')], ['风暴豁免', count('exempt')], ['已停用', count('disabled')]] as [string, number][]).map(([label, value]) => <div className="tools-stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="tools-filters" role="group" aria-label="工具筛选">{([['all', '全部'], ['readOnly', '只读'], ['write', '写入'], ['exempt', '风暴豁免'], ['disabled', '已停用']] as [string, string][]).map(([id, label]) => <Button size="sm" variant="light" key={id} className={`tools-filter ${filter === id ? 'active' : ''}`} aria-pressed={filter === id} onPress={() => setFilter(id)}>{label}<span>{count(id)}</span></Button>)}</div>
    <RemoteState {...state} />{error && <p role="alert" className="settings-error">{error}</p>}
    {visible.length === 0 && !state.loading && !state.error && <ResourceEmpty kind="tool" title="未找到匹配的工具">尝试调整搜索条件或筛选器。</ResourceEmpty>}
    <div className="resource-tool-grid">{visible.map(tool => <section className={`workbench-card resource-tool-card ${tool.enabled ? '' : 'is-disabled'}`} key={tool.name}>
      <div className="resource-tool-header"><ResourceIcon kind="tool" /><div className="resource-row-info"><div className="tools-card-head"><strong>{tool.name}</strong>{!tool.enabled && <span className="tool-badge disabled">已禁用</span>}</div><div className="resource-badges"><span className={`tool-badge ${tool.readOnly ? 'readonly' : 'write'}`}>{tool.readOnly ? '只读' : '写入'}</span>{tool.readOnlyOverride !== null && <span className="tool-badge override">自定义</span>}{tool.stormExempt && <span className="tool-badge exempt">豁免</span>}</div></div>
      <div className="resource-row-actions"><Button size="sm" variant="flat" color={tool.enabled ? 'primary' : 'default'} isDisabled={busy === tool.name} onPress={() => void act(tool.name, 'toggle')}>{tool.enabled ? '停用' : '启用'}</Button><Button className="settings-outlined-action" size="sm" variant={tool.autoApproved ? 'flat' : 'light'} color={tool.autoApproved ? 'primary' : 'default'} isDisabled={busy === tool.name} onPress={() => void act(tool.name, 'auto-toggle')}>{tool.autoApproved ? '取消自动放行' : '自动放行'}</Button></div></div>
      <p className="resource-tool-summary" title={tool.description}>{tool.description}</p>
      <SettingDisclosure heading={`工具说明与权限：${tool.name}`}><p className="resource-full-description">{tool.description}</p><div className="resource-permission-row"><span>读写分类</span><span className="tools-readonly-modes" role="group" aria-label={`${tool.name} 只读分类`}>{([['默认', null], ['只读', true], ['写入', false]] as [string, boolean | null][]).map(([label, value]) => <Button key={label} size="sm" variant="light" className={tool.readOnlyOverride === value ? 'selected' : ''} isDisabled={busy === tool.name} onPress={() => void act(tool.name, 'read-only', { readOnly: value })}>{label}</Button>)}</span></div>{tool.params?.length ? <ul className="tool-params">{tool.params.map(param => <li key={param.name}><code>{param.name}</code>{param.type && <span> · {param.type}</span>}{param.required && <span className="resource-meta"> · 必填</span>}{param.description && <p>{param.description}</p>}</li>)}</ul> : null}</SettingDisclosure>
    </section>)}</div>
  </div>;
}
export { UsageDashboard } from './UsageDashboard';
