import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/last-workspace.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { LAST_WORKSPACE_KEY, lastWorkspaceChoice, preferredWorkspace, readLastWorkspace, settledLastWorkspace, shouldRecordWorkspace, shouldRestoreWorkspace, writeLastWorkspace } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

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

// The two startup effects in App.tsx reduce to these predicates, so the ordering they
// depend on is pinned here rather than in a component that cannot be mounted cheaply.
const live = hash => hash === 'looprax' || hash === 'other';
const sync = (overrides = {}) => ({ answered: true, unread: false, stored: '', current: '', reported: '', picked: false, exists: live, ...overrides });

test('an unanswered service record settles to nothing instead of to "no record"', () => {
  // null is 'still unknown': the page must not treat it as an answer and must not write.
  assert.equal(settledLastWorkspace({ answered: false, stored: 'looprax', exists: live }), null);
  assert.equal(settledLastWorkspace({ answered: true, stored: 'looprax', exists: live }), 'looprax');
  // A real answer with no record is the empty string, which lets the configured project stand.
  assert.equal(settledLastWorkspace({ answered: true, stored: '', exists: live }), '');
});

test('a record naming a deleted project settles as no record', () => {
  assert.equal(settledLastWorkspace({ answered: true, stored: 'gone', exists: live }), '');
  // The chat workspace is a real entry in the project list, so it restores like any other.
  assert.equal(settledLastWorkspace({ answered: true, stored: '__loopra_chat__', exists: hash => hash === '__loopra_chat__' }), '__loopra_chat__');
});

test('a service record is restored over the configured project once it arrives', () => {
  // This is the cold start the feature exists for: config.workspace pointed the page at
  // the default project, and the record has to win over it.
  assert.equal(shouldRestoreWorkspace(sync({ stored: 'looprax', current: 'other' })), true);
  // Nothing to change when the page already shows the recorded project.
  assert.equal(shouldRestoreWorkspace(sync({ stored: 'looprax', current: 'looprax' })), false);
  assert.equal(shouldRestoreWorkspace(sync({ answered: false, stored: 'looprax', current: 'other' })), false);
  assert.equal(shouldRestoreWorkspace(sync({ stored: '', current: 'other' })), false);
  assert.equal(shouldRestoreWorkspace(sync({ stored: 'gone', current: 'other' })), false);
});

test('a project the user picked is not dragged back by a late record', () => {
  assert.equal(shouldRestoreWorkspace(sync({ stored: 'looprax', current: 'other', picked: true })), false);
});

test('nothing is reported before the service answers', () => {
  assert.equal(shouldRecordWorkspace(sync({ answered: false, current: 'looprax' })), false);
  // Even a restored-looking project must wait: writing the configured project now would
  // save a guess as if the user had chosen it.
  assert.equal(shouldRecordWorkspace(sync({ answered: false, current: 'looprax', stored: 'looprax' })), false);
});

test('a failed read never overwrites the record it could not read', () => {
  // The regression this pins: settling on 'no record' after an error used to open the
  // write path, and the page then saved the configured project over the real record.
  assert.equal(shouldRecordWorkspace(sync({ unread: true, stored: '', current: 'other' })), false);
  // Switching projects afterwards is still suppressed for that session.
  assert.equal(shouldRecordWorkspace(sync({ unread: true, stored: '', current: 'looprax' })), false);
  assert.equal(shouldRecordWorkspace(sync({ unread: false, stored: '', current: 'looprax' })), true);
});

test('only a project that exists and changed is reported', () => {
  assert.equal(shouldRecordWorkspace(sync({ current: '' })), false);
  assert.equal(shouldRecordWorkspace(sync({ current: 'gone' })), false);
  assert.equal(shouldRecordWorkspace(sync({ current: 'looprax', reported: 'looprax' })), false);
  assert.equal(shouldRecordWorkspace(sync({ current: 'looprax', reported: 'other' })), true);
});

test('a restored project is not reported back, but a real switch is', () => {
  // Restoring is not a switch: the service already knows this project, and reporting it
  // would let one browser's startup undo a record another browser just made.
  assert.equal(shouldRecordWorkspace(sync({ stored: 'looprax', current: 'looprax' })), false);
  assert.equal(shouldRecordWorkspace(sync({ stored: 'looprax', current: 'other' })), true);
  assert.equal(shouldRecordWorkspace(sync({ stored: '', current: 'looprax' })), true);
  // A pick outranks the record even when both name the same project, because the user
  // chose it deliberately after a failed read or a stale cache.
  assert.equal(shouldRecordWorkspace(sync({ stored: 'looprax', current: 'looprax', picked: true })), true);
});

test('the write path keeps the record behind the answered-read gate', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // The guard is now expressed once, in shouldRecordWorkspace; the effect must not
  // re-derive its own conditions next to it.
  assert.match(app, /if \(!report\) return;/);
  assert.match(app, /unread: lastWorkspaceUnread\.current/);
  assert.match(app, /answered: serverLastWorkspace !== null/);
  // A failed read settles the record without claiming the project list is authoritative
  // for it, so the write-back above stays closed for the rest of the session.
  assert.match(app, /lastWorkspaceUnread\.current = true;\s*\n\s*setServerLastWorkspace\(''\);/);
});
