// 迁移脚本: 文件夹名 → SQLite 原始元数据
//
// 设计原则:
//   - 只读用户音乐目录, 绝不修改任何文件 (不动 mp3 / jpg / json)
//   - 幂等: 重复执行不会重复插入 (INSERT OR REPLACE + flag 文件)
//   - 失败兜底: try/catch + eprintln!, 不阻断主流程
//
// 文件夹名解析规则 (按优先级):
//   1. "歌手 - 歌名" (B站下载默认, 最常见)
//   2. "歌手-歌名" (无空格变体, artist 长度 sanity check 防误匹配)
//   3. 【活动/专辑】歌名 (cover: xxx)
//   4. UP主投稿:歌名
//   5. 兜底: 整段当歌名, 歌手=未知歌手

use std::path::Path;

use rusqlite::params;
use tauri::{AppHandle, Manager};

use crate::commands::db;
use crate::commands::song_hash::compute_content_hash;

/// 迁移 flag 文件名
const MIGRATE_FLAG: &str = "migrated_v1.flag";

/// 初始化 songs 表 schema (幂等)
pub fn init_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS songs (
            song_hash    TEXT    PRIMARY KEY,
            song_path    TEXT    NOT NULL UNIQUE,
            title        TEXT    NOT NULL,
            artist       TEXT    NOT NULL,
            album        TEXT    NOT NULL DEFAULT '',
            duration     INTEGER NOT NULL DEFAULT 0,
            cover_path   TEXT    NOT NULL DEFAULT '',
            source       TEXT    NOT NULL DEFAULT 'folder_migration',
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_songs_path ON songs(song_path);
        CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
        "#,
    )
    .map_err(|e| format!("初始化 songs schema 失败: {}", e))?;

    // v2 迁移: 添加 album 字段 (幂等)
    let _ = conn.execute(
        "ALTER TABLE songs ADD COLUMN album TEXT NOT NULL DEFAULT ''",
        [],
    );

    Ok(())
}

/// 从文件夹名解析 (artist, title)
///
/// 按优先级匹配, 都不命中则返回 ("未知歌手", name)
#[allow(dead_code)]
pub fn parse_folder_name(name: &str) -> (String, String) {
    let s = name.trim();

    // 1. "歌手 - 歌名" (B站下载默认, 最常见)
    if let Some(idx) = s.find(" - ") {
        let a = s[..idx].trim();
        let t = s[idx + 3..].trim();
        if !a.is_empty() && !t.is_empty() {
            return (a.to_string(), t.to_string());
        }
    }

    // 2. "歌手-歌名" (无空格变体, artist 长度 sanity check 防误匹配)
    if let Some(idx) = s.find('-') {
        let a = s[..idx].trim();
        let t = s[idx + 1..].trim();
        if !a.is_empty() && !t.is_empty() && a.len() < 60 {
            return (a.to_string(), t.to_string());
        }
    }

    // 3. 【活动/专辑】歌名 (cover：xxx)
    if s.starts_with('【') {
        if let Some(end) = s.find('】') {
            let inside = &s[3..end];
            let rest = &s[end + 3..];
            let title = rest.trim_start_matches(|c: char| c == ' ' || c == '-');
            let title = title.split("（cover").next().unwrap_or(title).trim();
            if !title.is_empty() {
                return (inside.to_string(), title.to_string());
            }
        }
    }

    // 4. UP主投稿：歌名
    if let Some(stripped) = s.strip_prefix("UP主投稿：") {
        return ("未知歌手".to_string(), stripped.trim().to_string());
    }

    // 5. 兜底: 整段当歌名
    ("未知歌手".to_string(), s.to_string())
}

