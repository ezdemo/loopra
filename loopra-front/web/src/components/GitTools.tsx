import { useEffect, useRef, useState } from 'react';
import { Button } from '@nextui-org/react';
import { ChevronDown, CircleCheck, FolderGit2, GitBranch, Plus, Sparkles } from 'lucide-react';
import type { LoopraClient } from '../backend';
import GitChangeTree from './GitChangeTree';
import { ConfirmAction, errorText, query, RemoteState, useRemote } from './RemoteControls';
import { gitModelFromValue, gitModelKnown, gitModelValue, groupGitModels, type GitModel } from '../git-models';
type GitFile = { path: string; index: string; workTree: string; status: string };
type Status = { gitAvailable: boolean; initialized: boolean; branch: string; changed: GitFile[]; untracked: GitFile[] };
// Legacy GitPanel.vue showed commit history dates as relative time (fmtRelative).
function fmtRelative(dateStr: string) {
  if (!dateStr) return '';
  const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (!Number.isFinite(diffSec)) return dateStr;
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return dateStr;
}
// Legacy GitPanel.vue offered a 「恢复默认」 button that resets the commit author
// to Loopra's built-in defaults and saves them. These mirror the backend
// constants GitService.DEFAULT_AUTHOR_NAME / DEFAULT_AUTHOR_EMAIL, which are
// also what GET /git/config returns once no author is configured.
const DEFAULT_GIT_AUTHOR = { authorName: 'Loopra', authorEmail: 'loopra@sorghum.site', model: '', modelChannelId: '' };

function useGitRemote<T>(api: LoopraClient, path: string | null, revision = 0) {
  const request = useRemote<T>(api, path, revision);
  const previous = useRef<{ api: LoopraClient; path: string | null; data: T }>();
  useEffect(() => { if (request.data !== undefined) previous.current = { api, path, data: request.data }; }, [api, path, request.data]);
  const cached = previous.current;
  return { ...request, data: request.data ?? (request.loading && cached?.api === api && cached.path === path ? cached.data : undefined) };
}

