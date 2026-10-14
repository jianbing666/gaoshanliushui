// 播放历史记录 - 基于 SQLite 的历史记录管理
//
// 设计原则:
//   - 所有历史记录存在 SQLite, 不再依赖 localStorage
//   - 使用 song_hash (content_hash) 关联歌曲, 用户移动文件后关联不失效
//   - 同时冗余存储 title/artist/album 等展示字段, 避免 JOIN 查询
//   - 两类历史:
//       1. 完整历史 (full_history): 每次播放一条, 最多 10000 条 (用于统计)
//       2. 展示历史 (display_history): 每首歌只保留最新一条, 最多 500 条 (用于展示)
//   - 所有操作幂等 (INSERT OR IGNORE)

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::commands::db;

/// 展示历史最多保留歌曲数 (与前端 MAX_HISTORY_ITEMS 保持一致)
const MAX_HISTORY_ITEMS: i64 = 500;
/// 完整历史最多保留记录数 (清理旧记录时使用)
const MAX_FULL_HISTORY_ITEMS: i64 = 10000;

/// 历史记录项 (与前端 PlayHistoryItem 对应)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryRecord {
    pub id: String,
    pub song_hash: String,
    pub song_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: i64,
    pub cover_path: String,
    /// 封面缩略图路径 (128px)。存量数据为空或缺失时前端回退到 cover_path
    #[serde(default)]
    pub cover_thumb_path: String,
    pub played_at: i64,
    pub played_duration: i64,
    pub completed: bool,
}

/// 初始化 history schema (建表 + 索引)
pub fn init_history_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        -- 完整播放历史 (每次播放一条, 用于统计)
        CREATE TABLE IF NOT EXISTS play_history (
            id              TEXT    PRIMARY KEY,
            song_hash       TEXT    NOT NULL,
            song_path       TEXT    NOT NULL,
            title           TEXT    NOT NULL,
            artist          TEXT    NOT NULL DEFAULT '',
            album           TEXT    NOT NULL DEFAULT '',
            duration        INTEGER NOT NULL DEFAULT 0,
            cover_path      TEXT    NOT NULL DEFAULT '',
            cover_thumb_path TEXT   NOT NULL DEFAULT '',
            played_at       INTEGER NOT NULL,
            played_duration INTEGER NOT NULL DEFAULT 0,
            completed       INTEGER NOT NULL DEFAULT 0
        );

        -- 索引: 按时间倒序查询
        CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC);

        -- 索引: 按歌曲查询
        CREATE INDEX IF NOT EXISTS idx_play_history_song ON play_history(song_hash);
        "#,
    )
    .map_err(|e| format!("初始化 history schema 失败: {}", e))?;

    // v2 迁移: 添加 cover_thumb_path 字段 (幂等)
    let _ = conn.execute(
        "ALTER TABLE play_history ADD COLUMN cover_thumb_path TEXT NOT NULL DEFAULT ''",
        [],
    );

    Ok(())
}

/// 把历史记录里的歌曲标识从"路径哈希"回填为"内容指纹"
///
/// 背景 (见 优化方案.md P0-4):
///   历史写入端曾把 `Song.id`(`DefaultHasher` 对文件路径的 16 位哈希) 写进
///   `song_hash`, 而 `songs.song_hash` 是 40 位内容指纹。两者不是同一套标识,
///   导致 `play_history` 与 `songs` 按该列匹配数为 0, "移动文件后仍能关联"的
///   设计意图实际失效。
///
/// 做法:
///   `song_path` 在两张表里都有, 且 `songs.song_path` 有 UNIQUE 约束, 因此可以
///   用它把历史记录重新指向正确的内容指纹。
///
/// 幂等:
///   已与 `songs.song_hash` 一致的行会被 `NOT EXISTS` 条件排除, 重复执行无副作用。
///
/// 局限:
///   不在 `songs` 表里的历史歌曲 (已从曲库移除) 无法回填, 其标识保持原值。
pub fn backfill_song_hash_from_path(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "UPDATE play_history
         SET song_hash = (
             SELECT s.song_hash FROM songs s WHERE s.song_path = play_history.song_path
         )
         WHERE EXISTS (SELECT 1 FROM songs s WHERE s.song_path = play_history.song_path)
           AND NOT EXISTS (
               SELECT 1 FROM songs s2 WHERE s2.song_hash = play_history.song_hash
           )",
        [],
    )
    .map_err(|e| format!("回填 song_hash 失败: {}", e))
}

