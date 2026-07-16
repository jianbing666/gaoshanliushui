import { defineStore } from 'pinia'
import { ref, computed, watch, markRaw } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { ThemeMode, BackgroundSettings, FontSettings, FontFamily, DataDirInfo, FileUsage } from '@/types/song'
import { loadSettings, saveSettings, getSystemTheme } from '@/utils/storage'

/**
 * 设置域 store
 *
 * 包含:
 *   - 主题 (theme / setTheme / applyTheme)
 *   - 字体 (fontSettings / setFontFamily / setFontSize / setUseThemeColor / setCustomColor)
 *   - 背景图片 (background / scanBackgroundFolder / setBackgroundMode / 轮播定时器)
 *   - 频谱显示 (showSpectrum / spectrumQuality / 3 个 computed 配置 / spectrumPaused)
 *   - 最小化到托盘 (minimizeToTray / setMinimizeToTray)
 *   - 睡眠定时器 (sleepTimerEnabled / sleepTimerMinutes / sleepTimerRemaining)
 *   - 下载输出目录 (downloadOutputDir / setDownloadOutputDir)
 *   - 极致性能: 暂停/恢复所有非必要后台动画
 *
 * 不包含: 播放控制、UI 面板显隐、播放历史、统计
 */

const saved = loadSettings()

const defaultBackground: BackgroundSettings = {
  mode: 'none',
  imagePath: '',
  folderPath: '',
  imageList: [],
  currentImageIndex: 0,
  interval: 30,
  fit: 'cover',
  overlay: 0.3,
  scale: 100,
  positionX: 50,
  positionY: 50,
  blur: 0,
}

const defaultFontSettings: FontSettings = {
  family: 'system',
  size: 14,
  useThemeColor: true,
  customColor: '#333333',
}

