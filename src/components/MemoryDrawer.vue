<script setup lang="ts">
// Memory feature - 高山流水 v1.1: 回忆抽屉
// - w-80 (320px), 与项目其他右侧面板宽度统一
// - 顶部: 当前歌曲名
// - 短标签区: 圆角胶囊 + 实时保存 (300ms debounce)
// - 长回忆区: textarea + 预览模式 (marked 渲染), 1s 防抖自动保存
// - 右上角: 关闭 + 删除 + 导出按钮

import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import { open } from '@tauri-apps/plugin-dialog'
import { useMemoryStore } from '@/stores/memoryStore'
import { useUIStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useSettingsStore } from '@/stores/settingsStore'
import XIcon from '@/components/icons/XIcon.vue'
import ChevronRightIcon from '@/components/icons/ChevronRightIcon.vue'
import TrashIcon from '@/components/icons/TrashIcon.vue'
import DownloadIcon from '@/components/icons/DownloadIcon.vue'
import FolderIcon from '@/components/icons/FolderIcon.vue'
import PencilIcon from '@/components/icons/PencilIcon.vue'

const memory = useMemoryStore()
const ui = useUIStore()
const library = useLibraryStore()
const settings = useSettingsStore()

// 背景图片存在时, 面板背景使用 30-50% 透明度 (与其他面板保持一致)
const hasBackground = computed(() => !!settings.currentBackgroundUrl)

// BUG 6: 导出目录显示
//   - memoryExportDir 非空 → 使用自定义目录
//   - memoryExportDir 为空但 library.folderPath 非空 → 用音乐库目录
//   - 都为空 → 歌曲同目录 (显示为"歌曲同目录")
const exportDirDisplay = computed(() => {
  if (settings.memoryExportDir) {
    return settings.memoryExportDir
  }
  if (library.folderPath) {
    return library.folderPath + ' (音乐库目录)'
  }
  return '歌曲同目录'
})

// BUG 6: 选择导出文件夹
async function selectExportDir() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择备注导出文件夹',
      defaultPath: settings.memoryExportDir || library.folderPath || undefined,
    })
    if (selected && typeof selected === 'string') {
      settings.setMemoryExportDir(selected)
    }
  } catch (error) {
    console.warn('选择导出文件夹失败:', error)
  }
}

// ========== 短标签输入 ==========
const tagInput = ref('')
const localTags = ref<string[]>([])

// 抽屉打开时同步当前回忆的标签
watch(
  () => memory.currentShortTags,
  (tags) => {
    localTags.value = [...tags]
  },
  { immediate: true }
)

/** 保存短标签 */
function saveTags() {
  if (!memory.currentHash) return
  memory.saveShortTags([...localTags.value])
}

/** 添加标签: 按 - 分割输入, 也支持回车添加单条 */
function addTagsFromInput() {
  if (!tagInput.value.trim()) return
  // 按 `-` 分割, 过滤空
  const parts = tagInput.value
    .split('-')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const p of parts) {
    if (!localTags.value.includes(p)) {
      localTags.value.push(p)
    }
  }
  tagInput.value = ''
  saveTags()
}

/** 删除单个标签 */
function removeTag(tag: string) {
  localTags.value = localTags.value.filter((t) => t !== tag)
  saveTags()
}

// ========== 长文 (双向绑定 + 1s 防抖自动保存) ==========
const longText = ref('')
const showPreview = ref(false)

watch(
  () => memory.currentLongText,
  (text) => {
    if (longText.value !== text) {
      longText.value = text
    }
  },
  { immediate: true }
)

function onLongTextInput(e: Event) {
  const value = (e.target as HTMLTextAreaElement).value
  longText.value = value
  memory.setLongText(value)
}

/** Markdown 渲染 (安全: marked v14 默认 sanitize-on 仍需 XSS 兜底) */
const renderedHtml = computed(() => {
  if (!showPreview.value) return ''
  try {
    // marked 14 已默认开启 GFM, 不需要额外配置
    return marked.parse(longText.value || '', { async: false }) as string
  } catch {
    return '<p class="text-red-500">渲染失败</p>'
  }
})

// ========== 导出 / 删除 ==========
const exporting = ref(false)
async function handleExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const path = await memory.exportCurrentMemory()
    if (path) {
      exportToast.value = `已导出到: ${path}`
    } else {
      exportToast.value = '导出失败: 该歌曲暂无记忆'
    }
    setTimeout(() => (exportToast.value = ''), 4000)
  } finally {
    exporting.value = false
  }
}
const exportToast = ref('')

const confirmingDelete = ref(false)
async function handleDelete() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    setTimeout(() => (confirmingDelete.value = false), 3000)
    return
  }
  const ok = await memory.deleteCurrentMemory()
  if (ok) {
    localTags.value = []
    longText.value = ''
    confirmingDelete.value = false
  }
}

// ========== 关闭前 flush 长文 ==========
function handleClose() {
  void memory.flushLongText()
  ui.toggleMemoryDrawer()
}

// ========== 失焦 flush ==========
function onTextareaBlur() {
  void memory.flushLongText()
}

