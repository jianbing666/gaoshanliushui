use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, OnceLock};

use std::borrow::Cow;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use regex::Regex;
use walkdir::WalkDir;

use crate::commands::data_dir;
use crate::commands::db;
use crate::commands::song_hash::compute_content_hash;
use crate::models::Song;
use tauri::{AppHandle, Emitter};

/// 支持的音频文件扩展名
const SUPPORTED_EXTENSIONS: &[&str] = &["mp3", "mp4", "flac", "wav", "m4a", "aac", "ogg", "wma"];

/// 支持的图片扩展名
const COVER_IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp"];

/// ========== 缩略图配置 ==========
const THUMB_WIDTH: u32 = 128;
const THUMB_QUALITY: u8 = 75;

/// 从 songs 表读出的元数据行 (数据库 → 内存的中间表示)
///
/// 字段顺序与 SELECT 语句逐一对应:
/// (song_path, title, artist, album, duration, cover_path, cover_thumb_path,
///  favorite, favorited_at, created_at)
/// 增删列时需同步修改两处。
type DbSongRow = (
    String,
    String,
    String,
    String,
    i64,
    String,
    String,
    bool,
    i64,
    i64,
);

/// 递归扫描指定文件夹下的所有音频文件，并解析元数据
///
/// v1.1 性能优化 (2026-07-15): 两阶段扫描
///   - 阶段 1 (快速返回): 文件名解析 + duration + content_hash
///     → 这些是轻量级操作，content_hash 只读头尾 64KB
///     → 前端能立即拿到歌曲列表和记忆功能所需的 content_hash
///   - 阶段 2 (后台异步): ID3 元数据补全 + 封面提取 + 缩略图生成
///     → 通过 'scan:enrich-progress' 事件增量推送
///     → 封面提取是最耗时的操作（读整个文件找图片块）
#[tauri::command]
pub async fn scan_music_folder(
    app: AppHandle,
    folder_path: String,
    metadata_source: Option<String>,
    force_refresh: Option<bool>,
) -> Result<Vec<Song>, String> {
    let path = Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("路径不存在或不是文件夹: {}", folder_path));
    }

    let use_filename_only = metadata_source.as_deref() == Some("filename");
    let force = force_refresh.unwrap_or(false);

    if force {
        clear_cover_cache();
    }

    // 收集所有音频文件路径
    let audio_files: Vec<std::path::PathBuf> = WalkDir::new(&folder_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| {
                    let ext_lower = ext.to_ascii_lowercase();
                    SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str())
                })
                .unwrap_or(false)
        })
        .map(|e| e.path().to_path_buf())
        .collect();

    let total = audio_files.len();

    // ========== 阶段 1: 快速返回基础元数据 ==========
    // 包含: 文件名/ID3基础信息 + duration + content_hash
    // 不包含: 封面提取 + 缩略图生成（最耗时的部分）
    let mut songs = Vec::with_capacity(total);
    for file_path in &audio_files {
        match parse_audio_file_phase1(file_path, use_filename_only) {
            Ok(song) => songs.push(song),
            Err(e) => {
                eprintln!("解析文件失败 {:?}: {}", file_path, e);
            }
        }
    }

    songs.sort_by(|a, b| a.title.cmp(&b.title));

    // ========== 写入 songs 表 + 合并用户修正数据 ==========
    // 设计原则:
    //   - 新歌曲: 插入文件解析的元数据 (INSERT OR IGNORE)
    //   - 已有歌曲: 只更新 file_path / duration / cover_path 等原始属性
    //              绝不覆盖 title / artist / album (用户可能手动修正过)
    //   - 最终返回给前端的数据: 以数据库为准 (包含用户修正)
    // 失败仅打印警告，不阻断扫描结果返回
    let mut merged_songs = songs.clone();
    {
        let songs_for_db = songs.clone();
        let now = db::now_ms();
        let app_clone = app.clone();

        // 同步写入数据库并读取合并结果
        match db::run_db(&app_clone, move |conn| {
            let tx = conn
                .transaction()
                .map_err(|e| format!("开启事务失败: {}", e))?;

            let mut hashes: Vec<String> = Vec::new();

            for song in &songs_for_db {
                let hash = match &song.content_hash {
                    Some(h) => h.clone(),
                    None => continue,
                };
                hashes.push(hash.clone());

                // 先尝试插入 (新歌曲)
                let inserted = tx.execute(
                    "INSERT OR IGNORE INTO songs 
                        (song_hash, song_path, title, artist, album, duration, cover_path, source, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    rusqlite::params![
                        hash,
                        song.file_path,
                        song.title,
                        song.artist,
                        song.album,
                        song.duration as i64,
                        song.cover_path.clone().unwrap_or_default(),
                        "scan",
                        now,
                        now,
                    ],
                )
                .map_err(|e| format!("插入 song 失败: {}", e))?;

                // 如果歌曲已存在 (inserted == 0), 只更新原始属性, 不碰 title/artist/album
                if inserted == 0 {
                    tx.execute(
                        "UPDATE songs SET 
                            song_path = ?1,
                            duration = ?2,
                            cover_path = CASE WHEN ?3 != '' THEN ?3 ELSE cover_path END,
                            updated_at = ?4
                         WHERE song_hash = ?5",
                        rusqlite::params![
                            song.file_path,
                            song.duration as i64,
                            song.cover_path.clone().unwrap_or_default(),
                            now,
                            hash,
                        ],
                    )
                    .map_err(|e| format!("更新 song 原始属性失败: {}", e))?;
                }
            }

            // 从数据库读取所有扫描到的歌曲 (包含用户修正)
            let placeholders = hashes
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");
            let query = format!(
                "SELECT song_hash, song_path, title, artist, album, duration, cover_path, cover_thumb_path,
                        favorite, favorited_at, created_at
                 FROM songs
                 WHERE song_hash IN ({})
                 ORDER BY title ASC",
                placeholders
            );

            let db_songs = {
                let mut stmt = tx
                    .prepare(&query)
                    .map_err(|e| format!("查询 songs 失败: {}", e))?;

                let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
                for h in &hashes {
                    params.push(h);
                }

                let mut rows = stmt
                    .query(rusqlite::params_from_iter(params))
                    .map_err(|e| format!("查询 songs 失败: {}", e))?;

                let mut result = Vec::new();
                while let Some(row) = rows
                    .next()
                    .map_err(|e| format!("读取行失败: {}", e))?
                {
                    result.push((
                        row.get::<_, String>(0).map_err(|e| format!("读取 song_hash 失败: {}", e))?,
                        row.get::<_, String>(1).map_err(|e| format!("读取 song_path 失败: {}", e))?,
                        row.get::<_, String>(2).map_err(|e| format!("读取 title 失败: {}", e))?,
                        row.get::<_, String>(3).map_err(|e| format!("读取 artist 失败: {}", e))?,
                        row.get::<_, String>(4).map_err(|e| format!("读取 album 失败: {}", e))?,
                        row.get::<_, i64>(5).map_err(|e| format!("读取 duration 失败: {}", e))?,
                        row.get::<_, String>(6).map_err(|e| format!("读取 cover_path 失败: {}", e))?,
                        row.get::<_, String>(7).map_err(|e| format!("读取 cover_thumb_path 失败: {}", e))?,
                        row.get::<_, bool>(8).map_err(|e| format!("读取 favorite 失败: {}", e))?,
                        row.get::<_, i64>(9).map_err(|e| format!("读取 favorited_at 失败: {}", e))?,
                        row.get::<_, i64>(10).map_err(|e| format!("读取 created_at 失败: {}", e))?,
                    ));
                }
                result
            };

            // ========== 同步默认歌单 ==========
            // 确保默认歌单存在，并将所有扫描到的歌曲加入默认歌单
            // 这是启动时 load_default_playlist_songs 能读到数据的关键
            let default_id: i64 = tx
                .query_row(
                    "SELECT id FROM playlists WHERE is_default = 1 LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| {
                    tx.execute(
                    "INSERT INTO playlists (name, is_default, sort_order, created_at, updated_at)
                                 VALUES ('全部歌曲', 1, 0, ?1, ?1)",
                    rusqlite::params![now],
                ).ok();
                    tx.last_insert_rowid()
                });

            // 批量插入 playlist_songs（INSERT OR IGNORE，幂等）
            for (i, hash) in hashes.iter().enumerate() {
                tx.execute(
                    "INSERT OR IGNORE INTO playlist_songs (playlist_id, song_hash, position, added_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![default_id, hash, i as i64, now],
                ).ok();
            }

            tx.commit()
                .map_err(|e| format!("提交事务失败: {}", e))?;

            Ok(db_songs)
        })
        .await
        {
            Ok(db_songs) => {

                // 用数据库中的数据 (含用户修正) 合并到返回结果
                use std::collections::HashMap;
                let db_map: HashMap<String, DbSongRow> = db_songs
                    .into_iter()
                    .map(
                        |(
                            hash,
                            path,
                            title,
                            artist,
                            album,
                            dur,
                            cover,
                            thumb,
                            favorite,
                            favorited_at,
                            created_at,
                        )| {
                            (
                                hash,
                                (
                                    path,
                                    title,
                                    artist,
                                    album,
                                    dur,
                                    cover,
                                    thumb,
                                    favorite,
                                    favorited_at,
                                    created_at,
                                ),
                            )
                        },
                    )
                    .collect();

                for song in &mut merged_songs {
                    if let Some(ref hash) = song.content_hash {
                        if let Some((
                            _,
                            title,
                            artist,
                            album,
                            _,
                            cover,
                            thumb,
                            favorite,
                            favorited_at,
                            created_at,
                        )) = db_map.get(hash)
                        {
                            song.title = title.clone();
                            song.artist = artist.clone();
                            song.album = album.clone();
                            if !cover.is_empty() {
                                song.cover_path = Some(cover.clone());
                            }
                            // 缩略图独立赋值: 存量数据该列为空, 保持 None 让前端回退全尺寸封面
                            song.cover_thumb_path = if thumb.is_empty() {
                                None
                            } else {
                                Some(thumb.clone())
                            };
                            // 喜爱状态与入库时间以数据库为准 (重扫不得覆盖用户标记)
                            song.favorite = *favorite;
                            song.favorited_at = *favorited_at;
                            song.created_at = *created_at;
                        }
                    }
                }

                // 重新排序 (用户修正的 title 可能改变了排序)
                merged_songs.sort_by(|a, b| a.title.cmp(&b.title));
            }
            Err(e) => {
                eprintln!("[scan] 同步 songs 表失败: {}", e);
            }
        }
    }

    // ========== 阶段 2: 后台异步补全封面 + 缩略图 ==========
    // 文件名模式下也可能有同级封面图片，所以也需要阶段2
    let app_handle = app.clone();
    let songs_arc = Arc::new(merged_songs.clone());
    std::thread::spawn(move || {
        enrich_covers_async(app_handle, audio_files, songs_arc, force, use_filename_only);
    });

    Ok(merged_songs)
}

