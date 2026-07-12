use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use std::borrow::Cow;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use regex::Regex;
use walkdir::WalkDir;

use crate::models::Song;

/// 支持的音频文件扩展名
const SUPPORTED_EXTENSIONS: &[&str] = &["mp3", "mp4", "flac", "wav", "m4a", "aac", "ogg", "wma"];

/// 支持的图片扩展名
const COVER_IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp"];

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

    // 强制刷新时，先删除旧的封面缓存
    if force_refresh {
        let temp_dir = std::env::temp_dir().join("bilibili-music-player-covers");
        let cover_path = temp_dir.join(format!("{}.jpg", id));
        if cover_path.exists() {
            let _ = std::fs::remove_file(&cover_path);
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
        let cover_path = find_sibling_cover_image(file_path);
        return Ok(Song {
            id,
            file_path: file_path_str,
            title,
            artist,
            album: String::new(),
            duration,
            cover_path,
        });
    }

    // 尝试解析 ID3 标签
    let (title, artist, album, duration, cover_path) = match Probe::open(file_path) {
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
                let cover_path = extract_cover_art(file_path, &id)
                    .or_else(|| find_sibling_cover_image(file_path));

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

                (title, artist, album, duration, cover_path)
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
                let cover_path = find_sibling_cover_image(file_path);
                (title, artist, String::new(), 0u64, cover_path)
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
            let cover_path = find_sibling_cover_image(file_path);
            (title, artist, String::new(), 0u64, cover_path)
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

/// 提取音频文件中的封面图片，保存到临时目录
fn extract_cover_art(file_path: &Path, song_id: &str) -> Option<String> {
    let tagged_file = Probe::open(file_path).ok()?.read().ok()?;

    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag())?;

    // 查找封面图片
    let pictures = tag.pictures();
    if pictures.is_empty() {
        return None;
    }

    let picture = &pictures[0];

    // 创建临时目录
    let temp_dir = std::env::temp_dir().join("bilibili-music-player-covers");
    if !temp_dir.exists() {
        let _ = std::fs::create_dir_all(&temp_dir);
    }

    // 保存封面图片
    let cover_filename = format!("{}.jpg", song_id);
    let cover_path = temp_dir.join(&cover_filename);

    if std::fs::write(&cover_path, picture.data()).is_ok() {
        cover_path.to_str().map(|s| s.to_string())
    } else {
        None
    }
}

/// 清除所有封面缓存
fn clear_cover_cache() {
    let temp_dir = std::env::temp_dir().join("bilibili-music-player-covers");
    if temp_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&temp_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(&path);
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