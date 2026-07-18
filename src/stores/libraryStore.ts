import { defineStore } from 'pinia'
import { ref, computed, watch, shallowRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Song, Playlist, PlaylistRecord, PlaylistSong } from '@/types/song'
import {
  loadSettings,
  saveSettings,
  loadPlaylists,
  getMusicLibraryPath,
  setMusicLibraryPath,
  clearMusicLibraryPath,
} from '@/utils/storage'
import { useSettingsStore } from './settingsStore'

/**
 * 歌曲库域 store
 *
 * 包含:
 *   - 歌曲列表 (playlist / shallowRef, 10000 首歌优化)
 *   - 歌单 (playlists / activePlaylistId / 自定义歌单)
 *   - 元数据源 (metadataSource)
 *   - 文件夹扫描 (scanMusicFolder / autoLoadMusicLibrary / refreshMetadata)
 *   - 搜索过滤 (searchQuery / filteredActivePlaylistSongs)
 *   - 当前播放索引 (currentIndex - 所有权归 libraryStore)
 *   - 路径缓存 (coverUrlCache / audioUrlCache)
 *
 * 不包含: 播放控制、Web Audio、UI 状态、历史、设置
 *
 * 关键决策:
 *   - currentIndex 归 libraryStore (语义: "playlist 中的位置")
 *   - audioStore 通过 useLibraryStore() 读取 currentIndex
 *   - playlist 用 shallowRef 避免深 Proxy 重建
 */

const saved = loadSettings()

