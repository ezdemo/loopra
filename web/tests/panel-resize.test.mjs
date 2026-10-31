import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Skills and plugins share one main-page entry in the sidebar.
// The right dock retains the legacy resize behaviour.
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const sidebar = await readFile(new URL('../src/layout/Sidebar.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const panels = await readFile(new URL('../src/components/Panels.tsx', import.meta.url), 'utf8');
const workbenchCss = await readFile(new URL('../src/workbench.css', import.meta.url), 'utf8');
const panelResizeSource = await readFile(new URL('../src/panel-resize.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(panelResizeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { clampPanelWidth, clampSidebarWidth, resizePanelWidth, resizeSidebarWidth } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('skills and plugins open in the main area from one sidebar entry', async () => {
  const settings = await readFile(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /SkillManager/);
  assert.doesNotMatch(settings, /ExtensionManager/);
  assert.match(sidebar, /Skills & Plugins.*技能与插件/);
  assert.match(sidebar, /onClick=\{props.onSkills\}/);
  assert.ok(sidebar.indexOf('onClick={props.onSearch}') < sidebar.indexOf('onClick={props.onSkills}'));
  assert.match(app, /skillsOpen && <SkillsAndPluginsPage/);
  assert.match(app, /const surfaceOpen = skillsOpen \|\| schedulesOpen \|\| !!pluginPage/);
  assert.match(app, /className="app-chat-workspace" hidden=\{surfaceOpen\}/);
});

test('the sidebar keeps refresh and fold-all but drops locate and sort controls', () => {
  assert.match(sidebar, /<IconButton label="刷新项目列表" onClick=\{\(\) => void props\.onRefreshAll\(\)\}><RefreshCw size="0\.875rem" \/><\/IconButton>/);
  assert.match(app, /onRefreshAll=\{\(\) => void backend\.refresh\(\)\}/);
  assert.match(sidebar, /折叠全部工作区/);
  assert.doesNotMatch(sidebar, /定位当前会话/);
  assert.doesNotMatch(sidebar, /按最新排序/);
});

test('the right workbench panel inherits the legacy drag-to-resize behaviour', () => {
  // Persisted width, the shared clamp helper, and the drag wiring.
  assert.match(panels, /useLocalState<number>\('right-panel-width'/);
  assert.match(panels, /resizePanelWidth\(startWidth, move\.clientX - startX, window\.innerWidth\)/);
  // The handle only shows while the panel is docked (>=1101px); below that it floats.
  assert.match(panels, /aria-label="拖动调整右侧面板宽度"/);
  // The docked width is inline because it follows the drag — and it doubles as the
  // distance the panel slides when it closes (`--panel-width`).
  assert.match(panels, /style=\{docked \? \(\{ width: panelWidth, flexBasis: panelWidth, '--panel-width': `\$\{panelWidth\}px` \} as CSSProperties\) : undefined\}/);
  assert.match(workbenchCss, /\.panel-resize-handle \{/);
  assert.match(workbenchCss, /cursor: ew-resize;/);
  assert.match(workbenchCss, /\.panel-resize-shield \{[^}]*position: fixed;[^}]*inset: 0;[^}]*cursor: ew-resize;/);
  assert.match(workbenchCss, /\.panel-resize-handle \{[^}]*touch-action: none;/);
});

test('panel width clamps to the legacy 240px floor and 70% viewport cap', () => {
  // Drag left far enough to exceed the cap on a 1000px viewport.
  assert.equal(resizePanelWidth(320, -900, 1000), 700);
  // Drag right past the floor.
  assert.equal(resizePanelWidth(320, 900, 1000), 240);
  // Dragging left widens; dragging right narrows.
  assert.equal(resizePanelWidth(320, -100, 1000), 420);
  assert.equal(resizePanelWidth(320, 100, 1000), 240);
  // A tiny viewport still leaves the floor reachable instead of collapsing.
  assert.equal(clampPanelWidth(600, 200), 240);
});

test('the left sidebar drags wider between 180px and 480px', () => {
  assert.equal(resizeSidebarWidth(240, 96, 1600), 336);
  assert.equal(resizeSidebarWidth(300, -300, 1600), 180);
  assert.equal(clampSidebarWidth(100, 1600), 180);
  assert.equal(clampSidebarWidth(900, 1600), 480);
  // Narrow windows cap the sidebar at 45% of the viewport.
  assert.equal(clampSidebarWidth(900, 800), 360);
});

test('the sidebar resize handle persists its width', () => {
  assert.match(sidebar, /useLocalState<number>\('sidebar-width', DEFAULT_SIDEBAR_WIDTH\)/);
  assert.match(sidebar, /resizeSidebarWidth\(startWidth, move\.clientX - startX, window\.innerWidth\)/);
  assert.match(sidebar, /className=\{`sidebar-resize-handle/);
  assert.match(sidebar, /role="separator" aria-orientation="vertical"/);
  assert.match(styles, /\.sidebar-resize-handle \{/);
  assert.match(styles, /cursor: col-resize;/);
  assert.match(styles, /margin-left: calc\(-1 \* var\(--sidebar-width, 15rem\)\)/);
});
