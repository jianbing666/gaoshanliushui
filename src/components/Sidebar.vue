<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import SongItem from './SongItem.vue'
import { open } from '@tauri-apps/plugin-dialog'

const player = usePlayerStore()

async function selectFolder() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择音乐文件夹',
    })
    if (selected) {
      await player.scanMusicFolder(selected)
    }
  } catch (error) {
    console.error('选择文件夹失败:', error)
  }
}
</script>

<template>
  <aside class="w-72 bg-gray-800/50 backdrop-blur-xl border-r border-gray-700/50 flex flex-col h-full">
    <!-- 标题栏 -->
    <div class="p-4 border-b border-gray-700/50">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-white text-lg font-semibold">播放列表</h2>
        <span class="text-gray-500 text-xs">{{ player.playlist.length }} 首</span>
      </div>
      <button
        class="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
        :disabled="player.isLoading"
        @click="selectFolder"
      >
        <span v-if="player.isLoading" class="animate-spin">⟳</span>
        <span v-else>📂</span>
        {{ player.isLoading ? '扫描中...' : '选择文件夹' }}
      </button>
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
        <div class="flex flex-col items-center justify-center h-full text-gray-500 text-sm">
          <span class="text-4xl mb-3">🎵</span>
          <p>点击上方按钮</p>
          <p>选择音乐文件夹</p>
        </div>
      </template>
    </div>
  </aside>
</template>