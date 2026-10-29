// VS Code's own highlighting, shared by the file preview, the diff view and chat
// code fences. The preview mounts a real Monaco editor; the other two surfaces
// reuse Monaco's standalone colorizer, which paints the same tokens with the same
// theme without paying for an editor instance.
//
// Monaco only loads on demand (it is a multi-megabyte chunk shared with the
// legacy Vue editor), so every entry point here resolves asynchronously: content
// paints as plain text first and is repainted once the module and theme are ready.
import { useEffect, useState } from 'react';
import type * as Monaco from 'monaco-editor';

/** One token run from Monaco's colorizer: its theme classes plus the token text. */
export type ColorRun = { cls: string; text: string };
/** A colorized run once the word-level marks of a diff have been applied to it. */
export type ColorSegment = ColorRun & { changed: boolean };
export type WordMark = { text: string; changed: boolean };

type ThemeName = 'vs' | 'vs-dark';

/**
 * Colorizing is re-run on every streamed token, so very large blocks are left
 * plain rather than tokenized on each delta.
 */
export const MAX_HIGHLIGHT_CHARS = 200000;

const listeners = new Set<() => void>();
let revision = 0;
let monaco: typeof Monaco | null = null;
let loading: Promise<void> | null = null;
let theme: ThemeName | null = null;
let observing = false;

export function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function highlightThemeName(dark: boolean): ThemeName {
  return dark ? 'vs-dark' : 'vs';
}

/**
 * Monaco does not inherit the app's type scale. The preview used to render at
 * 13px of a 16px base, so the editor font is derived from the root font size,
 * which is what `--ui-scale` (App.tsx) drives.
 */
export function codeFontSize(rootFontSize: number): number {
  const base = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16;
  return Math.max(9, Math.round(base * 0.8125));
}

/** Bumped whenever already-rendered markup has to be painted again. */
export function highlightRevision(): number {
  return revision;
}

