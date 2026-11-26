//! Running without a window (docs/plan-background.md).
//!
//! - `kns --background` starts the backend, the client socket (rpc.rs) and the MCP server, with a
//!   tray icon and no window (no webview memory until one is opened).
//! - With "keep running" on (`--background`, or `rust/background.json`), closing the window leaves
//!   the process in the tray; "Quit kns" in the tray ends it.
//! - A second `kns` start (Finder, Dock, `kns-tui --open`) shows the window of the running one
//!   (tauri-plugin-single-instance); a second `kns --background` does nothing.
//! - "Launch at login" writes a LaunchAgent (macOS) that runs `kns --background`.
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    ipc::{BackendError, Result},
    rpc,
    rustfiles,
    state::{AppState, lock},
};

pub const ARG: &str = "--background";
const FILE: &str = "background";
const MAIN: &str = "main";
#[cfg(target_os = "macos")]
const AGENT_LABEL: &str = "no.sixm.kns.background";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub keep_running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    pub keep_running: bool,
    pub started_in_background: bool,
    pub launch_at_login: bool,
    pub window_open: bool,
    pub socket: rpc::SocketStatus,
}

#[derive(Default)]
struct Slot {
    keep_running: AtomicBool,
    started_hidden: AtomicBool,
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

fn slot(state: &AppState) -> std::sync::Arc<Slot> {
    state.ext::<Slot>()
}

/// True when the process was started with `--background`.
pub fn wants_background(args: &[String]) -> bool {
    args.iter().any(|a| a == ARG)
}

pub fn keep_running(state: &AppState) -> bool {
    slot(state).keep_running.load(Ordering::Relaxed)
}

/// Called from `setup`: reads the stored setting, then either opens the window or puts kns in the
/// tray.
pub fn setup(state: &AppState, app: &AppHandle, hidden: bool) {
    let s = slot(state);
    s.started_hidden.store(hidden, Ordering::Relaxed);
    // sync read: `setup` runs before the event loop, and this file is tiny
    let stored: Option<Config> = rustfiles::dir(app)
        .ok()
        .and_then(|dir| std::fs::read(dir.join(format!("{FILE}.json"))).ok())
        .and_then(|b| serde_json::from_slice(&b).ok());
    let keep = hidden || stored.unwrap_or_default().keep_running;
    s.keep_running.store(keep, Ordering::Relaxed);
    if keep {
        ensure_tray(state, app);
    }
    if hidden {
        set_dock(app, false);
    } else {
        show_window(state);
    }
}

pub fn status(state: &AppState) -> BackgroundStatus {
    let s = slot(state);
    BackgroundStatus {
        keep_running: s.keep_running.load(Ordering::Relaxed),
        started_in_background: s.started_hidden.load(Ordering::Relaxed),
        launch_at_login: launch_agent_path().is_some_and(|p| p.exists()),
        window_open: state.app().and_then(|a| a.get_webview_window(MAIN)).is_some(),
        socket: rpc::status(state),
    }
}

/// Stores "keep running" and adds or removes the login item.
pub async fn set(state: &AppState, keep_running: bool, launch_at_login: Option<bool>) -> Result<BackgroundStatus> {
    let app = state.app().ok_or_else(|| BackendError::internal("the app is not running"))?.clone();
    rustfiles::write(&rustfiles::dir(&app)?, FILE, &Config { keep_running }).await?;
    let s = slot(state);
    // started with --background: stays in the tray for this run whatever the setting says
    let effective = keep_running || s.started_hidden.load(Ordering::Relaxed);
    s.keep_running.store(effective, Ordering::Relaxed);
    if effective {
        ensure_tray(state, &app);
    } else if let Some(tray) = lock(&s.tray).take() {
        let _ = app.remove_tray_by_id(tray.id());
    }
    if let Some(on) = launch_at_login {
        set_launch_at_login(on)?;
    }
    Ok(status(state))
}

/// Shows the main window, creating it when it was never opened or was closed.
pub fn show_window(state: &AppState) {
    let Some(app) = state.app().cloned() else { return };
    let run = app.clone();
    // window creation must happen on the main thread
    let _ = run.run_on_main_thread(move || {
        set_dock(&app, true);
        if let Some(w) = app.get_webview_window(MAIN) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == MAIN).cloned() else { return };
        // shown by `on_page_load` once the page has loaded (no white flash)
        if let Err(e) = tauri::WebviewWindowBuilder::from_config(&app, &cfg).and_then(|b| b.build()) {
            eprintln!("kns: could not open the window: {e}");
        }
    });
}