// ========== 失效封面过滤 ==========
//
// 背景:
//   play_history.cover_path 是播放当时的路径快照, 而封面缓存 (data_dir/covers)
//   会被设置页的"清除封面缓存"以及重扫时的强制刷新删除。快照不会随之更新, 于是
//   历史里会残留一批指向已删除文件的路径 —— 前端逐条请求这些 URL 只会拿到 404,
//   用户看到的是"有些历史条目没有封面"。
//
//   在返回给前端之前把文件已不存在的封面路径清空, UI 就能直接渲染占位符:
//   既不会产生无谓的请求, 也不会闪现破图。
//
// 为什么不能 join songs 表取当前封面:
//   play_history.song_hash 存的是 Song.id (DefaultHasher 对文件路径的 16 位哈希),
//   而 songs.song_hash 是内容指纹 (40 位 SHA-1)。两者不是同一套标识, 无法关联。
//   详见 优化方案.md P0-4。
//
// 性能:
//   逐条 Path::exists() 在历史达到上限 (500 / 10000) 时会产生大量系统调用。
//   这里按目录聚合, 每个目录只 read_dir 一次, 之后都是集合查找。

/// 封面文件存在性索引 (按目录缓存一次目录列举)
#[derive(Default)]
struct CoverFileIndex {
    dirs: HashMap<PathBuf, HashSet<String>>,
}

impl CoverFileIndex {
    /// 判断路径对应的文件是否存在; 空路径一律视为不存在
    fn exists(&mut self, path: &str) -> bool {
        if path.is_empty() {
            return false;
        }
        let path = Path::new(path);
        let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
        else {
            return false;
        };
        let names = self.dirs.entry(dir.to_path_buf()).or_insert_with(|| {
            let mut set = HashSet::new();
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    // 只认文件: 同名目录不能当作封面
                    if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                        if let Some(name) = entry.file_name().to_str() {
                            set.insert(name.to_string());
                        }
                    }
                }
            }
            set
        });
        names.contains(name)
    }
}

/// 清空指向不存在文件的封面路径
fn drop_missing_history_covers(records: &mut [HistoryRecord]) {
    let mut index = CoverFileIndex::default();
    for record in records.iter_mut() {
        if !index.exists(&record.cover_path) {
            record.cover_path.clear();
        }
        if !index.exists(&record.cover_thumb_path) {
            record.cover_thumb_path.clear();
        }
    }
}

/// 清空统计行里指向不存在文件的封面路径
fn drop_missing_song_covers(rows: &mut [SongStatRow]) {
    let mut index = CoverFileIndex::default();
    for row in rows.iter_mut() {
        if !index.exists(&row.cover_path) {
            row.cover_path.clear();
        }
        if !index.exists(&row.cover_thumb_path) {
            row.cover_thumb_path.clear();
        }
    }
}

