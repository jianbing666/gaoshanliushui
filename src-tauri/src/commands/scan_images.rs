use std::path::Path;
use walkdir::WalkDir;

/// 支持的图片文件扩展名
const SUPPORTED_IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "svg",
];

/// 递归扫描指定文件夹下的所有图片文件
#[tauri::command]
pub async fn scan_image_folder(folder_path: String) -> Result<Vec<String>, String> {
    let path = Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!("路径不存在或不是文件夹: {}", folder_path));
    }

    let mut images = Vec::new();

    for entry in WalkDir::new(&folder_path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let file_path = entry.path();

        if file_path.is_file() {
            if let Some(ext) = file_path.extension() {
                if SUPPORTED_IMAGE_EXTENSIONS
                    .contains(&ext.to_ascii_lowercase().to_str().unwrap_or(""))
                {
                    if let Some(path_str) = file_path.to_str() {
                        images.push(path_str.to_string());
                    }
                }
            }
        }
    }

    images.sort();

    Ok(images)
}
