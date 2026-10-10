import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Input, Modal, ModalContent } from '@nextui-org/react';
import { Archive, Check, ChevronDown, Copy, FileCode2, FolderClosed, FolderOpen, GitBranch, MessageCirclePlus, MoreHorizontal, PanelLeft, PanelRight, Plus, Search as SearchIcon, Settings as SettingsIcon, SlidersHorizontal, SquareTerminal } from 'lucide-react';
import { getSessionMessages, useLocalState } from './lib';
import type { Provider, Session } from './lib';
import { LoopraMark, IconButton } from './components/ui';
import { Messages } from './components/Conversation';
import ChangesPanel, { TerminalPanel } from './components/Panels';
import Settings, { defaultPreferences } from './components/Settings';
import type { Preferences } from './components/Settings';
import Search from './components/Search';
import type { FileChange, Message } from './chat';
import Composer from './components/Composer';
import { defaultAgentSettings, type AgentSettings } from './settings-data';
import { defaultOptions, emptyContext, getModelCatalog, type ComposerContext, type ComposerOptions } from './composer';
import { applyEvent, DEFAULT_SERVER, historyMessages, permissionLabel, permissionValue, providerChannels, remoteSession, serverAddress, sessionQuery, sessionRoute, type HistoryMessage } from './backend';
import useLoopra from './useLoopra';
import { AppMotion, Collapse, Enter, Popup, SelectionIndicator, SidebarSurface, Toast } from './components/Motion';

