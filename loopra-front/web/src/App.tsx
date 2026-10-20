import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { Check } from 'lucide-react';
import { getSessionMessages, useLocalState } from './lib';
import type { Provider, Session } from './lib';
import Sidebar from './layout/Sidebar';
import Header from './layout/Header';
import HomeView from './layout/HomeView';
import IsolationSwitch from './layout/IsolationSwitch';
import ChatDock from './layout/ChatDock';
import { Messages } from './components/Conversation';
import ChangesPanel from './components/Panels';
import BackgroundTasks from './components/BackgroundTasks';
import Settings, { defaultPreferences } from './components/Settings';
import { CoreServiceUpdateDialog, useCoreServiceUpdate } from './components/CoreServiceUpdate';
import type { Preferences } from './components/Settings';
import Search from './components/Search';
import type { FileChange, Message } from './chat';
import { attachPendingChoices, chatNearBottom, chatScrollState, collectPendingChoices, resolveChoiceBlock, unresolvedChoices, userMessageDock } from './chat';
import Composer from './components/Composer';
import type { AcpCommand, AcpPlanEntry, AgentEngine } from './backend';
import { applySeed, newSessionSeed, seedChanges, type AgentConfigOption } from './agent-config';
import { defaultAgentSettings, type AgentSettings } from './settings-data';
import { composeOutgoing, defaultOptions, emptyContext, getModelCatalog, largeInputReference, type ComposerContext, type ComposerOptions, type LiveSpeed, type QueuedMessage } from './composer';
import { LARGE_PASTE_THRESHOLD_CHARS } from './documents';
import { enqueue, nextQueued, promoteQueued, removeQueued, type MessageQueue } from './message-queue';
import { acpStopMessage, applyEvent, DEFAULT_SERVER, historyMessages, permissionLabel, permissionValue, providerChannels, remoteSession, serverAddress, sessionQuery, sessionRoute, type HistoryMessage, type StreamEvent, type Workspace } from './backend';
import useLoopra from './useLoopra';
import { AppMotion, Enter, Toast, usePresence } from './components/Motion';
import { prepareCompletionSound, playCompletionSound } from './notifications';
import usePets from './usePets';
import { petActivity, petReplyPreview, type PetReply } from './pets';
import SessionDetails, { SessionProgress } from './components/SessionDetails';
import { ConfirmAction, query } from './components/RemoteControls';
import ProjectSessions from './components/ProjectSessions';
import ProjectManager from './components/ProjectManager';
import Help from './components/Help';
import SessionsManager from './components/SessionsManager';
import RequirementBoard from './components/RequirementBoard';
import PlanReview from './components/PlanReview';
import ChoicePopup, { type ChoiceAnswer } from './components/ChoicePopup';
import ElicitationForm from './components/ElicitationForm';
import type { ElicitationRequest } from './elicitation';
import { chatExportText, downloadText } from './chat-export';
import ChatLogs, { useChatLogs } from './components/ChatLogs';
import DesktopTitleBar from './components/DesktopTitleBar';
import { desktopPlatform, isDesktopWindow, usesNativeWindowControls } from './desktop-shell';
import { fetchAvailableApplications, launchWorkspace, visibleApplications } from './workspace-launcher';
import { notifyWorkspaceChanged } from './workspace-events';
import WorkspaceTabs from './components/WorkspaceTabs';
import { closeSubAgentTab, closeWorkspaceFile, emptyWorkspaceTabs, ensureSubAgentTab, openSubAgentTab, openWorkspaceFile, updateWorkspaceFilePath, type WorkspaceFile, type WorkspaceTabs as WorkspaceTabsState } from './workspace-tabs';
import { subSessionLabel, type SubSession } from './sub-sessions';
import { useSubAgentTabs } from './useSubAgentTabs';

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
  const [availableApplications, setAvailableApplications] = useState<string[] | null>(null);
  const [petReply, setPetReply] = useState<PetReply | null>(null);
  const [composerContext, setComposerContext] = useState<ComposerContext>(emptyContext);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 760);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [changes, setChanges] = useState(false);
  // Both sidebars slide both ways, so they stay mounted until their exit slide ends.
  const sidebarMounted = usePresence(sidebar);
  const changesMounted = usePresence(changes);
  const [sessionDetails, setSessionDetails] = useState(false);
  const [sessionDetailsTab, setSessionDetailsTab] = useState('events');
  const [deleteSession, setDeleteSession] = useState<Session>();
  const [rollbackMessage, setRollbackMessage] = useState<Message>();
  const [rollbackCode, setRollbackCode] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<string>();
  const [discardPlan, setDiscardPlan] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [progressRevision, setProgressRevision] = useState(0);
  const [workspaceEditors, setWorkspaceEditors] = useState<Record<string, WorkspaceTabsState>>({});
  const editorKey = `${server}/${workspace}`;
  const editorTabs = workspaceEditors[editorKey] || emptyWorkspaceTabs;
  const [projectDialog, setProjectDialog] = useState<Workspace>();
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [homeTaskToolbar, setHomeTaskToolbar] = useState<HTMLDivElement | null>(null);
  const [gitBranch, setGitBranch] = useState('工作区');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('通用');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newAgentId, setNewAgentId] = useLocalState('agent-engine', 'native');
  const [engines, setEngines] = useState<AgentEngine[]>([]);
  const [acpPlans, setAcpPlans] = useState<Record<string, AcpPlanEntry[]>>({});
  const [acpCommands, setAcpCommands] = useState<Record<string, AcpCommand[]>>({});
  const [pendingInputs, setPendingInputs] = useState<Record<string, ElicitationRequest[]>>({});
  // The backend re-detects installed Agent runtimes on every request; bump this to refresh
  // after the user installs a missing runtime outside the app.
  const [enginesRevision, setEnginesRevision] = useState(0);
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentConfigOption[]>>({});
  // Home has no session yet, but its composer still advertises the selected
  // Agent's options. The prepared backend session is reused by the first send.
  const [newAgentConfig, setNewAgentConfig] = useState<{ key: string; options: AgentConfigOption[] } | null>(null);
  // Read synchronously by sends that race the background seeding.
  const newAgentConfigRef = useRef<{ key: string; options: AgentConfigOption[] } | null>(null);
  const newConfigSeed = useRef<Promise<void> | null>(null);
  function storeNewAgentConfig(next: { key: string; options: AgentConfigOption[] } | null) {
    newAgentConfigRef.current = next;
    setNewAgentConfig(next);
  }
  // The last new conversation's choices per backend and Agent. Existing sessions
  // keep their own saved config; only a fresh draft is seeded from this record.
  const [newSessionConfig, setNewSessionConfig] = useLocalState<Record<string, Record<string, string | boolean>>>('new-session-config', {});
  // Last known option list per backend and Agent. The home composer shows it
  // (disabled) while the Agent reconnects instead of collapsing into a spinner.
  const [agentConfigCache, setAgentConfigCache] = useLocalState<Record<string, AgentConfigOption[]>>('agent-config-cache', {});
  const preparedNewSession = useRef<{ key: string; target: Session } | null>(null);
  // A draft's Agent choices are already authoritative when it becomes a real
  // session. Remember the id briefly so selecting it does not fire a redundant
  // configuration read that would race (and lose to) the first prompt.
  const seededConfigAt = useRef<Record<string, number>>({});
  const [agentConfigBusy, setAgentConfigBusy] = useState<string>();
  const [agentConfigError, setAgentConfigError] = useState('');
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [liveSpeed, setLiveSpeed] = useState<LiveSpeed>();
  const [toast, setToast] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const activeRequest = useRef<{ controller: AbortController; requestId: string; session?: Session; stopping?: boolean; stopPromise?: Promise<void> }>();
  const sendingQueued = useRef(new Set<string>());
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const [queuedMessages, setQueuedMessages] = useState<Record<string, QueuedMessage[]>>({});
  const queuedRef = useRef(queuedMessages);
  useEffect(() => { queuedRef.current = queuedMessages; }, [queuedMessages]);
  // Live sessions for async senders: a resumed turn must find the bubble it is
  // continuing even while several choice answers are sent back to back.
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const [remoteRun, setRemoteRun] = useState<{ id: string; requestId?: string | null } | null>(null);
  const remoteRunRef = useRef<string | null>(null);
  const historyRequest = useRef<AbortController>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const notifiedUpdate = useRef('');
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
  // Legacy Chat.vue floating log stack (SSE `log`, `copy-success`, `app-notify`).
  const chatLogs = useChatLogs();
  const settingsQueue = useRef(Promise.resolve());
  const session = sessions.find(item => item.id === activeId && !hiddenSessions.includes(item.id));
  const isHome = !session;
  const agentId = session?.agentId || (session ? 'native' : newAgentId);
  const externalAgent = agentId !== 'native';
  const agentConfigKey = `${workspace}::${agentId}`;
  const composerConfigBusy = !!agentConfigBusy || (!session && newAgentConfig?.key !== agentConfigKey);
  useEffect(() => {
    setAgentConfigError('');
    if (!session?.name || !session.workspaceHash || backend.status !== 'connected') return;
    // Just converted from a preconfigured draft: the Agent already holds these
    // choices, so a read here only competes with the first prompt for the process.
    const seededAt = seededConfigAt.current[session.id];
    if (seededAt && Date.now() - seededAt < 5000) return;
    const controller = new AbortController();
    const id = session.id; setAgentConfigBusy(id);
    void api.request<{ configOptions: AgentConfigOption[] }>(`/agent-engines/config?${sessionQuery(session)}`, 'GET', undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setAgentConfigs(current => ({ ...current, [id]: result.configOptions })); })
      .catch(error => { if (!controller.signal.aborted) setAgentConfigError(error instanceof Error ? error.message : String(error)); })
      .finally(() => setAgentConfigBusy(current => current === id ? undefined : current));
    return () => controller.abort();
  }, [api, session?.id, backend.status]);
  useEffect(() => {
    const controller = new AbortController();
    void api.request<AgentEngine[]>('/agent-engines', 'GET', undefined, controller.signal).then(setEngines).catch(() => setEngines([]));
    return () => controller.abort();
  }, [api, backend.status, enginesRevision]);
  // Pending HITL/ask_choice cards drive the composer popup. Read from the live
  // session messages (not demo history) so mock/offline sessions never pop it.
  const pendingChoices = useMemo(() => collectPendingChoices(session?.messages || []), [session?.messages]);
  const visibleSessions = sessions.filter(item => !hiddenSessions.includes(item.id));
  const currentWorkspace = workspaces.find(item => item.hash === workspace);
  const workspaceName = currentWorkspace?.name || '选择工作区';
  const isDark = preferences.theme === '深色' || (preferences.theme === '跟随系统' && systemDark);
  // A new chat has no session yet, but the Agent's choices are already known:
  // prepare them in the background so the composer never asks for a manual step.
  useEffect(() => {
    if (session || !currentWorkspace || backend.status !== 'connected' || !backend.ready) return;
    if (newAgentConfig?.key === agentConfigKey || preparedNewSession.current?.key === agentConfigKey) return;
    const engine = engines.find(item => item.id === agentId);
    if (engine && !engine.available) return;
    const controller = new AbortController();
    // Debounce so StrictMode's throwaway first effect (and rapid Agent toggles)
    // never spawns a backend session that nobody asked for.
    const timer = setTimeout(() => void loadNewAgentConfig(currentWorkspace.hash, agentId, controller.signal), 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [session, agentConfigKey, currentWorkspace, backend.status, backend.ready, newAgentConfig?.key, engines, agentId]);

  useLayoutEffect(() => {
    // Root tokens also reach NextUI menus, modals and tooltips rendered in portals.
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', String(preferences.fontScale / 100));
    return () => { root.style.removeProperty('--ui-scale'); };
  }, [preferences.fontScale]);

  function notify(message: string) { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2600); }
  const coreUpdate = useCoreServiceUpdate(api, notify, () => { setSettingsOpen(false); setMenu(null); }, settingsOpen);
  useEffect(() => {
    const check = backend.updateCheck;
    if (!check?.hasNewVersion || !check.latestVersion || notifiedUpdate.current === check.latestVersion) return;
    notifiedUpdate.current = check.latestVersion;
    notify(`发现新版本 v${check.latestVersion}，点击顶栏版本查看`);
  }, [backend.updateCheck]);
  function selectMainTab(path: string | null, hash = workspace) { const key = `${server}/${hash}`; setWorkspaceEditors(current => ({ ...current, [key]: { ...(current[key] || emptyWorkspaceTabs), active: path } })); }
  function openFile(file: WorkspaceFile) { setWorkspaceEditors(current => ({ ...current, [editorKey]: openWorkspaceFile(current[editorKey] || emptyWorkspaceTabs, file) })); if (narrow) setChanges(false); }
  function changeFilePath(from: string, to?: string) { setWorkspaceEditors(current => ({ ...current, [editorKey]: updateWorkspaceFilePath(current[editorKey] || emptyWorkspaceTabs, from, to) })); }
  function closeFile(path: string) { setWorkspaceEditors(current => ({ ...current, [editorKey]: closeWorkspaceFile(current[editorKey] || emptyWorkspaceTabs, path) })); }
  function closeSubAgent(subSessionId: string) { setWorkspaceEditors(current => ({ ...current, [editorKey]: closeSubAgentTab(current[editorKey] || emptyWorkspaceTabs, subSessionId) })); }
  useSubAgentTabs(api, server, session, backend.status === 'connected', generatingId, setWorkspaceEditors);
  /** Open a sub-agent run as a main-area tab (live runs auto-open one as well). */
  function showSubAgent(item: Pick<SubSession, 'subSessionId' | 'name' | 'title' | 'task'>, sessionName = session?.name) {
    if (!sessionName) return;
    const label = subSessionLabel({ status: 'running', startedAt: 0, endedAt: 0, eventCount: 0, ...item });
    setWorkspaceEditors(current => ({ ...current, [editorKey]: openSubAgentTab(current[editorKey] || emptyWorkspaceTabs,
      { subSessionId: item.subSessionId, sessionName, label }) }));
  }
  function mutation(task: () => Promise<void>) {
    const result = settingsQueue.current.then(async () => {
      if (activeRequest.current) throw new Error('请等待当前回复结束后再修改运行配置');
      if (backend.status !== 'connected') throw new Error('尚未连接 Loopra');
      await task();
    });
    settingsQueue.current = result.catch(error => { notify(`保存失败：${error instanceof Error ? error.message : error}`); });
    return result;
  }
  function newConfigKey(agent: string) { return `${server}::${agent}`; }
  function cacheAgentConfig(agent: string, options: AgentConfigOption[]) {
    setAgentConfigCache(current => ({ ...current, [newConfigKey(agent)]: options }));
  }
  function rememberNewConfig(agent: string, options: AgentConfigOption[]) {
    setNewSessionConfig(current => ({ ...current, [newConfigKey(agent)]: newSessionSeed(options) }));
  }
  /** Native's non-ACP fallback writes the same choices through ComposerOptions. */
  function rememberFallbackConfig(agent: string, next: ComposerOptions) {
    setNewSessionConfig(current => ({ ...current, [newConfigKey(agent)]: {
      model: next.modelId, mode: permissionValue(next.mode), effort: next.effort, fast: next.fast ? 'on' : 'off',
    } }));
  }
  /**
   * Re-apply the last new conversation's choices to a freshly prepared draft.
   * A value the Agent no longer offers is skipped, so the draft always opens.
   */
  async function seedNewConfig(workspaceHash: string, sessionName: string, agent: string,
      options: AgentConfigOption[]) {
    let current = options;
    for (const change of seedChanges(options, newSessionConfig[newConfigKey(agent)])) {
      try {
        const result = await api.request<{ configOptions: AgentConfigOption[] }>('/agent-engines/config', 'PUT',
          { workspaceHash, sessionName, configId: change.id, value: change.value });
        current = result.configOptions;
      } catch (error) {
        // A retired model or a disabled mode must not block a new conversation.
        console.warn('[agent-config] 忽略无法恢复的新会话配置', change.id, error);
      }
    }
    return current;
  }
  function saveOptions(next: ComposerOptions) {
    if (externalAgent) { setComposerOptions(next); return Promise.resolve(); }
    // Leaving plan mode discards any submitted plan, so confirm first (legacy togglePlan).
    if (!next.plan && composerOptions.plan && session) { setDiscardPlan(true); return Promise.resolve(); }
    return mutation(async () => {
      if (!session) await newConfigSeed.current?.catch(() => {});
      const prepared = preparedNewSession.current;
      const target = session || (prepared?.key === agentConfigKey ? prepared.target : undefined) || await prepareAgentConfig();
      if (!target) return;
      const changes: [string, string][] = [];
      if (next.modelId !== composerOptions.modelId) changes.push(['model', next.modelId]);
      if (next.mode !== composerOptions.mode) changes.push(['mode', permissionValue(next.mode)]);
      if (next.effort !== composerOptions.effort) changes.push(['effort', next.effort]);
      if (next.fast !== composerOptions.fast) changes.push(['fast', next.fast ? 'on' : 'off']);
      if (next.plan !== composerOptions.plan) changes.push(['plan', next.plan ? 'on' : 'off']);
      for (const [configId, value] of changes) {
        const result = await api.request<{ configOptions: AgentConfigOption[] }>('/agent-engines/config', 'PUT',
          { workspaceHash: target.workspaceHash, sessionName: target.name, configId, value });
        if (session) setAgentConfigs(current => ({ ...current, [target.id]: result.configOptions }));
        else {
          const draft = newAgentConfigRef.current;
          if (draft?.key === agentConfigKey) storeNewAgentConfig({ ...draft, options: result.configOptions });
          cacheAgentConfig(target.agentId || agentId, result.configOptions);
        }
      }
      // A fresh draft remembers its final choices for the next new conversation.
      if (!session) rememberFallbackConfig(target.agentId || agentId, next);
      setComposerOptions(next);
    }).catch(() => {});
  }
  /**
   * Fetch the selected Agent's defaults for the home composer. The returned
   * session name is kept only as a draft: it becomes visible when the first
   * message is sent, so browsing the home page never adds empty sessions.
   */
  async function loadNewAgentConfig(workspaceHash: string, requestedAgent: string, signal?: AbortSignal) {
    const key = `${workspaceHash}::${requestedAgent}`;
    const busyId = `new:${key}`;
    setAgentConfigBusy(busyId); setAgentConfigError('');
    try {
      const prepared = await api.request<{ sessionName: string; agentId: string; configOptions: AgentConfigOption[] }>('/agent-engines/prepare', 'POST',
        { workspaceHash, sessionName: undefined, agentId: requestedAgent }, signal);
      if (signal?.aborted) return;
      const project = workspaces.find(item => item.hash === workspaceHash);
      if (!project) return;
      const target = remoteSession({ name: prepared.sessionName, agentId: prepared.agentId, title: '新会话', messageCount: 0, mtime: Date.now() }, project);
      preparedNewSession.current = { key, target };
      // Show the Agent's controls immediately, already carrying the remembered
      // choices, so the factory default never flashes before the writes land.
      // The remembered choices are also applied to the draft in the background,
      // and the first send waits for them, so opening the home page never blocks
      // on a round trip per option. Seeding deliberately does not use the effect's
      // abort signal: the state update above reruns the effect and would cancel
      // the very requests that restore the draft.
      storeNewAgentConfig({ key, options: applySeed(prepared.configOptions, newSessionConfig[newConfigKey(prepared.agentId)]) });
      let seeding: Promise<void>;
      seeding = seedNewConfig(workspaceHash, prepared.sessionName, prepared.agentId, prepared.configOptions)
        .then(options => {
          const draft = newAgentConfigRef.current;
          if (draft?.key === key) storeNewAgentConfig({ key, options });
          cacheAgentConfig(prepared.agentId, options);
        })
        .finally(() => { if (newConfigSeed.current === seeding) newConfigSeed.current = null; });
      newConfigSeed.current = seeding;
    } catch (error) {
      if (signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setAgentConfigError(message); notify(message);
    } finally {
      setAgentConfigBusy(current => current === busyId ? undefined : current);
    }
  }
  async function prepareAgentConfig() {
    if (!currentWorkspace) { notify('请先选择工作区'); return; }
    setAgentConfigBusy(session?.id || 'new'); setAgentConfigError('');
    try {
      const prepared = await api.request<{ sessionName: string; agentId: string; configOptions: AgentConfigOption[] }>('/agent-engines/prepare', 'POST',
        { workspaceHash: currentWorkspace.hash, sessionName: session?.name, agentId });
      // Only a new draft is seeded; an existing session keeps its own saved config.
      const options = session ? prepared.configOptions
        : await seedNewConfig(currentWorkspace.hash, prepared.sessionName, prepared.agentId, prepared.configOptions);
      const target = session || remoteSession({ name: prepared.sessionName, agentId: prepared.agentId, title: '新会话', messageCount: 0, mtime: Date.now() }, currentWorkspace);
      if (!session) cacheAgentConfig(prepared.agentId, options);
      setAgentConfigs(current => ({ ...current, [target.id]: options }));
      // A fresh session goes to the top, matching the server's newest-first list.
      if (!session) { setSessions(current => [target, ...current]); setActiveId(target.id); }
      return target;
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setAgentConfigError(message); notify(message); }
    finally { setAgentConfigBusy(undefined); }
  }
  function retryAgentConfig() {
    if (session) { void prepareAgentConfig(); return; }
    if (currentWorkspace) void loadNewAgentConfig(currentWorkspace.hash, agentId);
  }
  async function changeAgentConfig(configId: string, value: string | boolean) {
    const prepared = preparedNewSession.current;
    const target = session || (prepared?.key === agentConfigKey ? prepared.target : undefined);
    if (!target) return;
    // A background seed writes the same options; finish it first so this change wins.
    if (!session) await newConfigSeed.current?.catch(() => {});
    setAgentConfigBusy(target.id);
    try {
      const result = await api.request<{ configOptions: AgentConfigOption[] }>('/agent-engines/config', 'PUT',
        { workspaceHash: target.workspaceHash, sessionName: target.name, configId, value });
      if (session) setAgentConfigs(current => ({ ...current, [target.id]: result.configOptions }));
      else {
        const draft = newAgentConfigRef.current;
        if (draft?.key === agentConfigKey) storeNewAgentConfig({ ...draft, options: result.configOptions });
        cacheAgentConfig(target.agentId || agentId, result.configOptions);
        // A draft's change becomes the starting point for the next new conversation.
        rememberNewConfig(target.agentId || agentId, result.configOptions);
      }
      if (target.agentId === 'native' || !target.agentId) {
        // Native choices also feed the legacy settings page and plan review, so
        // mirror the Agent's authoritative config back into composer options.
        setComposerOptions(current => {
          const next = { ...current };
          const model = result.configOptions.find(option => option.id === 'model');
          const mode = result.configOptions.find(option => option.id === 'mode');
          const effort = result.configOptions.find(option => option.id === 'effort');
          const fast = result.configOptions.find(option => option.id === 'fast');
          const plan = result.configOptions.find(option => option.id === 'plan');
          if (model && typeof model.currentValue === 'string') next.modelId = model.currentValue;
          if (mode && typeof mode.currentValue === 'string') next.mode = permissionLabel(mode.currentValue);
          if (effort && typeof effort.currentValue === 'string') next.effort = effort.currentValue;
          if (fast) next.fast = fast.currentValue === true || fast.currentValue === 'on';
          if (plan) next.plan = plan.currentValue === 'on';
          return next;
        });
        const plan = result.configOptions.find(option => option.id === 'plan');
        if (plan && plan.currentValue !== 'on') setPendingPlan(undefined);
      }
    } catch (error) { notify(`保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setAgentConfigBusy(undefined); }
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
  /** Switching the Agent always starts a new conversation, and never mid-run. */
  function switchAgent(id: string) {
    if (id === agentId) return;
    if (generatingId || remoteRun) { notify('任务运行中，结束后才能切换 Agent'); return; }
    setNewAgentId(id);
    newSession();
  }
  function newSession(nextWorkspace = workspace || workspaces[0]?.hash || '') { selectMainTab(null, nextWorkspace); if (narrow) setSidebar(false); historyRequest.current?.abort(); if (getModelCatalog(providers).some(model => model.id === defaultModel)) setComposerOptions(value => ({ ...value, modelId: defaultModel })); setActiveId(null); setWorkspace(nextWorkspace); setChanges(false); setDraft(''); setComposerContext(emptyContext); setPendingPlan(undefined); setLiveSpeed(undefined); setMenu(null); userScrolledAway.current = false; lastScrollTop.current = 0; setShowScrollBtn(false); setTimeout(() => textarea.current?.focus(), 50); }
  // Legacy Chat.vue 清空按钮：后端 /new 命令已移除，改为在当前工作区新建空白会话。
  function clearChat() { if (generatingId) { notify('生成中无法清空，请先停止生成'); return; } newSession(workspace || workspaces[0]?.hash || ''); notify('已新建空白会话'); }
  async function selectSession(id: string) {
    const selected = sessions.find(item => item.id === id); if (!selected) return;
    selectMainTab(null, selected.workspaceHash || '');
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
      setComposerOptions(current => ({ ...current, ...(selected.agentId && selected.agentId !== 'native' ? {} : { modelId: `${settings.modelChannelId}:${settings.model}` }), effort: settings.reasoningEffort || current.effort, plan: mode.mode === 'plan' }));
      setPendingPlan(mode.pendingPlan || undefined);
    } catch (error) { if (!controller.signal.aborted) notify(`加载会话失败：${error instanceof Error ? error.message : error}`); }
  }
  function toggleMenu(name: string) { setMenu(current => current === name ? null : name); }
  function openSettings(tab = '通用') { setSettingsTab(tab); setSettingsOpen(true); setMenu(null); }
  function openCoreUpdate() {
    if (coreUpdate.update?.running || coreUpdate.startingUpdate) coreUpdate.show();
    else coreUpdate.prepare(backend.version || backend.updateCheck?.currentVersion || '-', backend.updateCheck);
  }
  // Legacy Sidebar.vue footer exposed 工具 / 子代理 / 数据面板 / 主题 / 设置; the
  // theme button flipped light↔dark without touching 跟随系统.
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
  // Legacy Sidebar.vue drag-reorder: persist the new project order to the backend.
  function reorderWorkspaces(from: string, to: string) {
    if (!from || !to || from === to) return;
    const next = [...workspaces];
    const source = next.findIndex(item => item.hash === from);
    const target = next.findIndex(item => item.hash === to);
    if (source < 0 || target < 0) return;
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    void api.request('/workspaces/order', 'PUT', next.map(item => item.hash)).then(() => backend.refresh()).catch(error => notify(`调整项目顺序失败：${error instanceof Error ? error.message : error}`));
  }
  // Session drag-reorder inside one project. The backend stores the order so the
  // list keeps it after a refresh and for other clients.
  function reorderSessions(workspaceHash: string, from: string, to: string) {
    if (!from || !to || from === to) return;
    const own = sessions.filter(item => item.workspaceHash === workspaceHash && !hiddenSessions.includes(item.id));
    const source = own.findIndex(item => item.id === from);
    const target = own.findIndex(item => item.id === to);
    if (source < 0 || target < 0) return;
    const next = [...own];
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    let index = 0;
    setSessions(current => current.map(item => item.workspaceHash === workspaceHash && !hiddenSessions.includes(item.id) ? next[index++] : item));
    const order = next.map(item => item.name).filter((name): name is string => !!name);
    void api.request(`/sessions/order?workspaceHash=${encodeURIComponent(workspaceHash)}`, 'PUT', order)
      .catch(error => { notify(`调整会话顺序失败：${error instanceof Error ? error.message : error}`); void backend.refresh(); });
  }
  function projectMaintained(kind: 'refresh' | 'clear-all' | 'clear-old' | 'delete', item: Workspace, deletedSessionNames: string[] = []) {
    const activeSessionName = activeId?.startsWith(`${item.hash}/`) ? activeId.slice(item.hash.length + 1) : '';
    if (kind === 'clear-all' || kind === 'delete' || (activeSessionName && deletedSessionNames.includes(activeSessionName))) setActiveId(null);
    if (kind === 'delete' && workspace === item.hash) setWorkspace(workspaces.find(entry => entry.hash !== item.hash)?.hash || '');
  }
  function initPet() {
    // Legacy ran `npx petdex install boba` in a fresh session automatically.
    // Keep the install explicit: the user confirms the command in the composer.
    newSession(workspace || workspaces[0]?.hash || '');
    setDraft('调用 npx petdex@latest install boba 初始化一个宠物');
    notify('已新建会话，确认后发送即可初始化宠物');
  }
  function openTerminal() { setTerminal(true); setMenu(null); }
  async function openWorkspace(application = preferences.openWith) {
    setMenu(null);
    try { await launchWorkspace(api, currentWorkspace?.hash || '', application); }
    catch (error) { notify(`打开失败：${error instanceof Error ? error.message : error}`); }
  }
  function copyPath() { void navigator.clipboard?.writeText(currentWorkspace?.path || ''); setMenu(null); notify('已复制工作区路径'); }
  async function stopGeneration() {
    const request = activeRequest.current; if (!request) return;
    if (request.stopPromise) return request.stopPromise;
    request.stopping = true;
    request.stopPromise = api.request('/chat/abort', 'POST', { requestId: request.requestId, workspaceHash: request.session?.workspaceHash || workspace, sessionName: request.session?.name })
      .then(() => { request.controller.abort(); })
      .catch(error => { request.stopping = false; request.stopPromise = undefined; notify(`停止失败：${error instanceof Error ? error.message : error}`); });
    await request.stopPromise;
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
      const permissions = running ? await api.request<StreamEvent[]>(`/chat/permissions?${sessionQuery(target)}`, 'GET', undefined, controller.signal) : [];
      const inputs = running ? await api.request<ElicitationRequest[]>(`/chat/elicitations?${sessionQuery(target)}`, 'GET', undefined, controller.signal) : [];
      if (!controller.signal.aborted) setPendingInputs(current => ({ ...current, [target.id]: inputs }));
      if (!controller.signal.aborted && (history.length || permissions.length)) setSessions(current => current.map(item => {
        if (item.id !== target.id) return item;
        const messages = historyMessages(history);
        for (const permission of permissions) {
          const last = messages.at(-1);
          if (!last || last.role !== 'assistant') messages.push({ id: `permission-${permission.permissionRequestId}`, role: 'assistant', text: '', blocks: [] });
          messages[messages.length - 1] = applyEvent(messages[messages.length - 1], { ...permission, type: 'choice' });
        }
        return { ...item, messages };
      }));
    }
    if (observe.running && !running) {
      notifyWorkspaceChanged(target.workspaceHash);
      if (queuedRef.current[target.id]?.length) void sendQueuedMessage(target.id);
    }
    observe.running = running;
  }
  async function stopRemoteRun() {
    if (!session || !remoteRun) return;
    try { await api.request('/chat/abort', 'POST', { requestId: remoteRun.requestId || undefined, workspaceHash: session.workspaceHash, sessionName: session.name }); notify('已请求停止后台任务'); }
    catch (error) { notify(`停止失败：${error instanceof Error ? error.message : error}`); }
  }
  // Legacy `openStoredDiff`: a message's file list carries the diff saved with
  // that turn, so show it directly instead of re-reading the live working tree.
  function openDiff(path: string, storedDiff?: string) { openFile({ path, mode: 'diff', diff: storedDiff }); }
  function addFileContext(path: string, selection?: string) {
    selectMainTab(null);
    setComposerContext(current => ({ ...current, files: [...new Set([...current.files, path])] }));
    if (selection) setDraft(current => `${current}${current ? '\n\n' : ''}来自 ${path}：\n${selection}`);
    notify('已加入消息上下文'); requestAnimationFrame(() => textarea.current?.focus());
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
  // Answering a pending choice auto-sends silently: normal choices (HITL 同意/拒绝
  // and ask_choice) go out as control messages — no user bubble — while sub-agent
  // approvals post to their own endpoint. Each answer resumes the suspended turn
  // in place (same bubble, one running timer); the final reload only reconciles it.
  function submitChoices(answers: ChoiceAnswer[]) {
    if (!session) return;
    const key = session.id;
    setSessions(current => current.map(item => item.id === key ? { ...item, messages: item.messages.map(message => message.blocks ? { ...message, blocks: answers.reduce((blocks, answer) => resolveChoiceBlock(blocks, answer.id, answer.label), message.blocks) } : message) } : item));
    const outgoing: string[] = [];
    for (const answer of answers) {
      if (answer.permissionRequestId) void api.request('/chat/permission', 'POST', { workspaceHash: session.workspaceHash, sessionName: session.name, permissionRequestId: answer.permissionRequestId, optionId: answer.value }).catch(error => {
        setSessions(current => current.map(item => item.id === key ? { ...item, messages: item.messages.map(message => ({ ...message, blocks: message.blocks?.map(block => block.id === answer.id && block.type === 'choice' ? { ...block, selected: undefined } : block) })) } : item));
        notify(error instanceof Error ? error.message : '审批失败');
      });
      else if (answer.subId) void api.request(`/chat/sub-hitl/${encodeURIComponent(answer.subId)}`, 'POST', { action: answer.value === '/agree' || answer.value === 'approve' ? 'approve' : 'deny' }).then(() => notify('子代理审批已发送')).catch(error => notify(error instanceof Error ? error.message : '审批失败'));
      else if (answer.value) outgoing.push(answer.value);
    }
    if (!outgoing.length) return;
    void (async () => { for (const value of outgoing) await sendMessage(value, undefined, undefined, false, true); })();
  }
  async function answerElicitation(request: ElicitationRequest, action: 'accept' | 'decline', content: Record<string, unknown>) {
    if (!session) return;
    const target = session;
    await api.request('/chat/elicitation', 'POST', { workspaceHash: target.workspaceHash, sessionName: target.name,
      elicitationRequestId: request.elicitationRequestId, action, content });
    setPendingInputs(current => ({ ...current, [target.id]: (current[target.id] || []).filter(input => input.elicitationRequestId !== request.elicitationRequestId) }));
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
    if (sendingQueued.current.has(key) || activeRequest.current || remoteRunRef.current === key) return;
    const target = sessionsRef.current.find(item => item.id === key);
    if (!target || !nextQueued(queuedRef.current, key)) return;
    sendingQueued.current.add(key);
    let sent = false;
    try {
      // An abort response only acknowledges cancellation. Wait for the backend
      // task to leave its finally blocks before submitting the next turn.
      const deadline = Date.now() + 10000;
      while (true) {
        const status = await api.request<{ running: boolean }>(`/agent/session-status?${sessionQuery(target)}`);
        if (!status.running) break;
        if (Date.now() >= deadline) throw new Error('上一条回复仍在停止，消息已保留在队列中');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (activeRequest.current) return;
      const next = nextQueued(queuedRef.current, key);
      if (!next) return;
      // Resolve the latest sender, and pass the queue's owner explicitly: the
      // old stream callback may have captured Home or another selected session.
      sent = await sendMessageRef.current(next.text, next.context, undefined, false, false, target, next.id);
    } catch (error) { notify(error instanceof Error ? error.message : '队列发送失败'); }
    finally {
      sendingQueued.current.delete(key);
      if (sent && !activeRequest.current && queuedRef.current[key]?.length) void sendQueuedMessage(key);
    }
  }
  function guideQueuedMessage(id: string) {
    if (!session) return;
    const key = session.id;
    replaceQueue(promoteQueued(queuedRef.current, key, id));
    if (activeRequest.current?.session?.id === key) void stopGeneration();
    else if (remoteRunRef.current === key) void stopRemoteRun();
    else void sendQueuedMessage(key);
  }

  async function sendMessage(override?: string, overrideContext?: ComposerContext, action?: string, fresh = false, autoAnswer = false, queuedSession?: Session, queuedMessageId?: string): Promise<boolean> {
    if (!queuedSession && composerConfigBusy) return false;
    const sendSession = queuedSession || session;
    const sendWorkspace = queuedSession ? workspaces.find(item => item.hash === queuedSession.workspaceHash) : currentWorkspace;
    const sendAgentId = queuedSession ? queuedSession.agentId || 'native' : agentId;
    if (activeRequest.current || remoteRunRef.current === (sendSession?.id ?? '')) { if (override === undefined && !action) queueMessage(); return false; }
    if (override === undefined && !action && !draft.trim() && !composerContext.files.length) return false;
    if (backend.status !== 'connected' || !backend.ready || !sendWorkspace) { notify('请先连接 Loopra 并选择工作区'); return false; }
    let prompt = (override ?? draft.trim()) || (action ? '' : '请查看附件');
    const titleSource = prompt;
    // Oversized directly-typed bodies are saved into the project and replaced by
    // a reference block before sending, matching legacy ChatInput.vue. The paste
    // handler already externalizes clipboard text; this covers typed/edited text.
    let savedInput: string | undefined;
    if (!action && sendWorkspace && prompt.length > LARGE_PASTE_THRESHOLD_CHARS) {
      try {
        const saved = await api.request<{ path: string; chars?: number }>('/files/paste', 'POST', { workspaceHash: sendWorkspace.hash, content: prompt });
        if (!saved?.path) throw new Error('服务端未返回文件路径');
        savedInput = largeInputReference(saved.path, Number(saved.chars) || prompt.length);
        prompt = '';
      } catch (error) {
        notify(`大段输入内容保存失败：${error instanceof Error ? error.message : String(error)}，本次未发送`);
        return false;
      }
    }
    if (activeRequest.current) return false;
    if (preferences.sound) prepareCompletionSound();
    const context = { ...(overrideContext || composerContext) };
    const text = action ? prompt : composeOutgoing(prompt, context, savedInput);
    const controller = new AbortController(); const requestId = crypto.randomUUID();
    activeRequest.current = { controller, requestId, session: sendSession };
    const request = activeRequest.current;
    if (queuedSession && queuedMessageId) replaceQueue(removeQueued(queuedRef.current, queuedSession.id, queuedMessageId));
    setGeneratingId(sendSession?.id || 'creating');
    setLiveSpeed(undefined);
    // A fresh send ignores the selected session so the prompt opens a new one.
    let target = fresh ? undefined : sendSession;
    // An auto-answered choice resumes the suspended assistant turn in place:
    // reusing its id lands the resumed stream in the same bubble, so approving
    // adds no second turn, bubble or timer and reads exactly like a plain run.
    const source = sessionsRef.current.find(item => item.id === sendSession?.id) || sendSession;
    const resumed = autoAnswer ? source?.messages.filter(entry => entry.role === 'assistant').at(-1) : undefined;
    const answerId = resumed?.id || crypto.randomUUID();
    const now = Date.now();
    const time = new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    // Legacy Chat.vue attached the outgoing images to the local user bubble so
    // they render before any history reload (which may be skipped on a choice).
    const message = { id: crypto.randomUUID(), role: 'user' as const, text, time, images: (context.attachments || []).flatMap(file => file.image ? [file.image] : []) };
    // Structured actions (execute_plan) and automatic choice answers run without a
    // user bubble — an answer is a control reply, not something the user typed.
    const silent = !!action || autoAnswer;
    let completed = false;
    let agentStopReason: string | undefined;
    const assistant: Message = { id: answerId, role: 'assistant', text: '', time, startedAt: now, blocks: [] };
    let petAnswer = assistant;
    try {
      if (!target) {
        // Reuse the draft prepared for the home composer so its Agent choices
        // (model, permission mode, effort…) survive into the first real turn.
        const prepared = preparedNewSession.current;
        if (prepared?.key === agentConfigKey) {
          // Seeding may still be writing the last new-conversation choices; wait
          // so the first turn never starts on the Agent's factory defaults.
          await newConfigSeed.current?.catch(() => {});
          const draft = newAgentConfigRef.current;
          target = { ...prepared.target, title: titleSource.slice(0, 60) };
          const options = draft?.key === agentConfigKey ? draft.options : undefined;
          if (options) {
            setAgentConfigs(current => ({ ...current, [target!.id]: options }));
            cacheAgentConfig(target!.agentId || agentId, options);
            // Freeze the draft's final choices for the next new conversation.
            rememberNewConfig(target!.agentId || agentId, options);
            seededConfigAt.current[target!.id] = Date.now();
          }
          preparedNewSession.current = null;
          storeNewAgentConfig(null);
        } else {
          const created = await api.request<{ sessionName: string }>(`/sessions/new?workspaceHash=${encodeURIComponent(workspace)}`, 'POST', undefined, controller.signal);
          target = remoteSession({ name: created.sessionName, title: titleSource.slice(0, 60), messageCount: 0, mtime: now, agentId }, sendWorkspace);
        }
        activeRequest.current!.session = target;
        await api.request(sessionRoute(target, '/title'), 'PUT', { title: target.title }, controller.signal);
        // The server lists newest first; mirror that optimistically instead of appending.
        setSessions(current => [target!, ...current]); setActiveId(target.id);
      }
      const id = target.id; setGeneratingId(id);
      // Approving a plan (execute_plan) must not re-enter plan mode; the agent clears it while executing.
      // A continued turn already owns its bubble: reopen it (so its timer ticks
      // again) instead of inserting a second one.
      if (resumed) setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? { ...entry, finishedAt: undefined } : entry) } : item));
      else setSessions(current => current.map(item => item.id === id ? { ...item, messages: silent ? [...item.messages, assistant] : [...item.messages, message, assistant] } : item));
      if (!autoAnswer && !queuedSession) { setDraft(''); setComposerContext(emptyContext); setMenu(null); }
      // A new prompt always returns to the newest message (legacy scroll(true)).
      userScrolledAway.current = false;
      const scroller = scrollArea.current;
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
      setShowScrollBtn(false);
      const attachments = context.attachments || [];
      const documentText = attachments.filter(file => file.text !== undefined).map(file => `附件：${file.name}\n${file.text}`).join('\n\n');
      await api.stream({ message: [text, documentText].filter(Boolean).join('\n\n'), requestId, workspaceHash: target.workspaceHash!, sessionName: target.name!, agentId: sendAgentId, images: attachments.flatMap(file => file.image ? [file.image] : []), linkedProjectHashes: workspaces.filter(project => context.projects.includes(project.name)).map(project => project.hash), ...(action ? { action } : {}) }, event => {
        if (event.type === 'complete') agentStopReason = event.stopReason;
        if (event.type === 'config_options' && event.configOptions) { setAgentConfigs(current => ({ ...current, [id]: event.configOptions! })); return; }
        if (event.type === 'elicitation' && event.elicitationRequestId && event.schema) {
          const input: ElicitationRequest = { elicitationRequestId: event.elicitationRequestId, message: event.message || '请回答以下问题', schema: event.schema };
          setPendingInputs(current => ({ ...current, [id]: [...(current[id] || []).filter(item => item.elicitationRequestId !== input.elicitationRequestId), input] }));
          return;
        }
        if (event.type === 'elicitation_resolved') {
          setPendingInputs(current => ({ ...current, [id]: (current[id] || []).filter(input => input.elicitationRequestId !== event.elicitationRequestId) })); return;
        }
        if (event.type === 'acp_plan') { setAcpPlans(current => ({ ...current, [id]: event.entries || [] })); return; }
        if (event.type === 'acp_commands') { setAcpCommands(current => ({ ...current, [id]: event.commands || [] })); return; }
        if (event.type === 'plan_submitted') { setPendingPlan(event.plan || undefined); setComposerOptions(current => ({ ...current, plan: true })); return; }
        if (event.type === 'mode_changed') { setComposerOptions(current => ({ ...current, plan: event.mode === 'plan' })); if (event.mode !== 'plan') setPendingPlan(undefined); return; }
        if (event.type === 'snapshot' && event.msgId) setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === message.id ? { ...entry, rollbackId: event.msgId, ...(event.hasCodeSnapshot ? { snapshotId: event.msgId } : {}) } : entry) } : item));
        if (event.type === 'token_speed') { setLiveSpeed({ tokensPerSecond: event.tokensPerSecond, avgTokensPerSecond: event.avgTokensPerSecond, done: !!event.done, completionTokens: event.completionTokens }); return; }
        // Legacy `log` events only surface as floating INFO/WARN/ERROR bars.
        if (event.type === 'log') { chatLogs.push({ level: event.level, message: event.message, content: event.content }); return; }
        // Legacy Chat.vue opened the right panel's command tab when the agent
        // started a background shell, so the running process is visible.
        if ((event.type === 'tool_call' || event.type === 'sub_tool_call') && event.name === 'bash_start') window.dispatchEvent(new CustomEvent('loopra:bash-start'));
        // Every sub-agent run gets its own tab next to the conversation and files.
        // Opening it without selecting keeps the answer the user is watching in view.
        if (event.type === 'sub_start' && event.subSessionId && target?.name) {
          const label = event.name && event.title ? `${event.name}：${event.title}` : event.name || event.title || event.task || '子代理';
          setWorkspaceEditors(current => ({ ...current, [editorKey]: ensureSubAgentTab(current[editorKey] || emptyWorkspaceTabs,
            { subSessionId: event.subSessionId!, sessionName: target!.name!, label }) }));
        }
        petAnswer = applyEvent(petAnswer, event);
        setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? applyEvent(entry, event) : entry) } : item));
      }, controller.signal);
      completed = true;
      const preview = petReplyPreview(petAnswer);
      if (preview) setPetReply({ id: answerId, text: preview });
      const stopped = acpStopMessage(agentStopReason);
      if (stopped || preferences.notifications) notify(stopped || '回复已完成');
      if (!stopped && preferences.sound) playCompletionSound();
    } catch (error) {
      const content = controller.signal.aborted || activeRequest.current?.stopping ? '> 本次回复已停止。' : `> 请求失败：${error instanceof Error ? error.message : error}`;
      setPetReply({ id: answerId, text: content.replace(/^> /, ''), activity: controller.signal.aborted || activeRequest.current?.stopping ? 'idle' : 'failed' });
      setSessions(current => current.map(item => item.id === target?.id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? applyEvent(entry, { type: 'content', content: `\n\n${content}` }) : entry) } : item));
      notify(content.replace(/^> /, ''));
    } finally {
      // Do not let a late abort handler cancel the queued replacement turn.
      await request.stopPromise;
      if (target) {
        const id = target.id;
        setPendingInputs(current => ({ ...current, [id]: [] }));
        notifyWorkspaceChanged(target.workspaceHash);
        setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? { ...entry, finishedAt: Date.now() } : entry) } : item));
        try {
          const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(target)}`);
          // The reload is authoritative: the server folds the whole approval loop
          // (prompt → approve ×N) into one assistant turn and never stores the
          // "/agree" command, so this drops the extra bubbles and merges the AI
          // replies for free. A suspended choice is client-only, so reattach it.
          if (completed && !controller.signal.aborted && history.length) {
            const messages = attachPendingChoices(historyMessages(history), unresolvedChoices(petAnswer.blocks).filter(choice => !choice.permissionRequestId));
            setSessions(current => current.map(item => item.id === id ? { ...item, messages } : item));
          }
        } catch { /* Keep the already received stream if history reload fails. */ }
        if (action === 'execute_plan') { try { const mode = await api.request<{ mode: string; pendingPlan?: string | null }>(`/agent/mode?${sessionQuery(target)}`, 'GET'); setComposerOptions(current => ({ ...current, plan: mode.mode === 'plan' })); setPendingPlan(mode.pendingPlan || undefined); } catch { /* keep the stream-derived state */ } }
      }
      activeRequest.current = undefined; setGeneratingId(null);
      setLiveSpeed(current => current && !current.done ? { ...current, done: true, avgTokensPerSecond: current.avgTokensPerSecond ?? current.tokensPerSecond } : current);
      if (target && queuedRef.current[target.id]?.length) void sendQueuedMessage(target.id);
    }
    return true;
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
    // model/effort belong to the *session*: the picker writes them to that session's settings
    // and selectSession loads them back. Re-deriving them from the global config here (which
    // the picker never updates) silently undid the user's pick on every backend.refresh(),
    // which is triggered by ordinary things like refreshing projects or opening the session
    // manager. Keep them seeded from the config only when no session owns them yet — that is
    // the only place the configured default reaches an empty composer.
    setComposerOptions(current => session
      ? { ...current, mode: permissionLabel(config.hitl), fast: config.fastMode }
      : { ...current, modelId, effort: config.reasoningEffort || 'max', mode: permissionLabel(config.hitl), fast: config.fastMode });
    setAgentSettings(current => ({ ...current, serverUrl: server, projectPath: config.workspace, defaultWorkspace: backend.workspaces.find(item => item.path === config.workspace)?.name || backend.workspaces[0]?.name || '', tools: backend.tools, skills: backend.skills, systemPrompt: backend.prompt, validatorModel: config.validationModel ? `${config.validationModelChannelId}:${config.validationModel}` : '', imageModel: config.imageUnderstandingModel ? `${config.imageUnderstandingModelChannelId}:${config.imageUnderstandingModel}` : '' }));
    setWorkspace(current => backend.workspaces.some(item => item.hash === current) ? current : backend.workspaces.find(item => item.path === config.workspace)?.hash || backend.workspaces[0]?.hash || '');
  }, [backend.config, backend.tools, backend.skills, backend.prompt, backend.workspaces, server, session?.id]);
  // The host is what actually launches these, and only it knows what exists there (Git Bash is
  // Windows-only, PowerShell needs pwsh installed), so ask it instead of offering a fixed list.
  const refreshApplications = useCallback(() => {
    void fetchAvailableApplications(api).then(ids => setAvailableApplications(ids));
  }, [api]);
  useEffect(() => { if (backend.status === 'connected') refreshApplications(); }, [backend.status, refreshApplications]);
  // Ask again whenever the menu opens. The first attempt can land while the service is restarting,
  // or against a service too old to have the inventory, and that answer must not stick for the
  // whole session — otherwise the menu keeps offering launchers the host cannot run.
  useEffect(() => { if (menu === 'folder') refreshApplications(); }, [menu, refreshApplications]);
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
      if (event.key === 'Escape') { setMenu(null); if (!event.defaultPrevented && !(event.target as HTMLElement).closest('[role="dialog"]')) { setChanges(false); if (narrow) setSidebar(false); } return; }
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); setMenu(null); }
        if (event.key.toLowerCase() === 'n') { event.preventDefault(); newSession(); }
        if (event.key.toLowerCase() === 'b') { event.preventDefault(); setSidebar(value => !value); }
        if (event.key === ',') { event.preventDefault(); openSettings(); }
      }
    }
    document.addEventListener('pointerdown', onPointer); window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey); };
  });
  useEffect(() => () => { activeRequest.current?.controller.abort(); historyRequest.current?.abort(); clearTimeout(toastTimer.current); }, []);

  const activeInput = session ? pendingInputs[session.id]?.[0] : undefined;
  const composer = <BackgroundTasks key={workspace} api={api} workspaceHash={workspace} connected={backend.status === 'connected' && backend.ready} open={terminal} onOpenChange={setTerminal} notify={notify} toolbarTarget={isHome ? homeTaskToolbar : null} actions={!isHome && session ? <SessionProgress api={api} session={session} revision={progressRevision} externalPlan={generatingId === session.id ? acpPlans[session.id] : undefined} /> : undefined}><Composer home={isHome} language={preferences.language} draft={draft} onDraft={setDraft} inputRef={textarea}
    agentConfig={{ options: session ? agentConfigs[session.id] : newAgentConfig?.key === agentConfigKey ? newAgentConfig.options : agentConfigCache[newConfigKey(agentId)], busy: composerConfigBusy, error: agentConfigError, onPrepare: retryAgentConfig, onChange: (id, value) => void changeAgentConfig(id, value) }}
    agentId={agentId} engines={engines} acpCommands={session ? acpCommands[session.id] : undefined}
    options={composerOptions} onOptions={saveOptions} context={composerContext} onContext={setComposerContext}
    providers={providers} api={api} workspaceHash={workspace} sessionName={session?.name || (externalAgent && preparedNewSession.current?.key === agentConfigKey ? preparedNewSession.current.target.name : undefined)} workspaces={workspaces} connected={backend.status === 'connected'} skillOptions={agentSettings.skills.filter(skill => skill.enabled)} systemPrompt={agentSettings.systemPrompt} petEnabled={agentSettings.petEnabled && !changes && !settingsOpen && !searchOpen && !helpOpen && !sessionsOpen && !requirementsOpen} pets={pets} petReply={petReply} latestPetReply={petReplyPreview(session?.messages.filter(message => message.role === 'assistant').at(-1))} onPetClose={() => setAgentSettings(current => ({ ...current, petEnabled: false }))} petActivity={petActivity(!!generatingId && generatingId === activeId, session?.messages.at(-1)?.blocks)} defaultModel={defaultModel} onDefaultModel={saveDefaultModel}
    history={session ? getSessionMessages(session).map(message => message.text) : []}
    busy={!!generatingId || backend.status !== 'connected' || !backend.ready} generating={!!generatingId && generatingId === activeId}
    // Legacy `continueChat` sent the literal `/continue` command so the backend
    // resumes from the existing context (and approves pending HITL) without
    // appending a user message.
    onSend={() => sendMessage()} onStop={stopGeneration} onContinue={() => sendMessage(externalAgent ? '请继续完成刚才的任务。' : '/continue')}
    onNew={() => newSession()} onClear={() => clearChat()} onTerminal={() => openTerminal()} onManage={() => openSettings('模型供应商')}
    onExport={() => { if (!session) { notify('请先开始一个会话'); return; } downloadText(`chat-${new Date().toISOString().slice(0, 10)}.txt`, chatExportText(getSessionMessages(session))); notify('对话已导出'); }}
    onSessions={() => setSessionsOpen(true)}
    queue={session ? (queuedMessages[session.id] || []) : []} onRemoveQueued={removeQueuedMessage} onGuideQueued={guideQueuedMessage}
    remoteRunning={!!session && remoteRun?.id === session.id} onStopRemote={stopRemoteRun}
    liveSpeed={liveSpeed}
    onOpen={() => { setMenu(null); setTerminal(false); }} notify={notify} /></BackgroundTasks>;

  // The window controls float over the first row (sidebar brand and conversation
  // header), so the shell has no empty title-bar strip of its own.
  const desktopShell = isDesktopWindow();
  const nativeWindowControls = desktopShell && usesNativeWindowControls(desktopPlatform());
  return <AppMotion enabled={preferences.animations}><div className={`desktop-app${desktopShell ? ' is-desktop-shell' : ''}${nativeWindowControls ? ' is-native-controls' : ''}`} data-sidebar={sidebar ? 'open' : 'closed'} data-panel={changes ? 'open' : 'closed'}>
    {desktopShell && <DesktopTitleBar />}
    <div className="app-body">
      {narrow && <button className="sidebar-backdrop" data-open={sidebar} aria-label="关闭侧边栏遮罩" onClick={() => setSidebar(false)} />}
      {sidebarMounted && <Sidebar open={sidebar} english={preferences.language === 'English'} workspaces={workspaces} sessions={visibleSessions} activeId={activeId ?? ''} workspace={workspace} isHome={isHome} collapsed={collapsed} onCollapsed={setCollapsed}
        onClose={() => setSidebar(false)} onNewSession={hash => newSession(hash)} onSearch={() => { setSearchOpen(true); setMenu(null); }} onSettings={() => openSettings()}
        onRefreshAll={() => void backend.refresh()} onRefreshProject={hash => void refreshProject(hash)} onRefreshSession={entry => void refreshSessionChat(entry)} onManageProject={setProjectDialog}
        onSelectSession={selectSession} onDeleteSession={setDeleteSession} onReorder={reorderWorkspaces} onReorderSessions={reorderSessions} />}
      <main className={`main-area ${changes ? 'has-changes' : ''}`}>
        <Header sidebarOpen={sidebar} onOpenSidebar={() => setSidebar(true)} isHome={isHome} workspaceName={workspaceName} session={session} menu={menu} onToggleMenu={toggleMenu}
          backend={{ status: backend.status, ready: backend.ready, error: backend.error, version: backend.version }} server={server} onStatus={() => openSettings('服务器')}
          latestVersion={backend.updateCheck?.hasNewVersion ? backend.updateCheck.latestVersion : undefined} onVersion={openCoreUpdate}
          gitBranch={gitBranch} changesOpen={changes} onToggleChanges={() => setChanges(!changes)} onShowChanges={() => { setChanges(true); setMenu(null); }}
          applications={visibleApplications(availableApplications)} onOpenWorkspace={application => void openWorkspace(application)} onCopyPath={copyPath}
          onRename={() => { if (!session) return; setRename(session.id); setRenameValue(session.title); setMenu(null); }}
          onRecords={() => { setSessionDetailsTab('events'); setSessionDetails(true); setMenu(null); }}
          onClear={() => { setMenu(null); clearChat(); }}
          onExport={() => { if (!session) return; setMenu(null); downloadText(`chat-${new Date().toISOString().slice(0, 10)}.txt`, chatExportText(getSessionMessages(session))); notify('对话已导出'); }}
          onHide={archiveSession} onDelete={() => { if (!session) return; setDeleteSession(session); setMenu(null); }}
          onCopyTitle={() => { if (!session) return; void navigator.clipboard?.writeText(session.title); setMenu(null); notify('已复制会话标题'); }} />
        <WorkspaceTabs key={editorKey} api={api} workspaceHash={workspace} state={editorTabs} onSelect={selectMainTab} onClose={closeFile} onOpen={openFile} onAdd={addFileContext} notify={notify} onCloseSubAgent={closeSubAgent}><div className={`main-content ${isHome ? 'home-content' : ''}`}>{(!!generatingId || (!!session && remoteRun?.id === session.id)) && <div className="streaming-bar" role="status" aria-label="会话正在执行"><div className="streaming-bar-inner" /></div>}
          <ChatLogs logs={chatLogs.logs} onDismiss={chatLogs.dismiss} onCopy={text => { void navigator.clipboard?.writeText(text).then(() => chatLogs.push({ text: '✅ 日志已复制' })).catch(() => chatLogs.push({ level: 'ERROR', message: '复制失败，请手动选择日志' })); }} />
          {backend.status === 'error' && <div className="backend-error" role="alert"><span>无法连接 Loopra：{backend.error}</span><Button size="sm" variant="flat" onPress={() => void backend.refresh()}>重新连接</Button></div>}
          {isHome ? <HomeView workspaces={workspaces} workspace={workspace} workspaceName={workspaceName} menuOpen={menu === 'workspace'} onToggleMenu={() => toggleMenu('workspace')}
            onSelect={hash => { setWorkspace(hash); setMenu(null); }} onManage={() => { setMenu(null); setProjectsOpen(true); }}
            engines={engines} agentId={agentId} agentDisabled={!!generatingId || !!remoteRun} onAgent={switchAgent}
            onTaskToolbarMount={setHomeTaskToolbar}
            onRefreshEngines={() => setEnginesRevision(value => value + 1)}
            isolation={<IsolationSwitch api={api} workspaceHash={workspace} disabled={!!generatingId || !!remoteRun} notify={notify}
              sessionName={preparedNewSession.current?.key === agentConfigKey ? preparedNewSession.current.target.name : undefined} />}>{composer}</HomeView> : <>
            <div className="chat-scroll" ref={scrollArea} onScroll={onChatScroll}><div className="chat-content"><Enter key={session.id}><Messages session={session} loading={generatingId === activeId} scrollRef={scrollArea} offsetsRef={messageOffsets} busy={!!generatingId || backend.status !== 'connected' || !backend.ready} notify={notify} onOpenFile={path => openFile({ path, mode: 'content' })} onDiff={openDiff} onRevert={revertChanges} onEdit={fillDraft} onBranch={branchSession} onRollback={message => { setRollbackMessage(message); setRollbackCode(false); }} onRawEvents={() => { setSessionDetailsTab('events'); setSessionDetails(true); }} /></Enter></div></div>
            <ChatDock items={userMessageDock(getSessionMessages(session))} showScrollButton={showScrollBtn} hasMessages={getSessionMessages(session).length > 0} onJump={jumpToMessage} onScrollBottom={scrollToBottom} onCollapseAll={collapseAllBlocks} />
            <div className="chat-composer-area">{!externalAgent && composerOptions.plan && <PlanReview pendingPlan={pendingPlan} busy={!!generatingId || planBusy} onApprove={() => void approvePlan()} onExit={() => setDiscardPlan(true)} notify={notify} />}{pendingChoices.length > 0 && <ChoicePopup key={pendingChoices.map(choice => choice.id).join('|')} choices={pendingChoices} onSubmit={submitChoices} />}{activeInput && pendingChoices.length === 0 && <ElicitationForm key={activeInput.elicitationRequestId} request={activeInput} onAnswer={(action, content) => answerElicitation(activeInput, action, content)} />}{composer}</div>
          </>}
        </div></WorkspaceTabs>
      </main>
      {changesMounted && <button className="workbench-backdrop" data-open={changes} aria-label="关闭工作区面板遮罩" onClick={() => setChanges(false)} />}
      {changesMounted && <ChangesPanel open={changes} api={api} workspaceHash={workspace} key={workspace} onOpenFile={openFile} onPathChange={changeFilePath} activeFile={editorTabs.active} sessionName={session?.name || (isHome ? preparedNewSession.current?.target.name : undefined)} sessions={sessions} onAdd={addFileContext} onClose={() => setChanges(false)} notify={notify} onOpenSubAgent={item => showSubAgent(item)} />}
    </div>
    {sessionDetails && session && <SessionDetails api={api} session={session} initialTab={sessionDetailsTab} onClose={() => setSessionDetails(false)} notify={notify} />}
    {deleteSession && <ConfirmAction title="删除会话" onClose={() => setDeleteSession(undefined)} action={() => removeSession(deleteSession)}><p>删除 {deleteSession.title} 及其在 Loopra 服务端的记录？此操作不可恢复。</p></ConfirmAction>}
    {projectDialog && <ProjectSessions api={api} workspace={projectDialog} count={sessions.filter(item => item.workspaceHash === projectDialog.hash).length} sessions={sessions.filter(item => item.workspaceHash === projectDialog.hash)} onClose={() => setProjectDialog(undefined)} onRefresh={async () => { await backend.refreshWorkspaces(); }} onCompleted={(kind, sessionNames) => projectMaintained(kind, projectDialog, sessionNames)} onRenamed={(previous, renamed) => { setProjectDialog(renamed); setComposerContext(current => ({ ...current, projects: current.projects.map(name => name === previous.name ? renamed.name : name) })); }} notify={notify} />}
    {projectsOpen && <ProjectManager api={api} workspaces={workspaces} sessions={sessions} current={workspace} onClose={() => setProjectsOpen(false)} onRefresh={backend.refreshWorkspaces} onAdded={item => { setCollapsed(previous => previous.filter(hash => hash !== item.hash)); newSession(item.hash); }} onDeleted={item => projectMaintained('delete', item)} notify={notify} />}
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
    <Settings
      onOpenSessions={() => { setSettingsOpen(false); openSessionsManager(); }}
      onOpenRequirements={() => { setSettingsOpen(false); setRequirementsOpen(true); }}
      onOpenHelp={() => { setSettingsOpen(false); setHelpOpen(true); }}
      pets={pets}
      onInitPet={initPet}
      updateCheck={backend.updateCheck}
      coreUpdate={coreUpdate}
      onRefresh={() => backend.refresh()}
      workspaces={workspaces}
      server={server}
      availableApplications={availableApplications}
      config={agentSettings}
      onConfig={saveAgentSettings}
      options={composerOptions}
      onOptions={saveOptions}
      defaultModel={defaultModel}
      onDefaultModel={saveDefaultModel}
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      initialTab={settingsTab}
      preferences={preferences}
      onPreferences={setPreferences}
      providers={providers}
      onProviders={saveProviders}
      sessions={sessions.map(item => ({ ...item, archived: hiddenSessions.includes(item.id) }))}
      onRestore={id => { setHiddenSessions(current => current.filter(item => item !== id)); notify('会话已恢复'); }}
      notify={notify}
    />
    <CoreServiceUpdateDialog controller={coreUpdate} notify={notify} />
    <Modal isOpen={!!rename} onClose={() => setRename(null)} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog rename-modal', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label="重命名会话"><ModalContent><form className="app-dialog-form" onSubmit={event => { event.preventDefault(); void renameSession(); }}><ModalHeader className="app-dialog-header"><h2>重命名会话</h2></ModalHeader><ModalBody className="app-dialog-body"><Input autoFocus aria-label="会话名称" value={renameValue} onValueChange={setRenameValue} variant="bordered" /></ModalBody><ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" onPress={() => setRename(null)}>取消</Button><Button size="sm" type="submit" color="primary" isDisabled={!renameValue.trim()}>保存</Button></ModalFooter></form></ModalContent></Modal>
    <Toast message={toast}><Check size="1rem" />{toast}</Toast>
  </div></AppMotion>;
}

