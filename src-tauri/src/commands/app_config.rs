use crate::commands::db;

pub fn init_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("初始化 app_config schema 失败: {}", e))?;

    Ok(())
}

#[allow(dead_code)]
pub fn get_config(key: &str) -> Result<Option<String>, String> {
    db::with_conn(|conn| {
        let result: Result<String, _> = conn.query_row(
            "SELECT value FROM app_config WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        );

        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("读取 app_config 失败: {}", e)),
        }
    })
}

pub fn set_config(key: &str, value: &str) -> Result<(), String> {
    db::with_conn(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO app_config (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )
        .map_err(|e| format!("写入 app_config 失败: {}", e))?;
        Ok(())
    })
}

pub fn delete_config(key: &str) -> Result<(), String> {
    db::with_conn(|conn| {
        conn.execute(
            "DELETE FROM app_config WHERE key = ?1",
            rusqlite::params![key],
        )
        .map_err(|e| format!("删除 app_config 失败: {}", e))?;
        Ok(())
    })
}
