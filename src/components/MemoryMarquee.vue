<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useMemoryStore } from '@/stores/memoryStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useAudioStore } from '@/stores/audioStore'

const memory = useMemoryStore()
const settings = useSettingsStore()
const audio = useAudioStore()

// 暂停滚动: 音乐暂停时停止，播放时滚动
const isPaused = computed(() => !audio.isPlaying)

// 鼠标悬停状态
const isHovered = ref(false)

// ========== 数据源 ==========
// 限制最多显示 30 个标签, 减少 DOM 节点
const MAX_TAGS = 30
const tags = computed(() => {
  const t = memory.currentShortTags
  if (t.length <= MAX_TAGS) return t
  // 超出时随机选取 MAX_TAGS 个
  const shuffled = [...t].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, MAX_TAGS)
})

// 6 行轮询分配，每条标签仅出现一次
const ROWS = 6
const LINE_HEIGHT = 18 // px

// 每行的标签列表
const rows = computed(() => {
  const t = tags.value
  if (t.length === 0) return []
  const result: string[][] = Array.from({ length: ROWS }, () => [])
  t.forEach((tag, i) => {
    result[i % ROWS].push(tag)
  })
  return result
})

// 每行的动画速度 (秒): 基础 20s + 错落
const rowDurations = computed(() => {
  return Array.from({ length: ROWS }, (_, i) => {
    return 18 + (i % 3) * 4
  })
})

// 每行的动画延迟 (秒): 错开出发时间
const rowDelays = computed(() => {
  return Array.from({ length: ROWS }, (_, i) => {
    return -(i * 2.5)
  })
})

// 切歌后刷新动画
const animKey = ref(0)
function refresh() {
  animKey.value++
}

/*
  标签内容变化后重启动画（refresh() 的注释一直写着"切歌后刷新动画"，
  但此前只在 onMounted 调过一次，切歌时新标签会直接出现在滚动途中原地替换）。
  监听的是拼接后的字符串而不是数组本身：saveMemory 回执会重新赋值 currentMemory，
  但标签内容没变，此时不该重启弹幕。
*/
watch(
  () => tags.value.join('\u0000'),
  () => refresh()
)

onMounted(() => {
  refresh()
})

onBeforeUnmount(() => {
  // noop
})
</script>

<template>
  <div
    class="memory-marquee relative w-96 mx-auto overflow-hidden pointer-events-none"
    :style="{ minHeight: `${ROWS * LINE_HEIGHT}px` }"
  >
    <template v-if="settings.showMemoryTags && tags.length > 0">
      <!-- 鼠标悬停热区 -->
      <div
        class="absolute inset-0 pointer-events-auto cursor-default"
        @mouseenter="isHovered = true"
        @mouseleave="isHovered = false"
      ></div>

      <!-- 多行弹幕 -->
      <div :key="animKey" class="marquee-container">
        <div
          v-for="(row, rowIdx) in rows"
          :key="`row-${rowIdx}`"
          class="marquee-row"
          :style="{ height: `${LINE_HEIGHT}px` }"
        >
          <div
            v-if="row.length > 0"
            class="marquee-track"
            :style="{
              animationDuration: `${rowDurations[rowIdx]}s`,
              animationDelay: `${rowDelays[rowIdx]}s`,
            }"
            :class="{ 'is-paused': isPaused || isHovered }"
          >
            <span
              v-for="(tag, i) in row"
              :key="`${rowIdx}-${i}-${tag}`"
              class="memory-tag inline-block mr-16 px-2 py-0.5 rounded-full text-[11px] whitespace-nowrap bg-white/70 dark:bg-black/55 text-gray-700 dark:text-gray-200 border border-white/30 dark:border-white/10"
            >
              {{ tag }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.memory-marquee {
  opacity: 0.55;
  transition: opacity 0.25s ease;
  /*
    布局/绘制隔离：6 行弹幕的位移不再有机会让祖先元素重新布局，
    容器尺寸也完全由自身决定（min-height 由模板给出）。
  */
  contain: layout paint;
}

.marquee-container {
  position: relative;
  width: 100%;
  height: 100%;
}

.marquee-row {
  position: relative;
  width: 100%;
  overflow: hidden;
}

/*
  注意：标签上不再使用 backdrop-blur。
  这里最多 30 个标签、6 条轨道同时无限位移，每帧都要重新采样并模糊其背后的
  像素（背后还是全屏渐变 + 经过 blur() 的背景图），是播放页最贵的一处开销。
  改用略微提高不透明度的底色，视觉差异极小，但把整条弹幕降级成纯合成动画。
*/
.marquee-track {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  left: 100%;
  white-space: nowrap;
  animation-name: marquee-slide;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}

.marquee-track.is-paused {
  animation-play-state: paused;
}

@keyframes marquee-slide {
  0% {
    transform: translateY(-50%) translateX(0);
  }
  100% {
    transform: translateY(-50%) translateX(calc(-100% - 384px));
  }
}

@media (prefers-reduced-motion: reduce) {
  .marquee-track {
    animation: none;
  }
}
</style>