onBeforeUnmount(() => {
  void memory.flushLongText()
})

// ========== 编辑元数据 ==========
const songTitleRef = ref<HTMLElement | null>(null)
function handleEditMetadata() {
  if (!library.currentSong || !songTitleRef.value) return
  const rect = songTitleRef.value.getBoundingClientRect()
  ui.openEditMetadata(library.currentSong, rect.left, rect.bottom + 4)
}
</script>

<template>
  <aside
    class="w-80 h-full flex flex-col backdrop-blur border-l border-gray-200/60 dark:border-gray-700/60 shadow-2xl"
    :class="hasBackground ? 'bg-white/50 dark:bg-gray-900/50' : 'bg-white/90 dark:bg-gray-900/90'"
  >
    <!-- 头部: 歌曲名 + 关闭按钮 -->
    <div
      class="px-5 py-4 border-b border-gray-200/50 dark:border-gray-700/50 flex items-center justify-between gap-2 min-w-0"
    >
      <div class="min-w-0 flex-1 flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <h2
            ref="songTitleRef"
            class="text-gray-900 dark:text-white text-base font-semibold truncate"
            :title="library.currentSong?.title || ''"
          >
            {{ library.currentSong?.title || '请先选择歌曲' }}
          </h2>
          <p class="text-gray-500 dark:text-gray-400 text-xs truncate">
            {{ library.currentSong?.artist || '未播放' }}
          </p>
        </div>
        <button
          v-if="library.currentSong"
          class="p-1 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors shrink-0"
          title="编辑歌曲元数据"
          @click="handleEditMetadata"
        >
          <PencilIcon :size="15" />
        </button>
      </div>
      <button
        class="p-1.5 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white transition-colors shrink-0"
        title="关闭"
        @click="handleClose"
      >
        <ChevronRightIcon :size="18" />
      </button>
    </div>

    <!-- BUG 5 修复: 在抽屉内提供「显示弹幕」开关, 用户可独立控制当前会话的弹幕 -->
    <div
      class="px-5 py-2.5 border-b border-gray-200/50 dark:border-gray-700/50 flex items-center justify-between"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">显示弹幕</span>
        <span class="text-[10px] text-gray-400 dark:text-gray-500 truncate"
          >播放时在唱片上方滚动</span
        >
      </div>
      <button
        class="relative w-9 h-5 rounded-full transition-colors shrink-0"
        :class="
          settings.showMemoryTags ? 'bg-blue-500 dark:bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
        "
        :title="settings.showMemoryTags ? '关闭弹幕' : '开启弹幕'"
        @click="settings.setShowMemoryTags(!settings.showMemoryTags)"
      >
        <div
          class="absolute top-0.5 w-4 h-4 bg-white dark:bg-gray-900 rounded-full shadow transition-transform"
          :class="settings.showMemoryTags ? 'translate-x-[18px]' : 'translate-x-0.5'"
        ></div>
      </button>
    </div>

    <!-- 无歌曲空态 -->
    <div v-if="!library.currentSong" class="flex-1 flex items-center justify-center px-6">
      <div class="text-center">
        <div class="text-4xl mb-3 opacity-50">♪</div>
        <p class="text-gray-500 dark:text-gray-400 text-sm">选择歌曲后写下回忆</p>
      </div>
    </div>

    <!-- 主体: 标签 + 长文 -->
    <div v-else class="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-5 scrollbar-hide">
      <!-- 短标签区 -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h3 class="text-gray-900 dark:text-white text-sm font-semibold">短标签</h3>
          <span class="text-xs text-gray-400 dark:text-gray-500">{{ localTags.length }} 个</span>
        </div>

        <!-- 已有标签: 圆角胶囊 (B 站弹幕风格) -->
        <div v-if="localTags.length" class="flex flex-wrap gap-1.5">
          <span
            v-for="tag in localTags"
            :key="tag"
            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-blue-500/10 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-200/50 dark:border-blue-500/30"
          >
            {{ tag }}
            <button
              class="hover:text-red-500 dark:hover:text-red-400 transition-colors"
              :title="`删除标签 ${tag}`"
              @click="removeTag(tag)"
            >
              <XIcon :size="12" />
            </button>
          </span>
        </div>

        <!-- 输入区 -->
        <div class="flex items-center gap-2">
          <input
            v-model="tagInput"
            type="text"
            placeholder="输入标签，用 - 分隔"
            class="flex-1 min-w-0 bg-gray-100/60 dark:bg-gray-800/60 rounded-md px-3 py-1.5 text-xs text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            @keydown.enter="addTagsFromInput"
          />
          <button
            class="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-md text-xs font-medium transition-colors disabled:opacity-50"
            :disabled="!tagInput.trim()"
            @click="addTagsFromInput"
          >
            保存
          </button>
        </div>
        <p class="text-xs text-gray-400 dark:text-gray-500">示例: 通宵的小曲儿-2019的那年夏天</p>
      </div>

      <!-- 分隔 -->
      <div class="border-t border-gray-200/50 dark:border-gray-700/50"></div>

      <!-- 长回忆区 -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h3 class="text-gray-900 dark:text-white text-sm font-semibold">长回忆</h3>
          <button
            class="text-xs px-2 py-0.5 rounded transition-colors"
            :class="
              showPreview
                ? 'bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            "
            @click="showPreview = !showPreview"
          >
            {{ showPreview ? '编辑' : '预览' }}
          </button>
        </div>

        <!-- 编辑模式 -->
        <textarea
          v-if="!showPreview"
          :value="longText"
          rows="6"
          class="w-full min-h-[120px] max-h-[40vh] bg-gray-100/60 dark:bg-gray-800/60 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
          placeholder="写下这首曲子背后的故事…"
          @input="onLongTextInput"
          @blur="onTextareaBlur"
        />
        <!-- 预览模式 -->
        <!-- eslint-disable-next-line vue/no-v-html -- 渲染的是用户自己写的回忆 Markdown, 非外部输入; 渲染前经 marked 处理 -->
        <div
          v-else
          class="memory-markdown min-h-[120px] max-h-[40vh] overflow-y-auto bg-gray-100/60 dark:bg-gray-800/60 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-white prose prose-sm dark:prose-invert max-w-none"
          v-html="renderedHtml"
        ></div>
        <p class="text-xs text-gray-400 dark:text-gray-500">输入停止 1 秒后自动保存</p>
      </div>

      <!-- 分隔 -->
      <div class="border-t border-gray-200/50 dark:border-gray-700/50"></div>

      <!-- BUG 6: 导出目录设置 -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-600 dark:text-gray-300">导出目录</span>
        </div>
        <div class="flex items-center gap-2">
          <div
            class="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-2 bg-gray-100/60 dark:bg-gray-800/60 rounded-md"
          >
            <FolderIcon :size="14" class="shrink-0 text-gray-400 dark:text-gray-500" />
            <span
              class="text-xs text-gray-600 dark:text-gray-400 truncate"
              :title="exportDirDisplay"
            >
              {{ exportDirDisplay }}
            </span>
          </div>
          <button
            class="px-2.5 py-2 rounded-md bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 transition-colors shrink-0"
            title="选择导出文件夹"
            @click="selectExportDir"
          >
            <FolderIcon :size="14" />
          </button>
        </div>
        <p class="text-[10px] text-gray-400 dark:text-gray-500">默认导出到音乐库目录，可自定义</p>
      </div>

      <!-- 操作按钮 -->
      <div class="flex items-center gap-2">
        <button
          class="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-md text-xs text-gray-700 dark:text-gray-300 transition-colors disabled:opacity-50"
          :disabled="exporting"
          @click="handleExport"
        >
          <DownloadIcon :size="14" />
          {{ exporting ? '导出中...' : '导出备注' }}
        </button>
        <button
          class="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs transition-colors"
          :class="
            confirmingDelete
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-gray-100/60 dark:bg-gray-800/60 hover:bg-red-100 dark:hover:bg-red-900/30 text-gray-700 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400'
          "
          @click="handleDelete"
        >
          <TrashIcon :size="14" />
          {{ confirmingDelete ? '再次点击确认' : '删除' }}
        </button>
      </div>

      <!-- 导出提示 -->
      <transition name="fade">
        <p
          v-if="exportToast"
          class="text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-md px-3 py-2"
        >
          {{ exportToast }}
        </p>
      </transition>
    </div>
  </aside>
