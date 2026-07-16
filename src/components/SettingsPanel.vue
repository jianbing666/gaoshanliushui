<script setup lang="ts">
import { useSettingsStore } from '@/stores/settingsStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useAudioStore } from '@/stores/audioStore'
import MigrateDataModal from './MigrateDataModal.vue'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import type { ThemeMode, BackgroundSettings } from '@/types/song'
import { useShortcutConfig } from '@/composables/useShortcutConfig'
import { useAutoLaunch } from '@/composables/useAutoLaunch'
import { ref, onMounted, onUnmounted } from 'vue'

const settings = useSettingsStore()
const library = useLibraryStore()
const audio = useAudioStore()

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

const backgroundModeOptions: { value: BackgroundSettings['mode']; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'image', label: '单图' },
  { value: 'folder', label: '轮播' },
]

const fitOptions: { value: BackgroundSettings['fit']; label: string }[] = [
  { value: 'cover', label: '填充' },
  { value: 'contain', label: '完整' },
  { value: 'repeat', label: '平铺' },
]

const {
  shortcuts,
  editingShortcut,
  startEdit,
  cancelEdit,
  updateShortcut,
  resetToDefault,
  clearShortcut,
  resetAllToDefault,
  handleKeyDown,
} = useShortcutConfig()

const {
  autoLaunch,
  loading: autoLaunchLoading,
  toggleAutoLaunch,
} = useAutoLaunch()

const isScanningBgFolder = ref(false)
const showRefreshConfirm = ref(false)

async function selectFolder() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择音乐文件夹',
    })
    if (selected) {
      await library.scanMusicFolder(selected)
    }
  } catch (error) {
    console.error('选择文件夹失败:', error)
  }
}

// v1.1 (2026-07-14): 重新扫描当前目录 (不弹确认, 直接触发, forceRefresh=false 节省缓存)
async function confirmRescan() {
  if (!library.folderPath) return
  try {
    await library.scanMusicFolder(library.folderPath, false)
  } catch (error) {
    console.error('重新扫描失败:', error)
  }
}

async function handleRefreshMetadata() {
  showRefreshConfirm.value = true
}

async function confirmRefreshMetadata() {
  showRefreshConfirm.value = false
  await library.refreshMetadata()
}

function cancelRefresh() {
  showRefreshConfirm.value = false
}

function handleMetadataSourceChange(source: 'auto' | 'filename') {
  library.setMetadataSource(source)
}

function handleThemeChange(theme: ThemeMode) {
  settings.setTheme(theme)
}

function handleShortcutKeyDown(event: KeyboardEvent, shortcutId: string) {
  const newShortcut = handleKeyDown(event)
  if (newShortcut) {
    updateShortcut(shortcutId, newShortcut)
  }
}

function handleClickOutside(_event: MouseEvent) {
  if (editingShortcut.value) {
    cancelEdit()
  }
}

function handleBackgroundModeChange(mode: BackgroundSettings['mode']) {
  settings.setBackgroundMode(mode)
}

async function selectBackgroundImage() {
  try {
    const selected = await open({
      multiple: false,
      title: '选择背景图片',
      filters: [
        {
          name: '图片',
          extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'],
        },
      ],
    })
    if (selected) {
      settings.setBackgroundImage(selected as string)
    }
  } catch (error) {
    console.error('选择背景图片失败:', error)
  }
}

async function selectBackgroundFolder() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择背景图片文件夹',
    })
    if (selected) {
      isScanningBgFolder.value = true
      try {
        await settings.scanBackgroundFolder(selected)
      } finally {
        isScanningBgFolder.value = false
      }
    }
  } catch (error) {
    console.error('选择背景文件夹失败:', error)
  }
}

function updateBgSetting<K extends keyof BackgroundSettings>(key: K, value: BackgroundSettings[K]) {
  settings.updateBackgroundSetting(key, value)
}

