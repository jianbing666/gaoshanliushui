#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站歌单下载器（附件6专用·分离版）
功能：生成独立MP3 + 独立封面JPG，不嵌入封面
"""

import requests
import re
import subprocess
import os
import time
import shutil
from pathlib import Path

# ==================== 配置区（按需修改） ====================
OUTPUT_DIR = r"D:\Music"
NOTES_FILE = "9f3463c7-f72f-455d-9d3f-4c15b7c5f998_临时笔记.md"

FFMPEG_PATHS = [
    r"C:\Users\李国志\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffmpeg.exe",
    r"ffmpeg",
]

AUDIO_BITRATE = "192k"
MAX_RETRIES = 3
REQUEST_INTERVAL = 1.5
MIN_MP3_SIZE_KB = 100
# ==========================================================


def log(msg, level="INFO"):
    prefix = {"INFO":"ℹ️","SUCCESS":"✅","ERROR":"❌","WARN":"⚠️"}.get(level,"ℹ️")
    print(f"[{prefix}] {msg}")


def find_ffmpeg():
    for path in FFMPEG_PATHS:
        try:
            if os.path.isabs(path) and os.path.exists(path):
                ffmpeg = path
            else:
                subprocess.run([path,"-version"],capture_output=True,timeout=3)
                ffmpeg = path
            result = subprocess.run([ffmpeg,"-codecs"],capture_output=True,text=True,timeout=3)
            if "libmp3lame" in result.stdout:
                log(f"找到可用FFmpeg: {ffmpeg}")
                return ffmpeg
        except Exception:
            continue
    log("未找到支持libmp3lame的FFmpeg","ERROR")
    return None


def sanitize_filename(name):
    if not name: return "未知"
    name = re.sub(r'[\\/:*?"<>|]','',name)
    name = re.sub(r'\(.*?\)|（.*?）','',name)
    return name.strip()[:80] or "未知"


def parse_notes(file_path):
    if not os.path.exists(file_path):
        log(f"附件6不存在: {file_path}","ERROR")
        return []
    items = []
    with open(file_path,"r",encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]
    i = 0
    while i < len(lines):
        if "bilibili.com" in lines[i]:
            i += 1
            continue
        name_line = lines[i]
        url_line = None
        for j in range(i+1, min(i+3, len(lines))):
            if "bilibili.com/video/" in lines[j]:
                url_line = lines[j]
                break
        if not url_line:
            i += 1
            continue
        bv_match = re.search(r'(BV[a-zA-Z0-9]{10})', url_line)
        if not bv_match:
            i += 2
            continue
        bvid = bv_match.group(1)
        if "-" in name_line:
            singer, song = name_line.split("-",1)
            singer = sanitize_filename(singer)
            song = sanitize_filename(song)
        else:
            singer = "未知"
            song = sanitize_filename(name_line)
        items.append((singer, song, bvid))
        i += 2
    log(f"解析到 {len(items)} 首歌曲")
    return items


def get_bilibili_api(url, headers=None, retries=MAX_RETRIES):
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == 0:
                return data["data"]
            else:
                log(f"API错误: {data.get('message')}","WARN")
        except Exception as e:
            if attempt < retries -1:
                log(f"请求失败，重试({attempt+1}/{retries}): {str(e)[:50]}","WARN")
                time.sleep(2)
    return None


def get_video_info(bvid):
    url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": f"https://www.bilibili.com/video/{bvid}"
    }
    return get_bilibili_api(url, headers)


def get_audio_and_cover_urls(bvid, cid, info):
    """
    返回 (audio_url, cover_url)
    cover_url 使用 info["pic"]（真正的封面）
    """
    url = f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&fnval=16&qn=64"
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": f"https://www.bilibili.com/video/{bvid}"
    }

    data = get_bilibili_api(url, headers)
    if not data or "dash" not in data:
        return None, None

    dash = data["dash"]

    # 选最高码率音频
    audio_streams = sorted(dash["audio"], key=lambda x: x.get("bandwidth", 0), reverse=True)
    audio_url = audio_streams[0].get("baseUrl") or audio_streams[0].get("base_url")

    # ✅ 真正封面（B站官方字段）
    cover_url = info.get("pic")
    if cover_url and cover_url.startswith("//"):
        cover_url = "https:" + cover_url

    return audio_url, cover_url


def download_file(url, save_path, referer, desc=""):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": referer
    }
    file_size = 0
    if os.path.exists(save_path):
        file_size = os.path.getsize(save_path)
        headers["Range"] = f"bytes={file_size}-"
    try:
        with requests.get(url, headers=headers, stream=True, timeout=60) as resp:
            if resp.status_code == 416:
                log(f"{desc}已完整，跳过","INFO")
                return True
            resp.raise_for_status()
            mode = "ab" if file_size > 0 else "wb"
            with open(save_path, mode) as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
            final_size = os.path.getsize(save_path)
            if final_size < 1024:
                os.remove(save_path)
                return False
            log(f"{desc}下载完成 ({final_size//1024}KB)")
            return True
    except Exception as e:
        log(f"{desc}下载失败: {str(e)[:50]}","ERROR")
        if os.path.exists(save_path) and os.path.getsize(save_path) < 1024:
            os.remove(save_path)
        return False


def convert_to_mp3(ffmpeg, audio_path, mp3_path, title, artist):
    """
    纯音频转换（不嵌入封面）
    修复 Windows GBK 解码问题
    """
    log("转换纯音频MP3...")
    temp_mp3 = mp3_path.replace(".mp3", "_temp.mp3")

    cmd = [
        ffmpeg,
        "-i", audio_path,
        "-vn",                 # 禁用视频流
        "-c:a", "libmp3lame",
        "-b:a", AUDIO_BITRATE,
        "-ar", "44100",
        "-ac", "2",
        "-metadata", f"title={title}",
        "-metadata", f"artist={artist}",
        "-id3v2_version", "3",
        "-y",
        temp_mp3
    ]

    try:
        # ✅ 关键：不用 text=True，直接拿 bytes
        result = subprocess.run(cmd, capture_output=True, timeout=300)

        # 安全打印 FFmpeg 日志（忽略解码错误）
        if result.stderr:
            try:
                err = result.stderr.decode("utf-8", errors="ignore")
            except Exception:
                err = str(result.stderr)
            log(f"FFmpeg日志（末尾）: {err[-200:]}", "INFO")

        if result.returncode != 0:
            log("MP3转换失败（FFmpeg 返回非0）", "ERROR")
            return False

        if os.path.getsize(temp_mp3) < MIN_MP3_SIZE_KB * 1024:
            log(f"MP3过小，判定失败", "ERROR")
            os.remove(temp_mp3)
            return False

        shutil.move(temp_mp3, mp3_path)
        log("MP3转换完成", "SUCCESS")
        return True

    except subprocess.TimeoutExpired:
        log("MP3转换超时", "ERROR")
        if os.path.exists(temp_mp3):
            os.remove(temp_mp3)
        return False
    except Exception as e:
        log(f"MP3转换异常: {str(e)[:50]}", "ERROR")
        if os.path.exists(temp_mp3):
            os.remove(temp_mp3)
        return False


def main():
    print("=" * 60)
    print("🎵 B站歌单下载器（MP3+封面分离版）")
    print(f"📁 输出目录: {OUTPUT_DIR}")
    print("📦 输出规则：每首歌生成 歌手-歌名.mp3 + 歌手-歌名.jpg")
    print("=" * 60)
    
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    songs = parse_notes(NOTES_FILE)
    if not songs:
        log("没有可下载的歌曲","ERROR")
        return
    
    success = 0
    failed = []
    
    for idx, (singer, song, bvid) in enumerate(songs, 1):
        filename = f"{singer}-{song}"
        mp3_path = os.path.join(OUTPUT_DIR, f"{filename}.mp3")
        temp_audio = os.path.join(OUTPUT_DIR, f"{filename}.temp.m4a")
        cover_path = os.path.join(OUTPUT_DIR, f"{filename}.jpg")
        
        # 跳过已完成的MP3
        if os.path.exists(mp3_path) and os.path.getsize(mp3_path) > MIN_MP3_SIZE_KB * 1024:
            log(f"[{idx}/{len(songs)}] MP3已存在: {filename}")
            success += 1
            # 清理残留的临时音频文件
            if os.path.exists(temp_audio):
                os.remove(temp_audio)
            continue
        
        log(f"[{idx}/{len(songs)}] 开始处理: {filename}")
        
        try:
            # 1. 获取视频信息
            info = get_video_info(bvid)
            if not info:
                log("获取视频信息失败","ERROR")
                failed.append(filename)
                continue
            
            cid = info["cid"]
            
            # 2. 获取下载地址
            audio_url, cover_url = get_audio_and_cover_urls(bvid, cid, info)
            if not audio_url:
                log("获取音频地址失败","ERROR")
                failed.append(filename)
                continue
            
            # 3. 下载音频
            if not download_file(audio_url, temp_audio, referer=f"https://www.bilibili.com/video/{bvid}", desc="音频"):
                failed.append(filename)
                continue
            
            # 4. 下载封面（保留为独立JPG，不处理）
            if cover_url:
                download_file(cover_url, cover_path, referer=f"https://www.bilibili.com/video/{bvid}", desc="封面")
            else:
                log("该视频无封面，仅生成MP3","WARN")
            
            # 5. 转换纯MP3（不嵌入封面）
            if convert_to_mp3(ffmpeg, temp_audio, mp3_path, title=song, artist=singer):
                log(f"处理完成: {filename}","SUCCESS")
                success += 1
            else:
                log(f"转换失败: {filename}","ERROR")
                failed.append(filename)
            
            # 仅删除临时音频文件，保留封面JPG
            if os.path.exists(temp_audio):
                os.remove(temp_audio)
            
            time.sleep(REQUEST_INTERVAL)
            
        except KeyboardInterrupt:
            log("用户中断下载","WARN")
            break
        except Exception as e:
            log(f"处理异常: {str(e)[:50]}","ERROR")
            failed.append(filename)
            # 清理异常残留文件
            for tmp in [temp_audio, mp3_path]:
                if os.path.exists(tmp) and os.path.getsize(tmp) < MIN_MP3_SIZE_KB * 1024:
                    os.remove(tmp)
            continue
    
    # 输出总结
    print("\n" + "=" * 60)
    print(f"📊 处理完成")
    print(f"✅ 成功: {success}/{len(songs)}")
    print(f"❌ 失败: {len(failed)}")
    if failed:
        print("\n失败列表:")
        for f in failed[:10]:
            print(f"  - {f}")
        if len(failed) > 10:
            print(f"  ... 还有{len(failed)-10}个")
    print(f"\n📁 文件位置: {OUTPUT_DIR}")
    print("💡 每个歌曲对应一个MP3和一个JPG封面，无封面的歌曲只有MP3")
    print("=" * 60)


if __name__ == "__main__":
    main()