import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/composer.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { getModelCatalog, groupModels, composeMessage, estimateContext, appendPreset, attachmentViews, defaultOptions, largeInputReference, composeOutgoing } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const providers = [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'magpie', name: 'magpie' }];
const models = getModelCatalog(providers);

test('same-name models keep distinct provider identities and search both fields', () => {
  const matches = groupModels(models, ' DEEPSEEK V4.1 ');
  assert.equal(matches.length, 2);
  assert.equal(new Set(matches.flatMap(group => group.models.map(model => model.id))).size, 2);
  assert.equal(groupModels(models, 'MAGPIE')[0].models.length, 3);
  assert.deepEqual(groupModels(models, 'missing-model'), []);
  assert.ok(!getModelCatalog([providers[0]]).some(model => model.providerId === 'magpie'));
  assert.deepEqual(getModelCatalog([{ id: 'custom', name: 'Custom' }]), []);
});

test('sent context is a stable folded snapshot, including the selected channel', () => {
  const options = { ...defaultOptions, plan: true, fast: true, effort: 'custom' };
  const context = { projects: ['runtime'], skills: ['代码审查'], files: ['notes.md'] };
  const text = composeMessage('审查代码', options, context, models.find(model => model.providerId === 'magpie'));
  options.plan = false;
  context.files.push('later.md');
  assert.match(text, /^```折叠块\n/);
  assert.match(text, /magpie \/ DeepSeek V4.1 Flash/);
  assert.match(text, /计划模式：开启/);
  assert.match(text, /推理强度：custom/);
  assert.match(text, /技能：代码审查/);
  assert.match(text, /仅文件名，未读取内容/);
  assert.ok(!text.includes('later.md'));
  assert.ok(text.endsWith('```\n审查代码'));
});

test('prompt presets append without losing existing drafts', () => {
  assert.equal(appendPreset('  ', '要求'), '要求');
  assert.equal(appendPreset('已有内容 \n', '要求'), '已有内容\n\n要求');
});

// Legacy ChatInput.vue externalizes oversized directly-typed text before sending.
test('oversized typed bodies become a saved-file reference, and sendMessage uses it', async () => {
  const reference = largeInputReference('.loopra/paste/paste-test.txt', 12345);
  assert.match(reference, /^大段输入内容（已保存）：/);
  assert.match(reference, /\.loopra\/paste\/paste-test\.txt（12,345 字符）/);
  assert.match(reference, /read 工具/);
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /prompt\.length > LARGE_PASTE_THRESHOLD_CHARS/);
  assert.match(app, /\/files\/paste/);
  assert.match(app, /savedInput = largeInputReference\(saved\.path, Number\(saved\.chars\) \|\| prompt\.length\)/);
  // A failed save must abort the send rather than transmit the raw text.
  assert.match(app, /大段输入内容保存失败：[\s\S]*本次未发送/);
});

// Legacy ChatInput.vue wrapped auto-attached context in a leading 折叠块 that the
// chat renderer folds into "附加上下文"; the backend merges its own notes into it.
test('outgoing context is folded into a leading block ahead of the prompt', async () => {
  const context = { projects: ['runtime'], skills: ['code-review'], files: ['src/app.ts', '.loopra/paste/paste-1.txt'], attachments: [] };
  const text = composeOutgoing('修复登录问题', context);
  assert.match(text, /^```折叠块\n/);
  assert.match(text, /大段粘贴内容（已保存）：\n- \.loopra\/paste\/paste-1\.txt\n请使用 read 工具/);
  assert.match(text, /引用文件：\n- src\/app\.ts/);
  assert.match(text, /调用技能：\n\/skill:code-review/);
  assert.ok(text.endsWith('```\n\n修复登录问题'));
  // Attachment chips are delivered as document text, not file references.
  assert.ok(!composeOutgoing('hi', { ...context, files: ['report.pdf'], attachments: [{ name: 'report.pdf', text: 'x' }] }).includes('report.pdf'));
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const text = action \? prompt : composeOutgoing\(prompt, context, savedInput\)/);
  // Externalized typed input is folded with no visible prompt remainder.
  assert.equal(composeOutgoing('', { projects: [], skills: [], files: [], attachments: [] }, '大段输入内容（已保存）：\n- a.txt'), '```折叠块\n大段输入内容（已保存）：\n- a.txt\n```');
});

test('slash commands and empty context stay raw', () => {
  const context = { projects: [], skills: ['code-review'], files: [], attachments: [] };
  assert.equal(composeOutgoing('/compact', context), '/compact');
  assert.equal(composeOutgoing('  /continue', context), '  /continue');
  assert.equal(composeOutgoing('你好', { projects: [], skills: [], files: [], attachments: [] }), '你好');
  // Fences widen when the context itself contains backticks.
  const fenced = composeOutgoing('查看', { projects: [], skills: [], files: ['a`b```.ts'], attachments: [] });
  assert.match(fenced, /^````折叠块\n/);
});

test('context estimates account for history/draft/chips and cap percentage', () => {
  const empty = { projects: [], skills: [], files: [] };
  const base = estimateContext([], '', empty);
  const usage = estimateContext(['你好', 'hello'], '继续', { ...empty, files: ['notes.md'] });
  assert.ok(usage.total > base.total);
  assert.equal(usage.parts.reduce((sum, part) => sum + part.tokens, 0), usage.total);
  assert.equal(estimateContext(['中'.repeat(130000)], '', empty).percent, 100);
  assert.ok(estimateContext([], '😀', empty).total > base.total);
});

test('attachment views split image thumbnails from sized file chips', () => {
  const context = {
    projects: [], skills: [],
    files: ['shot.png', 'report.pdf', '.loopra/paste/big.txt'],
    attachments: [
      { name: 'shot.png', image: 'data:image/png;base64,AAAA', size: 2048 },
      { name: 'report.pdf', text: 'pdf text', size: 4096 },
    ],
  };
  const view = attachmentViews(context, { '.loopra/paste/big.txt': 12345 });
  // Images become thumbnails and are removed from the file chip list.
  assert.deepEqual(view.images, [{ name: 'shot.png', src: 'data:image/png;base64,AAAA' }]);
  assert.deepEqual(view.files, [
    { name: 'report.pdf', size: 4096, chars: undefined },
    { name: '.loopra/paste/big.txt', size: undefined, chars: 12345 },
  ]);
  // Without saved paste metadata a plain @-referenced path still lists as a chip.
  assert.deepEqual(attachmentViews({ ...context, files: ['src/app.ts'], attachments: [] }).files, [{ name: 'src/app.ts', size: undefined, chars: undefined }]);
});

test('the composer renders image thumbnails and sized chips using the view helper', async () => {
  const component = await readFile(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8');
  // Legacy ChatInput.vue rendered an .image-preview-bar; the React composer keeps it.
  assert.match(component, /className="composer-image-thumb"/);
  assert.match(component, /className="composer-image-preview"/);
  assert.match(component, /className="context-chip-size"/);
  assert.match(component, /attachmentViews\(context, pasteChars\)/);
  assert.match(component, /size: file\.size/);
});
