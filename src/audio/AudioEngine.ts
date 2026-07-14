/**
 * Web Audio API 播放引擎(单例)
 *
 * 设计目标:
 *   - 将 AudioContext / AnalyserNode / GainNode / AudioBufferSourceNode 等
 *     音频节点从 Pinia store 抽离,store 只持有"播放状态"和"业务编排"
 *   - 通过回调注入(onStart/onEnded)与 store 解耦,避免引擎层反向依赖 store
 *   - 单例模式,确保全局唯一音频链路
 *
 * 关键设计(2026-07-14 修复):
 *   - AudioBuffer LRU: current + prev(切回上一首 < 50ms)
 *   - 切歌静音: stopPlayback 时立即 gain.gain = 0,新 source start 前恢复
 *   - 强制唤醒: forceWake() 显式 await audioContext.resume()
 *   - onended 清理: 手动 stop 前先 audioSourceNode.onended = null
 *
 * 调用入口(由 audioStore.ts 注入):
 *   - audioStore 调 engine.playFromOffset(0, song, onStart)
 *   - audioStore 调 engine.pausePlayback()
 *   - audioStore 调 engine.stopPlayback() (切歌时)
 *   - audioStore 调 engine.seekTo(time)
 *   - 引擎通过 setOnEnded 注入的回调通知 audioStore 播完
 */

export class AudioEngine {
  // ========== 模块级状态(Web Audio 单例) ==========
  private audioContext: AudioContext | null = null
  private analyserNode: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  private audioSourceNode: AudioBufferSourceNode | null = null

  /** 当前播放歌曲的 AudioBuffer(仅保留一首) */
  private currentBuffer: AudioBuffer | null = null
  private currentBufferUrl: string | null = null
  /** 当前播放歌曲的 URL */
  private currentUrl: string | null = null

  /** LRU 前一首(切回上一首 < 50ms) */
  private prevBuffer: AudioBuffer | null = null
  private prevBufferUrl: string | null = null
  private prevSongId: string | null = null

  /** 暂停时的播放位置(秒),用于恢复播放 */
  private pausedOffset = 0
  /** 播放开始时的 AudioContext 时间 */
  private playbackStartTime = 0
  /** 是否已暂停(用于区分主动暂停和播放结束) */
  private isPaused = false

  /** 当前音量(用于恢复 gain.gain) */
  private currentVolume = 0.8

  // ========== 回调(由 audioStore 注入) ==========
  private _onEnded: (() => void) | null = null
  private _onStart: (() => void) | null = null

  // ========== 公开 API ==========

