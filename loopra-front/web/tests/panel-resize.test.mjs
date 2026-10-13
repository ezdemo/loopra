import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Legacy Sidebar.vue exposed a 「技能」 shortcut that opened the skill market,
// and legacy RightPanel.vue let the right dock be dragged and remembered its
// width. The React shell had neither, so both are re-checked here.
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const panels = await readFile(new URL('../src/components/Panels.tsx', import.meta.url), 'utf8');
const workbenchCss = await readFile(new URL('../src/workbench.css', import.meta.url), 'utf8');
const panelResizeSource = await readFile(new URL('../src/panel-resize.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(panelResizeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { clampPanelWidth, resizePanelWidth } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('the sidebar exposes the legacy skill-market shortcut', () => {
  assert.match(app, /<button onClick=\{\(\) => openSettings\('技能'\)\}><Sparkles size="1\.1875rem" \/>\{preferences\.language === 'English' \? 'Skills' : '技能'\}<\/button>/);
  // Sparkles is imported from lucide so the shortcut has its icon.
  assert.match(app, /import \{[^}]*\bSparkles\b[^}]*\} from 'lucide-react';/);
});

test('the sidebar exposes the legacy refresh-projects control', () => {
  assert.match(app, /<IconButton label="刷新项目列表" onClick=\{\(\) => void backend\.refresh\(\)\}><RefreshCw size="0\.875rem" \/><\/IconButton>/);
});

test('the right workbench panel inherits the legacy drag-to-resize behaviour', () => {
  // Persisted width, the shared clamp helper, and the drag wiring.
  assert.match(panels, /useLocalState<number>\('right-panel-width'/);
  assert.match(panels, /resizePanelWidth\(startWidth, move\.clientX - startX, window\.innerWidth\)/);
  // The handle only shows while the panel is docked (>=1101px); below that it floats.
  assert.match(panels, /aria-label="拖动调整右侧面板宽度"/);
  assert.match(panels, /style=\{docked \? \{ width: panelWidth, flexBasis: panelWidth \} : undefined\}/);
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
