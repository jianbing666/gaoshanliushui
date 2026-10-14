use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::app_config;

const CUSTOM_DATA_DIR_KEY: &str = "custom_data_dir";
const BOOT_CONFIG_FILE: &str = "boot_config.json";
const COVERS_DIR_NAME: &str = "covers";
const THUMBNAILS_DIR_NAME: &str = "thumbnails";
const BACKGROUNDS_DIR_NAME: &str = "backgrounds";

static DATA_DIR: OnceLock<Mutex<PathBuf>> = OnceLock::new();

#[derive(Serialize, Deserialize, Default)]
struct BootConfig {
    custom_data_dir: Option<String>,
}

fn boot_config_path(default_dir: &Path) -> PathBuf {
    default_dir.join(BOOT_CONFIG_FILE)
}

fn read_boot_config(default_dir: &Path) -> BootConfig {
    let path = boot_config_path(default_dir);
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str::<BootConfig>(&content).unwrap_or_default(),
            Err(e) => {
                eprintln!("[data_dir] 读取启动配置失败: {}", e);
                BootConfig::default()
            }
        }
    } else {
        BootConfig::default()
    }
}

fn write_boot_config(default_dir: &Path, config: &BootConfig) -> Result<(), String> {
    ensure_dir(default_dir)?;
    let path = boot_config_path(default_dir);
    let content =
        serde_json::to_string_pretty(config).map_err(|e| format!("序列化启动配置失败: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("写入启动配置失败: {}", e))?;
    Ok(())
}

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

fn ensure_dir(path: &Path) -> Result<(), String> {
    if !path.exists() {
        std::fs::create_dir_all(path).map_err(|e| format!("创建目录失败 {:?}: {}", path, e))?;
    }
    Ok(())
}

pub fn init_data_dir(app: &AppHandle) -> Result<(), String> {
    let default_dir = default_data_dir(app)?;
    ensure_dir(&default_dir)?;

    let boot_config = read_boot_config(&default_dir);
    let custom_path = boot_config.custom_data_dir.map(PathBuf::from);

    let data_dir = if let Some(custom) = custom_path {
        if custom.exists() && custom.is_dir() {
            custom
        } else {
            eprintln!(
                "[data_dir] 自定义数据目录不存在，回退到默认目录: {:?}",
                custom
            );
            default_dir.clone()
        }
    } else {
        default_dir.clone()
    };

    ensure_dir(&data_dir)?;
    ensure_subdirs(&data_dir)?;

    let _ = DATA_DIR.set(Mutex::new(data_dir));
    Ok(())
}

fn ensure_subdirs(data_dir: &Path) -> Result<(), String> {
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
    let is_custom = current != default;

    Ok(DataDirInfo {
        current_path: current.to_string_lossy().to_string(),
        is_custom,
        default_path: default.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn set_data_dir(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    if !target.is_dir() {
        return Err(format!("路径不是目录: {}", path));
    }

    ensure_subdirs(&target)?;

    let default_dir = default_data_dir(&app)?;
    let mut boot_config = read_boot_config(&default_dir);
    boot_config.custom_data_dir = Some(path.clone());
    write_boot_config(&default_dir, &boot_config)?;

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

    let mut boot_config = read_boot_config(&default);
    boot_config.custom_data_dir = None;
    write_boot_config(&default, &boot_config)?;

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

    usage.sort_by_key(|item| std::cmp::Reverse(item.size_bytes));
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

use rusqlite::Connection;
use std::path::Path;
use tauri::Emitter;

const DB_FILE: &str = "memories.db";
const DB_WAL_FILE: &str = "memories.db-wal";
const DB_SHM_FILE: &str = "memories.db-shm";
const COVERS_DIR: &str = "covers";
const THUMBNAILS_DIR: &str = "thumbnails";
const BACKGROUNDS_DIR: &str = "backgrounds";

/// 需要跟随数据目录迁移而重写路径的列 (表名, 列名)
///
/// 只包含封面相关列。songs.song_path 与 play_history.song_path 指向用户的
/// 音乐库, 与数据目录迁移无关, 绝不能改写。
const COVER_PATH_COLUMNS: &[(&str, &str)] = &[
    ("songs", "cover_path"),
    ("songs", "cover_thumb_path"),
    ("play_history", "cover_path"),
    ("play_history", "cover_thumb_path"),
];

/// 迁移过程中会被整体复制的子目录
///
/// 只有位于这些子目录下的路径才真正属于数据目录, 才需要跟着迁移重写。
const MIGRATED_SUBDIRS: &[&str] = &[COVERS_DIR, THUMBNAILS_DIR];

/// 去掉路径末尾的分隔符
///
/// 例如 D:\Music\Bilibili\ 归一化为 D:\Music\Bilibili。
/// 盘符根 (D:\) 不去尾, 否则会退化成裸盘符 D:。
fn trim_trailing_separator(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() || trimmed.ends_with(':') {
        path
    } else {
        trimmed
    }
}

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

    let mut src_file =
        std::fs::File::open(src).map_err(|e| format!("打开源文件失败 {:?}: {}", src, e))?;
    let mut dst_file =
        std::fs::File::create(dst).map_err(|e| format!("创建目标文件失败 {:?}: {}", dst, e))?;

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

/// 迁移后重写库中的封面绝对路径, 返回被重写的行数
///
/// 背景:
///   covers/ 与 thumbnails/ 会被 migrate_data 整体复制到新数据目录, 但库里存的是
///   绝对路径。若不重写, 迁移后所有封面仍指向旧目录, 旧目录一旦被清理即全部 404;
///   而前端 onCoverError 只是静默隐藏 img 换成占位符, 用户看到的只是封面消失,
///   不会收到任何报错。
///
/// 为什么只匹配 covers/ 与 thumbnails/ 这两个子目录:
///   封面有两种来源 —— 数据目录下提取出的封面, 以及音乐库中与音频同名的同级图片
///   (见 scan_folder::find_sibling_cover_image)。当音乐库与数据目录是同一个文件夹时
///   (早期版本很容易出现这种配置), 裸前缀匹配会把用户的同级图片路径一并改写, 造成
///   真实的数据损坏。只有被迁移复制的子目录下的路径才应参与重写。
///
/// 为什么用 substr 而不是 LIKE:
///   路径中可能含下划线或百分号, 会命中 LIKE 的通配语义。这里改用精确前缀比较,
///   并要求前缀之后紧跟一个分隔符, 避免 covers 误匹配 covers_backup。
fn rewrite_cover_paths(
    conn: &Connection,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<usize, String> {
    let old_prefix = trim_trailing_separator(old_prefix);
    let new_prefix = trim_trailing_separator(new_prefix);

    if old_prefix.is_empty() || new_prefix.is_empty() || old_prefix == new_prefix {
        return Ok(0);
    }

    let mut rewritten = 0usize;

    for (table, column) in COVER_PATH_COLUMNS {
        for subdir in MIGRATED_SUBDIRS {
            let old_dir = format!("{}{}{}", old_prefix, std::path::MAIN_SEPARATOR, subdir);
            let sql = format!(
                "UPDATE {table}
                 SET {column} = ?1 || substr({column}, length(?2) + 1)
                 WHERE {column} != ''
                   AND substr({column}, 1, length(?3)) = ?3
                   AND substr({column}, length(?3) + 1, 1) IN ('\\', '/')"
            );

            // ?1 新前缀, ?2 旧前缀 (替换偏移), ?3 旧前缀+子目录 (命中范围)
            let affected = conn
                .execute(&sql, rusqlite::params![new_prefix, old_prefix, old_dir])
                .map_err(|e| format!("重写 {}.{} 失败: {}", table, column, e))?;

            rewritten += affected;
        }
    }

    Ok(rewritten)
}

/// 收集目录下的文件名集合 (仅一层, 封面/缩略图都是平铺存放)
///
/// 用一次 read_dir 换掉逐行检查文件是否存在, 避免启动时对上千首歌发起上千次
/// 文件系统调用 —— 那会直接吃掉冷启动预算。
fn collect_file_names(dir: &std::path::Path) -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                names.insert(name.to_string());
            }
        }
    }
    names
}

/// 修复某一列中指向旧目录的封面路径, 返回修复条数
///
/// 只处理"不在当前目录、但当前目录下有同名文件"的行, 不做逐行文件系统调用。
fn repair_column(
    conn: &Connection,
    table: &str,
    column: &str,
    dir: &std::path::Path,
    available: &std::collections::HashSet<String>,
) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT rowid, {column} FROM {table} WHERE {column} != ''"
        ))
        .map_err(|e| format!("准备查询失败: {}", e))?;

    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("查询失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取失败: {}", e))?;
    drop(stmt);

    let mut repaired = 0usize;
    for (rowid, old_path) in rows {
        let path = std::path::Path::new(&old_path);

        // 已经指向当前目录, 无需修复
        if path.parent() == Some(dir) {
            continue;
        }

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };

        // 当前目录下没有同名文件则无从修复 (例如封面本就来自音乐库的同级图片)
        if !available.contains(file_name) {
            continue;
        }

        let new_path = match dir.join(file_name).to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };

        conn.execute(
            &format!("UPDATE {table} SET {column} = ?1 WHERE rowid = ?2"),
            rusqlite::params![new_path, rowid],
        )
        .map_err(|e| format!("回写失败: {}", e))?;
        repaired += 1;
    }

    Ok(repaired)
}

