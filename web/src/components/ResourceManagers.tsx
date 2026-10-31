import { useState } from 'react';
import { PluginFrame, type PluginContext } from './PluginFrame';
import { PluginCatalog } from './PluginCatalog';
import { PluginGlyph, pluginTone, type PluginIconRef } from './plugin-icons';
import { Button } from '@nextui-org/react';
import { Plus, Settings2, Trash2, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { ConfirmAction, errorText, RemoteState, useRemote } from './RemoteControls';
import { PageActions, Field, SettingDisclosure, ResourceIcon, ResourceEmpty } from './SettingControls';
import { CapabilityCard, CapabilityControls, CapabilityRefresh, CapabilitySearch, type CapabilityLibraryProps } from './CapabilityUI';

type ToolParam = { name: string; description?: string; type?: string; required?: boolean };
type Tool = { name: string; description: string; readOnly: boolean; readOnlyOverride: boolean | null; stormExempt: boolean; enabled: boolean; autoApproved: boolean; params?: ToolParam[] };
export { default as SubAgentManager } from './SubAgentManager';
type Pack = { id: string; displayName?: string; remark?: string; description?: string; enabled: boolean; builtin?: boolean; source?: string; sourceUrl?: string; state?: string; error?: string; tools?: string[]; hooks?: string[]; version?: string; settings?: boolean; icon?: PluginIconRef };
function pluginOrigin(pack: Pack) {
  if (pack.builtin) return '内置';
  const source = pack.source || pack.sourceUrl || '';
  if (/github\.com|^github:|github:/i.test(source)) return 'GitHub';
  if (/^[a-z]:[\\/]/i.test(source) || source.startsWith('file:') || source.startsWith('.') || source.includes('\\') || source.startsWith('/')) return '本地';
  return 'npm';
}
export function ExtensionManager({ api, onChanged, context, embedded = false, view, library = false, searchQuery, refreshKey = 0, toolbarTarget, showType, installOpen, onInstallOpenChange, onOpenSettings }: { api: LoopraClient; onChanged?: () => void; context?: PluginContext; embedded?: boolean; view?: 'installed' | 'catalog'; installOpen?: boolean; onInstallOpenChange?: (open: boolean) => void; onOpenSettings?: () => void } & CapabilityLibraryProps) {
  const [localTab, setTab] = useState<'installed' | 'catalog'>('installed');
  const tab = view || localTab;
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('all');
  const [localAdding, setLocalAdding] = useState(false);
  const adding = installOpen ?? localAdding;
  function setAdding(open: boolean) { setLocalAdding(open); onInstallOpenChange?.(open); }
  const [revision, setRevision] = useState(0); const state = useRemote<Pack[]>(api, '/plugins', revision + refreshKey); const [source, setSource] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [deleting, setDeleting] = useState<Pack>(); const [panel, setPanel] = useState<Pack>();
  async function act(path: string, body?: unknown, clearSource = false) {
    setBusy(true); setError('');
    try { await api.request(`/plugins${path}`, 'POST', body); if (clearSource) { setSource(''); setAdding(false); } onChanged?.(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); setRevision(value => value + 1); }
  }
  const visible = state.data?.filter(pack => `${pack.displayName || ''} ${pack.id} ${pack.description || ''}`.toLowerCase().includes((searchQuery ?? filter).trim().toLowerCase()) && (status === 'all' || (status === 'failed' ? !!pack.error : status === 'enabled' ? pack.enabled && !pack.error : !pack.enabled)));
  if (panel) {
    const name = panel.displayName || panel.id;
    return <div className={`settings-resource-page plugin-page ${library ? 'library-detail' : ''}`}>
      <PageActions title={name} onBack={() => setPanel(undefined)} />
      <PluginFrame api={api} id={panel.id} name={name} slot="ui" title={`${name} 设置`} context={context} />
    </div>;
  }
  return <div className={`settings-resource-page plugin-page ${library ? 'library-card-stream' : ''}`}>
    {!embedded && <PageActions title="插件">{tab === 'installed' && <Button className="settings-outlined-action" size="sm" variant="light" onPress={() => setRevision(value => value + 1)}>刷新</Button>}</PageActions>}
    {!view && <div className="tools-filters" role="group" aria-label="插件视图">
      <Button size="sm" variant="light" className={`tools-filter ${tab === 'installed' ? 'active' : ''}`} aria-pressed={tab === 'installed'} onPress={() => setTab('installed')}>已安装</Button>
      <Button size="sm" variant="light" className={`tools-filter ${tab === 'catalog' ? 'active' : ''}`} aria-pressed={tab === 'catalog'} onPress={() => setTab('catalog')}>发现插件</Button>
      {embedded && tab === 'installed' && <Button className="settings-outlined-action capabilities-refresh" size="sm" variant="light" onPress={() => setRevision(value => value + 1)}>刷新</Button>}
    </div>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    <RemoteState {...state} />
    {tab === 'catalog' ? <PluginCatalog api={api} installed={state.data || []} busy={busy || !state.data} onInstall={value => act('/install', { source: value })} onUninstall={id => setDeleting(state.data?.find(pack => pack.id === id && !pack.builtin))} library={library} searchQuery={searchQuery} refreshKey={refreshKey} toolbarTarget={toolbarTarget} showType={showType} /> : <>
    {!library && <div className="capability-toolbar">
      <CapabilitySearch label="搜索已安装插件" value={filter} onChange={setFilter} />
      <select className="capability-select" aria-label="插件状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="failed">加载失败</option></select>
      <CapabilityRefresh disabled={busy} onClick={() => setRevision(value => value + 1)} />
      <button type="button" className="capability-primary" aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus size={15} />安装插件</button>
    </div>}
    {library && <CapabilityControls library target={toolbarTarget}><select className="capability-select" aria-label="插件状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="failed">加载失败</option></select></CapabilityControls>}
    {adding && <form className="capability-install-panel" onSubmit={event => { event.preventDefault(); const value = source.trim(); if (value) void act('/install', { source: value }, true); }}>
      <Field label="插件地址" required value={source} onChange={setSource} placeholder="npm 包名、GitHub 地址或本地路径" />
      <button className="capability-primary" type="submit" disabled={busy || !source.trim()}>{busy ? '安装中' : '安装'}</button>
      <button type="button" className="capability-icon-button" aria-label="取消安装" onClick={() => setAdding(false)}><X size={16} /></button>
    </form>}
    {!library && state.data?.length === 0 && <ResourceEmpty kind="plugin" title="尚未安装插件">前往「发现插件」浏览，或从地址安装。</ResourceEmpty>}
    {!library && !!state.data?.length && visible?.length === 0 && <ResourceEmpty kind="plugin" title="没有匹配的插件">尝试调整搜索或状态筛选。</ResourceEmpty>}
    <div className="plugin-market">{visible?.map(pack => {
      const name = pack.displayName || pack.id;
      const failed = pack.state === '加载失败';
      const on = pack.enabled && !failed;
      return <CapabilityCard key={pack.id} className="plugin-card" title={name} description={pack.description || pack.remark} iconClassName={pack.icon ? 'plugin-card-mark has-icon' : 'plugin-card-mark'} iconStyle={pack.icon ? undefined : { background: pluginTone(pack.id), color: '#fff' }} icon={pack.icon ? <PluginGlyph api={api} pluginId={pack.id} icon={pack.icon} className="plugin-card-icon" size="1.25rem" /> : ([...name.trim()][0] || '?')} badge={[showType && '插件', pack.builtin && '内置'].filter(Boolean).join(' · ')} meta={<span title={pack.source}>{[pack.version && `v${pack.version}`, !pack.builtin && pluginOrigin(pack)].filter(Boolean).join(' · ')}</span>} actions={<>
        <button className={`capability-toggle ${failed ? 'is-failed' : ''}`} role="switch" aria-label={`${name} 启用状态`} aria-checked={pack.enabled} data-on={on} type="button" disabled={busy} onClick={() => void act(`/${encodeURIComponent(pack.id)}/toggle`, { enabled: !pack.enabled })}><span className="capability-toggle-track" />{failed ? '加载失败' : on ? '已启用' : '已停用'}</button>
        {pack.settings && <button className="capability-icon-button" type="button" disabled={busy} aria-label={`${name} 设置`} title="设置" onClick={() => { onOpenSettings?.(); setPanel(pack); }}><Settings2 size={15} /></button>}
        {!pack.builtin && <button className="capability-icon-button capability-remove" type="button" disabled={busy} aria-label={`卸载 ${name}`} title="卸载" onClick={() => setDeleting(pack)}><Trash2 size={15} /></button>}
      </>}>
        {pack.error && <p role="alert" className="settings-error plugin-card-error">{pack.error}</p>}
      </CapabilityCard>;
    })}</div>
    </>}
    {deleting && <ConfirmAction title="卸载插件" onClose={() => setDeleting(undefined)} action={() => api.request(`/plugins/${encodeURIComponent(deleting.id)}/remove`, 'POST')} onDone={() => { setRevision(value => value + 1); onChanged?.(); }}><p>卸载 {deleting.displayName || deleting.id}？已安装的文件和它贡献的工具会一起移除。</p></ConfirmAction>}
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
