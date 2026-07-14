import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { Song } from '@/types/song'
import { useSettingsStore } from './settingsStore'

/**
 * UI 域 store
 *
 * 包含:
 *   - 面板可见性 (showSidebar / showHistoryDrawer / showStatsPanel / showDownloadPanel)
 *   - 同侧互斥逻辑(集中处理,避免分散在 App.vue)
 *   - 全局右键菜单 (contextMenu)
 *   - 创建歌单弹窗 (showCreatePlaylistModal / createPlaylistAddSongId)
 *   - 迷你模式 (isMiniMode / setMiniMode / 窗口尺寸 rAF 插值动画)
 *
 * 不包含: 业务数据(歌曲、歌单、历史)、Web Audio、设置项
 *
 * 跨域调用:
 *   - setMiniMode 内部 useSettingsStore() 暂停/恢复后台动画
 *   - toggleStatsPanel 通过 store event 通知 App.vue 收起 showSettings
 */

export interface ContextMenuState {
  visible: boolean
  song: Song | null
  playlistId: string | null
  x: number
  y: number
}

// ========== 迷你模式动画常量(与 toggle_mini_mode.rs 保持一致) ==========
const MINI_TARGET_W = 472
const MINI_TARGET_H = 112
const NORMAL_TARGET_W = 1200
const NORMAL_TARGET_H = 800
const MINI_ANIM_DURATION = 320 // ms
const MINI_INVOKE_INTERVAL = 10 // ms - IPC 节流, 避免每帧调用

