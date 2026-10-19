import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/session-order.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { orderSessions, sessionDate } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('the default order is the server order (already newest first)', () => {
  const sessions = [{ id: 'b', mtime: 2 }, { id: 'a', mtime: 1 }];
  const ordered = orderSessions(sessions, false);
  assert.equal(ordered, sessions);
});

test('sorting by newest puts a just-created session on top without mutating the input', () => {
  const sessions = [{ id: 'old', mtime: 1 }, { id: 'fresh', mtime: 3 }, { id: 'middle', mtime: 2 }];
  const ordered = orderSessions(sessions, true);
  assert.deepEqual(ordered.map(entry => entry.id), ['fresh', 'middle', 'old']);
  assert.deepEqual(sessions.map(entry => entry.id), ['old', 'fresh', 'middle']);
});

test('a session without a timestamp sorts last', () => {
  const ordered = orderSessions([{ id: 'missing' }, { id: 'dated', mtime: 1 }], true);
  assert.deepEqual(ordered.map(entry => entry.id), ['dated', 'missing']);
});

// 2026-10-19 is a Monday; all dates below are local noon so calendar-day math
// does not depend on the machine's time zone.
const now = new Date(2026, 9, 19, 12, 0).getTime();
const day = (month, date, hour = 12) => new Date(2026, month, date, hour).getTime();

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
  assert.match(app, /setSessions\(current => \[target!, \.\.\.current\]\)/);
  assert.match(app, /setSessions\(current => \[target, \.\.\.current\]\)/);
  assert.doesNotMatch(app, /setSessions\(current => \[\.\.\.current, target/);
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
