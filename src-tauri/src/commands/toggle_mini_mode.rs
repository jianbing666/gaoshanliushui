use tauri::{AppHandle, Manager};

/// 切换迷你模式：调整窗口大小和置顶状态
#[tauri::command]
pub async fn toggle_mini_mode(
    app: AppHandle,
    is_mini: bool,
) -> Result<bool, String> {
    let window = app.get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;

    if is_mini {
        // 切换到迷你模式
        // 设置初始建议尺寸为 472x112，同时允许用户自由调整大小（最小 472x112，最大 600x400）
        window.set_size(tauri::LogicalSize::new(472.0, 112.0))
            .map_err(|e| format!("设置窗口大小失败: {}", e))?;
        window.set_min_size(Some(tauri::LogicalSize::new(472.0, 112.0)))
            .map_err(|e| format!("设置最小尺寸失败: {}", e))?;
        window.set_max_size(Some(tauri::LogicalSize::new(600.0, 400.0)))
            .map_err(|e| format!("设置最大尺寸失败: {}", e))?;
        window.set_always_on_top(true)
            .map_err(|e| format!("设置置顶失败: {}", e))?;
        window.set_decorations(false)
            .map_err(|e| format!("设置无边框失败: {}", e))?;
    } else {
        // 切换回正常模式
        window.set_size(tauri::LogicalSize::new(1200.0, 800.0))
            .map_err(|e| format!("设置窗口大小失败: {}", e))?;
        window.set_min_size(Some(tauri::LogicalSize::new(800.0, 600.0)))
            .map_err(|e| format!("设置最小尺寸失败: {}", e))?;
        let _ = window.set_max_size(None::<tauri::LogicalSize<f64>>);
        window.set_always_on_top(false)
            .map_err(|e| format!("取消置顶失败: {}", e))?;
        // 保持无边框（使用自定义标题栏）
        window.set_decorations(false)
            .map_err(|e| format!("设置无边框失败: {}", e))?;
    }

    Ok(is_mini)
}