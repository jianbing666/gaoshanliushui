import { convertFileSrc } from '@tauri-apps/api/core'

/**
 * HTML5 Audio 元素包装(元数据 + MediaSession 专用)
 *
 * 用途: 仅用于获取音频元数据 (duration) 和作为 MediaSession 的媒体源.
 * 实际播放完全由 Web Audio API (AudioBufferSourceNode) 处理.
 *
 * 关键设计:
 *   - 永远不调用 audio.play() (避免 WebView2 中 volume=0 失效导致切歌时短暂听到 HTML5 Audio)
 *   - 仅加载 (src=url, load()), 触发 canplay 获取 duration, 立即暂停保持 paused 状态
 *   - MediaSession.playbackState 由 store 直接控制, 不依赖 audio 的实际 play/pause 状态
 *
 * 迁移说明 (架构分离 v1):
 *   - 原位置: src/utils/audioPlayer.ts
 *   - 新位置: src/audio/HTML5AudioPlayer.ts
 *   - 内部实现零改动, 仅迁移路径
 */
export class HTML5AudioPlayer {
  private audio: HTMLAudioElement
  private _onTimeUpdate: ((time: number) => void) | null = null
  private _onEnded: (() => void) | null = null
  private _onDurationChange: ((duration: number) => void) | null = null
  private _onPlay: (() => void) | null = null
  private _onPause: (() => void) | null = null

  // 修复 2026-07-14: 之前 audioPlayer 在 canplay 时调用 audio.play() 触发了
  //   HTML5 Audio 的短暂播放 (WebView2 中 volume=0 在 src 切换瞬间不可靠),
  //   导致切歌时用户能听到旧歌开头 0-1s.
  // 现在 audioPlayer 完全不调用 play/pause, 所有状态由 Web Audio 链路管理.
  // 保留 setIsSwitchingSong 入口 (用于切歌完成后清锁).
  private _setIsSwitchingSong: ((v: boolean) => void) | null = null

  constructor() {
    this.audio = new Audio()
    this.audio.preload = 'metadata'
    // 关键: volume 设为 0, 且 muted = true 双保险,
    //   防止 WebView2 在 src 切换瞬间 volume=0 失效
    this.audio.volume = 0
    this.audio.muted = true

    this.audio.addEventListener('timeupdate', () => {
      this._onTimeUpdate?.(this.audio.currentTime)
    })

    this.audio.addEventListener('ended', () => {
      this._onEnded?.()
    })

    this.audio.addEventListener('durationchange', () => {
      const dur = this.audio.duration
      if (isFinite(dur) && dur > 0) {
        this._onDurationChange?.(dur)
      }
    })

    this.audio.addEventListener('loadedmetadata', () => {
      const dur = this.audio.duration
      if (isFinite(dur) && dur > 0) {
        this._onDurationChange?.(dur)
      }
    })

    this.audio.addEventListener('play', () => {
      this._onPlay?.()
    })

    this.audio.addEventListener('pause', () => {
      this._onPause?.()
    })

    this.audio.addEventListener('error', () => {
      const err = this.audio.error
      console.error('音频加载错误:', err?.message, 'code:', err?.code, 'src:', this.audio.src)
    })
  }

  /**
   * 绑定 store 状态的访问器
   */
  bindStoreAccessors(accessors: {
    setIsSwitchingSong: (v: boolean) => void
  }) {
    this._setIsSwitchingSong = accessors.setIsSwitchingSong
  }

