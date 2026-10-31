import { ToolImageSourceProvider } from './components/ToolImageResult';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { Check } from 'lucide-react';
import { applyDocumentTheme, bootTheme } from './document-theme';
import { getSessionMessages, useLocalState } from './lib';
import { useSessionPanel } from './useSessionPanel';
import type { Provider, Session } from './lib';
import Sidebar from './layout/Sidebar';
import ProfileEditor from './components/LocalProfile';
import { normalizeProfile, useLocalProfile } from './local-profile';
import Header from './layout/Header';
import HomeView from './layout/HomeView';
import IsolationSwitch from './layout/IsolationSwitch';
import ChatDock from './layout/ChatDock';
import { Messages } from './components/Conversation';
import SessionHistoryState from './components/SessionHistoryState';
import ChangesPanel from './components/Panels';
import BackgroundTasks from './components/BackgroundTasks';
import Settings, { defaultPreferences } from './components/Settings';
import SkillsAndPluginsPage from './components/SkillsAndPluginsPage';
import { capabilitiesTabForSection, type CapabilitiesTab } from './capabilities-navigation';
import SchedulesPage from './components/SchedulesPage';
import { PluginFrame } from './components/PluginFrame';
import type { PluginIconRef } from './components/plugin-icons';
import { CoreServiceUpdateDialog, useCoreServiceUpdate } from './components/CoreServiceUpdate';
import { DesktopUpdateDialog, useDesktopUpdate } from './components/DesktopUpdate';
import type { Preferences } from './components/Settings';
import { mergeStoredSettings, toStoredSettings, type ClientSettings, type StoredUIPreferences } from './ui-preferences';
import Search from './components/Search';
import type { FileChange, Message } from './chat';
import { attachPendingChoices, chatNearBottom, chatScrollState, collectPendingChoices, resolveChoiceBlock, unresolvedChoices, userMessageDock } from './chat';
import Composer from './components/Composer';
import SessionOccupiedNotice from './components/SessionOccupiedNotice';
import type { AcpCommand, AcpPlanEntry, AgentEngine } from './backend';
import type { AgentConfigOption } from './agent-config';
import { defaultAgentSettings, type AgentSettings } from './settings-data';
import { composeOutgoing, defaultOptions, emptyContext, getModelCatalog, largeInputReference, withoutWorkspaceContext, type ComposerContext, type ComposerOptions, type QueuedMessage } from './composer';
import { LARGE_PASTE_THRESHOLD_CHARS } from './documents';
import { enqueue, moveQueued, nextQueued, promoteQueued, removeQueued, restoreQueuedDraft, type MessageQueue } from './message-queue';
import { acpStopMessage, applyEvent, CHAT_WORKSPACE, DEFAULT_SERVER, historyMessages, isChatWorkspace, isSessionOccupiedError, permissionLabel, permissionValue, providerChannels, remoteSession, serverAddress, sessionQuery, sessionRoute, type HistoryMessage, type RemoteSession, type StreamEvent, type Workspace } from './backend';
import useLoopra from './useLoopra';
import { AppMotion, Enter, Toast, usePresence } from './components/Motion';
import { prepareCompletionSound, playCompletionSound } from './notifications';
import usePets from './usePets';
import { petActivity, petReplyPreview, petScale, type PetReply } from './pets';
import { useNativePet } from './pet-desktop';
import SessionDetails, { SessionProgress } from './components/SessionDetails';
import { ConfirmAction, query } from './components/RemoteControls';
import RollbackMessageDialog from './components/RollbackMessageDialog';
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
import { desktopPlatform, isDesktopWindow, syncDesktopTheme, usesNativeWindowControls } from './desktop-shell';
import { fetchAvailableApplications, launchWorkspace, visibleApplications } from './workspace-launcher';
import { notifyWorkspaceChanged, watchWorkspaceChanges } from './workspace-events';
import WorkspaceTabs from './components/WorkspaceTabs';
import { closeSubAgentTab, closeWorkspaceFile, emptyWorkspaceTabs, ensureSubAgentTab, openWorkspaceFile, updateWorkspaceFilePath, type WorkspaceFile, type WorkspaceTabs as WorkspaceTabsState } from './workspace-tabs';
import { useSubAgentTabs } from './useSubAgentTabs';
import { SessionRuns, sessionRunKey, draftRunKey, isRunView } from './session-runs';
import { orderWithNewSessionFirst } from './session-order';
import { preferredWorkspace, readLastWorkspace, writeLastWorkspace } from './last-workspace';
import { initialOpenWorkspace } from './workspace-open';

