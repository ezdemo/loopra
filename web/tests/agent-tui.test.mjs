import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/agent-tui.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { canUseTui, isExternalAgent, tuiDisabledReason, tuiSessionBody } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('isExternalAgent distinguishes external engines', () => {
  assert.equal(isExternalAgent('claude-code'), true);
  assert.equal(isExternalAgent('codex'), true);
  assert.equal(isExternalAgent('devin'), true);
  assert.equal(isExternalAgent('native'), false);
  assert.equal(isExternalAgent(''), false);
});

test('canUseTui only shows on the new-session draft for external agents', () => {
  const draft = { chatMode: false, surface: false, session: false };
  assert.equal(canUseTui('claude-code', draft), true);
  assert.equal(canUseTui('native', draft), false);
  assert.equal(canUseTui('claude-code', { ...draft, chatMode: true }), false);
  assert.equal(canUseTui('claude-code', { ...draft, surface: true }), false);
});

test('canUseTui hides once a session exists', () => {
  const selected = { chatMode: false, surface: false, session: true };
  assert.equal(canUseTui('claude-code', selected), false);
  assert.equal(canUseTui('codex', selected), false);
});

test('tuiDisabledReason reports a busy run only when the button shows', () => {
  const draft = { chatMode: false, surface: false, session: false, busy: false };
  assert.equal(tuiDisabledReason('codex', draft), undefined);
  assert.equal(tuiDisabledReason('codex', { ...draft, busy: true }), '任务运行中，结束后才能创建 TUI 会话');
  assert.equal(tuiDisabledReason('native', { ...draft, busy: true }), undefined);
  assert.equal(tuiDisabledReason('codex', { ...draft, session: true, busy: true }), undefined);
});

test('tuiSessionBody posts workspace, agent and session together', () => {
  assert.deepEqual(tuiSessionBody('hash1', 'codex', 'sess-1'), { workspaceHash: 'hash1', agentId: 'codex', sessionName: 'sess-1' });
  assert.deepEqual(tuiSessionBody('hash1', 'devin', ''), { workspaceHash: 'hash1', agentId: 'devin', sessionName: '' });
});
