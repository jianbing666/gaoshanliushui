<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { open } from '@tauri-apps/plugin-dialog'
import type { ThemeMode, BackgroundSettings } from '@/types/song'
import { useShortcutConfig } from '@/composables/useShortcutConfig'
import { useAutoLaunch } from '@/composables/useAutoLaunch'
import { ref, onMounted, onUnmounted } from 'vue'

const player = usePlayerStore()

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
      await player.scanMusicFolder(selected)
    }
  } catch (error) {
    console.error('选择文件夹失败:', error)
  }
}

async function handleRefreshMetadata() {
  showRefreshConfirm.value = true
}

async function confirmRefreshMetadata() {
  showRefreshConfirm.value = false
  await player.refreshMetadata()
}

function cancelRefresh() {
  showRefreshConfirm.value = false
}

function handleMetadataSourceChange(source: 'auto' | 'filename') {
  player.setMetadataSource(source)
}

function handleThemeChange(theme: ThemeMode) {
  player.setTheme(theme)
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
  player.setBackgroundMode(mode)
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
      player.setBackgroundImage(selected as string)
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
        await player.scanBackgroundFolder(selected)
      } finally {
        isScanningBgFolder.value = false
      }
    }
  } catch (error) {
    console.error('选择背景文件夹失败:', error)
  }
}

function updateBgSetting<K extends keyof BackgroundSettings>(key: K, value: BackgroundSettings[K]) {
  player.updateBackgroundSetting(key, value)
}

