/**
 * 实时响度均衡器（单例，基于 Web Audio API）
 *
 * 设计目标:
 *   - 零外部依赖、零预处理、不修改源文件
 *   - 关闭时音频链路完全恢复原状并停止测量，做到零开销
 *
 * 双测量模式:
 *   - rms（标准/低开销）：复用播放链路的 AnalyserNode，5Hz 轮询瞬时 RMS
 *   - lufs（高精度）：K-weighting 测量支路 + AudioWorklet，按 EBU R128 双门限
 *                     计算集成 LUFS（10Hz 上报），不影响主链路音质
 *
 * 增益施加（两模式共用）:
 *   - 目标响度 -14dB，最大提升 +9dB；衰减不设下限（很响的歌可充分压低）
 *   - setTargetAtTime 平滑施加；RMS 模式额外做 EMA 平滑，杜绝"呼吸感/抽吸感"
 *   - DynamicsCompressor 作为透明限幅器（-1.5dB 天花板），防止提升安静歌曲时削波
 *
 * 主链路（启用时）:
 *   AnalyserNode → loudnessGain → limiter → volumeGainNode
 * LUFS 模式额外测量支路:
 *   AnalyserNode → K-weighting(搁架+高通) → AudioWorkletNode → 静音Gain
 * 关闭后恢复:
 *   AnalyserNode → volumeGainNode
 */

/** 测量模式：标准 RMS / 高精度 LUFS */
export type LoudnessMode = 'rms' | 'lufs'

/** 目标响度（dB）。RMS 模式为 dB(RMS)，LUFS 模式为 LUFS */
const TARGET_DB = -14
/** 最大提升增益（dB），防止安静片段被过度放大 */
const MAX_BOOST_DB = 9
/** 静音门限：线性 RMS 低于此值视为静音/近静音（约 -80dBFS） */
const SILENCE_GATE_RMS = 1e-4
/** RMS 测量轮询间隔（ms），5Hz 足够慢、足够省 */
const MEASURE_INTERVAL_MS = 200
/** EMA 平滑系数：5Hz 更新下对应约 1s 时间常数 */
const EMA_ALPHA = 0.2
/** setTargetAtTime 时间常数（s），增益变化的最终平滑层 */
const GAIN_TIME_CONSTANT = 0.4

export class LoudnessNormalizer {
  /** 响度增益节点（补偿量施加于此） */
  private gainNode: GainNode | null = null
  /** 透明限幅器，仅在启用时串入主链路 */
  private limiterNode: DynamicsCompressorNode | null = null

  /** 当前测量模式 */
  private mode: LoudnessMode = 'rms'
  /** 主链路是否处于启用状态 */
  private active = false

  // ----- RMS 模式资源 -----
  /** 复用的时域波形缓冲（避免每次测量分配，降低 GC 压力） */
  private wave: Float32Array<ArrayBuffer> | null = null
  /** EMA 平滑后的测量响度（dB）；null 表示尚无有效测量 */
  private smoothedDb: number | null = null
  /** RMS 测量定时器 id；null 表示未运行 */
  private timerId: ReturnType<typeof setInterval> | null = null

  // ----- LUFS 模式资源 -----
  /** K-weighting Stage1：高频搁架 +4dB @1681.88Hz */
  private kShelf: BiquadFilterNode | null = null
  /** K-weighting Stage2：高通 38.13547Hz，Q=0.5 */
  private kHighpass: BiquadFilterNode | null = null
  /** R128 测量 worklet 节点 */
  private meterNode: AudioWorkletNode | null = null
  /** 维持 worklet 渲染的零增益出口 → destination（不发声） */
  private meterSink: GainNode | null = null
  /** worklet 模块加载 Promise（全局只加载/编译一次） */
  private modulePromise: Promise<void> | null = null

  private analyser: AnalyserNode | null = null
  private volumeGain: GainNode | null = null

