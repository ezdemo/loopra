import { useCallback, useEffect, useRef, useState } from 'react';
import { Accordion, AccordionItem, Button, Checkbox, Spinner, Textarea } from '@nextui-org/react';
import { CircleCheck, FolderGit2, GitBranch, Sparkles } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { errorText, query, RemoteState } from './RemoteControls';
import { Segmented } from './ui';
import GitChangeTree from './GitChangeTree';
import { notifyWorkspaceChanged } from '../workspace-events';
import {
  environmentEntries,
  formatCommitDate,
  normalizeEnvironmentStatus,
  trackingSummary,
  type EnvironmentGitStatus,
  type EnvironmentSummary,
  type GitCommitEntry,
  type GitStatus,
  type SessionWorktreeMode,
} from '../environment';

export type EnvironmentProps = {
  api: LoopraClient;
  workspaceHash: string;
  sessionName?: string;
  revision: number;
  notify: (message: string) => void;
  onRefresh: () => void;
};

type HistoryScope = 'main' | 'current';
type Notice = { tone: 'success' | 'error' | 'info'; text: string };

/**
 * Loads the session environment plus the main/worktree Git status and exposes
 * the actions both the summary bar and the worktree body need. The Git tab uses
 * one controller so the bar and body never fetch the same state twice.
 */
