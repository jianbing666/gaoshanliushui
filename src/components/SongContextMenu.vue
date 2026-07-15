<script setup lang="ts">
import { useUIStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
import ChevronRightIcon from '@/components/icons/ChevronRightIcon.vue'
import ChevronLeftIcon from '@/components/icons/ChevronLeftIcon.vue'
import PlusIcon from '@/components/icons/PlusIcon.vue'
import TrashIcon from '@/components/icons/TrashIcon.vue'
import FolderIcon from '@/components/icons/FolderIcon.vue'

const ui = useUIStore()
const library = useLibraryStore()
const menuRef = ref<HTMLElement | null>(null)

type MenuMode = 'main' | 'add' | 'move'
const menuMode = ref<MenuMode>('main')
const isClosing = ref(false)
const playlistMembership = ref<Record<string, boolean>>({})
const membershipLoading = ref(false)

const isDefaultPlaylist = computed(() => {
  const pid = ui.contextMenu.playlistId
  if (!pid) return true
  return library.defaultPlaylist?.id === pid
})

// 检查歌曲在各歌单中的状态
async function refreshPlaylistMembership() {
  if (!ui.contextMenu.song) return
  membershipLoading.value = true
  const result: Record<string, boolean> = {}
  for (const pl of library.customPlaylists) {
    result[pl.id] = await library.isSongInPlaylist(ui.contextMenu.song!.id, pl.id)
  }
  playlistMembership.value = result
  membershipLoading.value = false
}

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    closeMenu()
  }
}

function closeMenu() {
  isClosing.value = true
  setTimeout(() => {
    ui.closeContextMenu()
    menuMode.value = 'main'
    isClosing.value = false
    playlistMembership.value = {}
  }, 150)
}

function openAddPanel() {
  menuMode.value = 'add'
  void refreshPlaylistMembership()
}

function openMovePanel() {
  menuMode.value = 'move'
}

function backToMain() {
  menuMode.value = 'main'
}

function addToPlaylist(playlistId: string) {
  if (ui.contextMenu.song) {
    void library.addSongToPlaylist(ui.contextMenu.song.id, playlistId)
    // 立即更新本地状态
    playlistMembership.value[playlistId] = true
  }
}

function moveToPlaylist(playlistId: string) {
  if (ui.contextMenu.song && !isDefaultPlaylist.value && ui.contextMenu.playlistId) {
    const songId = ui.contextMenu.song.id
    const currentPlaylistId = ui.contextMenu.playlistId
    void library.addSongToPlaylist(songId, playlistId)
    void library.removeSongFromPlaylist(songId, currentPlaylistId)
  }
  closeMenu()
}

function createAndAddToPlaylist() {
  const songId = ui.contextMenu.song?.id
  closeMenu()
  if (songId) {
    nextTick(() => {
      ui.openCreatePlaylistModal(songId)
    })
  }
}

function removeFromCurrentPlaylist() {
  if (!isDefaultPlaylist.value && ui.contextMenu.playlistId && ui.contextMenu.song) {
    void library.removeSongFromPlaylist(ui.contextMenu.song.id, ui.contextMenu.playlistId)
  }
  closeMenu()
}

function adjustPosition() {
  nextTick(() => {
    if (menuRef.value && ui.contextMenu.song) {
      const rect = menuRef.value.getBoundingClientRect()
      let newX = ui.contextMenu.x
      let newY = ui.contextMenu.y

      if (rect.right > window.innerWidth) {
        newX = Math.max(8, ui.contextMenu.x - rect.width)
      }
      if (rect.bottom > window.innerHeight) {
        newY = Math.max(8, ui.contextMenu.y - rect.height)
      }

      if (newX !== ui.contextMenu.x) {
        menuRef.value.style.left = `${newX}px`
      }
      if (newY !== ui.contextMenu.y) {
        menuRef.value.style.top = `${newY}px`
      }
    }
  })
}

