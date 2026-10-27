import { useCallback } from 'react';
import { useLocalState } from './lib';

type PanelState = { open: boolean; tab: string };

export function useSessionPanel(server: string, sessionId: string | undefined, workspace: string) {
  const [states, setStates] = useLocalState<Record<string, PanelState>>('session-right-panels', {});
  const key = JSON.stringify([server, sessionId ? 'session' : 'draft', sessionId || workspace]);
  const state = states[key] || { open: false, tab: 'files' };
  const setOpen = useCallback((open: boolean) => {
    setStates(current => ({ ...current, [key]: { open, tab: current[key]?.tab ?? 'files' } }));
  }, [key, setStates]);
  const setTab = useCallback((tab: string) => {
    setStates(current => ({ ...current, [key]: { open: current[key]?.open ?? false, tab } }));
  }, [key, setStates]);
  return [state.open, setOpen, state.tab, setTab] as const;
}
