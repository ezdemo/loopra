import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, ModalContent, Slider } from '@nextui-org/react';
import { AnimatePresence } from 'framer-motion';
import { Archive, Bot, FolderClosed, Plug, Search, Server, SlidersHorizontal, Star, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Enter, SelectionIndicator } from './Motion';
import type { Provider, Session } from '../lib';
import type { AgentSettings } from '../settings-data';
import type { ComposerOptions } from '../composer';
import { IconButton, LoopraMark } from './ui';
import { SettingRow, SettingSwitch, SelectField, SettingSegments } from './SettingControls';
import ModelProviderSettings from './ModelProviderSettings';
import { BackendProjects, BackendServer } from './BackendSettings';
import { LoopraClient } from '../backend';
import IntegrationManager from './IntegrationManager';
import { ExtensionManager, SkillManager, SubAgentManager, ToolManager, UsageDashboard } from './ResourceManagers';
import type { Workspace } from '../backend';
import { AgentDefaults, PromptSettings } from './AgentSettingsPages';
import { searchSettings } from '../settings-search';
import { normalizeSettingsSection, settingsCategories, settingsCategoryFor } from '../settings-navigation';
import PetSettings from './PetSettings';
import type { PetStore } from '../usePets';
import VersionInfo from './VersionInfo';
import BrowserSettings from './BrowserSettings';
import { GITEE_HOME_URL, GITHUB_HOME_URL } from '../update-scripts';

export type Preferences = { theme: string; language: string; fontScale: number; notifications: boolean; sound: boolean; openWith: string; autoContext: boolean; animations: boolean };
export const defaultPreferences: Preferences = { theme: '浅色', language: '简体中文', fontScale: 100, notifications: true, sound: true, openWith: 'File Explorer', autoContext: true, animations: true };
const categoryIcons: Record<string, LucideIcon> = { '通用': SlidersHorizontal, '模型服务': Zap, '智能体': Bot, '工具与集成': Plug, '工作区与数据': FolderClosed, '连接与帮助': Server };
const tabs = settingsCategories.flatMap(category => category.sections.map(section => ({ ...section, keywords: `${category.name} ${section.keywords}` })));
type Props = {
  pets: PetStore;
  /** Opens a fresh session with the petdex install command for a new pet. */
  onInitPet?: () => void;
  /** Creates a fresh session and sends the Loopra update prompt (About page). */
  onAutoUpdate?: () => void;
  open: boolean; onClose: () => void; initialTab: string; server: string; workspaces: Workspace[]; onRefresh: () => Promise<void>;
  preferences: Preferences; onPreferences: (value: Preferences) => void;
  providers: Provider[]; onProviders: (value: Provider[]) => void | Promise<void>;
  sessions: Session[]; onRestore: (id: string) => void; notify: (message: string) => void;
  config: AgentSettings; onConfig: (value: AgentSettings) => void | Promise<void>;
  options: ComposerOptions; onOptions: (value: ComposerOptions) => void;
  defaultModel: string; onDefaultModel: (id: string) => void;
};

