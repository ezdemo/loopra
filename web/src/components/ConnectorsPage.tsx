import { useCallback, useState } from 'react';
import { Button, Checkbox, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch } from '@nextui-org/react';
import { EllipsisVertical, MessageSquarePlus, Plus } from 'lucide-react';
import type { LoopraClient } from '../backend';
import {
  connectorsForView, customDescription, customStatusDisplay, filterConnectors, installedCustomConnectors,
  sortConnectors, statusDisplay, type ConnectorItem, type ConnectorsList, type CustomConnector,
} from '../connectors';
import { CapabilityCard, CapabilityControls, CapabilitySelect } from './CapabilityUI';
import { ConnectorConnectDialog } from './ConnectorConnectDialog';
import { CustomConnectorDialog } from './CustomConnectorDialog';
import { OAuthWaiting, useOAuthFlow } from './OAuthFlow';
import { ConfirmAction, errorText, query, RemoteState, useRemote } from './RemoteControls';
import { IconButton } from './ui';

export default function ConnectorsPage({ api, notify, onStartChat, view = 'installed', searchQuery = '', refreshKey = 0, toolbarTarget, onViewChange }: {
  api: LoopraClient;
  notify: (message: string) => void;
  onStartChat?: (connectorId: string) => void;
  view?: 'installed' | 'discover';
  searchQuery?: string;
  refreshKey?: number;
  toolbarTarget?: HTMLElement | null;
  onViewChange?: (view: 'installed' | 'discover') => void;
}) {
  const [revision, setRevision] = useState(0);
  const state = useRemote<ConnectorsList>(api, '/connectors', refreshKey + revision);
  const [category, setCategory] = useState('all');
  const [connecting, setConnecting] = useState<ConnectorItem | null>(null);
  const [toolsFor, setToolsFor] = useState<ConnectorItem | null>(null);
  const [disconnecting, setDisconnecting] = useState<ConnectorItem | null>(null);
  const [customToolsFor, setCustomToolsFor] = useState<string | null>(null);
  const [editingCustom, setEditingCustom] = useState<string | null>(null);
  const [addingCustom, setAddingCustom] = useState(false);
  const [authorizing, setAuthorizing] = useState<CustomConnector | null>(null);
  const [deleting, setDeleting] = useState<CustomConnector | null>(null);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  const categories = state.data?.categories || [];
  const discover = view === 'discover';
  const scoped = connectorsForView(state.data?.connectors || [], view);
  const items = sortConnectors(filterConnectors(scoped, discover ? category : 'all', searchQuery));
  const custom = installedCustomConnectors(state.data?.custom, searchQuery);
  const takenNames = (state.data?.custom || []).map(server => server.name)
    .concat((state.data?.connectors || []).map(item => item.id));

  async function toggle(item: ConnectorItem, enabled: boolean) {
    try {
      await api.request(`/connectors/${encodeURIComponent(item.id)}/toggle`, 'POST', { enabled });
      refresh();
    } catch (cause) { notify(`操作失败：${errorText(cause)}`); }
  }

  async function toggleCustom(server: CustomConnector, enabled: boolean) {
    try {
      await api.request('/mcp/servers/toggle', 'POST', { name: server.name, enabled });
      refresh();
    } catch (cause) { notify(`操作失败：${errorText(cause)}`); }
  }

  async function signOut(server: CustomConnector) {
    try {
      await api.request(`/connectors/custom/${encodeURIComponent(server.name)}/signout`, 'POST');
      notify(`${server.name} 已退出登录`);
      refresh();
    } catch (cause) { notify(`操作失败：${errorText(cause)}`); }
  }

  return <div className="connectors-page">
    {discover && <CapabilityControls library target={toolbarTarget}>
      <CapabilitySelect label="服务分类" value={category} onChange={setCategory}
        options={[{ value: 'all', label: '全部' }, ...categories.map(item => ({ value: item.id, label: item.name }))]} />
    </CapabilityControls>}
    <RemoteState {...state} />
    {state.data && !items.length && !custom.length && (discover
      ? <p className="composer-empty connectors-empty">{searchQuery || category !== 'all' ? '没有匹配的连接器' : '暂无可用的连接器'}</p>
      : <div className="composer-empty connectors-empty connectors-empty-installed">
          {searchQuery ? '没有匹配的连接器' : <>
            <p>还没有连接任何服务</p>
            {onViewChange && <Button size="sm" color="primary" variant="flat" onPress={() => onViewChange('discover')}>去发现</Button>}
          </>}
        </div>)}
    <div className="library-grid connectors-grid">
      {discover && <CapabilityCard className="connector-card"
        title="自定义连接器" description="连接任意 MCP 服务"
        icon={<Plus size="1.125rem" />}
        actions={<IconButton label="添加自定义连接器" onClick={() => setAddingCustom(true)}><Plus size="1rem" /></IconButton>}>
      </CapabilityCard>}
      {items.map(item => {
        const display = statusDisplay(item.status);
        const connected = item.status === 'connected';
        const reauth = item.status === 'needs_reauth';
        const missing = item.status === 'missing_requirement';
        return <CapabilityCard key={item.id} className={`connector-card is-${item.status}`}
          title={item.name} description={item.description}
          icon={item.name.slice(0, 1)} iconStyle={item.color ? { background: item.color, color: '#fff', borderColor: 'transparent' } : undefined}
          badge={<span className={`connector-status is-${display.tone}`}><i />{display.label}</span>}
          meta={missing ? <a className="connector-requirement" href="https://nodejs.org" target="_blank" rel="noreferrer">需要 Node.js</a> : undefined}
          actions={<>
            {connected && <Switch size="sm" aria-label={`启用 ${item.name}`} isSelected={item.enabled} onValueChange={value => void toggle(item, value)} />}
            {connected && onStartChat && <Button size="sm" variant="flat" color="primary" startContent={<MessageSquarePlus size="0.9375rem" />} onPress={() => onStartChat(item.id)}>去对话</Button>}
            {(connected || reauth) && <Dropdown placement="bottom-end">
              <DropdownTrigger><Button isIconOnly size="sm" variant="light" aria-label={`${item.name} 更多操作`}><EllipsisVertical size="1rem" /></Button></DropdownTrigger>
              <DropdownMenu aria-label={`${item.name} 操作`} onAction={key => {
                if (key === 'tools') setToolsFor(item);
                if (key === 'reauth') setConnecting(item);
                if (key === 'disconnect') setDisconnecting(item);
              }}>
                <DropdownItem key="tools">查看工具</DropdownItem>
                <DropdownItem key="reauth">重新授权</DropdownItem>
                {connected ? <DropdownItem key="disconnect" color="danger" className="text-danger">断开连接</DropdownItem> : null}
              </DropdownMenu>
            </Dropdown>}
            {reauth && <Button size="sm" color="primary" onPress={() => setConnecting(item)}>重新授权</Button>}
            {!connected && !reauth && <IconButton label={`连接 ${item.name}`} isDisabled={missing} onClick={() => setConnecting(item)}><Plus size="1rem" /></IconButton>}
          </>}>
        </CapabilityCard>;
      })}
      {!discover && custom.map(server => <CustomCard key={server.name} server={server}
        onStartChat={onStartChat}
        onToggle={enabled => void toggleCustom(server, enabled)}
        onTools={() => setCustomToolsFor(server.name)}
        onEdit={() => setEditingCustom(server.name)}
        onSignIn={() => setAuthorizing(server)}
        onSignOut={() => void signOut(server)}
        onDelete={() => setDeleting(server)} />)}
    </div>

    {connecting && <ConnectorConnectDialog key={`${connecting.id}-${connecting.status}`} api={api} item={connecting} notify={notify}
      onClose={() => setConnecting(null)} onDone={() => { setConnecting(null); refresh(); }} />}
    {toolsFor && <ConnectorTools api={api} item={toolsFor} onClose={() => setToolsFor(null)} />}
    {disconnecting && <ConfirmAction title={`断开 ${disconnecting.name}`}
      action={() => api.request(`/connectors/${encodeURIComponent(disconnecting.id)}/disconnect`, 'POST')}
      onClose={() => setDisconnecting(null)} onDone={refresh}>
      <p>断开连接会删除已保存的凭据，{disconnecting.name} 的工具将不再可用。</p>
    </ConfirmAction>}
    {customToolsFor && <CustomTools api={api} name={customToolsFor} notify={notify} onClose={() => setCustomToolsFor(null)} />}
    {addingCustom && <CustomConnectorDialog api={api} takenNames={takenNames} notify={notify}
      onClose={() => setAddingCustom(false)} onDone={() => { setAddingCustom(false); refresh(); }} />}
    {editingCustom && <CustomConnectorDialog key={editingCustom} api={api} name={editingCustom} takenNames={takenNames} notify={notify}
      onClose={() => setEditingCustom(null)} onDone={() => { setEditingCustom(null); refresh(); }} />}
    {authorizing && <CustomAuthorize api={api} server={authorizing} notify={notify}
      onClose={() => setAuthorizing(null)} onDone={() => { setAuthorizing(null); refresh(); }} />}
    {deleting && <ConfirmAction title={`删除 ${deleting.name}`}
      action={() => api.request('/mcp/servers/remove', 'POST', { name: deleting.name })}
      onClose={() => setDeleting(null)} onDone={refresh}>
      <p>删除后该服务及其授权凭据将被移除。</p>
    </ConfirmAction>}
  </div>;
}