export function useEnvironmentController({ api, workspaceHash, sessionName, revision, notify, onRefresh }: EnvironmentProps) {
  const [environment, setEnvironment] = useState<EnvironmentSummary>();
  const [mode, setMode] = useState<SessionWorktreeMode>();
  const [mainStatus, setMainStatus] = useState<GitStatus | null>();
  const [currentStatus, setCurrentStatus] = useState<GitStatus | null>();
  const [statusError, setStatusError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyScope, setHistoryScope] = useState<HistoryScope>('current');
  const [history, setHistory] = useState<GitCommitEntry[]>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const loadSequence = useRef(0);
  const historySequence = useRef(0);
  const stagingPaths = useRef(new Set<string>());
  const stagingQueue = useRef(Promise.resolve());

  // A session switch must not briefly show the previous session's checkout.
  useEffect(() => {
    setEnvironment(undefined); setMode(undefined); setMainStatus(undefined); setCurrentStatus(undefined);
    setStatusError(''); setLoadError(''); setActionError(''); setNotice(undefined); setMessage('');
    setHistory(undefined); setHistoryError(''); setHistoryOpen(false);
  }, [sessionName]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!workspaceHash || !sessionName) { setLoading(false); return; }
    const sequence = ++loadSequence.current;
    // The polling signal lives for the whole effect, so add the client's usual
    // 30s bound explicitly or one wedged request would overlap forever.
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : undefined;
    setLoading(true); setLoadError('');
    let env: EnvironmentSummary; let nextMode: SessionWorktreeMode;
    try {
      [env, nextMode] = await Promise.all([
        api.request<EnvironmentSummary>(`/git/environment?${query({ workspaceHash, sessionName })}`, 'GET', undefined, requestSignal),
        api.request<SessionWorktreeMode>(`/sessions/${encodeURIComponent(sessionName)}/worktree?${query({ workspaceHash })}`, 'GET', undefined, requestSignal),
      ]);
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setLoadError(errorText(cause)); setMainStatus(undefined); setCurrentStatus(undefined); setLoading(false);
      return;
    }
    if (sequence !== loadSequence.current) return;
    setEnvironment(env); setMode(nextMode);
    try {
      // The backend resolves both checkout paths itself; the client never sends
      // an arbitrary directory for Git operations.
      const status = await api.request<EnvironmentGitStatus>(`/git/environment/status?${query({ workspaceHash, sessionName })}`, 'GET', undefined, requestSignal);
      if (sequence !== loadSequence.current) return;
      setMainStatus(normalizeEnvironmentStatus(status.main));
      setCurrentStatus(normalizeEnvironmentStatus(status.current));
      setStatusError('');
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      // An unreadable status must never be presented as "clean".
      setMainStatus(undefined); setCurrentStatus(undefined); setStatusError(errorText(cause));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [api, sessionName, workspaceHash]);

  useEffect(() => {
    if (!sessionName) { setLoading(false); return undefined; }
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load, revision, sessionName]);

  const loadHistory = useCallback(async (scope: HistoryScope) => {
    const path = scope === 'main' ? environment?.mainPath : environment?.currentPath;
    if (!path) { setHistoryError('无法读取提交记录'); setHistory([]); return; }
    const sequence = ++historySequence.current;
    setHistoryLoading(true); setHistoryError('');
    try {
      const result = await api.request<{ commits: { hash: string; shortHash: string; author: string; date: string; message: string }[] }>(`/git/environment/log?${query({ workspaceHash, sessionName, scope, limit: 30 })}`);
      const items: GitCommitEntry[] = result.commits.map(commit => ({ hash: commit.hash, shortHash: commit.shortHash, author: commit.author, date: commit.date, subject: commit.message }));
      if (sequence !== historySequence.current) return;
      setHistory(items);
    } catch (cause) {
      if (sequence !== historySequence.current) return;
      setHistory([]); setHistoryError(errorText(cause));
    } finally {
      if (sequence === historySequence.current) setHistoryLoading(false);
    }
  }, [api, environment?.currentPath, environment?.mainPath, sessionName, workspaceHash]);

  useEffect(() => {
    if (!historyOpen) return;
    void loadHistory(historyScope);
  }, [historyOpen, historyScope, loadHistory, revision]);

  useEffect(() => {
    const hasWorktree = environment?.mode === 'worktree' && !!environment.currentPath && environment.currentPath !== environment.mainPath;
    if (historyScope === 'current' && !hasWorktree) setHistoryScope('main');
  }, [environment, historyScope]);

  // The strip polls, but GitTools only refreshes on workspace events. Forward a
  // changed branch/dirty signature so both halves of the tab agree.
  const lastStatusSignature = useRef('');
  useEffect(() => {
    if (environment?.mode !== 'local' || !mainStatus) return;
    const signature = `${mainStatus.branch}|${mainStatus.dirty}|${mainStatus.changed.length}|${mainStatus.untracked.length}`;
    if (lastStatusSignature.current && signature !== lastStatusSignature.current) notifyWorkspaceChanged(workspaceHash);
    lastStatusSignature.current = signature;
  }, [environment?.mode, mainStatus, workspaceHash]);

  const isWorktree = environment?.mode === 'worktree';
  const currentPath = isWorktree ? environment?.currentPath || '' : environment?.mainPath || '';
  const currentBranch = isWorktree ? environment?.currentBranch : environment?.mainBranch;
  const currentEntries = environmentEntries(currentStatus);
  const mainEntries = environmentEntries(mainStatus);
  const hasSeparateWorktree = !!isWorktree && !!environment?.currentPath && environment?.currentPath !== environment?.mainPath;
  const agentRunning = !!environment?.agentRunning;
  const statusText = statusError ? '读取失败' : currentStatus ? (currentStatus.dirty ? '有变更' : '干净') : !environment ? '读取中' : isWorktree ? (environment.currentPath ? '读取中' : '待创建') : '读取失败';

  // Selecting files is only meaningful while they still exist in the status.
  useEffect(() => {
    const paths = new Set([...currentEntries].map(entry => entry.path));
    setSelected(current => current.filter(path => paths.has(path)));
  }, [currentStatus]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setActionError(''); setNotice(undefined);
    try { await action(); }
    catch (cause) { const text = errorText(cause); setActionError(text); notify(text); }
    finally { setBusy(false); }
  }

  function toggleMode(enabled: boolean) {
    if (busy || !mode || agentRunning) return;
    if (!enabled && isWorktree) {
      // The backend does not guard this; fall back to its server-computed flag
      // when the detailed status read failed.
      const dirty = currentStatus ? currentStatus.dirty : !!environment?.currentDirty;
      if (dirty) { setNotice({ tone: 'error', text: '请先提交隔离分支变更' }); return; }
      if (!currentStatus && !environment?.currentDirty) { setNotice({ tone: 'error', text: '无法确认隔离分支状态，暂不能切换' }); return; }
    }
    const url = `/sessions/${encodeURIComponent(sessionName!)}/worktree?${query({ workspaceHash })}`;
    void run(async () => {
      setMode(await api.request<SessionWorktreeMode>(url, 'PUT', { ...mode, worktreeMode: enabled }));
      if (enabled) {
        try { await api.request('/git/worktree/create', 'POST', { workspaceHash, sessionName }); }
        catch (cause) {
          // Never leave the session pointed at a worktree that does not exist.
          await api.request<SessionWorktreeMode>(url, 'PUT', { ...mode, worktreeMode: false }).then(setMode).catch(() => undefined);
          throw cause;
        }
      }
      setNotice({ tone: 'success', text: enabled ? '已启用隔离分支' : '已切换到本地' });
      notifyWorkspaceChanged(workspaceHash);
      onRefresh();
    });
  }

  function createWorktree() {
    if (busy || agentRunning || !mode?.worktreeMode || environment?.worktreeExists) return;
    void run(async () => {
      await api.request('/git/worktree/create', 'POST', { workspaceHash, sessionName });
      setNotice({ tone: 'success', text: '已创建隔离分支' });
      notifyWorkspaceChanged(workspaceHash);
      onRefresh();
    });
  }

  function stage(path: string, staged: boolean) {
    if (stagingPaths.current.has(path)) return;
    stagingPaths.current.add(path); setPendingPaths([...stagingPaths.current]); setActionError('');
    stagingQueue.current = stagingQueue.current.then(async () => {
      try {
        await api.request(`/git/environment/toggle?${query({ workspaceHash, sessionName })}`, 'POST', { path, staged });
        onRefresh();
      } catch (cause) {
        const text = errorText(cause); setActionError(text); notify(text);
      } finally {
        stagingPaths.current.delete(path); setPendingPaths([...stagingPaths.current]);
      }
    });
  }

  function generateMessage() {
    if (busy || generating || agentRunning || !currentStatus?.dirty) return;
    setGenerating(true); setActionError(''); setNotice(undefined);
    void api.request<{ message: string }>(`/git/generate-environment-commit-message?${query({ workspaceHash, sessionName })}`, 'POST', { files: selected.length ? selected : undefined }, AbortSignal.timeout(120000))
      .then(result => { setMessage(result.message); setNotice({ tone: 'success', text: 'AI 已生成提交信息，可修改后提交' }); })
      .catch(cause => { const text = errorText(cause); setActionError(text); notify(text); })
      .finally(() => setGenerating(false));
  }

  function commitCurrent() {
    const text = message.trim();
    if (!text || busy || generating || agentRunning || !currentPath || !currentStatus?.dirty) return;
    void run(async () => {
      // Java resolves the checkout path; without a selection it stages everything.
      await api.request(`/git/environment/commit?${query({ workspaceHash, sessionName })}`, 'POST', { message: text, files: selected.length ? selected : undefined });
      setMessage(''); setSelected([]);
      setNotice({ tone: 'success', text: '已提交' });
      notifyWorkspaceChanged(workspaceHash);
      onRefresh();
    });
  }

  return {
    sessionName, environment, mode, mainStatus, currentStatus, statusError, loadError, loading,
    actionError, notice, setNotice, busy, generating, message, setMessage,
    historyOpen, setHistoryOpen, historyScope, setHistoryScope, history, historyLoading, historyError,
    isWorktree, currentPath, currentBranch, currentEntries, mainEntries, hasSeparateWorktree,
    agentRunning, statusText, selected, setSelected, pendingPaths, stage,
    toggleMode, createWorktree, generateMessage, commitCurrent,
  };
}

