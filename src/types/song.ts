/// 歌曲数据类型（与 Rust 后端 Song 模型对应）
export interface Song {
  /** 唯一标识（基于文件路径的哈希） */
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
  /** 缩略图路径（Rust 端生成, 128px 宽, 旧数据可能为 null） */
  cover_thumb_path?: string | null
  /**
   * Memory feature - 高山流水 v1.1: 文件内容指纹（头尾 64KB SHA-1 十六进制）
   * 与文件路径解耦, 用于跨文件移动时稳定匹配历史回忆
   * 旧数据可能为 undefined, 前端需做容错
   */
  content_hash?: string | null
}

/**
 * Memory feature - 高山流水 v1.1: 回忆记录
 *
 * 存储在 SQLite (app_data_dir/memories.db) 中, 与音乐文件完全解耦
 */
export interface MemoryRecord {
  /** 自增主键 */
  id: number
  /** 文件内容指纹 (Song.content_hash) */
  song_hash: string
  /** 当前文件绝对路径 (用户移动文件后会被更新) */
  song_path: string
  /** 短标签 JSON 数组字符串, 如 '["通宵的小曲儿~","2019的那年夏天"]' */
  short_tags: string
  /** Markdown 长文 */
  long_text: string
  /** 创建时间 (Unix 毫秒) */
  created_at: number
  /** 更新时间 (Unix 毫秒) */
  updated_at: number
}

/// 歌单数据类型 (旧版, localStorage, 保留用于迁移)
export interface Playlist {
  /** 歌单唯一标识 */
  id: string
  /** 歌单名称 */
  name: string
  /** 歌单类型：default 为默认歌单（不可删除/重命名），custom 为用户创建 */
  type: 'default' | 'custom'
  /** 歌曲 ID 列表（引用） */
  songIds: string[]
  /** 是否展开（仅用于 UI 状态） */
  expanded?: boolean
}

/// 歌单记录 (SQLite 版)
export interface PlaylistRecord {
  id: number
  name: string
  description: string
  is_default: boolean
  sort_order: number
  created_at: number
  updated_at: number
  song_count: number
  /** UI 状态: 是否展开 */
  expanded?: boolean
}

/// 歌单中的歌曲 (带元数据)
export interface PlaylistSong {
  song_hash: string
  song_path: string
  title: string
  artist: string
  duration: number
  cover_path: string
  position: number
  added_at: number
}

/// 循环模式
export type LoopMode = 'list' | 'single' | 'none' | 'shuffle'

/// 主题模式
export type ThemeMode = 'light' | 'dark' | 'system'

/// 背景图片设置
export interface BackgroundSettings {
  /** 背景模式：none 无背景, color 纯色, image 单图, folder 文件夹轮播 */
  mode: 'none' | 'color' | 'image' | 'folder'
  /** 背景图片路径（单图模式） */
  imagePath?: string
  /** 背景图片文件夹路径（文件夹轮播模式） */
  folderPath?: string
  /** 背景图片列表（文件夹模式下缓存的图片路径） */
  imageList?: string[]
  /** 当前显示的图片索引 */
  currentImageIndex?: number
  /** 轮播间隔（秒） */
  interval?: number
  /** 填充模式：cover 填充, contain 完整, repeat 平铺 */
  fit: 'cover' | 'contain' | 'repeat'
  /** 遮罩透明度（0-1） */
  overlay: number
  /** 缩放比例（0-200%） */
  scale: number
  /** 水平位置（0-100%） */
  positionX: number
  /** 垂直位置（0-100%） */
  positionY: number
  /** 模糊半径（px） */
  blur: number
}

/// 字体类型
export type FontFamily = 'system' | 'serif' | 'kaiti' | 'songti' | 'fangsong'

/// 字体设置
export interface FontSettings {
  /** 字体类型 */
  family: FontFamily
  /** 字体大小（px） */
  size: number
  /** 字体颜色（默认跟随主题） */
  useThemeColor: boolean
  /** 自定义字体颜色（仅在 useThemeColor 为 false 时生效） */
  customColor?: string
}

/// 播放历史记录
export interface PlayHistoryItem {
  /** 唯一标识 */
  id: string
  /** 歌曲 ID */
  songId: string
  /** 歌曲标题（冗余存储，方便展示） */
  title: string
  /** 艺术家（冗余存储） */
  artist: string
  /** 专辑（冗余存储） */
  album: string
  /** 歌曲时长（秒） */
  duration: number
  /** 封面路径（冗余存储） */
  cover_path: string | null
  /** 文件路径（冗余存储） */
  file_path: string
  /** 开始播放时间（时间戳） */
  playedAt: number
  /** 实际播放时长（秒） */
  playedDuration: number
  /** 是否完整播放（播放超过 80% 视为完整播放） */
  completed: boolean
}

/** v1.2.0 - 数据目录信息 */
export interface DataDirInfo {
  /** 当前数据目录路径 */
  current_path: string
  /** 是否为自定义目录 */
  is_custom: boolean
  /** 默认数据目录路径 */
  default_path: string
}

/** v1.2.0 - 文件/目录使用量统计 */
export interface FileUsage {
  /** 名称 */
  name: string
  /** 路径 */
  path: string
  /** 大小（字节） */
  size_bytes: number
  /** 是否为目录 */
  is_dir: boolean
}