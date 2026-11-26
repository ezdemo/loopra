import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/i18n.ts', import.meta.url), 'utf8');
const start = source.indexOf('const zh = {');
if (start < 0) throw new Error('zh resources missing');
let depth = 0; let end = -1;
for (let index = source.indexOf('{', start); index < source.length; index += 1) {
  const char = source[index];
  if (char === '{') depth += 1;
  if (char === '}') {
    depth -= 1;
    if (depth === 0) { end = index + 1; break; }
  }
}
const zh = vm.runInNewContext(`(${source.slice(source.indexOf('{', start), end)})`);
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
export const reactI18nextStubUrl = dataUrl(`
const zh = ${JSON.stringify(zh)};
const interpolate = (text, params) => text.replace(/\\{\\{(\\w+)\\}\\}/g, (_, key) => params?.[key] ?? '');
const translate = (key, params) => interpolate(zh[key] ?? key, params);
export function useTranslation() {
  return { t: translate };
}
export default { t: translate };
`);
