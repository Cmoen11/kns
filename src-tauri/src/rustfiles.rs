//! Files only Rust writes (docs/plan-features.md §2.5): `<app_config_dir>/rust/<name>.json`, e.g.
//! `devsets.json`, `mcp.json`, `traps.json`, `journal.json`, `proxy.json`.
//!
//! The webview's `save_state` (store.rs) maps every key to `<app_config_dir>/<key>.json` with `/`
//! and `\` replaced, so no webview key reaches this subdirectory (tested in store.rs).
use std::path::{Path, PathBuf};

use serde::{Serialize, de::DeserializeOwned};
use tokio::io::AsyncWriteExt;

use crate::ipc::{BackendError, Result};

pub const SUBDIR: &str = "rust";

/// `<config_dir>/rust`.
pub fn dir_in(config_dir: &Path) -> PathBuf {
    config_dir.join(SUBDIR)
}

/// The directory in the running app.
pub fn dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    Ok(dir_in(&app.path().app_config_dir().map_err(|e| BackendError::config(e.to_string()))?))
}

/// `<dir>/<name>.json` for a fixed, lowercase file name (`[a-z0-9-]{1,40}`).
fn file(dir: &Path, name: &str) -> Result<PathBuf> {
    let ok = !name.is_empty() && name.len() <= 40 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !ok {
        return Err(BackendError::internal(format!("invalid rust file name \"{name}\"")));
    }
    Ok(dir.join(format!("{name}.json")))
}

/// The stored value; `Ok(None)` when the file does not exist. Unparsable content is an error, so
/// a caller never silently replaces a damaged file with defaults.
pub async fn read<T: DeserializeOwned>(dir: &Path, name: &str) -> Result<Option<T>> {
    match tokio::fs::read(file(dir, name)?).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| BackendError::new(0, "Corrupt", format!("{name}.json: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Atomic write: temp file next to the target, synced, then renamed over it. Callers serialise
/// their own writes per file (each file has one owning module).
pub async fn write<T: Serialize>(dir: &Path, name: &str, value: &T) -> Result<()> {
    let target = file(dir, name)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    tokio::fs::create_dir_all(dir).await?;
    let tmp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let written = async {
        let mut f = tokio::fs::File::create(&tmp).await?;
        f.write_all(&bytes).await?;
        f.sync_all().await?;
        drop(f);
        tokio::fs::rename(&tmp, &target).await
    }
    .await;
    if let Err(e) = written {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("kns-rustfiles-{tag}-{}", std::process::id()))
    }

    #[tokio::test]
    async fn round_trip_missing_and_corrupt() {
        let base = temp_dir("rt");
        let dir = dir_in(&base);
        assert_eq!(read::<serde_json::Value>(&dir, "devsets").await.unwrap(), None);
        write(&dir, "devsets", &serde_json::json!({ "schema": 1, "sets": [] })).await.unwrap();
        let back: serde_json::Value = read(&dir, "devsets").await.unwrap().unwrap();
        assert_eq!(back["schema"], 1);
        std::fs::write(dir.join("mcp.json"), b"{not json").unwrap();
        assert_eq!(read::<serde_json::Value>(&dir, "mcp").await.unwrap_err().reason, "Corrupt");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn names_are_fixed_lowercase() {
        for bad in ["", "../x", "a/b", "A", "x.json", "a\\b"] {
            assert!(file(Path::new("d"), bad).is_err(), "{bad}");
        }
        assert!(file(Path::new("d"), "devsets").is_ok());
    }
}
