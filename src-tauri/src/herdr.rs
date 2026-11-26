//! "Add to Herdr": everything Herdr needs to show kns, set up from kns itself (Settings → Herdr in
//! the window, `kns-tui herdr install`, the `herdr_install` call). See docs/herdr.md.
//!
//! - **Herdr app** (`dev.herdr.app`): the kns mod (`herdr/app/kns/`, embedded in this binary) goes
//!   to `<herdr home>/mods/kns`, with a `config.js` naming this kns's `kns-tui` and its
//!   `rpc-tcp.json`. The loopback endpoint (`rpc/tcp.rs`) is turned on, since that is how a mod
//!   reaches kns. `herdr-app check` verifies the mod. Herdr reloads mods on save and docks a new
//!   one on its first sight.
//! - **herdr TUI** (`herdr` ≥ 0.9.5): the plugin (`herdr/herdr-plugin.toml`, `bin/kns-herdr` with
//!   this `kns-tui` baked in) goes to `<data_dir>/no.sixm.kns/herdr-plugin` and is `herdr plugin
//!   link`ed.
//! - Whatever is found is set up; nothing found is an error that says what to install.
//! - When kns starts and finds an installed mod that differs from the one it carries (kns was
//!   updated), it rewrites the files, so the mod and kns always speak the same protocol.
use std::{
    path::{Path, PathBuf},
    process::Command,
};

use serde::Serialize;

use crate::{
    herdr_paths,
    ipc::{BackendError, Result},
    rpc::{self, tcp::TcpStatus},
    state::AppState,
};

/// The mod's files, `main.js` last: Herdr reloads on every save, and the entry point should see
/// its modules already in place.
const MOD_FILES: &[(&str, &str)] = &[
    ("mod.json", include_str!("../../herdr/app/kns/mod.json")),
    ("utf8.js", include_str!("../../herdr/app/kns/utf8.js")),
    ("model.js", include_str!("../../herdr/app/kns/model.js")),
    ("diff.js", include_str!("../../herdr/app/kns/diff.js")),
    ("client.js", include_str!("../../herdr/app/kns/client.js")),
    ("panel.js", include_str!("../../herdr/app/kns/panel.js")),
    ("dialogs.js", include_str!("../../herdr/app/kns/dialogs.js")),
    ("main.js", include_str!("../../herdr/app/kns/main.js")),
];
const MOD_NAME: &str = "kns";
/// First line of the generated `config.js`: how kns recognises its own mod folder.
const MARKER: &str = "// kns-mod";

pub const TUI_MANIFEST: &str = include_str!("../../herdr/herdr-plugin.toml");
pub const TUI_LAUNCHER: &str = include_str!("../../herdr/bin/kns-herdr");
const TUI_PLUGIN_ID: &str = "kns";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrStatus {
    /// the Herdr app is installed (its folder or its binary exists)
    pub app_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mod_dir: Option<String>,
    pub mod_installed: bool,
    /// the installed mod is the one this kns carries
    pub mod_current: bool,
    /// the herdr TUI is installed
    pub tui_found: bool,
    pub tui_plugin_written: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kns_tui: Option<String>,
    pub tcp: TcpStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    /// what was done, one line each
    pub done: Vec<String>,
    /// what could not be done or needs the person (a non-empty list is a warning)
    pub notes: Vec<String>,
    /// where to find things next
    pub tips: Vec<String>,
    pub status: HerdrStatus,
}

/// `kns-tui` next to this binary (the app bundle, or `target/<profile>` in development).
pub fn kns_tui() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let name = if cfg!(windows) { "kns-tui.exe" } else { "kns-tui" };
    let p = exe.parent()?.join(name);
    p.is_file().then_some(p)
}

fn mod_dir() -> Option<PathBuf> {
    herdr_paths::app_home().map(|h| h.join("mods").join(MOD_NAME))
}

fn tui_plugin_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(rpc::path::IDENTIFIER).join("herdr-plugin"))
}

