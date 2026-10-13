import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Input, Modal, ModalContent } from '@nextui-org/react';
import { Activity, Archive, ArrowDownToLine, Bot, Check, ChevronDown, ClipboardList, Copy, Crosshair, Download, FileCode2, FoldVertical, FolderClosed, FolderOpen, FolderPlus, GitBranch, HelpCircle, MessageCirclePlus, MessagesSquare, MoreHorizontal, PanelLeft, PanelRight, Plus, RefreshCw, Search as SearchIcon, Settings as SettingsIcon, SlidersHorizontal, Sparkles, SunMoon, Trash2, Wrench } from 'lucide-react';
import { getSessionMessages, useLocalState } from './lib';
import type { Provider, Session } from './lib';
import { LoopraMark, IconButton } from './components/ui';
import { Messages } from './components/Conversation';
import ChangesPanel from './components/Panels';
import BackgroundTasks from './components/BackgroundTasks';
import Settings, { defaultPreferences } from './components/Settings';
import type { Preferences } from './components/Settings';
import Search from './components/Search';
import type { FileChange, Message } from './chat';
import { chatNearBottom, chatScrollState, truncatePreview, userMessageDock } from './chat';
import Composer from './components/Composer';
import { defaultAgentSettings, type AgentSettings } from './settings-data';
import { buildUpdatePrompt, loadUpdateSource } from './update-scripts';
import { composeOutgoing, defaultOptions, emptyContext, getModelCatalog, largeInputReference, type ComposerContext, type ComposerOptions, type LiveSpeed, type QueuedMessage } from './composer';
import { LARGE_PASTE_THRESHOLD_CHARS } from './documents';
import { enqueue, nextQueued, promoteQueued, removeQueued, type MessageQueue } from './message-queue';
import { applyEvent, DEFAULT_SERVER, historyMessages, permissionLabel, permissionValue, providerChannels, remoteSession, serverAddress, sessionQuery, sessionRoute, type HistoryMessage, type Workspace } from './backend';
import useLoopra from './useLoopra';
import { AppMotion, Collapse, Enter, Popup, SelectionIndicator, SidebarSurface, Toast } from './components/Motion';
import { prepareCompletionSound, playCompletionSound } from './notifications';
import usePets from './usePets';
import { petActivity, petReplyPreview, type PetReply } from './pets';
import SessionDetails, { SessionProgress } from './components/SessionDetails';
import { ConfirmAction, query } from './components/RemoteControls';
import ProjectSessions from './components/ProjectSessions';
import Help from './components/Help';
import SessionsManager from './components/SessionsManager';
import RequirementBoard from './components/RequirementBoard';
import PlanReview from './components/PlanReview';
import { chatExportText, downloadText } from './chat-export';
import ChatLogs, { useChatLogs } from './components/ChatLogs';
import DesktopTitleBar from './components/DesktopTitleBar';
import { isDesktopWindow } from './desktop-shell';

