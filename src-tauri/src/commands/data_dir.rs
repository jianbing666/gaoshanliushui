use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::app_config;

const CUSTOM_DATA_DIR_KEY: &str = "custom_data_dir";
const COVERS_DIR_NAME: &str = "covers";
const THUMBNAILS_DIR_NAME: &str = "thumbnails";
const BACKGROUNDS_DIR_NAME: &str = "backgrounds";

static DATA_DIR: OnceLock<Mutex<PathBuf>> = OnceLock::new();

#[derive(Serialize)]
pub struct DataDirInfo {
    pub current_path: String,
    pub is_custom: bool,
    pub default_path: String,
}

#[derive(Serialize)]
pub struct FileUsage {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub is_dir: bool,
}

fn default_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {}", e))
}

fn ensure_dir(path: &PathBuf) -> Result<(), String> {
    if !path.exists() {
        std::fs::create_dir_all(path)
            .map_err(|e| format!("创建目录失败 {:?}: {}", path, e))?;
    }
    Ok(())
}

pub fn init_data_dir(app: &AppHandle) -> Result<(), String> {
    let default_dir = default_data_dir(app)?;
    ensure_dir(&default_dir)?;

    let custom_path = app_config::get_config(CUSTOM_DATA_DIR_KEY)
        .ok()
        .flatten()
        .map(PathBuf::from);

    let data_dir = if let Some(custom) = custom_path {
        if custom.exists() && custom.is_dir() {
            custom
        } else {
            eprintln!("[data_dir] 自定义数据目录不存在，回退到默认目录: {:?}", custom);
            default_dir
        }
    } else {
        default_dir
    };

    ensure_dir(&data_dir)?;
    ensure_subdirs(&data_dir)?;

    let _ = DATA_DIR.set(Mutex::new(data_dir));
    Ok(())
}

fn ensure_subdirs(data_dir: &PathBuf) -> Result<(), String> {
    ensure_dir(&data_dir.join(COVERS_DIR_NAME))?;
    ensure_dir(&data_dir.join(THUMBNAILS_DIR_NAME))?;
    Ok(())
}

pub fn get_data_dir_path() -> Result<PathBuf, String> {
    DATA_DIR
        .get()
        .ok_or_else(|| "数据目录未初始化".to_string())
        .and_then(|m| {
            m.lock()
                .map(|p| p.clone())
                .map_err(|e| format!("数据目录锁失败: {}", e))
        })
}

pub fn get_covers_dir() -> Result<PathBuf, String> {
    Ok(get_data_dir_path()?.join(COVERS_DIR_NAME))
}

pub fn get_thumbnails_dir() -> Result<PathBuf, String> {
    Ok(get_data_dir_path()?.join(THUMBNAILS_DIR_NAME))
}

#[allow(dead_code)]
pub fn get_backgrounds_dir() -> Result<PathBuf, String> {
    let dir = get_data_dir_path()?.join(BACKGROUNDS_DIR_NAME);
    ensure_dir(&dir)?;
    Ok(dir)
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Ok(meta) = p.metadata() {
                    total += meta.len();
                }
            } else if p.is_dir() {
                total += dir_size(&p);
            }
        }
    }
    total
}

fn file_size(path: &std::path::Path) -> u64 {
    if let Ok(meta) = std::fs::metadata(path) {
        meta.len()
    } else {
        0
    }
}