/// 获取完整播放历史 (按时间倒序, 最多 limit 条)
#[tauri::command]
pub async fn get_play_history(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<HistoryRecord>, String> {
    let limit = limit.unwrap_or(10000);
    db::run_db(&app, move |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT h.id, h.song_hash, h.song_path, h.title, h.artist, h.album, h.duration,
                        CASE WHEN s.song_hash IS NOT NULL THEN s.cover_path
                             ELSE h.cover_path END,
                        CASE WHEN s.song_hash IS NOT NULL THEN s.cover_thumb_path
                             ELSE h.cover_thumb_path END,
                        h.played_at, h.played_duration, h.completed
                 FROM play_history h
                 LEFT JOIN songs s ON s.song_hash = h.song_hash
                 ORDER BY h.played_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let records = stmt
            .query_map(params![limit], |row| {
                Ok(HistoryRecord {
                    id: row.get(0)?,
                    song_hash: row.get(1)?,
                    song_path: row.get(2)?,
                    title: row.get(3)?,
                    artist: row.get(4)?,
                    album: row.get(5)?,
                    duration: row.get(6)?,
                    cover_path: row.get(7)?,
                    cover_thumb_path: row.get(8)?,
                    played_at: row.get(9)?,
                    played_duration: row.get(10)?,
                    completed: row.get::<_, i64>(11)? != 0,
                })
            })
            .map_err(|e| format!("查询历史记录失败: {}", e))?;

        let mut result = Vec::new();
        for record in records {
            result.push(record.map_err(|e| format!("读取记录失败: {}", e))?);
        }
        // 清空已被删除的封面文件引用, 避免前端逐条 404
        drop_missing_history_covers(&mut result);
        Ok(result)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let unique = format!(
            "gaoshanliushui-history-{}-{}",
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

    fn record(cover: &str, thumb: &str) -> HistoryRecord {
        HistoryRecord {
            id: "r1".to_string(),
            song_hash: "h1".to_string(),
            song_path: "song.mp3".to_string(),
            title: "t".to_string(),
            artist: "a".to_string(),
            album: String::new(),
            duration: 0,
            cover_path: cover.to_string(),
            cover_thumb_path: thumb.to_string(),
            played_at: 0,
            played_duration: 0,
            completed: false,
        }
    }

    fn stat_row(cover: &str, thumb: &str) -> SongStatRow {
        SongStatRow {
            song_hash: "h1".to_string(),
            count: 1,
            total_duration: 10,
            completed_count: 1,
            last_played_at: 0,
            title: "t".to_string(),
            artist: "a".to_string(),
            album: String::new(),
            cover_path: cover.to_string(),
            cover_thumb_path: thumb.to_string(),
            duration: 0,
        }
    }

    /// 存在的封面保留, 已删除的封面清空
    #[test]
    fn test_drop_missing_history_covers_keeps_only_existing() {
        let dir = temp_dir("history");
        let existing = dir.join("ok.jpg");
        std::fs::write(&existing, b"x").expect("写入文件失败");
        let existing = existing.to_str().unwrap().to_string();
        let missing = dir.join("gone.jpg").to_str().unwrap().to_string();

        let mut records = vec![record(&existing, &missing), record(&missing, "")];
        drop_missing_history_covers(&mut records);

        assert_eq!(records[0].cover_path, existing, "存在的封面应保留");
        assert_eq!(records[0].cover_thumb_path, "", "缺失的缩略图应清空");
        assert_eq!(records[1].cover_path, "", "缺失的封面应清空");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空路径与不存在的目录都应安全处理
    #[test]
    fn test_drop_missing_history_covers_handles_edge_cases() {
        let absent = temp_dir("history-absent").join("not-a-dir");
        let mut records = vec![
            record("", ""),
            record(absent.join("a.jpg").to_str().unwrap(), ""),
        ];

        drop_missing_history_covers(&mut records);

        assert_eq!(records[0].cover_path, "");
        assert_eq!(records[1].cover_path, "", "目录不存在时应清空");
    }

    /// 同名目录不能被当成封面文件
    #[test]
    fn test_drop_missing_history_covers_ignores_directories() {
        let dir = temp_dir("history-dir");
        std::fs::create_dir_all(dir.join("same-name.jpg")).expect("建目录失败");
        let path = dir.join("same-name.jpg").to_str().unwrap().to_string();

        let mut records = vec![record(&path, "")];
        drop_missing_history_covers(&mut records);

        assert_eq!(records[0].cover_path, "", "同名目录不应被当作封面");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 统计行的封面过滤与历史记录一致
    #[test]
    fn test_drop_missing_song_covers() {
        let dir = temp_dir("history-song");
        let existing = dir.join("ok.jpg");
        std::fs::write(&existing, b"x").expect("写入文件失败");
        let existing = existing.to_str().unwrap().to_string();
        let missing = dir.join("gone.jpg").to_str().unwrap().to_string();

        let mut rows = vec![stat_row(&existing, &missing)];
        drop_missing_song_covers(&mut rows);

        assert_eq!(rows[0].cover_path, existing);
        assert_eq!(rows[0].cover_thumb_path, "");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同一目录被多条记录引用时只列举一次 (行为等价即可, 这里断言结果正确)
    #[test]
    fn test_cover_file_index_reuses_directory_listing() {
        let dir = temp_dir("history-index");
        std::fs::write(dir.join("a.jpg"), b"x").expect("写入文件失败");
        let a = dir.join("a.jpg").to_str().unwrap().to_string();
        let b = dir.join("b.jpg").to_str().unwrap().to_string();

        let mut index = CoverFileIndex::default();
        assert!(index.exists(&a));
        assert!(!index.exists(&b));
        assert!(index.exists(&a));
        assert_eq!(index.dirs.len(), 1, "同一目录只应列举一次");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ========== P0-4 回填 ==========

    /// 建一个含 songs 与 play_history 两张表的内存库
    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().expect("打开内存库失败");
        crate::commands::migrate::init_schema(&conn).expect("初始化 songs schema 失败");
        init_history_schema(&conn).expect("初始化 history schema 失败");
        conn
    }

    fn insert_song(conn: &Connection, hash: &str, path: &str, cover: &str, thumb: &str) {
        conn.execute(
            "INSERT INTO songs
                (song_hash, song_path, title, artist, album, duration,
                 cover_path, cover_thumb_path, source, created_at, updated_at)
             VALUES (?1, ?2, 't', 'a', '', 0, ?3, ?4, 'test', 0, 0)",
            rusqlite::params![hash, path, cover, thumb],
        )
        .expect("插入歌曲失败");
    }

    fn insert_history_row(conn: &Connection, id: &str, hash: &str, path: &str) {
        conn.execute(
            "INSERT INTO play_history
                (id, song_hash, song_path, title, artist, album, duration,
                 cover_path, cover_thumb_path, played_at, played_duration, completed)
             VALUES (?1, ?2, ?3, 't', 'a', '', 0, '', '', 0, 0, 0)",
            rusqlite::params![id, hash, path],
        )
        .expect("插入历史记录失败");
    }

    fn history_hash(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT song_hash FROM play_history WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .expect("查询历史 song_hash 失败")
    }

    /// 旧的路径哈希应被回填为内容指纹
    #[test]
    fn test_backfill_replaces_path_hash_with_content_hash() {
        let conn = setup_db();
        let content = "a".repeat(40);
        insert_song(&conn, &content, "D:\\Music\\a.mp3", "", "");
        insert_history_row(&conn, "r1", "993dd288157fc156", "D:\\Music\\a.mp3");

        assert_eq!(backfill_song_hash_from_path(&conn).expect("回填失败"), 1);
        assert_eq!(history_hash(&conn, "r1"), content);
    }

    /// 幂等: 重复执行不应产生变化
    #[test]
    fn test_backfill_is_idempotent() {
        let conn = setup_db();
        let content = "b".repeat(40);
        insert_song(&conn, &content, "D:\\Music\\b.mp3", "", "");
        insert_history_row(&conn, "r1", "1111111111111111", "D:\\Music\\b.mp3");

        assert_eq!(backfill_song_hash_from_path(&conn).unwrap(), 1);
        assert_eq!(
            backfill_song_hash_from_path(&conn).unwrap(),
            0,
            "第二次应为空操作"
        );
        assert_eq!(history_hash(&conn, "r1"), content);
    }

    /// 曲库中已不存在的历史歌曲无法回填, 应保持原值
    #[test]
    fn test_backfill_skips_songs_absent_from_library() {
        let conn = setup_db();
        let original = "2222222222222222".to_string();
        insert_history_row(&conn, "r1", &original, "D:\\Music\\gone.mp3");

        assert_eq!(backfill_song_hash_from_path(&conn).unwrap(), 0);
        assert_eq!(history_hash(&conn, "r1"), original);
    }

    /// 改名后产生的多条历史应归并为同一个内容指纹
    #[test]
    fn test_backfill_merges_records_of_renamed_song() {
        let conn = setup_db();
        let content = "c".repeat(40);
        insert_song(&conn, &content, "D:\\Music\\new.mp3", "", "");
        insert_history_row(&conn, "r1", "aaaaaaaaaaaaaaaa", "D:\\Music\\new.mp3");
        insert_history_row(&conn, "r2", "bbbbbbbbbbbbbbbb", "D:\\Music\\new.mp3");

        assert_eq!(backfill_song_hash_from_path(&conn).unwrap(), 2);
        assert_eq!(history_hash(&conn, "r1"), content);
        assert_eq!(history_hash(&conn, "r2"), content);
    }

    // ========== 展示历史的封面解析 ==========

    /// 曲库中有这首歌时, 用曲库的当前封面覆盖播放时的旧快照
    #[test]
    fn test_display_history_prefers_library_cover() {
        let conn = setup_db();
        let dir = temp_dir("display-prefer");
        let current = dir.join("current.jpg");
        let stale = dir.join("stale.jpg");
        std::fs::write(&current, b"x").expect("写入失败");
        std::fs::write(&stale, b"x").expect("写入失败");
        let current = current.to_str().unwrap().to_string();
        let stale = stale.to_str().unwrap().to_string();

        let content = "d".repeat(40);
        insert_song(&conn, &content, "D:\\Music\\a.mp3", &current, &current);
        insert_history_row(&conn, "r1", &content, "D:\\Music\\a.mp3");
        // 历史里存的是播放当时的旧封面
        conn.execute(
            "UPDATE play_history SET cover_path = ?1, cover_thumb_path = ?1 WHERE id = 'r1'",
            rusqlite::params![stale],
        )
        .expect("更新快照失败");

        let rows = query_display_history(&conn, 500).expect("查询失败");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].cover_path, current, "应采用曲库当前封面");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 曲库里没有这首歌时回退到历史快照
    #[test]
    fn test_display_history_falls_back_to_snapshot() {
        let conn = setup_db();
        let dir = temp_dir("display-fallback");
        let snapshot = dir.join("snap.jpg");
        std::fs::write(&snapshot, b"x").expect("写入失败");
        let snapshot = snapshot.to_str().unwrap().to_string();

        insert_history_row(&conn, "r1", "ffffffffffffffff", "D:\\Music\\gone.mp3");
        conn.execute(
            "UPDATE play_history SET cover_path = ?1 WHERE id = 'r1'",
            rusqlite::params![snapshot],
        )
        .expect("更新快照失败");

        let rows = query_display_history(&conn, 500).expect("查询失败");
        assert_eq!(rows[0].cover_path, snapshot, "曲库无此歌时应回退快照");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 曲库封面与快照都指向已删除文件时清空 (第二层兜底)
    #[test]
    fn test_display_history_clears_when_all_sources_missing() {
        let conn = setup_db();
        let dir = temp_dir("display-clear");
        let missing = dir.join("gone.jpg").to_str().unwrap().to_string();

        let content = "e".repeat(40);
        insert_song(&conn, &content, "D:\\Music\\a.mp3", &missing, "");
        insert_history_row(&conn, "r1", &content, "D:\\Music\\a.mp3");

        let rows = query_display_history(&conn, 500).expect("查询失败");
        assert_eq!(rows[0].cover_path, "", "两处都取不到时应清空");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 添加一条播放历史记录
#[tauri::command]
pub async fn add_play_history(app: AppHandle, record: HistoryRecord) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        conn.execute(
            "INSERT OR IGNORE INTO play_history
                (id, song_hash, song_path, title, artist, album, duration, cover_path,
                 cover_thumb_path, played_at, played_duration, completed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                record.id,
                record.song_hash,
                record.song_path,
                record.title,
                record.artist,
                record.album,
                record.duration,
                record.cover_path,
                record.cover_thumb_path,
                record.played_at,
                record.played_duration,
                if record.completed { 1 } else { 0 },
            ],
        )
        .map_err(|e| format!("插入历史记录失败: {}", e))?;

        // 清理超过上限的旧记录 (保留最新的 MAX_FULL_HISTORY_ITEMS 条)
        conn.execute(
            "DELETE FROM play_history
             WHERE id NOT IN (
                 SELECT id FROM play_history
                 ORDER BY played_at DESC
                 LIMIT ?1
             )",
            params![MAX_FULL_HISTORY_ITEMS],
        )
        .map_err(|e| format!("清理旧历史记录失败: {}", e))?;

        Ok(())
    })
    .await
}

/// 添加或更新一条播放历史记录 (按 id 幂等 upsert)
///
/// 2026-09 新增, 用于"开始即落库 + 播放中心跳增量更新时长"机制:
///   - 播放开始: upsert 一条 played_duration=0 的记录
///   - 播放中每 15s: upsert 最新累计时长
///   - 播放结束: upsert 终态时长
/// 多次调用/乱序到达都安全, 同一 id 最终为最后一次写入的状态。
#[tauri::command]
pub async fn upsert_play_history(app: AppHandle, record: HistoryRecord) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        conn.execute(
            "INSERT INTO play_history
                (id, song_hash, song_path, title, artist, album, duration, cover_path,
                 cover_thumb_path, played_at, played_duration, completed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                played_duration = excluded.played_duration,
                completed       = excluded.completed,
                cover_thumb_path = CASE WHEN excluded.cover_thumb_path != ''
                                        THEN excluded.cover_thumb_path
                                        ELSE cover_thumb_path END",
            params![
                record.id,
                record.song_hash,
                record.song_path,
                record.title,
                record.artist,
                record.album,
                record.duration,
                record.cover_path,
                record.cover_thumb_path,
                record.played_at,
                record.played_duration,
                if record.completed { 1 } else { 0 },
            ],
        )
        .map_err(|e| format!("upsert 历史记录失败: {}", e))?;

        // 清理超过上限的旧记录 (保留最新的 MAX_FULL_HISTORY_ITEMS 条)
        conn.execute(
            "DELETE FROM play_history
             WHERE id NOT IN (
                 SELECT id FROM play_history
                 ORDER BY played_at DESC
                 LIMIT ?1
             )",
            params![MAX_FULL_HISTORY_ITEMS],
        )
        .map_err(|e| format!("清理旧历史记录失败: {}", e))?;

        Ok(())
    })
    .await
}

/// 批量添加播放历史记录 (用于从 localStorage 迁移)
#[tauri::command]
pub async fn batch_add_play_history(
    app: AppHandle,
    records: Vec<HistoryRecord>,
) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {}", e))?;

        for record in &records {
            tx.execute(
                "INSERT OR IGNORE INTO play_history
                    (id, song_hash, song_path, title, artist, album, duration, cover_path,
                     cover_thumb_path, played_at, played_duration, completed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    record.id,
                    record.song_hash,
                    record.song_path,
                    record.title,
                    record.artist,
                    record.album,
                    record.duration,
                    record.cover_path,
                    record.cover_thumb_path,
                    record.played_at,
                    record.played_duration,
                    if record.completed { 1 } else { 0 },
                ],
            )
            .map_err(|e| format!("插入历史记录失败: {}", e))?;
        }

        // 清理超过上限的旧记录
        tx.execute(
            "DELETE FROM play_history
             WHERE id NOT IN (
                 SELECT id FROM play_history
                 ORDER BY played_at DESC
                 LIMIT ?1
             )",
            params![MAX_FULL_HISTORY_ITEMS],
        )
        .ok();

        tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;

        Ok(())
    })
    .await
}