export default function App() {
  const [server, setServer] = useLocalState('backend-server', DEFAULT_SERVER);
  const backend = useLoopra(server);
  const { api, sessions, setSessions, providers, workspaces } = backend;
  const [hiddenSessions, setHiddenSessions] = useLocalState<string[]>(`hidden-sessions:${server}`, []);
  const [preferences, setPreferences] = useLocalState<Preferences>('preferences', defaultPreferences);
  const [composerOptions, setComposerOptions] = useLocalState<ComposerOptions>('composer-options', defaultOptions);
  const [defaultModel, setDefaultModel] = useLocalState('default-model', defaultOptions.modelId);
  const [agentSettings, setAgentSettings] = useLocalState<AgentSettings>('agent-settings', defaultAgentSettings);
  const [composerContext, setComposerContext] = useState<ComposerContext>(emptyContext);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 760);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [changes, setChanges] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [gitBranch, setGitBranch] = useState('工作区');
  const [terminalShell, setTerminalShell] = useState('PowerShell');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('通用');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [sortNewest, setSortNewest] = useState(false);
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const activeRequest = useRef<{ controller: AbortController; requestId: string; session?: Session; stopping?: boolean }>();
  const historyRequest = useRef<AbortController>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const settingsQueue = useRef(Promise.resolve());
  const session = sessions.find(item => item.id === activeId && !hiddenSessions.includes(item.id));
  const isHome = !session;
  const visibleSessions = sessions.filter(item => !hiddenSessions.includes(item.id));
  const currentWorkspace = workspaces.find(item => item.hash === workspace);
  const workspaceName = currentWorkspace?.name || '选择工作区';
  const isDark = preferences.theme === '深色' || (preferences.theme === '跟随系统' && systemDark);

  useLayoutEffect(() => {
    // Root tokens also reach NextUI menus, modals and tooltips rendered in portals.
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', String(preferences.fontScale / 100));
    root.style.setProperty('--configured-code-font', `${agentSettings.codeFontSize / 16}rem`);
    return () => { root.style.removeProperty('--ui-scale'); root.style.removeProperty('--configured-code-font'); };
  }, [preferences.fontScale, agentSettings.codeFontSize]);

  function notify(message: string) { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2600); }
  function mutation(task: () => Promise<void>) {
    const result = settingsQueue.current.then(async () => {
      if (activeRequest.current) throw new Error('请等待当前回复结束后再修改运行配置');
      if (backend.status !== 'connected') throw new Error('尚未连接 Loopra');
      await task();
    });
    settingsQueue.current = result.catch(error => { notify(`保存失败：${error instanceof Error ? error.message : error}`); });
    return result;
  }
  function saveOptions(next: ComposerOptions) {
    return mutation(async () => {
      const model = getModelCatalog(providers).find(item => item.id === next.modelId);
      if (!model) throw new Error('请选择有效模型');
      await api.request('/config', 'PUT', { hitl: permissionValue(next.mode), fastMode: next.fast, terminateOnNoToolCall: next.finishWithoutTools });
      if (session) {
        await api.request(sessionRoute(session, '/settings'), 'PUT', { model: model.name, modelChannelId: model.providerId, reasoningEffort: next.effort });
        if (next.plan !== composerOptions.plan) await api.request('/agent/mode', 'POST', { workspaceHash: session.workspaceHash, sessionName: session.name, enabled: next.plan });
      }
      setComposerOptions(next);
    }).catch(() => {});
  }
  function saveDefaultModel(id: string) {
    void mutation(async () => {
      const model = getModelCatalog(providers).find(item => item.id === id);
      if (!model) throw new Error('请选择有效模型');
      await api.request('/config', 'PUT', { model: model.name, modelChannelId: model.providerId }); setDefaultModel(id); notify('默认模型已保存到 Loopra');
    }).catch(() => {});
  }
  async function saveProviders(next: Provider[]) {
    await mutation(async () => {
      const catalog = getModelCatalog(next);
      if (!catalog.length) throw new Error('至少保留一个可用模型');
      const fallback = catalog.find(model => model.id === defaultModel) || catalog[0];
      await api.request('/config', 'PUT', { modelChannels: providerChannels(next), model: fallback.name, modelChannelId: fallback.providerId });
      await backend.refresh(); notify('模型渠道已保存到 Loopra');
    });
  }
  async function saveAgentSettings(next: AgentSettings) {
    if (next.serverUrl !== server) { setServer(serverAddress(next.serverUrl)); setActiveId(null); setWorkspace(''); return; }
    const changed = <K extends keyof AgentSettings>(key: K) => JSON.stringify(next[key]) !== JSON.stringify(agentSettings[key]);
    const localOnly = !(['systemPrompt', 'tools', 'validatorModel', 'imageModel'] as const).some(changed);
    if (localOnly) { setAgentSettings(next); return; }
    await mutation(async () => {
      const patch: Record<string, unknown> = {};
      if (changed('tools')) patch.disabledTools = next.tools.filter(tool => !tool.enabled).map(tool => tool.name);
      for (const [key, modelKey, channelKey] of [['validatorModel', 'validationModel', 'validationModelChannelId'], ['imageModel', 'imageUnderstandingModel', 'imageUnderstandingModelChannelId']] as const) {
        if (changed(key)) { const model = getModelCatalog(providers).find(item => item.id === next[key]); patch[modelKey] = model?.name || ''; patch[channelKey] = model?.providerId || ''; }
      }
      if (Object.keys(patch).length) await api.request('/config', 'PUT', patch);
      if (changed('systemPrompt')) await api.request('/loopra-md', 'PUT', next.systemPrompt);
      setAgentSettings(next); notify('配置已保存到 Loopra');
    });
  }
  async function renameSession() {
    if (!renameValue.trim()) return;
    const target = sessions.find(item => item.id === rename); if (!target) return;
    try { await api.request(sessionRoute(target, '/title'), 'PUT', { title: renameValue.trim() }); setSessions(current => current.map(item => item.id === rename ? { ...item, title: renameValue.trim() } : item)); setRename(null); notify('会话已重命名'); }
    catch (error) { notify(`重命名失败：${error instanceof Error ? error.message : error}`); }
  }
  function newSession(nextWorkspace = workspace || workspaces[0]?.hash || '') { historyRequest.current?.abort(); if (getModelCatalog(providers).some(model => model.id === defaultModel)) setComposerOptions(value => ({ ...value, modelId: defaultModel })); setActiveId(null); setWorkspace(nextWorkspace); setChanges(false); setDraft(''); setComposerContext(emptyContext); setMenu(null); setTimeout(() => textarea.current?.focus(), 50); }
  async function selectSession(id: string) {
    const selected = sessions.find(item => item.id === id); if (!selected) return;
    historyRequest.current?.abort(); const controller = new AbortController(); historyRequest.current = controller;
    setActiveId(id); setWorkspace(selected.workspaceHash || ''); setMenu(null); setDraft(''); setComposerContext(emptyContext);
    if (generatingId === id) return;
    try {
      const [history, settings, mode] = await Promise.all([
        api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(selected)}`, 'GET', undefined, controller.signal),
        api.request<{ model: string; modelChannelId: string; reasoningEffort: string }>(sessionRoute(selected, '/settings'), 'GET', undefined, controller.signal),
        api.request<{ mode: string }>(`/agent/mode?${sessionQuery(selected)}`, 'GET', undefined, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setSessions(current => current.map(item => item.id === id ? { ...item, messages: historyMessages(history) } : item));
      setComposerOptions(current => ({ ...current, modelId: `${settings.modelChannelId}:${settings.model}`, effort: settings.reasoningEffort || current.effort, plan: mode.mode === 'plan' }));
    } catch (error) { if (!controller.signal.aborted) notify(`加载会话失败：${error instanceof Error ? error.message : error}`); }
  }
  function toggleMenu(name: string) { setMenu(current => current === name ? null : name); }
  function openSettings(tab = '通用') { setSettingsTab(tab); setSettingsOpen(true); setMenu(null); }
  function archiveSession() { if (!activeId) return; setHiddenSessions(current => [...current, activeId]); newSession(); notify('会话已在本机隐藏，可在设置中恢复；后端历史保留'); }
  function openTerminal(shell = 'PowerShell') { setTerminalShell(shell); setTerminal(true); setMenu(null); }
  function openWorkspace() { if (preferences.openWith === 'File Explorer') setChanges(true); else openTerminal(preferences.openWith === 'Git Bash' ? 'Bash' : 'PowerShell'); setMenu(null); }
  function copyPath() { void navigator.clipboard?.writeText(currentWorkspace?.path || ''); setMenu(null); notify('已复制工作区路径'); }
  async function stopGeneration() {
    const request = activeRequest.current; if (!request) return;
    request.stopping = true;
    try { await api.request('/chat/abort', 'POST', { requestId: request.requestId, workspaceHash: request.session?.workspaceHash || workspace, sessionName: request.session?.name }); request.controller.abort(); }
    catch (error) { request.stopping = false; notify(`停止失败：${error instanceof Error ? error.message : error}`); }
  }
  function openDiff(path: string) { setDiffPath(path); setChanges(true); }
  async function revertChanges(changes: FileChange[]) { await mutation(async () => { await api.request('/sessions/file-changes/revert', 'POST', { workspaceHash: workspace, changes }); }); }
  function fillDraft(text: string) { setDraft(text); textarea.current?.focus(); }
  async function chooseOption(value: string, subId?: string) {
    if (subId) { await api.request(`/chat/sub-hitl/${encodeURIComponent(subId)}`, 'POST', { action: value === '/agree' || value === 'approve' ? 'approve' : 'deny' }); notify('子代理审批已发送'); }
    else fillDraft(value);
  }
  async function branchSession(messageId: string) {
    if (!session || generatingId) return;
    const messages = getSessionMessages(session);
    const index = messages.findIndex(message => message.id === messageId);
    if (index < 0) return;
    try {
      const count = messages[index].historyCount;
      if (!count) { notify('请重新打开会话后再创建分支'); return; }
      const result = await api.request<{ sessionName: string }>(`${sessionRoute(session, '/branch')}&messageCount=${count}`, 'POST');
      const next = { ...session, id: `${session.workspaceHash}/${result.sessionName}`, name: result.sessionName };
      const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(next)}`);
      await backend.refreshSessions(workspaces); setSessions(current => current.map(item => item.id === next.id ? { ...item, messages: historyMessages(history) } : item)); setActiveId(next.id); notify('已在 Loopra 创建分支会话');
    } catch (error) { notify(`创建分支失败：${error instanceof Error ? error.message : error}`); }
  }

  async function sendMessage(override?: string) {
    if ((!override && !draft.trim() && !composerContext.files.length) || activeRequest.current) return;
    if (backend.status !== 'connected' || !backend.ready || !currentWorkspace) { notify('请先连接 Loopra 并选择工作区'); return; }
    const prompt = override || draft.trim() || '请查看附件';
    const selectedModel = getModelCatalog(providers).find(model => model.id === composerOptions.modelId);
    if (!selectedModel) { notify('请先选择一个模型'); return; }
    const options = { ...composerOptions };
    const context = { ...composerContext };
    const text = [...context.skills.map(name => `使用技能：${name}`), ...context.files.filter(name => !context.attachments?.some(file => file.name === name)).map(name => `引用工作区文件：${name}`), prompt].join('\n\n');
    const controller = new AbortController(); const requestId = crypto.randomUUID();
    activeRequest.current = { controller, requestId, session };
    setGeneratingId(session?.id || 'creating');
    let target = session;
    const answerId = crypto.randomUUID();
    const now = Date.now();
    const time = new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const message = { id: crypto.randomUUID(), role: 'user' as const, text, time };
    let completed = false;
    const assistant: Message = { id: answerId, role: 'assistant', text: '', time, startedAt: now, blocks: [] };
    try {
      if (!target) {
        const created = await api.request<{ sessionName: string }>(`/sessions/new?workspaceHash=${encodeURIComponent(workspace)}`, 'POST', undefined, controller.signal);
        target = remoteSession({ name: created.sessionName, title: prompt.slice(0, 60), messageCount: 0, mtime: now }, currentWorkspace);
        activeRequest.current!.session = target;
        await api.request(sessionRoute(target, '/title'), 'PUT', { title: target.title }, controller.signal);
        setSessions(current => [...current, target!]); setActiveId(target.id);
      }
      const id = target.id; setGeneratingId(id);
      await api.request('/config', 'PUT', { hitl: permissionValue(options.mode), fastMode: options.fast, terminateOnNoToolCall: options.finishWithoutTools }, controller.signal);
      await api.request('/agent/mode', 'POST', { workspaceHash: target.workspaceHash, sessionName: target.name, enabled: options.plan }, controller.signal);
      setSessions(current => current.map(item => item.id === id ? { ...item, messages: [...item.messages, message, assistant] } : item));
      setDraft(''); setComposerContext(emptyContext); setMenu(null);
      const attachments = context.attachments || [];
      const documentText = attachments.filter(file => file.text !== undefined).map(file => `附件：${file.name}\n${file.text}`).join('\n\n');
      await api.stream({ message: [text, documentText].filter(Boolean).join('\n\n'), requestId, workspaceHash: target.workspaceHash!, sessionName: target.name!, model: selectedModel.name, modelChannelId: selectedModel.providerId, reasoningEffort: options.effort, fastMode: options.fast, images: attachments.flatMap(file => file.image ? [file.image] : []), linkedProjectHashes: workspaces.filter(project => context.projects.includes(project.name)).map(project => project.hash) }, event => {
        setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? applyEvent(entry, event) : entry) } : item));
      }, controller.signal);
      completed = true;
    } catch (error) {
      const content = controller.signal.aborted || activeRequest.current?.stopping ? '> 本次回复已停止。' : `> 请求失败：${error instanceof Error ? error.message : error}`;
      setSessions(current => current.map(item => item.id === target?.id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? applyEvent(entry, { type: 'content', content: `\n\n${content}` }) : entry) } : item));
      notify(content.replace(/^> /, ''));
    } finally {
      if (target) {
        const id = target.id;
        setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? { ...entry, finishedAt: Date.now() } : entry) } : item));
        try { const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(target)}`); if (completed && !controller.signal.aborted && history.length) setSessions(current => current.map(item => item.id === id ? { ...item, messages: historyMessages(history) } : item)); } catch { /* Keep the already received stream if history reload fails. */ }
      }
      activeRequest.current = undefined; setGeneratingId(null);
    }
  }

  useEffect(() => {
    setGitBranch('工作区'); if (!workspace) return;
    const controller = new AbortController();
    void api.request<{ branch: string; initialized: boolean }>(`/git/status?workspaceHash=${encodeURIComponent(workspace)}`, 'GET', undefined, controller.signal).then(data => { if (!controller.signal.aborted) setGitBranch(data.initialized ? data.branch || 'HEAD' : '未初始化'); }).catch(() => {});
    return () => controller.abort();
  }, [api, workspace, changes]);
  useEffect(() => {
    const config = backend.config; if (!config) return;
    const modelId = `${config.modelChannelId}:${config.model}`;
    setDefaultModel(modelId);
    setComposerOptions(current => ({ ...current, modelId, effort: config.reasoningEffort || 'max', mode: permissionLabel(config.hitl), fast: config.fastMode, finishWithoutTools: config.terminateOnNoToolCall }));
    setAgentSettings(current => ({ ...current, serverUrl: server, projectPath: config.workspace, defaultWorkspace: backend.workspaces.find(item => item.path === config.workspace)?.name || backend.workspaces[0]?.name || '', tools: backend.tools, skills: backend.skills, systemPrompt: backend.prompt, validatorModel: config.validationModel ? `${config.validationModelChannelId}:${config.validationModel}` : '', imageModel: config.imageUnderstandingModel ? `${config.imageUnderstandingModelChannelId}:${config.imageUnderstandingModel}` : '' }));
    setWorkspace(current => backend.workspaces.some(item => item.hash === current) ? current : backend.workspaces.find(item => item.path === config.workspace)?.hash || backend.workspaces[0]?.hash || '');
  }, [backend.config, backend.tools, backend.skills, backend.prompt, backend.workspaces, server]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange); return () => media.removeEventListener('change', onChange);
  }, []);
  useEffect(() => { document.documentElement.classList.toggle('dark', isDark); }, [isDark]);
  useEffect(() => {
    const catalog = getModelCatalog(providers);
    if (!catalog.some(model => model.id === composerOptions.modelId) && catalog.length) setComposerOptions(value => ({ ...value, modelId: catalog[0].id }));
    if (!catalog.some(model => model.id === defaultModel) && catalog.length) setDefaultModel(catalog[0].id);
  }, [providers, composerOptions.modelId, defaultModel, setComposerOptions, setDefaultModel]);
  useEffect(() => {
    const catalog = getModelCatalog(providers);
    if ((agentSettings.validatorModel && !catalog.some(model => model.id === agentSettings.validatorModel)) || (agentSettings.imageModel && !catalog.some(model => model.id === agentSettings.imageModel && model.imageInput))) {
      setAgentSettings(current => ({ ...current, validatorModel: catalog.some(model => model.id === current.validatorModel) ? current.validatorModel : '', imageModel: catalog.some(model => model.id === current.imageModel && model.imageInput) ? current.imageModel : '' }));
    }
  }, [providers, agentSettings.validatorModel, agentSettings.imageModel, setAgentSettings]);
  useEffect(() => {
    const names = ['编程助手', '通用助手', '代码审查助手', ...agentSettings.agents.filter(agent => agent.enabled).map(agent => agent.name)];
    if (!names.includes(agentSettings.agentName)) setAgentSettings(current => ({ ...current, agentName: '编程助手' }));
  }, [agentSettings.agents, agentSettings.agentName, setAgentSettings]);
  useEffect(() => {
    setComposerContext(current => ({ ...current, skills: current.skills.filter(name => agentSettings.skills.some(skill => skill.name === name && skill.enabled)) }));
  }, [agentSettings.skills]);
  useEffect(() => { if (session?.messages.length) scrollArea.current?.scrollTo({ top: scrollArea.current.scrollHeight, behavior: 'instant' }); }, [session?.messages]);
  useEffect(() => {
    function onPointer(event: PointerEvent) { if (!(event.target as HTMLElement).closest('[data-popover]')) setMenu(null); }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { setMenu(null); return; }
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); setMenu(null); }
        if (event.key.toLowerCase() === 'n') { event.preventDefault(); newSession(); }
        if (event.key === ',') { event.preventDefault(); openSettings(); }
      }
    }
    document.addEventListener('pointerdown', onPointer); window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey); };
  });
  useEffect(() => () => { activeRequest.current?.controller.abort(); historyRequest.current?.abort(); clearTimeout(toastTimer.current); }, []);

  const composer = <Composer home={isHome} language={preferences.language} draft={draft} onDraft={setDraft} inputRef={textarea}
    options={composerOptions} onOptions={saveOptions} context={composerContext} onContext={setComposerContext}
    providers={providers} api={api} workspaceHash={workspace} workspaces={workspaces} connected={backend.status === 'connected'} skillOptions={agentSettings.skills.filter(skill => skill.enabled)} systemPrompt={agentSettings.systemPrompt} petEnabled={agentSettings.petEnabled} petStyle={agentSettings.petStyle} defaultModel={defaultModel} onDefaultModel={saveDefaultModel}
    history={session ? getSessionMessages(session).map(message => message.text) : []}
    busy={!!generatingId || backend.status !== 'connected' || !backend.ready} generating={!!generatingId && generatingId === activeId}
    onSend={() => sendMessage()} onStop={stopGeneration} onContinue={() => sendMessage('请继续上一次回复，补充后续步骤和注意事项。')}
    onNew={() => newSession()} onTerminal={() => openTerminal()} onManage={() => openSettings('模型供应商')}
    onOpen={() => setMenu(null)} notify={notify} />;

  return <AppMotion enabled={preferences.animations}><div className="desktop-app">
    <div className="app-body">
      {sidebar && <SidebarSurface key="sidebar"><div className="sidebar-brand"><span className="app-icon"><LoopraMark small /></span><span>Loopra</span><IconButton label="收起侧边栏" onClick={() => setSidebar(false)}><PanelLeft size="1.0625rem" /></IconButton></div><div className="sidebar-actions"><button onClick={() => newSession()}><MessageCirclePlus size="1.1875rem" />{preferences.language === 'English' ? 'New chat' : '新建会话'}</button><button onClick={() => { setSearchOpen(true); setMenu(null); }}><SearchIcon size="1.25rem" />{preferences.language === 'English' ? 'Search' : '搜索'}</button></div>
        <div className="session-section"><div className="section-label"><span>会话</span><div><IconButton label="折叠工作区" onClick={() => setCollapsed(collapsed.length ? [] : workspaces.map(item => item.hash))}><Plus size="0.9375rem" className="collapse-icon" /></IconButton><IconButton label={sortNewest ? '恢复默认排序' : '按最新排序'} active={sortNewest} onClick={() => setSortNewest(!sortNewest)}><SlidersHorizontal size="0.875rem" /></IconButton></div></div>
          {workspaces.map(item => <div key={item.hash} className="workspace-group"><button className={`workspace-heading ${isHome && workspace === item.hash ? 'selected' : ''}`} onClick={() => newSession(item.hash)} onDoubleClick={() => setCollapsed(current => current.includes(item.hash) ? current.filter(name => name !== item.hash) : [...current, item.hash])}>{collapsed.includes(item.hash) ? <FolderClosed size="1.1875rem" /> : <FolderOpen size="1.1875rem" />}<span>{item.name}</span></button><Collapse open={!collapsed.includes(item.hash)} className="workspace-sessions">{!visibleSessions.some(entry => entry.workspaceHash === item.hash) && <p className="no-conversation">暂无对话</p>}{(sortNewest ? [...visibleSessions].reverse() : visibleSessions).filter(entry => entry.workspaceHash === item.hash).map(entry => <button key={entry.id} className={`session-item ${activeId === entry.id ? 'selected' : ''}`} onClick={() => selectSession(entry.id)} title={entry.title}>{activeId === entry.id && <SelectionIndicator />}<span>{entry.title}</span><time>{entry.mtime ? new Date(entry.mtime).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}</time></button>)}</Collapse></div>)}
        </div><footer className="sidebar-footer"><button className="profile-button" onClick={() => openSettings('账户')}><span className="avatar">🌷</span><span>Loopra</span><span className="free-badge">Local</span></button><IconButton label="设置" onClick={() => openSettings()}><SettingsIcon size="1.1875rem" /></IconButton></footer>
      </SidebarSurface>}
      <main className={`main-area ${changes ? 'has-changes' : ''}`}>
        <header className={`conversation-header ${isHome ? 'home-header' : ''}`}>
          {!sidebar && <IconButton label="展开侧边栏" className="sidebar-reopen" onClick={() => setSidebar(true)}><PanelLeft size="1.0625rem" /></IconButton>}
          {!isHome && <div className="breadcrumb"><span>{workspaceName}</span><span className="breadcrumb-divider">/</span><strong title={session.title}>{session.title}</strong><div data-popover className="menu-anchor"><IconButton label="会话选项" onClick={() => toggleMenu('session')}><MoreHorizontal size="1.1875rem" /></IconButton><Popup open={menu === 'session'} className="popup session-menu" role="menu"><button role="menuitem" onClick={() => { setRename(session.id); setRenameValue(session.title); setMenu(null); }}><FileCode2 size="1rem" />重命名会话</button><button role="menuitem" onClick={archiveSession}><Archive size="1rem" />在本机隐藏</button><button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(session.title); setMenu(null); notify('已复制会话标题'); }}><Copy size="1rem" />复制会话标题</button></Popup></div></div>}
          <div className="header-actions"><button className={`backend-status ${backend.status}`} title={backend.error || `${server} · v${backend.version}`} onClick={() => openSettings('服务器')}><span />{backend.status === 'connecting' ? '连接中' : backend.status === 'error' ? '连接失败' : backend.ready ? 'Loopra 已连接' : '需要配置模型'}</button>{!isHome && <><div data-popover className="menu-anchor"><div className="folder-split"><button aria-label="查看工作区文件" onClick={openWorkspace}>📁</button><button aria-label="打开方式" onClick={() => toggleMenu('folder')}><ChevronDown size="1rem" /></button></div><Popup open={menu === 'folder'} className="popup folder-menu" role="menu"><button role="menuitem" onClick={() => { setChanges(true); setMenu(null); }}><span className="emoji-icon">📁</span>File Explorer</button><button role="menuitem" onClick={() => { setTerminal(true); setMenu(null); }}><span className="terminal-icon">&gt;_</span>Terminal</button><button role="menuitem" onClick={() => openTerminal('Bash')}><span className="git-icon">◆</span>Git Bash</button><hr /><button role="menuitem" onClick={copyPath}><Copy size="1.0625rem" />复制路径</button></Popup></div>{!changes && <div data-popover className="menu-anchor"><button className="branch-button" onClick={() => toggleMenu('branch')}><GitBranch size="1rem" />{gitBranch}</button><Popup open={menu === 'branch'} className="popup branch-menu"><h3>当前分支</h3><button onClick={() => { setChanges(true); setMenu(null); }}><GitBranch size="0.9375rem" />{gitBranch}<Check size="1rem" /></button></Popup></div>}</>}
            <IconButton label={terminal ? '关闭终端' : '打开终端'} active={terminal} onClick={() => setTerminal(!terminal)}><SquareTerminal size="1.0625rem" /></IconButton><IconButton label={changes ? '关闭改动面板' : '打开改动面板'} active={changes} onClick={() => setChanges(!changes)}><PanelRight size="1.0625rem" /></IconButton>
          </div>
        </header>
        <div className="main-content">{backend.status === 'error' && <div className="backend-error" role="alert"><span>无法连接 Loopra：{backend.error}</span><Button size="sm" variant="flat" onPress={() => void backend.refresh()}>重新连接</Button></div>}
          {isHome ? <section className="welcome-shell"><Enter as="div" className="welcome-intro"><h1 className="welcome-logo" aria-label="Loopra"><LoopraMark />Loopra</h1></Enter><div className="workspace-selector menu-anchor" data-popover><button onClick={() => toggleMenu('workspace')}><FolderClosed size="1.125rem" />{workspaceName}<ChevronDown size="1.0625rem" /></button><Popup open={menu === 'workspace'} className="popup workspace-menu"><h3>选择工作区</h3>{workspaces.map(item => <button key={item.hash} onClick={() => { setWorkspace(item.hash); setMenu(null); }}><FolderClosed size="1rem" />{item.name}{workspace === item.hash && <Check size="1rem" />}</button>)}</Popup></div>{composer}</section> : <>
            <div className="chat-scroll" ref={scrollArea}><div className="chat-content"><Enter key={session.id}><Messages session={session} loading={generatingId === activeId} busy={!!generatingId || backend.status !== 'connected' || !backend.ready} notify={notify} onDiff={openDiff} onRevert={revertChanges} onChoice={chooseOption} onEdit={fillDraft} onBranch={branchSession} /></Enter></div></div>
            <div className="chat-composer-area">{composer}</div>
          </>}
        </div>
        {terminal && <TerminalPanel api={api} workspaceHash={workspace} key="terminal" initialShell={terminalShell} onClose={() => setTerminal(false)} />}
      </main>
      {changes && <ChangesPanel api={api} workspaceHash={workspace} key="changes" initialFile={diffPath} onClose={() => setChanges(false)} notify={notify} />}
    </div>
    <Search workspaces={workspaces} open={searchOpen} onClose={() => setSearchOpen(false)} sessions={visibleSessions} activeId={activeId} onSession={selectSession} onWorkspace={hash => newSession(hash)} />
    <Settings onRefresh={() => backend.refresh()} workspaces={workspaces} server={server} config={agentSettings} onConfig={saveAgentSettings} options={composerOptions} onOptions={saveOptions} defaultModel={defaultModel} onDefaultModel={saveDefaultModel} open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab={settingsTab} preferences={preferences} onPreferences={setPreferences} providers={providers} onProviders={saveProviders} sessions={sessions.map(item => ({ ...item, archived: hiddenSessions.includes(item.id) }))} onRestore={id => { setHiddenSessions(current => current.filter(item => item !== id)); notify('会话已恢复'); }} notify={notify} />
    <Modal isOpen={!!rename} onClose={() => setRename(null)} placement="center" classNames={{ base: 'rename-modal', backdrop: 'modal-backdrop' }} aria-label="重命名会话"><ModalContent><form onSubmit={event => { event.preventDefault(); void renameSession(); }}><h2>重命名会话</h2><Input autoFocus aria-label="会话名称" value={renameValue} onValueChange={setRenameValue} variant="bordered" /><div className="form-buttons"><Button variant="light" onPress={() => setRename(null)}>取消</Button><Button type="submit" color="primary" isDisabled={!renameValue.trim()}>保存</Button></div></form></ModalContent></Modal>
    <Toast message={toast}><Check size="1rem" />{toast}</Toast>
  </div></AppMotion>;
}
