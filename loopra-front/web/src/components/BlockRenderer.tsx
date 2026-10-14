import { Collapse, Disclosure, useCollapseAll } from './Motion';
import { useId, useState } from 'react';
import { Button } from '@nextui-org/react';
import { Brain, Check, ChevronDown, Circle, FileCode2, FileDiff, LoaderCircle, Undo2, X } from 'lucide-react';
import type { ChatBlock, FileChange, ToolStatus } from '../chat';
import { groupToolBlocks } from '../chat';
import { toolParam } from '../tool-params';
import Markdown from './Markdown';

export type BlockActions = { notify: (message: string) => void; onDiff?: (path: string, diff?: string) => void; onRevert?: (changes: FileChange[]) => Promise<void> };
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

function FileChanges({ changes, onDiff, onRevert, notify }: { changes: FileChange[] } & BlockActions) {
  const [undone, setUndone] = useState(false);
  const [showAll, setShowAll] = useState(false);
  useCollapseAll(() => setShowAll(false));
  const total = changes.reduce((sum, item) => ({ additions: sum.additions + item.additions, deletions: sum.deletions + item.deletions }), { additions: 0, deletions: 0 });
  const onlyFile = changes.length === 1 ? changes[0] : null;
  return <section className={`block-file-changes ${undone ? 'undone' : ''}`} aria-label="文件改动"><div className="file-changes-head"><button type="button" className="file-changes-main" onClick={() => onlyFile && onDiff?.(onlyFile.path, onlyFile.diff)} disabled={!onlyFile || undone}><span className="file-changes-icon"><FileDiff size="1.3125rem" /></span><span className="file-changes-summary"><strong>{undone ? '文件改动已撤销' : onlyFile ? onlyFile.path.split('/').pop() : `${changes.length} 个文件已修改`}</strong><span className="file-changes-total"><b className="file-change-add">+{total.additions}</b><b className="file-change-del">−{total.deletions}</b>{onlyFile && <span>{onlyFile.created ? '新增文件' : '文件已修改'}</span>}</span></span></button><Button size="sm" variant="light" className="file-changes-undo" endContent={<Undo2 size="0.875rem" />} isDisabled={undone || !onRevert || changes.some(change => !change.diff)} onPress={() => { void onRevert?.(changes).then(() => { setUndone(true); notify('文件改动已撤销'); }).catch(error => notify(error instanceof Error ? error.message : '撤销失败')); }}>{undone ? '已撤销' : '撤销'}</Button></div><Collapse open={!undone && !onlyFile}>{changes.slice(0, 3).map(change => <button key={change.path} type="button" className="file-change-row" onClick={() => onDiff?.(change.path, change.diff)}><FileCode2 size="0.875rem" /><span>{change.path}</span><span className="file-change-stats"><b className="file-change-add">+{change.additions}</b><b className="file-change-del">−{change.deletions}</b></span></button>)}<Collapse open={showAll}>{changes.slice(3).map(change => <button key={change.path} type="button" className="file-change-row" onClick={() => onDiff?.(change.path, change.diff)}><FileCode2 size="0.875rem" /><span>{change.path}</span><span className="file-change-stats"><b className="file-change-add">+{change.additions}</b><b className="file-change-del">−{change.deletions}</b></span></button>)}</Collapse></Collapse>{!undone && changes.length > 3 && <button type="button" className="file-changes-expand" onClick={() => setShowAll(!showAll)}>{showAll ? '收起文件' : `再显示 ${changes.length - 3} 个文件`}<ChevronDown size="0.875rem" className={showAll ? 'rotated' : ''} /></button>}</section>;
}