function CustomCard({ server, onStartChat, onToggle, onTools, onEdit, onSignIn, onSignOut, onDelete }: {
  server: CustomConnector;
  onStartChat?: (connectorId: string) => void;
  onToggle: (enabled: boolean) => void;
  onTools: () => void;
  onEdit: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onDelete: () => void;
}) {
  const display = customStatusDisplay(server);
  const remote = server.type !== 'stdio';
  const reauth = server.authStatus === 'needs_reauth';
  const signedIn = server.authStatus === 'connected';
  return <CapabilityCard className="connector-card"
    title={server.name} description={customDescription(server)}
    icon={server.name.slice(0, 1)}
    badge={<span className={`connector-status is-${display.tone === 'success' ? 'ok' : display.tone === 'warning' ? 'warn' : 'muted'}`}><i />{display.label}</span>}
    actions={<>
      <Switch size="sm" aria-label={`启用 ${server.name}`} isSelected={server.enabled} onValueChange={onToggle} />
      {onStartChat && <Button size="sm" variant="flat" color="primary" startContent={<MessageSquarePlus size="0.9375rem" />} onPress={() => onStartChat(server.name)}>去对话</Button>}
      <Dropdown placement="bottom-end">
        <DropdownTrigger><Button isIconOnly size="sm" variant="light" aria-label={`${server.name} 更多操作`}><EllipsisVertical size="1rem" /></Button></DropdownTrigger>
        <DropdownMenu aria-label={`${server.name} 操作`} onAction={key => {
          if (key === 'tools') onTools();
          if (key === 'edit') onEdit();
          if (key === 'signin') onSignIn();
          if (key === 'signout') void onSignOut();
          if (key === 'delete') onDelete();
        }}>
          <DropdownItem key="tools">查看工具</DropdownItem>
          <DropdownItem key="edit">编辑</DropdownItem>
          {remote && !signedIn ? <DropdownItem key="signin">{reauth ? '重新授权' : '登录'}</DropdownItem> : null}
          {remote && signedIn ? <DropdownItem key="signout">退出登录</DropdownItem> : null}
          <DropdownItem key="delete" color="danger" className="text-danger">删除</DropdownItem>
        </DropdownMenu>
      </Dropdown>
    </>}>
  </CapabilityCard>;
}

