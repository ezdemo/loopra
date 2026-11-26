import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Switch, Tooltip } from '@nextui-org/react';
import { Check, ChevronDown, Search, Settings2, Star, X, Zap } from 'lucide-react';
import { groupModels, modelEffortLevels, modelLabel, resolveModelEffort, type ComposerOptions, type ModelOption } from '../composer';
import { agentEffortLevels, agentModelGroups as groupAgentModels, agentOptionDescription, agentOptionLabel, configValue, findAgentOption, reasoningEffortLabel, type AgentConfigState } from '../agent-config';
import { useMenuPlacement } from '../layout/menu-placement';
import { Collapse } from './Motion';
import ReasoningControl from './ReasoningControl';
import AgentIcon from './AgentIcon';

type Props = {
  open: boolean; onOpenChange: () => void; onClose: () => void; onSelected: () => void;
  models: ModelOption[]; options: ComposerOptions; onOptions: (value: ComposerOptions) => void | Promise<void>;
  agentConfig?: AgentConfigState; agentId?: string; external: boolean; agentEngineName: string; busy: boolean; connected: boolean;
  chatMode?: boolean;
  defaultModel: string; onDefaultModel: (id: string) => void; onManage: () => void; notify: (text: string) => void;
};

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Switch size="sm" aria-label={label} isSelected={value} onValueChange={onChange} classNames={{ label: 'sr-only' }}>{label}</Switch>;
}

