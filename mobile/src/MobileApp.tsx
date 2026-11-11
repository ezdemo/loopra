import { useCallback, useEffect, useRef, useState } from 'react';
import { Textarea } from '@nextui-org/react';
import { isTauri } from '@tauri-apps/api/core';
import { AlertCircle, Link, LoaderCircle, QrCode, RefreshCw, Unplug } from 'lucide-react';
import MobileWorkspace from './MobileWorkspace';
import { paintPreferences, readPreferences, savePreferences } from './preferences';
import type { MobilePreferences } from './preferences';
import { clearPairing, loadPairing, savePairing } from './pairing-store';
import { scanPairing } from './scanner';
import { pairingOrigin, parsePairingLink, validatePairing, type Pairing } from './relay/pairing';
import { installRelayFetch } from './relay/fetch';
import type { RelayState } from './relay/transport';
import { createRelayTransport, type RelayConnection } from './relay/connection';
import { onNativeBack, onNativeResume } from './native-back';

type Connection = { pairing: Pairing; origin: string };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const copyable = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .loopra-conversation .msg-body'));

export default function MobileApp() {
  const [connection, setConnection] = useState<Connection>();
  const [saved, setSaved] = useState<Pairing | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const [state, setState] = useState<RelayState>('disconnected');
  const [reconnectResult, setReconnectResult] = useState(0);
  const current = useRef<{ transport: RelayConnection; restore?: () => void }>(undefined);
  const revision = useRef(0);
  const pending = useRef(false);
  const disposed = useRef(false);
  const scanning = useRef<AbortController>(undefined);
  const autoReconnect = useRef(0);
  const autoReconnectTimer = useRef(0);
  const autoReconnectPaused = useRef(false);
  const stateRef = useRef<RelayState>('disconnected');
  const [preferences, setPreferences] = useState(readPreferences);
  stateRef.current = state;
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

  useEffect(() => {
    if (!isTauri()) return;
    const block = (event: MouseEvent) => {
      if (!copyable(event.target)) event.preventDefault();
    };
    document.addEventListener('contextmenu', block, true);
    return () => document.removeEventListener('contextmenu', block, true);
  }, []);

  useEffect(() => onNativeBack(() => {
    if (!scanning.current) return false;
    scanning.current.abort();
    return true;
  }), []);

  const disconnect = useCallback(() => {
    autoReconnectPaused.current = true;
    revision.current++;
    current.current?.restore?.(); current.current?.transport.close(); current.current = undefined;
    pending.current = false; setBusy(false); setConnection(undefined); setState('disconnected');
  }, []);

  const connect = useCallback(async (pairing: Pairing, preserve = false) => {
    if (pending.current) return;
    pending.current = true;
    const id = ++revision.current;
    current.current?.restore?.(); current.current?.transport.close();
    if (!preserve) setConnection(undefined);
    setBusy(true); setError('');
    const transport = createRelayTransport(pairing);
    current.current = { transport };
    transport.onState = (next, failure) => {
      if (id !== revision.current || disposed.current) return;
      setState(next);
      if (failure) setError(failure.message);
      else if (next === 'connected') setError('');
    };
    try {
      await transport.connect();
      if (!transport.native) {
        const response = await transport.fetch('/api/mobile/handshake', { signal: AbortSignal.timeout(10000) });
        const body: unknown = await response.json();
        const envelope = body as { success?: boolean; data?: { protocol?: string; version?: number } };
        if (!response.ok || envelope?.success !== true || envelope.data?.protocol !== 'loopra-relay' || envelope.data.version !== 1) throw new Error('桌面尚未支持 Loopra Mobile，请更新桌面端后重新配对');
      }
      if (id !== revision.current || disposed.current) { transport.close(); return; }
      const origin = transport.origin || await pairingOrigin(pairing);
      if (!preserve) await savePairing(pairing);
      if (id !== revision.current || disposed.current) { transport.close(); return; }
      current.current = { transport, restore: installRelayFetch(transport, origin) };
      autoReconnect.current = 0;
      autoReconnectPaused.current = false;
      setSaved(pairing); setConnection({ pairing, origin }); setLink('');
    } catch (cause) {
      transport.close();
      if (id === revision.current && !disposed.current) setError(errorMessage(cause));
    } finally {
      if (id === revision.current && !disposed.current) { pending.current = false; setBusy(false); }
    }
  }, []);

  useEffect(() => onNativeResume(() => {
    // Native recovery is owned by Tauri's Rust RunEvent::Resumed handler.
    if (current.current?.transport.native) { current.current.transport.syncState?.(); return; }
    if (pending.current) return;
    const pairing = connection?.pairing || saved;
    if (!pairing || (!connection && autoReconnectPaused.current)) return;
    autoReconnect.current = 0;
    void connect(pairing, Boolean(connection));
  }), [connection, saved, connect]);

  useEffect(() => {
    if (isTauri()) return;
    if (!connection) { autoReconnect.current = 0; return; }
    if (state === 'connected') {
      autoReconnect.current = 0;
      if (autoReconnectTimer.current) window.clearTimeout(autoReconnectTimer.current);
      autoReconnectTimer.current = 0;
      return;
    }
    if (state !== 'disconnected' || busy || autoReconnect.current >= 3) return;
    const delay = [900, 2200, 5000][autoReconnect.current++];
    autoReconnectTimer.current = window.setTimeout(() => {
      autoReconnectTimer.current = 0;
      if (!pending.current && stateRef.current !== 'connected' && !document.hidden) void connect(connection.pairing, true);
    }, delay);
    return () => {
      if (autoReconnectTimer.current) window.clearTimeout(autoReconnectTimer.current);
      autoReconnectTimer.current = 0;
    };
  }, [connection, state, busy, connect]);

  useEffect(() => {
    if (isTauri()) return;
    if (connection || !saved || booting || busy || autoReconnectPaused.current || autoReconnect.current >= 3) return;
    const delay = [900, 2200, 5000][autoReconnect.current++];
    autoReconnectTimer.current = window.setTimeout(() => {
      autoReconnectTimer.current = 0;
      if (!pending.current && !autoReconnectPaused.current && !document.hidden) void connect(saved);
    }, delay);
    return () => {
      if (autoReconnectTimer.current) window.clearTimeout(autoReconnectTimer.current);
      autoReconnectTimer.current = 0;
    };
  }, [saved, connection, booting, busy, connect]);

  useEffect(() => {
    if (!connection && !saved) return;
    const resume = () => {
      if (current.current?.transport.native) {
        if (document.visibilityState === 'visible') current.current.transport.syncState?.();
        return;
      }
      if (document.visibilityState !== 'visible' || pending.current || stateRef.current === 'connected') return;
      if (!connection && autoReconnectPaused.current) return;
      autoReconnect.current = 0;
      const pairing = connection?.pairing || saved;
      if (pairing) void connect(pairing, Boolean(connection));
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [saved, connection, connect]);

  useEffect(() => {
    disposed.current = false;
    let active = true;
    void loadPairing().then(pairing => {
      if (!active) return;
      setSaved(pairing);
      if (pairing) { autoReconnectPaused.current = false; autoReconnect.current = 0; void connect(pairing); }
    }).catch(cause => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setBooting(false); });
    return () => { active = false; disposed.current = true; revision.current++; pending.current = false; scanning.current?.abort(); if (autoReconnectTimer.current) window.clearTimeout(autoReconnectTimer.current); current.current?.restore?.(); current.current?.transport.close(); current.current = undefined; };
  }, [connect]);

  async function submit() {
    if (busy) return;
    try { autoReconnectPaused.current = false; autoReconnect.current = 0; await connect(parsePairingLink(link)); } catch (cause) { setError(errorMessage(cause)); }
  }
  async function scan() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    const controller = new AbortController(); scanning.current = controller;
    try {
      const scanned = await scanPairing(controller.signal);
      if (disposed.current) return;
      setLink(scanned);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (disposed.current) return;
      const pairing = parsePairingLink(scanned);
      autoReconnectPaused.current = false; autoReconnect.current = 0;
      pending.current = false; await connect(pairing);
    } catch (cause) {
      if (!disposed.current && !controller.signal.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(errorMessage(cause));
    }
    finally { if (scanning.current === controller) scanning.current = undefined; if (!disposed.current) { pending.current = false; setBusy(false); } }
  }
  async function forget() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await clearPairing(); disconnect(); setSaved(null); setError(''); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { if (!disposed.current) { pending.current = false; setBusy(false); } }
  }

  async function renameConnection(name: string) {
    if (!connection) return;
    const updated = validatePairing({ ...connection.pairing, displayName: name });
    await savePairing(updated);
    setSaved(updated);
    setConnection(current => current ? { ...current, pairing: updated } : current);
  }

  async function reconnect() {
    if (pending.current || !connection) return;
    const transport = current.current?.transport;
    if (!transport?.native || transport.state === 'closed') { await connect(connection.pairing, true); return; }
    pending.current = true; setBusy(true); setError('');
    const id = revision.current;
    try { await transport.resume(); if (id === revision.current && !disposed.current) setReconnectResult(value => value + 1); }
    catch (cause) { if (id === revision.current && !disposed.current) setError(errorMessage(cause)); }
    finally { if (id === revision.current && !disposed.current) { pending.current = false; setBusy(false); } }
  }

  if (connection) return <MobileWorkspace key={connection.origin} origin={connection.origin} hostname={new URL(connection.pairing.relayUrl).hostname} connectionName={connection.pairing.displayName || ''} online={state === 'connected'} reconnecting={busy || (isTauri() && (state === 'connecting' || state === 'disconnected'))} reconnectBusy={busy} reconnectResult={reconnectResult} error={error} onReconnect={() => void reconnect()} onRenameConnection={renameConnection} onForgetConnection={forget} onConnectAnother={() => { setError(''); disconnect(); }} preferences={preferences} onPreferences={changePreferences} />;

  return <main className="pairing-screen">
    <div className="pairing-stack">
      <div className="pairing-brand"><span className="pairing-mark"><img src={`${import.meta.env.BASE_URL}loopra-logo.svg`} alt="" aria-hidden="true" /></span><span>Loopra</span></div>
      <section className="pairing-card" aria-busy={booting || busy}>
        {booting ? <div className="pairing-loading"><LoaderCircle size={20} className="app-spin" /><span>读取连接</span></div> : <>
          <header className="pairing-heading"><h1>{busy && !scanning.current ? '正在连接桌面…' : '连接桌面'}</h1><p>扫描二维码，或粘贴配对链接。</p></header>
          <form onSubmit={event => { event.preventDefault(); void submit(); }}>
            <button type="button" className="pairing-primary" disabled={busy} onClick={() => void scan()}>{busy ? <LoaderCircle size={19} className="app-spin" /> : <QrCode size={19} />}<span>扫描二维码</span></button>
            <div className="pairing-divider"><span>或</span></div>
            <Textarea aria-label="配对链接" variant="flat" value={link} onValueChange={setLink} placeholder="loopra://connect?…" minRows={3} isDisabled={busy} classNames={{ inputWrapper: 'pairing-input' }} />
            <button type="submit" className="pairing-secondary" disabled={busy || !link.trim()}>{busy ? <LoaderCircle size={18} className="app-spin" /> : <Link size={18} />}<span>连接</span></button>
          </form>
          {busy && !scanning.current && <button type="button" className="pairing-secondary" onClick={disconnect}>取消连接</button>}
          {saved && <div className="pairing-saved"><button type="button" disabled={busy} aria-label={`重新连接 ${saved.displayName || new URL(saved.relayUrl).hostname}`} onClick={() => { autoReconnectPaused.current = false; autoReconnect.current = 0; void connect(saved); }}><RefreshCw size={16} /><span>{saved.displayName || new URL(saved.relayUrl).hostname}</span></button><button type="button" className="pairing-forget" aria-label="忘记连接" disabled={busy} onClick={() => void forget()}><Unplug size={16} /></button></div>}
          {error && <p className="pairing-error" role="alert"><AlertCircle size={16} /><span>{error}</span></p>}
        </>}
      </section>
      <p className="pairing-help">在桌面端打开 <strong>设置 → 连接与帮助 → 远程访问</strong></p>
    </div>
  </main>;
}
