<script lang="ts">
export default { inheritAttrs: false }
</script>

<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { audioPlayer } from '@/utils/audioPlayer'
import { formatTime } from '@/utils/formatTime'
import { watch, onMounted, onUnmounted, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useVolumeSlider } from '@/composables/useVolumeSlider'
import VolumeSlider from '@/components/VolumeSlider.vue'
import RepeatIcon from '@/components/icons/RepeatIcon.vue'
import RepeatOneIcon from '@/components/icons/RepeatOneIcon.vue'
import ShuffleIcon from '@/components/icons/ShuffleIcon.vue'
import ArrowRightIcon from '@/components/icons/ArrowRightIcon.vue'
import SkipBackIcon from '@/components/icons/SkipBackIcon.vue'
import SkipForwardIcon from '@/components/icons/SkipForwardIcon.vue'
import PlayIcon from '@/components/icons/PlayIcon.vue'
import PauseIcon from '@/components/icons/PauseIcon.vue'
import MusicIcon from '@/components/icons/MusicIcon.vue'

const player = usePlayerStore()
const volumeIconRef = ref<HTMLElement | null>(null)
// autoplay 被拦截时的轻提示
const showAutoplayTip = ref(false)

// 使用音量滑块 composable
const {
  showVolumeSlider,
  volumeSliderPosition,
  showVolumeControl,
  hideVolumeControl,
  closeVolumeControl,
  handleMouseEnterSlider,
  handleMouseLeaveSlider,
} = useVolumeSlider()

// 全局快捷键监听器引用
let unlistenToggle: UnlistenFn | null = null
let unlistenPrev: UnlistenFn | null = null
let unlistenNext: UnlistenFn | null = null
let unlistenVolumeUp: UnlistenFn | null = null
let unlistenVolumeDown: UnlistenFn | null = null

// 循环模式标签
const loopModeLabels: Record<string, string> = {
  list: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
  none: '顺序播放',
}

// 播放进度拖拽
function onProgressInput(event: Event) {
  const target = event.target as HTMLInputElement
  const time = parseFloat(target.value)
  audioPlayer.seek(time)
  player.currentTime = time
}

// 音量图标鼠标事件处理
function handleVolumeIconEnter() {
  if (volumeIconRef.value) {
    showVolumeControl(volumeIconRef.value)
  }
}

function handleVolumeIconLeave() {
  hideVolumeControl()
}

// 切换静音
function toggleMute() {
  player.toggleMute()
}

// 监听当前歌曲变化：仅加载音频，播放由 canplay 回调处理
watch(
  () => player.currentSong,
  async (song) => {
    if (song) {
      // 切歌时立即重置进度，避免显示上一首歌的残留时间
      player.currentTime = 0

      try {
        await audioPlayer.load(song.file_path)
        // load 完成（canplay 已触发），设置音量和 Media Session
        audioPlayer.setVolume(player.volume)
        audioPlayer.setMediaSession(
          song.title,
          song.artist,
          song.cover_path ? player.getCoverUrl(song.cover_path) : undefined
        )
      } catch (e) {
        console.error('[ControlBar] 加载歌曲失败:', e)
        player.isSwitchingSong = false
        player.pendingPlay = false
      }
    }
  }
)

// 监听播放状态变化（用户手动点击播放/暂停按钮）
watch(
  () => player.isPlaying,
  (playing) => {
    if (playing) {
      // 如果有 pendingPlay（autoplay 被拦截后用户点击播放），重新尝试播放
      if (player.pendingPlay && player.currentSong) {
        player.pendingPlay = false
        audioPlayer.play()
      } else {
        audioPlayer.play()
      }
    } else {
      audioPlayer.pause()
    }
  }
)

// 监听音量变化，应用到音频播放器
watch(
  () => player.volume,
  (vol) => {
    audioPlayer.setVolume(vol)
  }
)

onMounted(async () => {
  // 绑定 store 状态访问器，让 canplay 回调能读写 pendingPlay / isSwitchingSong / isPlaying
  audioPlayer.bindStoreAccessors({
    getPendingPlay: () => player.pendingPlay,
    setPendingPlay: (v: boolean) => { player.pendingPlay = v },
    setIsSwitchingSong: (v: boolean) => { player.isSwitchingSong = v },
    setIsPlaying: (v: boolean) => { player.isPlaying = v },
  })

  // 绑定音频播放器事件
  audioPlayer.onTimeUpdate((time) => {
    player.currentTime = time
  })

  audioPlayer.onDurationChange((dur) => {
    player.duration = dur
  })

  audioPlayer.onEnded(() => {
    // 播放结束，自动下一首
    player.next()
  })

  audioPlayer.onPlay(() => {
    // 非切歌状态下由 play 事件更新 isPlaying
    if (!player.isSwitchingSong) {
      player.isPlaying = true
    }
  })

  audioPlayer.onPause(() => {
    // 切歌锁：正在切歌时，旧音频的 pause 事件不应修改 isPlaying
    if (player.isSwitchingSong) {
      return
    }
    player.isPlaying = false
  })

  audioPlayer.onAutoplayBlocked(() => {
    showAutoplayTip.value = true
    setTimeout(() => { showAutoplayTip.value = false }, 3000)
  })

  // 设置媒体键处理
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('previoustrack', () => player.prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => player.next())
  }

  // 监听全局快捷键事件
  unlistenToggle = await listen('global-shortcut:toggle-play', () => {
    player.togglePlay()
  })
  unlistenPrev = await listen('global-shortcut:prev-track', () => {
    player.prev()
  })
  unlistenNext = await listen('global-shortcut:next-track', () => {
    player.next()
  })
  unlistenVolumeUp = await listen('global-shortcut:volume-up', () => {
    player.volume = Math.min(1, player.volume + 0.05)
  })
  unlistenVolumeDown = await listen('global-shortcut:volume-down', () => {
    player.volume = Math.max(0, player.volume - 0.05)
  })
})

