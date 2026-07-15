<script setup lang="ts">
/**
 * ScrollingText - 文本循环滚动组件
 *
 * 当文本宽度超过容器宽度时，横向循环滚动
 * 通过 ResizeObserver 监听尺寸变化，动态判断是否溢出
 * 根据文本长度动态调整滚动速度（每秒滚动固定像素）
 */
import { ref, onMounted, onBeforeUnmount, nextTick, watch, computed } from 'vue'

const props = withDefaults(
  defineProps<{
    text: string
    /** 滚动速度: 每秒滚动的像素数（默认 30px/s） */
    speed?: number
    /** 滚动周期 (秒) — 兼容旧版，优先使用 speed */
    duration?: number
    /** 字体 class (e.g. 'text-lg') */
    textClass?: string
  }>(),
  {
    speed: 30,
    duration: undefined,
  },
)

const containerRef = ref<HTMLElement | null>(null)
const measureRef = ref<HTMLElement | null>(null)
const isOverflow = ref(false)
const animKey = ref(0)
const textWidth = ref(0)

let observer: ResizeObserver | null = null

/** 根据文本宽度和速度计算滚动周期（秒） */
const computedDuration = computed(() => {
  // 如果显式传了 duration，优先使用（兼容旧版）
  if (props.duration !== undefined && props.duration > 0) {
    return props.duration
  }
  if (textWidth.value <= 0 || props.speed <= 0) return 15
  // 滚动距离是文本宽度的一半（因为有两份重复文本）
  return Math.max(8, textWidth.value / 2 / props.speed)
})

async function measure() {
  await nextTick()
  if (!containerRef.value || !measureRef.value) return

  const containerWidth = containerRef.value.clientWidth
  const w = measureRef.value.scrollWidth
  textWidth.value = w

  isOverflow.value = w > containerWidth + 1
  animKey.value++
}

onMounted(() => {
  measure()
  if (containerRef.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  if (observer) {
    observer.disconnect()
    observer = null
  }
})

watch(
  () => props.text,
  () => {
    measure()
  },
)
</script>

<template>
  <div ref="containerRef" class="scrolling-text relative overflow-hidden">
    <!-- 隐藏的测量元素（用于获取真实文本宽度） -->
    <span
      ref="measureRef"
      :class="textClass || 'text-lg'"
      class="invisible absolute top-0 left-0 whitespace-nowrap pointer-events-none"
      aria-hidden="true"
    >
      {{ text }}
    </span>

    <!-- 静态显示: 文本不溢出时 -->
    <p
      v-if="!isOverflow"
      :class="textClass || 'text-lg'"
      class="text-gray-600 dark:text-gray-400 truncate"
    >
      {{ text }}
    </p>

    <!-- 动态滚动: 文本溢出时, 两份内容无缝循环 -->
    <div
      v-else
      class="relative whitespace-nowrap"
      :key="animKey"
    >
      <div
        class="flex w-max scrolling-track"
        :style="{ animationDuration: `${computedDuration}s` }"
      >
        <span :class="textClass || 'text-lg'" class="text-gray-600 dark:text-gray-400 pr-12 shrink-0">
          {{ text }}
        </span>
        <span :class="textClass || 'text-lg'" class="text-gray-600 dark:text-gray-400 pr-12 shrink-0">
          {{ text }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrolling-text {
  min-width: 0;
}

.scrolling-track {
  animation: scroll-left linear infinite;
  will-change: transform;
}

@keyframes scroll-left {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
</style>
