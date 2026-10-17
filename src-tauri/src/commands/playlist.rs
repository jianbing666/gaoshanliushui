// 虚拟歌单 - 基于 SQLite 的歌单管理
//
// 设计原则:
//   - 所有歌单数据存在 SQLite, 不再依赖 localStorage
//   - 使用 song_hash (content_hash) 关联歌曲, 用户移动文件后关联不失效
//   - 默认歌单 (is_default=1) 不可删除, 自动包含全部歌曲
//   - ON DELETE CASCADE: 删除歌曲/歌单时自动清理关联
//   - 所有操作幂等 (INSERT OR IGNORE)

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::db;
use crate::models::Song;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// 歌单数据结构 (前后端共享)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistRecord {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub is_default: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub song_count: i64,
}

/// 歌单中的歌曲 (带元数据)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistSong {
    pub song_hash: String,
    pub song_path: String,
    pub title: String,
    pub artist: String,
    pub duration: i64,
    pub cover_path: String,
    pub position: i64,
    pub added_at: i64,
}

/// 初始化 playlists 相关表 schema (幂等)
pub fn init_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS playlists (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            description TEXT    NOT NULL DEFAULT '',
            is_default  INTEGER NOT NULL DEFAULT 0,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playlist_songs (
            playlist_id INTEGER NOT NULL,
            song_hash   TEXT    NOT NULL,
            position    INTEGER NOT NULL DEFAULT 0,
            added_at    INTEGER NOT NULL,
            PRIMARY KEY (playlist_id, song_hash),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
            FOREIGN KEY (song_hash)   REFERENCES songs(song_hash)  ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist ON playlist_songs(playlist_id);
        CREATE INDEX IF NOT EXISTS idx_playlist_songs_song ON playlist_songs(song_hash);
        "#,
    )
    .map_err(|e| format!("初始化 playlists schema 失败: {}", e))?;

    // 初始化默认歌单 (幂等)
    let now = db::now_ms();
    conn.execute(
        "INSERT OR IGNORE INTO playlists (id, name, is_default, sort_order, created_at, updated_at)
         VALUES (1, '全部歌曲', 1, 0, ?1, ?2)",
        params![now, now],
    )
    .map_err(|e| format!("初始化默认歌单失败: {}", e))?;

    Ok(())
}

/// 获取所有歌单 (不含歌曲详情)
#[tauri::command]
pub async fn get_all_playlists(app: AppHandle) -> Result<Vec<PlaylistRecord>, String> {
    db::run_db(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.name, p.description, p.is_default, p.sort_order, p.created_at, p.updated_at,
                        COUNT(ps.song_hash) as song_count
                 FROM playlists p
                 LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
                 GROUP BY p.id
                 ORDER BY p.sort_order ASC, p.id ASC",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let playlists = stmt
            .query_map([], |row| {
                Ok(PlaylistRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    is_default: row.get::<_, i64>(3)? != 0,
                    sort_order: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    song_count: row.get(7)?,
                })
            })
            .map_err(|e| format!("查询歌单失败: {}", e))?;

        let mut result = Vec::new();
        for playlist in playlists {
            result.push(playlist.map_err(|e| format!("遍历歌单失败: {}", e))?);
        }
        Ok(result)
    })
    .await
}

/// 新建歌单
#[tauri::command]
pub async fn create_playlist(
    app: AppHandle,
    name: String,
    description: Option<String>,
) -> Result<i64, String> {
    let name_trim = name.trim().to_string();
    if name_trim.is_empty() {
        return Err("歌单名称不能为空".to_string());
    }

    let now = db::now_ms();
    let desc = description.unwrap_or_default();

    db::run_db(&app, move |conn| {
        // 获取最大 sort_order
        let max_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) FROM playlists WHERE is_default = 0",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        conn.execute(
            "INSERT INTO playlists (name, description, is_default, sort_order, created_at, updated_at)
             VALUES (?1, ?2, 0, ?3, ?4, ?5)",
            params![name_trim, desc, max_order + 1, now, now],
        )
        .map_err(|e| format!("创建歌单失败: {}", e))?;

        Ok(conn.last_insert_rowid())
    })
    .await
}

