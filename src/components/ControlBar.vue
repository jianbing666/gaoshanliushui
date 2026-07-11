<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { audioPlayer } from '@/utils/audioPlayer'
import { formatTime } from '@/utils/formatTime'
import { watch, onMounted, onUnmounted } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

const player = usePlayerStore()

// 全局快捷键监听器引用
let unlisten: UnlistenFn | null = null

// 循环模式图标映射
const loopModeIcons: Record<string, string> = {
  list: '🔁',
  single: '🔂',
  none: '➡️',
}

const loopModeLabels: Record<string, string> = {
  list: '列表循环',
  single: '单曲循环',
  none: '顺序播放',
}

// 播放进度拖拽
function onProgressInput(event: Event) {
  const target = event.target as HTMLInputElement
  const time = parseFloat(target.value)
  audioPlayer.seek(time)
  player.currentTime = time
}

// 音量控制
function onVolumeInput(event: Event) {
  const target = event.target as HTMLInputElement
  player.volume = parseFloat(target.value)
  audioPlayer.setVolume(player.volume)
}

// 监听当前歌曲变化，加载新音频
watch(
  () => player.currentSong,
  (song) => {
    if (song) {
      audioPlayer.load(song.file_path)
      audioPlayer.setVolume(player.volume)
      audioPlayer.setMediaSession(
        song.title,
        song.artist,
        song.cover_path ? player.getCoverUrl(song.cover_path) : undefined
      )
      if (player.isPlaying) {
        audioPlayer.play()
      }
    }
  }
)

// 监听播放状态变化
watch(
  () => player.isPlaying,
  (playing) => {
    if (playing) {
      audioPlayer.play()
    } else {
      audioPlayer.pause()
    }
  }
)

onMounted(async () => {
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
    player.isPlaying = true
  })

  audioPlayer.onPause(() => {
    player.isPlaying = false
  })

  // 设置媒体键处理
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('previoustrack', () => player.prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => player.next())
  }

  // 监听全局快捷键事件（Ctrl+Alt+P 暂停/播放）
  unlisten = await listen('global-shortcut:toggle-play', () => {
    player.togglePlay()
  })
})

onUnmounted(() => {
  unlisten?.()
})
</script>

<template>
  <footer class="h-24 bg-gray-800/50 backdrop-blur-xl border-t border-gray-700/50 flex items-center px-6 gap-6">
    <!-- 左：当前歌曲信息 -->
    <div class="flex items-center gap-4 w-72 shrink-0">
      <div class="w-14 h-14 rounded-lg bg-gray-700 shrink-0 overflow-hidden">
        <img
          v-if="player.currentSong?.cover_path"
          :src="player.getCoverUrl(player.currentSong.cover_path)"
          :alt="player.currentSong?.title"
          class="w-full h-full object-cover"
        />
        <div v-else class="w-full h-full flex items-center justify-center text-gray-500">♪</div>
      </div>
      <div class="min-w-0" v-if="player.currentSong">
        <p class="text-white text-sm font-medium truncate">{{ player.currentSong.title }}</p>
        <p class="text-gray-400 text-xs truncate">{{ player.currentSong.artist || '未知艺术家' }}</p>
      </div>
      <div v-else>
        <p class="text-gray-500 text-sm">未选择歌曲</p>
      </div>
    </div>

    <!-- 中：播放控制 -->
    <div class="flex-1 flex flex-col items-center gap-1">
      <!-- 控制按钮 -->
      <div class="flex items-center gap-4">
        <!-- 循环模式 -->
        <button
          class="text-gray-400 hover:text-white text-lg transition-colors"
          :title="loopModeLabels[player.loopMode]"
          @click="player.toggleLoopMode"
        >
          {{ loopModeIcons[player.loopMode] }}
        </button>

        <!-- 上一首 -->
        <button
          class="text-white text-xl hover:text-gray-300 transition-colors"
          :class="{ 'opacity-30': !player.hasPrev }"
          :disabled="!player.hasPrev"
          @click="player.prev"
        >
          ⏮
        </button>

        <!-- 播放/暂停 -->
        <button
          class="w-12 h-12 bg-white rounded-full flex items-center justify-center hover:bg-gray-200 transition-colors shadow-lg"
          @click="player.togglePlay"
        >
          <span class="text-gray-900 text-xl">{{ player.isPlaying ? '⏸' : '▶' }}</span>
        </button>

        <!-- 下一首 -->
        <button
          class="text-white text-xl hover:text-gray-300 transition-colors"
          :class="{ 'opacity-30': !player.hasNext }"
          :disabled="!player.hasNext"
          @click="player.next"
        >
          ⏭
        </button>

        <!-- 迷你模式 -->
        <button
          class="text-gray-400 hover:text-white text-lg transition-colors"
          title="迷你模式"
          @click="player.toggleMiniMode"
        >
          🗗
        </button>
      </div>

      <!-- 进度条 -->
      <div class="flex items-center gap-2 w-full max-w-xl">
        <span class="text-gray-400 text-xs w-10 text-right">{{ formatTime(player.currentTime) }}</span>
        <input
          type="range"
          class="flex-1"
          :min="0"
          :max="player.duration || 0"
          :value="player.currentTime"
          step="0.1"
          @input="onProgressInput"
        />
        <span class="text-gray-400 text-xs w-10">{{ formatTime(player.duration) }}</span>
      </div>
    </div>

    <!-- 右：音量控制 -->
    <div class="flex items-center gap-3 w-36 shrink-0 justify-end">
      <span class="text-white text-sm cursor-pointer" @click="player.volume = player.volume > 0 ? 0 : 0.8">
        {{ player.volume === 0 ? '🔇' : player.volume < 0.5 ? '🔉' : '🔊' }}
      </span>
      <input
        type="range"
        class="w-20"
        min="0"
        max="1"
        step="0.01"
        :value="player.volume"
        @input="onVolumeInput"
      />
    </div>
  </footer>
</template>