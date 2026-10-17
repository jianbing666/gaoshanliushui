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
 * 音频链路 (v1.2.0 + EQ + 响度均衡):
 *   AudioBufferSourceNode → Equalizer(10段) → AnalyserNode
 *     → [响度均衡启用时: LoudnessGain → Limiter]
 *     → GainNode(用户音量) → Destination
 *
 * 调用入口(由 audioStore.ts 注入):
 *   - audioStore 调 engine.playFromOffset(0, song, onStart)
 *   - audioStore 调 engine.pausePlayback()
 *   - audioStore 调 engine.stopPlayback() (切歌时)
 *   - audioStore 调 engine.seekTo(time)
 *   - 引擎通过 setOnEnded 注入的回调通知 audioStore 播完
 */

import { equalizer } from './Equalizer'
import { loudnessNormalizer } from './LoudnessNormalizer'
import type { LoudnessMode } from './LoudnessNormalizer'
import type { SwitchTimingsInput } from '../utils/switchSegments'

/**
 * 引擎采集的切歌分段原始计时（P0 定位用，不参与任何播放决策）
 * 由 audioStore 在切歌完成后读取并通过 perf:switch-trace 交给记录器。
 */
export interface EngineSwitchTimings extends SwitchTimingsInput {
  songId: string
}

export class AudioEngine {
  // ========== 模块级状态(Web Audio 单例) ==========
  private audioContext: AudioContext | null = null
  private analyserNode: AnalyserNode | null = null
  private gainNode: GainNode | null = null
  private audioSourceNode: AudioBufferSourceNode | null = null

  /** 当前播放歌曲的 AudioBuffer(仅保留一首) */
  private currentBuffer: AudioBuffer | null = null
  private currentBufferUrl: string | null = null
  /** 当前播放歌曲的 ID (引擎内部维护, 用于 LRU 槽位降级时正确标注) */
  private currentSongId: string | null = null
  /** 当前播放歌曲的 URL */
  private currentUrl: string | null = null

  /** LRU 前一首(切回上一首 < 50ms) */
  private prevBuffer: AudioBuffer | null = null
  private prevBufferUrl: string | null = null
  private prevSongId: string | null = null

  /**
   * 异步加载序号 (防止并发 fetch/decode 乱序污染缓存槽)
   * 每次发起新加载 +1, 解码完成后若序号已过期则不写入 current/prev 槽
   */
  private bufferLoadSeq = 0

  /**
   * 最近一次切歌的分段计时（P0 定位用）
   * getAudioBuffer 记录 fetch/decode，playFromOffset 补齐 start 两段；
   * 仅观测，不改变任何播放行为。
   */
  private lastTimings: EngineSwitchTimings | null = null

  /** 暂停时的播放位置(秒),用于恢复播放 */
  private pausedOffset = 0
  /** 播放开始时的 AudioContext 时间 */
  private playbackStartTime = 0
  /** 是否已暂停(用于区分主动暂停和播放结束) */
  private isPaused = false

  /** 当前音量(用于恢复 gain.gain) */
  private currentVolume = 0.8

  /** 切歌静音锁: stopPlayback 时设为 true, playFromOffset 成功启动新 source 后设为 false
   *  防止旧 source 停止过程中发出任何声音, 也防止新 source 启动前的静音状态被误恢复 */
  private isMutedForSwitch = false

  /** 响度均衡启用标记（由 audioStore 同步设置页开关）
   *  context 初始化前先拨动开关时仅记录标记, init() 建链后按标记接入 */
  private loudnessEnabled = false

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
      this.gainNode.gain.value = volume
      this.currentVolume = volume

      this.analyserNode.connect(this.gainNode)
      this.gainNode.connect(this.audioContext.destination)

      equalizer.init(this.audioContext, this.analyserNode)

