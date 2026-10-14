<script setup lang="ts">
import { useUIStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import DownloadIcon from '@/components/icons/DownloadIcon.vue'
import TrashIcon from '@/components/icons/TrashIcon.vue'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

const ui = useUIStore()
const library = useLibraryStore()
const menuRef = ref<HTMLElement | null>(null)
const isClosing = ref(false)

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    closeMenu()
  }
}

function closeMenu() {
  isClosing.value = true
  setTimeout(() => {
    ui.closePlaylistContextMenu()
    isClosing.value = false
  }, 150)
}

function adjustPosition() {
  nextTick(() => {
    if (menuRef.value && ui.playlistContextMenu.playlist) {
      const rect = menuRef.value.getBoundingClientRect()
      let newX = ui.playlistContextMenu.x
      let newY = ui.playlistContextMenu.y

      if (rect.right > window.innerWidth) {
        newX = Math.max(8, ui.playlistContextMenu.x - rect.width)
      }
      if (rect.bottom > window.innerHeight) {
        newY = Math.max(8, ui.playlistContextMenu.y - rect.height)
      }

      if (newX !== ui.playlistContextMenu.x) {
        menuRef.value.style.left = `${newX}px`
      }
      if (newY !== ui.playlistContextMenu.y) {
        menuRef.value.style.top = `${newY}px`
      }
    }
  })
}

async function exportPlaylist() {
  const playlist = ui.playlistContextMenu.playlist
  if (!playlist) return
  closeMenu()

  try {
    const defaultName = `${playlist.name}.md`
    const filePath = await save({
      defaultPath: defaultName,
      filters: [
        {
          name: 'Markdown',
          extensions: ['md'],
        },
      ],
    })

    if (!filePath) return

    const playlistId = parseInt(playlist.id, 10)
    if (isNaN(playlistId)) return

    await invoke('export_playlist', {
      playlistId,
      format: 'markdown',
      outputPath: filePath,
    })
  } catch (e) {
    console.error('导出歌单失败:', e)
  }
}

function deletePlaylist() {
  const playlist = ui.playlistContextMenu.playlist
  if (!playlist || playlist.type !== 'custom') return
  closeMenu()

  ui.openConfirmDialog({
    title: '删除歌单',
    message: `确定要删除歌单"${playlist.name}"吗？\n歌单内的歌曲文件不会被删除。`,
    type: 'danger',
    confirmText: '删除',
    cancelText: '取消',
    onConfirm: async () => {
      try {
        const playlistId = parseInt(playlist.id, 10)
        if (isNaN(playlistId)) return

        await invoke('delete_playlist', { playlistId })
        await library.loadPlaylistsFromDb()
      } catch (e) {
        console.error('删除歌单失败:', e)
      }
    },
  })
}

watch(
  () => ui.playlistContextMenu.visible,
  (visible) => {
    if (visible) {
      isClosing.value = false
      adjustPosition()
    }
  }
)

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div
    v-if="ui.playlistContextMenu.visible && ui.playlistContextMenu.playlist"
    ref="menuRef"
    class="fixed z-[100] w-44 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200/60 dark:border-gray-700/60 overflow-hidden"
    :class="{
      'animate-menu-enter': !isClosing,
      'animate-menu-exit': isClosing,
    }"
    :style="{ left: `${ui.playlistContextMenu.x}px`, top: `${ui.playlistContextMenu.y}px` }"
    @click.stop
  >
    <div class="p-1.5">
      <button
        class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center gap-2 transition-colors"
        @click="exportPlaylist"
      >
        <DownloadIcon :size="14" class="text-blue-500" />
        <span>导出歌单</span>
      </button>

      <template v-if="ui.playlistContextMenu.playlist.type === 'custom'">
        <div class="h-px bg-gray-200/60 dark:bg-gray-700/60 my-1"></div>

        <button
          class="w-full px-3 py-2 rounded-lg text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2 transition-colors"
          @click="deletePlaylist"
        >
          <TrashIcon :size="14" />
          <span>删除歌单</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.animate-menu-enter {
  animation: menu-enter 0.15s ease-out;
}

.animate-menu-exit {
  animation: menu-exit 0.15s ease-in forwards;
}

@keyframes menu-enter {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes menu-exit {
  from {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  to {
    opacity: 0;
    transform: scale(0.96) translateY(-4px);
  }
}
</style>