watch(
  () => ui.contextMenu.visible,
  (visible) => {
    if (visible) {
      menuMode.value = 'main'
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
    v-if="ui.contextMenu.visible && ui.contextMenu.song"
    ref="menuRef"
    class="fixed z-[100] w-48 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200/60 dark:border-gray-700/60 overflow-hidden"
    :class="{
      'animate-menu-enter': !isClosing,
      'animate-menu-exit': isClosing,
    }"
    :style="{ left: `${ui.contextMenu.x}px`, top: `${ui.contextMenu.y}px` }"
    @click.stop
  >
    <!-- 主菜单 -->
    <div
      class="p-1.5"
      :class="{
        'animate-menu-slide-right': menuMode === 'main',
        'hidden': menuMode !== 'main',
      }"
    >
      <button
        class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center justify-between gap-2 transition-colors"
        @click="openAddPanel"
      >
        <div class="flex items-center gap-2">
          <PlusIcon :size="14" class="text-blue-500" />
          <span>添加到歌单</span>
        </div>
        <ChevronRightIcon :size="14" class="text-gray-400" />
      </button>

      <template v-if="!isDefaultPlaylist && ui.contextMenu.playlistId">
        <button
          class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center justify-between gap-2 transition-colors"
          @click="openMovePanel"
        >
          <div class="flex items-center gap-2">
            <FolderIcon :size="14" class="text-amber-500" />
            <span>转移至其他歌单</span>
          </div>
          <ChevronRightIcon :size="14" class="text-gray-400" />
        </button>

        <div class="h-px bg-gray-200/60 dark:bg-gray-700/60 my-1"></div>

        <button
          class="w-full px-3 py-2 rounded-lg text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2 transition-colors"
          @click="removeFromCurrentPlaylist"
        >
          <TrashIcon :size="14" />
          <span>从当前歌单移除</span>
        </button>
      </template>
    </div>

    <!-- 添加到歌单子菜单 -->
    <div
      class="p-1.5"
      :class="{
        'animate-menu-slide-left': menuMode === 'add',
        'hidden': menuMode !== 'add',
      }"
    >
      <button
        class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center gap-2 transition-colors mb-1"
        @click="backToMain"
      >
        <ChevronLeftIcon :size="14" class="text-gray-400" />
        <span class="font-medium">返回</span>
      </button>

      <div class="h-px bg-gray-200/60 dark:bg-gray-700/60 my-1"></div>

      <div class="max-h-56 overflow-y-auto">
        <template v-if="library.customPlaylists.length > 0">
          <button
            v-for="pl in library.customPlaylists"
            :key="pl.id"
            class="w-full px-3 py-2 rounded-lg text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center justify-between gap-2 transition-colors"
            :class="playlistMembership[pl.id]
              ? 'text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-900/10'
              : 'text-gray-700 dark:text-gray-300'"
            @click="addToPlaylist(pl.id)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <FolderIcon :size="14" :class="playlistMembership[pl.id] ? 'text-blue-500 shrink-0' : 'text-amber-500 shrink-0'" />
              <span class="truncate">{{ pl.name }}</span>
            </div>
            <span v-if="playlistMembership[pl.id]" class="shrink-0 text-xs">
              已添加
            </span>
          </button>
        </template>

        <div v-else class="px-3 py-4 text-center">
          <p class="text-gray-400 dark:text-gray-500 text-xs">暂无个人歌单</p>
        </div>
      </div>

      <div class="h-px bg-gray-200/60 dark:bg-gray-700/60 my-1"></div>

      <button
        class="w-full px-3 py-2 rounded-lg text-left text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-2 transition-colors"
        @click="createAndAddToPlaylist"
      >
        <PlusIcon :size="14" />
        <span>新建歌单...</span>
      </button>
    </div>

    <!-- 转移至其他歌单子菜单 -->
    <div
      class="p-1.5"
      :class="{
        'animate-menu-slide-left': menuMode === 'move',
        'hidden': menuMode !== 'move',
      }"
    >
      <button
        class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center gap-2 transition-colors mb-1"
        @click="backToMain"
      >
        <ChevronLeftIcon :size="14" class="text-gray-400" />
        <span class="font-medium">返回</span>
      </button>

      <div class="h-px bg-gray-200/60 dark:bg-gray-700/60 my-1"></div>

      <div class="max-h-56 overflow-y-auto">
        <template v-if="library.customPlaylists.filter(pl => pl.id !== ui.contextMenu.playlistId).length > 0">
          <button
            v-for="pl in library.customPlaylists.filter(pl => pl.id !== ui.contextMenu.playlistId)"
            :key="pl.id"
            class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center gap-2 transition-colors"
            @click="moveToPlaylist(pl.id)"
          >
            <FolderIcon :size="14" class="text-amber-500 shrink-0" />
            <span class="truncate">{{ pl.name }}</span>
          </button>
        </template>

        <div v-else class="px-3 py-4 text-center">
          <p class="text-gray-400 dark:text-gray-500 text-xs">暂无其他歌单</p>
        </div>
      </div>
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

.animate-menu-slide-right {
  animation: slide-right 0.2s ease-out;
}

.animate-menu-slide-left {
  animation: slide-left 0.2s ease-out;
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

@keyframes slide-right {
  from {
    opacity: 0;
    transform: translateX(-12px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes slide-left {
  from {
    opacity: 0;
    transform: translateX(12px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>
