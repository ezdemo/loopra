import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Button, Chip, Input, Switch, Textarea, Tooltip } from '@nextui-org/react';
import { ArrowLeft, ArrowUp, BookOpen, Brain, Check, ChevronDown, ChevronRight, CircleHelp, FileText, FolderClosed, ListChecks, Paperclip, Pencil, Play, Plus, Search, Settings2, ShieldAlert, ShieldCheck, Sparkles, Square, SquareTerminal, Star, Trash2, X, Zap } from 'lucide-react';
import { appendPreset, effortLevels, estimateContext, getModelCatalog, groupModels, initialPresets } from '../composer';
import type { ComposerContext, ComposerOptions, PromptPreset } from '../composer';
import { useLocalState, type Provider } from '../lib';
import type { LoopraClient, Workspace } from '../backend';
import { Collapse, Popup } from './Motion';
import { LoopraMark } from './ui';
import ReasoningControl from './ReasoningControl';

type Props = {
  home: boolean; language: string; draft: string; onDraft: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>; options: ComposerOptions; onOptions: (value: ComposerOptions) => void | Promise<void>;
  skillOptions: { name: string; description: string }[]; systemPrompt: string; petEnabled: boolean; petStyle: string;
  context: ComposerContext; onContext: (value: ComposerContext) => void; providers: Provider[];
  workspaces: Workspace[]; connected: boolean;
  api: LoopraClient; workspaceHash: string;
  defaultModel: string; onDefaultModel: (id: string) => void; history: string[];
  busy: boolean; generating: boolean; onSend: () => void; onStop: () => void; onContinue: () => void;
  onNew: () => void; onTerminal: () => void; onManage: () => void; onOpen: () => void; notify: (text: string) => void;
};
type Menu = 'models' | 'effort' | 'tools' | 'projects' | 'skills' | 'permission' | 'presets' | 'context';

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Switch size="sm" aria-label={label} isSelected={value} onValueChange={onChange} classNames={{ label: 'sr-only' }}>{label}</Switch>;
}