/// 阶段 1 解析: 快速返回基础元数据
/// - 文件名解析 或 ID3 标题/艺术家/专辑
/// - duration (lofty Probe, 仅读文件属性)
/// - content_hash (头尾 64KB SHA-1)
///
/// 不做: 封面提取 + 缩略图生成（最耗时）
fn parse_audio_file_phase1(file_path: &Path, use_filename_only: bool) -> Result<Song, String> {
    let file_path_str = file_path
        .to_str()
        .ok_or_else(|| format!("无效的文件路径: {:?}", file_path))?
        .to_string();

    let id = generate_id(&file_path_str);

    // 计算 content_hash (记忆功能需要，必须阶段1就有)
    let content_hash = compute_content_hash(file_path);
    // 首次入库时间的暂定值: 真正落库后以数据库中的 created_at 为准 (重扫不会刷新)
    let created_at = db::now_ms();

    if use_filename_only {
        // 仅文件名模式: 从文件名解析 + duration
        let (artist, title) = parse_filename(file_path);
        let title = if title.is_empty() {
            file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("未知歌曲")
                .to_string()
        } else {
            title
        };
        let duration = Probe::open(file_path)
            .ok()
            .and_then(|p| p.read().ok())
            .map(|f| f.properties().duration().as_secs())
            .unwrap_or(0);
        let sibling_cover = find_sibling_cover_image(file_path);
        // 缩略图只在真的生成过时才填: 历史实现把同级全尺寸封面写进这一列,
        // 列表拿 3000px JPEG 当 40px 缩略图, 快速滚动时内存冲到 GB 级 (P1)
        let thumb = existing_thumbnail(&id);
        return Ok(Song {
            id,
            file_path: file_path_str,
            title,
            artist,
            album: String::new(),
            duration,
            cover_path: sibling_cover,
            cover_thumb_path: thumb,
            content_hash,
            favorite: false,
            favorited_at: 0,
            created_at,
        });
    }

    // auto 模式: 尝试读 ID3，但不提取封面
    let (title, artist, album, duration) = match Probe::open(file_path) {
        Ok(probe) => match probe.read() {
            Ok(tagged_file) => {
                let duration = tagged_file.properties().duration().as_secs();
                let mut title = String::new();
                let mut artist = String::new();
                let mut album = String::new();

                if let Some(tag) = tagged_file.primary_tag() {
                    title = tag.title().unwrap_or(Cow::Borrowed("")).to_string();
                    artist = tag.artist().unwrap_or(Cow::Borrowed("")).to_string();
                    album = tag.album().unwrap_or(Cow::Borrowed("")).to_string();
                } else if let Some(tag) = tagged_file.first_tag() {
                    title = tag.title().unwrap_or(Cow::Borrowed("")).to_string();
                    artist = tag.artist().unwrap_or(Cow::Borrowed("")).to_string();
                    album = tag.album().unwrap_or(Cow::Borrowed("")).to_string();
                }

                // 文件名兜底
                if title.is_empty() || artist.is_empty() {
                    let (parsed_artist, parsed_title) = parse_filename(file_path);
                    if title.is_empty() {
                        title = parsed_title;
                    }
                    if artist.is_empty() {
                        artist = parsed_artist;
                    }
                }
                if title.is_empty() {
                    title = file_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("未知歌曲")
                        .to_string();
                }

                (title, artist, album, duration)
            }
            Err(_) => {
                let (artist, title) = parse_filename(file_path);
                let title = if title.is_empty() {
                    file_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("未知歌曲")
                        .to_string()
                } else {
                    title
                };
                (title, artist, String::new(), 0u64)
            }
        },
        Err(_) => {
            let (artist, title) = parse_filename(file_path);
            let title = if title.is_empty() {
                file_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("未知歌曲")
                    .to_string()
            } else {
                title
            };
            (title, artist, String::new(), 0u64)
        }
    };

    // 阶段1不提取封面，但检查同级图片（轻量级，仅判断文件是否存在）
    let sibling_cover = find_sibling_cover_image(file_path);
    let thumb = existing_thumbnail(&id);

    Ok(Song {
        id,
        file_path: file_path_str,
        title,
        artist,
        album,
        duration,
        cover_path: sibling_cover,
        cover_thumb_path: thumb,
        content_hash,
        favorite: false,
        favorited_at: 0,
        created_at,
    })
}

