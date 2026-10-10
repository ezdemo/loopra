import { useEffect, useState } from 'react';
import { Button, Input, Modal, ModalContent, Slider } from '@nextui-org/react';
import { AnimatePresence } from 'framer-motion';
import { Archive, AppWindow, BarChart3, Bot, Code2, FileText, FlaskConical, FolderClosed, Globe, Info, Keyboard, Package, PawPrint, Plug, Puzzle, Search, Server, SlidersHorizontal, Sparkles, UserRound, Users, Wrench, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Enter, SelectionIndicator } from './Motion';
import type { Provider, Session } from '../lib';
import type { AgentSettings } from '../settings-data';
import type { ComposerOptions } from '../composer';
import { IconButton, LoopraMark } from './ui';
import { SettingRow, SettingSwitch, SelectField, SettingSegments } from './SettingControls';
import ModelProviderSettings from './ModelProviderSettings';
import { BackendProjects, BackendResources, BackendServer } from './BackendSettings';
import type { Workspace } from '../backend';
import { AgentDefaults, PromptSettings, ToolSettings } from './AgentSettingsPages';

export type Preferences = { theme: string; language: string; fontScale: number; notifications: boolean; sound: boolean; openWith: string; autoContext: boolean; animations: boolean };
export const defaultPreferences: Preferences = { theme: '浅色', language: '简体中文', fontScale: 100, notifications: true, sound: true, openWith: 'File Explorer', autoContext: true, animations: true };
const tabs: { name: string; icon: LucideIcon; group: string; keywords: string }[] = [
  { name: '通用', icon: SlidersHorizontal, group: '常规', keywords: '外观 主题 字体 语言 通知' },
  { name: '账户', icon: UserRound, group: '常规', keywords: '个人 方案' },
  { name: '项目', icon: FolderClosed, group: '常规', keywords: '路径 工作区 目录' },
  { name: '服务器', icon: Server, group: '常规', keywords: '后端 API 连接' },
  { name: '智能体与会话', icon: Bot, group: 'AI', keywords: '权限 推理 计划 快速' },
  { name: '模型供应商', icon: Zap, group: 'AI', keywords: '模型渠道 API 密钥 上下文 价格' },
  { name: '工具', icon: Wrench, group: 'AI', keywords: 'tools 只读 写入' },
  { name: '子代理', icon: Users, group: 'AI', keywords: '角色 提示词 白名单 subagent' },
  { name: '数据面板', icon: BarChart3, group: 'AI', keywords: '统计 token 用量 费用' },
  { name: '系统提示词', icon: FileText, group: 'AI', keywords: 'prompt loopra.md' },
  { name: '技能', icon: Sparkles, group: '集成', keywords: 'skill 市场 能力' },
  { name: '浏览器', icon: AppWindow, group: '集成', keywords: '预览 无头 Chrome' },
  { name: '插件', icon: Puzzle, group: '集成', keywords: '运行时 工具开关' },
  { name: '拓展包', icon: Package, group: '集成', keywords: 'Solon H-SPI jar zip' },
  { name: 'OpenAPI', icon: Globe, group: '集成', keywords: '接口 文档 认证' },
  { name: 'MCP 服务器', icon: Plug, group: '集成', keywords: 'stdio SSE 工具 传输' },
  { name: 'LSP 服务器', icon: Code2, group: '集成', keywords: '语言 命令 扩展名' },
  { name: '宠物', icon: PawPrint, group: '其他', keywords: '吉祥物 预览' },
  { name: '快捷键', icon: Keyboard, group: '其他', keywords: '键盘 输入' },
  { name: '实验室', icon: FlaskConical, group: '其他', keywords: '动画 动效' },
  { name: '已归档的会话', icon: Archive, group: '其他', keywords: '恢复 历史' },
  { name: '关于', icon: Info, group: '其他', keywords: '版本 技术栈' },
];
type Props = {
  open: boolean; onClose: () => void; initialTab: string; server: string; workspaces: Workspace[]; onRefresh: () => Promise<void>;
  preferences: Preferences; onPreferences: (value: Preferences) => void;
  providers: Provider[]; onProviders: (value: Provider[]) => void | Promise<void>;
  sessions: Session[]; onRestore: (id: string) => void; notify: (message: string) => void;
  config: AgentSettings; onConfig: (value: AgentSettings) => void | Promise<void>;
  options: ComposerOptions; onOptions: (value: ComposerOptions) => void;
  defaultModel: string; onDefaultModel: (id: string) => void;
};

