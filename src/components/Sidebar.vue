<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import SongItem from './SongItem.vue'

const player = usePlayerStore()
</script>

<template>
  <aside class="w-72 bg-white/80 dark:bg-gray-800/50 backdrop-blur-xl border-r border-gray-200/50 dark:border-gray-700/50 flex flex-col h-full">
    <!-- 标题栏 -->
    <div class="p-4 border-b border-gray-200/50 dark:border-gray-700/50">
      <div class="flex items-center justify-between">
        <h2 class="text-gray-900 dark:text-white text-lg font-semibold">播放列表</h2>
        <span class="text-gray-500 dark:text-gray-400 text-xs">{{ player.playlist.length }} 首</span>
      </div>
    </div>

    <!-- 歌曲列表 -->
    <div class="flex-1 overflow-y-auto p-2 space-y-0.5">
      <template v-if="player.playlist.length > 0">
        <SongItem
          v-for="(song, index) in player.playlist"
          :key="song.id"
          :song="song"
          :index="index"
          @play="player.playByIndex"
        />
      </template>
      <template v-else>
        <div class="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
          <span class="text-4xl mb-3">🎵</span>
          <p>请在右侧设置面板</p>
          <p>选择音乐文件夹</p>
        </div>
      </template>
    </div>
  </aside>
</template>