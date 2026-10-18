import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type RefObject } from 'react';
import { Button, Chip, Input, Spinner, Switch, Textarea, Tooltip } from '@nextui-org/react';
import { ArrowLeft, ArrowUp, BookOpen, Brain, Check, ChevronDown, ChevronRight, CircleHelp, FileText, FolderClosed, ListChecks, Paperclip, Pencil, Play, Plus, RefreshCw, Search, Settings2, ShieldAlert, ShieldCheck, Sparkles, Square, SquareTerminal, Star, Trash2, X, Zap } from 'lucide-react';
import { appendPreset, attachmentViews, effortLevels, estimateContext, formatTokenSpeed, formatTokens, getModelCatalog, groupModels, initialPresets, localSlashCommands, mergeSlashCommands, presetPayload, presetsFromServer, serverSlashCommands } from '../composer';
import type { ComposerContext, ComposerOptions, LiveSpeed, PromptPreset, QueuedMessage, ServerCommand, ServerSkill, ServerPreset } from '../composer';
import { contextFromUsage, FOLD_THRESHOLD_RATIO, foldThreshold, formatUsageCost, usagePath, type UsageDTO } from '../usage';
import { attachmentLimitReached, fileKind, extractDocumentText, formatFileSize, LARGE_PASTE_THRESHOLD_CHARS, MAX_DOC_FILE_SIZE, MAX_IMAGE_COUNT, MAX_TEXT_FILE_SIZE, MAX_UPLOAD_FILES } from '../documents';
import { useLocalState, type Provider } from '../lib';
import type { AgentEngine, LoopraClient, Workspace } from '../backend';
import { Collapse, Popup } from './Motion';
import PetCompanion from './PetCompanion';
import { petScale, type PetAnimation, type PetReply } from '../pets';
import type { PetStore } from '../usePets';
import ReasoningControl from './ReasoningControl';
import AgentConfigControls from './AgentConfigControls';
import { agentEffortLevels, agentModelGroups as groupAgentModels, agentOptionDescription, agentOptionLabel, configValue, findAgentOption, isDangerousAgentMode, type AgentConfigState } from '../agent-config';

type Props = {
  agentId?: string; engines?: AgentEngine[]; onAgent?: (id: string) => void; onAgentsRefresh?: () => void;
  agentConfig?: AgentConfigState;
  home: boolean; language: string; draft: string; onDraft: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>; options: ComposerOptions; onOptions: (value: ComposerOptions) => void | Promise<void>;
  skillOptions: { name: string; description: string }[]; systemPrompt: string; petEnabled: boolean; pets: PetStore; petActivity: PetAnimation;
  petReply: PetReply | null; latestPetReply: string; onPetClose: () => void;
  context: ComposerContext; onContext: (value: ComposerContext) => void; providers: Provider[];
  workspaces: Workspace[]; connected: boolean;
  api: LoopraClient; workspaceHash: string;
  sessionName?: string;
  defaultModel: string; onDefaultModel: (id: string) => void; history: string[];
  busy: boolean; generating: boolean; onSend: () => void; onStop: () => void; onContinue: () => void;
  queue: QueuedMessage[]; onRemoveQueued: (id: string) => void; onGuideQueued: (id: string) => void;
  remoteRunning: boolean; onStopRemote: () => void;
  liveSpeed?: LiveSpeed;
  onNew: () => void; onTerminal: () => void; onManage: () => void; onOpen: () => void; notify: (text: string) => void;
  onExport: () => void; onSessions: () => void;
  onClear: () => void;
};
type Menu = 'agents' | 'models' | 'effort' | 'tools' | 'projects' | 'skills' | 'permission' | 'presets' | 'context' | 'more';

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Switch size="sm" aria-label={label} isSelected={value} onValueChange={onChange} classNames={{ label: 'sr-only' }}>{label}</Switch>;
}

