<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { ref, watch, onMounted, onUnmounted, computed, nextTick, defineAsyncComponent } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Sidebar from '@/components/Sidebar.vue'
import Player from '@/components/Player.vue'
import ControlBar from '@/components/ControlBar.vue'
import SongContextMenu from '@/components/SongContextMenu.vue'
import TitleBar from '@/components/TitleBar.vue'
import HistoryDrawer from '@/components/HistoryDrawer.vue'
import Maximize2Icon from '@/components/icons/Maximize2Icon.vue'
import PlayIcon from '@/components/icons/PlayIcon.vue'
import PauseIcon from '@/components/icons/PauseIcon.vue'
import SkipBackIcon from '@/components/icons/SkipBackIcon.vue'
import SkipForwardIcon from '@/components/icons/SkipForwardIcon.vue'
import RepeatIcon from '@/components/icons/RepeatIcon.vue'
import RepeatOneIcon from '@/components/icons/RepeatOneIcon.vue'
import ShuffleIcon from '@/components/icons/ShuffleIcon.vue'
import ArrowRightIcon from '@/components/icons/ArrowRightIcon.vue'
import MusicIcon from '@/components/icons/MusicIcon.vue'
import { formatTime } from '@/utils/formatTime'
import { useMediaControls } from '@/composables/useMediaControls'
import { syncShortcutsToBackend } from '@/utils/syncShortcuts'

// ========== 阶段 3.6: 异步组件（首屏 JS 减 20-30KB）============
// 同步: 首屏必现
// 异步: 仅在用户首次打开对应面板/弹窗时下载独立 chunk
const SettingsPanel = defineAsyncComponent(() => import('@/components/SettingsPanel.vue'))
const StatsPanel = defineAsyncComponent(() => import('@/components/StatsPanel.vue'))
const DownloadPanel = defineAsyncComponent(() => import('@/components/DownloadPanel.vue'))
const CreatePlaylistModal = defineAsyncComponent(() => import('@/components/CreatePlaylistModal.vue'))

const player = usePlayerStore()
const appWindow = getCurrentWindow()
const showSettings = ref(false)
const autoLoadError = ref<string | null>(null)

// 极致性能 + 多入口统一: 托盘菜单/全局快捷键/媒体键/迷你模式控制
//   全部走 useMediaControls 统一在 App 级别注册, 避免迷你模式 ControlBar
//   卸载后事件丢失 (导致托盘按钮和媒体键失效)
useMediaControls()

const miniWindowWidth = ref(640)
const miniWindowHeight = ref(120)
const isCompactMiniMode = computed(() => miniWindowWidth.value < 480)

let unlistenWindowShow: UnlistenFn | null = null

// 切换设置面板显示/隐藏
function toggleSettings() {
  // 同侧互斥：展开设置时收起统计和下载
  if (!showSettings.value) {
    if (player.showStatsPanel) {
      player.toggleStatsPanel()
    }
    if (player.showDownloadPanel) {
      player.toggleDownloadPanel()
    }
  }
  showSettings.value = !showSettings.value
}

// 监听统计面板切换，实现右侧互斥
watch(() => player.showStatsPanel, (newVal) => {
  // 展开统计时收起设置
  if (newVal && showSettings.value) {
    showSettings.value = false
  }
  // 展开统计时收起下载
  if (newVal && player.showDownloadPanel) {
    player.toggleDownloadPanel()
  }
})

// 监听下载面板切换，实现右侧互斥
watch(() => player.showDownloadPanel, (newVal) => {
  // 展开下载时收起设置和统计
  if (newVal) {
    if (showSettings.value) showSettings.value = false
    if (player.showStatsPanel) player.toggleStatsPanel()
  }
})

// 切换迷你模式
function toggleMiniMode() {
  player.setMiniMode(!player.isMiniMode)
}

// 迷你模式窗口控制
function minimizeWindow() {
  appWindow.minimize().catch(() => {})
}

function closeWindow() {
  appWindow.close().catch(() => {})
}

// 处理窗口显示事件（从托盘恢复时）
function handleWindowShow() {
  // 恢复 AudioContext 运行状态
  player.resumeAudioContext()
}

// 迷你模式窗口大小变化监听
let resizeObserver: ResizeObserver | null = null
function handleMiniResize() {
  if (player.isMiniMode) {
    miniWindowWidth.value = window.innerWidth
    miniWindowHeight.value = window.innerHeight
  }
}