      // 建链完成: 若开关此前已打开（context 未建时只存了标记），立即接入响度链路
      if (this.loudnessEnabled) {
        loudnessNormalizer.start(this.analyserNode, this.gainNode)
      }
    }
  }

  /**
   * 获取 AudioBuffer(fetch + decodeAudioData,LRU 保留前一首)
   * 阶段 3.3: 支持 LRU, 切回上一首 < 50ms
   * @param url 音频文件 URL
   * @param songId 歌曲 ID,用于 prev 槽匹配(防止 ID 复用错位)
   *
   * 2026-09 修复:
   *   - prev 槽提升为 current 时, 先用局部变量保存 prev 引用再做降级,
   *     修复"点击上一首却播放旧 current 音频"的引用覆盖 Bug
   *   - currentSongId 由引擎内部维护, 降级时标注不再依赖外部传参
   *   - bufferLoadSeq 防止并发加载乱序完成时污染缓存槽
   */
  async getAudioBuffer(url: string, songId: string): Promise<AudioBuffer | null> {
    // 命中 current
    if (this.currentBuffer && this.currentBufferUrl === url) {
      this.currentSongId = songId
      // 使任何在途的旧加载失效, 防止其完成后污染缓存槽
      this.bufferLoadSeq++
      this.recordCacheHit(songId)
      return this.currentBuffer
    }

    if (!this.audioContext) return null

    // 命中 prev(切回上一首)
    if (songId && this.prevBuffer && this.prevSongId === songId && this.prevBufferUrl === url) {
      // 槽位发生调整, 使在途加载失效
      this.bufferLoadSeq++
      // 先保存要提升的 prev buffer 引用 (若先覆盖 prevBuffer 会丢失它!)
      const promotedBuffer = this.prevBuffer

      // current 降级为 prev
      if (this.currentBuffer) {
        this.prevBuffer = this.currentBuffer
        this.prevBufferUrl = this.currentBufferUrl
        this.prevSongId = this.currentSongId
      } else {
        this.prevBuffer = null
        this.prevBufferUrl = null
        this.prevSongId = null
      }

      // prev 提升为 current
      this.currentBuffer = promotedBuffer
      this.currentBufferUrl = url
      this.currentSongId = songId
      this.recordCacheHit(songId)
      return this.currentBuffer
    }

    const reqId = ++this.bufferLoadSeq
    try {
      // 分段计时: fetch(含读取) / decode 分开记，便于定位瓶颈在哪一段
      const fetchStartedAt = performance.now()
      const response = await fetch(url)
      if (!response.ok) return null
      const arrayBuffer = await response.arrayBuffer()
      const fetchEndedAt = performance.now()
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer)
      const decodeEndedAt = performance.now()
      // 先落计时再判并发：过期加载同样要留下样本，否则"连切"时样本会缺失
      this.lastTimings = {
        songId,
        cacheHit: false,
        fetchMs: fetchEndedAt - fetchStartedAt,
        decodeMs: decodeEndedAt - fetchEndedAt,
        startPrepMs: 0,
        startCallMs: 0,
      }

      // 并发保护: 解码期间又发起了更新的加载, 本次结果已过期,
      // 不写入缓存槽 (调用方也会通过世代令牌丢弃本次播放)
      if (reqId !== this.bufferLoadSeq) {
        return audioBuffer
      }

      // 旧的 current 降级为 prev (songId 用引擎内部记录, 保证标注正确)
      if (this.currentBuffer) {
        this.prevBuffer = this.currentBuffer
        this.prevBufferUrl = this.currentBufferUrl
        this.prevSongId = this.currentSongId
      }
      this.currentBuffer = audioBuffer
      this.currentBufferUrl = url
      this.currentSongId = songId

      return audioBuffer
    } catch (error) {
      console.error('[Audio] AudioBuffer 解码失败:', error)
      return null
    }
  }

  /**
   * 读取最近一次切歌的分段计时（无样本时为 null）
   * 仅供性能定位使用，调用方负责把原始毫秒取整归档。
   */
  getLastTimings(): EngineSwitchTimings | null {
    return this.lastTimings ? { ...this.lastTimings } : null
  }

  /** 记录一次 LRU 命中的切歌（无 fetch / decode 开销） */
  private recordCacheHit(songId: string): void {
    this.lastTimings = {
      songId,
      cacheHit: true,
      fetchMs: 0,
      decodeMs: 0,
      startPrepMs: 0,
      startCallMs: 0,
    }
  }

  /**
   * 播放歌曲(从指定偏移量开始)
   * @param offset 开始播放位置(秒)
   * @param onStart 播放开始回调(由 audioStore 注入,用于触发 history 记录)
   */
  async playFromOffset(offset: number, onStart?: () => void): Promise<void> {
    const enteredAt = performance.now()
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
    equalizer.reconnectSource(newSource)

    newSource.onended = () => {
      if (!this.isPaused) {
        this.audioSourceNode = null
        this._onEnded?.()
      }
    }

    this.audioSourceNode = newSource
    this.playbackStartTime = this.audioContext.currentTime - offset
    this.isPaused = false

    // 触发播放开始回调(用于 history 记录)
    if (onStart) {
      this._onStart = onStart
    }
    this._onStart?.()
    // 分段计时: onStart 之前为 startPrep(唤醒/拆旧/建链/回调)，之后为 startCall(实际启动)
    const startPrepEndedAt = performance.now()

    try {
      // 先启动 source (此时 gain 仍为 0, 不会发声)
      newSource.start(0, offset)
      // 再恢复音量: 确保新 source 已经开始渲染, 才解除静音
      // 这样既不会有旧声音残留, 也不会有新声音的开头被截断
      if (this.gainNode) {
        this.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime)
        this.gainNode.gain.setValueAtTime(this.currentVolume, this.audioContext.currentTime)
      }
      this.isMutedForSwitch = false
      // 复位响度测量: 切歌/seek 后不沿用上一段内容的补偿增益（未启用时为 no-op）
      loudnessNormalizer.reset()
    } catch (error) {
      console.error('[Audio] AudioBufferSourceNode 启动失败:', error)
      this.audioSourceNode = null
    } finally {
      // 仅补计时，不改变任何播放行为；恢复/seek 入口也会经过这里，
      // 但记录器只认 audioStore 在切歌链路派发的 perf:switch-trace，不会误采。
      if (this.lastTimings) {
        this.lastTimings.startPrepMs = startPrepEndedAt - enteredAt
        this.lastTimings.startCallMs = performance.now() - startPrepEndedAt
      }
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
      } catch {
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
   *
   * 切歌静音策略(三层防护):
   *   1. gain.gain 立即设为 0 (最直接, 任何残留声音都会被静音)
   *   2. isMutedForSwitch = true (静音锁, 防止 setVolume 等意外恢复音量)
   *   3. 旧 source 置空 buffer + stop + disconnect (彻底清理)
   *
   * 这样即使 AudioBufferSourceNode.stop() 是异步的,
   * 在 stopPlayback() 返回的瞬间, 也绝对不会有任何声音输出.
   */
  stopPlayback(): void {
    // 第 1 层: 立即静音 + 静音锁 (在操作 source 之前就锁死, 确保零延迟)
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime)
      this.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime)
    }
    this.isMutedForSwitch = true

    if (this.audioSourceNode) {
      try {
        // 第 2 层: 清空 onended, 防止手动 stop 触发播放结束回调
        this.audioSourceNode.onended = null
        // 第 3 层: 置空 buffer + stop + disconnect, 彻底切断旧 source
        const oldSource = this.audioSourceNode
        oldSource.buffer = null
        oldSource.stop()
        oldSource.disconnect()
        this.audioSourceNode = null
      } catch {
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
   * 切歌静音锁激活时, 只更新 currentVolume 但不应用到 gain,
   * 等 playFromOffset 成功启动新 source 后再恢复
   */
  setVolume(value: number): void {
    this.currentVolume = value
    if (this.gainNode && !this.isMutedForSwitch) {
      this.gainNode.gain.value = value
    }
  }

  /**
   * 开关响度均衡（由 audioStore 监听设置页开关后调用）
   * context 尚未初始化时仅保存标记，init() 建链时按标记接入；
   * 已初始化则立即改链接入 / 断开恢复
   */
  setLoudnessEnabled(value: boolean): void {
    this.loudnessEnabled = value
    if (this.audioContext && this.analyserNode && this.gainNode) {
      if (value) {
        loudnessNormalizer.start(this.analyserNode, this.gainNode)
      } else {
        loudnessNormalizer.stop(this.analyserNode, this.gainNode)
      }
    }
  }

  /**
   * 设置响度测量模式（RMS 标准 / LUFS 高精度）
   * 直接转发给 normalizer：未启用时仅记录，start() 建链时按该模式测量；启用中立即切换
   */
  setLoudnessMode(mode: LoudnessMode): void {
    loudnessNormalizer.setMode(mode)
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
    this.bufferLoadSeq++
    this.currentBuffer = null
    this.currentBufferUrl = null
    this.currentSongId = null
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
   * 注意: 同时会绕过均衡器, 直接 source → gain
   * 响度均衡启用时一并断开响度链路（analyser 已无输入，停测量、恢复 analyser → gain）
   */
  disconnectAnalyser(): void {
    if (this.audioSourceNode && this.analyserNode && this.gainNode && this.audioContext) {
      try {
        equalizer.disconnect()
        if (this.loudnessEnabled) {
          loudnessNormalizer.stop(this.analyserNode, this.gainNode)
        }
        this.audioSourceNode.connect(this.gainNode)
      } catch {
        // 忽略断开失败
      }
    }
  }

  /**
   * 重新连接频谱分析链路 (同时恢复均衡器)
   * 响度均衡启用时一并重新接入响度链路
   */
  reconnectAnalyser(): void {
    if (this.audioSourceNode && this.analyserNode && this.gainNode && this.audioContext) {
      try {
        this.audioSourceNode.disconnect()
        equalizer.reconnectSource(this.audioSourceNode)
        if (this.loudnessEnabled) {
          loudnessNormalizer.start(this.analyserNode, this.gainNode)
        }
      } catch {
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
