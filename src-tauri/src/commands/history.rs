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

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::db;

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

    Ok(())
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
                "SELECT id, song_hash, song_path, title, artist, album, duration, cover_path, 
                        played_at, played_duration, completed
                 FROM play_history
                 ORDER BY played_at DESC
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
                    played_at: row.get(8)?,
                    played_duration: row.get(9)?,
                    completed: row.get::<_, i64>(10)? != 0,
                })
            })
            .map_err(|e| format!("查询历史记录失败: {}", e))?;

        let mut result = Vec::new();
        for record in records {
            result.push(record.map_err(|e| format!("读取记录失败: {}", e))?);
        }
        Ok(result)
    })
    .await
}

/// 添加一条播放历史记录
#[tauri::command]
pub async fn add_play_history(
    app: AppHandle,
    record: HistoryRecord,
) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        conn.execute(
            "INSERT OR IGNORE INTO play_history 
                (id, song_hash, song_path, title, artist, album, duration, cover_path, 
                 played_at, played_duration, completed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                record.id,
                record.song_hash,
                record.song_path,
                record.title,
                record.artist,
                record.album,
                record.duration,
                record.cover_path,
                record.played_at,
                record.played_duration,
                if record.completed { 1 } else { 0 },
            ],
        )
        .map_err(|e| format!("插入历史记录失败: {}", e))?;

        // 清理超过 10000 条的旧记录 (保留最新的 10000 条)
        conn.execute(
            "DELETE FROM play_history 
             WHERE id NOT IN (
                 SELECT id FROM play_history 
                 ORDER BY played_at DESC 
                 LIMIT 10000
             )",
            [],
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
                     played_at, played_duration, completed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    record.id,
                    record.song_hash,
                    record.song_path,
                    record.title,
                    record.artist,
                    record.album,
                    record.duration,
                    record.cover_path,
                    record.played_at,
                    record.played_duration,
                    if record.completed { 1 } else { 0 },
                ],
            )
            .map_err(|e| format!("插入历史记录失败: {}", e))?;
        }

        // 清理超过 10000 条的旧记录
        tx.execute(
            "DELETE FROM play_history 
             WHERE id NOT IN (
                 SELECT id FROM play_history 
                 ORDER BY played_at DESC 
                 LIMIT 10000
             )",
            [],
        )
        .ok();

        tx.commit()
            .map_err(|e| format!("提交事务失败: {}", e))?;

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
pub async fn delete_play_history(
    app: AppHandle,
    id: String,
) -> Result<(), String> {
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
        conn
            .execute("DELETE FROM play_history", [])
            .map_err(|e| format!("清空历史记录失败: {}", e))?;
        Ok(())
    })
    .await
}
