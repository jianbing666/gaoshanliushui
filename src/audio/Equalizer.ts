/**
 * 10段均衡器 (基于 Web Audio API BiquadFilterNode)
 *
 * 频率点: 31Hz, 62Hz, 125Hz, 250Hz, 500Hz, 1kHz, 2kHz, 4kHz, 8kHz, 16kHz
 * 增益范围: -12dB ~ +12dB
 *
 * 音频链路: source → eqFilters[0] → ... → eqFilters[9] → output
 */

export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export const EQ_BAND_LABELS = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K']

export const EQ_MAX_GAIN = 12
export const EQ_MIN_GAIN = -12

export class Equalizer {
  private filters: BiquadFilterNode[] = []
  private audioContext: AudioContext | null = null
  private inputNode: AudioNode | null = null
  private outputNode: AudioNode | null = null
  private _gains: number[] = new Array(10).fill(0)
  private _enabled = true

  /**
   * 初始化均衡器 (创建 filter 节点, 暂不连线)
   * @param context AudioContext 实例
   * @param outputNode 输出节点 (下一级节点, 如 analyser)
   */
  init(context: AudioContext, outputNode: AudioNode): void {
    this.audioContext = context
    this.outputNode = outputNode

    for (let i = 0; i < 10; i++) {
      const filter = context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = EQ_FREQUENCIES[i]
      filter.Q.value = 1.4
      filter.gain.value = this._gains[i]
      this.filters.push(filter)
    }
  }

  /**
   * 重新连接音频链路
   * source → eq0 → eq1 → ... → eq9 → output
   * 如果禁用, 直接 source → output
   */
  private reconnect(): void {
    if (!this.audioContext || !this.inputNode || !this.outputNode) return

    try {
      this.inputNode.disconnect()
    } catch {}

    for (const filter of this.filters) {
      try {
        filter.disconnect()
      } catch {}
    }

    if (this._enabled && this.filters.length > 0) {
      this.inputNode.connect(this.filters[0])
      for (let i = 0; i < this.filters.length - 1; i++) {
        this.filters[i].connect(this.filters[i + 1])
      }
      this.filters[this.filters.length - 1].connect(this.outputNode)
    } else {
      this.inputNode.connect(this.outputNode)
    }
  }

  /**
   * 设置指定频段的增益 (dB)
   */
  setBandGain(index: number, gainDb: number): void {
    const clamped = Math.max(EQ_MIN_GAIN, Math.min(EQ_MAX_GAIN, gainDb))
    this._gains[index] = clamped
    if (this.filters[index]) {
      this.filters[index].gain.value = clamped
    }
  }

  /**
   * 获取所有频段增益值
   */
  getGains(): number[] {
    return [...this._gains]
  }

  /**
   * 设置所有频段增益
   */
  setGains(gains: number[]): void {
    for (let i = 0; i < 10; i++) {
      this.setBandGain(i, gains[i] ?? 0)
    }
  }

  /**
   * 重置所有频段为 0dB
   */
  reset(): void {
    for (let i = 0; i < 10; i++) {
      this.setBandGain(i, 0)
    }
  }

  /**
   * 是否启用均衡器
   */
  get enabled(): boolean {
    return this._enabled
  }

  set enabled(value: boolean) {
    if (this._enabled === value) return
    this._enabled = value
    this.reconnect()
  }

  /**
   * 当 source 节点变化时重新连接 (切歌后调用)
   * 因为每次切歌都会创建新的 AudioBufferSourceNode
   */
  reconnectSource(newSource: AudioNode): void {
    this.inputNode = newSource
    this.reconnect()
  }

  /**
   * 断开输入连接 (低功耗模式等场景)
   */
  disconnect(): void {
    if (this.inputNode) {
      try {
        this.inputNode.disconnect()
      } catch {}
    }
    this.inputNode = null
  }
}

export const equalizer = new Equalizer()
