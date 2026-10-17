<script setup lang="ts">
import { useHistoryStore } from '@/stores/historyStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useAudioStore } from '@/stores/audioStore'
import { useUIStore } from '@/stores/uiStore'
import { formatTime } from '@/utils/formatTime'
import MusicIcon from '@/components/icons/MusicIcon.vue'
import ChevronLeftIcon from '@/components/icons/ChevronLeftIcon.vue'
import TrashIcon from '@/components/icons/TrashIcon.vue'
// 阶段 2.1: 虚拟列表
import VirtualSongList from '@/components/VirtualSongList.vue'
import type { PlayHistoryItem } from '@/types/song'
import { computed } from 'vue'

const history = useHistoryStore()
const library = useLibraryStore()
const audio = useAudioStore()
const ui = useUIStore()

// 阶段 2.1: 长度 > 200 启用虚拟滚动
const useVirtualList = computed(() => history.playHistory.length > 200)

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const itemDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  if (itemDate.getTime() === today.getTime()) {
    return '今天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } else if (itemDate.getTime() === yesterday.getTime()) {
    return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } else {
    return date.toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
}

function playHistoryItem(index: number) {
  const item = history.playHistory[index]
  if (!item) return

  const song = library.findSongById(item.songId)
  if (song) {
    const globalIndex = library.playlist.findIndex((s) => s.id === song.id)
    if (globalIndex !== -1) {
      audio.playByIndex(globalIndex)
    }
  }
}

// 阶段 3.7: 封面加载失败时静默隐藏
function onCoverError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
}
</script>

<template>
  <div
    class="w-80 h-full flex flex-col bg-white/50 dark:bg-gray-900/60 backdrop-blur border-r border-gray-200/60 dark:border-gray-700/60"
  >
    <!-- 头部 -->
    <div
      class="flex items-center justify-between px-4 py-3 border-b border-gray-200/50 dark:border-gray-700/50"
    >
      <div class="flex items-center gap-2">
        <h2 class="text-gray-900 dark:text-white text-base font-semibold">播放历史</h2>
        <span class="text-xs text-gray-500 dark:text-gray-400"
          >{{ history.playHistory.length }} 首</span
        >
      </div>
      <div class="flex items-center gap-1">
        <button
          v-if="history.playHistory.length > 0"
          class="p-1.5 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          title="清空历史"
          @click="history.clearPlayHistory()"
        >
          <TrashIcon :size="16" />
        </button>
        <button
          class="p-1.5 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white transition-colors"
          title="关闭"
          @click="ui.toggleHistoryDrawer()"
        >
          <ChevronLeftIcon :size="18" />
        </button>
      </div>
    </div>

    <!-- 历史记录列表 -->
    <div class="flex-1 overflow-y-auto min-h-0">
      <template v-if="history.playHistory.length > 0">
        <!-- 阶段 2.1: 大列表走虚拟滚动, 小列表保留 v-for -->
        <VirtualSongList v-if="useVirtualList" :songs="history.playHistory" :item-size="64">
          <template #default="{ song, index }">
            <div
              class="flex items-center gap-3 px-3 py-2 hover:bg-gray-100/60 dark:hover:bg-white/10 cursor-pointer transition-colors group"
              @click="playHistoryItem(index)"
            >
              <!-- 封面 -->
              <div
                class="w-10 h-10 rounded bg-gray-200/70 dark:bg-gray-700/70 shrink-0 overflow-hidden"
              >
                <img
                  v-if="
                    library.hasCoverThumb(
                      (song as PlayHistoryItem).cover_path,
                      (song as PlayHistoryItem).cover_thumb_path
                    )
                  "
                  :src="
                    library.getCoverThumbUrl(
                      (song as PlayHistoryItem).cover_path,
                      (song as PlayHistoryItem).cover_thumb_path
                    )
                  "
                  :alt="(song as PlayHistoryItem).title"
                  class="w-full h-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
                <div
                  v-else
                  class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500"
                >
                  <MusicIcon :size="16" />
                </div>
              </div>

              <!-- 歌曲信息 -->
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {{ (song as PlayHistoryItem).title }}
                </p>
                <p class="text-xs text-gray-600 dark:text-gray-300 truncate">
                  {{ (song as PlayHistoryItem).artist }}
                </p>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-xs text-gray-500 dark:text-gray-400">{{
                    formatDate((song as PlayHistoryItem).playedAt)
                  }}</span>
                  <span
                    class="text-xs"
                    :class="
                      (song as PlayHistoryItem).completed
                        ? 'text-green-500 dark:text-green-400'
                        : 'text-gray-500 dark:text-gray-400'
                    "
                  >
                    {{
                      (song as PlayHistoryItem).completed
                        ? '完整播放'
                        : formatTime((song as PlayHistoryItem).playedDuration)
                    }}
                  </span>
                </div>
              </div>

              <!-- 删除按钮 -->
              <button
                class="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-all"
                title="删除记录"
                @click.stop="history.removeHistoryItem((song as PlayHistoryItem).id)"
              >
                <TrashIcon :size="14" />
              </button>
            </div>
          </template>
        </VirtualSongList>
        <template v-else>
          <div
            v-for="(item, index) in history.playHistory"
            :key="item.id"
            class="flex items-center gap-3 px-3 py-2 hover:bg-gray-100/60 dark:hover:bg-white/10 cursor-pointer transition-colors group"
            @click="playHistoryItem(index)"
          >
            <!-- 封面 -->
            <div
              class="w-10 h-10 rounded bg-gray-200/70 dark:bg-gray-700/70 shrink-0 overflow-hidden"
            >
              <img
                v-if="item.cover_path"
                :src="library.getCoverThumbUrl(item.cover_path, item.cover_thumb_path)"
                :alt="item.title"
                class="w-full h-full object-cover"
                loading="lazy"
                decoding="async"
                @error="onCoverError"
              />
              <div
                v-else
                class="w-full h-full flex items-center justify-center text-gray-400 dark:text-gray-500"
              >
                <MusicIcon :size="16" />
              </div>
            </div>

            <!-- 歌曲信息 -->
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-gray-900 dark:text-white truncate">
                {{ item.title }}
              </p>
              <p class="text-xs text-gray-600 dark:text-gray-300 truncate">
                {{ item.artist }}
              </p>
              <div class="flex items-center gap-2 mt-0.5">
                <span class="text-xs text-gray-500 dark:text-gray-400">{{
                  formatDate(item.playedAt)
                }}</span>
                <span
                  class="text-xs"
                  :class="
                    item.completed
                      ? 'text-green-500 dark:text-green-400'
                      : 'text-gray-500 dark:text-gray-400'
                  "
                >
                  {{ item.completed ? '完整播放' : formatTime(item.playedDuration) }}
                </span>
              </div>
            </div>

            <!-- 删除按钮 -->
            <button
              class="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-all"
              title="删除记录"
              @click.stop="history.removeHistoryItem(item.id)"
            >
              <TrashIcon :size="14" />
            </button>
          </div>
        </template>
      </template>
      <template v-else>
        <div
          class="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400"
        >
          <MusicIcon :size="48" class="mb-3 opacity-30" />
          <p class="text-sm">暂无播放记录</p>
          <p class="text-xs mt-1">播放的歌曲会在这里显示</p>
        </div>
      </template>
    </div>
  </div>
</template>
