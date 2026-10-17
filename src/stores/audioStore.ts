import { defineStore } from 'pinia'
import { ref, computed, nextTick, watch, onScopeDispose } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { LoopMode } from '@/types/song'
import type { Song } from '@/types/song'
import { audioEngine } from '@/audio/AudioEngine'

import { loadSettings, saveSettings } from '@/utils/storage'
import { computeSmartWeights, pickWeightedIndex } from '@/utils/smartShuffle'
import type { SongPlaySignals } from '@/utils/smartShuffle'
import { pickUpcomingSong, resolveShuffleNext } from '@/utils/playQueue'
import { useLibraryStore } from './libraryStore'
import type { useHistoryStore } from './historyStore'
import { useSettingsStore } from './settingsStore'
import { mediaControls, PlaybackStatus } from 'tauri-plugin-media-api'

/**
 * 播放控制域 store
 *
 * 包含:
 *   - 播放状态 (isPlaying / currentTime / duration / volume / loopMode)
 *   - 切歌锁 (isSwitchingSong / pendingPlay)
 *   - 随机播放历史 (shuffleHistory)
 *   - 静音切换 (lastVolume / toggleMute)
 *   - 播放控制 (play / pause / togglePlay / next / prev / playByIndex / playFromActivePlaylist)
 *   - 命令式 force* 控制层 (用于托盘/快捷键/媒体键)
 *   - seekTo 跳转
 *   - currentTime 定时更新
 *   - MediaSession action handler 绑定
 *   - 当前播放歌曲变化的 watch(自动加载下一首)
 *   - 音量变化的 watch(同步到 engine.gain)
 *
 * 跨域调用:
 *   - 读取 libraryStore.currentIndex / currentSong / playlist
 *   - 触发 historyStore.startHistoryRecord / endHistoryRecord
 *   - 通过 audioEngine 实际操作 Web Audio
 *
 * 不包含: UI 面板状态、设置项、历史数据持久化
 */

const saved = loadSettings()

/**
 * 初始音量（0~1）。
 * 只作用在"本地没有存过音量"的首次启动；用户一旦调过音量，
 * 之后一律以 localStorage 里持久化的值为准。
 * 三处使用点（volume 初值 / lastVolume 初值 / 取消静音的兜底值）共用此常量，
 * 避免以后再改默认值时漏改其中一处。
 */
const DEFAULT_VOLUME = 0.5

