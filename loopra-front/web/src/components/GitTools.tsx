import { useEffect, useState } from 'react';
import { Button } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
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

export default function GitTools({ api, workspaceHash, revision, onRefresh, onFile }: { api: LoopraClient; workspaceHash: string; revision: number; onRefresh: () => void; onFile: (path: string) => void }) {
  const suffix = query({ workspaceHash });
  const state = useRemote<Status>(api, `/git/status?${suffix}`, revision);
  const config = useRemote<Record<string, string>>(api, `/git/config?${suffix}`);
  const history = useRemote<{ commits: { hash: string; shortHash: string; message: string; author: string; date: string }[] }>(api, state.data?.initialized ? `/git/log?${suffix}&limit=50` : null, revision);
  // Legacy GitPanel.vue loaded GET /models for the commit-message model picker.
  const models = useRemote<{ models: GitModel[] }>(api, '/models', revision);
  const channels = groupGitModels(models.data?.models);
  const [author, setAuthor] = useState({ authorName: '', authorEmail: '', model: '', modelChannelId: '' });
  const [message, setMessage] = useState(''); const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [confirm, setConfirm] = useState<'init' | 'commit'>();
  // Legacy GitPanel offered a "初始化后创建首次提交" checkbox (init?initialCommit=).
  const [initCommit, setInitCommit] = useState(true);
  useEffect(() => { if (config.data) setAuthor(current => ({ ...current, ...config.data })); }, [config.data]);
  const files = [...(state.data?.changed || []), ...(state.data?.untracked || [])];
  useEffect(() => { if (state.data) setSelected(current => current.filter(path => [...state.data!.changed, ...state.data!.untracked].some(file => file.path === path))); }, [state.data]);
  async function act(path: string, body?: unknown) { setBusy(true); setError(''); try { await api.request(`/git/${path}?${suffix}`, 'POST', body); onRefresh(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  async function generate() { setBusy(true); setError(''); try { const result = await api.request<{ message: string }>(`/git/generate-commit-message?${suffix}`, 'POST', { files: selected.length ? selected : files.map(file => file.path), model: author.model, modelChannelId: author.modelChannelId }, AbortSignal.timeout(120000)); setMessage(result.message); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  async function reloadConfig() { setBusy(true); setError(''); try { const result = await api.request<Record<string, string>>(`/git/config?${suffix}`); setAuthor(current => ({ ...current, ...result })); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  async function resetAuthor() { setAuthor(DEFAULT_GIT_AUTHOR); await act('config', DEFAULT_GIT_AUTHOR); }
  return <><RemoteState {...state} />{error && <p role="alert" className="settings-error">{error}</p>}
    {state.data && !state.data.gitAvailable && <p className="panel-empty">服务端尚未安装 Git。</p>}
    {state.data?.gitAvailable && !state.data.initialized && <div className="workbench-card"><p>当前项目尚未初始化 Git。</p><label className="workbench-actions"><input type="checkbox" checked={initCommit} onChange={event => setInitCommit(event.target.checked)} />初始化后创建首次提交</label><Button size="sm" onPress={() => setConfirm('init')}>初始化仓库</Button></div>}
    {state.data?.initialized && <><div className="workbench-card"><strong>{state.data.branch} · {files.length} 个改动</strong><p>勾选本次提交文件；未勾选时提交下方全部改动。</p><Button size="sm" variant="light" onPress={() => setSelected(selected.length === files.length ? [] : files.map(file => file.path))}>全选 / 清除</Button></div>
      {files.map(file => <div className="git-file-row" key={file.path}><input type="checkbox" aria-label={`选择提交文件：${file.path}`} checked={selected.includes(file.path)} onChange={event => setSelected(current => event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path))} /><button onClick={() => onFile(file.path)}>{file.status} {file.path}</button><Button size="sm" variant="light" isDisabled={busy} onPress={() => void act('toggle', { path: file.path })}>{file.index && file.index !== ' ' && file.index !== '?' ? '取消暂存' : '暂存'}</Button></div>)}
      <div className="workbench-form"><label>提交说明<textarea aria-label="提交说明" rows={3} value={message} onChange={event => setMessage(event.target.value)} /></label><div className="workbench-actions"><Button size="sm" variant="flat" isLoading={busy} isDisabled={!files.length} onPress={() => void generate()}>AI 生成说明</Button><Button size="sm" color="primary" isDisabled={busy || !message.trim() || !files.length} onPress={() => setConfirm('commit')}>提交 {selected.length || files.length} 个文件</Button></div>
        <details><summary>提交作者与生成模型</summary>
          <label>作者名称<input value={author.authorName} onChange={event => setAuthor(current => ({ ...current, authorName: event.target.value }))} /></label>
          <label>作者邮箱<input value={author.authorEmail} onChange={event => setAuthor(current => ({ ...current, authorEmail: event.target.value }))} /></label>
          <label>生成模型<select aria-label="生成模型" value={gitModelValue(author.model, author.modelChannelId)} onChange={event => setAuthor(current => ({ ...current, ...gitModelFromValue(event.target.value) }))}><option value="">留空继承默认模型</option>{channels.map(channel => <optgroup key={channel.id} label={channel.name}>{channel.models.map(model => <option key={`${channel.id}::${model.name}`} value={`${channel.id}::${model.name}`}>{model.name}</option>)}</optgroup>)}</select></label>
          {!gitModelKnown(models.data?.models || [], author.model, author.modelChannelId) && <p className="panel-empty" role="status">警告：当前模型不在可用列表中，请重新选择。</p>}
          <div className="workbench-actions"><Button size="sm" variant="light" isDisabled={busy} onPress={() => void reloadConfig()}>从现有环境获取</Button><Button size="sm" variant="light" isDisabled={busy} onPress={() => void resetAuthor()}>恢复默认</Button><Button size="sm" variant="flat" isDisabled={busy} onPress={() => void act('config', author)}>保存提交配置</Button></div>
        </details></div>
      <details className="workbench-card"><summary>提交历史</summary><RemoteState {...history} /><ul className="git-history">{history.data?.commits.map(commit => <li key={commit.hash}><code>{commit.shortHash}</code> {commit.message}<small title={commit.date}>{commit.author} · {fmtRelative(commit.date)}</small></li>)}</ul></details></>}
    {confirm && <ConfirmAction title={confirm === 'init' ? '初始化 Git 仓库' : '提交所选改动'} onClose={() => setConfirm(undefined)} action={() => api.request(`/git/${confirm === 'init' ? 'init' : 'commit'}?${confirm === 'init' ? query({ workspaceHash, initialCommit: initCommit }) : suffix}`, 'POST', confirm === 'commit' ? { ...author, message: message.trim(), files: selected.length ? selected : files.map(file => file.path) } : undefined)} onDone={() => { if (confirm === 'commit') { setMessage(''); setSelected([]); } onRefresh(); }}><p>{confirm === 'init' ? `将在当前项目创建 Git 仓库和默认忽略规则${initCommit ? '，并创建首次提交' : ''}。` : `将提交 ${selected.length || files.length} 个文件：${message}`}</p></ConfirmAction>}
  </>;
}