/// 查找文件夹下第一个 mp3 文件
#[allow(dead_code)]
fn find_first_mp3(folder: &Path) -> Option<std::path::PathBuf> {
    let read_dir = std::fs::read_dir(folder).ok()?;
    for entry in read_dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext.to_ascii_lowercase() == "mp3" {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// 执行一次性迁移: 遍历音乐目录下所有子文件夹, 解析文件夹名写入 songs 表
///
/// 幂等: 已迁移过 (flag 文件存在) 则直接跳过
/// 返回: 迁移的歌曲数量
#[allow(dead_code)]
pub fn run_migration(music_folder: &str, app: &AppHandle) -> Result<usize, String> {
    let music_path = Path::new(music_folder);
    if !music_path.exists() || !music_path.is_dir() {
        return Err(format!("音乐目录不存在: {}", music_folder));
    }

    // 检查 flag, 已迁移则跳过
    let flag_path = match app.path().app_data_dir() {
        Ok(dir) => dir.join(MIGRATE_FLAG),
        Err(_) => return Err("无法获取 app_data_dir".to_string()),
    };
    if flag_path.exists() {
        eprintln!("[migrate] 已存在 flag, 跳过迁移");
        return Ok(0);
    }

    let now = db::now_ms();
    let mut songs_to_insert: Vec<(String, String, String, String)> = Vec::new();

    // 遍历所有子文件夹，收集数据
    let read_dir = std::fs::read_dir(music_path)
        .map_err(|e| format!("读取音乐目录失败: {}", e))?;

    for entry in read_dir.filter_map(|e| e.ok()) {
        let folder_path = entry.path();
        if !folder_path.is_dir() {
            continue;
        }

        let folder_name = match folder_path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };

        // 找第一个 mp3
        let mp3_path = match find_first_mp3(&folder_path) {
            Some(p) => p,
            None => continue,
        };

        let mp3_path_str = match mp3_path.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };

        // 计算 content_hash
        let content_hash = match compute_content_hash(&mp3_path) {
            Some(h) => h,
            None => continue,
        };

        // 解析文件夹名
        let (artist, title) = parse_folder_name(folder_name);

        songs_to_insert.push((content_hash, mp3_path_str, title, artist));
    }

    // 批量写入数据库
    let count = db::with_conn(|conn| {
        let mut inserted = 0usize;
        for (content_hash, mp3_path_str, title, artist) in &songs_to_insert {
            conn.execute(
                "INSERT OR REPLACE INTO songs 
                    (song_hash, song_path, title, artist, duration, cover_path, source, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    content_hash,
                    mp3_path_str,
                    title,
                    artist,
                    0,
                    "",
                    "folder_migration",
                    now,
                    now,
                ],
            )
            .map_err(|e| format!("写入 songs 表失败: {}", e))?;
            inserted += 1;
        }
        Ok(inserted)
    })?;

    // 写入 flag 文件
    let _ = std::fs::write(&flag_path, "");
    eprintln!("[migrate] 迁移完成，共处理 {} 首歌", count);

    Ok(count)
}

/// 触发重新迁移: 删除 flag 文件, 下次启动自动重跑
#[tauri::command]
pub async fn reset_migration(app: AppHandle) -> Result<(), String> {
    let flag_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {}", e))?
        .join(MIGRATE_FLAG);

    if flag_path.exists() {
        std::fs::remove_file(&flag_path)
            .map_err(|e| format!("删除 flag 文件失败: {}", e))?;
    }

    // 同时清空 songs 表
    db::run_db(&app, |conn| {
        conn.execute("DELETE FROM songs", [])
            .map_err(|e| format!("清空 songs 表失败: {}", e))?;
        Ok(())
    })
    .await?;

    eprintln!("[migrate] 已重置, 下次启动将重新迁移");
    Ok(())
}

/// 更新歌曲元数据 (任务4: 铅笔图标手动修正)
#[tauri::command]
pub async fn update_song_metadata(
    app: AppHandle,
    song_hash: String,
    title: String,
    artist: String,
    album: Option<String>,
) -> Result<(), String> {
    let title_trim = title.trim().to_string();
    let artist_trim = artist.trim().to_string();
    let album_trim = album.unwrap_or_default().trim().to_string();

    if title_trim.is_empty() || artist_trim.is_empty() {
        return Err("歌名和歌手名不能为空".to_string());
    }

    let now = db::now_ms();

    db::run_db(&app, move |conn| {
        conn.execute(
            "UPDATE songs SET title = ?1, artist = ?2, album = ?3, updated_at = ?4 
             WHERE song_hash = ?5",
            params![title_trim, artist_trim, album_trim, now, song_hash],
        )
        .map_err(|e| format!("更新歌曲元数据失败: {}", e))?;
        Ok(())
    })
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_bilibili_default() {
        let (a, t) = parse_folder_name("周杰伦 - 听妈妈的话");
        assert_eq!(a, "周杰伦");
        assert_eq!(t, "听妈妈的话");
    }

    #[test]
    fn test_parse_no_space() {
        let (a, t) = parse_folder_name("刀酱-520AM");
        assert_eq!(a, "刀酱");
        assert_eq!(t, "520AM");
    }

    #[test]
    fn test_parse_activity() {
        let (a, t) = parse_folder_name("【2024跨年晚会】夜空中最亮的星（cover：逃跑计划）");
        assert_eq!(a, "2024跨年晚会");
        assert_eq!(t, "夜空中最亮的星");
    }

    #[test]
    fn test_parse_up_upload() {
        let (a, t) = parse_folder_name("UP主投稿：原创歌曲demo");
        assert_eq!(a, "未知歌手");
        assert_eq!(t, "原创歌曲demo");
    }

    #[test]
    fn test_parse_fallback() {
        let (a, t) = parse_folder_name("随便一首歌");
        assert_eq!(a, "未知歌手");
        assert_eq!(t, "随便一首歌");
    }
}
