/**
 * 将秒数格式化为 "mm:ss" 格式
 */
export function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/**
 * 将秒数格式化为 "hh:mm:ss" 格式
 */
export function formatTimeLong(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00:00'
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
