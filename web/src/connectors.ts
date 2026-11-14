// 连接器目录与会话开关的纯逻辑：协议类型、筛选、状态展示与
// 授权流程轮询归约。UI 无关，供 ConnectorsPage 与 Composer 复用。

export type ConnectorField = { key: string; label: string; secret?: boolean };
export type ConnectorStatus = 'available' | 'connected' | 'needs_reauth' | 'missing_requirement';
export type ConnectorAuthType = 'oauth' | 'token' | 'credentials';

export type ConnectorItem = {
  id: string;
  name: string;
  category: string;
  color?: string;
  description?: string;
  capabilities?: string[];
  docsUrl?: string;
  status: ConnectorStatus;
  enabled: boolean;
  connectedAt?: number;
  authType: ConnectorAuthType;
  authClient?: string;
  fields: ConnectorField[];
  configuredFields?: string[];
  helpUrl?: string;
  requires?: string[];
  requirementsMet: boolean;
};

export type ConnectorCategory = { id: string; name: string };

export type ConnectorsList = {
  categories: ConnectorCategory[];
  connectors: ConnectorItem[];
  custom: CustomConnector[];
};

export type ConnectorFlowView = { status: 'pending' | 'connected' | 'failed' | 'cancelled'; error?: string };
export type ConnectorSessionItem = { id: string; name: string; enabled: boolean; override?: boolean; custom?: boolean };

// filterConnectors 按分类与搜索词（名称、说明、能力）过滤。
export function filterConnectors(connectors: ConnectorItem[], category: string, query: string): ConnectorItem[] {
  const needle = query.trim().toLowerCase();
  return connectors.filter(item => {
    if (category && category !== 'all' && item.category !== category) return false;
    if (!needle) return true;
    return [item.name, item.description || '', ...(item.capabilities || [])].join(' ').toLowerCase().includes(needle);
  });
}

// sortConnectors 已连接的排前面，组内保持目录顺序。
export function sortConnectors(connectors: ConnectorItem[]): ConnectorItem[] {
  const weight = (item: ConnectorItem) => item.status === 'connected' ? 0 : item.status === 'needs_reauth' ? 1 : 2;
  return connectors.map((item, index) => ({ item, index }))
    .sort((a, b) => weight(a.item) - weight(b.item) || a.index - b.index)
    .map(entry => entry.item);
}

// statusDisplay 不只用颜色表达状态。
export function statusDisplay(status: ConnectorStatus): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (status) {
    case 'connected': return { label: '已连接', tone: 'ok' };
    case 'needs_reauth': return { label: '需要重新授权', tone: 'warn' };
    case 'missing_requirement': return { label: '缺少运行环境', tone: 'muted' };
    default: return { label: '未连接', tone: 'muted' };
  }
}

// connectPayload 组装 POST /connectors/{id}/connect 的请求体，
// 去掉空白字段。
export function connectPayload(fields: Record<string, string>): { fields: Record<string, string> } {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value.trim() !== '') clean[key] = value;
  }
  return { fields: clean };
}

// missingFields 返回尚未填写的必填字段 key。
export function missingFields(item: ConnectorItem, fields: Record<string, string>): string[] {
  return item.fields.filter(field => !(fields[field.key] || '').trim()).map(field => field.key);
}

// FlowPhase 是授权对话框的阶段：表单 → 等待授权 → 结果。
export type FlowPhase = 'form' | 'waiting' | 'connected' | 'failed' | 'cancelled';

export const initialFlowPhase: FlowPhase = 'form';

// reduceFlow 把轮询到的流程状态折叠成对话框阶段；form 阶段忽略
// 迟到的轮询结果。
export function reduceFlow(phase: FlowPhase, view: ConnectorFlowView): FlowPhase {
  if (phase !== 'waiting') return phase;
  if (view.status === 'pending') return 'waiting';
  return view.status;
}

