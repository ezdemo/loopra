import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { diffFolds, diffHunkCount, foldContext, parseDiffRows, unifiedLines, wordDiff, type UnifiedLine, type WordSegment } from '../diff';
import { colorRunsText, highlightUri, splitRunsByMarks, useColorizedLines, type ColorRun } from '../highlight';

// The single-column diff every surface shares: a line-number gutter and a sign
// column on the left, the whole row tinted (green added, red removed), untouched
// runs folded to a "N 行未更改" marker, and a replaced line shown as the old line
// above the new one with the changed words marked inside both. The same component
// renders in the workspace pane and inline in a chat message.
const SIGN: Record<UnifiedLine['kind'], string> = { context: ' ', add: '+', remove: '-', empty: '' };

function Code({ text, segments }: { text: string; segments?: WordSegment[] }) {
  if (!segments) return <>{text}</>;
  return <>{segments.map((part, index) => part.changed ? <mark key={index} className="diff-word">{part.text}</mark> : part.text)}</>;
}

// Lines painted by Monaco's colorizer keep VS Code's token colours and carry the
// same word-level marks the plain-text path renders.
function PaintedCode({ runs, marks }: { runs: ColorRun[]; marks?: WordSegment[] }) {
  return <>{splitRunsByMarks(runs, marks).map((segment, index) => segment.changed
    ? <mark key={index} className="diff-word">{segment.cls ? <span className={segment.cls}>{segment.text}</span> : segment.text}</mark>
    : <span key={index} className={segment.cls || undefined}>{segment.text}</span>)}</>;
}

export default function UnifiedDiff({ diff, path, context = 3, nav = false, emptyText }: {
  diff?: string;
  /** The file the patch belongs to: Monaco resolves the language from its name. */
  path?: string;
  /** Unchanged lines kept around each change group. */
  context?: number;
  /** Show the previous/next change-group navigator (the workspace pane asks for it). */
  nav?: boolean;
  /** Shown when there is no patch at all; without it the component renders nothing. */
  emptyText?: string;
}) {
  // Folding runs on the paired rows, before they are expanded into lines: the
  // context window and the "N 行未更改" counts are measured in rows and lines,
  // not in the lines a replacement expands into.
  const rows = useMemo(() => foldContext(parseDiffRows(diff), context), [diff, context]);
  const lines = useMemo(() => unifiedLines(rows), [rows]);
  const folds = useMemo(() => diffFolds(rows), [rows]);
  // Each side is colorized as one document and read back per row, so both halves
  // of a replaced line keep the colours of the file they came from.
  const oldText = useMemo(() => rows.map(row => row.left).join('\n'), [rows]);
  const newText = useMemo(() => rows.map(row => row.right).join('\n'), [rows]);
  const oldRuns = useColorizedLines(oldText, path ? highlightUri(path, 'old') : null);
  const newRuns = useColorizedLines(newText, path ? highlightUri(path, 'new') : null);
  // Word marks are diffed on the *rendered* text when tokens are painted: the
  // colorizer expands tabs, so offsets no longer match the source line.
  const marks = useMemo(() => rows.map((row, index) => {
    if (row.type !== 'replace') return null;
    const old = oldRuns?.[index];
    const next = newRuns?.[index];
    return old && next ? wordDiff(colorRunsText(old), colorRunsText(next)) : wordDiff(row.left, row.right);
  }), [rows, oldRuns, newRuns]);
  // Which runs each half renders from. A replacement is painted only when *both*
  // halves are colorized: its marks were measured on the colorized texts, so
  // painting one half from raw text would put them at the wrong offsets.
  const painted = useMemo(() => rows.map((row, index) => {
    const old = oldRuns?.[index];
    const next = newRuns?.[index];
    return row.type === 'replace' && !(old && next) ? { old: undefined, next: undefined } : { old, next };
  }), [rows, oldRuns, newRuns]);
  const hunkCount = diffHunkCount(rows);
  const [active, setActive] = useState(-1);
  const body = useRef<HTMLDivElement>(null);
  // A different file starts at the top; a patch that merely grows under the reader
  // (a streaming edit, a refresh of the same file) keeps its place, and only the
  // current-hunk marker resets.
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = 0; }, [path]);
  useLayoutEffect(() => { setActive(-1); }, [diff]);
  function navigate(direction: number) {
    const next = active + direction;
    if (next < 0 || next >= hunkCount) return;
    setActive(next);
    const target = body.current?.querySelector(`[data-hunk-index="${next}"][data-change="true"]`) || body.current?.querySelector(`[data-hunk-index="${next}"]`);
    if (!body.current || !target) return;
    const top = body.current.scrollTop + target.getBoundingClientRect().top - body.current.getBoundingClientRect().top - 8;
    body.current.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  // The navigator sits outside the scroll container, so no sticky header has to
  // be compensated for; the first change at or above the top edge is the current one.
  function handleScroll() {
    const element = body.current;
    if (!element || !hunkCount) return;
    const limit = element.getBoundingClientRect().top + 8;
    let index = -1;
    for (const line of element.querySelectorAll('[data-change="true"]')) {
      if (line.getBoundingClientRect().top > limit) break;
      index = Number((line as HTMLElement).dataset.hunkIndex);
    }
    setActive(index);
  }
  if (!diff) return emptyText ? <p className="panel-empty">{emptyText}</p> : null;
  // A patch we cannot read as hunks (a binary diff, a truncated stream) still
  // shows, as the raw patch rather than nothing.
  if (!rows.length) return <pre className="workspace-preview-raw" tabIndex={0}>{diff}</pre>;
  return <>
    {nav && <div className="diff-hunk-nav" aria-label="差异块导航">
      <button type="button" aria-label="上一个差异块" title="上一个差异块" disabled={active <= 0} onClick={() => navigate(-1)}><ArrowUp size={14} /></button>
      <button type="button" aria-label="下一个差异块" title="下一个差异块" disabled={active >= hunkCount - 1} onClick={() => navigate(1)}><ArrowDown size={14} /></button>
      <span className="diff-hunk-position">{hunkCount} 处差异{active >= 0 ? ` · 当前 ${active + 1}` : ''}</span>
    </div>}
    <div className="unified-diff" ref={body} onScroll={nav ? handleScroll : undefined}>
      {rows.map((_row, index) => <Fragment key={index}>
        {folds.has(index) && <div className="unified-diff-fold" aria-label={`${folds.get(index)} 行未更改`}><span>⋯ {folds.get(index)} 行未更改</span></div>}
        {lines[index].map((line, offset) => {
          const mark = marks[index];
          // Removal lines are painted from the old file, everything else from the new one.
          const runs = line.kind === 'remove' ? painted[index].old : painted[index].next;
          const segments = line.kind === 'empty' || !mark ? undefined : line.kind === 'remove' ? mark.left : mark.right;
          return <div key={offset} className={`unified-diff-line unified-diff-${line.kind}`} data-hunk-index={line.hunkIndex} data-change={line.changed}>
            <span className="unified-diff-gutter"><span className="unified-diff-ln">{line.lineNum ?? ''}</span><span className="unified-diff-sign">{SIGN[line.kind]}</span></span>
            <span className="unified-diff-code">{runs && line.kind !== 'empty' ? <PaintedCode runs={runs} marks={segments} /> : <Code text={line.text} segments={segments} />}</span>
          </div>;
        })}
      </Fragment>)}
    </div>
  </>;
}
