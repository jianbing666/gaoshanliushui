import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// 前端单元测试配置
//
// 只跑纯逻辑 (工具函数 / store 计算), 不加载 Vue 组件与 Tauri IPC ——
// 那些需要真实 WebView 环境, 属于后续的集成测试范围。
export default defineConfig({
  test: {
    // storage.ts 依赖 localStorage, 需要 DOM 环境
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // Tauri 的 invoke 在单测中不可用, 相关模块需自行 mock
    clearMocks: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
