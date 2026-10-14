<script setup lang="ts">
import { computed } from 'vue'
import { useLibraryStore } from '@/stores/libraryStore'
import { useUIStore } from '@/stores/uiStore'
import type { Playlist } from '@/types/song'
import FolderIcon from '@/components/icons/FolderIcon.vue'

const props = defineProps<{
  playlist: Playlist
}>()

const library = useLibraryStore()
const ui = useUIStore()

const isActive = computed(() => library.activePlaylistId === props.playlist.id)

function handleClick() {
  library.selectPlaylist(props.playlist.id)
}

function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  ui.openPlaylistContextMenu(props.playlist, e.clientX, e.clientY)
}
</script>

<template>
  <div
    class="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors group"
    :class="
      isActive
        ? 'bg-gray-100/50 dark:bg-white/10 text-gray-900 dark:text-white font-medium'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/50 dark:hover:bg-white/5'
    "
    @click="handleClick"
    @contextmenu="handleContextMenu"
  >
    <FolderIcon
      :size="16"
      :class="isActive ? 'text-gray-600 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'"
    />

    <span class="flex-1 text-sm truncate">{{ playlist.name }}</span>

    <span
      class="text-xs shrink-0"
      :class="isActive ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'"
    >
      {{ playlist.songCount ?? 0 }}
    </span>
  </div>
</template>
