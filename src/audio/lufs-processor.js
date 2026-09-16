/**
 * EBU R128 简化版实时 LUFS 测量器（AudioWorklet）
 *
 * 输入前提：进入本 worklet 的信号已经在主线程完成 K-weighting
 *   （Stage1 高频搁架 +4dB @1682Hz；Stage2 高通 ~38Hz Q≈0.5）
 *
 * 测量方式（对齐 R128 集成响度的简化版）：
 *   - 每 100ms 汇总一个均方功率块（hop=100ms）
 *   - 滑动 400ms 窗口（最近 4 个功率块的均值）作为一个 400ms 响度块
 *   - 收集块响度历史（有界），执行双门限：
 *       绝对门限 -70 LUFS；相对门限 = 绝对门限通过块的响度 -10 LUFS
 *   - 集成响度 L = -0.691 + 10 * log10(门限内块功率的均值)
 *   - 每个 hop（约 10Hz）通过端口上报当前 integrated LUFS
 *
 * 通信：
 *   主线程 → { type: 'reset' }：清空累计与历史（切歌/seek）
 *   worklet → { type: 'lufs', integrated }
 */

const HOP_SECONDS = 0.1
const WINDOW_BLOCKS = 4 // 400ms
const ABSOLUTE_GATE = -70
const RELATIVE_GATE_OFFSET = -10
/** 块历史上限（30 分钟 @100ms hop），超出丢弃最旧，避免无界增长 */
const MAX_BLOCKS = 1800
/** R128 电平偏移常量 */
const LEVEL_OFFSET = -0.691

class LufsProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    /** 当前 hop 已累计样本数 */
    this.samplesInHop = 0
    /** 每 hop 样本数（按实际采样率） */
    this.hopSamples = Math.max(1, Math.round(sampleRate * HOP_SECONDS))
    /** 当前 hop 累计平方和与样本计数 */
    this.hopSumSquares = 0
    this.hopCount = 0
    /** 最近 4 个 100ms 块功率（400ms 滑窗） */
    this.windowPowers = []
    /** 400ms 块响度/功率历史（用于双门限集成响度） */
    this.blockPowers = []

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'reset') {
        this.reset()
      }
    }
  }

  reset() {
    this.samplesInHop = 0
    this.hopSumSquares = 0
    this.hopCount = 0
    this.windowPowers.length = 0
    this.blockPowers.length = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channelCount = input.length
    // 以第一声道长度为本次量子长度（多声道逐样本求和）
    const quantum = input[0].length

    for (let i = 0; i < quantum; i++) {
      let sampleSquares = 0
      for (let ch = 0; ch < channelCount; ch++) {
        const v = input[ch][i]
        sampleSquares += v * v
      }
      // 多声道取均值
      this.hopSumSquares += sampleSquares / channelCount
      this.hopCount++
      this.samplesInHop++

      if (this.samplesInHop >= this.hopSamples) {
        const power = this.hopCount > 0 ? this.hopSumSquares / this.hopCount : 0
        this.pushBlock(power)
        this.samplesInHop = 0
        this.hopSumSquares = 0
        this.hopCount = 0
      }
    }

    return true
  }

  pushBlock(power) {
    this.windowPowers.push(power)
    if (this.windowPowers.length > WINDOW_BLOCKS) {
      this.windowPowers.shift()
    }
    // 满 400ms 才形成一个有效块
    if (this.windowPowers.length < WINDOW_BLOCKS) return

    let windowMean = 0
    for (const p of this.windowPowers) windowMean += p
    windowMean /= WINDOW_BLOCKS

    this.blockPowers.push(windowMean)
    if (this.blockPowers.length > MAX_BLOCKS) {
      this.blockPowers.shift()
    }

    const integrated = this.computeIntegrated()
    if (integrated !== null) {
      this.port.postMessage({ type: 'lufs', integrated })
    }
  }

  computeIntegrated() {
    // 第 1 道：绝对门限（-70 LUFS → 线性功率）
    const absolutePower = Math.pow(10, (ABSOLUTE_GATE - LEVEL_OFFSET) / 10)
    let sumAbs = 0
    let countAbs = 0
    for (const p of this.blockPowers) {
      if (p >= absolutePower) {
        sumAbs += p
        countAbs++
      }
    }
    if (countAbs === 0) return null

    // 第 2 道：相对门限 = 绝对门限通过块响度均值 - 10 LUFS
    const meanAbsPower = sumAbs / countAbs
    const ungatedLoudness = LEVEL_OFFSET + 10 * Math.log10(meanAbsPower)
    const relativeGateLoudness = ungatedLoudness + RELATIVE_GATE_OFFSET
    const relativePower = Math.pow(10, (relativeGateLoudness - LEVEL_OFFSET) / 10)

    let sumFinal = 0
    let countFinal = 0
    for (const p of this.blockPowers) {
      if (p >= absolutePower && p >= relativePower) {
        sumFinal += p
        countFinal++
      }
    }
    if (countFinal === 0) return null

    return LEVEL_OFFSET + 10 * Math.log10(sumFinal / countFinal)
  }
}

registerProcessor('lufs-processor', LufsProcessor)
