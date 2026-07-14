/**
 * 统一 LocalStorage 读写工具
 *
 * 设计目标:
 *   - 集中所有 key 定义,避免散落
 *   - 容错:读取失败返回默认值,写入失败静默
 *   - 业务层 store 统一调用此处
 *
 * 注意:
 *   - 修改 STORAGE_KEYS 会破坏向后兼容,严禁随意改名
 *   - loadPlaylists 失败时返回默认 "全部歌曲" 歌单
 *   - loadFullPlayHistory 失败时回退到 display history(老数据兼容)
 */

import type { Playlist, PlayHistoryItem } from '@/types/song'

/// LocalStorage 键与限制
export const STORAGE_KEYS = {
  /** 应用总设置(volume/theme/background/...) */
  settings: 'gaoshanliushui-settings',
  /** 音乐库路径(单独存,启动时优先读取) */
  musicLibraryPath: 'musicLibraryPath',
  /** 歌单数据 */
  playlists: 'gaoshanliushui-playlists',
  /** 展示用播放历史(去重,最多 500) */
  history: 'gaoshanliushui-history',
  /** 完整播放历史(不去重,最多 10000,用于统计) */
  fullHistory: 'gaoshanliushui-full-history',
} as const

export const MAX_HISTORY_ITEMS = 500
export const MAX_FULL_HISTORY_ITEMS = 10000

// ========== 通用 settings 读写 ==========

export function loadSettings(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.settings)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveSettings(settings: Record<string, unknown>): void {
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings))
  } catch {
    // 忽略写入失败
  }
}

// ========== 音乐库路径 ==========

export function getMusicLibraryPath(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.musicLibraryPath)
  } catch {
    return null
  }
}

export function setMusicLibraryPath(path: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS.musicLibraryPath, path)
  } catch {
    // 忽略写入失败
  }
}

export function clearMusicLibraryPath(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.musicLibraryPath)
  } catch {
    // 忽略删除失败
  }
}

// ========== 歌单 ==========

export function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.playlists)
    if (raw) return JSON.parse(raw)
  } catch {
    // 忽略读取失败
  }
  // 默认歌单
  return [
    {
      id: 'all-songs',
      name: '全部歌曲',
      type: 'default',
      songIds: [],
      expanded: true,
    },
  ]
}

export function savePlaylists(playlists: Playlist[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.playlists, JSON.stringify(playlists))
  } catch {
    // 忽略写入失败
  }
}

// ========== 播放历史 ==========

export function loadPlayHistory(): PlayHistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.history)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function loadFullPlayHistory(): PlayHistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.fullHistory)
    if (raw) return JSON.parse(raw)
    // 首次加载时,如果没有完整记录,用现有展示记录初始化
    const displayRaw = localStorage.getItem(STORAGE_KEYS.history)
    return displayRaw ? JSON.parse(displayRaw) : []
  } catch {
    return []
  }
}

export function savePlayHistory(items: PlayHistoryItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(items))
  } catch {
    // 忽略写入失败
  }
}

export function saveFullPlayHistory(items: PlayHistoryItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.fullHistory, JSON.stringify(items))
  } catch {
    // 忽略写入失败
  }
}

// ========== 通用工具 ==========

/// 生成唯一 ID(用于歌单、历史项等)
export function generateId(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

/// 检测系统主题偏好
export function getSystemTheme(): 'light' | 'dark' {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}
