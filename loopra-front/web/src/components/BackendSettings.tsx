import { useEffect, useMemo, useState } from 'react';
import { Button, Spinner } from '@nextui-org/react';
import { FolderClosed, RefreshCw } from 'lucide-react';
import { LoopraClient, serverAddress, type Workspace } from '../backend';
import { EmptySetting, Field, PageHeader, SettingRow, SettingSwitch } from './SettingControls';

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
  return <><PageHeader title="服务器" description="连接本地 Loopra Web 服务，聊天与配置直接读写后端。" /><form className="settings-card rich-settings-card rich-settings-form" onSubmit={event => { event.preventDefault(); void check(true); }}><Field label="后端 API 地址" value={url} onChange={setUrl} placeholder="http://127.0.0.1:4567" /><p className="section-note" role="status">{state || `当前地址：${server}`}</p><div className="settings-save-row"><Button variant="flat" isLoading={busy} onPress={() => void check(false)}>检查连接</Button><Button type="submit" color="primary" isDisabled={busy}>保存并连接</Button></div></form></>;
}

export function BackendProjects({ server, workspaces, onRefresh }: { server: string; workspaces: Workspace[]; onRefresh: () => Promise<void> }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true); setError('');
    try { await new LoopraClient(server).request('/workspace', 'POST', { path: path.trim() }); await onRefresh(); setPath(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '添加失败'); }
    finally { setBusy(false); }
  }
  return <><PageHeader title="项目" description="项目与会话保存在 Loopra 后端，可在侧栏选择工作区。" /><div className="settings-card">{workspaces.map(item => <SettingRow key={item.hash} title={item.name} description={item.path}><FolderClosed size="1.25rem" /></SettingRow>)}</div><h2>添加本地项目</h2><form className="rich-settings-form" onSubmit={event => { event.preventDefault(); void add(); }}><Field label="项目绝对路径" value={path} onChange={setPath} placeholder="C:\Projects\my-app" />{error && <p className="settings-error" role="alert">{error}</p>}<div className="settings-save-row"><Button type="submit" color="primary" isLoading={busy} isDisabled={!path.trim()}>添加项目</Button></div></form></>;
}

const resources: Record<string, string> = { '子代理': '/sub-agents', '技能': '/agent/skills', '插件': '/plugins', '拓展包': '/extpacks', 'OpenAPI': '/openapi/sources', 'MCP 服务器': '/mcp/servers', 'LSP 服务器': '/lsp/servers', '数据面板': '/usage/dashboard?days=30' };
type Resource = { id?: string; name?: string; displayName?: string; description?: string; remark?: string; command?: string; docUrl?: string; enabled?: boolean; enable?: boolean; installed?: boolean; tools?: unknown[] };
export function BackendResources({ tab, server }: { tab: string; server: string }) {
  const api = useMemo(() => new LoopraClient(server), [server]);
  const [items, setItems] = useState<Resource[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(signal?: AbortSignal) {
    setBusy(true); setError('');
    try {
      const data = await api.request<Resource[] | Record<string, number>>(resources[tab], 'GET', undefined, signal);
      if (signal?.aborted) return;
      if (Array.isArray(data)) setItems(data); else setMetrics(data);
    } catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : '加载失败'); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [api, tab]);
  async function toggle(item: Resource, enabled: boolean) {
    setBusy(true); setError('');
    try {
      if (tab === '插件' || tab === '拓展包') await api.request(`${tab === '插件' ? '/plugins' : '/extpacks'}/${encodeURIComponent(item.id || '')}/toggle`, 'POST', { enabled });
      else await api.request(`${tab === 'MCP 服务器' ? '/mcp' : '/lsp'}/servers/toggle`, 'POST', { name: item.name, enabled });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); setBusy(false); }
  }
  const canToggle = ['插件', '拓展包', 'MCP 服务器', 'LSP 服务器'].includes(tab);
  return <><PageHeader title={tab} description="读取 Loopra 当前配置与运行状态。"><Button isIconOnly size="sm" variant="light" aria-label={`刷新${tab}`} isDisabled={busy} onPress={() => void load()}><RefreshCw size="1rem" /></Button></PageHeader>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {busy && <Spinner size="sm" />}
    {tab === '数据面板' ? <div className="settings-metrics">{[['请求次数', 'totalRequests'], ['输入 Token', 'totalPromptTokens'], ['输出 Token', 'totalCompletionTokens'], ['缓存命中', 'totalCacheHit'], ['总费用', 'totalCost'], ['活跃天数', 'activeDays']].map(([label, key]) => <div className="settings-metric" key={key}><span>{label}</span><strong>{(metrics[key] || 0).toLocaleString()}</strong></div>)}</div> : <div className="settings-card">{items.map((item, index) => <SettingRow key={item.id || item.name || String(index)} title={item.displayName || item.name || item.docUrl || `配置 ${index + 1}`} description={item.description || item.remark || item.command || (item.tools ? `${item.tools.length} 个工具` : undefined)}>{canToggle && typeof item.enabled === 'boolean' ? <SettingSwitch label={`启用：${item.displayName || item.name}`} value={item.enabled} onChange={enabled => void toggle(item, enabled)} /> : <span className="tag">{item.enable === false ? '已停用' : '已配置'}</span>}</SettingRow>)}</div>}
    {!busy && !error && tab !== '数据面板' && !items.length && <EmptySetting>Loopra 暂无{tab}配置</EmptySetting>}
    <p className="section-note">新增、编辑及高级配置可在 <a href={`${server}/legacy.html`} target="_blank" rel="noreferrer">Loopra 高级控制台</a> 中管理，保存后点击刷新同步。</p>
  </>;
}