/// 更新一条历史记录的播放时长和完成状态
#[tauri::command]
pub async fn update_play_history(
    app: AppHandle,
    id: String,
    played_duration: i64,
    completed: bool,
) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        conn.execute(
            "UPDATE play_history SET played_duration = ?1, completed = ?2 WHERE id = ?3",
            params![played_duration, if completed { 1 } else { 0 }, id],
        )
        .map_err(|e| format!("更新历史记录失败: {}", e))?;
        Ok(())
    })
    .await
}

/// 删除一条历史记录
#[tauri::command]
pub async fn delete_play_history(app: AppHandle, id: String) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        conn.execute("DELETE FROM play_history WHERE id = ?1", params![id])
            .map_err(|e| format!("删除历史记录失败: {}", e))?;
        Ok(())
    })
    .await
}

/// 清空所有历史记录
#[tauri::command]
pub async fn clear_play_history(app: AppHandle) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        conn.execute("DELETE FROM play_history", [])
            .map_err(|e| format!("清空历史记录失败: {}", e))?;
        Ok(())
    })
    .await
}

// ========== 统计聚合 (v1.3.0) ==========
//
// 统计口径约定:
//   - 仅统计 played_duration >= 1 秒的 "有效播放"。
//     <1s 的记录只可能来自误触切歌或崩溃遗留的 0 秒占位, 不构成一次真实播放,
//     若计入会虚增播放次数。completed=1 的记录时长必然 >= 曲长*0.8, 不受影响。
//   - 展示历史 (get_display_history) 不过滤, 仍保留每首歌最新一条。

