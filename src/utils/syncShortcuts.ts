import { invoke } from '@tauri-apps/api/core'

const STORAGE_KEY = 'gaoshanliushui-shortcuts'

interface SavedShortcut {
  id: string
  currentShortcut: string
}

/**
 * 将前端 localStorage 中保存的快捷键配置同步到后端
 *
 * 必要性:
 *   后端 ShortcutStore 在启动时使用默认值 (Ctrl+Alt+P 等).
 *   如果用户之前在设置中修改过快捷键, 这些修改只存在 localStorage.
 *   不主动同步的话, 后端继续用默认值, 用户按修改后的快捷键无反应.
 *
 * 调用时机:
 *   - App 启动后, requestIdleCallback 中调用
 *   - 兜底: 后端启动时的默认值也已被注册, 此函数是覆盖
 */
export async function syncShortcutsToBackend(): Promise<void> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return

  let saved: SavedShortcut[]
  try {
    saved = JSON.parse(raw)
  } catch {
    return
  }

  if (!Array.isArray(saved) || saved.length === 0) return

  // 并发同步所有快捷键 (互不依赖)
  await Promise.allSettled(
    saved.map((item) =>
      invoke('update_global_shortcut', {
        shortcutId: item.id,
        newShortcut: item.currentShortcut,
      }).catch((e) => {
        console.warn(`[syncShortcuts] 同步 ${item.id}=${item.currentShortcut} 失败:`, e)
      })
    )
  )
}
