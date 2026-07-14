<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useAudioStore } from '@/stores/audioStore'

interface Props {
  visible: boolean
  position: { x: number; y: number }
}

defineProps<Props>()
const emit = defineEmits<{
  close: []
  mouseEnter: []
  mouseLeave: []
}>()

const player = useAudioStore()
const sliderRef = ref<HTMLElement | null>(null)
const isDragging = ref(false)
let startVolume = 0
let startY = 0

const volumePercent = computed(() => Math.round(player.volume * 100))
const sliderHeight = computed(() => `${player.volume * 100}%`)

function handleMouseDown(e: MouseEvent) {
  e.preventDefault()
  isDragging.value = true
  startVolume = player.volume
  startY = e.clientY
  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', handleMouseUp)
}

function handleMouseMove(e: MouseEvent) {
  if (!isDragging.value || !sliderRef.value) return

  const rect = sliderRef.value.getBoundingClientRect()
  const trackHeight = rect.height
  const deltaY = startY - e.clientY
  let newVolume = startVolume + (deltaY / trackHeight)
  newVolume = Math.max(0, Math.min(1, newVolume))
  player.volume = newVolume
}

function handleMouseUp() {
  isDragging.value = false
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', handleMouseUp)
}

function handleTrackClick(e: MouseEvent) {
  if (!sliderRef.value) return
  const rect = sliderRef.value.getBoundingClientRect()
  const clickY = e.clientY - rect.top
  const newVolume = 1 - clickY / rect.height
  player.volume = Math.max(0, Math.min(1, newVolume))
}

function handleMouseEnter() {
  emit('mouseEnter')
}

function handleMouseLeave() {
  emit('mouseLeave')
}

onMounted(() => {
  document.addEventListener('selectstart', (e) => {
    if (isDragging.value) e.preventDefault()
  })
})

onUnmounted(() => {
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', handleMouseUp)
})
</script>

<template>
  <teleport to="body">
    <div
      v-if="visible"
      class="fixed z-50 bg-black/30 dark:bg-black/50 backdrop-blur-lg rounded-lg p-3 shadow-xl border border-white/10 dark:border-gray-700/50"
      :style="{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transform: 'translateX(-50%) translateY(-100%)',
      }"
      @mouseenter="handleMouseEnter"
      @mouseleave="handleMouseLeave"
    >
      <div class="text-center mb-2">
        <span class="text-white text-sm font-medium">{{ volumePercent }}%</span>
      </div>

      <div
        ref="sliderRef"
        class="relative w-8 h-32 flex items-end justify-center cursor-pointer select-none"
        @click="handleTrackClick"
        @mousedown="handleMouseDown"
      >
        <div class="w-2 h-full bg-gray-300/30 dark:bg-gray-600/30 rounded-full relative overflow-hidden">
          <div
            class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-pink-400 to-pink-300 rounded-full transition-all duration-100"
            :class="{ 'transition-none': isDragging }"
            :style="{ height: sliderHeight }"
          ></div>
        </div>

        <div
          class="absolute w-4 h-4 bg-pink-400 rounded-full shadow-lg border-2 border-white transition-all duration-100 hover:scale-110"
          :class="{ 'transition-none scale-110': isDragging }"
          :style="{ bottom: `${volumePercent}%`, transform: 'translateY(50%)' }"
        ></div>
      </div>
    </div>
  </teleport>
</template>
