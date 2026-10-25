import { useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { ArrowLeft, ArrowUpRight, Check, Download, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { ConfirmAction, errorText, query, RemoteState, useRemote } from './RemoteControls';
import { Field, SelectField } from './SettingControls';

type Skill = { name: string; description?: string; slug?: string; displayName?: string; summary?: string; installSlug?: string; url?: string };
type Selection = { skill: Skill; installed: boolean; market: string };
const skillName = (skill: Skill) => skill.displayName || skill.name || skill.slug || '未命名技能';
const skillSlug = (skill: Skill) => skill.installSlug || skill.slug || skill.name;
function skillWebsite(skill?: Skill) {
  if (!skill?.url) return '';
  try {
    const url = new URL(skill.url);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

export default function SkillsPage({ api, onRefresh, onBack }: { api: LoopraClient; onRefresh: () => Promise<void>; onBack: () => void }) {
  const [revision, setRevision] = useState(0);
  const installed = useRemote<Skill[]>(api, '/agent/skills', revision);
  const markets = useRemote<{ name: string; description: string }[]>(api, '/skill-market/markets');
  const [tab, setTab] = useState<'installed' | 'market'>('installed');
  const [filter, setFilter] = useState('');
  const [market, setMarket] = useState('');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const results = useRemote<Skill[]>(api, tab === 'market' ? `/skill-market/proxy?${query({ action: search ? 'search' : 'trending', q: search, marketName: market, limit: 30 })}` : null, revision);
  const [selected, setSelected] = useState<Selection>();
  const detail = useRemote<Skill>(api, selected && !selected.installed ? `/skill-market/detail?${query({ slug: selected.skill.slug || selected.skill.name, marketName: selected.market })}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uninstall, setUninstall] = useState<Skill>();
  const skills = installed.data || [];
  const isInstalled = (skill: Skill) => skills.some(item => item.name === skillSlug(skill) || item.name === (skill.slug || skill.name));
  const visible = tab === 'installed' ? skills.filter(skill => `${skillName(skill)} ${skill.name} ${skill.description || ''}`.toLowerCase().includes(filter.trim().toLowerCase())) : results.data || [];
  const state = tab === 'installed' ? installed : results;
  async function install(skill: Skill, source: string) {
    setBusy(true); setError('');
    try {
      await api.request(`/skill-market/install?${query({ slug: skillSlug(skill), marketName: source })}`, 'POST', undefined, AbortSignal.timeout(120000));
      setRevision(value => value + 1);
      await onRefresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const selectedSkill = selected?.installed ? selected.skill : detail.data && { ...selected?.skill, ...detail.data };
  const selectedWebsite = skillWebsite(selectedSkill) || skillWebsite(selected?.skill);
  return <section className="skills-hub" aria-label="技能">
    <div className="skills-hub-inner">
      <header className="skills-hub-heading"><div><span className="skills-hub-eyebrow"><Sparkles size={15} />扩展你的智能体</span><h1>技能</h1><p>管理常用技能，发现适合你工作方式的新能力。</p></div><div className="skills-hub-actions"><Button size="sm" variant="light" onPress={onBack} startContent={<ArrowLeft size={15} />}>返回会话</Button><Button size="sm" variant="bordered" isDisabled={busy} onPress={() => setRevision(value => value + 1)} startContent={<RefreshCw size={14} />}>刷新</Button></div></header>
      <nav className="skills-hub-tabs" aria-label="技能分类">{([['installed', '已安装'], ['market', '技能市场']] as const).map(([id, label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setSelected(undefined); }}><span>{label}</span>{id === 'installed' && installed.data && <span className="skills-hub-count">{skills.length}</span>}</button>)}</nav>
      {tab === 'installed' ? <div className="skills-hub-toolbar"><Field label="搜索已安装技能" value={filter} onChange={setFilter} placeholder="搜索名称或说明…" startContent={<Search size={16} />} /><span>{visible.length} 个技能</span></div> : <form className="skills-hub-market-search" onSubmit={event => { event.preventDefault(); setSearch(text.trim()); setSelected(undefined); setRevision(value => value + 1); }}><Field label="搜索技能" value={text} onChange={setText} placeholder="你想让智能体学会什么？" startContent={<Search size={16} />} /><SelectField label="技能市场" value={market} onChange={value => { setMarket(value); setSelected(undefined); }} options={[{ value: '', label: '默认市场' }, ...(markets.data?.map(item => ({ value: item.name, label: item.name })) || [])]} /><Button size="md" color="primary" type="submit">{text.trim() ? '搜索技能' : '浏览热门'}</Button></form>}
      <RemoteState {...state} />{tab === 'market' && markets.error && <p role="alert" className="settings-error">市场列表加载失败：{markets.error}</p>}{error && <p role="alert" className="settings-error">{error}</p>}
      {tab === 'market' && !state.loading && !state.error && <div className="skills-hub-section-label"><h2>{search ? `“${search}”的搜索结果` : '热门推荐'}</h2><span>{visible.length} 个技能</span></div>}
      {!state.loading && !state.error && visible.length === 0 && <div className="skills-hub-empty"><Sparkles size={30} strokeWidth={1.5} /><h2>{tab === 'installed' && !filter ? '从一个技能开始' : '没有找到匹配的技能'}</h2><p>{tab === 'installed' && !filter ? '前往技能市场，为智能体添加新的工作能力。' : '试试其他关键词，或切换技能市场。'}</p>{tab === 'installed' && !filter && <Button color="primary" size="sm" onPress={() => setTab('market')}>发现技能<ArrowUpRight size={14} /></Button>}</div>}
      <div className="skills-hub-grid">{visible.map(skill => {
        const added = tab === 'installed' || isInstalled(skill);
        return <article className="skills-hub-card" key={skill.slug || skill.name}><div className="skills-hub-card-top"><span className="skills-hub-avatar" aria-hidden="true">{skillName(skill).slice(0, 2).toUpperCase()}</span>{added && <span className="skills-hub-badge"><Check size={12} />已安装</span>}</div><h2 title={skillName(skill)}>{skillName(skill)}</h2><p className="skills-hub-summary">{skill.summary || skill.description || '暂无技能说明'}</p><footer><Button size="sm" variant="light" onPress={() => { setError(''); setSelected({ skill, installed: tab === 'installed', market }); }}>查看详情<ArrowUpRight size={13} /></Button>{tab === 'installed' ? <Button size="sm" variant="light" className="skills-hub-remove" isDisabled={busy} onPress={() => setUninstall(skill)} startContent={<Trash2 size={13} />}>卸载</Button> : <Button size="sm" color={added ? 'default' : 'primary'} variant={added ? 'flat' : 'solid'} isDisabled={added || busy} onPress={() => void install(skill, market)} startContent={added ? <Check size={13} /> : <Download size={13} />}>{added ? '已安装' : '安装'}</Button>}</footer></article>;
      })}</div>
      {selected && <Modal isOpen onClose={() => setSelected(undefined)} hideCloseButton placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog skills-hub-detail', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop' }} aria-label="技能详情">
        <ModalContent>
          <ModalHeader className="app-dialog-header skills-detail-header">
            <span className="skills-detail-icon" aria-hidden="true"><Sparkles size={22} strokeWidth={1.6} /></span>
            <div className="skills-detail-title"><span>技能详情</span><h2>{skillName(selectedSkill || selected.skill)}</h2></div>
            <Button size="sm" isIconOnly variant="light" className="skills-detail-close" aria-label="关闭技能详情" onPress={() => setSelected(undefined)}><X size={18} /></Button>
          </ModalHeader>
          <ModalBody className="app-dialog-body skills-detail-body">
            <div className="skills-detail-meta">{selected.installed || isInstalled(selectedSkill || selected.skill) ? <span className="skills-hub-badge"><Check size={12} />已安装</span> : <span className="skills-detail-source">{selected.market || '默认市场'}</span>}</div>
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
    {uninstall && <ConfirmAction title="卸载技能" onClose={() => setUninstall(undefined)} action={() => api.request(`/skill-market/uninstall?${query({ slug: uninstall.name })}`, 'POST')} onDone={() => { setSelected(undefined); setRevision(value => value + 1); void onRefresh().catch(cause => setError(errorText(cause))); }}><p>卸载 {skillName(uninstall)}？</p></ConfirmAction>}
  </section>;
}
