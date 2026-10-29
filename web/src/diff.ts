export type DiffRow = {
  type: 'context' | 'replace' | 'add' | 'remove' | 'empty';
  left: string;
  right: string;
  leftLineNum: number | null;
  rightLineNum: number | null;
  hunkIndex: number;
};

// Ported from the legacy DiffViewer.vue pairing: turn a unified diff into rows,
// pairing consecutive removed/added lines into a replacement.
export function parseDiffRows(diffText?: string): DiffRow[] {
  if (!diffText) return [];
  // CRLF patches keep their carriage return in the body line, which `white-space:
  // pre` would then render as a line break of its own; split it off here.
  const lines = diffText.split(/\r?\n/);
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
    // The body ends at the next hunk, and at the next file: a patch holding two
    // files would otherwise read the second file's `---`/`+++` header as content.
    while (j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git')) {
      const body = lines[j];
      // Inside a hunk every line is body: `+++`/`---` only open a file header, and
      // skipping them here would drop real content that starts with `--` or `++`
      // (a YAML document marker, a SQL comment) and shift that side's numbering.
      if (body.startsWith('+')) addedQueue.push({ content: body.substring(1), lineNum: newNum++ });
      else if (body.startsWith('-')) removedQueue.push({ content: body.substring(1), lineNum: oldNum++ });
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

export type WordSegment = { text: string; changed: boolean };

const TOKEN = /\w+|\s+|[^\w\s]/g;
const MAX_TOKENS = 400;

/**
 * Intra-line highlight for a replaced line, like the darker spans an IDE paints
 * over the exact characters that changed. Token-level LCS; very long lines fall
 * back to trimming the common prefix and suffix.
 */
export function wordDiff(oldText: string, newText: string): { left: WordSegment[]; right: WordSegment[] } {
  const a = oldText.match(TOKEN) || [];
  const b = newText.match(TOKEN) || [];
  const keepLeft = new Array<boolean>(a.length).fill(false);
  const keepRight = new Array<boolean>(b.length).fill(false);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { keepLeft[start] = keepRight[start] = true; start++; }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { keepLeft[endA--] = true; keepRight[endB--] = true; }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  if (midA.length && midB.length && midA.length <= MAX_TOKENS && midB.length <= MAX_TOKENS) {
    const table: number[][] = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0));
    for (let i = midA.length - 1; i >= 0; i--) for (let j = midB.length - 1; j >= 0; j--) {
      table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { keepLeft[start + i] = keepRight[start + j] = true; i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) i++;
      else j++;
    }
  }
  const join = (tokens: string[], keep: boolean[]) => {
    const out: WordSegment[] = [];
    tokens.forEach((text, index) => {
      const changed = !keep[index];
      const last = out[out.length - 1];
      if (last && last.changed === changed) last.text += text; else out.push({ text, changed });
    });
    return out;
  };
  return { left: join(a, keepLeft), right: join(b, keepRight) };
}

/**
 * Number of untouched lines hidden before each row, keyed by that row's index
 * (the "N 行未更改" fold an IDE shows between changes). The gap is measured in file
 * lines and every row is checked, not just the first row of a hunk: folding can
 * merge two neighbouring hunks into one contiguous block, and the lines between
 * them must still be accounted for rather than silently disappear.
 */
export function diffFolds(rows: DiffRow[]): Map<number, number> {
  const folds = new Map<number, number>();
  let lastLeft: number | null = null;
  let lastRight: number | null = null;
  rows.forEach((row, index) => {
    // Untouched lines advance both files together, so the gap is the same on
    // either side — but only if that side's cursor is real. A hunk that opens
    // with removals leaves the new-file cursor behind, and measuring against it
    // would report a fold in the middle of the group.
    const gaps: number[] = [];
    if (row.leftLineNum !== null) gaps.push(row.leftLineNum - (lastLeft ?? 0) - 1);
    if (row.rightLineNum !== null) gaps.push(row.rightLineNum - (lastRight ?? 0) - 1);
    const gap = gaps.length ? Math.min(...gaps) : 0;
    if (gap > 0) folds.set(index, gap);
    if (row.leftLineNum !== null) lastLeft = row.leftLineNum;
    if (row.rightLineNum !== null) lastRight = row.rightLineNum;
  });
  return folds;
}

/**
 * Keep only the changed rows plus `context` unchanged rows around them and number
 * each surviving block as its own hunk, so a whole-file diff reads like an IDE
 * diff: change groups separated by folded "N 行未更改" runs.
 */
export function foldContext(rows: DiffRow[], context = 3): DiffRow[] {
  const isChange = (row: DiffRow) => row.type !== 'context' && row.type !== 'empty';
  if (!rows.some(isChange)) return rows;
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (!isChange(row)) return;
    for (let near = Math.max(0, index - context); near <= Math.min(rows.length - 1, index + context); near++) keep[near] = true;
  });
  const out: DiffRow[] = [];
  let hunk = -1;
  let previous = -2;
  rows.forEach((row, index) => {
    if (!keep[index]) return;
    if (index !== previous + 1) hunk++;
    previous = index;
    out.push({ ...row, hunkIndex: hunk });
  });
  return out;
}

