//! `aws sso login` for contexts whose kubeconfig user runs `aws eks get-token`.
//!
//! The window never sends a profile: it names a context, and the profile is read from that
//! context's kubeconfig user (`--profile X` in the exec args, or `AWS_PROFILE` in its env). A
//! profile that has an `sso_session` in the AWS config logs in with `--sso-session <name>`, any
//! other with `--profile <name>`. The CLI opens the browser itself; this waits until it exits.
use std::{path::PathBuf, process::Stdio, time::Duration};

use kube::config::{AuthInfo, Kubeconfig};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

use crate::ipc::{BackendError, Result};

/// A login waits for a person in a browser.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// A GUI app on macOS starts with `/usr/bin:/bin:...`: Homebrew's `aws` is not on it.
const EXTRA_PATH: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/aws-cli"];

/// A profile name as the AWS CLI accepts it, and never an option (`-x`).
fn valid_profile(p: &str) -> bool {
    !p.is_empty() && p.len() <= 128 && !p.starts_with('-') && p.chars().all(|c| c.is_ascii_alphanumeric() || "._-@:+/".contains(c))
}

/// The AWS profile the user's exec plugin signs in with, when it is the AWS CLI.
pub fn profile_of(user: &AuthInfo) -> Option<String> {
    let exec = user.exec.as_ref()?;
    let command = exec.command.as_deref()?;
    let program = command.rsplit(['/', '\\']).next().unwrap_or(command);
    if !matches!(program, "aws" | "aws.exe") {
        return None;
    }
    let args = exec.args.as_deref().unwrap_or_default();
    let from_args = args.iter().enumerate().find_map(|(i, a)| match a.strip_prefix("--profile=") {
        Some(p) => Some(p.to_string()),
        None if a == "--profile" => args.get(i + 1).cloned(),
        None => None,
    });
    let from_env = || {
        exec.env.as_deref().unwrap_or_default().iter().find_map(|e| (e.get("name").map(String::as_str) == Some("AWS_PROFILE")).then(|| e.get("value").cloned()).flatten())
    };
    from_args.or_else(from_env).filter(|p| valid_profile(p))
}

/// `key` of `[profile <profile>]` in an AWS config file's text.
fn profile_value(config: &str, profile: &str, key: &str) -> Option<String> {
    let mut inside = false;
    for line in config.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let header = header.trim();
            inside = header == profile || header.strip_prefix("profile").is_some_and(|n| n.trim() == profile);
        } else if inside && let Some((k, v)) = line.split_once('=') && k.trim() == key {
            return Some(v.trim().to_string()).filter(|s| valid_profile(s));
        }
    }
    None
}

/// Arguments of the login for `profile`. An assume-role profile (`source_profile`) holds no SSO
/// settings itself: the chain is followed to the profile that has an `sso_session` or an
/// `sso_start_url`.
pub fn login_args(profile: &str, config: &str) -> Vec<String> {
    let mut args = vec!["sso".to_string(), "login".to_string()];
    let mut at = profile.to_string();
    for _ in 0..5 {
        if let Some(session) = profile_value(config, &at, "sso_session") {
            args.extend(["--sso-session".to_string(), session]);
            return args;
        }
        if profile_value(config, &at, "sso_start_url").is_some() {
            break;
        }
        match profile_value(config, &at, "source_profile") {
            Some(next) => at = next,
            None => {
                at = profile.to_string();
                break;
            }
        }
    }
    args.extend(["--profile".to_string(), at]);
    args
}

fn aws_config_path() -> Option<PathBuf> {
    std::env::var_os("AWS_CONFIG_FILE").map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".aws").join("config")))
}

/// The profile of `context` in `kubeconfig`.
pub fn context_profile(kubeconfig: &Kubeconfig, context: &str) -> Option<String> {
    let user = kubeconfig.contexts.iter().find(|c| c.name == context)?.context.as_ref()?.user.as_deref()?;
    profile_of(kubeconfig.auth_infos.iter().find(|u| u.name == user)?.auth_info.as_ref()?)
}

