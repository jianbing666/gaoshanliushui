<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { useSettingsStore } from '@/stores/settingsStore'

interface MigrateProgressPayload {
  stage: string
  current_file: string
  processed_bytes: number
  total_bytes: number
  percent: number
}

const settings = useSettingsStore()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'completed'): void
}>()

const isMigrating = ref(false)
const targetPath = ref('')
const currentStage = ref('idle')
const currentFile = ref('')
const processedBytes = ref(0)
const totalBytes = ref(0)
const percent = ref(0)
const errorMsg = ref('')
const isClosing = ref(false)

let unlistenMigrateProgress: (() => void) | null = null

async function selectTargetDir() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择目标目录',
    })
    if (selected && typeof selected === 'string') {
      targetPath.value = selected
    }
  } catch (error) {
    console.error('选择目录失败:', error)
  }
}

async function startMigration() {
  if (!targetPath.value || isMigrating.value) return

  isMigrating.value = true
  errorMsg.value = ''
  currentStage.value = 'preparing'

  try {
    await invoke('migrate_data', { targetPath: targetPath.value })
    currentStage.value = 'completed'
    await settings.loadDataDirInfo()
    await settings.loadDataUsage()
    emit('completed')
  } catch (error: any) {
    console.error('迁移失败:', error)
    errorMsg.value = error?.toString() || '未知错误'
    currentStage.value = 'failed'
  } finally {
    isMigrating.value = false
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function stageLabel(stage: string): string {
  const map: Record<string, string> = {
    idle: '等待开始',
    preparing: '准备中...',
    checkpoint: '保存数据库状态...',
    copying: '正在复制文件...',
    switching: '切换到新目录...',
    completed: '迁移完成',
    failed: '迁移失败',
  }
  return map[stage] || stage
}

function closeModal() {
  if (isMigrating.value) return
  isClosing.value = true
  setTimeout(() => {
    emit('close')
    isClosing.value = false
  }, 150)
}

function handleOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    closeModal()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeModal()
  }
}

watch(
  () => currentStage.value,
  () => {},
  { immediate: false }
)

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  listen('data:migrate-progress', (event: any) => {
    const payload = event.payload as MigrateProgressPayload
    currentStage.value = payload.stage
    currentFile.value = payload.current_file
    processedBytes.value = payload.processed_bytes
    totalBytes.value = payload.total_bytes
    percent.value = payload.percent
  }).then((unlisten) => {
    unlistenMigrateProgress = unlisten
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  if (unlistenMigrateProgress) {
    unlistenMigrateProgress()
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[200] flex items-center justify-center"
      :class="{ 'animate-fade-in': !isClosing, 'animate-fade-out': isClosing }"
      @click="handleOverlayClick"
    >
      <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]"></div>

      <div
        class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-96 overflow-hidden"
        :class="{ 'animate-scale-in': !isClosing, 'animate-scale-out': isClosing }"
      >
        <div class="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 class="text-gray-900 dark:text-white text-base font-semibold">迁移数据目录</h2>
          <p class="text-gray-500 dark:text-gray-400 text-xs mt-1">将所有数据复制到新目录并切换</p>
        </div>

        <div class="px-5 py-4 space-y-4">
          <div class="space-y-2">
            <label class="text-xs text-gray-500 dark:text-gray-400">目标目录</label>
            <div class="flex gap-2">
              <div
                class="flex-1 px-3 py-2 bg-gray-100/60 dark:bg-gray-700/60 rounded-lg text-sm text-gray-900 dark:text-white truncate"
              >
                {{ targetPath || '请选择目标目录' }}
              </div>
              <button
                class="px-3 py-2 bg-gray-100/60 dark:bg-gray-700/60 hover:bg-gray-200/60 dark:hover:bg-gray-600/60 rounded-lg text-xs text-gray-700 dark:text-gray-300 transition-all disabled:opacity-50"
                :disabled="isMigrating"
                @click="selectTargetDir"
              >
                选择
              </button>
            </div>
          </div>

          <div v-if="currentStage !== 'idle'" class="space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs text-gray-500 dark:text-gray-400">{{
                stageLabel(currentStage)
              }}</span>
              <span class="text-xs text-gray-600 dark:text-gray-400 font-medium"
                >{{ percent.toFixed(1) }}%</span
              >
            </div>

            <div class="w-full h-2 bg-gray-100/60 dark:bg-gray-700/60 rounded-full overflow-hidden">
              <!--
                进度条用 scaleX 而不是 width：
                迁移/下载时进度按事件频率更新，改 width 每次都要重新布局，
                改 transform 只走合成，且圆角由父级 overflow-hidden 保证不被压扁。
              -->
              <div
                class="h-full origin-left bg-blue-500 dark:bg-blue-400 rounded-full transition-transform duration-100 ease-linear"
                :style="{ transform: `scaleX(${percent / 100})` }"
              ></div>
            </div>

            <p
              v-if="currentFile"
              class="text-xs text-gray-500 dark:text-gray-400 truncate"
              :title="currentFile"
            >
              {{ currentFile }}
            </p>

            <div class="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
              <span>{{ formatBytes(processedBytes) }}</span>
              <span>/</span>
              <span>{{ formatBytes(totalBytes) }}</span>
            </div>
          </div>

          <div
            v-if="currentStage === 'completed'"
            class="p-3 bg-green-50 dark:bg-green-900/20 rounded-lg"
          >
            <p class="text-sm text-green-700 dark:text-green-400 font-medium">迁移成功</p>
            <p class="text-xs text-green-600/80 dark:text-green-400/70 mt-1">
              数据已迁移到新目录，建议重启应用确保所有模块正常工作。
            </p>
          </div>

          <div
            v-if="currentStage === 'failed' && errorMsg"
            class="p-3 bg-red-50 dark:bg-red-900/20 rounded-lg"
          >
            <p class="text-sm text-red-700 dark:text-red-400 font-medium">迁移失败</p>
            <p class="text-xs text-red-600/80 dark:text-red-400/70 mt-1 break-all">
              {{ errorMsg }}
            </p>
          </div>

          <p
            v-if="currentStage === 'idle'"
            class="text-xs text-gray-400 dark:text-gray-500 leading-relaxed"
          >
            迁移过程中请勿关闭应用。迁移完成后将自动切换到新目录。
          </p>
        </div>

        <div class="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2">
          <button
            class="px-4 py-2 rounded-lg text-sm transition-all"
            :class="
              currentStage === 'completed'
                ? 'bg-blue-500 hover:bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300'
            "
            :disabled="isMigrating"
            @click="closeModal"
          >
            {{ currentStage === 'completed' ? '完成' : '取消' }}
          </button>
          <button
            v-if="currentStage === 'idle' || currentStage === 'failed'"
            class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!targetPath || isMigrating"
            @click="startMigration"
          >
            {{ isMigrating ? '迁移中...' : '开始迁移' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
