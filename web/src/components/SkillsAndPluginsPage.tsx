import { useEffect, useState } from 'react';
import { Plus, PackageOpen } from 'lucide-react';
import { Button, Spinner } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import type { CapabilitiesTab } from '../capabilities-navigation';
import type { PluginContext } from './PluginFrame';
import SkillsPage from './SkillsPage';
import ConnectorsPage from './ConnectorsPage';
import { ExtensionManager } from './ResourceManagers';
import { CapabilityRefresh, CapabilitySearch, CapabilityTabs } from './CapabilityUI';

export default function SkillsAndPluginsPage({ api, tab, onTabChange, onRefresh, onPluginsChanged, onBack, context, notify, onStartChat }: {
  api: LoopraClient;
  notify: (message: string) => void;
  tab: CapabilitiesTab;
  onTabChange: (tab: CapabilitiesTab) => void;
  onRefresh: () => Promise<void>;
  onPluginsChanged: () => void;
  onBack: () => void;
  context?: PluginContext;
  onStartChat?: (connectorId: string) => void;
}) {
  const [discover, setDiscover] = useState(false);
  const [query, setQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [skillsRevision, setSkillsRevision] = useState(0);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setCommittedQuery(query), 350); return () => clearTimeout(timer); }, [query]);
  // 进入连接器页一律落在「我的内容」，与作曲家 / 设置里的入口一致。
  useEffect(() => { if (tab === 'connectors') setDiscover(false); }, [tab]);
  function changeView(next: boolean) { setDiscover(next); setQuery(''); setCommittedQuery(''); setInstallOpen(false); }
  const libraryProps = { library: true, searchQuery: discover ? committedQuery : query, refreshKey: revision, showType: false };
  const searchLabel = tab === 'plugins' ? '搜索插件' : tab === 'skills' ? '搜索技能' : '搜索连接器';
  const addLabel = tab === 'plugins' ? '添加插件' : tab === 'skills' ? '添加技能' : '添加连接器';
  return <section className="skills-hub capabilities-hub" aria-label="技能与插件">
    <div className="capabilities-shell">
      <header className="capabilities-header"><CapabilityTabs label="内容类型" value={tab} onChange={value => { onTabChange(value as CapabilitiesTab); setInstallOpen(false); }} options={[{ value: 'plugins', label: '插件' }, { value: 'skills', label: '技能' }, { value: 'connectors', label: '连接器' }]} variant="underlined" className="library-type-navigation" /><div className="library-header-actions">
        <Button size="sm" color="primary" className="capability-primary library-add-button" onPress={() => { if (tab === 'plugins') { changeView(false); setInstallOpen(true); } else changeView(true); }}><Plus size={16} />{addLabel}</Button>
      </div></header>
      <div className="library-navigation-row"><CapabilityTabs label="内容视图" value={discover ? 'discover' : 'installed'} onChange={value => changeView(value === 'discover')} options={[{ value: 'installed', label: '我的内容' }, { value: 'discover', label: '发现' }]} className="capabilities-navigation" /><div className="library-toolbar-actions"><div className="library-extra-controls" ref={setControls} /><CapabilitySearch label={searchLabel} value={query} onChange={setQuery} placeholder={`${searchLabel}…`} /><CapabilityRefresh onClick={() => setRevision(value => value + 1)} /></div></div>
      {tab === 'connectors'
        ? <ConnectorsPage key={`connectors-${discover}`} {...libraryProps} toolbarTarget={controls} api={api} notify={notify} onStartChat={onStartChat} view={discover ? 'discover' : 'installed'} onViewChange={value => changeView(value === 'discover')} />
        : <div className="library-grid" key={`${tab}-${discover}`}>
          <div className="library-loading" role="status" aria-label="正在加载内容"><Spinner size="sm" /></div>
          {tab === 'skills' && <SkillsPage key={`skills-${discover}`} {...libraryProps} installedRefreshKey={skillsRevision} toolbarTarget={controls} api={api} onRefresh={onRefresh} onBack={onBack} embedded view={discover ? 'market' : 'installed'} onViewChange={value => changeView(value === 'market')} />}
          {tab === 'plugins' && <ExtensionManager key={`plugins-${discover}`} {...libraryProps} toolbarTarget={controls} installOpen={installOpen} onInstallOpenChange={setInstallOpen} onOpenSettings={() => onTabChange('plugins')} api={api} notify={notify} context={context} onChanged={() => { setSkillsRevision(value => value + 1); onPluginsChanged(); }} embedded view={discover ? 'catalog' : 'installed'} />}
          <div className="library-empty"><PackageOpen size={28} /><h2>{query ? '没有找到匹配的内容' : discover ? '暂无可发现的内容' : '内容库还是空的'}</h2></div>
        </div>}
    </div>
  </section>;
}
