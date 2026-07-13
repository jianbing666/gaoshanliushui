<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'

const player = usePlayerStore()

// 频谱数据数组（64个条形）
const spectrumData = ref<number[]>(Array(64).fill(0))

// requestAnimationFrame 的 ID
let animationId: number | null = null

// 上一次采样时间（用于控制采样频率）
let lastSampleTime = 0

// 复用的频域数据数组（避免每次创建新的 Uint8Array）
let dataArray: Uint8Array<ArrayBuffer> | null = null

// 计算采样间隔（30fps = 33ms，低功耗模式 20fps = 50ms）
const sampleInterval = computed(() => player.spectrumLowPower ? 50 : 33)

// 计算 fftSize（低功耗模式 1024，正常模式 2048）
const fftSize = computed(() => player.spectrumLowPower ? 1024 : 2048)

// 计算当前实际主题（用于频谱条形颜色）
const actualTheme = computed(() => {
  if (player.theme === 'system') {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  }
  return player.theme
})

// 频谱条形颜色（浅色模式 blue-500，深色模式 blue-400）
const spectrumBarColor = computed(() => actualTheme.value === 'dark' ? '#60a5fa' : '#3b82f6')

// 启动频谱动画循环
function startSpectrumAnimation() {
  const analyserNode = player.getAnalyserNode()

  if (!analyserNode) {
    console.warn('[AudioSpectrum] 无法启动动画：AnalyserNode 未初始化')
    return
  }

  // 更新 fftSize（如果切换了低功耗模式）
  if (analyserNode.fftSize !== fftSize.value) {
    analyserNode.fftSize = fftSize.value
  }

  console.log('[AudioSpectrum] 启动频谱动画', {
    fftSize: analyserNode.fftSize
  })

  // 开始采样循环
  animationLoop()
}

// 采样循环函数
function animationLoop() {
  const analyserNode = player.getAnalyserNode()

  animationId = requestAnimationFrame((timestamp) => {
    if (!analyserNode) return

    // 控制采样频率：仅在达到间隔时间时采样
    if (timestamp - lastSampleTime >= sampleInterval.value) {
      lastSampleTime = timestamp

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

      // 每隔 1 秒输出一次频谱数据样本（用于调试）
      if (timestamp % 1000 < 50) {
        const avgValue = newSpectrumData.reduce((a, b) => a + b, 0) / newSpectrumData.length
        const maxRawValue = Math.max(...dataArray)

        console.log('[AudioSpectrum] 频谱数据样本:', {
          平均高度: avgValue.toFixed(2) + '%',
          最大高度: Math.max(...newSpectrumData).toFixed(2) + '%',
          原始最大值: maxRawValue,
          第一个值: dataArray[0]
        })
      }

      spectrumData.value = newSpectrumData
    }

    // 继续循环（仅在播放状态下）
    if (player.isPlaying) {
      animationLoop()
    }
  })
}

// 停止频谱动画
function stopSpectrumAnimation() {
  if (animationId !== null) {
    cancelAnimationFrame(animationId)
    animationId = null
  }

  // 重置频谱数据为 0
  spectrumData.value = Array(64).fill(0)
}

// 监听播放状态变化
watch(
  () => player.isPlaying,
  (playing) => {
    if (playing && player.showSpectrum) {
      startSpectrumAnimation()
    } else {
      stopSpectrumAnimation()
    }
  }
)

// 监听显示频谱开关变化
watch(
  () => player.showSpectrum,
  (show) => {
    if (show && player.isPlaying) {
      startSpectrumAnimation()
    } else {
      stopSpectrumAnimation()
    }
  }
)

// 监听低功耗模式变化
watch(
  () => player.spectrumLowPower,
  () => {
    const analyserNode = player.getAnalyserNode()
    if (analyserNode && player.isPlaying && player.showSpectrum) {
      analyserNode.fftSize = fftSize.value
    }
  }
)

// 监听切歌（currentSong 变化）
watch(
  () => player.currentSong,
  () => {
    spectrumData.value = Array(64).fill(0)
  }
)

onMounted(() => {
  if (player.isPlaying && player.showSpectrum) {
    startSpectrumAnimation()
  }
})

onUnmounted(() => {
  stopSpectrumAnimation()
})
</script>

<template>
  <div
    v-if="player.showSpectrum"
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
