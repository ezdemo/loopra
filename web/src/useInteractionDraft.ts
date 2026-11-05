import { useState } from 'react';

export type InteractionDraft<T> = { index: number; answers: Record<string, T> };
export type InteractionDraftCache<T> = Map<string, InteractionDraft<T>>;

/** Keep unfinished input in the owning workbench while a session's form is unmounted. */
export function useInteractionDraft<T>(key: string, cache?: InteractionDraftCache<T>) {
  const [state, setState] = useState(() => ({ key, draft: cache?.get(key) || { index: 0, answers: {} } }));
  const draft: InteractionDraft<T> = state.key === key ? state.draft : cache?.get(key) || { index: 0, answers: {} };
  const update = (next: InteractionDraft<T>) => {
    cache?.set(key, next);
    setState({ key, draft: next });
  };
  const clear = () => { cache?.delete(key); };
  return [draft, update, clear] as const;
}
