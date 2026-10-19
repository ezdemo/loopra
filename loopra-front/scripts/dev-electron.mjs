import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentElectron } from './electron-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const origin = 'http://127.0.0.1:3000';
const temporary = join(root, '.cache', 'desktop-temp');
await mkdir(temporary, { recursive: true });
// Keep Vite/esbuild temporary files in the writable project directory.
process.env.TEMP = temporary;
process.env.TMP = temporary;
process.chdir(root);
const { build, createServer } = await import('vite');
const require = createRequire(import.meta.url);
let server;
let electron;

async function close() {
  await server?.close();
}

try {
  await build({ configFile: join(root, 'vite.main.config.mjs'), build: { outDir: 'dist/main' } });
  await build({ configFile: join(root, 'vite.preload.config.mjs'), build: { outDir: 'dist/main', emptyOutDir: false } });
  // Vite's build API sets NODE_ENV=production; reset it for React refresh.
  process.env.NODE_ENV = 'development';

  let existing = false;
  try {
    const response = await fetch(`${origin}/src/entry.js`, { signal: AbortSignal.timeout(1500) });
    existing = response.ok && (await response.text()).includes('usesLegacyRenderer');
  } catch { /* Start an owned server if none is reachable. */ }
  if (existing) {
    console.log(`[desktop] Reusing Loopra dev server at ${origin}`);
  } else {
    server = await createServer({ configFile: join(root, 'vite.config.js'), server: { host: '127.0.0.1', port: 3000, strictPort: true } });
    await server.listen();
    server.printUrls();
  }

  const env = { ...process.env, NODE_ENV: 'development' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = await developmentElectron(require('electron'), require('electron/package.json').version);
  electron = spawn(executable, ['.'], { cwd: root, env, stdio: 'inherit', windowsHide: false });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { electron.kill(); void close(); });
  }
  const code = await new Promise((resolve, reject) => {
    electron.once('error', reject);
    electron.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (code) console.error(`[desktop] Electron exited with code ${code} (0x${(code >>> 0).toString(16)}).`);
  process.exitCode = code ? 1 : 0;
} catch (error) {
  console.error('[desktop] Startup failed:', error);
  process.exitCode = 1;
} finally {
  await close();
}
