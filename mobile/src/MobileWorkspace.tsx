import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { motion } from 'framer-motion';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem, Spinner, Textarea } from '@nextui-org/react';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, CornerDownRight, Folder, ListEnd, LoaderCircle, MessageSquare, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Sparkles, Square, X } from 'lucide-react';
import { CHAT_WORKSPACE, LoopraClient } from '@web/backend';
import type { ChoiceBlockData } from '@web/chat';
import { collectPendingChoices } from '@web/chat';
import { agentEffortLevels, agentOptionLabel, configValue, findAgentOption } from '@web/agent-config';
import { Messages } from '@web/components/Conversation';
import { SessionImageSourceProvider } from '@web/components/ChatImage';
import AgentIcon from '@web/components/AgentIcon';
import ElicitationForm from '@web/components/ElicitationForm';
import type { Session } from '@web/lib';
import { useAppMotion } from '@web/components/Motion';
import { MobileSessionStore, agentConfigKey, emptyView } from './session-store';
import type { QueuedMessage } from './session-store';
import type { MobilePreferences } from './preferences';
import MobileAgentConfig from './components/MobileAgentConfig';
import MobileApprovals from './components/MobileApprovals';
import MobileConnections from './components/MobileConnections';
import MobileConnectionStatus from './components/MobileConnectionStatus';
import MobileDock from './components/MobileDock';
import MobileSheetGrip from './components/MobileSheetGrip';
import { onNativeBack } from './native-back';

