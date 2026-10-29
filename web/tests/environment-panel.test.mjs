import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The panel keeps its pure logic in environment.ts so the listing rules and the
// Electron capability gate can be tested without mounting React.
const environmentSource = await readFile(new URL('../src/environment.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(environmentSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const helpers = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const panel = await readFile(new URL('../src/components/EnvironmentPanel.tsx', import.meta.url), 'utf8');
const panels = await readFile(new URL('../src/components/Panels.tsx', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/environment.css', import.meta.url), 'utf8');

test('changed and untracked entries share one list in Electron order', () => {
  const changed = [{ path: 'src/a.ts', index: ' ', workTree: 'M', status: ' M' }];
  const untracked = [{ path: 'new.txt', index: '?', workTree: '?', status: '??' }];
  assert.deepEqual(helpers.environmentEntries({ changed, untracked }).map(entry => entry.path), ['src/a.ts', 'new.txt']);
  assert.deepEqual(helpers.environmentEntries(null), []);
});

test('file status letters and tones follow the porcelain codes', () => {
  assert.equal(helpers.environmentEntryLabel({ index: ' ', workTree: 'M', path: 'a', status: ' M' }), '改');
  assert.equal(helpers.environmentEntryLabel({ index: 'M', workTree: ' ', path: 'a', status: 'M ' }), '暂');
  assert.equal(helpers.environmentEntryLabel({ index: ' ', workTree: 'D', path: 'a', status: ' D' }), '删');
  assert.equal(helpers.environmentEntryLabel({ index: '?', workTree: '?', path: 'a', status: '??' }), '新');
  assert.equal(helpers.environmentEntryTone({ index: '?', workTree: '?', path: 'a', status: '??' }), 'untracked');
  assert.equal(helpers.environmentEntryTone({ index: 'A', workTree: ' ', path: 'a', status: 'A ' }), 'added');
  assert.equal(helpers.environmentEntryTone({ index: ' ', workTree: 'D', path: 'a', status: ' D' }), 'deleted');
  assert.equal(helpers.environmentEntryTone({ index: ' ', workTree: 'M', path: 'a', status: ' M' }), 'modified');
});

// Every Git operation on a session checkout is executed by the Java backend,
// which resolves the directory from workspaceHash + sessionName.
test('all session Git operations go through the Java environment endpoints', () => {
  assert.match(panel, /\/git\/environment\/status\?\$\{query\(\{ workspaceHash, sessionName \}\)\}/);
  assert.match(panel, /\/git\/environment\/log\?\$\{query\(\{ workspaceHash, sessionName, scope, limit: 30 \}\)\}/);
  assert.match(panel, /\/git\/environment\/commit\?\$\{query\(\{ workspaceHash, sessionName \}\)\}/);
  assert.match(panel, /\/git\/environment\/toggle\?\$\{query\(\{ workspaceHash, sessionName \}\)\}/);
  assert.doesNotMatch(panel, /gitEnvironmentBridge|bridgeSupports|electronAPI/);
  assert.doesNotMatch(environmentSource, /gitEnvironmentBridge|bridgeSupports|GitEnvironmentBridge/);
  // The client never sends a path for status/commit/push.
  assert.doesNotMatch(panel, /\/git\/status\?/);
  assert.doesNotMatch(panel, /\/git\/commit\?/);
});

test('ahead/behind is summarized only when an upstream has diverged', () => {
  assert.equal(helpers.trackingSummary({ ahead: 0, behind: 0 }), '');
  assert.equal(helpers.trackingSummary({ ahead: 2, behind: 0 }), '领先 2');
  assert.equal(helpers.trackingSummary({ ahead: 0, behind: 3 }), '落后 3');
  assert.equal(helpers.trackingSummary({ ahead: 2, behind: 3 }), '领先 2 · 落后 3');
});

test('the Git tab owns the environment strip and swaps in the worktree view', () => {
  assert.match(panels, /import EnvironmentPanel, \{ EnvironmentBar, useEnvironmentController \} from '\.\/EnvironmentPanel';/);
  assert.match(panels, /<EnvironmentBar controller=\{controller\} \/>/);
  assert.match(panels, /controller\.mode\?\.worktreeMode/);
  assert.match(panels, /<EnvironmentPanel controller=\{controller\} onFile=/);
  // The standalone Environment tab is gone: Git and the session checkout share one tab.
  assert.doesNotMatch(panels, /\['environment', '环境'/);
});

test('the panel stylesheet loads with the other workbench stylesheets', () => {
  assert.match(main, /import '\.\/environment\.css';/);
  assert.match(css, /\.environment-panel/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('enabling isolation creates the worktree and rolls the mode back on failure', () => {
  assert.match(panel, /worktreeMode: enabled/);
  assert.match(panel, /api\.request\('\/git\/worktree\/create', 'POST', \{ workspaceHash, sessionName \}\)/);
  assert.match(panel, /api\.request<SessionWorktreeMode>\(url, 'PUT', \{ \.\.\.mode, worktreeMode: false \}\)/);
  assert.match(panel, /请先提交隔离分支变更/);
});

test('a new conversation can enable isolation from the home switcher row', async () => {
  const [switcher, home, app, styles] = await Promise.all([
    readFile(new URL('../src/layout/IsolationSwitch.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/layout/HomeView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ]);
  // The switch sits on the same row as the project and Agent switchers and acts
  // on the prepared draft, before the first message creates the worktree.
  assert.match(home, /: isolation\}/);
  assert.match(app, /<IsolationSwitch api=\{api\} workspaceHash=\{workspace\}/);
  assert.match(app, /preparedNewSession\.current\?\.key === agentConfigKey \? preparedNewSession\.current\.target\.name : undefined/);
  assert.match(switcher, /\/sessions\/\$\{encodeURIComponent\(sessionName\)\}\/worktree\?workspaceHash=/);
  assert.match(switcher, /worktreeMode: checked/);
  assert.match(switcher, /'\/git\/worktree\/create', 'POST', \{ workspaceHash, sessionName \}/);
  assert.match(switcher, /worktreeMode: false/);
  assert.match(switcher, /role="switch" aria-checked=\{on\}/);
  assert.match(switcher, /<span className="isolation-track"/);
  // The Git tab toggles the same flag; both views stay in sync.
  assert.match(switcher, /watchWorkspaceChanges\(workspaceHash/);
  assert.match(styles, /\.isolation-switch \{ margin-left: auto;/);
});

test('commit posts the message and selection to Java; AI generation stays on the backend', () => {
  assert.match(panel, /await api\.request\(`\/git\/environment\/commit\?\$\{query\(\{ workspaceHash, sessionName \}\)\}`, 'POST', \{ message: text, files: selected\.length \? selected : undefined \}\)/);
  assert.match(panel, /generate-environment-commit-message/);
  assert.match(panel, /AbortSignal\.timeout\(120000\)/);
});

test('the worktree change list uses the shared Git tree with staging and selection', async () => {
  assert.match(panel, /<GitChangeTree changed=\{c\.currentStatus\.changed\} untracked=\{c\.currentStatus\.untracked\}/);
  assert.match(panel, /onToggle=\{c\.stage\}/);
  // Main-checkout changes use the same tree, read-only (no staging target here).
  assert.match(panel, /<GitChangeTree readOnly changed=\{c\.mainStatus\.changed\} untracked=\{c\.mainStatus\.untracked\}/);
  assert.match(panel, /onMainFile/);
  assert.match(panel, /全选/);
  assert.match(panel, /未勾选时提交全部改动/);
  // Worktree file tabs must read the environment-scoped diff/content endpoints.
  const workspaceTabs = await readFile(new URL('../src/components/WorkspaceTabs.tsx', import.meta.url), 'utf8');
  assert.match(workspaceTabs, /\/git\/environment\/diff-content/);
  assert.match(workspaceTabs, /\/git\/environment\/working-file-content/);
});

test('history loads lazily per scope with the legacy 30-commit limit', () => {
  assert.match(panel, /\/git\/environment\/log\?\$\{query\(\{ workspaceHash, sessionName, scope, limit: 30 \}\)\}/);
  assert.match(panel, /<Segmented label="提交历史范围"/);
  assert.match(panel, /暂无提交/);
});

test('an unreadable status is never shown as a clean worktree', () => {
  // The status error branch precedes the empty ("clean") branch in both lists.
  assert.match(panel, /c\.statusError\s*\?\s*<p className="env-hint is-error">\{c\.statusError\}<\/p>/);
  assert.match(panel, /currentStatus\.dirty \? '有变更' : '干净'/);
  assert.match(panel, /setMainStatus\(undefined\); setCurrentStatus\(undefined\); setStatusError\(errorText\(cause\)\)/);
  assert.match(panel, /'读取失败'/);
});

test('unknown state fails closed instead of reading as clean or local', () => {
  // The main-project list has an explicit unknown branch before "主项目干净".
  assert.match(panel, /: !c\.mainStatus\s*\n\s*\? <p className="env-hint">正在读取主项目状态…<\/p>/);
  // A stale/unknown worktree status cannot be toggled off without a server-side clean signal.
  assert.match(panel, /const dirty = currentStatus \? currentStatus\.dirty : !!environment\?\.currentDirty/);
  assert.match(panel, /无法确认隔离分支状态，暂不能切换/);
  // A non-repo project is left to GitTools' init card, not flagged red.
  assert.match(panel, /不是 Git 仓库\|not a git repository/);
  // Pending states use the neutral pill, not the success tone.
  assert.match(panel, /' is-muted'/);
  // Both the environment query and the session key gate the fallback to GitTools.
  assert.match(panels, /key=\{`\$\{workspaceHash\}\/\$\{sessionName\}`\}/);
  assert.match(panels, /unknownSessionCheckout/);
});

test('history responses and load errors are sequenced/visible', () => {
  assert.match(panel, /const sequence = \+\+historySequence\.current/);
  assert.match(panel, /sequence !== historySequence\.current/);
  assert.match(panel, /环境信息刷新失败：\{c\.loadError\}/);
});

test('the agent run lock disables every mutating control', () => {
  assert.match(panel, /Agent 正在运行，暂不可操作/);
  for (const fragment of [
    /isDisabled=\{c\.busy \|\| c\.agentRunning \|\| !c\.mode\}/,
    /isDisabled=\{c\.busy \|\| c\.agentRunning\}/,
    /isDisabled=\{c\.busy \|\| c\.generating \|\| c\.agentRunning/,
  ]) assert.match(panel, fragment);
});
