<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { formatTime } from '@/utils/formatTime'
import type { Song } from '@/types/song'

const player = usePlayerStore()

defineProps<{
  song: Song
  index: number
}>()

const emit = defineEmits<{
  play: [index: number]
}>()
</script>

<template>
  <div
    class="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors hover:bg-white/10"
    :class="{ 'bg-white/10': player.currentIndex === index }"
    @click="emit('play', index)"
  >
    <!-- 序号或播放指示 -->
    <span class="w-6 text-center text-sm text-gray-400 shrink-0">
      <template v-if="player.currentIndex === index && player.isPlaying">
        <span class="flex items-center justify-center gap-0.5">
          <span class="w-0.5 h-3 bg-blue-400 animate-pulse"></span>
          <span class="w-0.5 h-4 bg-blue-400 animate-pulse" style="animation-delay: 0.15s"></span>
          <span class="w-0.5 h-2 bg-blue-400 animate-pulse" style="animation-delay: 0.3s"></span>
        </span>
      </template>
      <template v-else>
        {{ index + 1 }}
      </template>
    </span>

    <!-- 封面缩略图 -->
    <div class="w-10 h-10 rounded-md bg-gray-700 shrink-0 overflow-hidden">
      <img
        v-if="song.cover_path"
        :src="player.getCoverUrl(song.cover_path)"
        :alt="song.title"
        class="w-full h-full object-cover"
      />
      <div v-else class="w-full h-full flex items-center justify-center text-gray-500 text-xs">
        ♪
      </div>
    </div>

    <!-- 歌曲信息 -->
    <div class="flex-1 min-w-0">
      <p
        class="text-sm truncate"
        :class="player.currentIndex === index ? 'text-blue-400' : 'text-white'"
      >
        {{ song.title }}
      </p>
      <p class="text-xs text-gray-400 truncate">{{ song.artist || '未知艺术家' }}</p>
    </div>

    <!-- 时长 -->
    <span class="text-xs text-gray-500 shrink-0">{{ formatTime(song.duration) }}</span>
  </div>
</template>