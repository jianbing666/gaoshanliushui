<script setup lang="ts">
import { computed } from 'vue'
import { usePlayerStore } from '@/stores/playerStore'

interface Props {
  visible: boolean
  position: { x: number; y: number }
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  mouseEnter: []
  mouseLeave: []
}>()

const player = usePlayerStore()

// 音量百分比显示
const volumePercent = computed(() => Math.round(player.volume * 100))

// 音量滑块样式（高度随音量变化）
const sliderHeight = computed(() => `${player.volume * 100}%`)

// 处理音量变化
function handleVolumeChange(event: Event) {
  const target = event.target as HTMLInputElement
  const newVolume = parseFloat(target.value)
  player.volume = newVolume
}

// 处理滑块点击（阻止事件冒泡）
function handleSliderClick(event: MouseEvent) {
  event.stopPropagation()
}

// 处理容器点击（关闭悬浮框）
function handleContainerClick() {
  emit('close')
}

// 鼠标事件处理
function handleMouseEnter() {
  emit('mouseEnter')
}

function handleMouseLeave() {
  emit('mouseLeave')
}
</script>

<template>
  <teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-50 flex items-center justify-center"
      @click="handleContainerClick"
    >
      <!-- 悬浮音量控制条 -->
      <div
        class="absolute bg-black/30 dark:bg-black/50 backdrop-blur-lg rounded-lg p-2 shadow-xl border border-white/10 dark:border-gray-700/50"
        :style="{ left: `${position.x}px`, top: `${position.y}px`, transform: 'translateX(-50%) translateY(-100%)' }"
        @click.stop
        @mouseenter="handleMouseEnter"
        @mouseleave="handleMouseLeave"
      >
        <!-- 音量百分比显示 -->
        <div class="text-center mb-2">
          <span class="text-white text-sm font-medium">{{ volumePercent }}%</span>
        </div>

        <!-- 垂直滑块容器 -->
        <div class="relative w-8 h-32 flex items-end justify-center" @click="handleSliderClick">
          <!-- 滑块轨道 -->
          <div class="w-2 h-full bg-gray-300/30 dark:bg-gray-600/30 rounded-full relative overflow-hidden">
            <!-- 滑块填充部分（粉色调） -->
            <div
              class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-pink-400 to-pink-300 rounded-full transition-all duration-100"
              :style="{ height: sliderHeight }"
            ></div>
          </div>

          <!-- 垂直滑块 -->
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="player.volume"
            class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            orient="vertical"
            style="writing-mode: bt-lr; -webkit-appearance: slider-vertical;"
            @input="handleVolumeChange"
            @click.stop
          />

          <!-- 滑块把手（圆形，粉色调） -->
          <div
            class="absolute w-4 h-4 bg-pink-400 rounded-full shadow-lg border-2 border-white transition-all duration-100"
            :style="{ bottom: `${volumePercent}%`, transform: 'translateY(50%)' }"
          ></div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
/* 确保垂直滑块可以正常工作 */
input[type="range"][orient="vertical"] {
  writing-mode: bt-lr;
  -webkit-appearance: slider-vertical;
  width: 100%;
  height: 100%;
}
</style>