/// 阶段 2 后台异步: 补全封面 + 缩略图
/// - 内嵌封面提取 + 缩略图生成
/// - 每完成一首 emit 一次增量事件 + 更新 songs 表
fn enrich_covers_async(
    app: AppHandle,
    audio_files: Vec<std::path::PathBuf>,
    _songs: Arc<Vec<Song>>,
    force_refresh: bool,
    use_filename_only: bool,
) {
    let total = audio_files.len();
    let now = db::now_ms();

    for (idx, file_path) in audio_files.iter().enumerate() {
        let file_path_str = match file_path.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let id = generate_id(&file_path_str);

        if force_refresh {
            if let Ok(cover_dir) = data_dir::get_covers_dir() {
                let _ = std::fs::remove_file(cover_dir.join(format!("{}.jpg", id)));
            }
            if let Ok(thumb_dir) = data_dir::get_thumbnails_dir() {
                let _ = std::fs::remove_file(thumb_dir.join(format!("{}.jpg", id)));
            }
        }

        // 文件名模式下只检查同级图片（阶段1已做），跳过内嵌封面提取
        let (cover_path, cover_thumb_path) = if use_filename_only {
            let sibling = find_sibling_cover_image(file_path);
            let thumb = sibling
                .as_ref()
                .and_then(|path| make_thumbnail_from_file(Path::new(path), &id))
                .or_else(|| existing_thumbnail(&id));
            (sibling, thumb)
        } else {
            // 提取内嵌封面 + 缩略图
            let (cover_path, cover_thumb_path) = match extract_cover_art(file_path, &id) {
                (Some(c), Some(t)) => (Some(c), Some(t)),
                (Some(c), None) => {
                    let thumb = c.clone();
                    (Some(c), Some(thumb))
                }
                (None, t) => (None, t),
            };
            // 同级图片兜底: 同样生成缩略图, 不要拿全尺寸封面冒充
            if cover_path.is_none() {
                if let Some(sibling) = find_sibling_cover_image(file_path) {
                    let thumb = make_thumbnail_from_file(Path::new(&sibling), &id)
                        .or_else(|| existing_thumbnail(&id));
                    (Some(sibling), thumb)
                } else {
                    (cover_path, cover_thumb_path)
                }
            } else {
                (cover_path, cover_thumb_path)
            }
        };

        // 更新 songs 表的 cover_path / cover_thumb_path
        //
        // 用 CASE WHEN 而不是直接覆盖: 本次未提取到封面时 (例如音频无内嵌图片)
        // 不应把库中已有的封面路径清空。
        let cover_value = cover_path.clone().unwrap_or_default();
        let thumb_value = cover_thumb_path.clone().unwrap_or_default();
        if !cover_value.is_empty() || !thumb_value.is_empty() {
            let _ = db::with_conn(|conn| {
                conn.execute(
                    "UPDATE songs
                     SET cover_path = CASE WHEN ?1 != '' THEN ?1 ELSE cover_path END,
                         cover_thumb_path = CASE WHEN ?2 != '' THEN ?2 ELSE cover_thumb_path END,
                         updated_at = ?3
                     WHERE song_path = ?4",
                    rusqlite::params![cover_value, thumb_value, now, file_path_str],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            });
        }

        // emit 增量更新
        let _ = app.emit(
            "scan:enrich-progress",
            serde_json::json!({
                "id": id,
                "file_path": file_path_str,
                "cover_path": cover_path,
                "cover_thumb_path": cover_thumb_path,
                "index": idx,
                "total": total,
            }),
        );
    }

    let _ = app.emit(
        "scan:enrich-complete",
        serde_json::json!({ "total": total }),
    );
}

/// "歌手 - 歌名" 解析正则
///
/// 用 OnceLock 只编译一次: `parse_filename` 在扫描时按文件逐个调用, 若每次都
/// `Regex::new`, 5000 首歌就是 5000 次正则编译 —— 这部分开销与解析结果无关,
/// 纯属浪费。
static FILENAME_SPLIT_RE: OnceLock<Regex> = OnceLock::new();

fn filename_split_re() -> &'static Regex {
    FILENAME_SPLIT_RE
        .get_or_init(|| Regex::new(r"^(.+?)\s*[-–—]\s*(.+?)$").expect("文件名解析正则非法"))
}

