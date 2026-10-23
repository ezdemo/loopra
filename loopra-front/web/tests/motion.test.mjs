import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Open/close motion for the hand-rolled surfaces. Menus and disclosures still mount
// only while open (`Popup`/`Collapse` render `open ? … : null`), so a mount keyframe
// plays on open. The two sidebars slide BOTH ways instead: their transition lives on
// the element and `usePresence` holds them mounted for the exit half. All of it stays
// plain CSS (plus that one timer) so the html[data-motion="off"] and
// prefers-reduced-motion kill switches in motion.css stay authoritative.
const motion = await readFile(new URL('../src/motion.css', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const composer = await readFile(new URL('../src/composer.css', import.meta.url), 'utf8');
const chatBlocks = await readFile(new URL('../src/chat-blocks.css', import.meta.url), 'utf8');
const markdown = await readFile(new URL('../src/components/Markdown.tsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const panels = await readFile(new URL('../src/components/Panels.tsx', import.meta.url), 'utf8');
const motionTsx = await readFile(new URL('../src/components/Motion.tsx', import.meta.url), 'utf8');

function ruleBody(css, selector) {
  // Anchored at line start (allowing the indent of a media-query rule) so that
  // `.code-preview {` cannot match inside `.content-collapse, .code-preview {`.
  const pattern = new RegExp('^[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'm');
  const match = css.match(pattern);
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test('surface-pop-in is the only shell keyframe left', () => {
  assert.match(motion, /@keyframes surface-pop-in \{/);
  // The one-way slide/fade keyframes were replaced by transitions, which are the
  // only thing that can run on the way out.
  for (const name of ['surface-slide-left', 'surface-slide-right', 'overlay-fade-in']) {
    assert.doesNotMatch(motion, new RegExp(`@keyframes ${name}`), `stale @keyframes ${name}`);
  }
});

test('every Collapse body pops in when it opens', () => {
  // One rule covers the assistant 用时/思考/工具 detail, 展开全部, sidebar groups and
  // the composer model groups, since they all render through `Collapse`.
  assert.match(ruleBody(motion, '.content-collapse'), /animation: surface-pop-in 0\.15s ease-out;/);
});

test('menus pop in on open, except the typing-driven suggestion list', () => {
  assert.match(ruleBody(styles, '.popup'), /animation: surface-pop-in 0\.15s ease-out;/);
  assert.match(ruleBody(composer, '.composer-popover:not(.composer-suggestions)'), /animation: surface-pop-in 0\.15s ease-out;/);
  // The suggestion list re-mounts per keystroke, so it must never replay motion.
  assert.doesNotMatch(ruleBody(composer, '.composer-suggestions'), /animation:/);
});

test('the sidebars slide both ways through one shared Bézier', () => {
  assert.match(motion, /--panel-slide-duration: 300ms;/);
  assert.match(motion, /--panel-slide-ease: cubic-bezier\(\.32, \.72, 0, 1\);/);

  for (const [selector, axis, distance] of [
    ['.sidebar', 'margin-left', 'calc\\(-1 \\* var\\(--sidebar-width, 15rem\\)\\)'],
    ['.changes-panel', 'margin-right', 'calc\\(-1 \\* var\\(--panel-width, 26rem\\)\\)'],
  ]) {
    const open = ruleBody(styles, selector);
    assert.match(open, new RegExp(`transition: ${axis} var\\(--panel-slide-duration\\) var\\(--panel-slide-ease\\)`));
    // Width/flex-basis must never animate: that reflows the whole workbench every
    // frame and feeds transient widths into the panel-resize measurement. Moving the
    // panel's box instead keeps its content rigid, so it reads as a slide.
    assert.doesNotMatch(open, /transition:[^;]*(?:width|flex-basis)/);
    const closed = ruleBody(styles, `${selector}[data-open="false"]`);
    assert.match(closed, new RegExp(`${axis}: ${distance};`));
    // Off-screen panels must leave the tab order and the accessibility tree.
    assert.match(closed, /visibility: hidden;/);
  }
});

test('the panels mount off-screen so the opening slide needs no JS frame', () => {
  const starting = styles.match(/@starting-style \{([\s\S]*?)\n\}/)[1];
  assert.match(starting, /\.sidebar \{ margin-left: calc\(-1 \* var\(--sidebar-width, 15rem\)\); \}/);
  assert.match(starting, /\.changes-panel \{ margin-right: calc\(-1 \* var\(--panel-width, 26rem\)\); \}/);
  assert.match(starting, /\.sidebar-backdrop\[data-open="true"\], \.workbench-backdrop\[data-open="true"\] \{ opacity: 0; \}/);
});

test('a closing panel stays mounted for the length of its exit slide', () => {
  // Without this the element is gone before its transition can play.
  assert.match(app, /const sidebarMounted = usePresence\(sidebar\);/);
  assert.match(app, /const changesMounted = usePresence\(changes\);/);
  assert.match(app, /\{sidebarMounted && <Sidebar open=\{sidebar\}/);
  assert.match(app, /\{!chatMode && changesMounted && <ChangesPanel open=\{changes\}/);
  // `data-open` is what every CSS state above keys off.
  assert.match(motionTsx, /<aside className="sidebar" data-open=\{open\}/);
  assert.match(panels, /data-open=\{open\}/);
  // The timer must not drift from the CSS duration it mirrors.
  const cssMs = Number(motion.match(/--panel-slide-duration: (\d+)ms/)[1]);
  assert.match(motionTsx, new RegExp(`PANEL_SLIDE_MS = ${cssMs};`));
});

test('both backdrops fade with their panel instead of popping', () => {
  assert.match(ruleBody(styles, '.sidebar-backdrop'), /transition: opacity var\(--panel-slide-duration\) var\(--panel-slide-ease\), visibility 0s/);
  assert.match(ruleBody(styles, '.sidebar-backdrop[data-open="true"]'), /opacity: 1; visibility: visible;/);
  // The workbench backdrop is `display: none` while the panel is docked, so only the
  // overlay layout carries the fade. It is an invisible click-catcher, so the chat
  // behind an open panel is never dimmed.
  assert.match(styles, /\.workbench-backdrop \{ display: block;[^}]*background: transparent;[^}]*transition: opacity var\(--panel-slide-duration\)/);
  assert.match(ruleBody(styles, '.workbench-backdrop[data-open="true"]'), /opacity: 1; visibility: visible;/);
});

test('the code block expands through a height transition', () => {
  const preview = ruleBody(motion, '.code-preview');
  assert.match(preview, /transition: height 0\.25s ease;/);
  // Without this, `height: auto` cannot take part in the transition (Chromium 129+
  // in the shipped Electron; elsewhere the declaration is ignored and the block
  // opens instantly, which is the previous behaviour).
  assert.match(preview, /interpolate-size: allow-keywords;/);
  assert.match(ruleBody(motion, '.code-block-wrap.collapsed .code-preview'), /height: 11\.0625rem;/);
  // The height has to come from CSS, not an inline style, or it cannot tween. It
  // stays unscoped so `Markdown` outside `.loopra-conversation` (plan review,
  // requirement board) keeps clipping long blocks the way the inline style did.
  assert.doesNotMatch(markdown, /style=\{\{ height: lines/);
  assert.doesNotMatch(chatBlocks, /\.loopra-conversation \.code-block-wrap(?:\.collapsed)? \.code-preview \{[^}]*height:/);
});

test('the motion kill switches still disable all of it', () => {
  assert.match(motion, /html\[data-motion="off"\] \*,/);
  assert.match(motion, /animation: none !important; transition: none !important/);
  assert.match(motion, /@media \(prefers-reduced-motion: reduce\)/);
});
