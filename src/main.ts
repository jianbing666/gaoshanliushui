import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'
// 阶段 2.1: 虚拟滚动样式
import './styles/virtual-scroller.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')