/// 从文件名解析 "歌手 - 歌名" 格式
fn parse_filename(file_path: &Path) -> (String, String) {
    let file_stem = match file_path.file_stem().and_then(|s| s.to_str()) {
        Some(stem) => stem,
        None => return (String::new(), String::new()),
    };

    if let Some(caps) = filename_split_re().captures(file_stem) {
        let artist = caps
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let title = caps
            .get(2)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        return (artist, title);
    }

    (String::new(), String::new())
}

/// 查找同目录下与音频文件同名的图片作为封面
fn find_sibling_cover_image(audio_path: &Path) -> Option<String> {
    let parent_dir = audio_path.parent()?;
    let file_stem = audio_path.file_stem()?.to_str()?;

    for ext in COVER_IMAGE_EXTENSIONS {
        let cover_path = parent_dir.join(format!("{}.{}", file_stem, ext));
        if cover_path.exists() && cover_path.is_file() {
            return cover_path.to_str().map(|s| s.to_string());
        }
    }

    None
}

/// 提取音频文件中的封面图片, 同时生成 128px 缩略图
fn extract_cover_art(file_path: &Path, song_id: &str) -> (Option<String>, Option<String>) {
    let tagged_file = match Probe::open(file_path).ok().and_then(|p| p.read().ok()) {
        Some(f) => f,
        None => return (None, None),
    };

    let tag = match tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())
    {
        Some(t) => t,
        None => return (None, None),
    };

    let pictures = tag.pictures();
    if pictures.is_empty() {
        return (None, None);
    }

    let picture = &pictures[0];

    let cover_dir = match data_dir::get_covers_dir() {
        Ok(dir) => dir,
        Err(_) => return (None, None),
    };
    if !cover_dir.exists() {
        let _ = std::fs::create_dir_all(&cover_dir);
    }
    let cover_path = cover_dir.join(format!("{}.jpg", song_id));
    let cover_str = match std::fs::write(&cover_path, picture.data()) {
        Ok(_) => cover_path.to_str().map(String::from),
        Err(_) => None,
    };

    let thumb_str = generate_thumbnail(picture.data(), song_id);

    (cover_str, thumb_str)
}