  /**
   * 启用并改接音频链路（幂等）
   * @param analyser 播放链路中的 AnalyserNode（当前直连 volumeGain）
   * @param volumeGain 用户音量 GainNode
   */
  start(analyser: AnalyserNode, volumeGain: GainNode): void {
    const context = analyser.context as AudioContext

    // 懒创建主链路节点（首次启用时分配）
    if (!this.gainNode) {
      this.gainNode = context.createGain()
      this.gainNode.gain.value = 1
    }
    if (!this.limiterNode) {
      const limiter = context.createDynamicsCompressor()
      limiter.threshold.value = -1.5
      limiter.knee.value = 0
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.25
      this.limiterNode = limiter
    }
    // 复用波形缓冲，长度与 analyser.fftSize 对齐（当前为 2048）
    if (!this.wave || this.wave.length !== analyser.fftSize) {
      this.wave = new Float32Array(analyser.fftSize)
    }

    this.analyser = analyser
    this.volumeGain = volumeGain
    this.active = true

    // 主链路: analyser → gain → limiter → volumeGain
    // disconnect 会同时移除主链路与可能存在的 LUFS 测量支路，随后按模式重建
    try {
      analyser.disconnect()
      this.gainNode.disconnect()
      this.limiterNode.disconnect()
    } catch {
      // 首次改链时可能没有既有连接，忽略
    }
    analyser.connect(this.gainNode)
    this.gainNode.connect(this.limiterNode)
    this.limiterNode.connect(volumeGain)

    // 复位测量状态（重复 start 视为重新开始，不沿用旧增益）
    this.reset()

    if (this.mode === 'rms') {
      this.startRms()
    } else {
      void this.attachLufsBranch(context)
    }
  }

  /**
   * 停用并恢复原始链路：analyser → volumeGain
   */
  stop(analyser?: AnalyserNode, volumeGain?: GainNode): void {
    const input = analyser ?? this.analyser
    const output = volumeGain ?? this.volumeGain

    this.active = false
    this.stopRms()
    this.detachLufsBranch()

    if (input && output) {
      try {
        this.gainNode?.disconnect()
        this.limiterNode?.disconnect()
        input.disconnect()
      } catch {
        // 忽略断开异常
      }
      input.connect(output)
    }

    this.analyser = null
    this.volumeGain = null
    this.smoothedDb = null
  }

  /**
   * 切换测量模式
   * 未启用时仅记录；启用中则立即切换测量资源（主链路增益节点不变）
   */
  setMode(mode: LoudnessMode): void {
    if (this.mode === mode) return
    this.mode = mode
    if (!this.active || !this.analyser) return

    const context = this.analyser.context as AudioContext
    // 切模式视为重新测量：复位增益与平滑状态
    this.reset()
    if (mode === 'rms') {
      this.detachLufsBranch()
      this.startRms()
    } else {
      this.stopRms()
      void this.attachLufsBranch(context)
    }
  }

  /**
   * 复位：增益立即回到 1.0、清空平滑状态与 worklet 历史
   * 切歌 / seek / 低功耗旁路恢复时调用，避免上一段内容的增益带入新歌
   */
  reset(): void {
    this.smoothedDb = null
    if (this.gainNode && this.analyser) {
      const now = (this.analyser.context as AudioContext).currentTime
      const param = this.gainNode.gain
      param.cancelScheduledValues(now)
      param.setValueAtTime(1, now)
    }
    try {
      this.meterNode?.port.postMessage({ type: 'reset' })
    } catch {
      // worklet 未就绪时忽略
    }
  }

  // ============ RMS 模式 ============

  private startRms(): void {
    if (this.timerId === null) {
      this.timerId = setInterval(() => this.updateRms(), MEASURE_INTERVAL_MS)
    }
  }

