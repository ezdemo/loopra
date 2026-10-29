import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Button, Input, Switch, Tooltip } from '@nextui-org/react';
import { Check, ChevronDown, Search, Settings2, Star, X, Zap } from 'lucide-react';
import { groupModels, modelLabel, type ComposerOptions, type ModelOption } from '../composer';
import { agentEffortLevels, agentModelGroups as groupAgentModels, agentOptionDescription, agentOptionLabel, configValue, findAgentOption, type AgentConfigState } from '../agent-config';
import { useMenuPlacement } from '../layout/menu-placement';
import { Collapse } from './Motion';
import ReasoningControl from './ReasoningControl';
import AgentIcon from './AgentIcon';

type Props = {
  open: boolean; onOpenChange: () => void; onClose: () => void; onSelected: () => void;
  models: ModelOption[]; options: ComposerOptions; onOptions: (value: ComposerOptions) => void | Promise<void>;
  agentConfig?: AgentConfigState; agentId?: string; external: boolean; agentEngineName: string; busy: boolean; connected: boolean;
  defaultModel: string; onDefaultModel: (id: string) => void; onManage: () => void; notify: (text: string) => void;
};

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Switch size="sm" aria-label={label} isSelected={value} onValueChange={onChange} classNames={{ label: 'sr-only' }}>{label}</Switch>;
}

