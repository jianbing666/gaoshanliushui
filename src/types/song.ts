/// 歌曲数据类型（与 Rust 后端 Song 模型对应）
export interface Song {
  /** 唯一标识 */
  id: string
  /** 文件绝对路径 */
  file_path: string
  /** 歌曲标题 */
  title: string
  /** 艺术家 */
  artist: string
  /** 专辑名 */
  album: string
  /** 时长（秒） */
  duration: number
  /** 封面图片路径 */
  cover_path: string | null
}

/// 循环模式
export type LoopMode = 'list' | 'single' | 'none'

/// 主题模式
export type ThemeMode = 'light' | 'dark' | 'system'