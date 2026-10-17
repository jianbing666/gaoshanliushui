<script setup lang="ts">
import { useAudioStore } from '@/stores/audioStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'

import {
  ref,
  onMounted,
  onUnmounted,
  computed,
  nextTick,
  defineAsyncComponent,
  markRaw,
  watch,
} from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import Sidebar from '@/components/Sidebar.vue'
import Player from '@/components/Player.vue'
import ControlBar from '@/components/ControlBar.vue'
import TitleBar from '@/components/TitleBar.vue'

// ========== 阶段 3.6: 异步组件（首屏 JS 减 20-30KB）============
// 同步: 首屏必现
// 异步: 仅在用户首次打开对应面板/弹窗时下载独立 chunk
// BUG 2 修复: 用 markRaw 包装避免 reactive proxy, 提升 :is 渲染性能
const SettingsPanel = markRaw(defineAsyncComponent(() => import('@/components/SettingsPanel.vue')))
const StatsPanel = markRaw(defineAsyncComponent(() => import('@/components/StatsPanel.vue')))
const DownloadPanel = markRaw(defineAsyncComponent(() => import('@/components/DownloadPanel.vue')))
const EqualizerPanel = markRaw(
  defineAsyncComponent(() => import('@/components/EqualizerPanel.vue'))
)
const MemoryDrawer = markRaw(defineAsyncComponent(() => import('@/components/MemoryDrawer.vue')))
const CreatePlaylistModal = markRaw(
  defineAsyncComponent(() => import('@/components/CreatePlaylistModal.vue'))
)
const ConfirmDialog = markRaw(defineAsyncComponent(() => import('@/components/ConfirmDialog.vue')))
const InputContextMenu = markRaw(
  defineAsyncComponent(() => import('@/components/InputContextMenu.vue'))
)
const EditSongMetadata = markRaw(
  defineAsyncComponent(() => import('@/components/EditSongMetadata.vue'))
)
// P2: 右键菜单与历史抽屉按需加载(约 10KB + 4KB 从主入口移出; 都只在用户主动打开时出现)
const SongContextMenu = markRaw(
  defineAsyncComponent(() => import('@/components/SongContextMenu.vue'))
)
const PlaylistContextMenu = markRaw(
  defineAsyncComponent(() => import('@/components/PlaylistContextMenu.vue'))
)
const HistoryDrawer = markRaw(defineAsyncComponent(() => import('@/components/HistoryDrawer.vue')))
// P2: 迷你模式界面按需加载(约 5KB 布局代码移出主入口)
const MiniPlayer = markRaw(defineAsyncComponent(() => import('@/components/MiniPlayer.vue')))

const audio = useAudioStore()
const library = useLibraryStore()
const ui = useUIStore()
const settings = useSettingsStore()

const autoLoadError = ref<string | null>(null)

// 托盘菜单/全局快捷键/媒体键监听已统一由 main.ts 的 setupGlobalMediaListeners() 注册
// (P2: 改为动态 import, 不再从主入口静态引入 useMediaControls)

/** 右侧面板正在播放离开动画（用于把列宽留到 leave 结束，避免内容提前展开与面板重叠） */
const rightPanelLeaving = ref(false)

/*
  右侧面板组件映射（null = 当前没有面板）。
  此前这里是在模板里写五层嵌套三元 + 用 'div' 兜底，兜底的后果是：
  关闭状态下动画槽位被一个空 div 占着，重新打开时得等它先走完 250ms 的 leave
  面板才开始滑入 —— 那 250ms 就是"点了没反应"的顿感。
*/
const activeRightComponent = computed(() => {
  switch (ui.activeRightPanel) {
    case 'settings':
      return SettingsPanel
    case 'stats':
      return StatsPanel
    case 'download':
      return DownloadPanel
    case 'memory':
      return MemoryDrawer
    case 'equalizer':
      return EqualizerPanel
    default:
      return null
  }
})

let unlistenWindowShow: UnlistenFn | null = null
let unlistenMigrate: UnlistenFn | null = null
let unlistenScanComplete: UnlistenFn | null = null
let hiddenTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 播放历史 store 延迟加载(P2)
 * historyStore 约 11KB(压缩后 ~3KB), 启动与首屏不需要它;
 * 只有"加载历史 / 刷新统计 / 内存回收"这类动作才真正要它。
 */
async function loadHistoryStore() {
  const module = await import('@/stores/historyStore')
  return module.useHistoryStore()
}

// 切换迷你模式
function toggleMiniMode() {
  ui.setMiniMode(!ui.isMiniMode)
}

