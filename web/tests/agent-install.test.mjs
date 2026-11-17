import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/agent-install.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { agentAcpInstallPrompt } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('install prompts stay minimal, name each provider and state the goal', () => {
  assert.equal(agentAcpInstallPrompt('claude-code'), '帮我安装好 Claude Code 和它的 ACP 适配器，让三方应用能通过 ACP 协议驱动它。安装完成即可，接口调用、登录校验、ACP 客户端配置让用户自行完成。');
  assert.equal(agentAcpInstallPrompt('codex'), '帮我安装好 Codex CLI 和它的 ACP 适配器，让三方应用能通过 ACP 协议驱动它。安装完成即可，接口调用、登录校验、ACP 客户端配置让用户自行完成。');
  assert.equal(agentAcpInstallPrompt('devin'), '帮我安装好 Devin CLI 和它的 ACP 适配器，让三方应用能通过 ACP 协议驱动它。安装完成即可，接口调用、登录校验、ACP 客户端配置让用户自行完成。');
  assert.equal(agentAcpInstallPrompt('native'), '');
  assert.equal(agentAcpInstallPrompt('unknown'), '');
});
