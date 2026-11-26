// Real accent-color.ts as a data: URL, so module loaders in the protocol tests
// can resolve the './accent-color' specifier that lib.ts and document-theme.ts
// import. Pure logic, no stubbing.
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../../src/accent-color.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
export const accentColorUrl = 'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64');
