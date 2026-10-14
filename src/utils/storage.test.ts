import { beforeEach, describe, expect, it } from 'vitest'
import type { PlayHistoryItem } from '@/types/song'
import {
  STORAGE_KEYS,
  clearMusicLibraryPath,
  generateId,
  getMusicLibraryPath,
  loadFullPlayHistory,
  loadPlayHistory,
  loadPlaylists,
  loadSettings,
  saveFullPlayHistory,
  savePlayHistory,
  savePlaylists,
  saveSettings,
  setMusicLibraryPath,
} from './storage'

function historyItem(id: string): PlayHistoryItem {
  return {
    id,
    songId: 's1',
    title: 't',
    artist: 'a',
    album: '',
    duration: 0,
    cover_path: null,
    file_path: 'f.mp3',
    playedAt: 0,
    playedDuration: 0,
    completed: false,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('settings 读写', () => {
  it('无数据时返回空对象', () => {
    expect(loadSettings()).toEqual({})
  })

  it('写入后可原样读回', () => {
    saveSettings({ volume: 0.5, theme: 'dark' })
    expect(loadSettings()).toEqual({ volume: 0.5, theme: 'dark' })
  })

  it('内容损坏时回退为空对象而不是抛错', () => {
    localStorage.setItem(STORAGE_KEYS.settings, '{损坏的内容')
    expect(loadSettings()).toEqual({})
  })
})

describe('音乐库路径', () => {
  it('默认无值', () => {
    expect(getMusicLibraryPath()).toBeNull()
  })

  it('可写入与清除', () => {
    setMusicLibraryPath('D:\\Music')
    expect(getMusicLibraryPath()).toBe('D:\\Music')
    clearMusicLibraryPath()
    expect(getMusicLibraryPath()).toBeNull()
  })
})

describe('歌单', () => {
  it('无数据时返回含默认歌单的数组', () => {
    const playlists = loadPlaylists()
    expect(playlists).toHaveLength(1)
    expect(playlists[0].id).toBe('all-songs')
    expect(playlists[0].type).toBe('default')
  })

  it('数据损坏时回退到默认歌单', () => {
    localStorage.setItem(STORAGE_KEYS.playlists, '这不是 JSON')
    expect(loadPlaylists()[0].id).toBe('all-songs')
  })

  it('写入后可读回', () => {
    savePlaylists([{ id: '1', name: '自定义', type: 'custom', songIds: ['s1'] }])
    expect(loadPlaylists()).toEqual([{ id: '1', name: '自定义', type: 'custom', songIds: ['s1'] }])
  })
})

describe('播放历史', () => {
  it('无数据时返回空数组', () => {
    expect(loadPlayHistory()).toEqual([])
    expect(loadFullPlayHistory()).toEqual([])
  })

  it('完整历史缺失时用展示历史初始化', () => {
    savePlayHistory([historyItem('h1')])
    expect(loadFullPlayHistory().map((i) => i.id)).toEqual(['h1'])
  })

  it('完整历史存在时优先使用它', () => {
    savePlayHistory([historyItem('display')])
    saveFullPlayHistory([historyItem('full')])
    expect(loadFullPlayHistory().map((i) => i.id)).toEqual(['full'])
  })

  it('数据损坏时返回空数组而不是抛错', () => {
    localStorage.setItem(STORAGE_KEYS.history, '坏掉的数据')
    localStorage.setItem(STORAGE_KEYS.fullHistory, '也坏了')
    expect(loadPlayHistory()).toEqual([])
    expect(loadFullPlayHistory()).toEqual([])
  })
})

describe('generateId', () => {
  it('使用给定前缀', () => {
    expect(generateId('history').startsWith('history-')).toBe(true)
  })

  it('默认前缀为 id', () => {
    expect(generateId().startsWith('id-')).toBe(true)
  })

  it('连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId()))
    expect(ids.size).toBe(200)
  })
})
