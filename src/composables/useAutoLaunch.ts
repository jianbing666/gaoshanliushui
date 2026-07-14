import { ref, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'

const STORAGE_KEY = 'gaoshanliushui-auto-launch'

export function useAutoLaunch() {
  const autoLaunch = ref(false)
  const loading = ref(false)

  async function loadAutoLaunchStatus() {
    loading.value = true
    try {
      const enabled = await invoke<boolean>('plugin:autostart|is_enabled')
      autoLaunch.value = enabled
      localStorage.setItem(STORAGE_KEY, String(enabled))
    } catch (error) {
      console.error('加载开机自启状态失败:', error)
      const saved = localStorage.getItem(STORAGE_KEY)
      autoLaunch.value = saved === 'true'
    } finally {
      loading.value = false
    }
  }

  async function toggleAutoLaunch(): Promise<boolean> {
    loading.value = true
    try {
      const newState = !autoLaunch.value
      if (newState) {
        await invoke('plugin:autostart|enable')
      } else {
        await invoke('plugin:autostart|disable')
      }
      autoLaunch.value = newState
      localStorage.setItem(STORAGE_KEY, String(newState))
      return true
    } catch (error) {
      console.error('切换开机自启失败:', error)
      return false
    } finally {
      loading.value = false
    }
  }

  async function enableAutoLaunch(): Promise<boolean> {
    if (autoLaunch.value) return true
    return await toggleAutoLaunch()
  }

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
