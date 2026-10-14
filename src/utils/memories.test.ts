import { describe, expect, it } from 'vitest'
import { parseShortTags } from './memories'

describe('parseShortTags', () => {
  it('正常解析字符串数组', () => {
    expect(parseShortTags('["通宵的小曲儿~","2019的那年夏天"]')).toEqual([
      '通宵的小曲儿~',
      '2019的那年夏天',
    ])
  })

  it('空数组与空值返回空数组', () => {
    expect(parseShortTags('[]')).toEqual([])
    expect(parseShortTags('')).toEqual([])
    expect(parseShortTags(null)).toEqual([])
    expect(parseShortTags(undefined)).toEqual([])
  })

  it('损坏的 JSON 不抛错, 返回空数组', () => {
    expect(parseShortTags('{不是合法 JSON')).toEqual([])
    expect(parseShortTags('[1,2')).toEqual([])
  })

  it('合法 JSON 但结构不符时返回空数组', () => {
    expect(parseShortTags('{"a":1}')).toEqual([])
    expect(parseShortTags('"一个字符串"')).toEqual([])
    expect(parseShortTags('[1,2]')).toEqual([])
    expect(parseShortTags('["合法",1]')).toEqual([])
  })
})
