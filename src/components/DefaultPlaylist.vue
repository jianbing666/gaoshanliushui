<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import MusicIcon from '@/components/icons/MusicIcon.vue'

const player = usePlayerStore()

// 获取默认歌单的歌曲数量
function getSongCount(): number {
  return player.defaultPlaylist?.songIds.length || 0
}
</script>

<template>
  <div
    class="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors group"
    :class="
      player.activePlaylistId === 'all-songs'
        ? 'bg-blue-500/15 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 font-medium'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/50 dark:hover:bg-white/5'
    "
    @click="player.selectPlaylist('all-songs')"
  >
    <!-- 音乐图标 -->
    <MusicIcon
      :size="16"
      :class="
        player.activePlaylistId === 'all-songs'
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
        player.activePlaylistId === 'all-songs'
          ? 'text-blue-500 dark:text-blue-400'
          : 'text-gray-400 dark:text-gray-500'
      "
    >
      {{ getSongCount() }}
    </span>
  </div>
</template>
