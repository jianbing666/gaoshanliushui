// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;

use commands::scan_folder;
use commands::toggle_mini_mode;
use commands::global_shortcut;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 注册全局快捷键
            if let Err(e) = global_shortcut::register_global_shortcuts(app.handle()) {
                eprintln!("注册全局快捷键失败: {}", e);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder::scan_music_folder,
            toggle_mini_mode::toggle_mini_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