/// 已存在的缩略图路径(只检查, 不生成)
fn existing_thumbnail(song_id: &str) -> Option<String> {
    let thumb_dir = data_dir::get_thumbnails_dir().ok()?;
    let thumb_path = thumb_dir.join(format!("{}.jpg", song_id));
    if thumb_path.exists() {
        thumb_path.to_str().map(String::from)
    } else {
        None
    }
}

/// 生成 128px 宽 jpeg 缩略图(内嵌封面用)
fn generate_thumbnail(data: &[u8], song_id: &str) -> Option<String> {
    use image::ImageReader;
    use std::io::Cursor;

    let reader = ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .ok()?;
    let img = reader.decode().ok()?;
    encode_thumbnail(&img, song_id)
}

/// 按封面文件路径生成缩略图(P1 优化)
///
/// 与 [generate_thumbnail] 的差别: 源图本身已经很小时直接返回源图路径,
/// 而不是返回 None 让调用方"拿全尺寸封面当缩略图"。
/// 列表里的 40px 头像位根本不需要 3000px 的原图, 那正是滚动内存尖峰的根源。
fn make_thumbnail_from_file(cover_path: &Path, song_id: &str) -> Option<String> {
    use image::ImageReader;

    let file = std::fs::File::open(cover_path).ok()?;
    let reader = ImageReader::new(std::io::BufReader::new(file))
        .with_guessed_format()
        .ok()?;
    let img = reader.decode().ok()?;

    if img.width() <= THUMB_WIDTH {
        return cover_path.to_str().map(String::from);
    }

    encode_thumbnail(&img, song_id)
}

