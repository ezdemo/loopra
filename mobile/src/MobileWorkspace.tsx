import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem, Spinner, Textarea } from '@nextui-org/react';
import { ArrowDown, ArrowLeft, ArrowUp, ChevronDown, Folder, MessageSquare, RefreshCw, Search, Settings, SlidersHorizontal, Square, Unplug } from 'lucide-react';
import { CHAT_WORKSPACE, LoopraClient } from '@web/backend';
import type { ChoiceBlockData } from '@web/chat';
import { collectPendingChoices } from '@web/chat';
import { Messages } from '@web/components/Conversation';
import { SessionImageSourceProvider } from '@web/components/ChatImage';
import ElicitationForm from '@web/components/ElicitationForm';
import type { Session } from '@web/lib';
import { useAppMotion } from '@web/components/Motion';
import { MobileSessionStore, emptyView, modelChoices } from './session-store';
import type { MobilePreferences } from './preferences';
import MobileApprovals from './components/MobileApprovals';
import LiquidNavigation from './components/LiquidNavigation';

type Props = { origin: string; hostname: string; online: boolean; error: string; onReconnect: () => void; onDisconnect: () => void; preferences: MobilePreferences; onPreferences: (value: MobilePreferences) => void };
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
    setStore(next); void next.refresh();
    return () => next.dispose();
  }, [props.origin]);
  return store ? <WorkspaceView {...props} store={store} /> : <div className="phone-centered"><Spinner label="加载会话" /></div>;
}

