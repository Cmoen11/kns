//! Persisted UI state: one JSON file per key in the app config dir.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use tokio::io::AsyncWriteExt;

use crate::ipc::{BackendError, Json, Result};

/// Orders the saves by when they were asked for.
static SEQ: AtomicU64 = AtomicU64::new(0);
/// One save at a time; per file the sequence number of the newest value written.
static WRITTEN: tokio::sync::Mutex<Option<HashMap<PathBuf, u64>>> = tokio::sync::Mutex::const_new(None);

/// `<dir>/<key>.json`, with everything outside `[A-Za-z0-9._-]` replaced so a key cannot leave `dir`.
fn file_for(dir: &Path, key: &str) -> Result<PathBuf> {
    let safe: String =
        key.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    // Windows maps these names to devices whatever the extension.
    let stem = safe.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.ends_with(|c: char| c.is_ascii_digit()));
    if safe.is_empty() || safe.chars().all(|c| c == '.') || safe.len() > 100 || device {
        return Err(BackendError::invalid(format!("invalid state key \"{key}\"")));
    }
    Ok(dir.join(format!("{safe}.json")))
}

/// Stored value, or `null` when the key was never saved (or its file is unreadable JSON).
pub async fn load_state(dir: &Path, key: &str) -> Result<Json> {
    match tokio::fs::read(file_for(dir, key)?).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or(Json::Null)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Json::Null),
        Err(e) => Err(e.into()),
    }
}

/// Atomic save: write and sync a temp file next to the target, then rename over it. Saves run one
/// at a time and a save that was overtaken by a later one for the same key is dropped, so the last
/// value asked for is the one that stays.
pub async fn save_state(dir: &Path, key: &str, value: &Json) -> Result<()> {
    save_state_written(dir, key, value).await.map(|_| ())
}

/// `save_state`, telling whether this value was written (false: a later save overtook it).
pub async fn save_state_written(dir: &Path, key: &str, value: &Json) -> Result<bool> {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let target = file_for(dir, key)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut written = WRITTEN.lock().await;
    let newest = written.get_or_insert_default().entry(target.clone()).or_default();
    if *newest > seq {
        return Ok(false);
    }
    tokio::fs::create_dir_all(dir).await?;
    let tmp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let saved = async {
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(&bytes).await?;
        // Without this a power loss shortly after the rename can leave an empty file.
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&tmp, &target).await
    }
    .await;
    match saved {
        Ok(()) => {
            *newest = seq;
            Ok(true)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(e.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::file_for;
    use std::path::Path;

    #[test]
    fn keys() {
        let name = |key: &str| file_for(Path::new("d"), key).ok().and_then(|p| Some(p.file_name()?.to_str()?.to_string()));
        assert_eq!(name("layout"), Some("layout.json".into()));
        assert_eq!(name("../escape/x"), Some(".._escape_x.json".into()));
        assert_eq!(name("console"), Some("console.json".into()));
        assert_eq!(name("com10"), Some("com10.json".into()));
        for bad in ["", "..", "CON", "nul", "Aux.backup", "com1", "LPT9.x"] {
            assert_eq!(name(bad), None, "{bad}");
        }
    }

    /// The webview can never write Rust-owned files under `<dir>/rust/` (rustfiles.rs).
    #[test]
    fn keys_never_reach_the_rust_subdir() {
        let dir = Path::new("cfg");
        let keys = [
            "rust/devsets", "rust\\devsets", "RUST/mcp", "Rust\\mcp", "../rust/x", "..\\rust\\x", "./rust/x", "rust/../rust/x",
            "rust", "rust.", "rust/", "/rust/x", "\\rust\\x", "%2e%2e/rust", "rust%2fdevsets", "r\u{fc}st/x", "rust\0x",
        ];
        for key in keys {
            if let Ok(path) = file_for(dir, key) {
                assert_eq!(path.parent(), Some(dir), "{key}");
                assert_ne!(path, dir.join(crate::rustfiles::SUBDIR), "{key}");
                assert!(!path.starts_with(dir.join(crate::rustfiles::SUBDIR)), "{key}");
            }
        }
    }
}

pub mod cmd {
    use std::path::PathBuf;

    use tauri::Manager;

    use crate::ipc::{BackendError, Json, Result};

    fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
        app.path().app_config_dir().map_err(|e| BackendError::config(e.to_string()))
    }

    #[tauri::command]
    pub async fn load_state(app: tauri::AppHandle, key: String) -> Result<Json> {
        super::load_state(&config_dir(&app)?, &key).await
    }

    #[tauri::command]
    pub async fn save_state(app: tauri::AppHandle, state: tauri::State<'_, crate::state::AppState>, key: String, value: Json) -> Result<()> {
        let written = super::save_state_written(&config_dir(&app)?, &key, &value).await?;
        // Rust reads the context flags from the settings it persists (docs/plan-features.md §5.4).
        // An overtaken save wrote nothing; the newer one updates the flags itself.
        if written && key == crate::ctxflags::SETTINGS_KEY {
            crate::ctxflags::on_settings_saved(&state, &value);
        }
        Ok(())
    }
}