/// 缩放 + 编码 + 落盘, 返回缩略图路径
fn encode_thumbnail(img: &image::DynamicImage, song_id: &str) -> Option<String> {
    if img.width() <= THUMB_WIDTH {
        return None;
    }

    let thumb = img.resize(
        THUMB_WIDTH,
        THUMB_WIDTH,
        image::imageops::FilterType::Triangle,
    );

    let thumb_dir = data_dir::get_thumbnails_dir().ok()?;
    if !thumb_dir.exists() {
        let _ = std::fs::create_dir_all(&thumb_dir);
    }
    let thumb_path = thumb_dir.join(format!("{}.jpg", song_id));

    let rgb = thumb.into_rgb8();
    let mut buf = Vec::with_capacity(8 * 1024);
    {
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, THUMB_QUALITY);
        encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .ok()?;
    }

    std::fs::write(&thumb_path, &buf).ok()?;
    thumb_path.to_str().map(String::from)
}

/// 清除所有封面与缩略图缓存
#[tauri::command]
pub fn clear_cover_cache() {
    if let Ok(cover_dir) = data_dir::get_covers_dir() {
        if cover_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&cover_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
    if let Ok(thumb_dir) = data_dir::get_thumbnails_dir() {
        if thumb_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&thumb_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

/// 为存量曲库补齐缩略图(P1 优化)
///
/// 历史版本把"同级封面图"原路径直接写进 cover_thumb_path, 列表只能拿全尺寸 JPEG 当缩略图:
/// 一张 3456x2160 的图解码后约 30MB, 快速滚动时整应用内存冲到 2.6GB。
/// 这里在后台线程逐首补生成 128px 缩略图, 并复用扫描阶段的进度事件让前端增量刷新。
///
/// 返回需要处理的歌曲数(0 表示曲库已全部就绪);实际生成在后台线程里进行。
#[tauri::command]
pub fn backfill_thumbnails(app: AppHandle) -> Result<u32, String> {
    let rows: Vec<(String, String, String)> = db::with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT song_hash, cover_path, song_path FROM songs
                 WHERE cover_path != ''
                   AND (cover_thumb_path = '' OR cover_thumb_path = cover_path)",
            )
            .map_err(|e| e.to_string())?;
        let iter = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for item in iter.flatten() {
            out.push(item);
        }
        Ok(out)
    })?;

    let total = rows.len() as u32;
    if total == 0 {
        return Ok(0);
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        let now = db::now_ms();
        for (idx, (song_hash, cover, song_path)) in rows.iter().enumerate() {
            let thumb = make_thumbnail_from_file(Path::new(cover), song_hash);
            if let Some(ref thumb_path) = thumb {
                let _ = db::with_conn(|conn| {
                    conn.execute(
                        "UPDATE songs SET cover_thumb_path = ?1, updated_at = ?2 WHERE song_hash = ?3",
                        rusqlite::params![thumb_path, now, song_hash],
                    )
                    .map_err(|e| e.to_string())?;
                    Ok(())
                });
            }
            // 前端按 Song.id(= 路径哈希)匹配, 与扫描阶段的进度事件保持一致
            let _ = handle.emit(
                "scan:enrich-progress",
                serde_json::json!({
                    "id": generate_id(song_path),
                    "file_path": song_path,
                    "cover_path": cover,
                    "cover_thumb_path": thumb,
                    "index": idx,
                    "total": total,
                }),
            );
        }
        let _ = handle.emit(
            "scan:enrich-complete",
            serde_json::json!({ "total": total }),
        );
    });

    Ok(total)
}

