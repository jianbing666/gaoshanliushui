<script setup lang="ts">
import { useAudioStore } from '@/stores/audioStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useSettingsStore } from '@/stores/settingsStore'
import AudioSpectrum from '@/components/AudioSpectrum.vue'

const audio = useAudioStore()
const library = useLibraryStore()
const settings = useSettingsStore()
</script>

<template>
  <div class="flex-1 flex items-center justify-center p-8">
    <template v-if="library.currentSong">
      <div class="text-center">
        <!-- 专辑封面（旋转动画） -->
        <!-- .paused 触发条件: 未播放 / 低功耗模式开启 / 窗口隐藏 / 迷你模式
             极致性能: 后 3 种场景下让 CPU/GPU 进入空闲, 避免空转 -->
        <div
          class="relative mx-auto w-64 h-64 rounded-full shadow-2xl overflow-hidden cover-rotating"
          :class="{ 'paused': !audio.isPlaying || settings.spectrumPaused }"
        >
          <img
            v-if="library.currentSong.cover_path"
            :src="library.getCoverUrl(library.currentSong.cover_path)"
            :alt="library.currentSong.title"
            class="w-full h-full object-cover"
          />
          <div
            v-else
            class="w-full h-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center"
          >
            <span class="text-6xl text-white/50">♪</span>
          </div>
          <!-- 黑胶唱片中心 -->
          <div
            class="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <div class="w-12 h-12 bg-gray-900/80 rounded-full border-2 border-gray-700"></div>
          </div>
        </div>

        <!-- 频谱组件（放在封面下方） -->
        <AudioSpectrum />

        <!-- 歌曲信息 -->
        <h2 class="text-gray-900 dark:text-white text-2xl font-semibold mt-8">{{ library.currentSong.title }}</h2>
        <p class="text-gray-600 dark:text-gray-400 text-lg mt-2">{{ library.currentSong.artist || '未知艺术家' }}</p>
        <p v-if="library.currentSong.album" class="text-gray-500 dark:text-gray-500 text-sm mt-1">
          {{ library.currentSong.album }}
        </p>
      </div>
    </template>
    <template v-else>
      <div class="text-center">
        <div
          class="w-64 h-64 mx-auto bg-gradient-to-br from-purple-500/30 to-pink-500/30 rounded-full flex items-center justify-center shadow-2xl"
        >
          <div class="w-12 h-12 bg-gray-900/50 rounded-full border-2 border-gray-700/50"></div>
        </div>
        <p class="text-gray-900 dark:text-white text-xl mt-6">等待播放...</p>
        <p class="text-gray-600 dark:text-gray-400 text-sm mt-2">在右侧设置面板选择音乐文件夹开始播放</p>
      </div>
    </template>
  </div>
</template>