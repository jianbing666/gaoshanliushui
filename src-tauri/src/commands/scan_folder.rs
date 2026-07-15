use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Arc;

use std::borrow::Cow;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use regex::Regex;
use walkdir::WalkDir;

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
const THUMB_DIR: &str = "gaoshanliushui-covers-thumb";

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

    // ========== 阶段 2: 后台异步补全封面 + 缩略图 ==========
    // 文件名模式下也可能有同级封面图片，所以也需要阶段2
    let app_handle = app.clone();
    let songs_arc = Arc::new(songs.clone());
    std::thread::spawn(move || {
        enrich_covers_async(app_handle, audio_files, songs_arc, force, use_filename_only);
    });

    Ok(songs)
}

/// 阶段 1 解析: 快速返回基础元数据
/// - 文件名解析 或 ID3 标题/艺术家/专辑
/// - duration (lofty Probe, 仅读文件属性)
/// - content_hash (头尾 64KB SHA-1)
/// 不做: 封面提取 + 缩略图生成（最耗时）
fn parse_audio_file_phase1(
    file_path: &Path,
    use_filename_only: bool,
) -> Result<Song, String> {
    let file_path_str = file_path
        .to_str()
        .ok_or_else(|| format!("无效的文件路径: {:?}", file_path))?
        .to_string();

    let id = generate_id(&file_path_str);

    // 计算 content_hash (记忆功能需要，必须阶段1就有)
    let content_hash = compute_content_hash(file_path);

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
        return Ok(Song {
            id,
            file_path: file_path_str,
            title,
            artist,
            album: String::new(),
            duration,
            cover_path: sibling_cover.clone(),
            cover_thumb_path: sibling_cover,
            content_hash,
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

    Ok(Song {
        id,
        file_path: file_path_str,
        title,
        artist,
        album,
        duration,
        cover_path: sibling_cover.clone(),
        cover_thumb_path: sibling_cover,
        content_hash,
    })
}

/// 阶段 2 后台异步: 补全封面 + 缩略图
/// - 内嵌封面提取 + 缩略图生成
/// - 每完成一首 emit 一次增量事件
fn enrich_covers_async(
    app: AppHandle,
    audio_files: Vec<std::path::PathBuf>,
    _songs: Arc<Vec<Song>>,
    force_refresh: bool,
    use_filename_only: bool,
) {
    let total = audio_files.len();

    for (idx, file_path) in audio_files.iter().enumerate() {
        let file_path_str = match file_path.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let id = generate_id(&file_path_str);

        if force_refresh {
            let cover_dir = std::env::temp_dir().join("gaoshanliushui-covers");
            let _ = std::fs::remove_file(cover_dir.join(format!("{}.jpg", id)));
            let thumb_dir = std::env::temp_dir().join(THUMB_DIR);
            let _ = std::fs::remove_file(thumb_dir.join(format!("{}.jpg", id)));
        }

        // 文件名模式下只检查同级图片（阶段1已做），跳过内嵌封面提取
        let (cover_path, cover_thumb_path) = if use_filename_only {
            let sibling = find_sibling_cover_image(file_path);
            (sibling.clone(), sibling)
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
            // 同级图片兜底
            if cover_path.is_none() {
                if let Some(sibling) = find_sibling_cover_image(file_path) {
                    (Some(sibling.clone()), Some(sibling))
                } else {
                    (cover_path, cover_thumb_path)
                }
            } else {
                (cover_path, cover_thumb_path)
            }
        };

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

/// 从文件名解析 "歌手 - 歌名" 格式
fn parse_filename(file_path: &Path) -> (String, String) {
    let file_stem = match file_path.file_stem().and_then(|s| s.to_str()) {
        Some(stem) => stem,
        None => return (String::new(), String::new()),
    };

    let re = Regex::new(r"^(.+?)\s*[-–—]\s*(.+?)$").unwrap();
    if let Some(caps) = re.captures(file_stem) {
        let artist = caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        let title = caps.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
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

    let tag = match tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
        Some(t) => t,
        None => return (None, None),
    };

    let pictures = tag.pictures();
    if pictures.is_empty() {
        return (None, None);
    }

    let picture = &pictures[0];

    let cover_dir = std::env::temp_dir().join("gaoshanliushui-covers");
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

/// 生成 128px 宽 jpeg 缩略图
fn generate_thumbnail(data: &[u8], song_id: &str) -> Option<String> {
    use image::ImageReader;
    use std::io::Cursor;

    let reader = ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .ok()?;
    let img = reader.decode().ok()?;

    if img.width() <= THUMB_WIDTH {
        return None;
    }

    let thumb = img.resize(
        THUMB_WIDTH,
        THUMB_WIDTH,
        image::imageops::FilterType::Triangle,
    );

    let thumb_dir = std::env::temp_dir().join(THUMB_DIR);
    if !thumb_dir.exists() {
        let _ = std::fs::create_dir_all(&thumb_dir);
    }
    let thumb_path = thumb_dir.join(format!("{}.jpg", song_id));

    let rgb = thumb.into_rgb8();
    let mut buf = Vec::with_capacity(8 * 1024);
    {
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, THUMB_QUALITY);
        if encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .is_err()
        {
            return None;
        }
    }

    std::fs::write(&thumb_path, &buf).ok()?;
    thumb_path.to_str().map(String::from)
}

/// 清除所有封面与缩略图缓存
#[tauri::command]
pub fn clear_cover_cache() {
    for dir_name in &["gaoshanliushui-covers", THUMB_DIR] {
        let dir = std::env::temp_dir().join(dir_name);
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
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

/// 基于字符串生成唯一 ID
fn generate_id(s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