export function subscribeHighlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function repaint(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** React binding for {@link highlightRevision}: repaint on theme or type-scale changes. */
export function useHighlightRevision(): number {
  const [value, setValue] = useState(revision);
  useEffect(() => subscribeHighlight(() => setValue(highlightRevision())), []);
  return value;
}

/**
 * Load Monaco and install the global theme. Idempotent, and a no-op once loaded.
 * Callers await it rather than relying on import-time side effects, so the
 * module stays inert for unit tests that only exercise the pure helpers below.
 */
export function initHighlight(): Promise<void> {
  if (!loading) {
    loading = import('./monaco')
      .then(module => {
        monaco = module.default;
        theme = highlightThemeName(isDarkTheme());
        monaco.editor.setTheme(theme);
        watchWorkbench();
        repaint();
      })
      .catch(error => {
        loading = null;
        console.warn('[highlight] Monaco unavailable, code stays plain text:', error);
      });
  }
  return loading;
}

// The workbench switches the theme by toggling `dark` on <html> and the type
// scale by writing `--ui-scale` on the same element (App.tsx). Monaco keeps one
// global theme and does not inherit our font size, so a single observer keeps
// every editor and every colorized line in step with the app.
function watchWorkbench(): void {
  if (observing || typeof MutationObserver === 'undefined') return;
  observing = true;
  new MutationObserver(() => {
    if (!monaco) return;
    const next = highlightThemeName(isDarkTheme());
    if (next !== theme) {
      theme = next;
      monaco.editor.setTheme(next);
    }
    // Token class numbers are theme specific, so the markup has to be rebuilt
    // even when only the type scale changed.
    repaint();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
}

/**
 * A pseudo path per document. Monaco resolves the language from the file name
 * (`createByFilepathOrFirstLine`), and the scheme keeps the two sides of a diff
 * apart in Monaco's model registry.
 */
export function highlightUri(path: string, side: string): string {
  return `${side}://highlight/${String(path).replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

/**
 * Colorize `text` into one HTML line per source line, or null while Monaco is
 * unavailable (callers render plain text instead). Tab size matches the 4
 * columns the preview used before.
 */
export async function colorizeLines(text: string, uri: string): Promise<string[] | null> {
  if (text.length > MAX_HIGHLIGHT_CHARS) return null;
  await initHighlight();
  if (!monaco) return null;
  const source = text.replace(/\r\n?/g, '\n');
  try {
    const model = monaco.editor.createModel(source, undefined, monaco.Uri.parse(uri));
    const languageId = model.getLanguageId();
    model.dispose();
    const html = await monaco.editor.colorize(source, languageId, { tabSize: 4 });
    return splitColorizedLines(html, source.split('\n').length);
  } catch (error) {
    console.warn('[highlight] colorize failed, falling back to plain text:', error);
    return null;
  }
}

/**
 * Colorize a fenced code block from chat. The fence carries a language name
 * rather than a path, so it is matched against Monaco's registered ids and
 * aliases; unknown names degrade to plain text through the colorizer itself.
 */
export async function colorizeFence(code: string, languageName: string): Promise<string | null> {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  await initHighlight();
  if (!monaco) return null;
  try {
    // Tab size matches `.code-block-wrap pre { tab-size: 2 }`.
    return await monaco.editor.colorize(code, resolveLanguageName(languageName), { tabSize: 2 });
  } catch (error) {
    console.warn('[highlight] code block highlight failed, falling back to plain text:', error);
    return null;
  }
}

/** Map a markdown fence info string onto a Monaco language id. */
export function resolveLanguageName(languageName: string): string {
  const wanted = String(languageName || '').trim().toLowerCase();
  if (!wanted || !monaco) return 'plaintext';
  const registered = monaco.languages.getLanguages();
  const exact = registered.find(language => language.id.toLowerCase() === wanted);
  if (exact) return exact.id;
  const aliased = registered.find(language => (language.aliases || []).some(alias => alias.toLowerCase() === wanted));
  return aliased ? aliased.id : 'plaintext';
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers. Monaco's colorizer emits `<span class="mtkN">token</span>` runs
// separated by `<br/>`; the diff interleaves its own word-level marks with them,
// so both are parsed back into text first.
// ═══════════════════════════════════════════════════════════════════════════

/** Split a colorized document into per-line markup; null if the shape is unexpected. */
export function splitColorizedLines(html: string, lineCount: number): string[] | null {
  const parts = html.split(/<br\s*\/?>/i);
  // The renderer pushes a <br/> after the last line as well.
  if (parts.length !== lineCount + 1 || parts[parts.length - 1] !== '') return null;
  return parts.slice(0, lineCount);
}

/** Parse one colorized line back into runs; null when the markup is not what the colorizer emits. */
export function parseColorRuns(html: string): ColorRun[] | null {
  const runs: ColorRun[] = [];
  const open: string[] = [];
  let index = 0;
  const append = (text: string) => {
    if (!text) return;
    const cls = open.join(' ');
    const last = runs[runs.length - 1];
    if (last && last.cls === cls) last.text += text;
    else runs.push({ cls, text });
  };
  while (index < html.length) {
    const tag = html.indexOf('<', index);
    if (tag === -1) { append(decodeEntities(html.slice(index))); break; }
    append(decodeEntities(html.slice(index, tag)));
    const end = html.indexOf('>', tag);
    if (end === -1) return null;
    const markup = html.slice(tag, end + 1);
    if (/^<span(\s[^>]*)?>$/i.test(markup)) open.push(/class="([^"]*)"/i.exec(markup)?.[1] || '');
    else if (/^<\/span>$/i.test(markup)) { if (!open.length) return null; open.pop(); }
    // Anything else (a <br/> inside a single line, nested markup) is not a shape we can merge marks into.
    else return null;
    index = end + 1;
  }
  return open.length ? null : runs;
}

/** The plain text of a colorized line, used to diff the two sides of a replaced row. */
export function colorRunsText(runs: ColorRun[]): string {
  return runs.map(run => run.text).join('');
}

/**
 * Copy runs, splitting them wherever a word-level mark starts or ends so the
 * theme classes and the diff highlights can be rendered together. A mark list
 * that does not cover the whole line leaves the remaining text unmarked.
 */
export function splitRunsByMarks(runs: ColorRun[], marks?: WordMark[]): ColorSegment[] {
  const list = (marks || []).filter(mark => mark.text.length > 0);
  if (!list.length) return runs.map(run => ({ ...run, changed: false }));
  const segments: ColorSegment[] = [];
  let markIndex = 0;
  let consumed = 0;
  for (const run of runs) {
    let rest = run.text;
    while (rest) {
      const mark = list[markIndex];
      // A mark list that runs out first leaves the rest of the line unmarked.
      if (!mark) { segments.push({ cls: run.cls, text: rest, changed: false }); break; }
      const take = Math.min(mark.text.length - consumed, rest.length);
      segments.push({ cls: run.cls, text: rest.slice(0, take), changed: mark.changed });
      consumed += take;
      rest = rest.slice(take);
      if (consumed >= mark.text.length) { markIndex += 1; consumed = 0; }
    }
  }
  return segments;
}

/** Parse a whole colorized document into runs per line; null if any line fails to parse. */
export function parseColorizedDocument(lines: string[]): ColorRun[][] | null {
  const parsed: ColorRun[][] = [];
  for (const line of lines) {
    const runs = parseColorRuns(line);
    if (!runs) return null;
    parsed.push(runs);
  }
  return parsed;
}

// Monaco's line renderer emits `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;` and, for
// its blank-line placeholder, `&nbsp;` (kept as a non-breaking space so the
// rendered line keeps the run layout the colorizer produced).
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// React binding for colorized documents (the diff view). Returns null until
// Monaco is ready, so callers keep rendering their plain-text fallback.
// ═══════════════════════════════════════════════════════════════════════════
export function useColorizedLines(text: string, uri: string | null): ColorRun[][] | null {
  const revision = useHighlightRevision();
  const [painted, setPainted] = useState<{ text: string; lines: ColorRun[][] | null } | null>(null);
  useEffect(() => {
    if (!uri || !text) { setPainted(null); return; }
    let cancelled = false;
    void colorizeLines(text, uri).then(result => {
      if (cancelled) return;
      setPainted({ text, lines: result ? parseColorizedDocument(result) : null });
    });
    return () => { cancelled = true; };
  }, [text, uri, revision]);
  // Only the markup that belongs to *this* document: a theme or scale change
  // repaints the same text (so the pane never flashes plain), but a patch that
  // just changed must not render the previous one's tokens over its own lines.
  return painted && painted.text === text ? painted.lines : null;
}

// React binding for a fenced code block in chat. Streaming re-runs this on every
// delta; the effect cancels the previous call so only the newest markup lands.
export function useColorizedFence(code: string, languageName: string): string | null {
  const revision = useHighlightRevision();
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!code || code.length > MAX_HIGHLIGHT_CHARS) { setHtml(null); return; }
    let cancelled = false;
    void colorizeFence(code, languageName).then(result => { if (!cancelled) setHtml(result); });
    return () => { cancelled = true; };
  }, [code, languageName, revision]);
  return html;
}