export default function App() {
  const [server, setServer] = useLocalState('backend-server', DEFAULT_SERVER);
  const backend = useLoopra(server);
  const { api, sessions, setSessions, providers, workspaces } = backend;
  const pets = usePets(api, backend.status === 'connected');
  const [hiddenSessions, setHiddenSessions] = useLocalState<string[]>(`hidden-sessions:${server}`, []);
  const [preferences, setPreferences] = useLocalState<Preferences>('preferences', defaultPreferences);
  const [composerOptions, setComposerOptions] = useLocalState<ComposerOptions>('composer-options', defaultOptions);
  const [defaultModel, setDefaultModel] = useLocalState('default-model', defaultOptions.modelId);
  const [agentSettings, setAgentSettings] = useLocalState<AgentSettings>('agent-settings', defaultAgentSettings);
  const [petReply, setPetReply] = useState<PetReply | null>(null);
  const [composerContext, setComposerContext] = useState<ComposerContext>(emptyContext);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 760);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [changes, setChanges] = useState(false);
  const [workbenchTab, setWorkbenchTab] = useState('git');
  const [sessionDetails, setSessionDetails] = useState(false);
  const [sessionDetailsTab, setSessionDetailsTab] = useState('events');
  const [deleteSession, setDeleteSession] = useState<Session>();
  const [rollbackMessage, setRollbackMessage] = useState<Message>();
  const [rollbackCode, setRollbackCode] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<string>();
  const [discardPlan, setDiscardPlan] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [progressRevision, setProgressRevision] = useState(0);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffInline, setDiffInline] = useState<string | undefined>(undefined);
  const [projectDialog, setProjectDialog] = useState<Workspace>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [gitBranch, setGitBranch] = useState('工作区');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('通用');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [liveSpeed, setLiveSpeed] = useState<LiveSpeed>();
  const [toast, setToast] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [sortNewest, setSortNewest] = useState(false);
  const [dragWorkspace, setDragWorkspace] = useState('');
  const [dragOverWorkspace, setDragOverWorkspace] = useState('');
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const activeRequest = useRef<{ controller: AbortController; requestId: string; session?: Session; stopping?: boolean }>();
  const [queuedMessages, setQueuedMessages] = useState<Record<string, QueuedMessage[]>>({});
  const queuedRef = useRef(queuedMessages);
  useEffect(() => { queuedRef.current = queuedMessages; }, [queuedMessages]);
  const [remoteRun, setRemoteRun] = useState<{ id: string; requestId?: string | null } | null>(null);
  const remoteRunRef = useRef<string | null>(null);
  const historyRequest = useRef<AbortController>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  // Legacy Chat.vue scroll state: programmatic follow only while the user has
  // not scrolled away, and a floating "back to bottom" button otherwise.
  const userScrolledAway = useRef(false);
  const lastScrollTop = useRef(0);
  // Legacy `Chat.vue` virtualWindow offsets, published by the message list so the
  // thumbnail dock can jump to a message that is currently unmounted.
  const messageOffsets = useRef<number[]>([]);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const sessionSection = useRef<HTMLDivElement>(null);
  // Legacy Chat.vue floating log stack (SSE `log`, `copy-success`, `app-notify`).
  const chatLogs = useChatLogs();
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
    // Leaving plan mode discards any submitted plan, so confirm first (legacy togglePlan).
    if (!next.plan && composerOptions.plan && session) { setDiscardPlan(true); return Promise.resolve(); }
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
  function newSession(nextWorkspace = workspace || workspaces[0]?.hash || '') { if (narrow) setSidebar(false); historyRequest.current?.abort(); if (getModelCatalog(providers).some(model => model.id === defaultModel)) setComposerOptions(value => ({ ...value, modelId: defaultModel })); setActiveId(null); setWorkspace(nextWorkspace); setChanges(false); setDraft(''); setComposerContext(emptyContext); setPendingPlan(undefined); setLiveSpeed(undefined); setMenu(null); userScrolledAway.current = false; lastScrollTop.current = 0; setShowScrollBtn(false); setTimeout(() => textarea.current?.focus(), 50); }
  // Legacy Chat.vue 清空按钮：后端 /new 命令已移除，改为在当前工作区新建空白会话。
  function clearChat() { if (generatingId) { notify('生成中无法清空，请先停止生成'); return; } newSession(workspace || workspaces[0]?.hash || ''); notify('已新建空白会话'); }
  async function selectSession(id: string) {
    const selected = sessions.find(item => item.id === id); if (!selected) return;
    if (narrow) setSidebar(false);
    historyRequest.current?.abort(); const controller = new AbortController(); historyRequest.current = controller;
    setActiveId(id); setWorkspace(selected.workspaceHash || ''); setMenu(null); setDraft(''); setComposerContext(emptyContext);
    // Opening a session always jumps to the newest message.
    userScrolledAway.current = false; lastScrollTop.current = 0; setShowScrollBtn(false);
    setLiveSpeed(undefined);
    if (generatingId === id) return;
    try {
      const [history, settings, mode] = await Promise.all([
        api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(selected)}`, 'GET', undefined, controller.signal),
        api.request<{ model: string; modelChannelId: string; reasoningEffort: string }>(sessionRoute(selected, '/settings'), 'GET', undefined, controller.signal),
        api.request<{ mode: string; pendingPlan?: string | null }>(`/agent/mode?${sessionQuery(selected)}`, 'GET', undefined, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setSessions(current => current.map(item => item.id === id ? { ...item, messages: historyMessages(history) } : item));
      setComposerOptions(current => ({ ...current, modelId: `${settings.modelChannelId}:${settings.model}`, effort: settings.reasoningEffort || current.effort, plan: mode.mode === 'plan' }));
      setPendingPlan(mode.pendingPlan || undefined);
    } catch (error) { if (!controller.signal.aborted) notify(`加载会话失败：${error instanceof Error ? error.message : error}`); }
  }
  function toggleMenu(name: string) { setMenu(current => current === name ? null : name); }
  function openSettings(tab = '通用') { setSettingsTab(tab); setSettingsOpen(true); setMenu(null); }
  // Legacy Sidebar.vue footer exposed 工具 / 子代理 / 数据面板 / 主题 / 设置; the
  // theme button flipped light↔dark without touching 跟随系统.
  function toggleTheme() { setPreferences(current => ({ ...current, theme: isDark ? '浅色' : '深色' })); }
  function openSessionsManager() { setSessionsOpen(true); setMenu(null); if (narrow) setSidebar(false); }
  // Legacy Chat.vue onScroll(): only an upward movement counts as leaving the
  // bottom; being pushed up by streamed content keeps auto-follow active.
  function onChatScroll() {
    const element = scrollArea.current;
    if (!element) return;
    const next = chatScrollState(element, lastScrollTop.current, userScrolledAway.current);
    userScrolledAway.current = next.away;
    setShowScrollBtn(next.showScrollButton);
    lastScrollTop.current = element.scrollTop;
  }
  function scrollToBottom() {
    userScrolledAway.current = false;
    const element = scrollArea.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setShowScrollBtn(false);
  }
  // Legacy collapseAllBlocks(): fold every open block and let mounted blocks reset.
  function collapseAllBlocks() {
    window.dispatchEvent(new CustomEvent('loopra:collapse-all-blocks'));
    requestAnimationFrame(() => {
      const element = scrollArea.current;
      if (element && !userScrolledAway.current) element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
  }
  function jumpToMessage(id: string) {
    const element = scrollArea.current;
    if (!element) return;
    const target = element.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    // The message is outside the virtual window: fall back to its known offset.
    const list = session ? getSessionMessages(session) : [];
    const index = list.findIndex(message => message.id === id);
    const offsets = messageOffsets.current;
    if (index >= 0 && offsets.length === list.length + 1) element.scrollTo({ top: offsets[index], behavior: 'smooth' });
  }
  async function refreshSessionChat(target: Session) {
    try {
      const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(target)}`, 'GET');
      setSessions(current => current.map(item => item.id === target.id ? { ...item, messages: historyMessages(history), messageCount: history.length } : item));
      notify(`${target.title} 已刷新`);
    } catch (error) { notify(`刷新失败：${error instanceof Error ? error.message : error}`); }
  }
  function archiveSession() { if (!activeId) return; setHiddenSessions(current => [...current, activeId]); newSession(); notify('会话已在本机隐藏，可在设置中恢复；后端历史保留'); }
  async function approvePlan() {
    if (!session || planBusy || generatingId) return;
    setPlanBusy(true);
    try { await sendMessage(undefined, undefined, 'execute_plan'); } finally { setPlanBusy(false); }
  }
  async function exitPlanMode() {
    if (!session || planBusy) return;
    setPlanBusy(true);
    try {
      await api.request('/agent/mode', 'POST', { workspaceHash: session.workspaceHash, sessionName: session.name, enabled: false });
      setComposerOptions(current => ({ ...current, plan: false }));
      setPendingPlan(undefined);
      notify('已退出计划模式');
    } catch (error) { notify(`退出计划模式失败：${error instanceof Error ? error.message : error}`); }
    finally { setPlanBusy(false); }
  }
  async function removeSession(target: Session) {
    await api.request(sessionRoute(target), 'DELETE');
    if (activeId === target.id) newSession();
    await backend.refreshSessions(workspaces);
    notify('会话已从 Loopra 删除');
  }
  async function refreshProject(hash: string) {
    try { await backend.refreshSessions(workspaces); notify(`${workspaces.find(item => item.hash === hash)?.name || '项目'}的会话已刷新`); }
    catch (error) { notify(`刷新失败：${error instanceof Error ? error.message : error}`); }
  }
  // Legacy Sidebar.vue: scroll the current session into view on demand.
  function locateActiveSession() {
    const nodes = sessionSection.current?.querySelectorAll<HTMLElement>('[data-session-key]');
    nodes?.forEach(node => { if (node.dataset.sessionKey === activeId) node.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  }
  // Legacy Sidebar.vue drag-reorder: persist the new project order to the backend.
  function reorderWorkspaces(from: string, to: string) {
    setDragWorkspace(''); setDragOverWorkspace('');
    if (!from || !to || from === to) return;
    const next = [...workspaces];
    const source = next.findIndex(item => item.hash === from);
    const target = next.findIndex(item => item.hash === to);
    if (source < 0 || target < 0) return;
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    void api.request('/workspaces/order', 'PUT', next.map(item => item.hash)).then(() => backend.refresh()).catch(error => notify(`调整项目顺序失败：${error instanceof Error ? error.message : error}`));
  }
  function projectMaintained(kind: 'refresh' | 'clear' | 'delete', item: Workspace) {
    if ((kind === 'clear' || kind === 'delete') && activeId?.startsWith(`${item.hash}/`)) setActiveId(null);
    if (kind === 'delete' && workspace === item.hash) setWorkspace(workspaces.find(entry => entry.hash !== item.hash)?.hash || '');
  }
  function initPet() {
    // Legacy ran `npx petdex install boba` in a fresh session automatically.
    // Keep the install explicit: the user confirms the command in the composer.
    newSession(workspace || workspaces[0]?.hash || '');
    setDraft('调用 npx petdex@latest install boba 初始化一个宠物');
    notify('已新建会话，确认后发送即可初始化宠物');
  }
  async function autoUpdate() {
    // Legacy 「更新核心服务」新建会话并把更新指令发给 Agent 执行；这里直接新建会话并发送。
    if (backend.status !== 'connected' || !backend.ready || !currentWorkspace) { notify('请先连接 Loopra 并选择工作区'); return; }
    newSession(workspace || workspaces[0]?.hash || '');
    setSettingsOpen(false);
    await sendMessage(buildUpdatePrompt(loadUpdateSource()), undefined, undefined, true);
    notify('已新建更新会话并发送更新指令');
  }
  function openTerminal() { setTerminal(true); setMenu(null); }
  function openWorkspace() { if (preferences.openWith === 'File Explorer') { setWorkbenchTab('files'); setChanges(true); } else openTerminal(); setMenu(null); }
  function copyPath() { void navigator.clipboard?.writeText(currentWorkspace?.path || ''); setMenu(null); notify('已复制工作区路径'); }
  async function stopGeneration() {
    const request = activeRequest.current; if (!request) return;
    request.stopping = true;
    try { await api.request('/chat/abort', 'POST', { requestId: request.requestId, workspaceHash: request.session?.workspaceHash || workspace, sessionName: request.session?.name }); request.controller.abort(); }
    catch (error) { request.stopping = false; notify(`停止失败：${error instanceof Error ? error.message : error}`); }
  }
  // Legacy Chat.vue polls /agent/session-status so a reply started elsewhere
  // (another window, or a reload mid-run) is visible and its history stays fresh.
  async function syncSessionRun(target: Session, controller: AbortController, observe: { running: boolean }) {
    const status = await api.request<{ running?: boolean; requestId?: string }>(`/agent/session-status?${sessionQuery(target)}`, 'GET', undefined, controller.signal);
    if (controller.signal.aborted) return;
    const running = !!status?.running;
    remoteRunRef.current = running ? target.id : null;
    setRemoteRun(running ? { id: target.id, requestId: status?.requestId } : null);
    if (running || observe.running) {
      const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(target)}`, 'GET', undefined, controller.signal);
      if (!controller.signal.aborted && history.length) setSessions(current => current.map(item => item.id === target.id ? { ...item, messages: historyMessages(history) } : item));
    }
    if (observe.running && !running && queuedRef.current[target.id]?.length) void sendQueuedMessage(target.id);
    observe.running = running;
  }
  async function stopRemoteRun() {
    if (!session || !remoteRun) return;
    try { await api.request('/chat/abort', 'POST', { requestId: remoteRun.requestId || undefined, workspaceHash: session.workspaceHash, sessionName: session.name }); notify('已请求停止后台任务'); }
    catch (error) { notify(`停止失败：${error instanceof Error ? error.message : error}`); }
  }
  // Legacy `openStoredDiff`: a message's file list carries the diff saved with
  // that turn, so show it directly instead of re-reading the live working tree.
  function openDiff(path: string, storedDiff?: string) { setDiffPath(path); setDiffInline(storedDiff); setWorkbenchTab('git'); setChanges(true); }
  function addFileContext(path: string, selection?: string) {
    setComposerContext(current => ({ ...current, files: [...new Set([...current.files, path])] }));
    if (selection) setDraft(current => `${current}${current ? '\n\n' : ''}来自 ${path}：\n${selection}`);
    notify('已加入消息上下文'); textarea.current?.focus();
  }
  async function refreshCurrentSession(text?: string) {
    if (session) await selectSession(session.id);
    if (text) setDraft(text);
    setProgressRevision(value => value + 1);
  }
  useEffect(() => {
    setProgressRevision(value => value + 1);
    if (!generatingId) return;
    const timer = setInterval(() => setProgressRevision(value => value + 1), 4000);
    return () => clearInterval(timer);
  }, [generatingId, activeId]);
  useEffect(() => {
    // Only poll while this window is idle: a local stream already owns the history.
    if (!session || generatingId || backend.status !== 'connected') { remoteRunRef.current = null; setRemoteRun(null); return; }
    const target = session;
    const controller = new AbortController();
    const observe = { running: false };
    const tick = () => { void syncSessionRun(target, controller, observe).catch(() => {}); };
    const timer = setInterval(tick, 2500);
    tick();
    return () => { controller.abort(); clearInterval(timer); remoteRunRef.current = null; setRemoteRun(null); };
  }, [api, session?.id, generatingId, backend.status]);
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

  // Legacy Chat.vue queued messages per session: sending while a reply is
  // streaming appends to the session queue instead of being dropped.
  function replaceQueue(next: MessageQueue) { queuedRef.current = next; setQueuedMessages(next); }
  function queueMessage(): boolean {
    if (!session) return false;
    if (!draft.trim() && !composerContext.files.length) return false;
    replaceQueue(enqueue(queuedRef.current, session.id, { id: crypto.randomUUID(), text: draft.trim(), context: composerContext }));
    setDraft(''); setComposerContext(emptyContext); setMenu(null);
    notify('已加入队列，当前回复结束后自动发送');
    return true;
  }
  function removeQueuedMessage(id: string) { if (session) replaceQueue(removeQueued(queuedRef.current, session.id, id)); }
  async function sendQueuedMessage(key: string) {
    const next = nextQueued(queuedRef.current, key);
    if (!next) return;
    // Wait for the previous run to finish; the poll timer or stream end retries.
    if (activeRequest.current || remoteRunRef.current === key) return;
    replaceQueue(removeQueued(queuedRef.current, key, next.id));
    await sendMessage(next.text, next.context);
  }
  function guideQueuedMessage(id: string) {
    if (!session) return;
    const key = session.id;
    replaceQueue(promoteQueued(queuedRef.current, key, id));
    if (activeRequest.current) void stopGeneration();
    else void sendQueuedMessage(key);
  }

  async function sendMessage(override?: string, overrideContext?: ComposerContext, action?: string, fresh = false) {
    if (activeRequest.current || remoteRunRef.current === (session?.id ?? '')) { if (!override && !action) queueMessage(); return; }
    if (!override && !action && !draft.trim() && !composerContext.files.length) return;
    if (backend.status !== 'connected' || !backend.ready || !currentWorkspace) { notify('请先连接 Loopra 并选择工作区'); return; }
    let prompt = override || draft.trim() || (action ? '' : '请查看附件');
    const titleSource = prompt;
    const selectedModel = getModelCatalog(providers).find(model => model.id === composerOptions.modelId);
    if (!selectedModel) { notify('请先选择一个模型'); return; }
    // Oversized directly-typed bodies are saved into the project and replaced by
    // a reference block before sending, matching legacy ChatInput.vue. The paste
    // handler already externalizes clipboard text; this covers typed/edited text.
    let savedInput: string | undefined;
    if (!action && currentWorkspace && prompt.length > LARGE_PASTE_THRESHOLD_CHARS) {
      try {
        const saved = await api.request<{ path: string; chars?: number }>('/files/paste', 'POST', { workspaceHash: workspace, content: prompt });
        if (!saved?.path) throw new Error('服务端未返回文件路径');
        savedInput = largeInputReference(saved.path, Number(saved.chars) || prompt.length);
        prompt = '';
      } catch (error) {
        notify(`大段输入内容保存失败：${error instanceof Error ? error.message : String(error)}，本次未发送`);
        return;
      }
    }
    const options = { ...composerOptions };
    if (preferences.sound) prepareCompletionSound();
    const context = { ...(overrideContext || composerContext) };
    const text = action ? prompt : composeOutgoing(prompt, context, savedInput);
    const controller = new AbortController(); const requestId = crypto.randomUUID();
    activeRequest.current = { controller, requestId, session };
    setGeneratingId(session?.id || 'creating');
    setLiveSpeed(undefined);
    // A fresh send ignores the selected session so the prompt opens a new one.
    let target = fresh ? undefined : session;
    const answerId = crypto.randomUUID();
    const now = Date.now();
    const time = new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const message = { id: crypto.randomUUID(), role: 'user' as const, text, time };
    // Structured actions (execute_plan) are silent: they run the plan without a user bubble.
    const silent = !!action;
    let completed = false;
    const assistant: Message = { id: answerId, role: 'assistant', text: '', time, startedAt: now, blocks: [] };
    let petAnswer = assistant;
    try {
      if (!target) {
        const created = await api.request<{ sessionName: string }>(`/sessions/new?workspaceHash=${encodeURIComponent(workspace)}`, 'POST', undefined, controller.signal);
        target = remoteSession({ name: created.sessionName, title: titleSource.slice(0, 60), messageCount: 0, mtime: now }, currentWorkspace);
        activeRequest.current!.session = target;
        await api.request(sessionRoute(target, '/title'), 'PUT', { title: target.title }, controller.signal);
        setSessions(current => [...current, target!]); setActiveId(target.id);
      }
      const id = target.id; setGeneratingId(id);
      await api.request('/config', 'PUT', { hitl: permissionValue(options.mode), fastMode: options.fast, terminateOnNoToolCall: options.finishWithoutTools }, controller.signal);
      // Approving a plan (execute_plan) must not re-enter plan mode; the agent clears it while executing.
      if (!action) await api.request('/agent/mode', 'POST', { workspaceHash: target.workspaceHash, sessionName: target.name, enabled: options.plan }, controller.signal);
      setSessions(current => current.map(item => item.id === id ? { ...item, messages: silent ? [...item.messages, assistant] : [...item.messages, message, assistant] } : item));
      setDraft(''); setComposerContext(emptyContext); setMenu(null);
      // A new prompt always returns to the newest message (legacy scroll(true)).
      userScrolledAway.current = false;
      const scroller = scrollArea.current;
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
      setShowScrollBtn(false);
      const attachments = context.attachments || [];
      const documentText = attachments.filter(file => file.text !== undefined).map(file => `附件：${file.name}\n${file.text}`).join('\n\n');
      await api.stream({ message: [text, documentText].filter(Boolean).join('\n\n'), requestId, workspaceHash: target.workspaceHash!, sessionName: target.name!, model: selectedModel.name, modelChannelId: selectedModel.providerId, reasoningEffort: options.effort, fastMode: options.fast, images: attachments.flatMap(file => file.image ? [file.image] : []), linkedProjectHashes: workspaces.filter(project => context.projects.includes(project.name)).map(project => project.hash), ...(action ? { action } : {}) }, event => {
        if (event.type === 'plan_submitted') { setPendingPlan(event.plan || undefined); setComposerOptions(current => ({ ...current, plan: true })); return; }
        if (event.type === 'mode_changed') { setComposerOptions(current => ({ ...current, plan: event.mode === 'plan' })); if (event.mode !== 'plan') setPendingPlan(undefined); return; }
        if (event.type === 'snapshot' && event.msgId) setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === message.id ? { ...entry, rollbackId: event.msgId, ...(event.hasCodeSnapshot ? { snapshotId: event.msgId } : {}) } : entry) } : item));
        if (event.type === 'token_speed') { setLiveSpeed({ tokensPerSecond: event.tokensPerSecond, avgTokensPerSecond: event.avgTokensPerSecond, done: !!event.done, completionTokens: event.completionTokens }); return; }
        // Legacy `log` events only surface as floating INFO/WARN/ERROR bars.
        if (event.type === 'log') { chatLogs.push({ level: event.level, message: event.message, content: event.content }); return; }
        // Legacy Chat.vue opened the right panel's command tab when the agent
        // started a background shell, so the running process is visible.
        if ((event.type === 'tool_call' || event.type === 'sub_tool_call') && event.name === 'bash_start') window.dispatchEvent(new CustomEvent('loopra:bash-start'));
        petAnswer = applyEvent(petAnswer, event);
        setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? applyEvent(entry, event) : entry) } : item));
      }, controller.signal);
      completed = true;
      const preview = petReplyPreview(petAnswer);
      if (preview) setPetReply({ id: answerId, text: preview });
      if (preferences.notifications) notify('回复已完成');
      if (preferences.sound) playCompletionSound();
    } catch (error) {
      const content = controller.signal.aborted || activeRequest.current?.stopping ? '> 本次回复已停止。' : `> 请求失败：${error instanceof Error ? error.message : error}`;
      setPetReply({ id: answerId, text: content.replace(/^> /, ''), activity: controller.signal.aborted || activeRequest.current?.stopping ? 'idle' : 'failed' });
      setSessions(current => current.map(item => item.id === target?.id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? applyEvent(entry, { type: 'content', content: `\n\n${content}` }) : entry) } : item));
      notify(content.replace(/^> /, ''));
    } finally {
      if (target) {
        const id = target.id;
        setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? { ...entry, finishedAt: Date.now() } : entry) } : item));
        try { const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(target)}`); if (completed && !controller.signal.aborted && history.length) setSessions(current => current.map(item => item.id === id ? { ...item, messages: historyMessages(history) } : item)); } catch { /* Keep the already received stream if history reload fails. */ }
        if (action === 'execute_plan') { try { const mode = await api.request<{ mode: string; pendingPlan?: string | null }>(`/agent/mode?${sessionQuery(target)}`, 'GET'); setComposerOptions(current => ({ ...current, plan: mode.mode === 'plan' })); setPendingPlan(mode.pendingPlan || undefined); } catch { /* keep the stream-derived state */ } }
      }
      activeRequest.current = undefined; setGeneratingId(null);
      setLiveSpeed(current => current && !current.done ? { ...current, done: true, avgTokensPerSecond: current.avgTokensPerSecond ?? current.tokensPerSecond } : current);
      if (target && queuedRef.current[target.id]?.length) void sendQueuedMessage(target.id);
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
  // Switching backends/servers drops the previous run's tokens/s badge so the
  // home composer never shows a speed from another project.
  useEffect(() => { setLiveSpeed(undefined); }, [server]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange); return () => media.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const onChange = () => { setNarrow(media.matches); setSidebar(!media.matches); };
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
  // Legacy `scroll()`: follow streaming output unless the user scrolled away.
  useEffect(() => {
    const element = scrollArea.current;
    if (!element || !session?.messages.length) return;
    if (!userScrolledAway.current || chatNearBottom(element)) element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
    setShowScrollBtn(!chatNearBottom(element));
  }, [session?.messages, session?.id]);
  useEffect(() => {
    function onPointer(event: PointerEvent) { if (!(event.target as HTMLElement).closest('[data-popover]')) setMenu(null); }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { setMenu(null); if (narrow) setSidebar(false); return; }
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

  const composer = <BackgroundTasks key={workspace} api={api} workspaceHash={workspace} connected={backend.status === 'connected' && backend.ready} open={terminal} onOpenChange={setTerminal} notify={notify}><Composer home={isHome} language={preferences.language} draft={draft} onDraft={setDraft} inputRef={textarea}
    options={composerOptions} onOptions={saveOptions} context={composerContext} onContext={setComposerContext}
    providers={providers} api={api} workspaceHash={workspace} sessionName={session?.name} workspaces={workspaces} connected={backend.status === 'connected'} skillOptions={agentSettings.skills.filter(skill => skill.enabled)} systemPrompt={agentSettings.systemPrompt} petEnabled={agentSettings.petEnabled} pets={pets} petReply={petReply} latestPetReply={petReplyPreview(session?.messages.filter(message => message.role === 'assistant').at(-1))} onPetClose={() => setAgentSettings(current => ({ ...current, petEnabled: false }))} petActivity={petActivity(!!generatingId && generatingId === activeId, session?.messages.at(-1)?.blocks)} defaultModel={defaultModel} onDefaultModel={saveDefaultModel}
    history={session ? getSessionMessages(session).map(message => message.text) : []}
    busy={!!generatingId || backend.status !== 'connected' || !backend.ready} generating={!!generatingId && generatingId === activeId}
    // Legacy `continueChat` sent the literal `/continue` command so the backend
    // resumes from the existing context (and approves pending HITL) without
    // appending a user message.
    onSend={() => sendMessage()} onStop={stopGeneration} onContinue={() => sendMessage('/continue')}
    onNew={() => newSession()} onClear={() => clearChat()} onTerminal={() => openTerminal()} onManage={() => openSettings('模型供应商')}
    onExport={() => { if (!session) { notify('请先开始一个会话'); return; } downloadText(`chat-${new Date().toISOString().slice(0, 10)}.txt`, chatExportText(getSessionMessages(session))); notify('对话已导出'); }}
    onSessions={() => setSessionsOpen(true)}
    queue={session ? (queuedMessages[session.id] || []) : []} onRemoveQueued={removeQueuedMessage} onGuideQueued={guideQueuedMessage}
    remoteRunning={!!session && remoteRun?.id === session.id} onStopRemote={stopRemoteRun}
    liveSpeed={liveSpeed}
    onOpen={() => { setMenu(null); setTerminal(false); }} notify={notify} /></BackgroundTasks>;

  return <AppMotion enabled={preferences.animations}><div className={`desktop-app${isDesktopWindow() ? ' is-desktop-shell' : ''}`}>
    {isDesktopWindow() && <DesktopTitleBar />}
    <div className="app-body">
      {narrow && sidebar && <button className="sidebar-backdrop" aria-label="关闭侧边栏遮罩" onClick={() => setSidebar(false)} />}
      {sidebar && <SidebarSurface key="sidebar"><div className="sidebar-brand"><span className="app-icon"><LoopraMark small /></span><span>Loopra</span><IconButton label="收起侧边栏" onClick={() => setSidebar(false)}><PanelLeft size="1.0625rem" /></IconButton></div><div className="sidebar-actions"><button onClick={() => newSession()}><MessageCirclePlus size="1.1875rem" />{preferences.language === 'English' ? 'New chat' : '新建会话'}</button><button onClick={() => { setSearchOpen(true); setMenu(null); }}><SearchIcon size="1.25rem" />{preferences.language === 'English' ? 'Search' : '搜索'}</button><button onClick={() => openSettings('技能')}><Sparkles size="1.1875rem" />{preferences.language === 'English' ? 'Skills' : '技能'}</button><button onClick={openSessionsManager}><MessagesSquare size="1.1875rem" />{preferences.language === 'English' ? 'Manage sessions' : '会话管理'}</button><button onClick={() => { setRequirementsOpen(true); setMenu(null); if (narrow) setSidebar(false); }}><ClipboardList size="1.1875rem" />{preferences.language === 'English' ? 'Requirement board' : '需求池'}</button><button onClick={() => { setHelpOpen(true); setMenu(null); }}><HelpCircle size="1.1875rem" />{preferences.language === 'English' ? 'Help' : '帮助中心'}</button></div>
        <div className="session-section" ref={sessionSection}><div className="section-label"><span>会话</span><div><IconButton label="定位当前会话" onClick={locateActiveSession}><Crosshair size="0.875rem" /></IconButton><IconButton label="折叠工作区" onClick={() => setCollapsed(collapsed.length ? [] : workspaces.map(item => item.hash))}><Plus size="0.9375rem" className="collapse-icon" /></IconButton><IconButton label={sortNewest ? '恢复默认排序' : '按最新排序'} active={sortNewest} onClick={() => setSortNewest(!sortNewest)}><SlidersHorizontal size="0.875rem" /></IconButton><IconButton label="刷新项目列表" onClick={() => void backend.refresh()}><RefreshCw size="0.875rem" /></IconButton></div></div>
          {workspaces.map(item => <div key={item.hash} className={`workspace-group ${dragWorkspace === item.hash ? 'dragging' : ''} ${dragOverWorkspace === item.hash && dragWorkspace !== item.hash ? 'drag-over' : ''}`} draggable onDragStart={event => { setDragWorkspace(item.hash); event.dataTransfer.effectAllowed = 'move'; }} onDragOver={event => { if (!dragWorkspace || dragWorkspace === item.hash) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverWorkspace(item.hash); }} onDragLeave={() => setDragOverWorkspace(current => current === item.hash ? '' : current)} onDrop={event => { event.preventDefault(); reorderWorkspaces(dragWorkspace, item.hash); }} onDragEnd={() => { setDragWorkspace(''); setDragOverWorkspace(''); }}><div className="workspace-heading-row"><button className={`workspace-heading ${isHome && workspace === item.hash ? 'selected' : ''}`} onClick={() => newSession(item.hash)} onDoubleClick={() => setCollapsed(current => current.includes(item.hash) ? current.filter(name => name !== item.hash) : [...current, item.hash])}>{collapsed.includes(item.hash) ? <FolderClosed size="1.1875rem" /> : <FolderOpen size="1.1875rem" />}<span>{item.name}</span></button><span className="workspace-tools"><IconButton label={`在 ${item.name} 新建会话`} onClick={() => newSession(item.hash)}><Plus size="0.8125rem" /></IconButton><IconButton label={`刷新 ${item.name} 的会话`} onClick={() => void refreshProject(item.hash)}><RefreshCw size="0.8125rem" /></IconButton><IconButton label={`管理 ${item.name} 的会话`} onClick={() => setProjectDialog(item)}><MoreHorizontal size="0.9375rem" /></IconButton></span></div><Collapse open={!collapsed.includes(item.hash)} className="workspace-sessions">{!visibleSessions.some(entry => entry.workspaceHash === item.hash) && <p className="no-conversation">暂无对话</p>}{(sortNewest ? [...visibleSessions].reverse() : visibleSessions).filter(entry => entry.workspaceHash === item.hash).map(entry => <div key={entry.id} data-session-key={entry.id} className={`session-row ${activeId === entry.id ? 'selected' : ''}`}><button className={`session-item ${activeId === entry.id ? 'selected' : ''}`} onClick={() => selectSession(entry.id)} title={entry.title}>{activeId === entry.id && <SelectionIndicator />}<span>{entry.title}</span>{entry.worktreeMode && <i className="wt-badge" title="隔离分支模式">🌲</i>}<time>{entry.mtime ? new Date(entry.mtime).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}</time></button><span className="session-row-tools"><IconButton label={`刷新 ${entry.title}`} onClick={() => void refreshSessionChat(entry)}><RefreshCw size="0.75rem" /></IconButton><IconButton label={`删除 ${entry.title}`} onClick={() => setDeleteSession(entry)}><Trash2 size="0.75rem" /></IconButton></span></div>)}</Collapse></div>)}
        </div><footer className="sidebar-footer"><button className="profile-button" onClick={() => openSettings('账户')}><span className="avatar">🌷</span><span>Loopra</span><span className="free-badge">Local</span></button><span className="sidebar-quick-actions"><IconButton label="工具列表" onClick={() => openSettings('工具')}><Wrench size="0.9375rem" /></IconButton><IconButton label="子代理" onClick={() => openSettings('子代理')}><Bot size="0.9375rem" /></IconButton><IconButton label="数据面板" onClick={() => openSettings('数据面板')}><Activity size="0.9375rem" /></IconButton><IconButton label="切换主题" onClick={toggleTheme}><SunMoon size="0.9375rem" /></IconButton></span><IconButton label="设置" onClick={() => openSettings()}><SettingsIcon size="1.1875rem" /></IconButton></footer>
      </SidebarSurface>}
      <main className={`main-area ${changes ? 'has-changes' : ''}`}>
        <header className={`conversation-header ${isHome ? 'home-header' : ''}`}>
          {!sidebar && <IconButton label="展开侧边栏" className="sidebar-reopen" onClick={() => setSidebar(true)}><PanelLeft size="1.0625rem" /></IconButton>}
          {!isHome && <div className="breadcrumb"><span>{workspaceName}</span><span className="breadcrumb-divider">/</span><strong title={session.title}>{session.title}</strong><div data-popover className="menu-anchor"><IconButton label="会话选项" onClick={() => toggleMenu('session')}><MoreHorizontal size="1.1875rem" /></IconButton><Popup open={menu === 'session'} className="popup session-menu" role="menu"><button role="menuitem" onClick={() => { setRename(session.id); setRenameValue(session.title); setMenu(null); }}><FileCode2 size="1rem" />重命名会话</button><button role="menuitem" onClick={() => { setSessionDetails(true); setMenu(null); }}>原始记录与快照</button><button role="menuitem" onClick={() => { setMenu(null); clearChat(); }}><MessageCirclePlus size="1rem" />清空当前对话</button><button role="menuitem" onClick={() => { setMenu(null); downloadText(`chat-${new Date().toISOString().slice(0, 10)}.txt`, chatExportText(getSessionMessages(session))); notify('对话已导出'); }}><Download size="1rem" />导出对话</button><button role="menuitem" onClick={archiveSession}><Archive size="1rem" />在本机隐藏</button><button role="menuitem" onClick={() => { setDeleteSession(session); setMenu(null); }}><Trash2 size="1rem" />删除会话</button><button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(session.title); setMenu(null); notify('已复制会话标题'); }}><Copy size="1rem" />复制会话标题</button></Popup></div></div>}
          <div className="header-actions"><button className={`backend-status ${backend.status}`} title={backend.error || `${server} · v${backend.version}`} onClick={() => openSettings('服务器')}><span />{backend.status === 'connecting' ? '连接中' : backend.status === 'error' ? '连接失败' : backend.ready ? 'Loopra 已连接' : '需要配置模型'}</button>{!isHome && <><div data-popover className="menu-anchor"><div className="folder-split"><button aria-label="查看工作区文件" onClick={openWorkspace}>📁</button><button aria-label="打开方式" onClick={() => toggleMenu('folder')}><ChevronDown size="1rem" /></button></div><Popup open={menu === 'folder'} className="popup folder-menu" role="menu"><button role="menuitem" onClick={() => { setWorkbenchTab('files'); setChanges(true); setMenu(null); }}><span className="emoji-icon">📁</span>File Explorer</button><button role="menuitem" onClick={() => { setTerminal(true); setMenu(null); }}><span className="terminal-icon">&gt;_</span>Terminal</button><button role="menuitem" onClick={() => openTerminal()}><span className="git-icon">◆</span>Git Bash</button><hr /><button role="menuitem" onClick={copyPath}><Copy size="1.0625rem" />复制路径</button></Popup></div>{!changes && <div data-popover className="menu-anchor"><button className="branch-button" onClick={() => toggleMenu('branch')}><GitBranch size="1rem" />{gitBranch}</button><Popup open={menu === 'branch'} className="popup branch-menu"><h3>当前分支</h3><button onClick={() => { setChanges(true); setMenu(null); }}><GitBranch size="0.9375rem" />{gitBranch}<Check size="1rem" /></button></Popup></div>}</>}
              <IconButton label={changes ? '关闭改动面板' : '打开改动面板'} active={changes} onClick={() => setChanges(!changes)}><PanelRight size="1.0625rem" /></IconButton>
          </div>
        </header>
        <div className={`main-content ${isHome ? 'home-content' : ''}`}>{(!!generatingId || (!!session && remoteRun?.id === session.id)) && <div className="streaming-bar" role="status" aria-label="会话正在执行"><div className="streaming-bar-inner" /></div>}
          <ChatLogs logs={chatLogs.logs} onDismiss={chatLogs.dismiss} onCopy={text => { void navigator.clipboard?.writeText(text).then(() => chatLogs.push({ text: '✅ 日志已复制' })).catch(() => chatLogs.push({ level: 'ERROR', message: '复制失败，请手动选择日志' })); }} />
          {backend.status === 'error' && <div className="backend-error" role="alert"><span>无法连接 Loopra：{backend.error}</span><Button size="sm" variant="flat" onPress={() => void backend.refresh()}>重新连接</Button></div>}
          {isHome ? <section className="welcome-shell"><Enter as="div" className="welcome-intro"><h1 className="welcome-logo" aria-label="Loopra"><LoopraMark />Loopra</h1></Enter><div className="workspace-selector menu-anchor" data-popover><button onClick={() => toggleMenu('workspace')}><FolderClosed size="1.125rem" />{workspaceName}<ChevronDown size="1.0625rem" /></button><Popup open={menu === 'workspace'} className="popup workspace-menu"><h3>选择工作区</h3>{workspaces.map(item => <button key={item.hash} onClick={() => { setWorkspace(item.hash); setMenu(null); }}><FolderClosed size="1rem" />{item.name}{workspace === item.hash && <Check size="1rem" />}</button>)}{!workspaces.length && <p className="composer-empty">暂无可用项目</p>}<hr /><button onClick={() => openSettings('项目')}><FolderPlus size="1rem" />管理项目</button></Popup></div>{composer}</section> : <>
            <div className="chat-scroll" ref={scrollArea} onScroll={onChatScroll}><div className="chat-content"><Enter key={session.id}><Messages session={session} loading={generatingId === activeId} scrollRef={scrollArea} offsetsRef={messageOffsets} busy={!!generatingId || backend.status !== 'connected' || !backend.ready} notify={notify} onDiff={openDiff} onRevert={revertChanges} onChoice={chooseOption} onEdit={fillDraft} onBranch={branchSession} onRollback={message => { setRollbackMessage(message); setRollbackCode(false); }} onRawEvents={() => { setSessionDetailsTab('events'); setSessionDetails(true); }} /></Enter></div></div>
            {(() => { const dock = userMessageDock(getSessionMessages(session)); return dock.length > 0 && <nav className="msg-thumb-dock" aria-label="消息定位"><div className="thumb-dock-inner">{dock.map(item => <button key={item.id} type="button" className="thumb-item" title={item.text} onClick={() => jumpToMessage(item.id)}><span className="thumb-indicator" /><span className="thumb-preview">{truncatePreview(item.text)}</span></button>)}</div></nav>; })()}
            {showScrollBtn && <button type="button" className="scroll-bottom-btn" title="滚动到底部" aria-label="滚动到底部" onClick={scrollToBottom}><ArrowDownToLine size="1rem" /></button>}
            {getSessionMessages(session).length > 0 && <button type="button" className="collapse-all-btn" title="一键折叠所有展开的块" aria-label="一键折叠所有展开的块" onClick={collapseAllBlocks}><FoldVertical size="1rem" /></button>}
            <div className="chat-composer-area">{composerOptions.plan && <PlanReview pendingPlan={pendingPlan} busy={!!generatingId || planBusy} onApprove={() => void approvePlan()} onExit={() => setDiscardPlan(true)} notify={notify} />}<SessionProgress api={api} session={session} revision={progressRevision} />{composer}</div>
          </>}
        </div>
      </main>
      {changes && <ChangesPanel api={api} workspaceHash={workspace} key={workspace} initialFile={diffPath} initialDiff={diffInline} initialTab={workbenchTab} sessionName={session?.name} sessions={sessions} onAdd={addFileContext} onClose={() => setChanges(false)} notify={notify} />}
    </div>
    {sessionDetails && session && <SessionDetails api={api} session={session} initialTab={sessionDetailsTab} onClose={() => setSessionDetails(false)} onRolledBack={refreshCurrentSession} busy={!!generatingId} notify={notify} />}
    {deleteSession && <ConfirmAction title="删除会话" onClose={() => setDeleteSession(undefined)} action={() => removeSession(deleteSession)}><p>删除 {deleteSession.title} 及其在 Loopra 服务端的记录？此操作不可恢复。</p></ConfirmAction>}
    {projectDialog && <ProjectSessions api={api} workspace={projectDialog} count={sessions.filter(item => item.workspaceHash === projectDialog.hash).length} onClose={() => setProjectDialog(undefined)} onRefresh={() => backend.refresh()} onCompleted={kind => projectMaintained(kind, projectDialog)} notify={notify} />}
    {sessionsOpen && <SessionsManager api={api} sessions={visibleSessions} workspaceHash={workspace} workspaceName={workspaceName} activeId={activeId} onClose={() => setSessionsOpen(false)} onOpen={id => { setSessionsOpen(false); void selectSession(id); }} onNew={() => { setSessionsOpen(false); newSession(); }} onChanged={() => backend.refresh()} notify={notify} />}
    <Help open={helpOpen} onClose={() => setHelpOpen(false)} server={server} />
    {requirementsOpen && <RequirementBoard api={api} onClose={() => setRequirementsOpen(false)} notify={notify} />}
    {rollbackMessage && session && <ConfirmAction title="撤回消息" onClose={() => setRollbackMessage(undefined)} action={async () => {
      const result = await api.request<{ success: boolean; message: string; rollbackUserText?: string }>(`/snapshots/rollback?${sessionQuery(session)}&${query({ msgId: rollbackMessage.rollbackId, rollbackTimestamp: rollbackMessage.rollbackTimestamp, rollbackCode })}`, 'POST');
      if (!result.success) throw new Error(result.message);
      await refreshCurrentSession(result.rollbackUserText);
    }}><p>撤回这条消息及之后的所有记录？</p>{rollbackMessage.snapshotId && <label><input type="checkbox" checked={rollbackCode} onChange={event => setRollbackCode(event.target.checked)} />同时恢复代码到本条消息之前</label>}</ConfirmAction>}
    {discardPlan && <ConfirmAction title="退出计划模式" onClose={() => setDiscardPlan(false)} action={exitPlanMode}><p>{pendingPlan ? '待审查计划将被丢弃，且无法恢复。' : '将退出计划模式并恢复全部工具。'}</p></ConfirmAction>}
    <Search workspaces={workspaces} open={searchOpen} onClose={() => setSearchOpen(false)} sessions={visibleSessions} activeId={activeId} onSession={selectSession} onWorkspace={hash => newSession(hash)} />
    <Settings pets={pets} onInitPet={initPet} onAutoUpdate={() => void autoUpdate()} onRefresh={() => backend.refresh()} workspaces={workspaces} server={server} config={agentSettings} onConfig={saveAgentSettings} options={composerOptions} onOptions={saveOptions} defaultModel={defaultModel} onDefaultModel={saveDefaultModel} open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab={settingsTab} preferences={preferences} onPreferences={setPreferences} providers={providers} onProviders={saveProviders} sessions={sessions.map(item => ({ ...item, archived: hiddenSessions.includes(item.id) }))} onRestore={id => { setHiddenSessions(current => current.filter(item => item !== id)); notify('会话已恢复'); }} notify={notify} />
    <Modal isOpen={!!rename} onClose={() => setRename(null)} placement="center" classNames={{ base: 'rename-modal', backdrop: 'modal-backdrop' }} aria-label="重命名会话"><ModalContent><form onSubmit={event => { event.preventDefault(); void renameSession(); }}><h2>重命名会话</h2><Input autoFocus aria-label="会话名称" value={renameValue} onValueChange={setRenameValue} variant="bordered" /><div className="form-buttons"><Button variant="light" onPress={() => setRename(null)}>取消</Button><Button type="submit" color="primary" isDisabled={!renameValue.trim()}>保存</Button></div></form></ModalContent></Modal>
    <Toast message={toast}><Check size="1rem" />{toast}</Toast>
  </div></AppMotion>;
}