export default function GitTools({ api, workspaceHash, revision, onRefresh, onFile, notify }: { api: LoopraClient; workspaceHash: string; revision: number; onRefresh: () => void; onFile: (path: string) => void; notify: (message: string) => void }) {
  const suffix = query({ workspaceHash });
  const state = useGitRemote<Status>(api, `/git/status?${suffix}`, revision);
  const config = useRemote<Record<string, string>>(api, `/git/config?${suffix}`);
  const history = useGitRemote<{ commits: { hash: string; shortHash: string; message: string; author: string; date: string }[] }>(api, state.data?.initialized ? `/git/log?${suffix}&limit=50` : null, revision);
  // Legacy GitPanel.vue loaded GET /models for the commit-message model picker.
  const models = useGitRemote<{ models: GitModel[] }>(api, '/models', revision);
  const channels = groupGitModels(models.data?.models);
  const [author, setAuthor] = useState({ authorName: '', authorEmail: '', model: '', modelChannelId: '' });
  const [message, setMessage] = useState(''); const [selected, setSelected] = useState<string[]>([]);
  const [acting, setBusy] = useState(false); const [error, setError] = useState(''); const [confirm, setConfirm] = useState<'init' | 'commit'>();
  const [generating, setGenerating] = useState(false);
  const [pendingStages, setPendingStages] = useState<string[]>([]);
  const stagingPaths = useRef(new Set<string>()), stagingQueue = useRef(Promise.resolve());
  const busy = acting || (state.loading && !state.data);
  // Legacy GitPanel offered a "初始化后创建首次提交" checkbox (init?initialCommit=).
  const [initCommit, setInitCommit] = useState(true);
  useEffect(() => { if (config.data) setAuthor(current => ({ ...current, ...config.data })); }, [config.data]);
  const files = [...(state.data?.changed || []), ...(state.data?.untracked || [])];
  const commitCount = selected.length || files.length;
  useEffect(() => { if (state.data) setSelected(current => current.filter(path => [...state.data!.changed, ...state.data!.untracked].some(file => file.path === path))); }, [state.data]);
  async function act(path: string, body?: unknown) { setBusy(true); setError(''); try { await api.request(`/git/${path}?${suffix}`, 'POST', body); onRefresh(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  function stage(path: string, staged: boolean) {
    if (stagingPaths.current.has(path)) return;
    stagingPaths.current.add(path); setPendingStages([...stagingPaths.current]); setError('');
    notify('正在操作，请稍后…');
    stagingQueue.current = stagingQueue.current.then(async () => {
      let outcome = '';
      try { await api.request(`/git/toggle?${suffix}`, 'POST', { path, staged }); onRefresh(); outcome = staged ? '已暂存' : '已取消暂存'; }
      catch (cause) { const message = errorText(cause); setError(message); notify(`操作失败：${message}`); }
      finally {
        stagingPaths.current.delete(path); setPendingStages([...stagingPaths.current]);
        if (!stagingPaths.current.size && outcome) notify(outcome);
      }
    });
  }
  async function generate() { setGenerating(true); setError(''); try { const result = await api.request<{ message: string }>(`/git/generate-commit-message?${suffix}`, 'POST', { files: selected.length ? selected : files.map(file => file.path), model: author.model, modelChannelId: author.modelChannelId }, AbortSignal.timeout(120000)); setMessage(result.message); } catch (cause) { setError(errorText(cause)); } finally { setGenerating(false); } }
  async function reloadConfig() { setBusy(true); setError(''); try { const result = await api.request<Record<string, string>>(`/git/config?${suffix}`); setAuthor(current => ({ ...current, ...result })); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  async function resetAuthor() { setAuthor(DEFAULT_GIT_AUTHOR); await act('config', DEFAULT_GIT_AUTHOR); }
  return <section className="git-panel" aria-label="Git 版本控制"><RemoteState loading={state.loading && !state.data} error={state.error} />{error && <p role="alert" className="settings-error">{error}</p>}
    {state.data && !state.data.gitAvailable && <div className="git-empty"><span className="git-empty-icon"><FolderGit2 size={24} /></span><h3>还没有安装 Git</h3><p>在服务所在电脑安装 Git 后，即可管理项目版本。</p></div>}
    {state.data?.gitAvailable && !state.data.initialized && <div className="git-empty git-init"><span className="git-empty-icon"><FolderGit2 size={24} /></span><h3>开始记录项目的每一步</h3><p>初始化 Git 仓库，追踪文件改动与提交历史。</p><label><input type="checkbox" checked={initCommit} disabled={busy} onChange={event => setInitCommit(event.target.checked)} />初始化后创建首次提交</label><Button size="sm" color="primary" isDisabled={busy} onPress={() => setConfirm('init')}><Plus size={15} />初始化仓库</Button></div>}
    {state.data?.initialized && <>
      <header className="git-repository" aria-label="当前分支"><GitBranch size={16} /><strong title={state.data.branch}>{state.data.branch || 'HEAD'}</strong></header>
      <section className="git-changes" aria-label="改动文件"><header className="git-section-header"><h3>改动文件</h3><button className="git-text-action" disabled={busy || !files.length} onClick={() => setSelected(selected.length === files.length ? [] : files.map(file => file.path))}>{selected.length === files.length && files.length ? '清除选择' : '全选'}</button></header>
        {files.length ? <GitChangeTree changed={state.data.changed} untracked={state.data.untracked} selected={selected} busy={busy} pendingPaths={pendingStages} onSelect={setSelected} onFile={onFile} onToggle={stage} /> : <div className="git-clean-state"><CircleCheck size={24} /><strong>工作区很干净</strong><p>所有改动均已提交，开始下一次创作吧。</p></div>}
      </section>
      <section className="git-commit-card" aria-label="创建提交"><header className="git-section-header"><h3>提交说明</h3><Button className="git-ai-button" size="sm" variant="light" aria-busy={generating} isDisabled={busy || generating || !files.length} onPress={() => void generate()}><Sparkles size={14} /><span>{generating ? '生成中…' : 'AI 生成说明'}</span></Button></header><label className="git-message-label" htmlFor="git-commit-message">提交说明</label><textarea id="git-commit-message" className="git-message-input" aria-label="提交说明" rows={4} placeholder="描述这次改动…" value={message} disabled={busy || generating} onChange={event => setMessage(event.target.value)} /><footer className="git-commit-footer"><span>{selected.length ? `已选择 ${selected.length} 个文件` : files.length ? '未勾选时提交全部改动' : '暂无待提交文件'}</span><Button className="git-commit-button" size="sm" color="primary" isDisabled={busy || generating || pendingStages.length > 0 || !message.trim() || !files.length} onPress={() => setConfirm('commit')}>提交 {commitCount} 个文件</Button></footer>
        <details className="git-advanced"><summary><span>提交作者与生成模型</span><ChevronDown size={14} /></summary><div className="git-config-fields">
          <label>作者名称<input value={author.authorName} onChange={event => setAuthor(current => ({ ...current, authorName: event.target.value }))} /></label>
          <label>作者邮箱<input value={author.authorEmail} onChange={event => setAuthor(current => ({ ...current, authorEmail: event.target.value }))} /></label>
          <label>生成模型<select aria-label="生成模型" value={gitModelValue(author.model, author.modelChannelId)} onChange={event => setAuthor(current => ({ ...current, ...gitModelFromValue(event.target.value) }))}><option value="">留空继承默认模型</option>{channels.map(channel => <optgroup key={channel.id} label={channel.name}>{channel.models.map(model => <option key={`${channel.id}::${model.name}`} value={`${channel.id}::${model.name}`}>{model.name}</option>)}</optgroup>)}</select></label>
          {!gitModelKnown(models.data?.models || [], author.model, author.modelChannelId) && <p className="panel-empty" role="status">警告：当前模型不在可用列表中，请重新选择。</p>}
          <div className="workbench-actions"><Button size="sm" variant="light" isDisabled={busy} onPress={() => void reloadConfig()}>从现有环境获取</Button><Button size="sm" variant="light" isDisabled={busy} onPress={() => void resetAuthor()}>恢复默认</Button><Button size="sm" variant="flat" isDisabled={busy} onPress={() => void act('config', author)}>保存提交配置</Button></div>
        </div></details></section>
      <details className="git-history-card"><summary><strong>提交历史</strong><span>{history.data?.commits.length || 0}</span><ChevronDown size={15} /></summary><RemoteState loading={history.loading && !history.data} error={history.error} /><ol className="git-commit-list">{history.data?.commits.map(commit => <li key={commit.hash}><span className="git-history-dot" /><div><strong title={commit.message}>{commit.message}</strong><small title={commit.date}>{commit.author}<span>·</span>{fmtRelative(commit.date)}</small></div><code>{commit.shortHash}</code></li>)}</ol>{history.data && !history.data.commits.length && <p className="git-history-empty">提交后，版本记录会显示在这里。</p>}</details></>}
    {confirm && <ConfirmAction title={confirm === 'init' ? '初始化 Git 仓库' : '提交所选改动'} onClose={() => setConfirm(undefined)} action={() => api.request(`/git/${confirm === 'init' ? 'init' : 'commit'}?${confirm === 'init' ? query({ workspaceHash, initialCommit: initCommit }) : suffix}`, 'POST', confirm === 'commit' ? { ...author, message: message.trim(), files: selected.length ? selected : files.map(file => file.path) } : undefined)} onDone={() => { if (confirm === 'commit') { setMessage(''); setSelected([]); } onRefresh(); }}><p>{confirm === 'init' ? `将在当前项目创建 Git 仓库和默认忽略规则${initCommit ? '，并创建首次提交' : ''}。` : `将提交 ${selected.length || files.length} 个文件：${message}`}</p></ConfirmAction>}
  </section>;
}
