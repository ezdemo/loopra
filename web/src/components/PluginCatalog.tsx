import { useState } from 'react';
import { Button } from '@nextui-org/react';
import { Plus, Settings2, Trash2, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { Field, ResourceEmpty } from './SettingControls';
import { errorText, RemoteState, useRemote } from './RemoteControls';
import { PluginGlyph, pluginTone, type PluginIconRef } from './plugin-icons';
import { CapabilityCard, CapabilityControls, CapabilityRefresh, CapabilitySearch, CapabilitySelect, type CapabilityLibraryProps } from './CapabilityUI';

type CatalogEntry = { id: string; name: string; description?: string; version?: string; source: string; icon?: PluginIconRef };

export function PluginCatalog({ api, installed, busy, onInstall, onUpdate, onUninstall, library = false, searchQuery, refreshKey = 0, toolbarTarget, showType }: {
  api: LoopraClient;
  installed: { id: string; builtin?: boolean }[];
  busy: boolean;
  onInstall: (source: string) => Promise<void>;
  onUpdate: (id: string) => Promise<void>;
  onUninstall: (id: string) => void;
} & CapabilityLibraryProps) {
  const sources = useRemote<string[]>(api, '/plugins/sources', refreshKey);
  const [selected, setSelected] = useState('');
  const [revision, setRevision] = useState(0);
  const [managing, setManaging] = useState(false);
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState('');
  const [updating, setUpdating] = useState('');
  const active = sources.data?.includes(selected) ? selected : sources.data?.[0] || '';
  const catalog = useRemote<CatalogEntry[]>(api, active ? `/plugins/catalog?source=${encodeURIComponent(active)}` : null, revision + refreshKey);
  const visible = catalog.data?.filter(entry => `${entry.name} ${entry.description || ''}`.toLowerCase().includes((searchQuery ?? filter).trim().toLowerCase()));
  const sourceName = (value: string) => value.replace('https://github.com/', '');

  async function changeSource(remove: boolean, target = active) {
    setSaving(true); setError('');
    try {
      const result = await api.request<string[]>(`/plugins/sources${remove ? '/remove' : ''}`, 'POST', { source: remove ? target : source.trim() });
      sources.setData(result);
      if (!remove) { setSelected(result.at(-1) || ''); setSource(''); }
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  }
  async function install(entry: CatalogEntry) {
    setInstalling(entry.source);
    try { await onInstall(entry.source); }
    finally { setInstalling(''); }
  }
  async function update(id: string) {
    setUpdating(id);
    try { await onUpdate(id); }
    finally { setUpdating(''); }
  }

  return <>
    <CapabilityControls library={library} target={toolbarTarget}>
      {!library && <CapabilitySearch label="搜索插件" value={filter} onChange={setFilter} placeholder="搜索插件…" />}
      <CapabilitySelect label="插件源" value={active} disabled={saving || sources.loading} onChange={setSelected} options={active ? (sources.data || []).map(value => ({ value, label: sourceName(value) })) : [{ value: '', label: '暂无插件源' }]} />
      {!library && <CapabilityRefresh disabled={!active || catalog.loading} onClick={() => setRevision(value => value + 1)} />}
      <Button size="sm" variant="bordered" type="button" className="capability-secondary" isDisabled={saving} aria-expanded={managing} onPress={() => setManaging(value => !value)}><Settings2 size={15} />管理源</Button>
    </CapabilityControls>
    {managing && <section className="capability-source-panel" aria-label="插件源管理">
      <header><h2>插件源</h2><Button size="sm" variant="light" isIconOnly type="button" className="capability-icon-button" aria-label="关闭插件源管理" onPress={() => setManaging(false)}><X size={16} /></Button></header>
      <ul>{sources.data?.map(value => <li key={value}><span title={value}>{sourceName(value)}</span><Button size="sm" variant="light" isIconOnly type="button" className="capability-icon-button capability-remove" aria-label={`移除 ${sourceName(value)}`} title="移除源" isDisabled={saving} onPress={() => void changeSource(true, value)}><Trash2 size={15} /></Button></li>)}</ul>
      <form className="capability-install-panel" onSubmit={event => { event.preventDefault(); if (source.trim()) void changeSource(false); }}>
        <Field label="GitHub 仓库" required value={source} onChange={setSource} placeholder="https://github.com/owner/repo" />
        <Button size="sm" color="primary" type="submit" className="capability-primary" isDisabled={saving || !source.trim()}><Plus size={15} />{saving ? '保存中' : '添加源'}</Button>
      </form>
    </section>}
    <RemoteState {...sources} /><RemoteState {...catalog} />
    {error && <p className="settings-error" role="alert">{error}</p>}
    {!library && !sources.loading && !sources.error && !active && <ResourceEmpty kind="plugin" title="添加插件源">在「管理源」中添加一个 GitHub 仓库。</ResourceEmpty>}
    {!library && catalog.data?.length === 0 && <ResourceEmpty kind="plugin" title="仓库中暂无插件">每个插件目录需要包含 package.json 和插件入口文件。</ResourceEmpty>}
    {!library && !!catalog.data?.length && visible?.length === 0 && <ResourceEmpty kind="plugin" title="没有匹配的插件">试试其他关键词。</ResourceEmpty>}
    <div className="plugin-market">{visible?.map(entry => {
      const existing = installed.find(pack => pack.id === entry.id);
      return <CapabilityCard key={entry.source} className="plugin-card" title={entry.name} description={entry.description} badge={showType ? '插件' : undefined}
        iconClassName={entry.icon ? 'plugin-card-mark has-icon' : 'plugin-card-mark'} iconStyle={entry.icon ? undefined : { background: pluginTone(entry.id), color: '#fff' }}
        icon={entry.icon ? <PluginGlyph api={api} pluginId={entry.id} icon={entry.icon} className="plugin-card-icon" size="1.25rem" /> : ([...entry.name.trim()][0] || '?')}
        meta={entry.version ? `v${entry.version}` : undefined}
        actions={<>
          {existing && !existing.builtin && <Button size="sm" variant="bordered" type="button" className="capability-secondary" isDisabled={busy || !!installing || !!updating} onPress={() => void update(existing.id)}>{updating === existing.id ? '更新中' : '更新'}</Button>}
          <Button size="sm" color={existing ? "default" : "primary"} variant={existing ? "bordered" : "solid"} type="button" className={existing ? 'capability-secondary' : 'capability-primary'} isDisabled={busy || !!installing || !!updating || !!existing?.builtin} onPress={() => existing ? onUninstall(existing.id) : void install(entry)}>{existing ? existing.builtin ? '已安装' : '卸载' : installing === entry.source ? '安装中' : '安装'}</Button>
        </>} />;
    })}</div>
  </>;
}
