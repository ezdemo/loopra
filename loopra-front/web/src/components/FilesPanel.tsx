import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Button } from '@nextui-org/react';
import { ChevronRight, ChevronsDownUp, Coffee, Container, Database, ExternalLink, FileArchive, FileCode, FileImage, FileJson, FileText, FolderClosed, FolderOpen, GitBranch, ListTree, Package, Palette, Pencil, RefreshCw, Search, Settings, Terminal, Trash2, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { baseName, canRenameFiles, canRevealFiles, desktopFileBridge, invalidFileName, renamedPath } from '../desktop-files';
import { buildDecorations, type GitStatus } from '../git-decorations';
import { fileIconFor } from '../file-icons';
import { ConfirmAction, errorText, query, useRemote } from './RemoteControls';
import { IconButton } from './ui';
import DiffView from './DiffView';

type Entry = { name: string; path: string; directory: boolean };
type Preview = { path: string; mode: 'content' | 'diff' };
type WorkingFile = { content: string; exists: boolean; message?: string };
type WorkingDiff = { diff: string; stat: string };

// Legacy FileExplorerNode.vue picked a per-extension codicon; map its kinds onto lucide glyphs.
const FILE_GLYPHS: Record<string, typeof FileText> = {
  default: FileText, vue: FileCode, javascript: FileCode, react: FileCode, typescript: FileCode,
  java: Coffee, kotlin: FileCode, json: FileJson, markdown: FileText, css: Palette, sass: Palette,
  html: FileCode, xml: FileCode, yaml: ListTree, python: FileCode, go: FileCode, rust: Settings,
  php: FileCode, shell: Terminal, powershell: Terminal, database: Database, image: FileImage,
  svg: Palette, pdf: FileText, archive: FileArchive, config: Settings, git: GitBranch,
  npm: Package, docker: Container, maven: Package, gradle: Package,
};

function FileGlyph({ name }: { name: string }) {
  const { kind, color } = fileIconFor(name);
  const Glyph = FILE_GLYPHS[kind] || FileText;
  return <Glyph size={14} className="tree-file" data-icon={kind} style={{ color }} />;
}

// 工作区文件面板：目录树 + 递归搜索 + 只读预览（原文件 / Git Diff），
// 右键可删除文件或目录；预览内容可框选后加入会话上下文。
// 重命名 / 在文件管理器中显示沿用旧 FileExplorer.vue 的 Electron IPC，按能力探测显示。
export default function FilesPanel({ api, workspaceHash, revision, onAdd }: { api: LoopraClient; workspaceHash: string; revision: number; onAdd: (path: string, selection?: string) => void }) {
  const bridge = desktopFileBridge();
  const renameEnabled = canRenameFiles(bridge);
  const revealEnabled = canRevealFiles(bridge);
  const [roots, setRoots] = useState<Entry[]>([]);
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<Entry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry } | null>(null);
  const [pending, setPending] = useState<Entry | null>(null);
  const [notice, setNotice] = useState('');
  const [selection, setSelection] = useState<{ left: number; top: number; text: string } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const searchSeq = useRef(0);
  const previewBody = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRoots([]); setChildren({}); setExpanded(new Set()); setError('');
    void api.request<Entry[]>(`/files/tree?${query({ workspaceHash })}`, 'GET', undefined, controller.signal)
      .then(list => { if (!controller.signal.aborted) setRoots(list); })
      .catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); });
    return () => controller.abort();
  }, [api, workspaceHash, revision]);

  useEffect(() => {
    const text = keyword.trim();
    if (!text) { searchSeq.current++; setResults(null); setSearching(false); return; }
    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void api.request<Entry[]>(`/files/search?${query({ workspaceHash, query: text })}`)
        .then(list => { if (seq === searchSeq.current) setResults(list); })
        .catch(() => { if (seq === searchSeq.current) setResults([]); })
        .finally(() => { if (seq === searchSeq.current) setSearching(false); });
    }, 200);
    return () => clearTimeout(timer);
  }, [api, workspaceHash, keyword]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', escape); };
  }, [menu]);

  async function loadDir(path: string) {
    const list = await api.request<Entry[]>(`/files/tree?${query({ workspaceHash, path })}`);
    setChildren(current => ({ ...current, [path]: list }));
    return list;
  }

  function setDirectoryLoading(path: string, active: boolean) {
    setLoadingDirs(current => { const next = new Set(current); if (active) next.add(path); else next.delete(path); return next; });
  }

  async function toggle(entry: Entry) {
    if (!entry.directory) { setPreview({ path: entry.path, mode: 'content' }); return; }
    if (expanded.has(entry.path)) { setExpanded(current => { const next = new Set(current); next.delete(entry.path); return next; }); return; }
    setExpanded(current => new Set(current).add(entry.path));
    if (children[entry.path] !== undefined) return;
    setDirectoryLoading(entry.path, true);
    try {
      let list = await loadDir(entry.path);
      // 单一路径的目录自动展开，最多 32 层，避免异常结构导致无休止请求。
      for (let depth = 0; depth < 32; depth++) {
        if (list.length !== 1 || !list[0].directory) break;
        const child = list[0];
        setExpanded(current => new Set(current).add(child.path));
        list = await loadDir(child.path);
      }
    } catch (cause) { setError(errorText(cause)); }
    finally { setDirectoryLoading(entry.path, false); }
  }

  async function refreshDir(path: string) {
    setDirectoryLoading(path, true);
    try { await loadDir(path); } catch (cause) { setError(errorText(cause)); }
    finally { setDirectoryLoading(path, false); }
  }

  async function remove(entry: Entry) {
    await api.request(`/files/delete?${query({ workspaceHash, path: entry.path })}`, 'DELETE');
    setRoots(current => removeFromTree(current, entry.path));
    setChildren(current => Object.fromEntries(Object.entries(current).map(([key, list]) => [key, removeFromTree(list, entry.path)])));
    setResults(current => current?.filter(item => item.path !== entry.path) ?? current);
    setPreview(current => current?.path === entry.path || current?.path.startsWith(`${entry.path}/`) ? null : current);
    setNotice('已删除 ' + entry.path);
  }

  function openMenu(event: MouseEvent, entry: Entry) {
    event.preventDefault(); event.stopPropagation();
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 210), entry });
  }

  // 重命名后同步树、展开状态、搜索结果与预览里的路径（含子路径前缀）。
  function applyRename(from: string, to: string) {
    const swap = (path: string) => path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
    const renamedName = to.slice(to.lastIndexOf('/') + 1);
    const swapEntry = (entry: Entry): Entry => entry.path === from
      ? { ...entry, name: renamedName, path: to }
      : entry.path.startsWith(`${from}/`) ? { ...entry, path: swap(entry.path) } : entry;
    setRoots(current => current.map(swapEntry));
    setChildren(current => Object.fromEntries(Object.entries(current).map(([key, list]) => [swap(key), list.map(swapEntry)])));
    setExpanded(current => new Set([...current].map(swap)));
    setResults(current => current?.map(swapEntry) ?? current);
    setPreview(current => current ? { ...current, path: swap(current.path) } : current);
  }

  async function commitRename() {
    const pendingRename = renaming;
    if (!pendingRename) return;
    setRenaming(null);
    const name = pendingRename.value.trim();
    if (invalidFileName(name)) { setNotice('名称不能为空且不能包含路径分隔符'); return; }
    if (name === baseName(pendingRename.path)) return;
    const rename = bridge?.fileExplorer?.rename;
    if (!rename) { setNotice('重命名需要桌面版 Loopra'); return; }
    try {
      const result = await rename(pendingRename.path, name);
      if (result && result.success === false) throw new Error(result.error || '重命名失败');
      applyRename(pendingRename.path, result?.data?.path || renamedPath(pendingRename.path, name));
      setNotice(`已重命名为 ${result?.data?.name || name}`);
    } catch (cause) {
      setNotice(`重命名失败：${errorText(cause)}`);
    }
  }

  async function reveal(entry: Entry) {
    const openFolder = bridge?.openFolder;
    if (!openFolder) { setNotice('需要桌面版 Loopra 才能在文件管理器中显示'); return; }
    try {
      const result = await openFolder(entry.path);
      if (result && result.success === false) throw new Error(result.error || '未知错误');
    } catch (cause) {
      setNotice(`打开文件管理器失败：${errorText(cause)}`);
    }
  }

  function renameInput(entry: Entry) {
    return <input className="tree-rename-input" autoFocus value={renaming?.value ?? ''} aria-label={`重命名 ${entry.name}`} onClick={event => event.stopPropagation()} onChange={event => setRenaming({ path: entry.path, value: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') void commitRename(); if (event.key === 'Escape') setRenaming(null); }} onBlur={() => void commitRename()} />;
  }

  function handleMouseUp() {
    requestAnimationFrame(() => {
      const selected = typeof window !== 'undefined' ? window.getSelection() : null;
      const text = selected?.toString().trim() || '';
      const range = selected && selected.rangeCount ? selected.getRangeAt(0) : null;
      if (!text || !range || !previewBody.current?.contains(range.commonAncestorContainer)) { setSelection(null); return; }
      const rect = range.getBoundingClientRect();
      setSelection({ text, left: Math.min(Math.max(8, rect.left), window.innerWidth - 120), top: Math.max(8, rect.top - 38) });
    });
  }

  const content = useRemote<WorkingFile>(api, preview && preview.mode === 'content' ? `/git/working-file-content?${query({ workspaceHash, path: preview.path })}` : null, revision);
  const diff = useRemote<WorkingDiff>(api, preview && preview.mode === 'diff' ? `/git/diff-content?${query({ workspaceHash, path: preview.path })}` : null, revision);
  // Legacy FileExplorer decorated the tree with git status; reuse the Git tab's endpoint.
  const status = useRemote<GitStatus>(api, `/git/status?${query({ workspaceHash })}`, revision);
  const decorations = buildDecorations(status.data);
  const loading = content.loading || diff.loading;

  function renderEntries(entries: Entry[]): ReactNode {
    return entries.map(entry => entry.directory ? (
      <li key={entry.path} className="workspace-tree-node">
        {renaming?.path === entry.path ? <div className="workspace-tree-entry editing">{renameInput(entry)}</div>
          : <button type="button" className={`workspace-tree-entry ${expanded.has(entry.path) ? 'expanded' : ''}${decorations[entry.path] ? ` decorated is-${decorations[entry.path].kind}` : ''}`} onClick={() => void toggle(entry)} onContextMenu={event => openMenu(event, entry)} title={entry.path}>
            <ChevronRight size={13} className={`tree-chevron ${expanded.has(entry.path) ? 'open' : ''}`} />
            {expanded.has(entry.path) ? <FolderOpen size={14} className="tree-folder" /> : <FolderClosed size={14} className="tree-folder" />}
            <span>{entry.name}</span>
            {decorations[entry.path] && <span className={`fen-decoration is-${decorations[entry.path].kind} is-directory`} aria-hidden="true" />}
            {loadingDirs.has(entry.path) && <span className="tree-loading" aria-label="正在加载" />}
          </button>}
        {expanded.has(entry.path) && (children[entry.path]?.length
          ? <ul className="workspace-tree">{renderEntries(children[entry.path])}</ul>
          : !loadingDirs.has(entry.path) && <div className="tree-empty">空目录</div>)}
      </li>
    ) : (
      <li key={entry.path} className="workspace-tree-node">
        {renaming?.path === entry.path ? <div className="workspace-tree-entry editing">{renameInput(entry)}</div>
          : <button type="button" className={`workspace-tree-entry ${preview?.path === entry.path ? 'active' : ''}${decorations[entry.path] ? ` decorated is-${decorations[entry.path].kind}` : ''}`} onClick={() => setPreview({ path: entry.path, mode: 'content' })} onContextMenu={event => openMenu(event, entry)} title={entry.path}>
            <FileGlyph name={entry.name} />
            <span>{entry.name}</span>
            {decorations[entry.path] && <span className={`fen-decoration is-${decorations[entry.path].kind}`} aria-label={`Git 状态 ${decorations[entry.path].label}`}>{decorations[entry.path].label}</span>}
          </button>}
      </li>
    ));
  }

  return <div className="workspace-files" onMouseUp={handleMouseUp}>
    <div className="file-search">
      <Search size={15} aria-hidden="true" />
      <input type="search" value={keyword} placeholder="筛选文件..." aria-label="筛选文件" onChange={event => setKeyword(event.target.value)} />
      {keyword && <button type="button" className="clear-search" title="清除筛选" aria-label="清除筛选" onClick={() => setKeyword('')}><X size={14} /></button>}
      {expanded.size > 0 && <button type="button" className="collapse-tree" title="折叠全部" aria-label="折叠全部" onClick={() => setExpanded(new Set())}><ChevronsDownUp size={14} /></button>}
    </div>
    {notice && <p className="settings-note" role="status">{notice}</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    {results !== null ? <div className="workspace-file-list" role="listbox" aria-label="文件搜索结果">
      {searching ? <div className="remote-loading">正在搜索…</div> : results.length === 0 ? <p className="panel-empty">未找到匹配的文件</p> : results.map(result => (
        <button key={result.path} type="button" role="option" className="file-search-result" title={result.path} onClick={() => setPreview({ path: result.path, mode: 'content' })} onContextMenu={event => openMenu(event, result)}>
          <FileGlyph name={result.name} />
          <span className="file-search-result-name">{result.name}</span>
          <span className="file-search-result-path">{result.path}</span>
        </button>
      ))}
    </div> : roots.length === 0 && !error ? <p className="panel-empty">项目文件夹为空</p> : <ul className="workspace-tree workspace-file-list" role="tree" aria-label="项目文件">{renderEntries(roots)}</ul>}

    {preview && <section className="workspace-preview workbench-card">
      <header><strong>{preview.path}</strong>
        <div className="diff-view-tabs" role="tablist" aria-label="文件视图">
          <button type="button" role="tab" aria-selected={preview.mode === 'content'} className={preview.mode === 'content' ? 'active' : ''} onClick={() => setPreview({ path: preview.path, mode: 'content' })}>原文件</button>
          <button type="button" role="tab" aria-selected={preview.mode === 'diff'} className={preview.mode === 'diff' ? 'active' : ''} onClick={() => setPreview({ path: preview.path, mode: 'diff' })}>Git Diff</button>
        </div>
        <Button size="sm" variant="light" onPress={() => onAdd(preview.path)}>引用文件</Button>
        <IconButton label="关闭预览" onClick={() => { setPreview(null); setSelection(null); }}><X size={15} /></IconButton>
      </header>
      <div className="preview-body" ref={previewBody}>
        {loading ? <div className="remote-loading">正在加载…</div> : preview.mode === 'diff' ? <DiffView key={preview.path} diff={diff.data?.diff} /> : content.error ? <p className="settings-error" role="alert">{content.error}</p> : content.data?.exists ? <pre className="workspace-preview-raw">{content.data.content}</pre> : <p className="panel-empty">{content.data?.message || '该文件不存在或无法预览。'}</p>}
      </div>
    </section>}

    {selection && <button type="button" className="diff-selection-action" style={{ left: selection.left, top: selection.top }} onClick={() => { if (preview) onAdd(preview.path, selection.text); window.getSelection()?.removeAllRanges(); setSelection(null); }}>添加到会话</button>}

    {menu && <div className="file-context-menu" role="menu" aria-label="文件操作菜单" style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()}>
      {menu.entry.directory ? <button type="button" role="menuitem" onClick={() => { refreshDir(menu.entry.path); setMenu(null); }}><RefreshCw size={14} />刷新</button>
        : <>
          <button type="button" role="menuitem" onClick={() => { setPreview({ path: menu.entry.path, mode: 'content' }); setMenu(null); }}><FileText size={14} />打开文件</button>
          <button type="button" role="menuitem" onClick={() => { onAdd(menu.entry.path); setMenu(null); }}><FileText size={14} />添加到上下文</button>
        </>}
      {renameEnabled && <button type="button" role="menuitem" onClick={() => { setRenaming({ path: menu.entry.path, value: baseName(menu.entry.path) }); setMenu(null); }}><Pencil size={14} />重命名</button>}
      {revealEnabled && <button type="button" role="menuitem" onClick={() => { void reveal(menu.entry); setMenu(null); }}><ExternalLink size={14} />在文件管理器中显示</button>}
      <button type="button" role="menuitem" className="danger" onClick={() => { setPending(menu.entry); setMenu(null); }}><Trash2 size={14} />删除</button>
    </div>}

    {pending && <ConfirmAction title={pending.directory ? '删除目录？' : '删除文件？'} onClose={() => setPending(null)} action={() => remove(pending)}><p>“{pending.name}”将被永久删除，无法恢复。</p></ConfirmAction>}
  </div>;
}

function removeFromTree(entries: Entry[], path: string): Entry[] {
  return entries.filter(entry => entry.path !== path);
}