  private stopRms(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId)
      this.timerId = null
    }
  }

  /**
   * 单次 RMS 测量与增益更新（定时器回调）
   */
  private updateRms(): void {
    if (!this.analyser || !this.gainNode || !this.wave) return
    // 窗口隐藏时系统会节流/冻结音频图，跳过以节省 CPU
    if (document.hidden) return

    const analyser = this.analyser
    analyser.getFloatTimeDomainData(this.wave)

    // 计算 RMS（线性，full-scale = 1）
    let sumSquares = 0
    for (let i = 0; i < this.wave.length; i++) {
      const sample = this.wave[i]
      sumSquares += sample * sample
    }
    const rms = Math.sqrt(sumSquares / this.wave.length)

    // 静音门限：不更新测量、不改变增益
    if (rms < SILENCE_GATE_RMS) return

    const measuredDb = 20 * Math.log10(rms)

    // EMA 平滑测量值
    if (this.smoothedDb === null) {
      this.smoothedDb = measuredDb
    } else {
      this.smoothedDb += EMA_ALPHA * (measuredDb - this.smoothedDb)
    }

    this.applyCompensation(TARGET_DB - this.smoothedDb)
  }

  // ============ LUFS 模式 ============

  /**
   * 加载 worklet 模块（仅一次）并接入 K-weighting 测量支路
   * 异步期间若已被 stop / 切模式，则放弃接线
   */
  private async attachLufsBranch(context: AudioContext): Promise<void> {
    try {
      await this.ensureModule(context)
    } catch {
      // 模块加载失败：静默回退，不反复尝试
      return
    }
    if (!this.active || this.mode !== 'lufs' || !this.analyser) return

    const analyser = this.analyser

    if (!this.kShelf) {
      const shelf = context.createBiquadFilter()
      shelf.type = 'highshelf'
      shelf.frequency.value = 1681.88
      shelf.gain.value = 4
      this.kShelf = shelf
    }
    if (!this.kHighpass) {
      const hp = context.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 38.13547
      hp.Q.value = 0.5
      this.kHighpass = hp
    }
    if (!this.meterNode) {
      const node = new AudioWorkletNode(context, 'lufs-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
      })
      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; integrated?: number } | null
        if (data?.type === 'lufs' && typeof data.integrated === 'number') {
          this.onLufsReport(data.integrated)
        }
      }
      this.meterNode = node
    }
    if (!this.meterSink) {
      const sink = context.createGain()
      sink.gain.value = 0
      this.meterSink = sink
    }

    // 测量支路: analyser → shelf → highpass → meter → 零增益 → destination
    try {
      this.kShelf.disconnect()
      this.kHighpass.disconnect()
      this.meterNode.disconnect()
      this.meterSink.disconnect()
    } catch {
      // 忽略
    }
    analyser.connect(this.kShelf)
    this.kShelf.connect(this.kHighpass)
    this.kHighpass.connect(this.meterNode)
    this.meterNode.connect(this.meterSink)
    this.meterSink.connect(context.destination)
  }

  /**
   * 断开 LUFS 测量支路（节点保留复用，仅断开连线）
   */
  private detachLufsBranch(): void {
    // 仅移除 analyser → kShelf 这一条支路连接（disconnect(destinationNode) 是定向断开）
    try {
      if (this.analyser && this.kShelf) {
        this.analyser.disconnect(this.kShelf)
      }
    } catch {
      // 旧 WebView 或连接不存在时忽略，后续节点逐个断开即可
    }
    try {
      this.kShelf?.disconnect()
      this.kHighpass?.disconnect()
      this.meterNode?.disconnect()
      this.meterSink?.disconnect()
    } catch {
      // 忽略
    }
    // 主链路（analyser → gainNode）在 start()/stop() 中统一管理，切模式时保持不变，
    // 此处绝不可重复 connect，否则同一信号双路汇入会导致音量翻倍
  }

  private ensureModule(context: AudioContext): Promise<void> {
    if (!this.modulePromise) {
      // Vite 会将 worklet 文件打包为同源资源；CSP script-src 'self' 允许加载
      const url = new URL('./lufs-processor.js', import.meta.url).href
      this.modulePromise = context.audioWorklet.addModule(url)
    }
    return this.modulePromise
  }

  /**
   * worklet 上报集成 LUFS：按偏差施加补偿（集成值本身已平滑，不再做 EMA）
   */
  private onLufsReport(integrated: number): void {
    if (!this.active || document.hidden) return
    this.applyCompensation(TARGET_DB - integrated)
  }

  // ============ 增益施加（共用） ============

  /**
   * 按补偿量（dB）施加增益：钳位最大提升 → 线性换算 → 平滑施加
   */
  private applyCompensation(compensationDb: number): void {
    if (!this.gainNode || !this.analyser) return
    // 只限制最大提升，衰减保持充分
    const clampedDb = Math.min(compensationDb, MAX_BOOST_DB)
    // dB → 线性增益（10^(dB/20)），平滑施加
    const linearGain = Math.pow(10, clampedDb / 20)
    const now = (this.analyser.context as AudioContext).currentTime
    this.gainNode.gain.setTargetAtTime(linearGain, now, GAIN_TIME_CONSTANT)
  }
}

/// 全局单例
export const loudnessNormalizer = new LoudnessNormalizer()
