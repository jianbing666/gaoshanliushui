import { describe, expect, it } from 'vitest'
import { matchesSongKey } from './songIdentity'

const PATH_HASH = '993dd288157fc156'
const CONTENT_HASH = 'a'.repeat(40)

const song = { id: PATH_HASH, content_hash: CONTENT_HASH }

describe('matchesSongKey', () => {
  it('匹配路径哈希(历史旧记录写入的标识)', () => {
    expect(matchesSongKey(song, PATH_HASH)).toBe(true)
  })

  it('匹配内容指纹(历史新记录写入的标识)', () => {
    expect(matchesSongKey(song, CONTENT_HASH)).toBe(true)
  })

  it('不匹配无关标识与空键', () => {
    expect(matchesSongKey(song, 'ffffffffffffffff')).toBe(false)
    expect(matchesSongKey(song, '')).toBe(false)
  })

  it('缺少 content_hash 时只按 id 匹配', () => {
    const legacy = { id: PATH_HASH }
    expect(matchesSongKey(legacy, PATH_HASH)).toBe(true)
    expect(matchesSongKey(legacy, CONTENT_HASH)).toBe(false)
  })

  it('content_hash 为 null 时不会与字符串 "null" 误匹配', () => {
    const nullish = { id: PATH_HASH, content_hash: null }
    expect(matchesSongKey(nullish, PATH_HASH)).toBe(true)
    expect(matchesSongKey(nullish, 'null')).toBe(false)
  })
})
