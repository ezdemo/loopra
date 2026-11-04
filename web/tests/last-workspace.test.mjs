import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/last-workspace.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { LAST_WORKSPACE_KEY, lastWorkspaceChoice, preferredWorkspace, readLastWorkspace, initialWorkspaceSelection, workspaceSelectionReducer, writeLastWorkspace } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

function memory() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const projects = [
  { hash: '__loopra_chat__', path: '', name: '纯聊天' },
  { hash: 'looprax', path: 'C:\\code\\looprax' },
  { hash: 'other', path: 'C:\\code\\other' },
];

test('a live selection wins over the remembered project and the configured path', () => {
  assert.equal(preferredWorkspace('other', projects, 'looprax', 'C:\\code\\looprax'), 'other');
});

test('the next visit restores the last selected project ahead of the configured default', () => {
  assert.equal(preferredWorkspace('', projects, 'other', 'C:\\code\\looprax'), 'other');
  assert.equal(preferredWorkspace('missing', projects, '__loopra_chat__', 'C:\\code\\looprax'), '__loopra_chat__');
});

test('a removed project falls back to the configured path, then the first entry', () => {
  assert.equal(preferredWorkspace('', projects, 'gone', 'C:\\code\\looprax'), 'looprax');
  assert.equal(preferredWorkspace('', projects, 'gone', 'C:\\missing'), '__loopra_chat__');
  assert.equal(preferredWorkspace('gone', [], 'other', 'C:\\code\\looprax'), 'gone');
});

test('the service record outranks the browser cache and falls back when the service has none', () => {
  assert.equal(lastWorkspaceChoice('other', 'looprax'), 'looprax');
  assert.equal(lastWorkspaceChoice('other', ''), 'other');
  assert.equal(lastWorkspaceChoice('', ''), '');
});

test('a record for a deleted project does not block the other record', () => {
  const live = hash => hash === 'other' || hash === 'looprax';
  // The service remembers a project that no longer exists: the cached one still applies.
  assert.equal(lastWorkspaceChoice('other', 'gone', live), 'other');
  // Both are gone, so nothing is remembered and the caller falls back further.
  assert.equal(lastWorkspaceChoice('cached-gone', 'gone', live), '');
  assert.equal(lastWorkspaceChoice('other', '', live), 'other');
});

test('a service record for a removed project falls back to the browser cache', () => {
  const live = hash => projects.some(item => item.hash === hash);
  // The cached project still exists, so a deleted service record does not send the
  // page all the way back to the configured default.
  assert.equal(preferredWorkspace('', projects, lastWorkspaceChoice('other', 'gone', live), 'C:\\code\\looprax'), 'other');
  // Nothing usable is remembered: the configured path decides.
  assert.equal(preferredWorkspace('', projects, lastWorkspaceChoice('cached-gone', 'gone', live), 'C:\\code\\looprax'), 'looprax');
  assert.equal(preferredWorkspace('', projects, lastWorkspaceChoice('other', '', live), 'C:\\code\\looprax'), 'other');
});

test('the last choice is stored per browser and a blank choice does not erase it', () => {
  const storage = memory();
  assert.equal(readLastWorkspace(storage), '');
  writeLastWorkspace(storage, 'other');
  assert.equal(readLastWorkspace(storage), 'other');
  assert.equal(storage.getItem(LAST_WORKSPACE_KEY), JSON.stringify('other'));
  writeLastWorkspace(storage, '');
  assert.equal(readLastWorkspace(storage), 'other');
  storage.setItem(LAST_WORKSPACE_KEY, '{');
  assert.equal(readLastWorkspace(storage), '');
  storage.setItem(LAST_WORKSPACE_KEY, JSON.stringify(12));
  assert.equal(readLastWorkspace(storage), '');
});

test('a received record waits for the project list and then restores once', () => {
  let state = initialWorkspaceSelection('server', '');
  state = workspaceSelectionReducer(state, { type: 'received', server: 'server', hash: 'other' });
  const reconcile = { type: 'reconcile', server: 'server', workspaces: [], cached: '', configuredPath: projects[1].path };
  assert.equal(workspaceSelectionReducer(state, reconcile), state);
  state = workspaceSelectionReducer(state, { ...reconcile, workspaces: projects });
  assert.equal(state.current, 'other');
  assert.deepEqual(state.record, { status: 'ready', hash: 'other' });
});

test('switching services resets user intent and ignores responses from the old service', () => {
  let state = initialWorkspaceSelection('first', 'looprax');
  state = workspaceSelectionReducer(state, { type: 'select', server: 'first', hash: 'other' });
  state = workspaceSelectionReducer(state, { type: 'reset', server: 'second', cached: '' });
  assert.equal(state.picked, false);
  assert.deepEqual(state.record, { status: 'loading' });
  assert.equal(workspaceSelectionReducer(state, { type: 'received', server: 'first', hash: 'other' }), state);
});
