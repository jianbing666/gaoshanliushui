<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import FolderIcon from '@/components/icons/FolderIcon.vue'
import ChevronRightIcon from '@/components/icons/ChevronRightIcon.vue'
import DownloadIcon from '@/components/icons/DownloadIcon.vue'
import XIcon from '@/components/icons/XIcon.vue'
import CheckIcon from '@/components/icons/CheckIcon.vue'

const settings = useSettingsStore()
const ui = useUIStore()
const library = useLibraryStore()

// ============== 表单字段 (单条模式) ==============
const url = ref('')
const singer = ref('')
const song = ref('')
const outputDir = ref(settings.downloadOutputDir)  // 从持久化中恢复

// ============== 单条状态 ==============
const isDownloading = ref(false)
const progressStage = ref('')
const progressMessage = ref('')
const progressPercent = ref(0)
const status = ref<'idle' | 'success' | 'error'>('idle')
const resultMessage = ref('')
const lastSavedPath = ref('')
const coverPreview = ref('')

// ============== 批量下载状态 ==============
/** 单条批量任务 */
interface BatchItem {
  /** 用户填写的 singer (或解析自文本) */
  singer: string
  /** 用户填写的 song (或解析自文本) */
  song: string
  /** B 站链接 */
  url: string
  /** 任务状态: pending/running/success/error/skipped */
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped'
  /** 进度百分比 0-100 */
  progress: number
  /** 当前阶段标签 */
  stage: string
  /** 结果/错误信息 */
  message: string
  /** 最终保存路径 */
  savedPath: string
}

const showBatchPanel = ref(false)
const batchItems = ref<BatchItem[]>([])
const batchRunning = ref(false)
const batchCurrentIndex = ref(-1) // -1 表示未开始
const batchFinished = ref(false)  // 全部完成标记
const batchLog = ref<string[]>([]) // 全局日志, 用于汇总

let unlistenProgress: UnlistenFn | null = null

// ============== 辅助 ==============
const stageLabel = computed(() => {
  switch (progressStage.value) {
    case 'parsing': return '解析链接'
    case 'downloading_audio': return '下载音频'
    case 'converting': return '转换 MP3'
    case 'downloading_cover': return '下载封面'
    case 'done': return '完成'
    case 'error': return '失败'
    default: return '等待'
  }
})

const canSubmit = computed(() => {
  return !isDownloading.value && url.value.trim() !== '' && outputDir.value !== ''
})

// 批量相关计算属性
const batchTotal = computed(() => batchItems.value.length)
const batchCompleted = computed(() =>
  batchItems.value.filter(i => i.status === 'success' || i.status === 'skipped').length
)
const batchFailed = computed(() =>
  batchItems.value.filter(i => i.status === 'error').length
)
const batchProgress = computed(() => {
  if (batchTotal.value === 0) return 0
  return Math.round((batchCompleted.value / batchTotal.value) * 100)
})

// ============== 单条模式: 解析 ==============
async function handleParseInfo() {
  if (!url.value.trim()) {
    status.value = 'error'
    resultMessage.value = '请先输入 B 站视频链接'
    return
  }
  if (isDownloading.value) return

  status.value = 'idle'
  resultMessage.value = ''
  try {
    const info = await invoke<{ bvid: string; title: string; cover_url: string; duration: number }>(
      'parse_bilibili_url',
      { url: url.value.trim() }
    )
    if (!song.value.trim()) {
      song.value = info.title
    }
    coverPreview.value = info.cover_url
    resultMessage.value = `已识别视频: ${info.title}`
  } catch (e) {
    status.value = 'error'
    resultMessage.value = typeof e === 'string' ? e : String(e)
    coverPreview.value = ''
  }
}

// ============== 选择输出目录 ==============
async function selectOutputDir() {
  if (isDownloading.value || batchRunning.value) return
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择输出文件夹',
    })
    if (selected) {
      const path = selected as string
      outputDir.value = path
      // 持久化: 下次进入自动填充
      settings.setDownloadOutputDir(path)
    }
  } catch (e) {
    console.error('[Download] 选择文件夹失败:', e)
  }
}

