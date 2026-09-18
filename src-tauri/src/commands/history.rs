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
pub async fn upsert_play_history(
    app: AppHandle,
    record: HistoryRecord,
) -> Result<(), String> {
    db::run_db(&app, move |conn| {
        conn.execute(
            "INSERT INTO play_history
                (id, song_hash, song_path, title, artist, album, duration, cover_path,
                 played_at, played_duration, completed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                played_duration = excluded.played_duration,
                completed       = excluded.completed",
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
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: String,
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
            conn
                .query_row(
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
                        (SELECT x.title      FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1),
                        (SELECT x.artist     FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1),
                        (SELECT x.album      FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1),
                        (SELECT x.cover_path FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1),
                        (SELECT x.duration   FROM play_history x
                         WHERE x.song_hash = h.song_hash
                         ORDER BY x.played_at DESC, x.id DESC LIMIT 1)
                 FROM play_history h
                 WHERE h.played_duration >= 1
                 GROUP BY h.song_hash
                 ORDER BY SUM(h.played_duration) DESC",
            )
            .map_err(|e| format!("准备按歌曲统计失败: {}", e))?;
        let by_song = song_stmt
            .query_map([], |row| {
                Ok(SongStatRow {
                    song_hash: row.get(0)?,
                    count: row.get(1)?,
                    total_duration: row.get(2)?,
                    title: row.get(3)?,
                    artist: row.get(4)?,
                    album: row.get(5)?,
                    cover_path: row.get(6)?,
                    duration: row.get(7)?,
                })
            })
            .map_err(|e| format!("查询按歌曲统计失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取按歌曲统计失败: {}", e))?;

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
#[tauri::command]
pub async fn get_display_history(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<HistoryRecord>, String> {
    let limit = limit.unwrap_or(500).clamp(1, MAX_HISTORY_ITEMS);
    db::run_db(&app, move |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT h.id, h.song_hash, h.song_path, h.title, h.artist, h.album,
                        h.duration, h.cover_path, h.played_at, h.played_duration, h.completed
                 FROM play_history h
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
                    played_at: row.get(8)?,
                    played_duration: row.get(9)?,
                    completed: row.get::<_, i64>(10)? != 0,
                })
            })
            .map_err(|e| format!("查询展示历史失败: {}", e))?;

        let mut result = Vec::new();
        for record in records {
            result.push(record.map_err(|e| format!("读取展示历史失败: {}", e))?);
        }
        Ok(result)
    })
    .await
}
