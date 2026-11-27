import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Chip, Input, Switch, Textarea, Tooltip } from '@nextui-org/react';
import { ArrowLeft, ArrowUp, BookOpen, Cable, Check, ChevronRight, CircleHelp, FileText, FolderClosed, ListChecks, Paperclip, Pencil, Play, Plug, Plus, RefreshCw, Search, Settings2, ShieldAlert, ShieldCheck, Sparkles, Square, SquareTerminal, Trash2, X } from 'lucide-react';
import { acpSlashCommands, appendPreset, attachmentViews, estimateContext, formatTokenSpeed, formatTokens, getModelCatalog, initialPresets, localSlashCommands, mergeSlashCommands, presetPayload, presetsFromServer, serverSlashCommands, HistoryTokenEstimator } from '../composer';
import type { ComposerContext, ComposerOptions, LiveSpeed, PromptPreset, QueuedMessage, ServerCommand, ServerSkill, ServerPreset, SlashCommand } from '../composer';
import { contextFromUsage, contextPartPercent, FOLD_THRESHOLD_RATIO, foldThreshold, formatUsageCost, usagePath, type UsageDTO } from '../usage';
import { attachmentLimitReached, fileKind, extractDocumentText, formatFileSize, LARGE_PASTE_THRESHOLD_CHARS, MAX_DOC_FILE_SIZE, MAX_IMAGE_COUNT, MAX_TEXT_FILE_SIZE, MAX_UPLOAD_FILES } from '../documents';
import { useLocalState, type Provider } from '../lib';
import type { ConnectorSessionItem, ConnectorsList } from '../connectors';
import type { AcpCommand, AcpSessionState, AgentEngine, LoopraClient, Workspace } from '../backend';
import { Popup } from './Motion';
import PetCompanion from './PetCompanion';
import { petScale, type PetAnimation, type PetReply } from '../pets';
import type { PetStore } from '../usePets';
import ModelReasoningSelector from './ModelReasoningSelector';
import AgentConfigControls from './AgentConfigControls';
import AgentMcpControls from './AgentMcpControls';
import { agentOptionDescription, agentOptionLabel, configValue, findAgentOption, isDangerousAgentMode, type AgentConfigState } from '../agent-config';
import { useMenuPlacement } from '../layout/menu-placement';
import ComposerQueue from './ComposerQueue';
import { ConnectorIcon } from './ConnectorIcon';
import { clampComposerHeight, composerHeight, composerHeightCeiling, composerSessionKey, COMPOSER_HEIGHT_STEP_REM, FALLBACK_COMPOSER_FLOOR_REM, nudgeComposerHeight, resizeComposerHeight, storeComposerHeight } from '../composer-resize';

type Props = {
  loading?: boolean;
  agentId?: string;
  /** 会话绑定的自定义智能体名；提供时代替引擎名展示。 */
  agentName?: string;
  engines?: AgentEngine[];
  agentConfig?: AgentConfigState;
  acpCommands?: AcpCommand[];
  home: boolean; draft: string; onDraft: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>; options: ComposerOptions; onOptions: (value: ComposerOptions) => void | Promise<void>;
  skillOptions: { name: string; description: string }[]; systemPrompt: string; petEnabled: boolean; desktopPet?: boolean; pets: PetStore; petActivity: PetAnimation;
  petReply: PetReply | null; latestPetReply: string; onPetClose: () => void;
  context: ComposerContext; onContext: (value: ComposerContext) => void; providers: Provider[];
  workspaces: Workspace[]; connected: boolean;
  api: LoopraClient; workspaceHash: string;
  chatMode?: boolean;
  sessionName?: string;
  defaultModel: string; onDefaultModel: (id: string) => void; history: string[];
  busy: boolean; generating: boolean; onSend: () => void; onStop: () => void; onContinue: () => void;
  queue: QueuedMessage[]; onRemoveQueued: (id: string) => void; onGuideQueued: (id: string) => void;
  onEditQueued: (id: string) => boolean;
  onMoveQueued: (id: string, targetId: string) => void;
  remoteRunning: boolean; onStopRemote: () => void;
  liveSpeed?: LiveSpeed; usageRevision?: number;
  onNew: () => void; onTerminal: () => void; onManage: () => void; onOpen: () => void; notify: (text: string) => void;
  onExport: () => void; onSessions: () => void;
  onOpenConnectors?: () => void;
  onClear: () => void;
  /** Fires whenever the composer's height changes, so the chat pane can stay pinned. */
  onInputResize?: () => void;
};
type Menu = 'model-settings' | 'tools' | 'projects' | 'skills' | 'permission' | 'presets' | 'context' | 'more' | 'mcp' | 'connectors';

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Switch size="sm" aria-label={label} isSelected={value} onValueChange={onChange} classNames={{ label: 'sr-only' }}>{label}</Switch>;
}

function ComposerToolbarSkeleton({ showMcp }: { showMcp: boolean }) {
  const { t } = useTranslation();
  return <>
    <span className="sr-only" role="status">{t('composer.loadingToolbar')}</span>
    <div className="composer-left" aria-hidden="true"><span className="composer-skeleton skeleton-icon" /><span className="composer-skeleton skeleton-permission" /><span className="composer-skeleton skeleton-icon" /><span className="composer-skeleton skeleton-icon" />{showMcp && <span className="composer-skeleton skeleton-icon" />}</div>
    <div className="composer-right" aria-hidden="true"><span className="composer-skeleton skeleton-icon" /><span className="composer-skeleton skeleton-model" /><span className="composer-skeleton skeleton-send" /></div>
  </>;
}