fn app_found() -> bool {
    herdr_paths::app_home().is_some_and(|h| h.is_dir()) || herdr_paths::app_bin().is_some()
}

/// `config.js` for this kns: where its kns-tui and TCP info file are.
fn config_js(kns_tui: &Path) -> String {
    let q = |s: String| serde_json::to_string(&s).unwrap_or_else(|_| "\"\"".into());
    let info = rpc::path::tcp_info_path().map(|p| p.display().to_string()).unwrap_or_default();
    format!(
        "{MARKER} {version}: written by kns (Settings → Herdr → Add to Herdr, or `kns-tui herdr install`).\n\
         // kns rewrites this folder when it is updated; changes here do not last.\n\n\
         /** The kns-tui binary: logs and shells run it in terminal panes; it also starts kns. */\n\
         export function knsTui() {{\n  return {tui};\n}}\n\n\
         /** kns's rpc-tcp.json ({{port, token, pid, protocol}}), written while its TCP endpoint is on. */\n\
         export function tcpInfo() {{\n  return {info};\n}}\n",
        version = env!("CARGO_PKG_VERSION"),
        tui = q(kns_tui.display().to_string()),
        info = q(info),
    )
}

fn ours(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("config.js")).is_ok_and(|t| t.starts_with(MARKER))
}

/// The installed mod equals what this kns would write.
fn mod_current(dir: &Path, kns_tui: Option<&Path>) -> bool {
    let files_match = MOD_FILES.iter().all(|(name, text)| std::fs::read_to_string(dir.join(name)).is_ok_and(|t| t == *text));
    let config_matches = kns_tui.is_some_and(|k| std::fs::read_to_string(dir.join("config.js")).is_ok_and(|t| t == config_js(k)));
    files_match && config_matches
}

pub fn status(state: &AppState) -> HerdrStatus {
    let dir = mod_dir();
    let kns_tui = kns_tui();
    let installed = dir.as_deref().is_some_and(ours);
    HerdrStatus {
        app_found: app_found(),
        mod_dir: dir.as_ref().map(|d| d.display().to_string()),
        mod_installed: installed,
        mod_current: installed && dir.as_deref().is_some_and(|d| mod_current(d, kns_tui.as_deref())),
        tui_found: herdr_paths::tui_bin().is_some(),
        tui_plugin_written: tui_plugin_dir().is_some_and(|d| d.join("herdr-plugin.toml").is_file()),
        kns_tui: kns_tui.map(|p| p.display().to_string()),
        tcp: rpc::tcp::status(state),
    }
}

/// Writes the mod's files into `dir` (created when missing).
fn write_mod(dir: &Path, kns_tui: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("config.js"), config_js(kns_tui))?;
    for (name, text) in MOD_FILES {
        let path = dir.join(name);
        // unchanged files are left alone: every save makes Herdr reload the mod
        if std::fs::read_to_string(&path).is_ok_and(|t| t == *text) {
            continue;
        }
        std::fs::write(path, text)?;
    }
    Ok(())
}

fn run(bin: &Path, args: &[&str]) -> std::result::Result<String, String> {
    let out = Command::new(bin).args(args).stdin(std::process::Stdio::null()).output().map_err(|e| format!("{}: {e}", bin.display()))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string();
    if out.status.success() { Ok(text) } else { Err(text) }
}

