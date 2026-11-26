//! herdr integration (https://github.com/herdrdev/herdr, plugin v1, herdr >= 0.9.5).
//!
//! - Inside a herdr plugin pane (`HERDR_PLUGIN_ID` set) logs and shells open as plugin panes
//!   (`herdr plugin pane open --entrypoint logs|exec --env KNS_*=…`): the manifest fixes the argv,
//!   so the target travels in the environment (`from_env`).
//! - Inside any other herdr pane (`HERDR_ENV=1`) they open with `pane split` + `pane run`.
//! - Outside herdr the caller falls back to an in-place view.
//! - `report` puts a short health token (`$kns`) on the workspace row of herdr's sidebar.
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
pub struct Herdr {
    bin: String,
    plugin: Option<String>,
    pub workspace: Option<String>,
    pane: Option<String>,
}

/// What a plugin pane should run, read from `KNS_*` variables.
#[derive(Debug, Clone, Default)]
pub struct Target {
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub pod: Option<String>,
    pub container: Option<String>,
    /// for logs of a workload: `<resource>/<name>`
    pub workload: Option<String>,
}

pub fn from_env() -> Target {
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    Target {
        context: var("KNS_CONTEXT"),
        namespace: var("KNS_NAMESPACE"),
        pod: var("KNS_POD"),
        container: var("KNS_CONTAINER"),
        workload: var("KNS_WORKLOAD"),
    }
}

impl Herdr {
    pub fn detect() -> Option<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        if var("HERDR_ENV").as_deref() != Some("1") && var("HERDR_BIN_PATH").is_none() {
            return None;
        }
        Some(Self {
            bin: var("HERDR_BIN_PATH").unwrap_or_else(|| "herdr".into()),
            plugin: var("HERDR_PLUGIN_ID"),
            workspace: var("HERDR_WORKSPACE_ID").or_else(|| var("HERDR_ACTIVE_WORKSPACE_ID")),
            pane: var("HERDR_PANE_ID"),
        })
    }

    pub fn is_plugin(&self) -> bool {
        self.plugin.is_some()
    }

    /// Opens `entrypoint` (`logs` or `exec`) beside this pane with `env`. Plugin panes use the
    /// manifest's entrypoints; a plain herdr pane gets a split running `kns-tui <args>`.
    pub fn open(&self, entrypoint: &str, direction: &str, env: &[(&str, String)], fallback_args: &[String]) -> Result<(), String> {
        let cwd = std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default();
        if let Some(plugin) = &self.plugin {
            let mut args: Vec<String> = ["plugin", "pane", "open", "--plugin", plugin, "--entrypoint", entrypoint, "--placement", "split", "--direction", direction, "--focus"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            if let Some(p) = &self.pane {
                args.extend(["--target-pane".into(), p.clone()]);
            }
            if !cwd.is_empty() {
                args.extend(["--cwd".into(), cwd]);
            }
            for (k, v) in env {
                args.extend(["--env".into(), format!("{k}={v}")]);
            }
            return self.run(&args).map(|_| ());
        }
        // plain herdr pane: split, then type the command into the new shell
        let mut args: Vec<String> = vec!["pane".into(), "split".into()];
        match &self.pane {
            Some(p) => args.push(p.clone()),
            None => args.push("--current".into()),
        }
        args.extend(["--direction".into(), direction.into(), "--focus".into()]);
        if !cwd.is_empty() {
            args.extend(["--cwd".into(), cwd]);
        }
        let out = self.run(&args)?;
        let v: serde_json::Value = serde_json::from_str(&out).map_err(|_| format!("herdr pane split: unexpected answer: {}", out.trim()))?;
        let pane = v.pointer("/result/pane/pane_id").and_then(|p| p.as_str()).ok_or("herdr pane split: no pane id")?;
        let exe = std::env::current_exe().map(|e| e.display().to_string()).unwrap_or_else(|_| "kns-tui".into());
        let line = std::iter::once(exe).chain(fallback_args.iter().cloned()).map(|a| shell_quote(&a)).collect::<Vec<_>>().join(" ");
        self.run(&["pane".into(), "run".into(), pane.into(), format!("exec {line}")]).map(|_| ())
    }

    /// Sets (or clears, with `None`) the `$kns` token on this workspace's sidebar row.
    pub fn report(&self, token: Option<&str>) {
        let (Some(ws), Some(plugin)) = (&self.workspace, &self.plugin) else { return };
        let mut args: Vec<String> = vec!["workspace".into(), "report-metadata".into(), ws.clone(), "--source".into(), format!("plugin:{plugin}")];
        match token {
            Some(t) => args.extend(["--token".into(), format!("kns={t}"), "--ttl-ms".into(), "180000".into()]),
            None => args.extend(["--clear-token".into(), "kns".into()]),
        }
        let _ = self.run(&args);
    }

    fn run(&self, args: &[String]) -> Result<String, String> {
        let out = Command::new(&self.bin)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("{}: {e}", self.bin))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("herdr {}: {}", args.first().map(String::as_str).unwrap_or(""), err.trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=:@,+".contains(&b)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("pod-1"), "pod-1");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
    }
}