/// 基于字符串生成唯一 ID
fn generate_id(s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let unique = format!(
            "gaoshanliushui-scan-{}-{}",
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

    #[test]
    fn test_parse_filename_standard() {
        let (artist, title) = parse_filename(Path::new("music/周杰伦 - 晴天.mp3"));
        assert_eq!(artist, "周杰伦");
        assert_eq!(title, "晴天");
    }

    #[test]
    fn test_parse_filename_without_spaces() {
        let (artist, title) = parse_filename(Path::new("music/刀酱-520AM.flac"));
        assert_eq!(artist, "刀酱");
        assert_eq!(title, "520AM");
    }

    #[test]
    fn test_parse_filename_accepts_dash_variants() {
        // 半角连字符 / 短破折号 / 长破折号都应识别
        for sep in ["-", "–", "—"] {
            let path = format!("music/歌手{}歌名.mp3", sep);
            let (artist, title) = parse_filename(Path::new(&path));
            assert_eq!(artist, "歌手", "分隔符 {:?} 未识别", sep);
            assert_eq!(title, "歌名", "分隔符 {:?} 未识别", sep);
        }
    }

    #[test]
    fn test_parse_filename_keeps_extra_dashes_in_title() {
        let (artist, title) = parse_filename(Path::new("music/歌手 - 歌名 - 现场版.mp3"));
        assert_eq!(artist, "歌手");
        assert_eq!(title, "歌名 - 现场版");
    }

    #[test]
    fn test_parse_filename_without_separator_returns_empty() {
        let (artist, title) = parse_filename(Path::new("music/单纯一个歌名.mp3"));
        assert_eq!(artist, "");
        assert_eq!(title, "");
    }

    #[test]
    fn test_find_sibling_cover_prefers_earlier_extension() {
        let dir = temp_dir("sibling");
        std::fs::write(dir.join("song.mp3"), b"x").unwrap();
        std::fs::write(dir.join("song.png"), b"x").unwrap();
        std::fs::write(dir.join("song.jpg"), b"x").unwrap();

        let found = find_sibling_cover_image(&dir.join("song.mp3")).expect("应找到同级封面");
        // COVER_IMAGE_EXTENSIONS 中 jpg 在 png 之前
        assert_eq!(found, dir.join("song.jpg").to_str().unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_sibling_cover_ignores_other_names() {
        let dir = temp_dir("sibling-miss");
        std::fs::write(dir.join("song.mp3"), b"x").unwrap();
        std::fs::write(dir.join("other.jpg"), b"x").unwrap();

        assert!(find_sibling_cover_image(&dir.join("song.mp3")).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_sibling_cover_requires_image_file() {
        let dir = temp_dir("sibling-dir");
        std::fs::write(dir.join("song.mp3"), b"x").unwrap();
        // 同名但却是目录, 不应被当成封面
        std::fs::create_dir_all(dir.join("song.jpg")).unwrap();

        assert!(find_sibling_cover_image(&dir.join("song.mp3")).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_generate_id_is_stable_for_same_input() {
        assert_eq!(
            generate_id("D:\\Music\\a.mp3"),
            generate_id("D:\\Music\\a.mp3")
        );
        assert_ne!(
            generate_id("D:\\Music\\a.mp3"),
            generate_id("D:\\Music\\b.mp3")
        );
    }

    /// 解析正则必须全局复用同一实例, 而不是每次调用重新编译
    #[test]
    fn test_filename_regex_is_reused() {
        let first = filename_split_re() as *const Regex;
        let second = filename_split_re() as *const Regex;
        assert!(std::ptr::eq(first, second), "正则应复用同一实例");
    }
}
