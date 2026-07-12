import { ref, onMounted, onUnmounted } from 'vue'

/**
 * 音量滑块悬浮控制逻辑
 * 处理悬浮音量控制条的显示/隐藏和坐标计算
 */
export function useVolumeSlider() {
  const showVolumeSlider = ref(false)
  const volumeSliderPosition = ref({ x: 0, y: 0 })
  const isMouseOverSlider = ref(false)
  let hideTimeout: number | null = null

  /**
   * 显示音量滑块
   * 计算位置并显示悬浮控制条
   */
  function showVolumeControl(element: HTMLElement) {
    if (hideTimeout !== null) {
      clearTimeout(hideTimeout)
      hideTimeout = null
    }

    const rect = element.getBoundingClientRect()
    volumeSliderPosition.value = {
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
    }

    showVolumeSlider.value = true
  }

  /**
   * 隐藏音量滑块（带延迟，防止鼠标移动过程中闪烁）
   */
  function hideVolumeControl() {
    if (hideTimeout !== null) {
      clearTimeout(hideTimeout)
    }

    hideTimeout = window.setTimeout(() => {
      if (!isMouseOverSlider.value) {
        showVolumeSlider.value = false
      }
      hideTimeout = null
    }, 200)
  }

  /**
   * 立即隐藏音量滑块
   */
  function closeVolumeControl() {
    if (hideTimeout !== null) {
      clearTimeout(hideTimeout)
      hideTimeout = null
    }
    showVolumeSlider.value = false
    isMouseOverSlider.value = false
  }

  /**
   * 鼠标进入滑块区域
   */
  function handleMouseEnterSlider() {
    isMouseOverSlider.value = true
    if (hideTimeout !== null) {
      clearTimeout(hideTimeout)
      hideTimeout = null
    }
  }

  /**
   * 鼠标离开滑块区域
   */
  function handleMouseLeaveSlider() {
    isMouseOverSlider.value = false
    hideVolumeControl()
  }

  /**
   * 处理窗口缩放
   */
  function handleResize() {
    if (showVolumeSlider.value) {
      closeVolumeControl()
    }
  }

  onMounted(() => {
    window.addEventListener('resize', handleResize)
  })

  onUnmounted(() => {
    window.removeEventListener('resize', handleResize)
    if (hideTimeout !== null) {
      clearTimeout(hideTimeout)
    }
  })

  return {
    showVolumeSlider,
    volumeSliderPosition,
    showVolumeControl,
    hideVolumeControl,
    closeVolumeControl,
    handleMouseEnterSlider,
    handleMouseLeaveSlider,
  }
}
