<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import ChevronRightIcon from '@/components/icons/ChevronRightIcon.vue'
import ChevronLeftIcon from '@/components/icons/ChevronLeftIcon.vue'
import PlusIcon from '@/components/icons/PlusIcon.vue'
import TrashIcon from '@/components/icons/TrashIcon.vue'
import FolderIcon from '@/components/icons/FolderIcon.vue'

const player = usePlayerStore()
const menuRef = ref<HTMLElement | null>(null)

type MenuMode = 'main' | 'add' | 'move'
const menuMode = ref<MenuMode>('main')
const isClosing = ref(false)

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    closeMenu()
  }
}

function closeMenu() {
  isClosing.value = true
  setTimeout(() => {
    player.closeContextMenu()
    menuMode.value = 'main'
    isClosing.value = false
  }, 150)
}

function openAddPanel() {
  menuMode.value = 'add'
}

function openMovePanel() {
  menuMode.value = 'move'
}

function backToMain() {
  menuMode.value = 'main'
}

function addToPlaylist(playlistId: string) {
  if (player.contextMenu.song) {
    player.addSongToPlaylist(player.contextMenu.song.id, playlistId)
  }
}

function moveToPlaylist(playlistId: string) {
  if (player.contextMenu.song && player.contextMenu.playlistId !== 'all-songs' && player.contextMenu.playlistId) {
    const songId = player.contextMenu.song.id
    const currentPlaylistId = player.contextMenu.playlistId
    player.addSongToPlaylist(songId, playlistId)
    player.removeSongFromPlaylist(songId, currentPlaylistId)
  }
  closeMenu()
}

function createAndAddToPlaylist() {
  const songId = player.contextMenu.song?.id
  closeMenu()
  if (songId) {
    setTimeout(() => {
      const name = window.prompt('请输入歌单名称：')
      if (name && name.trim()) {
        const newPlaylist = player.createPlaylist(name.trim())
        player.addSongToPlaylist(songId, newPlaylist.id)
      }
    }, 200)
  }
}

function removeFromCurrentPlaylist() {
  if (player.contextMenu.playlistId !== 'all-songs' && player.contextMenu.playlistId && player.contextMenu.song) {
    player.removeSongFromPlaylist(player.contextMenu.song.id, player.contextMenu.playlistId)
  }
  closeMenu()
}

function adjustPosition() {
  nextTick(() => {
    if (menuRef.value && player.contextMenu.song) {
      const rect = menuRef.value.getBoundingClientRect()
      let newX = player.contextMenu.x
      let newY = player.contextMenu.y
      
      if (rect.right > window.innerWidth) {
        newX = Math.max(8, player.contextMenu.x - rect.width)
      }
      if (rect.bottom > window.innerHeight) {
        newY = Math.max(8, player.contextMenu.y - rect.height)
      }
      
      if (newX !== player.contextMenu.x) {
        menuRef.value.style.left = `${newX}px`
      }
      if (newY !== player.contextMenu.y) {
        menuRef.value.style.top = `${newY}px`
      }
    }
  })
}

watch(
  () => player.contextMenu.visible,
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
    v-if="player.contextMenu.visible && player.contextMenu.song"
    ref="menuRef"
    class="fixed z-[100] w-48 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200/60 dark:border-gray-700/60 overflow-hidden"
    :class="{
      'animate-menu-enter': !isClosing,
      'animate-menu-exit': isClosing,
    }"
    :style="{ left: `${player.contextMenu.x}px`, top: `${player.contextMenu.y}px` }"
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

      <template v-if="player.contextMenu.playlistId !== 'all-songs' && player.contextMenu.playlistId">
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
        <template v-if="player.customPlaylists.length > 0">
          <button
            v-for="pl in player.customPlaylists"
            :key="pl.id"
            class="w-full px-3 py-2 rounded-lg text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center justify-between gap-2 transition-colors"
            :class="player.isSongInPlaylist(player.contextMenu.song!.id, pl.id)
              ? 'text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-900/10'
              : 'text-gray-700 dark:text-gray-300'"
            @click="addToPlaylist(pl.id)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <FolderIcon :size="14" :class="player.isSongInPlaylist(player.contextMenu.song!.id, pl.id) ? 'text-blue-500 shrink-0' : 'text-amber-500 shrink-0'" />
              <span class="truncate">{{ pl.name }}</span>
            </div>
            <span v-if="player.isSongInPlaylist(player.contextMenu.song!.id, pl.id)" class="shrink-0 text-xs">
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
        <template v-if="player.customPlaylists.filter(pl => pl.id !== player.contextMenu.playlistId).length > 0">
          <button
            v-for="pl in player.customPlaylists.filter(pl => pl.id !== player.contextMenu.playlistId)"
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
