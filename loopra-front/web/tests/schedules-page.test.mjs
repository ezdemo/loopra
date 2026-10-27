import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { Simulate } = await import('react-dom/test-utils');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies) {
  const source = await readFile(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const ui = dataUrl(`const React = await import(${JSON.stringify(reactUrl)}); export const Button = ({children,onPress,startContent,isDisabled,isLoading,isIconOnly,color,variant,size,...props}) => React.createElement('button',{...props,onClick:onPress,disabled:isDisabled||isLoading},children); export const Checkbox = ({children,isSelected,onValueChange}) => React.createElement('label',null,React.createElement('input',{type:'checkbox',checked:isSelected,onChange:e=>onValueChange(e.target.checked)}),children); export const Input = ({onValueChange,variant,...props}) => React.createElement('input',{...props,onChange:e=>onValueChange(e.target.value)}); export const Textarea = ({onValueChange,minRows,maxRows,disableAutosize,variant,...props}) => React.createElement('textarea',{...props,onChange:e=>onValueChange(e.target.value)}); export const Modal = ({children,isOpen}) => isOpen ? React.createElement('div',{role:'dialog'},children) : null; export const ModalContent = ({children}) => React.createElement('div',null,children); export const ModalHeader = ModalContent, ModalBody = ModalContent, ModalFooter = ModalContent; export const RadioGroup = ({children,value,onValueChange}) => React.createElement('div',null,React.Children.map(children, child => React.cloneElement(child,{selected:child.props.value===value,onValueChange}))); export const Radio = ({children,value,selected,onValueChange}) => React.createElement('label',null,React.createElement('input',{type:'radio',value,checked:selected,onChange:()=>onValueChange(value)}),children); export const Switch = ({isSelected,onValueChange,isDisabled,...props}) => React.createElement('button',{'aria-label':props['aria-label'],onClick:()=>onValueChange?.(!isSelected),disabled:isDisabled},isSelected ? 'on' : 'off'); export const Tab = () => null; export const Tabs = ({children,onSelectionChange}) => React.createElement('div',null,React.Children.map(children, child => React.createElement('button',{onClick:()=>onSelectionChange(child.props.title === '定时任务' ? 'tasks' : 'runs')},child.props.title)));`);
const icons = dataUrl('export const AlertCircle=()=>null, AlarmClock=()=>null, Pencil=()=>null, Play=()=>null, RefreshCw=()=>null, Trash2=()=>null;');
const fields = dataUrl(`const React = await import(${JSON.stringify(reactUrl)});
export const SelectField = ({label,value,onChange,options,disabled}) => React.createElement('label',null,label,React.createElement('select',{value,disabled,onChange:e=>onChange(e.target.value)},options.map(item=>React.createElement('option',{key:item.value,value:item.value},item.label))));
export const Field = ({label,value,onChange}) => React.createElement('label',null,label,React.createElement('input',{value,onChange:e=>onChange(e.target.value)}));
export const TextField = ({label,value,onChange}) => React.createElement('label',null,label,React.createElement('textarea',{value,onChange:e=>onChange(e.target.value)}));`);
const controls = dataUrl(`const React = await import(${JSON.stringify(reactUrl)});
export const query = values => new URLSearchParams(values).toString();
export const errorText = error => error.message;
export const RemoteState = ({error}) => error ? React.createElement('p',null,error) : null;
export const ConfirmAction = () => null;
export function useRemote(api,path,revision) { const [state,setState] = React.useState({loading:true,error:''}); React.useEffect(() => { let live=true; api.request(path).then(data => { if(live) setState({data,loading:false,error:''}); }); return () => {live=false}; },[api,path,revision]); return state; }`);
const panel = await sourceUrl('SchedulePanel', { '@nextui-org/react': ui, 'lucide-react': icons, './RemoteControls': controls, './SettingControls': fields });
const Page = (await import(await sourceUrl('SchedulesPage', { '@nextui-org/react': ui, 'lucide-react': icons, './SchedulePanel': panel, './SettingControls': fields }))).default;

test('shows all project tasks, filters status and scopes actions to the selected project', async () => {
  const calls = [];
  const opened = [];
  const api = { request: async (path, method = 'GET') => { calls.push({path, method}); if (method !== 'GET') return {}; const alpha = path.includes('alpha'); return [{id:'t',name:alpha?'甲任务':'乙任务',sessionName:'session',message:'执行',cronExpr:null,intervalSec:60,enabled:alpha,runs:alpha?[{id:'r1',startedAt:1,status:'success',message:'执行甲',result:'结果甲',sessionName:'session-one'},{id:'r2',startedAt:2,status:'error',message:'执行乙',error:'错误乙',sessionName:'session-two'}]:[{id:'r3',startedAt:0,status:'success',message:'执行丙',result:'结果丙',sessionName:'session-three'}]}]; } };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Page, { api, workspaces:[{hash:'alpha',name:'甲项目',path:'/a'},{hash:'beta',name:'乙项目',path:'/b'}], sessions:[], onBack() {}, onOpenSession: (...args) => opened.push(args) })));
    assert.match(container.textContent, /甲任务/); assert.match(container.textContent, /乙任务/);
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent.includes('已暂停 (1)')).click(); });
    assert.doesNotMatch(container.textContent, /甲任务/); assert.match(container.textContent, /乙任务/);
    await act(async () => { container.querySelector('[aria-label="启用 乙任务"]').click(); });
    assert.ok(calls.some(call => call.path === '/schedules/t/toggle?workspaceHash=beta' && call.method === 'POST'));
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === '运行记录').click(); });
    assert.equal(container.querySelectorAll('.automation-record-row').length, 3);
    const runFilter = container.querySelector('.automation-run-toolbar select');
    assert.equal(runFilter.value, 'all');
    assert.match(runFilter.textContent, /全部任务/);
    await act(async () => { Simulate.change(runFilter, { target: { value: 'alpha/t' } }); });
    assert.equal(container.querySelectorAll('.automation-record-row').length, 2);
    await act(async () => { Simulate.change(runFilter, { target: { value: 'all' } }); });
    await act(async () => { container.querySelector('.automation-record-row').click(); });
    assert.match(container.textContent, /错误乙/);
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === '打开会话').click(); });
    assert.deepEqual(opened, [['alpha', 'session-two']]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test('creates a daily task that starts a separate session for every run', async () => {
  const calls = [];
  const api = { request: async (path, method = 'GET', body) => { calls.push({ path, method, body }); return method === 'GET' ? [] : {}; } };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Page, { api, workspaces: [{ hash: 'project', name: '项目', path: '/p' }], sessions: [{ id: 'one', name: 'session', title: '会话', workspaceHash: 'project' }], onBack() {} })));
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === '新建自动化').click(); });
    const targetField = () => [...container.querySelectorAll('label')].find(label => label.textContent.includes('目标会话'));
    assert.equal(targetField(), undefined);
    await act(async () => { Simulate.change(container.querySelector('input[type="radio"][value="existing"]')); });
    const targetSelect = targetField().querySelector('select');
    assert.equal(targetSelect.disabled, false);
    assert.equal(targetSelect.value, 'session');
    await act(async () => { Simulate.change(container.querySelector('input[type="radio"][value="independent"]')); });
    assert.equal(targetField(), undefined);
    const name = container.querySelector('[aria-label="自动化任务名称"]');
    const message = container.querySelector('[aria-label="自动化工作内容"]');
    await act(async () => { Simulate.change(name, { target: { value: '每日检查' } }); });
    await act(async () => { Simulate.change(message, { target: { value: '检查项目' } }); });
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === '创建').click(); });
    const created = calls.find(call => call.method === 'POST');
    assert.equal(created.path, '/schedules?workspaceHash=project');
    assert.equal(created.body.sessionMode, 'independent');
    assert.equal(created.body.sessionName, '');
    assert.equal(created.body.cronExpr, '0 0 9 * * ?');
    assert.equal(created.body.message, '检查项目');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