// ============== 单条模式: 下载 ==============
async function startDownload() {
  if (!canSubmit.value) return

  isDownloading.value = true
  status.value = 'idle'
  resultMessage.value = ''
  progressStage.value = 'parsing'
  progressMessage.value = '准备中...'
  progressPercent.value = 0
  lastSavedPath.value = ''

  try {
    const savedPath = await invoke<string>('download_bilibili_music', {
      url: url.value.trim(),
      outputDir: outputDir.value,
      singer: singer.value.trim() || null,
      song: song.value.trim() || null,
    })
    status.value = 'success'
    resultMessage.value = `已保存到: ${savedPath}`
    lastSavedPath.value = savedPath
    await library.autoLoadMusicLibrary()
  } catch (e) {
    status.value = 'error'
    resultMessage.value = typeof e === 'string' ? e : String(e)
  } finally {
    isDownloading.value = false
  }
}

function resetForm() {
  url.value = ''
  singer.value = ''
  song.value = ''
  // 不重置 outputDir (持久化)
  coverPreview.value = ''
  status.value = 'idle'
  resultMessage.value = ''
  progressStage.value = ''
  progressMessage.value = ''
  progressPercent.value = 0
  lastSavedPath.value = ''
}

// ============== 批量模式: 文档解析 ==============
/**
 * 解析批量文档内容
 * 格式: 同一行用 "-" 分隔 singer / song / url, 不同条目用换行分隔
 * 兼容 markdown 格式: 自动去除 [text](url) / `url` / 行首 - 等
 */
function parseBatchContent(content: string): BatchItem[] {
  const items: BatchItem[] = []
  const lines = content.split(/\r?\n/)
  for (const raw of lines) {
    let line = raw.trim()
    if (!line) continue

    // 去除 markdown 列表前缀: "- " / "* " / 数字+.+空格
    line = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '')

    // 去除行首/行尾的反引号包裹
    if (line.startsWith('`') && line.endsWith('`')) {
      line = line.slice(1, -1).trim()
    }
    if (line.startsWith('【') && line.endsWith('】')) {
      // 用户给的样例是 "【...】url" 形式, 去除包裹
      const innerEnd = line.lastIndexOf('】')
      const urlPart = line.slice(innerEnd + 1).trim()
      const namePart = line.slice(1, innerEnd).trim()
      if (urlPart) {
        line = `${namePart}-${urlPart}`
      } else {
        line = namePart
      }
    }

    // 用 "-" 分隔 (第一次: singer, 第二次: song, 其余: 并入 song)
    const parts = line.split('-').map(s => s.trim()).filter(Boolean)
    if (parts.length === 0) continue

    // 找到包含 B 站链接的部分
    const urlRegex = /(BV[a-zA-Z0-9]{10}|https?:\/\/[^\s]+|av\d+)/i
    let urlIdx = -1
    for (let i = 0; i < parts.length; i++) {
      if (urlRegex.test(parts[i])) {
        urlIdx = i
        break
      }
    }
    if (urlIdx < 0) continue // 没有链接的行跳过

    const url = parts[urlIdx]
    const beforeUrl = parts.slice(0, urlIdx)
    const afterUrl = parts.slice(urlIdx + 1)

    // 歌手 = beforeUrl[0] (如果存在)
    // 歌名 = beforeUrl[1..] + afterUrl 拼起来
    const singer = beforeUrl[0] || ''
    const song = [...beforeUrl.slice(1), ...afterUrl].join('-').trim()

    items.push({
      singer,
      song,
      url,
      status: 'pending',
      progress: 0,
      stage: '',
      message: '',
      savedPath: ''
    })
  }
  return items
}

/**
 * 选择并解析批量文档
 */
