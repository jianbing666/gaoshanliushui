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