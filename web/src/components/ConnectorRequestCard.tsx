import { useState } from 'react';
import { Button } from '@nextui-org/react';
import { Cable } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { connectorRequestOf, type ConnectorItem, type ConnectorsList } from '../connectors';
import type { ElicitationRequest } from '../elicitation';
import { errorText } from './RemoteControls';
import { ConnectorConnectDialog } from './ConnectorConnectDialog';

// connector_request 工具提出的连接请求：在聊天里以卡片呈现，
// 用户可直接在卡片上完成连接 / 启用 / 授权，或暂时拒绝。
export default function ConnectorRequestCard({ api, sessionName, request, notify, onAnswer }: {
  api: LoopraClient;
  sessionName: string;
  request: ElicitationRequest;
  notify: (message: string) => void;
  onAnswer: (action: 'accept' | 'decline', content: Record<string, unknown>) => Promise<void>;
}) {
  const marker = connectorRequestOf(request);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<ConnectorItem | null>(null);
  if (!marker) return null;

  async function answer(action: 'accept' | 'decline') {
    setBusy(true);
    try { await onAnswer(action, {}); }
    catch (cause) { notify(`操作失败：${errorText(cause)}`); }
    finally { setBusy(false); }
  }

  async function connect() {
    if (!marker) return;
    setBusy(true);
    try {
      const list = await api.request<ConnectorsList>('/connectors', 'GET');
      const item = (list.connectors || []).find(candidate => candidate.id === marker.id);
      if (!item) throw new Error('连接器已不存在');
      setConnecting(item);
    } catch (cause) {
      notify(`打开连接失败：${errorText(cause)}`);
    } finally { setBusy(false); }
  }

  async function enable() {
    if (!marker) return;
    setBusy(true);
    try {
      await api.request('/connectors/session', 'PUT', { sessionName, id: marker.id, enabled: true });
      await onAnswer('accept', {});
    } catch (cause) {
      notify(`启用失败：${errorText(cause)}`);
    } finally { setBusy(false); }
  }

  return <>
    <div className="connector-request-card" role="group" aria-label={`连接 ${marker.name}`}>
      <span className="connector-request-avatar">{marker.name.slice(0, 1) || <Cable size="1rem" />}</span>
      <div className="connector-request-body">
        <strong>{marker.name}</strong>
        {!!marker.reason && <p>{marker.reason}</p>}
      </div>
      <div className="connector-request-actions">
        {marker.needs === 'enable'
          ? <Button size="sm" color="primary" isDisabled={busy} onPress={() => void enable()}>启用</Button>
          : <Button size="sm" color="primary" isDisabled={busy} onPress={() => void connect()}>连接</Button>}
        <Button size="sm" variant="light" isDisabled={busy} onPress={() => void answer('decline')}>暂不</Button>
      </div>
    </div>
    {connecting && <ConnectorConnectDialog api={api} item={connecting} notify={notify}
      onClose={() => setConnecting(null)}
      onDone={() => { setConnecting(null); void answer('accept'); }} />}
  </>;
}
