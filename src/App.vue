<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import Sidebar from '@/components/Sidebar.vue'
import Player from '@/components/Player.vue'
import ControlBar from '@/components/ControlBar.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import SongContextMenu from '@/components/SongContextMenu.vue'
import CreatePlaylistModal from '@/components/CreatePlaylistModal.vue'
import HistoryDrawer from '@/components/HistoryDrawer.vue'
import StatsPanel from '@/components/StatsPanel.vue'
import TitleBar from '@/components/TitleBar.vue'

const player = usePlayerStore()
const showSettings = ref(false)
const autoLoadError = ref<string | null>(null)

let unlistenWindowShow: UnlistenFn | null = null

// 切换设置面板显示/隐藏
function toggleSettings() {
  // 同侧互斥：展开设置时收起统计
  if (!showSettings.value && player.showStatsPanel) {
    player.toggleStatsPanel()
  }
  showSettings.value = !showSettings.value
}

// 监听统计面板切换，实现右侧互斥
watch(() => player.showStatsPanel, (newVal) => {
  // 展开统计时收起设置
  if (newVal && showSettings.value) {
    showSettings.value = false
  }
})

// 切换迷你模式
function toggleMiniMode() {
  player.setMiniMode(!player.isMiniMode)
}

// 处理窗口显示事件（从托盘恢复时）
function handleWindowShow() {
  console.log('[App] 窗口已显示，恢复音频上下文')
  // 恢复 AudioContext 运行状态
  player.resumeAudioContext()
}

// 启动时自动加载音乐库
onMounted(async () => {
  const result = await player.autoLoadMusicLibrary()
  if (!result.success && result.error) {
    autoLoadError.value = `音乐库路径已失效：${result.error}\n请在设置面板中重新选择目录`
    showSettings.value = true
  }

  // 监听页面可见性变化（窗口隐藏/显示）
  document.addEventListener('visibilitychange', handleVisibilityChange)

  // 监听 Tauri 窗口显示事件
  try {
    unlistenWindowShow = await listen('tauri://window-show', handleWindowShow)
  } catch (e) {
    console.warn('[App] 监听窗口显示事件失败:', e)
  }
})

function handleVisibilityChange() {
  if (!document.hidden) {
    // 页面重新可见时，恢复音频上下文
    console.log('[App] 页面重新可见')
    player.resumeAudioContext()
  }
}

onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  unlistenWindowShow?.()
})
</script>

<template>
  <!-- 主容器：Flex 垂直布局 -->
  <div 
    class="flex flex-col bg-gradient-to-br from-gray-100 via-gray-50 to-gray-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 select-none overflow-hidden relative transition-all duration-300 ease-out"
    :class="player.isMiniMode ? 'h-20' : 'h-screen'"
  >
    <!-- 背景图片层 -->
    <div
      v-if="!player.isMiniMode && player.currentBackgroundUrl && player.background.mode !== 'none'"
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
      v-if="!player.isMiniMode && player.currentBackgroundUrl && player.background.mode !== 'none'"
      class="absolute inset-0 pointer-events-none bg-black transition-opacity duration-300"
      :style="{ opacity: player.background.overlay }"
    ></div>

    <!-- 自定义标题栏（仅非迷你模式显示） -->
    <TitleBar
      v-if="!player.isMiniMode"
      :show-settings="showSettings"
      :show-mini-mode-button="true"
      :show-sidebar-button="true"
      @toggle-settings="toggleSettings"
      @toggle-mini-mode="toggleMiniMode"
    />

    <!-- 主内容区域：Flex 水平三栏布局（非迷你模式） -->
    <div v-if="!player.isMiniMode" class="flex-1 flex min-h-0 relative">
      <!-- 左侧面板：侧边栏 / 历史记录（互斥，挤压式） -->
      <Transition name="slide-left-fade" mode="out-in">
        <Sidebar v-if="player.showSidebar && !player.showHistoryDrawer" key="sidebar" class="shrink-0" />
        <HistoryDrawer v-else-if="player.showHistoryDrawer" key="history" class="shrink-0" />
      </Transition>

      <!-- 中间播放器区域：flex-1 自适应宽度 -->
      <main class="flex-1 flex flex-col min-w-0 relative">
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

        <!-- 底部播放控制栏 -->
        <ControlBar class="shrink-0" />
      </main>

      <!-- 右侧面板：设置 / 统计（互斥，挤压式） -->
      <Transition name="slide-fade" mode="out-in">
        <SettingsPanel v-if="showSettings && !player.showStatsPanel" key="settings" class="shrink-0" />
        <StatsPanel v-else-if="player.showStatsPanel" key="stats" class="shrink-0" />
      </Transition>
    </div>

    <!-- 迷你模式下的控制栏 -->
    <div v-if="player.isMiniMode" class="flex-1 flex flex-col w-full">
      <!-- 迷你模式拖拽区域（顶部一小条，用于拖动窗口） -->
      <div class="h-6 shrink-0 cursor-grab active:cursor-grabbing" data-tauri-drag-region></div>
      <!-- ControlBar 区域 -->
      <div class="flex-1 flex items-center justify-center px-4 gap-4 relative">
        <ControlBar class="w-full shrink-0" />
        <!-- 展开按钮（悬浮在右上角） -->
        <button
          class="absolute top-2 right-3 w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-200 hover:bg-gray-200/50 dark:hover:bg-gray-700/50 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 z-50"
          title="展开"
          @click="toggleMiniMode"
        >
          <Maximize2Icon :size="16" />
        </button>
      </div>
    </div>

    <!-- 全局右键菜单（单例） -->
    <SongContextMenu v-if="!player.isMiniMode" />

    <!-- 创建歌单弹窗 -->
    <CreatePlaylistModal v-if="!player.isMiniMode" />
  </div>
</template>

<style>
/* 右侧滑入滑出动画（设置、统计面板） */
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

/* 左侧滑入滑出动画（侧边栏、历史记录） */
.slide-left-fade-enter-active {
  transition: all 0.3s ease-out;
}
.slide-left-fade-leave-active {
  transition: all 0.25s ease-in;
}
.slide-left-fade-enter-from,
.slide-left-fade-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}
</style>