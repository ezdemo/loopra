import { Collapse, Disclosure, useCollapseAll } from './Motion';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@nextui-org/react';
import { Brain, Check, ChevronDown, Circle, FileCode2, FileDiff, LoaderCircle, PanelRight, Undo2, X } from 'lucide-react';
import type { ChatBlock, FileChange, ToolStatus } from '../chat';
import { chainBlocks } from '../chat';
import { toolParam } from '../tool-params';
import { IconButton } from './ui';
import Markdown from './Markdown';
import UnifiedDiff from './UnifiedDiff';

export type BlockActions = { notify: (message: string) => void; onOpenFile?: (path: string) => void; onDiff?: (path: string, diff?: string) => void; onRevert?: (changes: FileChange[]) => Promise<void> };
function StatusIcon({ status }: { status: ToolStatus }) {
  return <span className={`tool-icon ${status === '成功' ? 'success' : status === '失败' ? 'failed' : 'running'}`}>{status === '成功' ? <Check size="0.9375rem" /> : status === '失败' ? <X size="0.9375rem" /> : <LoaderCircle size="0.9375rem" className="spin" />}</span>;
}

function ToolBlock({ block, onOpenFile }: { block: Extract<ChatBlock, { type: 'tool_call' }>; onOpenFile?: (path: string) => void }) {
  const detailId = useId();
  const [open, setOpen] = useState(false);
  useCollapseAll(() => setOpen(false));
  const param = toolParam(block.name, block.args);
  // The head is a <button>, so the clickable filename uses a span to avoid nesting interactive elements.
  const openFile = (event: { stopPropagation: () => void; preventDefault?: () => void }) => { event.stopPropagation(); if (param?.filePath) onOpenFile?.(param.filePath); };
  const paramNode = param?.filePath
    ? <span className="tool-file" role="button" tabIndex={0} title={param.title} onClick={openFile} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openFile(event); } }}>{param.text}</span>
    : param ? <span className="tool-param" title={param.title}>{param.text}</span> : null;
  return <div className="block-tool"><button type="button" className="tool-head" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}><StatusIcon status={block.status} /><code className="tool-name">{block.name}</code><span className={`tool-status ${block.status === '成功' ? 'success' : block.status === '失败' ? 'failed' : 'running'}`}>{block.status}</span>{paramNode}{block.duration && <span className="tool-duration">{block.duration}</span>}<ChevronDown size="0.875rem" className={open ? 'rotated' : ''} /></button><Collapse open={open} id={detailId} className="tool-detail">{block.args && <><span className="tool-detail-label">参数</span><pre><code>{JSON.stringify(block.args, null, 2)}</code></pre></>}{block.result && <><span className="tool-detail-label">结果</span><pre><code>{block.result}</code></pre></>}</Collapse></div>;
}

// One row of the file list: the name expands the diff in the transcript, the
// trailing button hands the same patch to the workspace pane instead.
function ChangeRow({ change, open, disabled, onToggle, onDiff }: { change: FileChange; open: boolean; disabled: boolean; onToggle: () => void; onDiff?: BlockActions['onDiff'] }) {
  const detailId = useId();
  return <>
    <div className={`file-change-row${open ? ' open' : ''}`}>
      <button type="button" className="file-change-main" aria-expanded={change.diff ? open : undefined} aria-controls={change.diff ? detailId : undefined} disabled={disabled || !change.diff} onClick={onToggle}>
        <FileCode2 size="0.875rem" />
        <span className="file-change-path">{change.path}</span>
        <span className="file-change-stats"><b className="file-change-add">+{change.additions}</b><b className="file-change-del">−{change.deletions}</b></span>
        {change.diff && <ChevronDown size="0.875rem" className={open ? 'rotated' : ''} />}
      </button>
      {/* The pane opens even without a saved patch: it then shows the file's live Git diff. */}
      {onDiff && <IconButton label={`在面板中打开 ${change.path}`} onClick={() => onDiff(change.path, change.diff)}><PanelRight size="0.9375rem" /></IconButton>}
    </div>
    {change.diff && <Collapse open={open} id={detailId}><div className="file-change-diff"><UnifiedDiff diff={change.diff} path={change.path} /></div></Collapse>}
  </>;
}

