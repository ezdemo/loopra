import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { ConfirmAction, errorText, query, RemoteState, useRemote } from './RemoteControls';
import { PageHeader } from './SettingControls';
// Payload builders live in a plain module so protocol tests can assert the
// exact request bodies sent to the MCP / OpenAPI endpoints.
import { headerLines, mcpExportPayload, openApiSourcePayload, tunnelConfigPayload, type McpExportConfigDTO, type OpenApiSourceDraft, type TunnelStatus } from '../integration';

type Server = OpenApiSourceDraft & { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; timeout?: string; extensions?: string[]; initializationOptions?: object; status?: string; errorMessage?: string };
/** Keys follow OpenApiManageService.buildAuthenticator exactly. */
const AUTH_FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  bearer: [{ key: 'token', label: 'Token', secret: true }],
  apiKey: [{ key: 'name', label: '参数名 name' }, { key: 'value', label: '参数值 value', secret: true }],
  basic: [{ key: 'username', label: '用户名 username' }, { key: 'password', label: '密码 password', secret: true }],
};

export default function IntegrationManager({ api, kind }: { api: LoopraClient; kind: 'mcp' | 'lsp' | 'openapi' }) {
  const [revision, setRevision] = useState(0); const refresh = () => setRevision(value => value + 1);
  const endpoint = kind === 'openapi' ? '/openapi/sources' : `/${kind}/servers`;
  const state = useRemote<Server[]>(api, endpoint, revision);
  const [draft, setDraft] = useState<Server>(); const [original, setOriginal] = useState(''); const [advanced, setAdvanced] = useState('{}'); const [headers, setHeaders] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [deleting, setDeleting] = useState<Server>(); const [tools, setTools] = useState<string>();
  function edit(server?: Server) {
    const next: Server = server || (kind === 'openapi' ? { docUrl: '', headers: {}, authType: 'none', authConfig: {} } : { name: '', enabled: false, type: 'stdio', command: '', args: [], env: {}, extensions: [] });
    setDraft({ ...next, headers: { ...(next.headers || {}) }, authConfig: { ...(next.authConfig || {}) } });
    setOriginal(server?.docUrl || server?.name || '');
    setHeaders(headerLines(next.headers));
    setAdvanced(JSON.stringify(kind === 'openapi' ? {} : kind === 'mcp'
      ? { args: next.args || [], env: next.env || {}, headers: next.headers || {}, timeout: next.timeout || '30s' }
      : { extensions: next.extensions || [], env: next.env || {}, initializationOptions: next.initializationOptions || {} }, null, 2));
    setError(''); setNotice('');
  }
  async function act(path: string, method: string, body: unknown) { setBusy(true); setError(''); setNotice(''); try { const result = await api.request<unknown>(path, method, body); refresh(); return result ?? true; } catch (cause) { setError(errorText(cause)); return false; } finally { setBusy(false); } }
  function payload() {
    if (!draft) return {};
    if (kind === 'openapi') return openApiSourcePayload(draft, headers);
    const extra: unknown = JSON.parse(advanced);
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('高级配置必须为 JSON 对象');
    return { ...draft, ...extra };
  }
  async function save() { try { const server = payload(); const path = kind === 'openapi' ? `${endpoint}${original ? '/refresh' : ''}` : `${endpoint}/${original ? 'update' : 'add'}`; const body = kind !== 'openapi' && original ? { originalName: original, server } : server; if (await act(path, kind === 'openapi' && original ? 'PUT' : 'POST', body)) setDraft(undefined); } catch (cause) { setError(errorText(cause)); } }
  const authConfig = draft?.authConfig || {};
  return <><PageHeader title={kind === 'mcp' ? 'MCP 服务器' : kind === 'lsp' ? 'LSP 服务器' : 'OpenAPI 接口源'} description="配置直接保存到 Loopra 服务端。"><Button size="sm" variant="bordered" onPress={() => edit()}>新增</Button><Button size="sm" variant="light" onPress={refresh}>刷新</Button></PageHeader><RemoteState {...state} />{error && <p className="settings-error" role="alert">{error}</p>}{notice && <p role="status" className="section-note">{notice}</p>}
    {draft && <form className="workbench-form settings-card" onSubmit={event => { event.preventDefault(); void save(); }}>
      {kind === 'openapi' ? <>
        <label>文档地址<input type="url" required readOnly={!!original} value={draft.docUrl || ''} onChange={event => setDraft({ ...draft, docUrl: event.target.value })} /></label>
        <label>认证方式<select aria-label="认证方式" value={draft.authType || 'none'} onChange={event => setDraft({ ...draft, authType: event.target.value, authConfig: {} })}>{['none', 'bearer', 'apiKey', 'basic'].map(value => <option key={value}>{value}</option>)}</select></label>
        {(AUTH_FIELDS[draft.authType || ''] || []).map(field => <label key={field.key}>{field.label}<input aria-label={field.label} type={field.secret ? 'password' : 'text'} autoComplete="off" value={authConfig[field.key] || ''} onChange={event => setDraft({ ...draft, authConfig: { ...authConfig, [field.key]: event.target.value } })} /></label>)}
        <label>请求头（每行 Key: Value）<textarea aria-label="请求头" rows={4} spellCheck={false} placeholder="Authorization: Bearer …" value={headers} onChange={event => setHeaders(event.target.value)} /></label>
        <p className="section-note">authType 使用 none / bearer / apiKey / basic：bearer 读取 token，apiKey 读取 name 与 value，basic 读取 username 与 password。</p>
      </> : <><label>名称<input required pattern="[a-zA-Z0-9_-]+" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>{kind === 'mcp' && <label>传输方式<select value={draft.type || 'stdio'} onChange={event => setDraft({ ...draft, type: event.target.value })}>{['stdio', 'sse', 'streamable'].map(value => <option key={value}>{value}</option>)}</select></label>}{kind === 'lsp' || draft.type === 'stdio' ? <label>启动命令<input required value={draft.command || ''} onChange={event => setDraft({ ...draft, command: event.target.value })} /></label> : <label>服务地址<input required type="url" value={draft.url || ''} onChange={event => setDraft({ ...draft, url: event.target.value })} /></label>}<label className="workbench-actions"><input type="checkbox" checked={!!draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用</label></>}
      {kind !== 'openapi' && <details open><summary>参数与环境配置</summary><p className="section-note">{kind === 'mcp' ? 'args 为参数数组；env、headers 为键值对象；timeout 例如 30s。' : 'extensions 为扩展名数组；env 为环境变量；initializationOptions 为初始化参数。'}</p><textarea aria-label="集成高级配置" rows={8} spellCheck={false} value={advanced} onChange={event => setAdvanced(event.target.value)} /></details>}
      <div className="workbench-actions"><Button size="sm" variant="light" onPress={() => setDraft(undefined)}>取消</Button>{kind === 'mcp' && <Button size="sm" variant="flat" isLoading={busy} onPress={() => { try { void act('/mcp/servers/check', 'POST', payload()).then(result => { if (result) setNotice(String(result)); }); } catch (cause) { setError(errorText(cause)); } }}>检查连接</Button>}<Button size="sm" type="submit" color="primary" isLoading={busy}>保存</Button></div>
    </form>}
    {state.data?.map(server => <section className="workbench-card" key={server.docUrl || server.name}><strong>{server.name || server.docUrl}</strong><p>{server.command || server.url || server.docUrl}</p><p>{server.errorMessage || server.status || (server.enabled ? '已启用' : '已停用')}</p><div className="workbench-actions"><Button size="sm" variant="light" onPress={() => edit(server)}>编辑</Button>{kind !== 'openapi' && <Button size="sm" variant="light" isDisabled={busy} onPress={() => void act(`${endpoint}/toggle`, 'POST', { name: server.name, enabled: !server.enabled })}>{server.enabled ? '停用' : '启用'}</Button>}{kind === 'lsp' && <Button size="sm" variant="light" isDisabled={busy} onPress={() => void act(`${endpoint}/check`, 'POST', { name: server.name }).then(result => { if (result) setNotice(String(result)); })}>检查安装</Button>}{kind === 'mcp' && <Button size="sm" variant="light" onPress={() => setTools(server.name)}>工具权限</Button>}{kind === 'openapi' && <Button size="sm" variant="light" isDisabled={busy} onPress={() => void act(`${endpoint}/refresh`, 'PUT', server)}>重新加载</Button>}<Button size="sm" variant="light" color="danger" onPress={() => setDeleting(server)}>删除</Button></div></section>)}
    {kind === 'openapi' && <ApiSearch api={api} />}{kind === 'mcp' && <McpPublishing api={api} />}
    {tools && <McpTools key={tools} api={api} name={tools} onClose={() => setTools(undefined)} />}
    {deleting && <ConfirmAction title="删除集成配置" onClose={() => setDeleting(undefined)} action={() => api.request(kind === 'openapi' ? endpoint : `${endpoint}/remove`, kind === 'openapi' ? 'DELETE' : 'POST', kind === 'openapi' ? { docUrl: deleting.docUrl } : { name: deleting.name })} onDone={refresh}><p>删除 {deleting.name || deleting.docUrl}</p></ConfirmAction>}
  </>;
}

function McpTools({ api, name, onClose }: { api: LoopraClient; name: string; onClose: () => void }) {
  const state = useRemote<{ connected: boolean; tools: { name: string; description: string }[]; disallowedTools: string[] }>(api, `/mcp/servers/tools?${query({ name })}`);
  const [denied, setDenied] = useState<string[] | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const selected = denied || state.data?.disallowedTools || [];
  return <section className="workbench-card"><strong>{name} · 工具权限</strong><RemoteState {...state} />{state.data && !state.data.connected && <p>服务未连接，请先检查配置。</p>}{state.data?.tools.map(tool => <label key={tool.name} className="workbench-actions" title={tool.description}><input type="checkbox" checked={!selected.includes(tool.name)} onChange={event => setDenied(event.target.checked ? selected.filter(entry => entry !== tool.name) : [...selected, tool.name])} />{tool.name}</label>)}{error && <p role="alert">{error}</p>}<div className="workbench-actions"><Button size="sm" variant="light" onPress={onClose}>关闭</Button><Button size="sm" isLoading={busy} isDisabled={!state.data} onPress={() => { setBusy(true); void api.request('/mcp/servers/tools/save', 'POST', { serverName: name, disallowedTools: selected }).then(onClose).catch(cause => setError(errorText(cause))).finally(() => setBusy(false)); }}>保存权限</Button></div></section>;
}

function ApiSearch({ api }: { api: LoopraClient }) {
  const [text, setText] = useState(''); const [term, setTerm] = useState(''); const state = useRemote<unknown>(api, term ? `/openapi/search?${query({ keyword: term })}` : null);
  return <section className="workbench-card"><form className="workbench-form" onSubmit={event => { event.preventDefault(); setTerm(text); }}><label>搜索接口<input value={text} onChange={event => setText(event.target.value)} /></label><Button size="sm" type="submit">搜索</Button></form><RemoteState {...state} />{state.data !== undefined && <pre>{JSON.stringify(state.data, null, 2)}</pre>}</section>;
}

function McpPublishing({ api }: { api: LoopraClient }) {
  const state = useRemote<McpExportConfigDTO>(api, '/mcp/export');
  const [draft, setDraft] = useState<McpExportConfigDTO>();
  const [mode, setMode] = useState<'all' | 'selected'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const apply = useCallback((data: McpExportConfigDTO) => {
    setDraft(data);
    setMode(Array.isArray(data.allowedTools) ? 'selected' : 'all');
    setSelected(Array.isArray(data.allowedTools) ? [...new Set(data.allowedTools)] : (data.tools || []).filter(tool => tool.enabled !== false).map(tool => tool.name));
  }, []);
  useEffect(() => { if (state.data) apply(state.data); }, [state.data, apply]);
  async function run(label: string, task: () => Promise<McpExportConfigDTO>) {
    setBusy(label); setError(''); setNotice('');
    try { apply(await task()); setNotice(label === '保存发布配置' ? 'Loopra MCP 发布配置已保存' : '工具清单已刷新'); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }
  const tools = draft?.tools || [];
  const enabledTools = tools.filter(tool => tool.enabled !== false);
  const checkedCount = mode === 'all' ? enabledTools.length : enabledTools.filter(tool => selected.includes(tool.name)).length;
  return <>
    <section className="workbench-card mcp-export-panel">
      <div className="workbench-panel-heading"><strong>发布 Loopra 工具</strong><span className="section-note">提供给 Claude Desktop、Cursor 等 MCP 客户端</span></div>
      <RemoteState {...state} />
      {error && <p role="alert" className="settings-error">{error}</p>}
      {notice && <p role="status" className="section-note">{notice}</p>}
      {draft && <>
        <label className="workbench-actions"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用 MCP Server</label>
        <div className="workbench-fields">
          <label>Server 名称<input maxLength={60} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>Endpoint 路径<input value={draft.endpoint} onChange={event => setDraft({ ...draft, endpoint: event.target.value })} /></label>
          <label>传输方式<select value={draft.channel} onChange={event => setDraft({ ...draft, channel: event.target.value })}><option value="streamable">Streamable HTTP（推荐）</option><option value="streamable_stateless">Streamable HTTP（无状态）</option><option value="sse">SSE</option></select></label>
        </div>
        <div className="workbench-actions"><span>发布哪些工具</span><small className="section-note">{checkedCount} / {enabledTools.length} 个已启用工具</small><Button size="sm" variant="light" isLoading={busy === '刷新清单'} onPress={() => void run('刷新清单', () => api.request<McpExportConfigDTO>('/mcp/export/refresh', 'POST'))}>刷新清单</Button><Button size="sm" variant={mode === 'all' ? 'flat' : 'light'} onPress={() => setMode('all')}>全部已启用</Button><Button size="sm" variant={mode === 'selected' ? 'flat' : 'light'} onPress={() => setMode('selected')}>手动选择</Button></div>
        {mode === 'selected' && <div className="mcp-export-tools"><div className="workbench-actions"><Button size="sm" variant="light" onPress={() => setSelected(enabledTools.map(tool => tool.name))}>全选已启用</Button><Button size="sm" variant="light" onPress={() => setSelected([])}>清空选择</Button></div>{tools.map(tool => <label key={tool.name} className={`mcp-export-tool ${tool.enabled === false ? 'is-disabled' : ''}`}><input type="checkbox" disabled={tool.enabled === false} checked={tool.enabled !== false && selected.includes(tool.name)} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, tool.name])] : current.filter(entry => entry !== tool.name))} /><span>{tool.name}</span><small>{tool.description || '暂无描述'}</small></label>)}</div>}
        <div className="workbench-actions"><Button size="sm" color="primary" isLoading={busy === '保存发布配置'} onPress={() => void run('保存发布配置', () => api.request<McpExportConfigDTO>('/mcp/export', 'PUT', mcpExportPayload(draft, mode, selected)))}>保存发布配置</Button>{draft.enabled && <code className="mcp-endpoint">{draft.endpointUrl}</code>}</div>
        <p className="section-note">默认关闭；启用后请只在可信网络中暴露此地址。MCP 调用使用当前 Loopra 工作目录执行。</p>
      </>}
    </section>
    <CloudflareTunnelPanel api={api} exportEnabled={!!draft?.enabled} channel={draft?.channel || 'streamable'} />
  </>;
}