  /**
   * 加载本地音频文件 (通过 Tauri convertFileSrc 转换路径), 等待 canplay 后 resolve
   *
   * 修复 2026-07-14: 之前在 canplay 中调用 audio.play(), 触发 WebView2 中
   *   HTML5 Audio 的短暂播放 (即使 volume=0 在 src 切换瞬间可能失效),
   *   导致切歌时用户能听到旧歌开头 0-1s.
   * 现在: 加载完成后立即 pause, 永远不调用 play(). MediaSession.playbackState
   *   由 store 直接设置, 不依赖 HTML5 Audio 的 play/pause 状态.
   */
  async load(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = convertFileSrc(filePath)

      const handleCanPlay = () => {
        cleanup()
        // 立即 reset currentTime = 0, 立即 pause
        // 双保险: muted=true + volume=0 + paused 状态, 杜绝任何发声可能
        this.audio.currentTime = 0
        this.audio.pause()
        this._setIsSwitchingSong?.(false)
        resolve()
      }

      const handleError = () => {
        cleanup()
        reject(new Error('音频加载失败'))
      }

      const cleanup = () => {
        this.audio.removeEventListener('canplay', handleCanPlay)
        this.audio.removeEventListener('error', handleError)
      }

      this.audio.addEventListener('canplay', handleCanPlay)
      this.audio.addEventListener('error', handleError)

      this.audio.src = url
      this.audio.load()
    })
  }

  /**
   * 播放 (保留 API 但不实际播放, 仅同步 MediaSession)
   * 实际播放由 Web Audio API 的 AudioBufferSourceNode 处理
   */
  async play(): Promise<void> {
    // 修复 2026-07-14: 不再调用 audio.play(), 避免 WebView2 短暂播放 HTML5 Audio
    // 进度更新完全由 store 的 timeUpdateInterval 轮询 Web Audio currentTime
  }

  /** 暂停 (空操作, 实际暂停由 Web Audio 处理) */
  pause() {
    // 空操作: HTML5 Audio 始终保持 paused 状态
  }

  /** 跳转到指定时间 (秒) - 仅同步到 HTML5 Audio 用于 MediaSession 显示 */
  seek(time: number) {
    if (isFinite(time) && time >= 0 && this.audio.duration) {
      try {
        this.audio.currentTime = time
      } catch {
        // 某些情况下设置 currentTime 会失败, 忽略
      }
    }
  }

  /**
   * 设置音量 (0-1) - 永远强制设为 0, HTML5 Audio 不输出声音
   * 修复 2026-07-14: WebView2 中 src 切换瞬间 volume=0 可能被覆盖,
   *   这里强制覆盖回 0 + muted, 杜绝任何发声可能
   */
  setVolume(_volume: number) {
    this.audio.volume = 0
    this.audio.muted = true
  }

  /** 获取当前播放时间 */
  get currentTime(): number {
    return this.audio.currentTime
  }

  /** 获取总时长 */
  get duration(): number {
    return this.audio.duration || 0
  }

  /** 获取是否正在播放 (始终返回 false, 实际状态由 Web Audio 管理) */
  get playing(): boolean {
    return false
  }

  /** 获取总时长 (方法形式, 供外部调用) */
  getDuration(): number {
    return this.audio.duration || 0
  }

  /** 获取内部音频元素 (供频谱组件使用) */
  getAudioElement(): HTMLAudioElement {
    return this.audio
  }

  // ========== 事件回调设置 ==========

  onTimeUpdate(callback: (time: number) => void) {
    this._onTimeUpdate = callback
  }

  onEnded(callback: () => void) {
    this._onEnded = callback
  }

  onDurationChange(callback: (duration: number) => void) {
    this._onDurationChange = callback
  }

  onPlay(callback: () => void) {
    this._onPlay = callback
  }

  onPause(callback: () => void) {
    this._onPause = callback
  }

  /**
   * 设置 Media Session 元数据 (仅元数据, action handler 由 store 统一管理)
   */
  setMediaSession(title: string, artist: string, coverUrl?: string) {
    if (!('mediaSession' in navigator)) return

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      artwork: coverUrl ? [{ src: coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
    })
  }

  /** 销毁播放器 */
  destroy() {
    this.audio.pause()
    this.audio.src = ''
    this._onTimeUpdate = null
    this._onEnded = null
    this._onDurationChange = null
    this._onPlay = null
    this._onPause = null
  }
}

// 全局单例
export const html5AudioPlayer = new HTML5AudioPlayer()