export default function ModelReasoningSelector(props: Props) {
  const { models, options, external, agentEngineName, notify } = props;
  const [menu, setMenu] = useState<'summary' | 'models' | 'effort'>('summary');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const modelRow = useRef<HTMLButtonElement>(null);
  const effortRow = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const flyout = useRef<HTMLDivElement>(null);
  const hoverClose = useRef<ReturnType<typeof setTimeout>>();
  const placement = useMenuPlacement(props.open, anchor);
  const selected = models.find(model => model.id === options.modelId);
  const agentModel = findAgentOption(props.agentConfig?.options, 'model', 'model');
  const agentEffort = findAgentOption(props.agentConfig?.options, 'effort', 'thought_level');
  const agentFast = findAgentOption(props.agentConfig?.options, 'fast', 'model_config');
  const agentBusy = !!props.agentConfig?.busy;
  const agentLevels = agentEffort ? agentEffortLevels(agentEffort) : [];
  const agentFastOn = !!agentFast && (agentFast.currentValue === true || agentFast.currentValue === 'on');
  const modelGroupsForAgent = useMemo(() => agentModel ? groupAgentModels(agentModel, agentEngineName) : [], [agentModel, agentEngineName]);
  const agentModelValue = agentModel ? configValue(agentModel) : '';
  const agentEffortValue = agentEffort ? configValue(agentEffort) : '';
  const native = !external && !props.agentConfig;
  const hasModel = !!agentModel || native;
  const hasReasoning = !!agentEffort || !!agentFast || native;
  const fast = native ? options.fast : agentFastOn;
  const activeModelLabel = agentModel
    ? modelGroupsForAgent.flatMap(group => group.models).find(model => model.value === configValue(agentModel))?.name || agentOptionLabel(agentModel)
    : '';
  const activeModelTooltip = agentModel
    ? [...new Set([agentOptionLabel(agentModel), agentOptionDescription(agentModel)])].filter(Boolean).join('\n')
    : selected ? `${selected.provider} / ${modelLabel(selected)}${modelLabel(selected) !== selected.name ? `\n${selected.name}` : ''}` : '选择模型';
  const modelQuery = query.trim().toLowerCase();
  const visibleModelGroups = modelGroupsForAgent
    .map(group => ({ ...group, models: group.models.filter(model => !modelQuery || `${group.name} ${model.name} ${model.value} ${model.description || ''}`.toLowerCase().includes(modelQuery)) }))
    .filter(group => group.models.length);

  const modelName = agentModel ? activeModelLabel : selected ? modelLabel(selected) : '选择模型';
  const reasoningValue = agentEffort ? agentEffortValue : native ? options.effort : '';
  const reasoningName = reasoningValue === 'none' ? '无' : reasoningValue === 'xhigh' ? 'XHigh'
    : /^(minimal|low|medium|high|max|default)$/.test(reasoningValue) ? reasoningValue[0].toUpperCase() + reasoningValue.slice(1)
    : agentEffort ? agentOptionLabel(agentEffort) : reasoningValue;
  const title = [agentEngineName, hasModel ? activeModelTooltip : '', hasReasoning ? `推理：${reasoningName || '默认'}${fast ? ' · 快速模式' : ''}` : ''].filter(Boolean).join('\n');
  const update = <K extends keyof ComposerOptions>(key: K, value: ComposerOptions[K]) => props.onOptions({ ...options, [key]: value });
  const changeAgent = (id: string, value: string | boolean) => props.agentConfig?.onChange(id, value);
  const close = props.onClose;
  const focusInput = props.onSelected;
  const back = () => { const previous = menu; setMenu('summary'); requestAnimationFrame(() => (previous === 'models' ? modelRow : effortRow).current?.focus()); };
  function cancelHoverClose() { clearTimeout(hoverClose.current); }
  function openPage(page: 'models' | 'effort', focus = false) {
    if (agentBusy) return;
    cancelHoverClose();
    if (focus) requestAnimationFrame(() => (flyout.current?.querySelector<HTMLInputElement>('input') || flyout.current?.querySelector<HTMLButtonElement>('button'))?.focus());
    if (menu === page) return;
    setQuery('');
    if (page === 'models') {
      if (agentModel) {
        const activeGroup = modelGroupsForAgent.find(group => group.models.some(model => model.value === agentModelValue));
        setCollapsed(modelGroupsForAgent.map(group => group.id).filter(id => id !== activeGroup?.id));
      } else setCollapsed([...new Set(models.map(model => model.providerId))].filter(id => id !== selected?.providerId));
    }
    setMenu(page);
  }
  useEffect(() => {
    if (!props.open) { setMenu('summary'); return; }
    if (trigger.current?.matches(':focus-visible')) (modelRow.current || effortRow.current)?.focus();
    const pointer = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', pointer);
    return () => document.removeEventListener('pointerdown', pointer);
  }, [props.open]);
  useEffect(() => () => cancelHoverClose(), []);

  if (!hasModel && !hasReasoning) return null;
  return <div ref={anchor} className="model-reasoning-selector" data-placement={placement.side}
    style={{ '--composer-popover-max-height': `${placement.maxHeight}px` } as CSSProperties}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (menu !== 'summary') back(); else { close(); trigger.current?.focus(); } }
      if (event.key === 'ArrowLeft' && (event.target === modelRow.current || event.target === effortRow.current)) { event.preventDefault(); openPage(event.target === modelRow.current ? 'models' : 'effort', true); }
      if (event.key === 'ArrowRight' && flyout.current?.contains(event.target as Node)) { event.preventDefault(); back(); }
      if ((event.target === modelRow.current || event.target === effortRow.current) && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); (document.activeElement === modelRow.current ? effortRow.current || modelRow.current : modelRow.current || effortRow.current)?.focus(); }
    }}>
    <Tooltip content={title} classNames={{ content: 'model-name-tooltip' }} delay={600}>
      <Button ref={trigger} isDisabled={agentBusy} variant="light" className={`composer-model composer-model-reasoning ${props.open ? 'is-active' : ''}`}
        title={title} aria-label={`模型与推理设置：${[agentEngineName, hasModel ? modelName : '', hasReasoning ? reasoningName : ''].filter(Boolean).join(' · ')}`}
        aria-haspopup="dialog" aria-expanded={props.open} aria-controls={props.open ? panelId : undefined} onPress={props.onOpenChange}>
        <AgentIcon agentId={props.agentId} />
        {hasModel && <span className="model-reasoning-name">{modelName}</span>}
        {hasModel && hasReasoning && <span className="model-reasoning-divider" aria-hidden="true">·</span>}
        {hasReasoning && <span className="model-reasoning-effort">{reasoningName || '快速'}</span>}
      </Button>
    </Tooltip>
    {props.open && <div className="model-reasoning-menus" onPointerEnter={cancelHoverClose}
      onPointerLeave={() => { hoverClose.current = setTimeout(() => { if (!flyout.current?.contains(document.activeElement)) setMenu('summary'); }, 180); }}>
      <div className="composer-popover model-reasoning-popover model-reasoning-summary">
        <section id={panelId} role="dialog" aria-label="模型与推理设置">
          <div className="model-reasoning-rows">
            {hasModel && <button ref={modelRow} type="button" onPointerEnter={event => { if (event.pointerType !== 'touch') openPage('models'); }} onClick={() => openPage('models', true)} disabled={agentBusy}
              aria-haspopup="dialog" aria-expanded={menu === 'models'} aria-controls={menu === 'models' ? `${panelId}-models` : undefined}>
              <span>模型</span><span className="model-reasoning-value" title={modelName}>{modelName}</span>
            </button>}
            {hasReasoning && <button ref={effortRow} type="button" onPointerEnter={event => { if (event.pointerType !== 'touch') openPage('effort'); }} onClick={() => openPage('effort', true)} disabled={agentBusy}
              aria-haspopup="dialog" aria-expanded={menu === 'effort'} aria-controls={menu === 'effort' ? `${panelId}-effort` : undefined}>
              <span>推理</span><span className="model-reasoning-value">{reasoningName || '快速模式'}{fast && reasoningName && <Zap size="0.875rem" aria-label="快速模式已开启" />}</span>
            </button>}
          </div>
        </section>
      </div>
      {menu !== 'summary' && <div ref={flyout} className="composer-popover model-reasoning-flyout" onPointerEnter={cancelHoverClose}>
        <section id={`${panelId}-${menu}`} role="dialog" aria-label={menu === 'models' ? '选择模型' : '推理设置'}>
          <div className="composer-popover-header">
            <div><strong>{menu === 'models' ? '选择模型' : '推理设置'}</strong>{menu === 'models' && <span className="demo-badge">{props.connected ? '在线' : '离线'}</span>}</div>
            <Button isIconOnly size="sm" variant="light" aria-label="收起设置面板" onPress={back}><X size="1rem" /></Button>
          </div>
        {menu === 'models' && (agentModel ? <>
          <div className="popover-search"><Input size="sm" variant="bordered" aria-label="搜索模型" placeholder="搜索模型…" value={query} onValueChange={setQuery} startContent={<Search size="0.9375rem" />} isClearable onClear={() => setQuery('')} /></div>
          <div className="model-group-list">
            {agentModel.options.length > 0 && !agentModel.options.some(value => value.value === agentModelValue) && <div className="composer-model-row is-selected">
              <button role="radio" aria-checked onClick={() => {}}><span><strong>{agentModelValue}</strong></span><Check size="1rem" /></button>
            </div>}
            {visibleModelGroups.map(group => {
              const openGroup = !!modelQuery || !collapsed.includes(group.id);
              return <div key={group.id} className="composer-model-group">
                <button className="model-group-heading" aria-expanded={openGroup} onClick={() => setCollapsed(current => current.includes(group.id) ? current.filter(id => id !== group.id) : [...current, group.id])}>
                  <span className="provider-dot" style={{ background: '#9298a1' }} /><span>{group.name}</span><small>{group.models.length}</small><ChevronDown size="0.875rem" className={openGroup ? 'rotated' : ''} />
                </button>
                <Collapse open={openGroup}>{group.models.map(model => {
                  const selected = model.value === agentModelValue;
                  return <div className={`composer-model-row agent-model-row ${selected ? 'is-selected' : ''}`} key={model.value}>
                    <button role="radio" aria-checked={selected} disabled={agentBusy || props.busy} aria-label={`${group.name} / ${model.name}`} title={[model.name, model.description].filter(Boolean).join('\n')} onClick={() => { changeAgent(agentModel.id, model.value); close(); focusInput(); }}>
                      <span><strong>{model.name}</strong>{model.description && <small>{model.description}</small>}</span>{selected && <Check size="1rem" />}
                    </button>
                    {!external && <Tooltip content={model.value === props.defaultModel ? '新会话默认模型' : '设为新会话默认模型'} delay={500}><Button isIconOnly size="sm" variant="light" className="model-star" aria-label={`设为默认模型：${group.name} / ${model.name}`} aria-pressed={model.value === props.defaultModel} onPress={() => { props.onDefaultModel(model.value); notify('已设为新会话默认模型'); }}><Star size="0.875rem" fill={model.value === props.defaultModel ? 'currentColor' : 'none'} /></Button></Tooltip>}
                  </div>;
                })}</Collapse>
              </div>;
            })}
            {!visibleModelGroups.length && <div className="composer-empty"><Search size="1.4375rem" /><p>没有找到匹配的模型</p><small>试试模型名或供应商名称</small></div>}
          </div>
          <div className="popover-footer"><span>模型来自 {external ? agentEngineName : 'Loopra 配置'}</span>{!external && <Button size="sm" variant="light" onPress={() => { close(); props.onManage(); }}><Settings2 size="0.875rem" />管理模型</Button>}</div>
        </> : <>
          <div className="popover-search"><Input size="sm" variant="bordered" aria-label="搜索模型或供应商" placeholder="搜索模型或供应商…" value={query} onValueChange={setQuery} startContent={<Search size="0.9375rem" />} isClearable onClear={() => setQuery('')} /></div>
          <div className="model-group-list">
            {groupModels(models, query).map(group => <div key={group.id} className="composer-model-group">
              <button className="model-group-heading" aria-expanded={!!query || !collapsed.includes(group.id)} onClick={() => setCollapsed(current => current.includes(group.id) ? current.filter(id => id !== group.id) : [...current, group.id])}>
                <span className="provider-dot" style={{ background: group.color || '#9298a1' }} /><span>{group.name}</span><small>{group.models.length}</small><ChevronDown size="0.875rem" className={query || !collapsed.includes(group.id) ? 'rotated' : ''} />
              </button>
              <Collapse open={!!query || !collapsed.includes(group.id)}>{group.models.map(model => <div className={`composer-model-row ${model.id === options.modelId ? 'is-selected' : ''}`} key={model.id}>
                <button role="radio" aria-checked={model.id === options.modelId} aria-label={`${model.provider} / ${modelLabel(model)}`} title={model.name} onClick={() => { update('modelId', model.id); close(); focusInput(); }}><span className="model-option-copy"><strong>{modelLabel(model)}</strong>{modelLabel(model) !== model.name && <small>{model.name}</small>}</span>{model.id === options.modelId && <Check size="1rem" />}</button>
                <Tooltip content={model.id === props.defaultModel ? '新会话默认模型' : '设为新会话默认模型'} delay={500}><Button isIconOnly size="sm" variant="light" className="model-star" aria-label={`设为默认模型：${model.provider} / ${modelLabel(model)}`} aria-pressed={model.id === props.defaultModel} onPress={() => { props.onDefaultModel(model.id); notify('已设为新会话默认模型'); }}><Star size="0.875rem" fill={model.id === props.defaultModel ? 'currentColor' : 'none'} /></Button></Tooltip>
              </div>)}</Collapse>
            </div>)}
            {!groupModels(models, query).length && <div className="composer-empty"><Search size="1.4375rem" /><p>没有找到匹配的模型</p><small>试试模型名或供应商名称</small></div>}
          </div>
          <div className="popover-footer"><span>模型来自 Loopra 配置</span><Button size="sm" variant="light" onPress={() => { close(); props.onManage(); }}><Settings2 size="0.875rem" />管理模型</Button></div>
        </>)}

        {menu === 'effort' && (agentEffort || agentFast ? <div className="effort-body">
          {agentEffort && <ReasoningControl value={agentEffortValue} levels={agentLevels} allowCustom={false} disabled={agentBusy || props.busy} onCommit={value => changeAgent(agentEffort.id, value)} onClose={close} />}
          {agentFast && <div className="composer-toggle-row"><div><span><Zap size="0.9375rem" />快速模式</span><small>{agentOptionDescription(agentFast) || '发送快速模式参数，需模型支持'}</small></div><Toggle label="快速模式" value={agentFastOn} onChange={value => changeAgent(agentFast.id, agentFast.type === 'boolean' ? value : value ? 'on' : 'off')} /></div>}
        </div> : <div className="effort-body">
          <ReasoningControl value={options.effort} disabled={props.busy} onCommit={value => update('effort', value)} onClose={close} />
          <div className="composer-toggle-row"><div><span><Zap size="0.9375rem" />快速模式</span><small>发送快速模式参数，需模型支持</small></div><Toggle label="快速模式" value={options.fast} onChange={value => update('fast', value)} /></div>
        </div>)}
        </section>
      </div>}
    </div>}
  </div>;
}
