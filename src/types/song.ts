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

/// 歌单数据类型
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