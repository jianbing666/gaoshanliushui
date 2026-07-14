import { defineStore } from 'pinia'
import { ref, computed, watch, shallowRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Song, Playlist } from '@/types/song'
import {
  loadSettings,
  saveSettings,
  loadPlaylists,
  savePlaylists,
  getMusicLibraryPath,
  setMusicLibraryPath,
  clearMusicLibraryPath,
  generateId,
} from '@/utils/storage'

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
  const playlists = ref<Playlist[]>(loadPlaylists())
  const activePlaylistId = ref<string>('all-songs')

  // ========== 搜索 ==========
  const searchQuery = ref('')

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
    return active.songIds
      .map((id) => findSongById(id))
      .filter((s): s is Song => s !== undefined)
  })

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

  // ========== 歌单管理 ==========
  function createPlaylist(name: string): Playlist {
    const newPlaylist: Playlist = {
      id: generateId('playlist'),
      name,
      type: 'custom',
      songIds: [],
      expanded: true,
    }
    playlists.value.push(newPlaylist)
    return newPlaylist
  }

  function deletePlaylist(playlistId: string) {
    const idx = playlists.value.findIndex((p) => p.id === playlistId)
    if (idx !== -1 && playlists.value[idx].type === 'custom') {
      if (activePlaylistId.value === playlistId) {
        activePlaylistId.value = 'all-songs'
      }
      playlists.value.splice(idx, 1)
    }
  }

  function renamePlaylist(playlistId: string, newName: string) {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (pl && pl.type === 'custom') {
      pl.name = newName
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
  }

  function addSongToPlaylist(songId: string, playlistId: string): boolean {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl) return false
    if (!pl.songIds.includes(songId)) {
      pl.songIds.push(songId)
      return true
    }
    return false
  }

  function toggleSongInPlaylist(songId: string, playlistId: string): boolean {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (!pl) return false
    const idx = pl.songIds.indexOf(songId)
    if (idx === -1) {
      pl.songIds.push(songId)
      return true
    } else {
      pl.songIds.splice(idx, 1)
      return false
    }
  }

  function removeSongFromPlaylist(songId: string, playlistId: string) {
    const pl = playlists.value.find((p) => p.id === playlistId)
    if (pl && pl.type === 'custom') {
      const idx = pl.songIds.indexOf(songId)
      if (idx !== -1) {
        pl.songIds.splice(idx, 1)
      }
    }
  }

  function isSongInPlaylist(songId: string, playlistId: string): boolean {
    const pl = playlists.value.find((p) => p.id === playlistId)
    return pl ? pl.songIds.includes(songId) : false
  }

  function syncDefaultPlaylist(songs: Song[]) {
    const defaultPl = playlists.value.find((p) => p.type === 'default')
    if (defaultPl) {
      defaultPl.songIds = songs.map((s) => s.id)
    }
  }

  // ========== 文件夹扫描 ==========
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

      return songs
    } catch (error) {
      console.error('扫描文件夹失败:', error)
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

  async function autoLoadMusicLibrary(): Promise<{ success: boolean; error?: string }> {
    const savedPath = getMusicLibraryPath()
    if (!savedPath) {
      return { success: false }
    }

    isLoading.value = true
    try {
      const metaSrc = metadataSource.value === 'filename' ? 'filename' : 'auto'
      const songs = await invoke<Song[]>('scan_music_folder', {
        folderPath: savedPath,
        metadataSource: metaSrc,
        forceRefresh: false,
      })
      playlist.value = songs
      folderPath.value = savedPath
      syncDefaultPlaylist(songs)
      if (songs.length > 0 && currentIndex.value === -1) {
        currentIndex.value = 0
      }
      return { success: true }
    } catch (error) {
      console.error('自动加载音乐库失败(路径可能已失效):', error)
      clearMusicLibraryPath()
      folderPath.value = ''
      const errorMsg = error instanceof Error ? error.message : '未知错误'
      return { success: false, error: errorMsg }
    } finally {
      isLoading.value = false
    }
  }

  // ========== 持久化(防抖) ==========
  let playlistSaveTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    playlists,
    (pls) => {
      if (playlistSaveTimer) {
        clearTimeout(playlistSaveTimer)
      }
      playlistSaveTimer = setTimeout(() => {
        savePlaylists(pls)
      }, 500)
    },
    { deep: true, flush: 'post' }
  )

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
    defaultPlaylist,
    customPlaylists,
    filteredCustomPlaylists,
    // 搜索
    searchQuery,
    filteredActivePlaylistSongs,
    // 工具
    findSongById,
    getAudioUrl,
    getCoverUrl,
    // 歌单方法
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
  }
})
