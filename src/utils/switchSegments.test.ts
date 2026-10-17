import { describe, expect, it } from 'vitest'
import {
  buildSwitchSegments,
  statsOf,
  summarizeSwitchSegments,
  type SwitchSegments,
} from './switchSegments'

function makeSegments(overrides: Partial<SwitchSegments> = {}): SwitchSegments {
  return {
    cacheHit: false,
    fetchMs: 100,
    decodeMs: 200,
    startPrepMs: 50,
    startCallMs: 5,
    resumeMs: 0,
    otherMs: 30,
    ...overrides,
  }
}

describe('statsOf', () => {
  it('空数组返回全 0 且样本数为 0', () => {
    expect(statsOf([])).toEqual({
      count: 0,
      minMs: 0,
      medianMs: 0,
      p95Ms: 0,
      maxMs: 0,
      meanMs: 0,
    })
  })

  it('计算最小 / 中位 / P95 / 最大 / 均值', () => {
    const stats = statsOf([10, 20, 30, 40, 50])
    expect(stats.count).toBe(5)
    expect(stats.minMs).toBe(10)
    expect(stats.medianMs).toBe(30)
    expect(stats.p95Ms).toBe(50)
    expect(stats.maxMs).toBe(50)
    expect(stats.meanMs).toBe(30)
  })

  it('保留两位小数', () => {
    const stats = statsOf([1.234, 2.345])
    expect(stats.minMs).toBe(1.23)
    expect(stats.maxMs).toBe(2.35)
  })

  it('不修改入参数组', () => {
    const values = [30, 10, 20]
    statsOf(values)
    expect(values).toEqual([30, 10, 20])
  })
})

describe('buildSwitchSegments', () => {
  it('其余段之和小于总延迟时给出残余', () => {
    const segments = buildSwitchSegments(
      { cacheHit: false, fetchMs: 100, decodeMs: 200, startPrepMs: 50, startCallMs: 5 },
      400
    )
    expect(segments.fetchMs).toBe(100)
    expect(segments.decodeMs).toBe(200)
    expect(segments.startPrepMs).toBe(50)
    // 400 - 100 - 200 - 50
    expect(segments.otherMs).toBe(50)
  })

  it('各段之和超过总延迟时残余归零,不出现负数', () => {
    const segments = buildSwitchSegments(
      { cacheHit: false, fetchMs: 300, decodeMs: 300, startPrepMs: 100, startCallMs: 10 },
      480
    )
    expect(segments.otherMs).toBe(0)
  })

  it('命中缓存时保留 cacheHit 标记', () => {
    const segments = buildSwitchSegments(
      { cacheHit: true, fetchMs: 0, decodeMs: 0, startPrepMs: 8, startCallMs: 1 },
      12
    )
    expect(segments.cacheHit).toBe(true)
    expect(segments.fetchMs).toBe(0)
    expect(segments.decodeMs).toBe(0)
    expect(segments.otherMs).toBe(4)
  })

  it('未提供 resumeMs 时按 0 归档,提供了则原样保留', () => {
    const withoutResume = buildSwitchSegments(
      { cacheHit: true, fetchMs: 0, decodeMs: 0, startPrepMs: 5, startCallMs: 1 },
      10
    )
    expect(withoutResume.resumeMs).toBe(0)

    const withResume = buildSwitchSegments(
      { cacheHit: true, fetchMs: 0, decodeMs: 0, startPrepMs: 900, startCallMs: 1, resumeMs: 880 },
      950
    )
    expect(withResume.resumeMs).toBe(880)
    expect(withResume.otherMs).toBe(50)
  })

  it('计时出现负值时按 0 处理', () => {
    const segments = buildSwitchSegments(
      { cacheHit: false, fetchMs: -5, decodeMs: 10, startPrepMs: 10, startCallMs: 0 },
      100
    )
    expect(segments.fetchMs).toBe(0)
  })
})

describe('summarizeSwitchSegments', () => {
  it('没有分段数据时各段样本为 0', () => {
    const summary = summarizeSwitchSegments([{ latencyMs: 500 }])
    expect(summary.sampleCount).toBe(0)
    expect(summary.latency.count).toBe(0)
    expect(summary.fetch.count).toBe(0)
  })

  it('命中缓存的样本不参与 fetch / decode 统计', () => {
    const summary = summarizeSwitchSegments([
      { latencyMs: 500, segments: makeSegments({ fetchMs: 120, decodeMs: 260 }) },
      {
        latencyMs: 20,
        segments: makeSegments({ cacheHit: true, fetchMs: 0, decodeMs: 0, otherMs: 2 }),
      },
    ])
    expect(summary.sampleCount).toBe(2)
    expect(summary.cacheHitCount).toBe(1)
    expect(summary.fetch.count).toBe(1)
    expect(summary.fetch.medianMs).toBe(120)
    expect(summary.decode.count).toBe(1)
    expect(summary.decode.medianMs).toBe(260)
  })

  it('start 段是 startPrep 与 startCall 之和', () => {
    const summary = summarizeSwitchSegments([
      { latencyMs: 500, segments: makeSegments({ startPrepMs: 40, startCallMs: 6 }) },
    ])
    expect(summary.start.medianMs).toBe(46)
  })

  it('总延迟只统计带分段的样本', () => {
    const summary = summarizeSwitchSegments([
      { latencyMs: 500, segments: makeSegments() },
      { latencyMs: 9000 },
    ])
    expect(summary.latency.count).toBe(1)
    expect(summary.latency.maxMs).toBe(500)
  })
})
