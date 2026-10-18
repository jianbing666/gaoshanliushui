use tauri::{AppHandle, Manager, Runtime};

/// 强制前端 JS 堆垃圾回收
///
/// 修复 2026-07-14: V8 默认的 GC 是分代回收, 不会立刻释放大对象.
///   切歌/低功耗场景主动触发一次 major GC, 让 Web Audio 的 AudioBuffer 等
///   大内存对象尽快释放, 配合前端 prevBuffer 缓存清理.
///
/// 实现: 通过 webview.eval() 在渲染进程中执行:
///   - globalThis.gc?.()  (Chrome devtools 开启时可用)
///   - 触发 finalizer 队列
///
/// 注意: 跨平台可用 (macOS / Linux 的 webview 也支持 eval JS).
#[tauri::command]
pub async fn clean_renderer_memory<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;

    // 强制触发 GC 并清理 finalizer 队列
    // 兼容性: production build 中 globalThis.gc 通常不存在 (仅 devtools 开启时存在),
    //   此时会静默失败, 不影响主流程.
    let script = r#"
        (function() {
            try {
                if (typeof globalThis.gc === 'function') {
                    // 第一次: 标记
                    globalThis.gc();
                    // 延迟再调一次: 回收
                    setTimeout(function() {
                        try { globalThis.gc(); } catch (_) {}
                    }, 0);
                }
            } catch (_) {}
        })();
    "#;

    window
        .eval(script)
        .map_err(|e| format!("执行 GC 脚本失败: {}", e))?;
    Ok(())
}

// ========== P4-1: WebView2 内存目标等级 ==========
//
// 背景: 应用隐藏到系统托盘后, 渲染进程仍保留完整的工作集(合成/光栅缓存等)。
// WebView2 提供了 CoreWebView2MemoryUsageTargetLevel.Low: 提示引擎丢弃可丢弃的
// 缓存、把内存换出到磁盘, 从而在"不可见"时降低占用; 重新显示时恢复 Normal。
// 官方说明: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance
//
// 仅在 Windows 有效(WebView2 专属); 其它平台为空操作。
// 注意: 这里不使用 TrySuspendAsync —— 那会暂停渲染进程里的脚本与 Web Audio,
// 正在托盘播放时会导致音乐停止; 只降内存目标, 不暂停渲染。

#[cfg(target_os = "windows")]
mod memory_level {
    use std::sync::atomic::{AtomicI8, Ordering};
    use tauri::Manager;

    /// 最近一次成功应用的等级: 0 = Normal, 1 = Low, -1 = 当前运行时/接口不支持
    static LAST_LEVEL: AtomicI8 = AtomicI8::new(0);
    /// 最近一次失败原因(诊断用, 成功时清空)
    static LAST_ERROR: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

    fn note_error(message: impl Into<String>) {
        if let Ok(mut slot) = LAST_ERROR.lock() {
            *slot = message.into();
        }
    }

    fn clear_error() {
        if let Ok(mut slot) = LAST_ERROR.lock() {
            slot.clear();
        }
    }

    /// 设置 WebView2 内存目标等级
    ///
    /// 幂等: 与当前等级相同时直接返回, 避免窗口 resize 等高频事件反复调用 COM。
    pub fn set(app: &tauri::AppHandle, low: bool) -> Result<(), String> {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;

        let desired: i8 = if low { 1 } else { 0 };
        if LAST_LEVEL.load(Ordering::Relaxed) == desired {
            return Ok(());
        }

        let window = match app.get_webview_window("main") {
            Some(window) => window,
            None => {
                note_error("找不到主窗口");
                return Err("找不到主窗口".to_string());
            }
        };
        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };

        // with_webview 是"投递到主线程"的操作, 窗口刚 hide/show 时偶发拿不到
        // CoreWebView2(实测偶发一两次失败)。最多重试 3 次、每次间隔 30ms;
        // 关闭窗口时阻塞主线程 <100ms, 用户无感。
        for attempt in 0..3 {
            match window.with_webview(move |platform| {
                let controller = platform.controller();
                match unsafe { controller.CoreWebView2() } {
                    Ok(core) => match core.cast::<ICoreWebView2_19>() {
                        Ok(webview19) => {
                            match unsafe { webview19.SetMemoryUsageTargetLevel(level) } {
                                Ok(()) => {
                                    LAST_LEVEL.store(desired, Ordering::Relaxed);
                                    clear_error();
                                }
                                Err(e) => note_error(format!(
                                    "SetMemoryUsageTargetLevel 失败: {}",
                                    e.message()
                                )),
                            }
                        }
                        Err(_) => {
                            // 运行时版本太旧(需要 WebView2 1.0.2210+): 标记不支持, 不再重试
                            LAST_LEVEL.store(-1, Ordering::Relaxed);
                            note_error("当前 WebView2 运行时不支持 ICoreWebView2_19");
                        }
                    },
                    Err(e) => note_error(format!("获取 CoreWebView2 失败: {}", e.message())),
                }
            }) {
                Ok(()) => {}
                Err(e) => note_error(format!("with_webview 调度失败: {}", e)),
            }

            let applied = LAST_LEVEL.load(Ordering::Relaxed);
            if applied == desired || applied == -1 {
                return Ok(());
            }
            if attempt < 2 {
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        }

        Err(format!(
            "设置 WebView2 内存等级失败: {}",
            LAST_ERROR
                .lock()
                .map(|s| s.clone())
                .unwrap_or_else(|_| "未知原因".to_string())
        ))
    }

    pub fn last_level() -> i8 {
        LAST_LEVEL.load(Ordering::Relaxed)
    }

    pub fn last_error() -> String {
        LAST_ERROR.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

/// 隐藏/最小化时降低 WebView2 内存目标, 重新显示时恢复
#[cfg(target_os = "windows")]
pub fn set_memory_usage_low(app: &tauri::AppHandle, low: bool) -> Result<(), String> {
    memory_level::set(app, low)
}

/// 非 Windows 平台: 无 WebView2, 空操作
#[cfg(not(target_os = "windows"))]
pub fn set_memory_usage_low(_app: &tauri::AppHandle, _low: bool) -> Result<(), String> {
    Ok(())
}

/// 查询最近一次成功应用的内存等级(诊断/自动化测试用)
/// 0 = Normal, 1 = Low, -1 = 当前 WebView2 运行时不支持
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn get_webview_memory_level() -> i8 {
    memory_level::last_level()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_webview_memory_level() -> i8 {
    -1
}

/// 查询内存等级与最近一次失败原因(诊断/自动化测试用)
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn get_webview_memory_status() -> (i8, String) {
    (memory_level::last_level(), memory_level::last_error())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_webview_memory_status() -> (i8, String) {
    (-1, "仅 Windows 支持".to_string())
}
