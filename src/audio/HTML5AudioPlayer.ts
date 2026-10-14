import { convertFileSrc } from '@tauri-apps/api/core'

/**
 * HTML5 Audio 元素包装(元数据 + MediaSession 专用)
 *
 * 用途: 仅用于获取音频元数据 (duration) 和作为 MediaSession 的媒体源.
 * 实际播放完全由 Web Audio API (AudioBufferSourceNode) 处理.
 *
 * 关键设计:
 *   - 永远不实际发声: volume=0 + muted=true 双保险, 即使 audio.play() 也无声
 *   - audio 元素保持 playing 状态: 这是让 OS 把 MediaKey 路由到 WebView 的关键
 *   - MediaSession.playbackState 由 store 直接控制
 *
 * 修复 2026-07-14 (v1.1.0 外部设备失效):
 *   - v1.0.0 时期 audio.play() 真正调用, MediaSession 被 OS 正确识别, 蓝牙耳机可用
 *   - v1.1.0 重构后 audio 永远 paused, OS 不再分发 MediaKey → 蓝牙耳机/键盘多媒体键失效
 *   - 现在: 加载完成后保持 paused=false (muted+volume=0 静音), OS 仍可识别媒体源
 *     但不会发出任何声音
 */
export class HTML5AudioPlayer {
  private audio: HTMLAudioElement
  private _onTimeUpdate: ((time: number) => void) | null = null
  private _onEnded: (() => void) | null = null
  private _onDurationChange: ((duration: number) => void) | null = null
  private _onPlay: (() => void) | null = null
  private _onPause: (() => void) | null = null

  // 2026-07-14: 保留 store 切歌状态通知入口
  private _setIsSwitchingSong: ((v: boolean) => void) | null = null

  constructor() {
    this.audio = new Audio()
    this.audio.preload = 'metadata'
    // 关键: volume 设为 0, 且 muted = true 双保险,
    //   防止 WebView2 在 src 切换瞬间 volume=0 失效
    this.audio.volume = 0
    this.audio.muted = true
    // 关键: 循环播放, 永远不 ended, 保持 playing 状态
    //   这样 OS 才会持续把 MediaKey 事件路由到 WebView
    this.audio.loop = true

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
  bindStoreAccessors(accessors: { setIsSwitchingSong: (v: boolean) => void }) {
    this._setIsSwitchingSong = accessors.setIsSwitchingSong
  }

  /**
   * 加载本地音频文件 (通过 Tauri convertFileSrc 转换路径), 等待 canplay 后 resolve
   *
   * 修复 2026-07-14 (v1.1.0 外部设备失效):
   *   - 之前 canplay 后立即 pause, 让 audio 永远 paused, OS 不分发 MediaKey
   *   - 现在 canplay 后保持 playing 状态 (muted+volume=0 静音, 无声)
   *     操作系统能正确识别"这是一个正在播放的媒体源", 把蓝牙耳机/键盘
   *     多媒体键的 MediaKey 事件路由给 WebView → 触发 MediaSession action handler
   */
  async load(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = convertFileSrc(filePath)

      const handleCanPlay = () => {
        cleanup()
        // 重置到开头
        this.audio.currentTime = 0
        // 保持 playing 状态 (muted=true + volume=0 不会发声)
        // 这样 OS 才能识别 mediaSession 媒体源, 外部设备 MediaKey 才能路由到 WebView
        if (this.audio.paused) {
          this.audio.play().catch((e) => {
            console.warn('[HTML5AudioPlayer] 自动播放失败:', e)
            // 静默失败: 不影响功能, OS 路由会退化但 Web Audio 主链路不受影响
          })
        }
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
   * 播放 (保持 audio 元素在 playing 状态, 由 OS 分发 MediaKey)
   * 实际播放由 Web Audio API 的 AudioBufferSourceNode 处理
   */
  async play(): Promise<void> {
    // 2026-07-14: 调用 audio.play() 让 OS 识别媒体源, 触发 MediaKey 路由
    //   muted=true + volume=0 绝对静音, 不会发出任何声音
    if (this.audio.paused && this.audio.src) {
      try {
        await this.audio.play()
      } catch {
        // 静默: autoplay 策略被拒时不影响主链路
      }
    }
  }

  /**
   * 暂停 (让 audio 元素 paused=true, 同步 MediaSession.playbackState)
   */
  pause() {
    if (!this.audio.paused) {
      this.audio.pause()
    }
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
