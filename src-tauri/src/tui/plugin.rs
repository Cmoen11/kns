//! Helpers for the herdr TUI plugin's entrypoints. Installing it (and the Herdr app's panel) is
//! kns's job: `herdr.rs`, reached through `kns-tui herdr install` or Settings → Herdr.
use std::process::Command;

use serde_json::Value;

pub const PLUGIN_ID: &str = "kns";

/// The directory of the workspace or focused pane the plugin was invoked from.
pub fn workspace_dir() -> Option<String> {
    let ctx: Value = serde_json::from_str(&std::env::var("HERDR_PLUGIN_CONTEXT_JSON").ok()?).ok()?;
    ["focused_pane_cwd", "workspace_cwd"]
        .iter()
        .find_map(|k| ctx[*k].as_str().filter(|s| !s.is_empty()).map(str::to_string))
}

/// Action `open-pane <entrypoint>`: opens a kns pane in the invoking workspace's directory.
pub fn open_pane(entrypoint: &str) -> Result<(), String> {
    let bin = std::env::var("HERDR_BIN_PATH").unwrap_or_else(|_| "herdr".into());
    let plugin = std::env::var("HERDR_PLUGIN_ID").unwrap_or_else(|_| PLUGIN_ID.into());
    let mut cmd = Command::new(&bin);
    cmd.args(["plugin", "pane", "open", "--plugin", &plugin, "--entrypoint", entrypoint, "--focus"]);
    if let Some(dir) = workspace_dir() {
        cmd.args(["--cwd", &dir]);
    }
    if let Ok(ws) = std::env::var("HERDR_WORKSPACE_ID") {
        cmd.args(["--workspace", &ws]);
    }
    let out = cmd.output().map_err(|e| format!("{bin}: {e}"))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}
