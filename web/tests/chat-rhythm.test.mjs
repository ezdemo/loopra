import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Two rules keep the transcript readable:
// 1. Prose is the star. Process chrome (用时 / `x 次思考 · n 次工具` / tool rows)
//    is reference material, so it is one step smaller (`--chat-font-meta`) and
//    one ink level lighter (`--chat-fg-4` instead of prose's `--chat-fg`).
// 2. One flex gap (`--chat-gap`) owns the spacing between every block, so a
//    process row keeps an even gap from the text above and below it.
const css = await readFile(new URL('../src/chat-blocks.css', import.meta.url), 'utf8');
const renderer = await readFile(new URL('../src/components/BlockRenderer.tsx', import.meta.url), 'utf8');

function ruleBody(selector) {
  const pattern = new RegExp('^[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'm');
  const match = css.match(pattern);
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test('the chain head only carries the counts, not the tool-name trail', () => {
  // `x 次思考 · n 次工具` alone: the expanded steps already name every tool, so
  // the `read → bash → edit` trail repeated them and crowded the row.
  assert.match(renderer, /const summary = \[thoughts \? `\$\{thoughts\} 次思考` : '', tools\.length \? `\$\{tools\.length\} 次工具` : ''\]/);
  assert.match(renderer, /<span className="chain-summary">\{summary\}<\/span>/);
  assert.doesNotMatch(renderer, /chain-tools/);
  assert.doesNotMatch(renderer, /names\.join/);
  // …and no style is left behind for a trail that no longer renders.
  assert.doesNotMatch(css, /\.chain-tools/);
});

test('process chrome is smaller and lighter than the answer', () => {
  const tokens = ruleBody('.loopra-conversation');
  assert.match(tokens, /--chat-font: \.875rem;/);
  assert.match(tokens, /--chat-font-meta: \.8125rem;/);
  assert.match(tokens, /--chat-line: 1\.65;/);

  // The chain row the user pointed at: 13px and the muted ink, not prose ink.
  const chain = ruleBody('.loopra-conversation .chain-head');
  assert.match(chain, /font-size: var\(--chat-font-meta\)/);
  assert.match(chain, /font-weight: 400/);
  assert.match(chain, /color: var\(--chat-fg-4\)/);
  const summary = ruleBody('.loopra-conversation .chain-summary');
  assert.match(summary, /font-size: var\(--chat-font-meta\)/);
  assert.match(summary, /color: var\(--chat-fg-4\)/);

  // The 用时 toggle and the inner tool/thinking rows follow the same level.
  assert.match(ruleBody('.loopra-conversation .assistant-process-toggle'), /font-size: var\(--chat-font-meta\)/);
  assert.match(ruleBody('.loopra-conversation .assistant-process-toggle'), /color: var\(--chat-fg-4\)/);
  const headRule = css.split('\n').find(line => line.includes('.loopra-conversation .tool-head {') && line.includes('font-size'));
  assert.ok(headRule, 'missing the process-row head rule');
  assert.match(headRule, /font-size: var\(--chat-font-meta\)/);
  assert.match(headRule, /color: var\(--chat-fg-4\)/);
  assert.match(ruleBody('.loopra-conversation .reasoning-head'), /color: var\(--chat-fg-4\)/);

  // Hovering lifts chrome back to the secondary ink so it stays discoverable.
  assert.match(css, /\.chain-head:hover \{ color: var\(--chat-fg-3\); \}/);

  // The answer itself keeps the full prose size and darkest ink.
  const prose = ruleBody('.loopra-conversation .block-content');
  assert.match(prose, /font-size: var\(--chat-font\)/);
  assert.match(prose, /font-weight: 400/);
  assert.match(prose, /line-height: var\(--chat-line\)/);
});

test('one gap separates every transcript block, including inside a chain', () => {
  assert.match(ruleBody('.loopra-conversation'), /--chat-gap: \.5rem;/);
  assert.match(ruleBody('.loopra-conversation .msg-blocks'), /gap: var\(--chat-gap\)/);
  // The chain must not add margins of its own on top of that gap.
  assert.match(ruleBody('.loopra-conversation .block-chain'), /margin: 0;/);
  assert.doesNotMatch(css, /\.block-chain \{ margin: [.]25rem/);
  // Expanded steps are spaced by the same token, not by their own margins.
  const steps = ruleBody('.loopra-conversation .chain-steps');
  assert.match(steps, /display: flex/);
  assert.match(steps, /gap: var\(--chat-gap\)/);
});
