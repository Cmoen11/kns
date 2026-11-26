//! Where the Herdr programs are. Std + `dirs` only: `kns-tui` compiles this file in (`#[path]`),
//! so kns and kns-tui look in the same places. A GUI app gets a short PATH from launchd, so the
//! usual install folders are tried as well.
//!
//! Two programs share the name: the Herdr app (`dev.herdr.app`: a window, `herdr-app`, terminals
//! in herdr-core `hc`, mods in `~/.config/herdr-app/mods`) and the herdr TUI (`herdr`, plugins
//! linked with `herdr plugin link`).
use std::path::{Path, PathBuf};

/// The Herdr app's folder: `HERDR_APP_HOME`, else `~/.config/herdr-app` (on every platform).
pub fn app_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("HERDR_APP_HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(h));
    }
    dirs::home_dir().map(|h| h.join(".config").join("herdr-app"))
}

/// `herdr-app`, the app's command line.
pub fn app_bin() -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = vec![];
    if let Some(b) = std::env::var_os("HERDR_APP_BIN").filter(|b| !b.is_empty()) {
        c.push(b.into());
    }
    c.extend(on_path("herdr-app"));
    if let Some(home) = dirs::home_dir() {
        c.push(home.join(".local/bin/herdr-app"));
    }
    c.push("/Applications/Herdr.app/Contents/MacOS/Herdr".into());
    if let Some(home) = dirs::home_dir() {
        c.push(home.join("Applications/Herdr.app/Contents/MacOS/Herdr"));
    }
    c.into_iter().find(|p| p.is_file())
}

/// `herdr`, the TUI.
pub fn tui_bin() -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = vec![];
    if let Some(b) = std::env::var_os("HERDR_BIN_PATH").filter(|b| !b.is_empty()) {
        c.push(b.into());
    }
    c.extend(on_path("herdr"));
    if let Some(home) = dirs::home_dir() {
        c.extend([home.join(".local/bin/herdr"), home.join(".cargo/bin/herdr")]);
    }
    c.extend(["/opt/homebrew/bin/herdr".into(), "/usr/local/bin/herdr".into()]);
    c.into_iter().find(|p| p.is_file() && !is_app_bundle(p))
}

/// The app's own binary is `Herdr` inside `Herdr.app`; on a case-insensitive disk it can look like `herdr`.
fn is_app_bundle(p: &Path) -> bool {
    p.components().any(|c| c.as_os_str().to_string_lossy().ends_with(".app"))
}

fn on_path(name: &str) -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).map(|d| d.join(name)).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_bundle_is_not_the_tui() {
        assert!(is_app_bundle(Path::new("/Applications/Herdr.app/Contents/MacOS/Herdr")));
        assert!(!is_app_bundle(Path::new("/opt/homebrew/bin/herdr")));
    }
}