/// 按日聚合行
#[derive(Debug, Serialize)]
pub struct DayStatRow {
    /// 本地日历日 'YYYY-MM-DD' (按调用方传入的时区偏移换算)
    pub day: String,
    pub count: i64,
    pub total_duration: i64,
    pub completed_count: i64,
}

/// 按歌曲聚合行 (展示字段取该歌最新一条记录)
#[derive(Debug, Serialize)]
pub struct SongStatRow {
    pub song_hash: String,
    pub count: i64,
    pub total_duration: i64,
    /// 该歌完整播放 (播放超过 80%) 的次数, 供智能随机计算完成率
    pub completed_count: i64,
    /// 该歌最近一次有效播放时间 (Unix 毫秒), 供智能随机做时间衰减
    pub last_played_at: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: String,
    /// 封面缩略图路径 (该歌最新一条记录的值, 可能为空)
    pub cover_thumb_path: String,
    pub duration: i64,
}

/// 全量统计聚合结果 (字段名与前端 historyStore 消费结构对齐, 勿随意改名)
#[derive(Debug, Serialize)]
pub struct PlayHistoryStats {
    pub total_count: i64,
    pub total_duration: i64,
    pub total_completed: i64,
    pub unique_songs: i64,
    pub by_day: Vec<DayStatRow>,
    pub by_song: Vec<SongStatRow>,
}