// 启动时自动加载音乐库
// 阶段 4.4: 启动时序优化 - 关键路径 first, 非关键路径 idle
// 首屏渲染完成后再加载音乐库 + 注册 IPC 监听, 避免阻塞首帧
onMounted(async () => {
  // 关键路径 1: 立即让首屏可见
  await nextTick()

  // 关键路径 2: 注册可见性监听 (轻量, 不阻塞)
  document.addEventListener('visibilitychange', handleVisibilityChange)

  // 关键路径 3: 启动 ResizeObserver (cheap, 但仍放首屏后)
  resizeObserver = new ResizeObserver(handleMiniResize)
  resizeObserver.observe(document.documentElement)

  // 非关键路径: 推迟到浏览器空闲时段执行
  // timeout: 2000ms 保证即使不支持 requestIdleCallback 也能在 2s 内执行
  requestIdleCallback(
    async () => {
      // 1. 同步快捷键到后端
      //    原因: 后端 ShortcutStore 启动时用默认值, 如果用户在之前会话中修改过快捷键
      //    且未保存, 就会使用默认值. 同步步骤确保后端使用用户实际配置的快捷键.
      try {
        await syncShortcutsToBackend()
      } catch (e) {
        console.warn('[App] 同步快捷键失败:', e)
      }

      // 2. 自动加载音乐库 (潜在 IPC + 扫描磁盘, 可能数百 ms)
      const result = await player.autoLoadMusicLibrary()
      if (!result.success && result.error) {
        autoLoadError.value = `音乐库路径已失效：${result.error}\n请在设置面板中重新选择目录`
        showSettings.value = true
      }

      // 3. 注册 Tauri 窗口显示事件 (IPC 通道建立, ~50ms)
      try {
        unlistenWindowShow = await listen('tauri://window-show', handleWindowShow)
      } catch (e) {
        console.warn('[App] 监听窗口显示事件失败:', e)
      }
    },
    { timeout: 2000 }
  )
})

// 极致性能: 窗口隐藏(最小化/切到后台/最小化到托盘)时
//   1. 恢复 AudioContext (浏览器自动挂起, 必须手动 resume)
//   2. 暂停所有非必要后台动画 (频谱 setTimeout / 背景轮播 / 封面旋转)
// 重新可见时, 1+2 反向恢复
function handleVisibilityChange() {
  if (document.hidden) {
    // 窗口隐藏: 暂停频谱采样循环、背景轮播定时器, 让 CPU/GPU 进入空闲
    player.pauseAllBackgroundAnimations()
  } else {
    // 页面重新可见时:
    //   1. 恢复音频上下文 (浏览器在 hidden 时自动挂起)
    //   2. 恢复所有后台动画
    player.resumeAudioContext()
    player.resumeAllBackgroundAnimations()
  }
}

// 阶段 3.7: 封面加载失败静默隐藏
function onCoverError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}

onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  unlistenWindowShow?.()
  resizeObserver?.disconnect()
})
</script>