</template>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Markdown 渲染样式 (作用域内避免污染全局) */
.memory-markdown :deep(h1) {
  font-size: 1.5em;
  font-weight: 600;
  margin: 0.5em 0;
}
.memory-markdown :deep(h2) {
  font-size: 1.25em;
  font-weight: 600;
  margin: 0.5em 0;
}
.memory-markdown :deep(h3) {
  font-size: 1.1em;
  font-weight: 600;
  margin: 0.5em 0;
}
.memory-markdown :deep(p) {
  margin: 0.5em 0;
  line-height: 1.6;
}
.memory-markdown :deep(ul),
.memory-markdown :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}
.memory-markdown :deep(li) {
  margin: 0.2em 0;
}
.memory-markdown :deep(code) {
  background: rgba(0, 0, 0, 0.05);
  padding: 0.1em 0.3em;
  border-radius: 0.2em;
  font-size: 0.9em;
  font-family: ui-monospace, monospace;
}
.dark .memory-markdown :deep(code) {
  background: rgba(255, 255, 255, 0.1);
}
.memory-markdown :deep(pre) {
  background: rgba(0, 0, 0, 0.05);
  padding: 0.5em;
  border-radius: 0.3em;
  overflow-x: auto;
  margin: 0.5em 0;
}
.memory-markdown :deep(blockquote) {
  border-left: 3px solid rgba(0, 0, 0, 0.1);
  padding-left: 0.8em;
  margin: 0.5em 0;
  color: rgba(0, 0, 0, 0.6);
}
.dark .memory-markdown :deep(blockquote) {
  border-left-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.6);
}
.memory-markdown :deep(a) {
  color: #3b82f6;
  text-decoration: underline;
}
</style>
