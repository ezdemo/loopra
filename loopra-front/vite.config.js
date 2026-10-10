import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'
import react from '@vitejs/plugin-react'
import Components from 'unplugin-vue-components/vite'
import {AntDesignVueResolver} from 'unplugin-vue-components/resolvers'
import {resolve} from 'path'

// @vscode/codicons 的 codicon.css 源文件自带的 cache-busting query（`?9aab...`）
// 会被打包保留。http 下无影响，但打包后 Electron 走 file:// 协议，Chromium 会
// 把 `font.ttf?hash` 整体当作文件名查找导致字体加载失败（图标渲染成缺失字形）。
// Vite 产物文件名本身已含内容 hash，query 纯属冗余，这里在 transform 阶段直接移除。
const stripUrlQuery = {
  name: 'loopra-strip-codicon-url-query',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('@vscode/codicons') || !id.endsWith('codicon.css')) return null
    return code.replace(
      /url\((['"]?)([^)'"]+?)\?[^)'"]+\1\)/g,
      (match, quote, path) => `url(${quote}${path}${quote})`
    )
  }
}

export default defineConfig({
  base: './',
  plugins: [
    stripUrlQuery,
    react({ include: /web\/src\/.*\.[jt]sx?$/ }),
    vue({
      script: {
        defineModel: true,
        propsDestructure: true
      }
    }),
    Components({
      resolvers: [
        AntDesignVueResolver({
          importStyle: false // 不导入样式，使用主题
        })
      ],
      dts: false // 不生成类型声明文件
    })
  ],
  
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@components': resolve(__dirname, 'src/components'),
      '@views': resolve(__dirname, 'src/views'),
      '@assets': resolve(__dirname, 'src/assets'),
      '@stores': resolve(__dirname, 'src/stores'),
      '@utils': resolve(__dirname, 'src/utils'),
      '@services': resolve(__dirname, 'src/services')
    }
  },
  
  server: {
    port: 3000,
    host: '127.0.0.1',
    open: false,
      cors: true,
      // 开发环境下将 /api 请求代理到后端，避免跨域
      proxy: {
          '/api': {
              target: 'http://localhost:4567',
              changeOrigin: true
          }
      }
  },
  
  build: {
    outDir: 'dist/renderer',
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        legacy: resolve(__dirname, 'legacy.html')
      },
      output: {
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
        manualChunks(id) {
          if (id.includes('node_modules/vue') || id.includes('node_modules/vue-router') || id.includes('node_modules/pinia')) {
            return 'vue';
          }
          if (id.includes('node_modules/axios')) {
            return 'vendor';
          }
        }
      }
    },
    chunkSizeWarningLimit: 1000
  },
  
  css: {
    preprocessorOptions: {
      css: {
        charset: false
      }
    },
    devSourcemap: true
  },
  
  optimizeDeps: {
    include: ['vue', 'vue-router', 'pinia', 'axios'],
    exclude: []
  },
  
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false
  },
  
  envPrefix: 'VUE_APP_',

  // Web protocol tests use node:test; keep Vitest on the existing Vue suites.
  test: {
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}']
  },
  
  logLevel: 'info',
  
  clearScreen: true
})