const TUNNEL_STATES: Record<string, string> = { stopped: '未启动', starting: '连接中', running: '已发布', stopping: '停止中', error: '异常' };

function CloudflareTunnelPanel({ api, exportEnabled, channel }: { api: LoopraClient; exportEnabled: boolean; channel: string }) {
  const [status, setStatus] = useState<TunnelStatus>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const edited = useRef(false);
  const load = useCallback(async () => {
    try {
      const data = await api.request<TunnelStatus>('/mcp/tunnel');
      setStatus(data);
      if (!edited.current) setPath(data.configuredExecutablePath || '');
      setError('');
    } catch (cause) { setError(errorText(cause)); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  const active = !!status && (status.running === true || ['starting', 'stopping'].includes(status.state || ''));
  useEffect(() => { if (!active) return; const timer = setInterval(() => void load(), 2000); return () => clearInterval(timer); }, [active, load]);
  async function run(label: string, task: () => Promise<TunnelStatus>, resetEdit = false) {
    setBusy(label); setError('');
    try { setStatus(await task()); if (resetEdit) edited.current = false; }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(''); }
  }
  const url = status?.publicUrl || status?.localUrl || status?.mcpEndpoint || '/mcp';
  return <section className="workbench-card mcp-tunnel-panel">
    <div className="workbench-panel-heading"><strong>Cloudflare 隧道</strong><span className={`tag ${status?.running ? 'is-ok' : ''}`} role="status">{TUNNEL_STATES[status?.state || 'stopped'] || '未启动'}</span><Button size="sm" variant="light" onPress={() => void load()}>刷新</Button></div>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {status?.error && <p role="alert" className="settings-error">{status.error}</p>}
    {status && !status.installed && <p className="section-note">未检测到 cloudflared，请先安装并加入 PATH，或填写下面的可执行文件路径。</p>}
    {!exportEnabled && <p className="section-note">请先启用上面的 Loopra MCP 工具发布配置。</p>}
    <label>cloudflared 路径（可选）<input aria-label="cloudflared 路径" placeholder="PATH 中的 cloudflared 或完整文件路径" value={path} onChange={event => { edited.current = true; setPath(event.target.value); }} /></label>
    <div className="workbench-actions">
      <Button size="sm" variant="light" isLoading={busy === '保存路径'} onPress={() => void run('保存路径', () => api.request<TunnelStatus>('/mcp/tunnel/config', 'PUT', tunnelConfigPayload(path)), true)}>保存路径</Button>
      {active
        ? <Button size="sm" color="danger" isLoading={busy === '停止隧道'} isDisabled={status?.state === 'stopping'} onPress={() => void run('停止隧道', () => api.request<TunnelStatus>('/mcp/tunnel/stop', 'POST', {}))}>停止隧道</Button>
        : <Button size="sm" color="primary" isLoading={busy === '启动隧道'} isDisabled={!exportEnabled || channel === 'sse'} onPress={() => void run('启动隧道', () => api.request<TunnelStatus>('/mcp/tunnel/start', 'POST', tunnelConfigPayload(path)))}>启动临时隧道</Button>}
      {status?.publicUrl && <Button size="sm" variant="light" onPress={() => void navigator.clipboard?.writeText(status.publicUrl!)}>复制公网地址</Button>}
    </div>
    <p className="section-note">{status?.publicUrl ? '公网 MCP 地址' : '本地 MCP 地址'} <code>{url}</code>{status?.executablePath ? ` · ${status.executablePath}` : ''}</p>
    <p className="section-note">Quick Tunnel 地址临时随机，应用退出后失效；只代理 MCP 路径。Quick Tunnel 不支持 SSE，请使用 Streamable HTTP。</p>
  </section>;
}
