<script setup lang="ts">
import { useLibraryStore } from '@/stores/libraryStore'
import { useUIStore } from '@/stores/uiStore'
import { useAudioStore } from '@/stores/audioStore'
import { formatTime } from '@/utils/formatTime'
import type { Song } from '@/types/song'
import { computed } from 'vue'

const library = useLibraryStore()
const ui = useUIStore()
const audio = useAudioStore()

const props = defineProps<{
  song: Song
  index: number
  compact?: boolean
  playlistId?: string | null
  /** 是否撑满父容器高度（虚拟列表中使用，由父容器控制高度） */
  fillHeight?: boolean
}>()

const emit = defineEmits<{
  play: [index: number]
}>()

const isCurrentSong = computed(() => {
  const currentSong = library.currentSong
  return currentSong?.id === props.song.id
})

function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  ui.openContextMenu(props.song, props.playlistId || null, e.clientX, e.clientY)
}

// 阶段 3.7: 封面加载失败时静默隐藏
function onCoverError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}
</script>

<template>
  <!--
    v1.1 修复 (2026-07-14): v-memo 移除 song.id, 改为包含 cover_path/duration
      原: [song.id, isCurrentSong, audio.isPlaying]  -- song.id 不变, 封面/duration 变化不重渲染
      改: [isCurrentSong, audio.isPlaying, !!song.cover_path, song.duration]
          用布尔值 + 数值 (而非字符串比较) 控制重渲染, 避免频繁 diff
    阶段 2 阶段 2.x 优化: 避免 compact 等无关 prop 变化触发整个列表 diff (5000 首歌场景收益显著)
  -->
  <div
    class="flex items-center gap-3 px-3 rounded-lg cursor-pointer transition-colors hover:bg-gray-100/50 dark:hover:bg-white/10 group w-full max-w-full"
    :class="[
      fillHeight
        ? 'h-full'
        : (compact ? 'h-9' : 'h-14'),
      isCurrentSong ? 'bg-gray-100/50 dark:bg-white/10' : '',
    ]"
    @click="emit('play', index)"
    @contextmenu="handleContextMenu"
  >
    <span v-if="!compact" class="w-6 text-center text-sm text-gray-500 dark:text-gray-400 shrink-0">
      <template v-if="isCurrentSong && audio.isPlaying">
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
        :src="library.getCoverThumbUrl(song.cover_path, song.cover_thumb_path)"
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

    <div class="flex-1 min-w-0 h-10 flex flex-col justify-center gap-0.5">
      <p
        :class="[
          compact ? 'text-xs' : 'text-sm',
          isCurrentSong ? 'text-blue-500 dark:text-blue-400' : 'text-gray-900 dark:text-white'
        ]"
        class="truncate font-medium"
      >
        {{ song.title }}
      </p>
      <p
        v-if="!compact"
        class="text-xs text-gray-600 dark:text-gray-400 truncate"
      >
        {{ song.artist || '未知艺术家' }}
      </p>
    </div>

    <span v-if="!compact" class="text-xs text-gray-500 dark:text-gray-500 shrink-0">
      {{ formatTime(song.duration) }}
    </span>
  </div>
</template>
