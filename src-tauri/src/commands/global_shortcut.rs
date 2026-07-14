use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub struct ShortcutStore {
    pub toggle_play: Mutex<String>,
    pub prev_track: Mutex<String>,
    pub next_track: Mutex<String>,
    pub volume_up: Mutex<String>,
    pub volume_down: Mutex<String>,
}

impl Default for ShortcutStore {
    fn default() -> Self {
        Self {
            toggle_play: Mutex::new("Ctrl+Alt+KeyP".to_string()),
            prev_track: Mutex::new("Ctrl+Alt+ArrowLeft".to_string()),
            next_track: Mutex::new("Ctrl+Alt+ArrowRight".to_string()),
            volume_up: Mutex::new("Ctrl+Alt+ArrowUp".to_string()),
            volume_down: Mutex::new("Ctrl+Alt+ArrowDown".to_string()),
        }
    }
}

fn parse_shortcut(shortcut_str: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = shortcut_str.split('+').collect();
    let mut modifiers = Modifiers::empty();
    let mut code: Option<Code> = None;

    for part in &parts {
        match part.to_uppercase().as_str() {
            "CTRL" | "CONTROL" => modifiers |= Modifiers::CONTROL,
            "ALT" | "OPTION" => modifiers |= Modifiers::ALT,
            "SHIFT" => modifiers |= Modifiers::SHIFT,
            "META" | "SUPER" | "WIN" | "CMD" | "COMMAND" => modifiers |= Modifiers::META,
            // 支持 KEY 前缀（如 KEYP）和不带前缀（如 P）
            "KEYA" | "A" => code = Some(Code::KeyA),
            "KEYB" | "B" => code = Some(Code::KeyB),
            "KEYC" | "C" => code = Some(Code::KeyC),
            "KEYD" | "D" => code = Some(Code::KeyD),
            "KEYE" | "E" => code = Some(Code::KeyE),
            "KEYF" | "F" => code = Some(Code::KeyF),
            "KEYG" | "G" => code = Some(Code::KeyG),
            "KEYH" | "H" => code = Some(Code::KeyH),
            "KEYI" | "I" => code = Some(Code::KeyI),
            "KEYJ" | "J" => code = Some(Code::KeyJ),
            "KEYK" | "K" => code = Some(Code::KeyK),
            "KEYL" | "L" => code = Some(Code::KeyL),
            "KEYM" | "M" => code = Some(Code::KeyM),
            "KEYN" | "N" => code = Some(Code::KeyN),
            "KEYO" | "O" => code = Some(Code::KeyO),
            "KEYP" | "P" => code = Some(Code::KeyP),
            "KEYQ" | "Q" => code = Some(Code::KeyQ),
            "KEYR" | "R" => code = Some(Code::KeyR),
            "KEYS" | "S" => code = Some(Code::KeyS),
            "KEYT" | "T" => code = Some(Code::KeyT),
            "KEYU" | "U" => code = Some(Code::KeyU),
            "KEYV" | "V" => code = Some(Code::KeyV),
            "KEYW" | "W" => code = Some(Code::KeyW),
            "KEYX" | "X" => code = Some(Code::KeyX),
            "KEYY" | "Y" => code = Some(Code::KeyY),
            "KEYZ" | "Z" => code = Some(Code::KeyZ),
            // 支持 LEFT/ARROWLEFT 等多种格式
            "LEFT" | "ARROWLEFT" => code = Some(Code::ArrowLeft),
            "RIGHT" | "ARROWRIGHT" => code = Some(Code::ArrowRight),
            "UP" | "ARROWUP" => code = Some(Code::ArrowUp),
            "DOWN" | "ARROWDOWN" => code = Some(Code::ArrowDown),
            "SPACE" => code = Some(Code::Space),
            "ENTER" | "RETURN" => code = Some(Code::Enter),
            "ESCAPE" | "ESC" => code = Some(Code::Escape),
            "BACKSPACE" => code = Some(Code::Backspace),
            "TAB" => code = Some(Code::Tab),
            "F1" => code = Some(Code::F1),
            "F2" => code = Some(Code::F2),
            "F3" => code = Some(Code::F3),
            "F4" => code = Some(Code::F4),
            "F5" => code = Some(Code::F5),
            "F6" => code = Some(Code::F6),
            "F7" => code = Some(Code::F7),
            "F8" => code = Some(Code::F8),
            "F9" => code = Some(Code::F9),
            "F10" => code = Some(Code::F10),
            "F11" => code = Some(Code::F11),
            "F12" => code = Some(Code::F12),
            _ => {}
        }
    }

    if let Some(code) = code {
        Ok(Shortcut::new(Some(modifiers), code))
    } else {
        Err(format!("无效的快捷键: {}", shortcut_str))
    }
}