export default function Composer(props: Props) {
  const { t } = useTranslation();
  const external = !!props.agentId && props.agentId !== 'native';
  const solonCode = props.agentId === 'soloncode';
  const { home, draft, onDraft, inputRef, options, onOptions, context, onContext, providers, notify, workspaces } = props;
  const chatMode = !!props.chatMode;
  const slash = draft.startsWith('/') && !draft.includes('\n') && !draft.includes(' ');
  const commandScope = JSON.stringify([props.agentId, props.workspaceHash, props.sessionName]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [query, setQuery] = useState('');
  const [presets, setPresets] = useLocalState<PromptPreset[]>('prompt-presets', initialPresets);
  const [editing, setEditing] = useState<PromptPreset | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [commandDiscovery, setCommandDiscovery] = useState<{ scope: string; api: LoopraClient; commands: AcpCommand[]; loading: boolean; error: string }>();
  const [commandRetry, setCommandRetry] = useState(0);
  const [remoteCommands, setRemoteCommands] = useState<ServerCommand[]>([]);
  const [remoteSkills, setRemoteSkills] = useState<ServerSkill[]>([]);
  const [remoteUsage, setRemoteUsage] = useState<UsageDTO | null>(null);
  // Character counts for large pastes saved to disk, keyed by the saved path.
  const [pasteChars, setPasteChars] = useState<Record<string, number>>({});
  const dragDepth = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Dragging the composer's top edge only grows it: the height the stylesheet
  // renders is the floor. The value is keyed per session (workspace/session) so a
  // reopened session returns at the size it was left; `dragHeight` is the live drag.
  const [inputHeights, setInputHeights] = useLocalState<Record<string, number>>('composer-heights', {});
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const inputResize = useRef<{ pointerId: number; startY: number; startRem: number; floorRem: number; height: number; handle: HTMLDivElement } | null>(null);
  const inputKey = composerSessionKey(props.workspaceHash, props.sessionName);
  const inputHeight = dragHeight ?? composerHeight(inputHeights, inputKey);
  const menuPlacement = useMenuPlacement(!!menu, root, { offsetRem: 4.375 });
  const suggestionPlacement = useMenuPlacement(!menu && (slash || /(?:^|\s)@[^\s]*$/.test(draft)), root);
  const menuPlacementStyle = {
    ...(menuPlacement.maxHeight ? { '--composer-popover-max-height': `${menuPlacement.maxHeight}px` } : {}),
    '--composer-suggestions-max-height': `${suggestionPlacement.maxHeight}px`,
  } as CSSProperties;
  const models = useMemo(() => getModelCatalog(providers), [providers]);
  const selected = models.find(model => model.id === options.modelId);
  const historyEstimator = useMemo(() => new HistoryTokenEstimator(), []);
  const historyTokens = useMemo(() => historyEstimator.estimate(props.history), [historyEstimator, props.history]);
  const localUsage = useMemo(() => estimateContext([], draft, context, selected?.contextTokens, props.systemPrompt, historyTokens), [historyTokens, draft, context, selected?.contextTokens, props.systemPrompt]);
  const usage = contextFromUsage(remoteUsage, external ? { ...localUsage, limit: 0, percent: 0, windowKnown: false } : localUsage);
  const usagePercent = usage.windowKnown === false ? '—' : `${usage.percent.toFixed(1)}%`;
  // ACP Agents report context usage but no cumulative token counters, so omit the
  // empty counter instead of printing "总 token 0" next to a real USD cost.
  const usageMetricsNote = usage.metrics
    ? [
        usage.metrics.promptTokens + usage.metrics.completionTokens > 0
          ? t('composer.totalTokens', { value: formatTokens(usage.metrics.promptTokens + usage.metrics.completionTokens) }) : '',
        usage.metrics.hasPrice ? t('composer.cost', { cost: formatUsageCost(usage.metrics.totalCost, usage.metrics.currency) }) : '',
        usage.metrics.cacheHitRate != null ? t('composer.cacheHitRate', { rate: usage.metrics.cacheHitRate.toFixed(1) }) : '',
      ].filter(Boolean).join(' · ')
    : '';
  // ACP owns the per-session choices. Its standard categories map onto the
  // composer's existing permission, model and reasoning controls, so Native and
  // external engines look and behave the same; only the advertised values differ.
  const agentOptions = props.agentConfig?.options;
  const agentMode = findAgentOption(agentOptions, 'mode', 'mode');
  const agentModel = findAgentOption(agentOptions, 'model', 'model');
  const agentEffort = findAgentOption(agentOptions, 'effort', 'thought_level');
  const agentFast = findAgentOption(agentOptions, 'fast', 'model_config');
  const agentPlan = external ? findAgentOption(agentOptions, 'plan') || findAgentOption(agentOptions, 'collaboration_mode', 'collaboration_mode') : undefined;
  const planOn = agentPlan?.id === 'collaboration_mode' ? 'plan' : 'on';
  const planOff = agentPlan?.id === 'collaboration_mode' ? 'default' : 'off';
  const agentFusion = external ? undefined : findAgentOption(agentOptions, 'fusionSidekick');
  const agentFusionEffort = external ? undefined : findAgentOption(agentOptions, 'fusionSidekickEffort');
  const agentBusy = !!props.agentConfig?.busy;
  const initialConfigLoading = !!props.loading || (agentBusy && !props.agentConfig?.error && !agentOptions?.length && !props.generating && !props.remoteRunning);
  const sendDisabled = agentBusy || (!draft.trim() && !context.files.length) || (!props.agentConfig && !external && !selected) || (!props.generating && !props.remoteRunning && props.busy);
  function runSolonCodeAction(id: '/clear' | '/interrupt') {
    if (id === '/clear') {
      if (props.generating || props.remoteRunning) { notify(t('composer.solonCode.clearBusy')); return; }
      onDraft('');
      props.onClear();
      return;
    }
    onDraft('');
    if (props.generating) props.onStop();
    else if (props.remoteRunning) props.onStopRemote();
    else notify(t('composer.solonCode.noActiveRun'));
  }
  function sendDraft() {
    const command = draft.trim().toLowerCase();
    if (solonCode && !context.files.length && !context.attachments?.length && (command === '/clear' || command === '/interrupt')) {
      runSolonCodeAction(command);
      return;
    }
    if (!sendDisabled) props.onSend();
  }
  const agentEngineName = props.agentName || props.engines?.find(engine => engine.id === (props.agentId || 'native'))?.name || (external ? props.agentId || 'Agent' : 'Loopra Native');
  const handledOptions = new Set([agentMode, agentModel, agentEffort, agentFast, agentPlan, agentFusion, agentFusionEffort].filter(Boolean).map(option => option!.id));
  const otherAgentOptions = (agentOptions || []).filter(option => !handledOptions.has(option.id));
  const agentModeValue = agentMode ? configValue(agentMode) : '';
  const planActive = !!agentPlan && configValue(agentPlan) === planOn;
  const update = <K extends keyof ComposerOptions>(key: K, value: ComposerOptions[K]) => onOptions({ ...options, [key]: value });
  const changeAgent = (id: string, value: string | boolean) => props.agentConfig?.onChange(id, value);
  const localizedNativePermission = (value: { value: string; name: string; description?: string }) => !external ? ({
    approval: { name: t('composer.permissionApproval'), description: t('composer.permissionApprovalDescription') },
    auto: { name: t('composer.permissionAuto'), description: t('composer.permissionAutoDescription') },
    free: { name: t('composer.permissionFree'), description: t('composer.permissionFreeDescription') },
  })[value.value] || null : null;
  const localizedPermissionMode = (mode: string) => mode === '完全自动' ? t('composer.permissionFree') : mode === '按需审批' ? t('composer.permissionApproval') : mode === '自动审批' ? t('composer.permissionAuto') : mode;
  const localizedUsagePart = (name: string) => ({
    '系统指令': t('usage.part.system'), '工具定义': t('usage.part.tools'), '用户消息': t('usage.part.user'), '助手消息': t('usage.part.assistant'),
    '工具结果': t('usage.part.result'), '会话上下文': t('usage.part.context'), '会话历史': t('usage.part.history'), '当前输入': t('usage.part.input'), '附加上下文': t('usage.part.attachments'),
  })[name] || name;

  function close() { setMenu(null); setEditing(null); }
  function open(next: Menu) {
    props.onOpen(); setMenu(current => current === next ? null : next); setQuery(''); setEditing(null);
    setDismissedDraft(draft);
  }
  function focusInput() { requestAnimationFrame(() => inputRef.current?.focus()); }
  function rootRem() { return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16; }
  /**
   * The floor is the card's shipped default height, read from its computed
   * `min-height` (always px in a browser) so a stored height — which only ever
   * sets `height` — cannot raise or lower its own floor. Home, session and
   * narrow-window layouts each ship a different default.
   */
  function floorHeight() {
    const element = root.current;
    if (!element) return FALLBACK_COMPOSER_FLOOR_REM;
    const minHeight = parseFloat(window.getComputedStyle(element).minHeight);
    const minRem = Number.isFinite(minHeight) && minHeight > 0 ? minHeight / rootRem() : FALLBACK_COMPOSER_FLOOR_REM;
    // Without a stored height the rendered card *is* the default: chips, a queue
    // row or a narrow-window rule can make it taller than min-height, and
    // dragging back down has to stop there instead of shrinking past it.
    if (inputHeight > 0) return minRem;
    const rendered = element.getBoundingClientRect().height / rootRem();
    return Number.isFinite(rendered) ? Math.max(minRem, rendered) : minRem;
  }
  function ceilingHeight() { return composerHeightCeiling(window.innerHeight, rootRem(), floorHeight()); }
  /**
   * The height the card shows now: the stored/dragged value, else whatever the
   * card currently renders — chips or a queue row can exceed `min-height`, and
   * a drag must pick up from there instead of jumping down. A height stored on a
   * taller window is capped by the current one.
   */
  function currentInputHeight() {
    const ceiling = ceilingHeight();
    if (inputHeight > 0) return Math.min(inputHeight, ceiling);
    const element = root.current;
    const rendered = element ? element.getBoundingClientRect().height / rootRem() : 0;
    return clampComposerHeight(Math.max(floorHeight(), Number.isFinite(rendered) ? rendered : 0), floorHeight(), ceiling);
  }
  /** A height back at the default clears the entry instead of pinning it. */
  function saveInputHeight(heightRem: number, floorRem: number) {
    setInputHeights(current => storeComposerHeight(current, inputKey, heightRem > floorRem + 0.01 ? heightRem : 0));
  }
  function stopInputResize() {
    const drag = inputResize.current;
    inputResize.current = null;
    // Pointer capture is unsupported in jsdom and in older WebViews.
    if (drag && drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  }
  function startInputResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || inputResize.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startRem = currentInputHeight();
    // The floor is captured now: while the drag runs the card is resized, so its
    // rendered height no longer describes the default.
    inputResize.current = { pointerId: event.pointerId, startY: event.clientY, startRem, floorRem: floorHeight(), height: startRem, handle };
    // Pointer capture keeps the drag alive when the pointer leaves the handle,
    // but jsdom and older WebViews do not implement it.
    handle.setPointerCapture?.(event.pointerId);
    setDragHeight(startRem);
  }
  function moveInputResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = inputResize.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.height = resizeComposerHeight(drag.startRem, event.clientY - drag.startY, rootRem(), drag.floorRem, ceilingHeight());
    setDragHeight(drag.height);
  }
  function endInputResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = inputResize.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    stopInputResize();
    setDragHeight(null);
    // Persist once, on release: a drag would otherwise write localStorage per move.
    saveInputHeight(drag.height, drag.floorRem);
  }
  /** Arrow keys step by a rem; Escape/Home and a double-click restore the default. */
  function nudgeInputHeight(deltaRem: number) {
    const floorRem = floorHeight();
    const next = nudgeComposerHeight(currentInputHeight(), deltaRem, floorRem, ceilingHeight());
    setDragHeight(null);
    saveInputHeight(next, floorRem);
  }
  function resetInputHeight() {
    setDragHeight(null);
    setInputHeights(current => storeComposerHeight(current, inputKey, 0));
  }
  // Alt-tabbing or opening a native dialog drops the pointer-up event; without
  // this the composer would keep following the pointer with no button held.
  useEffect(() => {
    const cancel = () => { stopInputResize(); setDragHeight(null); };
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); stopInputResize(); };
  }, []);
  // The transcript above shares the pane with the composer, so every height
  // change moves it. Let the owner keep the chat pinned while the drag runs —
  // but only inside one session: opening another session swaps in its own stored
  // height, and that must not steal the restored scroll position.
  const onInputResize = useRef(props.onInputResize);
  onInputResize.current = props.onInputResize;
  const lastComposerSize = useRef({ key: inputKey, height: inputHeight });
  useEffect(() => {
    const previous = lastComposerSize.current;
    lastComposerSize.current = { key: inputKey, height: inputHeight };
    if (previous.key === inputKey && previous.height !== inputHeight) onInputResize.current?.();
  }, [inputKey, inputHeight]);
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
    if (external || chatMode || !props.workspaceHash || text.length <= LARGE_PASTE_THRESHOLD_CHARS) return;
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
  // Native commands and skills must not leak into an external Agent's menu.
  useEffect(() => {
    const controller = new AbortController();
    setRemoteCommands([]); setRemoteSkills([]);
    if (external || !props.connected) return () => controller.abort();
    void props.api.request<ServerCommand[]>('/agent/commands', 'GET', undefined, controller.signal)
      .then(list => { if (!controller.signal.aborted && Array.isArray(list)) setRemoteCommands(list); }).catch(() => {});
    void props.api.request<ServerSkill[]>('/agent/skills', 'GET', undefined, controller.signal)
      .then(list => { if (!controller.signal.aborted && Array.isArray(list)) setRemoteSkills(list); }).catch(() => {});
    return () => controller.abort();
  }, [props.api, external, chatMode, props.connected]);
  useEffect(() => { close(); setFileSuggestions([]); }, [props.workspaceHash, props.agentId, chatMode]);
  const commandMenuOpen = slash && !menu && dismissedDraft !== draft;
  useEffect(() => {
    const controller = new AbortController();
    if (!external || !props.workspaceHash || !props.sessionName) { setCommandDiscovery(undefined); return () => controller.abort(); }
    setCommandDiscovery(current => ({
      scope: commandScope, api: props.api,
      commands: current?.scope === commandScope && current.api === props.api ? current.commands : [],
      loading: true, error: '',
    }));
    const suffix = new URLSearchParams({ workspaceHash: props.workspaceHash, sessionName: props.sessionName });
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryDelays = [250, 750];
    const read = (attempt: number) => {
      void props.api.request<AcpSessionState>(`/agent/acp-state?${suffix}`, 'GET', undefined, controller.signal)
        .then(state => {
          if (controller.signal.aborted) return;
          const commands = state.commands || [];
          setCommandDiscovery({ scope: commandScope, api: props.api, commands, loading: false, error: '' });
          const delay = retryDelays[attempt];
          if (!commands.length && commandMenuOpen && delay !== undefined) {
            retryTimer = setTimeout(() => read(attempt + 1), delay);
          }
        }).catch(() => {
          if (!controller.signal.aborted) setCommandDiscovery(current => current && { ...current, loading: false, error: t('composer.readAgentCommandsFailed') });
        });
    };
    read(0);
    return () => { clearTimeout(retryTimer); controller.abort(); };
  }, [props.api, external, commandScope, props.workspaceHash, props.sessionName, props.agentConfig?.options, props.generating, commandMenuOpen, commandRetry]);
  // Prompt presets are server-side config; the local cache is only a fallback.
  useEffect(() => {
    if (!props.connected) return;
    const controller = new AbortController();
    void props.api.request<ServerPreset[]>('/prompt-presets', 'GET', undefined, controller.signal)
      .then(list => { if (!controller.signal.aborted && Array.isArray(list)) setPresets(presetsFromServer(list)); }).catch(() => {});
    return () => controller.abort();
  }, [props.api, setPresets, props.connected]);
  function persistPresets(next: PromptPreset[]) {
    void props.api.request('/prompt-presets', 'PUT', presetPayload(next))
      .catch((error: unknown) => notify(`常用要求同步失败：${error instanceof Error ? error.message : String(error)}`));
  }
  useEffect(() => { setRemoteUsage(null); }, [props.api, props.workspaceHash, props.sessionName, props.agentId]);
  // 会话连接器开关：已有会话读服务端覆盖，新会话先保存在输入上下文随首条消息提交。
  const [sessionConnectors, setSessionConnectors] = useState<ConnectorSessionItem[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setSessionConnectors([]);
    if (external || chatMode || !props.connected) return () => controller.abort();
    const request = props.sessionName
      ? props.api.request<ConnectorSessionItem[]>(`/connectors/session?${new URLSearchParams({ sessionName: props.sessionName, workspaceHash: props.workspaceHash })}`, 'GET', undefined, controller.signal)
      : props.api.request<ConnectorsList>(`/connectors?${new URLSearchParams({ workspaceHash: props.workspaceHash })}`, 'GET', undefined, controller.signal)
          .then(list => (list.connectors || []).filter(item => item.status === 'connected').map(item => ({ id: item.id, name: item.name, icon: item.icon, enabled: item.allowed === false ? false : item.enabled, allowed: item.allowed })));
    void request.then(list => { if (!controller.signal.aborted) setSessionConnectors(list); }).catch(() => {});
    return () => controller.abort();
  }, [props.api, props.sessionName, props.workspaceHash, props.connected, external, chatMode, menu]);
  const connectorOverrides = context.connectors || {};
  const connectorEnabled = (item: ConnectorSessionItem) => props.sessionName ? item.enabled : (connectorOverrides[item.id] ?? item.enabled);
  const connectorEnabledCount = sessionConnectors.filter(connectorEnabled).length;
  async function toggleConnector(id: string, enabled: boolean) {
    if (!props.sessionName) { onContext({ ...context, connectors: { ...connectorOverrides, [id]: enabled } }); return; }
    const previous = sessionConnectors;
    setSessionConnectors(list => list.map(item => item.id === id ? { ...item, enabled, override: enabled } : item));
    try { await props.api.request('/connectors/session', 'PUT', { sessionName: props.sessionName, workspaceHash: props.workspaceHash, id, enabled }); }
    catch (cause) { setSessionConnectors(previous); notify(`连接器设置失败：${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  // A completed Native model call refreshes the persisted usage immediately.
  // Keep the debounced refresh for session/history changes and the final snapshot.
  useEffect(() => {
    if (!props.workspaceHash || !props.sessionName) { setRemoteUsage(null); return; }
    const controller = new AbortController();
    const path = usagePath(props.workspaceHash, props.sessionName);
    const refresh = () => {
      void props.api.request<UsageDTO>(path, 'GET', undefined, controller.signal)
        .then(data => { if (!controller.signal.aborted) setRemoteUsage(data); })
        .catch(() => { /* Keep the last snapshot for this session on a transient failure. */ });
    };
    const timer = props.usageRevision === undefined ? setTimeout(refresh, 400) : undefined;
    if (timer === undefined) refresh();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [props.api, props.workspaceHash, props.sessionName, props.agentId, props.agentConfig?.options, props.history.length, props.generating, props.usageRevision]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (!menu || menu === 'model-settings') return;
      const target = event.target as Node;
      const panel = root.current?.querySelector('.composer-popover:not(.composer-suggestions)');
      const trigger = root.current?.querySelector('.composer-bottom button[aria-expanded="true"]');
      if (!panel?.contains(target) && !trigger?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); setDismissedDraft(draft); if (root.current?.contains(document.activeElement)) focusInput(); }
    };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', escape); };
  }, [draft, menu]);

  const localizedSlashCommand = (command: (ReturnType<typeof localSlashCommands>)[number]) => {
    const key = command.id.slice(1);
    return {
      ...command,
      title: t(`composer.command.${key}.title`),
      description: command.id === '/continue'
        ? (props.history.length ? t('composer.command.continue.description') : t('composer.command.continue.disabled'))
        : t(`composer.command.${key}.description`),
    };
  };
  const localCommands = localSlashCommands({
    onNew: props.onNew,
    onContinue: props.onContinue,
    onSkills: () => open('skills'),
    onHelp: () => notify(chatMode ? t('composer.helpChat') : t('composer.helpWorkspace')),
    onExport: props.onExport,
    onSessions: props.onSessions,
    onTerminal: props.onTerminal,
    onClear: props.onClear,
    hasHistory: !!props.history.length, busy: props.busy, notify: message => notify(message === '请先开始会话' ? t('composer.command.continue.requiresSession') : message),
  }).filter(command => !external || command.id !== '/skills')
    .map(command => ({ ...localizedSlashCommand(command),
      ...(chatMode && command.id === '/help' ? { description: t('composer.helpChatShort') } : {}),
      action: () => { onDraft(''); command.action?.(); } }));
  // Server commands/skills insert their text so the agent handles them.
  const discovered = commandDiscovery?.scope === commandScope && commandDiscovery.api === props.api ? commandDiscovery : undefined;
  const agentCommands = (props.generating ? props.acpCommands : undefined) ?? discovered?.commands ?? [];
  const chatCommands = new Set(['/help', '/compact', '/continue', '/agree', '/deny']);
  const remoteSlash = (external ? acpSlashCommands(agentCommands) : serverSlashCommands(
    chatMode ? remoteCommands.filter(command => chatCommands.has(command.cmd)) : remoteCommands, remoteSkills))
    .map(command => ({ ...command, title: external ? agentEngineName : command.title, description: command.description === '运行技能' ? t('composer.runSkill') : command.description, action: () => { onDraft(command.insert || `${command.id} `); close(); focusInput(); } }));
  // SolonCode 的别名由客户端拥有：清空、停止与排队都映射到工作台已有操作，不发给 Agent。
  const solonCodeCommands: SlashCommand[] = solonCode ? [
    { id: '/clear', title: t('composer.command.clear.title'), description: t('composer.command.clear.description'), action: () => runSolonCodeAction('/clear') },
    { id: '/interrupt', title: t('composer.stopGeneration'), description: t('composer.solonCode.interruptDescription'), action: () => runSolonCodeAction('/interrupt') },
    { id: '/queue', title: t('composer.queueMessage'), description: t('composer.solonCode.queueDescription'), action: () => { onDraft('/queue '); close(); focusInput(); } },
  ] : [];
  const commands = mergeSlashCommands(external ? solonCodeCommands : localCommands, remoteSlash);
  const mention = chatMode ? null : draft.match(/(?:^|\s)@([^\s]*)$/);
  const mentionQuery = mention?.[1];
  useEffect(() => {
    if (chatMode || mentionQuery === undefined || !props.workspaceHash) { setFileSuggestions([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void props.api.request<{ path: string }[]>(`/files/search?workspaceHash=${encodeURIComponent(props.workspaceHash)}&query=${encodeURIComponent(mentionQuery)}`, 'GET', undefined, controller.signal).then(files => { if (!controller.signal.aborted) setFileSuggestions(files.map(file => file.path)); }).catch(() => { if (!controller.signal.aborted) setFileSuggestions([]); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [chatMode, mentionQuery, props.api, props.workspaceHash]);
  const suggestions = menu || dismissedDraft === draft ? [] : slash
    ? commands.filter(command => command.id.includes(draft.toLowerCase())).map(command => ({ ...command, label: command.id }))
    : mention ? fileSuggestions.map(name => ({
      id: name, label: name, title: t('composer.referenceFile'), description: t('composer.referenceFileDescription'), action: () => {
        onContext({ ...context, files: [...new Set([...context.files, name])] });
        onDraft(draft.slice(0, draft.length - mention[1].length - 1));
      },
    })) : [];
  const showCommandStatus = external && commandMenuOpen && !suggestions.length;
  const commandStatus = !props.sessionName ? (agentBusy ? t('composer.preparingAgentCommands') : t('composer.connectAgentCommands'))
    : discovered?.loading ? t('composer.loadingAgentCommands')
    : discovered?.error || (agentCommands.length ? t('composer.noMatchingAgentCommands') : t('composer.noAgentCommands'));
  useEffect(() => {
    root.current?.querySelector('.composer-suggestions .is-selected')?.scrollIntoView?.({ block: 'nearest' });
  }, [suggestionIndex, draft]);
  function selectSuggestion(index: number) { suggestions[index]?.action?.(); setSuggestionIndex(0); if (suggestions[index]?.id !== '/skills') focusInput(); }
  function savePreset() {
    if (!editing?.name.trim() || !editing.text.trim()) return;
    const item = { ...editing, name: editing.name.trim(), text: editing.text.trim() };
    const next = presets.some(preset => preset.id === item.id) ? presets.map(preset => preset.id === item.id ? item : preset) : [...presets, item];
    setPresets(next); persistPresets(next);
    setEditing(null); notify('常用要求已保存');
  }
  const menuTitles: Record<Menu, string> = { 'model-settings': t('composer.menu.modelSettings'), tools: t('composer.menu.tools'), projects: t('composer.menu.projects'), skills: t('composer.menu.skills'), permission: t('composer.menu.permission'), presets: t('composer.menu.presets'), context: t('composer.menu.context'), more: t('composer.menu.more'), mcp: t('composer.menu.mcp'), connectors: t('composer.menu.connectors') };
  // Legacy ChatInput split context into image thumbnails and file chips with sizes.
  const { images: contextImages, files: contextFiles } = attachmentViews(context, pasteChars);
  const removeAttachment = (name: string) => onContext({ ...context, files: context.files.filter(item => item !== name), attachments: context.attachments?.filter(file => file.name !== name) });
  const hasContext = contextImages.length > 0 || context.projects.length > 0 || context.skills.length > 0 || contextFiles.length > 0;

  return <>
    <ComposerQueue key={`${props.workspaceHash}/${props.sessionName || ''}`} queue={props.queue} onRemove={props.onRemoveQueued} onGuide={props.onGuideQueued}
      onEdit={id => { if (props.onEditQueued(id)) { close(); focusInput(); } }} onMove={props.onMoveQueued} />
    <div ref={root} data-popover data-placement={menuPlacement.side} data-suggestions-placement={suggestionPlacement.side}
    style={inputHeight > 0 ? { ...menuPlacementStyle, '--composer-height': `${inputHeight}rem` } as CSSProperties : menuPlacementStyle}
    className={`composer rich-composer ${home ? 'welcome-composer' : ''} ${dragging ? 'is-dragging' : ''} ${inputHeight > 0 ? 'is-resized' : ''} ${dragHeight !== null ? 'is-resizing' : ''}`}
    onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); addFiles(event.dataTransfer.files); }}>
    <div className="composer-resize-handle" role="separator" aria-orientation="horizontal" tabIndex={0}
      aria-label={t('composer.resizeInput')} aria-valuenow={inputHeight > 0 ? Math.round(inputHeight * 10) / 10 : undefined} title={t('composer.resizeInputTitle')}
      onPointerDown={startInputResize} onPointerMove={moveInputResize} onPointerUp={endInputResize} onPointerCancel={endInputResize} onLostPointerCapture={endInputResize}
      onDoubleClick={resetInputHeight}
      onKeyDown={event => {
        if (event.key === 'ArrowUp') { event.preventDefault(); nudgeInputHeight(COMPOSER_HEIGHT_STEP_REM); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); nudgeInputHeight(-COMPOSER_HEIGHT_STEP_REM); }
        else if (event.key === 'Home' || event.key === 'Escape') { event.preventDefault(); resetInputHeight(); }
      }} />
    {props.petEnabled && props.pets.active && !props.desktopPet && <PetCompanion key={props.pets.active.name} src={props.pets.imageUrl} name={props.pets.active.displayName || props.pets.active.name} scale={petScale(props.pets.active)} position={props.pets.active.position}
      activity={props.petActivity} reply={props.petReply} latestReply={props.latestPetReply} hidden={!!menu || !!suggestions.length} onMove={props.pets.move} onResize={props.pets.resize} onClose={props.onPetClose} onError={props.notify} />}
    <div className="composer-context-chips">
      {contextImages.map(image => <div className="composer-image-thumb" key={`image:${image.name}`} title={image.name}>
        <img className="composer-image-preview" src={image.src} alt={image.name} />
        <button type="button" className="composer-image-remove" aria-label={t('composer.removeImage', { name: image.name })} title={t('composer.removeImageShort')} onClick={() => removeAttachment(image.name)}><X size="0.75rem" /></button>
      </div>)}
      {(['projects', 'skills'] as const).filter(key => !chatMode || key === 'skills').flatMap(key => context[key].map(name => <Chip size="sm" variant="flat" key={`${key}:${name}`} classNames={{ base: `context-chip chip-${key}` }}
        startContent={key === 'projects' ? <FolderClosed size="0.8125rem" /> : <Sparkles size="0.8125rem" />}
        endContent={<button className="context-chip-remove" aria-label={key === 'projects' ? t('composer.removeProject', { name }) : t('composer.removeSkill', { name })} onClick={() => onContext({ ...context, [key]: context[key].filter(item => item !== name) })}><X size="0.75rem" /></button>}>{name}</Chip>))}
      {contextFiles.map(file => <Chip size="sm" variant="flat" key={`files:${file.name}`} classNames={{ base: 'context-chip chip-files' }}
        startContent={<Paperclip size="0.8125rem" />}
        endContent={<button className="context-chip-remove" aria-label={t('composer.removeAttachment', { name: file.name })} onClick={() => removeAttachment(file.name)}><X size="0.75rem" /></button>}>
        {file.name}{file.chars != null ? <small className="context-chip-size">{t('composer.characters', { value: file.chars.toLocaleString() })}</small> : file.size != null ? <small className="context-chip-size">{formatFileSize(file.size)}</small> : null}
      </Chip>)}
      {planActive && agentPlan && <Chip size="sm" variant="flat" color="primary" startContent={<ListChecks size="0.8125rem" />} endContent={<button className="context-chip-remove" aria-label={t('composer.exitPlanMode')} disabled={agentBusy} onClick={() => changeAgent(agentPlan.id, planOff)}><X size="0.75rem" /></button>}>{t('composer.planMode')}</Chip>}
      {hasContext && <button type="button" className="context-clear-all" onClick={() => onContext({ ...context, projects: [], skills: [], files: [], attachments: [] })}>{t('composer.clearAll')}</button>}
    </div>
    <textarea ref={inputRef} aria-label={t('composer.inputMessage')} placeholder={chatMode ? t('composer.placeholderChat') : t('composer.placeholderWorkspace')} value={draft}
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
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendDraft(); }
      }} />
    <div className={`composer-bottom${initialConfigLoading ? ' composer-toolbar-loading' : ''}`} aria-busy={initialConfigLoading || undefined}>
      {initialConfigLoading ? <ComposerToolbarSkeleton showMcp={!chatMode} /> : <>
      <div className="composer-left">
        <Tooltip content={t('composer.attachmentsProjectsTools')} delay={600}><Button isIconOnly variant="light" aria-label={t('composer.addAttachmentOrTool')} aria-expanded={menu === 'tools'} className={`composer-icon ${menu === 'tools' ? 'is-active' : ''}`} onPress={() => open('tools')}><Plus size="1.125rem" strokeWidth={1.75} /></Button></Tooltip>
        {agentMode ? <Tooltip content={agentOptionDescription(agentMode)} delay={600}><Button isDisabled={agentBusy} variant="light" className={`composer-permission ${isDangerousAgentMode(agentMode) ? 'automatic' : ''}`} onPress={() => open('permission')} aria-expanded={menu === 'permission'}>
          {isDangerousAgentMode(agentMode) ? <ShieldAlert size="0.9375rem" /> : <ShieldCheck size="0.9375rem" />}<span>{localizedNativePermission({ value: agentModeValue, name: agentOptionLabel(agentMode) })?.name || agentOptionLabel(agentMode)}</span>
        </Button></Tooltip> : !props.agentConfig && <Button isDisabled={external} variant="light" className={`composer-permission ${!external && options.mode === '完全自动' ? 'automatic' : ''}`} onPress={() => open('permission')} aria-expanded={menu === 'permission'}>
          {!external && options.mode === '完全自动' ? <ShieldAlert size="0.9375rem" /> : <ShieldCheck size="0.9375rem" />}<span>{external ? t('composer.agentApproval') : localizedPermissionMode(options.mode)}</span>
        </Button>}
        <Tooltip content={t('composer.presets')} delay={600}><Button isIconOnly variant="light" className={`composer-icon ${menu === 'presets' ? 'is-active' : ''}`} aria-label={t('composer.presets')} aria-expanded={menu === 'presets'} onPress={() => open('presets')}><BookOpen size="1rem" /></Button></Tooltip>
        {props.history.length > 0 && <Tooltip content={draft.trim() ? t('composer.clearDraftFirst') : t('composer.continueGeneration')} delay={600}><Button isIconOnly variant="light" className="composer-icon continue-button" aria-label={t('composer.continueGeneration')} isDisabled={agentBusy || props.busy || !!draft.trim()} onPress={props.onContinue}><Play size="1rem" /></Button></Tooltip>}
        {!chatMode && <Tooltip content={t('composer.manageMcp')} delay={600}><Button isIconOnly variant="light" className={`composer-icon ${menu === 'mcp' ? 'is-active' : ''}`} aria-label={t('composer.manageMcpAria')} aria-expanded={menu === 'mcp'} onPress={() => open('mcp')}><Plug size="1rem" /></Button></Tooltip>}
      </div>
      <div className={`composer-right ${agentOptions ? 'has-agent-config' : ''}`}>
        <Tooltip content={t('composer.contextUsage', { percent: usagePercent })} delay={600}><Button isIconOnly variant="light" aria-label={t('composer.viewContextUsage')} aria-expanded={menu === 'context'} className="composer-icon usage-button" onPress={() => open('context')}><span className="usage-ring" style={{ '--usage': `${usage.windowKnown === false ? 0 : Math.max(usage.percent, 4)}%` } as CSSProperties} /></Button></Tooltip>
        {agentOptions && otherAgentOptions.length > 0 && <Tooltip content={t('composer.moreAgentConfig')} delay={600}><Button isIconOnly variant="light" className={`composer-icon ${menu === 'more' ? 'is-active' : ''}`} aria-label={t('composer.moreAgentConfig')} aria-expanded={menu === 'more'} onPress={() => open('more')}><Settings2 size="1rem" /></Button></Tooltip>}
        <ModelReasoningSelector open={menu === 'model-settings'} onOpenChange={() => open('model-settings')} onClose={close} onSelected={focusInput}
          models={models} options={options} onOptions={onOptions} agentConfig={props.agentConfig} agentId={props.agentId} external={external} agentEngineName={agentEngineName}
          busy={props.busy} connected={props.connected} chatMode={chatMode} defaultModel={props.defaultModel} onDefaultModel={props.onDefaultModel} onManage={props.onManage} notify={notify} />
        {props.agentConfig?.error && <Tooltip content={props.agentConfig.error} delay={300}><Button isIconOnly size="sm" variant="light" className="composer-icon" onPress={props.agentConfig.onPrepare} aria-label={t('composer.retryAgentConfig')}><RefreshCw size="1rem" /></Button></Tooltip>}
        {props.generating ? <Button isIconOnly aria-label={t('composer.stopGeneration')} className="send-button generating" onPress={props.onStop}><Square size="0.75rem" fill="currentColor" /></Button>
          : props.remoteRunning ? <Button isIconOnly aria-label={t('composer.stopBackgroundTask')} className="send-button generating" onPress={props.onStopRemote}><Square size="0.75rem" fill="currentColor" /></Button> : null}
        <Button isIconOnly aria-label={props.generating || props.remoteRunning ? t('composer.queueMessage') : t('composer.sendMessage')} className={`send-button ${props.generating || props.remoteRunning ? 'queueing' : ''}`} isDisabled={sendDisabled} onPress={sendDraft}><ArrowUp key={props.generating || props.remoteRunning ? 'queued' : 'send'} size="1rem" strokeWidth={2.25} /></Button>
      </div>
      </>}
    </div>
    <input ref={fileInput} type="file" multiple hidden accept="image/*,.pdf,.docx,.xlsx,.txt,.md,.markdown,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.php,.sh,.bat,.ps1,.sql,.html,.htm,.css,.scss,.less,.xml,.yaml,.yml,.toml,.ini,.properties,.cfg,.conf,.env,.vue,.svelte" onChange={event => { addFiles(event.target.files || []); event.target.value = ''; close(); focusInput(); }} />

    <Popup open={!!menu && menu !== 'model-settings'} className={`composer-popover ${['tools', 'projects', 'skills', 'permission', 'presets', 'mcp', 'connectors'].includes(menu || '') ? 'popover-left' : 'popover-right'} popover-${menu}`}>
      {menu && <section role="dialog" aria-label={menuTitles[menu]}>
        <div className="composer-popover-header">
          <div>{['projects', 'skills', 'permission', 'connectors'].includes(menu) && <Button isIconOnly size="sm" variant="light" aria-label={t('composer.backToInputTools')} onPress={() => open('tools')}><ArrowLeft size="1rem" /></Button>}<strong>{menuTitles[menu]}</strong></div>
          <Button isIconOnly size="sm" variant="light" aria-label={t('composer.closeInputPopup')} onPress={() => { close(); focusInput(); }}><X size="1rem" /></Button>
        </div>

        {menu === 'tools' && <div className="composer-tool-list">
          <button onClick={() => fileInput.current?.click()}><Paperclip size="1.125rem" /><span><strong>{t('composer.uploadFile')}</strong><small>{t('composer.uploadFileDescription')}</small></span><Plus size="0.9375rem" /></button>
          {!chatMode && agentPlan && <div className="composer-tool-plan"><ListChecks size="1.125rem" /><span><strong>{t('composer.planMode')}</strong><small>{t('composer.planModeDescription')}</small></span><Toggle label={t('composer.planMode')} value={planActive} onChange={value => changeAgent(agentPlan.id, value ? planOn : planOff)} /></div>}
          {!chatMode && <button onClick={() => open('projects')}><FolderClosed size="1.125rem" /><span><strong>{t('composer.menu.projects')}</strong><small>{t('composer.projectsDescription')}</small></span>{!!context.projects.length && <em>{context.projects.length}</em>}<ChevronRight size="0.9375rem" /></button>}
          {!external && <button onClick={() => open('skills')}><Sparkles size="1.125rem" /><span><strong>{t('composer.skills')}</strong><small>{t('composer.skillsDescription')}</small></span>{!!context.skills.length && <em>{context.skills.length}</em>}<ChevronRight size="0.9375rem" /></button>}
          {!external && <button onClick={() => open('connectors')}><Cable size="1.125rem" /><span><strong>{t('composer.connectors')}</strong><small>{t('composer.connectorsDescription')}</small></span>{!!connectorEnabledCount && <em>{connectorEnabledCount}</em>}<ChevronRight size="0.9375rem" /></button>}
          {agentMode ? <button onClick={() => open('permission')}><ShieldCheck size="1.125rem" /><span><strong>{t('composer.permissionMode')}</strong><small>{localizedNativePermission({ value: agentModeValue, name: agentOptionLabel(agentMode) })?.name || agentOptionLabel(agentMode)}</small></span><ChevronRight size="0.9375rem" /></button>
            : !external && !props.agentConfig && <button onClick={() => open('permission')}><ShieldCheck size="1.125rem" /><span><strong>{t('composer.permissionMode')}</strong><small>{localizedPermissionMode(options.mode)}</small></span><ChevronRight size="0.9375rem" /></button>}
          <div className="composer-menu-divider" />
          <button onClick={() => { close(); props.onTerminal(); }}><SquareTerminal size="1.0625rem" /><span>{t('composer.openTerminal')}</span><ChevronRight size="0.9375rem" /></button>
          <button onClick={() => { onDraft('/'); close(); setDismissedDraft(null); focusInput(); }}><CircleHelp size="1.0625rem" /><span>{t('composer.viewInputCommands')}</span><span className="keycap">/</span></button>
        </div>}

        {(menu === 'projects' || menu === 'skills') && <>
          <div className="popover-search"><Input autoFocus size="sm" variant="bordered" aria-label={menu === 'projects' ? t('composer.searchProjects') : t('composer.searchSkills')} placeholder={menu === 'projects' ? t('composer.searchProjectsPlaceholder') : t('composer.searchSkillsPlaceholder')} value={query} onValueChange={setQuery} startContent={<Search size="0.9375rem" />} /></div>
          <div className="composer-selection-list">
            {(menu === 'projects' ? workspaces.map(item => ({ name: item.name, description: item.path })) : props.skillOptions).filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())).map(item => <button key={item.name} role="checkbox" aria-checked={context[menu].includes(item.name)} onClick={() => toggleContext(menu, item.name)}>
              {menu === 'projects' ? <FolderClosed size="1.125rem" /> : <Sparkles size="1.125rem" />}<span><strong>{item.name}</strong><small>{item.description}</small></span><span className={`composer-checkbox ${context[menu].includes(item.name) ? 'checked' : ''}`}>{context[menu].includes(item.name) && <Check size="0.75rem" />}</span>
            </button>)}
            {!(menu === 'projects' ? workspaces.map(item => ({ name: item.name, description: item.path })) : props.skillOptions).some(item => `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase())) && <p className="composer-empty">{t('composer.noMatches')}</p>}
          </div><div className="popover-footer"><span>{t('composer.selectedCount', { count: context[menu].length })}</span><Button size="sm" variant="light" onPress={() => onContext({ ...context, [menu]: [] })}>{t('common.clear')}</Button><Button size="sm" color="primary" variant="flat" onPress={() => { close(); focusInput(); }}>{t('common.done')}</Button></div>
        </>}

        {menu === 'permission' && (agentMode ? <div className="composer-selection-list">
          {((agentMode.options || []).some(value => value.value === agentModeValue) ? agentMode.options : [{ value: agentModeValue, name: agentModeValue, group: null }, ...(agentMode.options || [])]).map(value => {
            const selected = value.value === agentModeValue;
            const danger = /bypass|free/i.test(value.value) || /bypass|完全自动/i.test(value.name);
            return <button key={value.value} role="radio" aria-checked={selected} disabled={agentBusy} className={danger ? 'is-danger' : undefined} onClick={() => { changeAgent(agentMode.id, value.value); close(); }}>
              {danger ? <ShieldAlert size="1.125rem" /> : <ShieldCheck size="1.125rem" />}
              <span><strong>{localizedNativePermission(value)?.name || value.name}</strong>{value.description && <small>{localizedNativePermission(value)?.description || value.description}</small>}</span>{selected && <Check size="1rem" />}
            </button>;
          })}
          <p className="composer-note">{t('composer.agentOptionsNote', { agent: agentEngineName })}</p>
        </div> : <div className="composer-selection-list">{[
            { value: '完全自动', label: t('composer.permissionFree'), description: t('composer.permissionFreeDescription') },
            { value: '按需审批', label: t('composer.permissionApproval'), description: t('composer.permissionApprovalDescription') },
            { value: '自动审批', label: t('composer.permissionAuto'), description: t('composer.permissionAutoDescription') },
          ].map(mode => <button key={mode.value} role="radio" aria-checked={options.mode === mode.value} onClick={() => { update('mode', mode.value); close(); }}><ShieldCheck size="1.125rem" /><span><strong>{mode.label}</strong><small>{mode.description}</small></span>{options.mode === mode.value && <Check size="1rem" />}</button>)}<p className="composer-note">{t('composer.permissionNote')}</p></div>)}

        {menu === 'connectors' && <>
          <div className="composer-selection-list">
            {sessionConnectors.map(item => <div key={item.id} className="composer-tool-plan"><ConnectorIcon icon={item.icon} fallback={<Cable size="1.125rem" />} size={18} /><span><strong>{item.name}</strong></span><Switch size="sm" aria-label={t('composer.enableConnector', { name: item.name })} isSelected={connectorEnabled(item)} isDisabled={item.allowed === false} onValueChange={value => void toggleConnector(item.id, value)} /></div>)}
            {!sessionConnectors.length && <p className="composer-empty">{t('composer.noConnectors')}</p>}
          </div>
          <div className="popover-footer"><span /><Button size="sm" variant="light" onPress={() => { close(); props.onOpenConnectors?.(); }}>{t('composer.manageConnectors')}</Button></div>
        </>}

        {menu === 'more' && props.agentConfig && <AgentConfigControls state={props.agentConfig} options={otherAgentOptions} />}
        {menu === 'mcp' && <AgentMcpControls key={`${props.agentId || 'native'}:${props.workspaceHash}`} api={props.api} agentId={props.agentId || 'native'} workspaceHash={props.workspaceHash} connected={props.connected} />}

        {menu === 'presets' && <>
          {editing ? <form className="preset-form" onSubmit={event => { event.preventDefault(); savePreset(); }}><Input autoFocus size="sm" variant="bordered" label={t('composer.presetName')} aria-label={t('composer.presetNameAria')} maxLength={24} value={editing.name} onValueChange={name => setEditing({ ...editing, name })} /><Textarea variant="bordered" size="sm" label={t('composer.presetContent')} aria-label={t('composer.presetContentAria')} minRows={3} maxRows={5} maxLength={500} value={editing.text} onValueChange={text => setEditing({ ...editing, text })} /><div><Button size="sm" variant="light" onPress={() => setEditing(null)}>{t('common.cancel')}</Button><Button size="sm" color="primary" type="submit" isDisabled={!editing.name.trim() || !editing.text.trim()}>{t('common.save')}</Button></div></form>
            : <><p className="composer-note">{t('composer.presetHelp')}</p><div className="preset-list">{presets.map(preset => <div className="preset-row" key={preset.id}><button className="preset-append" onClick={() => { onDraft(appendPreset(draft, preset.text)); close(); focusInput(); }}><strong>{preset.name}</strong><small>{preset.text}</small></button><Button isIconOnly size="sm" variant="light" aria-label={t('composer.editPreset', { name: preset.name })} onPress={() => setEditing({ ...preset })}><Pencil size="0.875rem" /></Button><Button isIconOnly size="sm" variant="light" aria-label={t('composer.deletePreset', { name: preset.name })} onPress={() => { const next = presets.filter(item => item.id !== preset.id); setPresets(next); persistPresets(next); }}><Trash2 size="0.875rem" /></Button></div>)}{!presets.length && <p className="composer-empty">{t('composer.noPresets')}</p>}</div><div className="popover-footer"><span>{t('composer.storedOnServer')}</span><Button size="sm" variant="light" onPress={() => setEditing({ id: crypto.randomUUID(), name: '', text: '' })}><Plus size="0.875rem" />{t('composer.addPreset')}</Button></div></>}
        </>}

        {menu === 'context' && <div className="context-body">
          <div className="context-total">
            <strong>{!usage.measured && usage.source === 'loopra' ? t('composer.approximate') : ''}{formatTokens(usage.total)}<small> / {usage.windowKnown === false ? t('composer.windowUnknown') : formatTokens(usage.limit)}</small></strong>
            <span className={usage.percent >= 80 ? 'context-high' : usage.percent >= 50 ? 'context-medium' : 'context-low'}>{usagePercent}</span>
          </div>
          {formatTokenSpeed(props.liveSpeed) && <p className="composer-note">{t('composer.generationSpeed', { speed: formatTokenSpeed(props.liveSpeed) })}{props.liveSpeed?.completionTokens ? ` · ${t('composer.generatedTokens', { value: formatTokens(props.liveSpeed.completionTokens) })}` : ''}</p>}
          {usage.windowKnown !== false && <>
            <div className="context-gauge" role="img" aria-label={`${t('composer.contextGauge', { percent: usagePercent })}${external ? '' : t('composer.foldThresholdGauge', { threshold: FOLD_THRESHOLD_RATIO * 100 })}`}>
              {usage.parts.map(part => <span key={part.name} style={{ background: part.color, width: `${contextPartPercent(part, usage) / 100 * usage.percent}%` }} />)}
              {!external && <span className="context-gauge-threshold" style={{ left: `${FOLD_THRESHOLD_RATIO * 100}%` }} title={`${t('composer.foldThreshold')} (${FOLD_THRESHOLD_RATIO * 100}%)`} />}
            </div>
            <div className="context-gauge-scale"><span>{t('composer.currentTokens', { value: formatTokens(usage.total) })}</span><span>{t('composer.windowTokens', { value: formatTokens(usage.limit) })}</span></div>
            {!external && <p className="composer-note context-threshold-note">{t('composer.foldThresholdNote', { tokens: formatTokens(foldThreshold(usage.limit)), percent: FOLD_THRESHOLD_RATIO * 100 })}</p>}
          </>}
          {usage.parts.map(part => <div className="context-breakdown" key={part.name}>
            <span><i style={{ background: part.color }} />{localizedUsagePart(part.name)}</span>
            {!usage.estimatedComposition && <strong>{formatTokens(part.tokens)}</strong>}
            <small>{contextPartPercent(part, usage).toFixed(1)}%</small>
          </div>)}
          {usageMetricsNote && <p className="composer-note context-disclaimer">{usageMetricsNote}</p>}
        </div>}
      </section>}
    </Popup>
    <Popup open={!!suggestions.length || showCommandStatus} className="composer-popover composer-suggestions">
      <section aria-label={slash ? t('composer.inputCommands') : t('composer.workspaceFiles')}>
        <div className="suggestions-heading">
          <span>{slash ? t('composer.commands') : t('composer.referenceFiles')}{slash && external && <small>{agentEngineName}</small>}</span>
          <span className="suggestions-count">{t('composer.itemsCount', { count: suggestions.length })}</span>
        </div>
        <div className="suggestions-list">
          {suggestions.map((item, index) => <button type="button" key={item.id}
            className={suggestionIndex % suggestions.length === index ? 'is-selected' : ''}
            title={`${item.label}\n${item.description}`}
            onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => setSuggestionIndex(index)} onClick={() => selectSuggestion(index)}>
            {slash ? <SquareTerminal size={15} /> : <FileText size={15} />}
            <span className="suggestion-copy">
              <strong>{item.label}{!(slash && external) && item.title !== item.label && <em>{item.title}</em>}</strong>
              {item.description && <small>{item.description}</small>}
            </span>
            <kbd className="suggestion-enter" aria-hidden="true">↵</kbd>
          </button>)}
          {showCommandStatus && <div className="suggestions-status" role="status">
            {commandStatus}
            {props.sessionName && !discovered?.loading && !agentCommands.length && <button type="button" onClick={() => setCommandRetry(value => value + 1)}>{t('composer.reread')}</button>}
          </div>}
        </div>
        <div className="suggestions-footer">
          {suggestions.length > 0 && <span><kbd>↑</kbd><kbd>↓</kbd> {t('composer.selectComplete')}</span>}
          <span><kbd>Esc</kbd> {t('composer.escClose')}</span>
        </div>
      </section>
    </Popup>
    {dragging && <div className="composer-drop-hint"><Paperclip size="1.5rem" /><span>{t('composer.dropAttachments')}</span></div>}
  </div></>;
}