export const useUIStore = defineStore('ui', () => {
  // ========== 面板可见性 ==========
  const showSidebar = ref(true)
  const showHistoryDrawer = ref(false)
  const showStatsPanel = ref(false)
  const showDownloadPanel = ref(false)
  // Memory feature - 高山流水 v1.1: 回忆抽屉 (右侧, w-80, 与设置/统计/下载同侧互斥)
  const showMemoryDrawer = ref(false)

  // ========== 侧边栏 toggle(同侧互斥:与历史记录) ==========
  function toggleSidebar() {
    if (!showSidebar.value && showHistoryDrawer.value) {
      showHistoryDrawer.value = false
    }
    showSidebar.value = !showSidebar.value
  }

  // ========== 历史记录 toggle(同侧互斥:与侧边栏) ==========
  function toggleHistoryDrawer() {
    if (!showHistoryDrawer.value && showSidebar.value) {
      showSidebar.value = false
    }
    showHistoryDrawer.value = !showHistoryDrawer.value
  }

  // ========== 记忆抽屉 toggle(同侧互斥:与设置/统计/下载, 右侧 w-80) ==========
  // 记忆抽屉与设置/统计/下载都在右侧, 一次只能开一个
  // 展开记忆抽屉时, 通过自定义事件通知 App.vue 收起 showSettings
  function toggleMemoryDrawer() {
    const newVal = !showMemoryDrawer.value
    showMemoryDrawer.value = newVal
    if (newVal) {
      // 通知 App.vue: 展开记忆抽屉时收起 showSettings
      window.dispatchEvent(new CustomEvent('ui:memory-opened'))
    }
  }

  // ========== 统计面板 toggle ==========
  function toggleStatsPanel() {
    const newVal = !showStatsPanel.value
    showStatsPanel.value = newVal
    if (newVal) {
      // BUG 5 修复: 展开统计时关闭所有其他右侧面板
      showDownloadPanel.value = false
      showMemoryDrawer.value = false
      // 通知 App.vue: 展开统计时收起 showSettings
      window.dispatchEvent(new CustomEvent('ui:stats-opened'))
    }
  }

  // ========== 下载面板 toggle ==========
  function toggleDownloadPanel() {
    const newVal = !showDownloadPanel.value
    showDownloadPanel.value = newVal
    if (newVal) {
      // BUG 5 修复: 展开下载时关闭所有其他右侧面板
      showStatsPanel.value = false
      showMemoryDrawer.value = false
      // 通知 App.vue: 展开下载时收起 showSettings
      window.dispatchEvent(new CustomEvent('ui:download-opened'))
    }
  }

  // ========== 强制关闭右侧所有面板(供 App.vue 同侧互斥使用) ==========
  // 用直接赋值而非 toggle, 避免 "关闭已关闭的面板" 时反而打开的 BUG
  function closeAllRightPanels() {
    showStatsPanel.value = false
    showDownloadPanel.value = false
    showMemoryDrawer.value = false
  }

  // ========== 全局右键菜单 ==========
  const contextMenu = ref<ContextMenuState>({
    visible: false,
    song: null,
    playlistId: null,
    x: 0,
    y: 0,
  })

  function openContextMenu(song: Song, playlistId: string | null, x: number, y: number) {
    contextMenu.value = {
      visible: true,
      song,
      playlistId,
      x,
      y,
    }
  }

  function closeContextMenu() {
    contextMenu.value.visible = false
  }

  // ========== 创建歌单弹窗 ==========
  const showCreatePlaylistModal = ref(false)
  const createPlaylistAddSongId = ref<string | null>(null)

  function openCreatePlaylistModal(songId?: string) {
    createPlaylistAddSongId.value = songId ?? null
    showCreatePlaylistModal.value = true
  }

  function closeCreatePlaylistModal() {
    showCreatePlaylistModal.value = false
    createPlaylistAddSongId.value = null
  }

  // ========== 迷你模式 ==========
  const isMiniMode = ref<boolean>(false)

  // 迷你模式 rAF 插值窗口尺寸
  let miniModeAnimId: number | null = null
  let miniModeAnimStartTime = 0
  let miniModeAnimLastInvoke = 0
  let miniModeStartSize: [number, number] = [0, 0]
  let miniModeTargetSize: [number, number] = [0, 0]

  function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3)
  }

  function setMiniMode(value: boolean) {
    // 取消任何正在进行的动画
    if (miniModeAnimId !== null) {
      cancelAnimationFrame(miniModeAnimId)
      miniModeAnimId = null
    }

    // 1. 立即切换 Vue 状态
    isMiniMode.value = value

    // 2. 立即调用后端处理"看不见的属性"
    invoke('toggle_mini_mode', { isMini: value })
      .catch((e) => console.warn('[miniMode] toggle_mini_mode 失败:', e))

    // 3. 阶段 5: 进入迷你模式时自动暂停所有非必要后台任务
    const settings = useSettingsStore()
    if (value) {
      settings.pauseAllBackgroundAnimations()
    } else {
      settings.resumeAllBackgroundAnimations()
    }

    // 4. 异步启动 rAF 动画插值窗口尺寸
    void animateMiniModeSize(value)
  }

  async function animateMiniModeSize(value: boolean) {
    let startSize: [number, number] = [NORMAL_TARGET_W, NORMAL_TARGET_H]
    try {
      const cur = await invoke<[number, number]>('get_window_size')
      if (cur && cur.length === 2 && cur[0] > 0 && cur[1] > 0) {
        startSize = [cur[0], cur[1]]
      }
    } catch (e) {
      startSize = value
        ? [NORMAL_TARGET_W, NORMAL_TARGET_H]
        : [MINI_TARGET_W, MINI_TARGET_H]
    }

    const targetSize: [number, number] = value
      ? [MINI_TARGET_W, MINI_TARGET_H]
      : [NORMAL_TARGET_W, NORMAL_TARGET_H]

    miniModeStartSize = startSize
    miniModeTargetSize = targetSize
    miniModeAnimStartTime = performance.now()
    miniModeAnimLastInvoke = 0

    const step = (now: number) => {
      const elapsed = now - miniModeAnimStartTime
      const progress = Math.min(elapsed / MINI_ANIM_DURATION, 1)
      const eased = easeOutCubic(progress)

      const w = miniModeStartSize[0] + (miniModeTargetSize[0] - miniModeStartSize[0]) * eased
      const h = miniModeStartSize[1] + (miniModeTargetSize[1] - miniModeStartSize[1]) * eased

      if (now - miniModeAnimLastInvoke >= MINI_INVOKE_INTERVAL || progress >= 1) {
        miniModeAnimLastInvoke = now
        invoke('set_window_size', { width: w, height: h }).catch(() => {})
      }

      if (progress < 1) {
        miniModeAnimId = requestAnimationFrame(step)
      } else {
        miniModeAnimId = null
        invoke('set_window_size', {
          width: miniModeTargetSize[0],
          height: miniModeTargetSize[1]
        }).catch(() => {})
      }
    }

    miniModeAnimId = requestAnimationFrame(step)
  }

  // 监听 showStatsPanel / showDownloadPanel, 通知 App.vue 处理 showSettings 互斥
  // (通过自定义事件,App.vue 在 onMounted 中订阅)
  watch([showStatsPanel, showDownloadPanel], ([stats, dl]) => {
    if (stats || dl) {
      window.dispatchEvent(new CustomEvent('ui:right-panel-opened', { detail: { stats, download: dl } }))
    }
  })

  return {
    // 面板
    showSidebar,
    showHistoryDrawer,
    showStatsPanel,
    showDownloadPanel,
    showMemoryDrawer,
    toggleSidebar,
    toggleHistoryDrawer,
    toggleStatsPanel,
    toggleDownloadPanel,
    toggleMemoryDrawer,
    closeAllRightPanels,
    // 右键菜单
    contextMenu,
    openContextMenu,
    closeContextMenu,
    // 创建歌单弹窗
    showCreatePlaylistModal,
    createPlaylistAddSongId,
    openCreatePlaylistModal,
    closeCreatePlaylistModal,
    // 迷你模式
    isMiniMode,
    setMiniMode,
  }
})
