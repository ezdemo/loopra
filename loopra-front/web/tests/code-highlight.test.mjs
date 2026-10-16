import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// The real highlighting module: it only reaches for Monaco inside initHighlight,
// so the parsing helpers below run without a browser (or a worker).
const source = await readFile(new URL('../src/highlight.ts', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react') })) {
  outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const {
  codeFontSize, colorRunsText, decodeEntities, highlightThemeName, highlightUri, parseColorRuns,
  parseColorizedDocument, resolveLanguageName, splitColorizedLines, splitRunsByMarks,
} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('each side of a diff is colorized as its own document', () => {
  assert.equal(highlightUri('web/src/a.ts', 'old'), 'old://highlight/web/src/a.ts');
  // Windows separators and a leading slash are normalized so the same file is one
  // document per side rather than one per separator style.
  assert.equal(highlightUri('C:\\repo\\a.ts', 'new'), 'new://highlight/C:/repo/a.ts');
  assert.equal(highlightUri('/abs/a.ts', 'old'), 'old://highlight/abs/a.ts');
  // The two sides hold different text, so they may never share a document.
  assert.notEqual(highlightUri('a.ts', 'old'), highlightUri('a.ts', 'new'));
});

const { wordDiff } = await import('data:text/javascript;base64,' + Buffer.from(
  ts.transpileModule(await readFile(new URL('../src/diff.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText,
).toString('base64'));

// Monaco renders tokens as <span class="mtkN"> runs and ends every line with
// <br/> — including a trailing one, which is why the split is strict about the
// line count instead of trusting whatever the colorizer returned.
const colorized = '<span class="mtk5">const</span> total = <span class="mtk9">1</span>;<br/><span class="mtk1">  return total &amp;&amp; `a&lt;b`;</span><br/>';

test('a colorized document is split back into one markup string per source line', () => {
  assert.deepEqual(splitColorizedLines(colorized, 2), [
    '<span class="mtk5">const</span> total = <span class="mtk9">1</span>;',
    '<span class="mtk1">  return total &amp;&amp; `a&lt;b`;</span>',
  ]);
  // Fewer or more rendered lines than the document has means we cannot map marks
  // onto it, so the caller falls back to plain text.
  assert.equal(splitColorizedLines(colorized, 3), null);
  assert.equal(splitColorizedLines(colorized, 1), null);
  assert.equal(splitColorizedLines('<span class="mtk1">x</span>', 1), null);
});

test('marked-up lines become runs that keep their theme classes and text', () => {
  assert.deepEqual(parseColorRuns('<span class="mtk5">const</span> total = <span class="mtk9">1</span>;'), [
    { cls: 'mtk5', text: 'const' },
    { cls: '', text: ' total = ' },
    { cls: 'mtk9', text: '1' },
    { cls: '', text: ';' },
  ]);
  // Nested styling (bold/italic tokens wrap their base class) survives, and
  // entities are decoded so the text matches what a source line would hold.
  assert.deepEqual(parseColorRuns('<span class="mtki"><span class="mtk12">&amp;&amp; &#39;x&#39;</span></span>'), [
    { cls: 'mtki mtk12', text: "&& 'x'" },
  ]);
  // Anything that is not a plain span run is refused rather than half-parsed.
  assert.equal(parseColorRuns('<span class="mtk5">const</span><br/>'), null);
  assert.equal(parseColorRuns('<span class="mtk5">const'), null);
  assert.equal(parseColorRuns('</span>'), null);
  assert.equal(parseColorRuns('<span class="mtk5">const</span></span>'), null);
  assert.deepEqual(parseColorRuns(''), []);
});

test('a document whose lines all parse yields runs per line, otherwise nothing', () => {
  const lines = splitColorizedLines(colorized, 2);
  assert.deepEqual(parseColorizedDocument(lines).map(colorRunsText), ['const total = 1;', '  return total && `a<b`;']);
  assert.equal(parseColorizedDocument(['<span class="mtk1">ok</span>', '<b>no</b>']), null);
});

test('word-level marks split the colorized runs at their boundaries', () => {
  const runs = [
    { cls: 'mtk5', text: 'const ' },
    { cls: 'mtk1', text: 'total = price * ' },
    { cls: 'mtk9', text: '2;' },
  ];
  const marks = wordDiff('const total = price * 2;', 'const total = price * qty;').left;
  const segments = splitRunsByMarks(runs, marks);
  assert.deepEqual(segments, [
    { cls: 'mtk5', text: 'const ', changed: false },
    { cls: 'mtk1', text: 'total = price * ', changed: false },
    { cls: 'mtk9', text: '2', changed: true },
    { cls: 'mtk9', text: ';', changed: false },
  ]);
  // No marks (unchanged/added/removed rows) leaves the tokens untouched.
  assert.deepEqual(splitRunsByMarks(runs).map(segment => segment.changed), [false, false, false]);
  // A mark list that stops short only un-marks the tail; it never drops text.
  assert.deepEqual(splitRunsByMarks(runs, [{ text: 'const ', changed: true }]).map(segment => segment.text).join(''), 'const total = price * 2;');
  assert.deepEqual(splitRunsByMarks(runs, [{ text: '', changed: true }]).map(segment => segment.changed), [false, false, false]);
});

test('entity decoding mirrors what the colorizer escapes', () => {
  assert.equal(decodeEntities('a &amp;&amp; b'), 'a && b');
  assert.equal(decodeEntities('&lt;div&gt;'), '<div>');
  assert.equal(decodeEntities('&quot;x&quot; &#39;y&#39;'), '"x" \'y\'');
  assert.equal(decodeEntities('&nbsp;'), ' ');
  assert.equal(decodeEntities('100% plain'), '100% plain');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('theme, type scale and language fallbacks follow the workbench', () => {
  assert.equal(highlightThemeName(true), 'vs-dark');
  assert.equal(highlightThemeName(false), 'vs');
  // The preview used to render 13px on a 16px root; --ui-scale scales the root.
  assert.equal(codeFontSize(16), 13);
  assert.equal(codeFontSize(24), 20);
  assert.equal(codeFontSize(Number.NaN), 13);
  assert.equal(codeFontSize(0), 13);
  // Without Monaco (or an unknown fence) blocks stay plain text.
  assert.equal(resolveLanguageName('typescript'), 'plaintext');
  assert.equal(resolveLanguageName(''), 'plaintext');
});
