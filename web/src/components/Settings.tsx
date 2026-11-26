import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@nextui-org/react';
import { ArrowUpRight, BookOpen, Bot, ChevronDown, ChevronRight, Database, FolderClosed, Monitor, Plug, Search, Server, SlidersHorizontal, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Enter, SelectionIndicator } from './Motion';
import { normalizeUiScale, UI_SCALE_LEVELS, type Provider, type Session } from '../lib';
import type { AgentSettings } from '../settings-data';
import type { ComposerOptions } from '../composer';
import { LoopraMark } from './ui';
import { PageActions, SettingRow, SettingSwitch, SelectField, SettingSegments } from './SettingControls';
import ModelProviderSettings from './ModelProviderSettings';
import ModelUsageSettings from './ModelUsageSettings';
import { BackendProjects, BackendServer } from './BackendSettings';
import { LoopraClient } from '../backend';
import IntegrationManager, { McpPublishingSettings } from './IntegrationManager';
import { SubAgentManager, ToolManager, UsageDashboard } from './ResourceManagers';
import { PluginFrame, type PluginContext } from './PluginFrame';
import { PluginGlyph, selectedPluginMenu, type PluginMenu } from './plugin-icons';
import type { Workspace } from '../backend';
import { AgentDefaults, PromptSettings } from './AgentSettingsPages';
import ExternalAgentsPage from './ExternalAgentsPage';
import { searchSettings } from '../settings-search';
import { normalizeSettingsSection, settingsCategories, settingsCategoryFor } from '../settings-navigation';
import { pluginSettingsCategory, settingsWithPluginMenus } from '../settings-plugin-menu';
import { visibleApplications } from '../workspace-launcher';
import PetSettings from './PetSettings';
import { AccentColorSettings } from './AccentColorSettings';
import type { PetStore } from '../usePets';
import { VersionInfoPanel } from './VersionInfo';
import type { CoreServiceUpdateController } from './CoreServiceUpdate';
import type { DesktopUpdateController } from './DesktopUpdate';
import ProxySettings from './ProxySettings';
import MemorySettings from './MemorySettings';
import RemoteAccessSettings from './RemoteAccessSettings';
import { GITEE_HOME_URL, GITHUB_HOME_URL } from '../update-scripts';
import type { VersionCheck } from '../version';

export type Preferences = { accentColor: string; theme: string; language: string; fontScale: number; notifications: boolean; sound: boolean; openWith: string; autoContext: boolean; animations: boolean };
export const defaultPreferences: Preferences = { accentColor: '', theme: '浅色', language: '简体中文', fontScale: 100, notifications: true, sound: true, openWith: 'File Explorer', autoContext: true, animations: true };
const categoryIcons: Record<string, LucideIcon> = { '偏好设置': SlidersHorizontal, '模型服务': Zap, '智能体': Bot, '工具与集成': Plug, '工作区与数据': FolderClosed, '连接与帮助': Server };
type Props = {
  pluginContext?: PluginContext;
  onOpenSessions?: () => void;
  onOpenRequirements?: () => void;
  /** 连接类资源统一在能力库的连接器页管理；提供时把入口跳过去。 */
  onOpenConnectors?: () => void;
  onOpenHelp?: () => void;
  pets: PetStore;
  /** Desktop mygo shows the pet in its own window, so position reset has to reach that window. */
  standalonePet?: boolean;
  onResetPetPosition?: () => void | Promise<void>;
  /** Opens a fresh session with the petdex install command for a new pet. */
  onInitPet?: () => void;
  /** 外部 Agent 可见性变化后让外层重新拉取引擎列表。 */
  onEnginesChanged?: () => void;
  initialTab: string; server: string; workspaces: Workspace[]; onRefresh: () => Promise<void>;
  /** Launcher ids the service host reports as usable; null/absent means unknown, so don't filter. */
  availableApplications?: string[] | null;
  preferences: Preferences; onPreferences: (value: Preferences) => void;
  profileReady: boolean; onEditProfile: () => void;
  providers: Provider[]; onProviders: (value: Provider[]) => void | Promise<void>;
  sessions: Session[]; notify: (message: string) => void;
  config: AgentSettings; onConfig: (value: AgentSettings) => void | Promise<void>;
  options: ComposerOptions; onOptions: (value: ComposerOptions) => void;
  defaultModel: string; onDefaultModel: (id: string) => void;
  updateCheck?: VersionCheck;
  coreUpdate: CoreServiceUpdateController;
  desktopUpdate?: DesktopUpdateController;
};

