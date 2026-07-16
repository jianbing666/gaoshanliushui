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

export const useHistoryStore = defineStore('history', () => {
  // ========== 历史记录数据 ==========
  const playHistory = ref<PlayHistoryItem[]>([])
  const fullPlayHistory = ref<PlayHistoryItem[]>([])

  // ========== 预聚合索引 (启动时构建一次, 后续增量更新) ==========
  // 设计目标: 6 个统计 computed 从 O(n) 全量扫描 -> O(1) 读桶 / O(唯一歌曲数) 找最值
  // 数据规模: max 10000 条
  // 写入约束: shallowRef 整体替换, 避免深 Proxy 重建

  // 按日分桶: { 'YYYY-MM-DD': PlayHistoryItem[] }
  const playHistoryByDay = shallowRef<Record<string, PlayHistoryItem[]>>({})
  // 按歌曲计数: { songId: count }
  const songPlayCount = shallowRef<Record<string, number>>({})
  // 按歌曲累计时长: { songId: totalPlayedSeconds }
  const songPlayDuration = shallowRef<Record<string, number>>({})

  // 模块级累计变量 (computed 不直接读, 避免每次重建数组)
  let totalPlayedDuration = 0
  let totalCompletedCount = 0
  let totalUniqueSongs = 0

  // ========== 从 SQLite 加载 ==========
  async function loadFromDb() {
    if (dbLoaded) return
    try {
      const records = await invoke<any[]>('get_play_history', { limit: MAX_FULL_HISTORY_ITEMS })
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

        fullPlayHistory.value = items
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

        // 重建索引
        buildStatsIndex()
        dbLoaded = true
        return
      }

      // 数据库为空, 尝试从 localStorage 迁移
      const localFull = loadFullPlayHistory()
      if (localFull.length > 0) {
        await migrateFromLocalStorage(localFull)
      } else {
        // 完全没有数据, 直接用空的
        fullPlayHistory.value = []
        playHistory.value = []
        buildStatsIndex()
      }
      dbLoaded = true
    } catch (e) {
      console.warn('[History] 从 SQLite 加载失败, 回退到 localStorage:', e)
      // 回退到 localStorage
      playHistory.value = loadPlayHistory()
      fullPlayHistory.value = loadFullPlayHistory()
      buildStatsIndex()
      dbLoaded = true
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

      // 加载到内存
      fullPlayHistory.value = localItems
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
      buildStatsIndex()
    } catch (e) {
      console.warn('[History] 迁移 localStorage 数据失败:', e)
      fullPlayHistory.value = localItems
      playHistory.value = loadPlayHistory()
      buildStatsIndex()
    }
  }

  // ========== 索引构建 ==========
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

    // 排序每个桶 (按 playedAt 降序)
    for (const k of Object.keys(byDay)) {
      byDay[k].sort((a, b) => b.playedAt - a.playedAt)
    }

    playHistoryByDay.value = byDay
    songPlayCount.value = count
    songPlayDuration.value = duration
    totalUniqueSongs = uniqueIds.size
  }

  function rebuildStatsIndex() {
    totalPlayedDuration = 0
    totalCompletedCount = 0
    totalUniqueSongs = 0
    buildStatsIndex()
  }

  // 启动时同步构建一次
  buildStatsIndex()

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

    // 1. 添加到完整播放记录 (不去重, 用于统计)
    fullPlayHistory.value.unshift({ ...currentHistoryItem })
    if (fullPlayHistory.value.length > MAX_FULL_HISTORY_ITEMS) {
      fullPlayHistory.value = fullPlayHistory.value.slice(0, MAX_FULL_HISTORY_ITEMS)
    }
    saveFullPlayHistory(fullPlayHistory.value)

    // 2. 更新展示用历史记录 (去重, 同一首歌只保留最新一次)
    playHistory.value = playHistory.value.filter((item) => item.songId !== currentHistoryItem!.songId)
    playHistory.value.unshift({ ...currentHistoryItem })
    if (playHistory.value.length > MAX_HISTORY_ITEMS) {
      playHistory.value = playHistory.value.slice(0, MAX_HISTORY_ITEMS)
    }
    savePlayHistory(playHistory.value)

    // 3. 异步写入 SQLite
    if (dbLoaded) {
      const item = currentHistoryItem
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
    const item = currentHistoryItem
    const d = new Date(item.playedAt)
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    const dayBucket = playHistoryByDay.value[dayKey] ? [...playHistoryByDay.value[dayKey]] : []
    dayBucket.unshift({ ...item })
    playHistoryByDay.value = { ...playHistoryByDay.value, [dayKey]: dayBucket }

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
    if (idx !== -1) {
      playHistory.value.splice(idx, 1)
      savePlayHistory(playHistory.value)
    }

    // 从完整记录中删除 (同时更新预聚合索引)
    const fullIdx = fullPlayHistory.value.findIndex((item) => item.id === id)
    if (fullIdx !== -1) {
      const removed = fullPlayHistory.value[fullIdx]
      fullPlayHistory.value.splice(fullIdx, 1)
      saveFullPlayHistory(fullPlayHistory.value)

      // 增量回滚预聚合
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

    // 同步删除 SQLite
    if (dbLoaded) {
      invoke('delete_play_history', { id }).catch((e) => console.warn('[History] 从 SQLite 删除失败:', e))
    }
  }

  // ========== 统计查询工具 ==========

  /**
   * 获取某一时间段内的播放记录 (基于按日分桶索引, O(桶数) 而非 O(全量))
   */
  function getHistoryInRange(startTime: number, endTime: number): PlayHistoryItem[] {
    const result: PlayHistoryItem[] = []
    const start = new Date(startTime)
    const end = new Date(endTime)
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

  /**
   * 汇总桶内数据
   */
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

  // ========== 6 个统计计算属性 ==========

  // 今天的统计 (O(1) 直接读桶)
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
    const item = fullPlayHistory.value.find((i) => i.songId === maxId)
    return item ? { song: item, count: maxCount } : null
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
    const item = fullPlayHistory.value.find((i) => i.songId === maxId)
    return item ? { song: item, duration: maxDuration } : null
  })

  // 全部时间统计 (直接读模块级累计变量)
  const allTimeStats = computed(() => ({
    count: fullPlayHistory.value.length,
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
        // BUG 7 修复: 改用 Rust 命令写文件
        //   - tauri-plugin-fs 未在 capabilities 中授权, writeTextFile 会静默失败
        //   - 通过 invoke('write_text_file') 绕过 fs plugin 权限限制
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
    // 报告
    generateStatsMarkdown,
    exportStatsReport,
  }
})