export default function ModelReasoningSelector(props: Props) {
  const { t } = useTranslation();
  const { models, options, external, agentEngineName, notify } = props;
  const [menu, setMenu] = useState<'summary' | 'models' | 'effort' | 'fusion' | 'fusion-effort'>('summary');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const modelRow = useRef<HTMLButtonElement>(null);
  const effortRow = useRef<HTMLButtonElement>(null);
  const fusionRow = useRef<HTMLButtonElement>(null);
  const fusionEffortRow = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const flyout = useRef<HTMLDivElement>(null);
  const hoverClose = useRef<ReturnType<typeof setTimeout>>();
  const placement = useMenuPlacement(props.open, anchor);
  const selected = models.find(model => model.id === options.modelId);
  const agentModel = findAgentOption(props.agentConfig?.options, 'model', 'model');
  const agentEffort = findAgentOption(props.agentConfig?.options, 'effort', 'thought_level');
  const agentFast = findAgentOption(props.agentConfig?.options, 'fast', 'model_config');
  const fusion = !external && !props.chatMode ? findAgentOption(props.agentConfig?.options, 'fusionSidekick') : undefined;
  const fusionValue = fusion ? configValue(fusion) : 'off';
  const fusionActive = !!fusion && fusionValue !== 'off';
  const fusionEffort = fusionActive ? findAgentOption(props.agentConfig?.options, 'fusionSidekickEffort') : undefined;
  const agentBusy = !!props.agentConfig?.busy;
  const effortTranslate = external ? undefined : t;
  const agentLevels = agentEffort ? agentEffortLevels(agentEffort, effortTranslate) : [];
  const agentFastOn = !!agentFast && (agentFast.currentValue === true || agentFast.currentValue === 'on');
  const modelGroupsForAgent = useMemo(() => agentModel ? groupAgentModels(agentModel, agentEngineName) : [], [agentModel, agentEngineName]);
  const fusionGroups = useMemo(() => fusion ? groupAgentModels({ ...fusion, options: fusion.options.filter(option => option.value !== 'off') }, agentEngineName) : [], [fusion, agentEngineName]);
  const fusionLabel = fusionValue === 'off'
    ? fusion?.options.find(option => option.value === 'off')?.name ?? '关闭'
    : fusionGroups.flatMap(group => group.models).find(model => model.value === fusionValue)?.name ?? '模型不可用';
  const pickerOption = menu === 'fusion' ? fusion : agentModel;
  const pickerValue = pickerOption ? configValue(pickerOption) : '';
  const pickerGroups = menu === 'fusion' ? fusionGroups : modelGroupsForAgent;
  const pickerTitle = menu === 'models' ? '选择模型' : menu === 'fusion' ? '边缘模型' : menu === 'fusion-effort' ? '边缘推理' : '推理设置';
  const agentModelValue = agentModel ? configValue(agentModel) : '';
  const agentEffortValue = agentEffort ? configValue(agentEffort) : '';
  const native = !external && !props.agentConfig;
  const hasModel = !!agentModel || native;
  const hasReasoning = !!agentEffort || !!agentFast || native;
  const fast = native ? options.fast : agentFastOn;
  const nativeLevels = native ? modelEffortLevels(selected?.reasoningEfforts) : [];
  const nativeEffort = resolveModelEffort(selected?.reasoningEfforts, options.effort, options.effort);
  const activeModelLabel = agentModel
    ? modelGroupsForAgent.flatMap(group => group.models).find(model => model.value === configValue(agentModel))?.name || agentOptionLabel(agentModel)
    : '';
  const activeModelTooltip = agentModel
    ? [...new Set([agentOptionLabel(agentModel), agentOptionDescription(agentModel)])].filter(Boolean).join('\n')
    : selected ? `${selected.provider} / ${modelLabel(selected)}${modelLabel(selected) !== selected.name ? `\n${selected.name}` : ''}` : '选择模型';
  const modelQuery = query.trim().toLowerCase();
  const visibleModelGroups = pickerGroups
    .map(group => ({ ...group, models: group.models.filter(model => !modelQuery || `${group.name} ${model.name} ${model.value} ${model.description || ''}`.toLowerCase().includes(modelQuery)) }))
    .filter(group => group.models.length);

  const modelName = agentModel ? activeModelLabel : selected ? modelLabel(selected) : '选择模型';
  const reasoningValue = agentEffort ? agentEffortValue : native ? nativeEffort : '';
  const reasoningName = reasoningEffortLabel(reasoningValue, agentEffort ? agentOptionLabel(agentEffort) : reasoningValue, effortTranslate);
  const title = [agentEngineName, hasModel ? activeModelTooltip : '', hasReasoning ? `推理：${reasoningName || '默认'}${fast ? ' · 快速模式' : ''}` : '', fusionActive ? `边缘：${fusionLabel}` : ''].filter(Boolean).join('\n');
  const update = <K extends keyof ComposerOptions>(key: K, value: ComposerOptions[K]) => props.onOptions({ ...options, [key]: value });
  const changeAgent = (id: string, value: string | boolean) => props.agentConfig?.onChange(id, value);
  const close = props.onClose;
  const focusInput = props.onSelected;
  const back = () => { const previous = menu; setMenu('summary'); requestAnimationFrame(() => (previous === 'models' ? modelRow : previous === 'fusion' ? fusionRow : previous === 'fusion-effort' ? fusionEffortRow : effortRow).current?.focus()); };
  function cancelHoverClose() { clearTimeout(hoverClose.current); }
  function openPage(page: 'models' | 'effort' | 'fusion' | 'fusion-effort', focus = false) {
    if (agentBusy || ((page === 'fusion' || page === 'fusion-effort') && props.busy)) return;
    cancelHoverClose();
    if (focus) requestAnimationFrame(() => (flyout.current?.querySelector<HTMLInputElement>('input') || flyout.current?.querySelector<HTMLButtonElement>('button'))?.focus());
    if (menu === page) return;
    setQuery('');
    if (page === 'models' || page === 'fusion') {
      const option = page === 'fusion' ? fusion : agentModel;
      const groups = page === 'fusion' ? fusionGroups : modelGroupsForAgent;
      const value = page === 'fusion' ? fusionValue : agentModelValue;
      if (option) {
        const activeGroup = groups.find(group => group.models.some(model => model.value === value));
        const openGroup = activeGroup || (page === 'fusion' ? groups[0] : undefined);
        setCollapsed(groups.map(group => group.id).filter(id => id !== openGroup?.id));
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
      const rows = [modelRow, effortRow, fusionRow, fusionEffortRow].map(ref => ref.current).filter((el): el is HTMLButtonElement => !!el && !el.disabled);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (menu !== 'summary') back(); else { close(); trigger.current?.focus(); } }
      if (event.key === 'ArrowLeft' && rows.includes(event.target as HTMLButtonElement)) { event.preventDefault(); openPage(event.target === modelRow.current ? 'models' : event.target === fusionRow.current ? 'fusion' : event.target === fusionEffortRow.current ? 'fusion-effort' : 'effort', true); }
      if (event.key === 'ArrowRight' && flyout.current?.contains(event.target as Node)) { event.preventDefault(); back(); }
      if (rows.includes(event.target as HTMLButtonElement) && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        const index = rows.indexOf(event.target as HTMLButtonElement);
        rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
      }
    }}>
    <Tooltip content={title} classNames={{ content: 'model-name-tooltip' }} delay={600}>
      <Button ref={trigger} isDisabled={agentBusy} variant="light" className={`composer-model composer-model-reasoning ${props.open ? 'is-active' : ''}`}
        title={title} aria-label={`模型与推理设置：${[agentEngineName, hasModel ? (fusionActive ? '边缘 · ' : '') + modelName : '', hasReasoning ? reasoningName : ''].filter(Boolean).join(' · ')}`}
        aria-haspopup="dialog" aria-expanded={props.open} aria-controls={props.open ? panelId : undefined} onPress={props.onOpenChange}>
        <AgentIcon agentId={props.agentId} />
        {hasModel && <span className="model-reasoning-name">{fusionActive ? '边缘 · ' : ''}{modelName}</span>}
        {hasModel && hasReasoning && <span className="model-reasoning-divider" aria-hidden="true">·</span>}
        {hasReasoning && <span className="model-reasoning-effort">{reasoningName || (fast ? '快速' : '默认')}</span>}
      </Button>
    </Tooltip>
    {props.open && <div className="model-reasoning-menus" onPointerEnter={cancelHoverClose}
      onPointerLeave={() => { hoverClose.current = setTimeout(() => { if (!flyout.current?.contains(document.activeElement)) setMenu('summary'); }, 180); }}>
      <div className="composer-popover model-reasoning-popover model-reasoning-summary">
        <section id={panelId} role="dialog" aria-label="模型与推理设置">
          <div className="model-reasoning-rows">
            {hasModel && <button ref={modelRow} type="button" onPointerEnter={event => { if (event.pointerType !== 'touch') openPage('models'); }} onClick={() => openPage('models', true)} disabled={agentBusy}
              aria-haspopup="dialog" aria-expanded={menu === 'models'} aria-controls={menu === 'models' ? `${panelId}-models` : undefined}>
              <span>{fusionActive ? '主模型' : '模型'}</span><span className="model-reasoning-value" title={modelName}>{modelName}</span>
            </button>}
            {hasReasoning && <button ref={effortRow} type="button" onPointerEnter={event => { if (event.pointerType !== 'touch') openPage('effort'); }} onClick={() => openPage('effort', true)} disabled={agentBusy}
              aria-haspopup="dialog" aria-expanded={menu === 'effort'} aria-controls={menu === 'effort' ? `${panelId}-effort` : undefined}>
              <span>{fusionActive ? '主推理' : '推理'}</span><span className="model-reasoning-value">{reasoningName || (fast ? '快速模式' : '默认')}{fast && reasoningName && <Zap size="0.875rem" aria-label="快速模式已开启" />}</span>
            </button>}
            {!!fusion && <button ref={fusionRow} type="button" onPointerEnter={event => { if (event.pointerType !== 'touch') openPage('fusion'); }} onClick={() => openPage('fusion', true)} disabled={agentBusy || props.busy}
              aria-haspopup="dialog" aria-expanded={menu === 'fusion'} aria-controls={menu === 'fusion' ? `${panelId}-fusion` : undefined}>
              <span>边缘</span><span className="model-reasoning-value" title={fusionLabel}>{fusionLabel}</span>
            </button>}
            {!!fusionEffort && <button ref={fusionEffortRow} type="button" onPointerEnter={event => { if (event.pointerType !== 'touch') openPage('fusion-effort'); }} onClick={() => openPage('fusion-effort', true)} disabled={agentBusy || props.busy}
              aria-haspopup="dialog" aria-expanded={menu === 'fusion-effort'} aria-controls={menu === 'fusion-effort' ? `${panelId}-fusion-effort` : undefined}>
              <span>边缘推理</span><span className="model-reasoning-value">{reasoningEffortLabel(configValue(fusionEffort), agentOptionLabel(fusionEffort), t)}</span>
            </button>}
          </div>
        </section>
      </div>
      {menu !== 'summary' && <div ref={flyout} className={`composer-popover model-reasoning-flyout${menu === 'effort' || menu === 'fusion-effort' ? ' model-reasoning-flyout-effort' : ''}`} onPointerEnter={cancelHoverClose}>
        <section id={`${panelId}-${menu}`} role="dialog" aria-label={pickerTitle}>
          <div className="composer-popover-header">
            <div><strong>{pickerTitle}</strong>{menu === 'models' && <span className="demo-badge">{props.connected ? '在线' : '离线'}</span>}</div>
            <Button isIconOnly size="sm" variant="light" aria-label="收起设置面板" onPress={back}><X size="1rem" /></Button>
          </div>
        {(menu === 'models' || (menu === 'fusion' && !!fusion)) && (pickerOption ? <>
          <div className="popover-search"><Input size="sm" variant="bordered" aria-label="搜索模型" placeholder="搜索模型…" value={query} onValueChange={setQuery} startContent={<Search size="0.9375rem" />} isClearable onClear={() => setQuery('')} /></div>
          <div className="model-group-list">
            {menu === 'fusion' && fusion && <div className={`composer-model-row agent-model-row ${fusionValue === 'off' ? 'is-selected' : ''}`}>
              <button role="radio" aria-checked={fusionValue === 'off'} disabled={agentBusy || props.busy} aria-label={fusion.options.find(option => option.value === 'off')?.name || '关闭'} onClick={() => { changeAgent(fusion.id, 'off'); close(); focusInput(); }}>
                <span><strong>{fusion.options.find(option => option.value === 'off')?.name || '关闭'}</strong></span>{fusionValue === 'off' && <Check size="1rem" />}
              </button>
            </div>}
            {!!pickerOption.options?.length && !pickerOption.options.some(value => value.value === pickerValue) && <div className="composer-model-row is-selected">
              <button role="radio" aria-checked onClick={() => {}}><span><strong>{pickerValue}</strong></span><Check size="1rem" /></button>
            </div>}
            {visibleModelGroups.map(group => {
              const openGroup = !!modelQuery || !collapsed.includes(group.id);
              return <div key={group.id} className="composer-model-group">
                <button className="model-group-heading" aria-expanded={openGroup} onClick={() => setCollapsed(current => current.includes(group.id) ? current.filter(id => id !== group.id) : [...current, group.id])}>
                  <span className="provider-dot" style={{ background: '#9298a1' }} /><span>{group.name}</span><small>{group.models.length}</small><ChevronDown size="0.875rem" className={openGroup ? 'rotated' : ''} />
                </button>
                <Collapse open={openGroup}>{group.models.map(model => {
                  const selected = model.value === pickerValue;
                  return <div className={`composer-model-row agent-model-row ${selected ? 'is-selected' : ''}`} key={model.value}>
                    <button role="radio" aria-checked={selected} disabled={agentBusy || props.busy} aria-label={`${group.name} / ${model.name}`} title={[model.name, model.description].filter(Boolean).join('\n')} onClick={() => { changeAgent(pickerOption.id, model.value); close(); focusInput(); }}>
                      <span><strong>{model.name}</strong>{model.description && <small>{model.description}</small>}</span>{selected && <Check size="1rem" />}
                    </button>
                    {!external && menu !== 'fusion' && <Tooltip content={model.value === props.defaultModel ? '新会话默认模型' : '设为新会话默认模型'} delay={500}><Button isIconOnly size="sm" variant="light" className="model-star" aria-label={`设为默认模型：${group.name} / ${model.name}`} aria-pressed={model.value === props.defaultModel} onPress={() => { props.onDefaultModel(model.value); notify('已设为新会话默认模型'); }}><Star size="0.875rem" fill={model.value === props.defaultModel ? 'currentColor' : 'none'} /></Button></Tooltip>}
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
                <button role="radio" aria-checked={model.id === options.modelId} aria-label={`${model.provider} / ${modelLabel(model)}`} title={model.name} onClick={() => { if (model.reasoningEfforts !== undefined) props.onOptions({ ...options, modelId: model.id, effort: resolveModelEffort(model.reasoningEfforts, options.effort, options.effort) }); else update('modelId', model.id); close(); focusInput(); }}><span className="model-option-copy"><strong>{modelLabel(model)}</strong>{modelLabel(model) !== model.name && <small>{model.name}</small>}</span>{model.id === options.modelId && <Check size="1rem" />}</button>
                <Tooltip content={model.id === props.defaultModel ? '新会话默认模型' : '设为新会话默认模型'} delay={500}><Button isIconOnly size="sm" variant="light" className="model-star" aria-label={`设为默认模型：${model.provider} / ${modelLabel(model)}`} aria-pressed={model.id === props.defaultModel} onPress={() => { props.onDefaultModel(model.id); notify('已设为新会话默认模型'); }}><Star size="0.875rem" fill={model.id === props.defaultModel ? 'currentColor' : 'none'} /></Button></Tooltip>
              </div>)}</Collapse>
            </div>)}
            {!groupModels(models, query).length && <div className="composer-empty"><Search size="1.4375rem" /><p>没有找到匹配的模型</p><small>试试模型名或供应商名称</small></div>}
          </div>
          <div className="popover-footer"><span>模型来自 Loopra 配置</span><Button size="sm" variant="light" onPress={() => { close(); props.onManage(); }}><Settings2 size="0.875rem" />管理模型</Button></div>
        </>)}

        {menu === 'fusion-effort' && fusionEffort && <div className="effort-body">
          <ReasoningControl value={configValue(fusionEffort)} levels={agentEffortLevels(fusionEffort, t)} allowCustom={false} disabled={agentBusy || props.busy} onCommit={value => changeAgent(fusionEffort.id, value)} onClose={close} />
        </div>}
        {menu === 'effort' && (agentEffort || agentFast ? <div className="effort-body">
          {agentEffort && <ReasoningControl value={agentEffortValue} levels={agentLevels} allowCustom={false} localizeLevels={!external} disabled={agentBusy || props.busy} onCommit={value => changeAgent(agentEffort.id, value)} onClose={close} />}
          {agentFast && <div className="composer-toggle-row"><div><span><Zap size="0.9375rem" />快速模式</span><small>{agentOptionDescription(agentFast) || '发送快速模式参数，需模型支持'}</small></div><Toggle label="快速模式" value={agentFastOn} onChange={value => changeAgent(agentFast.id, agentFast.type === 'boolean' ? value : value ? 'on' : 'off')} /></div>}
        </div> : <div className="effort-body">
          {nativeLevels.length > 0 && <ReasoningControl value={nativeEffort} levels={nativeLevels} allowCustom={selected?.reasoningEfforts === undefined} disabled={props.busy} onCommit={value => update('effort', value)} onClose={close} />}
          <div className="composer-toggle-row"><div><span><Zap size="0.9375rem" />快速模式</span><small>发送快速模式参数，需模型支持</small></div><Toggle label="快速模式" value={options.fast} onChange={value => update('fast', value)} /></div>
        </div>)}
        </section>
      </div>}
    </div>}
  </div>;
}
