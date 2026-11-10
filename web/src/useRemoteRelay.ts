import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoopraClient } from './backend';

export type RemoteRelayStatus = {
  enabled: boolean;
  state: string;
  relayUrl?: string;
  hasRegistrationKey: boolean;
  pairingLink?: string;
  qrCode?: string;
};
export type RemoteRelayUpdate = { enabled?: boolean; relayUrl?: string; registrationKey?: string };

export function useRemoteRelay(api: LoopraClient) {
  const [status, setStatus] = useState<RemoteRelayStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const active = useRef(false);
  const requestId = useRef(0);
  const controller = useRef<AbortController>();
  const pending = useRef(false);
  const mutationFailed = useRef(false);

  const request = useCallback(async (method = 'GET', body?: RemoteRelayUpdate, reset = false) => {
    if (pending.current) return;
    const id = ++requestId.current;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const action = method === 'GET' ? '' : reset ? 'reset' : body?.enabled === false ? 'stop' : 'save';
    pending.current = !!action;
    setBusy(action);
    setLoading(true);
    if (action) mutationFailed.current = false;
    if (!mutationFailed.current) setError('');
    try {
      const next = await api.request<RemoteRelayStatus>(reset ? '/remote/relay/reset-pairing' : '/remote/relay', method, body, current.signal);
      if (!active.current || current.signal.aborted || id !== requestId.current) return;
      setStatus(next);
      return next;
    } catch (cause) {
      if (active.current && !current.signal.aborted && id === requestId.current) {
        if (action) mutationFailed.current = true;
        if (action || !mutationFailed.current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (active.current && id === requestId.current) {
        setLoading(false);
        setBusy('');
        pending.current = false;
      }
    }
  }, [api]);

  useEffect(() => {
    active.current = true;
    pending.current = false;
    mutationFailed.current = false;
    setStatus(undefined);
    void request();
    return () => { active.current = false; ++requestId.current; controller.current?.abort(); };
  }, [request]);

  useEffect(() => {
    if (!status?.enabled || busy || loading) return;
    const timer = setTimeout(() => void request(), 2000);
    return () => clearTimeout(timer);
  }, [status, busy, loading, request]);

  return { status, loading, busy, error, refresh: () => request(), save: (update: RemoteRelayUpdate) => request('PUT', update), resetPairing: () => request('POST', undefined, true) };
}