export default function Settings(props: Props) {
  const { t } = useTranslation();
  const api = useMemo(() => new LoopraClient(props.server), [props.server]);
  const { preferences: prefs, onPreferences, providers, onProviders, sessions, notify, config, onConfig: saveConfig, coreUpdate } = props;
  const onConfig = (next: AgentSettings) => Promise.resolve(saveConfig(next)).catch(error => notify(error instanceof Error ? error.message : '保存配置失败'));
  const [tab, setTab] = useState(() => normalizeSettingsSection(props.initialTab));
  const [expandedCategory, setExpandedCategory] = useState(() => settingsCategoryFor(props.initialTab).name);
  const [pluginMenus, setPluginMenus] = useState<PluginMenu[]>([]);
  const [query, setQuery] = useState('');
  const [focusTarget, setFocusTarget] = useState('');
  const page = useRef<HTMLElement>(null);
  useEffect(() => { page.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { setTab(normalizeSettingsSection(props.initialTab)); setExpandedCategory(settingsCategoryFor(props.initialTab).name); setQuery(''); setFocusTarget(''); }, [props.initialTab]);
  useEffect(() => {
    const controller = new AbortController();
    void api.request<{ id: string; menu?: PluginMenu }[]>('/plugins', 'GET', undefined, controller.signal)
      .then(items => {
        if (controller.signal.aborted) return;
        setPluginMenus(items.flatMap(item => item.menu?.title ? [{ ...item.menu, id: item.id }] : []));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    if (!tab.startsWith('plugin:') || selectedPluginMenu(tab, pluginMenus)) return;
    setTab('通用');
    setExpandedCategory('偏好设置');
  }, [tab, pluginMenus]);
  useEffect(() => {
    if (query.trim() || !focusTarget) return;
    const frame = requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('.settings-content [data-setting-title], .settings-content label, .settings-content h2, .settings-content h3'))
        .find(element => (element.dataset.settingTitle || element.textContent?.trim()) === focusTarget);
      row?.scrollIntoView({ block: 'center' });
      const control = row?.closest('.settings-field')?.querySelector<HTMLElement>('input, textarea, button');
      (control || row)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [query, tab, focusTarget]);
  function openCategory(name: string) {
    if (name === 'MCP' && props.onOpenConnectors) { props.onOpenConnectors(); return; }
    const selection = selectedPluginMenu(name, pluginMenus);
    if (selection) { openPluginMenu(selection.menu, selection.child?.id); return; }
    setTab(normalizeSettingsSection(name)); setExpandedCategory(settingsCategoryFor(name).name); setQuery(''); setFocusTarget('');
  }
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onPreferences({ ...prefs, [key]: value });
  const pageProps = { config, onConfig, options: props.options, onOptions: props.onOptions, providers, sessions, notify };
  // Only launchers the service host actually has; an already-saved one stays listed even if it
  // has since gone away, so the stored preference still shows what it is set to.
  const openWithNames = visibleApplications(props.availableApplications).map(item => item.name);
  const openWithOptions = openWithNames.includes(prefs.openWith) ? openWithNames : [prefs.openWith, ...openWithNames];
  const navigationCategories = settingsWithPluginMenus(pluginMenus);
  const localizedCategory = (item: { name: string; key?: string }) => item.key ? t(`settings.category.${item.key}`) : item.name;
  const localizedSection = (item: { label: string; key?: string }) => item.key ? t(`settings.section.${item.key}`) : item.label;
  const tabs = navigationCategories.flatMap(category => category.sections.map(section => ({ ...section, keywords: `${localizedCategory(category)} ${localizedSection(section)} ${section.keywords}` })));
  const categoryForSection = (name: string) => navigationCategories.find(category => category.sections.some(section => section.name === name)) || settingsCategoryFor(name);
  const results = searchSettings(query, tabs).map(item => ({ ...item, title: tabs.find(section => section.name === item.title) ? localizedSection(tabs.find(section => section.name === item.title)!) : item.title }));
  const pluginSelection = selectedPluginMenu(tab, pluginMenus);
  const category = pluginSelection && !pluginSettingsCategory(pluginSelection.menu) ? { name: pluginSelection.menu.title, sections: [{ name: tab, label: pluginSelection.title }] } : categoryForSection(tab);
  const currentSection = category.sections.find(section => section.name === tab)!;
  const filtered = query.trim() ? navigationCategories.filter(item => results.some(result => categoryForSection(result.category).name === item.name)) : navigationCategories;
  const menuQuery = query.trim().toLowerCase();
  const visibleMenus = pluginMenus.filter(menu => !pluginSettingsCategory(menu) && (!menuQuery || menu.title.toLowerCase().includes(menuQuery) || menu.children?.some(child => child.title.toLowerCase().includes(menuQuery))));
  function openPluginMenu(menu: PluginMenu, childId = '') {
    const child = childId || (menu.page ? '' : menu.children?.[0]?.id || '');
    setTab(child ? `plugin:${menu.id}:${child}` : `plugin:${menu.id}`);
    setExpandedCategory(pluginSettingsCategory(menu) || `plugin:${menu.id}`);
    setQuery('');
    setFocusTarget('');
  }
  return <section className="settings-page" aria-label={t('settings.title')} tabIndex={-1} ref={page}><div className="settings-layout">
      <nav className="settings-nav rich-settings-nav" aria-label={t('settings.categoriesAria')}><div className="settings-nav-top"><h1>{t('settings.title')}</h1><Input size="sm" aria-label={t('settings.searchAria')} placeholder={t('settings.searchPlaceholder')} value={query} onValueChange={setQuery} startContent={<Search size="0.875rem" />} variant="bordered" /></div>
        <div className="settings-category-list">{filtered.map(({ name, key, sections }) => {
          const Icon = categoryIcons[name]; const active = category.name === name && !query.trim(); const expanded = active && expandedCategory === name;
          const displayCategory = localizedCategory({ name, key });
          return <section key={name} className="settings-nav-category">
            <Button variant="light" title={displayCategory} aria-label={displayCategory} aria-current={active && sections.length === 1 ? 'page' : undefined} aria-expanded={sections.length > 1 ? expanded : undefined} className={active ? 'selected' : ''} onPress={() => active && sections.length > 1 ? setExpandedCategory(expanded ? '' : name) : openCategory(name)}><Icon size="1.125rem" strokeWidth={1.8} /><span>{displayCategory}</span>{sections.length > 1 && <ChevronDown size="0.875rem" className="settings-category-chevron" />}</Button>
            {expanded && sections.length > 1 && <div className="settings-submenu" role="group" aria-label={t('settings.categoryOptions', { category: displayCategory })}>{sections.map(section => {
              const plugin = selectedPluginMenu(section.name, pluginMenus);
              return <Button key={section.name} variant="light" aria-current={tab === section.name ? 'page' : undefined} className={tab === section.name ? 'selected' : ''} onPress={() => openCategory(section.name)}>{tab === section.name && <SelectionIndicator />}{plugin && <PluginGlyph api={api} pluginId={plugin.menu.id} icon={plugin.child?.icon || plugin.menu.icon} className="settings-menu-icon" size="0.875rem" />}<span>{localizedSection(section)}</span></Button>;
            })}</div>}
          </section>;
        })}
        {visibleMenus.map(menu => {
          const key = `plugin:${menu.id}`;
          const active = tab === key || tab.startsWith(`${key}:`);
          const expanded = expandedCategory === key && !!menu.children?.length;
          const letter = [...menu.title.trim()][0] || '?';
          return <section key={key} className="settings-nav-category settings-plugin-category">
            <Button variant="light" title={menu.title} aria-label={menu.title} aria-current={active && !menu.children?.length ? 'page' : undefined} aria-expanded={menu.children?.length ? expanded : undefined} className={active ? 'selected' : ''} onPress={() => active && menu.children?.length ? setExpandedCategory(expanded ? '' : key) : openPluginMenu(menu)}>
              {menu.icon ? <PluginGlyph api={api} pluginId={menu.id} icon={menu.icon} className="settings-menu-icon" /> : <span className="plugin-menu-letter" aria-hidden="true">{letter}</span>}
              <span>{menu.title}</span>
              {!!menu.children?.length && <ChevronDown size="0.875rem" className="settings-category-chevron" />}
            </Button>
            {expanded && <div className="settings-submenu" role="group" aria-label={t('settings.categoryOptions', { category: menu.title })}>{menu.children?.map(child => <Button key={child.id} variant="light" aria-current={tab === `${key}:${child.id}` ? 'page' : undefined} className={tab === `${key}:${child.id}` ? 'selected' : ''} onPress={() => openPluginMenu(menu, child.id)}>{tab === `${key}:${child.id}` && <SelectionIndicator />}{child.icon ? <PluginGlyph api={api} pluginId={menu.id} icon={child.icon} className="settings-menu-icon" size="0.875rem" /> : null}<span>{child.title}</span></Button>)}</div>}
          </section>;
        })}
        </div>
        {!filtered.length && !visibleMenus.length && <p className="settings-nav-empty">{t('settings.noMatches')}</p>}
      </nav>
      <div className="settings-main">
      <header className="settings-content-header">
        <div className="settings-breadcrumb" aria-label={t('settings.currentLocation')}>{query.trim() ? <span>{t('settings.searchResults')}</span> : <><span>{localizedCategory(category)}</span>{localizedCategory(category) !== localizedSection(currentSection) && <><ChevronRight size="0.875rem" /><span>{localizedSection(currentSection)}</span></>}</>}</div>
      </header>
      <Enter key={query.trim() ? 'search' : tab} as="section" className={`settings-content rich-settings-content${!query.trim() && tab === '模型供应商' ? ' provider-settings-content' : ''}`}>
        <nav className="settings-mobile-categories" aria-label={t('settings.mobileCategories')}>{settingsCategories.map(item => <Button key={item.name} size="sm" variant="light" aria-pressed={!query.trim() && category.name === item.name} onPress={() => openCategory(item.name)}>{localizedCategory(item)}</Button>)}</nav>
        {!query.trim() && category.sections.length > 1 && <nav className="settings-mobile-sections" aria-label={t('settings.pageNavigation', { category: localizedCategory(category) })}>{category.sections.map(item => <Button key={item.name} size="sm" variant="light" aria-pressed={tab === item.name} onPress={() => openCategory(item.name)}>{localizedSection(item)}</Button>)}</nav>}
        {query.trim() ? <><PageActions title={t('settings.searchResults')} /><p className="section-note" role="status">{t('settings.found', { count: results.length, query: query.trim() })}</p><div className="settings-search-results">{results.map(item => <Button key={`${item.category}:${item.title}`} variant="light" onPress={() => { openCategory(item.category); setFocusTarget(item.title); }}><strong>{item.title}</strong><span>{localizedCategory(categoryForSection(item.category))}<ChevronRight size=".875rem" aria-hidden="true" /></span></Button>)}</div>{!results.length && <p className="section-note">{t('settings.searchHint')}</p>}</> : pluginSelection ? <div className="plugin-settings-page"><PluginFrame api={api} id={pluginSelection.menu.id} name={pluginSelection.title} slot="menu" menuItem={pluginSelection.child?.id || ''} title={pluginSelection.title} context={props.pluginContext} /></div> : <>
        {tab === '通用' && <>
          <PageActions title={t('settings.general')} /><div className="settings-card"><SettingRow title={t('settings.profile')} description={t('settings.profileDescription')}><Button size="sm" variant="flat" isDisabled={!props.profileReady} onPress={props.onEditProfile}>{t('common.edit')}</Button></SettingRow></div>
          <h3 className="settings-section-title">{t('settings.appearanceDisplay')}</h3><div className="settings-card">
            <SettingRow title={t('settings.appearance')} description={t('settings.appearanceDescription')}><SettingSegments label={t('settings.appearance')} options={[{ value: '☼ 浅色', label: `☼ ${t('settings.themeLight')}` }, { value: '◉ 深色', label: `◉ ${t('settings.themeDark')}` }, { value: '跟随系统', label: t('settings.themeSystem') }]} value={prefs.theme === '浅色' ? '☼ 浅色' : prefs.theme === '深色' ? '◉ 深色' : prefs.theme} onChange={value => update('theme', value.replace(/^[☼◉] /, ''))} /></SettingRow>
            <SettingRow title={t('settings.accentColor')}><AccentColorSettings value={prefs.accentColor} onChange={value => update('accentColor', value)} /></SettingRow>
            <SettingRow title={t('settings.language')} description={t('settings.languageDescription')}><SettingSegments label={t('settings.language')} options={['English', '简体中文']} value={prefs.language} onChange={value => update('language', value)} /></SettingRow>
            <SettingRow title={t('settings.uiScale')} description={t('settings.uiScaleDescription')}><div className="font-scale-control"><SettingSegments label={t('settings.globalUiScale')} options={UI_SCALE_LEVELS.map(level => `${level}%`)} value={`${normalizeUiScale(prefs.fontScale)}%`} onChange={value => update('fontScale', Number(value.replace('%', '')))} /></div></SettingRow>
          </div>
          <h3 className="settings-section-title">{t('settings.replyNotifications')}</h3><div className="settings-card"><SettingRow title={t('settings.systemNotifications')} description={t('settings.systemNotificationsDescription')}><SettingSwitch label={t('settings.systemNotifications')} value={prefs.notifications} onChange={value => update('notifications', value)} /></SettingRow><SettingRow title={t('settings.notificationSound')} description={t('settings.notificationSoundDescription')}><SettingSwitch label={t('settings.notificationSound')} value={prefs.sound} onChange={value => update('sound', value)} /></SettingRow></div>
          <h3 className="settings-section-title">{t('settings.experience')}</h3><div className="settings-card"><SettingRow title={t('settings.defaultOpenApp')} description={t('settings.defaultOpenAppDescription')}><SelectField compact label={t('settings.defaultOpenApp')} value={prefs.openWith} onChange={value => update('openWith', value)} options={openWithOptions} startContent={<FolderClosed size="1.0625rem" />} /></SettingRow><SettingRow title={t('settings.uiAnimations')} description={t('settings.uiAnimationsDescription')}><SettingSwitch label={t('settings.uiAnimations')} value={prefs.animations} onChange={value => update('animations', value)} /></SettingRow></div>
        </>}
        {tab === '宠物' && <PetSettings pets={props.pets} enabled={config.petEnabled} standalone={props.standalonePet} onResetPosition={props.onResetPetPosition} onEnabled={petEnabled => onConfig({ ...config, petEnabled })} onInitPet={props.onInitPet} notify={notify} />}
        {tab === '模型供应商' && <ModelProviderSettings providers={providers} server={props.server} onProviders={onProviders} />}
        {tab === '模型用途' && <ModelUsageSettings {...pageProps} defaultModel={props.defaultModel} onDefaultModel={props.onDefaultModel} onManageModels={() => openCategory('模型供应商')} />}
        {tab === '智能体与会话' && <><PageActions title={t('settings.sessionDefaults')} /><AgentDefaults {...pageProps} /><h2>{t('settings.sessionContext')}</h2><div className="settings-card"><SettingRow title={t('settings.autoWorkspaceContext')} description={t('settings.autoWorkspaceContextDescription')}><SettingSwitch label={t('settings.autoWorkspaceContext')} value={prefs.autoContext} onChange={value => update('autoContext', value)} /></SettingRow></div></>}
        {tab === '项目' && <><BackendProjects server={props.server} workspaces={props.workspaces} sessions={sessions} onRefresh={props.onRefresh} /><h3 className="settings-section-title">{t('settings.sessionsAndRequirements')}</h3><div className="settings-card"><SettingRow title={t('settings.sessionManagement')} description={t('settings.sessionManagementDescription')}><Button size="sm" variant="flat" onPress={props.onOpenSessions}>{t('settings.openSessionManagement')}</Button></SettingRow><SettingRow title={t('settings.requirementsPool')} description={t('settings.requirementsPoolDescription')}><Button size="sm" variant="flat" onPress={props.onOpenRequirements}>{t('settings.openRequirementsPool')}</Button></SettingRow></div></>}
        {tab === '服务器' && <BackendServer server={props.server} onSave={serverUrl => { void Promise.resolve(onConfig({ ...config, serverUrl })).catch(error => notify(String(error))); }} />}
        {tab === '网络代理' && <ProxySettings api={api} notify={notify} />}
        {tab === '远程访问' && <RemoteAccessSettings api={api} notify={notify} />}
        {tab === '工具' && <ToolManager api={api} onRefresh={props.onRefresh} />}
        {tab === '子代理' && <SubAgentManager api={api} />}
        {tab === '外部 Agent' && <ExternalAgentsPage api={api} notify={notify} onChanged={props.onEnginesChanged} />}
        {tab === '数据面板' && <UsageDashboard api={api} />}
        {tab === 'MCP 服务器' && <McpPublishingSettings api={api} />}
        {tab === 'MCP' && <IntegrationManager api={api} kind="mcp" />}
        {tab === '系统提示词' && <PromptSettings {...pageProps} />}
        {tab === '记忆' && <MemorySettings api={api} workspaces={props.workspaces} initialWorkspaceHash={props.pluginContext?.workspaceHash} />}
        {tab === '快捷键' && <><PageActions title={t('settings.section.shortcuts')} /><div className="settings-card">{[[t('settings.shortcut.newChat'), 'Ctrl / ⌘ + N'], [t('settings.shortcut.search'), 'Ctrl / ⌘ + K'], [t('settings.shortcut.openSettings'), 'Ctrl / ⌘ + ,'], [t('settings.shortcut.toggleSidebar'), 'Ctrl / ⌘ + B'], [t('settings.shortcut.sendMessage'), 'Enter'], [t('settings.shortcut.newline'), 'Shift + Enter'], [t('settings.shortcut.commandsFiles'), '/ 或 @'], [t('settings.shortcut.chooseSuggestion'), '↑ ↓ / Tab / Enter'], [t('settings.shortcut.closePopup'), 'Esc']].map(([name, key]) => <SettingRow key={name} title={name}><kbd>{key}</kbd></SettingRow>)}</div></>}
        {tab === '关于' && <div className="about-settings">
          <header className="about-heading"><LoopraMark /><div><h2>{t('settings.aboutTitle')}</h2><p>{t('settings.aboutDescription')}</p></div></header>
          <VersionInfoPanel api={api} notify={notify} initialCheck={props.updateCheck} coreUpdate={coreUpdate} desktopUpdate={props.desktopUpdate} />
          <section className="about-storage" aria-label={t('settings.storageTitle')}>
            <div className="about-section-heading"><h3>{t('settings.storageTitle')}</h3></div>
            <div className="about-storage-card">
              <div className="about-connection"><span className="about-row-icon"><Server size="1rem" aria-hidden="true" /></span><div><h4>{t('settings.currentService')}</h4><p>{props.server}</p></div><Button size="sm" variant="light" onPress={() => openCategory('服务器')}>{t('settings.connectionSettings')}<ChevronRight size=".875rem" aria-hidden="true" /></Button></div>
              <div className="about-storage-locations">
                <div><Database size="1rem" aria-hidden="true" /><div><h4>{t('settings.serverSettings')}</h4><p>{t('settings.serverSettingsDescription')}</p></div></div>
                <div><Monitor size="1rem" aria-hidden="true" /><div><h4>{t('settings.localConnection')}</h4><p>{t('settings.localConnectionDescription')}</p></div></div>
              </div>
            </div>
          </section>
          <footer className="about-footer"><button type="button" onClick={props.onOpenHelp}><BookOpen size="1rem" aria-hidden="true" />{t('settings.helpCenter')}<ArrowUpRight size=".875rem" aria-hidden="true" /></button><div><span>{t('settings.openSourceHome')}</span><a href={GITEE_HOME_URL} target="_blank" rel="noreferrer">Gitee<ArrowUpRight size=".875rem" aria-hidden="true" /></a><a href={GITHUB_HOME_URL} target="_blank" rel="noreferrer">GitHub<ArrowUpRight size=".875rem" aria-hidden="true" /></a></div></footer>
        </div>}
        </>}
      </Enter>
      </div>
    </div></section>;
}