function handleMinimizeToTrayToggle() {
  settings.setMinimizeToTray(!settings.minimizeToTray)
}

function handleShowSpectrumToggle() {
  settings.setShowSpectrum(!settings.showSpectrum)
}

// BUG 3 修复: 设置页面的「显示记忆标签」开关已移除
//   原因: 回忆抽屉内已有相同开关, 重复入口会增加 UI 复杂度
//   开关功能: 由回忆抽屉头部的「显示弹幕」开关统一控制

// BUG 7 修复: 设置页面的「导出备注」按钮已移除
//   原因: 回忆抽屉内已有相同功能, 重复入口会增加 UI 复杂度
//   提示文字: "导出备注请在右侧「回忆」抽屉操作"

function handleSpectrumQualityChange(quality: 'high' | 'balanced' | 'low') {
  settings.setSpectrumQuality(quality)
}

const isClearingCache = ref(false)
const cacheCleared = ref(false)

async function handleClearCache() {
  if (isClearingCache.value) return
  isClearingCache.value = true
  cacheCleared.value = false
  try {
    audio.clearAudioBufferCache()
    await invoke('clear_cover_cache')
    await settings.loadDataUsage()
    cacheCleared.value = true
    setTimeout(() => {
      cacheCleared.value = false
    }, 2000)
  } catch (error) {
    console.error('清除缓存失败:', error)
  } finally {
    isClearingCache.value = false
  }
}

const isClearingDataCache = ref(false)
const dataCacheCleared = ref(false)
const showMigrateModal = ref(false)

async function handleResetDataDir() {
  try {
    await settings.resetDataDirToDefault()
  } catch (error) {
    console.error('恢复默认数据目录失败:', error)
  }
}

async function handleOpenDataDir() {
  try {
    await settings.openDataDirInExplorer()
  } catch (error) {
    console.error('打开数据目录失败:', error)
  }
}

