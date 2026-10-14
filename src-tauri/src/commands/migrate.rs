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
            cover_thumb_path TEXT NOT NULL DEFAULT '',
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

    // v3 迁移: 添加 cover_thumb_path 字段 (幂等)
    //
    // 背景: 缩略图路径此前只通过 scan:enrich-progress 事件推给前端, 从未落库,
    //   导致重启后前端拿不到缩略图、退化为全尺寸封面 (性能优化实际失效)。
    //   存量行为空字符串, 前端按"无缩略图"回退, 下次扫描时补齐。
    let _ = conn.execute(
        "ALTER TABLE songs ADD COLUMN cover_thumb_path TEXT NOT NULL DEFAULT ''",
        [],
    );

    // v4 迁移: 添加 favorite / favorited_at 字段 (幂等)
    //
    // 背景: 「喜爱」是智能随机权重的核心信号之一, 必须与歌曲库一起持久化。
    //   favorite 为 0/1 整数, favorited_at 记录最近一次标记喜爱的毫秒时间戳
    //   (用于智能随机的时间衰减)。两者的不变式: favorited_at != 0 等价于 favorite = 1。
    //   存量数据默认 0 / 0, 即"未喜爱", 不影响任何既有行为。
    let _ = conn.execute(
        "ALTER TABLE songs ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE songs ADD COLUMN favorited_at INTEGER NOT NULL DEFAULT 0",
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
            let title = rest.trim_start_matches([' ', '-']);
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
                if ext.eq_ignore_ascii_case("mp3") {
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
    let read_dir = std::fs::read_dir(music_path).map_err(|e| format!("读取音乐目录失败: {}", e))?;

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
                // INSERT OR IGNORE: 已存在的歌曲保持原样 —— 既不能覆盖用户手动修正的
                // title/artist, 也不能清掉 favorite / favorited_at (RESET 迁移重跑时曾会)
                "INSERT OR IGNORE INTO songs 
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
        std::fs::remove_file(&flag_path).map_err(|e| format!("删除 flag 文件失败: {}", e))?;
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

/// 写入喜爱状态 (抽成独立函数便于单测)
///
/// 不变式: favorite = 1 时 favorited_at 为本次操作时间戳; favorite = 0 时清零,
/// 避免非喜爱歌曲残留"最近喜爱时间"影响智能随机的时间衰减。
fn apply_favorite(
    conn: &rusqlite::Connection,
    song_hash: &str,
    favorite: bool,
    now: i64,
) -> Result<usize, String> {
    let favorited_at = if favorite { now } else { 0 };
    conn.execute(
        "UPDATE songs SET favorite = ?1, favorited_at = ?2, updated_at = ?3
         WHERE song_hash = ?4",
        params![favorite as i64, favorited_at, now, song_hash],
    )
    .map_err(|e| format!("更新喜爱状态失败: {}", e))
}

/// 标记/取消标记「喜爱」(智能随机的权重信号之一)
#[tauri::command]
pub async fn set_song_favorite(
    app: AppHandle,
    song_hash: String,
    favorite: bool,
) -> Result<(), String> {
    let now = db::now_ms();

    db::run_db(&app, move |conn| {
        apply_favorite(conn, &song_hash, favorite, now)?;
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

    /// 读取某首歌的喜爱状态 (favorite, favorited_at)
    fn read_favorite(conn: &rusqlite::Connection, hash: &str) -> (i64, i64) {
        conn.query_row(
            "SELECT favorite, favorited_at FROM songs WHERE song_hash = ?1",
            params![hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("查询喜爱状态失败")
    }

    /// 存量库 (无 favorite / favorited_at 列) 应能通过 init_schema 补齐, 且可重复执行
    #[test]
    fn test_init_schema_adds_favorite_columns_to_legacy_db() {
        let conn = rusqlite::Connection::open_in_memory().expect("打开内存库失败");
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
            "INSERT INTO songs (song_hash, song_path, title, artist, created_at, updated_at)
             VALUES ('h1', 'x.mp3', 't', 'a', 0, 0)",
            [],
        )
        .expect("插入存量数据失败");

        init_schema(&conn).expect("旧库应能补齐新列");
        init_schema(&conn).expect("重复执行应保持幂等");

        assert_eq!(read_favorite(&conn, "h1"), (0, 0), "存量数据默认为未喜爱");
    }

    /// 喜爱 / 取消喜爱应写入 favorite 与 favorited_at, 并维持两者不变式
    #[test]
    fn test_apply_favorite_toggles_state() {
        let conn = rusqlite::Connection::open_in_memory().expect("打开内存库失败");
        init_schema(&conn).expect("初始化 schema 失败");
        conn.execute(
            "INSERT INTO songs (song_hash, song_path, title, artist, created_at, updated_at)
             VALUES ('h1', 'x.mp3', 't', 'a', 0, 0)",
            [],
        )
        .expect("插入歌曲失败");

        assert_eq!(apply_favorite(&conn, "h1", true, 1000).unwrap(), 1);
        assert_eq!(read_favorite(&conn, "h1"), (1, 1000), "喜爱应记录时间戳");

        assert_eq!(apply_favorite(&conn, "h1", false, 2000).unwrap(), 1);
        assert_eq!(read_favorite(&conn, "h1"), (0, 0), "取消喜爱应清零时间戳");

        assert_eq!(
            apply_favorite(&conn, "missing", true, 3000).unwrap(),
            0,
            "不存在的歌曲不应报错, 影响行数为 0"
        );
    }
}
