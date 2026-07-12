import { ref, onMounted } from 'vue'

const STORAGE_KEY = 'bilibili-music-player-auto-launch'

/**
 * 开机自启 Composable
 * 处理开机自启的启用、禁用和状态查询
 */
export function useAutoLaunch() {
  const autoLaunch = ref(false)
  const loading = ref(false)

  /**
   * 加载开机自启状态
   */
  function loadAutoLaunchStatus() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      autoLaunch.value = saved === 'true'
    } catch (error) {
      console.error('加载开机自启状态失败:', error)
      autoLaunch.value = false
    }
  }

  /**
   * 切换开机自启状态
   */
  async function toggleAutoLaunch(): Promise<boolean> {
    loading.value = true
    try {
      const newState = !autoLaunch.value

      // 保存状态到 localStorage
      localStorage.setItem(STORAGE_KEY, String(newState))
      autoLaunch.value = newState

      // TODO: 调用 Tauri API 注册/注销开机自启
      // 需要在 Cargo.toml 中添加 tauri-plugin-autolaunch 依赖
      // if (newState) {
      //   await invoke('enable_auto_launch')
      // } else {
      //   await invoke('disable_auto_launch')
      // }

      return true
    } catch (error) {
      console.error('切换开机自启失败:', error)
      // 恢复原状态
      const saved = localStorage.getItem(STORAGE_KEY)
      autoLaunch.value = saved === 'true'
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 启用开机自启
   */
  async function enableAutoLaunch(): Promise<boolean> {
    if (autoLaunch.value) return true
    return await toggleAutoLaunch()
  }

  /**
   * 禁用开机自启
   */
  async function disableAutoLaunch(): Promise<boolean> {
    if (!autoLaunch.value) return true
    return await toggleAutoLaunch()
  }

  onMounted(() => {
    loadAutoLaunchStatus()
  })

  return {
    autoLaunch,
    loading,
    toggleAutoLaunch,
    enableAutoLaunch,
    disableAutoLaunch,
  }
}