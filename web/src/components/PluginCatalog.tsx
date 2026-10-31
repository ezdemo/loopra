import { useState } from 'react';
import type { LoopraClient } from '../backend';
import { Field, ResourceEmpty } from './SettingControls';
import { errorText, RemoteState, useRemote } from './RemoteControls';

type CatalogEntry = { id: string; name: string; description?: string; version?: string; source: string };

export function PluginCatalog({ api, installed, busy, onInstall }: {
  api: LoopraClient;
  installed: { id: string }[];
  busy: boolean;
  onInstall: (source: string) => Promise<void>;
}) {
  const sources = useRemote<string[]>(api, '/plugins/sources');
  const [selected, setSelected] = useState('');
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState('');
  const active = sources.data?.includes(selected) ? selected : sources.data?.[0] || '';
  const catalog = useRemote<CatalogEntry[]>(api, active ? `/plugins/catalog?source=${encodeURIComponent(active)}` : null, revision);

  async function changeSource(remove: boolean) {
    setSaving(true); setError('');
    try {
      const result = await api.request<string[]>(`/plugins/sources${remove ? '/remove' : ''}`, 'POST', { source: remove ? active : source.trim() });
      sources.setData(result);
      if (!remove) { setSelected(result.at(-1) || ''); setSource(''); setAdding(false); }
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  }
  async function install(entry: CatalogEntry) {
    setInstalling(entry.source);
    try { await onInstall(entry.source); }
    finally { setInstalling(''); }
  }

  return <>
    <div className="plugin-source-toolbar">
      <select aria-label="插件源" value={active} disabled={saving || sources.loading} onChange={event => setSelected(event.target.value)}>
        {!active && <option value="">暂无插件源</option>}
        {sources.data?.map(value => <option key={value} value={value}>{value.replace('https://github.com/', '')}</option>)}
      </select>
      <button type="button" className="plugin-card-open" disabled={!active || catalog.loading} onClick={() => setRevision(value => value + 1)}>刷新</button>
      <button type="button" className="plugin-card-open" disabled={saving} aria-expanded={adding} onClick={() => setAdding(value => !value)}>添加源</button>
      <button type="button" className="plugin-card-remove" disabled={!active || saving} onClick={() => void changeSource(true)}>移除源</button>
    </div>
    {adding && <form className="resource-toolbar resource-install" onSubmit={event => { event.preventDefault(); if (source.trim()) void changeSource(false); }}>
      <Field label="GitHub 仓库" required value={source} onChange={setSource} placeholder="https://github.com/owner/repo" />
      <button type="submit" className="plugin-card-state" disabled={saving || !source.trim()}>{saving ? '保存中' : '添加'}</button>
    </form>}
    <RemoteState {...sources} /><RemoteState {...catalog} />
    {error && <p className="settings-error" role="alert">{error}</p>}
    {!sources.loading && !sources.error && !active && <ResourceEmpty kind="plugin" title="添加插件源">填写 GitHub 仓库地址即可浏览其中的插件。</ResourceEmpty>}
    {catalog.data?.length === 0 && <ResourceEmpty kind="plugin" title="仓库中暂无插件">每个插件目录需要包含 package.json 和插件入口文件。</ResourceEmpty>}
    <div className="plugin-market">{catalog.data?.map(entry => {
      const exists = installed.some(pack => pack.id === entry.id);
      return <section className="plugin-card" key={entry.source}>
        <header className="plugin-card-head">
          <div className="plugin-card-id"><div className="plugin-card-name"><strong title={entry.name}>{entry.name}</strong></div></div>
          <button type="button" className={`plugin-card-state ${exists ? 'is-on' : ''}`} disabled={busy || !!installing || exists} onClick={() => void install(entry)}>
            {exists ? '已安装' : installing === entry.source ? '安装中' : '安装'}
          </button>
        </header>
        {entry.description && <p className="plugin-card-desc">{entry.description}</p>}
        {entry.version && <footer className="plugin-card-foot"><span>v{entry.version}</span></footer>}
      </section>;
    })}</div>
  </>;
}
