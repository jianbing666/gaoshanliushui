// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;

use commands::db;
use commands::scan_folder;
use commands::toggle_mini_mode;
use commands::global_shortcut;
use commands::scan_images;
use commands::tray;
use commands::download_bilibili;
use commands::webview_memory;
use commands::memories;
use commands::migrate;
use commands::playlist;
use commands::export;
use commands::history;
use commands::app_config;
use commands::data_dir;

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
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二个实例启动时，显示并聚焦主窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
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

            // 初始化数据目录 (必须在数据库之前，因为 db_path 依赖 data_dir)
            if let Err(e) = data_dir::init_data_dir(&app.handle()) {
                eprintln!("[data_dir] 初始化数据目录失败，使用默认目录: {}", e);
            }

            // 初始化数据库 (所有表统一在一个连接中创建)
            if let Err(e) = db::init_db(&app.handle(), |conn| {
                app_config::init_schema(conn)?;
                memories::init_schema(conn)?;
                migrate::init_schema(conn)?;
                playlist::init_schema(conn)?;
                history::init_history_schema(conn)?;
                Ok(())
            }) {
                eprintln!("[db] 初始化数据库失败, 相关功能将不可用: {}", e);
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
            scan_folder::clear_cover_cache,
            toggle_mini_mode::toggle_mini_mode,
            toggle_mini_mode::set_window_size,
            toggle_mini_mode::get_window_size,
            scan_images::scan_image_folder,
            global_shortcut::update_global_shortcut,
            tray::set_minimize_to_tray,
            download_bilibili::parse_bilibili_url,
            download_bilibili::download_bilibili_music,
            download_bilibili::read_batch_file,
            // 2026-07-14: WebView2 内存优化 (强制 GC + 渲染进程挂起)
            webview_memory::clean_renderer_memory,
            webview_memory::try_suspend_renderer,
            webview_memory::try_resume_renderer,
            webview_memory::is_renderer_suspended,
            // Memory feature - 高山流水 v1.1: 回忆 CRUD + 导出
            memories::get_memory,
            memories::save_memory,
            memories::delete_memory,
            memories::export_memory,
            memories::list_all_memories,
            // 迁移 + 元数据修正
            migrate::reset_migration,
            migrate::update_song_metadata,
            // 虚拟歌单
            playlist::get_all_playlists,
            playlist::create_playlist,
            playlist::delete_playlist,
            playlist::rename_playlist,
            playlist::add_song_to_playlist,
            playlist::remove_song_from_playlist,
            playlist::get_playlist_songs,
            playlist::load_default_playlist_songs,
            playlist::import_playlist_from_paths,
            playlist::export_playlist,
            // BUG 7: 通用文件导出 (绕过 fs plugin 权限限制)
            export::write_text_file,
            // 播放历史记录
            history::get_play_history,
            history::add_play_history,
            history::batch_add_play_history,
            history::update_play_history,
            history::delete_play_history,
            history::clear_play_history,
            // v1.2.0 - 数据目录管理
            data_dir::get_data_dir_info,
            data_dir::set_data_dir,
            data_dir::reset_data_dir,
            data_dir::get_data_usage,
            data_dir::open_data_dir,
            data_dir::clear_thumbnail_cache,
            data_dir::migrate_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
