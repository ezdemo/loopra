import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { ConfirmAction, errorText, query, RemoteState, useRemote } from './RemoteControls';
import { PageActions, Field, SelectField, TextField, SettingDisclosure, ResourceIcon, ResourceEmpty } from './SettingControls';
// Payload builders live in a plain module so protocol tests can assert the
// exact request bodies sent to the MCP / OpenAPI endpoints.
import { headerLines, mcpExportPayload, openApiSourcePayload, tunnelConfigPayload, type McpExportConfigDTO, type OpenApiSourceDraft, type TunnelStatus } from '../integration';

type Server = OpenApiSourceDraft & { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; timeout?: string; status?: string; errorMessage?: string };
/** Keys follow OpenApiManageService.buildAuthenticator exactly. */
const AUTH_FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  bearer: [{ key: 'token', label: 'Token', secret: true }],
  apiKey: [{ key: 'name', label: '参数名 name' }, { key: 'value', label: '参数值 value', secret: true }],
  basic: [{ key: 'username', label: '用户名 username' }, { key: 'password', label: '密码 password', secret: true }],
};

export default function IntegrationManager({ api, kind }: { api: LoopraClient; kind: 'mcp' | 'openapi' }) {
  const [revision, setRevision] = useState(0); const refresh = () => setRevision(value => value + 1);
  const endpoint = kind === 'openapi' ? '/openapi/sources' : '/mcp/servers';
  const state = useRemote<Server[]>(api, endpoint, revision);
  const [draft, setDraft] = useState<Server>(); const [original, setOriginal] = useState(''); const [advanced, setAdvanced] = useState('{}'); const [headers, setHeaders] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [deleting, setDeleting] = useState<Server>(); const [tools, setTools] = useState<string>();
  function edit(server?: Server) {
    const next: Server = server || (kind === 'openapi' ? { docUrl: '', headers: {}, authType: 'none', authConfig: {} } : { name: '', enabled: false, type: 'stdio', command: '', args: [], env: {} });
    setDraft({ ...next, headers: { ...(next.headers || {}) }, authConfig: { ...(next.authConfig || {}) } });
    setOriginal(server?.docUrl || server?.name || '');
    setHeaders(headerLines(next.headers));
    setAdvanced(JSON.stringify({ args: next.args || [], env: next.env || {}, headers: next.headers || {}, timeout: next.timeout || '30s' }, null, 2));
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
  return <div className="settings-resource-page">
    <PageActions title={draft ? original ? '编辑配置' : '新增配置' : tools ? '工具权限' : kind === 'mcp' ? 'MCP' : 'OpenAPI'} onBack={draft || tools ? () => { setDraft(undefined); setTools(undefined); setError(''); setNotice(''); } : undefined}>
      {!draft && !tools && <><Button size="sm" color="primary" onPress={() => edit()}>新增</Button><Button className="settings-outlined-action" size="sm" variant="light" onPress={refresh}>刷新</Button></>}
    </PageActions><RemoteState {...state} />{error && <p className="settings-error" role="alert">{error}</p>}{notice && <p role="status" className="section-note">{notice}</p>}

    {draft && <form className="settings-resource-form resource-editor settings-card" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="resource-section-heading"><h3>基本配置</h3><span>{original ? '更新现有配置' : '填写连接信息'}</span></div>
      <div className="resource-editor-fields">{kind === 'openapi' ? <>
        <Field label={"文档地址"} type={"url"} required={true} readOnly={!!original} value={(draft.docUrl || '') ?? ''} onChange={value => setDraft({ ...draft, docUrl: value })} />
        <SelectField label={"认证方式"} aria-label={"认证方式"} value={String(draft.authType || 'none')} onChange={value => setDraft({ ...draft, authType: value, authConfig: {} })} options={[...(['none', 'bearer', 'apiKey', 'basic'].map(value => ({ value: String(String(value)), label: String(value) })) || [])]} />
        {(AUTH_FIELDS[draft.authType || ''] || []).map(field => <Field label={String(field.label)} key={field.key} aria-label={field.label} type={field.secret ? 'password' : 'text'} autoComplete={"off"} value={(authConfig[field.key] || '') ?? ''} onChange={value => setDraft({ ...draft, authConfig: { ...authConfig, [field.key]: value } })} />)}
        <TextField label={"请求头（每行 Key: Value）"} aria-label={"请求头"} rows={4} spellCheck="false" placeholder={"Authorization: Bearer …"} value={(headers) ?? ''} onChange={value => setHeaders(value)} />

      </> : <><Field label={"名称"} required={true} pattern={"[a-zA-Z0-9_\\-]+"} value={(draft.name) ?? ''} onChange={value => setDraft({ ...draft, name: value })} />{kind === 'mcp' && <SelectField label={"传输方式"} value={String(draft.type || 'stdio')} onChange={value => setDraft({ ...draft, type: value })} options={[...(['stdio', 'sse', 'streamable'].map(value => ({ value: String(String(value)), label: String(value) })) || [])]} />}{draft.type === 'stdio' ? <Field label={"启动命令"} required={true} value={(draft.command || '') ?? ''} onChange={value => setDraft({ ...draft, command: value })} /> : <Field label={"服务地址"} required={true} type={"url"} value={(draft.url || '') ?? ''} onChange={value => setDraft({ ...draft, url: value })} />}<Checkbox className={`settings-next-checkbox ${"workbench-actions"}`} size="sm" isSelected={!!draft.enabled} onValueChange={selected => setDraft({ ...draft, enabled: selected })}>启用</Checkbox></>}</div>
      {kind !== 'openapi' && <SettingDisclosure heading="参数与环境配置" defaultExpanded><p className="section-note">args 为参数数组；env、headers 为键值对象；timeout 例如 30s。</p><TextField label={"集成高级配置"} aria-label={"集成高级配置"} rows={8} spellCheck="false" value={(advanced) ?? ''} onChange={value => setAdvanced(value)} /></SettingDisclosure>}
      <div className="workbench-actions resource-footer"><Button size="sm" variant="light" onPress={() => setDraft(undefined)}>取消</Button>{kind === 'mcp' && <Button size="sm" variant="flat" isLoading={busy} onPress={() => { try { void act('/mcp/servers/check', 'POST', payload()).then(result => { if (result) setNotice(String(result)); }); } catch (cause) { setError(errorText(cause)); } }}>检查连接</Button>}<Button size="sm" type="submit" color="primary" isLoading={busy}>保存</Button></div>
    </form>}
    {!draft && !tools && <>
      {kind === 'openapi' && <ApiSearch api={api} />}
      <div className="resource-section-heading"><h3>{kind === 'mcp' ? '外部服务器' : '接口源'}</h3><span>{state.data?.length || 0} 个配置</span></div>
      {state.data?.length === 0 && <ResourceEmpty kind={kind} title={kind === 'openapi' ? '尚未添加接口源' : '尚未添加服务器'}>点击右上角「新增」添加连接配置。</ResourceEmpty>}
      <div className={kind === 'openapi' ? 'resource-source-grid' : 'resource-list'}>{state.data?.map(server => <section className={`workbench-card ${kind === 'openapi' ? 'resource-source-card' : 'resource-row'}`} key={server.docUrl || server.name}>
        <ResourceIcon kind={kind} /><div className="resource-row-info"><div className="resource-name"><strong>{server.name || (kind === 'openapi' ? 'OpenAPI 文档' : server.docUrl)}</strong><span className={`resource-status ${(kind === 'openapi' ? server.status === 'loaded' : server.enabled) ? 'is-on' : ''}`}>{kind === 'openapi' ? ({ loaded: '已加载', error: '加载失败', disabled: '已停用' }[server.status || 'loaded'] || server.status) : server.status || (server.enabled ? '已启用' : '已停用')}</span></div><p className="resource-mono">{server.command || server.url || server.docUrl}</p><span className="resource-meta">{kind === 'mcp' ? server.type || 'stdio' : `认证：${server.authType || 'none'}`}</span>{server.errorMessage && <p className="settings-error" role="alert">{server.errorMessage}</p>}</div>
        <div className="resource-row-actions"><Button size="sm" variant="light" onPress={() => edit(server)}>编辑</Button>{kind !== 'openapi' && <Button size="sm" variant={server.enabled ? 'flat' : 'light'} color={server.enabled ? 'primary' : 'default'} isDisabled={busy} onPress={() => void act(`${endpoint}/toggle`, 'POST', { name: server.name, enabled: !server.enabled })}>{server.enabled ? '停用' : '启用'}</Button>}{kind === 'mcp' && <Button size="sm" variant="light" onPress={() => setTools(server.name)}>工具权限</Button>}{kind === 'openapi' && <Button size="sm" variant="light" isDisabled={busy} onPress={() => void act(`${endpoint}/refresh`, 'PUT', server)}>重新加载</Button>}<Button size="sm" variant="light" color="danger" onPress={() => setDeleting(server)}>删除</Button></div>
      </section>)}</div>
    </>}

    {tools && <McpTools key={tools} api={api} name={tools} onClose={() => setTools(undefined)} />}
    {deleting && <ConfirmAction title="删除集成配置" onClose={() => setDeleting(undefined)} action={() => api.request(kind === 'openapi' ? endpoint : `${endpoint}/remove`, kind === 'openapi' ? 'DELETE' : 'POST', kind === 'openapi' ? { docUrl: deleting.docUrl } : { name: deleting.name })} onDone={refresh}><p>删除 {deleting.name || deleting.docUrl}</p></ConfirmAction>}
  </div>;
}

function McpTools({ api, name, onClose }: { api: LoopraClient; name: string; onClose: () => void }) {
  const state = useRemote<{ connected: boolean; tools: { name: string; description: string }[]; disallowedTools: string[] }>(api, `/mcp/servers/tools?${query({ name })}`);
  const [denied, setDenied] = useState<string[] | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const selected = denied || state.data?.disallowedTools || [];
  return <section className="workbench-card resource-panel mcp-permissions"><strong>{name} · 工具权限</strong><RemoteState {...state} />{state.data && !state.data.connected && <p>服务未连接，请先检查配置。</p>}{state.data?.tools.map(tool => <Checkbox key={tool.name} title={tool.description} className={`settings-next-checkbox ${"workbench-actions"}`} size="sm" isSelected={!selected.includes(tool.name)} onValueChange={checked => setDenied(checked ? selected.filter(entry => entry !== tool.name) : [...selected, tool.name])}>{tool.name}</Checkbox>)}{error && <p role="alert">{error}</p>}<div className="workbench-actions"><Button size="sm" variant="light" onPress={onClose}>关闭</Button><Button size="sm" color="primary" isLoading={busy} isDisabled={!state.data} onPress={() => { setBusy(true); void api.request('/mcp/servers/tools/save', 'POST', { serverName: name, disallowedTools: selected }).then(onClose).catch(cause => setError(errorText(cause))).finally(() => setBusy(false)); }}>保存权限</Button></div></section>;
}

type ApiSearchItem = { api_name?: string; category?: string; description?: string; endpoint?: string };
function ApiSearch({ api }: { api: LoopraClient }) {
  const [text, setText] = useState(''); const [term, setTerm] = useState('');
  const state = useRemote<ApiSearchItem[] | string>(api, term ? `/openapi/search?${query({ keyword: term })}` : null);
  return <section className="workbench-card resource-panel api-search">
    <div className="resource-section-heading"><h3>搜索接口</h3>{term && <Button size="sm" variant="light" onPress={() => { setTerm(''); setText(''); }}>清除结果</Button>}</div>
    <form className="resource-toolbar" onSubmit={event => { event.preventDefault(); setTerm(text.trim()); }}><Field label="搜索接口" value={text} onChange={setText} placeholder="输入关键词，多个关键词用空格分隔" /><Button size="sm" color="primary" type="submit" isDisabled={!text.trim()}>搜索</Button></form>
    <RemoteState {...state} />
    {typeof state.data === 'string' && <p className="resource-inline-empty">{state.data}</p>}
    {Array.isArray(state.data) && <div className="api-search-results">{state.data.length === 0 ? <p className="resource-inline-empty">未找到匹配的接口，尝试调整关键词。</p> : state.data.map((item, index) => <article key={`${item.api_name}-${index}`}><div className="resource-name"><strong>{item.api_name || '未命名接口'}</strong>{item.category && <span className="resource-status">{item.category}</span>}</div>{item.description && <p>{item.description}</p>}{item.endpoint && <code>{item.endpoint}</code>}</article>)}</div>}
  </section>;
}

export function McpPublishingSettings({ api }: { api: LoopraClient }) {
  return <div className="settings-resource-page">
    <PageActions title="MCP 服务器" />
    <McpPublishing api={api} />
  </div>;
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
    <section className="workbench-card resource-panel mcp-export-panel">
      <div className="resource-panel-heading"><div><strong>发布 Loopra 工具</strong><p>提供给 Claude Desktop、Cursor 等 MCP 客户端</p></div>{draft && <Checkbox className="settings-next-checkbox" size="sm" isSelected={draft.enabled} onValueChange={selected => setDraft({ ...draft, enabled: selected })}>启用 MCP Server</Checkbox>}</div>
      <RemoteState {...state} />
      {error && <p role="alert" className="settings-error">{error}</p>}
      {notice && <p role="status" className="section-note">{notice}</p>}
      {draft && <>
        <div className="settings-resource-fields resource-publish-fields">
          <Field label={"Server 名称"} maxLength={60} value={(draft.name) ?? ''} onChange={value => setDraft({ ...draft, name: value })} />
          <Field label={"Endpoint 路径"} value={(draft.endpoint) ?? ''} onChange={value => setDraft({ ...draft, endpoint: value })} />
          <SelectField label={"传输方式"} value={String(draft.channel ?? '')} onChange={value => setDraft({ ...draft, channel: value })} options={[({ value: String("streamable"), label: "Streamable HTTP（推荐）" }), ({ value: String("streamable_stateless"), label: "Streamable HTTP（无状态）" }), ({ value: String("sse"), label: "SSE" })]} />
        </div>
        <div className="resource-selection-heading"><div><strong>发布哪些工具</strong><small>{checkedCount} / {enabledTools.length} 个已启用工具</small></div><Button className="settings-outlined-action" size="sm" variant="light" isLoading={busy === '刷新清单'} onPress={() => void run('刷新清单', () => api.request<McpExportConfigDTO>('/mcp/export/refresh', 'POST'))}>刷新清单</Button><Button size="sm" variant={mode === 'all' ? 'flat' : 'light'} onPress={() => setMode('all')}>全部已启用</Button><Button size="sm" variant={mode === 'selected' ? 'flat' : 'light'} onPress={() => setMode('selected')}>手动选择</Button></div>
        {mode === 'selected' && <div className="mcp-export-tools"><div className="workbench-actions"><Button size="sm" variant="light" onPress={() => setSelected(enabledTools.map(tool => tool.name))}>全选已启用</Button><Button size="sm" variant="light" onPress={() => setSelected([])}>清空选择</Button></div>{tools.map(tool => <Checkbox key={tool.name} className={`settings-next-checkbox ${`mcp-export-tool ${tool.enabled === false ? 'is-disabled' : ''}`}`} size="sm" isDisabled={tool.enabled === false} isSelected={tool.enabled !== false && selected.includes(tool.name)} onValueChange={selected => setSelected(current => selected ? [...new Set([...current, tool.name])] : current.filter(entry => entry !== tool.name))}><span>{tool.name}</span><small>{tool.description || '暂无描述'}</small></Checkbox>)}</div>}
        <div className="workbench-actions resource-footer"><Button size="sm" color="primary" isLoading={busy === '保存发布配置'} onPress={() => void run('保存发布配置', () => api.request<McpExportConfigDTO>('/mcp/export', 'PUT', mcpExportPayload(draft, mode, selected)))}>保存发布配置</Button>{draft.enabled && <code className="mcp-endpoint resource-footer-endpoint">{draft.endpointUrl}</code>}</div>
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
  return <section className="workbench-card resource-panel mcp-tunnel-panel">
    <div className="resource-panel-heading"><div><strong>Cloudflare 隧道</strong><p>将 MCP 连接地址临时发布到公网</p></div><span className={`tag ${status?.running ? 'is-ok' : ''}`} role="status">{TUNNEL_STATES[status?.state || 'stopped'] || '未启动'}</span><Button className="settings-outlined-action" size="sm" variant="light" onPress={() => void load()}>刷新</Button></div>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {status?.error && <p role="alert" className="settings-error">{status.error}</p>}
    {status && !status.installed && <p className="section-note">未检测到 cloudflared，请先安装并加入 PATH，或填写下面的可执行文件路径。</p>}
    {!exportEnabled && <p className="section-note">请先启用上面的 Loopra MCP 工具发布配置。</p>}
    <Field label={"cloudflared 路径（可选）"} aria-label={"cloudflared 路径"} placeholder={"PATH 中的 cloudflared 或完整文件路径"} value={(path) ?? ''} onChange={value => { edited.current = true; setPath(value); }} />
    <div className="workbench-actions resource-footer">
      <div className="resource-footer-endpoint"><span>{status?.publicUrl ? '公网 MCP 地址' : '本地 MCP 地址'}</span><code>{url}</code></div>
      <Button size="sm" variant="light" isLoading={busy === '保存路径'} onPress={() => void run('保存路径', () => api.request<TunnelStatus>('/mcp/tunnel/config', 'PUT', tunnelConfigPayload(path)), true)}>保存路径</Button>
      {active
        ? <Button size="sm" color="danger" isLoading={busy === '停止隧道'} isDisabled={status?.state === 'stopping'} onPress={() => void run('停止隧道', () => api.request<TunnelStatus>('/mcp/tunnel/stop', 'POST', {}))}>停止隧道</Button>
        : <Button size="sm" color="primary" isLoading={busy === '启动隧道'} isDisabled={!exportEnabled || channel === 'sse'} onPress={() => void run('启动隧道', () => api.request<TunnelStatus>('/mcp/tunnel/start', 'POST', tunnelConfigPayload(path)))}>启动临时隧道</Button>}
      {status?.publicUrl && <Button size="sm" variant="light" onPress={() => void navigator.clipboard?.writeText(status.publicUrl!)}>复制公网地址</Button>}
    </div>
    {status?.executablePath && <p className="section-note">{status.executablePath}</p>}
    <p className="section-note">Quick Tunnel 地址临时随机，应用退出后失效；只代理 MCP 路径。Quick Tunnel 不支持 SSE，请使用 Streamable HTTP。</p>
  </section>;
}
