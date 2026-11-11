import { useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@nextui-org/react';
import { ChevronRight, LoaderCircle, RotateCcw } from 'lucide-react';
import { agentEffortLevels, agentModelGroups, agentOptionDescription, agentOptionLabel, configValue, findAgentOption, type AgentConfigOption, type AgentConfigValue } from '@web/agent-config';

type Props = {
  label?: string;
  options?: AgentConfigOption[];
  loading: boolean;
  error?: string;
  disabled: boolean;
  onChange: (id: string, value: string | boolean) => Promise<void>;
  onRetry: () => void;
};

function currentLabel(option: AgentConfigOption): string {
  if (option.type === 'boolean') return option.currentValue === true || option.currentValue === 'on' ? '开启' : '关闭';
  if (option.category === 'thought_level' || option.id === 'effort') {
    const value = configValue(option);
    return agentEffortLevels(option).find(item => item.value === value)?.label || agentOptionLabel(option);
  }
  return agentOptionLabel(option);
}

function choiceLabel(option: AgentConfigOption, choice: AgentConfigValue): string {
  if (option.category === 'thought_level' || option.id === 'effort') {
    return agentEffortLevels(option).find(item => item.value === choice.value)?.label || choice.name;
  }
  return choice.name || String(choice.value);
}

export default function MobileAgentConfig({ label = '智能体配置', options, loading, error, disabled, onChange, onRetry }: Props) {
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const modelOption = findAgentOption(options, 'model', 'model');
  const effortOption = findAgentOption(options, 'effort', 'thought_level');
  const others = (options || []).filter(option => option !== modelOption && option !== effortOption);
  const query = modelQuery.trim().toLowerCase();
  const modelGroups = useMemo(() => {
    if (!modelOption) return [];
    return agentModelGroups(modelOption, '模型').map(group => ({
      ...group,
      models: group.models.filter(item => !query || `${group.name} ${item.name} ${item.value} ${item.description || ''}`.toLowerCase().includes(query)),
    })).filter(group => group.models.length);
  }, [modelOption, query]);

  async function change(option: AgentConfigOption, value: string | boolean): Promise<boolean> {
    if (disabled || busy) return false;
    setBusy(option.id); setActionError('');
    try { await onChange(option.id, value); return true; }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(''); }
  }

  function choices(option: AgentConfigOption) {
    return option.options.map(choice => <button key={String(choice.value)} type="button" aria-pressed={String(choice.value) === configValue(option)} title={choice.description || undefined} disabled={disabled || !!busy} onClick={() => void change(option, String(choice.value))}>
      <span>{choiceLabel(option, choice)}</span>
      {String(choice.value) === configValue(option) && <span className="agent-config-check">✓</span>}
    </button>);
  }

  return <section className="sheet-group agent-config">
    <div className="sheet-group-title">{label}</div>
    {loading && !options ? <div className="agent-config-loading"><LoaderCircle size={16} className="app-spin" /><span>读取配置</span></div>
      : error && !options ? <div className="agent-config-error" role="alert"><span>{error}</span><button type="button" onClick={onRetry}><RotateCcw size={14} />重试</button></div>
        : options ? <>
          {!options.length && <div className="agent-config-empty">没有可调整的配置</div>}
          {modelOption && <Popover isOpen={modelOpen} onOpenChange={open => { setModelOpen(open); if (!open) setModelQuery(''); }} placement="bottom" showArrow={false}>
            <PopoverTrigger>
              <button type="button" className="agent-config-model-trigger" disabled={disabled || !!busy} aria-haspopup="dialog" aria-expanded={modelOpen}>
                <span>{modelOption.name || '模型'}</span><strong>{currentLabel(modelOption)}</strong><ChevronRight size={16} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="agent-model-picker">
              <div className="agent-model-picker-head"><strong>{modelOption.name || '选择模型'}</strong><span>{currentLabel(modelOption)}</span></div>
              <input type="search" className="agent-config-search" aria-label="搜索模型" placeholder="搜索模型" value={modelQuery} onChange={event => setModelQuery(event.target.value)} />
              <div className="agent-model-picker-list">
                {modelGroups.map(group => <div className="agent-config-model-group" key={group.id}>
                  {group.name && <div className="agent-config-model-title">{group.name}</div>}
                  <div className="agent-config-choices">{group.models.map(choice => {
                    const selected = String(choice.value) === configValue(modelOption);
                    return <button key={String(choice.value)} type="button" aria-pressed={selected} title={choice.description || undefined} disabled={disabled || !!busy} onClick={() => void change(modelOption, String(choice.value)).then(ok => { if (ok) { setModelOpen(false); setModelQuery(''); } })}>
                      <span>{choiceLabel(modelOption, choice)}</span>{selected && <span className="agent-config-check">✓</span>}
                    </button>;
                  })}</div>
                </div>)}
                {!modelGroups.length && <div className="agent-config-empty">没有匹配的模型</div>}
              </div>
            </PopoverContent>
          </Popover>}
          {effortOption && <div className="agent-config-effort">
            <div className="agent-config-heading"><span>{effortOption.name || '思考强度'}</span><strong>{currentLabel(effortOption)}</strong></div>
            <div className="reasoning-options">{agentEffortLevels(effortOption).map(level => <button key={level.value} type="button" title={level.description} aria-pressed={level.value === configValue(effortOption)} className={level.value === configValue(effortOption) ? 'is-active' : ''} disabled={disabled || !!busy} onClick={() => void change(effortOption, level.value)}>{level.label}</button>)}</div>
          </div>}
          {others.length > 0 && <details className="agent-config-more">
            <summary><span>更多配置</span><strong>{others.length}</strong><ChevronRight size={16} /></summary>
            <div className="agent-config-more-body">{others.map(option => option.type === 'boolean' ? <div className="agent-config-toggle" key={option.id}>
              <div><span>{option.name || option.id}</span>{option.description && <small>{option.description}</small>}</div>
              <button type="button" role="switch" aria-checked={option.currentValue === true || option.currentValue === 'on'} aria-label={option.name || option.id} disabled={disabled || !!busy} onClick={() => void change(option, !(option.currentValue === true || option.currentValue === 'on'))}><i /></button>
            </div> : <details className="agent-config-disclosure" key={option.id}>
              <summary><span>{option.name || option.id}</span><strong>{currentLabel(option)}</strong><ChevronRight size={16} /></summary>
              <div className="agent-config-disclosure-body">{option.options.length > 6 && <div className="agent-config-description">{agentOptionDescription(option)}</div>}<div className="agent-config-choices">{choices(option)}</div></div>
            </details>)}
            </div>
          </details>}
        </> : null}
    {(actionError || (options ? error : '')) && <p className="agent-config-action-error" role="alert">{actionError || error}</p>}
  </section>;
}
