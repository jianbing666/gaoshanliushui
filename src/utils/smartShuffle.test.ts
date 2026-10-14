import { describe, expect, it } from 'vitest'
import {
  SMART_SHUFFLE_PARAMS,
  completionMultiplier,
  computeSmartWeights,
  computeSongWeight,
  isSameLocalDay,
  pickWeightedIndex,
  recencyDecay,
} from './smartShuffle'
import type { Song } from '@/types/song'

const MS_PER_DAY = 24 * 60 * 60 * 1000
/** 固定"现在": 本地时间 2026-09-28 12:00 (用本地构造避免时区差异) */
const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime()

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: 'song-1',
    file_path: 'D:\\Music\\song-1.mp3',
    title: '歌曲 1',
    artist: '歌手',
    album: '',
    duration: 200,
    cover_path: null,
    content_hash: 'a'.repeat(40),
    favorite: false,
    favorited_at: 0,
    created_at: 0,
    ...overrides,
  }
}

describe('isSameLocalDay', () => {
  it('同一天的不同时刻视为同日', () => {
    expect(isSameLocalDay(NOW, NOW - 11 * 60 * 60 * 1000)).toBe(true)
  })

  it('跨日不算同日', () => {
    expect(isSameLocalDay(NOW, NOW - 13 * 60 * 60 * 1000)).toBe(false)
  })
})

describe('completionMultiplier', () => {
  it('从未播放过不加成也不惩罚', () => {
    expect(completionMultiplier(0, 0)).toBe(1)
  })

  it('完成率 >= 0.8 提升权重', () => {
    expect(completionMultiplier(10, 8)).toBe(SMART_SHUFFLE_PARAMS.completionHighMultiplier)
  })

  it('完成率处于中档保持基准权重', () => {
    expect(completionMultiplier(10, 5)).toBe(1)
    expect(completionMultiplier(10, 7)).toBe(1)
  })

  it('完成率 < 0.5 (常没听完就切走) 降低权重', () => {
    expect(completionMultiplier(10, 4)).toBe(SMART_SHUFFLE_PARAMS.completionLowMultiplier)
    expect(completionMultiplier(10, 0)).toBe(SMART_SHUFFLE_PARAMS.completionLowMultiplier)
  })
})

describe('recencyDecay', () => {
  it('无播放/喜爱记录时不衰减 (不惩罚陌生歌)', () => {
    expect(recencyDecay(0, NOW)).toBe(1)
  })

  it('刚刚有过活动时接近满权重', () => {
    expect(recencyDecay(NOW, NOW)).toBe(1)
  })

  it('一个半衰期后衰减到 0.5', () => {
    const halfLifeAgo = NOW - SMART_SHUFFLE_PARAMS.decayHalfLifeDays * MS_PER_DAY
    expect(recencyDecay(halfLifeAgo, NOW)).toBeCloseTo(0.5, 6)
  })

  it('长期未播放时不低于下限 (否则会从随机池中"消失")', () => {
    const veryOld = NOW - 365 * MS_PER_DAY
    expect(recencyDecay(veryOld, NOW)).toBe(SMART_SHUFFLE_PARAMS.decayFloor)
  })
})

describe('computeSongWeight', () => {
  it('全新未播放的歌权重为基准 1', () => {
    expect(computeSongWeight(makeSong(), {}, NOW)).toBe(1)
  })

  it('喜爱歌曲权重 ×3', () => {
    const song = makeSong({ favorite: true, favorited_at: NOW })
    expect(computeSongWeight(song, {}, NOW)).toBe(SMART_SHUFFLE_PARAMS.favoriteMultiplier)
  })

  it('当天入库的新歌权重 ×2', () => {
    const song = makeSong({ created_at: NOW - 60 * 1000 })
    expect(computeSongWeight(song, {}, NOW)).toBe(SMART_SHUFFLE_PARAMS.newSongMultiplier)
  })

  it('非当天入库的歌没有新歌加成', () => {
    const song = makeSong({ created_at: NOW - 3 * MS_PER_DAY })
    expect(computeSongWeight(song, {}, NOW)).toBe(1)
  })

  it('播放次数越多权重越高且为对数压缩', () => {
    const song = makeSong()
    const once = computeSongWeight(
      song,
      { playCount: 1, completedCount: 1, lastPlayedAt: NOW },
      NOW
    )
    const many = computeSongWeight(
      song,
      { playCount: 100, completedCount: 100, lastPlayedAt: NOW },
      NOW
    )

    expect(once).toBeGreaterThan(1)
    expect(many).toBeGreaterThan(once)
    // 对数压缩: 100 次播放的权重远小于 100 倍
    expect(many).toBeLessThan(10)
  })

  it('今日喜爱 + 今日入库 + 高完成率叠加', () => {
    const song = makeSong({ favorite: true, favorited_at: NOW, created_at: NOW })
    const weight = computeSongWeight(
      song,
      { playCount: 10, completedCount: 9, lastPlayedAt: NOW },
      NOW
    )
    const expected = (1 + Math.log(11)) * 3 * 2 * 1.2
    expect(weight).toBeCloseTo(expected, 6)
  })
})

describe('computeSmartWeights', () => {
  it('被排除的下标权重为 0, 其余正常计算', () => {
    const songs = [makeSong({ id: 'a' }), makeSong({ id: 'b' }), makeSong({ id: 'c' })]
    const weights = computeSmartWeights(songs, () => ({}), NOW, 1)

    expect(weights).toHaveLength(3)
    expect(weights[1]).toBe(0)
    expect(weights[0]).toBeGreaterThan(0)
    expect(weights[2]).toBeGreaterThan(0)
  })
})

describe('pickWeightedIndex', () => {
  it('空列表返回 -1', () => {
    expect(pickWeightedIndex([])).toBe(-1)
  })

  it('按累计权重区间取下标', () => {
    // 权重 [1, 3]: rng=0 落在第 0 项, rng=0.4 (1.6/4) 落在第 1 项
    expect(pickWeightedIndex([1, 3], () => 0)).toBe(0)
    expect(pickWeightedIndex([1, 3], () => 0.4)).toBe(1)
    expect(pickWeightedIndex([1, 3], () => 0.999)).toBe(1)
  })

  it('权重全为 0 时退化为等概率, 仍能抽出结果', () => {
    expect(pickWeightedIndex([0, 0], () => 0)).toBe(0)
    expect(pickWeightedIndex([0, 0], () => 0.6)).toBe(1)
  })

  it('大样本下高权重歌曲被抽中的概率显著更高', () => {
    const weights = [100, 1]
    let first = 0
    const samples = 5000
    for (let i = 0; i < samples; i++) {
      if (pickWeightedIndex(weights) === 0) first++
    }
    const ratio = first / samples
    expect(ratio).toBeGreaterThan(0.97)
    expect(ratio).toBeLessThan(1)
  })
})
