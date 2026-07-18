import { defineStore } from 'pinia'
import { ref, computed, shallowRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { Song, PlayHistoryItem } from '@/types/song'
import {
  loadPlayHistory,
  loadFullPlayHistory,
  savePlayHistory,
  saveFullPlayHistory,
  generateId,
  MAX_HISTORY_ITEMS,
  MAX_FULL_HISTORY_ITEMS,
} from '@/utils/storage'
import type { AudioEngine } from '@/audio/AudioEngine'

/**
 * 播放历史与统计域 store
 *
 * 包含:
 *   - 展示用历史记录 (playHistory, 去重, 最多 500)
 *   - 完整播放记录 (fullPlayHistory, 不去重, 最多 10000)
 *   - 4 个预聚合索引 (按日分桶 / 按歌曲计数 / 按歌曲累计时长 / 模块级累计变量)
 *   - 6 个统计计算属性 (todayStats / monthStats / yearStats / allTimeStats / mostLoopedSong / longestPlayedSong)
 *   - 历史记录操作 (startHistoryRecord / endHistoryRecord / clearPlayHistory / removeHistoryItem)
 *   - 统计报告 (generateStatsMarkdown / exportStatsReport)
 *
 * 数据存储:
 *   - v1.1+: 优先使用 SQLite (play_history 表)
 *   - 启动时从 SQLite 加载, 若为空则从 localStorage 迁移
 *   - 写入操作同时写入 SQLite 和 localStorage (双写过渡)
 *
 * 不包含: UI 面板显隐 (在 uiStore), 播放控制 (在 audioStore), 设置 (在 settingsStore)
 *
 * 跨域调用:
 *   - audioStore 在 currentSong 变化时调用 startHistoryRecord(song, audioEngine) 注入 engine
 *   - audioStore 在播完时调用 endHistoryRecord() 累加时长
 *   - 不反向依赖 audioStore,避免循环依赖
 */

// 当前正在记录的历史项 (模块级, 跨函数保持)
let currentHistoryItem: PlayHistoryItem | null = null
// 播放开始的 audioContext 时间 (用于计算 playedDuration, 比 wall-clock 更精确)
let currentPlayStartAudioTime = 0
// 是否已从 SQLite 加载完成
let dbLoaded = false

interface SongBasicInfo {
  title: string
  artist: string
  album: string
  cover_path: string | null
  duration: number
}

interface DailyStat {
  count: number
  totalDuration: number
  completedCount: number
}

export const useHistoryStore = defineStore('history', () => {
  // ========== 历史记录数据 ==========
  // 展示用历史记录 (去重, 最多 500 条, 用于历史抽屉)
  const playHistory = ref<PlayHistoryItem[]>([])

  // ========== 预聚合索引 (启动时构建一次, 后续增量更新) ==========
  // 设计目标: 内存占用最小化, 仅保留聚合数据, 完整记录按需从 SQLite 加载

  // 按日统计聚合: { 'YYYY-MM-DD': { count, totalDuration, completedCount } }
  const dailyStats = shallowRef<Record<string, DailyStat>>({})
  // 按歌曲计数: { songId: count }
  const songPlayCount = shallowRef<Record<string, number>>({})
  // 按歌曲累计时长: { songId: totalPlayedSeconds }
  const songPlayDuration = shallowRef<Record<string, number>>({})
  // 歌曲基本信息 (每首歌只存一份, 用于统计展示): { songId: SongBasicInfo }
  const songInfoMap = shallowRef<Record<string, SongBasicInfo>>({})
  // 完整历史记录是否已加载到内存 (懒加载标记)
  const fullHistoryLoaded = ref(false)
  // 完整历史记录 (按需加载, 默认空数组)
  const fullPlayHistory = ref<PlayHistoryItem[]>([])

  // 模块级累计变量 (computed 不直接读, 避免每次重建数组)
  let totalPlayedDuration = 0
  let totalCompletedCount = 0
  let totalUniqueSongs = 0
  let totalPlayCount = 0

  // ========== 从 SQLite 加载 ==========
  async function loadFromDb() {
    if (dbLoaded) return
    try {
      // 只加载最近的记录用于构建展示历史和聚合索引 (最多 2000 条, 足够构建统计索引)
      const records = await invoke<any[]>('get_play_history', { limit: 2000 })
      if (records && records.length > 0) {
        // 转换为前端 PlayHistoryItem 格式
        const items: PlayHistoryItem[] = records.map((r) => ({
          id: r.id,
          songId: r.song_hash,
          title: r.title,
          artist: r.artist,
          album: r.album,
          duration: r.duration,
          cover_path: r.cover_path ? r.cover_path : null,
          file_path: r.song_path,
          playedAt: r.played_at,
          playedDuration: r.played_duration,
          completed: r.completed,
        }))

        // 构建去重的展示历史 (每首歌只保留最新一条)
        const seen = new Set<string>()
        const displayItems: PlayHistoryItem[] = []
        for (const item of items) {
          if (!seen.has(item.songId)) {
            seen.add(item.songId)
            displayItems.push(item)
            if (displayItems.length >= MAX_HISTORY_ITEMS) break
          }
        }
        playHistory.value = displayItems

        // 从 SQLite 获取统计聚合数据 (更准确)
        try {
          const stats = await invoke<any>('get_play_history_stats')
          if (stats) {
            totalPlayCount = stats.total_count || 0
            totalPlayedDuration = stats.total_duration || 0
            totalCompletedCount = stats.total_completed || 0
            totalUniqueSongs = stats.unique_songs || 0
            // 按日统计
            if (stats.by_day) {
              const byDay: Record<string, DailyStat> = {}
              for (const d of stats.by_day) {
                byDay[d.day] = {
                  count: d.count,
                  totalDuration: d.total_duration,
                  completedCount: d.completed_count,
                }
              }
              dailyStats.value = byDay
            }
            // 按歌曲计数和时长 (top 100 + playHistory 中的歌曲)
            if (stats.by_song) {
              const countMap: Record<string, number> = {}
              const durMap: Record<string, number> = {}
              const infoMap: Record<string, SongBasicInfo> = {}
              for (const s of stats.by_song) {
                countMap[s.song_hash] = s.count
                durMap[s.song_hash] = s.total_duration
                infoMap[s.song_hash] = {
                  title: s.title,
                  artist: s.artist,
                  album: s.album,
                  cover_path: s.cover_path || null,
                  duration: s.duration,
                }
              }
              songPlayCount.value = countMap
              songPlayDuration.value = durMap
              songInfoMap.value = infoMap
            }
            dbLoaded = true
            fullHistoryLoaded.value = false
            return
          }
        } catch (_) {
          // SQLite 统计接口不可用, 回退到从记录构建
        }

        // 回退: 从部分记录构建索引 (可能不完整, 但启动快)
        buildStatsIndexFromItems(items)
        dbLoaded = true
        fullHistoryLoaded.value = false
        return
      }

      // 数据库为空, 尝试从 localStorage 迁移
      const localFull = loadFullPlayHistory()
      if (localFull.length > 0) {
        await migrateFromLocalStorage(localFull)
      } else {
        // 完全没有数据, 直接用空的
        playHistory.value = []
        buildStatsIndexFromItems([])
      }
      dbLoaded = true
    } catch (e) {
      console.warn('[History] 从 SQLite 加载失败, 回退到 localStorage:', e)
      // 回退到 localStorage
      playHistory.value = loadPlayHistory()
      const localFull = loadFullPlayHistory()
      buildStatsIndexFromItems(localFull)
      fullPlayHistory.value = localFull
      fullHistoryLoaded.value = true
      dbLoaded = true
    }
  }

  // 确保完整历史记录已加载 (需要时才调用)
  async function ensureFullHistoryLoaded(): Promise<void> {
    if (fullHistoryLoaded.value) return
    try {
      const records = await invoke<any[]>('get_play_history', { limit: MAX_FULL_HISTORY_ITEMS })
      if (records && records.length > 0) {
        fullPlayHistory.value = records.map((r) => ({
          id: r.id,
          songId: r.song_hash,
          title: r.title,
          artist: r.artist,
          album: r.album,
          duration: r.duration,
          cover_path: r.cover_path ? r.cover_path : null,
          file_path: r.song_path,
          playedAt: r.played_at,
          playedDuration: r.played_duration,
          completed: r.completed,
        }))
      } else {
        fullPlayHistory.value = []
      }
      fullHistoryLoaded.value = true
    } catch (e) {
      console.warn('[History] 加载完整历史失败:', e)
      fullPlayHistory.value = []
      fullHistoryLoaded.value = true
    }
  }

  // 从 localStorage 迁移到 SQLite
  async function migrateFromLocalStorage(localItems: PlayHistoryItem[]) {
    try {
      const records = localItems.map((item) => ({
        id: item.id,
        song_hash: item.songId,
        song_path: item.file_path,
        title: item.title,
        artist: item.artist,
        album: item.album,
        duration: item.duration,
        cover_path: item.cover_path || '',
        played_at: item.playedAt,
        played_duration: item.playedDuration,
        completed: item.completed,
      }))
      await invoke('batch_add_play_history', { records })

      // 构建展示历史和聚合索引
      const seen = new Set<string>()
      const displayItems: PlayHistoryItem[] = []
      for (const item of localItems) {
        if (!seen.has(item.songId)) {
          seen.add(item.songId)
          displayItems.push(item)
          if (displayItems.length >= MAX_HISTORY_ITEMS) break
        }
      }
      playHistory.value = displayItems
      buildStatsIndexFromItems(localItems)
      fullPlayHistory.value = localItems
      fullHistoryLoaded.value = true
    } catch (e) {
      console.warn('[History] 迁移 localStorage 数据失败:', e)
      fullPlayHistory.value = localItems
      playHistory.value = loadPlayHistory()
      buildStatsIndexFromItems(localItems)
      fullHistoryLoaded.value = true
    }
  }

  // ========== 索引构建 ==========
  function buildStatsIndexFromItems(items: PlayHistoryItem[]) {
    const byDay: Record<string, DailyStat> = {}
    const count: Record<string, number> = {}
    const duration: Record<string, number> = {}
    const infoMap: Record<string, SongBasicInfo> = {}
    const uniqueIds = new Set<string>()
    let localTotalDuration = 0
    let localTotalCompleted = 0

    for (const item of items) {
      // 按日统计聚合
      const d = new Date(item.playedAt)
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!byDay[dayKey]) {
        byDay[dayKey] = { count: 0, totalDuration: 0, completedCount: 0 }
      }
      byDay[dayKey].count++
      byDay[dayKey].totalDuration += item.playedDuration
      if (item.completed) byDay[dayKey].completedCount++

      // 按歌曲计数
      count[item.songId] = (count[item.songId] || 0) + 1
      // 按歌曲累计时长
      duration[item.songId] = (duration[item.songId] || 0) + item.playedDuration
      // 歌曲基本信息 (只存一份)
      if (!infoMap[item.songId]) {
        infoMap[item.songId] = {
          title: item.title,
          artist: item.artist,
          album: item.album,
          cover_path: item.cover_path,
          duration: item.duration,
        }
      }

      // 累计变量
      localTotalDuration += item.playedDuration
      if (item.completed) localTotalCompleted++
      uniqueIds.add(item.songId)
    }

    dailyStats.value = byDay
    songPlayCount.value = count
    songPlayDuration.value = duration
    songInfoMap.value = infoMap
    totalPlayedDuration = localTotalDuration
    totalCompletedCount = localTotalCompleted
    totalUniqueSongs = uniqueIds.size
    totalPlayCount = items.length
  }

  function rebuildStatsIndex() {
    totalPlayedDuration = 0
    totalCompletedCount = 0
    totalUniqueSongs = 0
    totalPlayCount = 0
    dailyStats.value = {}
    songPlayCount.value = {}
    songPlayDuration.value = {}
    songInfoMap.value = {}
  }

  // ========== 历史记录操作 ==========

  /**
   * 开始记录播放历史
   * @param song 当前播放的歌曲
   * @param audioEngine 音频引擎实例,用于读取 audioContext.currentTime 计算播放时长
   */
  function startHistoryRecord(song: Song, audioEngine: AudioEngine) {
    // 先结束上一首歌的记录
    endHistoryRecord(audioEngine)

    const context = audioEngine.getAudioContext()

    currentHistoryItem = {
      id: generateId('history'),
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
    // 记录 audioContext 起始时间 (精确到 AudioContext 时钟)
    currentPlayStartAudioTime = context ? context.currentTime : Date.now() / 1000
  }

  /**
   * 结束记录播放历史 (累加 playedDuration, 写入列表, 更新索引)
   * 在切歌 / 暂停 / 睡眠定时器触发等时机调用
   */
  function endHistoryRecord(audioEngine?: AudioEngine) {
    if (!currentHistoryItem) return

    // 优先使用 audioContext 时间差 (更准确, 不会受系统挂起影响)
    let playedDuration: number
    if (audioEngine) {
      const context = audioEngine.getAudioContext()
      if (context) {
        playedDuration = context.currentTime - currentPlayStartAudioTime
      } else {
        playedDuration = (Date.now() - currentHistoryItem.playedAt) / 1000
      }
    } else {
      playedDuration = (Date.now() - currentHistoryItem.playedAt) / 1000
    }

    currentHistoryItem.playedDuration = playedDuration
    currentHistoryItem.completed = playedDuration >= currentHistoryItem.duration * 0.8

    const item = currentHistoryItem

    // 1. 更新展示用历史记录 (去重, 同一首歌只保留最新一次)
    playHistory.value = playHistory.value.filter((i) => i.songId !== item.songId)
    playHistory.value.unshift({ ...item })
    if (playHistory.value.length > MAX_HISTORY_ITEMS) {
      playHistory.value = playHistory.value.slice(0, MAX_HISTORY_ITEMS)
    }
    savePlayHistory(playHistory.value)

    // 2. 如果完整历史已加载到内存, 同步更新 (懒加载模式下默认不加载)
    if (fullHistoryLoaded.value) {
      fullPlayHistory.value.unshift({ ...item })
      if (fullPlayHistory.value.length > MAX_FULL_HISTORY_ITEMS) {
        fullPlayHistory.value = fullPlayHistory.value.slice(0, MAX_FULL_HISTORY_ITEMS)
      }
      saveFullPlayHistory(fullPlayHistory.value)
    }

    // 3. 异步写入 SQLite
    if (dbLoaded) {
      invoke('add_play_history', {
        record: {
          id: item.id,
          song_hash: item.songId,
          song_path: item.file_path,
          title: item.title,
          artist: item.artist,
          album: item.album,
          duration: item.duration,
          cover_path: item.cover_path || '',
          played_at: item.playedAt,
          played_duration: item.playedDuration,
          completed: item.completed,
        },
      }).catch((e) => console.warn('[History] 写入 SQLite 失败:', e))
    }

    // 4. 增量更新预聚合索引
    const d = new Date(item.playedAt)
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    // 更新 dailyStats
    const oldDayStat = dailyStats.value[dayKey]
    const newDayStat = oldDayStat
      ? {
          count: oldDayStat.count + 1,
          totalDuration: oldDayStat.totalDuration + item.playedDuration,
          completedCount: oldDayStat.completedCount + (item.completed ? 1 : 0),
        }
      : {
          count: 1,
          totalDuration: item.playedDuration,
          completedCount: item.completed ? 1 : 0,
        }
    dailyStats.value = { ...dailyStats.value, [dayKey]: newDayStat }

    // 更新按歌曲统计
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

    // 更新歌曲基本信息 (首次出现时添加)
    if (oldCount === 0) {
      songInfoMap.value = {
        ...songInfoMap.value,
        [item.songId]: {
          title: item.title,
          artist: item.artist,
          album: item.album,
          cover_path: item.cover_path,
          duration: item.duration,
        },
      }
    }

    // 更新累计变量
    totalPlayCount++
    totalPlayedDuration += item.playedDuration
    if (item.completed) totalCompletedCount++
    if (oldCount === 0) totalUniqueSongs++

    currentHistoryItem = null
  }

  /**
   * 清空历史记录
   */
  function clearPlayHistory() {
    playHistory.value = []
    fullPlayHistory.value = []
    fullHistoryLoaded.value = false
    savePlayHistory(playHistory.value)
    saveFullPlayHistory(fullPlayHistory.value)
    rebuildStatsIndex()

    // 同步清空 SQLite
    if (dbLoaded) {
      invoke('clear_play_history').catch((e) => console.warn('[History] 清空 SQLite 失败:', e))
    }
  }

  /**
   * 删除单条历史记录
   */
  function removeHistoryItem(id: string) {
    // 从展示记录中删除
    const idx = playHistory.value.findIndex((item) => item.id === id)
    let removed: PlayHistoryItem | null = null
    if (idx !== -1) {
      removed = playHistory.value[idx]
      playHistory.value.splice(idx, 1)
      savePlayHistory(playHistory.value)
    }

    // 如果完整历史已加载, 也从中删除
    if (fullHistoryLoaded.value) {
      const fullIdx = fullPlayHistory.value.findIndex((item) => item.id === id)
      if (fullIdx !== -1) {
        removed = fullPlayHistory.value[fullIdx]
        fullPlayHistory.value.splice(fullIdx, 1)
        saveFullPlayHistory(fullPlayHistory.value)
      }
    }

    // 如果找到了被删除的项, 增量回滚预聚合
    if (removed) {
      const d = new Date(removed.playedAt)
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const dayStat = dailyStats.value[dayKey]
      if (dayStat) {
        const newCount = Math.max(0, dayStat.count - 1)
        const newDuration = Math.max(0, dayStat.totalDuration - removed.playedDuration)
        const newCompleted = Math.max(0, dayStat.completedCount - (removed.completed ? 1 : 0))
        if (newCount === 0) {
          const newStats = { ...dailyStats.value }
          delete newStats[dayKey]
          dailyStats.value = newStats
        } else {
          dailyStats.value = {
            ...dailyStats.value,
            [dayKey]: { count: newCount, totalDuration: newDuration, completedCount: newCompleted },
          }
        }
      }
      const oldCount = songPlayCount.value[removed.songId] || 0
      const newCount = Math.max(0, oldCount - 1)
      if (newCount === 0) {
        const newCountMap = { ...songPlayCount.value }
        delete newCountMap[removed.songId]
        songPlayCount.value = newCountMap
        const newDurMap = { ...songPlayDuration.value }
        delete newDurMap[removed.songId]
        songPlayDuration.value = newDurMap
        const newInfoMap = { ...songInfoMap.value }
        delete newInfoMap[removed.songId]
        songInfoMap.value = newInfoMap
      } else {
        songPlayCount.value = { ...songPlayCount.value, [removed.songId]: newCount }
        songPlayDuration.value = {
          ...songPlayDuration.value,
          [removed.songId]: Math.max(0, (songPlayDuration.value[removed.songId] || 0) - removed.playedDuration),
        }
      }
      totalPlayCount = Math.max(0, totalPlayCount - 1)
      totalPlayedDuration = Math.max(0, totalPlayedDuration - removed.playedDuration)
      if (removed.completed) totalCompletedCount = Math.max(0, totalCompletedCount - 1)
      if (newCount === 0) totalUniqueSongs = Math.max(0, totalUniqueSongs - 1)
    }

    // 同步删除 SQLite
    if (dbLoaded) {
      invoke('delete_play_history', { id }).catch((e) => console.warn('[History] 从 SQLite 删除失败:', e))
    }
  }

  // ========== 统计查询工具 ==========

  /**
   * 获取某一时间段内的统计汇总 (基于 dailyStats, O(天数) 而非 O(全量))
   */
  function getStatsInRange(startTime: number, endTime: number): { count: number; totalDuration: number; completedCount: number } {
    let count = 0
    let totalDuration = 0
    let completedCount = 0
    const start = new Date(startTime)
    const end = new Date(endTime)
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d.getTime() < end.getTime(); d.setDate(d.getDate() + 1)) {
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const stat = dailyStats.value[dayKey]
      if (stat) {
        count += stat.count
        totalDuration += stat.totalDuration
        completedCount += stat.completedCount
      }
    }
    return { count, totalDuration, completedCount }
  }

  // ========== 6 个统计计算属性 ==========

  // 今天的统计 (O(1) 直接读 dailyStats)
  const todayStats = computed(() => {
    const now = new Date()
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    return dailyStats.value[dayKey] || { count: 0, totalDuration: 0, completedCount: 0 }
  })

  // 本月统计
  const monthStats = computed(() => {
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()
    return getStatsInRange(startOfMonth, endOfMonth)
  })

  // 本年统计
  const yearStats = computed(() => {
    const now = new Date()
    const startOfYear = new Date(now.getFullYear(), 0, 1).getTime()
    const endOfYear = new Date(now.getFullYear() + 1, 0, 1).getTime()
    return getStatsInRange(startOfYear, endOfYear)
  })

  // 听歌之最: 单曲循环次数最多的歌 (O(唯一歌曲数))
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
    const info = songInfoMap.value[maxId]
    if (!info) return null
    return { song: info as PlayHistoryItem, count: maxCount }
  })

  // 听歌之最: 总播放时长最久的歌
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
    const info = songInfoMap.value[maxId]
    if (!info) return null
    return { song: info as PlayHistoryItem, duration: maxDuration }
  })

  // 全部时间统计 (直接读模块级累计变量)
  const allTimeStats = computed(() => ({
    count: totalPlayCount,
    totalDuration: totalPlayedDuration,
    completedCount: totalCompletedCount,
    uniqueSongs: totalUniqueSongs,
  }))

  // ========== 统计报告 (Markdown) ==========

  /**
   * 生成 Markdown 格式的统计报告
   */
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
    md += `> 生成时间:${dateStr}\n\n`

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
      md += `- **歌曲**:${mostLoopedSong.value.song.title}\n`
      md += `- **歌手**:${mostLoopedSong.value.song.artist || '未知艺术家'}\n`
      md += `- **播放次数**:${mostLoopedSong.value.count} 次\n\n`
    }

    if (longestPlayedSong.value) {
      md += `### 累计播放时长最久的歌曲\n\n`
      md += `- **歌曲**:${longestPlayedSong.value.song.title}\n`
      md += `- **歌手**:${longestPlayedSong.value.song.artist || '未知艺术家'}\n`
      md += `- **累计时长**:${formatDuration(longestPlayedSong.value.duration)}\n\n`
    }

    md += `## 📈 其他统计\n\n`
    md += `- **累计收听歌曲数**:${allTimeStats.value.uniqueSongs} 首\n`
    md += `- **完整播放率**:${allTimeStats.value.count > 0 ? ((allTimeStats.value.completedCount / allTimeStats.value.count) * 100).toFixed(1) : 0}%\n`

    return md
  }

  /**
   * 导出统计报告 (Markdown 格式)
   */
  async function exportStatsReport(): Promise<boolean> {
    try {
      // 导出前确保完整历史已加载 (用于完整统计)
      await ensureFullHistoryLoaded()
      const markdown = generateStatsMarkdown()
      const now = new Date()
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const filename = `听歌统计报告_${dateStr}.md`

      const { save } = await import('@tauri-apps/plugin-dialog')

      const filePath = await save({
        defaultPath: filename,
        filters: [{ name: 'Markdown 文件', extensions: ['md'] }],
      })

      if (filePath) {
        await invoke('write_text_file', {
          path: filePath,
          content: markdown,
        })
        return true
      }
      return false
    } catch (e) {
      console.error('[Stats] 导出统计报告失败:', e)
      return false
    }
  }

  // 释放完整历史记录 (节省内存)
  function releaseFullHistory() {
    if (fullHistoryLoaded.value) {
      fullPlayHistory.value = []
      fullHistoryLoaded.value = false
    }
  }

  return {
    // 状态
    playHistory,
    fullPlayHistory,
    // 统计
    todayStats,
    monthStats,
    yearStats,
    allTimeStats,
    mostLoopedSong,
    longestPlayedSong,
    // 操作
    startHistoryRecord,
    endHistoryRecord,
    clearPlayHistory,
    removeHistoryItem,
    loadFromDb,
    ensureFullHistoryLoaded,
    releaseFullHistory,
    // 报告
    generateStatsMarkdown,
    exportStatsReport,
  }
})
