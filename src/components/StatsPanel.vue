<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import MusicIcon from '@/components/icons/MusicIcon.vue'
import ChevronRightIcon from '@/components/icons/ChevronRightIcon.vue'

const player = usePlayerStore()

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hours > 0) {
    return `${hours}小时${minutes}分${secs}秒`
  } else if (minutes > 0) {
    return `${minutes}分${secs}秒`
  } else {
    return `${secs}秒`
  }
}

function formatDurationShort(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  } else {
    return `${minutes}m`
  }
}

async function handleExport() {
  await player.exportStatsReport()
}

// 阶段 3.7: 封面加载失败时静默隐藏
function onCoverError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}
</script>

<template>
  <div
    class="w-80 h-full flex flex-col bg-white/50 dark:bg-gray-900/60 backdrop-blur border-l border-gray-200/60 dark:border-gray-700/60 shadow-2xl will-change-auto"
  >
    <!-- 头部 -->
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-200/50 dark:border-gray-700/50">
      <div>
        <h2 class="text-gray-900 dark:text-white text-base font-semibold">数据统计</h2>
        <p class="text-gray-500 dark:text-gray-400 text-xs">你的听歌数据概览</p>
      </div>
      <button
        class="p-1.5 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white transition-colors"
        title="关闭"
        @click="player.toggleStatsPanel()"
      >
        <ChevronRightIcon :size="18" />
      </button>
    </div>

    <!-- 内容区域 -->
    <div class="flex-1 overflow-y-auto p-5 space-y-6">
      <!-- 听歌时长 -->
      <div>
        <h3 class="text-gray-900 dark:text-white text-sm font-medium mb-3 font-semibold">听歌时长</h3>
        <div class="space-y-2">
          <!-- 今天 -->
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-gray-700 dark:text-gray-200 text-sm">今天</span>
              <span class="text-gray-900 dark:text-white text-sm font-medium">{{ formatDuration(player.todayStats.totalDuration) }}</span>
            </div>
            <div class="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span>{{ player.todayStats.count }} 首</span>
              <span>完整播放 {{ player.todayStats.completedCount }} 首</span>
            </div>
          </div>

          <!-- 本月 -->
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-gray-700 dark:text-gray-200 text-sm">本月</span>
              <span class="text-gray-900 dark:text-white text-sm font-medium">{{ formatDuration(player.monthStats.totalDuration) }}</span>
            </div>
            <div class="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span>{{ player.monthStats.count }} 首</span>
              <span>完整播放 {{ player.monthStats.completedCount }} 首</span>
            </div>
          </div>

          <!-- 本年 -->
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
              <span class="text-gray-700 dark:text-gray-200 text-sm">本年</span>
              <span class="text-gray-900 dark:text-white text-sm font-medium">{{ formatDuration(player.yearStats.totalDuration) }}</span>
            </div>
            <div class="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span>{{ player.yearStats.count }} 首</span>
              <span>完整播放 {{ player.yearStats.completedCount }} 首</span>
            </div>
          </div>

          <!-- 全部 -->
          <div class="bg-blue-500/15 dark:bg-blue-500/20 rounded-lg p-3 border border-blue-200/30 dark:border-blue-500/30">
            <div class="flex items-center justify-between mb-2">
              <span class="text-blue-600 dark:text-blue-300 text-sm font-medium">累计总时长</span>
              <span class="text-blue-700 dark:text-blue-200 text-sm font-bold">{{ formatDuration(player.allTimeStats.totalDuration) }}</span>
            </div>
            <div class="flex items-center gap-4 text-xs text-blue-500 dark:text-blue-300">
              <span>{{ player.allTimeStats.count }} 次播放</span>
              <span>{{ player.allTimeStats.uniqueSongs }} 首不同歌曲</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 听歌之最 -->
      <div>
        <h3 class="text-gray-900 dark:text-white text-sm font-medium mb-3 font-semibold">听歌之最</h3>
        <div class="space-y-3">
          <!-- 播放次数最多 -->
          <div v-if="player.mostLoopedSong" class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center gap-3">
              <div class="w-12 h-12 rounded bg-gray-200/70 dark:bg-gray-700/70 shrink-0 overflow-hidden">
                <img
                  v-if="player.mostLoopedSong.song.cover_path"
                  :src="player.getCoverUrl(player.mostLoopedSong.song.cover_path)"
                  :alt="player.mostLoopedSong.song.title"
                  class="w-full h-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
                <div v-else class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
                  <MusicIcon :size="20" />
                </div>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-gray-900 dark:text-white text-sm font-medium truncate">{{ player.mostLoopedSong.song.title }}</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs truncate">{{ player.mostLoopedSong.song.artist || '未知艺术家' }}</p>
                <p class="text-blue-500 dark:text-blue-400 text-xs mt-0.5">播放次数最多 · {{ player.mostLoopedSong.count }} 次</p>
              </div>
            </div>
          </div>

          <!-- 总时长最久 -->
          <div v-if="player.longestPlayedSong" class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center gap-3">
              <div class="w-12 h-12 rounded bg-gray-200/70 dark:bg-gray-700/70 shrink-0 overflow-hidden">
                <img
                  v-if="player.longestPlayedSong.song.cover_path"
                  :src="player.getCoverUrl(player.longestPlayedSong.song.cover_path)"
                  :alt="player.longestPlayedSong.song.title"
                  class="w-full h-full object-cover"
                  loading="lazy"
                  decoding="async"
                  @error="onCoverError"
                />
                <div v-else class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
                  <MusicIcon :size="20" />
                </div>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-gray-900 dark:text-white text-sm font-medium truncate">{{ player.longestPlayedSong.song.title }}</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs truncate">{{ player.longestPlayedSong.song.artist || '未知艺术家' }}</p>
                <p class="text-green-500 dark:text-green-400 text-xs mt-0.5">累计时长最久 · {{ formatDurationShort(player.longestPlayedSong.duration) }}</p>
              </div>
            </div>
          </div>

          <!-- 暂无数据 -->
          <div v-if="!player.mostLoopedSong && !player.longestPlayedSong" class="text-center py-8 text-gray-500 dark:text-gray-400">
            <MusicIcon :size="40" class="mx-auto mb-2 opacity-30" />
            <p class="text-sm">暂无统计数据</p>
            <p class="text-xs mt-1">多听几首歌再来看看吧</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部导出按钮 -->
    <div class="p-4 border-t border-gray-200/50 dark:border-gray-700/50">
      <button
        class="w-full py-2.5 px-4 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="player.playHistory.length === 0"
        @click="handleExport"
      >
        导出 Markdown 报告
      </button>
    </div>
  </div>
</template>