/// 删除歌单 (拒绝删除默认歌单)
#[tauri::command]
pub async fn delete_playlist(app: AppHandle, id: i64) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        // 检查是否是默认歌单
        let is_default: i64 = conn
            .query_row(
                "SELECT is_default FROM playlists WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| format!("查询歌单失败: {}", e))?;

        if is_default != 0 {
            return Err("不能删除默认歌单".to_string());
        }

        conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])
            .map_err(|e| format!("删除歌单失败: {}", e))?;

        Ok(())
    })
    .await
}

/// 重命名歌单
#[tauri::command]
pub async fn rename_playlist(app: AppHandle, id: i64, new_name: String) -> Result<(), String> {
    let name_trim = new_name.trim().to_string();
    if name_trim.is_empty() {
        return Err("歌单名称不能为空".to_string());
    }

    let now = db::now_ms();

    db::run_db(&app, move |conn| {
        conn.execute(
            "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name_trim, now, id],
        )
        .map_err(|e| format!("重命名歌单失败: {}", e))?;
        Ok(())
    })
    .await
}

/// 添加歌曲到歌单 (已存在则忽略)
#[tauri::command]
pub async fn add_song_to_playlist(
    app: AppHandle,
    playlist_id: i64,
    song_hash: String,
) -> Result<(), String> {
    let now = db::now_ms();

    db::run_db(&app, move |conn| {
        // 获取当前最大 position
        let max_pos: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) FROM playlist_songs WHERE playlist_id = ?1",
                params![playlist_id],
                |row| row.get(0),
            )
            .unwrap_or(-1);

        conn.execute(
            "INSERT OR IGNORE INTO playlist_songs (playlist_id, song_hash, position, added_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![playlist_id, song_hash, max_pos + 1, now],
        )
        .map_err(|e| format!("添加歌曲到歌单失败: {}", e))?;

        // 更新歌单 updated_at
        conn.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )
        .ok();

        Ok(())
    })
    .await
}

/// 从歌单移除歌曲
#[tauri::command]
pub async fn remove_song_from_playlist(
    app: AppHandle,
    playlist_id: i64,
    song_hash: String,
) -> Result<(), String> {
    let now = db::now_ms();

    db::run_db(&app, move |conn| {
        conn.execute(
            "DELETE FROM playlist_songs WHERE playlist_id = ?1 AND song_hash = ?2",
            params![playlist_id, song_hash],
        )
        .map_err(|e| format!("从歌单移除歌曲失败: {}", e))?;

        // 更新歌单 updated_at
        conn.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )
        .ok();

        Ok(())
    })
    .await
}

