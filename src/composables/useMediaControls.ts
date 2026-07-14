import { onUnmounted } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useAudioStore } from '@/stores/audioStore'

/**
 * 全局媒体控制事件监听
 *
 * 设计目的:
 *   1. 解决"迷你模式下 ControlBar 卸载后, 托盘菜单/全局快捷键/媒体键事件无人接收"的问题
 *   2. 统一在应用最早期注册事件监听, 避免组件挂载/卸载导致事件丢失
 *   3. 防抖: 防止极短时间内重复触发 (例如双击)
 *   4. 命令式: 内部调 force* 函数, 强制唤醒 audioContext
 *
 * 事件源:
 *   - 系统托盘菜单点击 (tray.rs: global-shortcut:* 事件)
 *   - 全局快捷键 (global_shortcut.rs: global-shortcut:* 事件)
 *   - 外设媒体键 (Web MediaSession API, 由 store 直接绑定)
 *
 * 修复 2026-07-14:
 *   - 上一轮 useMediaControls 是 Vue composable, 依赖 App.vue 调用 useMediaControls() 才注册.
 *     但如果 App.vue 挂载失败或首次注册出错, 监听器永远不会被装上.
 *     改为在 main.ts 主动调用 setupGlobalMediaListeners(), 提前到 Pinia 创建后立即注册.
 *   - 防抖仍然保留 (250ms), 防止快速按键/双击
 */

// 防抖时间戳（模块级, 跨调用保持）
let lastToggleTime = 0
let lastPrevTime = 0
let lastNextTime = 0
const DEBOUNCE_MS = 250

// 已注册的 unlisten 函数 (模块级)
const unlistens: UnlistenFn[] = []
let setupCompleted = false

/**
 * 全局注册媒体控制事件监听器
 * 必须在 Pinia 创建之后调用
 */
export async function setupGlobalMediaListeners(): Promise<void> {
  if (setupCompleted) return
  setupCompleted = true

  try {
    // 播放/暂停
    unlistens.push(
      await listen('global-shortcut:toggle-play', () => {
        const now = Date.now()
        if (now - lastToggleTime < DEBOUNCE_MS) return
        lastToggleTime = now
        const audio = useAudioStore()
        void audio.forceTogglePlay()
      })
    )

    // 上一首
    unlistens.push(
      await listen('global-shortcut:prev-track', () => {
        const now = Date.now()
        if (now - lastPrevTime < DEBOUNCE_MS) return
        lastPrevTime = now
        const audio = useAudioStore()
        void audio.forcePrevious()
      })
    )

    // 下一首
    unlistens.push(
      await listen('global-shortcut:next-track', () => {
        const now = Date.now()
        if (now - lastNextTime < DEBOUNCE_MS) return
        lastNextTime = now
        const audio = useAudioStore()
        void audio.forceNext()
      })
    )

    // 音量增加
    unlistens.push(
      await listen('global-shortcut:volume-up', () => {
        const audio = useAudioStore()
        audio.volume = Math.min(1, audio.volume + 0.05)
      })
    )

    // 音量减少
    unlistens.push(
      await listen('global-shortcut:volume-down', () => {
        const audio = useAudioStore()
        audio.volume = Math.max(0, audio.volume - 0.05)
      })
    )
  } catch (e) {
    setupCompleted = false
    console.warn('[useMediaControls] 注册事件监听失败:', e)
  }
}

/**
 * Vue composable 包装器 (兼容 App.vue 已有调用)
 * 实际工作已由 setupGlobalMediaListeners() 在 main.ts 完成
 */
export function useMediaControls() {
  // 不再重复注册, 仅保留 onUnmounted 以备 keep-alive 等场景清理
  onUnmounted(() => {
    // App.vue 永不卸载, 此处仅作兼容
  })
}