// connectorRequestOf 识别 connector_request 工具挂到 schema 上的连接器
// 标记；命中时返回卡片所需的信息，否则返回 undefined。
export type ConnectorRequestNeed = 'connect' | 'enable' | 'reauth';
export type ConnectorRequest = { id: string; name: string; reason: string; needs: ConnectorRequestNeed };

export function connectorRequestOf(elicitation: { schema?: unknown } | null | undefined): ConnectorRequest | undefined {
  const schema = elicitation?.schema;
  if (!schema || typeof schema !== 'object') return undefined;
  const marker = (schema as Record<string, unknown>)['x-loopra-connector'];
  if (!marker || typeof marker !== 'object') return undefined;
  const { id, name, reason, needs } = marker as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return undefined;
  if (needs !== 'connect' && needs !== 'enable' && needs !== 'reauth') return undefined;
  return { id, name: typeof name === 'string' && name ? name : id, reason: typeof reason === 'string' ? reason : '', needs };
}

// connectorsForView 按「我的内容 / 发现」视图拆分内置连接器：
// 已连接或需重新授权的属于用户内容，可连接或缺运行环境的属于发现页。
export function connectorsForView(items: ConnectorItem[], view: 'installed' | 'discover'): ConnectorItem[] {
  const statuses: ConnectorStatus[] = view === 'installed' ? ['connected', 'needs_reauth'] : ['available', 'missing_requirement'];
  return items.filter(item => statuses.includes(item.status));
}

// ---- 自定义 MCP 服务：与内置连接器同格展示 ----

// GET /api/connectors 返回的自定义条目；头与 env 值永不下发。
export type CustomAuthStatus = 'none' | 'connected' | 'needs_reauth';
export type CustomConnector = {
  name: string;
  type: string;
  enabled: boolean;
  url?: string;
  command?: string;
  disallowedTools?: number;
  authStatus?: CustomAuthStatus;
};

// installedCustomConnectors 过滤「我的内容」里的自定义卡片：
// 按名称、地址与命令匹配搜索词。
export function installedCustomConnectors(custom: CustomConnector[] | undefined, query: string): CustomConnector[] {
  const list = custom || [];
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(item => [item.name, item.url, item.command].some(field => field && field.toLowerCase().includes(q)));
}

// customStatusDisplay 的状态行：需要重新授权 / 已连接 / 自定义。
export function customStatusDisplay(item: CustomConnector): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (item.authStatus === 'needs_reauth') return { label: '需要重新授权', tone: 'warning' };
  if (item.authStatus === 'connected') return { label: '已连接', tone: 'success' };
  return { label: '自定义', tone: 'neutral' };
}

// customDescription 的描述行：远程取主机名，本地取命令。
export function customDescription(item: CustomConnector): string {
  if (item.url) {
    try { return new URL(item.url).hostname; } catch { return item.url; }
  }
  return item.command || '';
}

// suggestConnectorName 从地址或命令推导服务名：
// mcp.notion.com → notion；npx -y @scope/pkg → pkg；/bin/foo → foo。
export function suggestConnectorName(input: { url?: string; command?: string; args?: string[] }): string {
  const clean = (raw: string) => raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  if (input.url) {
    let host = '';
    try { host = new URL(input.url).hostname; } catch { host = input.url; }
    const labels = host.split('.').filter(Boolean).filter(label => !['mcp', 'api', 'www'].includes(label));
    if (labels.length > 1) return clean(labels[0]);
    if (labels.length === 1) return clean(labels[0]);
  }
  if (input.command) {
    const base = input.command.split('/').pop() || input.command;
    if (['npx', 'uvx', 'bunx'].includes(base)) {
      const pkg = (input.args || []).find(arg => arg && !arg.startsWith('-'));
      if (pkg) {
        const tail = pkg.split('/').pop() || pkg;
        return clean(tail.replace(/^server-/, '') || tail);
      }
    }
    return clean(base);
  }
  return '';
}

