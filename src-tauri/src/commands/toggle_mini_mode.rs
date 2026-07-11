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
        window.set_size(tauri::LogicalSize::new(320.0, 80.0))
            .map_err(|e| format!("设置窗口大小失败: {}", e))?;
        window.set_always_on_top(true)
            .map_err(|e| format!("设置置顶失败: {}", e))?;
        window.set_decorations(false)
            .map_err(|e| format!("设置无边框失败: {}", e))?;
    } else {
        // 切换回正常模式
        window.set_size(tauri::LogicalSize::new(1200.0, 800.0))
            .map_err(|e| format!("设置窗口大小失败: {}", e))?;
        window.set_always_on_top(false)
            .map_err(|e| format!("取消置顶失败: {}", e))?;
        window.set_decorations(true)
            .map_err(|e| format!("设置边框失败: {}", e))?;
    }

    Ok(is_mini)
}