/// 从文件路径生成歌曲 ID (DefaultHasher 十六进制字符串，与 scan_folder 保持一致)
fn path_to_id(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// 从数据库加载默认歌单的全部歌曲 (返回 Song 数组)
/// 用于启动时快速加载，不扫描物理文件夹
#[tauri::command]
pub async fn load_default_playlist_songs(app: AppHandle) -> Result<Vec<Song>, String> {
    db::run_db(&app, move |conn| {
        // 查找默认歌单
        let default_id: i64 = conn
            .query_row(
                "SELECT id FROM playlists WHERE is_default = 1 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "默认歌单不存在".to_string())?;

        let mut stmt = conn
            .prepare(
                "SELECT s.song_hash, s.song_path, s.title, s.artist, s.album, s.duration,
                        s.cover_path, s.cover_thumb_path, s.favorite, s.favorited_at, s.created_at
                 FROM playlist_songs ps
                 JOIN songs s ON ps.song_hash = s.song_hash
                 WHERE ps.playlist_id = ?1
                 ORDER BY ps.position ASC",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let songs = stmt
            .query_map(params![default_id], |row| {
                let song_path: String = row.get(1)?;
                let content_hash: String = row.get(0)?;
                let cover_path: String = row.get(6)?;
                let cover_thumb_path: String = row.get(7)?;
                Ok(Song {
                    id: path_to_id(&song_path),
                    file_path: song_path,
                    title: row.get(2)?,
                    artist: row.get(3)?,
                    album: row.get(4)?,
                    duration: row.get::<_, i64>(5)? as u64,
                    cover_path: if cover_path.is_empty() {
                        None
                    } else {
                        Some(cover_path)
                    },
                    cover_thumb_path: if cover_thumb_path.is_empty() {
                        None
                    } else {
                        Some(cover_thumb_path)
                    },
                    content_hash: Some(content_hash),
                    favorite: row.get(8)?,
                    favorited_at: row.get(9)?,
                    created_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("查询歌单歌曲失败: {}", e))?;

        let mut result = Vec::new();
        for song in songs {
            result.push(song.map_err(|e| format!("遍历歌曲失败: {}", e))?);
        }
        Ok(result)
    })
    .await
}

/// 获取歌单中的所有歌曲 (带元数据, 按 position 排序)
#[tauri::command]
pub async fn get_playlist_songs(
    app: AppHandle,
    playlist_id: i64,
) -> Result<Vec<PlaylistSong>, String> {
    db::run_db(&app, move |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT ps.song_hash, s.song_path, s.title, s.artist, s.duration, s.cover_path, ps.position, ps.added_at
                 FROM playlist_songs ps
                 JOIN songs s ON ps.song_hash = s.song_hash
                 WHERE ps.playlist_id = ?1
                 ORDER BY ps.position ASC",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let songs = stmt
            .query_map(params![playlist_id], |row| {
                Ok(PlaylistSong {
                    song_hash: row.get(0)?,
                    song_path: row.get(1)?,
                    title: row.get(2)?,
                    artist: row.get(3)?,
                    duration: row.get(4)?,
                    cover_path: row.get(5)?,
                    position: row.get(6)?,
                    added_at: row.get(7)?,
                })
            })
            .map_err(|e| format!("查询歌单歌曲失败: {}", e))?;

        let mut result = Vec::new();
        for song in songs {
            result.push(song.map_err(|e| format!("遍历歌曲失败: {}", e))?);
        }
        Ok(result)
    })
    .await
}

/// 导入本地歌单 (从 localStorage 迁移)
/// 通过文件路径查找对应的 song_hash
#[tauri::command]
pub async fn import_playlist_from_paths(
    app: AppHandle,
    name: String,
    song_paths: Vec<String>,
) -> Result<i64, String> {
    let name_trim = name.trim().to_string();
    if name_trim.is_empty() {
        return Err("歌单名称不能为空".to_string());
    }

    let now = db::now_ms();

    db::run_db(&app, move |conn| {
        // 获取最大 sort_order
        let max_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) FROM playlists WHERE is_default = 0",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // 创建歌单
        conn.execute(
            "INSERT INTO playlists (name, description, is_default, sort_order, created_at, updated_at)
             VALUES (?1, '', 0, ?2, ?3, ?4)",
            params![name_trim, max_order + 1, now, now],
        )
        .map_err(|e| format!("创建歌单失败: {}", e))?;

        let playlist_id = conn.last_insert_rowid();

        // 批量添加歌曲 (通过 song_path 查找 song_hash)
        let mut position = 0i64;
        for song_path in &song_paths {
            if let Ok(song_hash) = conn.query_row::<String, _, _>(
                "SELECT song_hash FROM songs WHERE song_path = ?1",
                params![song_path],
                |row| row.get(0),
            ) {
                conn.execute(
                    "INSERT OR IGNORE INTO playlist_songs (playlist_id, song_hash, position, added_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![playlist_id, song_hash, position, now],
                )
                .ok();
                position += 1;
            }
        }

        Ok(playlist_id)
    })
    .await
}

/// 导出歌单 (m3u 或 markdown)
#[tauri::command]
pub async fn export_playlist(
    app: AppHandle,
    playlist_id: i64,
    format: String,
    output_path: String,
) -> Result<String, String> {
    let format_lower = format.to_lowercase();

    // 先获取歌单歌曲
    let songs = get_playlist_songs(app.clone(), playlist_id).await?;

    let playlist_name = db::run_db(&app, move |conn| {
        conn.query_row::<String, _, _>(
            "SELECT name FROM playlists WHERE id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("查询歌单名称失败: {}", e))
    })
    .await?;

    let content = match format_lower.as_str() {
        "m3u" => generate_m3u(&songs),
        "markdown" | "md" => generate_markdown(&playlist_name, &songs),
        _ => return Err(format!("不支持的导出格式: {}", format)),
    };

    std::fs::write(&output_path, content).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(output_path)
}

fn generate_m3u(songs: &[PlaylistSong]) -> String {
    let mut content = String::from("#EXTM3U\n");
    for song in songs {
        content.push_str(&format!(
            "#EXTINF:{},{}\n{}\n",
            song.duration,
            if song.artist.is_empty() {
                song.title.clone()
            } else {
                format!("{} - {}", song.artist, song.title)
            },
            song.song_path
        ));
    }
    content
}

fn generate_markdown(playlist_name: &str, songs: &[PlaylistSong]) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let date_str = format!(
        "{}-{:02}-{:02}",
        1970 + now / 31536000,
        (now % 31536000) / 86400 / 30 + 1,
        (now % 86400) / 3600,
    );

    let mut content = format!(
        "# 歌单：{}\n> 共 {} 首 · 导出时间 {}\n\n",
        playlist_name,
        songs.len(),
        date_str
    );

    for (i, song) in songs.iter().enumerate() {
        let minutes = song.duration / 60;
        let seconds = song.duration % 60;
        content.push_str(&format!(
            "## {}. {}\n- 歌手：{}\n- 时长：{}:{:02}\n- 路径：{}\n\n",
            i + 1,
            song.title,
            song.artist,
            minutes,
            seconds,
            song.song_path
        ));
    }

    content
}

/// 同步默认歌单 (扫描完成后调用, 确保默认歌单包含所有歌曲)
#[allow(dead_code)]
pub fn sync_default_playlist(conn: &mut rusqlite::Connection) -> Result<(), String> {
    let now = db::now_ms();

    // 清空默认歌单
    conn.execute("DELETE FROM playlist_songs WHERE playlist_id = 1", [])
        .map_err(|e| format!("清空默认歌单失败: {}", e))?;

    // 重新插入所有歌曲
    conn.execute(
        "INSERT INTO playlist_songs (playlist_id, song_hash, position, added_at)
         SELECT 1, song_hash, ROW_NUMBER() OVER (ORDER BY title ASC), ?1
         FROM songs",
        params![now],
    )
    .map_err(|e| format!("同步默认歌单失败: {}", e))?;

    // 更新 updated_at
    conn.execute(
        "UPDATE playlists SET updated_at = ?1 WHERE id = 1",
        params![now],
    )
    .ok();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::migrate;

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("打开内存库失败");
        conn.pragma_update(None, "foreign_keys", "ON").ok();
        migrate::init_schema(&conn).expect("初始化 songs schema 失败");
        init_schema(&conn).expect("初始化 playlist schema 失败");
        conn
    }

    fn insert_song(conn: &rusqlite::Connection, hash: &str, title: &str) {
        conn.execute(
            "INSERT INTO songs (song_hash, song_path, title, artist, created_at, updated_at)
             VALUES (?1, ?2, ?3, '测试歌手', 0, 0)",
            params![hash, format!("/music/{}.mp3", hash), title],
        )
        .expect("插入测试歌曲失败");
    }

    fn sample_song(hash: &str, title: &str, artist: &str, duration: i64) -> PlaylistSong {
        PlaylistSong {
            song_hash: hash.to_string(),
            song_path: format!("/music/{}.mp3", hash),
            title: title.to_string(),
            artist: artist.to_string(),
            duration,
            cover_path: String::new(),
            position: 1,
            added_at: 0,
        }
    }

    #[test]
    fn test_path_to_id_is_stable_and_hex() {
        let first = path_to_id("/music/周杰伦 - 晴天.mp3");
        let second = path_to_id("/music/周杰伦 - 晴天.mp3");
        assert_eq!(first, second, "同一路径必须得到同一个 ID");
        assert!(
            first.chars().all(|c| c.is_ascii_hexdigit()),
            "ID 必须是十六进制字符串: {}",
            first
        );
        assert!(first.len() <= 16, "u64 哈希最多 16 位: {}", first);
        assert_ne!(
            first,
            path_to_id("/music/另一首.mp3"),
            "不同路径不应生成相同 ID"
        );
    }

    #[test]
    fn test_generate_m3u_uses_duration_and_artist_title() {
        let songs = vec![
            sample_song("hash-1", "晴天", "周杰伦", 261),
            sample_song("hash-2", "纯音乐", "", 120),
        ];
        let content = generate_m3u(&songs);
        assert!(content.starts_with("#EXTM3U\n"), "首行必须是 #EXTM3U");
        assert!(
            content.contains("#EXTINF:261,周杰伦 - 晴天\n/music/hash-1.mp3\n"),
            "带歌手的行格式不对: {}",
            content
        );
        assert!(
            content.contains("#EXTINF:120,纯音乐\n/music/hash-2.mp3\n"),
            "空歌手时不应出现 ' - ' 前缀: {}",
            content
        );
    }

    #[test]
    fn test_generate_markdown_contains_track_metadata() {
        let songs = vec![
            sample_song("hash-1", "晴天", "周杰伦", 261),
            sample_song("hash-2", "纯音乐", "无名氏", 59),
        ];
        let content = generate_markdown("我的歌单", &songs);
        assert!(
            content.contains("# 歌单：我的歌单"),
            "缺少标题: {}",
            content
        );
        assert!(content.contains("> 共 2 首"), "缺少曲目数: {}", content);
        assert!(content.contains("## 1. 晴天"), "缺少序号/歌名: {}", content);
        assert!(content.contains("- 歌手：周杰伦"), "缺少歌手: {}", content);
        assert!(
            content.contains("- 时长：4:21"),
            "时长格式应为 分:秒: {}",
            content
        );
        assert!(content.contains("- 时长：0:59"), "秒数应补零: {}", content);
        assert!(
            content.contains("- 路径：/music/hash-1.mp3"),
            "缺少路径: {}",
            content
        );
    }

    #[test]
    fn test_playlist_init_schema_is_idempotent() {
        let conn = test_conn();
        init_schema(&conn).expect("重复初始化应保持幂等");
        let playlist_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlists", [], |row| row.get(0))
            .expect("查询歌单数失败");
        assert_eq!(playlist_count, 1, "默认歌单只应存在一条");
        let default_name: String = conn
            .query_row("SELECT name FROM playlists WHERE id = 1", [], |row| {
                row.get(0)
            })
            .expect("查询默认歌单失败");
        assert_eq!(default_name, "全部歌曲");
    }

    #[test]
    fn test_sync_default_playlist_orders_by_title_and_is_idempotent() {
        let mut conn = test_conn();
        insert_song(&conn, "hash-b", "B 歌");
        insert_song(&conn, "hash-a", "A 歌");
        insert_song(&conn, "hash-c", "C 歌");

        sync_default_playlist(&mut conn).expect("首次同步默认歌单失败");

        {
            // 作用域内持有 stmt 的不可变借用, 结束后再做可变借用
            let mut stmt = conn
                .prepare(
                    "SELECT song_hash, position FROM playlist_songs WHERE playlist_id = 1 ORDER BY position",
                )
                .expect("准备查询失败");
            let rows: Vec<(String, i64)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("执行查询失败")
                .collect::<Result<_, _>>()
                .expect("读取查询结果失败");
            assert_eq!(
                rows.iter()
                    .map(|(hash, _)| hash.as_str())
                    .collect::<Vec<_>>(),
                vec!["hash-a", "hash-b", "hash-c"],
                "应按歌名升序排列"
            );
            assert_eq!(
                rows.iter()
                    .map(|(_, position)| *position)
                    .collect::<Vec<_>>(),
                vec![1, 2, 3],
                "position 应从 1 连续递增"
            );
        }

        // 二次同步: 先清空再重建, 不应产生重复
        sync_default_playlist(&mut conn).expect("二次同步默认歌单失败");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = 1",
                [],
                |row| row.get(0),
            )
            .expect("查询关联数失败");
        assert_eq!(count, 3, "重复同步不应产生重复关联");
    }
}