export const useLibraryStore = defineStore('library', () => {
  // ========== 歌曲列表(全量) ==========
  // 阶段 4.x: shallowRef 替代 ref
  // 原因: 10000 首歌时深响应 proxy 重建成本显著
  // 写入约束: 必须整体替换 (playlist.value = newArr), 不能 push/splice
  // 读取: computed 内部 `playlist.value[index]` 仍响应
  const playlist = shallowRef<Song[]>([])

  // ========== 当前播放歌曲索引(归 library 所有) ==========
  const currentIndex = ref(-1)

  // ========== 元数据源 + 加载状态 ==========
  const isLoading = ref(false)
  const folderPath = ref((saved.folderPath as string) ?? '')
  const metadataSource = ref<'auto' | 'filename'>((saved.metadataSource as 'auto' | 'filename') ?? 'auto')

  // ========== 歌单分组管理 ==========
  const playlists = ref<Playlist[]>([])
  const activePlaylistId = ref<string>('1')
  const playlistsLoaded = ref(false)
  const playlistSongCache = new Map<string, PlaylistSong[]>()
  const playlistContentVersion = ref(0)
  // song.id -> content_hash 映射
  const idToHashMap = computed(() => {
    const map = new Map<string, string>()
    for (const song of playlist.value) {
      if (song.content_hash) {
        map.set(song.id, song.content_hash)
      }
    }
    return map
  })

  // ========== 搜索 ==========
  const searchQuery = ref('')
  const activeSongsLoading = ref(false)
  const activePlaylistSongList = shallowRef<Song[]>([])

  // ========== 计算属性 ==========
  const currentSong = computed(() =>
    currentIndex.value >= 0 ? playlist.value[currentIndex.value] : null
  )

  const defaultPlaylist = computed(() =>
    playlists.value.find((p) => p.type === 'default')
  )

  const customPlaylists = computed(() =>
    playlists.value.filter((p) => p.type === 'custom')
  )

  const filteredCustomPlaylists = computed(() => {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query) return customPlaylists.value
    return customPlaylists.value.filter((pl) =>
      pl.name.toLowerCase().includes(query)
    )
  })

  const activePlaylistSongs = computed(() => {
    const active = playlists.value.find((p) => p.id === activePlaylistId.value)
    if (!active) return []
    if (active.type === 'default') {
      return playlist.value
    }
    // 自定义歌单: 返回已加载的歌曲列表
    return activePlaylistSongList.value
  })

  // 加载当前歌单的歌曲
  async function loadActivePlaylistSongs() {
    const active = playlists.value.find((p) => p.id === activePlaylistId.value)
    if (!active) return

    if (active.type === 'default') {
      activePlaylistSongList.value = playlist.value
      return
    }

    activeSongsLoading.value = true
    try {
      const plSongs = await loadPlaylistSongs(activePlaylistId.value)
      // 通过 song_hash 映射到完整的 Song 对象
      const songs: Song[] = []
      for (const ps of plSongs) {
        const song = playlist.value.find((s) => s.content_hash === ps.song_hash)
        if (song) {
          songs.push(song)
        }
      }
      activePlaylistSongList.value = songs
    } finally {
      activeSongsLoading.value = false
    }
  }

  const filteredActivePlaylistSongs = computed(() => {
    const query = searchQuery.value.trim().toLowerCase()
    const songs = activePlaylistSongs.value
    if (!query) return songs
    return songs.filter((song) =>
      song.title.toLowerCase().includes(query) ||
      song.artist.toLowerCase().includes(query) ||
      song.album.toLowerCase().includes(query)
    )
  })

  // ========== 工具方法 ==========
  function findSongById(songId: string): Song | undefined {
    return playlist.value.find((s) => s.id === songId)
  }

  // ========== URL 缓存(阶段 1.3 优化) ==========
  const coverUrlCache = new Map<string, string>()
  const audioUrlCache = new Map<string, string>()

  function getAudioUrl(filePath: string): string {
    if (!filePath) return ''
    let url = audioUrlCache.get(filePath)
    if (url === undefined) {
      url = convertFileSrc(filePath)
      audioUrlCache.set(filePath, url)
    }
    return url
  }

  function getCoverUrl(coverPath: string | null): string {
    if (!coverPath) return ''
    let url = coverUrlCache.get(coverPath)
    if (url === undefined) {
      url = convertFileSrc(coverPath)
      coverUrlCache.set(coverPath, url)
    }
    return url
  }

  function getCoverThumbUrl(coverPath: string | null, thumbPath: string | null | undefined): string {
    if (thumbPath) {
      let url = coverUrlCache.get(thumbPath)
      if (url === undefined) {
        url = convertFileSrc(thumbPath)
        coverUrlCache.set(thumbPath, url)
      }
      return url
    }
    return getCoverUrl(coverPath)
  }

  // ========== 内存回收 ==========
  function compactMemory() {
    // 保留当前播放歌曲的音频 URL, 清空其他
    const current = currentSong.value
    const keepAudio = current ? current.file_path : ''
    audioUrlCache.forEach((_, key) => {
      if (key !== keepAudio) {
        audioUrlCache.delete(key)
      }
    })

    // 封面 URL 缓存保留最近使用的 100 个
    if (coverUrlCache.size > 100) {
      let count = 0
      const toDelete: string[] = []
      coverUrlCache.forEach((_, key) => {
        count++
        if (count > 100) toDelete.push(key)
      })
      toDelete.forEach((k) => coverUrlCache.delete(k))
    }

    // 歌单歌曲缓存只保留当前激活的
    const activeId = activePlaylistId.value
    playlistSongCache.forEach((_, key) => {
      if (key !== activeId) {
        playlistSongCache.delete(key)
      }
    })
  }

  // ========== 歌单管理 ==========
  // 从后端加载歌单列表
  async function loadPlaylistsFromDb() {
    try {
      const records = await invoke<PlaylistRecord[]>('get_all_playlists')
      const result: Playlist[] = records.map((r) => ({
        id: String(r.id),
        name: r.name,
        type: r.is_default ? 'default' : 'custom',
        songIds: [],
        expanded: r.is_default ? true : false,
        songCount: r.song_count,
      }))
      playlists.value = result
      playlistsLoaded.value = true

      // 如果只有默认歌单, 尝试从 localStorage 迁移
      const customPlaylists = result.filter((p) => p.type === 'custom')
      if (customPlaylists.length === 0) {
        await migrateLocalPlaylists()
      }
    } catch (error) {
      console.warn('从数据库加载歌单失败, 使用空列表:', error)
      playlists.value = [
        {
          id: 'all-songs',
          name: '全部歌曲',
          type: 'default',
          songIds: [],
          expanded: true,
        },
      ]
      playlistsLoaded.value = true
    }
  }

  // 从 localStorage 迁移自定义歌单到 SQLite
  async function migrateLocalPlaylists() {
    try {
      const localPls = loadPlaylists()
      const customPls = localPls.filter((p) => p.type === 'custom')
      if (customPls.length === 0) return

      console.log(`[playlist] 发现 ${customPls.length} 个本地歌单，开始迁移...`)

      for (const pl of customPls) {
        // 根据 songIds 找到对应的 file_path
        const songPaths: string[] = []
        for (const songId of pl.songIds) {
          const song = playlist.value.find((s) => s.id === songId)
          if (song) {
            songPaths.push(song.file_path)
          }
        }

        if (songPaths.length > 0) {
          const newId = await invoke<number>('import_playlist_from_paths', {
            name: pl.name,
            songPaths,
          })
          console.log(`[playlist] 歌单"${pl.name}"迁移完成，新 id: ${newId}`)
        }
      }

      // 重新加载歌单列表
      await loadPlaylistsFromDb()
    } catch (error) {
      console.warn('迁移本地歌单失败:', error)
    }
  }

  // 加载指定歌单的歌曲
  async function loadPlaylistSongs(playlistId: string): Promise<PlaylistSong[]> {
    const cached = playlistSongCache.get(playlistId)
    if (cached) return cached

    try {
      const id = parseInt(playlistId, 10)
      if (isNaN(id)) return []

      const songs = await invoke<PlaylistSong[]>('get_playlist_songs', {
        playlistId: id,
      })
      playlistSongCache.set(playlistId, songs)
      return songs
    } catch (error) {
      console.warn('加载歌单歌曲失败:', error)
      return []
    }
  }

  // 刷新歌单歌曲缓存
  function invalidatePlaylistCache(playlistId?: string) {
    if (playlistId) {
      playlistSongCache.delete(playlistId)
    } else {
      playlistSongCache.clear()
    }
    playlistContentVersion.value++
  }

  async function createPlaylist(name: string): Promise<Playlist> {
    try {
      const id = await invoke<number>('create_playlist', {
        name,
        description: '',
      })
      const newPlaylist: Playlist = {
        id: String(id),
        name,
        type: 'custom',
        songIds: [],
        expanded: true,
      }
      playlists.value.push(newPlaylist)
      return newPlaylist
    } catch (error) {
      console.error('创建歌单失败:', error)
      throw error
    }
  }

  async function deletePlaylist(playlistId: string) {
    const idx = playlists.value.findIndex((p) => p.id === playlistId)
    if (idx === -1) return
    if (playlists.value[idx].type !== 'custom') return

    try {
      const id = parseInt(playlistId, 10)
      if (!isNaN(id)) {
        await invoke('delete_playlist', { id })
      }
      if (activePlaylistId.value === playlistId) {
        activePlaylistId.value = '1'
      }
      playlists.value.splice(idx, 1)
      invalidatePlaylistCache(playlistId)
    } catch (error) {
      console.error('删除歌单失败:', error)
      throw error
    }
  }

  async function renamePlaylist(playlistId: string, newName: string) {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl || pl.type !== 'custom') return

    try {
      const id = parseInt(playlistId, 10)
      if (!isNaN(id)) {
        await invoke('rename_playlist', { id, newName })
      }
      pl.name = newName
    } catch (error) {
      console.error('重命名歌单失败:', error)
      throw error
    }
  }

  function togglePlaylistExpand(playlistId: string) {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (pl) {
      pl.expanded = !pl.expanded
    }
  }

  function selectPlaylist(playlistId: string) {
    activePlaylistId.value = playlistId
    // 切换歌单时，加载该歌单的歌曲
    void loadActivePlaylistSongs()
  }

  async function addSongToPlaylist(songId: string, playlistId: string): Promise<boolean> {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl) return false

    try {
      const hash = idToHashMap.value.get(songId)
      if (!hash) return false

      const id = parseInt(playlistId, 10)
      if (isNaN(id)) return false

      await invoke('add_song_to_playlist', {
        playlistId: id,
        songHash: hash,
      })
      invalidatePlaylistCache(playlistId)
      // 更新歌单歌曲数量
      if (pl.songCount !== undefined) {
        pl.songCount++
      }
      if (playlistId === activePlaylistId.value) {
        void loadActivePlaylistSongs()
      }
      return true
    } catch (error) {
      console.error('添加歌曲到歌单失败:', error)
      return false
    }
  }

  async function toggleSongInPlaylist(songId: string, playlistId: string): Promise<boolean> {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl) return false

    try {
      const hash = idToHashMap.value.get(songId)
      if (!hash) return false

      const id = parseInt(playlistId, 10)
      if (isNaN(id)) return false

      // 先检查是否已在歌单中
      const songs = await loadPlaylistSongs(playlistId)
      const exists = songs.some((s) => s.song_hash === hash)

      if (exists) {
        await invoke('remove_song_from_playlist', {
          playlistId: id,
          songHash: hash,
        })
        invalidatePlaylistCache(playlistId)
        // 更新歌单歌曲数量
        if (pl.songCount !== undefined && pl.songCount > 0) {
          pl.songCount--
        }
        if (playlistId === activePlaylistId.value) {
          void loadActivePlaylistSongs()
        }
        return false
      } else {
        await invoke('add_song_to_playlist', {
          playlistId: id,
          songHash: hash,
        })
        invalidatePlaylistCache(playlistId)
        // 更新歌单歌曲数量
        if (pl.songCount !== undefined) {
          pl.songCount++
        }
        if (playlistId === activePlaylistId.value) {
          void loadActivePlaylistSongs()
        }
        return true
      }
    } catch (error) {
      console.error('切换歌曲在歌单中的状态失败:', error)
      return false
    }
  }

  async function removeSongFromPlaylist(songId: string, playlistId: string) {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl || pl.type !== 'custom') return

    try {
      const hash = idToHashMap.value.get(songId)
      if (!hash) return

      const id = parseInt(playlistId, 10)
      if (isNaN(id)) return

      await invoke('remove_song_from_playlist', {
        playlistId: id,
        songHash: hash,
      })
      invalidatePlaylistCache(playlistId)
      // 更新歌单歌曲数量
      if (pl.songCount !== undefined && pl.songCount > 0) {
        pl.songCount--
      }
      if (playlistId === activePlaylistId.value) {
        void loadActivePlaylistSongs()
      }
    } catch (error) {
      console.error('从歌单移除歌曲失败:', error)
    }
  }

  async function isSongInPlaylist(songId: string, playlistId: string): Promise<boolean> {
    const hash = idToHashMap.value.get(songId)
    if (!hash) return false

    const songs = await loadPlaylistSongs(playlistId)
    return songs.some((s) => s.song_hash === hash)
  }

  function syncDefaultPlaylist(songs: Song[]) {
    // 默认歌单就是全部歌曲，不需要单独维护 songIds
    // 这里只是为了保持接口兼容
    const defaultPl = playlists.value.find((p) => p.type === 'default')
    if (defaultPl) {
      defaultPl.songIds = songs.map((s) => s.id)
    }
    // 清除歌单歌曲缓存
    invalidatePlaylistCache()
  }

  // ========== 文件夹扫描 ==========
