export type DiffRow = {
  type: 'context' | 'replace' | 'add' | 'remove' | 'empty';
  left: string;
  right: string;
  leftLineNum: number | null;
  rightLineNum: number | null;
  hunkIndex: number;
};

// Ported from the legacy DiffViewer.vue parseSideBySide: turn a unified diff into
// side-by-side rows, pairing consecutive removed/added lines as replacements.
export function parseSideBySide(diffText?: string): DiffRow[] {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  const result: DiffRow[] = [];
  let i = 0;
  let hunkIndex = -1;
  while (i < lines.length && !lines[i].startsWith('@@')) i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('@@')) continue;
    const match = line.match(/@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!match) continue;
    hunkIndex++;
    let oldNum = parseInt(match[1], 10);
    let newNum = parseInt(match[3], 10);
    const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
    if (oldCount === 0 && newCount === 0) {
      result.push({ type: 'empty', left: '', right: '（空文件）', leftLineNum: null, rightLineNum: null, hunkIndex });
      continue;
    }
    const removedQueue: { content: string; lineNum: number }[] = [];
    const addedQueue: { content: string; lineNum: number }[] = [];
    const flushQueues = () => {
      while (removedQueue.length && addedQueue.length) {
        const removed = removedQueue.shift()!;
        const added = addedQueue.shift()!;
        result.push({ type: 'replace', left: removed.content, right: added.content, leftLineNum: removed.lineNum, rightLineNum: added.lineNum, hunkIndex });
      }
      while (removedQueue.length) {
        const removed = removedQueue.shift()!;
        result.push({ type: 'remove', left: removed.content, right: '', leftLineNum: removed.lineNum, rightLineNum: null, hunkIndex });
      }
      while (addedQueue.length) {
        const added = addedQueue.shift()!;
        result.push({ type: 'add', left: '', right: added.content, leftLineNum: null, rightLineNum: added.lineNum, hunkIndex });
      }
    };
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('@@')) {
      const body = lines[j];
      if (body.startsWith('+') && !body.startsWith('+++')) addedQueue.push({ content: body.substring(1), lineNum: newNum++ });
      else if (body.startsWith('-') && !body.startsWith('---')) removedQueue.push({ content: body.substring(1), lineNum: oldNum++ });
      else if (body.startsWith(' ')) {
        flushQueues();
        const content = body.substring(1);
        result.push({ type: 'context', left: content, right: content, leftLineNum: oldNum++, rightLineNum: newNum++, hunkIndex });
      }
      j++;
    }
    flushQueues();
    i = j - 1;
  }
  return result;
}

export function diffHunkCount(rows: DiffRow[]) {
  return new Set(rows.map(row => row.hunkIndex)).size;
}
