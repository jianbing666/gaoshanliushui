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

/// 尝试暂停 WebView2 渲染进程
///
/// 修复 2026-07-14: 最小化到托盘或进入迷你模式 + 已暂停播放时, 暂停整个渲染进程
///   可大幅削减内存占用 (通常 -50~80MB).
///
/// 实现说明:
///   Tauri v2 的 `with_webview` 回调中 `webview.controller()` 返回的是
///   `ICoreWebView2Controller` (webview2-com 类型), 它本身没有 try_suspend 方法
///   (try_suspend 是 ICoreWebView2 的方法, 在 controller 层级不直接暴露).
///   需要通过 controller.CoreWebView2 拿到 ICoreWebView2 才能调用.
///   但 Tauri 2.x 公开的 controller() 抽象不直接给到 CoreWebView2.
///
/// 当前策略: 此命令在 v2 公开 API 下无法安全直接调用, 留作占位.
///   实际的"暂停渲染"通过前端暂停所有动画 / 计时器 (App.vue visibilitychange
///   + 频谱 setTimeout + 背景轮播 setInterval) 实现, 配合 Rust 端在 hide()
///   事件中通过 window eval 暂停 requestAnimationFrame.
///
/// 返回 false 表示当前平台未实现 (调用方应跳过).
#[tauri::command]
pub async fn try_suspend_renderer<R: Runtime>(_app: AppHandle<R>) -> Result<bool, String> {
    // TODO: Tauri v2 公开 API 不暴露 ICoreWebView2, 需要引入 webview2-com crate 直接调用.
    //   当前通过前端策略实现类似效果 (暂停所有 RAF / setTimeout / setInterval).
    Ok(false)
}

/// 恢复 WebView2 渲染进程 (与 try_suspend_renderer 配对)
#[tauri::command]
pub async fn try_resume_renderer<R: Runtime>(_app: AppHandle<R>) -> Result<bool, String> {
    // TODO: 同上
    Ok(false)
}

/// 检查渲染进程是否已暂停
#[tauri::command]
pub async fn is_renderer_suspended<R: Runtime>(_app: AppHandle<R>) -> Result<bool, String> {
    // TODO: 同上
    Ok(false)
}