#[tauri::command]
pub async fn get_data_dir_info(app: AppHandle) -> Result<DataDirInfo, String> {
    let current = get_data_dir_path()?;
    let default = default_data_dir(&app)?;
    let is_custom = app_config::get_config(CUSTOM_DATA_DIR_KEY)
        .ok()
        .flatten()
        .is_some();

    Ok(DataDirInfo {
        current_path: current.to_string_lossy().to_string(),
        is_custom,
        default_path: default.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn set_data_dir(_app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    if !target.is_dir() {
        return Err(format!("路径不是目录: {}", path));
    }

    ensure_subdirs(&target)?;

    app_config::set_config(CUSTOM_DATA_DIR_KEY, &path)?;

    if let Some(mutex) = DATA_DIR.get() {
        if let Ok(mut guard) = mutex.lock() {
            *guard = target;
        }
    }

    eprintln!("[data_dir] 数据目录已设置为: {}", path);
    Ok(())
}

#[tauri::command]
pub async fn reset_data_dir(app: AppHandle) -> Result<(), String> {
    let default = default_data_dir(&app)?;
    ensure_dir(&default)?;
    ensure_subdirs(&default)?;

    app_config::delete_config(CUSTOM_DATA_DIR_KEY)?;

    if let Some(mutex) = DATA_DIR.get() {
        if let Ok(mut guard) = mutex.lock() {
            *guard = default;
        }
    }

    eprintln!("[data_dir] 数据目录已恢复默认");
    Ok(())
}

#[tauri::command]
pub async fn get_data_usage() -> Result<Vec<FileUsage>, String> {
    let data_dir = get_data_dir_path()?;
    let mut usage = Vec::new();

    let db_path = data_dir.join("memories.db");
    if db_path.exists() {
        usage.push(FileUsage {
            name: "数据库".to_string(),
            path: db_path.to_string_lossy().to_string(),
            size_bytes: file_size(&db_path),
            is_dir: false,
        });
    }

    let wal_path = data_dir.join("memories.db-wal");
    if wal_path.exists() {
        usage.push(FileUsage {
            name: "数据库 WAL".to_string(),
            path: wal_path.to_string_lossy().to_string(),
            size_bytes: file_size(&wal_path),
            is_dir: false,
        });
    }

    let covers_dir = data_dir.join(COVERS_DIR_NAME);
    if covers_dir.exists() {
        usage.push(FileUsage {
            name: "封面图片".to_string(),
            path: covers_dir.to_string_lossy().to_string(),
            size_bytes: dir_size(&covers_dir),
            is_dir: true,
        });
    }

    let thumbs_dir = data_dir.join(THUMBNAILS_DIR_NAME);
    if thumbs_dir.exists() {
        usage.push(FileUsage {
            name: "缩略图缓存".to_string(),
            path: thumbs_dir.to_string_lossy().to_string(),
            size_bytes: dir_size(&thumbs_dir),
            is_dir: true,
        });
    }

    let bg_dir = data_dir.join(BACKGROUNDS_DIR_NAME);
    if bg_dir.exists() {
        usage.push(FileUsage {
            name: "背景图片".to_string(),
            path: bg_dir.to_string_lossy().to_string(),
            size_bytes: dir_size(&bg_dir),
            is_dir: true,
        });
    }

    usage.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(usage)
}

#[tauri::command]
pub async fn open_data_dir(_app: AppHandle) -> Result<(), String> {
    let path = get_data_dir_path()?;
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn clear_thumbnail_cache() -> Result<u64, String> {
    let thumbs_dir = get_thumbnails_dir()?;
    let mut cleared = 0u64;

    if thumbs_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&thumbs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Ok(meta) = path.metadata() {
                        cleared += meta.len();
                    }
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    let covers_dir = get_covers_dir()?;
    if covers_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&covers_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Ok(meta) = path.metadata() {
                        cleared += meta.len();
                    }
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    Ok(cleared)
}

// ========== 数据迁移 ==========

use std::path::Path;
use tauri::Emitter;

const DB_FILE: &str = "memories.db";
const DB_WAL_FILE: &str = "memories.db-wal";
const DB_SHM_FILE: &str = "memories.db-shm";
const COVERS_DIR: &str = "covers";
const THUMBNAILS_DIR: &str = "thumbnails";
const BACKGROUNDS_DIR: &str = "backgrounds";

#[derive(serde::Serialize, Clone)]
struct MigrateProgress {
    stage: String,
    current_file: String,
    processed_bytes: u64,
    total_bytes: u64,
    percent: f32,
}

fn collect_migrate_files(src_dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut files = Vec::new();

    let db_path = src_dir.join(DB_FILE);
    if db_path.exists() {
        if let Ok(meta) = db_path.metadata() {
            files.push((db_path, meta.len()));
        }
    }
    let wal_path = src_dir.join(DB_WAL_FILE);
    if wal_path.exists() {
        if let Ok(meta) = wal_path.metadata() {
            files.push((wal_path, meta.len()));
        }
    }
    let shm_path = src_dir.join(DB_SHM_FILE);
    if shm_path.exists() {
        if let Ok(meta) = shm_path.metadata() {
            files.push((shm_path, meta.len()));
        }
    }

    for subdir in &[COVERS_DIR, THUMBNAILS_DIR, BACKGROUNDS_DIR] {
        let dir = src_dir.join(subdir);
        if dir.exists() && dir.is_dir() {
            collect_dir_files(&dir, &mut files);
        }
    }

    files
}

fn collect_dir_files(dir: &Path, files: &mut Vec<(PathBuf, u64)>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(meta) = path.metadata() {
                    files.push((path, meta.len()));
                }
            } else if path.is_dir() {
                collect_dir_files(&path, files);
            }
        }
    }
}

fn copy_file_with_progress(
    src: &Path,
    dst: &Path,
    app: &AppHandle,
    processed_bytes: &mut u64,
    total_bytes: u64,
) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目标目录失败 {:?}: {}", parent, e))?;
    }

    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let mut src_file = std::fs::File::open(src)
        .map_err(|e| format!("打开源文件失败 {:?}: {}", src, e))?;
    let mut dst_file = std::fs::File::create(dst)
        .map_err(|e| format!("创建目标文件失败 {:?}: {}", dst, e))?;

    let mut buffer = [0u8; 64 * 1024];
    loop {
        let bytes_read = std::io::Read::read(&mut src_file, &mut buffer)
            .map_err(|e| format!("读取文件失败 {:?}: {}", src, e))?;
        if bytes_read == 0 {
            break;
        }
        std::io::Write::write_all(&mut dst_file, &buffer[..bytes_read])
            .map_err(|e| format!("写入文件失败 {:?}: {}", dst, e))?;
        *processed_bytes += bytes_read as u64;

        let percent = if total_bytes > 0 {
            (*processed_bytes as f32 / total_bytes as f32) * 100.0
        } else {
            100.0
        };

        let _ = app.emit(
            "data:migrate-progress",
            MigrateProgress {
                stage: "copying".to_string(),
                current_file: file_name.clone(),
                processed_bytes: *processed_bytes,
                total_bytes,
                percent,
            },
        );
    }

    Ok(())
}

