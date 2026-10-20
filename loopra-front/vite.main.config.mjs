import {defineConfig} from 'vite'
import {builtinModules} from 'node:module'

// Vite 配置 — 主进程
// 需要指定 entry + fileName(.cjs)，避免 "type": "module" 导致 ESM 报错
export default defineConfig({
  build: {
    lib: {
      entry: 'electron/main.cjs',
      fileName: () => '[name].cjs',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['electron', 'electron-updater', 'node-pty', ...builtinModules],
    },
    minify: false,
    sourcemap: true,
  },
})
