import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const cache = new Map();
export async function sourceModule(file) {
  const url = new URL(file, new URL('../src/', import.meta.url));
  if (!cache.has(url.href)) cache.set(url.href, (async () => {
    const source = await readFile(url, 'utf8');
    let code = ts.transpileModule(source, { fileName: url.pathname, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    for (const item of ts.preProcessFile(code, true, true).importedFiles) {
      const specifier = item.fileName;
      const resolved = specifier.startsWith('@web/') ? await sourceModule(new URL(`../web/src/${specifier.slice(5)}.ts`, new URL('../', import.meta.url)).href)
        : specifier.startsWith('.') ? await sourceModule(new URL(/\.tsx?$/.test(specifier) ? specifier : `${specifier}.ts`, url).href) : import.meta.resolve(specifier);
      code = code.replaceAll(`'${specifier}'`, JSON.stringify(resolved)).replaceAll(`"${specifier}"`, JSON.stringify(resolved));
    }
    return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  })());
  return cache.get(url.href);
}
export const load = async file => import(await sourceModule(file));
