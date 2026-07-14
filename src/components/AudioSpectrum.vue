<script setup lang="ts">
import { useAudioStore } from '@/stores/audioStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'

const audio = useAudioStore()
const settings = useSettingsStore()

// 频谱数据数组（64个条形）
const spectrumData = ref<number[]>(Array(64).fill(0))

// setTimeout 的 ID（用于 30fps 帧率限制）
let animationTimer: number | null = null

// 复用的频域数据数组（避免每次创建新的 Uint8Array）
let dataArray: Uint8Array<ArrayBuffer> | null = null

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
const spectrumBarColor = computed(() => actualTheme.value === 'dark' ? '#60a5fa' : '#3b82f6')

// 频谱动画是否应该运行
const shouldRun = computed(() =>
  audio.isPlaying && settings.showSpectrum && !settings.spectrumPaused
)

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

  // 提取 64 个关键频率点（均匀采样）
  const step = Math.floor(bufferLength / 64)
  const newSpectrumData: number[] = []
  for (let i = 0; i < 64; i++) {
    const index = i * step
    const value = dataArray[index] || 0
    // 转换为高度百分比（增强视觉效果）
    const normalizedValue = Math.max(10, (value / 255) * 100)
    newSpectrumData.push(normalizedValue)
  }

  spectrumData.value = newSpectrumData
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

  // 重置频谱数据为 0
  spectrumData.value = Array(64).fill(0)
}

// 监听是否应该运行动画
watch(
  shouldRun,
  (running) => {
    if (running) {
      startSpectrumAnimation()
    } else {
      stopSpectrumAnimation()
    }
  }
)

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

// 监听切歌（currentSong 变化）
watch(
  () => audio.currentSong,
  () => {
    spectrumData.value = Array(64).fill(0)
  }
)

onMounted(() => {
  if (shouldRun.value) {
    startSpectrumAnimation()
  }
})

onUnmounted(() => {
  stopSpectrumAnimation()
})
</script>

<template>
  <div
    v-if="settings.showSpectrum"
    class="w-[300px] h-[40px] flex items-end justify-center gap-[2px] mx-auto mt-4"
  >
    <div
      v-for="(height, index) in spectrumData"
      :key="index"
      class="w-[4px] rounded-[2px] transition-all duration-100"
      :style="{
        height: `${height}%`,
        backgroundColor: spectrumBarColor
      }"
    ></div>
  </div>
</template>