/** One line of the single-column diff, already carrying the sign it renders with. */
export type UnifiedLine = {
  kind: 'context' | 'add' | 'remove' | 'empty';
  /** The number on the side the line belongs to: the old file for removals, the new one otherwise. */
  lineNum: number | null;
  text: string;
  hunkIndex: number;
  changed: boolean;
};

/**
 * The lines a single-column diff shows for each paired row, in order. A replaced
 * line is the one row that becomes two lines — the old one, then the new one —
 * which is why folding stays keyed by row: `foldContext` and `diffFolds` are
 * measured on the paired rows, and this expansion runs after them.
 */
export function unifiedLines(rows: DiffRow[]): UnifiedLine[][] {
  return rows.map(row => {
    const base = { hunkIndex: row.hunkIndex, changed: row.type !== 'context' && row.type !== 'empty' };
    if (row.type === 'context') return [{ ...base, kind: 'context' as const, lineNum: row.rightLineNum ?? row.leftLineNum, text: row.right }];
    if (row.type === 'empty') return [{ ...base, kind: 'empty' as const, lineNum: null, text: row.right }];
    if (row.type === 'remove') return [{ ...base, kind: 'remove' as const, lineNum: row.leftLineNum, text: row.left }];
    if (row.type === 'add') return [{ ...base, kind: 'add' as const, lineNum: row.rightLineNum, text: row.right }];
    // A replacement reads top-down in one column: what was there, then what replaced it.
    return [
      { ...base, kind: 'remove' as const, lineNum: row.leftLineNum, text: row.left },
      { ...base, kind: 'add' as const, lineNum: row.rightLineNum, text: row.right },
    ];
  });
}

type FullDiff = { before: string[]; after: string[] };

/** Splits a single whole-file hunk (the shape the backend records) into its two file versions. */
function fullFileVersions(diff: string): FullDiff | null {
  const lines = diff.split('\n');
  const headers = lines.filter(line => line.startsWith('@@'));
  if (headers.length !== 1 || !/^@@\s+-1(?:,\d+)?\s+\+1(?:,\d+)?\s+@@/.test(headers[0])) return null;
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines.slice(lines.findIndex(item => item.startsWith('@@')) + 1)) {
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) after.push(line.slice(1));
    else if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith(' ')) { before.push(line.slice(1)); after.push(line.slice(1)); }
  }
  return { before, after };
}

const MAX_MERGE_CELLS = 4_000_000;

function lineDiff(before: string[], after: string[]) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length - 1;
  let endA = after.length - 1;
  while (endB >= start && endA >= start && before[endB] === after[endA]) { endB--; endA--; }
  const head = before.slice(0, start).map(line => ' ' + line);
  const tail = before.slice(endB + 1).map(line => ' ' + line);
  const midB = before.slice(start, endB + 1);
  const midA = after.slice(start, endA + 1);
  const mid: string[] = [];
  if (midB.length * midA.length > MAX_MERGE_CELLS) {
    midB.forEach(line => mid.push('-' + line));
    midA.forEach(line => mid.push('+' + line));
  } else {
    const table: number[][] = Array.from({ length: midB.length + 1 }, () => new Array<number>(midA.length + 1).fill(0));
    for (let i = midB.length - 1; i >= 0; i--) for (let j = midA.length - 1; j >= 0; j--) {
      table[i][j] = midB[i] === midA[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < midB.length || j < midA.length) {
      if (i < midB.length && j < midA.length && midB[i] === midA[j]) { mid.push(' ' + midB[i]); i++; j++; }
      else if (j < midA.length && (i === midB.length || table[i][j + 1] >= table[i + 1][j])) mid.push('+' + midA[j++]);
      else mid.push('-' + midB[i++]);
    }
  }
  return [...head, ...mid, ...tail];
}

/**
 * Combines the diffs of one file recorded by successive edits in a turn into a single
 * net diff (first "before" against last "after"). Concatenating them would show the
 * whole file twice. Falls back to plain concatenation for partial-hunk diffs.
 */
export function mergeFileDiffs(first: string | undefined, next: string | undefined): { diff: string; additions: number; deletions: number } | null {
  if (!first || !next) return null;
  const a = fullFileVersions(first);
  const b = fullFileVersions(next);
  if (!a || !b) return null;
  const body = lineDiff(a.before, b.after);
  const additions = body.filter(line => line.startsWith('+')).length;
  const deletions = body.filter(line => line.startsWith('-')).length;
  return { diff: `@@ -1,${a.before.length} +1,${b.after.length} @@\n${body.join('\n')}\n`, additions, deletions };
}
