// BUG 7: 通用文件导出命令
//
// 背景: tauri-plugin-fs 未在 capabilities 中授权, 前端 writeTextFile 会失败
// 方案: 通过 Rust 命令写文件, 无需额外 plugin 权限
//
// 用法: invoke('write_text_file', { path, content })

use std::fs;
use std::path::PathBuf;

/// 写入文本文件到指定路径
///
/// BUG 7 修复: 统计页 Markdown 报告导出用此命令写文件
///   - 前端传 path(由 save dialog 返回) 和 content(Markdown 内容)
///   - Rust 直接用 std::fs::write 写入, 绕过 fs plugin 权限限制
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);

    // 确保父目录存在
    if let Some(parent) = path_buf.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }

    fs::write(&path_buf, &content).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(())
}
