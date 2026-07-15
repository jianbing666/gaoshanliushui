import { defineStore } from 'pinia'
import { ref, computed, nextTick, watch, onScopeDispose } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { LoopMode } from '@/types/song'
import { audioEngine } from '@/audio/AudioEngine'
import { html5AudioPlayer } from '@/audio/HTML5AudioPlayer'
import { loadSettings, saveSettings } from '@/utils/storage'
import { useLibraryStore } from './libraryStore'
import { useHistoryStore } from './historyStore'

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
  const hasNext = computed(() => {
    if (loopMode.value === 'single') return true
    if (loopMode.value === 'list') return true
    if (loopMode.value === 'shuffle') return library.playlist.length > 0
    return library.currentIndex < library.playlist.length - 1
  })
  const hasPrev = computed(() => {
    if (loopMode.value === 'single') return true
    if (loopMode.value === 'list') return true
    if (loopMode.value === 'shuffle') return library.playlist.length > 0
    return library.currentIndex > 0
  })

  // ========== 工具方法 ==========
  function getRandomIndex(): number {
    if (library.playlist.length <= 1) return 0
    let newIndex = Math.floor(Math.random() * library.playlist.length)
    if (newIndex === library.currentIndex && library.playlist.length > 1) {
      newIndex = (newIndex + 1) % library.playlist.length
    }
    return newIndex
  }

  // ========== 切歌/播放控制 ==========
  // BUG 2: 区分「用户手动切歌」(不自动播放) 和「自然播放结束自动下一首」(自动播放)
  //   next() / prev() / playByIndex() = 用户手动触发 → 不自动播放
  //   nextAuto() / playByIndexAuto() = 系统自动触发(如播放结束) → 自动播放
  function next() {
    if (library.playlist.length === 0) return

    isSwitchingSong.value = true
    // BUG 2 修复: 用户手动切歌不自动播放, 仅切换到下一首并暂停在 0:00
    pendingPlay.value = false
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

    if (library.currentIndex < library.playlist.length - 1) {
      library.currentIndex++
    } else if (loopMode.value === 'list') {
      library.currentIndex = 0
    }

    void invoke('clean_renderer_memory').catch(() => {})
  }

  // 自动下一首 (自然播放结束时调用, 会自动播放)
  function nextAuto() {
    if (library.playlist.length === 0) return
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

    if (library.currentIndex < library.playlist.length - 1) {
      library.currentIndex++
    } else if (loopMode.value === 'list') {
      library.currentIndex = 0
    }

    void invoke('clean_renderer_memory').catch(() => {})
  }

  function prev() {
    if (library.playlist.length === 0) return

    isSwitchingSong.value = true
    // BUG 2 修复: 同上, 切歌不自动播放
    pendingPlay.value = false
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

    if (library.currentIndex > 0) {
      library.currentIndex--
    } else if (loopMode.value === 'list') {
      library.currentIndex = library.playlist.length - 1
    }

    void invoke('clean_renderer_memory').catch(() => {})
  }

  function playByIndex(index: number) {
    if (index >= 0 && index < library.playlist.length) {
      if (loopMode.value === 'shuffle' && library.currentIndex >= 0) {
        shuffleHistory.value.push(library.currentIndex)
      }
      isSwitchingSong.value = true
      // BUG 2 修复: 点击列表切换歌曲不自动播放, 仅加载并暂停在 0:00
      //   用户需主动点击播放按钮才开始播放
      pendingPlay.value = false
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
    html5AudioPlayer.pause()
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
    html5AudioPlayer.pause()
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
  audioEngine.setOnEnded(() => {
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

    // 顺序模式末尾: 停止播放
    if (loopMode.value === 'none' && library.currentIndex >= library.playlist.length - 1) {
      isPlaying.value = false
      return
    }

    // 列表循环末尾 / shuffle: 走 nextAuto (自然播放完, 自动播放下一首)
    nextAuto()
  })

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
  let isLoadingSong = false

  watch(
    () => currentSong.value,
    async (song) => {
      if (!song) return
      if (isLoadingSong) return
      isLoadingSong = true

      try {
        audioEngine.stopPlayback()
        stopTimeUpdate()
        currentTime.value = 0

        // 先确保 HTML5 Audio 静音
        html5AudioPlayer.setVolume(0)

        // 加载 HTML5 Audio(仅用于元数据和 MediaSession)
        await html5AudioPlayer.load(song.file_path)
        html5AudioPlayer.setVolume(0)
        html5AudioPlayer.setMediaSession(
          song.title,
          song.artist,
          song.cover_path ? library.getCoverUrl(song.cover_path) : undefined
        )

        // Web Audio 主播放链路
        audioEngine.init(volume.value)

        const audioUrl = library.getAudioUrl(song.file_path)
        const audioBuffer = await audioEngine.getAudioBuffer(audioUrl, song.id, library.currentSong?.id)

        if (audioBuffer) {
          audioEngine.setCurrentUrl(audioUrl)

          if (isPlaying.value || pendingPlay.value) {
            pendingPlay.value = false
            isSwitchingSong.value = false
            await audioEngine.playFromOffset(0, () => {
              // 播放开始时触发 history 记录
              if (currentSong.value) {
                history.startHistoryRecord(currentSong.value, audioEngine)
              }
            })
            startTimeUpdate()
          }
        }
      } catch (e) {
        console.error('[audioStore] 加载歌曲失败:', e)
        isSwitchingSong.value = false
        pendingPlay.value = false
      } finally {
        isLoadingSong = false
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
      } else {
        audioEngine.pausePlayback()
        stopTimeUpdate()
        html5AudioPlayer.pause()
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
      navigator.mediaSession.setActionHandler('play', () => { void forcePlay() })
      navigator.mediaSession.setActionHandler('pause', () => { void forcePause() })
      navigator.mediaSession.setActionHandler('previoustrack', () => { void forcePrevious() })
      navigator.mediaSession.setActionHandler('nexttrack', () => { void forceNext() })
      navigator.mediaSession.setActionHandler('stop', () => { void forcePause() })
    } catch (e) {
      console.warn('[MediaSession] 设置 action handler 失败:', e)
    }
  }
  setupMediaSessionHandlers()

  // 同步播放状态到 MediaSession
  function syncMediaSessionPlaybackState() {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.playbackState = isPlaying.value ? 'playing' : 'paused'
    } catch {
      // 忽略
    }
  }
  syncMediaSessionPlaybackState()
  watch(() => isPlaying.value, syncMediaSessionPlaybackState)

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
    clearAudioBufferCache: () => audioEngine.clearCache(),
    disconnectAnalyser: () => audioEngine.disconnectAnalyser(),
    reconnectAnalyser: () => audioEngine.reconnectAnalyser(),
  }
})
