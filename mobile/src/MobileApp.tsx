import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner, Textarea } from '@nextui-org/react';
import { Link, QrCode, RefreshCw, Unplug } from 'lucide-react';
import MobileWorkspace from './MobileWorkspace';
import { paintPreferences, readPreferences, savePreferences } from './preferences';
import type { MobilePreferences } from './preferences';
import { clearPairing, loadPairing, savePairing } from './pairing-store';
import { scanPairing } from './scanner';
import { pairingOrigin, parsePairingLink, type Pairing } from './relay/pairing';
import { installRelayFetch } from './relay/fetch';
import { RelayTransport, type RelayState } from './relay/transport';

type Connection = { pairing: Pairing; origin: string };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function MobileApp() {
  const [connection, setConnection] = useState<Connection>();
  const [saved, setSaved] = useState<Pairing | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [state, setState] = useState<RelayState>('disconnected');
  const current = useRef<{ transport: RelayTransport; restore?: () => void }>();
  const revision = useRef(0);
  const pending = useRef(false);
  const disposed = useRef(false);
  const scanning = useRef<AbortController>();
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    paintPreferences(preferences);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => paintPreferences(preferences);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preferences]);
  function changePreferences(value: MobilePreferences) {
    try { savePreferences(value); setPreferences(value); }
    catch { setError('外观设置保存失败'); }
  }

  const disconnect = useCallback(() => {
    revision.current++;
    current.current?.restore?.(); current.current?.transport.close(); current.current = undefined;
    pending.current = false; setBusy(false); setConnection(undefined); setState('disconnected');
  }, []);

  const connect = useCallback(async (pairing: Pairing) => {
    if (pending.current) return;
    pending.current = true;
    const id = ++revision.current;
    current.current?.restore?.(); current.current?.transport.close();
    setConnection(undefined); setBusy(true); setError('');
    const transport = new RelayTransport(pairing);
    current.current = { transport };
    transport.onState = (next, failure) => { if (id === revision.current && !disposed.current) { setState(next); if (failure) setError(failure.message); } };
    try {
      await transport.connect();
      const response = await transport.fetch('/api/mobile/handshake', { signal: AbortSignal.timeout(10000) });
      const body: unknown = await response.json();
      const envelope = body as { success?: boolean; data?: { protocol?: string; version?: number } };
      if (!response.ok || envelope?.success !== true || envelope.data?.protocol !== 'loopra-relay' || envelope.data.version !== 1) throw new Error('桌面尚未支持 Loopra Mobile，请更新桌面端后重新配对');
      if (id !== revision.current || disposed.current) { transport.close(); return; }
      const origin = await pairingOrigin(pairing);
      await savePairing(pairing);
      if (id !== revision.current || disposed.current) { transport.close(); return; }
      current.current = { transport, restore: installRelayFetch(transport, origin) };
      setSaved(pairing); setConnection({ pairing, origin }); setLink('');
    } catch (cause) {
      transport.close();
      if (id === revision.current && !disposed.current) setError(errorMessage(cause));
    } finally {
      if (id === revision.current && !disposed.current) { pending.current = false; setBusy(false); }
    }
  }, []);

  useEffect(() => {
    disposed.current = false;
    let active = true;
    void loadPairing().then(pairing => {
      if (!active) return;
      setSaved(pairing);
      if (pairing) void connect(pairing);
    }).catch(cause => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setBooting(false); });
    return () => { active = false; disposed.current = true; revision.current++; pending.current = false; scanning.current?.abort(); current.current?.restore?.(); current.current?.transport.close(); current.current = undefined; };
  }, [connect]);

  async function submit() {
    if (busy) return;
    try { await connect(parsePairingLink(link)); } catch (cause) { setError(errorMessage(cause)); }
  }
  async function scan() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    const controller = new AbortController(); scanning.current = controller;
    try {
      const scanned = await scanPairing(controller.signal);
      if (disposed.current) return;
      setLink(scanned);
      const pairing = parsePairingLink(scanned);
      pending.current = false; await connect(pairing);
    } catch (cause) { if (!disposed.current) setError(errorMessage(cause)); }
    finally { if (scanning.current === controller) scanning.current = undefined; if (!disposed.current) { pending.current = false; setBusy(false); } }
  }
  async function forget() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await clearPairing(); disconnect(); setSaved(null); setError(''); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { if (!disposed.current) { pending.current = false; setBusy(false); } }
  }

  if (connection) return <MobileWorkspace key={connection.origin} origin={connection.origin} hostname={new URL(connection.pairing.relayUrl).hostname} online={state === 'connected'} error={error} onReconnect={() => void connect(connection.pairing)} onDisconnect={disconnect} preferences={preferences} onPreferences={changePreferences} />;

  return <main className="mobile-pairing">
    <div className="mobile-pairing-content">
      <img className="mobile-brand" src={`${import.meta.env.BASE_URL}loopra-logo.svg`} alt="" aria-hidden="true" />
      <h1>Loopra</h1>
      {booting ? <Spinner label="读取连接" /> : <>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <Textarea label="配对链接" labelPlacement="outside" variant="bordered" value={link} onValueChange={setLink} placeholder="loopra://connect?…" minRows={3} isDisabled={busy} />
          <div className="mobile-pairing-actions">
            <Button color="primary" size="lg" isDisabled={busy} onPress={() => void scan()} startContent={<QrCode size="1.25rem" />}>扫描二维码</Button>
            <Button type="submit" size="lg" variant="bordered" isLoading={busy} isDisabled={busy || !link.trim()} startContent={<Link size="1.1rem" />}>连接</Button>
          </div>
        </form>
        {saved && <div className="mobile-saved-connection"><Button variant="light" isDisabled={busy} onPress={() => void connect(saved)} startContent={<RefreshCw size="1rem" />}>重新连接</Button><Button className="phone-icon" isIconOnly variant="light" aria-label="忘记连接" isDisabled={busy} onPress={() => void forget()}><Unplug size="1rem" /></Button></div>}
        {error && <p className="mobile-pairing-error" role="alert">{error}</p>}
        <p className="mobile-pairing-note">扫描桌面端「设置 → 远程访问」中的二维码。</p>
      </>}
    </div>
  </main>;
}
