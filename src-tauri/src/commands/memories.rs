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
//   - 用 rusqlite (同步 SQLite, bundled 静态链接) 而非 tauri-plugin-sql (拉入 sqlx, 编译开销大)
//   - rusqlite 操作是同步的, 通过 tauri::async_runtime::spawn_blocking 包装避免阻塞 async runtime
//   - 业务命令保持 async 签名, 与 Tauri 事件循环兼容
//
// 失败兜底:
//   - 数据库初始化/查询失败统一返回 Result<T, String>
//   - 前端 try/catch 后 console.warn, 不弹错误框打扰用户

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 数据库文件名
const DB_FILE: &str = "memories.db";

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

/// 全局 DB 路径 (懒初始化一次, 后续命令直接复用, 避免重复 IO)
static DB_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 获取数据库文件绝对路径
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {}", e))?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建 app_data_dir 失败: {}", e))?;
    }
    Ok(dir.join(DB_FILE))
}

/// 初始化数据库路径 (OnceLock, 幂等)
fn ensure_db_path(app: &AppHandle) -> Result<&'static PathBuf, String> {
    if let Some(p) = DB_PATH.get() {
        return Ok(p);
    }
    let p = db_path(app)?;
    let _ = DB_PATH.set(p);
    // 安全: set 失败说明已被其他线程设置, 取回即可
    Ok(DB_PATH.get().expect("DB_PATH just set"))
}

/// 获取当前 Unix 毫秒时间戳
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 打开数据库连接 + 执行 schema 初始化
///
/// bundled SQLite 无需额外配置, 一次建表 (IF NOT EXISTS) 幂等
fn open_and_init(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开 SQLite 失败: {}", e))?;

    // 建表 + 索引
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
    .map_err(|e| format!("初始化 schema 失败: {}", e))?;

    // 性能优化: WAL 模式 + 合理同步策略
    // WAL: 读写并发更好, 写入不阻塞读
    // synchronous=NORMAL: 折中安全与性能
    // temp_store=MEMORY: 临时表放内存
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    conn.pragma_update(None, "temp_store", "MEMORY").ok();

    Ok(conn)
}

/// 初始化 SQLite (建表 + 索引, 幂等)
/// 在 main.rs setup 阶段调用一次, 失败仅打印警告
pub fn init_db(app: &AppHandle) -> Result<(), String> {
    let path = ensure_db_path(app)?.clone();
    let _ = open_and_init(&path)?;
    Ok(())
}

/// 在 spawn_blocking 中执行同步 SQLite 操作
async fn run_db<F, R>(app: &AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce(&Connection) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    let path = ensure_db_path(app)?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_and_init(&path)?;
        f(&conn)
    })
    .await
    .map_err(|e| format!("spawn_blocking 失败: {}", e))?
}

/// 查询单条回忆
#[tauri::command]
pub async fn get_memory(
    app: AppHandle,
    song_hash: String,
) -> Result<Option<MemoryRecord>, String> {
    run_db(&app, move |conn| {
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
    let now = now_ms();
    let short_tags_json = serde_json::to_string(&short_tags)
        .map_err(|e| format!("序列化 short_tags 失败: {}", e))?;

    run_db(&app, move |conn| {
        // SQLite UPSERT: 有则更新, 无则插入
        //   - 插入: created_at = updated_at = now
        //   - 更新: 保留 created_at, 刷新 updated_at 与 song_path / short_tags / long_text
        //   - 设计: 即使用户移动文件, song_path 也会被最新路径覆盖
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
pub async fn delete_memory(
    app: AppHandle,
    song_hash: String,
) -> Result<bool, String> {
    run_db(&app, move |conn| {
        let affected = conn
            .execute("DELETE FROM memories WHERE song_hash = ?1", params![song_hash])
            .map_err(|e| format!("删除记忆失败: {}", e))?;
        Ok(affected > 0)
    })
    .await
}

/// 导出备注到指定目录 (生成 <歌名>.memo.json)
///
/// BUG 6: 新增可选 output_dir 参数
///   - 传入 Some: 导出到指定目录
///   - 传入 None: 导出到歌曲所在目录(原有行为)
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
    // 1. 查询记录 (数据库 IO, 走 spawn_blocking)
    let record: Option<MemoryRecord> = run_db(&app, move |conn| {
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

    // 2. 文件名安全处理: 去除 / \ : * ? " < > |
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
    // BUG 6: 优先使用 output_dir, 否则用歌曲所在目录
    let song_path_buf = std::path::PathBuf::from(&record.song_path);
    let parent_dir = song_path_buf
        .parent()
        .ok_or_else(|| "无法解析歌曲所在目录".to_string())?;

    let target_dir = if let Some(dir) = output_dir {
        let dir_path = std::path::PathBuf::from(&dir);
        // 确保目录存在
        if !dir_path.exists() {
            std::fs::create_dir_all(&dir_path)
                .map_err(|e| format!("创建导出目录失败: {}", e))?;
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

    let content = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("序列化 JSON 失败: {}", e))?;
    std::fs::write(&memo_path, content)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(memo_path.to_string_lossy().to_string())
}
