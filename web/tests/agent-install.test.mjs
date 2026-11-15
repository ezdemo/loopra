import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/agent-install.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { agentAcpInstallPrompt } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('Devin installation uses the standalone CLI and local credentials', () => {
  const prompt = agentAcpInstallPrompt('devin');
  assert.match(prompt, /cli\.devin\.ai\/install\.sh/);
  assert.match(prompt, /LOOPRA_DEVIN_EXECUTABLE/);
  assert.match(prompt, /devin auth login/);
});

test('existing engines retain their installation instructions and unknown engines omit install', () => {
  assert.match(agentAcpInstallPrompt('claude-code'), /@agentclientprotocol\/claude-agent-acp/);
  assert.match(agentAcpInstallPrompt('codex'), /@agentclientprotocol\/codex-acp/);
  assert.equal(agentAcpInstallPrompt('unknown'), '');
});
