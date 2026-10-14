// Memory feature - 高山流水 v1.1: 音乐备注 / 回忆存储
//
// 存储策略:
//   - 单 SQLite 文件, 存到 app_data_dir()/memories.db
//   - 与音乐文件完全解耦 (不修改 mp3/jpg, 也不在用户音乐目录生成任何文件)
//   - 主键 content_hash (头尾 64KB SHA-1) 而非文件路径
//     → 用户移动/重命名文件后仍能匹配历史回忆
//   - 同一文件被移动, song_path 会被新路径覆盖 (latest-write-wins)
//
// 实现选择:
//   - 用 rusqlite (同步 SQLite, bundled 静态链接)
//   - rusqlite 操作是同步的, 通过 db::run_db 包装避免阻塞 async runtime
//   - 业务命令保持 async 签名, 与 Tauri 事件循环兼容
//
// 失败兜底:
//   - 数据库初始化/查询失败统一返回 Result<T, String>
//   - 前端 try/catch 后 console.warn, 不弹错误框打扰用户

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::db;

/// 单条回忆记录 (前后端共享结构)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    /// 自增主键
    pub id: i64,
    /// 文件内容指纹 (头尾 64KB SHA-1 十六进制)
    pub song_hash: String,
    /// 当前文件绝对路径
    pub song_path: String,
    /// 短标签 JSON 数组字符串, 如 `["通宵的小曲儿~","2019的那年夏天"]`
    pub short_tags: String,
    /// Markdown 长文
    pub long_text: String,
    /// 创建时间 (Unix 毫秒)
    pub created_at: i64,
    /// 更新时间 (Unix 毫秒)
    pub updated_at: i64,
}

/// 初始化 memories 表 schema (幂等)
pub fn init_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memories (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            song_hash    TEXT    NOT NULL UNIQUE,
            song_path    TEXT    NOT NULL,
            short_tags   TEXT    NOT NULL DEFAULT '[]',
            long_text    TEXT    NOT NULL DEFAULT '',
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(song_hash);
        "#,
    )
    .map_err(|e| format!("初始化 memories schema 失败: {}", e))?;
    Ok(())
}

