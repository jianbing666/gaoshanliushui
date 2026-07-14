<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { formatTime } from '@/utils/formatTime'
import type { Song } from '@/types/song'
import { computed } from 'vue'

const player = usePlayerStore()

const props = defineProps<{
  song: Song
  index: number
  compact?: boolean
  playlistId?: string | null
}>()

const emit = defineEmits<{
  play: [index: number]
}>()

const isCurrentSong = computed(() => {
  const currentSong = player.currentSong
  return currentSong?.id === props.song.id
})

function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  player.openContextMenu(props.song, props.playlistId || null, e.clientX, e.clientY)
}

// 阶段 3.7: 封面加载失败时静默隐藏
function onCoverError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}
</script>

<template>
  <!--
    阶段 2.x: v-memo 优化
    仅当 song.id / isCurrentSong / player.isPlaying 变化时重渲染,
    避免 compact 等无关 prop 变化触发整个列表 diff (5000 首歌场景收益显著)
  -->
  <div
    v-memo="[song.id, isCurrentSong, player.isPlaying]"
    class="flex items-center gap-3 px-3 rounded-lg cursor-pointer transition-colors hover:bg-gray-100/50 dark:hover:bg-white/10 group"
    :class="[
      compact ? 'py-1.5' : 'py-2',
      isCurrentSong ? 'bg-gray-100/50 dark:bg-white/10' : '',
    ]"
    @click="emit('play', index)"
    @contextmenu="handleContextMenu"
  >
    <span v-if="!compact" class="w-6 text-center text-sm text-gray-500 dark:text-gray-400 shrink-0">
      <template v-if="isCurrentSong && player.isPlaying">
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

    <div
      class="rounded-md bg-gray-200 dark:bg-gray-700 shrink-0 overflow-hidden"
      :class="compact ? 'w-7 h-7' : 'w-10 h-10'"
    >
      <img
        v-if="song.cover_path"
        :src="player.getCoverUrl(song.cover_path)"
        :alt="song.title"
        class="w-full h-full object-cover"
        loading="lazy"
        decoding="async"
        @error="onCoverError"
      />
      <div class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
        <span :class="compact ? 'text-[10px]' : 'text-xs'">♪</span>
      </div>
    </div>

    <div class="flex-1 min-w-0">
      <p
        class="truncate"
        :class="[
          compact ? 'text-xs' : 'text-sm',
          isCurrentSong
            ? 'text-blue-500 dark:text-blue-400'
            : 'text-gray-900 dark:text-white',
        ]"
      >
        {{ song.title }}
      </p>
      <p v-if="!compact" class="text-xs text-gray-600 dark:text-gray-400 truncate">
        {{ song.artist || '未知艺术家' }}
      </p>
    </div>

    <span v-if="!compact" class="text-xs text-gray-500 dark:text-gray-500 shrink-0">
      {{ formatTime(song.duration) }}
    </span>
  </div>
</template>
