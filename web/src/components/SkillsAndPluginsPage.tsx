import { useEffect, useState } from 'react';
import { ArrowLeft, Plus, PackageOpen } from 'lucide-react';
import type { LoopraClient } from '../backend';
import type { CapabilitiesTab } from '../capabilities-navigation';
import type { PluginContext } from './PluginFrame';
import SkillsPage from './SkillsPage';
import { ExtensionManager } from './ResourceManagers';
import { CapabilityRefresh, CapabilitySearch } from './CapabilityUI';

export default function SkillsAndPluginsPage({ api, tab, onTabChange, onRefresh, onPluginsChanged, onBack, context }: {
  api: LoopraClient;
  tab: CapabilitiesTab;
  onTabChange: (tab: CapabilitiesTab) => void;
  onRefresh: () => Promise<void>;
  onPluginsChanged: () => void;
  onBack: () => void;
  context?: PluginContext;
}) {
  const [discover, setDiscover] = useState(false);
  const [query, setQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setCommittedQuery(query), 350); return () => clearTimeout(timer); }, [query]);
  function changeView(next: boolean) { setDiscover(next); setQuery(''); setCommittedQuery(''); setInstallOpen(false); }
  const libraryProps = { library: true, searchQuery: discover ? committedQuery : query, refreshKey: revision, showType: tab === 'all' };
  return <section className="skills-hub capabilities-hub" aria-label="技能与插件">
    <div className="capabilities-shell">
      <header className="capabilities-header"><h1>技能与插件</h1><div className="library-header-actions">
        <details className="library-add"><summary className="capability-primary"><Plus size={15} />添加</summary><div className="library-add-menu"><button type="button" onClick={event => { changeView(true); onTabChange('skills'); event.currentTarget.closest('details')!.open = false; }}>添加技能</button><button type="button" onClick={event => { changeView(false); onTabChange('plugins'); setInstallOpen(true); event.currentTarget.closest('details')!.open = false; }}>安装插件</button></div></details>
        <button type="button" className="capability-icon-button" aria-label="返回会话" title="返回会话" onClick={onBack}><ArrowLeft size={16} /></button>
      </div></header>
      <div className="library-navigation-row"><nav className="capabilities-navigation" aria-label="内容视图">
        <button type="button" aria-current={!discover ? 'page' : undefined} onClick={() => changeView(false)}>我的内容</button>
        <button type="button" aria-current={discover ? 'page' : undefined} onClick={() => changeView(true)}>发现</button>
      </nav><CapabilitySearch label="搜索技能与插件" value={query} onChange={setQuery} placeholder="搜索技能与插件…" /></div>
      <div className="library-filter-row"><div className="library-type-filter" role="group" aria-label="内容类型">{([['all', '全部'], ['skills', '技能'], ['plugins', '插件']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => { onTabChange(id); setInstallOpen(false); }}>{label}</button>)}</div><div className="library-extra-controls" ref={setControls} /><CapabilityRefresh onClick={() => setRevision(value => value + 1)} /></div>
      <div className="library-grid">
        {tab !== 'plugins' && <SkillsPage key={`skills-${discover}`} {...libraryProps} toolbarTarget={tab === 'skills' ? controls : null} api={api} onRefresh={async () => { setRevision(value => value + 1); await onRefresh(); }} onBack={onBack} embedded view={discover ? 'market' : 'installed'} onViewChange={value => changeView(value === 'market')} />}
        {tab !== 'skills' && <ExtensionManager key={`plugins-${discover}`} {...libraryProps} toolbarTarget={tab === 'plugins' ? controls : null} installOpen={installOpen} onInstallOpenChange={setInstallOpen} onOpenSettings={() => onTabChange('plugins')} api={api} context={context} onChanged={() => { setRevision(value => value + 1); onPluginsChanged(); }} embedded view={discover ? 'catalog' : 'installed'} />}
        <div className="library-empty"><PackageOpen size={28} /><h2>{query ? '没有找到匹配的内容' : discover ? '暂无可发现的内容' : '内容库还是空的'}</h2></div>
      </div>
    </div>
  </section>;
}