/// 查询单条回忆
#[tauri::command]
pub async fn get_memory(app: AppHandle, song_hash: String) -> Result<Option<MemoryRecord>, String> {
    db::run_db(&app, move |conn| {
        let result = conn
            .query_row(
                "SELECT id, song_hash, song_path, short_tags, long_text, created_at, updated_at
                 FROM memories WHERE song_hash = ?1",
                params![song_hash],
                |row| {
                    Ok(MemoryRecord {
                        id: row.get(0)?,
                        song_hash: row.get(1)?,
                        song_path: row.get(2)?,
                        short_tags: row.get(3)?,
                        long_text: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("查询记忆失败: {}", e))?;
        Ok(result)
    })
    .await
}

/// 保存 (upsert) 回忆
#[tauri::command]
pub async fn save_memory(
    app: AppHandle,
    song_hash: String,
    song_path: String,
    short_tags: Vec<String>,
    long_text: String,
) -> Result<MemoryRecord, String> {
    let now = db::now_ms();
    let short_tags_json =
        serde_json::to_string(&short_tags).map_err(|e| format!("序列化 short_tags 失败: {}", e))?;

    db::run_db(&app, move |conn| {
        // SQLite UPSERT: 有则更新, 无则插入
        conn.execute(
            "INSERT INTO memories (song_hash, song_path, short_tags, long_text, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(song_hash) DO UPDATE SET
                song_path  = excluded.song_path,
                short_tags = excluded.short_tags,
                long_text  = excluded.long_text,
                updated_at = excluded.updated_at",
            params![
                song_hash,
                song_path,
                short_tags_json,
                long_text,
                now,
                now,
            ],
        )
        .map_err(|e| format!("保存记忆失败: {}", e))?;

        // 回读最新记录
        let record = conn
            .query_row(
                "SELECT id, song_hash, song_path, short_tags, long_text, created_at, updated_at
                 FROM memories WHERE song_hash = ?1",
                params![song_hash],
                |row| {
                    Ok(MemoryRecord {
                        id: row.get(0)?,
                        song_hash: row.get(1)?,
                        song_path: row.get(2)?,
                        short_tags: row.get(3)?,
                        long_text: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .map_err(|e| format!("回读记忆失败: {}", e))?;
        Ok(record)
    })
    .await
}

/// 删除回忆
#[tauri::command]
pub async fn delete_memory(app: AppHandle, song_hash: String) -> Result<bool, String> {
    db::run_db(&app, move |conn| {
        let affected = conn
            .execute(
                "DELETE FROM memories WHERE song_hash = ?1",
                params![song_hash],
            )
            .map_err(|e| format!("删除记忆失败: {}", e))?;
        Ok(affected > 0)
    })
    .await
}

/// 列出所有回忆 (时间轴视图用)
#[tauri::command]
pub async fn list_all_memories(app: AppHandle) -> Result<Vec<MemoryRecord>, String> {
    db::run_db(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, song_hash, song_path, short_tags, long_text, created_at, updated_at
                 FROM memories ORDER BY updated_at DESC",
            )
            .map_err(|e| format!("准备查询失败: {}", e))?;

        let records = stmt
            .query_map([], |row| {
                Ok(MemoryRecord {
                    id: row.get(0)?,
                    song_hash: row.get(1)?,
                    song_path: row.get(2)?,
                    short_tags: row.get(3)?,
                    long_text: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| format!("查询所有记忆失败: {}", e))?;

        let mut result = Vec::new();
        for record in records {
            result.push(record.map_err(|e| format!("遍历记录失败: {}", e))?);
        }
        Ok(result)
    })
    .await
}

/// 导出备注到指定目录 (生成 <歌名>.memo.json)
///
/// 设计原则:
///   - 仅在用户主动触发时执行, 不会静默生成
///   - 文件名安全处理: 去除 / \ : * ? " < > |
///   - 失败时返回错误字符串, 前端用轻提示展示
#[tauri::command]
pub async fn export_memory(
    app: AppHandle,
    song_hash: String,
    song_title: String,
    song_artist: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    // 1. 查询记录
    let record: Option<MemoryRecord> = db::run_db(&app, move |conn| {
        conn.query_row(
            "SELECT id, song_hash, song_path, short_tags, long_text, created_at, updated_at
             FROM memories WHERE song_hash = ?1",
            params![song_hash],
            |row| {
                Ok(MemoryRecord {
                    id: row.get(0)?,
                    song_hash: row.get(1)?,
                    song_path: row.get(2)?,
                    short_tags: row.get(3)?,
                    long_text: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("查询记忆失败: {}", e))
    })
    .await?;

    let record = record.ok_or_else(|| "该歌曲暂无记忆, 无可导出内容".to_string())?;

    // 2. 文件名安全处理
    let safe_title: String = song_title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let safe_title = safe_title.trim().trim_matches('.').to_string();
    let safe_title = if safe_title.is_empty() {
        "未命名歌曲".to_string()
    } else {
        safe_title
    };

    // 3. 解析 tags (容错)
    let tags: Vec<String> = serde_json::from_str(&record.short_tags).unwrap_or_default();

    // 4. 构造输出路径
    let song_path_buf = std::path::PathBuf::from(&record.song_path);
    let parent_dir = song_path_buf
        .parent()
        .ok_or_else(|| "无法解析歌曲所在目录".to_string())?;

    let target_dir = if let Some(dir) = output_dir {
        let dir_path = std::path::PathBuf::from(&dir);
        if !dir_path.exists() {
            std::fs::create_dir_all(&dir_path).map_err(|e| format!("创建导出目录失败: {}", e))?;
        }
        dir_path
    } else {
        parent_dir.to_path_buf()
    };

    let memo_path = target_dir.join(format!("{}.memo.json", safe_title));

    let payload = serde_json::json!({
        "song": song_title,
        "artist": song_artist,
        "short_tags": tags,
        "long_text": record.long_text,
        "updated_at": record.updated_at,
    });

    let content =
        serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化 JSON 失败: {}", e))?;
    std::fs::write(&memo_path, content).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(memo_path.to_string_lossy().to_string())
}