/// 启动自愈: 修复指向已失效位置的封面路径
///
/// 场景:
///   rewrite_cover_paths 保证迁移后不再产生失效路径, 但已经损坏的存量数据需要
///   单独修复 —— 用户此前迁移过数据目录, 库里的绝对路径仍指着旧位置, 封面全 404。
///
/// 做法:
///   不复算封面文件名。封面文件名来自 scan_folder::generate_id, 而它基于
///   DefaultHasher, 该算法没有跨 Rust 版本的稳定性保证, 复算有落空的风险。
///   这里改为按库中已有的文件名, 到当前数据目录的 covers/ 与 thumbnails/ 下
///   查找同名文件, 命中即回写。
///
/// 开销: 2 次 read_dir + 若干次字符串比较, 不做逐行文件系统调用。
pub fn repair_stale_cover_paths(conn: &Connection) -> Result<usize, String> {
    let covers_dir = get_covers_dir()?;
    let thumbs_dir = get_thumbnails_dir()?;
    let covers = collect_file_names(&covers_dir);
    let thumbs = collect_file_names(&thumbs_dir);

    let mut repaired = 0usize;
    for (table, column, dir, available) in [
        ("songs", "cover_path", &covers_dir, &covers),
        ("songs", "cover_thumb_path", &thumbs_dir, &thumbs),
        ("play_history", "cover_path", &covers_dir, &covers),
        ("play_history", "cover_thumb_path", &thumbs_dir, &thumbs),
    ] {
        match repair_column(conn, table, column, dir, available) {
            Ok(n) => repaired += n,
            Err(e) => eprintln!("[data_dir] 修复 {}.{} 失败: {}", table, column, e),
        }
    }

    Ok(repaired)
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

    eprintln!(
        "[data_dir] 预估待迁移文件数: {}, 总大小: {} bytes",
        preview_files.len(),
        preview_total
    );

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
    crate::commands::db::checkpoint().map_err(|e| format!("数据库 checkpoint 失败: {}", e))?;

    crate::commands::db::close_connection().map_err(|e| format!("关闭数据库连接失败: {}", e))?;

    // 关闭连接后重新收集实际文件列表（WAL/SHM 可能已被删除）
    let files = collect_migrate_files(&src_dir);
    let total_bytes: u64 = files.iter().map(|(_, s)| *s).sum();

    eprintln!(
        "[data_dir] 实际待迁移文件数: {}, 总大小: {} bytes",
        files.len(),
        total_bytes
    );

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
            Err(_) => src_file.file_name().map(PathBuf::from).unwrap_or_default(),
        };
        let dst_file = target.join(&rel_path);

        if let Err(e) =
            copy_file_with_progress(src_file, &dst_file, &app, &mut processed_bytes, total_bytes)
        {
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
                percent: if total_bytes > 0 {
                    (processed_bytes as f32 / total_bytes as f32) * 100.0
                } else {
                    0.0
                },
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

    // 同时写入启动配置文件（确保下次启动时能读取到）
    if let Ok(default_dir) = default_data_dir(&app) {
        let mut boot_config = read_boot_config(&default_dir);
        boot_config.custom_data_dir = Some(target_path.clone());
        if let Err(e) = write_boot_config(&default_dir, &boot_config) {
            eprintln!("[data_dir] 写入启动配置失败: {}", e);
        }
    }

    // 重写库中封面相关的绝对路径
    //
    // covers/ 与 thumbnails/ 已随迁移复制到新目录, 但库里存的绝对路径仍指向旧目录,
    // 不重写的话迁移后所有封面都会 404。
    //
    // 走到这里迁移已经完成 (文件已复制、连接已切换), 失败无法回滚, 因此只告警不返回错误。
    let old_prefix = src_dir.to_string_lossy().to_string();
    let new_prefix = target.to_string_lossy().to_string();
    match crate::commands::db::with_conn(|conn| rewrite_cover_paths(conn, &old_prefix, &new_prefix))
    {
        Ok(count) if count > 0 => {
            eprintln!(
                "[data_dir] 已重写 {} 条封面路径: {} -> {}",
                count, old_prefix, new_prefix
            );
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("[data_dir] 封面路径重写失败, 封面可能失效: {}", e);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 用当前平台的分隔符拼接路径, 让用例在 Windows / macOS 下都能跑
    fn p(parts: &[&str]) -> String {
        let sep = std::path::MAIN_SEPARATOR.to_string();
        parts.join(&sep)
    }

    /// 旧数据目录 (迁移前)
    fn old_dir() -> String {
        p(&["D:", "Music", "Bilibili"])
    }

    /// 新数据目录 (迁移后)
    fn new_dir() -> String {
        p(&["E:", "GaoShanData"])
    }

    /// 建一个带完整 schema 的内存库 (与线上启动时注册的一致)
    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("打开内存库失败");
        crate::commands::migrate::init_schema(&conn).expect("初始化 songs schema 失败");
        crate::commands::history::init_history_schema(&conn).expect("初始化 history schema 失败");
        conn
    }

    fn insert_song(conn: &Connection, hash: &str, song_path: &str, cover: &str, thumb: &str) {
        conn.execute(
            "INSERT INTO songs
                (song_hash, song_path, title, artist, album, duration,
                 cover_path, cover_thumb_path, source, created_at, updated_at)
             VALUES (?1, ?2, 't', 'a', '', 0, ?3, ?4, 'test', 0, 0)",
            rusqlite::params![hash, song_path, cover, thumb],
        )
        .expect("插入歌曲失败");
    }

    fn insert_history(conn: &Connection, id: &str, hash: &str, cover: &str, thumb: &str) {
        conn.execute(
            "INSERT INTO play_history
                (id, song_hash, song_path, title, artist, album, duration,
                 cover_path, cover_thumb_path, played_at, played_duration, completed)
             VALUES (?1, ?2, 'x.mp3', 't', 'a', '', 0, ?3, ?4, 0, 0, 0)",
            rusqlite::params![id, hash, cover, thumb],
        )
        .expect("插入历史记录失败");
    }

    fn song_cover(conn: &Connection, hash: &str) -> (String, String) {
        conn.query_row(
            "SELECT cover_path, cover_thumb_path FROM songs WHERE song_hash = ?1",
            rusqlite::params![hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("查询歌曲封面失败")
    }

    fn history_cover(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT cover_path FROM play_history WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .expect("查询历史封面失败")
    }

    /// 核心用例: covers/ 与 thumbnails/ 下的绝对路径应跟随数据目录迁移
    #[test]
    fn test_rewrite_moves_covers_and_thumbnails() {
        let conn = setup_db();
        let old = old_dir();
        let new = new_dir();
        insert_song(
            &conn,
            "h1",
            &p(&[&old, "song.mp3"]),
            &p(&[&old, "covers", "abc.jpg"]),
            &p(&[&old, "thumbnails", "abc.jpg"]),
        );
        insert_history(&conn, "r1", "h1", &p(&[&old, "covers", "abc.jpg"]), "");

        let rewritten = rewrite_cover_paths(&conn, &old, &new).expect("重写失败");
        assert_eq!(rewritten, 3, "songs 两列 + play_history 一列都应被重写");

        let (cover, thumb) = song_cover(&conn, "h1");
        assert_eq!(cover, p(&[&new, "covers", "abc.jpg"]));
        assert_eq!(thumb, p(&[&new, "thumbnails", "abc.jpg"]));
        assert_eq!(history_cover(&conn, "r1"), p(&[&new, "covers", "abc.jpg"]));
    }

    /// 关键安全属性: 音乐库里的同级封面图片不能被改写
    ///
    /// 当音乐库与数据目录是同一个文件夹时 (早期版本很容易出现这种配置),
    /// 裸前缀匹配会把用户的同级图片一并改写, 造成真实的数据损坏。
    #[test]
    fn test_rewrite_leaves_music_library_paths_untouched() {
        let conn = setup_db();
        let old = old_dir();
        let new = new_dir();
        let sibling_cover = p(&[&old, "singer - song.jpg"]);
        let sibling_audio = p(&[&old, "singer - song.mp3"]);
        insert_song(
            &conn,
            "h1",
            &sibling_audio,
            &sibling_cover,
            &p(&[&old, "covers", "inner.jpg"]),
        );

        rewrite_cover_paths(&conn, &old, &new).expect("重写失败");

        let (cover, thumb) = song_cover(&conn, "h1");
        assert_eq!(cover, sibling_cover, "音乐库内的同级封面不应被改写");
        assert_eq!(
            thumb,
            p(&[&new, "covers", "inner.jpg"]),
            "数据目录内的缩略图应被改写"
        );

        let song_path: String = conn
            .query_row(
                "SELECT song_path FROM songs WHERE song_hash = 'h1'",
                [],
                |row| row.get(0),
            )
            .expect("查询歌曲路径失败");
        assert_eq!(song_path, sibling_audio, "song_path 指向音乐库, 不应被改写");
    }

    /// 前缀必须按路径段匹配: 相似前缀与相似目录名都不应命中
    #[test]
    fn test_rewrite_requires_exact_path_segment() {
        let conn = setup_db();
        let old = old_dir();
        let new = new_dir();
        let shorter_prefix = p(&["D:", "Music", "Bili", "covers", "a.jpg"]);
        let backup_dir = p(&[&old, "covers_backup", "b.jpg"]);
        insert_song(&conn, "short", "x.mp3", &shorter_prefix, "");
        insert_song(&conn, "backup", "y.mp3", &backup_dir, "");
        insert_song(&conn, "hit", "z.mp3", &p(&[&old, "covers", "c.jpg"]), "");

        let rewritten = rewrite_cover_paths(&conn, &old, &new).expect("重写失败");
        assert_eq!(rewritten, 1, "只有严格位于 covers/ 下的路径才应命中");

        assert_eq!(
            song_cover(&conn, "short").0,
            shorter_prefix,
            "相似前缀不应命中"
        );
        assert_eq!(
            song_cover(&conn, "backup").0,
            backup_dir,
            "covers_backup 不应命中"
        );
        assert_eq!(song_cover(&conn, "hit").0, p(&[&new, "covers", "c.jpg"]));
    }

    /// 幂等: 重复调用不应二次替换
    #[test]
    fn test_rewrite_is_idempotent() {
        let conn = setup_db();
        let old = old_dir();
        let new = new_dir();
        insert_song(&conn, "h1", "x.mp3", &p(&[&old, "covers", "a.jpg"]), "");

        assert_eq!(rewrite_cover_paths(&conn, &old, &new).unwrap(), 1);
        assert_eq!(
            rewrite_cover_paths(&conn, &old, &new).unwrap(),
            0,
            "第二次应为空操作"
        );
        assert_eq!(song_cover(&conn, "h1").0, p(&[&new, "covers", "a.jpg"]));
    }

    /// 旧目录带尾部分隔符时也应正确归一化
    #[test]
    fn test_rewrite_tolerates_trailing_separator() {
        let conn = setup_db();
        let old = old_dir();
        let new = new_dir();
        let old_with_sep = format!("{}{}", old, std::path::MAIN_SEPARATOR);
        insert_song(&conn, "h1", "x.mp3", &p(&[&old, "covers", "a.jpg"]), "");

        assert_eq!(rewrite_cover_paths(&conn, &old_with_sep, &new).unwrap(), 1);
        assert_eq!(song_cover(&conn, "h1").0, p(&[&new, "covers", "a.jpg"]));
    }

    /// 空路径与空封面不应被改写
    #[test]
    fn test_rewrite_ignores_empty_paths() {
        let conn = setup_db();
        let old = old_dir();
        insert_song(&conn, "h1", "x.mp3", "", "");

        assert_eq!(rewrite_cover_paths(&conn, &old, &new_dir()).unwrap(), 0);
        assert_eq!(song_cover(&conn, "h1"), (String::new(), String::new()));
    }

    /// 存量库 (无 cover_thumb_path 列) 应能通过 init_schema 补齐, 且可重复执行
    #[test]
    fn test_init_schema_adds_cover_thumb_path_to_legacy_db() {
        let conn = Connection::open_in_memory().expect("打开内存库失败");
        conn.execute_batch(
            "CREATE TABLE songs (
                song_hash  TEXT PRIMARY KEY,
                song_path  TEXT NOT NULL UNIQUE,
                title      TEXT NOT NULL,
                artist     TEXT NOT NULL,
                duration   INTEGER NOT NULL DEFAULT 0,
                cover_path TEXT NOT NULL DEFAULT '',
                source     TEXT NOT NULL DEFAULT 'legacy',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .expect("建旧表失败");
        conn.execute(
            "INSERT INTO songs
                (song_hash, song_path, title, artist, cover_path, created_at, updated_at)
             VALUES ('h1', 'x.mp3', 't', 'a', 'D:\\old\\covers\\a.jpg', 0, 0)",
            [],
        )
        .expect("插入存量数据失败");

        crate::commands::migrate::init_schema(&conn).expect("旧库应能补齐新列");
        crate::commands::migrate::init_schema(&conn).expect("重复执行应保持幂等");

        let (cover, thumb) = song_cover(&conn, "h1");
        assert_eq!(cover, "D:\\old\\covers\\a.jpg", "存量数据不应被破坏");
        assert_eq!(thumb, "", "新增列应取空字符串默认值");
    }

    /// play_history 的 schema 初始化同样应幂等, 且新列可读写
    #[test]
    fn test_init_history_schema_is_idempotent() {
        let conn = Connection::open_in_memory().expect("打开内存库失败");
        crate::commands::history::init_history_schema(&conn).expect("初始化失败");
        crate::commands::history::init_history_schema(&conn).expect("重复执行应保持幂等");

        insert_history(&conn, "r1", "h1", "c.jpg", "t.jpg");
        let thumb: String = conn
            .query_row(
                "SELECT cover_thumb_path FROM play_history WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .expect("查询失败");
        assert_eq!(thumb, "t.jpg");
    }

    /// 建一个临时目录 (调用方负责清理)
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let unique = format!(
            "gaoshanliushui-test-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    /// 自愈: 旧目录下的封面应按文件名被重新定位到当前数据目录
    #[test]
    fn test_repair_relocates_stale_cover_by_file_name() {
        let conn = setup_db();
        let covers = temp_dir("covers");
        std::fs::write(covers.join("abc.jpg"), b"x").expect("写入封面失败");

        let stale = p(&["D:", "OldPlace", "covers", "abc.jpg"]);
        insert_song(&conn, "h1", "x.mp3", &stale, "");

        let available = collect_file_names(&covers);
        let repaired =
            repair_column(&conn, "songs", "cover_path", &covers, &available).expect("修复失败");
        assert_eq!(repaired, 1);

        let expected = covers.join("abc.jpg").to_str().unwrap().to_string();
        assert_eq!(song_cover(&conn, "h1").0, expected);

        let _ = std::fs::remove_dir_all(&covers);
    }

    /// 自愈: 已在当前目录、或当前目录没有同名文件时都不应改动
    #[test]
    fn test_repair_skips_unknown_and_current_paths() {
        let conn = setup_db();
        let covers = temp_dir("covers-skip");
        std::fs::write(covers.join("known.jpg"), b"x").expect("写入封面失败");

        let current = covers.join("known.jpg").to_str().unwrap().to_string();
        let sibling = p(&["D:", "Music", "singer - song.jpg"]);
        insert_song(&conn, "h_current", "a.mp3", &current, "");
        insert_song(
            &conn,
            "h_stale",
            "b.mp3",
            &p(&["D:", "Old", "covers", "known.jpg"]),
            "",
        );
        insert_song(&conn, "h_sibling", "c.mp3", &sibling, "");

        let available = collect_file_names(&covers);
        let repaired =
            repair_column(&conn, "songs", "cover_path", &covers, &available).expect("修复失败");
        assert_eq!(repaired, 1, "只有旧目录下的已知文件应被修复");

        assert_eq!(
            song_cover(&conn, "h_current").0,
            current,
            "已正确的路径不应改动"
        );
        assert_eq!(
            song_cover(&conn, "h_sibling").0,
            sibling,
            "无从修复的路径不应改动"
        );
        assert_eq!(
            song_cover(&conn, "h_stale").0,
            current,
            "旧目录路径应被修复"
        );

        let _ = std::fs::remove_dir_all(&covers);
    }
}
