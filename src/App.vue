<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import Sidebar from '@/components/Sidebar.vue'
import Player from '@/components/Player.vue'
import ControlBar from '@/components/ControlBar.vue'
import MiniPlayer from '@/components/MiniPlayer.vue'

const player = usePlayerStore()
</script>

<template>
  <!-- 迷你模式 -->
  <MiniPlayer v-if="player.isMiniMode" />

  <!-- 正常模式 -->
  <div v-else class="flex h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 select-none">
    <!-- 左侧边栏：播放列表 -->
    <Sidebar />

    <!-- 右侧主区域 -->
    <main class="flex-1 flex flex-col min-w-0">
      <!-- 中央封面展示区域 -->
      <Player />

      <!-- 底部播放控制栏 -->
      <ControlBar />
    </main>
  </div>
</template>

<style>
/* 全局样式已在 main.css 中定义 */
</style>