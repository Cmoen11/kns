//! The herdr plugin files (`herdr/` in the repo, embedded here) and the helpers its entrypoints use.
use std::process::Command;

use serde_json::Value;

pub const MANIFEST: &str = include_str!("../../../herdr/herdr-plugin.toml");
pub const LAUNCHER: &str = include_str!("../../../herdr/bin/kns-herdr");
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

/// `kns-tui herdr install`: writes the plugin to `<data_dir>/no.sixm.kns/herdr-plugin` with this
/// binary's path baked into the launcher, then `herdr plugin link`s it (or tells how to).
pub fn install() -> Result<(), String> {
    let dir = dirs::data_dir().ok_or("no data directory")?.join(super::path::IDENTIFIER).join("herdr-plugin");
    std::fs::create_dir_all(dir.join("bin")).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("herdr-plugin.toml"), MANIFEST).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().and_then(|e| e.canonicalize()).map_err(|e| e.to_string())?;
    let launcher = LAUNCHER.replace("KNS_TUI_BAKED=\"\"", &format!("KNS_TUI_BAKED={}", super::herdr::shell_quote(&exe.display().to_string())));
    let path = dir.join("bin").join("kns-herdr");
    std::fs::write(&path, launcher).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    println!("plugin written to {}", dir.display());
    let herdr = std::env::var("HERDR_BIN_PATH").unwrap_or_else(|_| "herdr".into());
    // relinking an existing plugin: unlink first, ignore "not linked"
    let _ = Command::new(&herdr).args(["plugin", "unlink", PLUGIN_ID]).output();
    match Command::new(&herdr).args(["plugin", "link"]).arg(&dir).output() {
        Ok(o) if o.status.success() => {
            println!("linked with herdr. Bind a key in ~/.config/herdr/config.toml:\n");
            println!("  [[keys.command]]\n  key = \"prefix+k\"\n  type = \"plugin_action\"\n  command = \"kns.open\"\n  description = \"kns beside this pane\"\n");
            println!("then run: herdr server reload-config");
            Ok(())
        }
        Ok(o) => Err(format!("herdr plugin link failed: {}", String::from_utf8_lossy(&o.stderr).trim())),
        Err(_) => {
            println!("herdr not found on PATH; link it yourself:\n  herdr plugin link {}", dir.display());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_names_every_entrypoint_the_tui_opens() {
        for id in ["\"tui\"", "\"logs\"", "\"exec\"", "\"popup\"", "\"tab\""] {
            assert!(MANIFEST.contains(&format!("id = {id}")), "{id}");
        }
        assert!(MANIFEST.contains(&format!("id = \"{PLUGIN_ID}\"")));
        assert!(LAUNCHER.contains("KNS_TUI_BAKED=\"\""), "install bakes the path into this line");
    }
}
