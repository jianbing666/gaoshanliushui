<script setup lang="ts">
import { useAudioStore } from '@/stores/audioStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { ref, onMounted, onUnmounted, watch, computed, nextTick } from 'vue'

const audio = useAudioStore()
const settings = useSettingsStore()

// 频谱条形数量（与模板 v-for 保持一致）
const BAR_COUNT = 64
// 条形最小视觉比例（等价于旧实现里的 height: 10%）
const MIN_SCALE = 0.1

/*
  性能要点（本轮改造）：
  旧实现把 64 个条形的高度写成 `:style="{ height: x% }"` 并配 `transition-all`。
  high 档 sampleInterval = 16ms，也就是每帧都在改 height —— 每帧 64 次
  布局 + 绘制，且每次都要走一遍 Vue 的 patch 更新 64 个内联样式。
  现在改为：
    1. 只改 transform: scaleY()（只走合成/绘制，完全跳过布局）；
    2. 采样循环直接把值写到 DOM，绕开响应式与 vdom，不再每帧 patch 组件。
*/
const containerRef = ref<HTMLElement | null>(null)

// setTimeout 的 ID（用于按质量档位限制帧率）
let animationTimer: number | null = null

// 复用的频域数据数组（避免每次创建新的 Uint8Array）
let dataArray: Uint8Array<ArrayBuffer> | null = null

// 条形 DOM 引用与当前比例（复用数组，避免每帧分配）
let barEls: HTMLElement[] = []
const barScales = new Array<number>(BAR_COUNT).fill(MIN_SCALE)

// 频谱参数直接来自 store 中按"质量档位"计算好的值, 此处只读
const sampleInterval = computed(() => settings.spectrumSampleInterval)
const fftSize = computed(() => settings.spectrumFftSize)
const smoothing = computed(() => settings.spectrumSmoothing)

// 计算当前实际主题（用于频谱条形颜色）
const actualTheme = computed(() => {
  if (settings.theme === 'system') {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  }
  return settings.theme
})

// 频谱条形颜色（浅色模式 blue-500，深色模式 blue-400）
const spectrumBarColor = computed(() => (actualTheme.value === 'dark' ? '#60a5fa' : '#3b82f6'))

// 频谱动画是否应该运行
const shouldRun = computed(
  () => audio.isPlaying && settings.showSpectrum && !settings.spectrumPaused
)

// 缓存条形 DOM（v-if 切换后需要重新采集）
function collectBars() {
  const el = containerRef.value
  barEls = el ? (Array.from(el.children) as HTMLElement[]) : []
}

// 把当前比例写回 DOM（唯一的 DOM 写入点）
function applyScales() {
  for (let i = 0; i < barEls.length; i++) {
    barEls[i].style.transform = `scaleY(${barScales[i]})`
  }
}

// 归零（停止 / 切歌时）
function resetBars() {
  barScales.fill(MIN_SCALE)
  applyScales()
}

// 单次采样函数
function sampleSpectrum() {
  const analyserNode = audio.getAnalyserNode()
  if (!analyserNode) return

  // 获取频域数据（复用数组，避免频繁分配内存）
  const bufferLength = analyserNode.frequencyBinCount
  if (!dataArray || dataArray.length !== bufferLength) {
    dataArray = new Uint8Array(bufferLength)
  }
  analyserNode.getByteFrequencyData(dataArray)

  // 提取 BAR_COUNT 个关键频率点（均匀采样）
  const step = Math.max(1, Math.floor(bufferLength / BAR_COUNT))
  for (let i = 0; i < BAR_COUNT; i++) {
    const value = dataArray[i * step] || 0
    barScales[i] = Math.max(MIN_SCALE, value / 255)
  }
  applyScales()
}

// 启动频谱动画循环（使用 setTimeout 控制帧率）
function startSpectrumAnimation() {
  const analyserNode = audio.getAnalyserNode()

  if (!analyserNode) return

  // 更新 fftSize（如果切换了低功耗模式）
  if (analyserNode.fftSize !== fftSize.value) {
    analyserNode.fftSize = fftSize.value
  }

  // 阶段 2.7: smoothingTimeConstant 跟随频谱质量档位
  //   high     0.8: 视觉平滑, 减少高频抖动
  //   balanced 0.75: 平滑与响应兼顾
  //   low      0.5:  更快的频谱响应
  if (analyserNode.smoothingTimeConstant !== smoothing.value) {
    analyserNode.smoothingTimeConstant = smoothing.value
  }

  // 条形可能还没采集（首次挂载 / v-if 重新挂载）
  if (barEls.length === 0) {
    collectBars()
  }

  // 停止之前的定时器
  stopSpectrumAnimation()

  // 开始采样循环
  function loop() {
    sampleSpectrum()
    animationTimer = window.setTimeout(loop, sampleInterval.value)
  }
  loop()
}

// 停止频谱动画
function stopSpectrumAnimation() {
  if (animationTimer !== null) {
    clearTimeout(animationTimer)
    animationTimer = null
  }

  // 重置频谱数据
  resetBars()
}

// 监听是否应该运行动画
watch(shouldRun, (running) => {
  if (running) {
    startSpectrumAnimation()
  } else {
    stopSpectrumAnimation()
  }
})

// 监听频谱质量档位变化（影响采样间隔、fftSize、平滑系数）
watch(
  () => settings.spectrumQuality,
  () => {
    const analyserNode = audio.getAnalyserNode()
    if (analyserNode && shouldRun.value) {
      analyserNode.fftSize = fftSize.value
      // 重启动画以应用新的采样间隔
      startSpectrumAnimation()
    }
  }
)

// 监听切歌（用 currentTrackKey = 曲目身份，而不是 currentSong 对象引用）
// 原因：收藏 / 编辑元数据会生成"同 id 的新对象"，按引用监听的话
// 点一次「喜欢」就会把频谱清空一次（对象换了，歌其实没换）。
watch(
  () => audio.currentTrackKey,
  () => {
    resetBars()
  }
)

// 频谱显隐切换后需要重新采集 DOM（v-if 会重建全部条形）
watch(
  () => settings.showSpectrum,
  async (visible) => {
    if (!visible) {
      barEls = []
      return
    }
    await nextTick()
    collectBars()
    resetBars()
    if (shouldRun.value) {
      startSpectrumAnimation()
    }
  }
)

onMounted(async () => {
  await nextTick()
  collectBars()
  resetBars()
  if (shouldRun.value) {
    startSpectrumAnimation()
  }
})

onUnmounted(() => {
  stopSpectrumAnimation()
  barEls = []
})
</script>

<template>
  <div
    v-if="settings.showSpectrum"
    ref="containerRef"
    class="spectrum-bars w-[300px] h-[40px] flex items-end justify-center gap-[2px] mx-auto mt-4"
    :style="{ '--spectrum-color': spectrumBarColor }"
  >
    <div v-for="i in BAR_COUNT" :key="i" class="spectrum-bars__bar w-[4px] rounded-[2px]"></div>
  </div>
</template>

<style scoped>
/*
  条形固定为满高，视觉高度全部由 scaleY 提供（transform-origin 在底部）。
  这样每帧只走合成，不再触发布局 —— 旧实现每帧要重排 64 个 height。
  90ms 线性过渡在合成器上把 16~50ms 的采样间隔抹平，视觉上比"跳变"顺滑。
*/
.spectrum-bars__bar {
  height: 100%;
  background-color: var(--spectrum-color);
  transform: scaleY(0.1);
  transform-origin: bottom;
  transition: transform 90ms linear;
}
</style>
