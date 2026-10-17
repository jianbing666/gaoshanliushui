import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'
// 阶段 2.1: 虚拟滚动样式
import './styles/virtual-scroller.css'
// 2026-07-14: 托盘/快捷键/媒体键事件监听器必须在最早期注册
//   原因: Vue 组件挂载前可能错过事件, 且 webview 冻结后重启时
//   监听器是 Rust 唤醒 webview 的唯一信号源


// 记录 JS 启动基准时刻 (供按需加载的性能记录器计算启动耗时)
const bootAt = performance.now()
;(window as unknown as { __bootAt?: number }).__bootAt = bootAt

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')

// 标记"应用已可交互", 供性能记录器计算 JS 启动耗时
nextTick(() => {
  ;(window as unknown as { __appReadyAt?: number }).__appReadyAt = performance.now()
  window.dispatchEvent(new CustomEvent('perf:app-ready'))
})

// 必须在 app.mount 之后、且必须在 Pinia 创建之后调用
// 内部会等待 useAudioStore() 获取 store 实例
// P2: 媒体事件监听器按需加载(约 3.2KB 移出主入口); 它只注册 Tauri 事件, 晚一个 tick 无副作用
void import('./composables/useMediaControls').then((module) => module.setupGlobalMediaListeners())

// ========== 性能记录器 (按需加载, 默认不进主包) ==========
// 按 Ctrl+Shift+F12 首次加载并打开面板; 若上次开启过, 启动时静默加载以采集启动时序。
const PERF_ENABLED_KEY = 'gaoshanliushui:perf-hotkey'

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.code === 'F12') {
    event.preventDefault()
    void import('./utils/perfRecorder').then((module) => module.initPerfRecorder().togglePanel())
  }
})

try {
  if (localStorage.getItem(PERF_ENABLED_KEY) === '1') {
    void import('./utils/perfRecorder').then((module) => module.initPerfRecorder())
  }
} catch {
  // localStorage 不可用时忽略
}