/// 获取全量播放统计 (全表聚合, 不受任何 LIMIT 截断)
///
/// tz_offset_minutes: 本地时区相对 UTC 的偏移分钟数 (东八区为 -480,
/// 即前端 -new Date().getTimezoneOffset())。SQLite date() 按 UTC 解释 unix 秒,
/// 需先加上本地偏移再分桶, 才能与前端 dayKey 的本地日历日一致。
#[tauri::command]
pub async fn get_play_history_stats(
    app: AppHandle,
    tz_offset_minutes: Option<i64>,
) -> Result<PlayHistoryStats, String> {
    let tz_offset_ms = tz_offset_minutes.unwrap_or(0) * 60_000;

    db::run_db(&app, move |conn| {
        let (total_count, total_duration, total_completed, unique_songs): (i64, i64, i64, i64) =
            conn.query_row(
                "SELECT COUNT(*),
                            COALESCE(SUM(played_duration), 0),
                            COALESCE(SUM(completed), 0),
                            COUNT(DISTINCT song_hash)
                     FROM play_history
                     WHERE played_duration >= 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|e| format!("统计汇总查询失败: {}", e))?;

        // 按本地日历日分桶
        let mut day_stmt = conn
            .prepare(
                "SELECT date((played_at + ?1) / 1000, 'unixepoch') AS day,
                        COUNT(*),
                        SUM(played_duration),
                        SUM(completed)
                 FROM play_history
                 WHERE played_duration >= 1
                 GROUP BY day
                 ORDER BY day",
            )
            .map_err(|e| format!("准备按日统计失败: {}", e))?;
        let by_day = day_stmt
            .query_map(params![tz_offset_ms], |row| {
                Ok(DayStatRow {
                    day: row.get(0)?,
                    count: row.get(1)?,
                    total_duration: row.get(2)?,
                    completed_count: row.get(3)?,
                })
            })
            .map_err(|e| format!("查询按日统计失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取按日统计失败: {}", e))?;
        drop(day_stmt);

        // 按歌曲聚合: 展示字段用相关子查询取该歌最新一条 (played_at 最大),
        // 不使用窗口函数以兼容各 SQLite 版本; 按累计时长倒序便于前端直接使用。
        let mut song_stmt = conn
            .prepare(
                "SELECT h.song_hash,
                        COUNT(*),
                        SUM(h.played_duration),
                        SUM(h.completed),
                        MAX(h.played_at),
                        (SELECT x.title      FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1),
                        (SELECT x.artist     FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1),
                        (SELECT x.album      FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1),
                        COALESCE(
                            (SELECT s.cover_path FROM songs s WHERE s.song_hash = h.song_hash),
                            (SELECT x.cover_path FROM play_history x
                             WHERE x.song_hash = h.song_hash
                             ORDER BY x.played_at DESC, x.id DESC LIMIT 1)
                        ),
                        COALESCE(
                            (SELECT s.cover_thumb_path FROM songs s WHERE s.song_hash = h.song_hash),
                            (SELECT x.cover_thumb_path FROM play_history x
                             WHERE x.song_hash = h.song_hash
                             ORDER BY x.played_at DESC, x.id DESC LIMIT 1)
                        ),
                        (SELECT x.duration   FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1)
                 FROM play_history h
                 WHERE h.played_duration >= 1
                 GROUP BY h.song_hash
                 ORDER BY SUM(h.played_duration) DESC",
            )
            .map_err(|e| format!("准备按歌曲统计失败: {}", e))?;
        let mut by_song = song_stmt
            .query_map([], |row| {
                Ok(SongStatRow {
                    song_hash: row.get(0)?,
                    count: row.get(1)?,
                    total_duration: row.get(2)?,
                    completed_count: row.get(3)?,
                    last_played_at: row.get(4)?,
                    title: row.get(5)?,
                    artist: row.get(6)?,
                    album: row.get(7)?,
                    cover_path: row.get(8)?,
                    cover_thumb_path: row.get(9)?,
                    duration: row.get(10)?,
                })
            })
            .map_err(|e| format!("查询按歌曲统计失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取按歌曲统计失败: {}", e))?;

        // 清空已被删除的封面文件引用, 避免统计页封面 404
        drop_missing_song_covers(&mut by_song);

        Ok(PlayHistoryStats {
            total_count,
            total_duration,
            total_completed,
            unique_songs,
            by_day,
            by_song,
        })
    })
    .await
}