function WorkspaceView({ store, ...props }: Props & { store: MobileSessionStore }) {
  const { enabled: animated } = useAppMotion();
  const spring = { type: 'spring' as const, stiffness: 460, damping: 38, mass: .85 };
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [page, setPage] = useState<'threads' | 'projects' | 'chat'>('threads');
  const [workspace, setWorkspace] = useState(CHAT_WORKSPACE.hash);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sheet, setSheet] = useState<'settings' | 'composer'>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [modelId, setModelId] = useState('default');
  const [effort, setEffort] = useState('');
  const [engine, setEngine] = useState('native');
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [away, setAway] = useState(false);
  const [newReplies, setNewReplies] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const awayRef = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const thread = data.threads.find(item => item.id === data.selected?.id) || data.selected;
  const view = thread ? data.views[thread.id] || emptyView() : emptyView();
  const api = useMemo(() => new LoopraClient(props.origin), [props.origin]);
  const session: Session = { id: thread?.id || 'new', name: thread?.name, workspaceHash: thread?.workspaceHash, title: thread?.title || '新会话', workspace: thread?.workspaceHash || workspace, kind: 'remote', agentId: thread?.agentId, messages: view.messages };
  const choices = useMemo(() => collectPendingChoices(view.messages), [view.messages]);
  const draftKey = thread?.id || `new:${workspace}`;
  const draft = drafts[draftKey] || '';
  const models = useMemo(() => modelChoices(data.config), [data.config]);
  const selectedModel = models.find(model => model.id === modelId);
  const selectedWorkspace = data.workspaces.find(item => item.hash === (thread?.workspaceHash || workspace));
  const native = (thread?.agentId || engine) === 'native';
  const sendOptions = { workspaceHash: thread?.workspaceHash || workspace, agentId: thread?.agentId || engine, model: native ? selectedModel : undefined, effort: native && effort ? effort : undefined };
  const visibleThreads = data.threads.filter(item => (filter === 'all' || item.workspaceHash === filter) && (!search || `${item.title || item.name} ${data.workspaces.find(project => project.hash === item.workspaceHash)?.name || ''}`.toLowerCase().includes(search.toLowerCase())));

  useEffect(() => {
    if (!props.online) return;
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
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (page !== 'chat' || !thread) return; setModelId('default'); setEffort(''); }, [thread?.id, page]);
  // visualViewport tracks the usable WebView height when Android's keyboard opens.
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty('--phone-height', `${viewport?.height || window.innerHeight}px`);
    resize(); viewport?.addEventListener('resize', resize);
    return () => { viewport?.removeEventListener('resize', resize); document.documentElement.style.removeProperty('--phone-height'); };
  }, []);

  function newThread() {
    setActionError(''); setModelId('default'); setEffort('');
    if (filter !== 'all') setWorkspace(filter);
    void store.select(); setPage('chat');
  }
  function submit() {
    if (!draft.trim() || pending || view.running || view.loading || !props.online) return;
    const text = draft;
    setActionError(''); setPending(true);
    awayRef.current = false; setAway(false);
    // Keep failed prompts recoverable; clear only once the store has accepted a run.
    void store.send(text, sendOptions, false, () => {
      setDrafts(current => current[draftKey] === text ? { ...current, [draftKey]: '' } : current); setPending(false);
    }).catch(cause => setActionError(err(cause))).finally(() => setPending(false));
  }
  const answer = async (choice: ChoiceBlockData, value: string, title: string) => { await store.answer(choice, value, title, sendOptions); };
  const goBottom = () => { awayRef.current = false; setAway(false); setNewReplies(false); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); };

  return <main className={`phone-shell ${page === 'chat' ? 'is-chat' : ''}`} style={{ '--phone-body-size': `${props.preferences.fontSize / 16}rem` } as CSSProperties}>
    <header className={`phone-header ${page !== 'chat' ? 'phone-header-large' : ''}`}>
      {page === 'chat' ? <Button className="phone-icon" isIconOnly variant="light" aria-label="返回会话列表" isDisabled={pending && !view.running} onPress={() => { setPage('threads'); setActionError(''); }}><ArrowLeft size={22} /></Button> : <img src="/loopra-logo.svg" alt="" className="phone-header-logo" />}
      <div className="phone-title"><h1>{page === 'chat' ? thread?.title || '新会话' : page === 'projects' ? '项目' : '会话'}</h1>{page === 'chat' ? <span>{selectedWorkspace?.displayName || selectedWorkspace?.name || '纯聊天'}</span> : <button type="button" onClick={() => setSheet('settings')}><i className={props.online ? 'online' : ''} />{props.hostname}<ChevronDown size={12} /></button>}</div>
      {page !== 'chat' && <Button className="phone-icon" isIconOnly variant="light" aria-label="刷新会话" isDisabled={data.loading || !props.online} onPress={() => void store.refresh()}><RefreshCw size={20} className={data.loading ? 'phone-spin' : ''} /></Button>}
      <Button className="phone-icon" isIconOnly variant="light" aria-label={page === 'chat' ? '会话选项' : '设置'} onPress={() => setSheet(page === 'chat' ? 'composer' : 'settings')}>{page === 'chat' ? <SlidersHorizontal size={21} /> : <Settings size={21} />}</Button>
    </header>
    {!props.online && <div className="phone-offline" role="status"><span>{props.error || '桌面连接已断开'}</span><Button size="sm" onPress={props.onReconnect}>重连</Button></div>}
    <AnimatePresence initial={false} mode="wait"><motion.div key={page} className="phone-page" initial={animated ? { opacity: 0, x: page === 'chat' ? 22 : -12 } : false} animate={{ opacity: 1, x: 0 }} exit={animated ? { opacity: 0, x: page === 'chat' ? 14 : -8 } : { opacity: 1 }} transition={animated ? { duration: .2, ease: [.22, 1, .36, 1] } : { duration: 0 }}>
    {page === 'chat' ? <>
      <div ref={scroll} className="phone-chat-scroll" onScroll={() => {
        const node = scroll.current; if (!node) return;
        const next = node.scrollHeight - node.scrollTop - node.clientHeight > 90;
        awayRef.current = next; setAway(next); if (!next) setNewReplies(false);
      }} aria-label="聊天记录" aria-busy={view.loading}>
        <div className="phone-chat-column">
          {view.loading && <div className="phone-load"><Spinner size="sm" label="读取聊天记录" /></div>}
          {!view.loading && !view.messages.length && <div className="phone-chat-empty"><img src="/loopra-logo.svg" alt="" /><h2>{thread ? '开始这段对话' : '今天想做些什么？'}</h2></div>}
          <SessionImageSourceProvider api={api} workspaceHash={thread?.workspaceHash || workspace} sessionName={thread?.name}><Messages session={session} loading={view.running} scrollRef={scroll} busy={view.running || !props.online} notify={setNotice} onEdit={text => { setDrafts(current => ({ ...current, [draftKey]: text })); textarea.current?.focus(); }} /></SessionImageSourceProvider>
          {view.error && <div className="phone-inline-error" role="alert"><p>{view.error}</p><Button variant="light" size="sm" onPress={() => { if (thread) void store.select(thread); }}>重新读取</Button></div>}
        </div>
      </div>
      <div className="phone-composer-area">
        {away && <Button className="phone-latest" size="sm" variant="bordered" onPress={goBottom} startContent={<ArrowDown size={16} />}>{newReplies ? '有新回复' : '回到最新'}</Button>}
        {actionError && <p className="phone-error" role="alert">{actionError}</p>}
        {choices.length > 0 && <MobileApprovals key={choices[0].id} choices={choices} onAnswer={answer} />}
        {!!view.inputs?.length && <ElicitationForm key={view.inputs[0].elicitationRequestId} request={view.inputs[0]} draftKey={`${props.origin}:${thread?.id}:${view.inputs[0].elicitationRequestId}`} onAnswer={(action, content) => store.answerInput(view.inputs![0].elicitationRequestId, action, content)} />}
        {!thread && <Select aria-label="会话项目" className="phone-new-project" size="sm" variant="flat" selectedKeys={[workspace]} onSelectionChange={keys => { const key = [...keys][0]; if (key) setWorkspace(String(key)); }} isDisabled={pending} startContent={<Folder size={15} />}>{data.workspaces.map(item => <SelectItem key={item.hash} textValue={item.displayName || item.name}>{item.displayName || item.name}</SelectItem>)}</Select>}
        <form className="phone-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
          <Textarea ref={textarea} aria-label="消息" placeholder="发消息给 Loopra…" value={draft} onValueChange={value => setDrafts(current => ({ ...current, [draftKey]: value }))} minRows={1} maxRows={5} variant="flat" classNames={{ base: 'phone-message-input', inputWrapper: 'phone-input-wrapper', input: 'phone-input' }} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
          <div className="phone-composer-toolbar"><Button className="phone-model-button" size="sm" variant="light" onPress={() => setSheet('composer')} endContent={<ChevronDown size={13} />}>{native ? selectedModel?.label || data.config?.model || '桌面默认模型' : data.engines.find(item => item.id === (thread?.agentId || engine))?.name || thread?.agentId || engine}</Button>
            <span className="phone-composer-effort">{native && effort ? ({ low: '低', medium: '中', high: '高', xhigh: '最高' } as Record<string, string>)[effort] : ''}</span>
            {view.running ? <Button className="phone-send" isIconOnly color="primary" aria-label="停止回复" isLoading={stopping} onPress={() => { setStopping(true); setActionError(''); void store.stop().catch(cause => setActionError(err(cause))).finally(() => setStopping(false)); }}><Square size={16} fill="currentColor" /></Button> : <Button className="phone-send" type="submit" isIconOnly color="primary" aria-label="发送消息" isLoading={pending} isDisabled={!draft.trim() || pending || view.loading || !props.online}><ArrowUp size={21} /></Button>}
          </div>
        </form>
      </div>
    </> : <>
      <div className="phone-list-scroll">
        {page === 'threads' ? <>
          <div className="phone-list-controls"><Input aria-label="搜索会话" placeholder="搜索会话" value={search} onValueChange={setSearch} startContent={<Search size={17} />} variant="flat" className="phone-search" isClearable onClear={() => setSearch('')} />
            <Select aria-label="筛选项目" size="sm" selectedKeys={[filter]} onSelectionChange={keys => { const key = [...keys][0]; if (key) setFilter(String(key)); }} variant="bordered">{[{ hash: 'all', name: '全部项目' }, ...data.workspaces].map(item => <SelectItem key={item.hash}>{item.name}</SelectItem>)}</Select>
          </div>
          {data.loading && !data.threads.length && <div className="phone-centered"><Spinner label="加载会话" /></div>}
          <div className="phone-thread-list">{visibleThreads.map(item => <Button key={item.id} className="phone-thread" variant="light" onPress={() => { setActionError(''); setPage('chat'); void store.select(item); }}>
            <div><strong>{item.title || item.name}</strong><span>{data.workspaces.find(project => project.hash === item.workspaceHash)?.displayName || data.workspaces.find(project => project.hash === item.workspaceHash)?.name || '项目'}</span></div><div className="phone-thread-end"><time>{relativeTime(item.mtime)}</time>{data.views[item.id]?.running && <span className="phone-thread-running">回复中</span>}</div>
          </Button>)}</div>
          {!data.loading && !visibleThreads.length && !data.error && <div className="phone-list-empty"><MessageSquare size={32} /><p>{search ? '没有找到会话' : '还没有会话'}</p><Button variant="light" onPress={newThread}>新建会话</Button></div>}
        </> : <div className="phone-project-list">{data.workspaces.map(item => <Button key={item.hash} className="phone-project" variant="light" onPress={() => { setWorkspace(item.hash); setFilter(item.hash); setPage('threads'); }}><Folder size={23} /><div><strong>{item.displayName || item.name}</strong><span>{data.threads.filter(thread => thread.workspaceHash === item.hash).length} 个会话</span></div></Button>)}</div>}
        {data.error && <div className="phone-inline-error" role="alert"><p>{data.error}</p><Button variant="light" onPress={() => void store.refresh()}>重试</Button></div>}
      </div>
    </>}
    </motion.div></AnimatePresence>
    {page !== 'chat' && <LiquidNavigation page={page} onPage={setPage} onNew={newThread} disabled={data.loading || !props.online} />}
    <Modal isOpen={!!sheet} onClose={() => setSheet(undefined)} placement="bottom-center" backdrop="blur" scrollBehavior="inside" motionProps={animated ? { initial: { opacity: 0, y: 48, scale: .98 }, animate: { opacity: 1, y: 0, scale: 1, transition: spring }, exit: { opacity: 0, y: 28, transition: { duration: .16 } } } : undefined} classNames={{ base: 'phone-sheet', backdrop: 'phone-sheet-backdrop', closeButton: 'phone-sheet-close' }}>
      <ModalContent><ModalHeader>{sheet === 'settings' ? '设置' : '会话选项'}</ModalHeader><ModalBody className="phone-sheet-body">
        {sheet === 'settings' ? <>
          <div className="phone-settings-row"><label>正文字号</label><div className="phone-segments">{[15, 16, 18].map(size => <Button key={size} variant={props.preferences.fontSize === size ? 'flat' : 'light'} aria-pressed={props.preferences.fontSize === size} onPress={() => props.onPreferences({ ...props.preferences, fontSize: size })}>{size === 15 ? '小' : size === 16 ? '标准' : '大'}</Button>)}</div></div>
          <Select label="外观" labelPlacement="outside" variant="bordered" selectedKeys={[props.preferences.theme]} onSelectionChange={keys => { const key = [...keys][0]; if (key === 'system' || key === 'light' || key === 'dark') props.onPreferences({ ...props.preferences, theme: key }); }}><SelectItem key="system">跟随系统</SelectItem><SelectItem key="light">浅色</SelectItem><SelectItem key="dark">深色</SelectItem></Select>
          <div className="phone-settings-connection"><strong>桌面连接</strong><span>{props.hostname}</span><Button variant="bordered" onPress={props.onDisconnect} startContent={<Unplug size={17} />}>切换连接</Button></div>
        </> : <>
          {!thread && <Select label="智能体" labelPlacement="outside" variant="bordered" selectedKeys={[engine]} isDisabled={pending} onSelectionChange={keys => { const key = [...keys][0]; if (key) setEngine(String(key)); }}>{(data.engines.length ? data.engines : [{ id: 'native', name: 'Loopra Native', available: true }]).map(item => <SelectItem key={item.id} isDisabled={!item.available}>{item.name}</SelectItem>)}</Select>}
          {native ? <><Select label="模型" labelPlacement="outside" variant="bordered" selectedKeys={[modelId]} onSelectionChange={keys => { const key = [...keys][0]; if (key) setModelId(String(key)); }}>{[{ id: 'default', label: '桌面默认模型' }, ...models].map(model => <SelectItem key={model.id} textValue={model.label}>{model.label}</SelectItem>)}</Select>
            <Select label="思考强度" labelPlacement="outside" variant="bordered" selectedKeys={[effort || 'default']} onSelectionChange={keys => { const key = [...keys][0]; if (key) setEffort(key === 'default' ? '' : String(key)); }}><SelectItem key="default">桌面默认</SelectItem><SelectItem key="low">低</SelectItem><SelectItem key="medium">中</SelectItem><SelectItem key="high">高</SelectItem><SelectItem key="xhigh">最高</SelectItem></Select></> : <p className="phone-muted">模型与权限使用此智能体在桌面端的设置。</p>}
        </>}
      </ModalBody><ModalFooter><Button color="primary" fullWidth onPress={() => setSheet(undefined)}>完成</Button></ModalFooter></ModalContent>
    </Modal>
    {notice && <div role="status" className="phone-toast">{notice}</div>}
  </main>;
}
