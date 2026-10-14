use tauri::{AppHandle, Manager};

/// 迷你模式 / 正常模式的目标尺寸 (与前端 playerStore.ts 中常量保持一致)
/// 正常: 1200×800, 最小 800×600
/// 迷你: 472×112,  最小 472×112 / 最大 600×400
pub const NORMAL_MIN_SIZE: (f64, f64) = (800.0, 600.0);
pub const MINI_MIN_SIZE: (f64, f64) = (472.0, 112.0);
pub const MINI_MAX_SIZE: (f64, f64) = (600.0, 400.0);

/// 切换迷你模式 (仅处理"看不见的属性": 最小/最大尺寸、置顶、装饰)
///
/// **窗口尺寸不在此处设置**: 尺寸的过渡由前端的 rAF 动画通过 `set_window_size`
/// 在 320ms 内逐步插值完成。这样可以实现窗口尺寸的丝滑动画,而不是瞬间跳变。
///
/// **调用时序建议**:
///   1. 前端 setMiniMode() 立即切换 isMiniMode.value (让 Vue Transition 开始 UI 过渡)
///   2. 立即调用本命令,设置 min/max/decorations/always-on-top
///   3. 同时启动 rAF 循环,每 ~10ms 调用一次 set_window_size
///   4. 动画结束后由前端清理状态
#[tauri::command]
pub async fn toggle_mini_mode(app: AppHandle, is_mini: bool) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;

    if is_mini {
        // 切换到迷你模式
        window
            .set_min_size(Some(tauri::LogicalSize::new(
                MINI_MIN_SIZE.0,
                MINI_MIN_SIZE.1,
            )))
            .map_err(|e| format!("设置最小尺寸失败: {}", e))?;
        window
            .set_max_size(Some(tauri::LogicalSize::new(
                MINI_MAX_SIZE.0,
                MINI_MAX_SIZE.1,
            )))
            .map_err(|e| format!("设置最大尺寸失败: {}", e))?;
        window
            .set_always_on_top(true)
            .map_err(|e| format!("设置置顶失败: {}", e))?;
        window
            .set_decorations(false)
            .map_err(|e| format!("设置无边框失败: {}", e))?;
    } else {
        // 切换回正常模式
        window
            .set_min_size(Some(tauri::LogicalSize::new(
                NORMAL_MIN_SIZE.0,
                NORMAL_MIN_SIZE.1,
            )))
            .map_err(|e| format!("设置最小尺寸失败: {}", e))?;
        let _ = window.set_max_size(None::<tauri::LogicalSize<f64>>);
        window
            .set_always_on_top(false)
            .map_err(|e| format!("取消置顶失败: {}", e))?;
        // 保持无边框（使用自定义标题栏）
        window
            .set_decorations(false)
            .map_err(|e| format!("设置无边框失败: {}", e))?;
    }

    Ok(is_mini)
}

/// 设置窗口尺寸 (仅设置尺寸, 不影响其他属性)
///
/// 用于 rAF 动画: 前端在 320ms 内以 60fps 调用此命令,逐帧插值更新窗口大小。
/// 命令本身不做节流 (由前端控制调用频率), 保持每帧的逻辑一致。
#[tauri::command]
pub async fn set_window_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("设置窗口大小失败: {}", e))?;
    Ok(())
}

/// 获取当前窗口的逻辑尺寸 (DPI 缩放后的实际像素尺寸)
///
/// 返回 (width, height), 单位为 CSS 像素 (逻辑像素), 供前端 rAF 动画读取起点。
/// 注意: set_size 与 inner_size 在不同 DPI 下行为不同, 这里用 scale_factor 进行归一化。
#[tauri::command]
pub async fn get_window_size(app: AppHandle) -> Result<(f64, f64), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let size = window
        .inner_size()
        .map_err(|e| format!("获取窗口大小失败: {}", e))?;
    let scale = window
        .scale_factor()
        .map_err(|e| format!("获取缩放因子失败: {}", e))?;
    Ok((size.width as f64 / scale, size.height as f64 / scale))
}