/// 获取展示用历史 (SQL 层去重: 每首歌仅保留最新一条, 再按时间倒序)
///
/// 替代前端 "取最近 2000 条再内存去重" 的做法, 历史记录达到上限 10000 条时
/// 较老歌曲也不会丢失。不过滤 <1s 记录 (抽屉语义是 "最近碰过的歌")。
fn query_display_history(conn: &Connection, limit: i64) -> Result<Vec<HistoryRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT h.id, h.song_hash, h.song_path, h.title, h.artist, h.album,
                    h.duration,
                    CASE WHEN s.song_hash IS NOT NULL THEN s.cover_path
                         ELSE h.cover_path END,
                    CASE WHEN s.song_hash IS NOT NULL THEN s.cover_thumb_path
                         ELSE h.cover_thumb_path END,
                    h.played_at, h.played_duration, h.completed
             FROM play_history h
             LEFT JOIN songs s ON s.song_hash = h.song_hash
             WHERE h.id = (
                 SELECT x.id FROM play_history x
                 WHERE x.song_hash = h.song_hash
                 ORDER BY x.played_at DESC, x.id DESC
                 LIMIT 1
             )
             ORDER BY h.played_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("准备展示历史查询失败: {}", e))?;

    let records = stmt
        .query_map(params![limit], |row| {
            Ok(HistoryRecord {
                id: row.get(0)?,
                song_hash: row.get(1)?,
                song_path: row.get(2)?,
                title: row.get(3)?,
                artist: row.get(4)?,
                album: row.get(5)?,
                duration: row.get(6)?,
                cover_path: row.get(7)?,
                cover_thumb_path: row.get(8)?,
                played_at: row.get(9)?,
                played_duration: row.get(10)?,
                completed: row.get::<_, i64>(11)? != 0,
            })
        })
        .map_err(|e| format!("查询展示历史失败: {}", e))?;

    let mut result = Vec::new();
    for record in records {
        result.push(record.map_err(|e| format!("读取展示历史失败: {}", e))?);
    }
    // 第二层兜底: 曲库里也取不到 (或取到的文件也不存在) 时清空, 避免前端 404
    drop_missing_history_covers(&mut result);
    Ok(result)
}

#[tauri::command]
pub async fn get_display_history(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<HistoryRecord>, String> {
    let limit = limit.unwrap_or(500).clamp(1, MAX_HISTORY_ITEMS);
    db::run_db(&app, move |conn| query_display_history(conn, limit)).await
}
