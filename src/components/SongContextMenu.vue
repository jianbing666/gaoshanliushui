<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import type { Song } from '@/types/song'
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import ChevronRightIcon from '@/components/icons/ChevronRightIcon.vue'
import ChevronLeftIcon from '@/components/icons/ChevronLeftIcon.vue'
import PlusIcon from '@/components/icons/PlusIcon.vue'
import TrashIcon from '@/components/icons/TrashIcon.vue'
import MusicIcon from '@/components/icons/MusicIcon.vue'
import FolderIcon from '@/components/icons/FolderIcon.vue'

const props = defineProps<{
  song: Song
  visible: boolean
  x: number
  y: number
}>()

const emit = defineEmits<{
  close: []
}>()

const player = usePlayerStore()
const menuRef = ref<HTMLElement | null>(null)

// 面板切换模式：main 主菜单, move 移动到歌单
type MenuMode = 'main' | 'move'
const menuMode = ref<MenuMode>('main')
const isClosing = ref(false)

// 点击外部关闭菜单
function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    closeMenu()
  }
}

// 关闭菜单（带动画）
function closeMenu() {
  isClosing.value = true
  setTimeout(() => {
    emit('close')
    menuMode.value = 'main'
    isClosing.value = false
  }, 150)
}

// 切换到移动面板
function openMovePanel() {
  menuMode.value = 'move'
}

// 返回主菜单
function backToMain() {
  menuMode.value = 'main'
}

// 添加到指定歌单
function addToPlaylist(playlistId: string) {
  player.addSongToPlaylist(props.song.id, playlistId)
  closeMenu()
}

// 新建歌单并添加
function createAndAddToPlaylist() {
  const name = window.prompt('请输入歌单名称：')
  if (name && name.trim()) {
    const newPlaylist = player.createPlaylist(name.trim())
    player.addSongToPlaylist(props.song.id, newPlaylist.id)
  }
  closeMenu()
}

// 从当前歌单移除（仅在自定义歌单中有效）
function removeFromCurrentPlaylist() {
  if (player.activePlaylistId !== 'all-songs') {
    player.removeSongFromPlaylist(props.song.id, player.activePlaylistId)
  }
  closeMenu()
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  // 自动调整位置，避免超出视口
  nextTick(() => {
    if (menuRef.value) {
      const rect = menuRef.value.getBoundingClientRect()
      if (rect.right > window.innerWidth) {
        menuRef.value.style.left = `${Math.max(8, props.x - rect.width)}px`
      }
      if (rect.bottom > window.innerHeight) {
        menuRef.value.style.top = `${Math.max(8, props.y - rect.height)}px`
      }
    }
  })
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div
    v-if="visible"
    ref="menuRef"
    class="fixed z-50 w-48 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200/60 dark:border-gray-700/60 overflow-hidden"
    :class="{
      'animate-menu-enter': !isClosing,
      'animate-menu-exit': isClosing,
    }"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @click.stop
  >
    <!-- 主菜单面板 -->
    <div
      class="p-1.5"
      :class="{
        'animate-menu-slide-right': menuMode === 'main',
        'hidden': menuMode !== 'main',
      }"
    >
      <!-- 添加到歌单 -->
      <button
        class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center justify-between gap-2 transition-colors"
        @click="openMovePanel"
      >
        <div class="flex items-center gap-2">
          <MusicIcon :size="14" class="text-blue-500" />
          <span>添加到歌单</span>
        </div>
        <ChevronRightIcon :size="14" class="text-gray-400" />
      </button>

      <!-- 从当前歌单移除（仅在自定义歌单中显示） -->
      <template v-if="player.activePlaylistId !== 'all-songs'">
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

    <!-- 移动到歌单面板 -->
    <div
      class="p-1.5"
      :class="{
        'animate-menu-slide-left': menuMode === 'move',
        'hidden': menuMode !== 'move',
      }"
    >
      <!-- 返回按钮 -->
      <button
        class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center gap-2 transition-colors mb-1"
        @click="backToMain"
      >
        <ChevronLeftIcon :size="14" class="text-gray-400" />
        <span class="font-medium">添加到歌单</span>
      </button>

      <div class="h-px bg-gray-200/60 dark:bg-gray-700/60 my-1"></div>

      <!-- 歌单列表（可滚动） -->
      <div class="max-h-56 overflow-y-auto">
        <template v-if="player.customPlaylists.length > 0">
          <button
            v-for="pl in player.customPlaylists"
            :key="pl.id"
            class="w-full px-3 py-2 rounded-lg text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 flex items-center justify-between gap-2 transition-colors"
            @click="addToPlaylist(pl.id)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <FolderIcon :size="14" class="text-amber-500 shrink-0" />
              <span class="truncate">{{ pl.name }}</span>
            </div>
            <span v-if="player.isSongInPlaylist(song.id, pl.id)" class="text-blue-500 shrink-0">
              ✓
            </span>
          </button>
        </template>

        <!-- 空状态 -->
        <div v-else class="px-3 py-4 text-center">
          <p class="text-gray-400 dark:text-gray-500 text-xs">暂无个人歌单</p>
        </div>
      </div>

      <div class="h-px bg-gray-200/60 dark:bg-gray-700/60 my-1"></div>

      <!-- 新建歌单 -->
      <button
        class="w-full px-3 py-2 rounded-lg text-left text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-2 transition-colors"
        @click="createAndAddToPlaylist"
      >
        <PlusIcon :size="14" />
        <span>新建歌单...</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 菜单进入动画 */
.animate-menu-enter {
  animation: menu-enter 0.15s ease-out;
}

/* 菜单退出动画 */
.animate-menu-exit {
  animation: menu-exit 0.15s ease-in forwards;
}

/* 面板切换：主菜单右滑入 */
.animate-menu-slide-right {
  animation: slide-right 0.2s ease-out;
}

/* 面板切换：子菜单左滑入 */
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
