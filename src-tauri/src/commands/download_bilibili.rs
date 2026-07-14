// B站音乐下载命令模块
// 解析视频分享链接 → 获取视频信息 → 下载音频流(m4a) → ffmpeg转mp3 → 下载封面
//
// FFmpeg 调用统一通过 Tauri 2 的 sidecar 机制实现,无需用户手动安装 ffmpeg:
//   - 二进制位于 src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe
//   - 通过 tauri-plugin-shell 的 app.shell().sidecar("ffmpeg") 调用
//   - 运行时由 Tauri 解析为应用资源目录下的实际路径,自动跨环境(dev/build)适配
//
// 保留所有现有 FFmpeg 命令参数、转码进度事件名(convert-progress 仍由前端监听)与前端交互逻辑,
// 仅替换可执行文件的调用来源。

use std::path::Path;
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use tokio::io::AsyncWriteExt;

/// 读取批量下载文档 (.md / .txt)
/// 返回 UTF-8 解码后的文件内容, 由前端负责解析为条目。
/// 限定扩展名: .md / .txt / .markdown (防止用户误选二进制文件)
#[tauri::command]
pub async fn read_batch_file(path: String) -> Result<String, String> {
    use std::path::Path;

    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    if !p.is_file() {
        return Err(format!("不是文件: {}", path));
    }

    // 扩展名校验
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "md" | "txt" | "markdown") {
        return Err(format!(
            "仅支持 .md / .txt / .markdown 文件,当前扩展名: .{}",
            ext
        ));
    }

    // 读取并尝试 UTF-8 解码,失败时退回 lossy
    let bytes = std::fs::read(p).map_err(|e| format!("读取文件失败: {}", e))?;
    let content = String::from_utf8(bytes.clone())
        .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).to_string());

    // 文件大小上限 2MB, 防止误选超大文件卡住 UI
    if content.len() > 2 * 1024 * 1024 {
        return Err(format!("文件过大 (>2MB): {}", path));
    }

    Ok(content)
}

/// 视频信息（前端展示用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub bvid: String,
    pub title: String,
    pub cover_url: String,
    pub duration: u64,
}

/// 文件名清洗（去除 Windows 非法字符与括号内容）
fn sanitize_filename(name: &str) -> String {
    if name.is_empty() {
        return String::from("未知");
    }
    // 去除 Windows 非法字符
    let illegal = Regex::new("[\\\\/:*?\"<>|]").unwrap();
    let cleaned = illegal.replace_all(name, "").to_string();
    // 去除半角英文括号及其中内容
    let en_paren = Regex::new("\\([^)]*\\)").unwrap();
    let cleaned = en_paren.replace_all(&cleaned, "").to_string();
    let trimmed = cleaned.trim().chars().take(80).collect::<String>();
    if trimmed.is_empty() {
        String::from("未知")
    } else {
        trimmed
    }
}

/// 从分享链接/普通 URL/纯 BV 号中提取 BVID
fn extract_bvid(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(String::from("链接不能为空"));
    }
    // 直接是 BV 号
    let bv_re = Regex::new("^BV([a-zA-Z0-9]+)$").unwrap();
    if let Some(c) = bv_re.captures(trimmed) {
        return Ok(format!("BV{}", &c[1]));
    }
    // 包含 bilibili.com/video/BVxxxx
    let url_re = Regex::new("(BV[a-zA-Z0-9]{10})").unwrap();
    if let Some(c) = url_re.captures(trimmed) {
        return Ok(c[1].to_string());
    }
    // 也兼容 av 号
    let av_re = Regex::new("av(\\d+)").unwrap();
    if let Some(c) = av_re.captures(trimmed) {
        return Ok(format!("av{}", &c[1]));
    }
    Err(String::from("无法识别有效的视频链接"))
}

/// 获取视频信息（B 站 /x/web-interface/view）
async fn fetch_video_info(bvid: &str, client: &reqwest::Client) -> Result<serde_json::Value, String> {
    let url = format!("https://api.bilibili.com/x/web-interface/view?bvid={}", bvid);
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header("Referer", format!("https://www.bilibili.com/video/{}", bvid))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("请求视频信息失败: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析视频信息 JSON 失败: {}", e))?;

    if json.get("code").and_then(|v| v.as_i64()) != Some(0) {
        let msg = json
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("B站 API 错误: {}", msg));
    }

    json.get("data")
        .cloned()
        .ok_or_else(|| String::from("视频信息 data 字段缺失"))
}

