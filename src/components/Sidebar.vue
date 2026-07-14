<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import DefaultPlaylist from '@/components/DefaultPlaylist.vue'
import CustomPlaylist from '@/components/CustomPlaylist.vue'
import SongItem from '@/components/SongItem.vue'
// 阶段 2.1: 虚拟列表
import VirtualSongList from '@/components/VirtualSongList.vue'
import PlusIcon from '@/components/icons/PlusIcon.vue'
import { computed } from 'vue'

const player = usePlayerStore()

function handleCreatePlaylist() {
  player.openCreatePlaylistModal()
}

function playFilteredSong(index: number) {
  const song = player.filteredActivePlaylistSongs[index]
  if (song) {
    const globalIndex = player.playlist.findIndex((s) => s.id === song.id)
    if (globalIndex !== -1) {
      player.playByIndex(globalIndex)
    }
  }
}

// 阶段 2.1: 长度 > 200 启用虚拟滚动
const useVirtualList = computed(() => player.filteredActivePlaylistSongs.length > 200)
</script>

<template>
  <aside class="w-80 backdrop-blur border-r border-gray-200/50 dark:border-gray-700/50 flex flex-col h-full will-change-auto" :class="
    player.currentBackgroundUrl && player.background.mode !== 'none'
      ? 'bg-white/30 dark:bg-gray-900/30'
      : 'bg-white/80 dark:bg-gray-800/50'
  ">
    <div class="p-4 border-b border-gray-200/50 dark:border-gray-700/50">
      <div class="flex items-center justify-between">
        <h2 class="text-gray-900 dark:text-white text-lg font-semibold">歌单</h2>
        <button
          class="p-1.5 rounded-md hover:bg-gray-200/50 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          title="新建歌单"
          @click="handleCreatePlaylist"
        >
          <PlusIcon :size="16" />
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto flex flex-col min-h-0">
      <div class="p-2 space-y-0.5 border-b border-gray-200/50 dark:border-gray-700/50">
        <DefaultPlaylist />
      </div>

      <div class="p-2 space-y-0.5 flex-1 min-h-0 overflow-y-auto">
        <div class="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 font-medium uppercase tracking-wider">
          我的歌单
        </div>
        <template v-if="player.customPlaylists.length > 0">
          <CustomPlaylist
            v-for="pl in player.customPlaylists"
            :key="pl.id"
            :playlist="pl"
          />
        </template>
        <div v-else class="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
          点击右上角 + 创建歌单
        </div>
      </div>
    </div>

    <div class="border-t border-gray-200/50 dark:border-gray-700/50 flex-1 min-h-0 overflow-hidden flex flex-col">
      <div class="px-3 py-2 border-b border-gray-200/50 dark:border-gray-700/50">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
            {{ player.playlists.find(p => p.id === player.activePlaylistId)?.name || '歌曲列表' }}
          </h3>
          <span class="text-xs text-gray-400 dark:text-gray-500">
            {{ player.activePlaylistSongs.length }} 首
          </span>
        </div>
        <div class="relative">
          <svg
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.3-4.3"></path>
          </svg>
          <input
            v-model="player.searchQuery"
            type="text"
            placeholder="搜索歌曲..."
            class="w-full pl-9 pr-3 py-1.5 bg-gray-100/60 dark:bg-gray-700/40 border border-transparent rounded-lg text-gray-700 dark:text-gray-200 text-sm placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:bg-white dark:focus:bg-gray-700/60 focus:border-gray-200 dark:focus:border-gray-600 transition-all"
          />
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-2 space-y-0.5">
        <template v-if="player.filteredActivePlaylistSongs.length > 0">
          <!-- 阶段 2.1: 大列表走虚拟滚动, 小列表保留 v-for -->
          <VirtualSongList
            v-if="useVirtualList"
            :songs="player.filteredActivePlaylistSongs"
            @play="playFilteredSong"
          >
            <template #default="{ song, index }">
              <SongItem
                :song="song"
                :index="index"
                @play="playFilteredSong"
              />
            </template>
          </VirtualSongList>
          <template v-else>
            <SongItem
              v-for="(song, index) in player.filteredActivePlaylistSongs"
              :key="song.id"
              :song="song"
              :index="index"
              @play="playFilteredSong"
            />
          </template>
        </template>
        <div v-else class="flex flex-col items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
          <template v-if="player.searchQuery.trim()">
            <span class="text-2xl mb-2">🔍</span>
            <p>没有找到匹配的歌曲</p>
          </template>
          <template v-else>
            <span class="text-3xl mb-2">♪</span>
            <p>暂无歌曲</p>
          </template>
        </div>
      </div>
    </div>
  </aside>
</template>
