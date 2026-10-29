export type GitChangeFile = { path: string; index: string; workTree: string; status: string };
export type GitTreeNode = { name: string; path: string; children: GitTreeNode[]; paths: string[]; file?: GitChangeFile };

export function buildGitTree(files: GitChangeFile[]): GitTreeNode[] {
  type Entry = { name: string; path: string; children: Map<string, Entry>; file?: GitChangeFile };
  const root = new Map<string, Entry>(), seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const parts = file.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let children = root;
    parts.forEach((name, index) => {
      const leaf = index === parts.length - 1, key = `${leaf ? 'file' : 'folder'}:${name}`;
      let entry = children.get(key);
      if (!entry) { entry = { name, path: parts.slice(0, index + 1).join('/'), children: new Map(), ...(leaf ? { file } : {}) }; children.set(key, entry); }
      children = entry.children;
    });
  }
  function finish(entries: Map<string, Entry>): GitTreeNode[] {
    return [...entries.values()].map(entry => {
      const children = finish(entry.children);
      let node: GitTreeNode = { name: entry.name, path: entry.path, children, paths: entry.file ? [entry.file.path] : children.flatMap(child => child.paths), file: entry.file };
      // Compact chains such as loopra/src/main until a directory branches.
      while (!node.file && node.children.length === 1 && !node.children[0].file) {
        const child = node.children[0];
        node = { ...child, name: `${node.name}/${child.name}` };
      }
      return node;
    }).sort((left, right) => Number(!!left.file) - Number(!!right.file) || left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
  }
  return finish(root);
}

export function gitTreeSelection(paths: string[], selected: string[]) {
  const included = new Set(selected), count = paths.filter(path => included.has(path)).length;
  return { checked: paths.length > 0 && count === paths.length, mixed: count > 0 && count < paths.length };
}

export function selectGitPaths(selected: string[], paths: string[], checked: boolean) {
  const next = new Set(selected);
  for (const path of paths) { if (checked) next.add(path); else next.delete(path); }
  return [...next];
}

export function gitFileState(file: GitChangeFile) {
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.index + file.workTree)) return { label: '!', text: '存在冲突', tone: 'deleted', staged: false };
  const staged = !!file.index && file.index !== ' ' && file.index !== '?';
  if (file.status === 'U' || file.status.includes('?')) return { label: 'U', text: '未跟踪', tone: 'added', staged };
  if (file.status.includes('D')) return { label: 'D', text: '已删除', tone: 'deleted', staged };
  if (file.status.includes('A')) return { label: 'A', text: '新增', tone: 'added', staged };
  if (file.status.includes('R')) return { label: 'R', text: '已重命名', tone: 'modified', staged };
  return { label: 'M', text: '已修改', tone: 'modified', staged };
}