fn parse_shortcut_id(id: &str) -> &'static str {
    match id {
        "toggle-play" => "toggle_play",
        "prev-track" => "prev_track",
        "next-track" => "next_track",
        "volume-up" => "volume_up",
        "volume-down" => "volume_down",
        _ => "unknown",
    }
}

pub fn register_global_shortcuts(app: &AppHandle) -> Result<(), String> {
    let store = app.state::<ShortcutStore>();
    
    let shortcuts = vec![
        ("toggle_play", store.toggle_play.lock().unwrap().clone(), "global-shortcut:toggle-play"),
        ("prev_track", store.prev_track.lock().unwrap().clone(), "global-shortcut:prev-track"),
        ("next_track", store.next_track.lock().unwrap().clone(), "global-shortcut:next-track"),
        ("volume_up", store.volume_up.lock().unwrap().clone(), "global-shortcut:volume-up"),
        ("volume_down", store.volume_down.lock().unwrap().clone(), "global-shortcut:volume-down"),
    ];

    for (_name, shortcut_str, event_name) in &shortcuts {
        match parse_shortcut(shortcut_str) {
            Ok(shortcut) => {
                let event_name = event_name.to_string();
                app.global_shortcut()
                    .on_shortcut(shortcut, move |app_handle, _shortcut, _event| {
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.set_focus();
                        }
                        let _ = app_handle.emit(&event_name, ());
                    })
                    .map_err(|e| format!("注册快捷键 {} 失败: {}", shortcut_str, e))?;
            }
            Err(e) => eprintln!("跳过无效快捷键 {}: {}", shortcut_str, e),
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn update_global_shortcut(
    app: AppHandle,
    shortcut_id: String,
    new_shortcut: String,
) -> Result<(), String> {
    let store = app.state::<ShortcutStore>();
    let field = parse_shortcut_id(&shortcut_id);
    
    let old_shortcut = match field {
        "toggle_play" => store.toggle_play.lock().unwrap().clone(),
        "prev_track" => store.prev_track.lock().unwrap().clone(),
        "next_track" => store.next_track.lock().unwrap().clone(),
        "volume_up" => store.volume_up.lock().unwrap().clone(),
        "volume_down" => store.volume_down.lock().unwrap().clone(),
        _ => return Err(format!("未知的快捷键 ID: {}", shortcut_id)),
    };

    if old_shortcut == new_shortcut {
        return Ok(());
    }

    if let Ok(old_sc) = parse_shortcut(&old_shortcut) {
        let _ = app.global_shortcut().unregister(old_sc);
    }

    let new_sc = parse_shortcut(&new_shortcut)?;
    let event_name = format!("global-shortcut:{}", shortcut_id);

    app.global_shortcut()
        .on_shortcut(new_sc, move |app_handle, _shortcut, _event| {
            // 修复 2026-07-14: 同 register_global_shortcuts, 唤醒 webview
            if let Some(win) = app_handle.get_webview_window("main") {
                let _ = win.set_focus();
            }
            let _ = app_handle.emit(&event_name, ());
        })
        .map_err(|e| format!("注册新快捷键失败: {}", e))?;

    match field {
        "toggle_play" => *store.toggle_play.lock().unwrap() = new_shortcut,
        "prev_track" => *store.prev_track.lock().unwrap() = new_shortcut,
        "next_track" => *store.next_track.lock().unwrap() = new_shortcut,
        "volume_up" => *store.volume_up.lock().unwrap() = new_shortcut,
        "volume_down" => *store.volume_down.lock().unwrap() = new_shortcut,
        _ => {}
    }

    Ok(())
}
