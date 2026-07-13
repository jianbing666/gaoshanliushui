// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;

use commands::scan_folder;
use commands::toggle_mini_mode;
use commands::global_shortcut;
use commands::scan_images;
use commands::tray;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppSettings {
    pub minimize_to_tray: Mutex<bool>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            minimize_to_tray: Mutex::new(true),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(global_shortcut::ShortcutStore::default())
        .manage(AppSettings::default())
        .setup(|app| {
            // 初始化系统托盘
            if let Err(e) = tray::init_tray(&app.handle()) {
                eprintln!("初始化系统托盘失败: {}", e);
            }

            // 注册全局快捷键
            if let Err(e) = global_shortcut::register_global_shortcuts(app.handle()) {
                eprintln!("注册全局快捷键失败: {}", e);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let settings = app.state::<AppSettings>();
                let minimize = settings.minimize_to_tray.lock().unwrap();
                if *minimize {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder::scan_music_folder,
            toggle_mini_mode::toggle_mini_mode,
            scan_images::scan_image_folder,
            global_shortcut::update_global_shortcut,
            tray::set_minimize_to_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
