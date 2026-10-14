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
