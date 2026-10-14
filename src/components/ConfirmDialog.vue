<script setup lang="ts">
import { useUIStore } from '@/stores/uiStore'
import { ref, watch, onMounted, onUnmounted } from 'vue'

const ui = useUIStore()
const isClosing = ref(false)

function handleConfirm() {
  if (ui.confirmDialog.onConfirm) {
    ui.confirmDialog.onConfirm()
  }
  closeDialog()
}

function closeDialog() {
  isClosing.value = true
  setTimeout(() => {
    ui.closeConfirmDialog()
    isClosing.value = false
  }, 150)
}

function handleOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    closeDialog()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeDialog()
  }
  if (e.key === 'Enter') {
    handleConfirm()
  }
}

watch(
  () => ui.confirmDialog.visible,
  (visible) => {
    if (visible) {
      isClosing.value = false
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
      v-if="ui.confirmDialog.visible"
      class="fixed inset-0 z-[200] flex items-center justify-center"
      :class="{ 'animate-fade-in': !isClosing, 'animate-fade-out': isClosing }"
      @click="handleOverlayClick"
    >
      <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]"></div>

      <div
        class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-80 overflow-hidden"
        :class="{ 'animate-scale-in': !isClosing, 'animate-scale-out': isClosing }"
        @click.stop
      >
        <div class="p-5 space-y-4">
          <h3 class="text-gray-900 dark:text-white text-base font-semibold">
            {{ ui.confirmDialog.title }}
          </h3>

          <p class="text-gray-600 dark:text-gray-400 text-sm leading-relaxed whitespace-pre-line">
            {{ ui.confirmDialog.message }}
          </p>

          <div class="flex gap-2 pt-1">
            <button
              class="flex-1 px-3 py-2 bg-gray-100 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              @click="closeDialog"
            >
              {{ ui.confirmDialog.cancelText || '取消' }}
            </button>
            <button
              class="flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              :class="{
                'bg-red-500 text-white hover:bg-red-600': ui.confirmDialog.type === 'danger',
                'bg-blue-500 text-white hover:bg-blue-600': ui.confirmDialog.type !== 'danger',
              }"
              @click="handleConfirm"
            >
              {{ ui.confirmDialog.confirmText || '确定' }}
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
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fade-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
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
