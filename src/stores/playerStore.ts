import { defineStore } from 'pinia'
import { ref, computed, nextTick, watch } from 'vue'
import type { Song, LoopMode } from '@/types/song'
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'

// LocalStorage 持久化辅助
const STORAGE_KEY = 'bilibili-music-player-settings'

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveSettings(settings: Record<string, unknown>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 忽略写入失败
  }
}

export const usePlayerStore = defineStore('player', () => {
  // ========== 从 localStorage 恢复设置 ==========
  const saved = loadSettings()

  // ========== 播放列表 ==========
  const playlist = ref<Song[]>([])
  const currentIndex = ref(-1)

  // ========== 播放状态 ==========
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref((saved.volume as number) ?? 0.8)
  const loopMode = ref<LoopMode>((saved.loopMode as LoopMode) ?? 'list')

  // ========== 迷你模式 ==========
  const isMiniMode = ref(false)

  // ========== 加载状态 ==========
  const isLoading = ref(false)
  const folderPath = ref((saved.folderPath as string) ?? '')

  // ========== 计算属性 ==========
  const currentSong = computed(() =>
    currentIndex.value >= 0 ? playlist.value[currentIndex.value] : null
  )
  const hasNext = computed(() => {
    if (loopMode.value === 'single') return true
    if (loopMode.value === 'list') return true
    return currentIndex.value < playlist.value.length - 1
  })
  const hasPrev = computed(() => {
    if (loopMode.value === 'single') return true
    if (loopMode.value === 'list') return true
    return currentIndex.value > 0
  })

  // ========== 文件夹扫描 ==========
  async function scanMusicFolder(path: string) {
    isLoading.value = true
    try {
      const songs = await invoke<Song[]>('scan_music_folder', { folderPath: path })
      playlist.value = songs
      folderPath.value = path
      if (songs.length > 0 && currentIndex.value === -1) {
        currentIndex.value = 0
      }
      return songs
    } catch (error) {
      console.error('扫描文件夹失败:', error)
      throw error
    } finally {
      isLoading.value = false
    }
  }

  // ========== 播放控制 ==========
  function play() {
    isPlaying.value = true
  }

  function pause() {
    isPlaying.value = false
  }

  function togglePlay() {
    isPlaying.value = !isPlaying.value
  }

  function next() {
    if (playlist.value.length === 0) return

    if (loopMode.value === 'single') {
      // 单曲循环：从头重播当前歌曲
      currentTime.value = 0
      // 通过临时切换 currentIndex 触发 watch 重新加载
      const idx = currentIndex.value
      currentIndex.value = -1
      nextTick(() => {
        currentIndex.value = idx
        isPlaying.value = true
      })
      return
    }

    if (currentIndex.value < playlist.value.length - 1) {
      currentIndex.value++
    } else if (loopMode.value === 'list') {
      currentIndex.value = 0
    }
  }

  function prev() {
    if (playlist.value.length === 0) return

    if (loopMode.value === 'single') {
      // 单曲循环：从头重播当前歌曲
      currentTime.value = 0
      const idx = currentIndex.value
      currentIndex.value = -1
      nextTick(() => {
        currentIndex.value = idx
        isPlaying.value = true
      })
      return
    }

    if (currentIndex.value > 0) {
      currentIndex.value--
    } else if (loopMode.value === 'list') {
      currentIndex.value = playlist.value.length - 1
    }
  }

  function playByIndex(index: number) {
    if (index >= 0 && index < playlist.value.length) {
      currentIndex.value = index
      isPlaying.value = true
    }
  }

  // ========== 循环模式 ==========
  function toggleLoopMode() {
    const modes: LoopMode[] = ['list', 'single', 'none']
    const currentIdx = modes.indexOf(loopMode.value)
    loopMode.value = modes[(currentIdx + 1) % modes.length]
  }

  // ========== 迷你模式 ==========
  async function toggleMiniMode() {
    isMiniMode.value = !isMiniMode.value
    try {
      await invoke('toggle_mini_mode', { isMini: isMiniMode.value })
    } catch (error) {
      console.error('切换迷你模式失败:', error)
      isMiniMode.value = !isMiniMode.value
    }
  }

  // ========== 工具方法 ==========
  function getAudioUrl(filePath: string): string {
    return convertFileSrc(filePath)
  }

  function getCoverUrl(coverPath: string | null): string {
    if (!coverPath) return ''
    return convertFileSrc(coverPath)
  }

  // ========== 持久化：自动保存设置到 localStorage ==========
  watch(
    [volume, loopMode, folderPath],
    ([vol, mode, path]) => {
      saveSettings({ volume: vol, loopMode: mode, folderPath: path })
    }
  )

  return {
    // 状态
    playlist,
    currentIndex,
    isPlaying,
    currentTime,
    duration,
    volume,
    loopMode,
    isMiniMode,
    isLoading,
    folderPath,
    // 计算属性
    currentSong,
    hasNext,
    hasPrev,
    // 方法
    scanMusicFolder,
    play,
    pause,
    togglePlay,
    next,
    prev,
    playByIndex,
    toggleLoopMode,
    toggleMiniMode,
    getAudioUrl,
    getCoverUrl,
  }
})