// 执行内存回收
function doCompactMemory() {
  try {
    library.compactMemory()
    void loadHistoryStore().then((store) => store.releaseFullHistory())
  } catch (e) {
    console.warn('[Memory] 内存回收失败:', e)
  }
}

// 处理窗口显示事件（从托盘恢复时）
function handleWindowShow() {
  // 恢复 AudioContext 运行状态
  audio.resumeAudioContext()
}

// 窗口尺寸监听(仅用于保持 ResizeObserver 生命周期; 迷你布局自身在 MiniPlayer 内跟踪)
let resizeObserver: ResizeObserver | null = null
function handleMiniResize() {
  // 迷你模式的紧凑判定已移到 MiniPlayer.vue, 这里保留空实现以维持观察器注册
}

// 进入迷你模式时触发内存回收
watch(
  () => ui.isMiniMode,
  (isMini) => {
    if (isMini) {
      // 延迟一点执行, 避免动画卡顿
      setTimeout(() => {
        doCompactMemory()
      }, 1000)
    }
  }
)

// 启动时自动加载音乐库
// 阶段 4.4: 启动时序优化 - 关键路径 first, 非关键路径 idle
// 首屏渲染完成后再加载音乐库 + 注册 IPC 监听, 避免阻塞首帧
onMounted(async () => {
  // 关键路径 0: 禁用 WebView2 默认右键菜单 (防止刷新/另存为/检查元素等)
  // 开发者后门: 按住 Shift 键右键时, 不阻止默认行为, 可打开原生菜单(含"检查")
  document.addEventListener('contextmenu', (e) => {
    if (!e.shiftKey) {
      e.preventDefault()
    }
  })

  // 关键路径 1: 立即让首屏可见
  await nextTick()

  // 关键路径 1.5: 立即从 SQLite 加载播放历史 (不等空闲时段)
  //   旧实现放在 requestIdleCallback 中, 启动后立刻播放的歌曲
  //   会因 dbLoaded=false 只写 localStorage, 产生落库竞态。
  //   loadFromDb 内部为异步 IPC, 此处不 await, 不阻塞后续 UI 初始化。
  void loadHistoryStore()
    .then((store) => store.loadFromDb())
    .catch((e) => console.warn('[App] 加载历史记录失败:', e))

  // 数据目录迁移完成后, 后端已重连到新库, 前端内存中的展示历史/统计需重新拉取,
  // 否则统计页停留在旧库口径 (弹窗关闭后本监听仍在 App 级生效)
  listen('data:migrate-progress', (event: any) => {
    if (event.payload?.stage === 'completed') {
      void loadHistoryStore().then((store) => store.reloadFromDb())
    }
  })
    .then((un) => {
      unlistenMigrate = un
    })
    .catch((e) => console.warn('[App] 注册迁移进度监听失败:', e))

  // 扫描补全封面/缩略图后同样需要重新拉取历史:
  //   后端在封面文件缺失时会把该字段清空再下发, 而重扫正是把这些文件重新生成出来。
  //   前端内存里的历史是启动时加载的那一份, 不重拉就会一直停在"封面已被清空"的状态,
  //   表现为历史抽屉里部分条目明明曲库里封面正常、这里却是空白。
  listen('scan:enrich-complete', () => {
    void loadHistoryStore().then((store) => store.reloadFromDb())
  })
    .then((un) => {
      unlistenScanComplete = un
    })
    .catch((e) => console.warn('[App] 注册扫描完成监听失败:', e))

  // 关键路径 2: 注册可见性监听 (轻量, 不阻塞)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  // Page Lifecycle: 页面被系统冻结/恢复 (比 visibilitychange 更强的挂起状态)
  document.addEventListener('resume', handlePageResume as EventListener)
  document.addEventListener('freeze', handlePageFreeze as EventListener)

  // 关键路径 3: 启动 ResizeObserver (cheap, 但仍放首屏后)
  resizeObserver = new ResizeObserver(handleMiniResize)
  resizeObserver.observe(document.documentElement)

  // 非关键路径: 推迟到浏览器空闲时段执行
  // timeout: 2000ms 保证即使不支持 requestIdleCallback 也能在 2s 内执行
  requestIdleCallback(
    async () => {
      // 1. 同步快捷键到后端
      //    原因: 后端 ShortcutStore 启动时用默认值, 如果用户在之前会话中修改过快捷键
      //    且未保存, 就会使用默认值. 同步步骤确保后端使用用户实际配置的快捷键.
      try {
        const { syncShortcutsToBackend } = await import('@/utils/syncShortcuts')
        await syncShortcutsToBackend()
      } catch (e) {
        console.warn('[App] 同步快捷键失败:', e)
      }

      // 2. 自动加载音乐库 (潜在 IPC + 扫描磁盘, 可能数百 ms)
      const result = await library.autoLoadMusicLibrary()
      if (!result.success && result.error) {
        autoLoadError.value = `音乐库路径已失效：${result.error}\n请在设置面板中重新选择目录`
        ui.toggleSettingsPanel()
      }

      // 2.5 P1: 补齐存量缩略图 (后端后台线程生成, 通过 scan:enrich-* 事件增量回推)
      //   列表只认真缩略图, 缺缩略图时先显示 ♪ 占位, 绝不再拿全尺寸封面顶替。
      void library.backfillThumbnails()

      // 3. 注册 Tauri 窗口显示事件 (IPC 通道建立, ~50ms)
      try {
        unlistenWindowShow = await listen('tauri://window-show', handleWindowShow)
      } catch (e) {
        console.warn('[App] 监听窗口显示事件失败:', e)
      }
    },
    { timeout: 2000 }
  )
})

