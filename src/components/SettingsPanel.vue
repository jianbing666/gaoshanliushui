<script setup lang="ts">
import { usePlayerStore } from '@/stores/playerStore'
import { open } from '@tauri-apps/plugin-dialog'
import type { ThemeMode } from '@/types/song'
import { useShortcutConfig } from '@/composables/useShortcutConfig'
import { useAutoLaunch } from '@/composables/useAutoLaunch'
import { ref, onMounted, onUnmounted } from 'vue'

const player = usePlayerStore()

// 主题选项配置
const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

// 使用快捷键配置 composable
const {
  shortcuts,
  editingShortcut,
  loading: shortcutLoading,
  startEdit,
  cancelEdit,
  updateShortcut,
  resetToDefault,
  resetAllToDefault,
  handleKeyDown,
} = useShortcutConfig()

// 使用开机自启 composable
const {
  autoLaunch,
  loading: autoLaunchLoading,
  toggleAutoLaunch,
} = useAutoLaunch()

// 选择数据目录
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

// 切换主题
function handleThemeChange(theme: ThemeMode) {
  player.setTheme(theme)
}

// 处理快捷键编辑的键盘事件
function handleShortcutKeyDown(event: KeyboardEvent, shortcutId: string) {
  const newShortcut = handleKeyDown(event)
  if (newShortcut) {
    updateShortcut(shortcutId, newShortcut)
  }
}

// 处理点击外部取消编辑
function handleClickOutside(event: MouseEvent) {
  if (editingShortcut.value) {
    cancelEdit()
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <aside class="w-[300px] bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-l border-gray-200/50 dark:border-gray-700/50 rounded-l-2xl shadow-lg flex flex-col h-full">
    <!-- 设置面板标题 -->
    <div class="p-4 border-b border-gray-200/50 dark:border-gray-700/50">
      <h2 class="text-gray-900 dark:text-white text-lg font-semibold">设置</h2>
    </div>

    <!-- 设置内容区域 -->
    <div class="flex-1 overflow-y-auto p-4 space-y-6">
      <!-- 主题切换模块 -->
      <div class="space-y-3">
        <h3 class="text-gray-700 dark:text-gray-300 text-sm font-medium">主题</h3>

        <!-- Segmented Control 样式的主题选择 -->
        <div class="bg-gray-100/50 dark:bg-gray-800/50 rounded-lg p-1 flex gap-1">
          <button
            v-for="option in themeOptions"
            :key="option.value"
            class="flex-1 px-3 py-2 rounded-md text-sm transition-all duration-200"
            :class="
              player.theme === option.value
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200/50 dark:hover:bg-gray-700/50 hover:scale-105'
            "
            @click="handleThemeChange(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <!-- 数据目录选择模块 -->
      <div class="space-y-3">
        <h3 class="text-gray-700 dark:text-gray-300 text-sm font-medium">数据目录</h3>

        <!-- 当前目录路径显示 -->
        <div class="space-y-2">
          <div class="bg-gray-100/50 dark:bg-gray-800/50 rounded-lg p-3">
            <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">当前音乐文件夹</p>
            <input
              type="text"
              readonly
              :value="player.folderPath || '未选择'"
              class="w-full bg-transparent text-gray-900 dark:text-white text-sm border-none outline-none focus:ring-2 focus:ring-blue-500 rounded px-2 py-1 transition-all"
            />
          </div>

          <!-- 选择文件夹按钮 -->
          <button
            class="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm transition-all duration-200 flex items-center justify-center hover:scale-105 shadow-md"
            :disabled="player.isLoading"
            @click="selectFolder"
          >
            <span v-if="player.isLoading" class="animate-spin">⟳</span>
            {{ player.isLoading ? '扫描中...' : '选择文件夹' }}
          </button>
        </div>
      </div>

      <!-- 快捷键配置模块 -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-gray-700 dark:text-gray-300 text-sm font-medium">快捷键</h3>
          <button
            class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
            @click="resetAllToDefault"
          >
            恢复全部默认
          </button>
        </div>

        <!-- 快捷键列表 -->
        <div class="space-y-2">
          <div
            v-for="shortcut in shortcuts"
            :key="shortcut.id"
            class="bg-gray-100/50 dark:bg-gray-800/50 rounded-lg p-3 space-y-2"
          >
            <div class="flex items-center justify-between">
              <div>
                <p class="text-gray-900 dark:text-white text-sm font-medium">{{ shortcut.action }}</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs">{{ shortcut.description }}</p>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <!-- 快捷键显示/编辑 -->
              <div
                v-if="editingShortcut === shortcut.id"
                class="flex-1 relative"
                @click.stop
              >
                <input
                  type="text"
                  readonly
                  value="按下新快捷键..."
                  class="w-full bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm border-2 border-blue-500 rounded px-3 py-2 focus:outline-none"
                  @keydown="handleShortcutKeyDown($event, shortcut.id)"
                  @blur="cancelEdit"
                  ref="editInput"
                />
              </div>
              <div v-else class="flex-1 flex items-center gap-2">
                <div
                  class="flex-1 bg-white dark:bg-gray-700 rounded px-3 py-2 text-gray-900 dark:text-white text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
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

      <!-- 开机自启模块 -->
      <div class="space-y-3">
        <h3 class="text-gray-700 dark:text-gray-300 text-sm font-medium">开机自启</h3>

        <div class="bg-gray-100/50 dark:bg-gray-800/50 rounded-lg p-3">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-900 dark:text-white text-sm font-medium">自动启动</p>
              <p class="text-gray-500 dark:text-gray-400 text-xs">开机时自动启动应用</p>
            </div>

            <!-- 开关按钮 -->
            <button
              class="relative w-12 h-6 rounded-full transition-colors duration-200"
              :class="autoLaunch ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
              :disabled="autoLaunchLoading"
              @click="toggleAutoLaunch"
            >
              <div
                class="absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200"
                :class="autoLaunch ? 'translate-x-7' : 'translate-x-1'"
              ></div>
            </button>
          </div>
        </div>
      </div>

      <!-- 应用信息 -->
      <div class="mt-6 pt-4 border-t border-gray-200/50 dark:border-gray-700/50">
        <div class="text-center space-y-2">
          <p class="text-gray-600 dark:text-gray-400 text-xs">Bilibili Music Player</p>
          <p class="text-gray-500 dark:text-gray-500 text-xs">基于 Tauri v2 + Vue 3</p>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 自定义动画和过渡效果 */
button {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

input:focus {
  outline: none;
}
</style>