<template>
  <!-- 主容器：Flex 垂直布局 -->
  <div 
    class="flex flex-col bg-gradient-to-br from-gray-100 via-gray-50 to-gray-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 select-none overflow-hidden relative transition-all duration-300 ease-out"
    :class="player.isMiniMode ? 'h-full' : 'h-screen'"
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
          class="absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur flex items-center justify-center z-20"
        >
          <div class="text-center">
            <div class="animate-spin text-4xl mb-3">⟳</div>
            <p class="text-gray-700 dark:text-gray-300 text-sm">正在扫描音乐库...</p>
          </div>
        </div>

        <!-- 错误提示（路径失效时显示） -->
        <div
          v-if="autoLoadError && !player.isLoading"
          class="absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur flex items-center justify-center z-20"
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

      <!-- 右侧面板：设置 / 统计 / 下载（互斥，挤压式） -->
      <!-- 阶段 1.6: keep-alive 包裹, 切换面板时不销毁组件, 避免重复 setup + 重渲染 -->
      <Transition name="slide-fade" mode="out-in">
        <keep-alive>
          <SettingsPanel v-if="showSettings && !player.showStatsPanel && !player.showDownloadPanel" key="settings" class="shrink-0" />
          <StatsPanel v-else-if="player.showStatsPanel" key="stats" class="shrink-0" />
          <DownloadPanel v-else-if="player.showDownloadPanel" key="download" class="shrink-0" />
        </keep-alive>
      </Transition>
    </div>

    <!-- 迷你模式 -->
    <div v-if="player.isMiniMode" class="flex flex-col w-full min-h-screen bg-white/90 dark:bg-gray-900/90 backdrop-blur">
      <!-- 自定义标题栏：36px -->
      <div style="height: 36px" class="shrink-0 flex items-center px-3 border-b border-gray-200/50 dark:border-gray-700/50">
        <!-- 左侧：应用名（可拖拽） -->
        <div class="flex-1 flex items-center h-full" data-tauri-drag-region>
          <span class="text-sm text-gray-700 dark:text-gray-300 font-medium">高山流水</span>
        </div>
        <!-- 右侧：窗口控制按钮 -->
        <div class="flex items-center gap-0.5">
          <!-- 最小化 -->
          <button
            class="w-8 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
            title="最小化"
            @click="minimizeWindow"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M5 12h14"></path>
            </svg>
          </button>
          <!-- 退出迷你模式 -->
          <button
            class="w-8 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
            title="退出迷你模式"
            @click="toggleMiniMode"
          >
            <Maximize2Icon :size="14" />
          </button>
          <!-- 关闭 -->
          <button
            class="w-8 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-red-500 hover:text-white transition-colors"
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

      <!-- 音乐控制区域：自适应高度 -->
      <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
        <!-- 上半部分：左侧封面信息 + 中间控制按钮 + 右侧音量（横向布局） -->
        <div class="flex-1 flex items-center px-4 gap-4 min-h-0">
          <!-- 左侧：封面 + 歌曲信息 -->
          <div class="flex items-center gap-3 shrink-0 min-w-0"
               :style="isCompactMiniMode ? 'max-width: 180px;' : ''">
            <!-- 封面 -->
            <div class="w-12 h-12 rounded-lg bg-gray-200 dark:bg-gray-700 shrink-0 overflow-hidden">
              <img
                v-if="player.currentSong?.cover_path"
                :src="player.getCoverUrl(player.currentSong.cover_path)"
                :alt="player.currentSong?.title"
                class="w-full h-full object-cover"
                @error="onCoverError"
              />
              <div v-else class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
                <MusicIcon :size="18" />
              </div>
            </div>
            <!-- 歌曲信息 -->
            <div class="min-w-0 w-28">
              <p class="text-gray-900 dark:text-white text-sm font-medium truncate">
                {{ player.currentSong?.title || '未选择歌曲' }}
              </p>
              <p class="text-gray-500 dark:text-gray-400 text-xs truncate">
                {{ player.currentSong?.artist || '未知艺术家' }}
              </p>
            </div>
          </div>

          <!-- 中间：播放控制按钮 -->
          <div class="flex items-center gap-1 shrink-0">
            <!-- 循环模式 -->
            <button
              class="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
              :class="{ 'text-blue-500 dark:text-blue-400': player.loopMode !== 'none' }"
              :title="player.loopMode === 'list' ? '列表循环' : player.loopMode === 'single' ? '单曲循环' : player.loopMode === 'shuffle' ? '随机播放' : '顺序播放'"
              @click="player.toggleLoopMode"
            >
              <ShuffleIcon v-if="player.loopMode === 'shuffle'" :size="14" />
              <RepeatOneIcon v-else-if="player.loopMode === 'single'" :size="14" />
              <RepeatIcon v-else-if="player.loopMode === 'list'" :size="14" />
              <ArrowRightIcon v-else :size="14" />
            </button>

            <!-- 上一首 -->
            <button
              class="w-7 h-7 flex items-center justify-center rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
              :class="{ 'opacity-30 cursor-not-allowed': !player.hasPrev }"
              :disabled="!player.hasPrev"
              @click="player.prev"
            >
              <SkipBackIcon :size="16" />
            </button>

            <!-- 播放/暂停 -->
            <button
              class="w-9 h-9 bg-gray-900 dark:bg-white rounded-full flex items-center justify-center hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors shadow-md"
              @click="player.togglePlay"
            >
              <PauseIcon v-if="player.isPlaying" :size="16" class="text-white dark:text-gray-900" />
              <PlayIcon v-else :size="16" class="text-white dark:text-gray-900 ml-0.5" />
            </button>

            <!-- 下一首 -->
            <button
              class="w-7 h-7 flex items-center justify-center rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
              :class="{ 'opacity-30 cursor-not-allowed': !player.hasNext }"
              :disabled="!player.hasNext"
              @click="player.next"
            >
              <SkipForwardIcon :size="16" />
            </button>
          </div>

          <!-- 右侧：音量控制（弹性宽度） -->
          <div class="flex items-center gap-2 shrink-0 w-40">
            <svg class="w-4 h-4 text-gray-900 dark:text-gray-100 shrink-0" viewBox="0 0 24 24" fill="currentColor">
              <template v-if="player.volume === 0">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.58-1.42 1.07-2.25 1.43v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </template>
              <template v-else-if="player.volume < 0.5">
                <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>
              </template>
              <template v-else>
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
              </template>
            </svg>
            <input
              type="range"
              class="flex-1 min-w-0"
              :min="0"
              :max="1"
              step="0.01"
              :value="player.volume"
              @input="(e) => { player.volume = parseFloat((e.target as HTMLInputElement).value) }"
            />

            <!-- 新增：显示具体的音量值 -->
            <span class="text-xs text-gray-500 dark:text-gray-400 w-8 text-right shrink-0">
              {{ (player.volume * 100).toFixed(0) }}
            </span>
          </div>
        </div>

        <!-- 下半部分：进度条（带时间显示），跨整个宽度 -->
        <div class="flex items-center px-4 gap-2 shrink-0" :style="'height: 30px;'">
          <span class="text-gray-500 dark:text-gray-400 text-xs w-9 text-right shrink-0 tabular-nums">{{ formatTime(player.currentTime) }}</span>
          <input
            type="range"
            class="flex-1 min-w-0"
            :min="0"
            :max="player.duration || 0"
            :value="player.currentTime"
            step="0.1"
            @input="(e) => {
              const time = parseFloat((e.target as HTMLInputElement).value)
              player.seekTo(time)
              player.currentTime = time
            }"
          />
          <span class="text-gray-500 dark:text-gray-400 text-xs w-9 shrink-0 tabular-nums">{{ formatTime(player.duration) }}</span>
        </div>
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