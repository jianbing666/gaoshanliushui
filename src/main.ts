import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'
// 阶段 2.1: 虚拟滚动样式
import './styles/virtual-scroller.css'
// 2026-07-14: 托盘/快捷键/媒体键事件监听器必须在最早期注册
//   原因: Vue 组件挂载前可能错过事件, 且 webview 冻结后重启时
//   监听器是 Rust 唤醒 webview 的唯一信号源
import { setupGlobalMediaListeners } from './composables/useMediaControls'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')

// 必须在 app.mount 之后、且必须在 Pinia 创建之后调用
// 内部会等待 useAudioStore() 获取 store 实例
setupGlobalMediaListeners()