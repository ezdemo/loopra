import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Skills remain available in settings after simplifying the sidebar.
// The right dock retains the legacy resize behaviour.
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const sidebar = await readFile(new URL('../src/layout/Sidebar.tsx', import.meta.url), 'utf8');
const panels = await readFile(new URL('../src/components/Panels.tsx', import.meta.url), 'utf8');
const workbenchCss = await readFile(new URL('../src/workbench.css', import.meta.url), 'utf8');
const panelResizeSource = await readFile(new URL('../src/panel-resize.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(panelResizeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { clampPanelWidth, resizePanelWidth } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('skills remain available in settings after removing the sidebar shortcut', async () => {
  const settings = await readFile(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /tab === '技能' && <SkillManager/);
  assert.doesNotMatch(app, /onClick=\{\(\) => openSettings\('技能'\)\}/);
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
