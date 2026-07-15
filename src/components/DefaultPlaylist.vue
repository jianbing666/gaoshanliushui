<script setup lang="ts">
import { computed } from 'vue'
import { useLibraryStore } from '@/stores/libraryStore'
import MusicIcon from '@/components/icons/MusicIcon.vue'

const player = useLibraryStore()

const defaultPlaylistId = computed(() => player.defaultPlaylist?.id || '1')
const isActive = computed(() => player.activePlaylistId === defaultPlaylistId.value)

function getSongCount(): number {
  return player.playlist.length
}
</script>

<template>
  <div
    class="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors group"
    :class="
      isActive
        ? 'bg-blue-500/15 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 font-medium'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/50 dark:hover:bg-white/5'
    "
    @click="player.selectPlaylist(defaultPlaylistId)"
  >
    <!-- 音乐图标 -->
    <MusicIcon
      :size="16"
      :class="
        isActive
          ? 'text-blue-500 dark:text-blue-400'
          : 'text-gray-400 dark:text-gray-500'
      "
    />

    <!-- 歌单名称 -->
    <span class="flex-1 text-sm truncate">全部歌曲</span>

    <!-- 歌曲数量 -->
    <span
      class="text-xs shrink-0"
      :class="
        isActive
          ? 'text-blue-500 dark:text-blue-400'
          : 'text-gray-400 dark:text-gray-500'
      "
    >
      {{ getSongCount() }}
    </span>
  </div>
</template>
