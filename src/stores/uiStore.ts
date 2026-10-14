import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { Song, Playlist } from '@/types/song'
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

export interface PlaylistContextMenuState {
  visible: boolean
  playlist: Playlist | null
  x: number
  y: number
}

export interface EditMetadataState {
  visible: boolean
  song: Song | null
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

export type RightPanelKey = 'settings' | 'stats' | 'download' | 'memory' | 'equalizer' | null

export const useUIStore = defineStore('ui', () => {
  // ========== 左侧面板 ==========
  const showSidebar = ref(true)
  const showHistoryDrawer = ref(false)

  // ========== 右侧面板（统一管理，同侧互斥） ==========
  // 单一数据源: activeRightPanel 直接表示当前打开的右侧面板
  // 替代之前分散的 showStatsPanel / showDownloadPanel / showMemoryDrawer + App.vue 里的 showSettings
  const activeRightPanel = ref<RightPanelKey>(null)

  // 为了向后兼容，保留各个布尔 ref（computed 形式）
  const showStatsPanel = computed(() => activeRightPanel.value === 'stats')
  const showDownloadPanel = computed(() => activeRightPanel.value === 'download')
  const showMemoryDrawer = computed(() => activeRightPanel.value === 'memory')
  const showSettings = computed(() => activeRightPanel.value === 'settings')
  const showEqualizerPanel = computed(() => activeRightPanel.value === 'equalizer')

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

  // ========== 右侧面板统一切换 ==========
  function toggleRightPanel(panel: Exclude<RightPanelKey, null>) {
    if (activeRightPanel.value === panel) {
      // 点击已打开的面板 → 关闭
      activeRightPanel.value = null
    } else {
      // 切换到新面板（自动关闭旧的，因为是单一状态）
      activeRightPanel.value = panel
    }
  }

  // ========== 设置面板 toggle ==========
  function toggleSettingsPanel() {
    toggleRightPanel('settings')
  }

  // ========== 统计面板 toggle ==========
  function toggleStatsPanel() {
    toggleRightPanel('stats')
  }

  // ========== 下载面板 toggle ==========
  function toggleDownloadPanel() {
    toggleRightPanel('download')
  }

  // ========== 记忆抽屉 toggle ==========
  function toggleMemoryDrawer() {
    toggleRightPanel('memory')
  }

  function toggleEqualizerPanel() {
    toggleRightPanel('equalizer')
  }

  // ========== 关闭右侧所有面板 ==========
  function closeAllRightPanels() {
    activeRightPanel.value = null
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

  // ========== 歌单右键菜单 ==========
  const playlistContextMenu = ref<PlaylistContextMenuState>({
    visible: false,
    playlist: null,
    x: 0,
    y: 0,
  })

  function openPlaylistContextMenu(playlist: Playlist, x: number, y: number) {
    playlistContextMenu.value = {
      visible: true,
      playlist,
      x,
      y,
    }
  }

  function closePlaylistContextMenu() {
    playlistContextMenu.value.visible = false
  }

  // ========== 编辑元数据浮窗 ==========
  const editMetadata = ref<EditMetadataState>({
    visible: false,
    song: null,
    x: 0,
    y: 0,
  })

  function openEditMetadata(song: Song, x: number, y: number) {
    editMetadata.value = {
      visible: true,
      song,
      x,
      y,
    }
  }

  function closeEditMetadata() {
    editMetadata.value.visible = false
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

  // ========== 通用确认对话框 ==========
  const confirmDialog = ref({
    visible: false,
    title: '',
    message: '',
    type: 'default' as 'default' | 'danger',
    confirmText: '',
    cancelText: '',
    onConfirm: null as (() => void) | null,
  })

  function openConfirmDialog(options: {
    title: string
    message: string
    type?: 'default' | 'danger'
    confirmText?: string
    cancelText?: string
    onConfirm?: () => void
  }) {
    confirmDialog.value = {
      visible: true,
      title: options.title,
      message: options.message,
      type: options.type || 'default',
      confirmText: options.confirmText || '',
      cancelText: options.cancelText || '',
      onConfirm: options.onConfirm || null,
    }
  }

  function closeConfirmDialog() {
    confirmDialog.value.visible = false
    confirmDialog.value.onConfirm = null
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
    invoke('toggle_mini_mode', { isMini: value }).catch((e) =>
      console.warn('[miniMode] toggle_mini_mode 失败:', e)
    )

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
    } catch {
      // 取窗口尺寸失败时退回按目标尺寸推断, 不阻断迷你模式切换
      startSize = value ? [NORMAL_TARGET_W, NORMAL_TARGET_H] : [MINI_TARGET_W, MINI_TARGET_H]
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
          height: miniModeTargetSize[1],
        }).catch(() => {})
      }
    }

    miniModeAnimId = requestAnimationFrame(step)
  }

  return {
    // 面板
    showSidebar,
    showHistoryDrawer,
    activeRightPanel,
    showStatsPanel,
    showDownloadPanel,
    showMemoryDrawer,
    showSettings,
    showEqualizerPanel,
    toggleSidebar,
    toggleHistoryDrawer,
    toggleRightPanel,
    toggleSettingsPanel,
    toggleStatsPanel,
    toggleDownloadPanel,
    toggleMemoryDrawer,
    toggleEqualizerPanel,
    closeAllRightPanels,
    // 右键菜单
    contextMenu,
    openContextMenu,
    closeContextMenu,
    // 歌单右键菜单
    playlistContextMenu,
    openPlaylistContextMenu,
    closePlaylistContextMenu,
    // 编辑元数据
    editMetadata,
    openEditMetadata,
    closeEditMetadata,
    // 创建歌单弹窗
    showCreatePlaylistModal,
    createPlaylistAddSongId,
    openCreatePlaylistModal,
    closeCreatePlaylistModal,
    // 通用确认对话框
    confirmDialog,
    openConfirmDialog,
    closeConfirmDialog,
    // 迷你模式
    isMiniMode,
    setMiniMode,
  }
})
