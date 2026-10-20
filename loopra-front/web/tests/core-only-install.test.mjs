import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const gitBash = join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe');
for (const kind of ['powershell', 'bash']) {
  const available = kind === 'powershell' ? process.platform === 'win32' : process.platform !== 'win32' || existsSync(gitBash);
  test(`${kind}: desktop core updates without probing Java or downloading JRE`, { skip: !available }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'loopra-core-install-'));
    try {
      const source = join(fixture, 'source');
      const home = join(fixture, 'home');
      await mkdir(join(source, 'bin'), { recursive: true });
      await mkdir(join(home, '.loopra'), { recursive: true });
      await mkdir(join(home, '.loopra-gui', 'bin'), { recursive: true });
      await writeFile(join(source, 'bin', 'loopra-web.jar'), 'updated-core');
      await writeFile(join(source, 'bin', 'version.txt'), '26.9.92');
      await writeFile(join(home, '.loopra-gui', 'bin', 'version.txt'), '26.9.91');
      await writeFile(join(source, 'config.json'), '{"fresh":true}');
      await writeFile(join(home, '.loopra', 'config.json'), '{"preserved":true}');
      let result;
      if (kind === 'powershell') {
        await copyFile(new URL('../../../loopra/src/installDist/install.ps1', import.meta.url), join(source, 'install.ps1'));
        const wrapper = join(fixture, 'run.ps1');
        await writeFile(wrapper, `function Get-Command { throw 'Java must not be probed' }\nfunction Invoke-WebRequest { throw 'JRE must not be downloaded' }\nfunction Invoke-RestMethod { throw 'JRE must not be downloaded' }\n& (Join-Path $PSScriptRoot 'source/install.ps1') -Gui -Setup -SkipJava\n`);
        result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, USERPROFILE: home } });
      } else {
        await copyFile(new URL('../../../loopra/src/installDist/install.sh', import.meta.url), join(source, 'install.sh'));
        const wrapper = 'java() { echo "Unexpected Java invocation" >&2; return 91; }; curl() { return 91; }; wget() { return 91; }; export -f java curl wget; bash "$1" --gui --setup --skip-java';
        result = spawnSync(process.platform === 'win32' ? gitBash : 'bash', ['-c', wrapper, 'test', join(source, 'install.sh').replaceAll('\\', '/')], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, HOME: home.replaceAll('\\', '/') } });
      }
      assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Core-only install/);
      assert.equal(await readFile(join(home, '.loopra-gui', 'bin', 'loopra-web.jar'), 'utf8'), 'updated-core');
      assert.equal(await readFile(join(home, '.loopra-gui', 'bin', 'version.txt'), 'utf8'), '26.9.92');
      assert.equal(await readFile(join(home, '.loopra', 'config.json'), 'utf8'), '{"preserved":true}');
      assert.ok(existsSync(join(home, '.loopra-gui', 'bin', 'loopra')));
      assert.equal(existsSync(join(home, '.loopra-gui', 'jre25')), false);
    } finally {
      assert.ok(resolve(fixture).startsWith(resolve(tmpdir()) + sep));
      assert.ok(basename(fixture).startsWith('loopra-core-install-'));
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
