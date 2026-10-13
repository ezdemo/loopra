import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { diffHunkCount, parseSideBySide } from '../diff';

// Side-by-side unified diff with hunk navigation, ported from the legacy DiffViewer.
export default function DiffView({ diff }: { diff?: string }) {
  const rows = useMemo(() => parseSideBySide(diff), [diff]);
  const hunkCount = diffHunkCount(rows);
  const [active, setActive] = useState(-1);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { setActive(-1); if (body.current) body.current.scrollTop = 0; }, [diff]);
  function navigate(direction: number) {
    const next = active + direction;
    if (next < 0 || next >= hunkCount) return;
    setActive(next);
    const target = body.current?.querySelector(`[data-hunk-index="${next}"][data-change="true"]`) || body.current?.querySelector(`[data-hunk-index="${next}"]`);
    if (!body.current || !target) return;
    // Compensate for the sticky "旧版本 / 新版本" header so the row lands below it.
    const headerHeight = body.current.querySelector('.diff-sbs-header')?.clientHeight || 0;
    const top = body.current.scrollTop + target.getBoundingClientRect().top - body.current.getBoundingClientRect().top - headerHeight - 8;
    body.current.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function handleScroll() {
    const element = body.current;
    if (!element || !hunkCount) return;
    const headerHeight = element.querySelector('.diff-sbs-header')?.clientHeight || 0;
    const limit = element.getBoundingClientRect().top + headerHeight + 8;
    let index = -1;
    for (const row of element.querySelectorAll('[data-change="true"]')) {
      if (row.getBoundingClientRect().top > limit) break;
      index = Number((row as HTMLElement).dataset.hunkIndex);
    }
    setActive(index);
  }
  if (!diff) return <p className="panel-empty">该文件没有未提交的改动。</p>;
  if (!rows.length) return <pre className="workspace-preview-raw" tabIndex={0}>{diff}</pre>;
  return <>
    <div className="diff-hunk-nav" aria-label="差异块导航">
      <button type="button" aria-label="上一个差异块" title="上一个差异块" disabled={active <= 0} onClick={() => navigate(-1)}><ChevronLeft size={14} /></button>
      <span className="diff-hunk-position">{active + 1}/{hunkCount}</span>
      <button type="button" aria-label="下一个差异块" title="下一个差异块" disabled={active >= hunkCount - 1} onClick={() => navigate(1)}><ChevronRight size={14} /></button>
    </div>
    <div className="diff-sbs" ref={body} onScroll={handleScroll}>
      <div className="diff-sbs-header"><span className="diff-sbs-label">旧版本</span><span className="diff-sbs-label">新版本</span></div>
      {rows.map((row, index) => <div key={index} className={`diff-sbs-row diff-sbs-${row.type}`} data-hunk-index={row.hunkIndex} data-change={row.type !== 'context' && row.type !== 'empty'}>
        <div className="diff-sbs-cell"><span className="diff-sbs-ln">{row.leftLineNum ?? ''}</span><span className="diff-sbs-code">{row.left}</span></div>
        <div className="diff-sbs-cell"><span className="diff-sbs-ln">{row.rightLineNum ?? ''}</span><span className="diff-sbs-code">{row.right}</span></div>
      </div>)}
    </div>
  </>;
}
