import { convertFileSrc } from '@tauri-apps/api/core'

/**
 * 音频播放器封装类
 * 使用 Tauri convertFileSrc 将本地路径转为 asset:// 协议 URL
 */
export class AudioPlayer {
  private audio: HTMLAudioElement
  private _onTimeUpdate: ((time: number) => void) | null = null
  private _onEnded: (() => void) | null = null
  private _onDurationChange: ((duration: number) => void) | null = null
  private _onPlay: (() => void) | null = null
  private _onPause: (() => void) | null = null

  constructor() {
    this.audio = new Audio()
    this.audio.preload = 'metadata'

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

  /** 加载本地音频文件（通过 Tauri convertFileSrc 转换路径） */
  async load(filePath: string) {
    // 将本地文件路径转为 Tauri asset:// 协议 URL
    const url = convertFileSrc(filePath)
    this.audio.src = url
    this.audio.load()
  }

  /** 播放 */
  async play(): Promise<void> {
    try {
      await this.audio.play()
    } catch (e) {
      console.error('播放失败:', e)
    }
  }

  /** 暂停 */
  pause() {
    this.audio.pause()
  }

  /** 跳转到指定时间（秒） */
  seek(time: number) {
    if (isFinite(time) && time >= 0) {
      this.audio.currentTime = time
    }
  }

  /** 设置音量（0-1） */
  setVolume(volume: number) {
    this.audio.volume = Math.max(0, Math.min(1, volume))
  }

  /** 获取当前播放时间 */
  get currentTime(): number {
    return this.audio.currentTime
  }

  /** 获取总时长 */
  get duration(): number {
    return this.audio.duration || 0
  }

  /** 获取是否正在播放 */
  get playing(): boolean {
    return !this.audio.paused
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

  /** 设置 Media Session 元数据（支持系统媒体键） */
  setMediaSession(title: string, artist: string, coverUrl?: string) {
    if (!('mediaSession' in navigator)) return

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      artwork: coverUrl ? [{ src: coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
    })

    navigator.mediaSession.setActionHandler('play', () => this.play())
    navigator.mediaSession.setActionHandler('pause', () => this.pause())
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
export const audioPlayer = new AudioPlayer()