// 自定义远程服务的登录 / 重新授权：打开与内置连接器一致的等待态。
function CustomAuthorize({ api, server, notify, onClose, onDone }: {
  api: LoopraClient; server: CustomConnector; notify: (message: string) => void;
  onClose: () => void; onDone: () => void;
}) {
  const [error, setError] = useState('');
  const { phase, authURL, blocked, preopen, start, fail, cancel } =
    useOAuthFlow(api, () => { notify(`${server.name} 已连接`); onDone(); });
  const [started, setStarted] = useState(false);

  if (!started) {
    setStarted(true);
    preopen();
    void api.request<{ flowId: string; authorizationUrl: string }>(
      `/connectors/custom/${encodeURIComponent(server.name)}/authorize`, 'POST')
      .then(result => start(result.flowId, result.authorizationUrl))
      .catch(cause => { fail(); setError(errorText(cause)); });
  }

  function close() {
    if (phase === 'waiting') void cancel();
    onClose();
  }

  return <Modal isOpen onClose={close} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog connector-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={`登录 ${server.name}`}>
    <ModalContent>
      <ModalHeader className="app-dialog-header"><h2>登录 {server.name}</h2></ModalHeader>
      <ModalBody className="app-dialog-body">
        {phase === 'waiting' && <OAuthWaiting name={server.name} authURL={authURL} blocked={blocked} />}
        {phase === 'failed' && <p role="alert" className="settings-error">授权失败，请重试。</p>}
        {!!error && <p role="alert" className="settings-error">{error}</p>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer">
        {phase === 'waiting' && <Button size="sm" variant="light" onPress={() => void cancel()}>取消</Button>}
        {phase !== 'waiting' && <Button size="sm" variant="light" onPress={close}>关闭</Button>}
      </ModalFooter>
    </ModalContent>
  </Modal>;
}

// 自定义服务的工具列表与逐工具权限（沿用 /mcp/servers/tools 读写）。
function CustomTools({ api, name, notify, onClose }: {
  api: LoopraClient; name: string; notify: (message: string) => void; onClose: () => void;
}) {
  const state = useRemote<{ connected: boolean; tools: { name: string; description: string }[]; disallowedTools: string[] }>(api, `/mcp/servers/tools?${query({ name })}`);
  const [denied, setDenied] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = denied || state.data?.disallowedTools || [];
  return <Modal isOpen onClose={onClose} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog connector-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={`${name} 工具`}>
    <ModalContent>
      <ModalHeader className="app-dialog-header"><h2>{name} · 工具</h2></ModalHeader>
      <ModalBody className="app-dialog-body">
        <RemoteState {...state} />
        {state.data && !state.data.connected && <p>服务未连接，请先检查配置。</p>}
        <ul className="connector-tool-list connector-tool-permissions">
          {state.data?.tools.map(tool => <li key={tool.name}>
            <Checkbox size="sm" title={tool.description} isSelected={!selected.includes(tool.name)}
              onValueChange={checked => setDenied(checked ? selected.filter(entry => entry !== tool.name) : [...selected, tool.name])}>
              <strong>{tool.name}</strong>
            </Checkbox>
            {tool.description && <small>{tool.description}</small>}
          </li>)}
        </ul>
        {!!error && <p role="alert" className="settings-error">{error}</p>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer">
        <Button size="sm" variant="light" onPress={onClose}>关闭</Button>
        <Button size="sm" color="primary" isLoading={busy} isDisabled={!state.data}
          onPress={() => {
            setBusy(true);
            void api.request('/mcp/servers/tools/save', 'POST', { serverName: name, disallowedTools: selected })
              .then(() => { notify(`${name} 权限已保存`); onClose(); })
              .catch(cause => setError(errorText(cause)))
              .finally(() => setBusy(false));
          }}>保存权限</Button>
      </ModalFooter>
    </ModalContent>
  </Modal>;
}

function ConnectorTools({ api, item, onClose }: { api: LoopraClient; item: ConnectorItem; onClose: () => void }) {
  const state = useRemote<{ connected: boolean; tools: { name: string; description: string }[] }>(api, `/connectors/${encodeURIComponent(item.id)}/tools`);
  return <Modal isOpen onClose={onClose} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog connector-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={`${item.name} 工具`}>
    <ModalContent>
      <ModalHeader className="app-dialog-header"><h2>{item.name} · 工具</h2></ModalHeader>
      <ModalBody className="app-dialog-body">
        <RemoteState {...state} />
        {state.data && !state.data.connected && <p>暂时无法连接，请稍后再试。</p>}
        <ul className="connector-tool-list">
          {state.data?.tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</li>)}
        </ul>
      </ModalBody>
      <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" onPress={onClose}>关闭</Button></ModalFooter>
    </ModalContent>
  </Modal>;
}
