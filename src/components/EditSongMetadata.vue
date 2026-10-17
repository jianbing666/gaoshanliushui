<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useLibraryStore } from '@/stores/libraryStore'
import { invoke } from '@tauri-apps/api/core'
import type { Song } from '@/types/song'
import Icon from '@/components/icons/Icon.vue'

const library = useLibraryStore()

const props = defineProps<{
  song: Song
  visible: boolean
  x: number
  y: number
}>()

const emit = defineEmits<{
  close: []
}>()

const title = ref('')
const artist = ref('')
const album = ref('')
const isClosing = ref(false)
const saving = ref(false)
const menuRef = ref<HTMLElement | null>(null)
// 浮窗位置由本地状态驱动: 首帧即用 props 传入的锚点, adjustPosition 再按视口收敛
const pos = ref({ x: props.x, y: props.y })
// 关闭动画的延迟回调: 重新打开时需取消, 否则会把新开的浮窗一起关掉
let closeTimer: number | null = null

function resetToOriginal() {
  title.value = props.song.title
  artist.value = props.song.artist
  album.value = props.song.album
}

function handleClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    closePopup()
  }
}

function closePopup() {
  isClosing.value = true
  if (closeTimer !== null) clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => {
    closeTimer = null
    emit('close')
    isClosing.value = false
  }, 100)
}

function syncFromSong() {
  title.value = props.song.title
  artist.value = props.song.artist
  album.value = props.song.album
}

async function handleSave() {
  if (!props.song.content_hash) return

  // 先更新本地 UI（乐观更新），立即关闭弹窗
  const updates = {
    title: title.value.trim(),
    artist: artist.value.trim(),
    album: album.value.trim(),
  }
  library.updateSongLocalMetadata(props.song.id, updates)
  closePopup()

  // 后台异步写入数据库
  try {
    await invoke('update_song_metadata', {
      songHash: props.song.content_hash,
      title: updates.title,
      artist: updates.artist,
      album: updates.album,
    })
  } catch (error) {
    console.error('更新元数据失败:', error)
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closePopup()
  }
}

watch(
  [() => props.visible, () => props.song.id],
  ([visible]) => {
    if (visible) {
      // 取消上一次关闭动画的延迟回调, 避免连续操作时浮窗被立刻关掉
      if (closeTimer !== null) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      isClosing.value = false
      saving.value = false
      pos.value = { x: props.x, y: props.y }
      syncFromSong()
      nextTick(() => {
        adjustPosition()
      })
    }
  },
  { immediate: true }
)

function adjustPosition() {
  if (!menuRef.value) return
  const rect = menuRef.value.getBoundingClientRect()
  let newX = props.x
  let newY = props.y

  if (rect.right > window.innerWidth) {
    newX = Math.max(8, window.innerWidth - rect.width - 8)
  }
  if (rect.bottom > window.innerHeight) {
    newY = Math.max(8, window.innerHeight - rect.height - 8)
  }

  pos.value = { x: newX, y: newY }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('mousedown', handleClickOutside)
})

onUnmounted(() => {
  if (closeTimer !== null) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('mousedown', handleClickOutside)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="fixed z-[150] w-72 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200/60 dark:border-gray-700/60 overflow-hidden"
      :class="{
        'animate-menu-enter': !isClosing,
        'animate-menu-exit': isClosing,
      }"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      @click.stop
    >
      <!-- 标题栏 -->
      <div
        class="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700/50"
      >
        <div class="flex items-center gap-2">
          <Icon name="pencil" :size="14" class="text-blue-500" />
          <span class="text-sm font-medium text-gray-900 dark:text-white">编辑元数据</span>
        </div>
        <button
          class="p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          @click="closePopup"
        >
          <Icon name="x" :size="14" />
        </button>
      </div>

      <!-- 表单 -->
      <div class="p-3 space-y-2.5">
        <div>
          <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">歌名</label>
          <input
            v-model="title"
            type="text"
            class="w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500/40 transition-all"
            placeholder="歌曲名"
          />
        </div>
        <div>
          <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">歌手</label>
          <input
            v-model="artist"
            type="text"
            class="w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500/40 transition-all"
            placeholder="艺术家"
          />
        </div>
        <div>
          <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">专辑</label>
          <input
            v-model="album"
            type="text"
            class="w-full px-2.5 py-1.5 text-sm bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500/40 transition-all"
            placeholder="专辑名"
          />
        </div>
      </div>

      <!-- 底部按钮 -->
      <div
        class="flex items-center justify-between px-3 py-2 border-t border-gray-100 dark:border-gray-700/50 bg-gray-50/50 dark:bg-gray-800/50"
      >
        <button
          class="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 rounded-md transition-colors"
          @click="resetToOriginal"
        >
          <Icon name="rotate-ccw" :size="12" />
          <span>重置</span>
        </button>
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 rounded-lg transition-colors"
            @click="closePopup"
          >
            取消
          </button>
          <button
            class="px-3 py-1.5 text-xs bg-blue-500 text-white hover:bg-blue-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!title.trim() || saving"
            @click="handleSave"
          >
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.animate-menu-enter {
  animation: menu-enter 0.12s ease-out;
}

.animate-menu-exit {
  animation: menu-exit 0.1s ease-in forwards;
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