fn verify_file(src: &Path, dst: &Path) -> Result<bool, String> {
    let src_meta = std::fs::metadata(src).map_err(|e| format!("读取源文件元数据失败: {}", e))?;
    let dst_meta = std::fs::metadata(dst).map_err(|e| format!("读取目标文件元数据失败: {}", e))?;
    Ok(src_meta.len() == dst_meta.len())
}

fn register_all_schemas(conn: &rusqlite::Connection) -> Result<(), String> {
    use crate::commands::{app_config, history, memories, migrate, playlist};
    app_config::init_schema(conn)?;
    memories::init_schema(conn)?;
    migrate::init_schema(conn)?;
    playlist::init_schema(conn)?;
    history::init_history_schema(conn)?;
    Ok(())
}

#[tauri::command]
pub async fn migrate_data(app: AppHandle, target_path: String) -> Result<(), String> {
    let target = PathBuf::from(&target_path);
    if !target.exists() {
        return Err(format!("目标目录不存在: {}", target_path));
    }
    if !target.is_dir() {
        return Err(format!("目标路径不是目录: {}", target_path));
    }

    let src_dir = get_data_dir_path()?;
    if src_dir == target {
        return Err("目标目录与当前目录相同".to_string());
    }

    // 检测目标目录是否可写
    let test_file = target.join(".write_test");
    if std::fs::write(&test_file, "test").is_err() {
        return Err("目标目录不可写，请检查权限".to_string());
    }
    let _ = std::fs::remove_file(&test_file);

    // 检测目标目录是否已有数据
    let target_has_data = target.join(DB_FILE).exists()
        || target.join(COVERS_DIR).exists()
        || target.join(THUMBNAILS_DIR).exists();
    if target_has_data {
        eprintln!("[data_dir] 目标目录已有数据，将覆盖同名文件");
    }

    eprintln!("[data_dir] 开始迁移: {:?} -> {:?}", src_dir, target);

    let _ = app.emit(
        "data:migrate-progress",
        MigrateProgress {
            stage: "preparing".to_string(),
            current_file: String::new(),
            processed_bytes: 0,
            total_bytes: 0,
            percent: 0.0,
        },
    );

    // 预估算总大小（用于 UI 展示初始进度）
    let preview_files = collect_migrate_files(&src_dir);
    let preview_total: u64 = preview_files.iter().map(|(_, s)| *s).sum();

    eprintln!("[data_dir] 预估待迁移文件数: {}, 总大小: {} bytes", preview_files.len(), preview_total);

    let _ = app.emit(
        "data:migrate-progress",
        MigrateProgress {
            stage: "checkpoint".to_string(),
            current_file: "保存数据库状态".to_string(),
            processed_bytes: 0,
            total_bytes: preview_total,
            percent: 0.0,
        },
    );

    // WAL checkpoint + 关闭连接
    // 注意: checkpoint TRUNCATE 会删除 WAL 文件，因此必须在此之后重新收集文件列表
    crate::commands::db::checkpoint()
        .map_err(|e| format!("数据库 checkpoint 失败: {}", e))?;

    crate::commands::db::close_connection()
        .map_err(|e| format!("关闭数据库连接失败: {}", e))?;

    // 关闭连接后重新收集实际文件列表（WAL/SHM 可能已被删除）
    let files = collect_migrate_files(&src_dir);
    let total_bytes: u64 = files.iter().map(|(_, s)| *s).sum();

    eprintln!("[data_dir] 实际待迁移文件数: {}, 总大小: {} bytes", files.len(), total_bytes);

    let mut processed_bytes: u64 = 0;
    let mut success = true;
    let mut error_msg = String::new();

    for (src_file, _) in &files {
        // 复制前再次确认文件存在（防止并发修改）
        if !src_file.exists() {
            eprintln!("[data_dir] 跳过不存在的文件: {:?}", src_file);
            continue;
        }

        let rel_path = match src_file.strip_prefix(&src_dir) {
            Ok(p) => p.to_path_buf(),
            Err(_) => src_file.file_name().map(|n| PathBuf::from(n)).unwrap_or_default(),
        };
        let dst_file = target.join(&rel_path);

        if let Err(e) = copy_file_with_progress(
            src_file,
            &dst_file,
            &app,
            &mut processed_bytes,
            total_bytes,
        ) {
            success = false;
            error_msg = e;
            break;
        }

        if !verify_file(src_file, &dst_file).unwrap_or(false) {
            success = false;
            error_msg = format!("文件校验失败: {:?}", rel_path);
            break;
        }
    }

    if !success {
        eprintln!("[data_dir] 迁移失败: {}", error_msg);

        if let Err(e) = crate::commands::db::reopen_connection(&app, register_all_schemas) {
            eprintln!("[data_dir] 恢复数据库连接失败: {}", e);
        }

        let _ = app.emit(
            "data:migrate-progress",
            MigrateProgress {
                stage: "failed".to_string(),
                current_file: error_msg.clone(),
                processed_bytes,
                total_bytes,
                percent: if total_bytes > 0 { (processed_bytes as f32 / total_bytes as f32) * 100.0 } else { 0.0 },
            },
        );

        return Err(error_msg);
    }

    let _ = app.emit(
        "data:migrate-progress",
        MigrateProgress {
            stage: "switching".to_string(),
            current_file: "切换到新目录".to_string(),
            processed_bytes: total_bytes,
            total_bytes,
            percent: 100.0,
        },
    );

    // 先切换内存中的数据目录路径
    if let Some(mutex) = DATA_DIR.get() {
        if let Ok(mut guard) = mutex.lock() {
            *guard = target.clone();
        }
    }

    // 用新路径重新打开数据库连接
    if let Err(e) = crate::commands::db::reopen_connection(&app, register_all_schemas) {
        eprintln!("[data_dir] 重新打开数据库失败: {}", e);

        // 失败则回滚路径
        if let Some(mutex) = DATA_DIR.get() {
            if let Ok(mut guard) = mutex.lock() {
                *guard = src_dir.clone();
            }
        }

        let _ = app.emit(
            "data:migrate-progress",
            MigrateProgress {
                stage: "failed".to_string(),
                current_file: format!("数据库重连失败: {}", e),
                processed_bytes: total_bytes,
                total_bytes,
                percent: 100.0,
            },
        );
        return Err(format!("数据库重连失败: {}", e));
    }

    // 数据库连接成功后，再写入配置到新数据库
    if let Err(e) = app_config::set_config(CUSTOM_DATA_DIR_KEY, &target_path) {
        eprintln!("[data_dir] 写入配置失败，但迁移已完成: {}", e);
    }

    let _ = app.emit(
        "data:migrate-progress",
        MigrateProgress {
            stage: "completed".to_string(),
            current_file: String::new(),
            processed_bytes: total_bytes,
            total_bytes,
            percent: 100.0,
        },
    );

    eprintln!("[data_dir] 迁移完成: {:?}", target);
    Ok(())
}