function handleMinimizeToTrayToggle() {
  player.setMinimizeToTray(!player.minimizeToTray)
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <aside class="w-[320px] bg-white/90 dark:bg-gray-900/90 backdrop-blur-2xl border-l border-gray-200/60 dark:border-gray-700/60 shadow-2xl flex flex-col h-full">
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
                  player.theme === option.value
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
                player.background.mode === option.value
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              "
              @click="handleBackgroundModeChange(option.value)"
            >
              {{ option.label }}
            </button>
          </div>

          <div v-if="player.background.mode === 'image'" class="space-y-2">
            <button
              class="w-full px-4 py-2.5 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-all flex items-center justify-center gap-2"
              @click="selectBackgroundImage"
            >
              {{ player.background.imagePath ? '更换图片' : '选择图片' }}
            </button>
            <p v-if="player.background.imagePath" class="text-xs text-gray-500 dark:text-gray-400 truncate px-1">
              {{ player.background.imagePath }}
            </p>
          </div>

          <div v-if="player.background.mode === 'folder'" class="space-y-3">
            <button
              class="w-full px-4 py-2.5 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-all flex items-center justify-center gap-2"
              :disabled="isScanningBgFolder"
              @click="selectBackgroundFolder"
            >
              {{ isScanningBgFolder ? '扫描中...' : player.background.folderPath ? '更换文件夹' : '选择文件夹' }}
            </button>
            <p v-if="player.background.folderPath" class="text-xs text-gray-500 dark:text-gray-400 truncate px-1">
              {{ player.background.folderPath }}
            </p>
            <p v-if="player.background.imageList?.length" class="text-xs text-gray-500 dark:text-gray-400 px-1">
              共 {{ player.background.imageList.length }} 张图片
            </p>

            <div>
              <div class="flex items-center justify-between mb-2">
                <p class="text-xs text-gray-500 dark:text-gray-400">轮播间隔</p>
                <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">{{ player.background.interval }} 秒</span>
              </div>
              <input
                type="range"
                class="w-full"
                :min="5"
                :max="300"
                :value="player.background.interval"
                step="5"
                @input="(e) => updateBgSetting('interval', parseInt((e.target as HTMLInputElement).value))"
              />
            </div>

            <div class="flex items-center gap-2">
              <button
                class="flex-1 px-3 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-md text-xs text-gray-600 dark:text-gray-300 transition-colors"
                @click="player.prevBackgroundImage()"
                :disabled="!player.background.imageList?.length"
              >
                上一张
              </button>
              <button
                class="flex-1 px-3 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-md text-xs text-gray-600 dark:text-gray-300 transition-colors"
                @click="player.nextBackgroundImage()"
                :disabled="!player.background.imageList?.length"
              >
                下一张
              </button>
            </div>
          </div>

          <div v-if="player.background.mode !== 'none'" class="space-y-4 pt-2 border-t border-gray-200/50 dark:border-gray-700/50">
            <div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">填充方式</p>
              <div class="flex gap-1">
                <button
                  v-for="opt in fitOptions"
                  :key="opt.value"
                  class="flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-all bg-gray-100/60 dark:bg-gray-800/60"
                  :class="
                    player.background.fit === opt.value
                      ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900'
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
                <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">{{ Math.round(player.background.overlay * 100) }}%</span>
              </div>
              <input
                type="range"
                class="w-full"
                :min="0"
                :max="100"
                :value="player.background.overlay * 100"
                @input="(e) => updateBgSetting('overlay', parseInt((e.target as HTMLInputElement).value) / 100)"
              />
            </div>

            <div>
              <div class="flex items-center justify-between mb-2">
                <p class="text-xs text-gray-500 dark:text-gray-400">模糊程度</p>
                <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">{{ player.background.blur }}px</span>
              </div>
              <input
                type="range"
                class="w-full"
                :min="0"
                :max="30"
                :value="player.background.blur"
                @input="(e) => updateBgSetting('blur', parseInt((e.target as HTMLInputElement).value))"
              />
            </div>

            <div>
              <div class="flex items-center justify-between mb-2">
                <p class="text-xs text-gray-500 dark:text-gray-400">缩放比例</p>
                <span class="text-xs text-gray-600 dark:text-gray-300 font-medium">{{ player.background.scale }}%</span>
              </div>
              <input
                type="range"
                class="w-full"
                :min="50"
                :max="200"
                :value="player.background.scale"
                @input="(e) => updateBgSetting('scale', parseInt((e.target as HTMLInputElement).value))"
              />
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
              {{ player.folderPath || '未选择' }}
            </p>
          </div>
          <button
            class="w-full px-4 py-2.5 bg-gray-900 dark:bg-white hover:bg-gray-700 dark:hover:bg-gray-200 text-white dark:text-gray-900 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2"
            :disabled="player.isLoading"
            @click="selectFolder"
          >
            {{ player.isLoading ? '扫描中...' : '更改目录' }}
          </button>

          <!-- 元数据来源 -->
          <div class="space-y-2 pt-2 border-t border-gray-200/50 dark:border-gray-700/50">
            <p class="text-xs text-gray-500 dark:text-gray-400">元数据来源</p>
            <div class="bg-gray-100/60 dark:bg-gray-800/60 rounded-lg p-1 flex gap-1">
              <button
                class="flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="
                  player.metadataSource === 'auto'
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
                  player.metadataSource === 'filename'
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                "
                @click="handleMetadataSourceChange('filename')"
              >
                仅文件名
              </button>
            </div>
            <p class="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
              {{ player.metadataSource === 'auto' ? '优先使用 ID3 标签，缺失时从文件名解析' : '忽略 ID3 标签，完全从文件名解析（歌手 - 歌名）' }}
            </p>
          </div>

          <!-- 刷新元数据 -->
          <div v-if="player.folderPath" class="pt-2 border-t border-gray-200/50 dark:border-gray-700/50">
            <template v-if="!showRefreshConfirm">
              <button
                class="w-full px-4 py-2 bg-gray-100/60 dark:bg-gray-800/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-all"
                :disabled="player.isLoading"
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
                    :disabled="player.isLoading"
                    @click="confirmRefreshMetadata"
                  >
                    确认刷新
                  </button>
                </div>
              </div>
            </template>
          </div>

          <p class="text-xs text-gray-500 dark:text-gray-400 text-center">
            共 {{ player.playlist.length }} 首歌曲
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
                  @click.stop="startEdit(shortcut.id)"
                >
                  {{ shortcut.currentShortcut }}
                </div>
                <button
                  v-if="shortcut.currentShortcut !== shortcut.defaultShortcut"
                  class="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
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
                :class="autoLaunch ? 'bg-gray-900 dark:bg-white' : 'bg-gray-300 dark:bg-gray-600'"
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
                :class="player.minimizeToTray ? 'bg-gray-900 dark:bg-white' : 'bg-gray-300 dark:bg-gray-600'"
                @click="handleMinimizeToTrayToggle"
              >
                <div
                  class="absolute top-0.5 w-4 h-4 bg-white dark:bg-gray-900 rounded-full shadow transition-transform"
                  :class="player.minimizeToTray ? 'translate-x-5' : 'translate-x-0.5'"
                ></div>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="pt-2 pb-4">
        <div class="text-center space-y-1">
          <p class="text-gray-500 dark:text-gray-400 text-xs font-medium">Bilibili Music Player</p>
          <p class="text-gray-400 dark:text-gray-500 text-xs">基于 Tauri v2 + Vue 3</p>
        </div>
      </div>
    </div>
  </aside>
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
