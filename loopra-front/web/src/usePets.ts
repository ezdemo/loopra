import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoopraClient } from './backend';
import { loadPets, petImageUrl, type PetSnapshot, type PetPoint } from './pets';

export default function usePets(api: LoopraClient, connected: boolean) {
  const [snapshot, setSnapshot] = useState<PetSnapshot>({ pets: [], active: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController>();
  const appearanceQueue = useRef(Promise.resolve());
  const refresh = useCallback(async () => {
    request.current?.abort();
    if (!connected) { setSnapshot({ pets: [], active: null }); setError('请先连接 Loopra 服务'); setLoading(false); return; }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await loadPets(api, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
      if (!controller.signal.aborted) { setSnapshot(result); setRevision(current => current + 1); }
    } catch (cause) {
      if (!controller.signal.aborted) { setSnapshot({ pets: [], active: null }); setError(cause instanceof Error ? cause.message : '加载宠物失败'); }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [api, connected]);
  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { request.current?.abort(); window.removeEventListener('focus', focus); };
  }, [refresh]);
  async function select(name: string) {
    setLoading(true);
    try { await api.request('/pets/active', 'PUT', { name }); await refresh(); }
    finally { setLoading(false); }
  }
  async function remove(name: string) {
    setLoading(true);
    setError('');
    try { await api.request(`/pets/${encodeURIComponent(name)}`, 'DELETE'); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除宠物失败'); throw cause; }
    finally { setLoading(false); }
  }
  function saveAppearance(change: { scale?: number } & Partial<PetPoint>) {
    // The legacy endpoint merges a JSON file. Serialize move/resize writes so
    // a resize cannot discard a position saved at the same time.
    const result = appearanceQueue.current.then(async () => {
      await api.request('/pets/position', 'PUT', change);
      setSnapshot(current => ({ ...current, active: current.active ? {
        ...current.active,
        ...(change.scale !== undefined ? { scale: change.scale } : {}),
        ...(change.x !== undefined && change.y !== undefined ? { position: { x: change.x, y: change.y } } : {}),
      } : null }));
    });
    appearanceQueue.current = result.catch(() => {});
    return result;
  }
  const resize = (scale: number) => saveAppearance({ scale });
  const move = (position: PetPoint) => saveAppearance({ x: Math.round(position.x), y: Math.round(position.y) });
  const imageUrl = snapshot.active ? petImageUrl(api, snapshot.active.name, revision) : '';
  const imageUrlFor = (name: string) => petImageUrl(api, name, revision);
  return { ...snapshot, loading, error, refresh, select, remove, resize, move, imageUrl, imageUrlFor };
}
export type PetStore = ReturnType<typeof usePets>;
