<script setup lang="ts">
// Memory feature - 高山流水 v1.1: 弹幕式 tag 展示 (多行版)
// - 位于播放界面专辑封面/唱片上方
// - 多行 (6 行) tag 错落分布, 每条标签仅出现一次 (跨行随机分布)
// - 从右向左穿过式滚动, 标签从右侧进入, 左侧出去, 期间只出现一次
// - 鼠标悬停: 暂停滚动 + 完全不透明
// - BUG 1 第三次修复: 从"无缝循环(2份内容)"改为"穿过式弹幕"
//   - 根本原因: 2份内容 + 短标签总宽 < 容器宽 → 同屏看到重复标签
//   - 新方案: 每行一条轨道, 标签从右进左出, 每条标签仅出现一次
//   - 多行速度/延迟错落, 形成自然弹幕流
// - 性能: 纯 CSS animation, 不占主线程

import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useMemoryStore } from '@/stores/memoryStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'

const memory = useMemoryStore()
const ui = useUIStore()
const settings = useSettingsStore()

// 暂停滚动: 抽屉打开 / 窗口隐藏 / 暂停显示
const isPaused = computed(
  () => ui.showMemoryDrawer || settings.spectrumPaused,
)

// 鼠标悬停状态
const isHovered = ref(false)

// 背景图存在性: 背景图场景下渐变遮罩需透明, 无背景图场景下保持柔和淡出
const hasBackground = computed(() => !!settings.currentBackgroundUrl)

// ========== 数据源 ==========
const tags = computed(() => memory.currentShortTags)

// BUG 1 修复: 6 行, 每条标签仅出现一次
//   轮询分配: tag[0] → row[0], tag[1] → row[1], ... tag[5] → row[5], tag[6] → row[0]
//   每行有 ceil(N/6) ~ floor(N/6) 个标签, 总量 = N
const ROWS = 6
const LINE_HEIGHT = 18 // px

// 每行的标签列表 (按行索引)
const rows = computed(() => {
  const t = tags.value
  if (t.length === 0) return []
  const result: string[][] = Array.from({ length: ROWS }, () => [])
  t.forEach((tag, i) => {
    result[i % ROWS].push(tag)
  })
  return result
})

// 每行速度 (秒): 基础 15s + 错落, 让标签以不同速度飘过
const rowSpeeds = computed(() => {
  return Array.from({ length: ROWS }, (_, i) => {
    // 基础 12s, 每行 +2s 错落
    return 12 + (i % 3) * 2
  })
})

// 每行初始延迟 (秒): 错开出发时间, 避免齐刷刷一排
const rowDelays = computed(() => {
  return Array.from({ length: ROWS }, (_, i) => {
    // 每行错开 0.8s, 负延迟表示提前开始 (动画已经在进行中)
    return -(i * 0.8)
  })
})

// 切歌后刷新, 触发重渲染
const animKey = ref(0)
function refresh() {
  animKey.value++
}

onMounted(() => {
  refresh()
})

onBeforeUnmount(() => {
  // noop
})
</script>

<template>
  <!--
    容器: w-96 (384px), 6 行 × 18px = 108px
    z-index: 10 (高于唱片默认 0, 低于 ControlBar / 抽屉)
  -->
  <div
    v-if="settings.showMemoryTags && tags.length > 0"
    class="memory-marquee relative w-96 mx-auto overflow-hidden pointer-events-none"
    :style="{ height: `${ROWS * LINE_HEIGHT}px` }"
    :class="{ 'is-paused': isPaused || isHovered }"
    :key="animKey"
  >
    <!-- 左侧/右侧淡出渐变
         背景图场景: 用透明色作为起点, 避免出现明显方块/硬边界
         无背景图场景: 用白/深灰色作为起点, 营造柔和淡出效果
    -->
    <div
      v-if="hasBackground"
      class="absolute inset-y-0 left-0 w-8 z-10 pointer-events-none bg-gradient-to-r from-transparent to-transparent"
    ></div>
    <div
      v-else
      class="absolute inset-y-0 left-0 w-8 z-10 pointer-events-none bg-gradient-to-r from-white dark:from-gray-900 to-transparent"
    ></div>
    <div
      v-if="hasBackground"
      class="absolute inset-y-0 right-0 w-8 z-10 pointer-events-none bg-gradient-to-l from-transparent to-transparent"
    ></div>
    <div
      v-else
      class="absolute inset-y-0 right-0 w-8 z-10 pointer-events-none bg-gradient-to-l from-white dark:from-gray-900 to-transparent"
    ></div>

    <!-- 鼠标悬停热区 -->
    <div
      class="absolute inset-0 pointer-events-auto cursor-default"
      @mouseenter="isHovered = true"
      @mouseleave="isHovered = false"
    ></div>

    <!-- 多行弹幕: 每行独立轨道, 标签从右往左穿过 -->
    <div
      v-for="(row, rowIdx) in rows"
      :key="`row-${rowIdx}`"
      class="marquee-row"
      :style="{ height: `${LINE_HEIGHT}px` }"
    >
      <div
        v-if="row.length > 0"
        class="marquee-track flex items-center h-full"
        :style="{
          animationDuration: `${rowSpeeds[rowIdx]}s`,
          animationDelay: `${rowDelays[rowIdx]}s`,
        }"
        :class="{ 'is-paused': isPaused || isHovered }"
      >
        <!-- 单行内的多个标签, 用间距隔开 -->
        <span
          v-for="(tag, i) in row"
          :key="`${rowIdx}-${i}-${tag}`"
          class="memory-tag shrink-0 mr-16 px-2 py-0.5 rounded-full text-[11px] whitespace-nowrap bg-white/40 dark:bg-black/40 backdrop-blur text-gray-700 dark:text-gray-200 border border-white/30 dark:border-white/10"
        >
          {{ tag }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-marquee {
  opacity: 0.55;
  transition: opacity 0.25s ease;
}
.memory-marquee.is-paused {
  opacity: 1;
}

.marquee-row {
  position: relative;
  width: 100%;
  overflow: hidden;
}

.marquee-track {
  position: absolute;
  left: 0;
  top: 0;
  /* 从容器右侧外 (384px) 移动到自身完全移出左侧 (-100%) */
  animation-name: marquee-pass;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}
.marquee-track.is-paused {
  animation-play-state: paused;
}

@keyframes marquee-pass {
  0% {
    transform: translateX(384px);
  }
  100% {
    transform: translateX(-100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .marquee-track {
    animation: none;
  }
}
</style>
