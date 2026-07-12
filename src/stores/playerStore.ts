import { defineStore } from 'pinia'
import { ref, computed, nextTick, watch } from 'vue'
import type { Song, LoopMode, ThemeMode } from '@/types/song'
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'

// LocalStorage 持久化辅助
const STORAGE_KEY = 'bilibili-music-player-settings'
const MUSIC_LIBRARY_PATH_KEY = 'musicLibraryPath'

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

function getMusicLibraryPath(): string | null {
  try {
    return localStorage.getItem(MUSIC_LIBRARY_PATH_KEY)
  } catch {
    return null
  }
}

function setMusicLibraryPath(path: string) {
  try {
    localStorage.setItem(MUSIC_LIBRARY_PATH_KEY, path)
  } catch {
    // 忽略写入失败
  }
}

function clearMusicLibraryPath() {
  try {
    localStorage.removeItem(MUSIC_LIBRARY_PATH_KEY)
  } catch {
    // 忽略删除失败
  }
}

// 检测系统主题偏好
function getSystemTheme(): 'light' | 'dark' {
  // 使用 matchMedia 检测系统主题
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
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

  // ========== 加载状态 ==========
  const isLoading = ref(false)
  const folderPath = ref((saved.folderPath as string) ?? '')

  // ========== 主题设置 ==========
  const theme = ref<ThemeMode>((saved.theme as ThemeMode) ?? 'system')

  // 应用主题到 DOM（切换 Tailwind dark class）
  function applyTheme(themeMode: ThemeMode) {
    const actualTheme = themeMode === 'system' ? getSystemTheme() : themeMode
    if (actualTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  // 设置主题
  function setTheme(newTheme: ThemeMode) {
    theme.value = newTheme
    applyTheme(newTheme)
    // 持久化会在 watch 中自动处理
  }

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
      // 成功扫描后保存路径到 localStorage
      setMusicLibraryPath(path)
      if (songs.length > 0 && currentIndex.value === -1) {
        currentIndex.value = 0
      }
      return songs
    } catch (error) {
      console.error('扫描文件夹失败:', error)
      // 扫描失败时清除无效缓存
      clearMusicLibraryPath()
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
    [volume, loopMode, folderPath, theme],
    ([vol, mode, path, th]) => {
      saveSettings({ volume: vol, loopMode: mode, folderPath: path, theme: th })
    }
  )

  // ========== 自动加载音乐库（启动时自动扫描） ==========
  async function autoLoadMusicLibrary(): Promise<{ success: boolean; error?: string }> {
    const savedPath = getMusicLibraryPath()
    if (!savedPath) {
      // 没有缓存路径，返回需要用户选择
      return { success: false }
    }

    isLoading.value = true
    try {
      const songs = await invoke<Song[]>('scan_music_folder', { folderPath: savedPath })
      playlist.value = songs
      folderPath.value = savedPath
      if (songs.length > 0 && currentIndex.value === -1) {
        currentIndex.value = 0
      }
      return { success: true }
    } catch (error) {
      console.error('自动加载音乐库失败（路径可能已失效）:', error)
      // 路径失效，清除无效缓存
      clearMusicLibraryPath()
      folderPath.value = ''
      const errorMsg = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMsg }
    } finally {
      isLoading.value = false
    }
  }

  // ========== 初始化主题（应用保存的主题设置） ==========
  applyTheme(theme.value)

  // 监听系统主题变化（仅在 'system' 模式下生效）
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (theme.value === 'system') {
        applyTheme('system')
      }
    })
  }

  return {
    // 状态
    playlist,
    currentIndex,
    isPlaying,
    currentTime,
    duration,
    volume,
    loopMode,
    isLoading,
    folderPath,
    theme,
    // 计算属性
    currentSong,
    hasNext,
    hasPrev,
    // 方法
    scanMusicFolder,
    autoLoadMusicLibrary,
    play,
    pause,
    togglePlay,
    next,
    prev,
    playByIndex,
    toggleLoopMode,
    setTheme,
    getAudioUrl,
    getCoverUrl,
  }
})