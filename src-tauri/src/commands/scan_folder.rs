use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use std::borrow::Cow;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use regex::Regex;
use walkdir::WalkDir;

use crate::commands::song_hash::compute_content_hash;
use crate::models::Song;

/// 支持的音频文件扩展名
const SUPPORTED_EXTENSIONS: &[&str] = &["mp3", "mp4", "flac", "wav", "m4a", "aac", "ogg", "wma"];

/// 支持的图片扩展名
const COVER_IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp"];

/// ========== 阶段 3.1: 缩略图配置 ==========
/// 缩略图最大宽度
const THUMB_WIDTH: u32 = 128;
/// 缩略图 jpeg 质量
const THUMB_QUALITY: u8 = 75;
/// 缩略图缓存目录名
const THUMB_DIR: &str = "gaoshanliushui-covers-thumb";

/// 递归扫描指定文件夹下的所有音频文件，并解析元数据
#[tauri::command]
pub async fn scan_music_folder(
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

    // 如果强制刷新，清除封面缓存
    if force {
        clear_cover_cache();
    }

    let mut songs = Vec::new();

    // 递归遍历文件夹
    for entry in WalkDir::new(&folder_path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let file_path = entry.path();

        // 仅处理支持的音频文件
        if let Some(ext) = file_path.extension() {
            if SUPPORTED_EXTENSIONS.contains(&ext.to_ascii_lowercase().to_str().unwrap_or("")) {
                match parse_audio_file(file_path, use_filename_only, force) {
                    Ok(song) => songs.push(song),
                    Err(e) => {
                        // 解析失败的文件跳过，但不中断扫描
                        eprintln!("解析文件失败 {:?}: {}", file_path, e);
                    }
                }
            }
        }
    }

    // 按标题排序
    songs.sort_by(|a, b| a.title.cmp(&b.title));

    Ok(songs)
}

/// 解析单个音频文件，提取元数据
fn parse_audio_file(file_path: &Path, use_filename_only: bool, force_refresh: bool) -> Result<Song, String> {
    let file_path_str = file_path
        .to_str()
        .ok_or_else(|| format!("无效的文件路径: {:?}", file_path))?
        .to_string();

    // 生成唯一 ID（基于文件路径的哈希）
    let id = generate_id(&file_path_str);

    // Memory feature - 高山流水 v1.1: 计算文件内容指纹 (头尾 64KB SHA-1)
    // 失败不影响扫描主流程, 仅打印警告
    let content_hash = compute_content_hash(file_path);
    if content_hash.is_none() {
        eprintln!("[scan] 计算内容指纹失败 {:?}, 该歌曲无法关联历史回忆", file_path);
    }

    // 强制刷新时，先删除旧的封面缓存
    if force_refresh {
        let cover_dir = std::env::temp_dir().join("gaoshanliushui-covers");
        let cover_path = cover_dir.join(format!("{}.jpg", id));
        if cover_path.exists() {
            let _ = std::fs::remove_file(&cover_path);
        }
        // 阶段 3.1: 同步清理缩略图
        let thumb_dir = std::env::temp_dir().join(THUMB_DIR);
        let thumb_path = thumb_dir.join(format!("{}.jpg", id));
        if thumb_path.exists() {
            let _ = std::fs::remove_file(&thumb_path);
        }
    }

    if use_filename_only {
        // 仅使用文件名解析，不读取 ID3 标签
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
        // 尝试读取时长（仅读取文件属性，不解析标签）
        let duration = Probe::open(file_path)
            .ok()
            .and_then(|p| p.read().ok())
            .map(|f| f.properties().duration().as_secs())
            .unwrap_or(0);
        // 阶段 3.1: 文件名模式无内嵌封面, 缩略图与封面路径同步 (复用同级图片)
        let cover_path = find_sibling_cover_image(file_path);
        return Ok(Song {
            id,
            file_path: file_path_str,
            title,
            artist,
            album: String::new(),
            duration,
            cover_path: cover_path.clone(),
            cover_thumb_path: cover_path,
            content_hash,
        });
    }

    // 尝试解析 ID3 标签
    let (title, artist, album, duration, cover_path, cover_thumb_path) = match Probe::open(file_path) {
        Ok(probe) => match probe.read() {
            Ok(tagged_file) => {
                let duration = tagged_file.properties().duration().as_secs();

                // 从标签中提取元数据
                let (mut title, mut artist, mut album) = (String::new(), String::new(), String::new());

                if let Some(tag) = tagged_file.primary_tag() {
                    title = tag.title().unwrap_or(Cow::Borrowed("")).to_string();
                    artist = tag.artist().unwrap_or(Cow::Borrowed("")).to_string();
                    album = tag.album().unwrap_or(Cow::Borrowed("")).to_string();
                } else if let Some(tag) = tagged_file.first_tag() {
                    title = tag.title().unwrap_or(Cow::Borrowed("")).to_string();
                    artist = tag.artist().unwrap_or(Cow::Borrowed("")).to_string();
                    album = tag.album().unwrap_or(Cow::Borrowed("")).to_string();
                }

                // 提取封面图片（优先使用内嵌封面，否则尝试同名图片）
                // 阶段 3.1: 同时返回 (cover, thumb)
                let (mut cover_path, mut cover_thumb_path) = extract_cover_art(file_path, &id);

                // 同级图片兜底
                if cover_path.is_none() {
                    let sibling = find_sibling_cover_image(file_path);
                    cover_path = sibling.clone();
                    cover_thumb_path = sibling;
                }

                // 如果元数据缺失，尝试从文件名解析
                if title.is_empty() || artist.is_empty() {
                    let (parsed_artist, parsed_title) = parse_filename(file_path);
                    if title.is_empty() {
                        title = parsed_title;
                    }
                    if artist.is_empty() {
                        artist = parsed_artist;
                    }
                }

                // 如果标题仍为空，使用文件名
                if title.is_empty() {
                    title = file_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("未知歌曲")
                        .to_string();
                }

                (title, artist, album, duration, cover_path, cover_thumb_path)
            }
            Err(_e) => {
                // 解析标签失败，仅使用文件名
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
                let sibling = find_sibling_cover_image(file_path);
                (title, artist, String::new(), 0u64, sibling.clone(), sibling)
            }
        },
        Err(_) => {
            // 无法打开文件，使用文件名作为标题
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
            let sibling = find_sibling_cover_image(file_path);
            (title, artist, String::new(), 0u64, sibling.clone(), sibling)
        }
    };

    Ok(Song {
        id,
        file_path: file_path_str,
        title,
        artist,
        album,
        duration,
        cover_path,
        cover_thumb_path,
        content_hash,
    })
}