  /**
   * 初始化 AudioContext 音频链路(必须在用户交互后调用)
   * @param volume 当前音量,用于同步 gain.gain 初始值
   */
  init(volume: number): void {
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
      this.analyserNode = this.audioContext.createAnalyser()
      this.analyserNode.fftSize = 2048
      this.analyserNode.smoothingTimeConstant = 0.8
      this.gainNode = this.audioContext.createGain()
      // 关键: 同步 gain.gain 到当前 volume,避免显示音量与实际音量脱钩
      this.gainNode.gain.value = volume
      this.currentVolume = volume

      this.analyserNode.connect(this.gainNode)
      this.gainNode.connect(this.audioContext.destination)
    }
  }

  /**
   * 获取 AudioBuffer(fetch + decodeAudioData,LRU 保留前一首)
   * 阶段 3.3: 支持 LRU, 切回上一首 < 50ms
   * @param url 音频文件 URL
   * @param songId 歌曲 ID,用于 prev 槽匹配(防止 ID 复用错位)
   * @param currentSongId 当前播放歌曲 ID,用于 prev 槽降级时记录
   */
  async getAudioBuffer(url: string, songId: string, currentSongId?: string): Promise<AudioBuffer | null> {
    // 命中 current
    if (this.currentBuffer && this.currentBufferUrl === url) {
      return this.currentBuffer
    }

    if (!this.audioContext) return null

    // 命中 prev(切回上一首)
    if (songId && this.prevBuffer && this.prevSongId === songId && this.prevBufferUrl === url) {
      // current 降级为 prev
      if (this.currentBuffer) {
        this.prevBuffer = this.currentBuffer
        this.prevBufferUrl = this.currentBufferUrl
        this.prevSongId = currentSongId ?? null
      }
      // prev 提升为 current
      this.currentBuffer = this.prevBuffer
      this.currentBufferUrl = url
      // 清空 prev 槽
      this.prevBuffer = null
      this.prevBufferUrl = null
      this.prevSongId = null
      return this.currentBuffer
    }

    try {
      const response = await fetch(url)
      if (!response.ok) return null
      const arrayBuffer = await response.arrayBuffer()
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer)

      // 旧的 current 降级为 prev
      if (this.currentBuffer) {
        this.prevBuffer = this.currentBuffer
        this.prevBufferUrl = this.currentBufferUrl
        this.prevSongId = currentSongId ?? null
      }
      this.currentBuffer = audioBuffer
      this.currentBufferUrl = url

      return audioBuffer
    } catch (error) {
      console.error('[Audio] AudioBuffer 解码失败:', error)
      return null
    }
  }

  /**
   * 播放歌曲(从指定偏移量开始)
   * @param offset 开始播放位置(秒)
   * @param onStart 播放开始回调(由 audioStore 注入,用于触发 history 记录)
   */
  async playFromOffset(offset: number, onStart?: () => void): Promise<void> {
    if (!this.audioContext || !this.currentUrl) return

    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume()
      } catch {
        return
      }
    }

    const audioBuffer = this.currentBuffer
    if (!audioBuffer) return

    if (this.audioSourceNode) {
      try {
        this.audioSourceNode.onended = null
        this.audioSourceNode.stop()
        this.audioSourceNode.disconnect()
        this.audioSourceNode = null
      } catch {
        // 忽略已停止的节点错误
      }
    }

    const newSource = this.audioContext.createBufferSource()
    newSource.buffer = audioBuffer
    newSource.connect(this.analyserNode!)

    newSource.onended = () => {
      if (!this.isPaused) {
        this.audioSourceNode = null
        this._onEnded?.()
      }
    }

    this.audioSourceNode = newSource
    this.playbackStartTime = this.audioContext.currentTime - offset
    this.isPaused = false

    // 关键: 恢复音量(切歌时 stopPlayback 已将 gain 置 0)
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(this.currentVolume, this.audioContext.currentTime)
    }

    // 触发播放开始回调(用于 history 记录)
    if (onStart) {
      this._onStart = onStart
    }
    this._onStart?.()

    try {
      newSource.start(0, offset)
    } catch (error) {
      console.error('[Audio] AudioBufferSourceNode 启动失败:', error)
      this.audioSourceNode = null
    }
  }

  /**
   * 暂停播放
   */
  pausePlayback(): void {
    if (this.audioSourceNode && this.audioContext && !this.isPaused) {
      try {
        const currentTime = this.audioContext.currentTime - this.playbackStartTime
        this.pausedOffset = currentTime
        this.isPaused = true

        // 先清空 onended,防止手动 stop 触发播放结束回调
        this.audioSourceNode.onended = null
        this.audioSourceNode.stop()
        this.audioSourceNode.disconnect()
        this.audioSourceNode = null
      } catch (e) {
        // 忽略暂停失败
      }
    }
  }

  /**
   * 恢复播放(或从头开始播放)
   */
  async resumePlayback(): Promise<void> {
    if (!this.currentUrl || !this.audioContext) return

    if (this.audioSourceNode && !this.isPaused) return

    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume()
      } catch {
        return
      }
    }

    const offset = this.isPaused ? this.pausedOffset : 0
    await this.playFromOffset(offset)
  }

  /**
   * 停止播放(切歌时调用)
   */
  stopPlayback(): void {
    if (this.audioSourceNode) {
      try {
        // 先清空 onended
        this.audioSourceNode.onended = null
        // 切歌静音: 立即将 gain.gain 设为 0
        // 原因: AudioBufferSourceNode.stop() 是异步的,旧 source 仍会输出旧 buffer 1-2s
        if (this.gainNode && this.audioContext) {
          this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime)
        }
        const oldSource = this.audioSourceNode
        oldSource.buffer = null
        oldSource.stop()
        oldSource.disconnect()
        this.audioSourceNode = null
      } catch (e) {
        // 忽略已停止的节点错误
      }
    }
    this.isPaused = false
    this.pausedOffset = 0
    this.playbackStartTime = 0
  }

  /**
   * 跳转到指定播放位置(秒)
   */
  seekTo(time: number): void {
    if (!this.audioContext || !this.currentUrl) return

    const audioBuffer = this.currentBuffer
    const dur = audioBuffer?.duration || 0
    const clampedTime = Math.max(0, Math.min(time, dur))

    if (this.audioSourceNode || this.isPaused) {
      this.pausedOffset = clampedTime

      if (!this.isPaused) {
        void this.playFromOffset(clampedTime)
      }
    }
  }

  /**
   * 获取当前播放时间(秒)
   */
  getCurrentTime(): number {
    if (!this.audioContext || !this.audioSourceNode || this.isPaused) {
      return this.pausedOffset
    }
    return this.audioContext.currentTime - this.playbackStartTime
  }

  /**
   * 设置音量(0-1),应用到 gain.gain
   */
  setVolume(value: number): void {
    this.currentVolume = value
    if (this.gainNode) {
      this.gainNode.gain.value = value
    }
  }

  /**
   * 获取 AnalyserNode(供频谱组件使用)
   */
  getAnalyserNode(): AnalyserNode | null {
    return this.analyserNode
  }

  /**
   * 设置当前播放歌曲的 URL(由 audioStore 在加载新歌时调用)
   */
  setCurrentUrl(url: string | null): void {
    this.currentUrl = url
  }

  /**
   * 清除音频缓存(AudioBuffer)
   */
  clearCache(): void {
    this.currentBuffer = null
    this.currentBufferUrl = null
    this.currentUrl = null
    this.prevBuffer = null
    this.prevBufferUrl = null
    this.prevSongId = null
  }

  /**
   * 恢复 AudioContext 运行状态(窗口显示时调用)
   */
  resumeContext(): void {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {})
    }
  }

  /**
   * 强制唤醒 AudioContext(命令式,幂等)
   * 用途: 托盘/快捷键/媒体键触发时,WebView 刚从 frozen 恢复
   */
  async forceWake(): Promise<void> {
    if (!this.audioContext) return
    if (this.audioContext.state === 'suspended' || this.audioContext.state === 'closed') {
      try {
        await this.audioContext.resume()
      } catch {
        // 忽略唤醒失败
      }
    }
  }

  /**
   * 断开频谱分析链路(低功耗模式下节省 CPU)
   */
  disconnectAnalyser(): void {
    if (this.audioSourceNode && this.analyserNode && this.gainNode && this.audioContext) {
      try {
        this.audioSourceNode.disconnect()
        this.audioSourceNode.connect(this.gainNode)
      } catch (e) {
        // 忽略断开失败
      }
    }
  }

  /**
   * 重新连接频谱分析链路
   */
  reconnectAnalyser(): void {
    if (this.audioSourceNode && this.analyserNode && this.gainNode && this.audioContext) {
      try {
        this.audioSourceNode.disconnect()
        this.audioSourceNode.connect(this.analyserNode)
      } catch (e) {
        // 忽略重连失败
      }
    }
  }

  /**
   * 设置播放结束回调(由 audioStore 注入)
   */
  setOnEnded(callback: (() => void) | null): void {
    this._onEnded = callback
  }

  /**
   * 获取引擎状态(供 audioStore 决策)
   */
  get state() {
    return {
      isPaused: this.isPaused,
      hasSource: !!this.audioSourceNode,
      hasContext: !!this.audioContext,
      contextState: this.audioContext?.state ?? 'closed',
    }
  }

  /**
   * 获取底层 AudioContext (供 historyStore 等需要读取 currentTime 的模块使用)
   */
  getAudioContext(): AudioContext | null {
    return this.audioContext
  }
}

/// 全局单例
export const audioEngine = new AudioEngine()