// customDraft 是 CustomConnectorDialog 的表单态；与 McpServer DTO 互转，
// 编辑时以已加载的服务对象为底，仅覆盖表单涉及的字段。
export type CustomDraft = {
  mode: 'remote' | 'stdio';
  name: string;
  url: string;
  transport: 'streamable' | 'sse';
  command: string;
  argsText: string;
  headersText: string;
  envText: string;
  timeout: string;
  enabled: boolean;
};

export function customDraftFromServer(server: Record<string, any> | undefined): CustomDraft {
  const remote = !server || server.type !== 'stdio';
  const lines = (value: unknown) => Array.isArray(value) ? value.join('\n') : '';
  const pairs = (value: unknown, sep: string) => value && typeof value === 'object'
    ? Object.entries(value as Record<string, string>).map(([k, v]) => `${k}${sep}${v}`).join('\n') : '';
  return {
    mode: remote ? 'remote' : 'stdio',
    name: server?.name || '',
    url: server?.url || '',
    transport: server?.type === 'sse' ? 'sse' : 'streamable',
    command: server?.command || '',
    argsText: lines(server?.args),
    headersText: pairs(server?.headers, ': '),
    envText: pairs(server?.env, '='),
    timeout: server?.timeout || '',
    enabled: server?.enabled !== false,
  };
}

const namePattern = /^[a-zA-Z0-9_-]+$/;
function parsePairs(text: string, sep: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const index = line.indexOf(sep);
    if (index <= 0) continue;
    out[line.slice(0, index).trim()] = line.slice(index + sep.length).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// customDraftError 返回首个校验错误，无错返回空串。
export function customDraftError(draft: CustomDraft, takenNames: string[], originalName = ''): string {
  const name = draft.name.trim() || suggestConnectorName({ url: draft.url, command: draft.command, args: draftArgs(draft) });
  if (!namePattern.test(name)) return '名称只能包含字母、数字、下划线和连字符';
  if (name !== originalName && takenNames.includes(name)) return `已存在同名服务：${name}`;
  if (draft.mode === 'remote') {
    if (!draft.url.trim()) return '请填写服务地址';
    try {
      const parsed = new URL(draft.url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '地址必须是 http(s) URL';
    } catch { return '地址必须是 http(s) URL'; }
  } else if (!draft.command.trim()) return '请填写启动命令';
  if (draft.timeout.trim() && !/^\d+(\.\d+)?(ms|s|m|h)$/.test(draft.timeout.trim())) return '超时格式不正确（如 30s、500ms、2m）';
  return '';
}

function draftArgs(draft: CustomDraft): string[] {
  return draft.argsText.split('\n').map(line => line.trim()).filter(Boolean);
}

// customDraftPayload 生成 /mcp/servers add|update 的服务体；
// existing（编辑时已加载的服务）的未编辑字段与未知键原样保留。
export function customDraftPayload(draft: CustomDraft, existing?: Record<string, any>): Record<string, any> {
  const name = draft.name.trim() || suggestConnectorName({ url: draft.url, command: draft.command, args: draftArgs(draft) });
  const args = draftArgs(draft);
  const headers = draft.mode === 'remote' ? parsePairs(draft.headersText, ':') : undefined;
  const env = draft.mode === 'stdio' ? parsePairs(draft.envText, '=') : undefined;
  const server: Record<string, any> = { ...(existing || {}) };
  server.name = name;
  server.type = draft.mode === 'remote' ? draft.transport : 'stdio';
  server.enabled = draft.enabled;
  if (draft.mode === 'remote') {
    server.url = draft.url.trim();
    delete server.command;
    delete server.args;
    delete server.env;
  } else {
    server.command = draft.command.trim();
    if (args.length) server.args = args; else delete server.args;
    delete server.url;
    delete server.headers;
  }
  if (headers) server.headers = headers; else delete server.headers;
  if (env) server.env = env; else delete server.env;
  if (draft.timeout.trim()) server.timeout = draft.timeout.trim(); else delete server.timeout;
  return server;
}
