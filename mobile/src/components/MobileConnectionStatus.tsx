import { useEffect, useRef, useState } from 'react';
import { Button } from '@nextui-org/react';
import { Check, LoaderCircle, WifiOff } from 'lucide-react';

type Props = { online: boolean; reconnecting: boolean; busy: boolean; result?: number; error?: string; onReconnect: () => void };

export default function MobileConnectionStatus({ online, reconnecting, busy, result, error, onReconnect }: Props) {
  const previous = useRef({ online, reconnecting, result });
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const prior = previous.current;
    previous.current = { online, reconnecting, result };
    if (!online || reconnecting) { setNotice(''); return; }
    if (prior.online && !prior.reconnecting && prior.result === result) return;
    setNotice(prior.online ? '连接正常' : '连接已恢复');
    const timer = window.setTimeout(() => setNotice(''), 2400);
    return () => window.clearTimeout(timer);
  }, [online, reconnecting, result]);

  const active = reconnecting || busy;
  if (online && !active && !notice) return null;
  const label = active ? online ? '正在检查连接…' : '正在重新连接…' : online ? notice : error || '桌面连接已断开';
  return <div className={`app-connection-status ${online && !active ? 'is-restored' : active ? 'is-reconnecting' : 'is-offline'}`} role="status" aria-live="polite" aria-atomic="true">
    {active ? <LoaderCircle size={17} className="app-spin" aria-hidden="true" /> : online ? <Check size={17} aria-hidden="true" /> : <WifiOff size={17} aria-hidden="true" />}
    <span>{label}</span>
    {!online && <Button size="sm" variant="light" radius="full" isDisabled={busy} onPress={onReconnect}>{busy ? '重连中' : active ? '立即重试' : '重新连接'}</Button>}
  </div>;
}
