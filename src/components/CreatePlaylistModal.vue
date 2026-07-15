<script setup lang="ts">
import { useUIStore } from '@/stores/uiStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'

const ui = useUIStore()
const library = useLibraryStore()
const inputRef = ref<HTMLInputElement | null>(null)
const playlistName = ref('')
const isClosing = ref(false)

async function handleSubmit() {
  const name = playlistName.value.trim()
  if (name) {
    try {
      const newPlaylist = await library.createPlaylist(name)
      if (ui.createPlaylistAddSongId) {
        await library.addSongToPlaylist(ui.createPlaylistAddSongId, newPlaylist.id)
      }
      closeModal()
    } catch (error) {
      console.error('创建歌单失败:', error)
    }
  }
}

function closeModal() {
  isClosing.value = true
  setTimeout(() => {
    ui.closeCreatePlaylistModal()
    playlistName.value = ''
    isClosing.value = false
  }, 150)
}

function handleOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    closeModal()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeModal()
  }
}

watch(
  () => ui.showCreatePlaylistModal,
  (visible) => {
    if (visible) {
      isClosing.value = false
      nextTick(() => {
        inputRef.value?.focus()
      })
    }
  }
)

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.showCreatePlaylistModal"
      class="fixed inset-0 z-[200] flex items-center justify-center"
      :class="{ 'animate-fade-in': !isClosing, 'animate-fade-out': isClosing }"
      @click="handleOverlayClick"
    >
      <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]"></div>

      <div
        class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-72 overflow-hidden"
        :class="{ 'animate-scale-in': !isClosing, 'animate-scale-out': isClosing }"
        @click.stop
      >
        <div class="p-4 space-y-3">
          <h3 class="text-gray-900 dark:text-white text-sm font-semibold">新建歌单</h3>

          <input
            ref="inputRef"
            v-model="playlistName"
            type="text"
            placeholder="歌单名称"
            maxlength="30"
            class="w-full px-3 py-2 bg-gray-100/70 dark:bg-gray-700/50 border border-gray-200/50 dark:border-gray-600/50 rounded-lg text-gray-900 dark:text-white text-sm placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500/40 transition-all"
            @keyup.enter="handleSubmit"
          />

          <div class="flex gap-2">
            <button
              class="flex-1 px-3 py-2 bg-gray-100 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              @click="closeModal"
            >
              取消
            </button>
            <button
              class="flex-1 px-3 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="!playlistName.trim()"
              @click="handleSubmit"
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.animate-fade-in {
  animation: fade-in 0.15s ease-out;
}

.animate-fade-out {
  animation: fade-out 0.15s ease-in forwards;
}

.animate-scale-in {
  animation: scale-in 0.18s ease-out;
}

.animate-scale-out {
  animation: scale-out 0.15s ease-in forwards;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes scale-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes scale-out {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.96);
  }
}
</style>
