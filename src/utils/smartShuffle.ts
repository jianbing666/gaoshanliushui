/**
 * 智能随机 (加权抽样)
 *
 * 在随机播放模式下, 按权重而不是等概率地抽取下一首:
 *
 *   权重 = 频率因子 × 喜爱因子 × 新歌因子 × 完成率因子 × 时间衰减
 *
 *   - 频率因子:   1 + ln(1 + 有效播放次数)     播得越多权重越高, 对数压缩防止霸榜
 *   - 喜爱因子:   喜爱 ×3                      用户显式表达偏好, 权重最高的一档
 *   - 新歌因子:   当天入库 ×2                  让刚加进歌单的歌更容易被听到
 *   - 完成率因子: 完整率高 ×1.2 / 中 ×1 / 低 ×0.5
 *                  "没听完就切走"是最强的负反馈, 但保留 0.5 倍而非清零
 *   - 时间衰减:   0.5 ^ (距最近活动天数 / 14), 下限 0.35
 *                  最近活动 = max(最近播放时间, 最近喜爱时间)
 *
 * 下限 0.35 是刻意选择: 衰减若不带下限, 长期未播的歌权重会趋近 0 而"再也不出现",
 * 与随机播放"整个歌单都有机会"的预期冲突。
 *
 * 所有函数均为纯函数, 不读全局状态, 便于单测与调参。
 */

import type { Song } from '@/types/song'

/** 权重公式参数 (稳健档: 效果明显但不至于让歌单失衡) */
export const SMART_SHUFFLE_PARAMS = {
  /** 喜爱加成倍数 */
  favoriteMultiplier: 3,
  /** 当天入库的新歌加成倍数 */
  newSongMultiplier: 2,
  /** 完成率高档阈值与倍数 */
  completionHighRatio: 0.8,
  completionHighMultiplier: 1.2,
  /** 完成率低档阈值与倍数 */
  completionLowRatio: 0.5,
  completionLowMultiplier: 0.5,
  /** 时间衰减半衰期 (天) */
  decayHalfLifeDays: 14,
  /** 时间衰减下限 */
  decayFloor: 0.35,
} as const

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 单首歌的播放信号 (来自 historyStore 的按歌曲聚合索引) */
export interface SongPlaySignals {
  /** 有效播放次数 (played_duration >= 1s) */
  playCount?: number
  /** 完整播放次数 (播放超过 80%) */
  completedCount?: number
  /** 最近一次有效播放时间 (Unix 毫秒) */
  lastPlayedAt?: number
}

/** 判断两个时间戳是否落在同一个本地日历日 */
export function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

/**
 * 完成率因子
 *
 * 口径与后端一致: 播放次数指有效播放 (>=1s) 的次数。
 * 从未播放过的歌不加成也不惩罚 (返回 1)。
 */
export function completionMultiplier(playCount: number, completedCount: number): number {
  if (playCount <= 0) return 1
  const ratio = completedCount / playCount
  if (ratio >= SMART_SHUFFLE_PARAMS.completionHighRatio) {
    return SMART_SHUFFLE_PARAMS.completionHighMultiplier
  }
  if (ratio >= SMART_SHUFFLE_PARAMS.completionLowRatio) return 1
  return SMART_SHUFFLE_PARAMS.completionLowMultiplier
}

/**
 * 时间衰减因子
 *
 * lastActivityAt 为最近一次"有效活动"(播放或标记喜爱) 的时间戳。
 * 无活动记录 (0 / 未来时间) 时不衰减 —— 从未播放的新歌不该被惩罚。
 */
export function recencyDecay(lastActivityAt: number, now: number): number {
  if (!lastActivityAt || lastActivityAt >= now) return 1
  const days = (now - lastActivityAt) / MS_PER_DAY
  const decayed = Math.pow(0.5, days / SMART_SHUFFLE_PARAMS.decayHalfLifeDays)
  return Math.max(SMART_SHUFFLE_PARAMS.decayFloor, decayed)
}

/** 计算单首歌的权重 */
export function computeSongWeight(song: Song, signals: SongPlaySignals, now: number): number {
  const playCount = Math.max(0, signals.playCount || 0)
  const completedCount = Math.max(0, signals.completedCount || 0)

  const frequency = 1 + Math.log(1 + playCount)
  const favorite = song.favorite ? SMART_SHUFFLE_PARAMS.favoriteMultiplier : 1
  const newSong =
    song.created_at && isSameLocalDay(song.created_at, now)
      ? SMART_SHUFFLE_PARAMS.newSongMultiplier
      : 1
  const completion = completionMultiplier(playCount, completedCount)

  const lastActivity = Math.max(signals.lastPlayedAt || 0, song.favorited_at || 0)
  const decay = recencyDecay(lastActivity, now)

  return frequency * favorite * newSong * completion * decay
}

/**
 * 计算整个候选列表的权重
 *
 * @param excludeIndex 需要排除的下标 (通常是当前播放的歌曲), 其权重置 0
 */
export function computeSmartWeights(
  songs: Song[],
  signalsOf: (song: Song) => SongPlaySignals,
  now: number,
  excludeIndex = -1
): number[] {
  return songs.map((song, index) =>
    index === excludeIndex ? 0 : computeSongWeight(song, signalsOf(song), now)
  )
}

/**
 * 按权重抽取一个下标
 *
 * @param rng 随机源 (0 <= rng() < 1), 可注入以便测试
 * @returns 抽中的下标; 空数组返回 -1; 权重全为 0 时退化为等概率
 */
export function pickWeightedIndex(weights: number[], rng: () => number = Math.random): number {
  if (weights.length === 0) return -1

  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0)
  if (total <= 0) {
    // 所有权重都被排除 (例如只剩当前这一首): 退化为等概率, 保证仍有歌可播
    return Math.min(weights.length - 1, Math.floor(rng() * weights.length))
  }

  let cursor = rng() * total
  for (let i = 0; i < weights.length; i++) {
    cursor -= Math.max(0, weights[i])
    if (cursor < 0) return i
  }
  // 浮点误差兜底: 落在末尾
  return weights.length - 1
}
