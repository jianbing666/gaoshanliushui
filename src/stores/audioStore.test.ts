import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Song } from '@/types/song'

// store 层单测: mock 掉 Tauri IPC 与 Web Audio 引擎, 只验证 store 自身的状态机。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: vi.fn((path: string) => 'asset://localhost/' + encodeURIComponent(path)),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))
vi.mock('tauri-plugin-media-api', () => ({
  mediaControls: {
    initialize: vi.fn(async () => {}),
    updateNowPlaying: vi.fn(async () => {}),
    updatePlaybackStatus: vi.fn(async () => {}),
  },
  // 值只需在 store 内被原样传递
  PlaybackStatus: { Playing: 'playing', Paused: 'paused' },
}))
vi.mock('@/audio/AudioEngine', () => {
  const audioEngine = {
    state: { hasSource: false, isPaused: true },
    init: vi.fn(),
    getAudioBuffer: vi.fn(async () => null),
    getLastTimings: vi.fn(() => null),
    isStreaming: false,
    setStreamingMode: vi.fn(),
    prefetch: vi.fn(async () => {}),
    playFromOffset: vi.fn(async () => {}),
    pausePlayback: vi.fn(),
    stopPlayback: vi.fn(),
    resumePlayback: vi.fn(async () => {}),
    resumeContext: vi.fn(async () => {}),
    forceWake: vi.fn(async () => {}),
    setVolume: vi.fn(),
    setLoudnessEnabled: vi.fn(),
    setLoudnessMode: vi.fn(),
    seekTo: vi.fn(),
    getAnalyserNode: vi.fn(() => null),
    disconnectAnalyser: vi.fn(),
    reconnectAnalyser: vi.fn(),
    setCurrentUrl: vi.fn(),
    setOnEnded: vi.fn(),
    clearCache: vi.fn(),
  }
  return { audioEngine }
})
vi.mock('@/audio/HTML5AudioPlayer', () => {
  const html5AudioPlayer = {
    bindStoreAccessors: vi.fn(),
    onDurationChange: vi.fn(),
    setVolume: vi.fn(),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    load: vi.fn(async () => {}),
    setMediaSession: vi.fn(),
  }
  return { html5AudioPlayer }
})
vi.mock('./historyStore', () => ({
  useHistoryStore: () => ({
    songPlayCount: {},
    songCompletedCount: {},
    songLastPlayedAt: {},
    startHistoryRecord: vi.fn(),
    endHistoryRecord: vi.fn(),
    startHistoryRecordIfAbsent: vi.fn(),
    recordPlay: vi.fn(),
  }),
}))

import { audioEngine } from '@/audio/AudioEngine'
import { useAudioStore } from './audioStore'
import { useLibraryStore } from './libraryStore'

function song(id: string): Song {
  return {
    id,
    file_path: '/music/' + id + '.mp3',
    title: id,
    artist: '测试歌手',
    album: '',
    duration: 120,
    cover_path: null,
    cover_thumb_path: null,
    content_hash: '',
    favorite: false,
    favorited_at: 0,
  } as Song
}

/** 等待 store 内部 watcher / 异步链跑完 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function setupStore() {
  setActivePinia(createPinia())
  const library = useLibraryStore()
  library.playlist = [song('a'), song('b'), song('c')]
  library.currentIndex = 1
  library.playlists = [{ id: '1', name: '全部歌曲', type: 'default', songIds: [] }]
  library.activePlaylistId = '1'
  const audio = useAudioStore()
  return { library, audio }
}

describe('audioStore 状态机', () => {
  beforeEach(() => {
    vi.mocked(audioEngine.getAudioBuffer).mockClear()
  })

  it('toggleMute 在静音与上次音量之间切换', () => {
    const { audio } = setupStore()
    audio.volume = 0.8
    audio.toggleMute()
    expect(audio.volume).toBe(0)
    expect(audio.lastVolume).toBe(0.8)
    audio.toggleMute()
    expect(audio.volume).toBe(0.8)
  })

  it('toggleLoopMode 按 list -> single -> shuffle -> none -> list 循环', () => {
    const { audio } = setupStore()
    expect(audio.loopMode).toBe('list')
    audio.toggleLoopMode()
    expect(audio.loopMode).toBe('single')
    audio.toggleLoopMode()
    expect(audio.loopMode).toBe('shuffle')
    audio.toggleLoopMode()
    expect(audio.loopMode).toBe('none')
    audio.toggleLoopMode()
    expect(audio.loopMode).toBe('list')
  })

  it('play/pause 切换 isPlaying', () => {
    const { audio } = setupStore()
    audio.play()
    expect(audio.isPlaying).toBe(true)
    audio.pause()
    expect(audio.isPlaying).toBe(false)
  })

  it('list 模式 next() 前进一首并释放切歌锁', async () => {
    const { library, audio } = setupStore()
    expect(audio.loopMode).toBe('list')
    audio.next()
    expect(library.currentIndex).toBe(2)
    expect(audio.isSwitchingSong).toBe(true)
    await flush()
    // 引擎返回 null(模拟加载失败) 时 store 必须复位切歌锁, 不能卡死
    expect(audio.isSwitchingSong).toBe(false)
    expect(audio.isPlaying).toBe(false)
  })

  it('list 模式到末尾后 next() 回绕到第一首', async () => {
    const { library, audio } = setupStore()
    library.currentIndex = 2
    audio.next()
    expect(library.currentIndex).toBe(0)
    await flush()
  })

  it('list 模式在首曲 prev() 回绕到最后一首', async () => {
    const { library, audio } = setupStore()
    library.currentIndex = 0
    audio.prev()
    expect(library.currentIndex).toBe(2)
    await flush()
  })

  it('hasNext/hasPrev 在 list 模式下始终为 true(可回绕)', () => {
    const { library, audio } = setupStore()
    library.currentIndex = 2
    expect(audio.hasNext).toBe(true)
    expect(audio.hasPrev).toBe(true)
  })

  it('none 模式在末尾时 hasNext 为 false', () => {
    const { library, audio } = setupStore()
    audio.toggleLoopMode() // single
    audio.toggleLoopMode() // shuffle
    audio.toggleLoopMode() // none
    expect(audio.loopMode).toBe('none')
    library.currentIndex = 2
    expect(audio.hasNext).toBe(false)
    library.currentIndex = 1
    expect(audio.hasNext).toBe(true)
    expect(audio.hasPrev).toBe(true)
    library.currentIndex = 0
    expect(audio.hasPrev).toBe(false)
  })

  it('getRandomIndex 结果始终落在歌单范围内', () => {
    const { audio } = setupStore()
    for (let i = 0; i < 50; i++) {
      const index = audio.getRandomIndex()
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(3)
    }
  })

  it('seekTo 同步 currentTime 到引擎', () => {
    const { audio } = setupStore()
    audio.duration = 200
    audio.seekTo(42)
    expect(audio.currentTime).toBe(42)
    expect(audioEngine.seekTo).toHaveBeenCalledWith(42)
  })
})
