// Grouping helpers for the Git panel's commit-message model picker.
// Legacy GitPanel.vue loaded GET /models and rendered the models grouped by
// channel with a warning when the chosen model was not in the list.

export type GitModel = { name: string; displayName?: string; active?: boolean; channelId?: string; channelName?: string };
export type GitModelChannel = { id: string; name: string; models: GitModel[] };

/** Groups `/models` entries by their channel, keeping the server order. */
export function groupGitModels(models: GitModel[] = []): GitModelChannel[] {
  const groups = new Map<string, GitModelChannel>();
  for (const model of models || []) {
    const name = String(model?.name || '').trim();
    if (!name) continue;
    const id = String(model.channelId || '');
    if (!groups.has(id)) groups.set(id, { id, name: String(model.channelName || id || '默认渠道'), models: [] });
    groups.get(id)!.models.push({ ...model, name });
  }
  return [...groups.values()];
}

/** Encodes a `channelId::name` option value so a select can round-trip both. */
export function gitModelValue(model: string, channelId = '') {
  return model ? `${channelId}::${model}` : '';
}

export function gitModelFromValue(value: string) {
  const index = value.indexOf('::');
  if (index < 0) return { model: value, modelChannelId: '' };
  return { modelChannelId: value.slice(0, index), model: value.slice(index + 2) };
}

/** Legacy GitPanel showed a warning when the saved model was not selectable. */
export function gitModelKnown(models: GitModel[], model: string, channelId = '') {
  if (!model) return true;
  return (models || []).some(entry => entry.name === model && String(entry.channelId || '') === String(channelId || ''));
}
