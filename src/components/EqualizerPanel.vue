<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useUIStore } from '@/stores/uiStore'
import { equalizer } from '@/audio/Equalizer'
import Icon from '@/components/icons/Icon.vue'

const ui = useUIStore()

const eqEnabled = ref(true)
const selectedPreset = ref<string>('flat')

const presets = [
  { name: 'flat', label: '平坦', desc: '原声输出' },
  { name: 'pop', label: '流行', desc: '突出人声' },
  { name: 'rock', label: '摇滚', desc: '高低音增强' },
  { name: 'jazz', label: '爵士', desc: '柔和饱满' },
  { name: 'classical', label: '古典', desc: '动态宽广' },
  { name: 'bass', label: '重低音', desc: '低音轰头' },
  { name: 'treble', label: '高音', desc: '清晰透亮' },
  { name: 'vocal', label: '人声', desc: '人声突出' },
]

const presetGains: Record<string, number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pop: [-1, 2, 4, 4, 2, 0, -1, -1, 0, 2],
  rock: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
  jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  classical: [4, 3, 2, 1, 0, 0, 0, 1, 2, 3],
  bass: [8, 7, 6, 4, 2, 0, -1, -1, 0, 1],
  treble: [-1, -1, 0, 0, 1, 2, 3, 5, 7, 8],
  vocal: [-2, -1, 0, 2, 4, 4, 3, 2, 1, 0],
}

function applyPreset(presetName: string) {
  const gains = presetGains[presetName]
  if (!gains) return
  equalizer.setGains(gains)
  selectedPreset.value = presetName
}

function toggleEq() {
  eqEnabled.value = !eqEnabled.value
  equalizer.enabled = eqEnabled.value
}

onMounted(() => {
  eqEnabled.value = equalizer.enabled
})
</script>

<template>
  <aside
    class="w-80 h-full flex flex-col bg-white/50 dark:bg-gray-900/60 backdrop-blur border-l border-gray-200/60 dark:border-gray-700/60 shadow-2xl"
  >
    <!-- 头部 -->
    <div
      class="flex items-center justify-between px-5 py-4 border-b border-gray-200/50 dark:border-gray-700/50"
    >
      <div>
        <h2 class="text-gray-900 dark:text-white text-base font-semibold">均衡器</h2>
        <p class="text-gray-500 dark:text-gray-400 text-xs">调节音效风格</p>
      </div>
      <button
        class="p-1.5 rounded-md hover:bg-gray-200/60 dark:hover:bg-gray-700/60 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white transition-colors"
        title="关闭"
        @click="ui.toggleRightPanel('equalizer')"
      >
        <Icon name="chevron-right" :size="18" />
      </button>
    </div>

    <!-- 内容区域 -->
    <div class="flex-1 overflow-y-auto p-5 space-y-6">
      <!-- 启用开关 -->
      <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-gray-900 dark:text-white text-sm font-medium">启用均衡器</p>
            <p class="text-gray-500 dark:text-gray-400 text-xs">
              {{ eqEnabled ? '已启用' : '已禁用' }}
            </p>
          </div>
          <button
            class="relative w-10 h-5 rounded-full transition-colors shrink-0"
            :class="eqEnabled ? 'bg-blue-500 dark:bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
            @click="toggleEq"
          >
            <div
              class="absolute top-0.5 w-4 h-4 bg-white dark:bg-gray-900 rounded-full shadow transition-transform"
              :class="eqEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'"
            ></div>
          </button>
        </div>
      </div>

      <!-- 预设选择 -->
      <div>
        <h3 class="text-gray-900 dark:text-white text-sm font-medium mb-3 font-semibold">
          音效预设
        </h3>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="preset in presets"
            :key="preset.name"
            class="rounded-lg p-3 text-left transition-all border"
            :class="
              selectedPreset === preset.name && eqEnabled
                ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-400'
                : 'bg-white dark:bg-gray-800/60 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-blue-200 dark:hover:border-blue-800'
            "
            :disabled="!eqEnabled"
            @click="applyPreset(preset.name)"
          >
            <div class="text-sm font-medium">{{ preset.label }}</div>
            <div class="text-xs opacity-70 mt-0.5">{{ preset.desc }}</div>
          </button>
        </div>
      </div>

      <!-- 说明 -->
      <div
        class="text-xs text-gray-400 dark:text-gray-500 leading-relaxed bg-gray-100/40 dark:bg-gray-800/40 rounded-md p-3"
      >
        <p>选择不同预设体验不同音效风格</p>
        <p class="mt-1">基于 Web Audio API 实时处理，零延迟</p>
      </div>
    </div>
  </aside>
</template>
