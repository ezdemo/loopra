import { useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { ArrowUpRight, Check, Download, Sparkles, Trash2, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { ConfirmAction, errorText, query, RemoteState, useRemote } from './RemoteControls';
import { CapabilityCard, CapabilityControls, CapabilityRefresh, CapabilitySearch, type CapabilityLibraryProps } from './CapabilityUI';

type Skill = { name: string; description?: string; slug?: string; displayName?: string; summary?: string; installSlug?: string; url?: string; scope?: string; directoryName?: string };
type Selection = { skill: Skill; installed: boolean; market: string };
const isBuiltinSkill = (skill: Skill) => skill.scope === '@builtin-skills' || !!skill.scope?.startsWith('@builtin-skills/');
const isPluginSkill = (skill: Skill) => !!skill.scope?.startsWith('@plugin-skills/');
const skillBadge = (skill: Skill) => isPluginSkill(skill) ? '插件' : isBuiltinSkill(skill) ? '内置' : '已安装';
const skillName = (skill: Skill) => skill.displayName || skill.name || skill.slug || '未命名技能';
const skillSlug = (skill: Skill) => skill.installSlug || skill.slug || skill.name;
const skillKey = (skill: Skill) => JSON.stringify([skill.scope || '', skill.directoryName || skill.slug || skill.name]);
function skillWebsite(skill?: Skill) {
  if (!skill?.url) return '';
  try {
    const url = new URL(skill.url);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

export default function SkillsPage({ api, onRefresh, onBack, embedded = false, view, onViewChange, library = false, searchQuery, refreshKey = 0, installedRefreshKey = 0, toolbarTarget, showType }: { api: LoopraClient; onRefresh: () => Promise<void>; onBack: () => void; embedded?: boolean; view?: 'installed' | 'market'; onViewChange?: (view: 'installed' | 'market') => void; installedRefreshKey?: number } & CapabilityLibraryProps) {
  const [revision, setRevision] = useState(0);
  const [installedRevision, setInstalledRevision] = useState(0);
  const installed = useRemote<Skill[]>(api, '/agent/skills', installedRevision + revision + refreshKey + installedRefreshKey, true);
  const markets = useRemote<{ name: string; description: string }[]>(api, '/skill-market/markets');
  const [localTab, setLocalTab] = useState<'installed' | 'market'>('installed');
  const tab = view || localTab;
  function setTab(next: 'installed' | 'market') { setLocalTab(next); onViewChange?.(next); setSelected(undefined); }
  const [filter, setFilter] = useState('');
  const [market, setMarket] = useState('');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const activeSearch = searchQuery ?? search;
  const results = useRemote<Skill[]>(api, tab === 'market' ? `/skill-market/proxy?${query({ action: activeSearch ? 'search' : 'trending', q: activeSearch, marketName: market, limit: 30 })}` : null, revision + refreshKey);
  const [selected, setSelected] = useState<Selection>();
  const detail = useRemote<Skill>(api, selected && !selected.installed ? `/skill-market/detail?${query({ slug: selected.skill.slug || selected.skill.name, marketName: selected.market })}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uninstall, setUninstall] = useState<Skill>();
  const skills = installed.data || [];
  const findInstalled = (skill: Skill) => {
    const matches = skills.filter(item => [item.directoryName, item.name].some(name => name === skillSlug(skill) || name === (skill.slug || skill.name)));
    return matches.find(item => !isBuiltinSkill(item) && !isPluginSkill(item)) || matches[0];
  };
  const isInstalled = (skill: Skill) => !!findInstalled(skill);
  const marketSkills = [...new Map((results.data || []).map(skill => [skillKey(skill), skill])).values()];
  const visible = tab === 'installed' ? skills.filter(skill => `${skillName(skill)} ${skill.name} ${skill.description || ''}`.toLowerCase().includes((searchQuery ?? filter).trim().toLowerCase())) : marketSkills;
  const state = tab === 'installed' ? installed : results;
  async function install(skill: Skill, source: string) {
    setBusy(true); setError('');
    try {
      await api.request(`/skill-market/install?${query({ slug: skillSlug(skill), marketName: source })}`, 'POST', undefined, AbortSignal.timeout(120000));
      setInstalledRevision(value => value + 1);
      await onRefresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const selectedSkill = selected?.installed ? selected.skill : detail.data && { ...selected?.skill, ...detail.data };
  const selectedWebsite = skillWebsite(selectedSkill) || skillWebsite(selected?.skill);
  return <section className={library ? 'library-card-stream' : embedded ? 'skills-hub-content' : 'skills-hub'} aria-label="技能">
    <div className={embedded ? undefined : 'skills-hub-inner'}>
      {!embedded && <header className="skills-hub-heading"><div><h1>技能</h1></div><div className="skills-hub-actions"><Button size="sm" variant="light" onPress={onBack}>返回会话</Button></div></header>}
      {!view && <nav className="skills-hub-tabs" aria-label="技能分类">{([['installed', '已安装'], ['market', '技能市场']] as const).map(([id, label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><span>{label}</span>{id === 'installed' && installed.data && <span className="skills-hub-count">{skills.length}</span>}</button>)}</nav>}
      {!library && (tab === 'installed' ? <div className="capability-toolbar"><CapabilitySearch label="搜索已安装技能" value={filter} onChange={setFilter} /><span className="capability-result-count">{visible.length} 个技能</span><CapabilityRefresh disabled={busy} onClick={() => setRevision(value => value + 1)} /></div> : <form className="capability-toolbar" onSubmit={event => { event.preventDefault(); setSearch(text.trim()); setSelected(undefined); setRevision(value => value + 1); }}><CapabilitySearch label="搜索技能" value={text} onChange={setText} placeholder="搜索技能…" /><select className="capability-select" aria-label="技能市场" value={market} onChange={event => { setMarket(event.target.value); setSelected(undefined); }}><option value="">默认市场</option>{markets.data?.map(item => <option value={item.name} key={item.name}>{item.name}</option>)}</select><CapabilityRefresh disabled={busy} onClick={() => setRevision(value => value + 1)} /><button className="capability-primary" type="submit">{text.trim() ? '搜索技能' : '浏览热门'}</button></form>)}
      {library && tab === 'market' && <CapabilityControls library target={toolbarTarget}><select className="capability-select" aria-label="技能市场" value={market} onChange={event => setMarket(event.target.value)}><option value="">默认市场</option>{markets.data?.map(item => <option value={item.name} key={item.name}>{item.name}</option>)}</select></CapabilityControls>}
      <RemoteState {...state} loading={state.loading && !state.data} />{tab === 'market' && markets.error && <p role="alert" className="settings-error">市场列表加载失败：{markets.error}</p>}{error && <p role="alert" className="settings-error">{error}</p>}
      {!library && tab === 'market' && !state.loading && !state.error && <div className="skills-hub-section-label"><h2>{search ? `“${search}”的搜索结果` : '热门推荐'}</h2><span>{visible.length} 个技能</span></div>}
      {!library && !state.loading && !state.error && visible.length === 0 && <div className="skills-hub-empty"><Sparkles size={30} strokeWidth={1.5} /><h2>{tab === 'installed' && !filter ? '从一个技能开始' : '没有找到匹配的技能'}</h2><p>{tab === 'installed' && !filter ? '前往技能市场，为智能体添加新的工作能力。' : '试试其他关键词，或切换技能市场。'}</p>{tab === 'installed' && !filter && <Button color="primary" size="sm" onPress={() => setTab('market')}>发现技能<ArrowUpRight size={14} /></Button>}</div>}
      <div className="skills-hub-grid" key={tab === 'market' ? `market:${market}` : 'installed'}>{visible.map(skill => {
        const existing = tab === 'installed' ? skill : findInstalled(skill);
        const removable = existing && !isBuiltinSkill(existing) && !isPluginSkill(existing);
        return <CapabilityCard key={skillKey(skill)} className="skills-hub-card" title={skillName(skill)} description={skill.summary || skill.description} icon={skillName(skill).slice(0, 2).toUpperCase()} badge={[showType && '技能', isBuiltinSkill(skill) ? '内置' : isPluginSkill(skill) ? '插件提供' : ''].filter(Boolean).join(' · ')} meta={tab === 'market' ? market : undefined} actions={<><button type="button" className="capability-text-button" onClick={() => { setError(''); setSelected({ skill, installed: tab === 'installed', market }); }}>查看详情<ArrowUpRight size={13} /></button>{tab === 'installed' ? removable && <button type="button" className="capability-icon-button capability-remove" aria-label={`卸载 ${skillName(skill)}`} title="卸载" disabled={busy} onClick={() => setUninstall(skill)}><Trash2 size={15} /></button> : <button type="button" className={existing ? 'capability-secondary' : 'capability-primary'} disabled={busy || installed.loading || (!!existing && !removable)} onClick={() => existing ? setUninstall(existing) : void install(skill, market)}>{existing ? removable ? '删除' : '已安装' : '安装'}</button>}</>} />;
      })}</div>
      {selected && <Modal isOpen onClose={() => setSelected(undefined)} hideCloseButton placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog skills-hub-detail', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop' }} aria-label="技能详情">
        <ModalContent>
          <ModalHeader className="app-dialog-header skills-detail-header">
            <span className="skills-detail-icon" aria-hidden="true"><Sparkles size={22} strokeWidth={1.6} /></span>
            <div className="skills-detail-title"><span>技能详情</span><h2>{skillName(selectedSkill || selected.skill)}</h2></div>
            <Button size="sm" isIconOnly variant="light" className="skills-detail-close" aria-label="关闭技能详情" onPress={() => setSelected(undefined)}><X size={18} /></Button>
          </ModalHeader>
          <ModalBody className="app-dialog-body skills-detail-body">
            <div className="skills-detail-meta">{selected.installed || isInstalled(selectedSkill || selected.skill) ? <span className="skills-hub-badge"><Check size={12} />{skillBadge(selected.skill)}</span> : <span className="skills-detail-source">{selected.market || '默认市场'}</span>}</div>
            {!selected.installed && <RemoteState {...detail} />}
            {selectedSkill && <section><h3>技能说明</h3><div className="skills-detail-description">{selectedSkill.description || selectedSkill.summary || '暂无技能说明'}</div></section>}
            {error && <p className="settings-error" role="alert">{error}</p>}
          </ModalBody>
          <ModalFooter className="app-dialog-footer skills-detail-footer">
            {selectedWebsite && <a className="skills-detail-website" href={selectedWebsite} title={selectedWebsite} target="_blank" rel="noopener noreferrer">查看原网页<ArrowUpRight size={14} aria-hidden="true" /></a>}
            <Button size="sm" variant="light" onPress={() => setSelected(undefined)}>关闭</Button>
            {!selected.installed && <Button color="primary" size="sm" isDisabled={!detail.data || isInstalled(selectedSkill || selected.skill) || busy} isLoading={busy} startContent={isInstalled(selectedSkill || selected.skill) ? <Check size={14} /> : <Download size={14} />} onPress={() => selectedSkill && void install(selectedSkill, selected.market)}>{isInstalled(selectedSkill || selected.skill) ? '已安装' : '安装此技能'}</Button>}
          </ModalFooter>
        </ModalContent>
      </Modal>}
    </div>
    {uninstall && !isBuiltinSkill(uninstall) && !isPluginSkill(uninstall) && <ConfirmAction title="卸载技能" onClose={() => setUninstall(undefined)} action={() => api.request(`/skill-market/uninstall?${query({ slug: uninstall.directoryName || uninstall.name, scope: uninstall.scope })}`, 'POST')} onDone={() => { setSelected(undefined); setInstalledRevision(value => value + 1); void onRefresh().catch(cause => setError(errorText(cause))); }}><p>卸载 {skillName(uninstall)}？</p></ConfirmAction>}
  </section>;
}
