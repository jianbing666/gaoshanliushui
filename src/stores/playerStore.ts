import { defineStore } from 'pinia'
import { ref, computed, nextTick, watch } from 'vue'
import type { Song, LoopMode, ThemeMode, Playlist, BackgroundSettings, FontSettings, FontFamily } from '@/types/song'
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'

// LocalStorage 持久化辅助
const STORAGE_KEY = 'bilibili-music-player-settings'
const MUSIC_LIBRARY_PATH_KEY = 'musicLibraryPath'
const PLAYLISTS_KEY = 'bilibili-music-player-playlists'

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

function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY)
    if (raw) {
      return JSON.parse(raw)
    }
  } catch {
    // 忽略读取失败
  }
  // 默认歌单
  return [
    {
      id: 'all-songs',
      name: '全部歌曲',
      type: 'default',
      songIds: [],
      expanded: true,
    },
  ]
}

function savePlaylists(playlists: Playlist[]) {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists))
  } catch {
    // 忽略写入失败
  }
}

// 生成唯一 ID
function generateId(): string {
  return `playlist-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
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

  // ========== 播放列表（所有歌曲） ==========
  const playlist = ref<Song[]>([])
  const currentIndex = ref(-1)

  // ========== 歌单分组管理 ==========
  const playlists = ref<Playlist[]>(loadPlaylists())
  // 当前选中的歌单 ID
  const activePlaylistId = ref<string>('all-songs')

  // 根据 songId 查找歌曲
  function findSongById(songId: string): Song | undefined {
    return playlist.value.find((s) => s.id === songId)
  }

  // 当前歌单的歌曲列表（计算属性）
  const activePlaylistSongs = computed(() => {
    const active = playlists.value.find((p) => p.id === activePlaylistId.value)
    if (!active) return []
    return active.songIds
      .map((id) => findSongById(id))
      .filter((s): s is Song => s !== undefined)
  })

  // 获取默认歌单（全部歌曲）
  const defaultPlaylist = computed(() =>
    playlists.value.find((p) => p.type === 'default')
  )

  // 获取所有自定义歌单
  const customPlaylists = computed(() =>
    playlists.value.filter((p) => p.type === 'custom')
  )

  // 创建新歌单
  function createPlaylist(name: string): Playlist {
    const newPlaylist: Playlist = {
      id: generateId(),
      name,
      type: 'custom',
      songIds: [],
      expanded: true,
    }
    playlists.value.push(newPlaylist)
    return newPlaylist
  }

  // 删除歌单（仅自定义歌单）
  function deletePlaylist(playlistId: string) {
    const idx = playlists.value.findIndex((p) => p.id === playlistId)
    if (idx !== -1 && playlists.value[idx].type === 'custom') {
      // 如果删除的是当前选中的歌单，切换到默认歌单
      if (activePlaylistId.value === playlistId) {
        activePlaylistId.value = 'all-songs'
      }
      playlists.value.splice(idx, 1)
    }
  }

  // 重命名歌单（仅自定义歌单）
  function renamePlaylist(playlistId: string, newName: string) {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (pl && pl.type === 'custom') {
      pl.name = newName
    }
  }

  // 切换歌单展开/折叠状态
  function togglePlaylistExpand(playlistId: string) {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (pl) {
      pl.expanded = !pl.expanded
    }
  }

  // 切换当前选中的歌单
  function selectPlaylist(playlistId: string) {
    activePlaylistId.value = playlistId
  }

  // 将歌曲添加到指定歌单
  function addSongToPlaylist(songId: string, playlistId: string): boolean {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl) return false
    // 避免重复添加
    if (!pl.songIds.includes(songId)) {
      pl.songIds.push(songId)
      return true
    }
    return false
  }

  // 从指定歌单移除歌曲
  function removeSongFromPlaylist(songId: string, playlistId: string) {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (pl && pl.type === 'custom') {
      const idx = pl.songIds.indexOf(songId)
      if (idx !== -1) {
        pl.songIds.splice(idx, 1)
      }
    }
  }

  // 检查歌曲是否在指定歌单中
  function isSongInPlaylist(songId: string, playlistId: string): boolean {
    const pl = playlists.value.find((p) => p.id === playlistId)
    return pl ? pl.songIds.includes(songId) : false
  }

  // 同步默认歌单的歌曲（扫描后调用）
  function syncDefaultPlaylist(songs: Song[]) {
    const defaultPl = playlists.value.find((p) => p.type === 'default')
    if (defaultPl) {
      defaultPl.songIds = songs.map((s) => s.id)
    }
  }

  // 播放歌单中第 index 首歌
  function playFromActivePlaylist(index: number) {
    const songs = activePlaylistSongs.value
    if (index >= 0 && index < songs.length) {
      const song = songs[index]
      // 在全量 playlist 中找到对应的索引
      const globalIndex = playlist.value.findIndex((s) => s.id === song.id)
      if (globalIndex !== -1) {
        currentIndex.value = globalIndex
        isPlaying.value = true
      }
    }
  }

  // ========== 播放状态 ==========
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref((saved.volume as number) ?? 0.8)
  const lastVolume = ref(0.8)
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

  // ========== 背景图片设置 ==========
  const defaultBackground: BackgroundSettings = {
    mode: 'none',
    imagePath: '',
    folderPath: '',
    imageList: [],
    currentImageIndex: 0,
    interval: 30,
    fit: 'cover',
    overlay: 0.3,
    scale: 100,
    positionX: 50,
    positionY: 50,
    blur: 0,
  }

  const background = ref<BackgroundSettings>({
    ...defaultBackground,
    ...(saved.background as Partial<BackgroundSettings> || {}),
  })

  // 背景轮播定时器
  let backgroundTimer: number | null = null

  // 当前背景图片 URL（转换后的）
  const currentBackgroundUrl = computed(() => {
    if (background.value.mode === 'image' && background.value.imagePath) {
      return convertFileSrc(background.value.imagePath)
    }
    if (background.value.mode === 'folder' && background.value.imageList?.length) {
      const idx = background.value.currentImageIndex ?? 0
      const path = background.value.imageList[idx]
      return path ? convertFileSrc(path) : ''
    }
    return ''
  })

  // 设置背景模式
  function setBackgroundMode(mode: BackgroundSettings['mode']) {
    background.value.mode = mode
    if (mode === 'folder') {
      startBackgroundSlideshow()
    } else {
      stopBackgroundSlideshow()
    }
  }

  // 设置单张背景图
  function setBackgroundImage(path: string) {
    background.value.imagePath = path
    background.value.mode = 'image'
    stopBackgroundSlideshow()
  }

  // 扫描背景图片文件夹
  async function scanBackgroundFolder(folderPath: string) {
    try {
      const images = await invoke<string[]>('scan_image_folder', { folderPath })
      background.value.folderPath = folderPath
      background.value.imageList = images
      background.value.currentImageIndex = 0
      if (background.value.mode === 'folder') {
        startBackgroundSlideshow()
      }
      return images
    } catch (error) {
      console.error('扫描背景图片文件夹失败:', error)
      throw error
    }
  }

  // 切换到下一张背景图
  function nextBackgroundImage() {
    if (!background.value.imageList?.length) return
    const len = background.value.imageList.length
    background.value.currentImageIndex =
      ((background.value.currentImageIndex ?? 0) + 1) % len
  }

  // 切换到上一张背景图
  function prevBackgroundImage() {
    if (!background.value.imageList?.length) return
    const len = background.value.imageList.length
    background.value.currentImageIndex =
      ((background.value.currentImageIndex ?? 0) - 1 + len) % len
  }

  // 启动背景轮播
  function startBackgroundSlideshow() {
    stopBackgroundSlideshow()
    if (
      background.value.mode !== 'folder' ||
      !background.value.imageList?.length
    ) return
    const interval = (background.value.interval ?? 30) * 1000
    backgroundTimer = window.setInterval(() => {
      nextBackgroundImage()
    }, interval)
  }

  // 停止背景轮播
  function stopBackgroundSlideshow() {
    if (backgroundTimer !== null) {
      clearInterval(backgroundTimer)
      backgroundTimer = null
    }
  }

  // 更新背景设置项
  function updateBackgroundSetting<K extends keyof BackgroundSettings>(
    key: K,
    value: BackgroundSettings[K]
  ) {
    ;(background.value as BackgroundSettings)[key] = value
    // 如果修改了轮播间隔且当前是文件夹模式，重启定时器
    if (key === 'interval' && background.value.mode === 'folder') {
      startBackgroundSlideshow()
    }
  }

  // ========== 最小化到托盘设置 ==========
  const minimizeToTray = ref<boolean>(saved.minimizeToTray ?? true)

  function setMinimizeToTray(value: boolean) {
    minimizeToTray.value = value
  }

  // ========== 字体设置 ==========
  const defaultFontSettings: FontSettings = {
    family: 'system',
    size: 14,
    useThemeColor: true,
    customColor: '#333333',
  }

  const fontSettings = ref<FontSettings>({
    ...defaultFontSettings,
    ...(saved.fontSettings as Partial<FontSettings> || {}),
  })

  // 字体映射
  const fontFamilyMap: Record<FontFamily, string> = {
    system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    kaiti: '"KaiTi", "楷体", "STKaiti", serif',
    songti: '"SimSun", "宋体", "STSong", serif',
    fangsong: '"FangSong", "仿宋", "STFangsong", serif',
  }

  // 计算当前字体 CSS
  const currentFontFamily = computed(() => fontFamilyMap[fontSettings.value.family])
  const currentFontSize = computed(() => `${fontSettings.value.size}px`)
  const currentFontColor = computed(() => 
    fontSettings.value.useThemeColor 
      ? '' 
      : fontSettings.value.customColor || ''
  )

  // 应用字体设置到 DOM
  function applyFontSettings() {
    const root = document.documentElement
    root.style.setProperty('--font-family', fontFamilyMap[fontSettings.value.family])
    root.style.setProperty('--font-size', `${fontSettings.value.size}px`)
    if (!fontSettings.value.useThemeColor && fontSettings.value.customColor) {
      root.style.setProperty('--font-color', fontSettings.value.customColor)
      root.classList.add('custom-font-color')
    } else {
      root.style.removeProperty('--font-color')
      root.classList.remove('custom-font-color')
    }
  }

  // 设置字体类型
  function setFontFamily(family: FontFamily) {
    fontSettings.value.family = family
    applyFontSettings()
  }

  // 设置字体大小
  function setFontSize(size: number) {
    fontSettings.value.size = Math.max(12, Math.min(24, size))
    applyFontSettings()
  }

  // 设置字体颜色模式
  function setUseThemeColor(use: boolean) {
    fontSettings.value.useThemeColor = use
    applyFontSettings()
  }

  // 设置自定义字体颜色
  function setCustomColor(color: string) {
    fontSettings.value.customColor = color
    if (!fontSettings.value.useThemeColor) {
      applyFontSettings()
    }
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
      // 同步默认歌单
      syncDefaultPlaylist(songs)
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

  // ========== 静音控制 ==========
  function toggleMute() {
    if (volume.value > 0) {
      lastVolume.value = volume.value
      volume.value = 0
    } else {
      volume.value = lastVolume.value || 0.8
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
    [volume, loopMode, folderPath, theme, background, minimizeToTray, fontSettings],
    ([vol, mode, path, th, bg, mt, fs]) => {
      saveSettings({ volume: vol, loopMode: mode, folderPath: path, theme: th, background: bg, minimizeToTray: mt, fontSettings: fs })
    },
    { deep: true }
  )

  // 持久化歌单数据
  watch(
    playlists,
    (pls) => {
      savePlaylists(pls)
    },
    { deep: true }
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
      // 同步默认歌单
      syncDefaultPlaylist(songs)
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
  
  // ========== 初始化字体设置 ==========
  applyFontSettings()

  // 监听系统主题变化（仅在 'system' 模式下生效）
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (_e) => {
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
    // 背景设置
    background,
    currentBackgroundUrl,
    // 托盘设置
    minimizeToTray,
    // 歌单状态
    playlists,
    activePlaylistId,
    activePlaylistSongs,
    defaultPlaylist,
    customPlaylists,
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
    playFromActivePlaylist,
    toggleLoopMode,
    toggleMute,
    setTheme,
    // 背景设置方法
    setBackgroundMode,
    setBackgroundImage,
    scanBackgroundFolder,
    nextBackgroundImage,
    prevBackgroundImage,
    updateBackgroundSetting,
    // 托盘设置方法
    setMinimizeToTray,
    // 字体设置
    fontSettings,
    currentFontFamily,
    currentFontSize,
    currentFontColor,
    setFontFamily,
    setFontSize,
    setUseThemeColor,
    setCustomColor,
    getAudioUrl,
    getCoverUrl,
    findSongById,
    // 歌单方法
    createPlaylist,
    deletePlaylist,
    renamePlaylist,
    togglePlaylistExpand,
    selectPlaylist,
    addSongToPlaylist,
    removeSongFromPlaylist,
    isSongInPlaylist,
  }
})