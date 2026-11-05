import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The project maintenance dialog deletes server data, so assert the exact
// endpoints instead of exercising a live backend.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const settingControlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const SelectField = ({ label, value, onChange, options, disabled }) => createElement('select', {
  'aria-label': label,
  value,
  disabled: !!disabled,
  onChange: event => onChange(event.target.value),
}, options.map(option => {
  const item = typeof option === 'string' ? { value: option, label: option } : option;
  return createElement('option', { key: item.value, value: item.value }, item.label);
}));
`);
const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, isLoading, isIconOnly, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children);
export const Input = ({ value, onValueChange, isDisabled, isReadOnly, endContent, 'aria-label': label, placeholder, id, maxLength }) => createElement('div', null, createElement('input', {
  'aria-label': label, value, disabled: isDisabled, readOnly: isReadOnly, placeholder, id, maxLength, onChange: event => onValueChange(event.target.value),
}), endContent);
export const Checkbox = ({ children, isSelected, isDisabled, onValueChange, classNames }) => createElement('label', { className: classNames?.base }, createElement('input', { type: 'checkbox', checked: !!isSelected, disabled: !!isDisabled, onChange: event => onValueChange(event.target.checked) }), createElement('span', { className: classNames?.label }, children));
export const Modal = ({ children, classNames, 'aria-label': label }) => createElement('div', { role: 'dialog', className: classNames?.base, 'aria-label': label }, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('header', null, children);
export const ModalBody = ({ children }) => createElement('div', null, children);
export const ModalFooter = ({ children }) => createElement('footer', null, children);
`);

