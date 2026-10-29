import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/workspace-launcher.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { launchWorkspace, workspaceApplications } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('each native open action calls Java with the selected project hash', async () => {
  const calls = [];
  const api = { request: async (...args) => { calls.push(args); return 'C:\\真实项目'; } };
  for (const item of [...workspaceApplications, { name: 'Terminal', application: 'terminal' }]) {
    assert.equal(await launchWorkspace(api, 'abc123def456', item.name), 'C:\\真实项目');
    assert.deepEqual(calls.at(-1), ['/system/open-workspace', 'POST', { workspaceHash: 'abc123def456', application: item.application }]);
  }
});

test('missing projects and unknown applications never request a launch', async () => {
  const api = { request: async () => assert.fail('must not launch') };
  await assert.rejects(launchWorkspace(api, '', 'PowerShell'), /请先选择项目/);
  await assert.rejects(launchWorkspace(api, 'abc123def456', 'command'), /不支持/);
});

test('launch errors are propagated for the UI to display', async () => {
  const api = { request: async () => { throw new Error('请先安装 Git for Windows'); } };
  await assert.rejects(launchWorkspace(api, 'abc123def456', 'Git Bash'), /Git for Windows/);
});
