import { defineStore } from 'pinia'
import { ref, computed, nextTick, watch, onScopeDispose } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { LoopMode } from '@/types/song'
import { audioEngine } from '@/audio/AudioEngine'
import { html5AudioPlayer } from '@/audio/HTML5AudioPlayer'
import { loadSettings, saveSettings } from '@/utils/storage'
import { useLibraryStore } from './libraryStore'
import { useHistoryStore } from './historyStore'
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

export const useAudioStore = defineStore('audio', () => {
  const library = useLibraryStore()
  const history = useHistoryStore()

  // ========== 播放状态 ==========
  const isPlaying = ref(false)
  const isSwitchingSong = ref(false)
  const pendingPlay = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const volume = ref((saved.volume as number) ?? 0.8)
  const lastVolume = ref(0.8)
  const loopMode = ref<LoopMode>((saved.loopMode as LoopMode) ?? 'list')

  // ========== 随机播放历史 ==========
  const shuffleHistory = ref<number[]>([])

  // ========== 计算属性 ==========
  const currentSong = computed(() => library.currentSong)

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
    let newActiveIndex = Math.floor(Math.random() * songs.length)
    if (newActiveIndex === currentIdx && songs.length > 1) {
      newActiveIndex = (newActiveIndex + 1) % songs.length
    }
    return activeIndexToGlobal(newActiveIndex)
  }

  // ========== 切歌/播放控制 ==========
  // 切歌策略: 记录播放意图 (userWantsToPlay = 切歌前是否在播放)
  //   - 切歌前在播放 → 加载完自动播放
  //   - 切歌前暂停 → 加载完保持暂停
  //   - 通过 stopPlayback() 中 gain.gain = 0 实现静音切换, 无重叠/重复播放
  function next() {
    const songs = activeSongs.value
    if (songs.length === 0) return

    isSwitchingSong.value = true
    // 记录播放意图: 切歌前在播放则自动播放, 否则保持暂停
    const wasPlaying = isPlaying.value
    pendingPlay.value = wasPlaying
    isPlaying.value = false

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
      library.currentIndex = getRandomIndex()
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
      library.currentIndex = getRandomIndex()
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
      return
    }

    // 顺序 / 列表循环: 基于当前歌单
    const curIdx = currentActiveIndex.value
    if (curIdx > 0) {
      library.currentIndex = activeIndexToGlobal(curIdx - 1)
    } else if (loopMode.value === 'list') {
      library.currentIndex = activeIndexToGlobal(songs.length - 1)
    }

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
      volume.value = lastVolume.value || 0.8
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
    void html5AudioPlayer.play()
    void audioEngine.resumePlayback()
    startTimeUpdate()
  }

  function pause() {
    if (!isPlaying.value) return
    isPlaying.value = false
    audioEngine.pausePlayback()
    stopTimeUpdate()
    // 暂停: 累加本次播放时长到历史
    history.endHistoryRecord(audioEngine)
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
    void html5AudioPlayer.play()
    await audioEngine.resumePlayback()
    startTimeUpdate()
  }

  async function forcePause() {
    if (!isPlaying.value) return
    isPlaying.value = false
    audioEngine.pausePlayback()
    stopTimeUpdate()
    // 与 pause() 保持一致: 暂停即结束本次历史记录 (否则暂停时长会被计入播放时长)
    history.endHistoryRecord(audioEngine)
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
    history.endHistoryRecord(audioEngine)

    // 单曲循环: 复用 AudioBuffer, 跳过 fetch + decodeAudioData
    if (loopMode.value === 'single' && audioEngine.state.hasContext) {
      void audioEngine.playFromOffset(0, () => {
        // 单曲循环重启: 重新开始一条历史记录
        if (currentSong.value) {
          history.startHistoryRecord(currentSong.value, audioEngine)
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

  function startTimeUpdate() {
    if (timeUpdateInterval) return
    timeUpdateInterval = window.setInterval(() => {
      if (isPlaying.value) {
        const t = audioEngine.getCurrentTime()
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

  // ========== 当前播放歌曲变化: 加载并自动播放 ==========
  // 切歌加载世代令牌: currentSong 每次变化 +1。
  // 旧实现用 isLoadingSong 布尔锁, 加载期间的切歌请求会被直接丢弃,
  // 异步加载完成后播放的是过期目标 (一种"选 A 播 B"竞态)。
  // 现在每次变化都进入加载, await 后校验令牌, 只有最新一次生效。
  let loadGeneration = 0

  watch(
    () => currentSong.value,
    async (song) => {
      if (!song) return
      const myGen = ++loadGeneration

      try {
        // 第 1 步: 立即停止旧播放 + 静音 (AudioEngine 三层静音防护)
        audioEngine.stopPlayback()
        stopTimeUpdate()
        currentTime.value = 0

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
        html5AudioPlayer.setVolume(0)
        html5AudioPlayer.load(song.file_path).then(() => {
          // 加载完成时可能已切到别的歌, 校验后再写 MediaSession
          if (myGen !== loadGeneration || currentSong.value?.id !== song.id) return
          html5AudioPlayer.setVolume(0)
          html5AudioPlayer.setMediaSession(
            song.title,
            song.artist,
            song.cover_path ? library.getCoverUrl(song.cover_path) : undefined
          )
        }).catch((e) => {
          console.warn('[audioStore] HTML5 Audio 加载失败 (不影响播放):', e)
        })

        // 第 4 步: 根据当前播放状态决定是否自动播放
        //   (加载期间用户按了播放也能被捕捉到, 不再依赖加载前快照)
        if (audioBuffer && (isPlaying.value || pendingPlay.value)) {
          pendingPlay.value = false
          // 先设 isPlaying = true (此时 isSwitchingSong 仍为 true, isPlaying watcher 会跳过, 不会重复播放)
          isPlaying.value = true
          await audioEngine.playFromOffset(0, () => {
            // 播放开始时触发 history 记录
            if (currentSong.value) {
              history.startHistoryRecord(currentSong.value, audioEngine)
            }
          })
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
    }
  )

  // ========== isPlaying 变化(切歌过程中跳过, 防止重复触发) ==========
  watch(
    () => isPlaying.value,
    async (playing) => {
      if (isSwitchingSong.value) return

      if (playing) {
        await audioEngine.resumePlayback()
        startTimeUpdate()
        void html5AudioPlayer.play()
        // 暂停时历史记录已结束, 恢复播放需要新开一条记录
        // (切歌自动播放路径由 playFromOffset 的 onStart 回调负责, 不走这里)
        if (currentSong.value) {
          history.startHistoryRecordIfAbsent(currentSong.value, audioEngine)
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
      html5AudioPlayer.setVolume(0)
    }
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

  watch(() => currentSong.value, () => {
    void updateNativeMediaMetadata()
  })

  watch(() => isPlaying.value, () => {
    void updateNativeMediaPlaybackStatus()
  })

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
  html5AudioPlayer.bindStoreAccessors({
    setIsSwitchingSong: (v: boolean) => { isSwitchingSong.value = v },
  })

  // 接收时长变化(从 HTML5 Audio 元数据)
  html5AudioPlayer.onDurationChange((dur) => {
    duration.value = dur
  })

  // 确保 HTML5 Audio 始终静音
  html5AudioPlayer.setVolume(0)

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
    clearAudioBufferCache: () => audioEngine.clearCache(),
    disconnectAnalyser: () => audioEngine.disconnectAnalyser(),
    reconnectAnalyser: () => audioEngine.reconnectAnalyser(),
  }
})
