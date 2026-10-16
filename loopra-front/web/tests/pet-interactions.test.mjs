import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// DOM-only tests: no live backend, browser storage, workspaces or sessions.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} } };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
function dataUrl(code) { return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'); }
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [name, url] of Object.entries({ react: import.meta.resolve('react'), 'react-dom': import.meta.resolve('react-dom'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'lucide-react': import.meta.resolve('lucide-react'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url)).replaceAll(`"${name}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const petsUrl = await sourceUrl('pets.ts');
const spriteUrl = await sourceUrl('components/PetSprite.tsx', { '../pets': petsUrl, './Motion': dataUrl('export const useAppMotion = () => ({ enabled: false });') });
const companionUrl = await sourceUrl('components/PetCompanion.tsx', { '../pets': petsUrl, './PetSprite': spriteUrl });
const { default: PetCompanion } = await import(companionUrl);
const { default: usePets } = await import(await sourceUrl('usePets.ts', { './pets': petsUrl }));

dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const anchor = this.classList.contains('pet-anchor');
  const panel = this.classList.contains('pet-panel');
  const left = anchor ? 800 : Number.parseFloat(this.style.left) || 0;
  const top = anchor ? 500 : Number.parseFloat(this.style.top) || 0;
  const width = Number.parseFloat(this.style.width) || (panel ? 240 : 80);
  const height = Number.parseFloat(this.style.height) || (panel ? 180 : 86);
  return { left, top, x: left, y: top, width, height, right: left + width, bottom: top + height };
};
function pointer(element, type, values = {}) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 840, clientY: 540, ...values });
  element.dispatchEvent(event);
}
async function mount(overrides = {}) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const calls = { moves: [], scales: [], closes: 0, errors: [] };
  let props = { src: '/fake-sprite.webp', name: 'Boba', scale: 0.55, activity: 'idle', reply: null, latestReply: '', position: { x: 0, y: 0 },
    onMove: async next => { calls.moves.push(next); }, onResize: async next => { calls.scales.push(next); }, onClose: () => { calls.closes++; }, onError: text => calls.errors.push(text), ...overrides };
  await act(async () => root.render(createElement(PetCompanion, props)));
  const avatar = document.querySelector('.pet-avatar');
  let captured = false;
  avatar.setPointerCapture = () => { captured = true; };
  avatar.hasPointerCapture = () => captured;
  avatar.releasePointerCapture = () => { captured = false; };
  return { avatar, calls, async render(change) { props = { ...props, ...change }; await act(async () => root.render(createElement(PetCompanion, props))); },
    async close() { await act(async () => root.unmount()); container.remove(); } };
}
function button(text) { return [...document.querySelectorAll('.pet-panel button')].find(element => element.textContent.trim() === text); }

test('drag runs in the correct direction, saves once on release and suppresses click; cancellation restores position', async () => {
  const view = await mount({ position: { x: 20, y: -10 } });
  try {
    await act(async () => pointer(view.avatar, 'pointerdown'));
    await act(async () => pointer(view.avatar, 'pointermove', { clientX: 838, clientY: 540 }));
    assert.equal(view.calls.moves.length, 0);
    await act(async () => pointer(view.avatar, 'pointermove', { clientX: 720, clientY: 480 }));
    assert.equal(document.querySelector('.pet-sprite').dataset.petAnimation, 'running-left');
    assert.equal(document.querySelector('.pet-companion').style.left, '700px');
    await act(async () => pointer(view.avatar, 'pointerup', { clientX: 720, clientY: 480 }));
    await act(async () => view.avatar.click());
    assert.deepEqual(view.calls.moves, [{ x: -100, y: -70 }]);
    assert.equal(document.querySelector('[aria-label="宠物气泡"]'), null);
    await act(async () => pointer(view.avatar, 'pointerdown'));
    await act(async () => pointer(view.avatar, 'pointermove', { clientX: 940 }));
    await act(async () => pointer(view.avatar, 'pointercancel'));
    assert.equal(document.querySelector('.pet-companion').style.left, '700px');
    assert.equal(view.calls.moves.length, 1);
  } finally { await view.close(); }
});

test('right-click scale commits once, and close requires confirmation with a working cancel path', async () => {
  const view = await mount();
  try {
    await act(async () => view.avatar.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const slider = document.querySelector('input[aria-label="宠物大小"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(slider, '0.8');
      slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => { pointer(slider, 'pointerup'); slider.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })); });
    assert.deepEqual(view.calls.scales, [0.8]);
    await act(async () => button('关闭宠物').click());
    assert.ok(document.querySelector('[role="alertdialog"]'));
    assert.equal(view.calls.closes, 0);
    await act(async () => button('取消').click());
    assert.equal(view.calls.closes, 0);
    await act(async () => button('关闭宠物').click());
    await act(async () => button('关闭').click());
    assert.equal(view.calls.closes, 1);
    assert.equal(document.querySelector('.pet-panel'), null);
  } finally { await view.close(); }
});

test('touch long-press opens controls without dragging, activating or saving a position', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = await mount();
  try {
    await act(async () => pointer(view.avatar, 'pointerdown', { pointerType: 'touch' }));
    await act(async () => t.mock.timers.tick(500));
    assert.ok(document.querySelector('[aria-label="宠物操作"]'));
    await act(async () => { pointer(view.avatar, 'pointerup', { pointerType: 'touch' }); view.avatar.click(); });
    assert.equal(view.calls.moves.length, 0);
    assert.equal(document.querySelector('[aria-label="宠物气泡"]'), null);
  } finally { await view.close(); }
});

test('click shows the latest reply, double-click jumps, new replies replace the bubble and expire', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = await mount({ latestReply: '已经完成修复。' });
  try {
    await act(async () => view.avatar.click());
    assert.equal(document.querySelector('.pet-reply-bubble span').textContent, '已经完成修复。');
    await act(async () => view.avatar.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })));
    assert.equal(document.querySelector('.pet-sprite').dataset.petAnimation, 'jumping');
    await view.render({ reply: { id: 'new-answer', text: '新回复已完成。' } });
    assert.equal(document.querySelector('.pet-reply-bubble span').textContent, '新回复已完成。');
    await act(async () => t.mock.timers.tick(8000));
    assert.equal(document.querySelector('.pet-reply-bubble'), null);
  } finally { await view.close(); }
});

test('keyboard moves persist, Home resets position, and failed saves restore the previous position', async () => {
  const view = await mount();
  try {
    await act(async () => view.avatar.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true })));
    assert.deepEqual(view.calls.moves.at(-1), { x: -40, y: 0 });
    await act(async () => view.avatar.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    assert.deepEqual(view.calls.moves.at(-1), { x: 0, y: 0 });
    await view.render({ onMove: async () => { throw new Error('服务离线'); } });
    await act(async () => view.avatar.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    assert.equal(document.querySelector('.pet-companion').style.left, '800px');
    assert.match(view.calls.errors.at(-1), /保存宠物位置失败.*服务离线/);
  } finally { await view.close(); }
});

test('move and scale writes are serialized and merged through the legacy endpoint, without touching sessions', async () => {
  const requests = []; let inFlight = 0, maxInFlight = 0, pets;
  const api = { assetUrl: path => `/api${path}`, async request(path, method, body) {
    requests.push({ path, method, body });
    if (method === 'PUT') { maxInFlight = Math.max(maxInFlight, ++inFlight); await Promise.resolve(); inFlight--; return '已保存'; }
    return path === '/pets' ? [{ name: 'boba', hasSpritesheet: true }] : { active: true, name: 'boba', position: { x: 0, y: 0 } };
  } };
  function Harness() { pets = usePets(api, true); return null; }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => Promise.all([pets.move({ x: -123.4, y: -45.6 }), pets.resize(0.8)]));
    assert.equal(maxInFlight, 1);
    assert.deepEqual(pets.active.position, { x: -123, y: -46 });
    assert.equal(pets.active.scale, 0.8);
    assert.deepEqual(requests.filter(request => request.method === 'PUT'), [
      { path: '/pets/position', method: 'PUT', body: { x: -123, y: -46 } },
      { path: '/pets/position', method: 'PUT', body: { scale: 0.8 } },
    ]);
    assert.ok(requests.every(request => request.path.startsWith('/pets')));
  } finally { await act(async () => root.unmount()); container.remove(); }
});