function FileChanges({ changes, onDiff, onRevert, notify }: { changes: FileChange[] } & BlockActions) {
  // An undo only speaks for the patch it was pressed on: the undo reverts the
  // files, and if the turn then edits them again the card has to come back
  // instead of staying stamped 已撤销 over a patch nobody reverted.
  const patchOf = () => changes.map(change => change.diff || '').join('\u0000');
  const [undonePatch, setUndonePatch] = useState<string | null>(null);
  const undone = undonePatch !== null && undonePatch === patchOf();
  const [showAll, setShowAll] = useState(false);
  // One file open at a time: a turn can touch several files and the card should
  // not push the rest of the transcript out of view.
  const [expanded, setExpanded] = useState<string | null>(null);
  const headId = useId();
  useCollapseAll(() => { setShowAll(false); setExpanded(null); });
  const total = changes.reduce((sum, item) => ({ additions: sum.additions + item.additions, deletions: sum.deletions + item.deletions }), { additions: 0, deletions: 0 });
  const onlyFile = changes.length === 1 ? changes[0] : null;
  const headOpen = !!onlyFile && expanded === onlyFile.path && !undone;
  const toggle = (path: string) => setExpanded(current => current === path ? null : path);
  // The diff shows the patch saved with the turn; the workspace pane stays one
  // click away for the full file and for diffs saved before this turn.
  const openHead = () => { if (onlyFile) toggle(onlyFile.path); };
  // Remember the patch being reverted, not the one that exists when the request
  // comes back: an edit landing in between then reads as a different patch.
  const revert = () => {
    const patch = patchOf();
    void onRevert?.(changes).then(() => { setUndonePatch(patch); notify('文件改动已撤销'); }).catch(error => notify(error instanceof Error ? error.message : '撤销失败'));
  };
  return <section className={`block-file-changes ${undone ? 'undone' : ''}`} aria-label="文件改动"><div className="file-changes-head"><button type="button" className="file-changes-main" aria-expanded={onlyFile?.diff ? headOpen : undefined} aria-controls={onlyFile?.diff ? headId : undefined} onClick={openHead} disabled={!onlyFile || undone || !onlyFile.diff}><span className="file-changes-icon"><FileDiff size="1.3125rem" /></span><span className="file-changes-summary"><strong>{undone ? '文件改动已撤销' : onlyFile ? onlyFile.path.split('/').pop() : `${changes.length} 个文件已修改`}</strong><span className="file-changes-total"><b className="file-change-add">+{total.additions}</b><b className="file-change-del">−{total.deletions}</b>{onlyFile && <span>{onlyFile.created ? '新增文件' : '文件已修改'}</span>}</span></span>{onlyFile?.diff && <ChevronDown size="0.875rem" className={headOpen ? 'rotated' : ''} />}</button>{onlyFile && onDiff && !undone && <IconButton label="在面板中打开" onClick={() => onDiff(onlyFile.path, onlyFile.diff)}><PanelRight size="0.9375rem" /></IconButton>}<Button size="sm" variant="light" className="file-changes-undo" endContent={<Undo2 size="0.875rem" />} isDisabled={undone || !onRevert || changes.some(change => !change.diff)} onPress={revert}>{undone ? '已撤销' : '撤销'}</Button></div>{onlyFile?.diff && <Collapse open={headOpen} id={headId}><div className="file-change-diff"><UnifiedDiff diff={onlyFile.diff} path={onlyFile.path} /></div></Collapse>}<Collapse open={!undone && !onlyFile}>{changes.slice(0, 3).map(change => <ChangeRow key={change.path} change={change} open={expanded === change.path} disabled={undone} onToggle={() => toggle(change.path)} onDiff={onDiff} />)}<Collapse open={showAll}>{changes.slice(3).map(change => <ChangeRow key={change.path} change={change} open={expanded === change.path} disabled={undone} onToggle={() => toggle(change.path)} onDiff={onDiff} />)}</Collapse></Collapse>{!undone && changes.length > 3 && <button type="button" className="file-changes-expand" onClick={() => setShowAll(!showAll)}>{showAll ? '收起文件' : `再显示 ${changes.length - 3} 个文件`}<ChevronDown size="0.875rem" className={showAll ? 'rotated' : ''} /></button>}</section>;
}

type StepProps = { block: ChatBlock; streaming?: boolean } & BlockActions;

function ReasoningPreview({ content, streaming }: { content: string; streaming: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const preview = content.replace(/\s+/g, ' ').trim();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Follow the newest tokens while streaming; once this step is no longer the
    // live one, return to the beginning. The row is reused across steps and a
    // stale offset can leave the summary scrolled into empty space.
    element.scrollLeft = streaming ? element.scrollWidth : 0;
  }, [preview, streaming]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!streaming || !element) return;
    const observer = new ResizeObserver(() => { element.scrollLeft = element.scrollWidth; });
    observer.observe(element);
    return () => observer.disconnect();
  }, [streaming]);
  return <span ref={ref} className="reasoning-preview" data-streaming={streaming} title={preview}>{preview || '思考'}</span>;
}

function chainStatus(steps: ChatBlock[]): ToolStatus {
  const states = steps.map(step => step.type === 'tool_call' || step.type === 'sub_agent' ? step.status : '成功');
  return states.includes('执行中') ? '执行中' : states.includes('失败') ? '失败' : '成功';
}

