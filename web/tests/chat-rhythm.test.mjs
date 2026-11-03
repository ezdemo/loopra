import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// The transcript used two different rhythms: prose at 14px/1.65 and the
// thinking/tool rows at 13px/1.4 with their own margins, which made a process
// row look glued to one neighbour and floating from the other. Both now share
// `--chat-font` / `--chat-line`, and one flex gap (`--chat-gap`) owns the
// spacing between every block, so the left rail of the transcript reads evenly.
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

test('prose and process rows share one font size, weight and line box', () => {
  assert.match(ruleBody('.loopra-conversation'), /--chat-font: \.875rem;/);
  assert.match(ruleBody('.loopra-conversation'), /--chat-line: 1\.65;/);

  for (const selector of [
    '.loopra-conversation .block-content',
    '.loopra-conversation .chain-head',
    '.loopra-conversation .reasoning-text',
  ]) {
    const body = ruleBody(selector);
    assert.match(body, /font-size: var\(--chat-font\)/, `${selector} should size like prose`);
    assert.match(body, /font-weight: 400/, `${selector} should not shout like a heading`);
  }
  // The process rows share one rule that also carries the size and weight.
  const headRule = css.split('\n').find(line => line.includes('.loopra-conversation .tool-head {') && line.includes('font-size'));
  assert.ok(headRule, 'missing the process-row head rule');
  assert.match(headRule, /font-size: var\(--chat-font\)/);
  assert.match(headRule, /font-weight: 400/);
  assert.match(ruleBody('.loopra-conversation .block-content'), /line-height: var\(--chat-line\)/);
  assert.match(ruleBody('.loopra-conversation .chain-summary'), /font-size: var\(--chat-font\)/);
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
