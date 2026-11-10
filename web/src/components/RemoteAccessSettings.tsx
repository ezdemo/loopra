import { useEffect, useRef, useState } from 'react';
import { Button } from '@nextui-org/react';
import { Copy, Download, RefreshCw, Trash2 } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { useRemoteRelay } from '../useRemoteRelay';
import { Field, PageActions, TextField } from './SettingControls';
import { ConfirmAction, RemoteState } from './RemoteControls';
import { IconButton } from './ui';
import './remote-access-settings.css';

const states: Record<string, string> = { disabled: '未启用', stopped: '已停止', connecting: '连接中', connected: '中继已连接', reconnecting: '正在重连', rejected: '连接被拒绝' };
type Props = { api: LoopraClient; notify: (message: string) => void; onNestedDialog?: (open: boolean) => void };

export default function RemoteAccessSettings(props: Props) {
  return <RemoteAccessPanel key={props.api.base} {...props} />;
}

function RemoteAccessPanel({ api, notify, onNestedDialog }: Props) {
  const remote = useRemoteRelay(api);
  const { status, loading, busy, error } = remote;
  const [relayUrl, setRelayUrl] = useState('');
  const [registrationKey, setRegistrationKey] = useState('');
  const [keyChanged, setKeyChanged] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [copyError, setCopyError] = useState('');
  const pairingLink = status?.pairingLink;
  const qrCode = status?.qrCode;
  const dirty = useRef(false);
  useEffect(() => { if (status && !dirty.current) setRelayUrl(status.relayUrl || ''); }, [status]);
  useEffect(() => {
    if (!resetting) return;
    onNestedDialog?.(true);
    return () => onNestedDialog?.(false);
  }, [resetting, onNestedDialog]);

  async function save() {
    const next = await remote.save({ enabled: true, relayUrl: relayUrl.trim(), ...(keyChanged ? { registrationKey } : {}) });
    if (!next) return;
    dirty.current = false;
    setRelayUrl(next.relayUrl || '');
    setRegistrationKey('');
    setKeyChanged(false);
    notify('远程访问配置已保存');
  }

  async function copyLink() {
    if (!pairingLink) return;
    setCopyError('');
    try { await navigator.clipboard.writeText(pairingLink); notify('配对链接已复制'); }
    catch { setCopyError('复制失败，请选择下方链接手动复制。'); }
  }

  return <div className="settings-resource-page remote-access-settings">
    <PageActions title="远程访问">
      {status && <span className={`remote-access-status ${status.state === 'connected' ? 'is-connected' : ''}`} role="status">{states[status.state] || status.state}</span>}
      <IconButton label="刷新远程访问" onClick={() => void remote.refresh()} isDisabled={!!busy || loading}><RefreshCw size="1rem" /></IconButton>
    </PageActions>
    <RemoteState loading={!status && loading} error={error} />
    {!status && error && <Button size="sm" variant="flat" onPress={() => void remote.refresh()}>重试</Button>}
    {status && <>
      <div className="remote-access-layout">
        <form className="remote-access-form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <Field label="中继地址" type="url" required disabled={!!busy} placeholder="https://relay.example.com" value={relayUrl} onChange={value => { dirty.current = true; setRelayUrl(value); }} />
          <Field label="注册密钥（可选）" type="password" autoComplete="new-password" disabled={!!busy} value={registrationKey} placeholder={keyChanged ? '不使用注册密钥' : status.hasRegistrationKey ? '已保存，留空保持不变' : '无需认证时留空'} onChange={value => { dirty.current = true; setKeyChanged(true); setRegistrationKey(value); }} endContent={(status.hasRegistrationKey || registrationKey) && <IconButton label="清除注册密钥" isDisabled={!!busy} onClick={() => { dirty.current = true; setKeyChanged(true); setRegistrationKey(''); }}><Trash2 size="1rem" /></IconButton>} />
          <div className="workbench-actions remote-access-actions">
            <Button type="submit" size="sm" color="primary" isLoading={busy === 'save'} isDisabled={!!busy || !relayUrl.trim()}>{status.enabled ? '保存并重连' : '保存并连接'}</Button>
            {status.enabled && <Button size="sm" variant="light" isLoading={busy === 'stop'} isDisabled={!!busy} onPress={() => void remote.save({ enabled: false })}>停用</Button>}
          </div>
          {status.state === 'rejected' && <p className="settings-error" role="alert">中继拒绝了连接，请检查注册密钥，或是否有其他设备使用同一配对信息。</p>}
        </form>
        {pairingLink && qrCode && <div className="remote-access-pairing">
          <img className="remote-access-qr" src={qrCode} alt="Loopra Mobile 配对二维码" width={256} height={256} />
          <Button as="a" size="sm" variant="light" href={qrCode} download="loopra-pairing.png" startContent={<Download size="1rem" />}>保存二维码</Button>
        </div>}
      </div>
      {pairingLink && <section className="remote-access-link">
        <TextField label="配对链接" aria-label="配对链接" value={pairingLink} onChange={() => {}} isReadOnly rows={2} />
        <div className="workbench-actions"><Button size="sm" variant="flat" startContent={<Copy size="1rem" />} onPress={() => void copyLink()}>复制链接</Button><Button size="sm" variant="light" isDisabled={!!busy} onPress={() => setResetting(true)}>重置配对</Button></div>
        {copyError && <p role="alert" className="settings-error">{copyError}</p>}
      </section>}
      <p className="section-note">在 Loopra Mobile 扫码或粘贴链接连接。配对信息仅交给你信任的设备。</p>
    </>}
    {resetting && <ConfirmAction title="重置配对" onClose={() => setResetting(false)} action={async () => { if (!await remote.resetPairing()) throw new Error('重置配对失败，请重试。'); }}><p>已配对的手机将断开，需要使用新链接重新配对。</p></ConfirmAction>}
  </div>;
}
