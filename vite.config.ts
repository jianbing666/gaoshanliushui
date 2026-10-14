import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    // 阶段 1.8: Vite manualChunks 拆包
    // 目的: 第三方依赖拆为独立 chunk, 命中浏览器缓存, 二次启动可并行下载
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@tauri-apps')) return 'tauri-api'
            // marked 只被异步的 MemoryDrawer 使用: 不进 vendor, 让它随该 chunk 按需加载,
            // 否则整个 38KB 会被静态引入的 vendor 拖进启动关键路径.
            if (id.includes('/node_modules/marked/')) return
            if (id.includes('pinia')) return 'pinia'
            if (id.includes('@vue') || id.includes('/vue/')) return 'vue'
            return 'vendor'
          }
        },
      },
    },
  },
})
