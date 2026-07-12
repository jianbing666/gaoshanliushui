<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { ref, onMounted } from 'vue'
import Sidebar from '@/components/Sidebar.vue'
import Player from '@/components/Player.vue'
import ControlBar from '@/components/ControlBar.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'

const player = usePlayerStore()
const showSettings = ref(false)
const autoLoadError = ref<string | null>(null)

// 切换设置面板显示/隐藏
function toggleSettings() {
  showSettings.value = !showSettings.value
}

// 启动时自动加载音乐库
onMounted(async () => {
  const result = await player.autoLoadMusicLibrary()
  if (!result.success && result.error) {
    // 路径失效，显示错误提示
    autoLoadError.value = `音乐库路径已失效：${result.error}\n请在设置面板中重新选择目录`
    // 自动打开设置面板
    showSettings.value = true
  }
})
</script>

<template>
  <!-- 正常模式 -->
  <div class="flex flex-col h-screen bg-gradient-to-br from-gray-100 via-gray-50 to-gray-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 select-none">
    <!-- 顶部工具栏 -->
    <header class="h-12 bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl border-b border-gray-200/50 dark:border-gray-700/50 flex items-center justify-between px-4">
      <!-- 左侧标题 -->
      <div class="flex items-center gap-2">
        <h1 class="text-gray-900 dark:text-white text-sm font-medium">Bilibili Music Player</h1>
      </div>

      <!-- 右侧设置按钮 -->
      <button
        class="px-3 py-1.5 bg-gray-100/50 dark:bg-gray-700/50 hover:bg-gray-200/50 dark:hover:bg-gray-600/50 text-gray-700 dark:text-gray-300 text-sm rounded-lg transition-all duration-200 hover:scale-105"
        :class="{ 'bg-blue-600 hover:bg-blue-700': showSettings }"
        @click="toggleSettings"
      >
        设置
      </button>
    </header>

    <!-- 主内容区域 -->
    <div class="flex-1 flex min-h-0">
      <!-- 左侧边栏：播放列表 -->
      <Sidebar />

      <!-- 中央主区域：播放器 -->
      <main class="flex-1 flex flex-col min-w-0 relative">
        <!-- Loading 遮罩层（自动扫描时显示） -->
        <div
          v-if="player.isLoading && player.playlist.length === 0"
          class="absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl flex items-center justify-center z-10"
        >
          <div class="text-center">
            <div class="animate-spin text-4xl mb-3">⟳</div>
            <p class="text-gray-700 dark:text-gray-300 text-sm">正在扫描音乐库...</p>
          </div>
        </div>

        <!-- 错误提示（路径失效时显示） -->
        <div
          v-if="autoLoadError && !player.isLoading"
          class="absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl flex items-center justify-center z-10"
        >
          <div class="text-center max-w-md px-4">
            <div class="text-5xl mb-4">⚠️</div>
            <p class="text-gray-900 dark:text-white text-sm leading-relaxed whitespace-pre-line">{{ autoLoadError }}</p>
          </div>
        </div>

        <!-- 中央封面展示区域 -->
        <Player />

        <!-- 底部播放控制栏 -->
        <ControlBar />
      </main>

      <!-- 右侧设置面板（可切换显示/隐藏） -->
      <SettingsPanel v-if="showSettings" />
    </div>
  </div>
</template>

<style>
/* 全局样式已在 main.css 中定义 */
</style>