import { useMemo, useState } from 'react';
import { Button } from '@nextui-org/react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { LoopraClient, serverAddress, type Workspace } from '../backend';
import { EmptySetting, Field, PageActions, SettingRow, SelectField } from './SettingControls';
import { ConfirmAction } from './RemoteControls';

export function BackendServer({ server, onSave }: { server: string; onSave: (server: string) => void }) {
  const [url, setUrl] = useState(server);
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  async function check(save: boolean) {
    setBusy(true); setState('');
    try { const address = serverAddress(url); const health = await new LoopraClient(address).request<{ version: string }>('/system/health'); setState(`连接成功 · Loopra ${health.version}`); if (save) onSave(address); }
    catch (error) { setState(`连接失败：${error instanceof Error ? error.message : error}`); }
    finally { setBusy(false); }
  }
  return <><PageActions title="服务器" /><form className="settings-card rich-settings-card rich-settings-form" onSubmit={event => { event.preventDefault(); void check(true); }}><Field label="后端 API 地址" value={url} onChange={setUrl} placeholder="http://127.0.0.1:4567" /><p className="section-note">这个地址只保存在这台设备上，用来找到 Loopra。</p><p className="section-note" role="status">{state || `当前地址：${server}`}</p><div className="settings-save-row"><Button variant="flat" isLoading={busy} onPress={() => void check(false)}>检查连接</Button><Button type="submit" color="primary" isDisabled={busy}>保存并连接</Button></div></form></>;
}

export function BackendProjects({ server, workspaces, sessions = [], onRefresh }: { server: string; workspaces: Workspace[]; sessions?: { workspaceHash?: string }[]; onRefresh: () => Promise<void> }) {
  const api = useMemo(() => new LoopraClient(server), [server]);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [removing, setRemoving] = useState<Workspace>();
  const [clearing, setClearing] = useState<Workspace>();
  const [days, setDays] = useState(30);
  const countFor = (hash: string) => sessions.filter(item => item.workspaceHash === hash).length;
  async function run(label: string, task: () => Promise<unknown>, after: () => void) {
    setBusy(label); setError('');
    try { await task(); await onRefresh(); after(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : `${label}失败`); }
    finally { setBusy(''); }
  }
  async function add() {
    await run('添加项目', () => api.request('/workspace', 'POST', { path: path.trim() }), () => setPath(''));
  }
  // ProjectCatalog applies the saved order, so persisting the swapped array is enough.
  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= workspaces.length) return;
    const next = [...workspaces];
    [next[index], next[target]] = [next[target], next[index]];
    void run('调整排序', () => api.request('/workspaces/order', 'PUT', next.map(item => item.hash)), () => {});
  }
  return <><PageActions title="项目" />
    {workspaces.length ? <div className="settings-card">{workspaces.map((item, index) => <SettingRow key={item.hash} title={item.name} description={`${item.path} · ${countFor(item.hash)} 个会话`}>
      <div className="workbench-actions">
        <Button isIconOnly size="sm" variant="light" aria-label={`上移 ${item.name}`} isDisabled={!!busy || index === 0} onPress={() => move(index, -1)}><ArrowUp size=".9375rem" aria-hidden="true" /></Button>
        <Button isIconOnly size="sm" variant="light" aria-label={`下移 ${item.name}`} isDisabled={!!busy || index === workspaces.length - 1} onPress={() => move(index, 1)}><ArrowDown size=".9375rem" aria-hidden="true" /></Button>
        <Button size="sm" variant="light" isDisabled={!!busy} onPress={() => setClearing(item)}>清空会话</Button>
        <Button size="sm" variant="light" color="danger" isDisabled={!!busy} onPress={() => setRemoving(item)}>移除</Button>
      </div>
    </SettingRow>)}</div> : <EmptySetting>{'Loopra 还没有项目，添加一个本地目录即可开始。'}</EmptySetting>}
    <h2>添加本地项目</h2><form className="rich-settings-form" onSubmit={event => { event.preventDefault(); void add(); }}><Field label="项目绝对路径" value={path} onChange={setPath} placeholder="C:\Projects\my-app" />{error && <p className="settings-error" role="alert">{error}</p>}<div className="settings-save-row"><Button type="submit" color="primary" isLoading={busy === '添加项目'} isDisabled={!path.trim()}>添加项目</Button></div></form>
    <h2>清理过期会话</h2>
    <div className="settings-card"><SettingRow title="保留最近" description="删除所有工作区中早于该时间的会话记录（磁盘文件与缓存）">
      <div className="workbench-actions"><SelectField label={"保留天数"} aria-label={"保留天数"} value={String(days ?? '')} onChange={value => setDays(Number(value))} options={[...([7, 14, 30, 90, 365].map(value => ({ value: String(value), label: "近" + String(value) + "天" })) || [])]} /><Button size="sm" variant="light" isLoading={busy === '清理过期会话'} onPress={() => void run('清理过期会话', async () => { const before = Date.now() - days * 86400000; const results = await Promise.allSettled(workspaces.map(item => api.request(`/sessions/cleanup?workspaceHash=${encodeURIComponent(item.hash)}&before=${before}`, 'DELETE'))); const failed = results.filter(result => result.status === 'rejected'); if (failed.length) throw new Error(`${failed.length} 个工作区清理失败`); }, () => {})}>清理过期会话</Button></div>
    </SettingRow></div>
    {removing && <ConfirmAction title="移除项目" onClose={() => setRemoving(undefined)} action={() => api.request(`/workspaces/${encodeURIComponent(removing.hash)}`, 'DELETE')} onDone={() => void onRefresh()}><p>从 Loopra 移除项目 {removing.name}？磁盘上的文件不会被删除，会话记录会一并移除。</p></ConfirmAction>}
    {clearing && <ConfirmAction title="清空会话" onClose={() => setClearing(undefined)} action={() => api.request(`/sessions?workspaceHash=${encodeURIComponent(clearing.hash)}`, 'DELETE')} onDone={() => void onRefresh()}><p>清空 {clearing.name} 下的全部 {countFor(clearing.hash)} 个会话？此操作不可恢复。</p></ConfirmAction>}
  </>;
}
