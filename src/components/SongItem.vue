<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { formatTime } from '@/utils/formatTime'
import type { Song } from '@/types/song'
import SongContextMenu from '@/components/SongContextMenu.vue'
import { ref, computed } from 'vue'

const player = usePlayerStore()

const props = defineProps<{
  song: Song
  index: number
  compact?: boolean
}>()

const emit = defineEmits<{
  play: [index: number]
}>()

// 右键菜单状态
const showContextMenu = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)

// 判断是否是当前播放的歌曲（在 activePlaylistSongs 中的索引）
const isCurrentSong = computed(() => {
  const currentSong = player.currentSong
  return currentSong?.id === props.song.id
})

// 处理右键菜单
function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
  showContextMenu.value = true
}

function closeContextMenu() {
  showContextMenu.value = false
}
</script>

<template>
  <div
    class="flex items-center gap-3 px-3 rounded-lg cursor-pointer transition-colors hover:bg-gray-100/50 dark:hover:bg-white/10 group"
    :class="[
      compact ? 'py-1.5' : 'py-2',
      isCurrentSong ? 'bg-gray-100/50 dark:bg-white/10' : '',
    ]"
    @click="emit('play', index)"
    @contextmenu="handleContextMenu"
  >
    <!-- 序号或播放指示（非紧凑模式） -->
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

    <!-- 封面缩略图 -->
    <div
      class="rounded-md bg-gray-200 dark:bg-gray-700 shrink-0 overflow-hidden"
      :class="compact ? 'w-7 h-7' : 'w-10 h-10'"
    >
      <img
        v-if="song.cover_path"
        :src="player.getCoverUrl(song.cover_path)"
        :alt="song.title"
        class="w-full h-full object-cover"
      />
      <div class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
        <span :class="compact ? 'text-[10px]' : 'text-xs'">♪</span>
      </div>
    </div>

    <!-- 歌曲信息 -->
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

    <!-- 时长（非紧凑模式） -->
    <span v-if="!compact" class="text-xs text-gray-500 dark:text-gray-500 shrink-0">
      {{ formatTime(song.duration) }}
    </span>

    <!-- 右键菜单 -->
    <SongContextMenu
      :song="song"
      :visible="showContextMenu"
      :x="contextMenuX"
      :y="contextMenuY"
      @close="closeContextMenu"
    />
  </div>
</template>