export default function Composer(props: Props) {
  const { home, draft, onDraft, inputRef, options, onOptions, context, onContext, providers, notify, workspaces } = props;
  const [menu, setMenu] = useState<Menu | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [presets, setPresets] = useLocalState<PromptPreset[]>('prompt-presets', initialPresets);
  const [editing, setEditing] = useState<PromptPreset | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [popoverHeight, setPopoverHeight] = useState(500);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const dragDepth = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const models = getModelCatalog(providers);
  const selected = models.find(model => model.id === options.modelId);
  const usage = estimateContext(props.history, draft, context, selected?.contextTokens, props.systemPrompt);
  const effortIndex = effortLevels.findIndex(level => level.value === options.effort);
  const effort = effortLevels[effortIndex];
  const update = <K extends keyof ComposerOptions>(key: K, value: ComposerOptions[K]) => onOptions({ ...options, [key]: value });

  function close() { setMenu(null); setEditing(null); }
  function open(next: Menu) {
    props.onOpen(); setMenu(current => current === next ? null : next); setQuery(''); setEditing(null);
    if (next === 'models') setCollapsed([...new Set(models.map(model => model.providerId))].filter(id => id !== selected?.providerId));
    setDismissedDraft(draft);
  }
  function focusInput() { requestAnimationFrame(() => inputRef.current?.focus()); }
  async function addFiles(files: FileList | File[]) {
    const attachments = [...(context.attachments || [])];
    for (const file of Array.from(files)) {
      if (file.size > 5 * 1024 * 1024) { notify(`${file.name} 超过 5 MB，请缩小后上传`); continue; }
      if (file.type.startsWith('image/')) {
        const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
        attachments.push({ name: file.name, image });
      } else if (file.type.startsWith('text/') || /\.(md|txt|json|csv|log|[cm]?[jt]sx?|py|java|html|css|ya?ml|xml|sh|ps1|sql|vue|rs|go|c|cpp|h)$/i.test(file.name)) attachments.push({ name: file.name, text: await file.text() });
      else { notify(`${file.name} 暂不支持，请使用图片或文本文件`); }
    }
    onContext({ ...context, files: [...new Set([...context.files, ...attachments.map(file => file.name)])], attachments });
  }
  function toggleContext(key: 'projects' | 'skills', value: string) {
    onContext({ ...context, [key]: context[key].includes(value) ? context[key].filter(item => item !== value) : [...context[key], value] });
  }
  useLayoutEffect(() => {
    const measure = () => {
      const scale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
      setPopoverHeight(Math.max(130 * scale, (root.current?.getBoundingClientRect().bottom || window.innerHeight) - 82 * scale));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (root.current) observer.observe(root.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [menu, home]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); setDismissedDraft(draft); if (root.current?.contains(document.activeElement)) focusInput(); }
    };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', escape); };
  }, [draft]);

  const commands = [
    { id: '/new', title: '新建会话', description: '回到当前工作区的新会话', action: props.onNew },
    { id: '/continue', title: '继续生成', description: props.history.length ? '让助手继续上一次回复' : '开始会话后可用', action: () => { if (props.history.length && !props.busy) { onDraft(''); props.onContinue(); } else notify('请先开始会话'); } },
    { id: '/skills', title: '选择技能', description: '为这次消息附加技能', action: () => { onDraft(''); open('skills'); } },
    { id: '/help', title: '输入帮助', description: '/ 调用指令 · @ 引用工作区文件 · Shift + Enter 换行', action: () => { onDraft(''); notify('/ 调用指令，@ 引用工作区文件，Shift + Enter 换行'); } },
  ];
  const mention = draft.match(/(?:^|\s)@([^\s]*)$/);
  const mentionQuery = mention?.[1];
  useEffect(() => {
    if (mentionQuery === undefined || !props.workspaceHash) { setFileSuggestions([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void props.api.request<{ path: string }[]>(`/files/search?workspaceHash=${encodeURIComponent(props.workspaceHash)}&query=${encodeURIComponent(mentionQuery)}`, 'GET', undefined, controller.signal).then(files => { if (!controller.signal.aborted) setFileSuggestions(files.map(file => file.path)); }).catch(() => { if (!controller.signal.aborted) setFileSuggestions([]); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mentionQuery, props.api, props.workspaceHash]);
  const slash = draft.startsWith('/') && !draft.includes('\n') && !draft.includes(' ');
  const suggestions = menu || dismissedDraft === draft ? [] : slash
    ? commands.filter(command => command.id.includes(draft.toLowerCase())).map(command => ({ ...command, label: command.id }))
    : mention ? fileSuggestions.map(name => ({
      id: name, label: name, title: '引用项目文件', description: '将路径发送给 Loopra，由 Agent 按权限读取', action: () => {
        onContext({ ...context, files: [...new Set([...context.files, name])] });
        onDraft(draft.slice(0, draft.length - mention[1].length - 1));
      },
    })) : [];
  function selectSuggestion(index: number) { suggestions[index]?.action(); setSuggestionIndex(0); if (suggestions[index]?.id !== '/skills') focusInput(); }
  function savePreset() {
    if (!editing?.name.trim() || !editing.text.trim()) return;
    const item = { ...editing, name: editing.name.trim(), text: editing.text.trim() };
    setPresets(current => current.some(preset => preset.id === item.id) ? current.map(preset => preset.id === item.id ? item : preset) : [...current, item]);
    setEditing(null); notify('常用要求已保存');
  }
  const menuTitles: Record<Menu, string> = { models: '选择模型', effort: '推理设置', tools: '输入工具', projects: '关联项目', skills: '选择技能', permission: '权限模式', presets: '常用要求', context: '上下文用量' };

  return <div ref={root} data-popover style={{ '--composer-popover-height': `${popoverHeight}px` } as CSSProperties} className={`composer rich-composer ${home ? 'welcome-composer' : ''} ${dragging ? 'is-dragging' : ''}`}
    onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(event.dataTransfer.files); }}>
    {home && props.petEnabled && <div className={`peek-brand ${props.petStyle === '柔和紫' ? 'pet-violet' : ''}`}><LoopraMark /></div>}
    <div className="composer-context-chips">
      {(['projects', 'skills', 'files'] as const).flatMap(key => context[key].map(name => <Chip size="sm" variant="flat" key={`${key}:${name}`} classNames={{ base: `context-chip chip-${key}` }}
        startContent={key === 'projects' ? <FolderClosed size="0.8125rem" /> : key === 'skills' ? <Sparkles size="0.8125rem" /> : <Paperclip size="0.8125rem" />}
        endContent={<button className="context-chip-remove" aria-label={`移除${key === 'projects' ? '项目' : key === 'skills' ? '技能' : '附件'}：${name}`} onClick={() => onContext({ ...context, [key]: context[key].filter(item => item !== name), ...(key === 'files' ? { attachments: context.attachments?.filter(file => file.name !== name) } : {}) })}><X size="0.75rem" /></button>}>{name}</Chip>))}
      {options.plan && <Chip size="sm" variant="flat" color="primary" startContent={<ListChecks size="0.8125rem" />} endContent={<button className="context-chip-remove" aria-label="退出计划模式" onClick={() => update('plan', false)}><X size="0.75rem" /></button>}>计划模式</Chip>}
    </div>
    <textarea ref={inputRef} aria-label="输入消息" placeholder={props.language === 'English' ? 'Message… / commands, @ context' : '输入消息，/ 调用指令，@ 引用文件…'} value={draft}
      onChange={event => { onDraft(event.target.value); setSuggestionIndex(0); setDismissedDraft(null); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(event.key) && !event.shiftKey) {
          event.preventDefault();
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setSuggestionIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
          else selectSuggestion(suggestionIndex % suggestions.length);
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); props.onSend(); }
      }} />
    <div className="composer-bottom">
      <div className="composer-left">
        <Tooltip content="附件、项目、技能和计划模式" delay={600}><Button isIconOnly variant="light" aria-label="添加附件或工具" aria-expanded={menu === 'tools'} className={`composer-icon ${menu === 'tools' ? 'is-active' : ''}`} onPress={() => open('tools')}><Plus size="1.375rem" strokeWidth={1.6} /></Button></Tooltip>
        <Button variant="light" className={`composer-permission ${options.mode === '完全自动' ? 'automatic' : ''}`} onPress={() => open('permission')} aria-expanded={menu === 'permission'}>
          {options.mode === '完全自动' ? <ShieldAlert size="1.0625rem" /> : <ShieldCheck size="1.0625rem" />}<span>{options.mode}</span>
        </Button>
        <Tooltip content="常用要求" delay={600}><Button isIconOnly variant="light" className={`composer-icon ${menu === 'presets' ? 'is-active' : ''}`} aria-label="常用要求" aria-expanded={menu === 'presets'} onPress={() => open('presets')}><BookOpen size="1.0625rem" /></Button></Tooltip>
        {props.history.length > 0 && <Tooltip content={draft.trim() ? '先发送或清空草稿' : '继续生成'} delay={600}><Button isIconOnly variant="light" className="composer-icon continue-button" aria-label="继续生成" isDisabled={props.busy || !!draft.trim()} onPress={props.onContinue}><Play size="1rem" /></Button></Tooltip>}
      </div>
      <div className="composer-right">
        <Tooltip content={`上下文 ${usage.percent.toFixed(1)}% · 本地估算`} delay={600}><Button isIconOnly variant="light" aria-label="查看上下文用量" aria-expanded={menu === 'context'} className="composer-icon usage-button" onPress={() => open('context')}><span className="usage-ring" style={{ '--usage': `${Math.max(usage.percent, 4)}%` } as CSSProperties} /></Button></Tooltip>
        <Tooltip content={selected ? `${selected.provider} / ${selected.name}` : '选择模型'} delay={600}><Button variant="light" className={`composer-model ${menu === 'models' ? 'is-active' : ''}`} aria-label={`选择模型：${selected?.name || '未选择'}`} aria-expanded={menu === 'models'} onPress={() => open('models')}><span>{selected?.name || '选择模型'}</span><ChevronDown size="0.875rem" /></Button></Tooltip>
        <Tooltip content="推理强度与快速模式" delay={600}><Button variant="light" className={`composer-effort ${menu === 'effort' ? 'is-active' : ''}`} aria-label="推理设置" aria-expanded={menu === 'effort'} onPress={() => open('effort')}>{options.fast ? <Zap size="0.875rem" /> : <Brain size="0.875rem" />}<span>{effort ? effort.value === 'none' ? '无' : effort.value === 'xhigh' ? 'XHigh' : effort.value[0].toUpperCase() + effort.value.slice(1) : options.effort}</span></Button></Tooltip>
        {props.generating ? <Button isIconOnly aria-label="停止生成" className="send-button generating" onPress={props.onStop}><Square size="0.9375rem" fill="currentColor" /></Button>
          : <Button isIconOnly aria-label="发送消息" className="send-button" isDisabled={(!draft.trim() && !context.files.length) || props.busy || !selected} onPress={props.onSend}><ArrowUp size="1.4375rem" strokeWidth={2.5} /></Button>}
      </div>
    </div>
    <div className="composer-caption"><span><span>/</span> 指令 <span>·</span> <span>@</span> 上下文</span><span>Loopra <span>·</span> Shift + Enter 换行</span></div>
    <input ref={fileInput} type="file" multiple hidden onChange={event => { addFiles(event.target.files || []); event.target.value = ''; close(); focusInput(); }} />

    <Popup open={!!menu} className={`composer-popover ${['tools', 'projects', 'skills', 'permission', 'presets'].includes(menu || '') ? 'popover-left' : 'popover-right'} popover-${menu}`}>
      {menu && <section role="dialog" aria-label={menuTitles[menu]}>
        <div className="composer-popover-header">
          <div>{['projects', 'skills', 'permission'].includes(menu) && <Button isIconOnly size="sm" variant="light" aria-label="返回输入工具" onPress={() => open('tools')}><ArrowLeft size="1rem" /></Button>}<strong>{menuTitles[menu]}</strong>{menu === 'models' && <span className="demo-badge">{props.connected ? '在线' : '离线'}</span>}</div>
          <Button isIconOnly size="sm" variant="light" aria-label="关闭输入弹层" onPress={() => { close(); focusInput(); }}><X size="1rem" /></Button>
        </div>

        {menu === 'models' && <>
          <div className="popover-search"><Input autoFocus size="sm" variant="bordered" aria-label="搜索模型或供应商" placeholder="搜索模型或供应商…" value={query} onValueChange={setQuery} startContent={<Search size="0.9375rem" />} isClearable onClear={() => setQuery('')} /></div>
          <div className="model-group-list">
            {groupModels(models, query).map(group => <div key={group.id} className="composer-model-group">
              <button className="model-group-heading" aria-expanded={!!query || !collapsed.includes(group.id)} onClick={() => setCollapsed(current => current.includes(group.id) ? current.filter(id => id !== group.id) : [...current, group.id])}>
                <span className="provider-dot" style={{ background: group.color || '#9298a1' }} /><span>{group.name}</span><small>{group.models.length}</small><ChevronDown size="0.875rem" className={query || !collapsed.includes(group.id) ? 'rotated' : ''} />
              </button>
              <Collapse open={!!query || !collapsed.includes(group.id)}>{group.models.map(model => <div className={`composer-model-row ${model.id === options.modelId ? 'is-selected' : ''}`} key={model.id}>
                <button role="radio" aria-checked={model.id === options.modelId} aria-label={`${model.provider} / ${model.name}`} onClick={() => { update('modelId', model.id); close(); focusInput(); }}><span>{model.name}</span>{model.id === options.modelId && <Check size="1rem" />}</button>
                <Tooltip content={model.id === props.defaultModel ? '新会话默认模型' : '设为新会话默认模型'} delay={500}><Button isIconOnly size="sm" variant="light" className="model-star" aria-label={`设为默认模型：${model.provider} / ${model.name}`} aria-pressed={model.id === props.defaultModel} onPress={() => { props.onDefaultModel(model.id); notify('已设为新会话默认模型'); }}><Star size="0.875rem" fill={model.id === props.defaultModel ? 'currentColor' : 'none'} /></Button></Tooltip>
              </div>)}</Collapse>
            </div>)}
            {!groupModels(models, query).length && <div className="composer-empty"><Search size="1.4375rem" /><p>没有找到匹配的模型</p><small>试试模型名或供应商名称</small></div>}
          </div>
          <div className="popover-footer"><span>模型来自 Loopra 配置</span><Button size="sm" variant="light" onPress={() => { close(); props.onManage(); }}><Settings2 size="0.875rem" />管理模型</Button></div>
        </>}

        {menu === 'effort' && <div className="effort-body">
          <ReasoningControl value={options.effort} disabled={props.busy} onCommit={value => update('effort', value)} onClose={close} />
          <div className="composer-toggle-row"><div><span><Zap size="0.9375rem" />快速模式</span><small>发送快速模式参数，需模型支持</small></div><Toggle label="快速模式" value={options.fast} onChange={value => update('fast', value)} /></div>
          <div className="composer-toggle-row"><div><span>无工具调用时结束</span><small>同步到 Loopra 运行配置</small></div><Toggle label="无工具调用时结束" value={options.finishWithoutTools} onChange={value => update('finishWithoutTools', value)} /></div>
          <p className="composer-note">推理参数随请求发送，支持程度由所选模型决定。</p>
        </div>}

        {menu === 'tools' && <div className="composer-tool-list">
          <button onClick={() => fileInput.current?.click()}><Paperclip size="1.125rem" /><span><strong>上传文件</strong><small>图片与文本代码 · 读取内容发送</small></span><Plus size="0.9375rem" /></button>
          <div className="composer-tool-plan"><ListChecks size="1.125rem" /><span><strong>计划模式</strong><small>先生成步骤，再确认执行</small></span><Toggle label="计划模式" value={options.plan} onChange={value => update('plan', value)} /></div>
          <button onClick={() => open('projects')}><FolderClosed size="1.125rem" /><span><strong>关联项目</strong><small>为本轮消息选择工作区</small></span>{!!context.projects.length && <em>{context.projects.length}</em>}<ChevronRight size="0.9375rem" /></button>
          <button onClick={() => open('skills')}><Sparkles size="1.125rem" /><span><strong>技能</strong><small>选择助手处理任务的方式</small></span>{!!context.skills.length && <em>{context.skills.length}</em>}<ChevronRight size="0.9375rem" /></button>
          <button onClick={() => open('permission')}><ShieldCheck size="1.125rem" /><span><strong>权限模式</strong><small>{options.mode}</small></span><ChevronRight size="0.9375rem" /></button>
          <div className="composer-menu-divider" />
          <button onClick={() => { close(); props.onTerminal(); }}><SquareTerminal size="1.0625rem" /><span>打开终端</span><ChevronRight size="0.9375rem" /></button>
          <button onClick={() => { onDraft('/'); close(); setDismissedDraft(null); focusInput(); }}><CircleHelp size="1.0625rem" /><span>查看输入指令</span><span className="keycap">/</span></button>
        </div>}

        {(menu === 'projects' || menu === 'skills') && <>
          <div className="popover-search"><Input autoFocus size="sm" variant="bordered" aria-label={menu === 'projects' ? '搜索关联项目' : '搜索技能'} placeholder={menu === 'projects' ? '搜索项目名称或路径…' : '搜索技能…'} value={query} onValueChange={setQuery} startContent={<Search size="0.9375rem" />} /></div>
          <div className="composer-selection-list">
            {(menu === 'projects' ? workspaces.map(item => ({ name: item.name, description: item.path })) : props.skillOptions).filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())).map(item => <button key={item.name} role="checkbox" aria-checked={context[menu].includes(item.name)} onClick={() => toggleContext(menu, item.name)}>
              {menu === 'projects' ? <FolderClosed size="1.125rem" /> : <Sparkles size="1.125rem" />}<span><strong>{item.name}</strong><small>{item.description}</small></span><span className={`composer-checkbox ${context[menu].includes(item.name) ? 'checked' : ''}`}>{context[menu].includes(item.name) && <Check size="0.75rem" />}</span>
            </button>)}
            {!(menu === 'projects' ? workspaces.map(item => ({ name: item.name, description: item.path })) : props.skillOptions).some(item => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())) && <p className="composer-empty">没有匹配结果</p>}
          </div><div className="popover-footer"><span>已选 {context[menu].length} 项 · 可多选</span><Button size="sm" variant="light" onPress={() => onContext({ ...context, [menu]: [] })}>清空</Button><Button size="sm" color="primary" variant="flat" onPress={() => { close(); focusInput(); }}>完成</Button></div>
        </>}

        {menu === 'permission' && <div className="composer-selection-list">{[['完全自动', '自主执行工具与修改'], ['按需审批', '重要操作前等待确认'], ['自动审批', '由 Loopra 校验模型判断操作权限']].map(([name, description]) => <button key={name} role="radio" aria-checked={options.mode === name} onClick={() => { update('mode', name); close(); }}><ShieldCheck size="1.125rem" /><span><strong>{name}</strong><small>{description}</small></span>{options.mode === name && <Check size="1rem" />}</button>)}<p className="composer-note">权限同步到 Loopra，作用于真实工具执行。</p></div>}

        {menu === 'presets' && <>
          {editing ? <form className="preset-form" onSubmit={event => { event.preventDefault(); savePreset(); }}><Input autoFocus size="sm" variant="bordered" label="名称" aria-label="常用要求名称" maxLength={24} value={editing.name} onValueChange={name => setEditing({ ...editing, name })} /><Textarea variant="bordered" size="sm" label="要求内容" aria-label="常用要求内容" minRows={3} maxRows={5} maxLength={500} value={editing.text} onValueChange={text => setEditing({ ...editing, text })} /><div><Button size="sm" variant="light" onPress={() => setEditing(null)}>取消</Button><Button size="sm" color="primary" type="submit" isDisabled={!editing.name.trim() || !editing.text.trim()}>保存</Button></div></form>
            : <><p className="composer-note">点击要求追加到输入框，可自行编辑。</p><div className="preset-list">{presets.map(preset => <div className="preset-row" key={preset.id}><button className="preset-append" onClick={() => { onDraft(appendPreset(draft, preset.text)); close(); focusInput(); }}><strong>{preset.name}</strong><small>{preset.text}</small></button><Button isIconOnly size="sm" variant="light" aria-label={`编辑要求：${preset.name}`} onPress={() => setEditing({ ...preset })}><Pencil size="0.875rem" /></Button><Button isIconOnly size="sm" variant="light" aria-label={`删除要求：${preset.name}`} onPress={() => setPresets(current => current.filter(item => item.id !== preset.id))}><Trash2 size="0.875rem" /></Button></div>)}{!presets.length && <p className="composer-empty">还没有常用要求，添加一条试试。</p>}</div><div className="popover-footer"><span>保存在当前浏览器</span><Button size="sm" variant="light" onPress={() => setEditing({ id: crypto.randomUUID(), name: '', text: '' })}><Plus size="0.875rem" />添加要求</Button></div></>}
        </>}

        {menu === 'context' && <div className="context-body"><div className="context-total"><strong>{usage.total.toLocaleString()}<small> / {(usage.limit / 1000).toLocaleString()}K</small></strong><span>{usage.percent.toFixed(1)}%</span></div><p className="composer-note">上下文窗口 · 本地本地估算</p><div className="context-bar">{usage.parts.map(part => <span key={part.name} style={{ background: part.color, width: `${part.tokens / usage.total * 100}%` }} />)}</div>{usage.parts.map(part => <div className="context-breakdown" key={part.name}><span><i style={{ background: part.color }} />{part.name}</span><strong>{part.tokens.toLocaleString()}</strong><small>{(part.tokens / usage.total * 100).toFixed(1)}%</small></div>)}<p className="composer-note context-disclaimer">根据文字长度估算，附件只计入文件名。上下文窗口来自 Loopra 模型配置；实际用量以服务端统计为准。</p></div>}
      </section>}
    </Popup>
    <Popup open={!!suggestions.length} className="composer-popover popover-left composer-suggestions"><section aria-label={slash ? '输入指令' : '示例文件引用'}><div className="suggestions-heading">{slash ? '输入指令' : '示例文件引用'}<small>↑ ↓ 选择 · Tab / Enter 确认</small></div>{suggestions.map((item, index) => <button key={item.id} className={suggestionIndex % suggestions.length === index ? 'is-selected' : ''} onMouseEnter={() => setSuggestionIndex(index)} onClick={() => selectSuggestion(index)}>{slash ? <SquareTerminal size="1.0625rem" /> : <FileText size="1.0625rem" />}<span><strong>{item.label}<em>{item.title}</em></strong><small>{item.description}</small></span></button>)}</section></Popup>
    {dragging && <div className="composer-drop-hint"><Paperclip size="1.5rem" /><span>松开以添加附件</span></div>}
  </div>;
}