export default function Settings(props: Props) {
  const api = useMemo(() => new LoopraClient(props.server), [props.server]);
  const { open, onClose, preferences: prefs, onPreferences, providers, onProviders, sessions, onRestore, notify, config, onConfig: saveConfig } = props;
  const onConfig = (next: AgentSettings) => Promise.resolve(saveConfig(next)).catch(error => notify(error instanceof Error ? error.message : '保存配置失败'));
  const [tab, setTab] = useState(() => normalizeSettingsSection(props.initialTab));
  const [query, setQuery] = useState('');
  const [focusTarget, setFocusTarget] = useState('');
  useEffect(() => { if (open) { setTab(normalizeSettingsSection(props.initialTab)); setQuery(''); setFocusTarget(''); } }, [open, props.initialTab]);
  useEffect(() => {
    if (!open || query.trim() || !focusTarget) return;
    const frame = requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('.settings-content [data-setting-title], .settings-content label, .settings-content h2, .settings-content h3'))
        .find(element => (element.dataset.settingTitle || element.textContent?.trim()) === focusTarget);
      row?.scrollIntoView({ block: 'center' });
      const control = row?.closest('.settings-field')?.querySelector<HTMLElement>('input, textarea, button');
      (control || row)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, query, tab, focusTarget]);
  function openCategory(name: string) { setTab(normalizeSettingsSection(name)); setQuery(''); setFocusTarget(''); }
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onPreferences({ ...prefs, [key]: value });
  const pageProps = { config, onConfig, options: props.options, onOptions: props.onOptions, providers, sessions, notify };
  const results = searchSettings(query, tabs);
  const category = settingsCategoryFor(tab);
  const filtered = query.trim() ? settingsCategories.filter(item => results.some(result => settingsCategoryFor(result.category).name === item.name)) : settingsCategories;
  return <Modal isOpen={open} onClose={onClose} hideCloseButton backdrop="opaque" placement="center" classNames={{ wrapper: 'settings-wrapper', base: 'settings-modal rich-settings-modal', backdrop: 'modal-backdrop' }} aria-label="设置">
    <ModalContent>
      {/* Keep nested NextUI layout animations isolated from the modal's exit
          boundary so category changes cannot retain its portal after closing. */}
      <AnimatePresence initial={false} propagate={false}><div key="settings-layout" className="settings-layout">
      <nav className="settings-nav rich-settings-nav" aria-label="设置分类"><div className="settings-nav-top"><h1>设置</h1><Input size="sm" aria-label="搜索设置" placeholder="搜索设置…" value={query} onValueChange={setQuery} startContent={<Search size="0.875rem" />} variant="bordered" /></div>
        <div className="settings-category-list">{filtered.map(({ name }) => { const Icon = categoryIcons[name]; return <Button variant="light" key={name} title={name} aria-label={name} aria-current={category.name === name ? 'page' : undefined} className={category.name === name ? 'selected' : ''} onPress={() => openCategory(name)}>{category.name === name && <SelectionIndicator />}<Icon size="1.125rem" strokeWidth={1.8} /><span>{name}</span></Button>; })}</div>
        {!filtered.length && <p className="settings-nav-empty">没有匹配的设置</p>}
      </nav>
      <IconButton label="关闭设置" onClick={onClose} className="settings-close"><X size="1.25rem" /></IconButton>
      <div className="settings-mobile-select"><SelectField compact label="选择设置分类" value={category.name} onChange={openCategory} options={settingsCategories.map(item => item.name)} /></div>
      <Enter key={query.trim() ? 'search' : tab} as="section" className="settings-content rich-settings-content">
        {query.trim() ? <><h2>搜索设置</h2><p className="section-note" role="status">找到 {results.length} 项与“{query.trim()}”相关的设置</p><div className="settings-search-results">{results.map(item => <Button key={`${item.category}:${item.title}`} variant="light" onPress={() => { setTab(normalizeSettingsSection(item.category)); setFocusTarget(item.title); setQuery(''); }}><strong>{item.title}</strong><span>{settingsCategoryFor(item.category).name} →</span></Button>)}</div>{!results.length && <p className="section-note">试试设置名称，例如“提示音”“缩放”或“模型”。</p>}</> : <>
        {category.sections.length > 1 && (category.name === '工具与集成' ? <div className="settings-section-picker"><span>工具与集成</span><SelectField compact label="选择集成类型" value={tab} onChange={openCategory} options={category.sections.map(item => ({ value: item.name, label: item.label }))} /></div> : <div className="settings-section-tabs" aria-label={`${category.name}选项`}>{category.sections.map(item => <button key={item.name} type="button" aria-pressed={tab === item.name} onClick={() => openCategory(item.name)}>{item.label}</button>)}</div>)}
        {tab === '通用' && <>
          <div className="settings-page-intro"><h2>通用</h2><p>调整外观与日常使用偏好</p></div><h3 className="settings-section-title">外观与显示</h3><div className="settings-card">
            <SettingRow title="外观" description="选择应用的明暗外观"><SettingSegments label="外观" options={['☼ 浅色', '◉ 深色', '跟随系统']} value={prefs.theme === '浅色' ? '☼ 浅色' : prefs.theme === '深色' ? '◉ 深色' : prefs.theme} onChange={value => update('theme', value.replace(/^[☼◉] /, ''))} /></SettingRow>
            <SettingRow title="语言" description="侧栏与输入框的显示语言"><SettingSegments label="语言" options={['English', '简体中文']} value={prefs.language} onChange={value => update('language', value)} /></SettingRow>
            <SettingRow title="界面缩放" description="同步调整文字、侧栏宽度、控件尺寸与间距"><div className="font-scale-control"><Slider label="缩放比例" aria-label="全局界面缩放" size="sm" minValue={80} maxValue={150} step={0.1} value={prefs.fontScale} getValue={value => `${Number(Array.isArray(value) ? value[0] : value).toFixed(1).replace(/\.0$/, '')}%`} onChange={value => update('fontScale', Number((Array.isArray(value) ? value[0] : value).toFixed(1)))} /><div className="font-scale-footer"><span>80%</span><Button size="sm" variant="light" onPress={() => update('fontScale', 100)} isDisabled={prefs.fontScale === 100}>恢复 100%</Button><span>150%</span></div></div></SettingRow>
            <SettingRow title="代码字号" description="代码文字的基础字号，随界面比例同步缩放"><SelectField compact label="代码字号" value={String(config.codeFontSize)} onChange={value => onConfig({ ...config, codeFontSize: Number(value) })} options={[11, 12, 13, 14, 15, 16, 18, 20].map(size => ({ value: String(size), label: `${size}px` }))} /></SettingRow>
          </div>
          <h3 className="settings-section-title">回复通知</h3><div className="settings-card"><SettingRow title="系统通知" description="回答完成时显示应用内通知"><SettingSwitch label="系统通知" value={prefs.notifications} onChange={value => update('notifications', value)} /></SettingRow><SettingRow title="通知提示音" description="回答完成时播放简短提示音"><SettingSwitch label="通知提示音" value={prefs.sound} onChange={value => update('sound', value)} /></SettingRow></div>
          <h3 className="settings-section-title">使用体验</h3><div className="settings-card"><SettingRow title="默认打开应用" description="顶栏文件夹按钮默认打开的面板"><SelectField compact label="默认打开应用" value={prefs.openWith} onChange={value => update('openWith', value)} options={['File Explorer', 'Terminal', 'Git Bash']} startContent={<FolderClosed size="1.0625rem" />} /></SettingRow><SettingRow title="界面动画" description="弹窗与控件的过渡效果"><SettingSwitch label="界面动画" value={prefs.animations} onChange={value => update('animations', value)} /></SettingRow></div>
        </>}
        {tab === '通用' && <PetSettings pets={props.pets} enabled={config.petEnabled} onEnabled={petEnabled => onConfig({ ...config, petEnabled })} onInitPet={props.onInitPet} notify={notify} />}
        {tab === '模型供应商' && <ModelProviderSettings {...pageProps} server={props.server} onProviders={onProviders} defaultModel={props.defaultModel} onDefaultModel={props.onDefaultModel} />}
        {tab === '智能体与会话' && <><h2>会话默认</h2><AgentDefaults {...pageProps} /><h2>会话上下文</h2><div className="settings-card"><SettingRow title="自动工作区上下文" description="在新消息中包含当前工作区信息"><SettingSwitch label="自动工作区上下文" value={prefs.autoContext} onChange={value => update('autoContext', value)} /></SettingRow></div></>}
        {tab === '项目' && <BackendProjects server={props.server} workspaces={props.workspaces} sessions={sessions} onRefresh={props.onRefresh} />}
        {tab === '服务器' && <BackendServer server={props.server} onSave={serverUrl => { void Promise.resolve(onConfig({ ...config, serverUrl })).catch(error => notify(String(error))); }} />}
        {tab === '工具' && <ToolManager api={api} onRefresh={props.onRefresh} />}
        {tab === '子代理' && <SubAgentManager api={api} />}
        {tab === '数据面板' && <UsageDashboard api={api} />}
        {tab === '技能' && <SkillManager api={api} onRefresh={props.onRefresh} />}
        {(tab === '插件' || tab === '拓展包') && <ExtensionManager key={tab} api={api} plugin={tab === '插件'} />}
        {['OpenAPI', 'MCP 服务器', 'LSP 服务器'].includes(tab) && <IntegrationManager key={tab} api={api} kind={tab === 'OpenAPI' ? 'openapi' : tab === 'MCP 服务器' ? 'mcp' : 'lsp'} />}
        {tab === '系统提示词' && <PromptSettings {...pageProps} />}
        {tab === '浏览器' && <BrowserSettings api={api} />}
        {tab === '快捷键' && <><h2>快捷键</h2><div className="settings-card">{[['新建会话', 'Ctrl / ⌘ + N'], ['搜索会话或工作区', 'Ctrl / ⌘ + K'], ['打开设置', 'Ctrl / ⌘ + ,'], ['发送消息', 'Enter'], ['消息换行', 'Shift + Enter'], ['输入指令 / 文件引用', '/ 或 @'], ['选择建议', '↑ ↓ / Tab / Enter'], ['关闭弹窗', 'Esc']].map(([name, key]) => <SettingRow key={name} title={name}><kbd>{key}</kbd></SettingRow>)}</div></>}
        {tab === '关于' && <><div className="settings-about-heading"><LoopraMark /><div><h2>Loopra</h2><p>本地智能体工作区</p></div></div><VersionInfo api={api} notify={notify} onAutoUpdate={props.onAutoUpdate || (() => notify('请先连接 Loopra 并选择工作区'))} /><div className="settings-card"><SettingRow title="Loopra Web 服务" description={props.server}><Button size="sm" variant="light" onPress={() => openCategory('服务器')}>连接设置</Button></SettingRow><SettingRow title="开源主页" description="在 Gitee 或 GitHub 上关注 Loopra，欢迎点个 Star"><span className="about-community"><Button size="sm" variant="light" startContent={<Star size="0.875rem" />} onPress={() => window.open(GITEE_HOME_URL, '_blank', 'noreferrer')}>Gitee</Button><Button size="sm" variant="light" startContent={<Star size="0.875rem" />} onPress={() => window.open(GITHUB_HOME_URL, '_blank', 'noreferrer')}>GitHub</Button></span></SettingRow><SettingRow title="数据存储" description="工作区、会话与运行配置保存在后端；界面偏好保存在当前浏览器。"><span /></SettingRow></div></>}
        {tab === '已归档的会话' && <><h2>已隐藏会话</h2>{sessions.some(session => session.archived) ? <div className="settings-card">{sessions.filter(session => session.archived).map(session => <SettingRow key={session.id} title={session.title} description={session.workspace}><Button variant="light" className="restore-button" onPress={() => onRestore(session.id)}>恢复会话</Button></SettingRow>)}</div> : <div className="empty-setting"><Archive size="1.75rem" strokeWidth={1.5} /><h3>暂无隐藏会话</h3><p>在本机隐藏的会话可以在这里恢复。</p></div>}</>}
        </>}
      </Enter>
    </div></AnimatePresence></ModalContent>
  </Modal>;
}