onUnmounted(() => {
  unlistenToggle?.()
  unlistenPrev?.()
  unlistenNext?.()
  unlistenVolumeUp?.()
  unlistenVolumeDown?.()
})
</script>

<template>
  <div v-bind="$attrs">
    <footer class="h-24 bg-white/80 dark:bg-gray-800/50 backdrop-blur-xl border-t border-gray-200/50 dark:border-gray-700/50 flex items-center px-6 gap-6 shrink-0">
    <!-- 左：当前歌曲信息 -->
    <div class="flex items-center gap-4 w-36 shrink-0">
      <div class="w-14 h-14 rounded-lg bg-gray-200 dark:bg-gray-700 shrink-0 overflow-hidden">
        <img
          v-if="player.currentSong?.cover_path"
          :src="player.getCoverUrl(player.currentSong.cover_path)"
          :alt="player.currentSong?.title"
          class="w-full h-full object-cover"
        />
        <div v-else class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
          <MusicIcon :size="20" />
        </div>
      </div>
      <div class="min-w-0" v-if="player.currentSong">
        <p class="text-gray-900 dark:text-white text-sm font-medium truncate">{{ player.currentSong.title }}</p>
        <p class="text-gray-600 dark:text-gray-400 text-xs truncate">{{ player.currentSong.artist || '未知艺术家' }}</p>
      </div>
      <div v-else>
        <p class="text-gray-500 dark:text-gray-500 text-sm">未选择歌曲</p>
      </div>
    </div>

    <!-- 中：播放控制 -->
    <div class="flex-1 flex flex-col items-center gap-2">
      <!-- 控制按钮 -->
      <div class="flex items-center gap-4">
        <!-- 循环模式 -->
        <button
          class="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
          :class="{ 'text-blue-500 dark:text-blue-400': player.loopMode !== 'none' }"
          :title="loopModeLabels[player.loopMode]"
          @click="player.toggleLoopMode"
        >
          <ShuffleIcon v-if="player.loopMode === 'shuffle'" :size="18" />
          <RepeatOneIcon v-else-if="player.loopMode === 'single'" :size="18" />
          <RepeatIcon v-else-if="player.loopMode === 'list'" :size="18" />
          <ArrowRightIcon v-else :size="18" />
        </button>

        <!-- 上一首 -->
        <button
          class="p-2 rounded-lg text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
          :class="{ 'opacity-30 cursor-not-allowed': !player.hasPrev }"
          :disabled="!player.hasPrev"
          @click="player.prev"
        >
          <SkipBackIcon :size="20" />
        </button>

        <!-- 播放/暂停 -->
        <button
          class="w-12 h-12 bg-gray-900 dark:bg-white rounded-full flex items-center justify-center hover:bg-gray-700 dark:hover:bg-gray-200 transition-colors shadow-lg"
          @click="player.togglePlay"
        >
          <PauseIcon v-if="player.isPlaying" :size="20" class="text-white dark:text-gray-900" />
          <PlayIcon v-else :size="20" class="text-white dark:text-gray-900 ml-0.5" />
        </button>

        <!-- 下一首 -->
        <button
          class="p-2 rounded-lg text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
          :class="{ 'opacity-30 cursor-not-allowed': !player.hasNext }"
          :disabled="!player.hasNext"
          @click="player.next"
        >
          <SkipForwardIcon :size="20" />
        </button>
      </div>

      <!-- 进度条 -->
      <div class="flex items-center gap-2 w-full max-w-xl">
        <span class="text-gray-600 dark:text-gray-400 text-xs w-10 text-right">{{ formatTime(player.currentTime) }}</span>
        <input
          type="range"
          class="flex-1"
          :min="0"
          :max="player.duration || 0"
          :value="player.currentTime"
          step="0.1"
          @input="onProgressInput"
        />
        <span class="text-gray-600 dark:text-gray-400 text-xs w-10">{{ formatTime(player.duration) }}</span>
      </div>
    </div>

    <!-- 右：音量控制 -->
    <div class="flex items-center justify-end w-12 shrink-0">
      <!-- 音量图标（SVG） -->
      <button
        ref="volumeIconRef"
        class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        @click="toggleMute"
        @mouseenter="handleVolumeIconEnter"
        @mouseleave="handleVolumeIconLeave"
      >
        <svg class="w-5 h-5 text-gray-900 dark:text-white" viewBox="0 0 24 24" fill="currentColor">
          <!-- 静音图标 -->
          <template v-if="player.volume === 0">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.58-1.42 1.07-2.25 1.43v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
          </template>
          <!-- 低音量图标 -->
          <template v-else-if="player.volume < 0.5">
            <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>
          </template>
          <!-- 高音量图标 -->
          <template v-else>
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
          </template>
        </svg>
      </button>
    </div>
  </footer>

  <!-- autoplay 被拦截时的轻提示 -->
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0 translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-2"
  >
    <div
      v-if="showAutoplayTip"
      class="fixed bottom-28 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900/90 dark:bg-white/90 text-white dark:text-gray-900 text-sm rounded-lg shadow-lg pointer-events-none"
    >
      点击播放按钮继续播放
    </div>
  </Transition>

  <!-- 悬浮音量控制条 -->
  <VolumeSlider
    :visible="showVolumeSlider"
    :position="volumeSliderPosition"
    @close="closeVolumeControl"
    @mouse-enter="handleMouseEnterSlider"
    @mouse-leave="handleMouseLeaveSlider"
  />
  </div>
</template>