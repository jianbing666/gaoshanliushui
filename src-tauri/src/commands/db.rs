// 公共数据库基础设施
//
// 设计原则:
//   - 单一 SQLite 文件 (app_data_dir/memories.db)，所有表都在一个库中
//   - 全局连接复用 (OnceLock<Mutex<Connection>>)，避免每次 open 的 IO 开销
//   - 所有表使用 IF NOT EXISTS / INSERT OR REPLACE，保证幂等
//   - rusqlite 同步操作通过 spawn_blocking 包装，不阻塞 async runtime
//   - 失败兜底: try/catch + warn，不弹错误框，不阻断主流程

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// 数据库文件名
const DB_FILE: &str = "memories.db";

/// 全局 DB 路径
/// C:\Users\李国志\AppData\Roaming\com.gaoshanliushui.player\memories.db
static DB_PATH: OnceLock<PathBuf> = OnceLock::new();

/// 全局 DB 连接 (Mutex 保护，跨命令复用)
static DB_CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

/// 获取数据库文件绝对路径
pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
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
pub fn ensure_db_path(app: &AppHandle) -> Result<&'static PathBuf, String> {
    if let Some(p) = DB_PATH.get() {
        return Ok(p);
    }
    let p = db_path(app)?;
    let _ = DB_PATH.set(p);
    Ok(DB_PATH.get().expect("DB_PATH just set"))
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
///
/// 各模块在自己的 init 函数中追加建表语句
pub fn open_connection(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开 SQLite 失败: {}", e))?;

    // 性能优化: WAL 模式 + 合理同步策略
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    conn.pragma_update(None, "temp_store", "MEMORY").ok();
    // 开启外键约束 (用于 ON DELETE CASCADE)
    conn.pragma_update(None, "foreign_keys", "ON").ok();

    Ok(conn)
}

/// 初始化全局 DB 连接 (在 main.rs setup 阶段调用)
///
/// 各模块通过 register_schema 回调追加自己的建表语句
pub fn init_db<F>(app: &AppHandle, register_schema: F) -> Result<(), String>
where
    F: FnOnce(&Connection) -> Result<(), String>,
{
    let path = ensure_db_path(app)?.clone();
    let conn = open_connection(&path)?;

    // 执行各模块的 schema 注册
    register_schema(&conn)?;

    // 存入全局
    let _ = DB_CONN.set(Mutex::new(conn));
    Ok(())
}

/// 取出全局连接 (若未初始化, 返回错误)
pub fn get_conn() -> Result<&'static Mutex<Connection>, String> {
    DB_CONN
        .get()
        .ok_or_else(|| "数据库未初始化".to_string())
}

/// 在 spawn_blocking 中执行同步 SQLite 操作
///
/// 复用全局连接，统一的错误处理模式
pub async fn run_db<F, R>(_app: &AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce(&mut Connection) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    let mutex = get_conn()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = mutex.lock().map_err(|e| format!("DB 锁失败: {}", e))?;
        f(&mut guard)
    })
    .await
    .map_err(|e| format!("spawn_blocking 失败: {}", e))?
}