async function selectBatchFile() {
  if (batchRunning.value) return
  try {
    const selected = await open({
      multiple: false,
      title: '选择批量下载文档',
      filters: [
        { name: '文档', extensions: ['md', 'txt', 'markdown'] }
      ]
    })
    if (!selected) return

    const path = selected as string
    let content: string
    try {
      content = await invoke<string>('read_batch_file', { path })
    } catch (e) {
      batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] 读取失败: ${typeof e === 'string' ? e : String(e)}`)
      return
    }

    const items = parseBatchContent(content)
    if (items.length === 0) {
      batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] 文档中没有解析出有效的下载条目 (格式: 歌手-歌名-链接)`)
      return
    }

    batchItems.value = items
    batchFinished.value = false
    batchCurrentIndex.value = -1
    batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] 已加载 ${items.length} 个待下载条目`)
    showBatchPanel.value = true
  } catch (e) {
    console.error('[Download] 批量导入失败:', e)
  }
}

/**
 * 串行执行批量下载
 */
async function startBatchDownload() {
  if (batchRunning.value || batchItems.value.length === 0) return
  if (!outputDir.value) {
    batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] 请先选择输出文件夹`)
    return
  }

  batchRunning.value = true
  batchFinished.value = false
  batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] 开始批量下载, 共 ${batchItems.value.length} 项`)

  for (let i = 0; i < batchItems.value.length; i++) {
    const item = batchItems.value[i]
    batchCurrentIndex.value = i
    item.status = 'running'
    item.stage = '准备中'
    item.progress = 0
    item.message = ''

    try {
      const savedPath = await invoke<string>('download_bilibili_music', {
        url: item.url,
        outputDir: outputDir.value,
        singer: item.singer || null,
        song: item.song || null,
      })
      item.status = 'success'
      item.progress = 100
      item.stage = '完成'
      item.savedPath = savedPath
      item.message = savedPath
      batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] ✓ ${i + 1}/${batchItems.value.length} ${item.singer ? item.singer + '-' : ''}${item.song || '未命名'}`)
    } catch (e) {
      const errMsg = typeof e === 'string' ? e : String(e)
      item.status = 'error'
      item.stage = '失败'
      item.message = errMsg
      batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] ✗ ${i + 1}/${batchItems.value.length} ${item.singer ? item.singer + '-' : ''}${item.song || '未命名'} - ${errMsg}`)
    }
  }

  batchCurrentIndex.value = -1
  batchRunning.value = false
  batchFinished.value = true
  batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] 批量下载结束, 成功 ${batchCompleted.value}, 失败 ${batchFailed.value}`)

  if (batchCompleted.value > 0) {
    await library.autoLoadMusicLibrary()
    batchLog.value.unshift(`[${new Date().toLocaleTimeString()}] 音乐库已刷新`)
  }
}

function clearBatch() {
  if (batchRunning.value) return
  batchItems.value = []
  batchLog.value = []
  batchCurrentIndex.value = -1
  batchFinished.value = false
}

function exitBatch() {
  if (batchRunning.value) return
  showBatchPanel.value = false
}

// 监听下载进度事件
onMounted(async () => {
  try {
    unlistenProgress = await listen<{ stage: string; message: string; percent: number }>(
      'download-progress',
      (event) => {
        // 单条模式
        progressStage.value = event.payload.stage
        progressMessage.value = event.payload.message
        progressPercent.value = event.payload.percent

        // 批量模式: 更新当前任务的进度
        if (batchRunning.value && batchCurrentIndex.value >= 0) {
          const item = batchItems.value[batchCurrentIndex.value]
          if (item) {
            item.stage = event.payload.message
            item.progress = event.payload.percent
          }
        }
      }
    )
  } catch (e) {
    console.warn('[Download] 监听进度事件失败:', e)
  }
})

onUnmounted(() => {
  unlistenProgress?.()
})
</script>