// 极致性能: 窗口隐藏(最小化/切到后台/最小化到托盘)时
//   1. 恢复 AudioContext (浏览器自动挂起, 必须手动 resume)
//   2. 暂停所有非必要后台动画 (频谱 setTimeout / 背景轮播 / 封面旋转)
//   3. 隐藏超过 5 分钟后触发内存回收
// 重新可见时, 反向恢复
function handleVisibilityChange() {
  if (document.hidden) {
    // 窗口隐藏: 暂停频谱采样循环、背景轮播定时器, 让 CPU/GPU 进入空闲
    settings.pauseAllBackgroundAnimations()
    // 5 分钟后触发内存回收
    if (hiddenTimer) clearTimeout(hiddenTimer)
    hiddenTimer = setTimeout(
      () => {
        doCompactMemory()
      },
      5 * 60 * 1000
    )
  } else {
    // 清除隐藏超时定时器
    if (hiddenTimer) {
      clearTimeout(hiddenTimer)
      hiddenTimer = null
    }
    // 页面重新可见时:
    //   1. 恢复音频上下文 (浏览器在 hidden 时自动挂起)
    //   2. 恢复所有后台动画
    //   3. 播放状态对账: 后台期间若 onended 被节流/冻结吞掉,
    //      此处补走"自然播完"流程 (落历史 + 自动切歌)
    audio.resumeAudioContext()
    settings.resumeAllBackgroundAnimations()
    void audio.reconcilePlaybackState()
  }
}

// Page Lifecycle API: 页面进入 frozen 状态 (隐藏约 5 分钟后系统可能冻结 JS)
// freeze 时定时器/音频回调已被挂起, 无需处理; 关键是 resume 后对账。
function handlePageFreeze() {
  // 预留: 冻结前若需要 flush 任何状态可在此处理 (历史心跳无法在冻结时运行,
  // 已通过"开始即落库 + 15s 心跳"保证最多丢失 15s 数据)
}

function handlePageResume() {
  // 从 frozen 恢复: 唤醒 AudioContext, 并补对账被吞掉的播放结束事件
  audio.resumeAudioContext()
  settings.resumeAllBackgroundAnimations()
  void audio.reconcilePlaybackState()
}

onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  document.removeEventListener('resume', handlePageResume as EventListener)
  document.removeEventListener('freeze', handlePageFreeze as EventListener)
  unlistenWindowShow?.()
  unlistenMigrate?.()
  unlistenScanComplete?.()
  resizeObserver?.disconnect()
  // 全局清理播放历史心跳定时器, 释放其对 AudioEngine / 历史项的闭包引用
  void loadHistoryStore().then((store) => store.disposeHistory())
})
</script>

