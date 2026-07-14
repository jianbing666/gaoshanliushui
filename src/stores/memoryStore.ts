import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { useLibraryStore } from './libraryStore'
import { useSettingsStore } from './settingsStore'
import { getMemory, saveMemory, parseShortTags, exportMemory, deleteMemory } from '@/utils/memories'
import type { MemoryRecord } from '@/types/song'

/**
 * Memory feature - 高山流水 v1.1: 回忆域 store
 *
 * 包含:
 *   - 当前歌曲的回忆 (currentMemory: ref<MemoryRecord | null>)
 *   - 短标签数组 (currentShortTags: computed) - 自动从 JSON 解析
 *   - 长文内容 (currentLongText: computed/ref) - 提供 setter 触发自动保存
 *   - 自动加载 (loadMemoryForCurrentSong): 切歌时自动重载
 *   - 保存节流 (saveShortTags / setLongText): 1s debounce
 *   - 导出 (exportCurrentMemory)
 *   - 删除 (deleteCurrentMemory)
 *
 * 不包含: UI 面板显隐(由 uiStore.showMemoryDrawer 负责), 数据库 IO 细节
 *
 * 失败兜底:
 *   - 后端 IPC 失败时, currentMemory 保持 null, UI 显示空态
 *   - 解析 short_tags 失败返回空数组, 不弹错
 */

export const useMemoryStore = defineStore('memory', () => {
  const library = useLibraryStore()
  const settings = useSettingsStore()

  // ========== 当前回忆 ==========
  const currentMemory = ref<MemoryRecord | null>(null)
  const isLoading = ref(false)

  /** 当前歌曲的内容指纹 (用于查表) */
  const currentHash = computed(() => library.currentSong?.content_hash ?? null)

  /** 短标签数组 (从 JSON 字符串解析) */
  const currentShortTags = computed<string[]>(() => {
    if (!currentMemory.value) return []
    return parseShortTags(currentMemory.value.short_tags)
  })

  /** 长文 (双向同步: UI 编辑 → 更新 ref → 触发自动保存) */
  const currentLongText = ref<string>('')

  // ========== 自动加载: 切歌时重载 ==========
  watch(
    currentHash,
    async (hash) => {
      if (!hash) {
        currentMemory.value = null
        currentLongText.value = ''
        return
      }
      await loadMemoryForCurrentSong(hash)
    },
    { immediate: true },
  )

  /** 显式加载指定 hash 的回忆 */
  async function loadMemoryForCurrentSong(songHash: string): Promise<void> {
    isLoading.value = true
    try {
      const record = await getMemory(songHash)
      currentMemory.value = record
      currentLongText.value = record?.long_text ?? ''
    } finally {
      isLoading.value = false
    }
  }

  // ========== 保存: 短标签 (立即保存) ==========
  let shortTagsSaveTimer: ReturnType<typeof setTimeout> | null = null
  async function saveShortTags(tags: string[]): Promise<void> {
    if (!currentHash.value || !library.currentSong) return
    // 立即更新本地 (乐观更新)
    if (currentMemory.value) {
      currentMemory.value = {
        ...currentMemory.value,
        short_tags: JSON.stringify(tags),
      }
    }
    // 短标签改动通常较少, 300ms 防抖即可
    if (shortTagsSaveTimer) clearTimeout(shortTagsSaveTimer)
    shortTagsSaveTimer = setTimeout(async () => {
      const result = await saveMemory(
        currentHash.value!,
        library.currentSong!.file_path,
        tags,
        currentLongText.value,
      )
      if (result) currentMemory.value = result
    }, 300)
  }

  // ========== 保存: 长文 (1s 防抖自动保存) ==========
  let longTextSaveTimer: ReturnType<typeof setTimeout> | null = null
  function setLongText(text: string): void {
    currentLongText.value = text
    if (!currentHash.value || !library.currentSong) return
    if (longTextSaveTimer) clearTimeout(longTextSaveTimer)
    longTextSaveTimer = setTimeout(async () => {
      const result = await saveMemory(
        currentHash.value!,
        library.currentSong!.file_path,
        currentShortTags.value,
        text,
      )
      if (result) currentMemory.value = result
    }, 1000)
  }

  /** 立即保存长文 (跳过防抖, 用于失焦/关闭抽屉时) */
  async function flushLongText(): Promise<void> {
    if (longTextSaveTimer) {
      clearTimeout(longTextSaveTimer)
      longTextSaveTimer = null
    }
    if (!currentHash.value || !library.currentSong) return
    const result = await saveMemory(
      currentHash.value,
      library.currentSong.file_path,
      currentShortTags.value,
      currentLongText.value,
    )
    if (result) currentMemory.value = result
  }

  // ========== 导出 ==========
  // BUG 6: 使用 settings.memoryExportDir 作为输出目录
  //   - 如果 memoryExportDir 为空, 用音乐库目录 (library.folderPath)
  //   - 如果都为空, 则不传 output_dir, 后端会导出到歌曲同目录
  async function exportCurrentMemory(): Promise<string | null> {
    if (!currentHash.value || !library.currentSong) {
      console.warn('[memories] 当前无歌曲, 无法导出')
      return null
    }
    // 确定输出目录
    const outputDir = settings.memoryExportDir || library.folderPath || undefined
    return await exportMemory(
      currentHash.value,
      library.currentSong.title,
      library.currentSong.artist,
      outputDir,
    )
  }

  // ========== 删除当前回忆 ==========
  async function deleteCurrentMemory(): Promise<boolean> {
    if (!currentHash.value) return false
    const ok = await deleteMemory(currentHash.value)
    if (ok) {
      currentMemory.value = null
      currentLongText.value = ''
    }
    return ok
  }

  return {
    // 状态
    currentMemory,
    isLoading,
    currentHash,
    currentShortTags,
    currentLongText,
    // 方法
    loadMemoryForCurrentSong,
    saveShortTags,
    setLongText,
    flushLongText,
    exportCurrentMemory,
    deleteCurrentMemory,
  }
})
