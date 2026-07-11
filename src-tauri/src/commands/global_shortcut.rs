use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 注册全局快捷键
/// Ctrl+Alt+P: 暂停/播放切换
pub fn register_global_shortcuts(app: &AppHandle) -> Result<(), String> {
    let shortcut = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT),
        Code::KeyP,
    );

    app.global_shortcut()
        .on_shortcut(shortcut, move |app_handle, _shortcut, event| {
            // 只响应按下事件，忽略释放事件
            if event.state == ShortcutState::Pressed {
                let _ = app_handle.emit("global-shortcut:toggle-play", ());
            }
        })
        .map_err(|e| format!("注册全局快捷键失败: {}", e))?;

    Ok(())
}
