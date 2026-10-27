export type DirtyDiffChange = {
  type: 'added' | 'modified' | 'deleted';
  startLine: number;
  endLine: number;
  afterLine: number;
  originalStartLine: number;
  originalLines: string[];
};

/** Split Git's context hunks into the individual changed blocks in the gutter. */
export function parseDirtyDiff(patch?: string): DirtyDiffChange[] {
  const changes: DirtyDiffChange[] = [];
  let originalLine = 0, modifiedLine = 0, oldRemaining = 0, newRemaining = 0;
  let pending: { oldStart: number; newStart: number; removed: string[]; added: number } | null = null;
  function flush() {
    if (!pending) return;
    const { oldStart, newStart, removed, added } = pending;
    const startLine = Math.max(1, added ? newStart : newStart - 1);
    changes.push({
      type: removed.length ? added ? 'modified' : 'deleted' : 'added',
      startLine, endLine: added ? newStart + added - 1 : startLine,
      afterLine: Math.max(0, newStart - 1),
      originalStartLine: oldStart, originalLines: removed,
    });
    pending = null;
  }
  for (const line of (patch || '').split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      flush();
      originalLine = Number(header[1]) || 1;
      modifiedLine = Number(header[3]) || 1;
      oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
      newRemaining = header[4] === undefined ? 1 : Number(header[4]);
      continue;
    }
    if (!oldRemaining && !newRemaining) continue;
    if (line.startsWith('-') && oldRemaining > 0) {
      pending ??= { oldStart: originalLine, newStart: modifiedLine, removed: [], added: 0 };
      pending.removed.push(line.slice(1));
      originalLine++; oldRemaining--;
    } else if (line.startsWith('+') && newRemaining > 0) {
      pending ??= { oldStart: originalLine, newStart: modifiedLine, removed: [], added: 0 };
      pending.added++;
      modifiedLine++; newRemaining--;
    } else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      flush();
      originalLine++; modifiedLine++; oldRemaining--; newRemaining--;
    }
    if (!oldRemaining && !newRemaining) flush();
  }
  // The server may truncate a large patch; never preview an incomplete block.
  return changes;
}