/// 获取音频直链和封面
async fn fetch_audio_and_cover(
    bvid: &str,
    cid: u64,
    client: &reqwest::Client,
) -> Result<(String, String), String> {
    let url = format!(
        "https://api.bilibili.com/x/player/playurl?bvid={}&cid={}&fnval=16&qn=64",
        bvid, cid
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .header("Referer", format!("https://www.bilibili.com/video/{}", bvid))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("请求播放地址失败: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析播放地址 JSON 失败: {}", e))?;

    if json.get("code").and_then(|v| v.as_i64()) != Some(0) {
        let msg = json
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("B站 playurl 错误: {}", msg));
    }

    let dash = json
        .pointer("/data/dash")
        .ok_or_else(|| String::from("响应中无 dash 数据"))?;

    let audio_arr = dash
        .get("audio")
        .and_then(|v| v.as_array())
        .ok_or_else(|| String::from("dash 中无 audio 列表"))?;

    if audio_arr.is_empty() {
        return Err(String::from("未找到可用音频流"));
    }

    // 选择最高码率音频
    let mut audios = audio_arr.clone();
    audios.sort_by(|a, b| {
        let ba = a.get("bandwidth").and_then(|v| v.as_u64()).unwrap_or(0);
        let bb = b.get("bandwidth").and_then(|v| v.as_u64()).unwrap_or(0);
        bb.cmp(&ba)
    });

    let audio_url = audios[0]
        .get("baseUrl")
        .or_else(|| audios[0].get("base_url"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| String::from("音频地址缺失"))?
        .to_string();

    Ok((audio_url, String::new()))
}

/// 解析 B 站链接（仅获取信息，不下载）
#[tauri::command]
pub async fn parse_bilibili_url(url: String) -> Result<VideoInfo, String> {
    let bvid = extract_bvid(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let info = fetch_video_info(&bvid, &client).await?;

    let title = info
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("未知标题")
        .to_string();

    let duration = info
        .get("duration")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let mut cover_url = info
        .get("pic")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if cover_url.starts_with("//") {
        cover_url = format!("https:{}", cover_url);
    }

    Ok(VideoInfo {
        bvid,
        title,
        cover_url,
        duration,
    })
}

/// 进度事件 payload
#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    stage: String,        // "parsing" | "downloading_audio" | "converting" | "downloading_cover" | "done" | "error"
    message: String,
    percent: u8,          // 0-100
}

/// 通过 Tauri sidecar 机制执行 FFmpeg
///
/// 参数与现有逻辑完全一致,仅替换可执行文件来源:
///   ffmpeg -i <input> -vn -c:a libmp3lame -b:a 192k -ar 44100 -ac 2
///         -metadata title=<song> -metadata artist=<singer>
///         -id3v2_version 3 -y <output>
///
/// 返回执行是否成功（success）。错误信息从 stderr 解码。
/// 这里使用 `output()` 一次性执行,与原 `Command::new(...).status()` 行为等价（丢弃 stdout），
/// 不破坏前端进度事件流；如需解析 stderr 实现真实转码进度,可改为 `spawn()` + `CommandEvent::Stderr` 监听。
async fn run_ffmpeg_sidecar(
    app: &AppHandle,
    args: Vec<String>,
) -> Result<bool, String> {
    // sidecar("ffmpeg") 会由 Tauri 解析为内置 ffmpeg 的实际路径并执行。
    // 在 dev 与打包后均可工作：dev 时位于 src-tauri/binaries/，打包时随安装包分发到应用资源目录。
    let command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("无法加载内置 ffmpeg sidecar: {}", e))?;

    let output = command
        .args(args)
        .output()
        .await
        .map_err(|e| format!("执行 ffmpeg 失败: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 仅返回末尾 200 字符以避免错误信息过长
        let tail: String = stderr.chars().rev().take(200).collect::<String>().chars().rev().collect();
        return Err(format!("ffmpeg 转换失败 (exit={}): {}", output.status.code().unwrap_or(-1), tail));
    }

    Ok(true)
}

