// 批量响度归一化（阶段三 · 离线高级功能）
//
// 功能:
//   - 调用内置 ffmpeg sidecar，对用户指定的 MP3 执行 EBU R128 loudnorm 两遍处理
//       Pass1: 测量 input_i / input_tp / input_lra / input_thresh / target_offset
//       Pass2: 代入测量值线性归一化到目标 I（默认 -14 LUFS，TP -1.5，LRA 11）
//   - 输出到同目录临时文件，再经备份文件原子替换原文件（失败可回滚）
//   - 归一化后内容指纹会变化，同步把 memories.song_hash 从旧指纹迁移到新指纹，
//     保持"高山流水"回忆关联不丢失
//   - 全过程通过 "loudnorm://progress" 事件上报进度（start/done/error/finished）
//
// 边界:
//   - 与实时音量均衡开关完全独立
//   - 会修改并替换原文件；前端需二次确认并提示用户备份、暂停播放
//   - 顺序处理（非并发）：单用户桌面场景足够，避免多进程 ffmpeg 抢占 CPU/内存

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;

use crate::commands::db;
use crate::commands::song_hash::compute_content_hash;

/// 进度事件载荷（前后端共享结构）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnormEvent {
    /// 当前序号（0-based；finished 时等于 total）
    pub index: usize,
    /// 总文件数
    pub total: usize,
    /// 当前处理文件绝对路径
    pub file: String,
    /// 状态: start | done | error | finished
    pub status: String,
    /// 附加信息（error 时为错误描述）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Pass1 测得的输入响度（done 时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_i: Option<f64>,
}

/// Pass1 测量结果
struct LoudnormMeasurement {
    input_i: f64,
    input_tp: f64,
    input_lra: f64,
    input_thresh: f64,
    target_offset: f64,
}

/// 批量归一化入口命令
///
/// # 参数
/// - `paths`: 待处理 MP3 的绝对路径列表
/// - `target_i`: 目标集成响度（LUFS），缺省 -14
///
/// # 返回
/// 成功处理的文件数
#[tauri::command]
pub async fn normalize_songs_loudness(
    app: AppHandle,
    paths: Vec<String>,
    target_i: Option<f64>,
) -> Result<u32, String> {
    let target = target_i.unwrap_or(-14.0);
    let total = paths.len();
    let mut success_count: u32 = 0;

    for (index, path_str) in paths.iter().enumerate() {
        let input_path = PathBuf::from(path_str);

        let _ = app.emit(
            "loudnorm://progress",
            LoudnormEvent {
                index,
                total,
                file: path_str.clone(),
                status: "start".to_string(),
                message: None,
                input_i: None,
            },
        );

        match normalize_one(&app, &input_path, target).await {
            Ok(measured) => {
                success_count += 1;
                let _ = app.emit(
                    "loudnorm://progress",
                    LoudnormEvent {
                        index,
                        total,
                        file: path_str.clone(),
                        status: "done".to_string(),
                        message: None,
                        input_i: Some(measured),
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "loudnorm://progress",
                    LoudnormEvent {
                        index,
                        total,
                        file: path_str.clone(),
                        status: "error".to_string(),
                        message: Some(e),
                        input_i: None,
                    },
                );
            }
        }
    }

    let _ = app.emit(
        "loudnorm://progress",
        LoudnormEvent {
            index: total,
            total,
            file: String::new(),
            status: "finished".to_string(),
            message: Some(format!("成功 {}/{} 首", success_count, total)),
            input_i: None,
        },
    );

    Ok(success_count)
}

/// 处理单个文件：测量 → 归一化输出 → 替换 → 指纹迁移
async fn normalize_one(app: &AppHandle, path: &Path, target: f64) -> Result<f64, String> {
    if !path.exists() {
        return Err("文件不存在".to_string());
    }
    let path_str = path
        .to_str()
        .ok_or_else(|| "文件路径包含非 UTF-8 字符".to_string())?
        .to_string();

    // 归一化前的内容指纹（回忆迁移用）
    let old_hash = compute_content_hash(path);

    // ---------- Pass1: 测量 ----------
    let analysis_args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-i".into(),
        path_str.clone(),
        "-af".into(),
        "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let (_, stderr) = run_ffmpeg(app, analysis_args).await?;
    let measurement =
        parse_loudnorm_json(&stderr).ok_or_else(|| "无法解析 ffmpeg 响度测量结果".to_string())?;

    // ---------- Pass2: 线性归一化到临时文件 ----------
    let parent = path
        .parent()
        .ok_or_else(|| "无法解析文件所在目录".to_string())?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let tmp_path = parent.join(format!("{}.loudnorm-tmp.mp3", stem));
    // 清理上次失败可能残留的临时文件
    let _ = fs::remove_file(&tmp_path);

    let filter = format!(
        "loudnorm=I={target}:TP=-1.5:LRA=11:\
         measured_I={mi}:measured_TP={mtp}:measured_LRA={mlra}:\
         measured_thresh={mth}:offset={off}:linear=true:print_format=summary",
        target = target,
        mi = measurement.input_i,
        mtp = measurement.input_tp,
        mlra = measurement.input_lra,
        mth = measurement.input_thresh,
        off = measurement.target_offset
    );

    let normalize_args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        path_str.clone(),
        "-af".into(),
        filter,
        // 保留内嵌封面（attached_pic）与全部元数据
        "-map".into(),
        "0:a?".into(),
        "-map".into(),
        "0:v?".into(),
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        "libmp3lame".into(),
        "-b:a".into(),
        "192k".into(),
        "-map_metadata".into(),
        "0".into(),
        "-id3v2_version".into(),
        "3".into(),
        tmp_path
            .to_str()
            .ok_or_else(|| "临时文件路径包含非 UTF-8 字符".to_string())?
            .to_string(),
    ];
    let _ = run_ffmpeg(app, normalize_args).await?;

    // ---------- 备份 + 原子替换（失败回滚） ----------
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "无法解析文件名".to_string())?;
    let bak_path = parent.join(format!("{}.bak", file_name));
    let _ = fs::remove_file(&bak_path);

    fs::rename(path, &bak_path).map_err(|e| format!("备份原文件失败: {}", e))?;
    if let Err(e) = fs::rename(&tmp_path, path) {
        // 替换失败：尽量把备份恢复回原路径
        let _ = fs::rename(&bak_path, path);
        return Err(format!("替换原文件失败，已恢复: {}", e));
    }
    let _ = fs::remove_file(&bak_path);

    // ---------- 迁移回忆内容指纹 ----------
    let new_hash = compute_content_hash(path);
    if let (Some(old), Some(new)) = (old_hash, new_hash) {
        if old != new {
            let app_clone = app.clone();
            let new_path = path_str.clone();
            let _ = db::run_db(&app_clone, move |conn| {
                conn.execute(
                    "UPDATE memories SET song_hash = ?1, song_path = ?2 WHERE song_hash = ?3",
                    params![new, new_path, old],
                )
                .map_err(|e| format!("迁移回忆指纹失败: {}", e))?;
                Ok(())
            })
            .await;
        }
    }

    Ok(measurement.input_i)
}

