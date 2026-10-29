import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/agent-install.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { agentAcpInstallPrompt } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('Pi installation covers the CLI, adapter, authentication and MCP limitation', () => {
  const prompt = agentAcpInstallPrompt('pi');
  assert.match(prompt, /npm install -g @earendil-works\/pi-coding-agent pi-acp/);
  assert.match(prompt, /登录/);
  assert.match(prompt, /不转发工作台 MCP/);
});

test('DSH installation checks the ACP profile and supports a source build entry', () => {
  const prompt = agentAcpInstallPrompt('dsh');
  assert.match(prompt, /@deepseek-ai\/dsh/);
  assert.match(prompt, /dsh --profile acp --help/);
  assert.match(prompt, /LOOPRA_DSH_ACP_SCRIPT/);
});

test('existing engines retain their installation instructions and unknown engines omit install', () => {
  assert.match(agentAcpInstallPrompt('claude-code'), /@agentclientprotocol\/claude-agent-acp/);
  assert.match(agentAcpInstallPrompt('codex'), /@agentclientprotocol\/codex-acp/);
  assert.equal(agentAcpInstallPrompt('unknown'), '');
});
