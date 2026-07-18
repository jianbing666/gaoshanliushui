use std::path::Path;
use rusqlite::params;
use tauri::AppHandle;
use crate::commands::db;

#[tauri::command]
pub async fn delete_song(
    app: AppHandle,
    song_hash: String,
    delete_file: bool,
) -> Result<(), String> {
    let song_hash_for_db = song_hash.clone();
    let song_info = db::run_db(&app, move |conn| {
        conn.query_row::<(String, String, String), _, _>(
            "SELECT song_path, cover_path, title FROM songs WHERE song_hash = ?1",
            params![song_hash_for_db],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .map_err(|e| format!("查询歌曲信息失败: {}", e))
    })
    .await?;

    let (song_path, cover_path, _title) = song_info;

    if delete_file {
        let song_p = Path::new(&song_path);
        if song_p.exists() {
            if let Err(e) = std::fs::remove_file(song_p) {
                eprintln!("[delete_song] 删除歌曲文件失败: {}", e);
            }
        }

        if !cover_path.is_empty() {
            let cover_p = Path::new(&cover_path);
            if cover_p.exists() {
                if let Err(e) = std::fs::remove_file(cover_p) {
                    eprintln!("[delete_song] 删除封面文件失败: {}", e);
                }
            }
        }

        if let Some(parent) = song_p.parent() {
            let song_stem = song_p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let dir_entries = std::fs::read_dir(parent).ok();
            if let Some(entries) = dir_entries {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if stem == song_stem && path.extension().and_then(|e| e.to_str()) != Some("mp3") {
                            if path.is_file() {
                                let _ = std::fs::remove_file(&path);
                            }
                        }
                    }
                }
            }
        }
    }

    db::run_db(&app, move |conn| {
        conn.execute(
            "DELETE FROM songs WHERE song_hash = ?1",
            params![song_hash],
        )
        .map_err(|e| format!("删除歌曲数据库记录失败: {}", e))?;
        Ok(())
    })
    .await?;

    Ok(())
}
