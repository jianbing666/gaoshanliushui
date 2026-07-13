use tauri::{AppHandle, Emitter, Manager};

/// 设置最小化到托盘选项
#[tauri::command]
pub fn set_minimize_to_tray(app: AppHandle, enabled: bool) -> Result<(), String> {
    let settings = app.state::<crate::AppSettings>();
    *settings.minimize_to_tray.lock().unwrap() = enabled;
    Ok(())
}

/// 初始化系统托盘
pub fn init_tray(app: &AppHandle) -> Result<(), String> {
    // 创建托盘菜单
    let tray_menu = tauri::menu::Menu::with_items(
        app,
        &[
            &tauri::menu::MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>).map_err(|e| e.to_string())?,
            &tauri::menu::PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &tauri::menu::MenuItem::with_id(app, "play-pause", "播放/暂停", true, None::<&str>).map_err(|e| e.to_string())?,
            &tauri::menu::MenuItem::with_id(app, "prev", "上一首", true, None::<&str>).map_err(|e| e.to_string())?,
            &tauri::menu::MenuItem::with_id(app, "next", "下一首", true, None::<&str>).map_err(|e| e.to_string())?,
            &tauri::menu::PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?,
        ],
    ).map_err(|e| e.to_string())?;

    // 创建托盘图标
    let mut builder = tauri::tray::TrayIconBuilder::with_id("main-tray");

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let _tray = builder
        .tooltip("高山流水音乐播放器")
        .menu(&tray_menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "show" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                "play-pause" => {
                    let _ = app.emit("global-shortcut:toggle-play", ());
                }
                "prev" => {
                    let _ = app.emit("global-shortcut:prev-track", ());
                }
                "next" => {
                    let _ = app.emit("global-shortcut:next-track", ());
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}
