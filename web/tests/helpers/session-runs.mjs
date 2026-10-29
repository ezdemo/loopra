import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../../src/session-runs.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
export const { SessionRuns, sessionRunKey, draftRunKey, isRunView } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
