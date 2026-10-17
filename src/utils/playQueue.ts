import type { LoopMode, Song } from '@/types/song'

/**
 * 播放队列推进的纯逻辑(P3: 从 audioStore 抽出, 便于单测)
 *
 * 为什么单独成模块:
 *   "下一首是谁" / "随机预选的下一首还能不能用" 是 audioStore 里最容易出错的
 *   分支(列表循环要回绕、循环模式 none 到末尾要停、随机预选可能已失效),
 *   但它们不依赖任何播放状态或 Web Audio。抽成纯函数后可以脱离浏览器环境覆盖。
 *
 * 约定:
 *   - index 均为"当前歌单(activeSongs)内的下标", 不是全局 playlist 下标
 *   - 随机模式返回 null: 下一首无法预测, 预解码目标要靠 prefetch 时提前抽签
 */

/** 随机模式预选出的"下一首" */
export interface PendingShuffleNext {
  songId: string
  /** 全局 playlist 下标 */
  globalIndex: number
}

/**
 * 推断顺序/列表循环下"下一首"会播哪一首。
 *
 * 返回 null 的情况:
 *   - 歌单不足 2 首(没有"下一首"的概念)
 *   - 随机 / 单曲循环(不可预测, 或根本不换歌)
 *   - 当前不在歌单内(index < 0)
 *   - 循环模式为 none 且已在最后一首
 */
export function pickUpcomingSong(
  songs: readonly Song[],
  currentActiveIndex: number,
  loopMode: LoopMode
): Song | null {
  if (songs.length < 2) return null
  if (loopMode === 'shuffle' || loopMode === 'single') return null
  if (currentActiveIndex < 0) return null
  if (currentActiveIndex + 1 < songs.length) return songs[currentActiveIndex + 1]
  return loopMode === 'list' ? songs[0] : null
}

/**
 * 解析随机播放"下一首"的下标。
 *
 * 预选的下一首只有在"仍存在于当前歌单、且不是正在播的这首"时才可复用;
 * 否则(换过歌单、预选目标被删、上一轮已切到它)必须现场重抽。
 *
 * @param fallbackIndex 现场抽签结果(getRandomIndex 已保证落在有效范围)
 */
export function resolveShuffleNext(
  pending: PendingShuffleNext | null,
  songs: readonly Song[],
  currentSongId: string | null,
  fallbackIndex: number
): number {
  if (!pending) return fallbackIndex
  const stillExists = songs.some((song) => song.id === pending.songId)
  if (stillExists && pending.songId !== currentSongId) return pending.globalIndex
  return fallbackIndex
}