/// 下载并转换为 MP3
#[tauri::command]
pub async fn download_bilibili_music(
    app: AppHandle,
    url: String,
    output_dir: String,
    singer: Option<String>,
    song: Option<String>,
) -> Result<String, String> {
    // 进度事件发送器 - 事件名 "download-progress" 与前端保持一致,确保进度条联动不受影响
    let emit_progress = |stage: &str, message: &str, percent: u8| {
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                stage: stage.to_string(),
                message: message.to_string(),
                percent,
            },
        );
    };

    emit_progress("parsing", "正在解析链接...", 5);

    let bvid = extract_bvid(&url)?;

    // 检查输出目录
    let out_path = Path::new(&output_dir);
    if !out_path.exists() {
        return Err(format!("输出目录不存在: {}", output_dir));
    }
    if !out_path.is_dir() {
        return Err(format!("输出路径不是文件夹: {}", output_dir));
    }

    // 探测 sidecar 是否可用,缺失即提前报错
    app.shell()
        .sidecar("ffmpeg")
        .map_err(|_| String::from("未找到内置 ffmpeg，请确认 src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe 存在"))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    // 1. 获取视频信息
    emit_progress("parsing", "正在获取视频信息...", 15);
    let info = fetch_video_info(&bvid, &client).await?;
    let cid = info
        .get("cid")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| String::from("视频缺少 cid"))?;
    let video_title = info
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("未知标题")
        .to_string();
    let mut cover_url = info
        .get("pic")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if cover_url.starts_with("//") {
        cover_url = format!("https:{}", cover_url);
    }

    // 2. 获取音频直链
    emit_progress("parsing", "正在获取音频地址...", 25);
    let (audio_url, _cover_from_dash) = fetch_audio_and_cover(&bvid, cid, &client).await?;

    // 3. 确定最终文件名
    let final_singer = match singer {
        Some(s) if !s.trim().is_empty() => sanitize_filename(s.trim()),
        _ => String::from("未知"),
    };
    let final_song = match song {
        Some(s) if !s.trim().is_empty() => sanitize_filename(s.trim()),
        _ => sanitize_filename(&video_title),
    };
    let base_name = format!("{}-{}", final_singer, final_song);
    let mp3_path = out_path.join(format!("{}.mp3", base_name));
    let cover_path = out_path.join(format!("{}.jpg", base_name));
    let temp_audio = out_path.join(format!("{}.temp.m4a", base_name));

    // 跳过已存在
    if mp3_path.exists() {
        let size = std::fs::metadata(&mp3_path)
            .map(|m| m.len())
            .unwrap_or(0);
        if size > 100 * 1024 {
            emit_progress("done", "文件已存在，跳过下载", 100);
            return Ok(mp3_path.to_string_lossy().to_string());
        }
    }

    // 4. 下载音频流
    emit_progress("downloading_audio", "正在下载音频...", 30);
    download_stream(
        &client,
        &audio_url,
        &format!("https://www.bilibili.com/video/{}", bvid),
        &temp_audio,
    )
    .await?;

    if !temp_audio.exists() {
        return Err(String::from("音频下载失败：文件未生成"));
    }

    // 5. 转换 MP3 —— 参数与原实现完全一致,仅改用 sidecar 调用
    emit_progress("converting", "正在转换为 MP3...", 60);
    let temp_mp3 = out_path.join(format!("{}.temp.mp3", base_name));

    let ffmpeg_args: Vec<String> = vec![
        "-i".to_string(),
        temp_audio.to_string_lossy().to_string(),
        "-vn".to_string(),
        "-c:a".to_string(),
        "libmp3lame".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        "-ar".to_string(),
        "44100".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-metadata".to_string(),
        format!("title={}", final_song),
        "-metadata".to_string(),
        format!("artist={}", final_singer),
        "-id3v2_version".to_string(),
        "3".to_string(),
        "-y".to_string(),
        temp_mp3.to_string_lossy().to_string(),
    ];

    let convert_ok = run_ffmpeg_sidecar(&app, ffmpeg_args).await?;

    // 清理临时音频
    if temp_audio.exists() {
        let _ = tokio::fs::remove_file(&temp_audio).await;
    }

    if !convert_ok {
        if temp_mp3.exists() {
            let _ = tokio::fs::remove_file(&temp_mp3).await;
        }
        return Err(String::from("ffmpeg 转换失败"));
    }

    if !temp_mp3.exists() {
        return Err(String::from("MP3 转换失败：输出文件未生成"));
    }

    // 重命名为最终 mp3
    tokio::fs::rename(&temp_mp3, &mp3_path)
        .await
        .map_err(|e| format!("重命名 MP3 失败: {}", e))?;

    // 6. 下载封面
    if !cover_url.is_empty() {
        emit_progress("downloading_cover", "正在下载封面...", 90);
        let _ = download_stream(
            &client,
            &cover_url,
            &format!("https://www.bilibili.com/video/{}", bvid),
            &cover_path,
        )
        .await;
    }

    emit_progress("done", "下载完成", 100);
    Ok(mp3_path.to_string_lossy().to_string())
}

/// 流式下载到文件（带 Range 断点续传支持）
async fn download_stream(
    client: &reqwest::Client,
    url: &str,
    referer: &str,
    save_path: &Path,
) -> Result<(), String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            .parse()
            .unwrap(),
    );
    headers.insert("Referer", referer.parse().unwrap());

    // 断点续传
    if let Ok(meta) = std::fs::metadata(save_path) {
        let size = meta.len();
        if size > 0 {
            headers.insert(
                "Range",
                format!("bytes={}-", size).parse().unwrap(),
            );
        }
    }

    let resp = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", e))?;

    if resp.status().as_u16() == 416 {
        // Range 越界，文件已完整
        return Ok(());
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP 状态码错误: {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应字节失败: {}", e))?;

    // 追加模式（如果已有部分内容）
    let mut file = if save_path.exists() {
        let existing = std::fs::metadata(save_path).map(|m| m.len()).unwrap_or(0);
        if existing > 0 {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(save_path)
                .await
                .map_err(|e| format!("打开已有文件失败: {}", e))?
        } else {
            tokio::fs::File::create(save_path)
                .await
                .map_err(|e| format!("创建文件失败: {}", e))?
        }
    } else {
        tokio::fs::File::create(save_path)
            .await
            .map_err(|e| format!("创建文件失败: {}", e))?
    };

    file.write_all(&bytes)
        .await
        .map_err(|e| format!("写入文件失败: {}", e))?;

    // 校验：体积过小视为失败
    if let Ok(meta) = std::fs::metadata(save_path) {
        if meta.len() < 1024 {
            let _ = tokio::fs::remove_file(save_path).await;
            return Err(String::from("下载内容过小，可能已失效"));
        }
    }

    Ok(())
}