fn install_tui_plugin(herdr: &Path, kns_tui: &Path) -> std::result::Result<String, String> {
    let dir = tui_plugin_dir().ok_or("no data directory")?;
    std::fs::create_dir_all(dir.join("bin")).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("herdr-plugin.toml"), TUI_MANIFEST).map_err(|e| e.to_string())?;
    let quoted = format!("'{}'", kns_tui.display().to_string().replace('\'', r"'\''"));
    let launcher = TUI_LAUNCHER.replace("KNS_TUI_BAKED=\"\"", &format!("KNS_TUI_BAKED={quoted}"));
    let path = dir.join("bin").join("kns-herdr");
    std::fs::write(&path, launcher).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    // is it the herdr that has plugins at all?
    run(herdr, &["plugin", "--help"]).map_err(|_| format!("{} has no plugin command (herdr 0.9.5 or newer has)", herdr.display()))?;
    let _ = run(herdr, &["plugin", "unlink", TUI_PLUGIN_ID]);
    let dir_text = dir.display().to_string();
    run(herdr, &["plugin", "link", &dir_text]).map_err(|e| format!("herdr plugin link: {e}"))?;
    Ok(dir_text)
}

/// Sets up whatever Herdr is installed. Safe to run again (it updates).
pub async fn install(state: &AppState) -> Result<InstallReport> {
    let kns_tui = kns_tui().ok_or_else(|| BackendError::config("kns-tui is not next to kns: reinstall kns"))?;
    let (app, tui) = (app_found(), herdr_paths::tui_bin());
    if !app && tui.is_none() {
        return Err(BackendError::new(
            0,
            "HerdrNotFound",
            "Herdr is not installed: neither the Herdr app (~/.config/herdr-app) nor the herdr command was found",
        ));
    }
    let mut done = vec![];
    let mut notes = vec![];
    let mut tips = vec![];

    if app {
        // the mod reaches kns over loopback TCP: turn it on before the mod first looks
        match rpc::tcp::set(state, true).await {
            Ok(s) if s.listening => done.push(format!("kns listens for Herdr on 127.0.0.1:{}", s.port.unwrap_or(0))),
            Ok(s) => notes.push(format!("the TCP endpoint did not start: {}", s.error.unwrap_or_default())),
            Err(e) => notes.push(format!("the TCP endpoint: {}", e.message)),
        }
        let dir = mod_dir().ok_or_else(|| BackendError::config("no home folder"))?;
        let first = !ours(&dir);
        let (d, k) = (dir.clone(), kns_tui.clone());
        tokio::task::spawn_blocking(move || write_mod(&d, &k))
            .await
            .map_err(|e| BackendError::internal(e.to_string()))?
            .map_err(|e| BackendError::config(format!("{}: {e}", dir.display())))?;
        done.push(format!("the kns mod is in {}", dir.display()));
        if let Some(bin) = herdr_paths::app_bin() {
            let d = dir.display().to_string();
            let checked = {
                let bin = bin.clone();
                tokio::task::spawn_blocking(move || run(&bin, &["check", &d])).await.map_err(|e| BackendError::internal(e.to_string()))?
            };
            match checked {
                Ok(_) => {
                    done.push("herdr-app check passed".into());
                    // Herdr never docks a mod into its shipped layouts: show the panel once, beside
                    // the focused pane, so the person sees where it lives (a pane, saved with its tab)
                    if first {
                        match tokio::task::spawn_blocking(move || run(&bin, &["do", "pane.split", "--direction", "right", "--mod", MOD_NAME])).await {
                            Ok(Ok(_)) => done.push("opened the kns panel beside the focused pane in Herdr".into()),
                            _ => tips.push("open the panel from Herdr's command palette once Herdr runs".into()),
                        }
                    }
                }
                Err(e) => notes.push(format!("herdr-app check: {e}")),
            }
        }
        tips.push("In Herdr's command palette: \"kns: panel beside this pane\" and \"kns: clusters in a new tab\".".into());
    }
    if let Some(herdr) = tui {
        let k = kns_tui.clone();
        match tokio::task::spawn_blocking(move || install_tui_plugin(&herdr, &k)).await.map_err(|e| BackendError::internal(e.to_string()))? {
            Ok(dir) => {
                done.push(format!("the herdr TUI plugin is linked from {dir}"));
                tips.push("herdr TUI: bind kns.open to a key in ~/.config/herdr/config.toml".into());
            }
            Err(e) => notes.push(format!("herdr TUI plugin: {e}")),
        }
    }
    Ok(InstallReport { done, notes, tips, status: status(state) })
}

