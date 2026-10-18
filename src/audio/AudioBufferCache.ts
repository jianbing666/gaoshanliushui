/**
 * 已解码音频缓冲的 LRU 缓存(P0 优化用)
 *
 * 背景:实测切歌延迟 84.5% 花在 decodeAudioData(单曲 200~600ms),
 * 而命中缓存的切歌只需 1ms 量级。因此把"已解码的 AudioBuffer"按 LRU 多留几首,
 * 并配合预解码下一首,是唯一能把延迟压进 200ms 的路径。
 *
 * 设计要点:
 *   - 按 songId 归档(而不是 URL),切回同一首歌能直接命中
 *   - 同时受"条目数"和"字节数"两个上限约束:PCM 体积很大(约 0.34MB/秒/双声道),
 *     只按条目数限制会失控,只按字节限制会让小曲目挤掉大曲目
 *   - 正在播放的那一首永远 pin 住,不会被淘汰
 *   - 淘汰按"最久未使用"进行(LRU)
 *
 * 与 Web Audio 解耦:value 是泛型,因此可在纯 Node 环境单测。
 */

export interface AudioCacheEntry<T> {
  songId: string
  url: string
  value: T
  /** 该条目的字节数(调用方按 PCM 体积计算) */
  bytes: number
  /** 单调递增的访问序号,用于 LRU 淘汰 */
  lastUsed: number
}

export interface AudioCacheOptions<T> {
  /** 最多保留几首;默认 3(当前 + 上一首 + 预解码的下一首) */
  maxEntries?: number
  /** 最多占用多少字节;默认 256MB,防御性上限 */
  maxBytes?: number
  /**
   * 条目被淘汰/覆盖/清空时的回调(可选)。
   * 流式播放用它在淘汰时 revokeObjectURL,避免 blob 泄漏;
   * buffer 模式不传,行为与旧实现完全一致。
   */
  onEvict?: (entry: AudioCacheEntry<T>) => void
}

export interface AudioCacheStats {
  entries: number
  bytes: number
  maxEntries: number
  maxBytes: number
  pinnedSongId: string | null
}

export class AudioBufferCache<T> {
  private entries = new Map<string, AudioCacheEntry<T>>()
  private clock = 0
  private pinnedSongId: string | null = null
  private maxEntries: number
  private maxBytes: number
  private onEvict?: (entry: AudioCacheEntry<T>) => void

  constructor(options: AudioCacheOptions<T> = {}) {
    this.maxEntries = options.maxEntries ?? 3
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024
    this.onEvict = options.onEvict
  }

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.bytes
    return total
  }

  get stats(): AudioCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      pinnedSongId: this.pinnedSongId,
    }
  }

  has(songId: string): boolean {
    return this.entries.has(songId)
  }

  /**
   * 取一首已解码的音频;命中即刷新 LRU 顺序。
   * 传入 url 时额外校验 URL 是否一致(换文件后同 id 不应命中旧缓冲)。
   */
  get(songId: string): T | null
  get(songId: string, url: string): T | null
  get(songId: string, url?: string): T | null {
    const entry = this.entries.get(songId)
    if (!entry) return null
    if (url !== undefined && entry.url !== url) return null
    entry.lastUsed = ++this.clock
    return entry.value
  }

  /** 写入/覆盖一首;随后按上限淘汰 */
  set(songId: string, url: string, value: T, bytes: number): void {
    const previous = this.entries.get(songId)
    if (previous) this.onEvict?.(previous)
    this.entries.set(songId, {
      songId,
      url,
      value,
      bytes: Math.max(0, bytes),
      lastUsed: ++this.clock,
    })
    this.trim()
  }

  delete(songId: string): boolean {
    if (this.pinnedSongId === songId) this.pinnedSongId = null
    const entry = this.entries.get(songId)
    if (!entry) return false
    this.entries.delete(songId)
    this.onEvict?.(entry)
    return true
  }

  clear(): void {
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.pinnedSongId = null
    for (const entry of entries) this.onEvict?.(entry)
  }

  /** 钉住当前正在播放的一首(传 null 取消) */
  pin(songId: string | null): void {
    this.pinnedSongId = songId
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  /** 调整上限(测试与后续按内存预算收放时使用) */
  setLimits(limits: { maxEntries?: number; maxBytes?: number }): void {
    if (limits.maxEntries !== undefined) this.maxEntries = Math.max(1, limits.maxEntries)
    if (limits.maxBytes !== undefined) this.maxBytes = Math.max(0, limits.maxBytes)
    this.trim()
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      let victim: AudioCacheEntry<T> | null = null
      for (const entry of this.entries.values()) {
        if (entry.songId === this.pinnedSongId) continue
        if (!victim || entry.lastUsed < victim.lastUsed) victim = entry
      }
      // 只剩被钉住的一首时无法继续淘汰,直接退出避免死循环
      if (!victim) return
      this.entries.delete(victim.songId)
      this.onEvict?.(victim)
    }
  }
}