export type EnvironmentController = ReturnType<typeof useEnvironmentController>;

/**
 * Compact environment strip that sits at the top of the Git tab: current
 * checkout, dirty state and the isolation switch. The full worktree view below
 * reuses the same controller.
 */
function IsolationToggle({ c }: { c: EnvironmentController }) {
  return <Checkbox className="env-isolation-toggle" classNames={{ label: 'env-isolation-label' }} size="sm" color="primary" isSelected={!!c.mode?.worktreeMode} isDisabled={c.busy || c.agentRunning || !c.mode} onValueChange={c.toggleMode} aria-label="隔离分支模式" title="隔离分支模式：Agent 在独立 worktree 中读写文件">隔离</Checkbox>;
}

export function EnvironmentBar({ controller: c }: { controller: EnvironmentController }) {
  if (!c.sessionName) return null;
  // No environment yet: show a load failure instead of silently rendering the
  // main-project Git tools for a possibly isolated session.
  if (!c.environment) return c.loadError ? <div className="env-bar-wrap"><p className="settings-error" role="alert">{c.loadError}</p></div> : null;
  if (c.environment.mode === 'unavailable') return null;
  // A project that is not initialised yet belongs to GitTools' init card.
  if (!c.isWorktree && !c.mainStatus && /不是 Git 仓库|not a git repository/i.test(c.statusError)) return null;
  const stateClass = c.statusError ? ' is-error' : c.currentStatus ? (c.currentStatus.dirty ? ' is-dirty' : '') : ' is-muted';
  return <div className="env-bar-wrap">
    {/* The same card in both modes; only the badge text and tint change. */}
    <header className={`env-summary${c.isWorktree ? ' is-worktree' : ''}`} title={c.currentPath}>
      <div className="env-summary-head">
        <span className="env-summary-icon">{c.isWorktree ? <GitBranch size={15} /> : <FolderGit2 size={15} />}</span>
        <strong className="env-summary-title">{c.isWorktree ? '隔离分支' : '本地'}</strong>
        <span className={`env-state${stateClass}`}>{c.statusText}</span>
        {trackingSummary(c.currentStatus) && <span className="env-track">{trackingSummary(c.currentStatus)}</span>}
        <span className="env-summary-grow" />
        <div className="env-summary-actions"><IsolationToggle c={c} /></div>
      </div>
      <div className="env-summary-meta">
        <GitBranch size={11} />
        <span className="env-branch-name" title={c.currentBranch || ''}>{c.currentBranch || '未命名分支'}</span>
        <span className="env-meta-sep">·</span>
        <span className="env-summary-path" title={c.currentPath}>{c.currentPath || '尚未创建'}</span>
      </div>
    </header>

    {c.isWorktree && !c.environment.worktreeExists && <div className="env-bar-config">
      <span className="env-config-label">隔离分支尚未创建</span>
      <Button size="sm" variant="flat" isDisabled={c.busy || c.agentRunning} onPress={c.createWorktree}>创建隔离分支</Button>
    </div>}

    {c.loadError && <p className="env-notice is-error" role="alert"><span>环境信息刷新失败：{c.loadError}</span></p>}
    {c.actionError && <p className="settings-error" role="alert">{c.actionError}</p>}
    {c.agentRunning
      ? <p className="env-notice is-warning" role="status">Agent 正在运行，暂不可操作</p>
      : c.notice && <p className={`env-notice is-${c.notice.tone}`} role="status"><span>{c.notice.text}</span><button type="button" aria-label="关闭提示" title="关闭" onClick={() => c.setNotice(undefined)}>×</button></p>}
  </div>;
}

