import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
  plugins: [react()],
  publicDir: fileURLToPath(new URL('../web/public', import.meta.url)),
  resolve: {
    alias: { '@web': fileURLToPath(new URL('../web/src', import.meta.url)) },
    dedupe: ['react', 'react-dom', '@nextui-org/react', 'framer-motion'],
  },
  clearScreen: false,
  server: { host: host || '127.0.0.1', port: 1420, strictPort: true, fs: { allow: ['..'] }, watch: { ignored: ['**/src-tauri/**'] }, hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