/// Runs the login of `context` and returns when the CLI is done.
pub async fn login(context: &str) -> Result<()> {
    let (kubeconfig, _) = crate::session::load_kubeconfig().await?;
    let profile = context_profile(&kubeconfig, context)
        .ok_or_else(|| BackendError::invalid(format!("context \"{context}\" does not sign in with an AWS profile")))?;
    let config = match aws_config_path() {
        Some(p) => tokio::fs::read_to_string(p).await.unwrap_or_default(),
        None => String::new(),
    };
    let args = login_args(&profile, &config);

    let mut path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    path.extend(EXTRA_PATH.iter().map(PathBuf::from));
    let mut cmd = Command::new("aws");
    cmd.args(&args).env("PATH", std::env::join_paths(path).unwrap_or_default());
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let shown = format!("aws {}", args.join(" "));
    let mut child = cmd.spawn().map_err(|e| BackendError::config(format!("could not run `{shown}`: {e} (is the AWS CLI installed?)")))?;
    let mut stderr = child.stderr.take();
    let run = async {
        let status = child.wait().await?;
        let mut err = String::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_string(&mut err).await;
        }
        Ok::<_, std::io::Error>((status, err))
    };
    match timeout(LOGIN_TIMEOUT, run).await {
        Ok(Ok((status, _))) if status.success() => Ok(()),
        Ok(Ok((status, err))) => Err(BackendError::config(format!("`{shown}` failed ({status}): {}", err.trim().lines().last().unwrap_or("no output")))),
        Ok(Err(e)) => Err(BackendError::internal(format!("`{shown}`: {e}"))),
        Err(_) => Err(BackendError::config(format!("`{shown}` timed out: no sign-in within {} minutes", LOGIN_TIMEOUT.as_secs() / 60))),
    }
}

pub mod cmd {
    use crate::ipc::Result;

    #[tauri::command]
    pub async fn aws_sso_login(context: String) -> Result<()> {
        super::login(&context).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "[default]\nregion = eu-north-1\n\n[profile sso-toff]\nsso_session = toff\nsso_account_id = 1\n\n[profile sso-dev-eks]\nsso_start_url = https://x\nsso_region = eu-west-1\n\n[sso-session toff]\nsso_start_url = https://y\n";

    #[test]
    fn a_profile_with_a_session_logs_in_by_session() {
        assert_eq!(login_args("sso-toff", CONFIG), ["sso", "login", "--sso-session", "toff"]);
    }

    #[test]
    fn an_assume_role_profile_follows_its_source_profile() {
        let cfg = format!("{CONFIG}\n[profile admin-k8s]\nrole_arn = arn:x\nsource_profile = sso-toff\n\n[profile legacy-k8s]\nsource_profile = sso-dev-eks\n");
        assert_eq!(login_args("admin-k8s", &cfg), ["sso", "login", "--sso-session", "toff"]);
        assert_eq!(login_args("legacy-k8s", &cfg), ["sso", "login", "--profile", "sso-dev-eks"]);
    }

    #[test]
    fn a_legacy_profile_logs_in_by_profile() {
        assert_eq!(login_args("sso-dev-eks", CONFIG), ["sso", "login", "--profile", "sso-dev-eks"]);
        assert_eq!(login_args("missing", ""), ["sso", "login", "--profile", "missing"]);
    }

    #[test]
    fn profile_comes_from_args_or_env_of_the_aws_cli_only() {
        let user = |command: &str, args: serde_json::Value, env: serde_json::Value| -> AuthInfo {
            serde_json::from_value(serde_json::json!({"exec": {"apiVersion": "client.authentication.k8s.io/v1beta1", "command": command, "args": args, "env": env}})).unwrap()
        };
        let none = serde_json::Value::Null;
        let a = user("/opt/homebrew/bin/aws", serde_json::json!(["eks", "get-token", "--profile", "sso-dev-eks"]), none.clone());
        assert_eq!(profile_of(&a).as_deref(), Some("sso-dev-eks"));
        let b = user("aws", serde_json::json!(["eks", "--profile=p1"]), none.clone());
        assert_eq!(profile_of(&b).as_deref(), Some("p1"));
        let c = user("aws", serde_json::json!(["eks", "get-token"]), serde_json::json!([{"name": "AWS_PROFILE", "value": "p2"}]));
        assert_eq!(profile_of(&c).as_deref(), Some("p2"));
        assert_eq!(profile_of(&user("kubelogin", serde_json::json!(["--profile", "x"]), none.clone())), None);
        assert_eq!(profile_of(&user("aws", serde_json::json!(["eks", "--profile", "--evil"]), none)), None);
    }
}