type Props = { origin: string; hostname: string; connectionName: string; online: boolean; reconnecting: boolean; reconnectBusy?: boolean; reconnectResult?: number; error: string; onReconnect: () => void; onRenameConnection: (name: string) => Promise<void>; onForgetConnection: () => Promise<void>; onConnectAnother: () => void; preferences: MobilePreferences; onPreferences: (value: MobilePreferences) => void };
type Page = 'threads' | 'projects' | 'chat' | 'connections';
const err = (error: unknown) => error instanceof Error ? error.message : String(error);
const relativeTime = (mtime: number) => {
  const elapsed = Math.max(0, Date.now() - mtime);
  return elapsed < 60000 ? '刚刚' : elapsed < 3600000 ? `${Math.floor(elapsed / 60000)} 分钟前` : elapsed < 86400000 ? `${Math.floor(elapsed / 3600000)} 小时前` : new Date(mtime).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

export default function MobileWorkspace(props: Props) {
  const [store, setStore] = useState<MobileSessionStore>();
  // StrictMode may mount effects twice; each setup owns a fresh store and lifetime.
  useEffect(() => {
    const next = new MobileSessionStore(new LoopraClient(props.origin));
    setStore(next);
    return () => next.dispose();
  }, [props.origin]);
  return store ? <WorkspaceView {...props} store={store} /> : <div className="app-boot"><Spinner label="加载会话" /></div>;
}

function WorkspaceView({ store, ...props }: Props & { store: MobileSessionStore }) {
  const { enabled: animated } = useAppMotion();
  const spring = { type: 'spring' as const, stiffness: 460, damping: 38, mass: .85 };
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [page, setPage] = useState<Page>('threads');
  const [connectionsBack, setConnectionsBack] = useState<'threads' | 'projects'>('threads');
  const [workspace, setWorkspace] = useState(CHAT_WORKSPACE.hash);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sheet, setSheet] = useState<'settings' | 'composer'>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [engine, setEngine] = useState('native');
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [away, setAway] = useState(false);
  const [newReplies, setNewReplies] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const projectFilters = useRef<HTMLDivElement>(null);
  const awayRef = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const thread = data.threads.find(item => item.id === data.selected?.id) || data.selected;
  const view = thread ? data.views[thread.id] || emptyView() : emptyView();
  const api = useMemo(() => new LoopraClient(props.origin), [props.origin]);
  const session: Session = { id: thread?.id || 'new', name: thread?.name, workspaceHash: thread?.workspaceHash, title: thread?.title || '新会话', workspace: thread?.workspaceHash || workspace, kind: 'remote', agentId: thread?.agentId, messages: view.messages };
  const choices = useMemo(() => collectPendingChoices(view.messages), [view.messages]);
  const draftKey = thread?.id || `new:${workspace}`;
  const draft = drafts[draftKey] || '';
  const selectedWorkspace = data.workspaces.find(item => item.hash === (thread?.workspaceHash || workspace));
  const agentId = thread ? thread.agentId || 'native' : workspace === CHAT_WORKSPACE.hash ? 'native' : engine;
  const config = thread ? data.configs[thread.id] : data.draft?.key === agentConfigKey(workspace, agentId) ? data.draft.options : undefined;
  const configLoading = thread ? !!data.configLoading[thread.id] : !config && (data.draftLoading || !data.draftError);
  const configError = thread ? data.configErrors[thread.id] : data.draftError;
  const modelOption = findAgentOption(config, 'model', 'model');
  const effortOption = findAgentOption(config, 'effort', 'thought_level');
  const agentName = data.engines.find(item => item.id === agentId)?.name || agentId;
  const effortLabel = effortOption ? agentEffortLevels(effortOption).find(item => item.value === configValue(effortOption))?.label || agentOptionLabel(effortOption) : '';
  const modelLabel = modelOption ? agentOptionLabel(modelOption) : agentName;
  const sendOptions = { workspaceHash: thread?.workspaceHash || workspace, agentId };
  const visibleThreads = data.threads.filter(item => (filter === 'all' || item.workspaceHash === filter) && (!search || `${item.title || item.name} ${data.workspaces.find(project => project.hash === item.workspaceHash)?.name || ''}`.toLowerCase().includes(search.toLowerCase())));

  useEffect(() => {
    if (!props.online) return;
    void store.refresh();
    const selected = store.getSnapshot().selected;
    if (selected) void store.loadConfig(selected);
    let alive = true;
    const sync = () => { if (alive && !document.hidden) void store.sync(); };
    const timer = window.setInterval(sync, 2500);
    window.addEventListener('focus', sync); document.addEventListener('visibilitychange', sync); sync();
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, [store, props.online]);
  useEffect(() => {
    awayRef.current = false; setAway(false); setNewReplies(false);
    const frame = requestAnimationFrame(() => { if (scroll.current && !awayRef.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [thread?.id, page]);
  useEffect(() => {
    if (page !== 'chat') return;
    if (awayRef.current) { setNewReplies(true); return; }
    const frame = requestAnimationFrame(() => { if (scroll.current && !awayRef.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [view.messages, page]);
  useEffect(() => {
    if (page !== 'threads') return;
    const strip = projectFilters.current;
    if (!strip) return;
    const reveal = () => {
      const selected = strip.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (!selected) return;
      const bounds = strip.getBoundingClientRect();
      const chip = selected.getBoundingClientRect();
      // Scroll only the horizontal strip, leaving the session list in place.
      strip.scrollTo({ left: strip.scrollLeft + chip.left - bounds.left - (strip.clientWidth - chip.width) / 2, behavior: animated ? 'smooth' : 'instant' });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [page, filter, data.workspaces, props.preferences.fontSize, animated]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (page !== 'chat' || thread || !props.online) return;
    void store.prepareDraft(workspace, agentId);
  }, [page, thread?.id, workspace, agentId, store, props.online]);
  useEffect(() => onNativeBack(() => {
    if (sheet) { setSheet(undefined); return true; }
    if (page === 'connections') { setPage(connectionsBack); return true; }
    if (page === 'chat') { setPage('threads'); setActionError(''); return true; }
    if (page === 'projects') { setPage('threads'); return true; }
    if (search) { setSearch(''); return true; }
    if (filter !== 'all') { setFilter('all'); return true; }
    return false;
  }), [sheet, page, connectionsBack, search, filter]);
  // visualViewport tracks the usable WebView height when Android's keyboard opens.
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty('--phone-height', `${viewport?.height || window.innerHeight}px`);
    resize(); viewport?.addEventListener('resize', resize);
    return () => { viewport?.removeEventListener('resize', resize); document.documentElement.style.removeProperty('--phone-height'); };
  }, []);

  function newThread() {
    setActionError('');
    if (filter !== 'all') setWorkspace(filter);
    void store.select(); setPage('chat');
  }
  function submit() {
    if (!draft.trim() || pending || view.loading || data.configBusy || !props.online) return;
    const text = draft;
    const queueing = view.running;
    setActionError(''); setPending(true);
    awayRef.current = false; setAway(false);
    // Keep failed prompts recoverable; clear only once the store has accepted a run.
    void store.send(text, sendOptions, false, () => {
      setDrafts(current => current[draftKey] === text ? { ...current, [draftKey]: '' } : current); setPending(false);
      if (queueing) setNotice('已加入队列');
    }).catch(cause => setActionError(err(cause))).finally(() => setPending(false));
  }
  function editQueued(item: QueuedMessage) {
    if (!thread) return;
    store.removeQueued(thread.id, item.id);
    setDrafts(current => ({ ...current, [draftKey]: item.text }));
    requestAnimationFrame(() => textarea.current?.focus());
  }
  function guideQueued(item: QueuedMessage) {
    if (!thread) return;
    store.promoteQueued(thread.id, item.id);
    setStopping(true); setActionError('');
    void store.stop().catch(cause => setActionError(err(cause))).finally(() => setStopping(false));
  }
  const answer = async (choice: ChoiceBlockData, value: string, title: string) => { await store.answer(choice, value, title, sendOptions); };
  const goBottom = () => { awayRef.current = false; setAway(false); setNewReplies(false); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); };
  const openProject = (hash: string) => { setWorkspace(hash); setFilter(hash); setPage('threads'); };
  const openConnections = () => {
    if (page === 'threads' || page === 'projects') setConnectionsBack(page);
    setSheet(undefined); setPage('connections');
  };
  async function changeAgentConfig(configId: string, value: string | boolean) {
    if (thread) {
      await store.changeConfig({ workspaceHash: thread.workspaceHash, sessionName: thread.name, agentId: thread.agentId || 'native', threadId: thread.id }, configId, value);
      return;
    }
    const draft = data.draft?.key === agentConfigKey(workspace, agentId) ? data.draft : await store.prepareDraft(workspace, agentId);
    if (!draft) throw new Error(data.draftError || '读取智能体配置失败');
    await store.changeConfig({ workspaceHash: draft.workspaceHash, sessionName: draft.sessionName, agentId: draft.agentId }, configId, value);
  }
  function retryAgentConfig() {
    if (thread) void store.loadConfig(thread);
    else void store.prepareDraft(workspace, agentId);
  }

  return <main className={`phone-shell ${page === 'chat' ? 'is-chat' : ''}`}>
    <header className={`app-header ${page === 'chat' || page === 'connections' ? 'app-chat-header' : ''}`}>
      {page === 'chat' ? <>
        <button type="button" className="app-icon-button" aria-label="返回会话列表" disabled={pending && !view.running} onClick={() => { setPage('threads'); setActionError(''); }}><ArrowLeft size={21} /></button>
        <div className="app-chat-heading"><h1>{thread?.title || '新会话'}</h1><span>{selectedWorkspace?.displayName || selectedWorkspace?.name || '纯聊天'}</span></div>
        <button type="button" className="app-icon-button" aria-label="回复设置" onClick={() => setSheet('composer')}><SlidersHorizontal size={20} /></button>
      </> : page === 'connections' ? <>
        <button type="button" className="app-icon-button" aria-label="返回" onClick={() => setPage(connectionsBack)}><ArrowLeft size={21} /></button>
        <div className="app-chat-heading"><h1>连接管理</h1></div>
        <span className="app-chat-spacer" />
      </> : <>
        <div className="app-brand">
          <span className="app-mark"><img src={`${import.meta.env.BASE_URL}loopra-logo.svg`} alt="" aria-hidden="true" /></span>
          <div><strong>Loopra</strong><span className="app-connection"><i className={props.online ? 'online' : ''} /><span className="app-connection-name">{props.connectionName || props.hostname}</span></span></div>
        </div>
        <div className="app-header-actions">
          <button type="button" className="app-icon-button" aria-label="刷新会话" disabled={data.loading || !props.online} onClick={() => void store.refresh()}><RefreshCw size={19} className={data.loading ? 'app-spin' : ''} /></button>
          <button type="button" className="app-icon-button" aria-label="设置" onClick={() => setSheet('settings')}><Settings size={20} /></button>
        </div>
      </>}
    </header>
    <MobileConnectionStatus online={props.online} reconnecting={props.reconnecting} busy={!!props.reconnectBusy} result={props.reconnectResult} error={props.error} onReconnect={props.onReconnect} />
    <motion.div key={page} className="app-page" initial={animated ? { opacity: 0, y: 10 } : false} animate={{ opacity: 1, y: 0 }} transition={animated ? { duration: .22, ease: [.22, 1, .36, 1] } : { duration: 0 }} onAnimationComplete={() => { if (page === 'chat' && scroll.current && !awayRef.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>
      {page === 'threads' ? <div className="app-scroll">
        <div className="screen-heading"><h1>会话</h1><span className="screen-count">{visibleThreads.length}</span></div>
        <label className="search-field">
          <Search size={18} aria-hidden="true" />
          <input type="search" aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={event => setSearch(event.target.value)} />
          {search && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button>}
        </label>
        <div ref={projectFilters} className="filter-strip" role="group" aria-label="项目筛选">
          <button type="button" className="filter-chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
          {data.workspaces.map(item => <button key={item.hash} type="button" className="filter-chip" aria-pressed={filter === item.hash} onClick={() => setFilter(item.hash)}>{item.displayName || item.name}</button>)}
        </div>
        {data.loading && !data.threads.length ? <div className="app-panel loading-state"><Spinner size="sm" label="加载会话" /></div> : visibleThreads.length ? <div className="app-panel thread-panel">{visibleThreads.map(item => {
          const project = data.workspaces.find(candidate => candidate.hash === item.workspaceHash);
          const running = data.views[item.id]?.running;
          return <button key={item.id} type="button" className="thread-row" onClick={() => { setActionError(''); setPage('chat'); void store.select(item); }}>
            <span className="thread-avatar"><AgentIcon agentId={item.agentId || 'native'} /></span>
            <span className="thread-copy"><strong>{item.title || item.name}</strong><span>{project?.displayName || project?.name || '纯聊天'}</span></span>
            <span className="thread-trailing"><time>{relativeTime(item.mtime)}</time>{running && <span className="thread-live"><i />回复中</span>}</span>
          </button>;
        })}</div> : <div className="app-panel empty-state">
          <span className="empty-orb">{search || filter !== 'all' ? <Search size={24} /> : <MessageSquare size={24} />}</span>
          <strong>{search || filter !== 'all' ? '没有找到会话' : '还没有会话'}</strong>
          <p>{search || filter !== 'all' ? '换个关键词或项目试试。' : '从一个问题开始。'}</p>
          {search || filter !== 'all' ? <button type="button" className="empty-action" onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button> : <button type="button" className="empty-action" onClick={newThread}><Plus size={16} />新建会话</button>}
        </div>}
        {props.online && data.error && <div className="app-error-panel" role="alert"><p>{data.error}</p><button type="button" onClick={() => void store.refresh()}>重试</button></div>}
      </div> : page === 'projects' ? <div className="app-scroll">
        <div className="screen-heading"><h1>项目</h1><span className="screen-count">{data.workspaces.length}</span></div>
        {data.loading && !data.workspaces.length ? <div className="app-panel loading-state"><Spinner size="sm" label="加载项目" /></div> : <div className="project-grid">{data.workspaces.map(item => {
          const ProjectIcon = item.hash === CHAT_WORKSPACE.hash ? MessageSquare : Folder;
          const count = data.threads.filter(thread => thread.workspaceHash === item.hash).length;
          return <button key={item.hash} type="button" className="project-card" onClick={() => openProject(item.hash)}>
            <span className="project-icon"><ProjectIcon size={20} /></span>
            <ChevronRight size={16} className="project-chevron" aria-hidden="true" />
            <span className="project-name">{item.displayName || item.name}</span>
            <p>{count} 个会话</p>
          </button>;
        })}</div>}
        {props.online && data.error && <div className="app-error-panel" role="alert"><p>{data.error}</p><button type="button" onClick={() => void store.refresh()}>重试</button></div>}
      </div> : page === 'connections' ? <MobileConnections name={props.connectionName} host={props.hostname} online={props.online} reconnecting={props.reconnecting} busy={!!props.reconnectBusy} onRename={props.onRenameConnection} onReconnect={props.onReconnect} onConnectAnother={props.onConnectAnother} onForget={props.onForgetConnection} /> : <div className="chat-page">
        <div className="chat-stage"><div className="chat-surface">
          <div ref={scroll} className="phone-chat-scroll" onScroll={() => {
            const node = scroll.current; if (!node) return;
            const next = node.scrollHeight - node.scrollTop - node.clientHeight > 90;
            awayRef.current = next; setAway(next); if (!next) setNewReplies(false);
          }} aria-label="聊天记录" aria-busy={view.loading}>
            <div className="chat-scroll-inner">
              {view.loading && <div className="chat-loading"><Spinner size="sm" label="读取聊天记录" /></div>}
              {!view.loading && !view.messages.length && <div className="chat-empty"><span className="chat-empty-orb"><img src={`${import.meta.env.BASE_URL}loopra-logo.svg`} alt="" /></span><h2>{thread ? '开始这段对话' : '今天想做些什么？'}</h2></div>}
              <SessionImageSourceProvider api={api} workspaceHash={thread?.workspaceHash || workspace} sessionName={thread?.name}><Messages session={session} loading={view.running} scrollRef={scroll} busy={view.running || !props.online} notify={setNotice} onEdit={text => { setDrafts(current => ({ ...current, [draftKey]: text })); textarea.current?.focus(); }} /></SessionImageSourceProvider>
              {props.online && view.error && <div className="chat-inline-error" role="alert"><p>{view.error}</p><button type="button" onClick={() => { if (thread) void store.select(thread); }}>重新读取</button></div>}
            </div>
          </div>
          <div className="composer-zone">
            {away && <button type="button" className="jump-latest" onClick={goBottom}><ArrowDown size={15} />{newReplies ? '有新回复' : '回到最新'}</button>}
            {actionError && <p className="app-inline-error" role="alert">{actionError}</p>}
            {view.queued.length > 0 && <section className="phone-queue" aria-label={`排队消息 ${view.queued.length} 条`}>
              <div className="phone-queue-head"><ListEnd size={15} /><span>排队 {view.queued.length}</span></div>
              <ol className="phone-queue-list">{view.queued.map((item, index) => <li key={item.id}>
                <button type="button" className="phone-queue-text" title={item.text} aria-label={`编辑排队消息：${item.text}`} onClick={() => editQueued(item)}><span>{item.text}</span></button>
                {view.running && index > 0 && <button type="button" className="phone-queue-guide" title="停止当前回复并优先发送" aria-label="优先发送这条排队消息" disabled={stopping} onClick={() => guideQueued(item)}><CornerDownRight size={15} /></button>}
                <button type="button" className="phone-queue-remove" aria-label="撤回排队消息" onClick={() => { if (thread) { store.removeQueued(thread.id, item.id); setNotice('已撤回排队消息'); } }}><X size={15} /></button>
              </li>)}</ol>
            </section>}
            {choices.length > 0 && <MobileApprovals key={choices[0].id} choices={choices} onAnswer={answer} />}
            {!!view.inputs?.length && <ElicitationForm key={view.inputs[0].elicitationRequestId} request={view.inputs[0]} draftKey={`${props.origin}:${thread?.id}:${view.inputs[0].elicitationRequestId}`} onAnswer={(action, content) => store.answerInput(view.inputs![0].elicitationRequestId, action, content)} />}
            {!thread && <Select aria-label="会话项目" className="new-session-context" size="sm" variant="flat" selectedKeys={[workspace]} onSelectionChange={keys => { const key = [...keys][0]; if (key) setWorkspace(String(key)); }} isDisabled={pending} startContent={<Folder size={15} />}>{data.workspaces.map(item => <SelectItem key={item.hash} textValue={item.displayName || item.name}>{item.displayName || item.name}</SelectItem>)}</Select>}
            <form className="phone-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
              <Textarea ref={textarea} aria-label="消息" placeholder="发消息给 Loopra…" value={draft} onValueChange={value => setDrafts(current => ({ ...current, [draftKey]: value }))} minRows={1} maxRows={5} variant="flat" classNames={{ base: 'phone-message-input', inputWrapper: 'phone-input-wrapper', input: 'phone-input' }} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
              <div className="phone-composer-toolbar">
                <button type="button" className="composer-model" aria-label={`模型与配置：${modelLabel}${effortLabel ? ` · ${effortLabel}` : ''}`} onClick={() => setSheet('composer')}>{configLoading || data.configBusy ? <LoaderCircle size={14} className="app-spin" /> : <Sparkles size={14} />}<span>{modelLabel}</span><ChevronDown size={13} /></button>
                <span className="composer-effort">{effortLabel}</span>
                <div className="composer-send-actions">
                  {view.running && <button type="button" className="composer-send is-stop" aria-label="停止回复" disabled={stopping} onClick={() => { setStopping(true); setActionError(''); void store.stop().catch(cause => setActionError(err(cause))).finally(() => setStopping(false)); }}>{stopping ? <LoaderCircle size={18} className="app-spin" /> : <Square size={15} fill="currentColor" />}</button>}
                  <button type="submit" className={`composer-send ${view.running ? 'is-queue' : ''}`} aria-label={view.running ? '加入队列' : '发送消息'} disabled={!draft.trim() || pending || view.loading || data.configBusy || !props.online}>{pending ? <LoaderCircle size={18} className="app-spin" /> : <ArrowUp size={21} />}</button>
                </div>
              </div>
            </form>
          </div>
        </div></div>
      </div>}
    </motion.div>
    {(page === 'threads' || page === 'projects') && <MobileDock page={page} onPage={setPage} onNew={newThread} disabled={data.loading || !props.online} />}
    <Modal isOpen={!!sheet} onClose={() => setSheet(undefined)} placement="bottom-center" backdrop="blur" scrollBehavior="inside" motionProps={animated ? { initial: { opacity: 0, y: 38, scale: .99 }, animate: { opacity: 1, y: 0, scale: 1, transition: spring }, exit: { opacity: 0, y: 24, transition: { duration: .16 } } } : undefined} classNames={{ base: 'phone-sheet', backdrop: 'phone-sheet-backdrop', closeButton: 'phone-sheet-close', header: 'phone-sheet-header', body: 'phone-sheet-body', footer: 'phone-sheet-footer' }}>
      <ModalContent>
        <MobileSheetGrip onDismiss={() => setSheet(undefined)} />
        <ModalHeader>{sheet === 'settings' ? '设置' : '回复设置'}</ModalHeader>
        <ModalBody>
          {sheet === 'settings' ? <>
            <section className="sheet-group">
              <div className="sheet-group-title">外观</div>
              <div className="setting-row"><span>主题</span><div className="segmented" role="group" aria-label="主题">{([{ value: 'system', label: '自动' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }] as const).map(item => <button key={item.value} type="button" aria-pressed={props.preferences.theme === item.value} className={props.preferences.theme === item.value ? 'is-active' : ''} onClick={() => props.onPreferences({ ...props.preferences, theme: item.value })}>{item.label}</button>)}</div></div>
              <div className="setting-row"><span>字号</span><div className="segmented" role="group" aria-label="界面字号">{[15, 16, 18].map(size => <button key={size} type="button" aria-pressed={props.preferences.fontSize === size} className={props.preferences.fontSize === size ? 'is-active' : ''} onClick={() => props.onPreferences({ ...props.preferences, fontSize: size })}>{size === 15 ? '小' : size === 16 ? '标准' : '大'}</button>)}</div></div>
            </section>
            <section className="sheet-group">
              <div className="sheet-group-title">桌面连接</div>
              <button type="button" className="sheet-connection" onClick={openConnections}><span className={`connection-dot ${props.online ? 'online' : ''}`} aria-hidden="true" /><div><strong>{props.connectionName || props.hostname}</strong><span>{props.reconnecting ? props.online ? '正在检查连接' : '正在重新连接' : props.online ? '已连接' : '离线'}</span></div><ChevronRight size={17} /></button>
            </section>
          </> : <>
            {!thread && workspace !== CHAT_WORKSPACE.hash && <div className="sheet-field"><span>智能体</span><Select aria-label="智能体" variant="flat" selectedKeys={[engine]} isDisabled={pending} onSelectionChange={keys => { const key = [...keys][0]; if (key) setEngine(String(key)); }}>{(data.engines.length ? data.engines : [{ id: 'native', name: 'Loopra Native', available: true }]).map(item => <SelectItem key={item.id} isDisabled={!item.available}>{item.name}</SelectItem>)}</Select></div>}
            <MobileAgentConfig label={thread ? agentName : '智能体配置'} options={config} loading={configLoading} error={configError} disabled={!props.online || pending || view.running || view.loading || data.configBusy} onChange={changeAgentConfig} onRetry={retryAgentConfig} />
          </>}
        </ModalBody>
        <ModalFooter><button type="button" className="sheet-done" onClick={() => setSheet(undefined)}>完成</button></ModalFooter>
      </ModalContent>
    </Modal>
    {notice && <div role="status" className="app-toast">{notice}</div>}
  </main>;
}
