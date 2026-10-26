import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Update commands / prompt ported from the legacy src/utils/updateScripts.js.
const memory = new Map();
globalThis.localStorage = {
  getItem: key => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: key => memory.delete(key),
};

const source = await readFile(new URL('../src/update-scripts.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { buildUpdateCommand, buildUpdatePrompt, compareVersions, updateScriptName, loadUpdateSource, saveUpdateSource, UPDATE_SOURCE_NORMAL, UPDATE_SOURCE_MIRROR, MIRROR_SOURCES } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('builds direct and mirror update commands per platform', () => {
  const direct = buildUpdateCommand(UPDATE_SOURCE_NORMAL);
  assert.match(direct.windows, /setup\.ps1 \| iex$/);
  assert.equal(direct.windows, 'irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.ps1 | iex');
  assert.match(direct.unix, /setup\.sh \| bash$/);
  const mirror = buildUpdateCommand('https://gh-proxy.org/');
  assert.equal(mirror.windows, "$env:LOOPRA_MIRROR='https://gh-proxy.org/'; " + direct.windows);
  assert.equal(mirror.unix, "export LOOPRA_MIRROR='https://gh-proxy.org/'; " + direct.unix);
  assert.equal(updateScriptName(UPDATE_SOURCE_NORMAL, true, 'ps1'), 'setup-gui.ps1');
});

test('all explicit mirrors use the same official scripts, including GUI variants', () => {
  for (const source of MIRROR_SOURCES) {
    for (const gui of [false, true]) {
      const direct = buildUpdateCommand(UPDATE_SOURCE_NORMAL, gui);
      const mirrored = buildUpdateCommand(source.value, gui);
      assert.equal(mirrored.windows, `$env:LOOPRA_MIRROR='${source.value}'; ` + direct.windows);
      assert.equal(mirrored.unix, `export LOOPRA_MIRROR='${source.value}'; ` + direct.unix);
    }
  }
  assert.equal(buildUpdateCommand(UPDATE_SOURCE_MIRROR).windows, 'irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-mirror.ps1 | iex');
  assert.equal(buildUpdateCommand(UPDATE_SOURCE_MIRROR, true).unix, 'curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup-gui-mirror.sh | bash');
});

test('the update prompt names the source and both platforms', () => {
  const prompt = buildUpdatePrompt(UPDATE_SOURCE_NORMAL);
  assert.match(prompt, /GitHub 直连/);
  assert.match(prompt, /PowerShell/);
  assert.match(prompt, /macOS \/ Linux/);
  assert.match(buildUpdatePrompt('https://wget.la/'), /镜像（https:\/\/wget\.la\/）/);
});

test('compares semantic versions ignoring a leading v', () => {
  assert.ok(compareVersions('26.9.91', '26.9.90') > 0);
  assert.ok(compareVersions('v26.9.9', '26.9.10') < 0);
  assert.equal(compareVersions('26.9', '26.9.0'), 0);
});

test('persists the update source and rejects unknown values', () => {
  assert.equal(loadUpdateSource(), UPDATE_SOURCE_NORMAL);
  saveUpdateSource(MIRROR_SOURCES[0].value);
  assert.equal(loadUpdateSource(), MIRROR_SOURCES[0].value);
  saveUpdateSource('https://evil.example/');
  assert.equal(loadUpdateSource(), MIRROR_SOURCES[0].value);
  saveUpdateSource(UPDATE_SOURCE_NORMAL);
  assert.equal(memory.has('loopra.updateSource'), false);
});