function Step({ block, streaming = false, ...actions }: StepProps) {
  if (block.type === 'reasoning' || block.type === 'reasoning_started') {
    // Thinking is shown as plain text: Markdown parsing/highlighting of streamed reasoning only burns CPU.
    const text = block.type === 'reasoning' ? <p className="reasoning-plain">{block.content}</p> : '加密思考';
    return <Disclosure className="block-reasoning" headingClass="reasoning-head" heading={<><Brain size="0.9375rem" /><ReasoningPreview content={block.type === 'reasoning' ? block.content : ''} streaming={streaming} /><ChevronDown size="0.875rem" /></>}><div className="reasoning-text" role={block.type === 'reasoning' ? undefined : 'status'}>{text}</div></Disclosure>;
  }
  if (block.type === 'tool_call') return <ToolBlock block={block} onOpenFile={actions.onOpenFile} />;
  if (block.type === 'sub_agent') {
    return <Disclosure className="block-tool" headingClass="tool-head" heading={<><StatusIcon status={block.status} /><code className="tool-name">子代理</code><span className={`tool-status ${block.status === '成功' ? 'success' : block.status === '失败' ? 'failed' : 'running'}`}>{block.status}</span><span className="tool-param">{block.name} · {block.blocks.length} 步</span><ChevronDown size="0.875rem" /></>}><div className="tool-group-detail"><BlockRenderer blocks={block.blocks} streaming={streaming && block.status === '执行中'} {...actions} /></div></Disclosure>;
  }
  return null;
}

function Chain({ steps, streaming = false, ...actions }: { steps: ChatBlock[]; streaming?: boolean } & BlockActions) {
  const status = chainStatus(steps);
  const tools = steps.filter((step): step is Extract<ChatBlock, { type: 'tool_call' }> => step.type === 'tool_call');
  const thoughts = steps.filter(step => step.type === 'reasoning' || step.type === 'reasoning_started').length;
  const names = [...new Set(tools.map(tool => tool.name))];
  const summary = [thoughts ? `${thoughts} 次思考` : '', tools.length ? `${tools.length} 次工具` : ''].filter(Boolean).join(' · ');
  return <Disclosure className="block-chain" headingClass="chain-head" heading={<>
    <StatusIcon status={status} /><span className="chain-summary">{summary}</span>
    {names.length > 0 && <span className="chain-tools">{names.join(' → ')}</span>}<ChevronDown size="0.875rem" />
  </>}><div className="chain-steps">{steps.map((step, index) => <Step key={step.id} block={step} streaming={streaming && index === steps.length - 1} {...actions} />)}</div></Disclosure>;
}

export default function BlockRenderer({ blocks, streaming = false, ...actions }: { blocks: ChatBlock[]; streaming?: boolean } & BlockActions) {
  return <div className="msg-blocks">{chainBlocks(blocks).map(block => {
    if (block.type === 'chain') return <Chain key={block.id} steps={block.steps} streaming={streaming && block.steps.at(-1)?.id === blocks.at(-1)?.id} {...actions} />;
    if (block.type === 'content') return <Markdown key={block.id} text={block.content} notify={actions.notify} onOpenFile={actions.onOpenFile} />;
    if (block.type === 'reasoning' || block.type === 'reasoning_started' || block.type === 'sub_agent') return <Step key={block.id} block={block} streaming={streaming && block.id === blocks.at(-1)?.id} {...actions} />;
    if (block.type === 'tool_call') {
      if (block.name === 'finish' && block.result) return <section key={block.id} className="block-tool block-finish"><div className="tool-head finish-head"><StatusIcon status="成功" /><span className="tool-name">最终回答</span></div><div className="finish-content"><Markdown text={block.result} notify={actions.notify} onOpenFile={actions.onOpenFile} /></div></section>;
      return <ToolBlock key={block.id} block={block} onOpenFile={actions.onOpenFile} />;
    }
    if (block.type === 'file_changes') return <FileChanges key={block.id} changes={block.changes} {...actions} />;
    // Choice cards (HITL approval / ask_choice) render nothing in the transcript:
    // the composer popup owns the question and its options, so an approval never
    // interrupts the run's flow.
    if (block.type === 'checklist') {
      const completed = block.steps.filter(step => step.status === 'done').length;
      return <Disclosure key={block.id} className="block-tool block-checklist" headingClass="tool-head" heading={<><StatusIcon status={completed === block.steps.length ? '成功' : '执行中'} /><code className="tool-name">checklist</code><span className="tool-param">{block.title}</span><span className="tool-duration">{completed}/{block.steps.length}</span><ChevronDown size="0.875rem" /></>}><div className="checklist-detail"><div className="checklist-track"><span style={{ width: `${block.steps.length ? completed / block.steps.length * 100 : 0}%` }} /></div>{block.steps.map((step, index) => <div key={index} className={`checklist-row ${step.status}`}>{step.status === 'done' ? <Check size="0.875rem" /> : step.status === 'active' ? <LoaderCircle size="0.875rem" className="spin" /> : <Circle size="0.875rem" />}<div>{step.description}{step.result && <small>{step.result}</small>}</div></div>)}</div></Disclosure>;
    }
    return null;
  })}</div>;
}
