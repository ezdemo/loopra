import { useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { connectPayload, missingFields, type ConnectorItem } from '../connectors';
import { OAuthWaiting, useOAuthFlow } from './OAuthFlow';
import { errorText } from './RemoteControls';
import { Field } from './SettingControls';

// 连接对话框：连接器管理页与聊天内的连接卡片共用。
// OAuth 通过预开空白窗 + 轮询 flow 状态完成；令牌 / 凭据直接提交校验。
export function ConnectorConnectDialog({ api, item, notify, onClose, onDone }: {
  api: LoopraClient; item: ConnectorItem; notify: (message: string) => void;
  onClose: () => void; onDone: () => void;
}) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { phase, setPhase, authURL, blocked, preopen, start, fail, cancel } =
    useOAuthFlow(api, () => { notify(`${item.name} 已连接`); onDone(); });
  const oauth = item.authType === 'oauth';

  async function connect() {
    setBusy(true); setError('');
    try {
      if (!oauth) {
        await api.request(`/connectors/${encodeURIComponent(item.id)}/connect`, 'POST', connectPayload(fields));
        notify(`${item.name} 已连接`);
        onDone();
        return;
      }
      // 无论空白窗是否成功预开都先发起授权流：拿到 authorizationUrl
      // 后等待态会给出「打开授权页面」链接兜底。
      preopen();
      const result = await api.request<{ flowId: string; authorizationUrl: string }>(`/connectors/${encodeURIComponent(item.id)}/connect`, 'POST', connectPayload(fields));
      start(result.flowId, result.authorizationUrl);
    } catch (cause) {
      setError(errorText(cause));
      fail();
    } finally { setBusy(false); }
  }

  function close() {
    if (phase === 'waiting') void cancel();
    onClose();
  }

  const requiredMissing = missingFields(item, fields);
  return <Modal isOpen onClose={close} placement="center" scrollBehavior="inside"
    classNames={{ base: 'app-dialog connector-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={`连接 ${item.name}`}>
    <ModalContent>
      <ModalHeader className="app-dialog-header"><h2>连接 {item.name}</h2></ModalHeader>
      <ModalBody className="app-dialog-body">
        {!!item.capabilities?.length && phase !== 'waiting' && <ul className="connector-capabilities">
          {item.capabilities.map(capability => <li key={capability}>{capability}</li>)}
        </ul>}
        {phase === 'waiting' && <OAuthWaiting name={item.name} authURL={authURL} blocked={blocked} />}
        {phase === 'failed' && <p role="alert" className="settings-error">授权失败，请重试。</p>}
        {phase === 'form' && <>
          {item.fields.map(field => <Field key={field.key} label={field.label} required
            type={field.secret ? 'password' : 'text'} autoComplete="off"
            value={fields[field.key] || ''} onChange={value => setFields(current => ({ ...current, [field.key]: value }))} />)}
          {!!item.helpUrl && <a className="connector-help" href={item.helpUrl} target="_blank" rel="noreferrer">获取方式</a>}
          {!!error && <p role="alert" className="settings-error">{error}</p>}
        </>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer">
        {phase === 'waiting' && <Button size="sm" variant="light" onPress={() => void cancel()}>取消</Button>}
        {phase === 'form' && <>
          <Button size="sm" variant="light" onPress={onClose}>取消</Button>
          <Button size="sm" color="primary" isLoading={busy} isDisabled={requiredMissing.length > 0}
            onPress={() => void connect()}>{oauth ? '前往授权' : '连接'}</Button>
        </>}
        {(phase === 'failed' || phase === 'cancelled') && <Button size="sm" variant="light" onPress={() => setPhase('form')}>返回</Button>}
      </ModalFooter>
    </ModalContent>
  </Modal>;
}