/// Removes the mod and the TUI plugin link, and turns the TCP endpoint off.
pub async fn uninstall(state: &AppState) -> Result<InstallReport> {
    let mut done = vec![];
    let mut notes = vec![];
    if let Some(dir) = mod_dir() {
        if ours(&dir) {
            std::fs::remove_dir_all(&dir).map_err(|e| BackendError::config(format!("{}: {e}", dir.display())))?;
            done.push(format!("removed {}", dir.display()));
        } else if dir.exists() {
            notes.push(format!("{} was not written by kns; left alone", dir.display()));
        }
    }
    if let Some(herdr) = herdr_paths::tui_bin()
        && tui_plugin_dir().is_some_and(|d| d.exists())
    {
        match run(&herdr, &["plugin", "unlink", TUI_PLUGIN_ID]) {
            Ok(_) => done.push("unlinked the herdr TUI plugin".into()),
            Err(e) => notes.push(format!("herdr plugin unlink: {e}")),
        }
        if let Some(d) = tui_plugin_dir() {
            let _ = std::fs::remove_dir_all(d);
        }
    }
    rpc::tcp::set(state, false).await?;
    done.push("turned the TCP endpoint off".into());
    Ok(InstallReport { done, notes, tips: vec![], status: status(state) })
}

/// At start: an installed mod that differs from this kns's (kns was updated) is rewritten.
pub fn refresh_installed() {
    std::thread::spawn(|| {
        let (Some(dir), Some(kns_tui)) = (mod_dir(), kns_tui()) else { return };
        if ours(&dir) && !mod_current(&dir, Some(&kns_tui))
            && let Err(e) = write_mod(&dir, &kns_tui)
        {
            eprintln!("kns: could not update the Herdr mod in {}: {e}", dir.display());
        }
    });
}

pub mod cmd {
    use super::*;

    #[tauri::command]
    pub fn herdr_status(state: tauri::State<'_, AppState>) -> HerdrStatus {
        super::status(&state)
    }

    #[tauri::command]
    pub async fn herdr_install(state: tauri::State<'_, AppState>) -> Result<InstallReport> {
        super::install(&state).await
    }

    #[tauri::command]
    pub async fn herdr_uninstall(state: tauri::State<'_, AppState>) -> Result<InstallReport> {
        super::uninstall(&state).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_names_kns_tui_and_is_recognised() {
        let js = config_js(Path::new("/Applications/kns.app/Contents/MacOS/kns-tui"));
        assert!(js.starts_with(MARKER));
        assert!(js.contains("return \"/Applications/kns.app/Contents/MacOS/kns-tui\";"));
        assert!(js.contains("export function tcpInfo()"));
        // quotes in a path stay inside the string
        assert!(config_js(Path::new("/x/\"y/kns-tui")).contains(r#"return "/x/\"y/kns-tui";"#));
    }

    #[test]
    fn mod_files_round_trip_and_main_comes_last() {
        assert_eq!(MOD_FILES.last().unwrap().0, "main.js");
        let dir = std::env::temp_dir().join(format!("kns-herdr-mod-{}", std::process::id()));
        let tui = Path::new("/bin/kns-tui");
        write_mod(&dir, tui).unwrap();
        assert!(ours(&dir));
        assert!(mod_current(&dir, Some(tui)));
        std::fs::write(dir.join("panel.js"), "changed").unwrap();
        assert!(!mod_current(&dir, Some(tui)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tui_manifest_names_every_entrypoint() {
        for id in ["\"tui\"", "\"logs\"", "\"exec\"", "\"popup\"", "\"tab\""] {
            assert!(TUI_MANIFEST.contains(&format!("id = {id}")), "{id}");
        }
        assert!(TUI_LAUNCHER.contains("KNS_TUI_BAKED=\"\""), "install bakes the path into this line");
    }
}
