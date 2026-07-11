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

/// 递归扫描指定文件夹下的所有音频文件，并解析元数据
#[tauri::command]
pub async fn scan_music_folder(folder_path: String) -> Result<Vec<Song>, String> {
    let path = Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("路径不存在或不是文件夹: {}", folder_path));
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
                match parse_audio_file(file_path) {
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
fn parse_audio_file(file_path: &Path) -> Result<Song, String> {
    let file_path_str = file_path
        .to_str()
        .ok_or_else(|| format!("无效的文件路径: {:?}", file_path))?
        .to_string();

    // 生成唯一 ID（基于文件路径的哈希）
    let id = generate_id(&file_path_str);

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

                // 提取封面图片
                let cover_path = extract_cover_art(file_path, &id);

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
                (title, artist, String::new(), 0u64, None)
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
            (title, artist, String::new(), 0u64, None)
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

/// 基于字符串生成唯一 ID
fn generate_id(s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}