/** Full environment body, used instead of the main-project Git tools while the session runs in a worktree. */
export default function EnvironmentPanel({ controller: c, onFile, onMainFile }: { controller: EnvironmentController; onFile?: (path: string) => void; onMainFile?: (path: string) => void }) {
  if (!c.sessionName) return <p className="panel-empty">选择会话后可以管理隔离分支环境。</p>;
  // EnvironmentBar already renders a load failure; only the spinner is needed here.
  if (!c.environment) return c.loadError ? null : <section className="environment-panel"><RemoteState loading error="" /></section>;
  if (c.environment.mode === 'unavailable') return <p className="panel-empty">未找到可用的 Git 项目{c.environment.message ? `：${c.environment.message}` : ''}</p>;

  const allPaths = c.currentEntries.map(entry => entry.path);
  const allSelected = allPaths.length > 0 && allPaths.every(path => c.selected.includes(path));
  return <section className="environment-panel" aria-label="会话环境">
    <section className="env-section" aria-label="改动文件">
      <div className="git-section-header"><h3>改动文件<span className="git-count">{c.currentEntries.length}</span></h3><button type="button" className="git-text-action" disabled={!allPaths.length || c.busy} onClick={() => c.setSelected(allSelected ? [] : allPaths)}>{allSelected ? '清除选择' : '全选'}</button></div>
      {c.statusError
        ? <p className="env-hint is-error">{c.statusError}</p>
        : !c.currentStatus
          ? <p className="env-hint">{c.isWorktree ? '隔离分支尚未创建' : '正在读取 Git 状态…'}</p>
          : c.currentEntries.length === 0
            ? <p className="env-clean"><CircleCheck size={15} />暂无未提交变更</p>
            : <GitChangeTree changed={c.currentStatus.changed} untracked={c.currentStatus.untracked} selected={c.selected} busy={c.busy} pendingPaths={c.pendingPaths} onSelect={c.setSelected} onFile={path => onFile?.(path)} onToggle={c.stage} />}
    </section>

    {c.hasSeparateWorktree && <section className="env-section" aria-label="本地变更">
      <div className="git-section-header"><h3>本地变更<span className="git-count">{c.mainEntries.length}</span></h3><span className="env-readonly-note">只读</span></div>
      {c.statusError
        ? <p className="env-hint is-error">Git 状态不可用</p>
        : !c.mainStatus
          ? <p className="env-hint">正在读取主项目状态…</p>
          : c.mainEntries.length === 0
            ? <p className="env-hint">主项目干净</p>
            : <><GitChangeTree readOnly changed={c.mainStatus.changed} untracked={c.mainStatus.untracked} selected={[]} busy={false} onSelect={() => undefined} onFile={path => onMainFile?.(path)} onToggle={() => undefined} /><p className="env-hint is-warning">主项目有未提交变更，暂不能合并。</p></>}
    </section>}

    <section className="env-section env-commit" aria-label="提交改动">
      <div className="env-section-head">
        <h3>提交改动</h3>
        <Button className="env-ai-button" size="sm" variant="light" aria-busy={c.generating} isDisabled={c.busy || c.generating || c.agentRunning || !c.currentStatus?.dirty} onPress={c.generateMessage}><Sparkles size={13} /><span>{c.generating ? '生成中…' : 'AI 生成'}</span></Button>
      </div>
      <Textarea
        className="env-textarea"
        classNames={{ inputWrapper: 'env-textarea-wrapper', input: 'env-textarea-input' }}
        size="sm" radius="sm" variant="bordered" minRows={2} maxRows={5}
        aria-label="提交信息" placeholder="描述这次改动…"
        value={c.message}
        isDisabled={c.busy || c.agentRunning || !c.currentStatus?.dirty}
        onValueChange={c.setMessage}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); c.commitCurrent(); } }}
      />
      <div className="env-commit-footer">
        <span>{c.agentRunning ? 'Agent 正在运行，暂不可操作' : c.selected.length ? `已选择 ${c.selected.length} 个文件` : c.currentEntries.length ? '未勾选时提交全部改动' : '暂无可提交的改动'}</span>
        <Button className="env-commit-button" size="sm" color="primary" isDisabled={c.busy || c.generating || c.agentRunning || !c.message.trim() || !c.currentStatus?.dirty || !c.currentPath} onPress={c.commitCurrent}>提交当前</Button>
      </div>
    </section>

    <Accordion
      isCompact showDivider={false}
      className="env-history"
      itemClasses={{ base: 'env-history-accordion', trigger: 'env-history-trigger', title: 'env-history-title', content: 'env-history-content', indicator: 'env-history-indicator' }}
      selectedKeys={c.historyOpen ? ['history'] : []}
      onSelectionChange={keys => c.setHistoryOpen(new Set(keys).has('history'))}
    >
      <AccordionItem key="history" aria-label="提交历史" title={<span className="env-history-heading">提交历史{c.history && <small>{c.history.length}</small>}</span>}>
        {c.hasSeparateWorktree && <div className="env-history-scope"><Segmented label="提交历史范围" options={['本地', '隔离分支']} value={c.historyScope === 'main' ? '本地' : '隔离分支'} onChange={value => c.setHistoryScope(value === '本地' ? 'main' : 'current')} /></div>}
        {c.historyLoading
          ? <p className="env-hint"><Spinner size="sm" aria-label="正在读取提交记录" /></p>
          : c.historyError
            ? <p className="env-hint is-error">{c.historyError}</p>
            : !c.history?.length
              ? <p className="env-hint">暂无提交</p>
              : <ol className="env-history-list">{c.history.map(commit => <li key={commit.hash}>
                <span className="env-history-dot" />
                <div><strong title={commit.subject || '无标题提交'}>{commit.subject || '无标题提交'}</strong><small>{commit.author}<span>·</span>{formatCommitDate(commit.date)}</small></div>
                <code title={commit.hash}>{commit.shortHash}</code>
              </li>)}</ol>}
      </AccordionItem>
    </Accordion>
  </section>;
}