export default function App({ startupPending = false, initialServer }: { startupPending?: boolean; initialServer?: string } = {}) {
  const [server, setServer] = useLocalState('backend-server', DEFAULT_SERVER);
  const [appliedInitialServer, setAppliedInitialServer] = useState<string>();
  const backend = useLoopra(server, !startupPending && initialServer === appliedInitialServer);
  useEffect(() => { if (initialServer) { setServer(initialServer); setAppliedInitialServer(initialServer); } }, [initialServer, setServer]);
  const workspaceLoading = startupPending || (backend.status === 'connecting' && !backend.config);
  const { api, sessions, setSessions, providers, workspaces } = backend;
  const pets = usePets(api, backend.status === 'connected');
  const initialTheme = bootTheme();
  const [preferences, setPreferences] = useLocalState<Preferences>('preferences', initialTheme ? { ...defaultPreferences, theme: initialTheme } : defaultPreferences);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const uiPreferenceSave = useRef(0);
  const uiPreferenceDirty = useRef(false);
  const { profile, ready: profileReady, saveProfile: writeProfileLocal } = useLocalProfile();
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const [profileOpen, setProfileOpen] = useState(false);
  const [composerOptions, setComposerOptions] = useLocalState<ComposerOptions>('composer-options', defaultOptions);
  const [defaultModel, setDefaultModel] = useLocalState('default-model', defaultOptions.modelId);
  const [agentSettings, setAgentSettings] = useLocalState<AgentSettings>('agent-settings', defaultAgentSettings);
  const agentSettingsRef = useRef(agentSettings);
  agentSettingsRef.current = agentSettings;
  const [availableApplications, setAvailableApplications] = useState<string[] | null>(null);
  const [petReply, setPetReply] = useState<PetReply | null>(null);
  const [composerContext, setComposerContext] = useState<ComposerContext>(emptyContext);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState(() => readLastWorkspace(localStorage));
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 760);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<string[]>([]);
  const openedSelectedWorkspace = useRef(false);
  useLayoutEffect(() => {
    const next = initialOpenWorkspace(expandedWorkspaces, workspace, workspaces, openedSelectedWorkspace.current);
    openedSelectedWorkspace.current = next.applied;
    if (next.expanded.length !== expandedWorkspaces.length || next.expanded.some((hash, index) => hash !== expandedWorkspaces[index])) setExpandedWorkspaces(next.expanded);
  }, [expandedWorkspaces, workspace, workspaces]);
  // Both sidebars slide both ways, so they stay mounted until their exit slide ends.
  const sidebarMounted = usePresence(sidebar);
  const [sessionDetails, setSessionDetails] = useState(false);
  const [sessionDetailsTab, setSessionDetailsTab] = useState('events');
  const [deleteSession, setDeleteSession] = useState<Session>();
  const [rollbackMessage, setRollbackMessage] = useState<Message>();
  const [pendingPlan, setPendingPlan] = useState<string>();
  const [discardPlan, setDiscardPlan] = useState(false);
  const [planBusyKeys, setPlanBusyKeys] = useState<Set<string>>(() => new Set());
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
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [capabilitiesTab, setCapabilitiesTab] = useState<CapabilitiesTab>('all');
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [pluginPage, setPluginPage] = useState('');
  const [pluginNav, setPluginNav] = useState<{ id: string; title: string; icon?: PluginIconRef }[]>([]);
  const [pluginPanels, setPluginPanels] = useState<{ id: string; title: string; icon?: PluginIconRef }[]>([]);
  const [pluginNavRevision, setPluginNavRevision] = useState(0);
  const [settingsTab, setSettingsTab] = useState('通用');
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { setPluginPanels([]); setPluginNav([]); }, [api]);
  useEffect(() => {
    if (!settingsOpen || backend.status !== 'connected') return;
    const controller = new AbortController();
    void backend.refreshProviders(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [settingsOpen, backend.status, backend.refreshProviders]);
  useEffect(() => {
    if (backend.status !== 'connected') return;
    const controller = new AbortController();
    void api.request<{ id: string; sidebar?: { title?: string; icon?: PluginIconRef }; panel?: { title?: string; icon?: PluginIconRef } }[]>('/plugins', 'GET', undefined, controller.signal)
      .then(items => {
        if (controller.signal.aborted) return;
        setPluginNav(items.flatMap(item => item.sidebar?.title ? [{ id: item.id, title: item.sidebar.title, icon: item.sidebar.icon }] : []));
        setPluginPanels(items.flatMap(item => item.panel?.title ? [{ id: item.id, title: item.panel.title, icon: item.panel.icon }] : []));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, backend.status, settingsOpen, pluginNavRevision]);
  useEffect(() => {
    if (pluginPage && !pluginNav.some(item => item.id === pluginPage)) setPluginPage('');
  }, [pluginNav, pluginPage]);
  const [menu, setMenu] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newAgentId, setNewAgentId] = useLocalState('agent-engine', 'native');
  const [agentPreferencesServer, setAgentPreferencesServer] = useState<string>();
  const [agentPreferencesRevision, setAgentPreferencesRevision] = useState(0);
  const [agentPreferencesError, setAgentPreferencesError] = useState('');
  const [agentSelectionBusy, setAgentSelectionBusy] = useState(false);
  const [engines, setEngines] = useState<AgentEngine[]>([]);
  const [acpPlans, setAcpPlans] = useState<Record<string, AcpPlanEntry[]>>({});
  const [acpCommands, setAcpCommands] = useState<Record<string, AcpCommand[]>>({});
  const [pendingInputs, setPendingInputs] = useState<Record<string, ElicitationRequest[]>>({});
  // The backend re-detects installed Agent runtimes on every request; bump this to refresh
  // after the user installs a missing runtime outside the app.
  const [enginesRevision, setEnginesRevision] = useState(0);
  const [enginesError, setEnginesError] = useState('');
  const [enginesLoading, setEnginesLoading] = useState(true);
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentConfigOption[]>>({});
  // Home has no session yet, but its composer still advertises the selected
  // Agent's options. The prepared backend session is reused by the first send.
  const [newAgentConfig, setNewAgentConfig] = useState<{ key: string; options: AgentConfigOption[] } | null>(null);
  // Read synchronously when the prepared draft becomes a conversation.
  const newAgentConfigRef = useRef<{ key: string; options: AgentConfigOption[] } | null>(null);
  function storeNewAgentConfig(next: { key: string; options: AgentConfigOption[] } | null) {
    newAgentConfigRef.current = next;
    setNewAgentConfig(next);
  }
  // Last known option list per backend and Agent. The home composer shows it
  // (disabled) while the Agent reconnects instead of collapsing into a spinner.
  const [agentConfigCache, setAgentConfigCache] = useLocalState<Record<string, AgentConfigOption[]>>('agent-config-cache', {});
  const preparedNewSession = useRef<{ key: string; target: Session } | null>(null);
  const agentConfigRequest = useRef(0);
  const [agentDraftRevision, setAgentDraftRevision] = useState(0);
  // A draft's Agent choices are already authoritative when it becomes a real
  // session. Remember the id briefly so selecting it does not fire a redundant
  // configuration read that would race (and lose to) the first prompt.
  const seededConfigAt = useRef<Record<string, number>>({});
  const [agentConfigBusy, setAgentConfigBusy] = useState<string>();
  const [agentConfigError, setAgentConfigError] = useState('');
  const [agentConfigRevision, setAgentConfigRevision] = useState(0);
  const [occupiedSessions, setOccupiedSessions] = useState<Set<string>>(() => new Set());
  const forkRequest = useRef<string>();
  const [forkBusy, setForkBusy] = useState<string>();
  const occupiedSessionsRef = useRef(occupiedSessions);
  const composerViewRef = useRef({ server, activeId, draft, draftKey: '' });
  const runs = useMemo(() => new SessionRuns(), []);
  useSyncExternalStore(runs.subscribe, runs.getSnapshot);
  const [toast, setToast] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
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
  const [historyState, setHistoryState] = useState<{ id: string; error?: string }>();
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
  const session = sessions.find(item => item.id === activeId);
  const composerHistory = useMemo(() => session ? getSessionMessages(session).map(message => message.text) : [], [session?.messages, session?.kind]);
  const isHome = !session;
  const chatMode = workspace === CHAT_WORKSPACE.hash || session?.workspaceHash === CHAT_WORKSPACE.hash;
  const [panelOpen, setChanges, changesTab, setChangesTab] = useSessionPanel(server, session?.id, workspace);
  const surfaceOpen = skillsOpen || schedulesOpen || !!pluginPage;
  const changes = panelOpen && !chatMode && !surfaceOpen;
  const changesMounted = usePresence(changes);
  const requestedAgentId = session?.agentId || (session ? 'native' : newAgentId);
  // External ACP engines own their own toolset, so pure chat stays on Native.
  const agentId = chatMode ? 'native' : requestedAgentId;
  const externalAgent = agentId !== 'native';
  const selectedEngineAvailable = engines.find(item => item.id === agentId)?.available;
  const agentConfigKey = `${server}::${workspace}::${agentId}`;
  const homeRunKey = draftRunKey(server, workspace, agentId, agentDraftRevision);
  const currentRunKey = session ? sessionRunKey(server, session.id) : homeRunKey;
  composerViewRef.current = { server, activeId, draft, draftKey: homeRunKey };
  const generatingId = runs.get(currentRunKey) ? session?.id || 'creating' : null;
  const liveSpeed = runs.speed(currentRunKey);
  const anyGenerating = runs.hasActive(server);
  const runningIds = runs.runningIds(server);
  const unreadIds = runs.unreadIds(server, sessions);
  useEffect(() => { if (session) runs.markRead(server, session.id); }, [runs, server, session?.id]);
  const planBusy = planBusyKeys.has(currentRunKey);
  function setPlanBusy(value: boolean) { setPlanBusyKeys(current => { const next = new Set(current); if (value) next.add(currentRunKey); else next.delete(currentRunKey); return next; }); }
  const agentPreferencesReady = agentPreferencesServer === server;
  const composerConfigBusy = !!agentConfigBusy || (!session && (!agentPreferencesReady || agentSelectionBusy || newAgentConfig?.key !== agentConfigKey));
  useEffect(() => {
    if (backend.status !== 'connected') return;
    const controller = new AbortController();
    setAgentPreferencesServer(undefined);
    setAgentPreferencesError('');
    agentConfigRequest.current++;
    preparedNewSession.current = null;
    storeNewAgentConfig(null);
    void (async () => {
      const saved = await api.request<{ selectedAgent: string | null }>('/agent-engines/preferences', 'GET', undefined, controller.signal);
      // Migrate the local selection only on the first run. Afterwards the backend
      // is authoritative, including when the desktop core starts on another port.
      const selected = saved.selectedAgent || newAgentId;
      if (!saved.selectedAgent) await api.request('/agent-engines/preferences', 'PUT', { selectedAgent: selected }, controller.signal);
      if (controller.signal.aborted) return;
      setNewAgentId(selected);
      setAgentPreferencesError('');
      setAgentPreferencesServer(server);
    })().catch(error => {
      if (!controller.signal.aborted) setAgentPreferencesError(`读取 Agent 偏好失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => controller.abort();
  }, [api, backend.status, agentPreferencesRevision]);
  useEffect(() => {
    setAgentConfigError('');
    if (!session?.name || !session.workspaceHash || backend.status !== 'connected') return;
    if (runs.get(sessionRunKey(server, session.id))) { setAgentConfigBusy(undefined); return; }
    // Just converted from a preconfigured draft: the Agent already holds these
    // choices, so a read here only competes with the first prompt for the process.
    const seededAt = seededConfigAt.current[session.id];
    if (seededAt && Date.now() - seededAt < 5000 && !isSessionOccupied(session.id)) return;
    const controller = new AbortController();
    const id = session.id;
    const busyKey = `${id}:${++agentConfigRequest.current}`;
    setAgentConfigBusy(busyKey);
    void api.request<{ configOptions: AgentConfigOption[] }>(`/agent-engines/config?${sessionQuery(session)}`, 'GET', undefined, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setAgentConfigs(current => ({ ...current, [id]: result.configOptions }));
        cacheAgentConfig(session.agentId || 'native', result.configOptions);
        recordSessionOccupancy(id, false);
        if (queuedRef.current[id]?.length) void sendQueuedMessage(id);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        if (isSessionOccupiedError(error)) recordSessionOccupancy(id, true);
        else if (isSessionOccupied(id)) notify(`检查失败：${error instanceof Error ? error.message : String(error)}`);
        else setAgentConfigError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setAgentConfigBusy(current => current === busyKey ? undefined : current));
    return () => controller.abort();
  }, [api, session?.id, backend.status, agentConfigRevision, generatingId]);
  useEffect(() => {
    if (backend.status !== 'connected') return;
    const controller = new AbortController();
    setEnginesLoading(true);
    setEnginesError('');
    void api.request<AgentEngine[]>('/agent-engines', 'GET', undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setEngines(result); setEnginesError(''); } })
      .catch(error => {
        if (controller.signal.aborted) return;
        setEngines([]);
        setEnginesError(`检测 Agent 运行环境失败：${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { if (!controller.signal.aborted) setEnginesLoading(false); });
    return () => controller.abort();
  }, [api, backend.status, enginesRevision]);
  // Pending HITL/ask_choice cards drive the composer popup. Read from the live
  // session messages (not demo history) so mock/offline sessions never pop it.
  const pendingChoices = useMemo(() => collectPendingChoices(session?.messages || []), [session?.messages]);
  const currentWorkspace = workspaces.find(item => item.hash === workspace);
  const pluginContext = useMemo(() => ({ workspaceHash: currentWorkspace?.hash, workspaceDir: currentWorkspace?.path,
    sessionId: session?.id, filePath: editorTabs.files.find(file => file.path === editorTabs.active)?.path,
  }), [currentWorkspace?.hash, currentWorkspace?.path, session?.id, editorTabs.files, editorTabs.active]);
  const projectWorkspaces = useMemo(() => workspaces.filter(item => !isChatWorkspace(item)), [workspaces]);
  const workspaceName = currentWorkspace?.name || '选择工作区';
  useEffect(() => {
    if (!chatMode) return;
    setTerminal(false);
  }, [chatMode]);
  // A new chat has no session yet, but the Agent's choices are already known:
  // prepare them in the background so the composer never asks for a manual step.
  useEffect(() => {
    if (session || !currentWorkspace || backend.status !== 'connected' || !backend.ready || !agentPreferencesReady || agentSelectionBusy) return;
    if (newAgentConfig?.key === agentConfigKey || preparedNewSession.current?.key === agentConfigKey) return;
    // Wait for installation detection, and depend on its boolean result. A
    // second catalog response must not cancel an ACP process already opening.
    if (selectedEngineAvailable !== true) return;
    const controller = new AbortController();
    // Debounce so StrictMode's throwaway first effect (and rapid Agent toggles)
    // never spawns a backend session that nobody asked for.
    const timer = setTimeout(() => void loadNewAgentConfig(currentWorkspace.hash, agentId, controller.signal), 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [session, agentConfigKey, currentWorkspace?.hash, backend.status, backend.ready, newAgentConfig?.key, selectedEngineAvailable, agentId, agentPreferencesReady, agentSelectionBusy, agentDraftRevision]);

  useLayoutEffect(() => {
    // Root tokens also reach NextUI menus, modals and tooltips rendered in portals.
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', String(preferences.fontScale / 100));
    return () => { root.style.removeProperty('--ui-scale'); };
  }, [preferences.fontScale]);

  function notify(message: string) { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2600); }
  function currentClientSettings(): ClientSettings {
    return { preferences: preferencesRef.current, profile: profileRef.current, petEnabled: agentSettingsRef.current.petEnabled };
  }
  function persistClientSettings(settings: ClientSettings, reportError: boolean) {
    uiPreferenceDirty.current = true;
    const seq = ++uiPreferenceSave.current;
    void api.request('/ui-preferences', 'PUT', toStoredSettings(settings))
      .then(() => { if (seq === uiPreferenceSave.current) uiPreferenceDirty.current = false; })
      .catch(error => { if (reportError && seq === uiPreferenceSave.current) notify(`设置保存失败：${error instanceof Error ? error.message : error}`); });
  }
  function applyClientSettings(settings: ClientSettings) {
    preferencesRef.current = settings.preferences;
    profileRef.current = settings.profile;
    agentSettingsRef.current = { ...agentSettingsRef.current, petEnabled: settings.petEnabled };
    setPreferences(settings.preferences);
    setAgentSettings(current => ({ ...current, petEnabled: settings.petEnabled }));
    void writeProfileLocal(settings.profile);
  }
  function savePreferences(next: Preferences) {
    preferencesRef.current = next;
    setPreferences(next);
    persistClientSettings({ ...currentClientSettings(), preferences: next }, true);
  }
  async function saveProfile(value: Parameters<typeof writeProfileLocal>[0]) {
    const next = normalizeProfile(value);
    await writeProfileLocal(next);
    profileRef.current = next;
    persistClientSettings({ ...currentClientSettings(), profile: next }, true);
  }
  useEffect(() => {
    if (backend.status !== 'connected' || !profileReady) return;
    const controller = new AbortController();
    void api.request<StoredUIPreferences>('/ui-preferences', 'GET', undefined, controller.signal)
      .then(saved => {
        if (controller.signal.aborted) return;
        if (!saved.persisted || uiPreferenceDirty.current) {
          persistClientSettings(currentClientSettings(), false);
          return;
        }
        const merged = mergeStoredSettings(saved, currentClientSettings());
        applyClientSettings(merged.settings);
        if (!merged.complete) persistClientSettings(merged.settings, false);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, backend.status, profileReady, setPreferences, setAgentSettings]);
  const coreUpdate = useCoreServiceUpdate(api, notify, () => { setSettingsOpen(false); setMenu(null); }, settingsOpen && !isDesktopWindow());
  const desktopUpdate = useDesktopUpdate(anyGenerating || remoteRun ? '任务正在运行，请在任务结束后重启安装。'
    : coreUpdate.update?.running || coreUpdate.startingUpdate ? '核心服务正在更新，请在完成后重启安装。' : '',
    () => { setSettingsOpen(false); setMenu(null); });
  useEffect(() => {
    const check = backend.updateCheck;
    if (desktopUpdate.available || !check?.hasNewVersion || !check.latestVersion || notifiedUpdate.current === check.latestVersion) return;
    notifiedUpdate.current = check.latestVersion;
    notify(`发现新版本 v${check.latestVersion}，点击顶栏版本查看`);
  }, [backend.updateCheck, desktopUpdate.available]);
  function selectMainTab(path: string | null, hash = workspace) { const key = `${server}/${hash}`; setWorkspaceEditors(current => ({ ...current, [key]: { ...(current[key] || emptyWorkspaceTabs), active: path } })); }
  function openFile(file: WorkspaceFile) { setWorkspaceEditors(current => ({ ...current, [editorKey]: openWorkspaceFile(current[editorKey] || emptyWorkspaceTabs, file) })); if (narrow) setChanges(false); }
  function changeFilePath(from: string, to?: string) { setWorkspaceEditors(current => ({ ...current, [editorKey]: updateWorkspaceFilePath(current[editorKey] || emptyWorkspaceTabs, from, to) })); }
  function closeFile(path: string) { setWorkspaceEditors(current => ({ ...current, [editorKey]: closeWorkspaceFile(current[editorKey] || emptyWorkspaceTabs, path) })); }
  function closeSubAgent(subSessionId: string) { setWorkspaceEditors(current => ({ ...current, [editorKey]: closeSubAgentTab(current[editorKey] || emptyWorkspaceTabs, subSessionId) })); }
  useSubAgentTabs(api, server, session, backend.status === 'connected' && !chatMode, generatingId, setWorkspaceEditors);
  function mutation(task: () => Promise<void>, scope: 'global' | 'session' = 'global') {
    const result = settingsQueue.current.then(async () => {
      if (scope === 'global' ? runs.hasActive(server) : runs.get(currentRunKey)) throw new Error('请等待当前回复结束后再修改运行配置');
      if (backend.status !== 'connected') throw new Error('尚未连接 Loopra');
      await task();
    });
    settingsQueue.current = result.catch(error => { notify(`保存失败：${error instanceof Error ? error.message : error}`); });
    return result;
  }
  function isSessionOccupied(id: string) { return occupiedSessionsRef.current.has(`${server}::${id}`); }
  function recordSessionOccupancy(id: string, occupied: boolean) {
    const key = `${server}::${id}`;
    const next = new Set(occupiedSessionsRef.current);
    if (occupied) next.add(key); else next.delete(key);
    occupiedSessionsRef.current = next;
    setOccupiedSessions(next);
  }
  // 端口每次启动都会变，缓存不能带 origin，否则刷新后工具栏只能干等 ACP 握手。
  function cachedAgentOptions(agent: string) {
    const id = agent || 'native';
    const exact = agentConfigCache[id];
    if (exact?.length) return exact;
    const suffix = `::${id}`;
    for (const [key, options] of Object.entries(agentConfigCache)) {
      if (key.endsWith(suffix) && options.length) return options;
    }
    return undefined;
  }
  function cacheAgentConfig(agent: string, options: AgentConfigOption[]) {
    setAgentConfigCache(current => ({ ...current, [agent || 'native']: options }));
  }
  const composerAgentOptions = session
    ? (Object.prototype.hasOwnProperty.call(agentConfigs, session.id) ? agentConfigs[session.id] : cachedAgentOptions(session.agentId || 'native'))
    : newAgentConfig?.key === agentConfigKey ? newAgentConfig.options : cachedAgentOptions(agentId);
  function saveOptions(next: ComposerOptions) {
    if (externalAgent) { setComposerOptions(next); return Promise.resolve(); }
    // Leaving plan mode discards any submitted plan, so confirm first (legacy togglePlan).
    if (!next.plan && composerOptions.plan && session) { setDiscardPlan(true); return Promise.resolve(); }
    return mutation(async () => {
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
        }
        cacheAgentConfig(target.agentId || agentId, result.configOptions);
      }
      if (composerViewRef.current.server === server && composerViewRef.current.activeId === (session?.id || null) && (session || composerViewRef.current.draftKey === homeRunKey)) setComposerOptions(next);
    }, 'session').catch(() => {});
  }
  /**
   * Fetch the selected Agent's defaults for the home composer. The returned
   * session name is kept only as a draft: it becomes visible when the first
   * message is sent, so browsing the home page never adds empty sessions.
   */
  async function loadNewAgentConfig(workspaceHash: string, requestedAgent: string, signal?: AbortSignal) {
    const key = `${server}::${workspaceHash}::${requestedAgent}`;
    const request = ++agentConfigRequest.current;
    const busyId = `new:${key}:${request}`;
    setAgentConfigBusy(busyId); setAgentConfigError('');
    try {
      const prepared = await api.request<{ sessionName: string; agentId: string; configOptions: AgentConfigOption[] }>('/agent-engines/prepare', 'POST',
        { workspaceHash, sessionName: undefined, agentId: requestedAgent }, signal);
      if (signal?.aborted || request !== agentConfigRequest.current) return;
      const project = workspaces.find(item => item.hash === workspaceHash);
      if (!project) return;
      const target = remoteSession({ name: prepared.sessionName, agentId: prepared.agentId, title: '新会话', messageCount: 0, mtime: Date.now() }, project);
      preparedNewSession.current = { key, target };
      // Preparation restores the backend's per-Agent defaults before returning.
      storeNewAgentConfig({ key, options: prepared.configOptions });
      cacheAgentConfig(prepared.agentId, prepared.configOptions);
    } catch (error) {
      if (signal?.aborted || request !== agentConfigRequest.current) return;
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
      const options = prepared.configOptions;
      const target = session || remoteSession({ name: prepared.sessionName, agentId: prepared.agentId, title: '新会话', messageCount: 0, mtime: Date.now() }, currentWorkspace);
      if (!session) cacheAgentConfig(prepared.agentId, options);
      setAgentConfigs(current => ({ ...current, [target.id]: options }));
      // A fresh session goes to the top, matching the server's newest-first list.
      if (!session) { setSessions(current => [target, ...current]); setActiveId(target.id); pinNewSession(currentWorkspace.hash, target.name); }
      return target;
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setAgentConfigError(message); notify(message); }
    finally { setAgentConfigBusy(undefined); }
  }
  function retryAgentConfig() {
    if (!session && !agentPreferencesReady) { setAgentPreferencesRevision(value => value + 1); return; }
    if (!session && (enginesError || selectedEngineAvailable !== true)) { setEnginesRevision(value => value + 1); return; }
    if (session) { setAgentConfigRevision(value => value + 1); return; }
    if (currentWorkspace) void loadNewAgentConfig(currentWorkspace.hash, agentId);
  }
  async function changeAgentConfig(configId: string, value: string | boolean) {
    const prepared = preparedNewSession.current;
    const target = session || (prepared?.key === agentConfigKey ? prepared.target : undefined);
    if (!target) return;
    setAgentConfigBusy(target.id);
    try {
      const result = await api.request<{ configOptions: AgentConfigOption[] }>('/agent-engines/config', 'PUT',
        { workspaceHash: target.workspaceHash, sessionName: target.name, configId, value });
      if (session) setAgentConfigs(current => ({ ...current, [target.id]: result.configOptions }));
      else {
        const draft = newAgentConfigRef.current;
        if (draft?.key === agentConfigKey) storeNewAgentConfig({ ...draft, options: result.configOptions });
      }
      cacheAgentConfig(target.agentId || agentId, result.configOptions);
      if ((target.agentId === 'native' || !target.agentId) && composerViewRef.current.server === server && composerViewRef.current.activeId === (session?.id || null) && (session || composerViewRef.current.draftKey === homeRunKey)) {
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
    } catch (error) {
      if (isSessionOccupiedError(error)) recordSessionOccupancy(target.id, true);
      else notify(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
    finally { setAgentConfigBusy(current => current === target.id ? undefined : current); }
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
    if (next.petEnabled !== agentSettings.petEnabled) {
      agentSettingsRef.current = { ...agentSettingsRef.current, petEnabled: next.petEnabled };
      persistClientSettings(currentClientSettings(), true);
    }
    const changed = <K extends keyof AgentSettings>(key: K) => JSON.stringify(next[key]) !== JSON.stringify(agentSettings[key]);
    const localOnly = !(['systemPrompt', 'tools', 'validatorModel', 'imageModel', 'toolModel'] as const).some(changed);
    if (localOnly) { setAgentSettings(next); return; }
    await mutation(async () => {
      const patch: Record<string, unknown> = {};
      if (changed('tools')) patch.disabledTools = next.tools.filter(tool => !tool.enabled).map(tool => tool.name);
      for (const [key, modelKey, channelKey] of [['validatorModel', 'validationModel', 'validationModelChannelId'], ['imageModel', 'imageUnderstandingModel', 'imageUnderstandingModelChannelId'], ['toolModel', 'toolModel', 'toolModelChannelId']] as const) {
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
  async function switchAgent(id: string) {
    if (id === agentId) return;
    if (generatingId || remoteRun) { notify('任务运行中，结束后才能切换 Agent'); return; }
    if (!agentPreferencesReady || agentSelectionBusy) return;
    setAgentSelectionBusy(true);
    try {
      await api.request('/agent-engines/preferences', 'PUT', { selectedAgent: id });
      setNewAgentId(id);
      newSession();
    } catch (error) { notify(`保存 Agent 失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setAgentSelectionBusy(false); }
  }
  function newSession(nextWorkspace = workspace || workspaces[0]?.hash || '') {
    setSkillsOpen(false);
    setSchedulesOpen(false);
    setPluginPage('');
    agentConfigRequest.current++;
    setAgentDraftRevision(value => value + 1);
    preparedNewSession.current = null;
    storeNewAgentConfig(null);
    selectMainTab(null, nextWorkspace);
    if (narrow) setSidebar(false);
    historyRequest.current?.abort();
    if (getModelCatalog(providers).some(model => model.id === defaultModel))
      setComposerOptions(value => ({ ...value, modelId: defaultModel }));
    setActiveId(null); setWorkspace(nextWorkspace); setDraft('');
    setComposerContext(emptyContext); setPendingPlan(undefined); setMenu(null);
    userScrolledAway.current = false; lastScrollTop.current = 0; setShowScrollBtn(false);
    setTimeout(() => textarea.current?.focus(), 50);
  }
  async function forkOccupiedSession() {
    if (!session || composerConfigBusy) return;
    await createSessionBranch(session);
  }
  async function createSessionBranch(source: Session, messageCount?: number) {
    if (forkRequest.current || backend.status !== 'connected' || !backend.ready) return;
    const label = messageCount === undefined ? '分叉' : '分支';
    const key = `${server}::${source.id}`;
    forkRequest.current = key;
    setForkBusy(key);
    try {
      const route = messageCount === undefined ? sessionRoute(source, '/fork')
        : `${sessionRoute(source, '/branch')}&messageCount=${messageCount}`;
      const result = await api.request<{ sessionName: string }>(route, 'POST', undefined, AbortSignal.timeout(65000));
      if (!result.sessionName || result.sessionName === source.name) throw new Error('未能创建独立的分叉会话');
      if (composerViewRef.current.server !== server) return;
      const next: Session = { ...source, id: `${source.workspaceHash}/${result.sessionName}`, name: result.sessionName,
        title: `[复刻]${source.title}`, worktreeMode: false, mtime: Date.now(),
        messages: messageCount === undefined ? source.messages
          : source.messages.filter(message => message.historyCount !== undefined && message.historyCount <= messageCount) };
      // The fork already exists. Keep it visible even if the history refresh fails.
      setSessions(current => [next, ...current.filter(item => item.id !== next.id)]);
      pinNewSession(next.workspaceHash, next.name);
      let historyError = false;
      try {
        const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(next)}`);
        if (composerViewRef.current.server !== server) return;
        setSessions(current => current.map(item => item.id === next.id ? { ...item, messages: historyMessages(history) } : item));
      } catch { historyError = true; }
      const view = composerViewRef.current;
      if (view.server !== server || view.activeId !== source.id) return;
      historyRequest.current?.abort();
      selectMainTab(null, next.workspaceHash || '');
      setActiveId(next.id); setWorkspace(next.workspaceHash || '');
      setPendingPlan(undefined); setMenu(null);
      userScrolledAway.current = false; lastScrollTop.current = 0; setShowScrollBtn(false);
      notify(historyError ? `${label}已创建，历史刷新失败，可重新打开此会话加载`
        : messageCount === undefined ? '已保留历史并创建独立会话' : '已从所选回复创建独立分支会话');
    } catch (error) {
      const view = composerViewRef.current;
      if (view.server === server && view.activeId === source.id) {
        notify(`创建${label}失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      forkRequest.current = undefined;
      setForkBusy(undefined);
    }
  }
  function selectWorkspace(hash: string) {
    if (hash !== workspace) setComposerContext(withoutWorkspaceContext);
    setWorkspace(hash);
    setMenu(null);
  }
  // Legacy Chat.vue 清空按钮：后端 /new 命令已移除，改为在当前工作区新建空白会话。
  function clearChat() { if (generatingId) { notify('生成中无法清空，请先停止生成'); return; } newSession(workspace || workspaces[0]?.hash || ''); notify('已新建空白会话'); }
  async function selectSession(id: string, provided?: Session) {
    setSkillsOpen(false);
    setSchedulesOpen(false);
    setPluginPage('');
    const selected = provided || sessions.find(item => item.id === id); if (!selected) return;
    selectMainTab(null, selected.workspaceHash || '');
    if (narrow) setSidebar(false);
    historyRequest.current?.abort(); const controller = new AbortController(); historyRequest.current = controller;
    setActiveId(id); setWorkspace(selected.workspaceHash || ''); setMenu(null); setDraft(''); setComposerContext(emptyContext);
    // Opening a session always jumps to the newest message.
    userScrolledAway.current = false; lastScrollTop.current = 0; setShowScrollBtn(false);
    setHistoryState(undefined);
    runs.markRead(server, id);
    const localRunning = !!runs.get(sessionRunKey(server, id));
    if (!localRunning) setHistoryState({ id });
    // History is independently useful; slow Agent configuration must not hold it back.
    await Promise.all([
      (localRunning ? Promise.resolve() : api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(selected)}`, 'GET', undefined, controller.signal))
        .then(history => {
          if (controller.signal.aborted || !history) return;
          if (runs.get(sessionRunKey(server, id))) { setHistoryState(undefined); return; }
          const messages = historyMessages(history);
          setSessions(current => current.map(item => item.id === id ? { ...item, messages, messageCount: history.length } : item));
          setHistoryState(undefined);
        }).catch(error => {
          if (controller.signal.aborted) return;
          setHistoryState({ id, error: error instanceof Error ? error.message : String(error) });
        }),
      api.request<{ model: string; modelChannelId: string; reasoningEffort: string }>(sessionRoute(selected, '/settings'), 'GET', undefined, controller.signal)
        .then(settings => {
          if (!controller.signal.aborted) setComposerOptions(current => ({ ...current, ...(selected.agentId && selected.agentId !== 'native' ? {} : { modelId: `${settings.modelChannelId}:${settings.model}` }), effort: settings.reasoningEffort || current.effort }));
        }).catch(error => { if (!controller.signal.aborted) notify(`加载会话模型设置失败：${error instanceof Error ? error.message : error}`); }),
      api.request<{ mode: string; pendingPlan?: string | null }>(`/agent/mode?${sessionQuery(selected)}`, 'GET', undefined, controller.signal)
        .then(mode => {
          if (controller.signal.aborted) return;
          setComposerOptions(current => ({ ...current, plan: mode.mode === 'plan' }));
          setPendingPlan(mode.pendingPlan || undefined);
        }).catch(error => { if (!controller.signal.aborted) notify(`加载会话计划状态失败：${error instanceof Error ? error.message : error}`); }),
    ]);
  }
  async function openScheduledSession(hash: string, name: string) {
    const project = workspaces.find(item => item.hash === hash);
    if (!project) throw new Error('项目不存在');
    const remote = await api.request<RemoteSession[]>(`/sessions?workspaceHash=${encodeURIComponent(hash)}`);
    const found = remote.find(item => item.name === name);
    if (!found) throw new Error('该执行记录的会话不存在，可能尚未创建或已被删除');
    const target = remoteSession(found, project);
    setSessions(current => current.some(item => item.id === target.id) ? current : [target, ...current]);
    await selectSession(target.id, target);
  }
  function toggleMenu(name: string) { setMenu(current => current === name ? null : name); }
  function openSettings(tab = '通用') {
    const capabilities = capabilitiesTabForSection(tab);
    if (capabilities) {
      setCapabilitiesTab(capabilities); setSkillsOpen(true); setSchedulesOpen(false); setPluginPage(''); setSettingsOpen(false); setMenu(null);
      if (narrow) setSidebar(false);
      return;
    }
    setSettingsTab(tab); setSettingsOpen(true); setMenu(null);
  }
  function openCoreUpdate() {
    if (isDesktopWindow()) { desktopUpdate.show(); return; }
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
    if (runs.get(sessionRunKey(server, target.id))) { notify('会话正在运行，消息会实时更新'); return; }
    try {
      const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(target)}`, 'GET');
      if (composerViewRef.current.server !== server || runs.get(sessionRunKey(server, target.id))) return;
      setSessions(current => current.map(item => item.id === target.id ? { ...item, messages: historyMessages(history), messageCount: history.length } : item));
      notify(`${target.title} 已刷新`);
    } catch (error) { notify(`刷新失败：${error instanceof Error ? error.message : error}`); }
  }
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
      if (composerViewRef.current.server === server && composerViewRef.current.activeId === session.id) {
        setComposerOptions(current => ({ ...current, plan: false }));
        setPendingPlan(undefined);
      }
      notify('已退出计划模式');
    } catch (error) { notify(`退出计划模式失败：${error instanceof Error ? error.message : error}`); }
    finally { setPlanBusy(false); }
  }
  async function removeSession(target: Session) {
    if (runs.get(sessionRunKey(server, target.id))) throw new Error('请先停止该会话，再删除');
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
  // A saved drag order otherwise leaves a new name at the bottom on the next refresh.
  function pinNewSession(workspaceHash: string | undefined, name: string | undefined) {
    if (!workspaceHash || !name) return;
    const names = sessionsRef.current.filter(item => item.workspaceHash === workspaceHash && item.name && item.name !== name).map(item => item.name!);
    void api.request(`/sessions/order?workspaceHash=${encodeURIComponent(workspaceHash)}`, 'PUT', orderWithNewSessionFirst(names, name)).catch(() => {});
  }
  // Session drag-reorder inside one project. The backend stores the order so the
  // list keeps it after a refresh and for other clients.
  function reorderSessions(workspaceHash: string, from: string, to: string) {
    if (!from || !to || from === to) return;
    const own = sessions.filter(item => item.workspaceHash === workspaceHash);
    const source = own.findIndex(item => item.id === from);
    const target = own.findIndex(item => item.id === to);
    if (source < 0 || target < 0) return;
    const next = [...own];
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    let index = 0;
    setSessions(current => current.map(item => item.workspaceHash === workspaceHash ? next[index++] : item));
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
  function openTerminal() { if (chatMode) { notify('纯聊天模式不提供终端'); return; } setTerminal(true); setMenu(null); }
  async function openWorkspace(application = preferences.openWith) {
    setMenu(null);
    try { await launchWorkspace(api, currentWorkspace?.hash || '', application); }
    catch (error) { notify(`打开失败：${error instanceof Error ? error.message : error}`); }
  }
  function copyPath() { void navigator.clipboard?.writeText(currentWorkspace?.path || ''); setMenu(null); notify('已复制工作区路径'); }
  async function stopGeneration(id = session?.id) {
    const request = runs.get(id ? sessionRunKey(server, id) : homeRunKey); if (!request) return;
    if (request.stopPromise) return request.stopPromise;
    request.stopping = true;
    request.stopPromise = api.request('/chat/abort', 'POST', { requestId: request.requestId, workspaceHash: request.session?.workspaceHash || request.workspaceHash, sessionName: request.session?.name })
      .then(() => { request.controller.abort(); })
      .catch(error => { request.stopping = false; request.stopPromise = undefined; notify(`停止失败：${error instanceof Error ? error.message : error}`); });
    await request.stopPromise;
  }
  // Legacy Chat.vue polls /agent/session-status so a reply started elsewhere
  // (another window, or a reload mid-run) is visible and its history stays fresh.
  async function syncSessionRun(target: Session, controller: AbortController, observe: { running: boolean }) {
    const previousTitle = sessionsRef.current.find(item => item.id === target.id)?.title;
    const status = await api.request<{ running?: boolean; requestId?: string; title?: string }>(`/agent/session-status?${sessionQuery(target)}`, 'GET', undefined, controller.signal);
    if (controller.signal.aborted) return;
    if (status?.title) setSessions(current => current.map(item =>
      item.id === target.id && item.title === previousTitle && item.title !== status.title ? { ...item, title: status.title! } : item));
    if (runs.get(sessionRunKey(server, target.id))) return;
    const running = !!status?.running;
    remoteRunRef.current = running ? target.id : null;
    setRemoteRun(running ? { id: target.id, requestId: status?.requestId } : null);
    if (running || observe.running) {
      const history = await api.request<HistoryMessage[]>(`/agent/history?${sessionQuery(target)}`, 'GET', undefined, controller.signal);
      const permissions = running ? await api.request<StreamEvent[]>(`/chat/permissions?${sessionQuery(target)}`, 'GET', undefined, controller.signal) : [];
      const inputs = running ? await api.request<ElicitationRequest[]>(`/chat/elicitations?${sessionQuery(target)}`, 'GET', undefined, controller.signal) : [];
      if (!controller.signal.aborted && !runs.get(sessionRunKey(server, target.id))) setPendingInputs(current => ({ ...current, [target.id]: inputs }));
      if (!controller.signal.aborted && !runs.get(sessionRunKey(server, target.id)) && (history.length || permissions.length)) setSessions(current => current.map(item => {
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
    // Local streams own their messages; status polling still refreshes async titles.
    if (!session || backend.status !== 'connected') { remoteRunRef.current = null; setRemoteRun(null); return; }
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
    const count = messages[index].historyCount;
    if (!count) { notify('请重新打开会话后再创建分支'); return; }
    await createSessionBranch(session, count);
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
  function removeQueuedMessage(id: string) {
    if (!session) return;
    replaceQueue(removeQueued(queuedRef.current, session.id, id));
    notify('已撤回排队消息');
  }
  function editQueuedMessage(id: string): boolean {
    if (!session) return false;
    const item = queuedRef.current[session.id]?.find(entry => entry.id === id);
    if (!item) return false;
    const restored = restoreQueuedDraft(item, draft, composerContext);
    replaceQueue(removeQueued(queuedRef.current, session.id, id));
    setDraft(restored.draft);
    setComposerContext(restored.context);
    setMenu(null);
    return true;
  }
  function moveQueuedMessage(id: string, targetId: string) {
    if (session) replaceQueue(moveQueued(queuedRef.current, session.id, id, targetId));
  }
  async function sendQueuedMessage(key: string) {
    if (composerViewRef.current.server !== server || isSessionOccupied(key) || sendingQueued.current.has(key) || runs.get(sessionRunKey(server, key)) || remoteRunRef.current === key) return;
    const target = sessionsRef.current.find(item => item.id === key);
    if (!target || !nextQueued(queuedRef.current, key)) return;
    sendingQueued.current.add(key);
    let sent = false;
    let attempted: QueuedMessage | undefined;
    try {
      // An abort response only acknowledges cancellation. Wait for the backend
      // task to leave its finally blocks before submitting the next turn.
      const deadline = Date.now() + 10000;
      while (true) {
        const status = await api.request<{ running: boolean }>(`/agent/session-status?${sessionQuery(target)}`);
        if (!status.running) { if (remoteRunRef.current === key) remoteRunRef.current = null; break; }
        if (Date.now() >= deadline) throw new Error('上一条回复仍在停止，消息已保留在队列中');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (composerViewRef.current.server !== server || runs.get(sessionRunKey(server, key))) return;
      const next = nextQueued(queuedRef.current, key);
      if (!next) return;
      attempted = next;
      // Resolve the latest sender, and pass the queue's owner explicitly: the
      // old stream callback may have captured Home or another selected session.
      sent = await sendMessageRef.current(next.text, next.context, undefined, false, false, target, next.id);
    } catch (error) { notify(error instanceof Error ? error.message : '队列发送失败'); }
    finally {
      sendingQueued.current.delete(key);
      const next = nextQueued(queuedRef.current, key);
      if ((sent || (attempted && next && next !== attempted)) && !runs.get(sessionRunKey(server, key)) && next) void sendQueuedMessage(key);
    }
  }
  function guideQueuedMessage(id: string) {
    if (!session) return;
    const key = session.id;
    if (!nextQueued(queuedRef.current, key) || !queuedRef.current[key]?.some(item => item.id === id)) return;
    replaceQueue(promoteQueued(queuedRef.current, key, id));
    if (runs.get(sessionRunKey(server, key))) void stopGeneration(key);
    else if (remoteRunRef.current === key) void stopRemoteRun();
    else void sendQueuedMessage(key);
  }

  async function sendMessage(override?: string, overrideContext?: ComposerContext, action?: string, fresh = false, autoAnswer = false, queuedSession?: Session, queuedMessageId?: string): Promise<boolean> {
    if (!queuedSession && composerConfigBusy) return false;
    const queuedItem = queuedSession && queuedMessageId ? nextQueued(queuedRef.current, queuedSession.id) : undefined;
    if (queuedSession && queuedMessageId && queuedItem?.id !== queuedMessageId) return false;
    const sendSession = queuedSession || session;
    if (sendSession && isSessionOccupied(sendSession.id)) return false;
    const sendWorkspace = queuedSession ? workspaces.find(item => item.hash === queuedSession.workspaceHash) : currentWorkspace;
    const sendAgentId = isChatWorkspace(sendWorkspace) ? 'native' : queuedSession ? queuedSession.agentId || 'native' : agentId;
    const requestKey = sendSession && !fresh ? sessionRunKey(server, sendSession.id) : homeRunKey;
    if (runs.get(requestKey) || remoteRunRef.current === (sendSession?.id ?? '')) { if (override === undefined && !action) queueMessage(); return false; }
    if (override === undefined && !action && !draft.trim() && !composerContext.files.length) return false;
    if (backend.status !== 'connected' || !backend.ready || !sendWorkspace) { notify('请先连接 Loopra 并选择工作区'); return false; }
    if (runs.count(server) >= runs.limit) { if (!queuedSession) notify(`已有 ${runs.limit} 个会话正在运行，请等待其中一个结束后再发送`); return false; }
    let prompt = (override ?? draft.trim()) || (action ? '' : '请查看附件');
    const titleSource = prompt;
    // Oversized directly-typed bodies are saved into the project and replaced by
    // a reference block before sending, matching legacy ChatInput.vue. The paste
    // handler already externalizes clipboard text; this covers typed/edited text.
    let savedInput: string | undefined;
    if (!action && sendWorkspace && !isChatWorkspace(sendWorkspace) && prompt.length > LARGE_PASTE_THRESHOLD_CHARS) {
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
    if (composerViewRef.current.server !== server) return false;
    // File preparation can yield to editing, withdrawal, or reordering.
    if (queuedSession && queuedMessageId && nextQueued(queuedRef.current, queuedSession.id) !== queuedItem) {
      return false;
    }
    if (preferences.sound) prepareCompletionSound();
    const sourceContext = overrideContext || composerContext;
    const context = isChatWorkspace(sendWorkspace) ? withoutWorkspaceContext(sourceContext) : { ...sourceContext };
    const text = action ? prompt : composeOutgoing(prompt, context, savedInput);
    const controller = new AbortController(); const requestId = crypto.randomUUID();
    const request = runs.claim(requestKey, { controller, requestId, server, workspaceHash: sendWorkspace.hash, session: fresh ? undefined : sendSession });
    if (!request) { if (!queuedSession && !runs.get(requestKey)) notify(`已有 ${runs.limit} 个会话正在运行，请稍后发送`); return false; }
    const visible = () => isRunView(request, composerViewRef.current);
    const sameServer = () => composerViewRef.current.server === server;
    if (queuedSession && queuedMessageId) replaceQueue(removeQueued(queuedRef.current, queuedSession.id, queuedMessageId));
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
    let occupiedFailure = false;
    let agentStopReason: string | undefined;
    const assistant: Message = { id: answerId, role: 'assistant', text: '', time, startedAt: now, blocks: [] };
    let petAnswer = assistant;
    try {
      if (!target) {
        // Reuse the draft prepared for the home composer so its Agent choices
        // (model, permission mode, effort…) survive into the first real turn.
        const prepared = preparedNewSession.current;
        if (prepared?.key === agentConfigKey) {
          const draft = newAgentConfigRef.current;
          target = { ...prepared.target, title: titleSource.slice(0, 60) };
          const options = draft?.key === agentConfigKey ? draft.options : undefined;
          if (options) {
            setAgentConfigs(current => ({ ...current, [target!.id]: options }));
            cacheAgentConfig(target!.agentId || agentId, options);
            seededConfigAt.current[target!.id] = Date.now();
          }
          preparedNewSession.current = null;
          storeNewAgentConfig(null);
        } else {
          const created = await api.request<{ sessionName: string; agentId: string; configOptions: AgentConfigOption[] }>('/agent-engines/prepare', 'POST',
            { workspaceHash: sendWorkspace.hash, agentId: sendAgentId }, controller.signal);
          target = remoteSession({ name: created.sessionName, title: titleSource.slice(0, 60), messageCount: 0, mtime: now, agentId: created.agentId }, sendWorkspace);
          setAgentConfigs(current => ({ ...current, [target!.id]: created.configOptions }));
          seededConfigAt.current[target.id] = Date.now();
        }
        if (controller.signal.aborted || !runs.bind(request, target)) throw new Error('会话创建已取消');
        // Keep the optimistic title local so the backend can generate the first title.
        // The server lists newest first; mirror that optimistically instead of appending.
        if (sameServer()) {
          setSessions(current => [target!, ...current.filter(item => item.id !== target!.id)]);
          pinNewSession(sendWorkspace.hash, target!.name);
        }
        if (visible()) setActiveId(target.id);
      }
      if (controller.signal.aborted || !runs.owns(request) || !sameServer()) throw new Error('会话请求已取消');
      const id = target.id;
      // Approving a plan (execute_plan) must not re-enter plan mode; the agent clears it while executing.
      // A continued turn already owns its bubble: reopen it (so its timer ticks
      // again) instead of inserting a second one.
      if (resumed) setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? { ...entry, finishedAt: undefined } : entry) } : item));
      else setSessions(current => current.map(item => item.id === id ? { ...item, messages: silent ? [...item.messages, assistant] : [...item.messages, message, assistant] } : item));
      if (!autoAnswer && !queuedSession && visible() && composerViewRef.current.draft === draft) { setDraft(''); setComposerContext(emptyContext); setMenu(null); }
      // A new prompt always returns to the newest message (legacy scroll(true)).
      if (visible()) {
        userScrolledAway.current = false;
        const scroller = scrollArea.current;
        if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
        setShowScrollBtn(false);
      }
      const attachments = context.attachments || [];
      const documentText = attachments.filter(file => file.text !== undefined).map(file => `附件：${file.name}\n${file.text}`).join('\n\n');
      await api.stream({ message: [text, documentText].filter(Boolean).join('\n\n'), requestId, workspaceHash: target.workspaceHash!, sessionName: target.name!, agentId: sendAgentId, images: attachments.flatMap(file => file.image ? [file.image] : []), linkedProjectHashes: target.workspaceHash === CHAT_WORKSPACE.hash ? [] : projectWorkspaces.filter(project => context.projects.includes(project.name)).map(project => project.hash), ...(action ? { action } : {}) }, event => {
        if (!runs.owns(request) || controller.signal.aborted || !sameServer()) return;
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
        if (event.type === 'plan_submitted') { if (visible()) { setPendingPlan(event.plan || undefined); setComposerOptions(current => ({ ...current, plan: true })); } return; }
        if (event.type === 'mode_changed') { if (visible()) { setComposerOptions(current => ({ ...current, plan: event.mode === 'plan' })); if (event.mode !== 'plan') setPendingPlan(undefined); } return; }
        if (event.type === 'snapshot' && event.msgId) setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === message.id ? { ...entry, rollbackId: event.msgId, ...(event.hasCodeSnapshot ? { snapshotId: event.msgId } : {}) } : entry) } : item));
        if (event.type === 'token_speed') { runs.setSpeed(request, { tokensPerSecond: event.tokensPerSecond, avgTokensPerSecond: event.avgTokensPerSecond, done: !!event.done, completionTokens: event.completionTokens }); return; }
        // Legacy `log` events only surface as floating INFO/WARN/ERROR bars.
        if (event.type === 'log') { if (visible()) chatLogs.push({ level: event.level, message: event.message, content: event.content }); return; }
        // Legacy Chat.vue opened the right panel's command tab when the agent
        // started a background shell, so the running process is visible.
        if (visible() && (event.type === 'tool_call' || event.type === 'sub_tool_call') && event.name === 'bash_start') window.dispatchEvent(new CustomEvent('loopra:bash-start'));
        // Every sub-agent run gets its own tab next to the conversation and files.
        // Opening it without selecting keeps the answer the user is watching in view.
        if (event.type === 'sub_start' && event.subSessionId && target?.name) {
          const label = event.name && event.title ? `${event.name}：${event.title}` : event.name || event.title || event.task || '子代理';
          const targetEditorKey = `${server}/${target.workspaceHash}`;
          setWorkspaceEditors(current => ({ ...current, [targetEditorKey]: ensureSubAgentTab(current[targetEditorKey] || emptyWorkspaceTabs,
            { subSessionId: event.subSessionId!, sessionName: target!.name!, label }) }));
        }
        petAnswer = applyEvent(petAnswer, event);
        setSessions(current => current.map(item => item.id === id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? applyEvent(entry, event) : entry) } : item));
      }, controller.signal);
      completed = true;
      const preview = petReplyPreview(petAnswer);
      if (preview && visible()) setPetReply({ id: answerId, text: preview });
      const stopped = acpStopMessage(agentStopReason);
      if (sameServer() && (stopped || preferences.notifications)) notify(`${visible() ? '' : `${target.title || target.name}：`}${stopped || '回复已完成'}`);
      if (!stopped && preferences.sound) playCompletionSound();
    } catch (error) {
      occupiedFailure = !!target && sameServer() && !controller.signal.aborted && !request.stopping && isSessionOccupiedError(error);
      if (occupiedFailure && target) {
        const id = target.id;
        recordSessionOccupancy(id, true);
        if (!resumed) setSessions(current => current.map(item => item.id === id
          ? { ...item, messages: item.messages.filter(entry => entry.id !== answerId && entry.id !== message.id) } : item));
        if (queuedItem) replaceQueue({ ...queuedRef.current, [target.id]: [queuedItem, ...(queuedRef.current[target.id] || [])] });
        const view = composerViewRef.current;
        if (!silent && !queuedSession && view.server === server && view.activeId === target.id && !view.draft) {
          setDraft(draft);
          setComposerContext(sourceContext);
        }
      } else if (sameServer()) {
        const content = controller.signal.aborted || request.stopping ? '> 本次回复已停止。' : `> 请求失败：${error instanceof Error ? error.message : error}`;
        if (visible()) setPetReply({ id: answerId, text: content.replace(/^> /, ''), activity: controller.signal.aborted || request.stopping ? 'idle' : 'failed' });
        setSessions(current => current.map(item => item.id === target?.id ? { ...item, messages: item.messages.map(entry => entry.id === answerId ? applyEvent(entry, { type: 'content', content: `\n\n${content}` }) : entry) } : item));
        notify(`${visible() ? '' : `${target?.title || target?.name || '会话'}：`}${content.replace(/^> /, '')}`);
      }
    } finally {
      // Do not let a late abort handler cancel the queued replacement turn.
      await request.stopPromise;
      if (target && sameServer()) {
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
          if (sameServer() && (occupiedFailure || (completed && !controller.signal.aborted && history.length))) {
            const messages = attachPendingChoices(historyMessages(history), unresolvedChoices(petAnswer.blocks).filter(choice => !choice.permissionRequestId));
            setSessions(current => current.map(item => item.id === id ? { ...item, messages } : item));
          }
        } catch { /* Keep the already received stream if history reload fails. */ }
        if (action === 'execute_plan') { try { const mode = await api.request<{ mode: string; pendingPlan?: string | null }>(`/agent/mode?${sessionQuery(target)}`, 'GET'); if (visible()) { setComposerOptions(current => ({ ...current, plan: mode.mode === 'plan' })); setPendingPlan(mode.pendingPlan || undefined); } } catch { /* keep the stream-derived state */ } }
      }
      const released = runs.finish(request, !!target && !visible() && !occupiedFailure);
      if (released && sameServer()) {
        for (const key of Object.keys(queuedRef.current)) {
          if (queuedRef.current[key]?.length) void sendQueuedMessage(key);
        }
      }
    }
    return !occupiedFailure;
  }

  useEffect(() => {
    setGitBranch('工作区');
  }, [api, workspace]);
  useEffect(() => {
    if (backend.workspaces.some(item => item.hash === workspace)) writeLastWorkspace(localStorage, workspace);
  }, [workspace, backend.workspaces]);
  useEffect(() => {
    if (backend.status !== 'connected' || !workspace || workspace === CHAT_WORKSPACE.hash) return;
    const controller = new AbortController();
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void api.request<{ branch: string; initialized: boolean }>(`/git/status?workspaceHash=${encodeURIComponent(workspace)}`, 'GET', undefined, controller.signal)
        .then(data => { if (!controller.signal.aborted && current === request) setGitBranch(data.initialized ? data.branch || 'HEAD' : '未初始化'); }).catch(() => {});
    };
    refresh();
    const unwatch = watchWorkspaceChanges(workspace, refresh);
    return () => { controller.abort(); unwatch(); };
  }, [api, workspace, backend.status]);
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
    setAgentSettings(current => ({ ...current, serverUrl: server, projectPath: config.workspace, defaultWorkspace: backend.workspaces.find(item => item.path === config.workspace)?.name || backend.workspaces[0]?.name || '', tools: backend.tools, skills: backend.skills, systemPrompt: backend.prompt, validatorModel: config.validationModel ? `${config.validationModelChannelId}:${config.validationModel}` : '', imageModel: config.imageUnderstandingModel ? `${config.imageUnderstandingModelChannelId}:${config.imageUnderstandingModel}` : '', toolModel: config.toolModel ? `${config.toolModelChannelId}:${config.toolModel}` : '' }));
    // A refresh must not discard the project the user just chose. An empty choice
    // restores the last selection before falling back to the configured project.
    setWorkspace(current => preferredWorkspace(current, backend.workspaces, readLastWorkspace(localStorage), config.workspace));
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
  // A backend change detaches only its local streams; server tasks keep running.
  useEffect(() => () => { runs.detach(server); }, [runs, server]);
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
  useLayoutEffect(() => {
    applyDocumentTheme(preferences.theme, systemDark);
    void syncDesktopTheme(preferences.theme).catch(error => console.warn('[desktop-theme] sync failed:', error));
  }, [preferences.theme, systemDark]);
  useEffect(() => {
    const catalog = getModelCatalog(providers);
    if (!catalog.some(model => model.id === composerOptions.modelId) && catalog.length) setComposerOptions(value => ({ ...value, modelId: catalog[0].id }));
    if (!catalog.some(model => model.id === defaultModel) && catalog.length) setDefaultModel(catalog[0].id);
  }, [providers, composerOptions.modelId, defaultModel, setComposerOptions, setDefaultModel]);
  useEffect(() => {
    const catalog = getModelCatalog(providers);
    if ((agentSettings.toolModel && !catalog.some(model => model.id === agentSettings.toolModel)) || (agentSettings.validatorModel && !catalog.some(model => model.id === agentSettings.validatorModel)) || (agentSettings.imageModel && !catalog.some(model => model.id === agentSettings.imageModel && model.imageInput))) {
      setAgentSettings(current => ({ ...current, toolModel: catalog.some(model => model.id === current.toolModel) ? current.toolModel : '', validatorModel: catalog.some(model => model.id === current.validatorModel) ? current.validatorModel : '', imageModel: catalog.some(model => model.id === current.imageModel && model.imageInput) ? current.imageModel : '' }));
    }
  }, [providers, agentSettings.validatorModel, agentSettings.imageModel, agentSettings.toolModel, setAgentSettings]);
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
  useEffect(() => () => { runs.detach(); historyRequest.current?.abort(); clearTimeout(toastTimer.current); }, [runs]);

  const activeInput = session ? pendingInputs[session.id]?.[0] : undefined;
  const nativePet = useNativePet({
    api,
    connected: backend.status === 'connected',
    enabled: agentSettings.petEnabled && !!pets.active,
    name: pets.active?.name,
    label: pets.active?.displayName || pets.active?.name,
    scale: pets.active ? petScale(pets.active) : 0.55,
    activity: petActivity(!!generatingId && generatingId === activeId, session?.messages.at(-1)?.blocks),
    reply: petReply,
    latest: petReplyPreview(session?.messages.filter(message => message.role === 'assistant').at(-1)),
    onDismiss: () => { void saveAgentSettings({ ...agentSettingsRef.current, petEnabled: false }); },
  });
  const composer = <BackgroundTasks key={workspace} api={api} workspaceHash={workspace} connected={backend.status === 'connected' && backend.ready && !chatMode} open={terminal && !chatMode} onOpenChange={setTerminal} notify={notify} toolbarTarget={isHome ? homeTaskToolbar : null} actions={!chatMode && !isHome && session ? <SessionProgress api={api} session={session} revision={progressRevision} externalPlan={generatingId === session.id ? acpPlans[session.id] : undefined} /> : undefined}>{session && isSessionOccupied(session.id)
    ? <SessionOccupiedNotice busy={composerConfigBusy} forking={forkBusy === `${server}::${session.id}`} disabled={backend.status !== 'connected' || !backend.ready} onRetry={retryAgentConfig} onFork={() => void forkOccupiedSession()} />
    : <Composer home={isHome} loading={workspaceLoading} language={preferences.language} draft={draft} onDraft={setDraft} inputRef={textarea}
    agentConfig={{ options: composerAgentOptions, busy: composerConfigBusy, error: (!session && (agentPreferencesError || enginesError || (selectedEngineAvailable === false ? engines.find(item => item.id === agentId)?.detail || '所选 Agent 不可用，请检查安装与模型配置' : ''))) || agentConfigError, onPrepare: retryAgentConfig, onChange: changeAgentConfig }}
    agentId={agentId} engines={engines} acpCommands={session ? acpCommands[session.id] : undefined}
    options={composerOptions} onOptions={saveOptions} context={composerContext} onContext={setComposerContext}
    providers={providers} api={api} workspaceHash={workspace} chatMode={chatMode} sessionName={session?.name || (externalAgent && preparedNewSession.current?.key === agentConfigKey ? preparedNewSession.current.target.name : undefined)} workspaces={projectWorkspaces} connected={backend.status === 'connected'} skillOptions={agentSettings.skills.filter(skill => skill.enabled)} systemPrompt={agentSettings.systemPrompt} petEnabled={agentSettings.petEnabled && !skillsOpen && !schedulesOpen && !pluginPage && !changes && !settingsOpen && !searchOpen && !helpOpen && !sessionsOpen && !requirementsOpen} desktopPet={nativePet.native} pets={pets} petReply={petReply} latestPetReply={petReplyPreview(session?.messages.filter(message => message.role === 'assistant').at(-1))} onPetClose={() => { void saveAgentSettings({ ...agentSettings, petEnabled: false }); }} petActivity={petActivity(!!generatingId && generatingId === activeId, session?.messages.at(-1)?.blocks)} defaultModel={defaultModel} onDefaultModel={saveDefaultModel}
    history={composerHistory}
    busy={!!generatingId || backend.status !== 'connected' || !backend.ready} generating={!!generatingId}
    // Legacy `continueChat` sent the literal `/continue` command so the backend
    // resumes from the existing context (and approves pending HITL) without
    // appending a user message.
    onSend={() => sendMessage()} onStop={() => void stopGeneration()} onContinue={() => sendMessage(externalAgent ? '请继续完成刚才的任务。' : '/continue')}
    onNew={() => newSession()} onClear={() => clearChat()} onTerminal={() => openTerminal()} onManage={() => openSettings('模型供应商')}
    onExport={() => { if (!session) { notify('请先开始一个会话'); return; } downloadText(`chat-${new Date().toISOString().slice(0, 10)}.txt`, chatExportText(getSessionMessages(session))); notify('对话已导出'); }}
    onSessions={() => setSessionsOpen(true)}
    queue={session ? (queuedMessages[session.id] || []) : []} onRemoveQueued={removeQueuedMessage} onGuideQueued={guideQueuedMessage}
    onEditQueued={editQueuedMessage} onMoveQueued={moveQueuedMessage}
    remoteRunning={!!session && remoteRun?.id === session.id} onStopRemote={stopRemoteRun}
    liveSpeed={liveSpeed}
    onOpen={() => { setMenu(null); setTerminal(false); }} notify={notify} />}</BackgroundTasks>;

  // The window controls float over the first row (sidebar brand and conversation
  // header), so the shell has no empty title-bar strip of its own.
  const desktopShell = isDesktopWindow();
  const nativeWindowControls = desktopShell && usesNativeWindowControls(desktopPlatform());
  const toolImageUrl = useCallback((path: string) => api.assetUrl(`/files/image?${new URLSearchParams({ path, workspaceHash: workspace })}`), [api, workspace]);
  return <ToolImageSourceProvider value={toolImageUrl}><AppMotion enabled={preferences.animations}><div className={`desktop-app${desktopShell ? ' is-desktop-shell' : ''}${nativeWindowControls ? ' is-native-controls' : ''}`} data-sidebar={sidebar ? 'open' : 'closed'} data-panel={changes && !chatMode ? 'open' : 'closed'}>
    {desktopShell && <DesktopTitleBar />}
    <div className="app-body">
      {narrow && <button className="sidebar-backdrop" data-open={sidebar} aria-label="关闭侧边栏遮罩" onClick={() => setSidebar(false)} />}
      {sidebarMounted && <Sidebar api={api} open={sidebar} workspacesLoading={workspaceLoading} sessionsLoading={startupPending || backend.sessionsLoading} english={preferences.language === 'English'} workspaces={workspaces} sessions={sessions} runningIds={runningIds} unreadIds={unreadIds} activeId={surfaceOpen ? '' : activeId ?? ''} workspace={workspace} isHome={!surfaceOpen && isHome} expanded={expandedWorkspaces} onExpanded={setExpandedWorkspaces}
        profile={profile}
        onClose={() => setSidebar(false)} onNewSession={hash => newSession(hash)} onSearch={() => { setSearchOpen(true); setMenu(null); }} onSettings={() => openSettings()}
        skillsOpen={skillsOpen} onSkills={() => { setSkillsOpen(true); setSchedulesOpen(false); setPluginPage(''); setMenu(null); if (narrow) setSidebar(false); }}
        schedulesOpen={schedulesOpen} onSchedules={() => { setSchedulesOpen(true); setSkillsOpen(false); setPluginPage(''); setMenu(null); if (narrow) setSidebar(false); }}
        plugins={pluginNav} pluginPage={pluginPage} onOpenPlugin={id => { setPluginPage(id); setSkillsOpen(false); setSchedulesOpen(false); setMenu(null); if (narrow) setSidebar(false); }}
        onRefreshAll={() => void backend.refresh()} onRefreshProject={hash => void refreshProject(hash)} onRefreshSession={entry => void refreshSessionChat(entry)} onManageProject={setProjectDialog}
        onSelectSession={selectSession} onDeleteSession={setDeleteSession} onReorder={reorderWorkspaces} onReorderSessions={reorderSessions} />}
      <main className={`main-area ${changes && !chatMode ? 'has-changes' : ''}`}>
        <Header sidebarOpen={sidebar} onOpenSidebar={() => setSidebar(true)} isHome={surfaceOpen || isHome} workspaceName={workspaceName} session={session} menu={menu} onToggleMenu={toggleMenu}
          chatMode={surfaceOpen || chatMode}
          backend={{ status: backend.status, ready: backend.ready, error: backend.error, version: backend.version }} server={server} onStatus={() => openSettings('服务器')}
          latestVersion={backend.updateCheck?.latestVersion} desktopUpdate={desktopUpdate.state}
          onVersion={desktopUpdate.available ? desktopUpdate.show : openCoreUpdate}
          gitBranch={gitBranch} changesOpen={changes} onToggleChanges={() => setChanges(!changes)} onShowChanges={() => { setChangesTab('git'); setChanges(true); setMenu(null); }}
          applications={visibleApplications(availableApplications)} onOpenWorkspace={application => void openWorkspace(application)} onCopyPath={copyPath}
          onRename={() => { if (!session) return; setRename(session.id); setRenameValue(session.title); setMenu(null); }}
          onRecords={() => { setSessionDetailsTab('events'); setSessionDetails(true); setMenu(null); }}
          onClear={() => { setMenu(null); clearChat(); }}
          onExport={() => { if (!session) return; setMenu(null); downloadText(`chat-${new Date().toISOString().slice(0, 10)}.txt`, chatExportText(getSessionMessages(session))); notify('对话已导出'); }}
          onDelete={() => { if (!session) return; setDeleteSession(session); setMenu(null); }}
          onCopyTitle={() => { if (!session) return; void navigator.clipboard?.writeText(session.title); setMenu(null); notify('已复制会话标题'); }} />
        {skillsOpen && <SkillsAndPluginsPage api={api} tab={capabilitiesTab} onTabChange={setCapabilitiesTab} context={pluginContext} onRefresh={() => backend.refresh()} onPluginsChanged={() => { setPluginNavRevision(value => value + 1); void backend.refresh().catch(cause => notify(`刷新能力失败：${cause instanceof Error ? cause.message : String(cause)}`)); }} onBack={() => setSkillsOpen(false)} />}
        {schedulesOpen && <SchedulesPage api={api} workspaces={projectWorkspaces} sessions={sessions} onBack={() => setSchedulesOpen(false)} onOpenSession={(hash, name) => void openScheduledSession(hash, name).catch(cause => notify(`打开会话失败：${cause instanceof Error ? cause.message : String(cause)}`))} />}
        {pluginPage && <section className="plugin-app-page" aria-label={pluginNav.find(item => item.id === pluginPage)?.title || pluginPage}><PluginFrame api={api} id={pluginPage} name={pluginNav.find(item => item.id === pluginPage)?.title || pluginPage} slot="sidebar" className="plugin-app-frame" context={pluginContext} /></section>}
        <div className="app-chat-workspace" hidden={surfaceOpen}>
        <WorkspaceTabs key={editorKey} api={api} workspaceHash={workspace} state={chatMode ? emptyWorkspaceTabs : editorTabs} onSelect={selectMainTab} onClose={closeFile} onOpen={openFile} notify={notify} onCloseSubAgent={closeSubAgent}><div className={`main-content ${isHome ? 'home-content' : ''}`}>{(!!generatingId || (!!session && remoteRun?.id === session.id)) && <div className="streaming-bar" role="status" aria-label="会话正在执行"><div className="streaming-bar-inner" /></div>}
          <ChatLogs logs={chatLogs.logs} onDismiss={chatLogs.dismiss} onCopy={text => { void navigator.clipboard?.writeText(text).then(() => chatLogs.push({ text: '✅ 日志已复制' })).catch(() => chatLogs.push({ level: 'ERROR', message: '复制失败，请手动选择日志' })); }} />
          {backend.status === 'error' && <div className="backend-error" role="alert"><span>无法连接 Loopra：{backend.error}</span><Button size="sm" variant="flat" onPress={() => void backend.refresh()}>重新连接</Button></div>}
          {isHome ? <HomeView workspacesLoading={workspaceLoading} enginesLoading={workspaceLoading || (enginesLoading && !engines.length)} workspaces={workspaces} workspace={workspace} workspaceName={workspaceName} chatMode={chatMode} menuOpen={menu === 'workspace'} onToggleMenu={() => toggleMenu('workspace')}
            onSelect={selectWorkspace} onManage={() => { setMenu(null); setProjectsOpen(true); }}
            engines={chatMode ? engines.filter(engine => engine.id === 'native') : engines} agentId={agentId} agentDisabled={!!generatingId || !!remoteRun || !agentPreferencesReady || agentSelectionBusy || chatMode} onAgent={switchAgent}
            onTaskToolbarMount={setHomeTaskToolbar}
            onRefreshEngines={() => setEnginesRevision(value => value + 1)}
            isolation={!chatMode ? <IsolationSwitch api={api} workspaceHash={workspace} disabled={!!generatingId || !!remoteRun} notify={notify}
              sessionName={preparedNewSession.current?.key === agentConfigKey ? preparedNewSession.current.target.name : undefined} /> : undefined}>{composer}</HomeView> : <>
            <div className="chat-scroll" ref={scrollArea} onScroll={onChatScroll} aria-busy={historyState?.id === session.id && !historyState.error}><div className="chat-content"><Enter key={session.id}>{historyState?.id === session.id && <SessionHistoryState loading={!historyState.error} error={historyState.error} hasMessages={!!session.messages.length} onRetry={() => void selectSession(session.id)} />}<Messages session={session} loading={generatingId === activeId} scrollRef={scrollArea} offsetsRef={messageOffsets} busy={!!generatingId || !!forkBusy || backend.status !== 'connected' || !backend.ready} notify={notify} onOpenFile={path => openFile({ path, mode: 'content' })} onDiff={openDiff} onRevert={revertChanges} onEdit={fillDraft} onBranch={branchSession} onRollback={setRollbackMessage} onRawEvents={() => { setSessionDetailsTab('events'); setSessionDetails(true); }} /></Enter></div></div>
            <ChatDock items={userMessageDock(getSessionMessages(session))} showScrollButton={showScrollBtn} hasMessages={getSessionMessages(session).length > 0} onJump={jumpToMessage} onScrollBottom={scrollToBottom} onCollapseAll={collapseAllBlocks} />
            <div className="chat-composer-area">{!chatMode && !externalAgent && composerOptions.plan && <PlanReview pendingPlan={pendingPlan} busy={!!generatingId || planBusy} onApprove={() => void approvePlan()} onExit={() => setDiscardPlan(true)} notify={notify} />}{pendingChoices.length > 0 && <ChoicePopup key={pendingChoices.map(choice => choice.id).join('|')} choices={pendingChoices} onSubmit={submitChoices} />}{activeInput && pendingChoices.length === 0 && <ElicitationForm key={activeInput.elicitationRequestId} request={activeInput} onAnswer={(action, content) => answerElicitation(activeInput, action, content)} />}{composer}</div>
          </>}
        </div></WorkspaceTabs>
        </div>
      </main>
      {!chatMode && changesMounted && <button className="workbench-backdrop" data-open={changes} aria-label="关闭工作区面板遮罩" onClick={() => setChanges(false)} />}
      {!chatMode && changesMounted && <ChangesPanel open={changes} plugins={pluginPanels} context={pluginContext} api={api} workspaceHash={workspace} key={`${server}/${session?.id || `draft:${workspace}`}`} initialTab={changesTab} onTabChange={setChangesTab} onOpenFile={openFile} onPathChange={changeFilePath} activeFile={editorTabs.active} sessionName={session?.name || (isHome ? preparedNewSession.current?.target.name : undefined)} sessions={sessions} onAdd={addFileContext} onClose={() => setChanges(false)} notify={notify} />}
    </div>
    {sessionDetails && session && <SessionDetails api={api} session={session} initialTab={sessionDetailsTab} onClose={() => setSessionDetails(false)} notify={notify} />}
    {deleteSession && <ConfirmAction title="删除会话" onClose={() => setDeleteSession(undefined)} action={() => removeSession(deleteSession)}><p>删除 {deleteSession.title} 及其在 Loopra 服务端的记录？此操作不可恢复。</p></ConfirmAction>}
    {projectDialog && <ProjectSessions api={api} workspace={projectDialog} count={sessions.filter(item => item.workspaceHash === projectDialog.hash).length} sessions={sessions.filter(item => item.workspaceHash === projectDialog.hash)} onClose={() => setProjectDialog(undefined)} onRefresh={async () => { await backend.refreshWorkspaces(); }} onCompleted={(kind, sessionNames) => projectMaintained(kind, projectDialog, sessionNames)} onRenamed={(previous, renamed) => { setProjectDialog(renamed); setComposerContext(current => ({ ...current, projects: current.projects.map(name => name === previous.name ? renamed.name : name) })); }} notify={notify} />}
    {projectsOpen && <ProjectManager api={api} workspaces={projectWorkspaces} sessions={sessions} current={workspace} onClose={() => setProjectsOpen(false)} onRefresh={backend.refreshWorkspaces} onAdded={item => { setExpandedWorkspaces(previous => previous.includes(item.hash) ? previous : [...previous, item.hash]); newSession(item.hash); }} onDeleted={item => projectMaintained('delete', item)} notify={notify} />}
    {sessionsOpen && <SessionsManager api={api} sessions={sessions} workspaceHash={workspace} workspaceName={workspaceName} activeId={activeId} onClose={() => setSessionsOpen(false)} onOpen={id => { setSessionsOpen(false); void selectSession(id); }} onNew={() => { setSessionsOpen(false); newSession(); }} onChanged={() => backend.refresh()} notify={notify} />}
    <Help open={helpOpen} onClose={() => setHelpOpen(false)} server={server} />
    {requirementsOpen && <RequirementBoard api={api} onClose={() => setRequirementsOpen(false)} notify={notify} />}
    {rollbackMessage && session && <RollbackMessageDialog hasSnapshot={!!rollbackMessage.snapshotId} onClose={() => setRollbackMessage(undefined)} onConfirm={async rollbackCode => {
      const result = await api.request<{ success: boolean; message: string; rollbackUserText?: string }>(`/snapshots/rollback?${sessionQuery(session)}&${query({ msgId: rollbackMessage.rollbackId, rollbackTimestamp: rollbackMessage.rollbackTimestamp, rollbackCode })}`, 'POST');
      if (!result.success) throw new Error(result.message);
      await refreshCurrentSession(result.rollbackUserText);
    }} />}
    {discardPlan && <ConfirmAction title="退出计划模式" onClose={() => setDiscardPlan(false)} action={exitPlanMode}><p>{pendingPlan ? '待审查计划将被丢弃，且无法恢复。' : '将退出计划模式并恢复全部工具。'}</p></ConfirmAction>}
    <Search workspaces={workspaces} open={searchOpen} onClose={() => setSearchOpen(false)} sessions={sessions} activeId={activeId} onSession={selectSession} onWorkspace={hash => newSession(hash)} />
    <Settings
      pluginContext={pluginContext}
      onOpenSessions={() => { setSettingsOpen(false); openSessionsManager(); }}
      onOpenRequirements={() => { setSettingsOpen(false); setRequirementsOpen(true); }}
      onOpenHelp={() => { setSettingsOpen(false); setHelpOpen(true); }}
      pets={pets}
      standalonePet={nativePet.native}
      onResetPetPosition={nativePet.native ? async () => { await pets.clearDesktop(); await nativePet.reset(); } : undefined}
      onInitPet={initPet}
      updateCheck={backend.updateCheck}
      coreUpdate={coreUpdate}
      desktopUpdate={desktopUpdate.available ? desktopUpdate : undefined}
      onRefresh={() => backend.refresh()}
      workspaces={projectWorkspaces}
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
      onPreferences={savePreferences}
      profileReady={profileReady}
      onEditProfile={() => setProfileOpen(true)}
      providers={providers}
      onProviders={saveProviders}
      sessions={sessions}
      notify={notify}
    />
    {profileOpen && <ProfileEditor profile={profile} english={preferences.language === 'English'} onSave={saveProfile} onClose={() => setProfileOpen(false)} />}
    {!isDesktopWindow() && <CoreServiceUpdateDialog controller={coreUpdate} notify={notify} />}
    <DesktopUpdateDialog controller={desktopUpdate} />
    <Modal isOpen={!!rename} onClose={() => setRename(null)} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog rename-modal', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label="重命名会话"><ModalContent><form className="app-dialog-form" onSubmit={event => { event.preventDefault(); void renameSession(); }}><ModalHeader className="app-dialog-header"><h2>重命名会话</h2></ModalHeader><ModalBody className="app-dialog-body"><Input autoFocus aria-label="会话名称" value={renameValue} onValueChange={setRenameValue} variant="bordered" /></ModalBody><ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" onPress={() => setRename(null)}>取消</Button><Button size="sm" type="submit" color="primary" isDisabled={!renameValue.trim()}>保存</Button></ModalFooter></form></ModalContent></Modal>
    <Toast message={toast}><Check size="1rem" />{toast}</Toast>
  </div></AppMotion></ToolImageSourceProvider>;
}

