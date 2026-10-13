import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/documents.ts', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
// The transient data-URL module cannot resolve bare specifiers, so pin the one
// parser this test actually exercises (the other imports stay lazy).
outputText = outputText.replaceAll("import('xlsx')", `import(${JSON.stringify(import.meta.resolve('xlsx'))})`);
const { fileKind, formatFileSize, truncateText, extractDocumentText, attachmentLimitReached, MAX_EXTRACT_CHARS, MAX_TEXT_FILE_SIZE, MAX_DOC_FILE_SIZE, MAX_IMAGE_COUNT, MAX_UPLOAD_FILES } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('file kinds are detected from extension and mime type', () => {
  assert.equal(fileKind('photo.PNG', 'image/png'), 'image');
  assert.equal(fileKind('notes.md'), 'text');
  assert.equal(fileKind('component.vue'), 'text');
  assert.equal(fileKind('report.pdf', 'application/pdf'), 'pdf');
  assert.equal(fileKind('spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
  assert.equal(fileKind('budget.xlsx'), 'xlsx');
  assert.equal(fileKind('archive.zip'), 'unsupported');
  assert.equal(fileKind('no-extension', 'application/octet-stream'), 'unsupported');
  assert.equal(fileKind('payload', 'text/plain'), 'text');
});

test('size limits keep text small and allow large documents', () => {
  assert.equal(MAX_TEXT_FILE_SIZE, 512 * 1024);
  assert.equal(MAX_DOC_FILE_SIZE, 30 * 1024 * 1024);
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
  assert.equal(formatFileSize(3 * 1024 * 1024), '3.0 MB');
});

test('truncation preserves short text and marks the cut', () => {
  assert.equal(truncateText('hello'), 'hello');
  const long = 'a'.repeat(MAX_EXTRACT_CHARS + 100000);
  const cut = truncateText(long);
  assert.ok(cut.startsWith('a'.repeat(MAX_EXTRACT_CHARS)));
  assert.match(cut, /内容过长，已截断，共 \d+ 字符/);
  assert.ok(cut.length < long.length);
});

test('attachments stop at 10 images and 10 parsed documents', () => {
  assert.equal(MAX_IMAGE_COUNT, 10);
  assert.equal(MAX_UPLOAD_FILES, 10);
  assert.equal(attachmentLimitReached(9, 0, 'image'), false);
  assert.equal(attachmentLimitReached(10, 0, 'image'), true);
  assert.equal(attachmentLimitReached(0, 9, 'pdf'), false);
  assert.equal(attachmentLimitReached(0, 10, 'docx'), true);
  assert.equal(attachmentLimitReached(0, 10, 'text'), true);
  // 图片与文档各自计数：文档已满时图片仍可继续添加。
  assert.equal(attachmentLimitReached(3, 10, 'image'), false);
});

test('xlsx extraction returns each sheet as csv text', async () => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['项目', '预算'], ['服务器', 1200]]), '预算表');
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const file = new File([bytes], 'budget.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const text = await extractDocumentText(file);
  assert.match(text, /\[工作表: 预算表\]/);
  assert.match(text, /服务器,1200/);
});
