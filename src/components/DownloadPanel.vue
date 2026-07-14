<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { usePlayerStore } from '@/stores/playerStore'
import FolderIcon from '@/components/icons/FolderIcon.vue'
import ChevronRightIcon from '@/components/icons/ChevronRightIcon.vue'
import DownloadIcon from '@/components/icons/DownloadIcon.vue'

const player = usePlayerStore()

// 表单字段
const url = ref('')
const singer = ref('')
const song = ref('')
const outputDir = ref('')

// 状态
const isDownloading = ref(false)
const progressStage = ref('')
const progressMessage = ref('')
const progressPercent = ref(0)
const status = ref<'idle' | 'success' | 'error'>('idle')
const resultMessage = ref('')
const lastSavedPath = ref('')
const coverPreview = ref('')

let unlistenProgress: UnlistenFn | null = null

// 进度阶段展示
const stageLabel = computed(() => {
  switch (progressStage.value) {
    case 'parsing':
      return '解析链接'
    case 'downloading_audio':
      return '下载音频'
    case 'converting':
      return '转换 MP3'
    case 'downloading_cover':
      return '下载封面'
    case 'done':
      return '完成'
    case 'error':
      return '失败'
    default:
      return '等待'
  }
})

// 提交按钮可用性
const canSubmit = computed(() => {
  return !isDownloading.value && url.value.trim() !== '' && outputDir.value !== ''
})

// 解析视频信息（可选预填）
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
    // 解析成功时,仅当用户未填写歌名才预填
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

// 选择输出目录
async function selectOutputDir() {
  if (isDownloading.value) return
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择输出文件夹',
    })
    if (selected) {
      outputDir.value = selected as string
    }
  } catch (e) {
    console.error('[Download] 选择文件夹失败:', e)
  }
}

// 开始下载
async function startDownload() {
  if (!canSubmit.value) return

  // 重置状态
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
  outputDir.value = ''
  coverPreview.value = ''
  status.value = 'idle'
  resultMessage.value = ''
  progressStage.value = ''
  progressMessage.value = ''
  progressPercent.value = 0
  lastSavedPath.value = ''
}

onMounted(async () => {
  try {
    unlistenProgress = await listen<{ stage: string; message: string; percent: number }>(
      'download-progress',
      (event) => {
        progressStage.value = event.payload.stage
        progressMessage.value = event.payload.message
        progressPercent.value = event.payload.percent
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
      <button
        class="p-1.5 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white transition-colors"
        title="关闭"
        @click="player.toggleDownloadPanel()"
      >
        <ChevronRightIcon :size="18" />
      </button>
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
          >
            {{ outputDir || '未选择' }}
          </div>
          <button
            class="px-2.5 py-2 rounded-md bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 transition-colors disabled:opacity-50 shrink-0"
            :disabled="isDownloading"
            title="选择文件夹"
            @click="selectOutputDir"
          >
            <FolderIcon :size="14" />
          </button>
        </div>
        <p class="text-xs text-gray-400 dark:text-gray-500 mt-1">
          输出文件名：歌手-歌名.mp3（同时生成同名 .jpg 封面）
        </p>
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

      <!-- 进度条 -->
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

      <!-- 提示信息 -->
      <div
        v-if="!isDownloading && status === 'idle'"
        class="text-xs text-gray-400 dark:text-gray-500 leading-relaxed bg-gray-100/40 dark:bg-gray-800/40 rounded-md p-3"
      >
        需要本机已安装 ffmpeg（并支持 libmp3lame）。下载完成后 MP3 与封面图片将保存到所选目录。
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
