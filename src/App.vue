<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { ref, onMounted } from 'vue'
import Sidebar from '@/components/Sidebar.vue'
import Player from '@/components/Player.vue'
import ControlBar from '@/components/ControlBar.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import SettingsIcon from '@/components/icons/SettingsIcon.vue'

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
  <!-- 主容器：Flex 垂直布局 -->
  <div class="flex flex-col h-screen bg-gradient-to-br from-gray-100 via-gray-50 to-gray-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 select-none overflow-hidden relative">
    <!-- 背景图片层 -->
    <div
      v-if="player.currentBackgroundUrl && player.background.mode !== 'none'"
      class="absolute inset-0 pointer-events-none"
      :style="{
        backgroundImage: `url(${player.currentBackgroundUrl})`,
        backgroundSize: player.background.fit === 'repeat' ? 'auto' : player.background.fit,
        backgroundPosition: `${player.background.positionX}% ${player.background.positionY}%`,
        backgroundRepeat: player.background.fit === 'repeat' ? 'repeat' : 'no-repeat',
        transform: `scale(${player.background.scale / 100})`,
        filter: `blur(${player.background.blur}px)`,
      }"
    ></div>
    <!-- 背景遮罩层 -->
    <div
      v-if="player.currentBackgroundUrl && player.background.mode !== 'none'"
      class="absolute inset-0 pointer-events-none bg-black transition-opacity duration-300"
      :style="{ opacity: player.background.overlay }"
    ></div>

    <!-- 顶部工具栏 -->
    <header class="h-12 bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl border-b border-gray-200/50 dark:border-gray-700/50 flex items-center justify-between px-4 shrink-0 relative z-20">
      <!-- 左侧标题 -->
      <div class="flex items-center gap-2">
        <h1 class="text-gray-900 dark:text-white text-sm font-medium">Bilibili Music Player</h1>
      </div>

      <!-- 右侧设置按钮 -->
      <button
        class="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200"
        :class="showSettings
          ? 'bg-blue-500/10 dark:bg-blue-500/20'
          : 'hover:bg-gray-100/50 dark:hover:bg-gray-700/50'"
        @click="toggleSettings"
        title="设置"
      >
        <SettingsIcon
          :size="18"
          :class="showSettings
            ? 'text-blue-600 dark:text-blue-400'
            : 'text-gray-600 dark:text-gray-400'"
        />
      </button>
    </header>

    <!-- 主内容区域：Flex 水平三栏布局 -->
    <div class="flex-1 flex min-h-0 relative">
      <!-- 左侧边栏：固定宽度 -->
      <Sidebar class="shrink-0 relative z-10" />

      <!-- 中间播放器区域：flex-1 自适应宽度 -->
      <main
        class="flex-1 flex flex-col min-w-0 relative transition-all duration-300 ease-out"
        :class="showSettings ? 'pr-[320px]' : ''"
      >
        <!-- Loading 遮罩层（自动扫描时显示） -->
        <div
          v-if="player.isLoading && player.playlist.length === 0"
          class="absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl flex items-center justify-center z-20"
        >
          <div class="text-center">
            <div class="animate-spin text-4xl mb-3">⟳</div>
            <p class="text-gray-700 dark:text-gray-300 text-sm">正在扫描音乐库...</p>
          </div>
        </div>

        <!-- 错误提示（路径失效时显示） -->
        <div
          v-if="autoLoadError && !player.isLoading"
          class="absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl flex items-center justify-center z-20"
        >
          <div class="text-center max-w-md px-4">
            <div class="text-5xl mb-4">⚠️</div>
            <p class="text-gray-900 dark:text-white text-sm leading-relaxed whitespace-pre-line">{{ autoLoadError }}</p>
          </div>
        </div>

        <!-- 中央封面展示区域（垂直水平居中） -->
        <div class="flex-1 flex items-center justify-center min-h-0 relative z-10">
          <Player />
        </div>

        <!-- 底部播放控制栏（z-index 高于设置面板） -->
        <ControlBar class="relative z-50 shrink-0" />
      </main>

      <!-- 右侧设置面板：固定宽度，绝对定位在右侧 -->
      <Transition name="slide-fade">
        <SettingsPanel
          v-if="showSettings"
          class="absolute right-0 top-0 bottom-0 z-40 shrink-0"
        />
      </Transition>
    </div>
  </div>
</template>

<style>
/* 滑入滑出动画 */
.slide-fade-enter-active {
  transition: all 0.3s ease-out;
}
.slide-fade-leave-active {
  transition: all 0.25s ease-in;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>