/**
 * 切歌链路分段耗时的纯计算模块(P0 定位用)
 *
 * 背景:整应用实测切歌延迟(perf:load-start → perf:playback-started)中位数约 480ms,
 * 需要先拆成 fetch / decode / start 三段定位瓶颈,再决定优化方向。
 *
 * 分工:
 *   - AudioEngine 只采集原始计时(getLastTimings),不参与统计
 *   - audioStore 在切歌完成后派发 perf:switch-trace
 *   - perfRecorder 用本模块把原始计时整理成可导出结构
 *
 * 因此本文件全部为纯函数,便于单测(不依赖浏览器 API)。
 */

/** AudioEngine 采集的原始计时(ms,未取整) */
export interface SwitchTimingsInput {
  /** 命中 LRU(current/prev)时为 true,此时 fetch/decode 均为 0 */
  cacheHit: boolean
  /** fetch + arrayBuffer 读取耗时 */
  fetchMs: number
  /** decodeAudioData 耗时 */
  decodeMs: number
  /** 进入 playFromOffset 到触发 onStart 之间(上下文唤醒 / 旧节点拆解 / 建链) */
  startPrepMs: number
  /** onStart 之后到 source.start() 与音量恢复完成(超出上例总延迟口径的部分) */
  startCallMs: number
}

/** 归档进记录的分段(已取整;otherMs 由总延迟反推) */
export interface SwitchSegments {
  cacheHit: boolean
  fetchMs: number
  decodeMs: number
  startPrepMs: number
  startCallMs: number
  /** 总延迟扣掉 fetch/decode/startPrep 后的残余(store 编排、await 调度、静音重入等) */
  otherMs: number
}

/** 单段统计 */
export interface SegmentStats {
  count: number
  minMs: number
  medianMs: number
  p95Ms: number
  maxMs: number
  meanMs: number
}

/** 一次记录的分段汇总(每段中位 / P95 / 最大,供导出与报告引用) */
export interface SwitchSegmentSummary {
  /** 带分段数据的切歌次数 */
  sampleCount: number
  /** 其中命中 LRU 的次数(无 fetch/decode) */
  cacheHitCount: number
  /** 总延迟(仅统计带分段的样本,保证与各段同口径) */
  latency: SegmentStats
  /** 仅统计未命中缓存的样本 */
  fetch: SegmentStats
  /** 仅统计未命中缓存的样本 */
  decode: SegmentStats
  /** = startPrep + startCall */
  start: SegmentStats
  /** 总延迟残余 */
  other: SegmentStats
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1)))
  )
  return sorted[index]
}

export function statsOf(values: number[]): SegmentStats {
  if (values.length === 0) {
    return { count: 0, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0, meanMs: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, value) => acc + value, 0)
  return {
    count: sorted.length,
    minMs: round(sorted[0]),
    medianMs: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(sum / sorted.length),
  }
}

/**
 * 用引擎原始计时和端到端延迟拼出可归档分段。
 * otherMs 允许为 0(计时存在取整误差时不做负数),不做其他修正。
 */
export function buildSwitchSegments(
  timings: SwitchTimingsInput,
  latencyMs: number
): SwitchSegments {
  const fetchMs = round(Math.max(0, timings.fetchMs))
  const decodeMs = round(Math.max(0, timings.decodeMs))
  const startPrepMs = round(Math.max(0, timings.startPrepMs))
  const startCallMs = round(Math.max(0, timings.startCallMs))
  const otherMs = round(Math.max(0, latencyMs - fetchMs - decodeMs - startPrepMs))
  return { cacheHit: timings.cacheHit, fetchMs, decodeMs, startPrepMs, startCallMs, otherMs }
}

/**
 * 汇总一次记录里的全部切歌分段。
 * 命中缓存的样本只参与 latency / start / other,不参与 fetch / decode,
 * 否则被 0 值拉低,无法反映真实 I/O 成本。
 */
export function summarizeSwitchSegments(
  switches: { latencyMs: number; segments?: SwitchSegments }[]
): SwitchSegmentSummary {
  const withSegments = switches.filter(
    (item): item is { latencyMs: number; segments: SwitchSegments } => !!item.segments
  )
  const misses = withSegments.filter((item) => !item.segments.cacheHit)
  return {
    sampleCount: withSegments.length,
    cacheHitCount: withSegments.length - misses.length,
    latency: statsOf(withSegments.map((item) => item.latencyMs)),
    fetch: statsOf(misses.map((item) => item.segments.fetchMs)),
    decode: statsOf(misses.map((item) => item.segments.decodeMs)),
    start: statsOf(
      withSegments.map((item) => item.segments.startPrepMs + item.segments.startCallMs)
    ),
    other: statsOf(withSegments.map((item) => item.segments.otherMs)),
  }
}