export default function Settings(props: Props) {
  const { open, onClose, preferences: prefs, onPreferences, providers, onProviders, sessions, onRestore, notify, config, onConfig: saveConfig } = props;
  const onConfig = (next: AgentSettings) => Promise.resolve(saveConfig(next)).catch(error => notify(error instanceof Error ? error.message : '保存配置失败'));
  const [tab, setTab] = useState(props.initialTab);
  const [query, setQuery] = useState('');
  useEffect(() => { if (open) { setTab(props.initialTab); setQuery(''); } }, [open, props.initialTab]);
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onPreferences({ ...prefs, [key]: value });
  const pageProps = { config, onConfig, options: props.options, onOptions: props.onOptions, providers, sessions, notify };
  const filtered = tabs.filter(item => `${item.name} ${item.keywords}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <Modal isOpen={open} onClose={onClose} hideCloseButton backdrop="opaque" placement="center" classNames={{ wrapper: 'settings-wrapper', base: 'settings-modal rich-settings-modal', backdrop: 'modal-backdrop' }} aria-label="设置">
    <ModalContent>
      {/* Keep nested NextUI layout animations isolated from the modal's exit
          boundary so category changes cannot retain its portal after closing. */}
      <AnimatePresence initial={false} propagate={false}><div key="settings-layout" className="settings-layout">
      <nav className="settings-nav rich-settings-nav" aria-label="设置分类"><div className="settings-nav-top"><h1>设置</h1><Input size="sm" aria-label="搜索设置" placeholder="搜索设置…" value={query} onValueChange={setQuery} startContent={<Search size="0.875rem" />} variant="bordered" /></div>
        {['常规', 'AI', '集成', '其他'].map(group => filtered.some(item => item.group === group) && <div key={group}><p className="settings-nav-group">{group}</p>{filtered.filter(item => item.group === group).map(({ name, icon: Icon }) => <Button variant="light" key={name} title={name} aria-label={name} aria-current={tab === name ? 'page' : undefined} className={tab === name ? 'selected' : ''} onPress={() => setTab(name)}>{tab === name && <SelectionIndicator />}<Icon size="1.125rem" strokeWidth={1.8} /><span>{name}</span></Button>)}</div>)}
        {!filtered.length && <p className="settings-nav-empty">没有匹配的设置</p>}
      </nav>
      <IconButton label="关闭设置" onClick={onClose} className="settings-close"><X size="1.25rem" /></IconButton>
      <div className="settings-mobile-select"><SelectField compact label="选择设置分类" value={tab} onChange={setTab} options={tabs.map(item => item.name)} /></div>
      <Enter key={tab} as="section" className="settings-content rich-settings-content">
        {tab === '通用' && <>
          <h2>外观</h2><div className="settings-card">
            <SettingRow title="外观" description="选择应用的明暗外观"><SettingSegments label="外观" options={['☼ 浅色', '◉ 深色', '跟随系统']} value={prefs.theme === '浅色' ? '☼ 浅色' : prefs.theme === '深色' ? '◉ 深色' : prefs.theme} onChange={value => update('theme', value.replace(/^[☼◉] /, ''))} /></SettingRow>
            <SettingRow title="语言" description="选择界面显示语言"><SettingSegments label="语言" options={['English', '简体中文']} value={prefs.language} onChange={value => update('language', value)} /></SettingRow>
            <SettingRow title="界面缩放" description="同步调整文字、侧栏宽度、控件尺寸与间距"><div className="font-scale-control"><Slider label="缩放比例" aria-label="全局界面缩放" size="sm" minValue={80} maxValue={150} step={0.1} value={prefs.fontScale} getValue={value => `${Number(Array.isArray(value) ? value[0] : value).toFixed(1).replace(/\.0$/, '')}%`} onChange={value => update('fontScale', Number((Array.isArray(value) ? value[0] : value).toFixed(1)))} /><div className="font-scale-footer"><span>80%</span><Button size="sm" variant="light" onPress={() => update('fontScale', 100)} isDisabled={prefs.fontScale === 100}>恢复 100%</Button><span>150%</span></div></div></SettingRow>
            <SettingRow title="代码字号" description="代码文字的基础字号，随界面比例同步缩放"><SelectField compact label="代码字号" value={String(config.codeFontSize)} onChange={value => onConfig({ ...config, codeFontSize: Number(value) })} options={[11, 12, 13, 14, 15, 16, 18, 20].map(size => ({ value: String(size), label: `${size}px` }))} /></SettingRow>
          </div>
          <h2>通知</h2><div className="settings-card"><SettingRow title="系统通知" description="回答完成时显示应用内通知"><SettingSwitch label="系统通知" value={prefs.notifications} onChange={value => update('notifications', value)} /></SettingRow><SettingRow title="通知提示音" description="保存提示音偏好，当前为界面演示"><SettingSwitch label="通知提示音" value={prefs.sound} onChange={value => update('sound', value)} /></SettingRow></div>
          <h2>打开方式</h2><div className="settings-card"><SettingRow title="默认打开应用" description="顶栏文件夹按钮默认打开的面板"><SelectField compact label="默认打开应用" value={prefs.openWith} onChange={value => update('openWith', value)} options={['File Explorer', 'Terminal', 'Git Bash']} startContent={<FolderClosed size="1.0625rem" />} /></SettingRow></div>
        </>}
        {tab === '模型供应商' && <ModelProviderSettings {...pageProps} server={props.server} onProviders={onProviders} defaultModel={props.defaultModel} onDefaultModel={props.onDefaultModel} />}
        {tab === '账户' && <><h2>本地运行</h2><div className="settings-card"><SettingRow title="Loopra Web 服务" description={props.server}><span className="tag">本地连接</span></SettingRow><SettingRow title="数据存储" description="项目、会话与运行配置保存在 Loopra 后端；界面偏好保存在当前浏览器。"><span /></SettingRow></div></>}
        {tab === '智能体与会话' && <><h2>智能体与会话</h2><AgentDefaults {...pageProps} /><h2>会话上下文</h2><div className="settings-card"><SettingRow title="自动工作区上下文" description="在新消息中包含当前工作区信息"><SettingSwitch label="自动工作区上下文" value={prefs.autoContext} onChange={value => update('autoContext', value)} /></SettingRow><SettingRow title="后端会话" description="会话保存到 Loopra 后端，可刷新并继续"><span className="subtle">{sessions.filter(session => !session.archived).length} 个会话</span></SettingRow></div></>}
        {tab === '项目' && <BackendProjects server={props.server} workspaces={props.workspaces} onRefresh={props.onRefresh} />}
        {tab === '服务器' && <BackendServer server={props.server} onSave={serverUrl => { void Promise.resolve(onConfig({ ...config, serverUrl })).catch(error => notify(String(error))); }} />}
        {tab === '工具' && <ToolSettings {...pageProps} />}
        {['子代理', '数据面板', '技能', '插件', '拓展包', 'OpenAPI', 'MCP 服务器', 'LSP 服务器'].includes(tab) && <BackendResources key={tab} tab={tab} server={props.server} />}
        {tab === '系统提示词' && <PromptSettings {...pageProps} />}
        {tab === '宠物' && <><h2>宠物</h2><div className="settings-card"><SettingRow title="输入栏吉祥物" description="当前界面的本地显示偏好"><SettingSwitch label="输入栏吉祥物" value={config.petEnabled} onChange={petEnabled => void onConfig({ ...config, petEnabled })} /></SettingRow></div></>}
        {tab === '浏览器' && <><h2>浏览器</h2><p className="section-note">Agent 的浏览器能力由 Loopra 后端和浏览器桥接服务提供。请在 <a href={`${props.server}/legacy.html`} target="_blank" rel="noreferrer">Loopra 高级控制台</a> 中配置。</p></>}
        {tab === '快捷键' && <><h2>快捷键</h2><div className="settings-card">{[['新建会话', 'Ctrl / ⌘ + N'], ['搜索会话或工作区', 'Ctrl / ⌘ + K'], ['打开设置', 'Ctrl / ⌘ + ,'], ['发送消息', 'Enter'], ['消息换行', 'Shift + Enter'], ['输入指令 / 文件引用', '/ 或 @'], ['选择建议', '↑ ↓ / Tab / Enter'], ['关闭弹窗', 'Esc']].map(([name, key]) => <SettingRow key={name} title={name}><kbd>{key}</kbd></SettingRow>)}</div></>}
        {tab === '关于' && <><h2>关于</h2><div className="about-brand"><LoopraMark />Loopra</div><div className="settings-card"><SettingRow title="Loopra Web UI" description="连接 Loopra 的 React 客户端"><span className="tag">v0.1.0</span></SettingRow><SettingRow title="技术栈" description="React · TypeScript · NextUI · Vite"><Info size="1.375rem" /></SettingRow></div><p className="section-note">设置项参考 Loopra Web，保留当前项目视觉风格。已连接 Loopra Web 后端。</p></>}
        {tab === '实验室' && <><h2>实验室</h2><div className="settings-card"><SettingRow title="界面动画" description="保留 NextUI 组件的交互动效"><SettingSwitch label="界面动画" value={prefs.animations} onChange={value => update('animations', value)} /></SettingRow></div><div className="empty-setting"><FlaskConical size="2.125rem" strokeWidth={1.3} /><h3>探索更多可能</h3><p>偏好与组件动效保持同步。</p></div></>}
        {tab === '已归档的会话' && <><h2>已归档的会话</h2>{sessions.some(session => session.archived) ? <div className="settings-card">{sessions.filter(session => session.archived).map(session => <SettingRow key={session.id} title={session.title} description={session.workspace}><Button variant="light" className="restore-button" onPress={() => onRestore(session.id)}>恢复会话</Button></SettingRow>)}</div> : <div className="empty-setting"><Archive size="2.125rem" strokeWidth={1.3} /><h3>还没有归档的会话</h3><p>这里恢复在本机隐藏的会话，后端历史始终保留。</p></div>}</>}
      </Enter>
    </div></AnimatePresence></ModalContent>
  </Modal>;
}