/// The window was destroyed. In the tray: hide the Dock icon again.
pub fn window_closed(state: &AppState, app: &AppHandle) {
    if keep_running(state) {
        set_dock(app, false);
    }
}

#[cfg(target_os = "macos")]
fn set_dock(app: &AppHandle, visible: bool) {
    let policy = if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory };
    let _ = app.set_activation_policy(policy);
}

#[cfg(not(target_os = "macos"))]
fn set_dock(_app: &AppHandle, _visible: bool) {}

fn ensure_tray(state: &AppState, app: &AppHandle) {
    use tauri::{
        menu::{Menu, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let s = slot(state);
    let mut tray = lock(&s.tray);
    if tray.is_some() {
        return;
    }
    let build = || -> tauri::Result<tauri::tray::TrayIcon> {
        let open = MenuItem::with_id(app, "kns-open", "Open kns", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "kns-quit", "Quit kns", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
        let mut b = TrayIconBuilder::with_id("kns").tooltip("kns").menu(&menu).show_menu_on_left_click(false);
        if let Some(icon) = app.default_window_icon() {
            b = b.icon(icon.clone());
        }
        #[cfg(target_os = "macos")]
        {
            b = b.icon_as_template(false);
        }
        let menu_state = state.clone();
        let click_state = state.clone();
        b.on_menu_event(move |app, ev| match ev.id().as_ref() {
            "kns-open" => show_window(&menu_state),
            "kns-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |_, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_window(&click_state);
            }
        })
        .build(app)
    };
    match build() {
        Ok(t) => *tray = Some(t),
        Err(e) => eprintln!("kns: no tray icon: {e}"),
    }
}

// ───────────────────────── launch at login ─────────────────────────

#[cfg(target_os = "macos")]
fn launch_agent_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join("Library/LaunchAgents").join(format!("{AGENT_LABEL}.plist")))
}

#[cfg(not(target_os = "macos"))]
fn launch_agent_path() -> Option<std::path::PathBuf> {
    None
}

/// The LaunchAgent that starts `exe --background` at login. Not `KeepAlive`: "Quit kns" means quit.
#[cfg(target_os = "macos")]
pub fn launch_agent_plist(exe: &str) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>{ARG}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
        esc(exe)
    )
}

#[cfg(target_os = "macos")]
fn set_launch_at_login(on: bool) -> Result<()> {
    let path = launch_agent_path().ok_or_else(|| BackendError::config("no home directory"))?;
    if on {
        let exe = std::env::current_exe()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, launch_agent_plist(&exe.display().to_string()))?;
    } else {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn set_launch_at_login(_on: bool) -> Result<()> {
    Err(BackendError::not_implemented("launch at login on this platform"))
}

pub mod cmd {
    use super::{AppState, BackgroundStatus};
    use crate::ipc::Result;

    #[tauri::command]
    pub fn background_status(state: tauri::State<'_, AppState>) -> BackgroundStatus {
        super::status(&state)
    }

    #[tauri::command]
    pub async fn background_set(state: tauri::State<'_, AppState>, keep_running: bool, launch_at_login: Option<bool>) -> Result<BackgroundStatus> {
        super::set(&state, keep_running, launch_at_login).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_flag() {
        assert!(wants_background(&["kns".into(), "--background".into()]));
        assert!(!wants_background(&["kns".into()]));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn plist_escapes_the_path() {
        let p = launch_agent_plist("/Applications/k&ns.app/Contents/MacOS/kns");
        assert!(p.contains("<string>/Applications/k&amp;ns.app/Contents/MacOS/kns</string><string>--background</string>"));
        assert!(p.contains("<key>KeepAlive</key><false/>"));
    }
}