<template>
  <!-- 主容器：Flex 垂直布局 -->
  <!--
    这里刻意不再使用 transition-all:
    根容器的 class 会在 h-screen / h-full 之间切换(迷你模式), 对根容器做
    "所有属性" 过渡 = 每帧全应用重排; 窗口尺寸本身由 uiStore 的 rAF 动画负责,
    CSS 侧再叠一层高度过渡只会与它打架。
  -->
  <div
    class="flex flex-col bg-gradient-to-br from-gray-100 via-gray-50 to-gray-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 select-none overflow-hidden relative"
    :class="ui.isMiniMode ? 'h-full' : 'h-screen'"
  >
    <!-- 背景图片层 -->
    <div
      v-if="!ui.isMiniMode && settings.currentBackgroundUrl && settings.background.mode !== 'none'"
      class="background-layer absolute inset-0 pointer-events-none"
      :class="{ 'is-adjusting': settings.backgroundAdjusting }"
      :style="{
        backgroundImage: `url(${settings.currentBackgroundUrl})`,
        backgroundSize: settings.background.fit === 'repeat' ? 'auto' : settings.background.fit,
        backgroundPosition: `${settings.background.positionX}% ${settings.background.positionY}%`,
        backgroundRepeat: settings.background.fit === 'repeat' ? 'repeat' : 'no-repeat',
        transform: `scale(${settings.background.scale / 100})`,
        filter: `blur(${settings.background.blur}px)`,
      }"
    ></div>
    <!-- 背景遮罩层 -->
    <div
      v-if="!ui.isMiniMode && settings.currentBackgroundUrl && settings.background.mode !== 'none'"
      class="absolute inset-0 pointer-events-none bg-black transition-opacity duration-300"
      :style="{ opacity: settings.background.overlay }"
    ></div>

    <!-- 自定义标题栏（仅非迷你模式显示） -->
    <TitleBar
      v-if="!ui.isMiniMode"
      :show-mini-mode-button="true"
      :show-sidebar-button="true"
      @toggle-mini-mode="toggleMiniMode"
    />

    <!-- 主内容区域：Flex 水平三栏布局（非迷你模式） -->
    <div v-if="!ui.isMiniMode" class="flex-1 flex min-h-0 relative">
      <!-- 左侧面板：侧边栏 / 历史记录（互斥，挤压式） -->
      <Transition name="slide-left-fade" mode="out-in">
        <Sidebar v-if="ui.showSidebar && !ui.showHistoryDrawer" key="sidebar" class="shrink-0" />
        <HistoryDrawer v-else-if="ui.showHistoryDrawer" key="history" class="shrink-0" />
      </Transition>

      <!-- 中间播放器区域：flex-1 自适应宽度 -->
      <main class="flex-1 flex flex-col min-w-0 relative">
        <!-- Loading 遮罩层（自动扫描时显示） -->
        <div
          v-if="library.isLoading && library.playlist.length === 0"
          class="absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur flex items-center justify-center z-20"
        >
          <div class="text-center">
            <div class="animate-spin text-4xl mb-3">⟳</div>
            <p class="text-gray-700 dark:text-gray-300 text-sm">正在扫描音乐库...</p>
          </div>
        </div>

        <!-- 错误提示（路径失效时显示） -->
        <div
          v-if="autoLoadError && !library.isLoading"
          class="absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur flex items-center justify-center z-20"
        >
          <div class="text-center max-w-md px-4">
            <div class="text-5xl mb-4">⚠️</div>
            <p class="text-gray-900 dark:text-white text-sm leading-relaxed whitespace-pre-line">
              {{ autoLoadError }}
            </p>
          </div>
        </div>

        <!-- 中央封面展示区域（垂直水平居中） -->
        <div class="flex-1 flex items-center justify-center min-h-0 relative z-10">
          <Player />
        </div>

        <!-- 底部播放控制栏 -->
        <ControlBar class="shrink-0" />
      </main>

      <!--
        右侧面板：设置 / 统计 / 下载 / 回忆 / 均衡器（互斥，挤压式）
        单一状态管理: ui.activeRightPanel 直接控制当前显示的面板
        不使用 keep-alive 以节省内存, 低频面板每次打开重新渲染

        结构改造（修复"面板切换时中间内容弹一下又缩回"）：
        面板不再直接作为 flex 兄弟节点，而是放进一个"常驻列"，列内绝对定位。

        原因：面板直接做 flex 兄弟时，out-in 过渡会在"旧面板离开结束"释放 320px、
        又在"新面板进入开始"立刻占回 320px —— 中间内容因此瞬间右移再瞬间左移。
        但五个右面板都是 320px，切换前后布局需求完全相同，根本不该动。

        改完以后的三种情形：
          - 面板之间切换：列宽恒为 20rem，中间内容一帧都不动；
          - 打开：列宽立刻给到 20rem（同时面板开始滑入），内容一次性让位；
          - 关闭：列宽由 rightPanelLeaving 留住，直到 leave 结束才归零，
            所以内容是在面板滑走之后才展开，不会和面板重叠。
      -->
      <div
        class="right-panel-column relative shrink-0"
        :class="{ 'is-open': !!ui.activeRightPanel || rightPanelLeaving }"
      >
        <Transition
          name="slide-fade"
          mode="out-in"
          @before-leave="rightPanelLeaving = true"
          @after-leave="rightPanelLeaving = false"
        >
          <component
            :is="activeRightComponent"
            v-if="activeRightComponent"
            :key="ui.activeRightPanel || 'none'"
            class="absolute inset-y-0 right-0"
          />
        </Transition>
      </div>
    </div>

    <!-- 迷你模式(P2: 独立异步 chunk, 只在切换迷你模式时加载) -->
    <MiniPlayer v-if="ui.isMiniMode" />

    <SongContextMenu v-if="!ui.isMiniMode" />
    <PlaylistContextMenu v-if="!ui.isMiniMode" />

    <!-- 创建歌单弹窗 -->
    <CreatePlaylistModal v-if="!ui.isMiniMode" />

    <!-- 通用确认对话框 -->
    <ConfirmDialog v-if="!ui.isMiniMode" />

    <!-- 输入框右键菜单 -->
    <InputContextMenu v-if="!ui.isMiniMode" />

    <!-- 编辑歌曲元数据浮窗 -->
    <EditSongMetadata
      v-if="!ui.isMiniMode && ui.editMetadata.song"
      :song="ui.editMetadata.song"
      :visible="ui.editMetadata.visible"
      :x="ui.editMetadata.x"
      :y="ui.editMetadata.y"
      @close="ui.closeEditMetadata"
    />
  </div>
