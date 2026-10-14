import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The per-message 查看原始记录 shortcut reopens the session record modal on the
// raw-events tab, so SessionDetails must accept an initial tab from the app.
test('session records open on the requested tab', async () => {
  const details = await readFile(new URL('../src/components/SessionDetails.tsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(details, /initialTab = 'events'/, 'SessionDetails defaults to the events tab');
  assert.match(details, /useState\(initialTab === 'prompt' \? 'prompt' : 'events'\)/, 'the tab state seeds from valid requested tabs');
  assert.match(app, /initialTab=\{sessionDetailsTab\}/, 'App forwards the requested tab');
  assert.match(app, /onRawEvents=\{\(\) => \{ setSessionDetailsTab\('events'\); setSessionDetails\(true\); \}\}/, 'the raw-events shortcut opens the events tab');
});

// Legacy Chat.vue rendered the system prompt as Markdown with a copy action;
// the first React cut dropped both.
test('the system prompt tab renders Markdown with a copy action', async () => {
  const details = await readFile(new URL('../src/components/SessionDetails.tsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(details, /import Markdown, \{ copyText \} from '\.\/Markdown'/);
  assert.match(details, /复制提示词/);
  assert.match(details, /<Markdown text=\{promptText\(prompt\.data\)\}/, 'the prompt is rendered with the Markdown component');
  assert.ok(!details.includes('<pre className="session-raw">{promptText(prompt.data)}</pre>'), 'the plain <pre> prompt dump is gone');
  assert.match(app, /<SessionDetails[^\n]+notify=\{notify\} \/>/, 'App passes notify so the copy action can confirm');
});

test('the record window has only records and prompt tabs, and its menu has an icon', async () => {
  const details = await readFile(new URL('../src/components/SessionDetails.tsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(details, /\/snapshots|回滚到此快照|代码快照/);
  assert.match(details, /label: '原始记录'/);
  assert.match(details, /label: '系统提示词'/);
  assert.match(details, /<RawSessionRecords messages=\{events.data\}/);
  assert.match(app, /<ScrollText size="1rem" \/>会话记录/);
});
