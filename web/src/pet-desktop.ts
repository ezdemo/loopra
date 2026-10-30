import { useEffect, useRef, useState } from 'react';
import type { LoopraClient } from './backend';
import type { PetAnimation, PetReply } from './pets';

export type PetDesktopStatus = { native: boolean; dismissed: number };

export function petDesktopBody(input: {
  shown: boolean;
  name?: string;
  label?: string;
  activity: PetAnimation;
  reply: PetReply | null;
  latest: string;
  scale: number;
  seen: number;
  reset?: boolean;
}) {
  return {
    shown: input.shown,
    name: input.name ?? '',
    label: input.label ?? '',
    activity: input.activity,
    reply: input.reply?.text ?? '',
    replyId: input.reply?.id ?? '',
    replyActivity: input.reply?.activity ?? '',
    latest: input.latest,
    scale: input.scale,
    seen: input.seen,
    reset: input.reset === true,
  };
}

/** Drives the process-owned native pet. The page pet stays when this server has no GUI. */
export function useNativePet(input: {
  api: LoopraClient;
  connected: boolean;
  enabled: boolean;
  name?: string;
  label?: string;
  scale: number;
  activity: PetAnimation;
  reply: PetReply | null;
  latest: string;
  onDismiss: () => void;
}) {
  const [native, setNative] = useState(false);
  const seen = useRef<number | null>(null);
  const dismissRef = useRef(input.onDismiss);
  dismissRef.current = input.onDismiss;
  const nativeRef = useRef(false);
  const snapshot = useRef(input);
  snapshot.current = input;
  const replyId = input.reply?.id ?? '';
  const replyText = input.reply?.text ?? '';
  const replyActivity = input.reply?.activity ?? '';

  function note(status: PetDesktopStatus) {
    const became = status.native !== nativeRef.current;
    nativeRef.current = status.native;
    if (became) setNative(status.native);
    if (seen.current === null) {
      seen.current = status.dismissed;
      return;
    }
    if (status.dismissed > seen.current) {
      seen.current = status.dismissed;
      dismissRef.current();
    }
  }

  useEffect(() => {
    if (!input.connected) {
      nativeRef.current = false;
      setNative(false);
      seen.current = null;
      return;
    }
    let stop = false;
    const pull = async () => {
      try {
        const status = await input.api.request<PetDesktopStatus>('/pets/desktop');
        if (!stop) note(status);
      } catch {
        if (!stop) {
          nativeRef.current = false;
          setNative(false);
        }
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 1200);
    return () => { stop = true; window.clearInterval(timer); };
  }, [input.api, input.connected]);

  useEffect(() => {
    if (!native || seen.current === null) return;
    const current = snapshot.current;
    let stop = false;
    void input.api.request<PetDesktopStatus>('/pets/desktop', 'PUT', petDesktopBody({
      shown: current.enabled, name: current.name, label: current.label, activity: current.activity,
      reply: current.reply, latest: current.latest, scale: current.scale, seen: seen.current,
    })).then(status => { if (!stop) note(status); }).catch(() => {});
    return () => { stop = true; };
  }, [native, input.api, input.enabled, input.name, input.label, input.scale, input.activity, input.latest, replyId, replyText, replyActivity]);

  async function reset() {
    if (!nativeRef.current || seen.current === null) return;
    const current = snapshot.current;
    const status = await input.api.request<PetDesktopStatus>('/pets/desktop', 'PUT', petDesktopBody({
      shown: current.enabled, name: current.name, label: current.label, activity: current.activity,
      reply: current.reply, latest: current.latest, scale: current.scale, seen: seen.current, reset: true,
    }));
    note(status);
  }

  return { native, reset };
}
