export type AgentConfigValue = { value: string; name: string; description?: string; group?: string | null };
export type AgentConfigOption = { id: string; name: string; description?: string; category?: string; type: 'select' | 'boolean'; currentValue: string | boolean; options: AgentConfigValue[] };
export type AgentConfigState = {
  options?: AgentConfigOption[]; busy: boolean; error?: string;
  onPrepare: () => void; onChange: (id: string, value: string | boolean) => void | Promise<void>;
};
export type AgentEffortLevel = { value: string; label: string; description?: string };

export function configValue(option: AgentConfigOption): string { return String(option.currentValue ?? ''); }

/** ACP reserves category names for the selectors every client already has. */
export function findAgentOption(options: AgentConfigOption[] | undefined, id: string, category?: string) {
  if (!options) return undefined;
  return options.find(option => option.id === id) || (category ? options.find(option => option.category === category) : undefined);
}

export function agentOptionLabel(option: AgentConfigOption | undefined): string {
  if (!option) return '';
  const value = option.options.find(item => item.value === configValue(option));
  return value?.name || configValue(option);
}

export function agentOptionDescription(option: AgentConfigOption | undefined): string {
  if (!option) return '';
  return option.options.find(item => item.value === configValue(option))?.description || option.description || option.name;
}

const effortLabels: Record<string, string> = { none: '无', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大', default: '默认' };
const effortDescriptions: Record<string, string> = {
  none: '直接响应', minimal: '尽量少的思考', low: '快速响应', medium: '平衡速度与深度',
  high: '更充分地思考', xhigh: '更深入地推理', max: '优先完整的推理', default: '使用模型默认强度',
};

/** Turn an Agent's own thought-level choices into the shared reasoning control. */
export function agentEffortLevels(option: AgentConfigOption | undefined): AgentEffortLevel[] {
  return (option?.options || []).map(value => ({
    value: value.value,
    label: effortLabels[value.value] || value.name || value.value,
    description: value.description || effortDescriptions[value.value],
  }));
}

/** Group model choices by ACP group, or by the `频道 / 模型` names Native uses. */
export function agentModelGroups(option: AgentConfigOption, fallbackName: string) {
  const groups = new Map<string, { id: string; name: string; models: AgentConfigValue[] }>();
  for (const value of option.options) {
    const parts = value.name.split(' / ');
    const grouped = value.group || (parts.length === 2 ? parts[0] : '');
    const id = grouped || fallbackName;
    const name = grouped || fallbackName;
    if (!groups.has(id)) groups.set(id, { id, name, models: [] });
    groups.get(id)!.models.push({ ...value, name: grouped && parts.length === 2 ? parts.slice(1).join(' / ') : value.name });
  }
  return [...groups.values()];
}

export function isDangerousAgentMode(option: AgentConfigOption): boolean {
  const value = configValue(option);
  const name = agentOptionLabel(option);
  return /bypass|free|full[-_ ]?access|danger[-_ ]?full/i.test(value) || /bypass|full access|完全自动|完全访问/i.test(name);
}

/**
 * Composer choices to carry into the next new conversation. Plan mode is
 * turn-scoped, so a new conversation always starts outside it.
 */
export function newSessionSeed(options: AgentConfigOption[]): Record<string, string | boolean> {
  return Object.fromEntries(options.filter(option => option.id !== 'plan').map(option => [option.id, option.currentValue]));
}

/**
 * The saved choices the freshly prepared Agent still offers, as config changes.
 * A retired model or a removed mode is skipped instead of failing the draft.
 */
export function seedChanges(options: AgentConfigOption[], saved: Record<string, string | boolean> | undefined) {
  if (!saved) return [];
  const changes: { id: string; value: string | boolean }[] = [];
  for (const option of options) {
    if (option.id === 'plan') continue;
    const value = saved[option.id];
    if (value === undefined || value === option.currentValue) continue;
    if (option.type === 'boolean') {
      if (typeof value === 'boolean') changes.push({ id: option.id, value });
    } else if (typeof value === 'string' && option.options.some(choice => choice.value === value)) {
      changes.push({ id: option.id, value });
    }
  }
  return changes;
}

/**
 * Apply the remembered choices to a prepared option list locally, so the
 * composer can show the last preset while the writes are still in flight
 * (otherwise the Agent's factory default flashes first).
 */
export function applySeed(options: AgentConfigOption[], saved: Record<string, string | boolean> | undefined) {
  if (!saved) return options;
  return options.map(option => {
    if (option.id === 'plan') return option;
    const value = saved[option.id];
    const valid = option.type === 'boolean'
      ? typeof value === 'boolean'
      : typeof value === 'string' && option.options.some(choice => choice.value === value);
    return valid && value !== option.currentValue ? { ...option, currentValue: value } : option;
  });
}
