<script setup lang="ts">
import { useLibraryStore } from '@/stores/libraryStore'
import { useAudioStore } from '@/stores/audioStore'
import type { Playlist } from '@/types/song'
import FolderIcon from '@/components/icons/FolderIcon.vue'
import ChevronRightIcon from '@/components/icons/ChevronRightIcon.vue'
import ChevronDownIcon from '@/components/icons/ChevronDownIcon.vue'
import SongItem from '@/components/SongItem.vue'
// 阶段 2.1: 虚拟列表
import VirtualSongList from '@/components/VirtualSongList.vue'
import { computed } from 'vue'

const props = defineProps<{
  playlist: Playlist
}>()

const library = useLibraryStore()
const audio = useAudioStore()

// 歌单内的歌曲列表
const songs = computed(() => {
  return props.playlist.songIds
    .map((id) => library.findSongById(id))
    .filter((s) => s !== undefined)
})

// 阶段 2.1: 长度 > 200 启用虚拟滚动
const useVirtualList = computed(() => songs.value.length > 200)

// 是否激活
const isActive = computed(() => library.activePlaylistId === props.playlist.id)

// 点击展开/折叠
function handleToggleExpand(e: MouseEvent) {
  e.stopPropagation()
  library.togglePlaylistExpand(props.playlist.id)
}

// 点击选择歌单
function handleSelect() {
  library.selectPlaylist(props.playlist.id)
}

// 在歌单内播放歌曲
function playSongInPlaylist(index: number) {
  const song = songs.value[index]
  if (song) {
    // 先切换到该歌单，再播放
    library.selectPlaylist(props.playlist.id)
    // 使用全局索引播放
    const globalIndex = library.playlist.findIndex((s) => s.id === song.id)
    if (globalIndex !== -1) {
      audio.playByIndex(globalIndex)
    }
  }
}

function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
}
</script>

<template>
  <div>
    <!-- 歌单项 -->
    <div
      class="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors group"
      :class="
        isActive
          ? 'bg-gray-100/50 dark:bg-white/10 text-gray-900 dark:text-white font-medium'
          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/50 dark:hover:bg-white/5'
      "
      @click="handleSelect"
      @contextmenu="handleContextMenu"
    >
      <!-- 展开/折叠箭头 -->
      <button
        class="p-0.5 rounded hover:bg-gray-200/50 dark:hover:bg-white/10 transition-colors shrink-0"
        :class="isActive ? 'text-gray-600 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'"
        @click="handleToggleExpand"
      >
        <ChevronDownIcon v-if="playlist.expanded" :size="14" />
        <ChevronRightIcon v-else :size="14" />
      </button>

      <!-- 文件夹图标 -->
      <FolderIcon
        :size="16"
        :class="
          isActive
            ? 'text-gray-600 dark:text-gray-400'
            : 'text-gray-400 dark:text-gray-500'
        "
      />

      <!-- 歌单名称 -->
      <span class="flex-1 text-sm truncate">{{ playlist.name }}</span>

      <!-- 歌曲数量 -->
      <span
        class="text-xs shrink-0"
        :class="isActive ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'"
      >
        {{ songs.length }}
      </span>
    </div>

    <!-- 展开的歌曲列表（缩进显示） -->
    <div v-if="playlist.expanded" class="ml-6 mt-0.5">
      <template v-if="songs.length > 0">
        <!-- 阶段 2.1: 大列表走虚拟滚动, 小列表保留 v-for -->
        <VirtualSongList
          v-if="useVirtualList"
          :songs="songs"
          :compact="true"
          :playlist-id="playlist.id"
          @play="playSongInPlaylist"
        >
          <template #default="{ song, index }">
            <SongItem
              :song="song"
              :index="index"
              :compact="true"
              :playlist-id="playlist.id"
              @play="playSongInPlaylist"
            />
          </template>
        </VirtualSongList>
        <template v-else>
          <div class="space-y-0.5">
            <SongItem
              v-for="(song, index) in songs"
              :key="song.id"
              :song="song"
              :index="index"
              :compact="true"
              :playlist-id="playlist.id"
              @play="playSongInPlaylist"
            />
          </div>
        </template>
      </template>
      <div v-else class="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
        暂无歌曲
      </div>
    </div>
  </div>
</template>
