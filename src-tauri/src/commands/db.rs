// 公共数据库基础设施
//
// 设计原则:
//   - 单一 SQLite 文件 (数据目录/memories.db)，所有表都在一个库中
//   - 全局连接复用 (Mutex<Option<Connection>>)，支持热切换
//   - 所有表使用 IF NOT EXISTS / INSERT OR REPLACE，保证幂等
//   - rusqlite 同步操作通过 spawn_blocking 包装，不阻塞 async runtime
//   - 失败兜底: try/catch + warn，不弹错误框，不阻断主流程

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::commands::data_dir;

/// 数据库文件名
const DB_FILE: &str = "memories.db";

/// 全局 DB 连接 (支持热切换)
static DB_CONN: Mutex<Option<Connection>> = Mutex::new(None);

/// 获取数据库文件绝对路径
pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir::get_data_dir_path().or_else(|_| {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("获取 app_data_dir 失败: {}", e))
    })?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    }
    Ok(dir.join(DB_FILE))
}

/// 初始化数据库路径
pub fn ensure_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    db_path(app)
}

/// 获取当前 Unix 毫秒时间戳
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 打开数据库连接 + 执行公共 schema 初始化
pub fn open_connection(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开 SQLite 失败: {}", e))?;

    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    conn.pragma_update(None, "temp_store", "MEMORY").ok();
    conn.pragma_update(None, "foreign_keys", "ON").ok();

    Ok(conn)
}

/// 初始化全局 DB 连接 (在 main.rs setup 阶段调用)
pub fn init_db<F>(app: &AppHandle, register_schema: F) -> Result<(), String>
where
    F: FnOnce(&Connection) -> Result<(), String>,
{
    let path = ensure_db_path(app)?.clone();
    let conn = open_connection(&path)?;

    register_schema(&conn)?;

    let mut guard = DB_CONN.lock().map_err(|e| format!("DB 锁失败: {}", e))?;
    *guard = Some(conn);
    Ok(())
}

/// 执行 WAL checkpoint，确保 db 文件数据完整
pub fn checkpoint() -> Result<(), String> {
    let guard = DB_CONN.lock().map_err(|e| format!("DB 锁失败: {}", e))?;
    if let Some(ref conn) = *guard {
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")
            .map_err(|e| format!("WAL checkpoint 失败: {}", e))?;
    }
    Ok(())
}

/// 关闭当前数据库连接（用于迁移前）
pub fn close_connection() -> Result<(), String> {
    let mut guard = DB_CONN.lock().map_err(|e| format!("DB 锁失败: {}", e))?;
    if let Some(conn) = guard.take() {
        drop(conn);
    }
    Ok(())
}

/// 重新打开数据库连接（用于迁移后）
pub fn reopen_connection<F>(app: &AppHandle, register_schema: F) -> Result<(), String>
where
    F: FnOnce(&Connection) -> Result<(), String>,
{
    let path = ensure_db_path(app)?.clone();
    let conn = open_connection(&path)?;
    register_schema(&conn)?;

    let mut guard = DB_CONN.lock().map_err(|e| format!("DB 锁失败: {}", e))?;
    *guard = Some(conn);
    Ok(())
}

/// 在闭包中执行数据库操作
pub fn with_conn<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&Connection) -> Result<R, String>,
{
    let guard = DB_CONN.lock().map_err(|e| format!("DB 锁失败: {}", e))?;
    let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
    f(conn)
}

/// 在 spawn_blocking 中执行同步 SQLite 操作
pub async fn run_db<F, R>(_app: &AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce(&mut Connection) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = DB_CONN.lock().map_err(|e| format!("DB 锁失败: {}", e))?;
        let conn = guard.as_mut().ok_or_else(|| "数据库未初始化".to_string())?;
        f(conn)
    })
    .await
    .map_err(|e| format!("spawn_blocking 失败: {}", e))?
}
