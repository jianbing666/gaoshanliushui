import { defineStore } from 'pinia'
import { ref, computed, nextTick, watch, markRaw, shallowRef } from 'vue'
import type { Song, LoopMode, ThemeMode, Playlist, BackgroundSettings, FontSettings, FontFamily, PlayHistoryItem } from '@/types/song'
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { audioPlayer } from '@/utils/audioPlayer'

export interface ContextMenuState {
  visible: boolean
  song: Song | null
  playlistId: string | null
  x: number
  y: number
}

// ========== Web Audio API 主播放链路（替代 HTML5 Audio） ==========
// AudioContext 实例
let audioContext: AudioContext | null = null
// AnalyserNode 实例（频谱分析）
let analyserNode: AnalyserNode | null = null
// GainNode 实例（音量控制）
let gainNode: GainNode | null = null
// AudioBufferSourceNode 实例（音频源，一次性）
let audioSourceNode: AudioBufferSourceNode | null = null
// 当前播放歌曲的 AudioBuffer（仅保留一首，最大程度节省内存）
let currentAudioBuffer: AudioBuffer | null = null
let currentBufferUrl: string | null = null
// 当前播放歌曲的 URL
let currentAudioUrl: string | null = null
// ========== 阶段 3.3: AudioBuffer LRU 缓存（保留前一首） ==========
// 目的: 切回上一首 < 50ms, 跳过 fetch + decodeAudioData
// 内存代价: ~30-50MB（视歌曲长度/码率）, 用户已接受
// 命中键: prevSongId, prevBufferUrl 同步以备 stale 校验
let prevBuffer: AudioBuffer | null = null
let prevBufferUrl: string | null = null
let prevSongId: string | null = null
// 暂停时的播放位置（秒），用于恢复播放
let pausedOffset: number = 0
// 播放开始时的 AudioContext 时间，用于计算当前播放时间
let playbackStartTime: number = 0
// 是否已暂停（用于区分主动暂停和播放结束）
let isPaused: boolean = false