/// 从文件名解析 "歌手 - 歌名" 格式
fn parse_filename(file_path: &Path) -> (String, String) {
    let file_stem = match file_path.file_stem().and_then(|s| s.to_str()) {
        Some(stem) => stem,
        None => return (String::new(), String::new()),
    };

    // 正则匹配 "歌手 - 歌名" 格式
    let re = Regex::new(r"^(.+?)\s*[-–—]\s*(.+?)$").unwrap();
    if let Some(caps) = re.captures(file_stem) {
        let artist = caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        let title = caps.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        return (artist, title);
    }

    // 无法解析时，返回空
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
/// 返回 (原图路径, 缩略图路径), 任一失败不影响另一者
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

    // 1. 保存原图
    let cover_dir = std::env::temp_dir().join("gaoshanliushui-covers");
    if !cover_dir.exists() {
        let _ = std::fs::create_dir_all(&cover_dir);
    }
    let cover_path = cover_dir.join(format!("{}.jpg", song_id));
    let cover_str = match std::fs::write(&cover_path, picture.data()) {
        Ok(_) => cover_path.to_str().map(String::from),
        Err(_) => None,
    };

    // 2. 阶段 3.1: 生成缩略图 (失败不回退, 不阻塞)
    let thumb_str = generate_thumbnail(picture.data(), song_id);

    (cover_str, thumb_str)
}

/// 阶段 3.1: 生成 128px 宽 jpeg 缩略图
/// 失败时返回 None (不影响主流程)
fn generate_thumbnail(data: &[u8], song_id: &str) -> Option<String> {
    use image::ImageReader;
    use std::io::Cursor;

    let reader = ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .ok()?;
    let img = reader.decode().ok()?;

    // 原图已很小, 无需缩放
    if img.width() <= THUMB_WIDTH {
        return None;
    }

    let thumb = img.resize(
        THUMB_WIDTH,
        THUMB_WIDTH,
        image::imageops::FilterType::Triangle,
    );

    // 确保缩略图目录存在
    let thumb_dir = std::env::temp_dir().join(THUMB_DIR);
    if !thumb_dir.exists() {
        let _ = std::fs::create_dir_all(&thumb_dir);
    }
    let thumb_path = thumb_dir.join(format!("{}.jpg", song_id));

    // 编码为 jpeg (RGB 8-bit, 减小编码复杂度)
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