export default function BlockRenderer({ blocks, ...actions }: { blocks: ChatBlock[] } & BlockActions) {
  return <div className="msg-blocks">{groupToolBlocks(blocks).map(block => {
    if (block.type === 'content') return <Markdown key={block.id} text={block.content} notify={actions.notify} onOpenFile={actions.onDiff} />;
    if (block.type === 'reasoning') return <Disclosure key={block.id} className="block-reasoning" headingClass="reasoning-head" heading={<><Brain size="0.9375rem" /><span>思考</span><ChevronDown size="0.875rem" /></>}><div className="reasoning-text"><Markdown text={block.content} notify={actions.notify} onOpenFile={actions.onDiff} /></div></Disclosure>;
    // Encrypted reasoning reuses the plain thinking disclosure with fixed text (legacy BlockRenderer.vue).
    if (block.type === 'reasoning_started') return <Disclosure key={block.id} className="block-reasoning" headingClass="reasoning-head" heading={<><Brain size="0.9375rem" /><span>思考</span><ChevronDown size="0.875rem" /></>}><div className="reasoning-text" role="status">加密思考</div></Disclosure>;
    if (block.type === 'tool_group') {
      const status = block.tools.some(tool => tool.status === '执行中') ? '执行中' : block.tools.some(tool => tool.status === '失败') ? '失败' : '成功';
      return <Disclosure key={block.id} className="block-tool tool-group" headingClass="tool-head" heading={<><StatusIcon status={status} /><code className="tool-name">{block.tools.length} 个工具</code><span className={`tool-status ${status === '成功' ? 'success' : status === '失败' ? 'failed' : 'running'}`}>{status}</span><span className="tool-param">{block.tools.map(tool => tool.name).join(' → ')}</span><ChevronDown size="0.875rem" /></>}><div className="tool-group-detail">{block.tools.map(tool => <ToolBlock key={tool.id} block={tool} onOpenFile={actions.onDiff} />)}</div></Disclosure>;
    }
    if (block.type === 'tool_call') {
      if (block.name === 'finish' && block.result) return <section key={block.id} className="block-tool block-finish"><div className="tool-head finish-head"><StatusIcon status="成功" /><span className="tool-name">最终回答</span></div><div className="finish-content"><Markdown text={block.result} notify={actions.notify} onOpenFile={actions.onDiff} /></div></section>;
      return <ToolBlock key={block.id} block={block} onOpenFile={actions.onDiff} />;
    }
    if (block.type === 'file_changes') return <FileChanges key={block.id} changes={block.changes} {...actions} />;
    // Choice cards (HITL approval / ask_choice) render nothing in the transcript:
    // the composer popup owns the question and its options, so an approval never
    // interrupts the run's flow.
    if (block.type === 'sub_agent') return <Disclosure key={block.id} className="block-tool" headingClass="tool-head" heading={<><StatusIcon status={block.status} /><code className="tool-name">子代理</code><span className={`tool-status ${block.status === '成功' ? 'success' : block.status === '失败' ? 'failed' : 'running'}`}>{block.status}</span><span className="tool-param">{block.name} · {block.blocks.length} 步</span><ChevronDown size="0.875rem" /></>}><div className="tool-group-detail"><BlockRenderer blocks={block.blocks} {...actions} /></div></Disclosure>;
    if (block.type === 'checklist') {
      const completed = block.steps.filter(step => step.status === 'done').length;
      return <Disclosure key={block.id} className="block-tool block-checklist" headingClass="tool-head" heading={<><StatusIcon status={completed === block.steps.length ? '成功' : '执行中'} /><code className="tool-name">checklist</code><span className="tool-param">{block.title}</span><span className="tool-duration">{completed}/{block.steps.length}</span><ChevronDown size="0.875rem" /></>}><div className="checklist-detail"><div className="checklist-track"><span style={{ width: `${block.steps.length ? completed / block.steps.length * 100 : 0}%` }} /></div>{block.steps.map((step, index) => <div key={index} className={`checklist-row ${step.status}`}>{step.status === 'done' ? <Check size="0.875rem" /> : step.status === 'active' ? <LoaderCircle size="0.875rem" className="spin" /> : <Circle size="0.875rem" />}<div>{step.description}{step.result && <small>{step.result}</small>}</div></div>)}</div></Disclosure>;
    }
    return null;
  })}</div>;
}
