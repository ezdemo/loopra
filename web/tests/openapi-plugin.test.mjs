import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../../plugins/openapi/ui/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../plugins/openapi/ui/app.js', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../../internal/service/plugin/bridge.js', import.meta.url), 'utf8');
const page = html
  .replace('<script src="_loopra/bridge.js"></script>', () => `<script>${bridge.replaceAll('</script', '<\\/script')}</script>`)
  .replace('<script src="app.js"></script>', () => `<script>${script}</script>`);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(service) {
  const requests = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', url: 'https://plugin.test/', beforeParse(window) {
   window.postMessage = data => {
    if (data.op === 'hello') {
      queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { type: 'loopra', op: 'ready', theme: { text: '#222' }, context: { workspaceHash: 'demo' } } })));
      return;
    }
    if (data.op !== 'service:request') return;
    requests.push(data);
    Promise.resolve().then(() => service(data.action, data.value)).then(value => {
      window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { type: 'loopra', op: 'service:result', id: data.id, value } }));
    }, error => {
      window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { type: 'loopra', op: 'service:result', id: data.id, error: error.message } }));
    });
  };
  } });
  const { window } = dom;
  return { dom, window, document: window.document, requests, close: () => dom.window.close() };
}

test('OpenAPI plugin saves credentials, searches and reads API details', async () => {
  let sources = [];
  const ui = setup(async (action, value) => {
    if (action === 'sources') return sources;
    if (action === 'save') { sources = [{ ...value, status: 'loaded' }]; return sources[0]; }
    if (action === 'search') return [{ api_name: '查询订单', endpoint: 'GET /orders/{id}', docUrl: sources[0].docUrl, method: 'GET', path: '/orders/{id}' }];
    if (action === 'detail') return { endpoint: 'GET /orders/{id}', baseUrl: 'https://service.test', description: '<img src=x onerror=alert(1)>', parameters: [{ name: 'id', in: 'path', schema: { type: 'string' }, required: true }], responses: { 200: { description: '成功' } } };
    throw new Error(action);
  });
  try {
    await settle();
    const d = ui.document;
    assert.match(d.querySelector('#sources').textContent, /尚未添加/);
    d.querySelector('#add').click();
    d.querySelector('#doc-url').value = 'https://service.test/openapi.yaml';
    d.querySelector('#name').value = '订单';
    d.querySelector('#auth-type').value = 'basic';
    d.querySelector('#auth-type').dispatchEvent(new ui.window.Event('change'));
    d.querySelector('#username').value = 'tester';
    d.querySelector('input[type="password"]#password').value = 'test-secret';
    d.querySelector('#headers').value = 'X-Tenant: demo';
    d.querySelector('#save').click();
    await settle();
    const saved = ui.requests.find(item => item.action === 'save').value;
    assert.deepEqual(JSON.parse(JSON.stringify(saved.authConfig)), { username: 'tester', password: 'test-secret' });
    assert.deepEqual(JSON.parse(JSON.stringify(saved.headers)), { 'X-Tenant': 'demo' });
    assert.match(d.querySelector('#sources').textContent, /订单/);
    d.querySelector('#keyword').value = '订单';
    d.querySelector('#search').click();
    await settle();
    assert.match(d.querySelector('#results').textContent, /GET \/orders/);
    d.querySelector('#results button').click();
    await settle();
    assert.equal(d.querySelector('#detail').hidden, false);
    assert.match(d.querySelector('#detail-content').textContent, /required/);
    assert.match(d.querySelector('#detail-overview table').textContent, /idpathstring是/);
    assert.match(d.querySelector('#detail-overview').textContent, /200  成功/);
    assert.equal(d.querySelector('#detail-overview img'), null, 'document text must remain inert');
    assert.ok(ui.requests.every(item => !JSON.stringify(item).includes('accessKey')));
  } finally { ui.close(); }
});

test('OpenAPI plugin shows service errors and keeps failed sources editable', async () => {
  const ui = setup(async (action, value) => {
    if (action === 'sources') return [{ docUrl: 'https://service.test/spec', status: 'error', errorMessage: 'HTTP 401' }];
    throw new Error('文档认证失败');
  });
  try {
    await settle();
    const d = ui.document;
    assert.match(d.querySelector('#sources').textContent, /HTTP 401/);
    d.querySelector('#sources button').click();
    await settle();
    assert.equal(d.querySelector('#doc-url').readOnly, true);
    d.querySelector('#save').click();
    await settle();
    assert.match(d.querySelector('#status').textContent, /认证失败/);
    assert.equal(d.querySelector('#editor').hidden, false);
    assert.equal(d.querySelector('#save').disabled, false);
  } finally { ui.close(); }
});
