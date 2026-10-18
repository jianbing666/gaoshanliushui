// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod audio_device;
mod commands;
mod models;

use commands::app_config;
use commands::data_dir;
use commands::db;
use commands::download_bilibili;
use commands::export;
use commands::global_shortcut;
use commands::history;
use commands::loudnorm;
use commands::memories;
use commands::migrate;
use commands::playlist;
use commands::scan_folder;
use commands::scan_images;
use commands::song;
use commands::toggle_mini_mode;
use commands::tray;
use commands::webview_memory;
use tauri_plugin_media::MediaExt;

use std::sync::Mutex;
use tauri::Emitter;
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

/// P4-1: 后台线程里循环尝试设置 WebView2 内存等级, 直到成功或确认不支持。
///
/// 为什么需要循环重试: with_webview 投递到主线程时, 如果正好赶上窗口
/// hide/show 的过渡期, 拿不到 CoreWebView2 的概率不低(实测约 20~30%)。
/// 每次尝试内部还带 3 次快速重试; 整体最多约 3 秒, 成功即退出。
fn spawn_memory_level_change(app: &tauri::AppHandle, low: bool) {
    let handle = app.clone();
    std::thread::spawn(move || {
        for _ in 0..12 {
            if webview_memory::set_memory_usage_low(&handle, low).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
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
            // P4-1: 窗口重新可见, 恢复 WebView2 正常内存等级
            spawn_memory_level_change(app, false);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_media::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(global_shortcut::ShortcutStore::default())
        .manage(AppSettings::default())
        .setup(|app| {
            // 初始化系统托盘
            if let Err(e) = tray::init_tray(app.handle()) {
                eprintln!("初始化系统托盘失败: {}", e);
            }

            // 注册全局快捷键
            if let Err(e) = global_shortcut::register_global_shortcuts(app.handle()) {
                eprintln!("注册全局快捷键失败: {}", e);
            }

            // 初始化数据目录 (必须在数据库之前，因为 db_path 依赖 data_dir)
            if let Err(e) = data_dir::init_data_dir(app.handle()) {
                eprintln!("[data_dir] 初始化数据目录失败，使用默认目录: {}", e);
            }

            // 初始化数据库 (所有表统一在一个连接中创建)
            if let Err(e) = db::init_db(app.handle(), |conn| {
                app_config::init_schema(conn)?;
                memories::init_schema(conn)?;
                migrate::init_schema(conn)?;
                playlist::init_schema(conn)?;
                history::init_history_schema(conn)?;
                Ok(())
            }) {
                eprintln!("[db] 初始化数据库失败, 相关功能将不可用: {}", e);
            }

            // 启动自愈: 修复数据目录迁移后残留的失效封面路径
            // (迁移代码已保证新迁移不再产生失效路径, 这里负责修复存量损坏数据)
            match db::with_conn(data_dir::repair_stale_cover_paths) {
                Ok(count) if count > 0 => {
                    eprintln!("[data_dir] 已修复 {} 条失效的封面路径", count);
                }
                Ok(_) => {}
                Err(e) => eprintln!("[data_dir] 封面路径自愈失败: {}", e),
            }

            // 启动回填: 把历史记录里的歌曲标识从路径哈希改为内容指纹
            // (旧写入端存的是 Song.id, 与 songs.song_hash 不是同一套标识)
            match db::with_conn(history::backfill_song_hash_from_path) {
                Ok(count) if count > 0 => {
                    eprintln!("[history] 已回填 {} 条历史记录的歌曲指纹", count);
                }
                Ok(_) => {}
                Err(e) => eprintln!("[history] 歌曲指纹回填失败: {}", e),
            }

            // 注册媒体控制事件回调 (将系统媒体按键事件转发到前端)
            let app_handle = app.handle().clone();
            app.media().set_event_handler(move |event| {
                use tauri_plugin_media::MediaControlEventType::*;
                let event_name = match event.event_type {
                    Play => "media://play",
                    Pause => "media://pause",
                    PlayPause => "media://playpause",
                    Stop => "media://stop",
                    Next => "media://next",
                    Previous => "media://previous",
                    _ => return,
                };
                let _ = app_handle.emit(event_name, ());
            });

            // 监听系统音频输出端点变化: 蓝牙耳机/耳机断开时通知前端自动暂停
            // (修复"断开蓝牙后依旧在后台偷跑播歌")
            #[cfg(target_os = "windows")]
            audio_device::start(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let settings = app.state::<AppSettings>();
                    let minimize = settings.minimize_to_tray.lock().unwrap();
                    if *minimize {
                        api.prevent_close();
                        let _ = window.hide();
                        // P4-1: 隐藏到托盘后降低 WebView2 内存目标
                        spawn_memory_level_change(app, true);
                    }
                }
                // 注意: 不在 Resized 里处理"最小化"。
                //   窗口创建阶段也可能触发 Resized, 曾观测到启动时被误设为 Low;
                //   而任务栏最小化本身已由 Chromium 的遮挡检测降级, 不需要额外干预。
                //   这里只在真正的"隐藏到托盘"(CloseRequested)与"重新显示"路径切换等级。
                // 兜底: 任何方式重新获得焦点都恢复正常等级
                tauri::WindowEvent::Focused(true) => {
                    spawn_memory_level_change(app, false);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder::scan_music_folder,
            scan_folder::clear_cover_cache,
            // P1: 存量曲库补齐 128px 缩略图(避免列表拿全尺寸封面解码)
            scan_folder::backfill_thumbnails,
            toggle_mini_mode::toggle_mini_mode,
            toggle_mini_mode::set_window_size,
            toggle_mini_mode::get_window_size,
            scan_images::scan_image_folder,
            global_shortcut::update_global_shortcut,
            tray::set_minimize_to_tray,
            download_bilibili::parse_bilibili_url,
            download_bilibili::download_bilibili_music,
            download_bilibili::read_batch_file,
            // 2026-07-14: WebView2 内存优化 (切歌时主动触发一次 major GC)
            webview_memory::clean_renderer_memory,
            // P4-1: 查询当前 WebView2 内存等级(诊断/自动化测试用)
            webview_memory::get_webview_memory_level,
            webview_memory::get_webview_memory_status,
            // Memory feature - 高山流水 v1.1: 回忆 CRUD + 导出
            memories::get_memory,
            memories::save_memory,
            memories::delete_memory,
            memories::export_memory,
            memories::list_all_memories,
            // 迁移 + 元数据修正
            migrate::reset_migration,
            migrate::update_song_metadata,
            migrate::set_song_favorite,
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
            history::get_display_history,
            history::get_play_history_stats,
            history::add_play_history,
            history::upsert_play_history,
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
            // 歌曲管理
            song::delete_song,
            // 阶段三: 批量响度归一化
            loudnorm::normalize_songs_loudness,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
