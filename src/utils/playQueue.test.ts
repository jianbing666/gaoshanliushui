import { describe, expect, it } from 'vitest'
import { pickUpcomingSong, resolveShuffleNext } from './playQueue'
import type { LoopMode, Song } from '@/types/song'

/** 构造测试歌曲: 只填与队列逻辑相关的字段 */
function song(id: string): Song {
  return {
    id,
    file_path: '/music/' + id + '.mp3',
    title: id,
    artist: '测试歌手',
    album: '',
    duration: 120,
    cover_path: null,
    cover_thumb_path: null,
    content_hash: '',
    favorite: false,
    favorited_at: 0,
  } as Song
}

const songs = [song('a'), song('b'), song('c')]

describe('pickUpcomingSong', () => {
  it('顺序播放/列表循环取下一首', () => {
    for (const mode of ['list', 'none'] as LoopMode[]) {
      expect(pickUpcomingSong(songs, 0, mode)?.id).toBe('b')
      expect(pickUpcomingSong(songs, 1, mode)?.id).toBe('c')
    }
  })

  it('列表循环在最后一首回绕到第一首', () => {
    expect(pickUpcomingSong(songs, 2, 'list')?.id).toBe('a')
  })

  it('非循环(none)到最后一首返回 null', () => {
    expect(pickUpcomingSong(songs, 2, 'none')).toBeNull()
  })

  it('随机/单曲循环不可预测, 返回 null', () => {
    expect(pickUpcomingSong(songs, 1, 'shuffle')).toBeNull()
    expect(pickUpcomingSong(songs, 1, 'single')).toBeNull()
  })

  it('歌单不足两首或当前下标无效时返回 null', () => {
    expect(pickUpcomingSong([song('only')], 0, 'list')).toBeNull()
    expect(pickUpcomingSong([], 0, 'list')).toBeNull()
    expect(pickUpcomingSong(songs, -1, 'list')).toBeNull()
  })

  it('空歌单不抛异常', () => {
    expect(() => pickUpcomingSong([], -1, 'shuffle')).not.toThrow()
  })
})

describe('resolveShuffleNext', () => {
  it('没有预选时使用现抽结果', () => {
    expect(resolveShuffleNext(null, songs, 'a', 2)).toBe(2)
  })

  it('预选仍在歌单且不是当前曲目时复用预选', () => {
    expect(resolveShuffleNext({ songId: 'b', globalIndex: 1 }, songs, 'a', 2)).toBe(1)
  })

  it('预选目标就是当前曲目时重抽(避免原地重复)', () => {
    expect(resolveShuffleNext({ songId: 'b', globalIndex: 1 }, songs, 'b', 2)).toBe(2)
  })

  it('预选已被移出歌单时重抽', () => {
    expect(resolveShuffleNext({ songId: 'ghost', globalIndex: 99 }, songs, 'a', 0)).toBe(0)
  })

  it('预选目标已不在歌单且当前无歌曲时重抽', () => {
    expect(resolveShuffleNext({ songId: 'ghost', globalIndex: 99 }, songs, null, 1)).toBe(1)
  })
})