// v1.1 性能优化 (2026-07-15): 两阶段扫描
//   - 阶段 1 (快速返回): 文件名/ID3基础信息 + duration + content_hash
//     → 前端立即拿到歌曲列表，记忆功能可用
//   - 阶段 2 (后台异步): 封面提取 + 缩略图生成
//     → 通过 scan:enrich-progress 事件增量更新
//     → 封面提取是最耗时的操作，移到后台不阻塞首屏
async function scanMusicFolder(path: string, forceRefresh = false) {
  isLoading.value = true

  try {
    const metaSrc = metadataSource.value === 'filename' ? 'filename' : 'auto'
    const songs = await invoke<Song[]>('scan_music_folder', {
      folderPath: path,
      metadataSource: metaSrc,
      forceRefresh,
    })

    // 记录当前播放的歌曲 ID,用于扫描后恢复
    const currentSongId = currentSong.value?.id

    playlist.value = songs
    folderPath.value = path
    setMusicLibraryPath(path)
    syncDefaultPlaylist(songs)

    // 加载当前歌单的歌曲
    void loadActivePlaylistSongs()

    // 下载输出目录默认联动音乐库
    // 仅当用户从未显式设置过 (downloadOutputDir 为空) 时自动同步
    const settingsStore = useSettingsStore()
    if (!settingsStore.downloadOutputDir) {
      settingsStore.setDownloadOutputDir(path)
    }

    // 尝试恢复当前播放位置
    if (currentSongId) {
      const newIndex = songs.findIndex((s) => s.id === currentSongId)
      if (newIndex !== -1) {
        currentIndex.value = newIndex
      } else if (songs.length > 0) {
        currentIndex.value = 0
      } else {
        currentIndex.value = -1
      }
    } else if (songs.length > 0 && currentIndex.value === -1) {
      currentIndex.value = 0
    } else if (songs.length === 0) {
      currentIndex.value = -1
    }

    // ========== 阶段 2: 监听后台封面补全事件 ==========
    const unlistenProgress = await listen('scan:enrich-progress', (event) => {
      const payload = event.payload as {
        id: string
        file_path: string
        cover_path: string | null
        cover_thumb_path: string | null
        index: number
        total: number
      }

      const songIndex = playlist.value.findIndex((s) => s.id === payload.id)
      if (songIndex !== -1) {
        const updated = [...playlist.value]
        updated[songIndex] = {
          ...updated[songIndex],
          cover_path: payload.cover_path ?? updated[songIndex].cover_path,
          cover_thumb_path: payload.cover_thumb_path ?? updated[songIndex].cover_thumb_path,
        }
        playlist.value = updated
        syncDefaultPlaylist(updated)
      }
    })

    const unlistenComplete = await listen('scan:enrich-complete', () => {
      unlistenProgress()
      unlistenComplete()
    })

    return songs
  } catch (error) {
    clearMusicLibraryPath()
    throw error
  } finally {
    isLoading.value = false
  }
}

  function setMetadataSource(source: 'auto' | 'filename') {
    metadataSource.value = source
    if (folderPath.value) {
      void scanMusicFolder(folderPath.value, true)
    }
  }

  async function refreshMetadata() {
    if (folderPath.value) {
      await scanMusicFolder(folderPath.value, true)
    }
  }

  /**
   * 更新本地缓存中某首歌的元数据 (title/artist/album)
   * 会同步更新 playlist 和 activePlaylistSongList
   */
  function updateSongLocalMetadata(songId: string, updates: { title?: string; artist?: string; album?: string }) {
    // 更新默认歌单播放列表
    const idx = playlist.value.findIndex((s) => s.id === songId)
    if (idx !== -1) {
      const updated = [...playlist.value]
      updated[idx] = {
        ...updated[idx],
        ...updates,
      }
      playlist.value = updated
    }

    // 更新当前激活的自定义歌单列表
    const activeIdx = activePlaylistSongList.value.findIndex((s) => s.id === songId)
    if (activeIdx !== -1) {
      const updated = [...activePlaylistSongList.value]
      updated[activeIdx] = {
        ...updated[activeIdx],
        ...updates,
      }
      activePlaylistSongList.value = updated
    }
  }

  function removeSongFromLibrary(songId: string) {
    const idx = playlist.value.findIndex((s) => s.id === songId)
    if (idx !== -1) {
      const updated = [...playlist.value]
      updated.splice(idx, 1)
      playlist.value = updated
    }

    const activeIdx = activePlaylistSongList.value.findIndex((s) => s.id === songId)
    if (activeIdx !== -1) {
      const updated = [...activePlaylistSongList.value]
      updated.splice(activeIdx, 1)
      activePlaylistSongList.value = updated
    }
  }

  async function autoLoadMusicLibrary(): Promise<{ success: boolean; error?: string }> {
    const savedPath = getMusicLibraryPath()
    if (!savedPath) {
      return { success: false }
    }

    isLoading.value = true
    try {
      // 直接从数据库加载（不扫描物理文件夹）
      // 只有用户主动点击"选择文件夹"或"重新扫描"时才扫描物理文件夹
      const songsFromDb = await invoke<Song[]>('load_default_playlist_songs')
      if (songsFromDb && songsFromDb.length > 0) {
        playlist.value = songsFromDb
        folderPath.value = savedPath
        await loadPlaylistsFromDb()
        void loadActivePlaylistSongs()
        if (songsFromDb.length > 0 && currentIndex.value === -1) {
          currentIndex.value = 0
        }
        return { success: true }
      }

      // 数据库为空，不自动扫描文件夹
      // 用户需要手动点击"选择文件夹"或"重新扫描"来导入音乐
      playlist.value = []
      folderPath.value = savedPath
      await loadPlaylistsFromDb()
      void loadActivePlaylistSongs()
      return { success: true }
    } catch (error) {
      console.error('从数据库加载音乐库失败:', error)
      clearMusicLibraryPath()
      folderPath.value = ''
      const errorMsg = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMsg }
    } finally {
      isLoading.value = false
    }
  }

  // 持久化 folderPath / metadataSource (与 settings 一起)
  let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    [folderPath, metadataSource],
    ([path, metaSrc]) => {
      if (settingsSaveTimer) {
        clearTimeout(settingsSaveTimer)
      }
      settingsSaveTimer = setTimeout(() => {
        // 读取现有 settings, 合并写入
        const existing = loadSettings()
        saveSettings({
          ...existing,
          folderPath: path,
          metadataSource: metaSrc,
        })
      }, 300)
    },
    { deep: true, flush: 'post' }
  )

  // 初始化歌单 (异步, 不阻塞 store 创建)
  void loadPlaylistsFromDb()

  return {
    // 歌曲
    playlist,
    currentIndex,
    currentSong,
    isLoading,
    folderPath,
    metadataSource,
    // 歌单
    playlists,
    activePlaylistId,
    activePlaylistSongs,
    activeSongsLoading,
    playlistsLoaded,
    defaultPlaylist,
    customPlaylists,
    filteredCustomPlaylists,
    playlistContentVersion,
    // 搜索
    searchQuery,
    filteredActivePlaylistSongs,
    // 工具
    findSongById,
    getAudioUrl,
    getCoverUrl,
    getCoverThumbUrl,
    // 歌单方法
    loadPlaylistsFromDb,
    loadPlaylistSongs,
    loadActivePlaylistSongs,
    createPlaylist,
    deletePlaylist,
    renamePlaylist,
    togglePlaylistExpand,
    selectPlaylist,
    addSongToPlaylist,
    toggleSongInPlaylist,
    removeSongFromPlaylist,
    isSongInPlaylist,
    syncDefaultPlaylist,
    // 扫描
    scanMusicFolder,
    autoLoadMusicLibrary,
    setMetadataSource,
    refreshMetadata,
    updateSongLocalMetadata,
    removeSongFromLibrary,
    // 内存管理
    compactMemory,
  }
})
