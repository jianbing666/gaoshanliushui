// Memory feature - 高山流水 v1.1: 后端 Tauri 命令的 TS 封装
//
// 设计原则:
//   - 集中所有 IPC 调用, 业务 store 只 import 此文件
//   - 失败统一 console.warn, 不抛出阻断性错误 (符合"数据库失败降级"约束)
//   - 类型安全: MemoryRecord 与 Rust 端严格对应
//   - 解析容错: short_tags 可能是损坏的 JSON, 用 try/catch 兜底

import { invoke } from '@tauri-apps/api/core'
import type { MemoryRecord } from '@/types/song'

/**
 * 查询单条回忆
 * @param songHash 文件内容指纹 (Song.content_hash), undefined/空字符串返回 null
 * @returns 记录或 null (无记录 / 数据库失败)
 */
export async function getMemory(songHash: string | null | undefined): Promise<MemoryRecord | null> {
  if (!songHash) return null
  try {
    const result = await invoke<MemoryRecord | null>('get_memory', { songHash })
    return result
  } catch (error) {
    console.warn('[memories] getMemory 失败, 回忆功能降级:', error)
    return null
  }
}

/**
 * 保存 (upsert) 回忆
 * @returns 保存后的记录, 失败返回 null
 */
export async function saveMemory(
  songHash: string,
  songPath: string,
  shortTags: string[],
  longText: string
): Promise<MemoryRecord | null> {
  if (!songHash) return null
  try {
    const result = await invoke<MemoryRecord>('save_memory', {
      songHash,
      songPath,
      shortTags,
      longText,
    })
    return result
  } catch (error) {
    console.warn('[memories] saveMemory 失败:', error)
    return null
  }
}

/**
 * 删除回忆
 * @returns 是否成功删除
 */
export async function deleteMemory(songHash: string): Promise<boolean> {
  if (!songHash) return false
  try {
    return await invoke<boolean>('delete_memory', { songHash })
  } catch (error) {
    console.warn('[memories] deleteMemory 失败:', error)
    return false
  }
}

/**
 * 导出备注到指定目录
 * @param outputDir 输出目录, 不传则导出到歌曲所在目录
 * @returns 导出文件绝对路径, 失败返回 null
 */
export async function exportMemory(
  songHash: string,
  songTitle: string,
  songArtist: string,
  outputDir?: string
): Promise<string | null> {
  if (!songHash) return null
  try {
    return await invoke<string>('export_memory', {
      songHash,
      songTitle,
      songArtist,
      outputDir: outputDir ?? null,
    })
  } catch (error) {
    console.warn('[memories] exportMemory 失败:', error)
    return null
  }
}

/**
 * 解析 short_tags JSON 字符串
 * @returns 标签数组, 解析失败返回空数组
 */
export function parseShortTags(shortTags: string | null | undefined): string[] {
  if (!shortTags) return []
  try {
    const parsed = JSON.parse(shortTags)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed
    }
    return []
  } catch {
    return []
  }
}
