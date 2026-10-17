/**
 * Web Audio API 播放引擎(单例)
 *
 * 设计目标:
 *   - 将 AudioContext / AnalyserNode / GainNode / AudioBufferSourceNode 等
 *     音频节点从 Pinia store 抽离,store 只持有"播放状态"和"业务编排"
 *   - 通过回调注入(onStart/onEnded)与 store 解耦,避免引擎层反向依赖 store
 *   - 单例模式,确保全局唯一音频链路
 *
 * 关键设计:
 *   - AudioBuffer LRU: 按 songId 归档的 3 首字典缓存(当前 / 上一首 / 预解码的下一首)
 *   - 预解码: 当前曲目开始播放后把下一首解好,把 84.5% 的 decode 开销挪出切歌关键路径
 *
 * 历史修复(2026-07-14):
 *   - 切歌静音三层防护(见 stopPlayback / isMutedForSwitch)
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
import { AudioBufferCache } from './AudioBufferCache'

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

  /** 当前挂在播放链路上的 AudioBuffer(内容由 LRU 持有,这里只是引用) */
  private currentBuffer: AudioBuffer | null = null
  /** 当前播放歌曲的 URL */
  private currentUrl: string | null = null

  /**
   * 已解码音频的 LRU 缓存(P0 优化: 当前 + 上一首 + 预解码的下一首)
   * PCM 约 0.34MB/秒/双声道,因此默认 3 首 + 256MB 字节上限双约束
   */
  private cache = new AudioBufferCache<AudioBuffer>({
    maxEntries: 3,
    maxBytes: 256 * 1024 * 1024,
  })

  /** 在途解码任务(按 songId 去重: 预解码与前台请求撞车时共享同一份 Promise) */
  private inflight = new Map<string, Promise<AudioBuffer | null>>()

  /**
   * 每次 load 的 fetch / decode 耗时(按 songId)
   * 由 getAudioBuffer 取用后再落到 lastTimings,这样"前台加入预解码任务"时也能拿到真实分段,
   * 不会把上一次切歌的计时当成这一次的结果。
   */
  private loadTimings = new Map<string, { fetchMs: number; decodeMs: number }>()

  /** 预解码队列(串行执行,同一时刻只解一首) */
  private prefetchQueue: { songId: string; url: string }[] = []
  private prefetchRunning = false

  /** 缓存代际:clearCache 后旧任务的结果不再写回 */
  private cacheGeneration = 0

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
   * 获取 AudioBuffer(P0 优化: 按 songId 归档的 LRU + 预解码)
   *
   * 与旧实现的差别:
   *   - 缓存从"current + prev 两个槽位"改为 {AudioBufferCache} 的 LRU(默认 3 首),
   *     命中即刷新 LRU 顺序,并把当前播放的一首 pin 住
   *   - 未命中走 load(),与预解码共享同一份 in-flight 任务,不会重复解码同一首
   *   - 淘汰统一由缓存层负责:PCM 体积大(约 0.34MB/秒/双声道),必须同时按条目数与字节数约束
   *
   * @param url 音频文件 URL
   * @param songId 歌曲 ID
   */
  async getAudioBuffer(url: string, songId: string): Promise<AudioBuffer | null> {
    const cached = this.cache.get(songId, url)
    if (cached) {
      this.applyCurrent(songId, url, cached)
      this.recordCacheHit(songId)
      return cached
    }

    if (!this.audioContext) return null

    // 前台要播的这一首优先:清掉排队中的预解码,避免与本次解码抢 CPU
    this.prefetchQueue = []
    const audioBuffer = await this.load(url, songId)
    if (!audioBuffer) return null
    // 解码耗时来自这次 load 本身(可能是预解码先发起的任务被前台接走)
    const timings = this.loadTimings.get(songId)
    this.lastTimings = {
      songId,
      cacheHit: false,
      fetchMs: timings?.fetchMs ?? 0,
      decodeMs: timings?.decodeMs ?? 0,
      startPrepMs: 0,
      startCallMs: 0,
    }
    this.applyCurrent(songId, url, audioBuffer)
    return audioBuffer
  }

  /**
   * 预解码指定歌曲(P0 优化: 把解码提前到用户点歌之前)
   *
   * 只写缓存,不触碰 currentBuffer/currentUrl,因此不会影响正在播放的内容;
   * 已缓存或在途时直接跳过,队列串行执行且最多保留两个请求。
   */
  prefetch(url: string, songId: string): void {
    if (!this.audioContext) return
    if (this.cache.has(songId) || this.inflight.has(songId)) return
    this.prefetchQueue = this.prefetchQueue.filter((item) => item.songId !== songId)
    this.prefetchQueue.push({ songId, url })
    const overflow = this.prefetchQueue.length - 2
    if (overflow > 0) this.prefetchQueue.splice(0, overflow)
    void this.runPrefetchQueue()
  }

  /** 串行执行预解码:同一时刻只解一首,避免与播放抢 CPU 造成卡顿 */
  private async runPrefetchQueue(): Promise<void> {
    if (this.prefetchRunning) return
    this.prefetchRunning = true
    try {
      while (this.prefetchQueue.length > 0) {
        const next = this.prefetchQueue.shift()
        if (!next) break
        if (this.cache.has(next.songId) || this.inflight.has(next.songId)) continue
        // 预解码失败不影响任何播放行为,load 内部已记录错误
        await this.load(next.url, next.songId)
      }
    } finally {
      this.prefetchRunning = false
    }
  }

  /** 把已解码音频挂到播放槽位并 pin 住(缓存淘汰时不会动它) */
  private applyCurrent(songId: string, url: string, buffer: AudioBuffer): void {
    this.currentBuffer = buffer
    this.currentUrl = url
    this.cache.pin(songId)
  }

  /** 读取并解码一首歌,结果写入 LRU;同一首的并发请求共享同一个任务 */
  private load(url: string, songId: string): Promise<AudioBuffer | null> {
    const existing = this.inflight.get(songId)
    if (existing) return existing

    const generation = this.cacheGeneration
    const task = (async (): Promise<AudioBuffer | null> => {
      if (!this.audioContext) return null
      try {
        const fetchStartedAt = performance.now()
        const response = await fetch(url)
        if (!response.ok) return null
        const arrayBuffer = await response.arrayBuffer()
        const fetchEndedAt = performance.now()
        const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer)
        const decodeEndedAt = performance.now()

        // 计时总是记录:前台可能是"接走"了预解码任务,同样需要真实分段
        this.loadTimings.set(songId, {
          fetchMs: fetchEndedAt - fetchStartedAt,
          decodeMs: decodeEndedAt - fetchEndedAt,
        })
        if (this.loadTimings.size > 8) {
          const oldest = this.loadTimings.keys().next().value
          if (oldest !== undefined) this.loadTimings.delete(oldest)
        }

        // 清缓存后完成的旧任务不再写回,避免把已释放的内容又塞回 LRU
        if (generation === this.cacheGeneration) {
          const bytes = audioBuffer.length * audioBuffer.numberOfChannels * 4
          this.cache.set(songId, url, audioBuffer, bytes)
        }
        return audioBuffer
      } catch (error) {
        console.error('[Audio] AudioBuffer 解码失败:', error)
        return null
      }
    })().finally(() => {
      this.inflight.delete(songId)
    })
    this.inflight.set(songId, task)
    return task
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

    // 唤醒耗时单独记:音频设备异常时 resume() 可能占掉整个 startPrep
    let resumeMs = 0
    if (this.audioContext.state === 'suspended') {
      const resumeStartedAt = performance.now()
      try {
        await this.audioContext.resume()
      } catch {
        return
      }
      resumeMs = performance.now() - resumeStartedAt
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
        this.lastTimings.resumeMs = resumeMs
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
    this.cacheGeneration++
    this.cache.clear()
    this.loadTimings.clear()
    this.prefetchQueue = []
    this.currentBuffer = null
    this.currentUrl = null
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
      cache: this.cache.stats,
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