async function handleClearDataCache() {
  if (isClearingDataCache.value) return
  isClearingDataCache.value = true
  dataCacheCleared.value = false
  try {
    await settings.clearDataCache()
    dataCacheCleared.value = true
    setTimeout(() => {
      dataCacheCleared.value = false
    }, 2000)
  } catch (error) {
    console.error('清除数据缓存失败:', error)
  } finally {
    isClearingDataCache.value = false
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function totalDataUsage(): number {
  return settings.dataUsageList.reduce((sum, item) => sum + item.size_bytes, 0)
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  settings.loadDataDirInfo().catch(console.error)
  settings.loadDataUsage().catch(console.error)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <aside class="w-80 backdrop-blur border-l border-gray-200/60 dark:border-gray-700/60 shadow-2xl flex flex-col h-full will-change-auto" :class="
    settings.currentBackgroundUrl && settings.background.mode !== 'none'
      ? 'bg-white/50 dark:bg-gray-900/50'
      : 'bg-white/90 dark:bg-gray-900/90'
  ">
    <div class="px-5 py-4 border-b border-gray-200/50 dark:border-gray-700/50 flex items-center gap-3">
      <div>
        <h2 class="text-gray-900 dark:text-white text-base font-semibold">设置</h2>
        <p class="text-gray-500 dark:text-gray-400 text-xs">个性化你的播放器</p>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto scrollbar-hide px-5 py-4 space-y-6">
      <!-- 外观 -->
      <div class="space-y-3">
        <h3 class="text-gray-900 dark:text-white text-sm font-semibold">外观</h3>

        <div class="space-y-4">
          <div>
            <p class="text-gray-500 dark:text-gray-400 text-xs mb-2">主题模式</p>
            <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-1 flex gap-1">
              <button
                v-for="option in themeOptions"
                :key="option.value"
                class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="
                  settings.theme === option.value
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                "
                @click="handleThemeChange(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 音乐库 -->
      <div class="space-y-3">
        <h3 class="text-gray-900 dark:text-white text-sm font-semibold">音乐库</h3>

        <div class="space-y-3">
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">当前文件夹</p>
            <p class="text-sm text-gray-900 dark:text-white truncate">
              {{ library.folderPath || '未选择' }}
            </p>
          </div>
          <!-- 音乐库目录 + 重新扫描 (同一行) -->
          <div class="flex gap-2">
            <button
              class="flex-1 px-4 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-all disabled:opacity-50"
              :disabled="library.isLoading"
              @click="selectFolder"
            >
              {{ library.folderPath ? '更改目录' : '选择目录' }}
            </button>
            <button
              v-if="library.folderPath"
              class="flex-1 px-4 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-all disabled:opacity-50"
              :disabled="library.isLoading"
              @click="confirmRescan"
              :title="'重新扫描当前目录'"
            >
              {{ library.isLoading ? '扫描中...' : '重新扫描' }}
            </button>
          </div>

          <!-- 元数据来源 -->
          <div class="space-y-2 pt-2 border-t border-gray-200/50 dark:border-gray-700/50">
            <p class="text-xs text-gray-500 dark:text-gray-400">元数据来源</p>
            <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-1 flex gap-1">
              <button
                class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="
                  library.metadataSource === 'auto'
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                "
                @click="handleMetadataSourceChange('auto')"
              >
                智能
              </button>
              <button
                class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="
                  library.metadataSource === 'filename'
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                "
                @click="handleMetadataSourceChange('filename')"
              >
                仅文件名
              </button>
            </div>
            <p class="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
              {{ library.metadataSource === 'auto' ? '优先使用 ID3 标签，缺失时从文件名解析' : '忽略 ID3 标签，完全从文件名解析（歌手 - 歌名）' }}
            </p>
          </div>

          <!-- 刷新元数据 -->
          <div v-if="false" class="pt-2 border-t border-gray-200/50 dark:border-gray-700/50">
            <template v-if="!showRefreshConfirm">
              <button
                class="w-full px-4 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-all"
                :disabled="library.isLoading"
                @click="handleRefreshMetadata"
              >
                刷新元数据
              </button>
            </template>
            <template v-else>
              <div class="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200/50 dark:border-yellow-800/30 rounded-lg p-3 space-y-2">
                <p class="text-xs text-yellow-700 dark:text-yellow-300">
                  确定要刷新所有元数据吗？将清除封面缓存并重新扫描。
                </p>
                <div class="flex gap-2">
                  <button
                    class="flex-1 px-3 py-1.5 bg-gray-100 dark:bg-gray-700/50 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md text-xs text-gray-700 dark:text-gray-300 transition-colors"
                    @click="cancelRefresh"
                  >
                    取消
                  </button>
                  <button
                    class="flex-1 px-3 py-1.5 bg-yellow-500 hover:bg-yellow-600 text-white rounded-md text-xs font-medium transition-colors"
                    :disabled="library.isLoading"
                    @click="confirmRefreshMetadata"
                  >
                    确认刷新
                  </button>
                </div>
              </div>
            </template>
          </div>

          <p class="text-xs text-gray-500 dark:text-gray-400 text-center">
            共 {{ library.playlist.length }} 首歌曲
          </p>
        </div>
      </div>

      <!-- 系统 -->
      <div class="space-y-3">
        <h3 class="text-gray-900 dark:text-white text-sm font-semibold">系统</h3>

        <div class="space-y-2">
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-900 dark:text-white text-sm font-medium">开机自启</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs">开机时自动启动应用</p>
              </div>
              <button
                class="relative w-10 h-5 rounded-full transition-colors shrink-0"
                :class="autoLaunch ? 'bg-blue-500 dark:bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
                :disabled="autoLaunchLoading"
                @click="toggleAutoLaunch"
              >
                <div
                  class="absolute top-0.5 w-4 h-4 bg-white dark:bg-gray-900 rounded-full shadow transition-transform"
                  :class="autoLaunch ? 'translate-x-5' : 'translate-x-0.5'"
                ></div>
              </button>
            </div>
          </div>

          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-900 dark:text-white text-sm font-medium">关闭到托盘</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs">点击关闭按钮后最小化到托盘</p>
              </div>
              <button
                class="relative w-10 h-5 rounded-full transition-colors shrink-0"
                :class="settings.minimizeToTray ? 'bg-blue-500 dark:bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
                @click="handleMinimizeToTrayToggle"
              >
                <div
                  class="absolute top-0.5 w-4 h-4 bg-white dark:bg-gray-900 rounded-full shadow transition-transform"
                  :class="settings.minimizeToTray ? 'translate-x-5' : 'translate-x-0.5'"
                ></div>
              </button>
            </div>
          </div>

          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-900 dark:text-white text-sm font-medium">显示频谱</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs">播放时显示音频频谱动画</p>
              </div>
              <button
                class="relative w-10 h-5 rounded-full transition-colors shrink-0"
                :class="settings.showSpectrum ? 'bg-blue-500 dark:bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
                @click="handleShowSpectrumToggle"
              >
                <div
                  class="absolute top-0.5 w-4 h-4 bg-white dark:bg-gray-900 rounded-full shadow transition-transform"
                  :class="settings.showSpectrum ? 'translate-x-5' : 'translate-x-0.5'"
                ></div>
              </button>
            </div>
          </div>


          <!-- 频谱质量: 三档单选 (主开关开启时生效) -->
          <div v-if="settings.showSpectrum" class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3 space-y-2">
            <div>
              <p class="text-gray-900 dark:text-white text-sm font-medium">频谱质量</p>
              <p class="text-gray-500 dark:text-gray-400 text-xs">高 = 60fps + 2048 fft, 低 = 20fps + 512 fft, 越低越省 CPU</p>
            </div>
            <div class="bg-white/60 dark:bg-gray-900/40 rounded-lg p-1 flex gap-1">
              <button
                v-for="opt in [
                  { value: 'high', label: '高性能' },
                  { value: 'balanced', label: '平衡' },
                  { value: 'low', label: '低功耗' }
                ]"
                :key="opt.value"
                class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="
                  settings.spectrumQuality === opt.value
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                "
                @click="handleSpectrumQualityChange(opt.value as 'high' | 'balanced' | 'low')"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <!-- 清除缓存 -->
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-900 dark:text-white text-sm font-medium">清除缓存</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs">清除音频解码缓存和封面图片缓存</p>
              </div>
                <button
                  class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0"
                  :class="cacheCleared
                    ? 'bg-gray-100 dark:bg-gray-600 text-gray-900 dark:text-white'
                    : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-gray-50 dark:hover:bg-gray-700'"
                  :disabled="isClearingCache"
                  @click="handleClearCache"
                >
                {{ isClearingCache ? '清除中...' : cacheCleared ? '已清除' : '清除' }}
              </button>
            </div>
          </div>

          <!-- 定时关闭 -->
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3 space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-900 dark:text-white text-sm font-medium">定时关闭</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs">
                  {{ settings.sleepTimerEnabled
                    ? `剩余 ${formatTime(settings.sleepTimerRemaining)}`
                    : '设定时间后自动暂停播放' }}
                </p>
              </div>
              <button
                class="relative w-10 h-5 rounded-full transition-colors shrink-0"
                :class="settings.sleepTimerEnabled ? 'bg-blue-500 dark:bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
                @click="settings.toggleSleepTimer"
              >
                <div
                  class="absolute top-0.5 w-4 h-4 bg-white dark:bg-gray-900 rounded-full shadow transition-transform"
                  :class="settings.sleepTimerEnabled ? 'translate-x-5' : 'translate-x-0.5'"
                ></div>
              </button>
            </div>
            <div v-if="settings.sleepTimerEnabled" class="space-y-2">
              <div class="flex gap-1">
                <button
                  v-for="m in [15, 30, 60, 90]"
                  :key="m"
                  class="flex-1 py-1 text-xs rounded-md transition-colors"
                  :class="settings.sleepTimerMinutes === m
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'"
                  @click="settings.setSleepTimerMinutes(m)"
                >
                  {{ m }}分
                </button>
              </div>
              <div class="flex items-center gap-2">
                <input
                  type="range"
                  class="flex-1"
                  :min="5"
                  :max="180"
                  :value="settings.sleepTimerMinutes"
                  step="5"
                  @input="(e) => settings.setSleepTimerMinutes(parseInt((e.target as HTMLInputElement).value))"
                />
                <span class="text-xs text-gray-500 dark:text-gray-400 w-10 text-right">
                  {{ settings.sleepTimerMinutes }}分
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 数据管理 -->
      <div class="space-y-3">
        <h3 class="text-gray-900 dark:text-white text-sm font-semibold">数据管理</h3>

        <div class="space-y-2">
          <!-- 当前数据目录 -->
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3">
            <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">
              当前目录
              <span v-if="settings.dataDirInfo?.is_custom" class="text-blue-500 dark:text-blue-400 ml-1">（自定义）</span>
            </p>
            <p class="text-sm text-gray-900 dark:text-white truncate" :title="settings.dataDirInfo?.current_path">
              {{ settings.dataDirInfo?.current_path || '加载中...' }}
            </p>
          </div>

          <!-- 存储使用量 -->
          <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3 space-y-2">
            <div class="flex items-center justify-between">
              <p class="text-xs text-gray-500 dark:text-gray-400">存储使用</p>
              <p class="text-xs text-gray-700 dark:text-gray-300 font-medium">{{ formatBytes(totalDataUsage()) }}</p>
            </div>
            <div v-if="settings.dataUsageList.length > 0" class="space-y-1.5">
              <div v-for="item in settings.dataUsageList" :key="item.name" class="space-y-1">
                <div class="flex items-center justify-between">
                  <span class="text-xs text-gray-600 dark:text-gray-400">{{ item.name }}</span>
                  <span class="text-xs text-gray-500 dark:text-gray-500">{{ formatBytes(item.size_bytes) }}</span>
                </div>
                <div class="w-full h-1.5 bg-gray-200/60 dark:bg-gray-700/60 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-blue-500/70 dark:bg-blue-400/70 rounded-full transition-all"
                    :style="{ width: totalDataUsage() > 0 ? (item.size_bytes / totalDataUsage() * 100) + '%' : '0%' }"
                  ></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 操作按钮 -->
          <div class="flex gap-2">
            <button
              class="flex-1 px-3 py-2 bg-blue-500/90 hover:bg-blue-500 text-white rounded-lg text-xs transition-all"
              @click="showMigrateModal = true"
            >
              迁移到新目录
            </button>
            <button
              class="flex-1 px-3 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-xs text-gray-700 dark:text-gray-300 transition-all"
              @click="handleOpenDataDir"
            >
              打开目录
            </button>
          </div>

          <div class="flex gap-2">
            <button
              v-if="settings.dataDirInfo?.is_custom"
              class="flex-1 px-3 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-xs text-gray-700 dark:text-gray-300 transition-all"
              @click="handleResetDataDir"
            >
              恢复默认
            </button>
            <button
              class="flex-1 px-3 py-2 transition-all rounded-lg text-xs font-medium shrink-0"
              :class="dataCacheCleared
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-gray-50 dark:hover:bg-gray-700'"
              :disabled="isClearingDataCache"
              @click="handleClearDataCache"
            >
              {{ isClearingDataCache ? '清除中...' : dataCacheCleared ? '已清除' : '清除缓存' }}
            </button>
          </div>

          <p class="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
            数据目录存放数据库、封面缓存等应用数据。迁移过程会复制所有数据到新目录并自动切换。
          </p>
        </div>
      </div>

      <!-- 快捷键 -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-gray-900 dark:text-white text-sm font-semibold">快捷键</h3>
          <button
            class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            @click="resetAllToDefault"
          >
            恢复默认
          </button>
        </div>

        <div class="space-y-2">
          <div
            v-for="shortcut in shortcuts"
            :key="shortcut.id"
            class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-3 space-y-2"
          >
            <div>
              <p class="text-gray-900 dark:text-white text-sm font-medium">{{ shortcut.action }}</p>
              <p class="text-gray-500 dark:text-gray-400 text-xs">{{ shortcut.description }}</p>
            </div>

            <div class="flex items-center gap-2">
              <div
                v-if="editingShortcut === shortcut.id"
                class="flex-1 relative"
                @click.stop
              >
                <input
                  type="text"
                  readonly
                  value="按下新快捷键..."
                  class="w-full bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 focus:outline-none focus:border-gray-900 dark:focus:border-white"
                  @keydown="handleShortcutKeyDown($event, shortcut.id)"
                  @blur="cancelEdit"
                />
              </div>
              <div v-else class="flex-1 flex items-center gap-2">
                <div
                  class="flex-1 bg-white dark:bg-gray-700 rounded-md px-3 py-2 text-gray-900 dark:text-white text-sm font-mono cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors text-center"
                  :class="!shortcut.currentShortcut && 'text-gray-400 dark:text-gray-500'"
                  @click.stop="startEdit(shortcut.id)"
                >
                  {{ shortcut.currentShortcut || '未设置' }}
                </div>
                <!-- v1.1 (2026-07-14): X 清除按钮 -->
                <button
                  v-if="shortcut.currentShortcut"
                  class="px-2 py-1 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors shadow-sm border rounded-md flex items-center justify-center"
                  :title="'清除当前快捷键'"
                  @click="clearShortcut(shortcut.id)"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
                <button
                  v-if="shortcut.currentShortcut && shortcut.currentShortcut !== shortcut.defaultShortcut"
                  class="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors shadow-sm border rounded-md"
                  @click="resetToDefault(shortcut.id)"
                  title="恢复默认"
                >
                  重置
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 背景图片 -->
      <div class="space-y-3">
        <h3 class="text-gray-900 dark:text-white text-sm font-semibold">背景图片</h3>

        <div class="space-y-4">
          <div class="flex items-center gap-1 bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-1">
            <button
              v-for="option in backgroundModeOptions"
              :key="option.value"
              class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="
                settings.background.mode === option.value
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              "
              @click="handleBackgroundModeChange(option.value)"
            >
              {{ option.label }}
            </button>
          </div>

          <div v-if="settings.background.mode === 'image'" class="space-y-2">
            <button
              class="w-full px-4 py-2.5 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-all flex items-center justify-center gap-2"
              @click="selectBackgroundImage"
            >
              {{ settings.background.imagePath ? '更换图片' : '选择图片' }}
            </button>
            <p v-if="settings.background.imagePath" class="text-xs text-gray-500 dark:text-gray-400 truncate px-1">
              {{ settings.background.imagePath }}
            </p>
          </div>

          <div v-if="settings.background.mode === 'folder'" class="space-y-3">
            <button
              class="w-full px-4 py-2.5 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-all flex items-center justify-center gap-2"
              :disabled="isScanningBgFolder"
              @click="selectBackgroundFolder"
            >
              {{ isScanningBgFolder ? '扫描中...' : settings.background.folderPath ? '更换文件夹' : '选择文件夹' }}
            </button>
            <p v-if="settings.background.folderPath" class="text-xs text-gray-500 dark:text-gray-400 truncate px-1">
              {{ settings.background.folderPath }}
            </p>
            <p v-if="settings.background.imageList?.length" class="text-xs text-gray-500 dark:text-gray-400 px-1">
              共 {{ settings.background.imageList.length }} 张图片
            </p>

            <div>
              <div class="flex items-center justify-between mb-2">
                <p class="text-xs text-gray-500 dark:text-gray-400">轮播间隔</p>
                <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">{{ settings.background.interval }} 秒</span>
              </div>
              <input
                type="range"
                class="w-full"
                :min="5"
                :max="300"
                :value="settings.background.interval"
                step="5"
                @input="(e) => updateBgSetting('interval', parseInt((e.target as HTMLInputElement).value))"
              />
            </div>

            <div class="flex items-center gap-2">
              <button
                class="flex-1 px-3 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-md text-xs text-gray-600 dark:text-gray-300 transition-colors"
                @click="settings.prevBackgroundImage()"
                :disabled="!settings.background.imageList?.length"
              >
                上一张
              </button>
              <button
                class="flex-1 px-3 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-md text-xs text-gray-600 dark:text-gray-300 transition-colors"
                @click="settings.nextBackgroundImage()"
                :disabled="!settings.background.imageList?.length"
              >
                下一张
              </button>
            </div>
          </div>

          <div v-if="settings.background.mode !== 'none'" class="space-y-4 pt-2 border-t border-gray-200/50 dark:border-gray-700/50">
            <div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">填充方式</p>
              <div class="flex gap-1">
                <button
                  v-for="opt in fitOptions"
                  :key="opt.value"
                  class="flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-all bg-gray-100/60 dark:bg-gray-800/60"
                  :class="
                    settings.background.fit === opt.value
                      ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-700/60'
                  "
                  @click="updateBgSetting('fit', opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>

            <div>
              <div class="flex items-center justify-between mb-2">
                <p class="text-xs text-gray-500 dark:text-gray-400">遮罩透明度</p>
                <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">{{ Math.round(settings.background.overlay * 100) }}%</span>
              </div>
              <input
                type="range"
                class="w-full"
                :min="0"
                :max="100"
                :value="settings.background.overlay * 100"
                @input="(e) => updateBgSetting('overlay', parseInt((e.target as HTMLInputElement).value) / 100)"
              />
            </div>

            <div>
              <div class="flex items-center justify-between mb-2">
                <p class="text-xs text-gray-500 dark:text-gray-400">模糊程度</p>
                <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">{{ settings.background.blur }}px</span>
              </div>
              <input
                type="range"
                class="w-full"
                :min="0"
                :max="30"
                :value="settings.background.blur"
                @input="(e) => updateBgSetting('blur', parseInt((e.target as HTMLInputElement).value))"
              />
            </div>

            <div>
              <div class="flex items-center justify-between mb-2">
                <p class="text-xs text-gray-500 dark:text-gray-400">缩放比例</p>
                <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">{{ settings.background.scale }}%</span>
              </div>
              <input
                type="range"
                class="w-full"
                :min="50"
                :max="200"
                :value="settings.background.scale"
                @input="(e) => updateBgSetting('scale', parseInt((e.target as HTMLInputElement).value))"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="pt-2 pb-4">
        <div class="text-center space-y-1">
          <p class="text-gray-500 dark:text-gray-400 text-xs font-medium">高山流水</p>
          <p class="text-gray-400 dark:text-gray-500 text-xs">基于 Tauri v2 + Vue 3</p>
        </div>
      </div>
    </div>
  </aside>

  <MigrateDataModal
    v-if="showMigrateModal"
    @close="showMigrateModal = false"
    @completed="showMigrateModal = false"
  />
</template>

<style scoped>
button {
  transition: all 0.15s ease;
}

input:focus {
  outline: none;
}

/* 隐藏滚动条但保留滚动功能 */
:deep(.scrollbar-hide) {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

:deep(.scrollbar-hide::-webkit-scrollbar) {
  display: none;
}

</style>