export default function Composer(props: Props) {
  const external = !!props.agentId && props.agentId !== 'native';
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
  const [remoteCommands, setRemoteCommands] = useState<ServerCommand[]>([]);
  const [remoteSkills, setRemoteSkills] = useState<ServerSkill[]>([]);
  const [remoteUsage, setRemoteUsage] = useState<UsageDTO | null>(null);
  // Character counts for large pastes saved to disk, keyed by the saved path.
  const [pasteChars, setPasteChars] = useState<Record<string, number>>({});
  const dragDepth = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const models = getModelCatalog(providers);
  const selected = models.find(model => model.id === options.modelId);
  const usage = contextFromUsage(remoteUsage, estimateContext(props.history, draft, context, selected?.contextTokens, props.systemPrompt));
  // ACP Agents report context usage but no cumulative token counters, so omit the
  // empty counter instead of printing "总 token 0" next to a real USD cost.
  const usageNote = usage.metrics
    ? [
        usage.metrics.promptTokens + usage.metrics.completionTokens > 0
          ? `总 token ${formatTokens(usage.metrics.promptTokens + usage.metrics.completionTokens)}` : '',
        usage.metrics.hasPrice ? `费用 ${formatUsageCost(usage.metrics.totalCost, usage.metrics.currency)}` : '',
        usage.metrics.cacheHitRate != null ? `命中率 ${usage.metrics.cacheHitRate.toFixed(1)}%` : '',
      ].filter(Boolean).join(' · ') || '上下文来自 Agent 上报'
    : '根据文字长度估算，附件只计入文件名；上下文窗口来自 Loopra 模型配置。';
  const effortIndex = effortLevels.findIndex(level => level.value === options.effort);
  const effort = effortLevels[effortIndex];
  // ACP owns the per-session choices. Its standard categories map onto the
  // composer's existing permission, model and reasoning controls, so Native and
  // Claude Code look and behave the same; only the advertised values differ.
  const agentOptions = props.agentConfig?.options;
  const agentMode = findAgentOption(agentOptions, 'mode', 'mode');
  const agentModel = findAgentOption(agentOptions, 'model', 'model');
  const agentEffort = findAgentOption(agentOptions, 'effort', 'thought_level');
  const agentFast = findAgentOption(agentOptions, 'fast', 'model_config');
  const agentPlan = findAgentOption(agentOptions, 'plan');
  const agentBusy = !!props.agentConfig?.busy;
  const agentEngineName = props.engines?.find(engine => engine.id === (props.agentId || 'native'))?.name || (external ? 'Claude Code' : 'Loopra Native');
  const agentLevels = agentEffort ? agentEffortLevels(agentEffort) : [];
  const agentFastOn = !!agentFast && (agentFast.currentValue === true || agentFast.currentValue === 'on');
  const handledOptions = new Set([agentMode, agentModel, agentEffort, agentFast, agentPlan].filter(Boolean).map(option => option!.id));
  const otherAgentOptions = (agentOptions || []).filter(option => !handledOptions.has(option.id));
  const modelGroupsForAgent = agentModel ? groupAgentModels(agentModel, agentEngineName) : [];
  const activeModelLabel = agentModel
    ? modelGroupsForAgent.flatMap(group => group.models).find(model => model.value === configValue(agentModel))?.name || agentOptionLabel(agentModel)
    : '';
  const modelQuery = query.trim().toLowerCase();
  const visibleModelGroups = modelGroupsForAgent
    .map(group => ({ ...group, models: group.models.filter(model => !modelQuery || `${group.name} ${model.name} ${model.description || ''}`.toLowerCase().includes(modelQuery)) }))
    .filter(group => group.models.length);
  const agentModelValue = agentModel ? configValue(agentModel) : '';
  const agentModeValue = agentMode ? configValue(agentMode) : '';
  const agentEffortValue = agentEffort ? configValue(agentEffort) : '';
  const planActive = agentPlan ? configValue(agentPlan) === 'on' : options.plan;
  const update = <K extends keyof ComposerOptions>(key: K, value: ComposerOptions[K]) => onOptions({ ...options, [key]: value });
  const changeAgent = (id: string, value: string | boolean) => props.agentConfig?.onChange(id, value);

  function close() { setMenu(null); setEditing(null); }
  function open(next: Menu) {
    if (next === 'agents') props.onAgentsRefresh?.();
    props.onOpen(); setMenu(current => current === next ? null : next); setQuery(''); setEditing(null);
    if (next === 'models') {
      if (agentModel) {
        const groups = groupAgentModels(agentModel, agentEngineName);
        const activeGroup = groups.find(group => group.models.some(model => model.value === agentModelValue));
        setCollapsed(groups.map(group => group.id).filter(id => id !== activeGroup?.id));
      } else setCollapsed([...new Set(models.map(model => model.providerId))].filter(id => id !== selected?.providerId));
    }
    setDismissedDraft(draft);
  }
  function focusInput() { requestAnimationFrame(() => inputRef.current?.focus()); }
  async function addFiles(files: FileList | File[]) {
    const attachments = [...(context.attachments || [])];
    let imageCount = attachments.filter(file => file.image).length;
    let docCount = attachments.length - imageCount;
    let limitNotified = false;
    for (const file of Array.from(files)) {
      const kind = fileKind(file.name, file.type);
      if (kind === 'unsupported') { notify(`${file.name} 暂不支持，请使用图片、文本、PDF、Word 或 Excel`); continue; }
      if (attachmentLimitReached(imageCount, docCount, kind)) {
        if (!limitNotified) {
          notify(kind === 'image' ? `图片数量已达上限（${MAX_IMAGE_COUNT} 张）` : `上传文件数量已达上限（${MAX_UPLOAD_FILES} 个）`);
          limitNotified = true;
        }
        continue;
      }
      const limit = kind === 'text' ? MAX_TEXT_FILE_SIZE : kind === 'image' ? 5 * 1024 * 1024 : MAX_DOC_FILE_SIZE;
      if (file.size > limit) { notify(`${file.name} 超过大小限制（${kind === 'text' ? '512KB' : kind === 'image' ? '5MB' : '30MB'}）`); continue; }
      try {
        if (kind === 'image') {
          const image = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
          attachments.push({ name: file.name, image, size: file.size });
          imageCount += 1;
        } else {
          attachments.push({ name: file.name, text: await extractDocumentText(file), size: file.size });
          docCount += 1;
        }
      } catch (error) {
        notify(`${file.name} 解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    onContext({ ...context, files: [...new Set([...context.files, ...attachments.map(file => file.name)])], attachments });
  }
  // Large plain-text pastes are saved into the project instead of the draft.
  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files: File[] = [];
    for (const item of Array.from(event.clipboardData?.items || [])) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length) { event.preventDefault(); await addFiles(files); return; }
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!props.workspaceHash || text.length <= LARGE_PASTE_THRESHOLD_CHARS) return;
    event.preventDefault();
    try {
      const saved = await props.api.request<{ path: string; chars?: number }>('/files/paste', 'POST', { workspaceHash: props.workspaceHash, content: text });
      if (!saved?.path) throw new Error('服务端未返回文件路径');
      onContext({ ...context, files: [...new Set([...context.files, saved.path])] });
      setPasteChars(current => ({ ...current, [saved.path]: Number(saved.chars) || text.length }));
      notify(`大段粘贴已保存为 ${saved.path}`);
    } catch (error) {
      onDraft(draft ? `${draft}\n\n${text}` : text);
      notify(`大段粘贴内容保存失败：${error instanceof Error ? error.message : String(error)}，已恢复原文`);
    }
  }
  function toggleContext(key: 'projects' | 'skills', value: string) {
    onContext({ ...context, [key]: context[key].includes(value) ? context[key].filter(item => item !== value) : [...context[key], value] });
  }
  // Slash commands and skills live on the backend; fetch once per client.
  useEffect(() => {
    const controller = new AbortController();
    void props.api.request<ServerCommand[]>('/agent/commands', 'GET', undefined, controller.signal)
      .then(list => { if (!controller.signal.aborted && Array.isArray(list)) setRemoteCommands(list); }).catch(() => {});
    void props.api.request<ServerSkill[]>('/agent/skills', 'GET', undefined, controller.signal)
      .then(list => { if (!controller.signal.aborted && Array.isArray(list)) setRemoteSkills(list); }).catch(() => {});
    return () => controller.abort();
  }, [props.api]);
  // Prompt presets are server-side config; the local cache is only a fallback.
  useEffect(() => {
    const controller = new AbortController();
    void props.api.request<ServerPreset[]>('/prompt-presets', 'GET', undefined, controller.signal)
      .then(list => { if (!controller.signal.aborted && Array.isArray(list)) setPresets(presetsFromServer(list)); }).catch(() => {});
    return () => controller.abort();
  }, [props.api, setPresets]);
  function persistPresets(next: PromptPreset[]) {
    void props.api.request('/prompt-presets', 'PUT', presetPayload(next))
      .catch((error: unknown) => notify(`常用要求同步失败：${error instanceof Error ? error.message : String(error)}`));
  }
  // Real token usage for the active session, refreshed as the conversation grows.
  useEffect(() => {
    if (!props.workspaceHash || !props.sessionName) { setRemoteUsage(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void props.api.request<UsageDTO>(usagePath(props.workspaceHash, props.sessionName), 'GET', undefined, controller.signal)
        .then(data => { if (!controller.signal.aborted) setRemoteUsage(data); })
        .catch(() => { if (!controller.signal.aborted) setRemoteUsage(null); });
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [props.api, props.workspaceHash, props.sessionName, props.history.length, props.generating]);
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

  const localCommands = localSlashCommands({
    onNew: props.onNew,
    onContinue: props.onContinue,
    onSkills: () => open('skills'),
    onHelp: () => notify('/ 调用指令，@ 引用工作区文件，Shift + Enter 换行'),
    onExport: props.onExport,
    onSessions: props.onSessions,
    onTerminal: props.onTerminal,
    onClear: props.onClear,
    hasHistory: !!props.history.length, busy: props.busy, notify,
  }).map(command => ({ ...command, action: () => { onDraft(''); command.action?.(); } }));
  // Server commands/skills insert their text so the agent handles them.
  const remoteSlash = serverSlashCommands(remoteCommands, remoteSkills)
    .map(command => ({ ...command, action: () => { onDraft(command.insert || `${command.id} `); close(); focusInput(); } }));
  const commands = mergeSlashCommands(localCommands, remoteSlash);
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
  const suggestions = menu || dismissedDraft === draft || (external && slash) ? [] : slash
    ? commands.filter(command => command.id.includes(draft.toLowerCase())).map(command => ({ ...command, label: command.id }))
    : mention ? fileSuggestions.map(name => ({
      id: name, label: name, title: '引用项目文件', description: '将路径发送给 Loopra，由 Agent 按权限读取', action: () => {
        onContext({ ...context, files: [...new Set([...context.files, name])] });
        onDraft(draft.slice(0, draft.length - mention[1].length - 1));
      },
    })) : [];
  function selectSuggestion(index: number) { suggestions[index]?.action?.(); setSuggestionIndex(0); if (suggestions[index]?.id !== '/skills') focusInput(); }
  function savePreset() {
    if (!editing?.name.trim() || !editing.text.trim()) return;
    const item = { ...editing, name: editing.name.trim(), text: editing.text.trim() };
    const next = presets.some(preset => preset.id === item.id) ? presets.map(preset => preset.id === item.id ? item : preset) : [...presets, item];
    setPresets(next); persistPresets(next);
    setEditing(null); notify('常用要求已保存');
  }
  const menuTitles: Record<Menu, string> = { agents: '选择 Agent', models: '选择模型', effort: '推理设置', tools: '输入工具', projects: '关联项目', skills: '选择技能', permission: '权限模式', presets: '常用要求', context: '上下文用量', more: '更多 Agent 配置' };
  // Legacy ChatInput split context into image thumbnails and file chips with sizes.
  const { images: contextImages, files: contextFiles } = attachmentViews(context, pasteChars);
  const removeAttachment = (name: string) => onContext({ ...context, files: context.files.filter(item => item !== name), attachments: context.attachments?.filter(file => file.name !== name) });
  const hasContext = contextImages.length > 0 || context.projects.length > 0 || context.skills.length > 0 || contextFiles.length > 0;

  return <div ref={root} data-popover style={{ '--composer-popover-height': `${popoverHeight}px` } as CSSProperties} className={`composer rich-composer ${home ? 'welcome-composer' : ''} ${dragging ? 'is-dragging' : ''}`}
    onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(event.dataTransfer.files); }}>
    {props.petEnabled && props.pets.active && <PetCompanion key={props.pets.active.name} src={props.pets.imageUrl} name={props.pets.active.displayName || props.pets.active.name} scale={petScale(props.pets.active)} position={props.pets.active.position}
      activity={props.petActivity} reply={props.petReply} latestReply={props.latestPetReply} hidden={!!menu || !!suggestions.length} onMove={props.pets.move} onResize={props.pets.resize} onClose={props.onPetClose} onError={props.notify} />}
    <div className="composer-context-chips">
      {contextImages.map(image => <div className="composer-image-thumb" key={`image:${image.name}`} title={image.name}>
        <img className="composer-image-preview" src={image.src} alt={image.name} />
        <button type="button" className="composer-image-remove" aria-label={`移除图片：${image.name}`} title="移除图片" onClick={() => removeAttachment(image.name)}><X size="0.75rem" /></button>
      </div>)}
      {(['projects', 'skills'] as const).flatMap(key => context[key].map(name => <Chip size="sm" variant="flat" key={`${key}:${name}`} classNames={{ base: `context-chip chip-${key}` }}
        startContent={key === 'projects' ? <FolderClosed size="0.8125rem" /> : <Sparkles size="0.8125rem" />}
        endContent={<button className="context-chip-remove" aria-label={`移除${key === 'projects' ? '项目' : '技能'}：${name}`} onClick={() => onContext({ ...context, [key]: context[key].filter(item => item !== name) })}><X size="0.75rem" /></button>}>{name}</Chip>))}
      {contextFiles.map(file => <Chip size="sm" variant="flat" key={`files:${file.name}`} classNames={{ base: 'context-chip chip-files' }}
        startContent={<Paperclip size="0.8125rem" />}
        endContent={<button className="context-chip-remove" aria-label={`移除附件：${file.name}`} onClick={() => removeAttachment(file.name)}><X size="0.75rem" /></button>}>
        {file.name}{file.chars != null ? <small className="context-chip-size">{file.chars.toLocaleString()} 字符</small> : file.size != null ? <small className="context-chip-size">{formatFileSize(file.size)}</small> : null}
      </Chip>)}
      {planActive && <Chip size="sm" variant="flat" color="primary" startContent={<ListChecks size="0.8125rem" />} endContent={<button className="context-chip-remove" aria-label="退出计划模式" disabled={agentBusy} onClick={() => { if (agentPlan) changeAgent(agentPlan.id, 'off'); else update('plan', false); }}><X size="0.75rem" /></button>}>计划模式</Chip>}
      {hasContext && <button type="button" className="context-clear-all" onClick={() => onContext({ ...context, projects: [], skills: [], files: [], attachments: [] })}>清除</button>}
    </div>
    {props.remoteRunning && <div className="composer-run-status" role="status"><i /><span>该会话正在后台执行，输入的内容会加入队列</span></div>}
    {props.queue.length > 0 && <section className="composer-queue" aria-label={`排队消息 ${props.queue.length} 条`}>
      <div className="composer-queue-summary"><ListChecks size="0.875rem" /><span>排队 {props.queue.length} 条 · 当前回复结束后自动发送</span></div>
      <ul className="composer-queue-list">{props.queue.map(item => <li key={item.id}><span className="composer-queue-text" title={item.text}>{item.text || '（仅附件）'}</span><button type="button" className="composer-queue-guide" title="停止当前生成，优先发送这条消息" onClick={() => props.onGuideQueued(item.id)}>引导</button><button type="button" className="composer-queue-remove" title="移出队列" aria-label="移出队列" onClick={() => props.onRemoveQueued(item.id)}><X size="0.75rem" /></button></li>)}</ul>
    </section>}
    <textarea ref={inputRef} aria-label="输入消息" placeholder={props.language === 'English' ? 'Message… / commands, @ context' : '输入消息，/ 调用指令，@ 引用文件…'} value={draft}
      onChange={event => { onDraft(event.target.value); setSuggestionIndex(0); setDismissedDraft(null); }}
      onPaste={event => { void handlePaste(event); }}
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
        <Tooltip content="附件、项目、技能和计划模式" delay={600}><Button isIconOnly variant="light" aria-label="添加附件或工具" aria-expanded={menu === 'tools'} className={`composer-icon ${menu === 'tools' ? 'is-active' : ''}`} onPress={() => open('tools')}><Plus size="1.125rem" strokeWidth={1.75} /></Button></Tooltip>
        {agentMode ? <Tooltip content={agentOptionDescription(agentMode)} delay={600}><Button isDisabled={agentBusy} variant="light" className={`composer-permission ${isDangerousAgentMode(agentMode) ? 'automatic' : ''}`} onPress={() => open('permission')} aria-expanded={menu === 'permission'}>
          {isDangerousAgentMode(agentMode) ? <ShieldAlert size="0.9375rem" /> : <ShieldCheck size="0.9375rem" />}<span>{agentOptionLabel(agentMode)}</span>
        </Button></Tooltip> : !props.agentConfig && <Button isDisabled={external} variant="light" className={`composer-permission ${!external && options.mode === '完全自动' ? 'automatic' : ''}`} onPress={() => open('permission')} aria-expanded={menu === 'permission'}>
          {!external && options.mode === '完全自动' ? <ShieldAlert size="0.9375rem" /> : <ShieldCheck size="0.9375rem" />}<span>{external ? '由 Agent 请求审批' : options.mode}</span>
        </Button>}
        <Tooltip content="常用要求" delay={600}><Button isIconOnly variant="light" className={`composer-icon ${menu === 'presets' ? 'is-active' : ''}`} aria-label="常用要求" aria-expanded={menu === 'presets'} onPress={() => open('presets')}><BookOpen size="1rem" /></Button></Tooltip>
        {props.history.length > 0 && <Tooltip content={draft.trim() ? '先发送或清空草稿' : '继续生成'} delay={600}><Button isIconOnly variant="light" className="composer-icon continue-button" aria-label="继续生成" isDisabled={props.busy || !!draft.trim()} onPress={props.onContinue}><Play size="1rem" /></Button></Tooltip>}
      </div>
      <div className={`composer-right ${agentOptions ? 'has-agent-config' : ''}`}>
        <Tooltip content={`上下文 ${usage.percent.toFixed(1)}% · ${usage.metrics ? '服务端统计' : '本地估算'}`} delay={600}><Button isIconOnly variant="light" aria-label="查看上下文用量" aria-expanded={menu === 'context'} className="composer-icon usage-button" onPress={() => open('context')}><span className="usage-ring" style={{ '--usage': `${Math.max(usage.percent, 4)}%` } as CSSProperties} /></Button></Tooltip>
        <Button variant="light" className="composer-model" aria-label="选择 Agent" aria-expanded={menu === 'agents'} onPress={() => open('agents')}><span>{props.engines?.find(engine => engine.id === (props.agentId || 'native'))?.name || (external ? 'Claude Code' : 'Loopra Native')}</span><ChevronDown size="0.875rem" /></Button>
        {agentOptions ? <>
          {otherAgentOptions.length > 0 && <Tooltip content="更多 Agent 配置" delay={600}><Button isIconOnly variant="light" className={`composer-icon ${menu === 'more' ? 'is-active' : ''}`} aria-label="更多 Agent 配置" aria-expanded={menu === 'more'} onPress={() => open('more')}><Settings2 size="1rem" /></Button></Tooltip>}
          {agentModel && <Tooltip content={agentOptionDescription(agentModel)} delay={600}><Button isDisabled={agentBusy} variant="light" className={`composer-model ${menu === 'models' ? 'is-active' : ''}`} aria-label={`选择模型：${agentOptionLabel(agentModel)}`} aria-expanded={menu === 'models'} onPress={() => open('models')}><span>{activeModelLabel}</span><ChevronDown size="0.875rem" /></Button></Tooltip>}
          {(agentEffort || agentFast) && <Tooltip content="推理强度与快速模式" delay={600}><Button isDisabled={agentBusy} variant="light" className={`composer-effort ${menu === 'effort' ? 'is-active' : ''}`} aria-label="推理设置" aria-expanded={menu === 'effort'} onPress={() => open('effort')}>{agentFastOn ? <Zap size="0.875rem" /> : <Brain size="0.875rem" />}<span>{agentEffort ? agentOptionLabel(agentEffort) : '快速'}</span></Button></Tooltip>}
        </> : props.agentConfig
          ? props.agentConfig.error
            ? <Tooltip content={props.agentConfig.error} delay={300}><Button isIconOnly size="sm" variant="light" className="composer-icon" isDisabled={!!props.agentConfig.busy} onPress={props.agentConfig.onPrepare} aria-label="重试加载 Agent 配置"><RefreshCw size="1rem" /></Button></Tooltip>
            : props.agentConfig.busy ? <span className="agent-config-loading" role="status" aria-label="正在加载 Agent 配置"><Spinner size="sm" /></span> : null
          : <>
            {!external && <Tooltip content={selected ? `${selected.provider} / ${selected.name}` : '选择模型'} delay={600}><Button variant="light" className={`composer-model ${menu === 'models' ? 'is-active' : ''}`} aria-label={`选择模型：${selected?.name || '未选择'}`} aria-expanded={menu === 'models'} onPress={() => open('models')}><span>{selected?.name || '选择模型'}</span><ChevronDown size="0.875rem" /></Button></Tooltip>}
            {!external && <Tooltip content="推理强度与快速模式" delay={600}><Button variant="light" className={`composer-effort ${menu === 'effort' ? 'is-active' : ''}`} aria-label="推理设置" aria-expanded={menu === 'effort'} onPress={() => open('effort')}>{options.fast ? <Zap size="0.875rem" /> : <Brain size="0.875rem" />}<span>{effort ? effort.value === 'none' ? '无' : effort.value === 'xhigh' ? 'XHigh' : effort.value[0].toUpperCase() + effort.value.slice(1) : options.effort}</span></Button></Tooltip>}
          </>}
        {props.generating ? <Button isIconOnly aria-label="停止生成" className="send-button generating" onPress={props.onStop}><Square size="0.75rem" fill="currentColor" /></Button>
          : props.remoteRunning ? <Button isIconOnly aria-label="停止后台任务" className="send-button generating" onPress={props.onStopRemote}><Square size="0.75rem" fill="currentColor" /></Button> : null}
        <Button isIconOnly aria-label={props.generating || props.remoteRunning ? '加入队列' : '发送消息'} className={`send-button ${props.generating || props.remoteRunning ? 'queueing' : ''}`} isDisabled={(!draft.trim() && !context.files.length) || (!props.agentConfig && !external && !selected) || (!props.generating && !props.remoteRunning && props.busy)} onPress={props.onSend}><ArrowUp size="1rem" strokeWidth={2.25} /></Button>
      </div>
    </div>
    <div className="composer-caption"><span><span>/</span> 指令 <span>·</span> <span>@</span> 上下文</span><span>Loopra <span>·</span> Shift + Enter 换行</span></div>
    <input ref={fileInput} type="file" multiple hidden accept="image/*,.pdf,.docx,.xlsx,.txt,.md,.markdown,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.html,.htm,.css,.scss,.less,.xml,.yaml,.yml,.toml,.ini,.properties,.cfg,.conf,.env,.vue,.svelte" onChange={event => { addFiles(event.target.files || []); event.target.value = ''; close(); focusInput(); }} />

    <Popup open={!!menu} className={`composer-popover ${['tools', 'projects', 'skills', 'permission', 'presets'].includes(menu || '') ? 'popover-left' : 'popover-right'} popover-${menu}`}>
      {menu && <section role="dialog" aria-label={menuTitles[menu]}>
        <div className="composer-popover-header">
          <div>{['projects', 'skills', 'permission'].includes(menu) && <Button isIconOnly size="sm" variant="light" aria-label="返回输入工具" onPress={() => open('tools')}><ArrowLeft size="1rem" /></Button>}<strong>{menuTitles[menu]}</strong>{menu === 'models' && <span className="demo-badge">{props.connected ? '在线' : '离线'}</span>}</div>
          <Button isIconOnly size="sm" variant="light" aria-label="关闭输入弹层" onPress={() => { close(); focusInput(); }}><X size="1rem" /></Button>
        </div>

        {menu === 'agents' && <div className="composer-tool-list">{(props.engines || []).map(engine => <button key={engine.id} disabled={!engine.available} onClick={() => { props.onAgent?.(engine.id); close(); focusInput(); }}><span><strong>{engine.name}</strong><small>{engine.detail || (engine.available ? engine.id === 'native' ? '使用 Loopra 模型配置' : '使用本机 Claude 登录和配置' : '后端未检测到运行环境，请重启后端后重试')}</small></span>{engine.id === (props.agentId || 'native') && <Check size="1rem" />}</button>)}<p className="composer-note">切换 Agent 会新建会话。Claude 模型沿用自身配置。</p></div>}
        {menu === 'models' && (agentModel ? <>
          <div className="popover-search"><Input autoFocus size="sm" variant="bordered" aria-label="搜索模型" placeholder="搜索模型…" value={query} onValueChange={setQuery} startContent={<Search size="0.9375rem" />} isClearable onClear={() => setQuery('')} /></div>
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
                    <button role="radio" aria-checked={selected} aria-label={`${group.name} / ${model.name}`} onClick={() => { changeAgent(agentModel.id, model.value); close(); focusInput(); }}>
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
        </>)}

        {menu === 'effort' && (agentEffort || agentFast ? <div className="effort-body">
          {agentEffort && <ReasoningControl value={agentEffortValue} levels={agentLevels} allowCustom={false} disabled={agentBusy || props.busy} onCommit={value => changeAgent(agentEffort.id, value)} onClose={close} />}
          {agentFast && <div className="composer-toggle-row"><div><span><Zap size="0.9375rem" />快速模式</span><small>{agentOptionDescription(agentFast) || '发送快速模式参数，需模型支持'}</small></div><Toggle label="快速模式" value={agentFastOn} onChange={value => changeAgent(agentFast.id, agentFast.type === 'boolean' ? value : value ? 'on' : 'off')} /></div>}
        </div> : <div className="effort-body">
          <ReasoningControl value={options.effort} disabled={props.busy} onCommit={value => update('effort', value)} onClose={close} />
          <div className="composer-toggle-row"><div><span><Zap size="0.9375rem" />快速模式</span><small>发送快速模式参数，需模型支持</small></div><Toggle label="快速模式" value={options.fast} onChange={value => update('fast', value)} /></div>
        </div>)}

        {menu === 'tools' && <div className="composer-tool-list">
          <button onClick={() => fileInput.current?.click()}><Paperclip size="1.125rem" /><span><strong>上传文件</strong><small>图片、文本、PDF、Word、Excel · 读取内容发送</small></span><Plus size="0.9375rem" /></button>
          {agentPlan ? <div className="composer-tool-plan"><ListChecks size="1.125rem" /><span><strong>计划模式</strong><small>先生成步骤，再确认执行</small></span><Toggle label="计划模式" value={planActive} onChange={value => changeAgent(agentPlan.id, value ? 'on' : 'off')} /></div>
            : !external && !props.agentConfig && <div className="composer-tool-plan"><ListChecks size="1.125rem" /><span><strong>计划模式</strong><small>先生成步骤，再确认执行</small></span><Toggle label="计划模式" value={options.plan} onChange={value => update('plan', value)} /></div>}
          <button onClick={() => open('projects')}><FolderClosed size="1.125rem" /><span><strong>关联项目</strong><small>为本轮消息选择工作区</small></span>{!!context.projects.length && <em>{context.projects.length}</em>}<ChevronRight size="0.9375rem" /></button>
          <button onClick={() => open('skills')}><Sparkles size="1.125rem" /><span><strong>技能</strong><small>选择助手处理任务的方式</small></span>{!!context.skills.length && <em>{context.skills.length}</em>}<ChevronRight size="0.9375rem" /></button>
          {agentMode ? <button onClick={() => open('permission')}><ShieldCheck size="1.125rem" /><span><strong>权限模式</strong><small>{agentOptionLabel(agentMode)}</small></span><ChevronRight size="0.9375rem" /></button>
            : !external && !props.agentConfig && <button onClick={() => open('permission')}><ShieldCheck size="1.125rem" /><span><strong>权限模式</strong><small>{options.mode}</small></span><ChevronRight size="0.9375rem" /></button>}
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

        {menu === 'permission' && (agentMode ? <div className="composer-selection-list">
          {(agentMode.options.some(value => value.value === agentModeValue) ? agentMode.options : [{ value: agentModeValue, name: agentModeValue, group: null }, ...agentMode.options]).map(value => {
            const selected = value.value === agentModeValue;
            const danger = /bypass|free/i.test(value.value) || /bypass|完全自动/i.test(value.name);
            return <button key={value.value} role="radio" aria-checked={selected} disabled={agentBusy} className={danger ? 'is-danger' : undefined} onClick={() => { changeAgent(agentMode.id, value.value); close(); }}>
              {danger ? <ShieldAlert size="1.125rem" /> : <ShieldCheck size="1.125rem" />}
              <span><strong>{value.name}</strong>{value.description && <small>{value.description}</small>}</span>{selected && <Check size="1rem" />}
            </button>;
          })}
          <p className="composer-note">选项由 {agentEngineName} 提供，作用于当前会话。</p>
        </div> : <div className="composer-selection-list">{[['完全自动', '跳过审核，直接执行工具与修改'], ['按需审批', '普通读写直接执行，其余等待人工确认'], ['自动审批', '普通读写直接执行，其余由 AI 审核']].map(([name, description]) => <button key={name} role="radio" aria-checked={options.mode === name} onClick={() => { update('mode', name); close(); }}><ShieldCheck size="1.125rem" /><span><strong>{name}</strong><small>{description}</small></span>{options.mode === name && <Check size="1rem" />}</button>)}<p className="composer-note">权限同步到 Loopra，作用于真实工具执行。</p></div>)}

        {menu === 'more' && props.agentConfig && <AgentConfigControls state={props.agentConfig} options={otherAgentOptions} />}

        {menu === 'presets' && <>
          {editing ? <form className="preset-form" onSubmit={event => { event.preventDefault(); savePreset(); }}><Input autoFocus size="sm" variant="bordered" label="名称" aria-label="常用要求名称" maxLength={24} value={editing.name} onValueChange={name => setEditing({ ...editing, name })} /><Textarea variant="bordered" size="sm" label="要求内容" aria-label="常用要求内容" minRows={3} maxRows={5} maxLength={500} value={editing.text} onValueChange={text => setEditing({ ...editing, text })} /><div><Button size="sm" variant="light" onPress={() => setEditing(null)}>取消</Button><Button size="sm" color="primary" type="submit" isDisabled={!editing.name.trim() || !editing.text.trim()}>保存</Button></div></form>
            : <><p className="composer-note">点击要求追加到输入框，可自行编辑。</p><div className="preset-list">{presets.map(preset => <div className="preset-row" key={preset.id}><button className="preset-append" onClick={() => { onDraft(appendPreset(draft, preset.text)); close(); focusInput(); }}><strong>{preset.name}</strong><small>{preset.text}</small></button><Button isIconOnly size="sm" variant="light" aria-label={`编辑要求：${preset.name}`} onPress={() => setEditing({ ...preset })}><Pencil size="0.875rem" /></Button><Button isIconOnly size="sm" variant="light" aria-label={`删除要求：${preset.name}`} onPress={() => { const next = presets.filter(item => item.id !== preset.id); setPresets(next); persistPresets(next); }}><Trash2 size="0.875rem" /></Button></div>)}{!presets.length && <p className="composer-empty">还没有常用要求，添加一条试试。</p>}</div><div className="popover-footer"><span>保存在服务端</span><Button size="sm" variant="light" onPress={() => setEditing({ id: crypto.randomUUID(), name: '', text: '' })}><Plus size="0.875rem" />添加要求</Button></div></>}
        </>}

        {menu === 'context' && <div className="context-body"><div className="context-total"><strong>{formatTokens(usage.total)}<small> / {formatTokens(usage.limit)}</small></strong><span className={usage.percent >= 80 ? 'context-high' : usage.percent >= 50 ? 'context-medium' : 'context-low'}>{usage.percent.toFixed(1)}%</span></div>{formatTokenSpeed(props.liveSpeed) && <p className="composer-note">生成速度 {formatTokenSpeed(props.liveSpeed)}{props.liveSpeed?.completionTokens ? ` · 已生成 ${formatTokens(props.liveSpeed.completionTokens)} tokens` : ''}</p>}<div className="context-gauge" role="img" aria-label={`上下文占用 ${usage.percent.toFixed(1)}%，折叠阈值 ${FOLD_THRESHOLD_RATIO * 100}%`}>{usage.parts.map(part => <span key={part.name} style={{ background: part.color, width: `${part.tokens / usage.limit * 100}%` }} />)}<span className="context-gauge-threshold" style={{ left: `${FOLD_THRESHOLD_RATIO * 100}%` }} title="折叠阈值 (80%)" /></div><div className="context-gauge-scale"><span>当前 {formatTokens(usage.total)}</span><span>窗口 {formatTokens(usage.limit)}</span></div><p className="composer-note context-threshold-note">折叠阈值: {formatTokens(foldThreshold(usage.limit))} ({FOLD_THRESHOLD_RATIO * 100}%)</p>{usage.parts.map(part => <div className="context-breakdown" key={part.name}><span><i style={{ background: part.color }} />{part.name}</span><strong>{formatTokens(part.tokens)}</strong><small>{(part.tokens / usage.total * 100).toFixed(1)}%</small></div>)}<p className="composer-note context-disclaimer">{usageNote}</p></div>}
      </section>}
    </Popup>
    <Popup open={!!suggestions.length} className="composer-popover popover-left composer-suggestions"><section aria-label={slash ? '输入指令' : '工作区文件'}><div className="suggestions-heading">{slash ? '输入指令' : '工作区文件'}<small>↑ ↓ 选择 · Tab / Enter 确认</small></div>{suggestions.map((item, index) => <button key={item.id} className={suggestionIndex % suggestions.length === index ? 'is-selected' : ''} onMouseEnter={() => setSuggestionIndex(index)} onClick={() => selectSuggestion(index)}>{slash ? <SquareTerminal size="1.0625rem" /> : <FileText size="1.0625rem" />}<span><strong>{item.label}<em>{item.title}</em></strong><small>{item.description}</small></span></button>)}</section></Popup>
    {dragging && <div className="composer-drop-hint"><Paperclip size="1.5rem" /><span>松开以添加附件</span></div>}
  </div>;
}
