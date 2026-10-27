import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Legacy GitPanel.vue let the user create the first commit while initializing,
// and rendered the diff through the side-by-side DiffViewer component.
const gitTools = await readFile(new URL('../src/components/GitTools.tsx', import.meta.url), 'utf8');
const panels = await readFile(new URL('../src/components/Panels.tsx', import.meta.url), 'utf8');
const workspaceTabs = await readFile(new URL('../src/components/WorkspaceTabs.tsx', import.meta.url), 'utf8');

const modelsSource = await readFile(new URL('../src/git-models.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(modelsSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { groupGitModels, gitModelValue, gitModelFromValue, gitModelKnown } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('git init can create the initial commit like the legacy panel', () => {
  assert.match(gitTools, /初始化后创建首次提交/);
  assert.match(gitTools, /initialCommit: initCommit/);
  assert.match(gitTools, /useState\(true\)/);
});

test('the git tab opens a main workspace tab with original code and inline Git changes', () => {
  assert.match(panels, /onFile=\{path => onOpenFile\(\{ path, mode: 'diff' \}\)\}/);
  assert.match(workspaceTabs, /<CodeViewer path=\{file\.path\} content=\{content\} gitDiff=\{gitDiff\} active=\{active\} \/>/);
  assert.doesNotMatch(workspaceTabs, /<UnifiedDiff/);
});

test('git commit models group by channel with a round-tripping option value', () => {
  const grouped = groupGitModels([
    { name: 'deepseek-v4.1-flash', channelId: 'kimi', channelName: 'Kimi Code · DeepSeek', active: true },
    { name: 'gpt-6-sol', channelId: 'kimi', channelName: 'Kimi Code · DeepSeek' },
    { name: 'claude', channelId: 'cpa', channelName: 'CPA' },
    { name: '', channelId: 'kimi' },
  ]);
  assert.deepEqual(grouped.map(channel => [channel.id, channel.name, channel.models.length]), [['kimi', 'Kimi Code · DeepSeek', 2], ['cpa', 'CPA', 1]]);
  // channelId::name round-trips, and clearing the option restores "inherit".
  assert.equal(gitModelValue('gpt-6-sol', 'kimi'), 'kimi::gpt-6-sol');
  assert.deepEqual(gitModelFromValue('kimi::gpt-6-sol'), { modelChannelId: 'kimi', model: 'gpt-6-sol' });
  assert.deepEqual(gitModelFromValue(''), { modelChannelId: '', model: '' });
  // A saved model that is no longer selectable (or blank) is reported as unknown.
  assert.equal(gitModelKnown(grouped.flatMap(channel => channel.models), 'claude', 'cpa'), true);
  assert.equal(gitModelKnown(grouped.flatMap(channel => channel.models), 'claude', 'kimi'), false);
  assert.equal(gitModelKnown([], 'ghost', ''), false);
  assert.equal(gitModelKnown([], '', ''), true);
});

test('the git panel renders the grouped commit-model picker', () => {
  assert.match(gitTools, /groupGitModels\(models\.data\?\.models\)/);
  assert.match(gitTools, /<optgroup/);
  assert.match(gitTools, /aria-label="生成模型"/);
});

test('git history renders relative dates and the author config can reload from the environment', () => {
  // Legacy GitPanel.vue formatted history dates via fmtRelative(c.date).
  assert.match(gitTools, /function fmtRelative\(/);
  assert.match(gitTools, /fmtRelative\(commit\.date\)/);
  assert.match(gitTools, /title=\{commit\.date\}/);
  // Legacy handleFetchGitConfig re-read the author config from GET /git/config.
  assert.match(gitTools, /从现有环境获取/);
  assert.match(gitTools, /await api\.request<Record<string, string>>\(`\/git\/config\?\$\{suffix\}`\)/);
});

// Legacy GitPanel.vue had a 「恢复默认」 button that reset the commit author to
// Loopra's defaults (backend GitService.DEFAULT_AUTHOR_*) and persisted them.
test('the git author config offers a reset to Loopra defaults', () => {
  assert.match(gitTools, /const DEFAULT_GIT_AUTHOR = \{ authorName: 'Loopra', authorEmail: '[^']*', model: '', modelChannelId: '' \}/);
  assert.match(gitTools, /async function resetAuthor\(\) \{ setAuthor\(DEFAULT_GIT_AUTHOR\); await act\('config', DEFAULT_GIT_AUTHOR\); \}/);
  assert.match(gitTools, /onPress=\{\(\) => void resetAuthor\(\)\}>恢复默认<\/Button>/);
});
test('message cards keep saved patches while workspace tabs use live file contents', async () => {
  const blockRenderer = await readFile(new URL('../src/components/BlockRenderer.tsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(blockRenderer, /onDiff\?: \(path: string, diff\?: string\) => void/);
  // Saved patches stay in the message card; the file tab always shows the live original.
  assert.match(blockRenderer, /<UnifiedDiff diff=\{change\.diff\} path=\{change\.path\} \/>/);
  assert.match(blockRenderer, /onDiff\(change\.path, change\.diff\)/);
  assert.match(app, /function openDiff\(path: string, storedDiff\?: string\)/);
  assert.match(app, /openFile\(\{ path, mode: 'diff', diff: storedDiff \}\)/);
  assert.doesNotMatch(workspaceTabs, /file\.mode|file\.diff/);
  assert.match(workspaceTabs, /\/git\/working-file-content/);
});