export const useAudioStore = defineStore('audio', () => {
  const library = useLibraryStore()

  // ========== HTML5 音频层(P2: 延迟加载) ==========
  // 这一层只用于元数据 / MediaSession / 让系统把媒体键路由到 WebView, 不参与发声,
  // 因此没必要挤在主入口首屏关键路径上; 首次用到时再加载(模块级缓存, 只算一次)。
  type Html5Player = import('@/audio/HTML5AudioPlayer').HTML5AudioPlayer
  let html5PlayerPromise: Promise<Html5Player> | null = null
  function html5(): Promise<Html5Player> {
    if (!html5PlayerPromise) {
      html5PlayerPromise = import('@/audio/HTML5AudioPlayer').then(
        (module) => module.html5AudioPlayer
      )
    }
    return html5PlayerPromise
  }

  // ========== 播放历史 store(P2: 延迟加载) ==========
  // historyStore 约 11KB(压缩后 ~3KB), 启动与首屏都不需要它:
  //   - 记录类调用(开始/结束记录)在真正播放时才会发生
  //   - 统计类读取(智能随机的播放信号)读不到时按 0 处理, 与"没听过"等价
  // 模块初始化时就把动态 import 发出去, 与应用启动并行, 通常在任何用户交互前已就绪。
  type HistoryStore = ReturnType<typeof useHistoryStore>
  let historyStore: HistoryStore | null = null
  const historyReady: Promise<HistoryStore> = import('./historyStore').then((module) => {
    historyStore = module.useHistoryStore()
    return historyStore
  })

  /** 已就绪则同步拿到, 未就绪返回 null(用于同步读统计, 不做等待) */
  function historyNow(): HistoryStore | null {
    return historyStore
  }
  const settings = useSettingsStore()

  // ========== 播放状态 ==========
  const isPlaying = ref(false)
  const isSwitchingSong = ref(false)
  const pendingPlay = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref((saved.volume as number) ?? DEFAULT_VOLUME)
  const lastVolume = ref(DEFAULT_VOLUME)
  const loopMode = ref<LoopMode>((saved.loopMode as LoopMode) ?? 'list')

  // ========== 随机播放历史 ==========
  const shuffleHistory = ref<number[]>([])

  // ========== 计算属性 ==========
  const currentSong = computed(() => library.currentSong)

  /**
   * 当前播放曲目的"身份键"。
   *
   * 为什么不直接 watch(currentSong)：
   *   currentSong 是 `playlist[currentIndex]` 的 computed，返回的是**对象引用**；
   *   而 playlist 是 shallowRef —— 收藏(applyFavoriteLocal)、编辑元数据等操作
   *   必须用 `{ ...song, ...patch }` 造出"同 id 的新对象 + 新数组"才能触发 UI 更新。
   *   于是对象引用变了，但曲目根本没变。
   *
   *   旧实现 `watch(() => currentSong.value)` 只看引用，后果是：点一次「喜欢」就会
   *   走进换歌加载器 → stopPlayback() → currentTime = 0 → 从头重新加载播放，
   *   播放进度被清零，同时还会把播放历史记录切断重开。
   *
   *   改成只监听"身份键"：id 与 file_path 都没变就不算换歌。
   */
  const currentTrackKey = computed(() => {
    const song = currentSong.value
    return song ? `${song.id}\u0000${song.file_path}` : null
  })

  // 当前歌单的歌曲列表（默认歌单 = 全部歌曲，自定义歌单 = 歌单内歌曲）
  const activeSongs = computed(() => library.activePlaylistSongs)

  // 当前歌曲在当前歌单中的索引
  const currentActiveIndex = computed(() => {
    const current = currentSong.value
    if (!current) return -1
    return activeSongs.value.findIndex((s) => s.id === current.id)
  })

  const hasNext = computed(() => {
    if (loopMode.value === 'single') return true
    if (loopMode.value === 'list') return activeSongs.value.length > 0
    if (loopMode.value === 'shuffle') return activeSongs.value.length > 0
    return currentActiveIndex.value >= 0 && currentActiveIndex.value < activeSongs.value.length - 1
  })
  const hasPrev = computed(() => {
    if (loopMode.value === 'single') return true
    if (loopMode.value === 'list') return activeSongs.value.length > 0
    if (loopMode.value === 'shuffle') return activeSongs.value.length > 0
    return currentActiveIndex.value > 0
  })

  // ========== 工具方法 ==========
  // 将当前歌单中的索引转换为全局索引
  function activeIndexToGlobal(activeIdx: number): number {
    const song = activeSongs.value[activeIdx]
    if (!song) return -1
    return library.playlist.findIndex((s) => s.id === song.id)
  }

  function getRandomIndex(): number {
    const songs = activeSongs.value
    if (songs.length <= 1) return 0
    const currentIdx = currentActiveIndex.value

    // 智能随机: 按权重抽样 (喜爱 / 常听 / 当日新增加分, 常没听完扣分)
    if (settings.smartShuffle) {
      const weights = computeSmartWeights(songs, getPlaySignals, Date.now(), currentIdx)
      const picked = pickWeightedIndex(weights)
      // 权重池已排除当前歌曲, 这里的兜底只为防御异常输入
      if (picked >= 0 && picked !== currentIdx) {
        return activeIndexToGlobal(picked)
      }
    }

    // 等概率随机 (开关关闭, 或智能随机兜底)
    let newActiveIndex = Math.floor(Math.random() * songs.length)
    if (newActiveIndex === currentIdx) {
      newActiveIndex = (newActiveIndex + 1) % songs.length
    }
    return activeIndexToGlobal(newActiveIndex)
  }

  /**
   * 读取某首歌的播放信号 (智能随机加权用)
   *
   * 播放历史早期把路径哈希写进 song_hash, 现在是内容指纹, 存量数据两种键都有,
   * 因此两个键都查一遍并取较丰富的一份 (与 utils/songIdentity 的口径一致)。
   */
  function getPlaySignals(song: Song): SongPlaySignals {
    const keys: string[] = []
    if (song.content_hash) keys.push(song.content_hash)
    if (song.id) keys.push(song.id)

    let playCount = 0
    let completedCount = 0
    let lastPlayedAt = 0
    const history = historyNow()
    if (history) {
      for (const key of keys) {
        playCount = Math.max(playCount, history.songPlayCount[key] || 0)
        completedCount = Math.max(completedCount, history.songCompletedCount[key] || 0)
        lastPlayedAt = Math.max(lastPlayedAt, history.songLastPlayedAt[key] || 0)
      }
    }
    return { playCount, completedCount, lastPlayedAt }
  }

  // ========== 切歌/播放控制 ==========
  // 切歌策略: 记录播放意图 (userWantsToPlay = 切歌前是否在播放)
  //   - 切歌前在播放 → 加载完自动播放
  //   - 切歌前暂停 → 加载完保持暂停
  //   - 通过 stopPlayback() 中 gain.gain = 0 实现静音切换, 无重叠/重复播放

  /**
   * 切歌收尾: 本次操作未选中新歌时 (顺序模式在首/尾越界, shuffle 抽到同一首),
   * 说明不会再有新歌去触发 currentSong watcher 的收尾流程, 必须在此显式处理:
   *   - 释放切歌锁 isSwitchingSong (否则 isPlaying watcher 会被永久跳过)
   *   - 结束历史记录 (否则心跳定时器不会停止, 会持续持有引擎/记录引用并每 15s 写库)
   */
  function settleIfNoSongChanged(startIndex: number) {
    if (library.currentIndex !== startIndex) return
    isPlaying.value = false
    isSwitchingSong.value = false
    void historyReady.then((store) => store.endHistoryRecord(audioEngine))
  }

  // ========== 预解码下一首(P0 优化: 把 decode 挪出切歌关键路径) ==========
  //
  // 实测切歌延迟 84.5% 花在 decodeAudioData(单曲 200~600ms),而命中已解码缓存的
  // 切歌只需 1ms 量级。因此在当前曲目开始播放后,把"下一首"提前解好放进 LRU。
  //
  // 约束:
  //   - 随机/单曲循环无法预测下一首(随机会白烧一次解码),不预取
  //   - 延迟 600ms 触发,避开切歌本身的解码与首帧;期间若又换歌则重新计时
  const PREFETCH_DELAY_MS = 600
  let prefetchTimer: number | null = null
  /**
   * 随机模式下的"下一首"预选结果
   *
   * 随机的下一首本来到歌尾才算,这样预解码永远落空。这里在预解码时机提前抽一次,
   * 存下结果并在真正切歌时使用——随机性不变(仍是均匀/加权抽样),但解码可以提前完成。
   * 换歌、换歌单、切模式时都会作废重抽。
   */
  let prefetchedNext: { songId: string; globalIndex: number } | null = null

  /** 推断"下一首"会播哪一首(纯逻辑见 @/utils/playQueue, 便于单测) */
  function upcomingSong(): Song | null {
    return pickUpcomingSong(activeSongs.value, currentActiveIndex.value, loopMode.value)
  }

  function cancelPrefetch() {
    if (prefetchTimer !== null) {
      clearTimeout(prefetchTimer)
      prefetchTimer = null
    }
    prefetchedNext = null
  }

  /**
   * 取出随机模式预选的下一首并作废旧结果
   * 校验: 该曲目仍在当前歌单、且不是当前正在播的这首;否则回退到现抽
   */
  function takeShuffleNext(): number {
    const pending = prefetchedNext
    prefetchedNext = null
    return resolveShuffleNext(
      pending,
      activeSongs.value,
      currentSong.value?.id ?? null,
      getRandomIndex()
    )
  }

  /**
   * 确保"下一首"已经进入预解码(幂等: 已缓存/在途时是廉价空操作)
   *
   * 随机模式下,若尚未预选就提前抽一次并记住;已经预选过则沿用,不会反复换目标。
   */
  function ensurePrefetch() {
    if (!currentSong.value) return
    if (loopMode.value === 'single') return
    // 切歌过程中不解码:前台正在解码这一首,再并发一个预解码会把两者都拖慢
    if (isSwitchingSong.value || pendingPlay.value) return

    if (loopMode.value === 'shuffle') {
      if (prefetchedNext) {
        const picked = library.playlist.find((song) => song.id === prefetchedNext?.songId)
        if (picked) {
          audioEngine.prefetch(library.getAudioUrl(picked.file_path), picked.id)
          return
        }
        // 预选目标已不在歌单(切换歌单等),作废重抽
        prefetchedNext = null
      }
      const index = getRandomIndex()
      const picked = library.playlist[index]
      if (!picked) return
      prefetchedNext = { songId: picked.id, globalIndex: index }
      audioEngine.prefetch(library.getAudioUrl(picked.file_path), picked.id)
      return
    }

    const song = upcomingSong()
    if (!song) return
    audioEngine.prefetch(library.getAudioUrl(song.file_path), song.id)
  }

  /** 安排一次预解码;重复调用只保留最后一次(切歌期间的重置靠 cancelPrefetch) */
  function schedulePrefetch(delay = PREFETCH_DELAY_MS) {
    cancelPrefetch()
    prefetchTimer = window.setTimeout(() => {
      prefetchTimer = null
      ensurePrefetch()
    }, delay)
  }

  function next() {
    const songs = activeSongs.value
    if (songs.length === 0) return

    isSwitchingSong.value = true
    // 记录播放意图: 切歌前在播放则自动播放, 否则保持暂停
    const wasPlaying = isPlaying.value
    pendingPlay.value = wasPlaying
    isPlaying.value = false
    // 记录切歌前索引, 用于判断本次是否真的产生了新歌
    const startIndex = library.currentIndex

    if (loopMode.value === 'single') {
      currentTime.value = 0
      const idx = library.currentIndex
      library.currentIndex = -1
      nextTick(() => {
        library.currentIndex = idx
      })
      return
    }

    if (loopMode.value === 'shuffle') {
      shuffleHistory.value.push(library.currentIndex)
      if (shuffleHistory.value.length > 100) {
        shuffleHistory.value.shift()
      }
      library.currentIndex = takeShuffleNext()
      settleIfNoSongChanged(startIndex)
      return
    }

    // 顺序 / 列表循环: 基于当前歌单
    const curIdx = currentActiveIndex.value
    if (curIdx >= 0 && curIdx < songs.length - 1) {
      library.currentIndex = activeIndexToGlobal(curIdx + 1)
    } else if (loopMode.value === 'list') {
      library.currentIndex = activeIndexToGlobal(0)
    }

    settleIfNoSongChanged(startIndex)
    void invoke('clean_renderer_memory').catch(() => {})
  }

  // 自动下一首 (自然播放结束时调用, 会自动播放)
  function nextAuto() {
    const songs = activeSongs.value
    if (songs.length === 0) return
    isSwitchingSong.value = true
    pendingPlay.value = true
    isPlaying.value = true

    if (loopMode.value === 'single') {
      currentTime.value = 0
      const idx = library.currentIndex
      library.currentIndex = -1
      nextTick(() => {
        library.currentIndex = idx
      })
      return
    }

    if (loopMode.value === 'shuffle') {
      shuffleHistory.value.push(library.currentIndex)
      if (shuffleHistory.value.length > 100) {
        shuffleHistory.value.shift()
      }
      library.currentIndex = takeShuffleNext()
      return
    }

    // 顺序 / 列表循环: 基于当前歌单
    const curIdx = currentActiveIndex.value
    if (curIdx >= 0 && curIdx < songs.length - 1) {
      library.currentIndex = activeIndexToGlobal(curIdx + 1)
    } else if (loopMode.value === 'list') {
      library.currentIndex = activeIndexToGlobal(0)
    }

    void invoke('clean_renderer_memory').catch(() => {})
  }

  function prev() {
    const songs = activeSongs.value
    if (songs.length === 0) return

    isSwitchingSong.value = true
    // 记录播放意图: 切歌前在播放则自动播放, 否则保持暂停
    const wasPlaying = isPlaying.value
    pendingPlay.value = wasPlaying
    isPlaying.value = false
    // 记录切歌前索引, 用于判断本次是否真的产生了新歌
    const startIndex = library.currentIndex

    if (loopMode.value === 'single') {
      currentTime.value = 0
      const idx = library.currentIndex
      library.currentIndex = -1
      nextTick(() => {
        library.currentIndex = idx
      })
      return
    }

    if (loopMode.value === 'shuffle') {
      if (shuffleHistory.value.length > 0) {
        const prevIndex = shuffleHistory.value.pop()!
        library.currentIndex = prevIndex
      } else {
        library.currentIndex = getRandomIndex()
      }
      settleIfNoSongChanged(startIndex)
      return
    }

    // 顺序 / 列表循环: 基于当前歌单
    const curIdx = currentActiveIndex.value
    if (curIdx > 0) {
      library.currentIndex = activeIndexToGlobal(curIdx - 1)
    } else if (loopMode.value === 'list') {
      library.currentIndex = activeIndexToGlobal(songs.length - 1)
    }

    settleIfNoSongChanged(startIndex)
    void invoke('clean_renderer_memory').catch(() => {})
  }

  function playByIndex(index: number) {
    if (index >= 0 && index < library.playlist.length) {
      if (loopMode.value === 'shuffle' && library.currentIndex >= 0) {
        shuffleHistory.value.push(library.currentIndex)
      }
      isSwitchingSong.value = true
      // 记录播放意图: 切歌前在播放则自动播放, 否则保持暂停
      const wasPlaying = isPlaying.value
      pendingPlay.value = wasPlaying
      isPlaying.value = false
      library.currentIndex = index
    }
  }

  function playFromActivePlaylist(index: number) {
    const songs = library.filteredActivePlaylistSongs
    if (index >= 0 && index < songs.length) {
      const song = songs[index]
      const globalIndex = library.playlist.findIndex((s) => s.id === song.id)
      if (globalIndex !== -1) {
        playByIndex(globalIndex)
      }
    }
  }

  // ========== 循环模式 ==========
  function toggleLoopMode() {
    const modes: LoopMode[] = ['list', 'single', 'shuffle', 'none']
    const currentIdx = modes.indexOf(loopMode.value)
    loopMode.value = modes[(currentIdx + 1) % modes.length]
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
      volume.value = lastVolume.value || DEFAULT_VOLUME
    }
  }

  // ========== seekTo 跳转 ==========
  function seekTo(time: number) {
    audioEngine.seekTo(time)
    currentTime.value = time
  }

  // ========== 播放控制(play / pause / togglePlay) ==========
  function play() {
    if (isPlaying.value) return
    isPlaying.value = true
    // 2026-07-14: 同步 html5 audio 元素到 playing 状态,
    //   让 OS 把 MediaKey 路由到 WebView (蓝牙耳机/键盘多媒体键)
    //   muted+volume=0 绝对静音, 实际播放由 Web Audio 处理
    void html5().then((player) => player.play())
    void audioEngine.resumePlayback()
    startTimeUpdate()
  }

  function pause() {
    if (!isPlaying.value) return
    isPlaying.value = false
    audioEngine.pausePlayback()
    stopTimeUpdate()
    // 暂停: 累加本次播放时长到历史
    void historyReady.then((store) => store.endHistoryRecord(audioEngine))
  }

  function togglePlay() {
    if (isPlaying.value) {
      pause()
    } else {
      play()
    }
  }

  // ========== 命令式 Force 控制层(托盘/快捷键/媒体键) ==========
  async function forcePlay() {
    if (isPlaying.value && audioEngine.state.hasSource && !audioEngine.state.isPaused) return
    await audioEngine.forceWake()
    isPlaying.value = true
    // 2026-07-14: 同步 html5 audio 元素 playing, 让 MediaKey 路由到 WebView
    void html5().then((player) => player.play())
    await audioEngine.resumePlayback()
    startTimeUpdate()
  }

  async function forcePause() {
    if (!isPlaying.value) return
    isPlaying.value = false
    audioEngine.pausePlayback()
    stopTimeUpdate()
    // 与 pause() 保持一致: 暂停即结束本次历史记录 (否则暂停时长会被计入播放时长)
    void historyReady.then((store) => store.endHistoryRecord(audioEngine))
  }

  async function forceTogglePlay() {
    if (isPlaying.value) {
      await forcePause()
    } else {
      await forcePlay()
    }
  }

  async function forceNext() {
    await audioEngine.forceWake()
    next()
  }

  async function forcePrevious() {
    await audioEngine.forceWake()
    prev()
  }

  // ========== 播放结束回调 ==========
  // 自然播放结束的统一处理 (onended 与后台恢复对账共用, 避免逻辑分叉)
  function handleNaturalEnded() {
    stopTimeUpdate()
    // 自然播放结束: 累加一次历史时长
    void historyReady.then((store) => store.endHistoryRecord(audioEngine))

    // 单曲循环: 复用 AudioBuffer, 跳过 fetch + decodeAudioData
    if (loopMode.value === 'single' && audioEngine.state.hasContext) {
      void audioEngine.playFromOffset(0, () => {
        // 单曲循环重启: 重新开始一条历史记录(先把当前曲目固定下来再异步记录)
        const loopSong = currentSong.value
        if (loopSong) {
          void historyReady.then((store) => store.startHistoryRecord(loopSong, audioEngine))
        }
      })
      return
    }

    // 顺序模式末尾: 停止播放（基于当前歌单）
    if (loopMode.value === 'none' && currentActiveIndex.value >= activeSongs.value.length - 1) {
      isPlaying.value = false
      return
    }

    // 列表循环末尾 / shuffle: 走 nextAuto (自然播放完, 自动播放下一首)
    nextAuto()
  }

  audioEngine.setOnEnded(handleNaturalEnded)

  /**
   * 播放状态对账 (窗口从后台/冻结恢复时调用)
   *
   * 背景: WebView2 在窗口隐藏时可能节流甚至冻结 JS 主线程,
   *   AudioBufferSourceNode.onended 事件会被延迟或漏派发,
   *   表现为"界面显示播放中, 实际歌曲已播完且没有自动切歌/落历史".
   *
   * 检测: isPlaying=true 但引擎已无 source 且当前时间已到达歌曲结尾
   *   → 判定为漏派发, 补走一次自然结束流程 (落历史 + 自动切歌)
   */
  async function reconcilePlaybackState() {
    await audioEngine.forceWake()
    if (!isPlaying.value) return

    const engState = audioEngine.state
    if (engState.hasSource || engState.isPaused) return

    const t = audioEngine.getCurrentTime()
    const dur = duration.value || currentSong.value?.duration || 0
    if (dur > 0 && t >= dur - 1) {
      console.info('[audioStore] 检测到后台漏派发的播放结束, 执行状态对账')
      handleNaturalEnded()
    }
  }

  // ========== 播放时间更新定时器 ==========
  let timeUpdateInterval: number | null = null

  /** 预解码看门狗的时间闸门(毫秒):频率远低于 250ms 的进度刷新,避免额外开销 */
  const PREFETCH_WATCHDOG_MS = 2000
  let lastPrefetchCheckAt = 0

  function startTimeUpdate() {
    if (timeUpdateInterval) return
    timeUpdateInterval = window.setInterval(() => {
      if (!isPlaying.value) return
      const t = audioEngine.getCurrentTime()
      currentTime.value = t
      // 兜底:首次播放、预选失败、播放器被系统唤醒等路径都靠这里补一次预解码
      const now = performance.now()
      if (now - lastPrefetchCheckAt >= PREFETCH_WATCHDOG_MS) {
        lastPrefetchCheckAt = now
        ensurePrefetch()
      }
    }, 250)
  }

  function stopTimeUpdate() {
    if (timeUpdateInterval) {
      clearInterval(timeUpdateInterval)
      timeUpdateInterval = null
    }
  }

  // ========== 当前播放歌曲变化: 加载并自动播放 ==========
  // 切歌加载世代令牌: currentSong 每次变化 +1。
  // 旧实现用 isLoadingSong 布尔锁, 加载期间的切歌请求会被直接丢弃,
  // 异步加载完成后播放的是过期目标 (一种"选 A 播 B"竞态)。
  // 现在每次变化都进入加载, await 后校验令牌, 只有最新一次生效。
  //
  // 注意: 这里必须监听 currentTrackKey(身份键) 而不是 currentSong(对象引用),
  // 否则"收藏 / 编辑元数据"这类同曲目换对象的更新会被误判成换歌并把进度清零。
  let loadGeneration = 0

  watch(currentTrackKey, async () => {
    const song = currentSong.value
    if (!song) return
    const myGen = ++loadGeneration

    // 性能记录: 切歌加载起点 (供 perfRecorder 计算切歌延迟)
    window.dispatchEvent(new CustomEvent('perf:load-start', { detail: { songId: song.id } }))
    // 换歌时取消排队中的预解码,避免与本次解码抢 CPU
    cancelPrefetch()

    try {
      // 第 1 步: 立即停止旧播放 + 静音 (AudioEngine 三层静音防护)
      audioEngine.stopPlayback()
      stopTimeUpdate()
      currentTime.value = 0
      // 切歌即结束上一首的记录 (幂等): 保证任何"停旧播新"路径都不会遗留心跳定时器
      // 与旧记录引用; 即使新歌加载失败, 播放时长也已正确结算
      void historyReady.then((store) => store.endHistoryRecord(audioEngine))

      // 第 2 步: 初始化 AudioContext + 加载 Web Audio buffer (主链路, 优先)
      audioEngine.init(volume.value)
      const audioUrl = library.getAudioUrl(song.file_path)
      const audioBuffer = await audioEngine.getAudioBuffer(audioUrl, song.id)

      // await 期间用户又切了歌: 本次加载已过期, 放弃播放
      // (最新一次 watch 调用持有最新令牌, 会完成实际播放)
      if (myGen !== loadGeneration || currentSong.value?.id !== song.id) return

      if (audioBuffer) {
        audioEngine.setCurrentUrl(audioUrl)
      }

      // 第 3 步: 并行加载 HTML5 Audio (仅用于元数据/MediaSession, 不发声)
      //    放在 Web Audio 之后, 不阻塞主播放链路
      void (async () => {
        const player = await html5()
        player.setVolume(0)
        try {
          await player.load(song.file_path)
          // 加载完成时可能已切到别的歌, 校验后再写 MediaSession
          if (myGen !== loadGeneration || currentSong.value?.id !== song.id) return
          player.setVolume(0)
          player.setMediaSession(
            song.title,
            song.artist,
            song.cover_path ? library.getCoverUrl(song.cover_path) : undefined
          )
        } catch (e) {
          console.warn('[audioStore] HTML5 Audio 加载失败 (不影响播放):', e)
        }
      })()

      // 第 4 步: 根据当前播放状态决定是否自动播放
      //   (加载期间用户按了播放也能被捕捉到, 不再依赖加载前快照)
      if (audioBuffer && (isPlaying.value || pendingPlay.value)) {
        pendingPlay.value = false
        // 先设 isPlaying = true (此时 isSwitchingSong 仍为 true, isPlaying watcher 会跳过, 不会重复播放)
        isPlaying.value = true
        await audioEngine.playFromOffset(0, () => {
          // 播放开始时触发 history 记录(延迟加载: 拿到的 song 先固定下来)
          const startedSong = currentSong.value
          if (startedSong) {
            void historyReady.then((store) => store.startHistoryRecord(startedSong, audioEngine))
          }
          // 性能记录: 实际出声时刻 (供 perfRecorder 计算切歌延迟)
          window.dispatchEvent(
            new CustomEvent('perf:playback-started', { detail: { songId: song.id } })
          )
        })
        // 性能记录: 切歌分段明细(fetch/decode/start),仅定位用,不参与任何播放决策
        const timings = audioEngine.getLastTimings()
        if (timings) {
          window.dispatchEvent(
            new CustomEvent('perf:switch-trace', { detail: { songId: song.id, timings } })
          )
        }
        // 播放已开始:把下一首预解码好,下次切歌就走 LRU 命中
        schedulePrefetch()
        // 最后才解除切歌锁
        isSwitchingSong.value = false
        startTimeUpdate()
      } else {
        // 不自动播放: 只更新 UI 状态, 保持暂停在 0:00
        isSwitchingSong.value = false
        pendingPlay.value = false
      }
    } catch (e) {
      // 只有最新一次加载失败才重置状态, 过期调用的错误静默丢弃
      if (myGen !== loadGeneration) return
      console.error('[audioStore] 加载歌曲失败:', e)
      isSwitchingSong.value = false
      pendingPlay.value = false
      isPlaying.value = false
    }
  })

  // ========== isPlaying 变化(切歌过程中跳过, 防止重复触发) ==========
  watch(
    () => isPlaying.value,
    async (playing) => {
      if (isSwitchingSong.value) return

      if (playing) {
        await audioEngine.resumePlayback()
        startTimeUpdate()
        void html5().then((player) => player.play())
        // 恢复播放后同样预解码下一首(暂停期间缓存的下一首可能已被淘汰)
        schedulePrefetch()
        // 暂停时历史记录已结束, 恢复播放需要新开一条记录
        // (切歌自动播放路径由 playFromOffset 的 onStart 回调负责, 不走这里)
        const resumedSong = currentSong.value
        if (resumedSong) {
          void historyReady.then((store) =>
            store.startHistoryRecordIfAbsent(resumedSong, audioEngine)
          )
        }
      } else {
        audioEngine.pausePlayback()
        stopTimeUpdate()
      }
    }
  )

  // ========== 音量变化: 应用到 Web Audio + 持久化 ==========
  watch(
    () => volume.value,
    (vol) => {
      audioEngine.setVolume(vol)
      void html5().then((player) => player.setVolume(0))
    }
  )

  // ========== 响度均衡开关: 同步到音频引擎 ==========
  // immediate: store 初始化早于 AudioEngine.init，开关状态先以标记位保存，建链后自动接入
  watch(
    () => settings.loudnessNormalization,
    (enabled) => {
      audioEngine.setLoudnessEnabled(enabled)
    },
    { immediate: true }
  )

  // ========== 响度测量模式: 同步到 normalizer ==========
  watch(
    () => settings.loudnessMode,
    (mode) => {
      audioEngine.setLoudnessMode(mode)
    },
    { immediate: true }
  )

  // 持久化 volume / loopMode
  let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    [volume, loopMode],
    ([vol, mode]) => {
      if (settingsSaveTimer) {
        clearTimeout(settingsSaveTimer)
      }
      settingsSaveTimer = setTimeout(() => {
        const existing = loadSettings()
        saveSettings({
          ...existing,
          volume: vol,
          loopMode: mode,
        })
      }, 300)
    },
    { deep: false, flush: 'post' }
  )

  // ========== MediaSession action handler(命令式) ==========
  function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        void forcePlay()
      })
      navigator.mediaSession.setActionHandler('pause', () => {
        void forcePause()
      })
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        void forcePrevious()
      })
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        void forceNext()
      })
      navigator.mediaSession.setActionHandler('stop', () => {
        void forcePause()
      })
    } catch (e) {
      console.warn('[MediaSession] 设置 action handler 失败:', e)
    }
  }
  setupMediaSessionHandlers()

  // 同步播放状态到 MediaSession
  function syncMediaSessionPlaybackState() {
    if (!('mediaSession' in navigator)) return
    try {
      const state = isPlaying.value ? 'playing' : 'paused'
      navigator.mediaSession.playbackState = state
    } catch (e) {
      console.warn('[MediaSession] 同步 playbackState 失败:', e)
    }
  }
  syncMediaSessionPlaybackState()
  watch(() => isPlaying.value, syncMediaSessionPlaybackState)

  // ========== 原生系统媒体控制 (tauri-plugin-media) ==========
  // 绕过 WebView2 MediaSession 的不稳定性, 直接通过 Rust 原生层对接 Windows SMTC
  // 事件通过 Tauri 事件系统从 Rust 端 emit 到前端 (setEventHandler 前端 API 未实现)
  let nativeMediaInitialized = false

  async function initNativeMediaControls() {
    try {
      await mediaControls.initialize('com.gaoshanliushui.player', '高山流水')
      nativeMediaInitialized = true

      const events = ['play', 'pause', 'playpause', 'stop', 'next', 'previous']
      for (const evt of events) {
        await listen(`media://${evt}`, () => {
          switch (evt) {
            case 'play':
              void forcePlay()
              break
            case 'pause':
              void forcePause()
              break
            case 'playpause':
              if (isPlaying.value) {
                void forcePause()
              } else {
                void forcePlay()
              }
              break
            case 'stop':
              void forcePause()
              break
            case 'next':
              void forceNext()
              break
            case 'previous':
              void forcePrevious()
              break
          }
        })
      }
    } catch (e) {
      console.warn('[NativeMedia] 初始化失败:', e)
    }
  }

  async function updateNativeMediaMetadata() {
    if (!nativeMediaInitialized || !currentSong.value) return
    try {
      const song = currentSong.value
      const library = useLibraryStore()
      await mediaControls.updateNowPlaying(
        {
          title: song.title,
          artist: song.artist || '未知艺术家',
          album: song.album || undefined,
          duration: duration.value > 0 ? duration.value : undefined,
          artworkUrl: song.cover_path ? library.getCoverUrl(song.cover_path) : undefined,
          artworkData: '',
        },
        {
          status: isPlaying.value ? PlaybackStatus.Playing : PlaybackStatus.Paused,
          position: currentTime.value,
        }
      )
    } catch (e) {
      console.warn('[NativeMedia] 更新 metadata 失败:', e)
    }
  }

  async function updateNativeMediaPlaybackStatus() {
    if (!nativeMediaInitialized) return
    try {
      await mediaControls.updatePlaybackStatus(
        isPlaying.value ? PlaybackStatus.Playing : PlaybackStatus.Paused
      )
    } catch (e) {
      console.warn('[NativeMedia] 更新播放状态失败:', e)
    }
  }

  void initNativeMediaControls()

  // ========== 输出设备断开自动暂停 ==========
  // 背景: Web Audio 的输出跟随系统默认设备, 断开蓝牙耳机时 Windows 会切回扬声器,
  //   但 AudioContext 不会自动停止 → "断开蓝牙后依旧在后台偷跑播歌".
  // Rust 侧 (audio_device.rs) 通过 IMMNotificationClient 监听默认输出设备被移除,
  //   emit `audio://output-device-removed`; 这里收到后自动暂停.
  async function initAudioDeviceMonitor() {
    try {
      await listen('audio://output-device-removed', () => {
        if (!isPlaying.value) return
        console.info('[audioStore] 输出设备已断开, 自动暂停播放')
        void forcePause()
      })
    } catch (e) {
      console.warn('[audioStore] 注册输出设备监听失败:', e)
    }
  }

  void initAudioDeviceMonitor()

  watch(currentTrackKey, () => {
    void updateNativeMediaMetadata()
  })

  watch(
    () => isPlaying.value,
    () => {
      void updateNativeMediaPlaybackStatus()
    }
  )

  // ========== 监听 settings 的睡眠定时器触发 ==========
  function handleSleepTimerFire() {
    pause()
  }
  window.addEventListener('settings:sleep-timer-fire', handleSleepTimerFire)

  // 组件卸载时清理
  onScopeDispose(() => {
    window.removeEventListener('settings:sleep-timer-fire', handleSleepTimerFire)
    stopTimeUpdate()
  })

  // ========== 初始化 HTML5 Audio store 访问器 ==========
  // 这里放在 then 里: 模块本身是延迟加载的, 注册回调晚几毫秒不影响任何播放行为
  void html5().then((player) => {
    player.bindStoreAccessors({
      setIsSwitchingSong: (v: boolean) => {
        isSwitchingSong.value = v
      },
    })

    // 接收时长变化(从 HTML5 Audio 元数据)
    player.onDurationChange((dur) => {
      duration.value = dur
    })

    // 确保 HTML5 Audio 始终静音
    player.setVolume(0)
  })

  return {
    // 状态
    isPlaying,
    isSwitchingSong,
    pendingPlay,
    currentTime,
    duration,
    volume,
    lastVolume,
    loopMode,
    shuffleHistory,
    // 计算属性
    currentSong,
    currentTrackKey,
    hasNext,
    hasPrev,
    // 工具
    getRandomIndex,
    getAnalyserNode: () => audioEngine.getAnalyserNode(),
    // 切歌/播放
    next,
    prev,
    playByIndex,
    playFromActivePlaylist,
    toggleLoopMode,
    toggleMute,
    seekTo,
    play,
    pause,
    togglePlay,
    // 命令式 force 层
    forcePlay,
    forcePause,
    forceTogglePlay,
    forceNext,
    forcePrevious,
    // 引擎生命周期
    resumeAudioContext: () => audioEngine.resumeContext(),
    reconcilePlaybackState,
    clearAudioBufferCache: () => {
      cancelPrefetch()
      audioEngine.clearCache()
    },
    disconnectAnalyser: () => audioEngine.disconnectAnalyser(),
    reconnectAnalyser: () => audioEngine.reconnectAnalyser(),
  }
})
