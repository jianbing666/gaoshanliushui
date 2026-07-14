// Memory feature - 高山流水 v1.1: 文件内容指纹
// 算法: 读取文件头部 64KB + 尾部 64KB, 拼接后做 SHA-1, 输出十六进制字符串
// 理由: 头尾足够唯一(绝大多数 mp3 内嵌元数据 + 末尾标签), 避免读整首歌阻塞扫描
// SHA-1 vs SHA-256: 16 字节摘要对音乐指纹足够, 比 SHA-256 快 ~30%, 哈希更短(40 hex vs 64 hex)
//
// 解耦设计:
//   - 路径 hash (DefaultHasher) 仍作为 Song.id (保持现有逻辑零侵入)
//   - content_hash 作为 SQLite 主键, 跨文件移动保持稳定

use sha1::{Digest, Sha1};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// 头部/尾部各采样 64KB
const SAMPLE_SIZE: usize = 64 * 1024;

/// 计算文件内容指纹
///
/// 失败返回 None (例如文件被占用、权限不足、文件小于 128KB 等)
/// 调用方需对 None 做容错 (扫描失败时不阻塞主流程)
pub fn compute_content_hash(file_path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(file_path).ok()?;
    let file_size = metadata.len();

    let mut file = File::open(file_path).ok()?;
    let mut hasher = Sha1::new();

    if file_size <= (SAMPLE_SIZE * 2) as u64 {
        // 文件小于等于 128KB: 读整个文件
        let mut buffer = Vec::with_capacity(file_size as usize);
        file.read_to_end(&mut buffer).ok()?;
        hasher.update(&buffer);
    } else {
        // 文件大于 128KB: 读头部 64KB + 尾部 64KB
        let mut head = vec![0u8; SAMPLE_SIZE];
        file.read_exact(&mut head).ok()?;
        hasher.update(&head);

        file.seek(SeekFrom::End(-(SAMPLE_SIZE as i64))).ok()?;
        let mut tail = vec![0u8; SAMPLE_SIZE];
        file.read_exact(&mut tail).ok()?;
        hasher.update(&tail);
    }

    let result = hasher.finalize();
    Some(hex::encode(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_small_file() {
        let tmp = std::env::temp_dir().join("test_small_hash.txt");
        let mut f = File::create(&tmp).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let hash = compute_content_hash(&tmp);
        assert!(hash.is_some());
        assert_eq!(hash.unwrap().len(), 40); // SHA-1 = 40 hex chars
    }

    #[test]
    fn test_large_file() {
        let tmp = std::env::temp_dir().join("test_large_hash.bin");
        let f = File::create(&tmp).unwrap();
        // 写入 200KB 数据, 强制走头尾采样路径
        let data: Vec<u8> = (0..200 * 1024).map(|i| (i % 256) as u8).collect();
        std::fs::write(&tmp, &data).unwrap();
        drop(f);

        let hash = compute_content_hash(&tmp);
        assert!(hash.is_some());
        assert_eq!(hash.unwrap().len(), 40);
    }
}
