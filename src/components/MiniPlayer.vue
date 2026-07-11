<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { audioPlayer } from '@/utils/audioPlayer'
import { formatTime } from '@/utils/formatTime'
import { onMounted, onUnmounted } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

const player = usePlayerStore()

// 播放进度拖拽
function onProgressInput(event: Event) {
  const target = event.target as HTMLInputElement
  audioPlayer.seek(parseFloat(target.value))
}

// 窗口拖拽：通过 data-tauri-drag-region 属性实现
const appWindow = getCurrentWindow()

// 全局快捷键监听器
let unlisten: UnlistenFn | null = null

onMounted(async () => {
  // 迷你模式下需要独立绑定音频事件（因为 ControlBar 不渲染）
  audioPlayer.onTimeUpdate((time) => {
    player.currentTime = time
  })

  audioPlayer.onDurationChange((dur) => {
    player.duration = dur
  })

  audioPlayer.onEnded(() => {
    player.next()
  })

  audioPlayer.onPlay(() => {
    player.isPlaying = true
  })

  audioPlayer.onPause(() => {
    player.isPlaying = false
  })

  // 监听全局快捷键
  unlisten = await listen('global-shortcut:toggle-play', () => {
    player.togglePlay()
  })
})

onUnmounted(() => {
  unlisten?.()
})
</script>

<template>
  <div
    class="flex items-center h-full px-3 gap-2 bg-gray-900/95 backdrop-blur-xl select-none"
    data-tauri-drag-region
  >
    <!-- 歌曲信息（可拖拽区域） -->
    <div class="flex items-center gap-2 min-w-0 flex-1" data-tauri-drag-region>
      <div class="w-10 h-10 rounded bg-gray-700 shrink-0 overflow-hidden">
        <img
          v-if="player.currentSong?.cover_path"
          :src="player.getCoverUrl(player.currentSong.cover_path)"
          class="w-full h-full object-cover"
        />
      </div>
      <div class="min-w-0" data-tauri-drag-region>
        <p class="text-white text-xs truncate">{{ player.currentSong?.title || '未播放' }}</p>
        <p class="text-gray-500 text-[10px] truncate">{{ player.currentSong?.artist || '' }}</p>
      </div>
    </div>

    <!-- 进度条 -->
    <input
      type="range"
      class="w-24"
      min="0"
      :max="player.duration || 0"
      :value="player.currentTime"
      step="0.1"
      @input="onProgressInput"
    />

    <!-- 控制按钮 -->
    <div class="flex items-center gap-2">
      <button class="text-white text-sm hover:text-gray-300" @click="player.prev">⏮</button>
      <button
        class="w-7 h-7 bg-white rounded-full flex items-center justify-center"
        @click="player.togglePlay"
      >
        <span class="text-gray-900 text-xs">{{ player.isPlaying ? '⏸' : '▶' }}</span>
      </button>
      <button class="text-white text-sm hover:text-gray-300" @click="player.next">⏭</button>
    </div>

    <!-- 时间 -->
    <span class="text-gray-400 text-[10px] shrink-0">
      {{ formatTime(player.currentTime) }}
    </span>

    <!-- 退出迷你模式 -->
    <button
      class="text-gray-400 hover:text-white text-xs ml-1"
      title="退出迷你模式"
      @click="player.toggleMiniMode"
    >
      ✕
    </button>
  </div>
</template>