<template>
  <div
    class="w-80 h-full flex flex-col bg-white/50 dark:bg-gray-900/60 backdrop-blur-2xl border-l border-gray-200/60 dark:border-gray-700/60 shadow-2xl"
  >
    <!-- 头部 -->
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-200/50 dark:border-gray-700/50">
      <div>
        <h2 class="text-gray-900 dark:text-white text-base font-semibold">下载音乐</h2>
        <p class="text-gray-500 dark:text-gray-400 text-xs">从 B 站视频提取 MP3 与封面</p>
      </div>
      <div class="flex items-center gap-1">
        <button
          class="p-1.5 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white transition-colors"
          title="批量导入文档"
          :disabled="batchRunning || isDownloading"
          @click="selectBatchFile"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </button>
        <button
          class="p-1.5 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white transition-colors"
          title="关闭"
          @click="ui.toggleDownloadPanel()"
        >
          <ChevronRightIcon :size="18" />
        </button>
      </div>
    </div>

    <!-- 内容区域 -->
    <div class="flex-1 overflow-y-auto p-5 space-y-4">
      <!-- 视频链接 -->
      <div>
        <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">
          视频链接 <span class="text-red-500">*</span>
        </label>
        <div class="flex gap-1.5">
          <input
            v-model="url"
            type="text"
            placeholder="BV 号或 https://www.bilibili.com/video/..."
            class="flex-1 min-w-0 bg-gray-100/60 dark:bg-gray-800/60 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:bg-white dark:focus:bg-gray-700 transition-colors"
            :disabled="isDownloading"
            @keyup.enter="handleParseInfo"
          />
          <button
            class="px-2.5 py-2 rounded-md bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-xs text-gray-600 dark:text-gray-300 transition-colors disabled:opacity-50"
            :disabled="!url.trim() || isDownloading"
            title="解析视频信息"
            @click="handleParseInfo"
          >
            解析
          </button>
        </div>
      </div>

      <!-- 歌手名 -->
      <div>
        <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">
          歌手名 <span class="text-gray-400 dark:text-gray-500">（可选）</span>
        </label>
        <input
          v-model="singer"
          type="text"
          placeholder="留空显示为「未知」"
          class="w-full bg-gray-100/60 dark:bg-gray-800/60 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:bg-white dark:focus:bg-gray-700 transition-colors"
          :disabled="isDownloading"
        />
      </div>

      <!-- 歌名 -->
      <div>
        <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">
          歌名 <span class="text-gray-400 dark:text-gray-500">（可选，留空使用视频标题）</span>
        </label>
        <input
          v-model="song"
          type="text"
          placeholder="留空使用视频名称"
          class="w-full bg-gray-100/60 dark:bg-gray-800/60 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:bg-white dark:focus:bg-gray-700 transition-colors"
          :disabled="isDownloading"
        />
      </div>

      <!-- 输出目录 -->
      <div>
        <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">
          输出文件夹 <span class="text-red-500">*</span>
        </label>
        <div class="flex gap-1.5">
          <div
            class="flex-1 min-w-0 bg-gray-100/60 dark:bg-gray-800/60 rounded-md px-3 py-2 text-sm text-gray-900 dark:text-white truncate"
            :class="{ 'text-gray-400 dark:text-gray-500': !outputDir }"
            :title="outputDir"
          >
            {{ outputDir || '未选择 (下次进入自动填充)' }}
          </div>
          <button
            class="px-2.5 py-2 rounded-md bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 transition-colors disabled:opacity-50 shrink-0"
            :disabled="isDownloading || batchRunning"
            title="选择文件夹"
            @click="selectOutputDir"
          >
            <FolderIcon :size="14" />
          </button>
        </div>
      </div>

      <!-- 封面预览 -->
      <div v-if="coverPreview" class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3 flex items-center gap-3">
        <div class="w-12 h-12 rounded bg-gray-200/70 dark:bg-gray-700/70 overflow-hidden shrink-0">
          <img :src="coverPreview" class="w-full h-full object-cover" referrerpolicy="no-referrer" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-xs text-gray-500 dark:text-gray-400">封面预览</p>
          <p class="text-sm text-gray-900 dark:text-white truncate">{{ song || '视频封面' }}</p>
        </div>
      </div>

      <!-- 单条进度 -->
      <div v-if="isDownloading || status === 'success' || status === 'error'" class="space-y-2">
        <div class="flex items-center justify-between text-xs">
          <span
            :class="{
              'text-blue-600 dark:text-blue-400': status === 'idle' || isDownloading,
              'text-green-600 dark:text-green-400': status === 'success',
              'text-red-600 dark:text-red-400': status === 'error',
            }"
          >
            {{ isDownloading ? stageLabel : status === 'success' ? '成功' : status === 'error' ? '失败' : '' }}
          </span>
          <span class="text-gray-500 dark:text-gray-400">{{ progressPercent }}%</span>
        </div>
        <div class="h-1.5 bg-gray-200/60 dark:bg-gray-700/60 rounded-full overflow-hidden">
          <div
            class="h-full transition-all duration-300"
            :class="{
              'bg-blue-500': status === 'idle' || isDownloading,
              'bg-green-500': status === 'success',
              'bg-red-500': status === 'error',
            }"
            :style="{ width: progressPercent + '%' }"
          ></div>
        </div>
        <p
          v-if="resultMessage"
          class="text-xs leading-relaxed break-all"
          :class="{
            'text-gray-600 dark:text-gray-300': status !== 'error' && status !== 'success',
            'text-green-700 dark:text-green-300': status === 'success',
            'text-red-600 dark:text-red-400': status === 'error',
          }"
        >
          {{ resultMessage }}
        </p>
      </div>

      <div
        v-if="!isDownloading && status === 'idle' && !showBatchPanel"
        class="text-xs text-gray-400 dark:text-gray-500 leading-relaxed bg-gray-100/40 dark:bg-gray-800/40 rounded-md p-3"
      >
        点击右上角文件图标可批量导入 .md / .txt 文档(每行: 歌手-歌名-链接)。
      </div>

      <!-- ==================== 批量下载区域 ==================== -->
      <div v-if="showBatchPanel" class="border-t border-gray-200/50 dark:border-gray-700/50 pt-4 -mx-5 px-5">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">批量下载</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              共 {{ batchTotal }} 项 · 成功 {{ batchCompleted }} · 失败 {{ batchFailed }}
            </p>
          </div>
          <div class="flex items-center gap-1">
            <button
              v-if="!batchRunning"
              class="px-2.5 py-1.5 rounded-md text-xs bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 transition-colors"
              title="清空列表"
              @click="clearBatch"
            >
              清空
            </button>
            <button
              class="px-2.5 py-1.5 rounded-md text-xs bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 transition-colors"
              title="关闭批量面板"
              :disabled="batchRunning"
              @click="exitBatch"
            >
              收起
            </button>
          </div>
        </div>

        <!-- 批量进度条 -->
        <div v-if="batchRunning || batchFinished" class="mb-3 space-y-1.5">
          <div class="flex items-center justify-between text-xs">
            <span
              :class="{
                'text-blue-600 dark:text-blue-400': batchRunning,
                'text-green-600 dark:text-green-400': batchFinished && batchFailed === 0,
                'text-yellow-600 dark:text-yellow-400': batchFinished && batchFailed > 0,
              }"
            >
              {{ batchRunning ? `下载中 (${batchCompleted + 1}/${batchTotal})` : batchFinished ? (batchFailed > 0 ? '完成 (部分失败)' : '全部完成') : '' }}
            </span>
            <span class="text-gray-500 dark:text-gray-400">{{ batchProgress }}%</span>
          </div>
          <div class="h-1.5 bg-gray-200/60 dark:bg-gray-700/60 rounded-full overflow-hidden">
            <div
              class="h-full transition-all duration-300 bg-blue-500"
              :style="{ width: batchProgress + '%' }"
            ></div>
          </div>
        </div>

        <!-- 任务列表 (可滚动, 最多显示 ~6 条) -->
        <div class="space-y-1.5 max-h-60 overflow-y-auto pr-1">
          <div
            v-for="(item, idx) in batchItems"
            :key="idx"
            class="bg-gray-100/50 dark:bg-gray-800/50 rounded-md p-2.5 text-xs"
            :class="{
              'ring-1 ring-blue-500/50': idx === batchCurrentIndex,
              'opacity-60': batchRunning && idx !== batchCurrentIndex && item.status === 'pending',
            }"
          >
            <div class="flex items-center gap-2 mb-1">
              <span class="shrink-0 w-4 h-4 flex items-center justify-center">
                <template v-if="item.status === 'pending'">
                  <span class="w-2 h-2 rounded-full bg-gray-300 dark:bg-gray-600"></span>
                </template>
                <template v-else-if="item.status === 'running'">
                  <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
                </template>
                <template v-else-if="item.status === 'success'">
                  <CheckIcon :size="12" class="text-green-500" />
                </template>
                <template v-else-if="item.status === 'error'">
                  <XIcon :size="12" class="text-red-500" />
                </template>
              </span>
              <span class="font-medium text-gray-900 dark:text-white truncate flex-1">
                {{ item.singer || '未知' }} - {{ item.song || '(未命名)' }}
              </span>
            </div>
            <div class="text-gray-400 dark:text-gray-500 truncate" :title="item.url">
              {{ item.url }}
            </div>
            <div
              v-if="item.status === 'running' || item.message"
              class="mt-1 leading-relaxed truncate"
              :class="{
                'text-blue-600 dark:text-blue-400': item.status === 'running',
                'text-green-600 dark:text-green-400': item.status === 'success',
                'text-red-500 dark:text-red-400': item.status === 'error',
              }"
              :title="item.message"
            >
              {{ item.stage || (item.status === 'success' ? '✓ 已保存' : item.status === 'error' ? '✗ 失败' : '') }}
              <span v-if="item.message && item.status === 'error'" class="opacity-75"> · {{ item.message }}</span>
            </div>
          </div>
        </div>

        <!-- 启动按钮 -->
        <button
          v-if="!batchRunning && !batchFinished"
          class="w-full mt-3 py-2 px-3 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-md text-xs font-medium hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors disabled:opacity-50"
          :disabled="batchItems.length === 0 || !outputDir"
          @click="startBatchDownload"
        >
          <DownloadIcon :size="12" />
          串行下载 {{ batchItems.length }} 项
        </button>
      </div>

      <!-- 批量日志 (最近 8 条) -->
      <div v-if="batchLog.length > 0" class="border-t border-gray-200/50 dark:border-gray-700/50 pt-3 -mx-5 px-5">
        <p class="text-xs text-gray-400 dark:text-gray-500 mb-1">最近日志</p>
        <div class="space-y-0.5 max-h-32 overflow-y-auto text-xs font-mono text-gray-500 dark:text-gray-400">
          <p v-for="(line, i) in batchLog.slice(0, 8)" :key="i" class="leading-relaxed">{{ line }}</p>
        </div>
      </div>
    </div>

    <!-- 底部操作按钮 -->
    <div class="p-4 border-t border-gray-200/50 dark:border-gray-700/50 flex gap-2">
      <button
        v-if="!isDownloading && (status === 'success' || status === 'error')"
        class="px-4 py-2.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        @click="resetForm"
      >
        清空
      </button>
      <button
        class="flex-1 py-2.5 px-4 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
        :disabled="!canSubmit"
        @click="startDownload"
      >
        <DownloadIcon :size="14" />
        {{ isDownloading ? '下载中...' : '开始下载' }}
      </button>
    </div>
  </div>
</template>