export const useSettingsStore = defineStore('settings', () => {
  // ========== 主题 ==========
  const theme = ref<ThemeMode>((saved.theme as ThemeMode) ?? 'system')

  function applyTheme(themeMode: ThemeMode) {
    const actualTheme = themeMode === 'system' ? getSystemTheme() : themeMode
    if (actualTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  function setTheme(newTheme: ThemeMode) {
    theme.value = newTheme
    applyTheme(newTheme)
  }

  // ========== 背景图片 ==========
  const background = ref<BackgroundSettings>({
    ...defaultBackground,
    ...(saved.background as Partial<BackgroundSettings> || {}),
  })

  /** 背景轮播定时器 */
  let backgroundTimer: number | null = null

  /** 当前背景图片 URL(转换后) */
  const currentBackgroundUrl = computed(() => {
    if (background.value.mode === 'image' && background.value.imagePath) {
      return convertFileSrc(background.value.imagePath)
    }
    if (background.value.mode === 'folder' && background.value.imageList?.length) {
      const idx = background.value.currentImageIndex ?? 0
      const path = background.value.imageList[idx]
      return path ? convertFileSrc(path) : ''
    }
    return ''
  })

  function setBackgroundMode(mode: BackgroundSettings['mode']) {
    background.value.mode = mode
    if (mode === 'folder') {
      startBackgroundSlideshow()
    } else {
      stopBackgroundSlideshow()
    }
  }

  function setBackgroundImage(path: string) {
    background.value.imagePath = path
    background.value.mode = 'image'
    stopBackgroundSlideshow()
  }

  async function scanBackgroundFolder(folderPath: string) {
    try {
      const images = await invoke<string[]>('scan_image_folder', { folderPath })
      background.value.folderPath = folderPath
      background.value.imageList = images
      background.value.currentImageIndex = 0
      if (background.value.mode === 'folder') {
        startBackgroundSlideshow()
      }
      return images
    } catch (error) {
      console.error('扫描背景图片文件夹失败:', error)
      throw error
    }
  }

  function nextBackgroundImage() {
    if (!background.value.imageList?.length) return
    const len = background.value.imageList.length
    background.value.currentImageIndex =
      ((background.value.currentImageIndex ?? 0) + 1) % len
  }

  function prevBackgroundImage() {
    if (!background.value.imageList?.length) return
    const len = background.value.imageList.length
    background.value.currentImageIndex =
      ((background.value.currentImageIndex ?? 0) - 1 + len) % len
  }

  function startBackgroundSlideshow() {
    stopBackgroundSlideshow()
    if (
      background.value.mode !== 'folder' ||
      !background.value.imageList?.length
    ) return
    const interval = (background.value.interval ?? 30) * 1000
    backgroundTimer = window.setInterval(() => {
      nextBackgroundImage()
    }, interval)
  }

  function stopBackgroundSlideshow() {
    if (backgroundTimer !== null) {
      clearInterval(backgroundTimer)
      backgroundTimer = null
    }
  }

  function updateBackgroundSetting<K extends keyof BackgroundSettings>(
    key: K,
    value: BackgroundSettings[K]
  ) {
    ;(background.value as BackgroundSettings)[key] = value
    if (key === 'interval' && background.value.mode === 'folder') {
      startBackgroundSlideshow()
    }
  }

  // ========== 频谱设置 ==========
  const showSpectrum = ref<boolean>(Boolean(saved.showSpectrum ?? true))
  // Memory feature - 高山流水 v1.1: 是否在唱片上方显示 tag 弹幕 (默认开启)
  const showMemoryTags = ref<boolean>(Boolean(saved.showMemoryTags ?? true))
  type SpectrumQuality = 'high' | 'balanced' | 'low'
  // 旧数据兼容: 之前若保存过 spectrumLowPower, 平滑迁移到 'low' / 'balanced'
  const migratedQuality: SpectrumQuality =
    typeof saved.spectrumQuality === 'string'
      ? (saved.spectrumQuality as SpectrumQuality)
      : (saved.spectrumLowPower ? 'low' : 'balanced')
  const spectrumQuality = ref<SpectrumQuality>(migratedQuality)

  function setShowSpectrum(value: boolean) {
    showSpectrum.value = value
  }

  // Memory feature - 高山流水 v1.1: 切换弹幕显示
  function setShowMemoryTags(value: boolean) {
    showMemoryTags.value = value
  }

  function setSpectrumQuality(value: SpectrumQuality) {
    spectrumQuality.value = value
    // 切换频谱质量档位时触发 GC, 释放旧的频谱缓冲区等临时对象
    void invoke('clean_renderer_memory').catch(() => { /* 静默失败 */ })
  }

  const spectrumSampleInterval = computed(() => {
    if (spectrumQuality.value === 'high') return 16
    if (spectrumQuality.value === 'low') return 50
    return 33
  })
  const spectrumFftSize = computed(() => {
    if (spectrumQuality.value === 'high') return 2048
    if (spectrumQuality.value === 'low') return 512
    return 1024
  })
  const spectrumSmoothing = computed(() => {
    if (spectrumQuality.value === 'high') return 0.8
    if (spectrumQuality.value === 'low') return 0.5
    return 0.75
  })

  // ========== 频谱/动画暂停状态 ==========
  // 触发场景: 窗口最小化/切到后台/迷你模式
  // 暂停对象: 频谱采样 setTimeout + 背景轮播 setInterval
  const spectrumPaused = ref<boolean>(false)

  function pauseSpectrum() {
    spectrumPaused.value = true
  }

  function resumeSpectrum() {
    spectrumPaused.value = false
  }

  function pauseAllBackgroundAnimations() {
    spectrumPaused.value = true
    stopBackgroundSlideshow()
  }

  function resumeAllBackgroundAnimations() {
    spectrumPaused.value = false
    startBackgroundSlideshow()
  }

  // ========== 最小化到托盘 ==========
  const minimizeToTray = ref<boolean>(Boolean(saved.minimizeToTray ?? true))

  function setMinimizeToTray(value: boolean) {
    minimizeToTray.value = value
    invoke('set_minimize_to_tray', { enabled: value }).catch(console.error)
  }

  // 初始化时同步最小化到托盘设置到后端
  invoke('set_minimize_to_tray', { enabled: minimizeToTray.value }).catch(console.error)

  // ========== 睡眠定时器 ==========
  const sleepTimerEnabled = ref<boolean>(false)
  const sleepTimerMinutes = ref<number>(30)
  const sleepTimerRemaining = ref<number>(0)
  let sleepTimerInterval: ReturnType<typeof setInterval> | null = null

  function startSleepTimer(minutes?: number) {
    if (minutes !== undefined) {
      sleepTimerMinutes.value = minutes
    }
    sleepTimerRemaining.value = sleepTimerMinutes.value * 60
    sleepTimerEnabled.value = true
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval)
    }
    sleepTimerInterval = setInterval(() => {
      sleepTimerRemaining.value--
      if (sleepTimerRemaining.value <= 0) {
        stopSleepTimer()
        // 通过自定义事件通知 audioStore 暂停
        window.dispatchEvent(new CustomEvent('settings:sleep-timer-fire'))
      }
    }, 1000)
  }

  function stopSleepTimer() {
    sleepTimerEnabled.value = false
    sleepTimerRemaining.value = 0
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval)
      sleepTimerInterval = null
    }
  }

  function toggleSleepTimer() {
    if (sleepTimerEnabled.value) {
      stopSleepTimer()
    } else {
      startSleepTimer()
    }
  }

  function setSleepTimerMinutes(minutes: number) {
    sleepTimerMinutes.value = minutes
    if (sleepTimerEnabled.value) {
      sleepTimerRemaining.value = minutes * 60
    }
  }

  // ========== 下载输出目录 ==========
  const downloadOutputDir = ref<string>(String(saved.downloadOutputDir ?? ''))

  function setDownloadOutputDir(path: string) {
    downloadOutputDir.value = path
  }

  // ========== 数据目录管理 ==========
  const dataDirInfo = ref<DataDirInfo | null>(null)
  const dataUsageList = ref<FileUsage[]>([])
  const isDataDirLoading = ref(false)

  async function loadDataDirInfo() {
    isDataDirLoading.value = true
    try {
      const info = await invoke<DataDirInfo>('get_data_dir_info')
      dataDirInfo.value = info
      return info
    } catch (error) {
      console.error('获取数据目录信息失败:', error)
      throw error
    } finally {
      isDataDirLoading.value = false
    }
  }

  async function loadDataUsage() {
    try {
      const usage = await invoke<FileUsage[]>('get_data_usage')
      dataUsageList.value = usage
      return usage
    } catch (error) {
      console.error('获取数据使用量失败:', error)
      return []
    }
  }

  async function setCustomDataDir(path: string) {
    try {
      await invoke('set_data_dir', { path })
      await loadDataDirInfo()
      await loadDataUsage()
    } catch (error) {
      console.error('设置数据目录失败:', error)
      throw error
    }
  }

  async function resetDataDirToDefault() {
    try {
      await invoke('reset_data_dir')
      await loadDataDirInfo()
      await loadDataUsage()
    } catch (error) {
      console.error('恢复默认数据目录失败:', error)
      throw error
    }
  }

  async function openDataDirInExplorer() {
    try {
      await invoke('open_data_dir')
    } catch (error) {
      console.error('打开数据目录失败:', error)
      throw error
    }
  }

  async function clearDataCache() {
    try {
      const cleared = await invoke<number>('clear_thumbnail_cache')
      await loadDataUsage()
      return cleared
    } catch (error) {
      console.error('清除缓存失败:', error)
      throw error
    }
  }

  // ========== 记忆导出目录 ==========
  // BUG 6: 记忆备注导出文件夹, 持久化存储
  //   - 默认与音乐库文件夹一致 (library.folderPath)
  //   - 用户可在回忆抽屉中单独设置
  const memoryExportDir = ref<string>(String(saved.memoryExportDir ?? ''))

  function setMemoryExportDir(path: string) {
    memoryExportDir.value = path
  }

  // ========== 字体设置 ==========
  const fontSettings = ref<FontSettings>({
    ...defaultFontSettings,
    ...(saved.fontSettings as Partial<FontSettings> || {}),
  })

  // 字体映射 (markRaw 避免深 Proxy 包装)
  const fontFamilyMap: Record<FontFamily, string> = markRaw({
    system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    kaiti: '"KaiTi", "楷体", "STKaiti", serif',
    songti: '"SimSun", "宋体", "STSong", serif',
    fangsong: '"FangSong", "仿宋", "STFangsong", serif',
  })

  const currentFontFamily = computed(() => fontFamilyMap[fontSettings.value.family])
  const currentFontSize = computed(() => `${fontSettings.value.size}px`)
  const currentFontColor = computed(() =>
    fontSettings.value.useThemeColor
      ? ''
      : fontSettings.value.customColor || ''
  )

  function applyFontSettings() {
    const root = document.documentElement
    root.style.setProperty('--font-family', fontFamilyMap[fontSettings.value.family])
    root.style.setProperty('--font-size', `${fontSettings.value.size}px`)
    if (!fontSettings.value.useThemeColor && fontSettings.value.customColor) {
      root.style.setProperty('--font-color', fontSettings.value.customColor)
      root.classList.add('custom-font-color')
    } else {
      root.style.removeProperty('--font-color')
      root.classList.remove('custom-font-color')
    }
  }

  function setFontFamily(family: FontFamily) {
    fontSettings.value.family = family
    applyFontSettings()
  }

  function setFontSize(size: number) {
    fontSettings.value.size = Math.max(12, Math.min(24, size))
    applyFontSettings()
  }

  function setUseThemeColor(use: boolean) {
    fontSettings.value.useThemeColor = use
    applyFontSettings()
  }

  function setCustomColor(color: string) {
    fontSettings.value.customColor = color
    if (!fontSettings.value.useThemeColor) {
      applyFontSettings()
    }
  }

  // ========== 持久化(防抖) ==========
  let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    [theme, background, minimizeToTray, fontSettings, showSpectrum, spectrumQuality, downloadOutputDir, showMemoryTags, memoryExportDir],
    ([th, bg, mt, fs, spectrum, spectrumQualityVal, dlDir, showMemTags, memDir]) => {
      if (settingsSaveTimer) {
        clearTimeout(settingsSaveTimer)
      }
      settingsSaveTimer = setTimeout(() => {
        saveSettings({
          theme: th,
          background: bg,
          minimizeToTray: mt,
          fontSettings: fs,
          showSpectrum: spectrum,
          spectrumQuality: spectrumQualityVal,
          downloadOutputDir: dlDir,
          showMemoryTags: showMemTags,
          memoryExportDir: memDir,
        })
      }, 300)
    },
    { deep: true, flush: 'post' }
  )

  // ========== 初始化(应用保存的设置到 DOM) ==========
  applyTheme(theme.value)
  applyFontSettings()

  // 监听系统主题变化(仅在 'system' 模式下生效)
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (_e) => {
      if (theme.value === 'system') {
        applyTheme('system')
      }
    })
  }

  return {
    // 主题
    theme,
    setTheme,
    // 字体
    fontSettings,
    currentFontFamily,
    currentFontSize,
    currentFontColor,
    setFontFamily,
    setFontSize,
    setUseThemeColor,
    setCustomColor,
    // 背景
    background,
    currentBackgroundUrl,
    setBackgroundMode,
    setBackgroundImage,
    scanBackgroundFolder,
    nextBackgroundImage,
    prevBackgroundImage,
    updateBackgroundSetting,
    // 频谱
    showSpectrum,
    spectrumQuality,
    spectrumSampleInterval,
    spectrumFftSize,
    spectrumSmoothing,
    setShowSpectrum,
    setSpectrumQuality,
    spectrumPaused,
    pauseSpectrum,
    resumeSpectrum,
    pauseAllBackgroundAnimations,
    resumeAllBackgroundAnimations,
    // Memory feature - 高山流水 v1.1: 弹幕显示开关
    showMemoryTags,
    setShowMemoryTags,
    // 托盘
    minimizeToTray,
    setMinimizeToTray,
    // 睡眠定时器
    sleepTimerEnabled,
    sleepTimerMinutes,
    sleepTimerRemaining,
    startSleepTimer,
    stopSleepTimer,
    toggleSleepTimer,
    setSleepTimerMinutes,
    // 下载
    downloadOutputDir,
    setDownloadOutputDir,
    // 数据目录管理
    dataDirInfo,
    dataUsageList,
    isDataDirLoading,
    loadDataDirInfo,
    loadDataUsage,
    setCustomDataDir,
    resetDataDirToDefault,
    openDataDirInExplorer,
    clearDataCache,
    // 记忆导出
    memoryExportDir,
    setMemoryExportDir,
  }
})
