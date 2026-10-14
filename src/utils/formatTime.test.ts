import { describe, expect, it } from 'vitest'
import { formatTime, formatTimeLong } from './formatTime'

describe('formatTime', () => {
  it('把秒数格式化为 m:ss', () => {
    expect(formatTime(5)).toBe('0:05')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(600)).toBe('10:00')
  })

  it('非正数与非法值统一回退为 0:00', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(-1)).toBe('0:00')
    expect(formatTime(NaN)).toBe('0:00')
  })

  it('秒数向下取整而不是四舍五入', () => {
    expect(formatTime(59.9)).toBe('0:59')
  })
})

describe('formatTimeLong', () => {
  it('不足一小时时退化为 m:ss', () => {
    expect(formatTimeLong(65)).toBe('1:05')
    expect(formatTimeLong(3599)).toBe('59:59')
  })

  it('超过一小时时输出 h:mm:ss', () => {
    expect(formatTimeLong(3600)).toBe('1:00:00')
    expect(formatTimeLong(3665)).toBe('1:01:05')
  })

  it('非正数与非法值统一回退为 0:00:00', () => {
    expect(formatTimeLong(0)).toBe('0:00:00')
    expect(formatTimeLong(-1)).toBe('0:00:00')
  })
})
