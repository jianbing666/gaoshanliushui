<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAudioStore } from '@/stores/audioStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useUIStore } from '@/stores/uiStore'
import { formatTime } from '@/utils/formatTime'
import Icon from '@/components/icons/Icon.vue'

/**
 * 迷你模式界面(P2: 从 App.vue 拆出来并按需加载)
 *
 * 迷你模式只在用户主动切换时出现, 常驻在主入口里没有任何收益;
 * 拆成异步组件后主入口少一份布局与事件绑定, 首次切换时再下载(本地 chunk, 无感知延迟)。
 */
const audio = useAudioStore()
const library = useLibraryStore()
const ui = useUIStore()
const appWindow = getCurrentWindow()

// 迷你窗口宽度 < 480 时收窄左侧信息区(与主界面同源判定)
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 640)
const isCompactMiniMode = computed(() => windowWidth.value < 480)

function handleResize() {
  windowWidth.value = window.innerWidth
}

onMounted(() => window.addEventListener('resize', handleResize))
onUnmounted(() => window.removeEventListener('resize', handleResize))

function minimizeWindow() {
  appWindow.minimize().catch(() => {})
}

function closeWindow() {
  appWindow.close().catch(() => {})
}

function toggleMiniMode() {
  ui.setMiniMode(!ui.isMiniMode)
}

/** 封面加载失败时静默隐藏(与列表行一致) */
function onCoverError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}
</script>

<template>
  <!-- 迷你模式 -->
  <div
    v-if="ui.isMiniMode"
    class="flex flex-col w-full min-h-screen bg-white/90 dark:bg-gray-900/90 backdrop-blur"
  >
    <!-- 自定义标题栏：36px -->
    <div
      style="height: 36px"
      class="shrink-0 flex items-center px-3 border-b border-gray-200/50 dark:border-gray-700/50"
    >
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
          <svg
            class="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M5 12h14"></path>
          </svg>
        </button>
        <!-- 退出迷你模式 -->
        <button
          class="w-8 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 transition-colors"
          title="退出迷你模式"
          @click="toggleMiniMode"
        >
          <Icon name="maximize2" :size="14" />
        </button>
        <!-- 关闭 -->
        <button
          class="w-8 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-red-500 hover:text-white transition-colors"
          title="关闭"
          @click="closeWindow"
        >
          <svg
            class="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
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
        <div
          class="flex items-center gap-3 shrink-0 min-w-0"
          :style="isCompactMiniMode ? 'max-width: 180px;' : ''"
        >
          <!-- 封面 -->
          <div class="w-12 h-12 rounded-lg bg-gray-200 dark:bg-gray-700 shrink-0 overflow-hidden">
            <img
              v-if="library.currentSong?.cover_path"
              :src="library.getCoverUrl(library.currentSong.cover_path)"
              :alt="library.currentSong?.title"
              class="w-full h-full object-cover"
              @error="onCoverError"
            />
            <div
              v-else
              class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500"
            >
              <Icon name="music" :size="18" />
            </div>
          </div>
          <!-- 歌曲信息 -->
          <div class="min-w-0 w-28">
            <p class="text-gray-900 dark:text-white text-sm font-medium truncate">
              {{ library.currentSong?.title || '未选择歌曲' }}
            </p>
            <p class="text-gray-500 dark:text-gray-400 text-xs truncate">
              {{ library.currentSong?.artist || '未知艺术家' }}
            </p>
          </div>
        </div>

        <!-- 中间：播放控制按钮 -->
        <div class="flex items-center gap-1 shrink-0">
          <!-- 循环模式 -->
          <button
            class="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
            :class="{ 'text-blue-500 dark:text-blue-400': audio.loopMode !== 'none' }"
            :title="
              audio.loopMode === 'list'
                ? '列表循环'
                : audio.loopMode === 'single'
                  ? '单曲循环'
                  : audio.loopMode === 'shuffle'
                    ? '随机播放'
                    : '顺序播放'
            "
            @click="audio.toggleLoopMode"
          >
            <Icon v-if="audio.loopMode === 'shuffle'" name="shuffle" :size="14" />
            <Icon v-else-if="audio.loopMode === 'single'" name="repeat-one" :size="14" />
            <Icon v-else-if="audio.loopMode === 'list'" name="repeat" :size="14" />
            <Icon v-else name="arrow-right" :size="14" />
          </button>

          <!-- 上一首 -->
          <button
            class="w-7 h-7 flex items-center justify-center rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
            :class="{ 'opacity-30 cursor-not-allowed': !audio.hasPrev }"
            :disabled="!audio.hasPrev"
            @click="audio.prev"
          >
            <Icon name="skip-back" :size="16" />
          </button>

          <!-- 播放/暂停 -->
          <button
            class="w-9 h-9 bg-gray-900 dark:bg-white rounded-full flex items-center justify-center hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors shadow-md"
            @click="audio.togglePlay"
          >
            <Icon
              v-if="audio.isPlaying"
              name="pause"
              :size="16"
              class="text-white dark:text-gray-900"
            />
            <Icon v-else name="play" :size="16" class="text-white dark:text-gray-900 ml-0.5" />
          </button>

          <!-- 下一首 -->
          <button
            class="w-7 h-7 flex items-center justify-center rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
            :class="{ 'opacity-30 cursor-not-allowed': !audio.hasNext }"
            :disabled="!audio.hasNext"
            @click="audio.next"
          >
            <Icon name="skip-forward" :size="16" />
          </button>
        </div>

        <!-- 右侧：音量控制（弹性宽度） -->
        <div class="flex items-center gap-2 shrink-0 w-40">
          <svg
            class="w-4 h-4 text-gray-900 dark:text-gray-100 shrink-0"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <template v-if="audio.volume === 0">
              <path
                d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.58-1.42 1.07-2.25 1.43v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"
              />
            </template>
            <template v-else-if="audio.volume < 0.5">
              <path
                d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"
              />
            </template>
            <template v-else>
              <path
                d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
              />
            </template>
          </svg>
          <input
            type="range"
            class="flex-1 min-w-0"
            :min="0"
            :max="1"
            step="0.01"
            :value="audio.volume"
            @input="
              (e) => {
                audio.volume = parseFloat((e.target as HTMLInputElement).value)
              }
            "
          />

          <!-- 新增：显示具体的音量值 -->
          <span class="text-xs text-gray-500 dark:text-gray-400 w-8 text-right shrink-0">
            {{ (audio.volume * 100).toFixed(0) }}
          </span>
        </div>
      </div>

      <!-- 下半部分：进度条（带时间显示），跨整个宽度 -->
      <div class="flex items-center px-4 gap-2 shrink-0" :style="'height: 30px;'">
        <span
          class="text-gray-500 dark:text-gray-400 text-xs w-9 text-right shrink-0 tabular-nums"
          >{{ formatTime(audio.currentTime) }}</span
        >
        <input
          type="range"
          class="flex-1 min-w-0"
          :min="0"
          :max="audio.duration || 0"
          :value="audio.currentTime"
          step="0.1"
          @input="
            (e) => {
              const time = parseFloat((e.target as HTMLInputElement).value)
              audio.seekTo(time)
              audio.currentTime = time
            }
          "
        />
        <span class="text-gray-500 dark:text-gray-400 text-xs w-9 shrink-0 tabular-nums">{{
          formatTime(audio.duration)
        }}</span>
      </div>
    </div>
  </div>
</template>
