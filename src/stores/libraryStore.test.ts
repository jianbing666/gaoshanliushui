import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Song } from '@/types/song'

// store 层单测: 只验证纯前端可判定的逻辑, 不触发真实 Tauri IPC。
// invoke / listen 给空实现, convertFileSrc 给出可断言的伪 URL。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: vi.fn((path: string) => 'asset://localhost/' + encodeURIComponent(path)),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

import { convertFileSrc } from '@tauri-apps/api/core'
import { useLibraryStore } from './libraryStore'

function song(id: string, title: string, artist = '测试歌手'): Song {
  return {
    id,
    file_path: '/music/' + id + '.mp3',
    title,
    artist,
    album: '',
    duration: 120,
    cover_path: '/covers/' + id + '.jpg',
    cover_thumb_path: '/thumbnails/' + id + '.jpg',
    content_hash: '',
    favorite: false,
    favorited_at: 0,
  } as Song
}

describe('libraryStore.getCoverThumbUrl', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(convertFileSrc).mockClear()
  })

  it('没有缩略图时返回空串(不回退全尺寸封面)', () => {
    const store = useLibraryStore()
    expect(store.getCoverThumbUrl('/covers/a.jpg', null)).toBe('')
    expect(store.getCoverThumbUrl('/covers/a.jpg', undefined)).toBe('')
    expect(store.getCoverThumbUrl('/covers/a.jpg', '')).toBe('')
  })

  it('缩略图路径与封面路径相同时视为无效(旧数据的原图冒充缩略图)', () => {
    const store = useLibraryStore()
    expect(store.getCoverThumbUrl('/covers/a.jpg', '/covers/a.jpg')).toBe('')
  })

  it('有效缩略图转成 asset URL', () => {
    const store = useLibraryStore()
    expect(store.getCoverThumbUrl('/covers/a.jpg', '/thumbnails/a.jpg')).toBe(
      'asset://localhost/' + encodeURIComponent('/thumbnails/a.jpg')
    )
    expect(convertFileSrc).toHaveBeenCalledTimes(1)
  })

  it('同一缩略图路径重复调用会命中内部缓存', () => {
    const store = useLibraryStore()
    const first = store.getCoverThumbUrl('/covers/a.jpg', '/thumbnails/a.jpg')
    const second = store.getCoverThumbUrl('/covers/a.jpg', '/thumbnails/a.jpg')
    expect(second).toBe(first)
    expect(convertFileSrc).toHaveBeenCalledTimes(1)
  })

  it('hasCoverThumb 与 getCoverThumbUrl 同口径', () => {
    const store = useLibraryStore()
    expect(store.hasCoverThumb('/covers/a.jpg', null)).toBe(false)
    expect(store.hasCoverThumb('/covers/a.jpg', '/covers/a.jpg')).toBe(false)
    expect(store.hasCoverThumb('/covers/a.jpg', '/thumbnails/a.jpg')).toBe(true)
  })
})

describe('libraryStore 歌曲列表与搜索', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('默认歌单下 activePlaylistSongs 等于全量 playlist', () => {
    const store = useLibraryStore()
    store.playlists = [{ id: '1', name: '全部歌曲', type: 'default', songIds: [] }]
    store.activePlaylistId = '1'
    store.playlist = [song('a', '晴天'), song('b', '七里香')]
    expect(store.activePlaylistSongs.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('搜索按歌名/歌手/专辑过滤', () => {
    const store = useLibraryStore()
    store.playlists = [{ id: '1', name: '全部歌曲', type: 'default', songIds: [] }]
    store.activePlaylistId = '1'
    store.playlist = [song('a', '晴天', '周杰伦'), song('b', '七里香', '周杰伦')]
    store.searchQuery = '晴天'
    expect(store.filteredActivePlaylistSongs.map((s) => s.id)).toEqual(['a'])
    store.searchQuery = '周杰伦'
    expect(store.filteredActivePlaylistSongs).toHaveLength(2)
    store.searchQuery = '不存在的关键词'
    expect(store.filteredActivePlaylistSongs).toHaveLength(0)
  })

  it('currentSong 随 currentIndex 变化, 越界或 -1 时为 null', () => {
    const store = useLibraryStore()
    store.playlist = [song('a', '晴天'), song('b', '七里香')]
    store.currentIndex = 1
    expect(store.currentSong?.id).toBe('b')
    store.currentIndex = 5
    // 越界时 computed 直接取下标, 得到 undefined(调用方按 falsy 处理)
    expect(store.currentSong).toBeUndefined()
    store.currentIndex = -1
    expect(store.currentSong).toBeNull()
  })
})
