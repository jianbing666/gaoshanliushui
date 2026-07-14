use serde::{Deserialize, Serialize};

/// 歌曲数据模型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Song {
    /// 唯一标识（基于文件路径的哈希）
    pub id: String,
    /// 文件绝对路径
    pub file_path: String,
    /// 歌曲标题
    pub title: String,
    /// 艺术家
    pub artist: String,
    /// 专辑名
    pub album: String,
    /// 时长（秒）
    pub duration: u64,
    /// 封面图片路径（提取后保存到临时目录）
    pub cover_path: Option<String>,
    /// 缩略图路径（128px 宽, 保存到 temp_dir/gaoshanliushui-covers-thumb/, 旧数据为 None）
    #[serde(default)]
    pub cover_thumb_path: Option<String>,
    /// Memory feature - 高山流水 v1.1: 文件内容指纹（头尾各 64KB 的 SHA-1, 16 进制字符串）
    /// 与路径解耦, 用户移动/重命名文件后能继续匹配历史回忆
    /// 旧数据为 None, 前端需做容错
    #[serde(default)]
    pub content_hash: Option<String>,
}

/// 循环模式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub enum LoopMode {
    /// 列表循环
    List,
    /// 单曲循环
    Single,
    /// 不循环
    None,
}