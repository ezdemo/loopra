import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/session-order.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { orderWithNewSessionFirst, sessionDate } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// 2026-10-19 is a Monday; all dates below are local noon so calendar-day math
// does not depend on the machine's time zone.
const now = new Date(2026, 9, 19, 12, 0).getTime();
const day = (month, date, hour = 12) => new Date(2026, month, date, hour).getTime();

test('a new session is inserted ahead of the saved order without duplicating its name', () => {
  assert.deepEqual(orderWithNewSessionFirst(['old-a', 'old-b'], 'new'), ['new', 'old-a', 'old-b']);
  assert.deepEqual(orderWithNewSessionFirst(['new', 'old-a'], 'new'), ['new', 'old-a']);
});

test('sidebar timestamps use time, relative days, weekday, then the date', () => {
  assert.equal(sessionDate(day(9, 19, 14) + 32 * 60_000, now), '14:32');
  assert.equal(sessionDate(day(9, 18), now), '昨天');
  assert.equal(sessionDate(day(9, 17), now), '前天');
  assert.equal(sessionDate(day(9, 16), now), '3天前');
  assert.equal(sessionDate(day(9, 15), now), '星期四');
  assert.equal(sessionDate(day(9, 14), now), '星期三');
  assert.equal(sessionDate(day(9, 11), now), '10/11');
  assert.equal(sessionDate(new Date(2025, 9, 19, 12).getTime(), now), '2025/10/19');
  assert.equal(sessionDate(undefined, now), '');
});

// A newly created session must join the top of the sidebar immediately, before
// the next server refresh (the server itself returns newest first).
test('new sessions are prepended, never appended', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /setSessions\(current => \[target!, \.\.\.current\.filter\(item => item\.id !== target!\.id\)\]\)/);
  assert.match(app, /setSessions\(current => \[target, \.\.\.current\]\)/);
  assert.match(app, /pinNewSession\(sendWorkspace\.hash, target!\.name\)/);
  assert.match(app, /orderWithNewSessionFirst\(names, name\)/);
  assert.doesNotMatch(app, /setSessions\(current => \[\.\.\.current, target/);
});

test('a long project list folds after six sessions with an expand link', async () => {
  const [sidebar, css] = await Promise.all([
    readFile(new URL('../src/layout/Sidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/sessions.css', import.meta.url), 'utf8'),
  ]);
  assert.match(sidebar, /const SESSION_GROUP_LIMIT = 6;/);
  assert.match(sidebar, /const shown = expanded \? own : own\.slice\(0, SESSION_GROUP_LIMIT\);/);
  assert.match(sidebar, /useLocalState<string\[\]>\('expanded-session-groups', \[\]\)/);
  // The active session may come from search and sit below the fold; its group
  // opens instead of hiding the row that is currently selected.
  assert.match(sidebar, /own\.findIndex\(entry => entry\.id === activeId\) < SESSION_GROUP_LIMIT/);
  assert.match(sidebar, /展开显示/);
  assert.match(sidebar, /收起显示/);
  assert.match(css, /\.session-more \{ display: flex;/);
});

test('sessions can be dragged to reorder and the order is persisted per project', async () => {
  const [sidebar, app] = await Promise.all([
    readFile(new URL('../src/layout/Sidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ]);
  // Rows are always draggable now that the sort-by-newest switch is gone.
  assert.match(sidebar, /data-session-key=\{entry\.id\} draggable/);
  // A row drag must not be mistaken for a project drag on its parent.
  assert.match(sidebar, /event\.stopPropagation\(\); event\.dataTransfer\.effectAllowed = 'move';/);
  assert.match(sidebar, /props\.onReorderSessions\(item\.hash, draggingSession, entry\.id\)/);
  assert.match(app, /function reorderSessions\(workspaceHash: string, from: string, to: string\)/);
  assert.match(app, /`\/sessions\/order\?workspaceHash=\$\{encodeURIComponent\(workspaceHash\)\}`, 'PUT', order\)/);
  assert.match(app, /onReorderSessions=\{reorderSessions\}/);
});

test('an overlong session title slides sideways on hover', async () => {
  const [sidebar, css] = await Promise.all([
    readFile(new URL('../src/layout/Sidebar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/sessions.css', import.meta.url), 'utf8'),
  ]);
  assert.match(sidebar, /function SessionTitle/);
  assert.match(sidebar, /<SessionTitle text=\{entry\.title\} \/>/);
  assert.match(sidebar, /node\.scrollWidth - box\.clientWidth/);
  assert.match(css, /\.session-item:hover \.session-title\.marquee > span \{ max-width: none; animation: session-title-marquee/);
});
