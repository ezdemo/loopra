import { Check } from 'lucide-react';
import { configValue, type AgentConfigOption, type AgentConfigState } from '../agent-config';

/**
 * Optional Agent-specific settings that have no shared composer counterpart
 * (Claude's persona picker, future engine flags). Standard `mode`, `model` and
 * `thought_level` options are rendered by the composer's own controls instead.
 */
export default function AgentConfigControls({ state, options }: { state: AgentConfigState; options: AgentConfigOption[] }) {
  if (!options.length) return <p className="composer-note">Agent 未提供其他配置选项</p>;
  return <div className="agent-option-list" aria-busy={state.busy}>
    {options.map(option => <section key={option.id} className="agent-option-group" aria-label={option.name}>
      <header><strong>{option.name}</strong>{option.description && <small>{option.description}</small>}</header>
      {option.type === 'boolean'
        ? <button type="button" role="switch" aria-checked={option.currentValue === true} aria-label={option.name} disabled={state.busy}
            className="agent-option-toggle" onClick={() => state.onChange(option.id, option.currentValue !== true)}>
            <span>{option.currentValue === true ? '已开启' : '已关闭'}</span>
            <span className={`composer-checkbox ${option.currentValue === true ? 'checked' : ''}`}>{option.currentValue === true && <Check size="0.75rem" />}</span>
          </button>
        : <div className="composer-selection-list" role="radiogroup" aria-label={option.name}>
            {(option.options.some(value => value.value === configValue(option)) ? option.options
              : [{ value: configValue(option), name: configValue(option), group: null }, ...option.options]).map(value => {
              const selected = value.value === configValue(option);
              return <button key={value.value} type="button" role="radio" aria-checked={selected} disabled={state.busy}
                onClick={() => state.onChange(option.id, value.value)}>
                <span><strong>{value.group ? `${value.group} / ` : ''}{value.name}</strong>{value.description && <small>{value.description}</small>}</span>
                {selected && <Check size="1rem" />}
              </button>;
            })}
          </div>}
    </section>)}
  </div>;
}
