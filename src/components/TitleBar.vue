<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { usePlayerStore } from '@/stores/playerStore'
import SettingsIcon from '@/components/icons/SettingsIcon.vue'
import BarChart3Icon from '@/components/icons/BarChart3Icon.vue'
import DownloadIcon from '@/components/icons/DownloadIcon.vue'

const props = defineProps<{
  showSettings: boolean
  showMiniModeButton?: boolean
  showSidebarButton?: boolean
}>()

const player = usePlayerStore()
const appWindow = getCurrentWindow()
const isMaximized = ref(false)

let unlistenResized: (() => void) | null = null

onMounted(async () => {
  try {
    isMaximized.value = await appWindow.isMaximized()
    unlistenResized = await appWindow.onResized(async () => {
      isMaximized.value = await appWindow.isMaximized()
    }) as unknown as (() => void)
  } catch (e) {
    console.warn('[TitleBar] 获取窗口状态失败:', e)
  }
})

onUnmounted(() => {
  unlistenResized?.()
})

function minimize() {
  appWindow.minimize().catch((e) => console.error('[TitleBar] 最小化失败:', e))
}

function toggleMaximize() {
  if (isMaximized.value) {
    appWindow.unmaximize().catch((e) => console.error('[TitleBar] 还原失败:', e))
  } else {
    appWindow.maximize().catch((e) => console.error('[TitleBar] 最大化失败:', e))
  }
}

function closeWindow() {
  appWindow.close().catch((e) => console.error('[TitleBar] 关闭失败:', e))
}

const emit = defineEmits<{
  (e: 'toggleSettings'): void
  (e: 'toggleMiniMode'): void
}>()
</script>

<template>
  <div
    class="flex items-center h-12 px-3 select-none relative z-50 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-200/50 dark:border-gray-700/50"
  >
    <!-- 左侧：图标 + 标题 + 侧边栏按钮 + 历史记录按钮 -->
    <div class="flex items-center gap-2 flex-1 h-full">
      <!-- 应用图标 -->
      <!-- <svg class="w-4 h-4 text-gray-700 dark:text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18V5l12-2v13"></path>
        <circle cx="6" cy="18" r="3"></circle>
        <circle cx="18" cy="16" r="3"></circle>
      </svg> -->
      <!-- 标题 -->
      <span class="text-sm text-gray-700 dark:text-gray-300 font-medium">高山流水</span>
      <!-- 侧边栏展开/收起按钮 -->
      <button
        v-if="props.showSidebarButton"
        class="w-7 h-7 flex items-center justify-center rounded-md transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 hover:text-gray-700 dark:hover:text-gray-200"
        :title="player.showSidebar ? '收起侧栏' : '展开侧栏'"
        data-tauri-no-drag
        @click="player.toggleSidebar()"
      >
        <svg v-if="player.showSidebar" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" ry="2"></rect>
          <line x1="9" y1="4" x2="9" y2="20"></line>
        </svg>
        <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" ry="2"></rect>
          <line x1="15" y1="4" x2="15" y2="20"></line>
        </svg>
      </button>
      <!-- 历史记录按钮 -->
      <button
        class="w-7 h-7 flex items-center justify-center rounded-md transition-colors"
        :class="player.showHistoryDrawer
          ? 'bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
          : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 hover:text-gray-700 dark:hover:text-gray-200'"
        title="历史记录"
        data-tauri-no-drag
        @click="player.toggleHistoryDrawer()"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
          <path d="M3 3v5h5"></path>
          <path d="M12 7v5l4 2"></path>
        </svg>
      </button>
      <!-- 剩余空白可拖拽区域 -->
      <div class="flex-1 h-full" data-tauri-drag-region></div>
    </div>

    <!-- 右侧：功能按钮 + 窗口控制按钮 -->
    <div class="flex items-center h-full">
      <!-- 功能按钮组 -->
      <div class="flex items-center gap-0.5 mr-2" data-tauri-no-drag>
        <!-- 迷你模式按钮 -->
        <button
          v-if="props.showMiniModeButton && player.currentSong"
          class="w-8 h-8 flex items-center justify-center rounded-md transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 hover:text-gray-700 dark:hover:text-gray-200"
          title="迷你模式"
          @click="emit('toggleMiniMode')"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3v3a2 2 0 0 1-2 2H3"></path>
            <path d="M21 8h-3a2 2 0 0 1-2-2V3"></path>
            <path d="M3 16h3a2 2 0 0 1 2 2v3"></path>
            <path d="M16 21v-3a2 2 0 0 1 2-2h3"></path>
          </svg>
        </button>

        <!-- 下载按钮 -->
        <button
          class="w-8 h-8 flex items-center justify-center rounded-md transition-colors"
          :class="player.showDownloadPanel
            ? 'bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
            : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 hover:text-gray-700 dark:hover:text-gray-200'"
          title="下载"
          @click="player.toggleDownloadPanel()"
        >
          <DownloadIcon :size="16" />
        </button>

        <!-- 统计按钮 -->
        <button
          class="w-8 h-8 flex items-center justify-center rounded-md transition-colors"
          :class="player.showStatsPanel
            ? 'bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
            : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 hover:text-gray-700 dark:hover:text-gray-200'"
          title="统计"
          @click="player.toggleStatsPanel()"
        >
          <BarChart3Icon :size="16" />
        </button>

        <!-- 设置按钮 -->
        <button
          class="w-8 h-8 flex items-center justify-center rounded-md transition-colors"
          :class="props.showSettings
            ? 'bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400'
            : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 hover:text-gray-700 dark:hover:text-gray-200'"
          title="设置"
          @click="emit('toggleSettings')"
        >
          <SettingsIcon :size="16" />
        </button>
      </div>

      <!-- 分隔线 -->
      <div class="w-px h-4 bg-gray-300/60 dark:bg-gray-600/60 mr-1"></div>

      <!-- 窗口控制按钮 -->
      <div class="flex items-center" data-tauri-no-drag>
        <!-- 最小化 -->
        <button
          class="w-11 h-9 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
          title="最小化"
          @click="minimize"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M5 12h14"></path>
          </svg>
        </button>

        <!-- 最大化/还原 -->
        <button
          class="w-11 h-9 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
          :title="isMaximized ? '还原' : '最大化'"
          @click="toggleMaximize"
        >
          <svg v-if="!isMaximized" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="1"></rect>
          </svg>
          <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3v3a2 2 0 0 1-2 2H3"></path>
            <path d="M21 8h-3a2 2 0 0 1-2-2V3"></path>
            <path d="M3 16h3a2 2 0 0 1 2 2v3"></path>
            <path d="M16 21v-3a2 2 0 0 1 2-2h3"></path>
          </svg>
        </button>

        <!-- 关闭 -->
        <button
          class="w-11 h-9 flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-red-500 hover:text-white transition-colors"
          title="关闭"
          @click="closeWindow"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18"></path>
            <path d="m6 6 12 12"></path>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
