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
  let newVolume = startVolume + deltaY / trackHeight
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
        <div
          class="w-2 h-full bg-gray-300/30 dark:bg-gray-600/30 rounded-full relative overflow-hidden"
        >
          <!--
            填充条改用 scaleY（transform-origin 在底部）而不再是 height：
            拖动时每一帧都改 height 会持续触发布局，scaleY 只走合成。
            圆角交给父级 overflow-hidden 负责，避免缩放把圆头压扁。
          -->
          <div
            class="volume-fill absolute inset-0 bg-gradient-to-t from-pink-400 to-pink-300"
            :class="{ 'is-dragging': isDragging }"
            :style="{ transform: `scaleY(${player.volume})` }"
          ></div>
        </div>

        <!--
          滑块仍以 bottom 定位（绝对定位，代价很低），但把 translateY(50%) 从内联
          样式挪进 CSS —— 原来的内联 transform 直接覆盖掉了 Tailwind 的
          hover:scale-110 / scale-110，导致悬停与拖动放大实际上都没生效。
        -->
        <div
          class="volume-thumb absolute w-4 h-4 bg-pink-400 rounded-full shadow-lg border-2 border-white"
          :class="{ 'is-dragging': isDragging }"
          :style="{ bottom: `${volumePercent}%` }"
        ></div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.volume-fill {
  transition: transform 100ms linear;
  transform-origin: bottom;
}

.volume-thumb {
  transform: translateY(50%);
  transition:
    bottom 100ms linear,
    transform 120ms ease-out;
}

.volume-thumb:hover,
.volume-thumb.is-dragging {
  transform: translateY(50%) scale(1.15);
}

/* 拖动中不做补间，指针位置即音量，避免 100ms 的跟手延迟 */
.volume-fill.is-dragging,
.volume-thumb.is-dragging {
  transition: none;
}
</style>
