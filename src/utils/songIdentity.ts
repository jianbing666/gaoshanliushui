/**
 * 歌曲标识匹配
 *
 * 项目里同时存在两套歌曲标识:
 *
 *   - `Song.id`           —— 文件**路径**哈希(Rust 侧 `DefaultHasher`, 16 位十六进制)
 *   - `Song.content_hash` —— 文件**内容**指纹(SHA-1, 40 位十六进制)
 *
 * 二者用途不同:`id` 用于前端列表 key, `content_hash` 是持久化层的通用标识
 * (歌单、回忆都按它关联)。播放历史早期误把 `id` 写进了 `song_hash` 字段,
 * 现已改为写 `content_hash`, 但**存量记录仍是旧值**。
 *
 * 因此凡是用历史记录里的标识反查歌曲的地方, 都必须同时比对两者 ——
 * 只比对一个的话, 另一半记录会点不动。
 */

export interface SongIdentity {
  id: string
  content_hash?: string | null
}

/** 判断某个标识键是否指向这首歌 */
export function matchesSongKey(song: SongIdentity, key: string): boolean {
  if (!key) return false
  return song.id === key || song.content_hash === key
}
