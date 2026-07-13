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
            toggle_play: Mutex::new("Ctrl+Alt+P".to_string()),
            prev_track: Mutex::new("Ctrl+Alt+Left".to_string()),
            next_track: Mutex::new("Ctrl+Alt+Right".to_string()),
            volume_up: Mutex::new("Ctrl+Alt+Up".to_string()),
            volume_down: Mutex::new("Ctrl+Alt+Down".to_string()),
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
            "KEYA" => code = Some(Code::KeyA),
            "KEYB" => code = Some(Code::KeyB),
            "KEYC" => code = Some(Code::KeyC),
            "KEYD" => code = Some(Code::KeyD),
            "KEYE" => code = Some(Code::KeyE),
            "KEYF" => code = Some(Code::KeyF),
            "KEYG" => code = Some(Code::KeyG),
            "KEYH" => code = Some(Code::KeyH),
            "KEYI" => code = Some(Code::KeyI),
            "KEYJ" => code = Some(Code::KeyJ),
            "KEYK" => code = Some(Code::KeyK),
            "KEYL" => code = Some(Code::KeyL),
            "KEYM" => code = Some(Code::KeyM),
            "KEYN" => code = Some(Code::KeyN),
            "KEYO" => code = Some(Code::KeyO),
            "KEYP" => code = Some(Code::KeyP),
            "KEYQ" => code = Some(Code::KeyQ),
            "KEYR" => code = Some(Code::KeyR),
            "KEYS" => code = Some(Code::KeyS),
            "KEYT" => code = Some(Code::KeyT),
            "KEYU" => code = Some(Code::KeyU),
            "KEYV" => code = Some(Code::KeyV),
            "KEYW" => code = Some(Code::KeyW),
            "KEYX" => code = Some(Code::KeyX),
            "KEYY" => code = Some(Code::KeyY),
            "KEYZ" => code = Some(Code::KeyZ),
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