// LocalStorage 键与限制
const STORAGE_KEY = 'gaoshanliushui-settings'
const MUSIC_LIBRARY_PATH_KEY = 'musicLibraryPath'
const PLAYLISTS_KEY = 'gaoshanliushui-playlists'
const HISTORY_KEY = 'gaoshanliushui-history'
const FULL_HISTORY_KEY = 'gaoshanliushui-full-history'
const MAX_HISTORY_ITEMS = 500
const MAX_FULL_HISTORY_ITEMS = 10000

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
  // 阶段 4.x: shallowRef 替代 ref
  // 原因: 10000 首歌时深响应 proxy 重建成本显著 (启动 +200ms / 内存 +5-10MB)
  // 写入约束: 必须整体替换 (playlist.value = newArr), 不能 push/splice
  // 读取: computed 内部 `playlist.value[index]` 仍响应
  const playlist = shallowRef<Song[]>([])
  const currentIndex = ref(-1)

  // ========== 歌单分组管理 ==========
  const playlists = ref<Playlist[]>(loadPlaylists())
  // 当前选中的歌单 ID
  const activePlaylistId = ref<string>('all-songs')

  // ========== 播放历史记录 ==========
  // 展示用历史记录（去重，同一首歌只保留最新一次）
  const playHistory = ref<PlayHistoryItem[]>(loadPlayHistory())
  // 完整播放记录（不去重，用于数据统计）
  const fullPlayHistory = ref<PlayHistoryItem[]>(loadFullPlayHistory())
  const showHistoryDrawer = ref(false)

  // 当前播放的记录（用于累加播放时长）
  let currentHistoryItem: PlayHistoryItem | null = null
  let currentPlayStartTime = 0

  // ========== 阶段 2.5-2.6: 统计预聚合索引 ==========
  // 目的: 避免 6 个 computed 每次都对全量 fullPlayHistory 做 O(n) 扫描
  // 数据规模: max 10000 条, 直接 filter + sort 需 5-10ms; 预聚合后 <1ms
  // 设计: shallowRef + 整体替换 (新对象) 触发响应, 避免深 Proxy 重建

  // 按日分桶: { 'YYYY-MM-DD': PlayHistoryItem[] }
  const playHistoryByDay = shallowRef<Record<string, PlayHistoryItem[]>>({})
  // 按歌曲计数: { songId: count }
  const songPlayCount = shallowRef<Record<string, number>>({})
  // 按歌曲累计时长: { songId: totalPlayedSeconds }
  const songPlayDuration = shallowRef<Record<string, number>>({})
  // 全量总时长（避免每次 reduce）
  let totalPlayedDuration = 0
  // 完整播放次数
  let totalCompletedCount = 0
  // 唯一歌曲数
  let totalUniqueSongs = 0

  // 从 fullPlayHistory 构建预聚合索引（启动时一次性）
  function buildStatsIndex() {
    const byDay: Record<string, PlayHistoryItem[]> = {}
    const count: Record<string, number> = {}
    const duration: Record<string, number> = {}
    const uniqueIds = new Set<string>()

    for (const item of fullPlayHistory.value) {
      // 按日分桶
      const d = new Date(item.playedAt)
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!byDay[dayKey]) byDay[dayKey] = []
      byDay[dayKey].push(item)

      // 计数
      count[item.songId] = (count[item.songId] || 0) + 1
      // 累计时长
      duration[item.songId] = (duration[item.songId] || 0) + item.playedDuration
      // 总时长
      totalPlayedDuration += item.playedDuration
      // 完整播放
      if (item.completed) totalCompletedCount++
      // 唯一
      uniqueIds.add(item.songId)
    }

    // 排序每个桶（按 playedAt 降序）
    for (const k of Object.keys(byDay)) {
      byDay[k].sort((a, b) => b.playedAt - a.playedAt)
    }

    playHistoryByDay.value = byDay
    songPlayCount.value = count
    songPlayDuration.value = duration
    totalUniqueSongs = uniqueIds.size
  }
  // 启动时同步构建一次
  buildStatsIndex()

  // 重新构建索引（清空历史时调用）
  function rebuildStatsIndex() {
    totalPlayedDuration = 0
    totalCompletedCount = 0
    totalUniqueSongs = 0
    buildStatsIndex()
  }

  function loadPlayHistory(): PlayHistoryItem[] {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }

  function loadFullPlayHistory(): PlayHistoryItem[] {
    try {
      const raw = localStorage.getItem(FULL_HISTORY_KEY)
      if (raw) return JSON.parse(raw)
      // 首次加载时，如果没有完整记录，用现有展示记录初始化
      const displayRaw = localStorage.getItem(HISTORY_KEY)
      return displayRaw ? JSON.parse(displayRaw) : []
    } catch {
      return []
    }
  }

  function savePlayHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(playHistory.value))
    } catch {
      // 忽略写入失败
    }
  }

  function saveFullPlayHistory() {
    try {
      localStorage.setItem(FULL_HISTORY_KEY, JSON.stringify(fullPlayHistory.value))
    } catch {
      // 忽略写入失败
    }
  }

  // 开始记录播放历史
  function startHistoryRecord(song: Song) {
    // 先结束上一首歌的记录
    endHistoryRecord()

    currentHistoryItem = {
      id: generateId(),
      songId: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      cover_path: song.cover_path,
      file_path: song.file_path,
      playedAt: Date.now(),
      playedDuration: 0,
      completed: false,
    }
    currentPlayStartTime = audioContext ? audioContext.currentTime : Date.now() / 1000
  }

  // 结束记录播放历史
  function endHistoryRecord() {
    if (!currentHistoryItem || !audioContext) return

    const playedDuration = audioContext.currentTime - currentPlayStartTime
    currentHistoryItem.playedDuration = playedDuration
    currentHistoryItem.completed = playedDuration >= currentHistoryItem.duration * 0.8

    // 1. 添加到完整播放记录（不去重，用于统计）
    fullPlayHistory.value.unshift({ ...currentHistoryItem })
    // 限制完整记录最大条数
    if (fullPlayHistory.value.length > MAX_FULL_HISTORY_ITEMS) {
      fullPlayHistory.value = fullPlayHistory.value.slice(0, MAX_FULL_HISTORY_ITEMS)
    }
    saveFullPlayHistory()

    // 2. 更新展示用历史记录（去重，同一首歌只保留最新一次）
    playHistory.value = playHistory.value.filter((item) => item.songId !== currentHistoryItem!.songId)
    playHistory.value.unshift(currentHistoryItem)
    // 限制展示记录最大条数
    if (playHistory.value.length > MAX_HISTORY_ITEMS) {
      playHistory.value = playHistory.value.slice(0, MAX_HISTORY_ITEMS)
    }
    savePlayHistory()

    // 3. 阶段 2.5: 增量更新预聚合索引
    const item = currentHistoryItem
    const d = new Date(item.playedAt)
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    // 按日分桶增量
    const dayBucket = playHistoryByDay.value[dayKey] ? [...playHistoryByDay.value[dayKey]] : []
    dayBucket.unshift(item)
    playHistoryByDay.value = { ...playHistoryByDay.value, [dayKey]: dayBucket }

    // 计数/时长增量（先取旧值，再赋新值）
    const oldCount = songPlayCount.value[item.songId] || 0
    const newCount = oldCount + 1
    songPlayCount.value = {
      ...songPlayCount.value,
      [item.songId]: newCount,
    }
    songPlayDuration.value = {
      ...songPlayDuration.value,
      [item.songId]: (songPlayDuration.value[item.songId] || 0) + item.playedDuration,
    }

    // 模块级变量
    totalPlayedDuration += item.playedDuration
    if (item.completed) totalCompletedCount++
    if (oldCount === 0) totalUniqueSongs++

    currentHistoryItem = null
  }

  // 切换历史记录抽屉
  function toggleHistoryDrawer() {
    // 同侧互斥：展开历史记录时收起侧边栏
    if (!showHistoryDrawer.value && showSidebar.value) {
      showSidebar.value = false
    }
    showHistoryDrawer.value = !showHistoryDrawer.value
  }

  // 清空历史记录
  function clearPlayHistory() {
    playHistory.value = []
    fullPlayHistory.value = []
    savePlayHistory()
    saveFullPlayHistory()
    // 阶段 2.5: 重建预聚合索引
    rebuildStatsIndex()
  }

  // 删除单条历史记录
  function removeHistoryItem(id: string) {
    // 从展示记录中删除
    const idx = playHistory.value.findIndex((item) => item.id === id)
    if (idx !== -1) {
      playHistory.value.splice(idx, 1)
      savePlayHistory()
    }
    // 从完整记录中删除（同时更新预聚合索引）
    const fullIdx = fullPlayHistory.value.findIndex((item) => item.id === id)
    if (fullIdx !== -1) {
      const removed = fullPlayHistory.value[fullIdx]
      fullPlayHistory.value.splice(fullIdx, 1)
      saveFullPlayHistory()
      // 阶段 2.5: 增量回滚预聚合
      const d = new Date(removed.playedAt)
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const bucket = playHistoryByDay.value[dayKey]
      if (bucket) {
        playHistoryByDay.value = {
          ...playHistoryByDay.value,
          [dayKey]: bucket.filter((i) => i.id !== id),
        }
      }
      const oldCount = songPlayCount.value[removed.songId] || 0
      const newCount = Math.max(0, oldCount - 1)
      songPlayCount.value = {
        ...songPlayCount.value,
        [removed.songId]: newCount,
      }
      const newDuration = Math.max(0, (songPlayDuration.value[removed.songId] || 0) - removed.playedDuration)
      songPlayDuration.value = {
        ...songPlayDuration.value,
        [removed.songId]: newDuration,
      }
      totalPlayedDuration = Math.max(0, totalPlayedDuration - removed.playedDuration)
      if (removed.completed) totalCompletedCount = Math.max(0, totalCompletedCount - 1)
      if (newCount === 0) totalUniqueSongs = Math.max(0, totalUniqueSongs - 1)
    }
  }

  // ========== 数据统计 ==========
  const showStatsPanel = ref(false)

  function toggleStatsPanel() {
    showStatsPanel.value = !showStatsPanel.value
  }

  // ========== 下载面板 ==========
  const showDownloadPanel = ref(false)

  function toggleDownloadPanel() {
    showDownloadPanel.value = !showDownloadPanel.value
  }

  // ========== 侧边栏 ==========
  const showSidebar = ref(true)

  function toggleSidebar() {
    // 同侧互斥：展开侧边栏时收起历史记录
    if (!showSidebar.value && showHistoryDrawer.value) {
      showHistoryDrawer.value = false
    }
    showSidebar.value = !showSidebar.value
  }

  // 获取某一时间段内的播放记录（基于按日分桶索引, O(桶数) 而非 O(全量)）
  function getHistoryInRange(startTime: number, endTime: number): PlayHistoryItem[] {
    const result: PlayHistoryItem[] = []
    const start = new Date(startTime)
    const end = new Date(endTime)
    // 生成涵盖此区间的所有 dayKey
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d.getTime() < end.getTime(); d.setDate(d.getDate() + 1)) {
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const bucket = playHistoryByDay.value[dayKey]
      if (bucket) {
        for (const item of bucket) {
          if (item.playedAt >= startTime && item.playedAt < endTime) {
            result.push(item)
          }
        }
      }
    }
    return result
  }

  // 汇总桶内数据
  function summarizeBucket(items: PlayHistoryItem[]): { count: number; totalDuration: number; completedCount: number } {
    let count = 0
    let totalDuration = 0
    let completedCount = 0
    for (const item of items) {
      count++
      totalDuration += item.playedDuration
      if (item.completed) completedCount++
    }
    return { count, totalDuration, completedCount }
  }

  // 今天的统计（O(1) 直接读桶）
  const todayStats = computed(() => {
    const now = new Date()
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    return summarizeBucket(playHistoryByDay.value[dayKey] || [])
  })

  // 本月统计
  const monthStats = computed(() => {
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()
    return summarizeBucket(getHistoryInRange(startOfMonth, endOfMonth))
  })

  // 本年统计
  const yearStats = computed(() => {
    const now = new Date()
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime()
    const endOfYear = new Date(now.getFullYear() + 1, 0, 1).getTime()
    return summarizeBucket(getHistoryInRange(startOfYear, endOfYear))
  })

  // 听歌之最：单曲循环次数最多的歌（O(唯一歌曲数)）
  const mostLoopedSong = computed(() => {
    let maxId = ''
    let maxCount = 0
    for (const [id, count] of Object.entries(songPlayCount.value)) {
      if (count > maxCount) {
        maxCount = count
        maxId = id
      }
    }
    if (!maxId) return null
    // 从 fullPlayHistory 中找到该 songId 的最近一条
    const item = fullPlayHistory.value.find((i) => i.songId === maxId)
    return item ? { song: item, count: maxCount } : null
  })

  // 听歌之最：总播放时长最久的歌
  const longestPlayedSong = computed(() => {
    let maxId = ''
    let maxDuration = 0
    for (const [id, dur] of Object.entries(songPlayDuration.value)) {
      if (dur > maxDuration) {
        maxDuration = dur
        maxId = id
      }
    }
    if (!maxId) return null
    const item = fullPlayHistory.value.find((i) => i.songId === maxId)
    return item ? { song: item, duration: maxDuration } : null
  })

  // 全部时间统计（直接读模块级累计变量）
  const allTimeStats = computed(() => ({
    count: fullPlayHistory.value.length,
    totalDuration: totalPlayedDuration,
    completedCount: totalCompletedCount,
    uniqueSongs: totalUniqueSongs,
  }))

  // 生成 Markdown 格式的统计报告
  function generateStatsMarkdown(): string {
    const now = new Date()
    const dateStr = now.toLocaleDateString('zh-CN')

    function formatDuration(seconds: number): string {
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      const secs = Math.floor(seconds % 60)
      if (hours > 0) {
        return `${hours}小时${minutes}分${secs}秒`
      } else if (minutes > 0) {
        return `${minutes}分${secs}秒`
      } else {
        return `${secs}秒`
      }
    }

    let md = `# 听歌数据统计报告\n\n`
    md += `> 生成时间：${dateStr}\n\n`

    md += `## 📊 听歌时长\n\n`
    md += `| 时间范围 | 播放次数 | 总时长 | 完整播放 |\n`
    md += `|----------|----------|--------|----------|\n`
    md += `| 今天 | ${todayStats.value.count} 首 | ${formatDuration(todayStats.value.totalDuration)} | ${todayStats.value.completedCount} 首 |\n`
    md += `| 本月 | ${monthStats.value.count} 首 | ${formatDuration(monthStats.value.totalDuration)} | ${monthStats.value.completedCount} 首 |\n`
    md += `| 本年 | ${yearStats.value.count} 首 | ${formatDuration(yearStats.value.totalDuration)} | ${yearStats.value.completedCount} 首 |\n`
    md += `| 全部 | ${allTimeStats.value.count} 首 | ${formatDuration(allTimeStats.value.totalDuration)} | ${allTimeStats.value.completedCount} 首 |\n\n`

    md += `## 🏆 听歌之最\n\n`

    if (mostLoopedSong.value) {
      md += `### 播放次数最多的歌曲\n\n`
      md += `- **歌曲**：${mostLoopedSong.value.song.title}\n`
      md += `- **歌手**：${mostLoopedSong.value.song.artist || '未知艺术家'}\n`
      md += `- **播放次数**：${mostLoopedSong.value.count} 次\n\n`
    }

    if (longestPlayedSong.value) {
      md += `### 累计播放时长最久的歌曲\n\n`
      md += `- **歌曲**：${longestPlayedSong.value.song.title}\n`
      md += `- **歌手**：${longestPlayedSong.value.song.artist || '未知艺术家'}\n`
      md += `- **累计时长**：${formatDuration(longestPlayedSong.value.duration)}\n\n`
    }

    md += `## 📈 其他统计\n\n`
    md += `- **累计收听歌曲数**：${allTimeStats.value.uniqueSongs} 首\n`
    md += `- **完整播放率**：${allTimeStats.value.count > 0 ? ((allTimeStats.value.completedCount / allTimeStats.value.count) * 100).toFixed(1) : 0}%\n`

    return md
  }

  // 导出统计报告（Markdown 格式）
  async function exportStatsReport() {
    try {
      const markdown = generateStatsMarkdown()
      const now = new Date()
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const filename = `听歌统计报告_${dateStr}.md`

      // 使用 Tauri API 保存文件
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')

      const filePath = await save({
        defaultPath: filename,
        filters: [{ name: 'Markdown 文件', extensions: ['md'] }],
      })

      if (filePath) {
        await writeTextFile(filePath, markdown)
        return true
      }
      return false
    } catch (e) {
      console.error('[Stats] 导出统计报告失败:', e)
      return false
    }
  }

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
      const globalIndex = playlist.value.findIndex((s) => s.id === song.id)
      if (globalIndex !== -1) {
        isSwitchingSong.value = true
        pendingPlay.value = true
        currentIndex.value = globalIndex
      }
    }
  }

  // ========== 播放状态 ==========
  const isPlaying = ref(false)
  // 切歌锁：防止旧音频 pause 事件污染 isPlaying
  const isSwitchingSong = ref(false)
  // 切歌后需要自动播放
  const pendingPlay = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref((saved.volume as number) ?? 0.8)
  const lastVolume = ref(0.8)
  const loopMode = ref<LoopMode>((saved.loopMode as LoopMode) ?? 'list')

  // ========== 加载状态 ==========
  const isLoading = ref(false)
  const folderPath = ref((saved.folderPath as string) ?? '')
  const metadataSource = ref<'auto' | 'filename'>((saved.metadataSource as 'auto' | 'filename') ?? 'auto')

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
    invoke('set_minimize_to_tray', { enabled: value }).catch(console.error)
  }

  // 初始化时同步最小化到托盘设置到后端
  invoke('set_minimize_to_tray', { enabled: minimizeToTray.value }).catch(console.error)

  // ========== 定时关闭 ==========
  const sleepTimerEnabled = ref<boolean>(false)
  const sleepTimerMinutes = ref<number>(30)
  const sleepTimerRemaining = ref<number>(0)
  let sleepTimerInterval: ReturnType<typeof setInterval> | null = null

  function startSleepTimer(minutes?: number) {
    if (minutes !== undefined) {
      sleepTimerMinutes.value = minutes
    }
    sleepTimerRemaining.value = sleepTimerMinutes.value * 60
    sleepTimerEnabled.value = true
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval)
    }
    sleepTimerInterval = setInterval(() => {
      sleepTimerRemaining.value--
      if (sleepTimerRemaining.value <= 0) {
        stopSleepTimer()
        pause()
      }
    }, 1000)
  }

  function stopSleepTimer() {
    sleepTimerEnabled.value = false
    sleepTimerRemaining.value = 0
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval)
      sleepTimerInterval = null
    }
  }

  function toggleSleepTimer() {
    if (sleepTimerEnabled.value) {
      stopSleepTimer()
    } else {
      startSleepTimer()
    }
  }

  function setSleepTimerMinutes(minutes: number) {
    sleepTimerMinutes.value = minutes
    if (sleepTimerEnabled.value) {
      sleepTimerRemaining.value = minutes * 60
    }
  }

  // ========== 频谱显示设置 ==========
  const showSpectrum = ref<boolean>(saved.showSpectrum ?? true)
  const spectrumLowPower = ref<boolean>(saved.spectrumLowPower ?? false)

  function setShowSpectrum(value: boolean) {
    showSpectrum.value = value
  }

  function setSpectrumLowPower(value: boolean) {
    spectrumLowPower.value = value
  }

  // ========== 性能/低功耗模式 ==========
  const lowPowerMode = ref<boolean>(saved.lowPowerMode ?? false)
  const isMiniMode = ref<boolean>(false)
  const spectrumPaused = ref<boolean>(false)

  // ========== 下载页：上次输出目录 (持久化,进入下载页自动填充) ==========
  const downloadOutputDir = ref<string>(saved.downloadOutputDir ?? '')

  function setDownloadOutputDir(path: string) {
    downloadOutputDir.value = path
  }

  function setLowPowerMode(value: boolean) {
    lowPowerMode.value = value
    // 开启低功耗模式时，如果当前在播放且显示频谱，则暂停频谱动画
    if (value && isPlaying.value && showSpectrum.value) {
      spectrumPaused.value = true
    } else if (!value) {
      // 关闭低功耗模式时恢复频谱
      spectrumPaused.value = false
    }
  }

  // ========== 迷你模式切换：rAF 插值窗口尺寸 (320ms easeOutCubic) ==========
  // 目标尺寸 (与后端 toggle_mini_mode.rs 中常量保持一致)
  const MINI_TARGET_W = 472
  const MINI_TARGET_H = 112
  const NORMAL_TARGET_W = 1200
  const NORMAL_TARGET_H = 800
  const MINI_ANIM_DURATION = 320 // ms
  const MINI_INVOKE_INTERVAL = 10 // ms - IPC 节流, 避免每帧调用

  let miniModeAnimId: number | null = null
  let miniModeAnimStartTime = 0
  let miniModeAnimLastInvoke = 0
  let miniModeStartSize: [number, number] = [0, 0]
  let miniModeTargetSize: [number, number] = [0, 0]

  /** easeOutCubic: t∈[0,1] -> 缓出曲线,起始快,末尾渐缓 */
  function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3)
  }

  function setMiniMode(value: boolean) {
    // 取消任何正在进行的动画, 重新开始
    if (miniModeAnimId !== null) {
      cancelAnimationFrame(miniModeAnimId)
      miniModeAnimId = null
    }

    // 1. 立即切换 Vue 状态,让 UI 过渡与尺寸缩放同步开始
    isMiniMode.value = value

    // 2. 立即调用后端处理"看不见的属性" (min/max size, decorations, always-on-top)
    invoke('toggle_mini_mode', { isMini: value })
      .catch((e) => console.warn('[miniMode] toggle_mini_mode 失败:', e))

    // 3. 低功耗模式下, 进入迷你模式时暂停频谱并断开 AnalyserNode
    if (lowPowerMode.value) {
      spectrumPaused.value = value
      if (value) {
        disconnectAnalyser()
      } else {
        reconnectAnalyser()
      }
    }

    // 4. 异步启动 rAF 动画插值窗口尺寸
    void animateMiniModeSize(value)
  }

  async function animateMiniModeSize(value: boolean) {
    // 读取当前窗口尺寸作为起点
    let startSize: [number, number] = [NORMAL_TARGET_W, NORMAL_TARGET_H]
    try {
      const cur = await invoke<[number, number]>('get_window_size')
      if (cur && cur.length === 2 && cur[0] > 0 && cur[1] > 0) {
        startSize = [cur[0], cur[1]]
      }
    } catch (e) {
      // 兜底: 使用理论目标值
      startSize = value
        ? [NORMAL_TARGET_W, NORMAL_TARGET_H]
        : [MINI_TARGET_W, MINI_TARGET_H]
    }

    const targetSize: [number, number] = value
      ? [MINI_TARGET_W, MINI_TARGET_H]
      : [NORMAL_TARGET_W, NORMAL_TARGET_H]

    // 用户在动画期间再次切换 -> 起点取当前已显示的尺寸
    // 这里我们信任 get_window_size 的返回值, 它反映系统当前实际尺寸

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

      // IPC 节流: 每 ~10ms 才调用一次 set_window_size
      // (rAF 是 60fps ≈ 16ms, 这样每 ~1.6 帧调用一次, 总共约 32 次)
      if (now - miniModeAnimLastInvoke >= MINI_INVOKE_INTERVAL || progress >= 1) {
        miniModeAnimLastInvoke = now
        invoke('set_window_size', { width: w, height: h }).catch(() => {})
      }

      if (progress < 1) {
        miniModeAnimId = requestAnimationFrame(step)
      } else {
        // 动画结束: 强制设为精确目标值, 清除累积误差
        miniModeAnimId = null
        invoke('set_window_size', {
          width: miniModeTargetSize[0],
          height: miniModeTargetSize[1]
        }).catch(() => {})
      }
    }

    miniModeAnimId = requestAnimationFrame(step)
  }

  function resumeSpectrum() {
    spectrumPaused.value = false
  }

  function pauseSpectrum() {
    spectrumPaused.value = true
  }

  // 断开频谱分析链路（低功耗模式下进一步节省 CPU）
  function disconnectAnalyser() {
    if (audioSourceNode && analyserNode && gainNode && audioContext) {
      try {
        audioSourceNode.disconnect()
        audioSourceNode.connect(gainNode)
      } catch (e) {
        // 忽略断开失败
      }
    }
  }

  // 重新连接频谱分析链路
  function reconnectAnalyser() {
    if (audioSourceNode && analyserNode && gainNode && audioContext) {
      try {
        audioSourceNode.disconnect()
        audioSourceNode.connect(analyserNode)
      } catch (e) {
        // 忽略重连失败
      }
    }
  }

  // 恢复 AudioContext 运行状态（页面重新可见/窗口显示时调用）
  function resumeAudioContext() {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {})
    }
  }

  // ========== 全局右键菜单状态（单例模式） ==========
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

  // ========== 搜索功能 ==========
  const searchQuery = ref('')

  const filteredCustomPlaylists = computed(() => {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query) return customPlaylists.value
    return customPlaylists.value.filter((pl) =>
      pl.name.toLowerCase().includes(query)
    )
  })

  // 搜索当前歌单中的歌曲
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
  // 阶段 1.4: markRaw 包装不可变静态配置, 避免 Vue 深度 Proxy 包装, 减少初始化与访问开销
  const fontFamilyMap: Record<FontFamily, string> = markRaw({
    system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    kaiti: '"KaiTi", "楷体", "STKaiti", serif',
    songti: '"SimSun", "宋体", "STSong", serif',
    fangsong: '"FangSong", "仿宋", "STFangsong", serif',
  })

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
    if (loopMode.value === 'shuffle') return playlist.value.length > 0
    return currentIndex.value < playlist.value.length - 1
  })
  const hasPrev = computed(() => {
    if (loopMode.value === 'single') return true
    if (loopMode.value === 'list') return true
    if (loopMode.value === 'shuffle') return playlist.value.length > 0
    return currentIndex.value > 0
  })

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
      
      // 记录当前播放的歌曲 ID，用于扫描后恢复播放位置
      const currentSongId = currentSong.value?.id
      
      // 完全替换播放列表
      playlist.value = songs
      folderPath.value = path
      
      // 成功扫描后保存路径到 localStorage
      setMusicLibraryPath(path)
      
      // 同步默认歌单
      syncDefaultPlaylist(songs)
      
      // 尝试恢复当前播放位置（通过歌曲 ID 匹配）
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
      // 扫描失败时清除无效缓存
      clearMusicLibraryPath()
      throw error
    } finally {
      isLoading.value = false
    }
  }

  // 设置元数据来源
  function setMetadataSource(source: 'auto' | 'filename') {
    metadataSource.value = source
    // 如果已有音乐库，重新扫描
    if (folderPath.value) {
      scanMusicFolder(folderPath.value, true)
    }
  }

  // 强制刷新元数据
  async function refreshMetadata() {
    if (folderPath.value) {
      await scanMusicFolder(folderPath.value, true)
    }
  }

  // ========== Web Audio API 主播放链路 ==========

  // 初始化 AudioContext 音频链路（必须在用户交互后调用）
  function initAudioContext() {
    if (!audioContext) {
      audioContext = new AudioContext()
      analyserNode = audioContext.createAnalyser()
      analyserNode.fftSize = 2048
      analyserNode.smoothingTimeConstant = 0.8
      gainNode = audioContext.createGain()

      // 链路：AnalyserNode -> GainNode -> Destination
      analyserNode.connect(gainNode)
      gainNode.connect(audioContext.destination)
    }
    return { audioContext, analyserNode, gainNode }
  }

  // 获取 AudioBuffer（fetch + decodeAudioData，LRU 保留前一首）
  // 阶段 3.3: 支持 LRU, 切回上一首 < 50ms
  async function getAudioBuffer(url: string, songId?: string): Promise<AudioBuffer | null> {
    // 命中 current
    if (currentAudioBuffer && currentBufferUrl === url) {
      return currentAudioBuffer
    }

    if (!audioContext) return null

    // ========== 阶段 3.3: 命中 prev（切回上一首） ==========
    // 双键校验: songId 匹配 + prevBufferUrl 匹配 (防止 songId 复用导致错位)
    if (songId && prevBuffer && prevSongId === songId && prevBufferUrl === url) {
      // current 降级为 prev（保持 LRU 大小恒定）
      if (currentAudioBuffer) {
        prevBuffer = currentAudioBuffer
        prevBufferUrl = currentBufferUrl
        prevSongId = currentSong.value?.id ?? null
      }
      // prev 提升为 current
      currentAudioBuffer = prevBuffer
      currentBufferUrl = url
      // 清空 prev 槽（避免重复命中）
      prevBuffer = null
      prevBufferUrl = null
      prevSongId = null
      return currentAudioBuffer
    }

    try {
      const response = await fetch(url)
      if (!response.ok) return null
      const arrayBuffer = await response.arrayBuffer()
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)

      // 旧的 current 降级为 prev
      if (currentAudioBuffer) {
        prevBuffer = currentAudioBuffer
        prevBufferUrl = currentBufferUrl
        prevSongId = currentSong.value?.id ?? null
      }
      currentAudioBuffer = audioBuffer
      currentBufferUrl = url

      return audioBuffer
    } catch (error) {
      console.error('[Audio] AudioBuffer 解码失败:', error)
      return null
    }
  }

  // 创建 AudioBufferSourceNode 并连接到 AnalyserNode
  function createAudioSourceNode(audioBuffer: AudioBuffer): AudioBufferSourceNode | null {
    if (!audioContext || !analyserNode) return null

    // 停止旧的 AudioBufferSourceNode（避免内存泄漏）
    if (audioSourceNode) {
      try {
        // 先清空 onended，防止手动 stop 触发播放结束回调
        audioSourceNode.onended = null
        audioSourceNode.stop()
        audioSourceNode.disconnect()
      } catch (e) {
        // 忽略已停止的节点错误
      }
    }

    // 创建新的 AudioBufferSourceNode
    audioSourceNode = audioContext.createBufferSource()
    audioSourceNode.buffer = audioBuffer

    // 连接到 AnalyserNode（链路：Source -> Analyser -> GainNode -> Destination）
    audioSourceNode.connect(analyserNode)

    // 添加 onended 事件处理
    audioSourceNode.onended = () => {
      // 如果不是主动暂停，说明是自然播放结束
      if (!isPaused) {
        audioSourceNode = null
        // 触发下一首（通过 onEnded 回调）
        _onAudioEnded?.()
      }
    }

    return audioSourceNode
  }

  // 播放歌曲（从指定偏移量开始）
  async function playFromOffset(offset: number = 0) {
    if (!audioContext || !currentAudioUrl) return

    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume()
      } catch {
        return
      }
    }

    const audioBuffer = currentAudioBuffer
    if (!audioBuffer) return

    if (audioSourceNode) {
      try {
        audioSourceNode.onended = null
        audioSourceNode.stop()
        audioSourceNode.disconnect()
        audioSourceNode = null
      } catch {
        // 忽略已停止的节点错误
      }
    }

    const newSource = audioContext.createBufferSource()
    newSource.buffer = audioBuffer
    newSource.connect(analyserNode!)

    newSource.onended = () => {
      if (!isPaused) {
        audioSourceNode = null
        endHistoryRecord()
        _onAudioEnded?.()
      }
    }

    audioSourceNode = newSource
    playbackStartTime = audioContext.currentTime - offset
    isPaused = false
    isPlaying.value = true

    if (currentSong.value) {
      startHistoryRecord(currentSong.value)
    }

    try {
      newSource.start(0, offset)
    } catch (error) {
      console.error('[Audio] AudioBufferSourceNode 启动失败:', error)
      audioSourceNode = null
    }
  }

  // 暂停播放
  function pausePlayback() {
    if (audioSourceNode && audioContext && !isPaused) {
      try {
        // 计算当前播放位置
        const currentTime = audioContext.currentTime - playbackStartTime
        pausedOffset = currentTime
        isPaused = true
        isPlaying.value = false

        // 结束记录播放历史
        endHistoryRecord()

        // 先清空 onended，防止手动 stop 触发播放结束回调
        audioSourceNode.onended = null
        audioSourceNode.stop()
        audioSourceNode.disconnect()
        audioSourceNode = null
      } catch (e) {
        // 忽略暂停失败
      }
    }
  }

  // 恢复播放（或从头开始播放）
  async function resumePlayback() {
    if (!currentAudioUrl || !audioContext) return

    if (audioSourceNode && !isPaused) return

    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume()
      } catch {
        return
      }
    }

    const offset = isPaused ? pausedOffset : 0
    await playFromOffset(offset)
  }

  // 停止播放（切歌时调用）
  function stopPlayback() {
    if (audioSourceNode) {
      try {
        // 先清空 onended，防止手动 stop 触发播放结束回调
        audioSourceNode.onended = null
        audioSourceNode.stop()
        audioSourceNode.disconnect()
        audioSourceNode = null
      } catch (e) {
        // 忽略已停止的节点错误
      }
    }
    // 结束记录播放历史
    endHistoryRecord()
    isPaused = false
    isPlaying.value = false
    pausedOffset = 0
    playbackStartTime = 0
  }

  // 获取当前播放时间（秒）
  function getCurrentPlaybackTime(): number {
    if (!audioContext || !audioSourceNode || isPaused) {
      return pausedOffset
    }
    return audioContext.currentTime - playbackStartTime
  }

  // 跳转到指定播放位置（秒）
  function seekTo(time: number) {
    if (!audioContext || !currentAudioUrl) return

    // 确保 time 在有效范围内
    const audioBuffer = currentAudioBuffer
    const dur = audioBuffer?.duration || 0
    const clampedTime = Math.max(0, Math.min(time, dur))

    // 如果正在播放或暂停，重新创建节点并从新位置开始
    if (audioSourceNode || isPaused) {
      pausedOffset = clampedTime

      if (!isPaused) {
        playFromOffset(clampedTime)
      }
    }
  }

  // 设置音量
  function setPlaybackVolume(value: number) {
    if (gainNode) {
      gainNode.gain.value = value
    }
  }

  // 获取 AnalyserNode（供频谱组件使用）
  function getAnalyserNode(): AnalyserNode | null {
    return analyserNode
  }

  // 设置当前播放歌曲的 URL
  function setCurrentAudioUrl(url: string | null) {
    currentAudioUrl = url
  }

  // 清除音频缓存（AudioBuffer）
  function clearAudioBufferCache() {
    currentAudioBuffer = null
    currentBufferUrl = null
    currentAudioUrl = null
  }

  // ========== 音频播放结束回调 ==========
  let _onAudioEnded: (() => void) | null = null

  function setOnAudioEnded(callback: () => void) {
    _onAudioEnded = callback
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

  // 随机播放历史记录（用于上一首功能）
  const shuffleHistory = ref<number[]>([])

  function getRandomIndex(): number {
    if (playlist.value.length <= 1) return 0
    let newIndex = Math.floor(Math.random() * playlist.value.length)
    // 避免连续播放同一首
    if (newIndex === currentIndex.value && playlist.value.length > 1) {
      newIndex = (newIndex + 1) % playlist.value.length
    }
    return newIndex
  }

  function next() {
    if (playlist.value.length === 0) return

    // 设置切歌锁和自动播放标记（只要触发切歌就默认需要自动播放）
    isSwitchingSong.value = true
    pendingPlay.value = true

    if (loopMode.value === 'single') {
      currentTime.value = 0
      const idx = currentIndex.value
      currentIndex.value = -1
      nextTick(() => {
        currentIndex.value = idx
      })
      return
    }

    if (loopMode.value === 'shuffle') {
      shuffleHistory.value.push(currentIndex.value)
      if (shuffleHistory.value.length > 100) {
        shuffleHistory.value.shift()
      }
      currentIndex.value = getRandomIndex()
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

    // 设置切歌锁和自动播放标记
    isSwitchingSong.value = true
    pendingPlay.value = true

    if (loopMode.value === 'single') {
      currentTime.value = 0
      const idx = currentIndex.value
      currentIndex.value = -1
      nextTick(() => {
        currentIndex.value = idx
      })
      return
    }

    if (loopMode.value === 'shuffle') {
      if (shuffleHistory.value.length > 0) {
        const prevIndex = shuffleHistory.value.pop()!
        currentIndex.value = prevIndex
      } else {
        currentIndex.value = getRandomIndex()
      }
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
      if (loopMode.value === 'shuffle' && currentIndex.value >= 0) {
        shuffleHistory.value.push(currentIndex.value)
      }
      isSwitchingSong.value = true
      pendingPlay.value = true
      currentIndex.value = index
    }
  }

  // ========== 循环模式 ==========
  function toggleLoopMode() {
    const modes: LoopMode[] = ['list', 'single', 'shuffle', 'none']
    const currentIdx = modes.indexOf(loopMode.value)
    loopMode.value = modes[(currentIdx + 1) % modes.length]
    // 切换到随机模式时清空历史
    if (loopMode.value === 'shuffle') {
      shuffleHistory.value = []
    }
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
  // 阶段 1.3: convertFileSrc URL 缓存
  // 原生 convertFileSrc 内部会创建 URL 对象并做路径处理, 频繁调用存在非零开销
  // 用 Map 缓存后, 同一路径只处理一次, 列表滚动时几乎零成本
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

  // 持久化歌单数据（防抖，避免频繁写入）
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
    // 阶段 2.8: flush='post' 避免在 reactive getter 中抢占主线程
    { deep: true, flush: 'post' }
  )

  // 持久化设置（防抖）
  let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    [volume, loopMode, folderPath, theme, background, minimizeToTray, fontSettings, metadataSource, showSpectrum, spectrumLowPower, lowPowerMode, downloadOutputDir],
    ([vol, mode, path, th, bg, mt, fs, metaSrc, spectrum, lowPower, lpm, dlDir]) => {
      if (settingsSaveTimer) {
        clearTimeout(settingsSaveTimer)
      }
      settingsSaveTimer = setTimeout(() => {
        saveSettings({
          volume: vol,
          loopMode: mode,
          folderPath: path,
          theme: th,
          background: bg,
          minimizeToTray: mt,
          fontSettings: fs,
          metadataSource: metaSrc,
          showSpectrum: spectrum,
          spectrumLowPower: lowPower,
          lowPowerMode: lpm,
          downloadOutputDir: dlDir
        })
      }, 300)
    },
    // 阶段 2.8: flush='post' 让 settings 持久化在 DOM 更新后执行
    { deep: true, flush: 'post' }
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
      const metaSrc = metadataSource.value === 'filename' ? 'filename' : 'auto'
      const songs = await invoke<Song[]>('scan_music_folder', {
        folderPath: savedPath,
        metadataSource: metaSrc,
        forceRefresh: false,
      })
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

  // ========== 全局播放控制逻辑（不依赖组件，确保迷你模式也能正常播放） ==========

  // 切歌加载锁：防止 async watch 被重复触发导致多首歌同时播放
  let isLoadingSong = false

  // 播放时间更新定时器
  let timeUpdateInterval: number | null = null

  function startTimeUpdate() {
    if (timeUpdateInterval) return
    timeUpdateInterval = window.setInterval(() => {
      if (isPlaying.value) {
        const t = getCurrentPlaybackTime()
        currentTime.value = t
      }
    }, 250)
  }

  function stopTimeUpdate() {
    if (timeUpdateInterval) {
      clearInterval(timeUpdateInterval)
      timeUpdateInterval = null
    }
  }

  // 初始化 audioPlayer 的 store 访问器
  audioPlayer.bindStoreAccessors({
    getPendingPlay: () => pendingPlay.value,
    setPendingPlay: (v: boolean) => { pendingPlay.value = v },
    setIsSwitchingSong: (v: boolean) => { isSwitchingSong.value = v },
    setIsPlaying: (v: boolean) => { isPlaying.value = v },
  })

  // audioPlayer 事件：获取时长（仅用于元数据显示）
  audioPlayer.onDurationChange((dur) => {
    duration.value = dur
  })

  // 确保 HTML5 Audio 始终静音（声音完全由 Web Audio 输出）
  audioPlayer.setVolume(0)

  // Web Audio 播放结束回调
  setOnAudioEnded(() => {
    stopTimeUpdate()
    next()
  })

  // 监听当前歌曲变化：加载音频并自动播放
  watch(
    () => currentSong.value,
    async (song) => {
      if (!song) return

      if (isLoadingSong) return
      isLoadingSong = true

      try {
        stopPlayback()
        stopTimeUpdate()
        currentTime.value = 0

        // 先确保 HTML5 Audio 静音（防止加载过程中发声）
        audioPlayer.setVolume(0)

        // 加载 HTML5 Audio（仅用于元数据和 MediaSession）
        await audioPlayer.load(song.file_path)
        audioPlayer.setVolume(0)
        audioPlayer.setMediaSession(
          song.title,
          song.artist,
          song.cover_path ? getCoverUrl(song.cover_path) : undefined
        )

        // ========== Web Audio 主播放链路 ==========
        initAudioContext()

        const audioUrl = getAudioUrl(song.file_path)
        const audioBuffer = await getAudioBuffer(audioUrl, song.id)

        if (audioBuffer) {
          setCurrentAudioUrl(audioUrl)

          if (isPlaying.value || pendingPlay.value) {
            pendingPlay.value = false
            isSwitchingSong.value = false
            await playFromOffset(0)
            startTimeUpdate()
          }
        }
      } catch (e) {
        console.error('[playerStore] 加载歌曲失败:', e)
        isSwitchingSong.value = false
        pendingPlay.value = false
      } finally {
        isLoadingSong = false
      }
    }
  )

  // 监听播放状态变化：实际控制 Web Audio 播放/暂停
  watch(
    () => isPlaying.value,
    async (playing) => {
      if (playing) {
        await resumePlayback()
        startTimeUpdate()
      } else {
        pausePlayback()
        stopTimeUpdate()
        audioPlayer.pause()
      }
    }
  )

  // 监听音量变化：应用到 Web Audio
  watch(
    () => volume.value,
    (vol) => {
      setPlaybackVolume(vol)
      // 保持 HTML5 Audio 静音
      audioPlayer.setVolume(0)
    }
  )

  // 更新页面标题
  function updateDocumentTitle() {
    const song = currentSong.value
    if (song) {
      document.title = `${song.title} - ${song.artist} · 高山流水`
    } else {
      document.title = '高山流水'
    }
  }
  updateDocumentTitle()
  watch(() => currentSong.value, updateDocumentTitle)

  // 媒体键处理
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('previoustrack', () => prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
  }

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
    isSwitchingSong,
    pendingPlay,
    currentTime,
    duration,
    volume,
    loopMode,
    isLoading,
    folderPath,
    metadataSource,
    theme,
    // 背景设置
    background,
    currentBackgroundUrl,
    // 托盘设置
    minimizeToTray,
    // 定时关闭
    sleepTimerEnabled,
    sleepTimerMinutes,
    sleepTimerRemaining,
    startSleepTimer,
    stopSleepTimer,
    toggleSleepTimer,
    setSleepTimerMinutes,
    // 全局右键菜单
    contextMenu,
    openContextMenu,
    closeContextMenu,
    // 创建歌单弹窗
    showCreatePlaylistModal,
    createPlaylistAddSongId,
    openCreatePlaylistModal,
    closeCreatePlaylistModal,
    // 搜索
    searchQuery,
    filteredCustomPlaylists,
    filteredActivePlaylistSongs,
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
    setMetadataSource,
    refreshMetadata,
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
    // 频谱设置
    showSpectrum,
    spectrumLowPower,
    setShowSpectrum,
    setSpectrumLowPower,
    // 性能/低功耗模式
    lowPowerMode,
    isMiniMode,
    spectrumPaused,
    setLowPowerMode,
    setMiniMode,
    // 下载页
    downloadOutputDir,
    setDownloadOutputDir,
    resumeSpectrum,
    pauseSpectrum,
    disconnectAnalyser,
    reconnectAnalyser,
    resumeAudioContext,
    // Web Audio API 主播放链路
    initAudioContext,
    getAudioBuffer,
    createAudioSourceNode,
    playFromOffset,
    pausePlayback,
    resumePlayback,
    stopPlayback,
    getCurrentPlaybackTime,
    seekTo,
    setPlaybackVolume,
    getAnalyserNode,
    setCurrentAudioUrl,
    setOnAudioEnded,
    clearAudioBufferCache,
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
    toggleSongInPlaylist,
    removeSongFromPlaylist,
    isSongInPlaylist,
    // 播放历史记录
    playHistory,
    showHistoryDrawer,
    toggleHistoryDrawer,
    clearPlayHistory,
    removeHistoryItem,
    // 数据统计
    showStatsPanel,
    toggleStatsPanel,
    todayStats,
    monthStats,
    yearStats,
    allTimeStats,
    mostLoopedSong,
    longestPlayedSong,
    generateStatsMarkdown,
    exportStatsReport,
    // 下载面板
    showDownloadPanel,
    toggleDownloadPanel,
    // 侧边栏
    showSidebar,
    toggleSidebar,
  }
})