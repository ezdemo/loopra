import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronRight, FileText, FolderClosed, FolderOpen, Plus, Undo2 } from 'lucide-react';
import { buildGitTree, gitFileState, gitTreeSelection, selectGitPaths, type GitChangeFile, type GitTreeNode } from '../git-tree';

type Props = {
  changed: GitChangeFile[]; untracked: GitChangeFile[]; selected: string[]; busy: boolean; pendingPaths?: string[];
  onSelect: (paths: string[]) => void; onFile: (path: string) => void; onToggle: (path: string, staged: boolean) => void;
  /** Informational tree (e.g. the main checkout while isolated): no checkboxes or staging. */
  readOnly?: boolean;
};

function TreeCheckbox({ paths, selected, label, busy, onSelect }: { paths: string[]; selected: string[]; label: string; busy: boolean; onSelect: Props['onSelect'] }) {
  const input = useRef<HTMLInputElement>(null), { checked, mixed } = gitTreeSelection(paths, selected);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" aria-label={label} aria-checked={mixed ? 'mixed' : checked} checked={checked} disabled={busy} onChange={event => onSelect(selectGitPaths(selected, paths, event.target.checked))} />;
}

export default function GitChangeTree({ changed, untracked, selected, busy, pendingPaths = [], onSelect, onFile, onToggle, readOnly = false }: Props) {
  const [expanded, setExpanded] = useState(() => new Set(['changed', 'untracked']));
  const [active, setActive] = useState('');
  const stagedPaths = useMemo(() => new Set([...changed, ...untracked].filter(file => gitFileState(file).staged && !file.workTree.trim()).map(file => file.path)), [changed, untracked]);
  const groups = useMemo(() => [
    { id: 'changed', label: '更改', nodes: buildGitTree(changed) },
    { id: 'untracked', label: '未进行版本管理的文件', nodes: buildGitTree(untracked) },
  ].map(group => ({ ...group, paths: group.nodes.flatMap(node => node.paths) })).filter(group => group.paths.length), [changed, untracked]);
  function toggle(key: string) { setActive(key); setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  function clickRow(event: ReactMouseEvent<HTMLDivElement>, key: string) {
    // Buttons already handle expansion; checkboxes only change the selection.
    if (!(event.target as Element).closest('button, input')) toggle(key);
  }
  function renderNode(node: GitTreeNode, group: typeof groups[number], depth: number) {
    const key = `${group.id}/${node.path}`, open = expanded.has(key), file = node.file, status = file ? gitFileState(file) : undefined;
    const folderStaged = !file && node.paths.every(path => stagedPaths.has(path));
    return <li key={`${file ? 'file' : 'folder'}:${node.path}`}><div className={`git-tree-row ${file ? 'is-file' : ''} ${active === key ? 'is-active' : ''}`} style={{ paddingInlineStart: `${depth * .875}rem` }} onClick={file ? undefined : event => clickRow(event, key)}>
      {file ? <span className="git-tree-arrow-space" /> : <button type="button" className="git-tree-arrow" aria-label={`${open ? '折叠' : '展开'}目录：${group.label}/${node.path}`} aria-expanded={open} onClick={() => toggle(key)}><ChevronRight size={13} /></button>}
      {!readOnly && <TreeCheckbox paths={node.paths} selected={selected} label={file ? `选择提交文件：${file.path}` : `选择目录：${group.label}/${node.path}`} busy={busy} onSelect={onSelect} />}
      {file ? <FileText className="git-tree-glyph" size={14} /> : open ? <FolderOpen className="git-tree-glyph" size={15} /> : <FolderClosed className="git-tree-glyph" size={15} />}
      <button type="button" className={`git-tree-name ${status ? `is-${status.tone}` : ''}`} title={file?.path || node.path} onClick={() => { if (file) { setActive(key); onFile(file.path); } else toggle(key); }}>{node.name}</button>
      {file && status ? <><span className={`git-file-status is-${status.tone}`} title={`${status.text}${status.staged ? ' · 已暂存' : ''}`}>{status.label}</span>{!readOnly && <button type="button" className="git-stage-button" disabled={busy || pendingPaths.includes(file.path)} aria-busy={pendingPaths.includes(file.path)} aria-label={`${status.staged ? '取消暂存' : '暂存'} ${file.path}`} title={status.staged ? '取消暂存' : '暂存文件'} onClick={() => onToggle(file.path, !status.staged)}>{status.staged ? <Undo2 size={14} /> : <Plus size={15} />}</button>}</> : <><span className="git-tree-count">{node.paths.length} 个文件</span>{!readOnly && <button type="button" className="git-stage-button git-folder-stage" disabled={busy || pendingPaths.includes(node.path)} aria-busy={pendingPaths.includes(node.path)} aria-label={`${folderStaged ? '取消暂存目录' : '暂存目录'} ${node.path}`} title={folderStaged ? '取消暂存此目录的全部文件' : '暂存此目录的全部改动'} onClick={() => onToggle(node.path, !folderStaged)}>{folderStaged ? <Undo2 size={14} /> : <Plus size={15} />}</button>}</>}
    </div>{!file && open && <ul>{node.children.map(child => renderNode(child, group, depth + 1))}</ul>}</li>;
  }
  return <div className="git-change-tree" aria-label="Git 改动目录树">{groups.map(group => <section key={group.id} className="git-tree-group" aria-label={group.label}><div className={`git-tree-row git-tree-group-row ${active === group.id ? 'is-active' : ''}`} onClick={event => clickRow(event, group.id)}><button type="button" className="git-tree-arrow" aria-label={`${expanded.has(group.id) ? '折叠' : '展开'}分组：${group.label}`} aria-expanded={expanded.has(group.id)} onClick={() => toggle(group.id)}><ChevronRight size={13} /></button>{!readOnly && <TreeCheckbox paths={group.paths} selected={selected} label={`选择分组：${group.label}`} busy={busy} onSelect={onSelect} />}<button type="button" className="git-tree-name" onClick={() => toggle(group.id)}>{group.label}</button><span className="git-tree-count">{group.paths.length} 个文件</span></div>{expanded.has(group.id) && <ul>{group.nodes.map(node => renderNode(node, group, 1))}</ul>}</section>)}</div>;
}
