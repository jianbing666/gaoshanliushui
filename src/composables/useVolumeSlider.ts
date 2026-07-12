import { ref, onMounted, onUnmounted } from 'vue'

/**
 * 音量滑块悬浮控制逻辑
 * 处理悬浮音量控制条的显示/隐藏和坐标计算
 */
export function useVolumeSlider() {
  const showVolumeSlider = ref(false)
  const volumeSliderPosition = ref({ x: 0, y: 0 })
  let hideTimeout: number | null = null
  let isMouseOverSlider = ref(false)

  /**
   * 显示音量滑块
   * 计算位置并显示悬浮控制条
   */
  function showVolumeControl(element: HTMLElement) {
    // 清除隐藏定时器
    if (hideTimeout !== null) {
      clearTimeout(hideTimeout)
      hideTimeout = null
    }

    // 计算元素相对于视口的位置
    const rect = element.getBoundingClientRect()
    volumeSliderPosition.value = {
      x: rect.left + rect.width / 2, // 水平居中
      y: rect.top - 10, // 向上偏移 10px
    }

    showVolumeSlider.value = true
  }

  /**
   * 隐藏音量滑块（带延迟）
   * 使用 300ms 延迟防止鼠标移动过程中闪烁
   */
  function hideVolumeControl() {
    if (hideTimeout !== null) {
      clearTimeout(hideTimeout)
    }

    hideTimeout = window.setTimeout(() => {
      // 只有当鼠标不在滑块上时才隐藏
      if (!isMouseOverSlider.value) {
        showVolumeSlider.value = false
      }
      hideTimeout = null
    }, 300)
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
    // 清除隐藏定时器
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
   * 处理窗口缩放时的坐标重算
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