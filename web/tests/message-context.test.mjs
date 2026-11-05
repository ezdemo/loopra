import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/message-context.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { messageContextItems } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('context previews distinguish skills, references, uploaded documents and saved pastes', () => {
  const items = messageContextItems('调用技能：\n/skill:self-skill\n/skill:review\n\n引用文件：\n- C:\\repo\\src\\app.ts\n\n大段粘贴内容（已保存）：\n- .loopra/paste/notes.txt\n请使用 read 工具读取\n\n服务端备注', [{ name: '歌词.txt', text: '正文', size: 12 }]);
  assert.deepEqual(items.map(item => [item.kind, item.name]), [['document', '歌词.txt'], ['skill', 'self-skill'], ['skill', 'review'], ['file', 'app.ts'], ['paste', 'notes.txt'], ['context', '上下文']]);
  assert.equal(items[0].content, '正文');
  assert.equal(items[3].content, 'C:\\repo\\src\\app.ts');
  assert.match(items[4].content, /请使用 read/);
  assert.equal(items[5].content, '服务端备注');
});
test('empty context has no chips and unfamiliar sections remain readable', () => {
  assert.deepEqual(messageContextItems('', []), []);
  const context = '调用技能：\n未识别的格式';
  assert.deepEqual(messageContextItems(context, []), [{ kind: 'context', name: '上下文', content: context }]);
});