const source = await readFile(new URL('../src/components/ProjectSessions.tsx', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), '@nextui-org/react': nextuiStub, './SettingControls': settingControlsStub, 'lucide-react': dataUrl('export const Trash2 = () => null;') })) {
  outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const { default: ProjectSessions } = await import(dataUrl(outputText));

const workspace = { hash: 'aaa111', name: 'alpha', path: 'C:\\alpha' };

async function mount(count = 3, options = {}) {
  const { fail = false, refreshFail = false, workspace: targetWorkspace = workspace } = options;
  const sessions = options.sessions ?? Array.from({ length: count }, (_, index) => ({
    id: `${targetWorkspace.hash}/old-${index}`,
    name: `old-${index}`,
    title: `old-${index}`,
    workspace: targetWorkspace.name,
    workspaceHash: targetWorkspace.hash,
    kind: 'remote',
    messages: [],
    mtime: Date.now() - 31 * 24 * 60 * 60 * 1000,
  }));
  globalThis.__calls = [];
  const api = { request: async (path, method = 'GET', body) => {
    globalThis.__calls.push({ path, method, body });
    if (options.pending) await options.pending;
    if (options.respond) return options.respond(path, method, body);
    if (fail) return Promise.reject(new Error('保存失败'));
    if (path.endsWith('/name')) return Promise.resolve({ ...workspace, name: body.displayName || workspace.name, displayName: body.displayName || null });
    if (path.endsWith('/links')) return Promise.resolve({ ...targetWorkspace, ...body });
    if (path.startsWith('/sessions/cleanup?')) return Promise.resolve({ sessionNames: ['old-1', 'old-2'] });
    return Promise.resolve('ok');
  } };
  const events = [];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ProjectSessions, {
    api, workspace: targetWorkspace, workspaces: options.workspaces ?? [], count, sessions,
    onClose: () => events.push('close'),
    onRefresh: async () => { events.push('refresh'); if (refreshFail) throw new Error('离线'); },
    onCompleted: kind => events.push(`completed:${kind}`),
    onRenamed: (previous, next) => events.push(`renamed:${previous.name}:${next.name}`),
    onUpdated: (_hash, links) => events.push(`updated:${links.linkedProjectHashes.join(',')}${links.linkedProjectPaths.length ? `:${links.linkedProjectPaths.join(',')}` : ''}`),
    notify: message => events.push(`notify:${message}`),
  })));
  return { container, root, calls: () => globalThis.__calls, events, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === text);
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); }); }
async function openProjectPicker(view) {
  await click(buttonIn(view.container, '选择已有项目'));
  return view.container.querySelector('.project-picker-dialog');
}
const pickerCheckboxes = view => view.container.querySelectorAll('.project-picker-list input[type="checkbox"]');
const linkedRows = view => view.container.querySelectorAll('.project-dialog-linked-list > li');
const removeLinkButton = view => view.container.querySelector('.project-dialog-link-remove');
async function nameInput(view, value) {
  await act(async () => {
    const input = view.container.querySelector('#project-session-display-name');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function submitName(view) {
  await act(async () => view.container.querySelector('.project-dialog-rename').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
}
async function selectCleanupScope(view, value) {
  await act(async () => {
    const select = view.container.querySelector('select[aria-label="清理范围"]');
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}

const linked = { hash: 'bbb', name: '副项目', path: 'C:\\linked' };
async function pathInput(view, value) {
  await act(async () => {
    const input = view.container.querySelector('input[aria-label="副项目路径"]');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function submitPath(view) {
  await act(async () => view.container.querySelector('.project-dialog-link-add').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
}
function respondToLinkPath(path, _method, body) {
  if (path === '/system/pick-directory') return linked.path;
  if (path.endsWith('/links')) return { ...workspace, ...body };
  throw new Error(`Unexpected request: ${path}`);
}
const linksBody = (hashes = [], paths = []) => ({ linkedProjectHashes: hashes, linkedProjectPaths: paths });

test('the input opens an independent project picker and completion returns to the parent dialog', async () => {
  const view = await mount(3, { workspaces: [workspace, linked] });
  try {
    const trigger = buttonIn(view.container, '选择已有项目');
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(view.container.querySelector('.project-picker-dialog'), null);
    assert.equal(view.container.querySelectorAll('input[type="checkbox"]').length, 0);
    const picker = await openProjectPicker(view);
    assert.equal(picker.getAttribute('role'), 'dialog');
    assert.equal(picker.getAttribute('aria-label'), '选择已有项目');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(pickerCheckboxes(view).length, 1);
    await click(pickerCheckboxes(view)[0]);
    await click(buttonIn(picker, '完成'));
    assert.equal(view.container.querySelector('.project-picker-dialog'), null);
    assert.equal(view.container.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(linkedRows(view).length, 1);
    assert.match(linkedRows(view)[0].textContent, /副项目/);
    assert.equal(view.container.querySelectorAll('input[type="checkbox"]').length, 0);
    assert.deepEqual(view.calls(), [{ path: '/workspaces/aaa111/links', method: 'PUT', body: linksBody(['bbb']) }]);
    assert.ok(!view.events.includes('close'));
  } finally { await view.close(); }
});

test('an empty project picker can close without changing associations', async () => {
  const view = await mount();
  try {
    const picker = await openProjectPicker(view);
    assert.match(picker.textContent, /暂无已有项目/);
    await click(buttonIn(picker, '完成'));
    assert.equal(view.container.querySelector('.project-picker-dialog'), null);
    assert.deepEqual(view.calls(), []);
    assert.deepEqual(view.events, []);
  } finally { await view.close(); }
});

test('typing a path links only the directory without registering or switching projects', async () => {
  const view = await mount(3, { respond: respondToLinkPath });
  try {
    await pathInput(view, `  ${linked.path}  `);
    await submitPath(view);
    assert.deepEqual(view.calls(), [
      { path: '/workspaces/aaa111/links', method: 'PUT', body: linksBody([], [linked.path]) },
    ]);
    assert.equal(linkedRows(view).length, 1);
    assert.match(view.container.querySelector('.project-dialog-links-list').textContent, /linked/);
    assert.equal(view.container.querySelector('input[aria-label="副项目路径"]').value, '');
    assert.ok(!view.events.includes('close'));
  } finally { await view.close(); }
});

test('folder selection links its selected directory without creating a project', async () => {
  const view = await mount(3, { respond: respondToLinkPath });
  try {
    await pathInput(view, 'C:\\initial');
    await click(buttonIn(view.container, '选择文件夹'));
    assert.deepEqual(view.calls()[0], { path: '/system/pick-directory', method: 'POST', body: { path: 'C:\\initial' } });
    assert.deepEqual(view.calls()[1], { path: '/workspaces/aaa111/links', method: 'PUT', body: linksBody([], [linked.path]) });
    assert.equal(view.calls().length, 2);
    assert.equal(linkedRows(view).length, 1);
  } finally { await view.close(); }
});

test('cancelling directory selection preserves the path and makes no changes', async () => {
  const view = await mount(3, { respond: () => '' });
  try {
    await pathInput(view, 'C:\\draft');
    await click(buttonIn(view.container, '选择文件夹'));
    assert.equal(view.calls().length, 1);
    assert.equal(view.container.querySelector('input[aria-label="副项目路径"]').value, 'C:\\draft');
    assert.deepEqual(view.events, []);
    assert.equal(view.container.querySelector('[role="alert"]'), null);
  } finally { await view.close(); }
});

test('directory validation errors retain the draft and do not register a project', async () => {
  const view = await mount(3, { fail: true });
  try {
    await pathInput(view, 'C:\\missing'); await submitPath(view);
    assert.equal(view.calls().length, 1);
    assert.equal(view.container.querySelector('input[aria-label="副项目路径"]').value, 'C:\\missing');
    assert.match(view.container.querySelector('[role="alert"]').textContent, /保存失败/);
    assert.equal(buttonIn(view.container, '关联').disabled, false);
  } finally { await view.close(); }
});

test('link save failure rolls back the directory and preserves its draft for retry', async () => {
  let failLink = true;
  const view = await mount(3, { respond(path, method, body) {
    if (path.endsWith('/links') && failLink) throw new Error('关联保存失败');
    return respondToLinkPath(path, method, body);
  } });
  try {
    await pathInput(view, linked.path); await submitPath(view);
    assert.equal(linkedRows(view).length, 0);
    assert.equal(view.container.querySelector('input[aria-label="副项目路径"]').value, linked.path);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /关联保存失败/);
    failLink = false; await submitPath(view);
    assert.equal(linkedRows(view).length, 1);
    assert.equal(view.container.querySelectorAll('input[type="checkbox"]').length, 0);
  } finally { await view.close(); }
});

test('the server rejects self-links and duplicate existing-project paths make no request', async () => {
  const self = await mount(3, { respond: () => { throw new Error('不能将当前项目关联为副项目'); } });
  try {
    await pathInput(self, workspace.path); await submitPath(self);
    assert.equal(self.calls().length, 1);
    assert.match(self.container.querySelector('[role="alert"]').textContent, /不能将当前项目/);
  } finally { await self.close(); }
  const duplicate = await mount(3, { workspace: { ...workspace, linkedProjectHashes: [linked.hash] }, workspaces: [linked], respond: respondToLinkPath });
  try {
    await pathInput(duplicate, linked.path); await submitPath(duplicate);
    assert.equal(duplicate.calls().length, 0);
    assert.equal(linkedRows(duplicate).length, 1);
    assert.equal(duplicate.container.querySelectorAll('input[type="checkbox"]').length, 0);
  } finally { await duplicate.close(); }
});

test('saved directory links restore and can be removed without project records', async () => {
  const view = await mount(3, { workspace: { ...workspace, linkedProjectPaths: [linked.path] } });
  try {
    assert.equal(linkedRows(view).length, 1);
    assert.match(linkedRows(view)[0].textContent, /linked/);
    const picker = await openProjectPicker(view);
    assert.equal(pickerCheckboxes(view).length, 0);
    assert.match(picker.textContent, /暂无已有项目/);
    await click(buttonIn(picker, '完成'));
    await click(removeLinkButton(view));
    assert.deepEqual(view.calls(), [{ path: '/workspaces/aaa111/links', method: 'PUT', body: linksBody() }]);
    assert.equal(linkedRows(view).length, 0);
  } finally { await view.close(); }
});

test('duplicate directory paths do not save twice and canonical server paths replace the draft', async () => {
  const canonical = 'C:\\canonical\\linked';
  const view = await mount(3, { respond(_path, _method, body) { return { ...workspace, ...body, linkedProjectPaths: [canonical] }; } });
  try {
    await pathInput(view, linked.path); await submitPath(view);
    assert.equal(view.container.querySelector('input[aria-label="副项目路径"]').value, '');
    assert.ok(linkedRows(view)[0].textContent.includes(canonical));
    await pathInput(view, canonical); await submitPath(view);
    assert.equal(view.calls().length, 1);
    assert.equal(linkedRows(view).length, 1);
  } finally { await view.close(); }
});

test('a directory also listed as an existing project can be unchecked in the picker', async () => {
  const view = await mount(3, { workspace: { ...workspace, linkedProjectPaths: [linked.path] }, workspaces: [linked] });
  try {
    await openProjectPicker(view);
    assert.equal(pickerCheckboxes(view)[0].checked, true);
    await click(pickerCheckboxes(view)[0]);
    assert.deepEqual(view.calls()[0].body, linksBody());
    assert.equal(linkedRows(view).length, 0);
  } finally { await view.close(); }
});

test('queued project selection and directory removal preserve both lists in their latest snapshot', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const directory = 'C:\\directory-only';
  const view = await mount(3, { pending, workspace: { ...workspace, linkedProjectPaths: [directory] }, workspaces: [linked] });
  try {
    await openProjectPicker(view);
    await click(pickerCheckboxes(view)[0]);
    await click(buttonIn(view.container, '完成'));
    await click(view.container.querySelector('button[aria-label="解除关联 directory-only"]'));
    assert.equal(view.calls().length, 1);
    await act(async () => { resolve(); await pending; });
    assert.deepEqual(view.calls().map(call => call.body), [linksBody([linked.hash], [directory]), linksBody([linked.hash])]);
    assert.equal(linkedRows(view).length, 1);
    assert.match(linkedRows(view)[0].textContent, /副项目/);
  } finally { resolve(); await view.close(); }
});

test('the eight-link limit counts directories and existing projects together', async () => {
  const view = await mount(3, { workspace: { ...workspace, linkedProjectPaths: Array.from({ length: 7 }, (_, i) => `C:\\directory-${i}`), linkedProjectHashes: [linked.hash] }, workspaces: [linked, { hash: 'ccc', name: 'other', path: 'C:\\other' }] });
  try {
    await openProjectPicker(view);
    assert.equal(pickerCheckboxes(view)[0].disabled, false);
    assert.equal(pickerCheckboxes(view)[1].disabled, true);
    await click(pickerCheckboxes(view)[0]);
    assert.equal(pickerCheckboxes(view)[1].disabled, false);
    assert.equal(view.calls()[0].body.linkedProjectPaths.length, 7);
  } finally { await view.close(); }
});

test('eight saved links disable both path entry and folder selection', async () => {
  const view = await mount(3, { workspace: { ...workspace, linkedProjectHashes: Array.from({ length: 8 }, (_, i) => `p${i}`) } });
  try {
    assert.equal(view.container.querySelector('input[aria-label="副项目路径"]').readOnly, true);
    assert.equal(buttonIn(view.container, '选择文件夹').disabled, true);
    assert.equal(buttonIn(view.container, '选择已有项目').disabled, false);
    await submitPath(view);
    assert.deepEqual(view.calls(), []);
  } finally { await view.close(); }
});

test('persistent links distinguish same-name projects by hash and save without closing', async () => {
  const view = await mount(3, { workspaces: [workspace, { hash: 'bbb', name: 'same', path: 'C:\\one' }, { hash: 'ccc', name: 'same', path: 'D:\\two' }, { hash: 'chat', name: '纯聊天', kind: 'chat' }] });
  try {
    await openProjectPicker(view);
    const checkboxes = pickerCheckboxes(view);
    assert.equal(checkboxes.length, 2);
    await click(checkboxes[1]);
    assert.deepEqual(view.calls(), [{ path: '/workspaces/aaa111/links', method: 'PUT', body: linksBody(['ccc']) }]);
    assert.deepEqual(view.events, ['updated:ccc', 'notify:关联副项目已保存，将在下一轮生效', 'refresh']);
    assert.equal(buttonIn(view.container, '保存关联'), undefined);
  } finally { await view.close(); }
});

test('removing a saved link persists an empty list', async () => {
  const view = await mount(3, { workspace: { ...workspace, linkedProjectHashes: ['bbb'] }, workspaces: [{ hash: 'bbb', name: '副项目', path: 'C:\\linked' }] });
  try {
    await click(removeLinkButton(view));
    assert.deepEqual(view.calls()[0].body, linksBody());
    assert.equal(linkedRows(view).length, 0);
    assert.ok(!view.events.includes('close'));
  } finally { await view.close(); }
});

test('a failed unlink restores its project row and the remove button can retry', async () => {
  const view = await mount(3, { fail: true, workspace: { ...workspace, linkedProjectHashes: [linked.hash] }, workspaces: [linked] });
  try {
    assert.equal(view.container.querySelectorAll('input[type="checkbox"]').length, 0);
    assert.equal(removeLinkButton(view).getAttribute('aria-label'), '解除关联 副项目');
    await click(removeLinkButton(view));
    assert.equal(linkedRows(view).length, 1);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /保存失败/);
    assert.equal(removeLinkButton(view).disabled, false);
    await click(removeLinkButton(view));
    assert.deepEqual(view.calls().map(call => call.body), [linksBody(), linksBody()]);
  } finally { await view.close(); }
});

test('failed automatic link saves roll back the selection and allow retry', async () => {
  const view = await mount(3, { fail: true, workspaces: [{ hash: 'bbb', name: '副项目', path: 'C:\\linked' }] });
  try {
    await openProjectPicker(view);
    await click(pickerCheckboxes(view)[0]);
    assert.equal(pickerCheckboxes(view)[0].checked, false);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /保存失败/);
    assert.equal(pickerCheckboxes(view)[0].disabled, false);
    await click(pickerCheckboxes(view)[0]);
    assert.equal(view.calls().length, 2);
  } finally { await view.close(); }
});

test('a failed refresh retains saved links and distinguishes the refresh error', async () => {
  const view = await mount(3, { refreshFail: true, workspaces: [{ hash: 'bbb', name: '副项目', path: 'C:\\linked' }] });
  try {
    await openProjectPicker(view);
    await click(pickerCheckboxes(view)[0]);
    assert.equal(pickerCheckboxes(view)[0].checked, true);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /关联已保存，刷新项目失败：离线/);
  } finally { await view.close(); }
});

test('link selection enforces eight projects and permits removing missing links', async () => {
  const projects = Array.from({ length: 9 }, (_, i) => ({ hash: `p${i}`, name: `project ${i}`, path: `C:\\p${i}` }));
  const view = await mount(3, { workspace: { ...workspace, linkedProjectHashes: projects.slice(0, 8).map(item => item.hash) }, workspaces: projects });
  try {
    await openProjectPicker(view);
    const checkboxes = pickerCheckboxes(view);
    assert.equal(checkboxes[8].disabled, true);
    await click(checkboxes[0]);
    assert.equal(checkboxes[8].disabled, false);
  } finally { await view.close(); }
  const missing = await mount(3, { workspace: { ...workspace, linkedProjectHashes: ['removed'] } });
  try {
    assert.match(missing.container.textContent, /项目已移除/);
    await click(removeLinkButton(missing));
    assert.deepEqual(missing.calls()[0].body, linksBody());
  } finally { await missing.close(); }
});

test('background link saves keep controls active and persist the latest selection in order', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const view = await mount(3, { pending, workspaces: [{ hash: 'bbb', name: '副项目', path: 'C:\\linked' }, { hash: 'ccc', name: '另一个项目', path: 'C:\\other' }] });
  try {
    await openProjectPicker(view);
    const checkbox = pickerCheckboxes(view)[0];
    await click(checkbox);
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.disabled, false);
    assert.equal(buttonIn(view.container, '关闭').disabled, false);
    await click(checkbox);
    await click(pickerCheckboxes(view)[1]);
    assert.equal(view.calls().length, 1);
    assert.equal(checkbox.checked, false);
    await act(async () => { resolve(); await pending; });
    assert.deepEqual(view.calls().map(call => call.body.linkedProjectHashes), [['bbb'], ['ccc']]);
    assert.equal(checkbox.disabled, false);
    assert.equal(buttonIn(view.container, '关闭').disabled, false);
    assert.equal(checkbox.checked, false);
    assert.equal(pickerCheckboxes(view)[1].checked, true);
  } finally { resolve(); await view.close(); }
});

test('closing the dialog keeps queued saves running without reopening it', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const view = await mount(3, { pending, workspaces: [{ hash: 'bbb', name: '副项目', path: 'C:\\linked' }] });
  await openProjectPicker(view);
  await click(pickerCheckboxes(view)[0]);
  await click(pickerCheckboxes(view)[0]);
  await click(buttonIn(view.container, '完成'));
  await click(buttonIn(view.container, '关闭'));
  await view.close();
  await act(async () => { resolve(); await pending; });
  assert.deepEqual(view.calls().map(call => call.body.linkedProjectHashes), [['bbb'], []]);
  assert.ok(!view.events.some(event => event.startsWith('updated:')));
  assert.ok(view.events.includes('refresh'));
});

test('a failed older save cannot roll back a more recent selection', async () => {
  let reject;
  let requests = 0;
  const first = new Promise((_resolve, fail) => { reject = fail; });
  const view = await mount(3, { workspaces: [{ hash: 'bbb', name: '副项目', path: 'C:\\linked' }, { hash: 'ccc', name: '另一个项目', path: 'C:\\other' }], respond(_path, _method, body) {
    if (++requests === 1) return first;
    return { ...workspace, ...body };
  } });
  try {
    await openProjectPicker(view);
    const checkboxes = pickerCheckboxes(view);
    await click(checkboxes[0]); await click(checkboxes[1]);
    await act(async () => { reject(new Error('旧请求失败')); await first.catch(() => {}); });
    assert.deepEqual(view.calls().map(call => call.body.linkedProjectHashes), [['bbb'], ['bbb', 'ccc']]);
    assert.equal(checkboxes[0].checked, true); assert.equal(checkboxes[1].checked, true);
    assert.equal(view.container.querySelector('[role="alert"]'), null);
  } finally { await view.close(); }
});
test('the project sessions dialog saves display names without closing and updates its summary', async () => {
  const view = await mount();
  try {
    await nameInput(view, '  核心服务  '); await submitName(view);
    assert.deepEqual(view.calls(), [{ path: '/workspaces/aaa111/name', method: 'PUT', body: { displayName: '核心服务' } }]);
    assert.equal(view.container.querySelector('.project-dialog-summary strong').textContent, '核心服务');
    assert.ok(view.container.textContent.includes(workspace.path));
    assert.deepEqual(view.events, ['renamed:alpha:核心服务', 'notify:项目展示名称已保存', 'refresh']);
  } finally { await view.close(); }
});

test('an empty display name restores the directory name', async () => {
  const view = await mount();
  try {
    await nameInput(view, ''); await submitName(view);
    assert.equal(view.calls()[0].body.displayName, '');
    assert.equal(view.container.querySelector('.project-dialog-summary strong').textContent, 'alpha');
  } finally { await view.close(); }
});

test('failed name saves preserve the draft for retry', async () => {
  const view = await mount(3, { fail: true });
  try {
    await nameInput(view, '新名称'); await submitName(view);
    assert.equal(view.container.querySelector('input').value, '新名称');
    assert.equal(view.container.querySelector('.project-dialog-summary strong').textContent, 'alpha');
    assert.match(view.container.querySelector('[role="alert"]').textContent, /保存失败/);
    assert.deepEqual(view.events, []);
  } finally { await view.close(); }
});

test('a failed refresh after saving retains the confirmed name and reports the refresh failure', async () => {
  const view = await mount(3, { refreshFail: true });
  try {
    await nameInput(view, '新名称'); await submitName(view);
    assert.equal(view.container.querySelector('.project-dialog-summary strong').textContent, '新名称');
    assert.match(view.container.querySelector('[role="alert"]').textContent, /名称已保存，刷新项目失败：离线/);
    assert.ok(!view.events.includes('close'));
  } finally { await view.close(); }
});

test('project dialog shows the session count without a duplicate refresh action', async () => {
  const view = await mount(4);
  assert.match(view.container.textContent, /4 个会话/);
  assert.equal(buttonIn(view.container, '刷新会话列表'), undefined);
  assert.deepEqual(view.calls(), []);
  assert.deepEqual(view.events, []);
  await view.close();
});

test('all cleanup is one scope in the unified cleanup control', async () => {
  const view = await mount();
  await selectCleanupScope(view, 'all');
  await click(buttonIn(view.container, '清理会话'));
  assert.deepEqual(view.calls(), [{ path: '/sessions?workspaceHash=aaa111', method: 'DELETE', body: undefined }]);
  assert.deepEqual(view.events, ['refresh', 'completed:clear-all', 'notify:会话已清空', 'close']);
  await view.close();
});

test('the unified cleanup control offers 3 day, 7 day, 30 day, and all scopes', async () => {
  const view = await mount();
  try {
    const values = [...view.container.querySelectorAll('select[aria-label="清理范围"] option')].map(option => [option.value, option.textContent]);
    assert.deepEqual(values, [['3', '3 天前'], ['7', '7 天前'], ['30', '1 个月前'], ['all', '全部会话']]);
    for (const [value, days] of [['3', 3], ['7', 7], ['30', 30]]) {
      await selectCleanupScope(view, value);
      const before = Date.now();
      await click(buttonIn(view.container, '清理会话'));
      const after = Date.now();
      const call = view.calls().at(-1);
      const url = new URL(call.path, 'http://test.invalid');
      const cutoff = Number(url.searchParams.get('before'));
      assert.equal(call.method, 'DELETE');
      assert.equal(url.searchParams.get('workspaceHash'), 'aaa111');
      assert.ok(cutoff <= after - days * 24 * 60 * 60 * 1000);
      assert.ok(cutoff >= before - days * 24 * 60 * 60 * 1000 - 2000);
    }
    assert.deepEqual(view.events.filter(event => event.startsWith('completed:')), [
      'completed:clear-old',
      'completed:clear-old',
      'completed:clear-old',
    ]);
    assert.ok(view.events.includes('notify:已清理 2 个超过 30 天的会话'));
    assert.ok(!view.events.includes('close'));
  } finally {
    await view.close();
  }
});

test('the cleanup preview counts only sessions older than the selected scope', async () => {
  const now = Date.now();
  const session = (name, ageDays) => ({ id: `aaa111/${name}`, name, title: name, workspace: 'alpha', workspaceHash: 'aaa111', kind: 'remote', messages: [], mtime: now - ageDays * 24 * 60 * 60 * 1000 });
  const view = await mount(4, { sessions: [session('active', 1), session('old-3', 4), session('old-7', 8), session('old-30', 31)] });
  try {
    assert.match(view.container.querySelector('.project-dialog-cleanup-preview').textContent, /将删除 3 个超过 3 天未活动的会话/);
    await selectCleanupScope(view, '7');
    assert.match(view.container.querySelector('.project-dialog-cleanup-preview').textContent, /将删除 2 个超过 7 天未活动的会话/);
    await selectCleanupScope(view, '30');
    assert.match(view.container.querySelector('.project-dialog-cleanup-preview').textContent, /将删除 1 个超过 30 天未活动的会话/);
    await selectCleanupScope(view, 'all');
    assert.match(view.container.querySelector('.project-dialog-cleanup-preview').textContent, /将删除全部 4 个会话/);
  } finally {
    await view.close();
  }
});

test('deleting drops the project record from Loopra', async () => {
  const view = await mount();
  await click(buttonIn(view.container, '删除项目'));
  assert.deepEqual(view.calls(), [{ path: '/workspaces/aaa111', method: 'DELETE', body: undefined }]);
  assert.deepEqual(view.events, ['refresh', 'completed:delete', 'notify:项目已删除', 'close']);
  await view.close();
});

const chatWorkspace = { hash: '__loopra_chat__', name: '纯聊天', path: '', kind: 'chat' };

test('pure chat offers session maintenance without project name or deletion controls', async () => {
  const view = await mount(4, { workspace: chatWorkspace });
  try {
    assert.equal(view.container.querySelector('h2').textContent, '管理纯聊天会话');
    assert.equal(view.container.querySelector('.project-dialog-summary strong').textContent, '纯聊天');
    assert.equal(view.container.querySelector('.project-dialog-rename'), null);
    assert.equal(buttonIn(view.container, '删除项目'), undefined);
    assert.equal(view.container.querySelector('.project-dialog-summary p'), null);
    assert.equal(buttonIn(view.container, '刷新会话列表'), undefined);
    assert.deepEqual(view.calls(), []);
    assert.deepEqual(view.events, []);
  } finally { await view.close(); }
});

test('pure chat cleanup scopes both age-based and all-session requests to pure chat', async () => {
  const view = await mount(3, { workspace: chatWorkspace });
  try {
    await click(buttonIn(view.container, '清理会话'));
    const cleanup = new URL(view.calls()[0].path, 'http://test.invalid');
    assert.equal(cleanup.pathname, '/sessions/cleanup');
    assert.equal(cleanup.searchParams.get('workspaceHash'), chatWorkspace.hash);
    assert.equal(view.calls()[0].method, 'DELETE');
    await selectCleanupScope(view, 'all');
    await click(buttonIn(view.container, '清理会话'));
    assert.deepEqual(view.calls()[1], { path: '/sessions?workspaceHash=__loopra_chat__', method: 'DELETE', body: undefined });
  } finally { await view.close(); }
});

test('session cleanup only closes an active conversation in the affected workspace', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
  const maintained = app.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'projectMaintained');
  const { outputText } = ts.transpileModule(maintained.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const bind = new Function('activeId', 'workspace', 'workspaces', 'setActiveId', 'setWorkspace', `${outputText}; return projectMaintained;`);
  for (const [activeId, kind, target, deleted, expected] of [
    ['aaa111/current', 'clear-all', chatWorkspace, [], []],
    ['__loopra_chat__/current', 'clear-all', workspace, [], []],
    ['__loopra_chat__/current', 'clear-all', chatWorkspace, [], [null]],
    ['__loopra_chat__/current', 'clear-old', chatWorkspace, ['other'], []],
    ['__loopra_chat__/current', 'clear-old', chatWorkspace, ['current'], [null]],
    ['aaa111/current', 'clear-all', workspace, [], [null]],
  ]) {
    const selected = [];
    bind(activeId, 'aaa111', [workspace, chatWorkspace], id => selected.push(id), () => {})(kind, target, deleted);
    assert.deepEqual(selected, expected, `${activeId}: ${kind} ${target.hash}`);
  }
});
