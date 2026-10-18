import { describe, expect, it } from 'vitest'
import { AudioBufferCache } from './AudioBufferCache'

describe('AudioBufferCache', () => {
  it('按 songId 命中并返回同一个值', () => {
    const cache = new AudioBufferCache<string>()
    cache.set('a', 'url-a', 'buf-a', 100)
    expect(cache.get('a')).toBe('buf-a')
    expect(cache.has('a')).toBe(true)
    expect(cache.get('missing')).toBeNull()
  })

  it('URL 不一致时不命中(换文件后不应复用旧缓冲)', () => {
    const cache = new AudioBufferCache<string>()
    cache.set('a', 'url-a', 'buf-a', 100)
    expect(cache.get('a', 'url-a')).toBe('buf-a')
    expect(cache.get('a', 'url-other')).toBeNull()
  })

  it('超过条目上限时淘汰最久未使用的一首', () => {
    const cache = new AudioBufferCache<string>({ maxEntries: 2 })
    cache.set('a', 'ua', 'a', 10)
    cache.set('b', 'ub', 'b', 10)
    cache.get('a') // a 变新
    cache.set('c', 'uc', 'c', 10)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
  })

  it('超过字节上限时继续淘汰', () => {
    const cache = new AudioBufferCache<string>({ maxEntries: 5, maxBytes: 250 })
    cache.set('a', 'ua', 'a', 100)
    cache.set('b', 'ub', 'b', 100)
    cache.set('c', 'uc', 'c', 100)
    expect(cache.bytes).toBeLessThanOrEqual(250)
    expect(cache.size).toBe(2)
    expect(cache.has('a')).toBe(false)
  })

  it('被 pin 住的一首不会被淘汰,即使它最久未使用', () => {
    const cache = new AudioBufferCache<string>({ maxEntries: 2 })
    cache.set('a', 'ua', 'a', 10)
    cache.pin('a')
    cache.set('b', 'ub', 'b', 10)
    cache.set('c', 'uc', 'c', 10)
    expect(cache.has('a')).toBe(true)
    expect(cache.size).toBe(2)
  })

  it('全部被 pin 住时不会死循环', () => {
    const cache = new AudioBufferCache<string>({ maxEntries: 1, maxBytes: 100 })
    cache.set('a', 'ua', 'a', 10)
    cache.pin('a')
    expect(() => cache.set('b', 'ub', 'b', 10)).not.toThrow()
    expect(cache.has('a')).toBe(true)
  })

  it('覆盖同一首不会重复计数', () => {
    const cache = new AudioBufferCache<string>()
    cache.set('a', 'ua', 'a', 10)
    cache.set('a', 'ua2', 'a2', 20)
    expect(cache.size).toBe(1)
    expect(cache.bytes).toBe(20)
    expect(cache.get('a')).toBe('a2')
  })

  it('删除与清空同时解除 pin', () => {
    const cache = new AudioBufferCache<string>()
    cache.set('a', 'ua', 'a', 10)
    cache.pin('a')
    cache.delete('a')
    expect(cache.stats.pinnedSongId).toBeNull()

    cache.set('b', 'ub', 'b', 10)
    cache.pin('b')
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.stats.pinnedSongId).toBeNull()
  })

  it('字节数等于各条目之和', () => {
    const cache = new AudioBufferCache<string>()
    cache.set('a', 'ua', 'a', 10)
    cache.set('b', 'ub', 'b', 32)
    expect(cache.bytes).toBe(42)
    expect(cache.stats).toMatchObject({ entries: 2, bytes: 42, maxEntries: 3 })
  })

  // P4-2 流式播放依赖 onEvict 释放 objectURL:
  // 漏掉任何一条淘汰路径都会造成 blob 泄漏(内存只增不减),所以逐条覆盖。
  it('onEvict 在淘汰 / 覆盖 / 删除 / 清空时都会被调用', () => {
    const evicted: string[] = []
    const cache = new AudioBufferCache<string>({
      maxEntries: 2,
      onEvict: (entry) => evicted.push(entry.value),
    })

    cache.set('a', 'ua', 'a', 10)
    cache.set('b', 'ub', 'b', 10)
    cache.set('c', 'uc', 'c', 10) // 淘汰最久未使用的 a
    expect(evicted).toEqual(['a'])

    cache.set('b', 'ub2', 'b2', 20) // 覆盖 b
    expect(evicted).toEqual(['a', 'b'])

    cache.delete('c')
    expect(evicted).toEqual(['a', 'b', 'c'])

    cache.set('d', 'ud', 'd', 10)
    cache.clear()
    expect(evicted).toEqual(['a', 'b', 'c', 'b2', 'd'])
  })

  it('onEvict 抛出异常时不影响缓存状态', () => {
    const cache = new AudioBufferCache<string>({
      maxEntries: 1,
      onEvict: () => {
        throw new Error('revoke failed')
      },
    })
    cache.set('a', 'ua', 'a', 10)
    expect(() => cache.set('b', 'ub', 'b', 10)).toThrow()
    // 抛错发生在删除之后, 所以 a 已被剔除、b 已写入
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
  })
})