/// 执行内置 ffmpeg sidecar，返回 (stdout, stderr)；非零退出码时返回错误
async fn run_ffmpeg(app: &AppHandle, args: Vec<String>) -> Result<(Vec<u8>, Vec<u8>), String> {
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
        // 仅保留末尾 200 字符，避免错误信息过长
        let tail: String = stderr
            .chars()
            .rev()
            .take(200)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err(format!(
            "ffmpeg 处理失败 (exit={}): {}",
            output.status.code().unwrap_or(-1),
            tail
        ));
    }

    Ok((output.stdout, output.stderr))
}

/// 从 ffmpeg loudnorm Pass1 的 stderr 中解析末尾的 JSON 测量结果
fn parse_loudnorm_json(stderr: &[u8]) -> Option<LoudnormMeasurement> {
    let text = String::from_utf8_lossy(stderr);
    // loudnorm 在输出末尾打印唯一的 JSON 对象
    let start = text.rfind('{')?;
    let tail = &text[start..];
    let end_rel = tail.find('}')?;
    let json_str = &tail[..=end_rel];

    let value: serde_json::Value = serde_json::from_str(json_str).ok()?;

    // JSON 中各字段为字符串形式的数值，如 "input_i": "-23.0"
    let field = |name: &str| -> Option<f64> { value.get(name)?.as_str()?.parse().ok() };

    Some(LoudnormMeasurement {
        input_i: field("input_i")?,
        input_tp: field("input_tp")?,
        input_lra: field("input_lra")?,
        input_thresh: field("input_thresh")?,
        target_offset: field("target_offset")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_STDERR: &str = "[Parsed_loudnorm_0 @ 000001] \n{\n\t\"input_i\" : \"-23.05\",\n\t\"input_tp\" : \"-5.20\",\n\t\"input_lra\" : \"7.10\",\n\t\"input_thresh\" : \"-33.27\",\n\t\"output_i\" : \"-14.02\",\n\t\"target_offset\" : \"0.13\"\n}\n";

    #[test]
    fn test_parse_loudnorm_json_reads_trailing_json() {
        let measurement =
            parse_loudnorm_json(SAMPLE_STDERR.as_bytes()).expect("应解析出 loudnorm 测量值");
        assert!((measurement.input_i - (-23.05)).abs() < 1e-9);
        assert!((measurement.input_tp - (-5.20)).abs() < 1e-9);
        assert!((measurement.input_lra - 7.10).abs() < 1e-9);
        assert!((measurement.input_thresh - (-33.27)).abs() < 1e-9);
        assert!((measurement.target_offset - 0.13).abs() < 1e-9);
    }

    #[test]
    fn test_parse_loudnorm_json_returns_none_on_invalid_input() {
        assert!(parse_loudnorm_json(b"").is_none(), "空输入应返回 None");
        assert!(
            parse_loudnorm_json(b"[loudnorm] no json here").is_none(),
            "没有 JSON 对象应返回 None"
        );
        assert!(
            parse_loudnorm_json(br#"{"input_i":"-23.0"}"#).is_none(),
            "字段缺失时应返回 None"
        );
        assert!(
            parse_loudnorm_json(br#"{"input_i":"not-a-number","input_tp":"0","input_lra":"0","input_thresh":"0","target_offset":"0"}"#)
                .is_none(),
            "数值字段不可解析时应返回 None"
        );
    }
}
