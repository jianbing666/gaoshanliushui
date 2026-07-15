import { ref, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'

/**
 * 快捷键配置接口
 */
export interface ShortcutConfig {
  id: string
  action: string
  defaultShortcut: string
  currentShortcut: string
  description: string
}

const STORAGE_KEY = 'gaoshanliushui-shortcuts'

// 默认快捷键配置
const defaultShortcuts: ShortcutConfig[] = [
  {
    id: 'toggle-play',
    action: '播放/暂停',
    defaultShortcut: 'Ctrl+Alt+P',
    currentShortcut: 'Ctrl+Alt+P',
    description: '切换播放状态',
  },
  {
    id: 'prev-track',
    action: '上一首',
    defaultShortcut: 'Ctrl+Alt+Left',
    currentShortcut: 'Ctrl+Alt+Left',
    description: '播放上一首歌曲',
  },
  {
    id: 'next-track',
    action: '下一首',
    defaultShortcut: 'Ctrl+Alt+Right',
    currentShortcut: 'Ctrl+Alt+Right',
    description: '播放下一首歌曲',
  },
  {
    id: 'volume-up',
    action: '音量增加',
    defaultShortcut: 'Ctrl+Alt+Up',
    currentShortcut: 'Ctrl+Alt+Up',
    description: '增加音量',
  },
  {
    id: 'volume-down',
    action: '音量减少',
    defaultShortcut: 'Ctrl+Alt+Down',
    currentShortcut: 'Ctrl+Alt+Down',
    description: '减少音量',
  },
]

/**
 * 快捷键配置 Composable
 * 处理快捷键的显示、编辑、保存和恢复默认
 */
export function useShortcutConfig() {
  const shortcuts = ref<ShortcutConfig[]>([])
  const editingShortcut = ref<string | null>(null)
  const loading = ref(false)

  /**
   * 加载快捷键配置
   */
  function loadShortcuts() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const savedConfigs = JSON.parse(saved) as ShortcutConfig[]
        // 合并默认配置和保存的配置
        shortcuts.value = defaultShortcuts.map(defaultItem => {
          const savedItem = savedConfigs.find(s => s.id === defaultItem.id)
          return savedItem ? { ...defaultItem, currentShortcut: savedItem.currentShortcut } : defaultItem
        })
      } else {
        shortcuts.value = [...defaultShortcuts]
      }
    } catch (error) {
      console.error('加载快捷键配置失败:', error)
      shortcuts.value = [...defaultShortcuts]
    }
  }

  /**
   * 保存快捷键配置
   */
  function saveShortcuts() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts.value))
    } catch (error) {
      console.error('保存快捷键配置失败:', error)
    }
  }

  /**
   * 开始编辑快捷键
   */
  function startEdit(shortcutId: string) {
    editingShortcut.value = shortcutId
  }

  /**
   * 取消编辑快捷键
   */
  function cancelEdit() {
    editingShortcut.value = null
  }

  /**
   * 更新快捷键
   */
  async function updateShortcut(shortcutId: string, newShortcut: string): Promise<boolean> {
    loading.value = true
    try {
      // 检查快捷键冲突
      const conflict = shortcuts.value.find(
        s => s.id !== shortcutId && s.currentShortcut === newShortcut
      )
      if (conflict) {
        alert(`快捷键冲突：已用于"${conflict.action}"`)
        return false
      }

      // 调用后端更新全局快捷键
      try {
        await invoke('update_global_shortcut', {
          shortcutId,
          newShortcut,
        })
      } catch (err) {
        console.error('更新全局快捷键失败:', err)
        alert('更新快捷键失败，请重试')
        return false
      }

      // 更新本地状态
      const index = shortcuts.value.findIndex(s => s.id === shortcutId)
      if (index !== -1) {
        shortcuts.value[index].currentShortcut = newShortcut
        saveShortcuts()
        editingShortcut.value = null
        return true
      }
      return false
    } catch (error) {
      console.error('更新快捷键失败:', error)
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 恢复默认快捷键
   */
  function resetToDefault(shortcutId: string) {
    const index = shortcuts.value.findIndex(s => s.id === shortcutId)
    if (index !== -1) {
      shortcuts.value[index].currentShortcut = shortcuts.value[index].defaultShortcut
      saveShortcuts()
    }
  }

  /**
   * v1.1 (2026-07-14): 清空单个快捷键 (X 按钮)
   * 把 currentShortcut 设为空字符串, 后端会取消该快捷键的注册
   */
  async function clearShortcut(shortcutId: string) {
    const index = shortcuts.value.findIndex(s => s.id === shortcutId)
    if (index === -1) return
    const empty = ''
    // 通知后端注销快捷键 (newShortcut = '' 表示禁用)
    try {
      await invoke('update_global_shortcut', { shortcutId, newShortcut: empty })
    } catch (err) {
      console.error('清除全局快捷键失败:', err)
      // 即使后端失败也更新本地状态, 用户可手动重试
    }
    shortcuts.value[index].currentShortcut = empty
    saveShortcuts()
  }

  /**
   * 恢复所有默认快捷键
   */
  function resetAllToDefault() {
    shortcuts.value = shortcuts.value.map(s => ({
      ...s,
      currentShortcut: s.defaultShortcut,
    }))
    saveShortcuts()
  }

  /**
   * 处理键盘事件（用于快捷键编辑）
   */
  function handleKeyDown(event: KeyboardEvent): string | null {
    // 阻止默认行为
    event.preventDefault()
    event.stopPropagation()

    // 构建快捷键字符串
    const parts: string[] = []
    if (event.ctrlKey) parts.push('Ctrl')
    if (event.altKey) parts.push('Alt')
    if (event.shiftKey) parts.push('Shift')
    if (event.metaKey) parts.push('Meta')

    // 添加按键
    const key = event.key.toUpperCase()
    if (['CONTROL', 'ALT', 'SHIFT', 'META'].includes(key)) {
      return null // 不允许只有修饰键
    }
    parts.push(key)

    return parts.join('+')
  }

  onMounted(() => {
    loadShortcuts()
  })

  return {
    shortcuts,
    editingShortcut,
    loading,
    startEdit,
    cancelEdit,
    updateShortcut,
    resetToDefault,
    clearShortcut,
    resetAllToDefault,
    handleKeyDown,
  }
}