</template>

<style>
/*
  拖动"模糊程度 / 缩放比例"滑杆期间，背景图层临时上合成层：
  这是全屏尺寸 + filter: blur() 的一层，不提升时每次改参数都要在主线程
  重新栅格化整屏；提升后变化交给合成线程处理。松手后标记清除、层被回收，
  不会长期占着一张全屏纹理（4K 下就是几十 MB）。
*/
.background-layer.is-adjusting {
  will-change: transform, filter;
}

/*
  右侧面板的常驻列。
  宽度只在"有没有面板"这一层变化：面板之间切换时恒为 20rem，
  也就是切换前后布局需求完全一致 —— 这是"中间内容弹一下又缩回"的根因修复。

  宽度本身刻意不做过渡：
    1. 与左侧保持一致的一次性到位手感；
    2. 若给 width 加 CSS 过渡，它会和面板的 enter 过渡错开约 2 个 rAF
       （Vue 要等两帧才移除 enter-from 真正开始位移），反而会在开头露出一条缝。
  关闭时靠 rightPanelLeaving 把列宽留住到 leave 结束，因此内容是在面板滑走之后
  才展开，面板不会和展开后的内容重叠。

  两点注意：
    1. 20rem 必须与面板自身的 w-80 一致；
    2. 不要给这一列加 overflow-hidden —— 会把面板的 shadow-2xl 一起裁掉。
*/
.right-panel-column {
  width: 0;
}

.right-panel-column.is-open {
  width: 20rem;
}

/*
  抽屉滑入滑出动画（设置 / 统计 / 下载 / 回忆 / 均衡器 / 侧边栏 / 历史）

  改造点：
  1. 原来的 `transition: all` 会把 transform / opacity 之外的一切可动画属性
     都纳入过渡（含 width / height / 背景等），任何一次无关重渲染都可能被
     莫名其妙地"补间"一帧，也阻止了浏览器按已知属性做优化。
     现在显式声明 transform + opacity。
  2. 抽屉面板带 backdrop-filter，位移时 backdrop 需要逐帧重算 —— 这是本应用
     最贵的一段过渡。在过渡期间加 will-change: transform 让浏览器提前把它提升为
     合成层（只在动画期间付这份显存，结束后由浏览器回收）。
  3. 时长/缓动改走 main.css 里的 --motion-* 令牌，左右抽屉手感一致。
*/
.slide-fade-enter-active,
.slide-left-fade-enter-active {
  transition:
    transform var(--motion-duration-drawer) var(--motion-ease-out),
    opacity var(--motion-duration-base) var(--motion-ease-out);
}

.slide-fade-leave-active,
.slide-left-fade-leave-active {
  transition:
    transform 250ms var(--motion-ease-in),
    opacity var(--motion-duration-fast) var(--motion-ease-in);
}

.slide-fade-enter-active,
.slide-fade-leave-active,
.slide-left-fade-enter-active,
.slide-left-fade-leave-active {
  will-change: transform, opacity;
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

.slide-left-fade-enter-from,
.slide-left-fade-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}
</style>
