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
/// A GUI app on macOS starts with `/usr/bin:/bin:...`: Homebrew's `aws` (and `gh`) is not on it.
const EXTRA_PATH: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/aws-cli"];

/// `PATH` with the places Homebrew and the CLI installers use: what a CLI kns runs is looked up in.
pub fn tool_path() -> std::ffi::OsString {
    let mut path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    path.extend(EXTRA_PATH.iter().map(PathBuf::from));
    std::env::join_paths(path).unwrap_or_default()
}

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

/// `key` of the section whose header `matches`, in an AWS config file's text.
fn section_value(config: &str, matches: impl Fn(&str) -> bool, key: &str) -> Option<String> {
    let mut inside = false;
    for line in config.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            inside = matches(header.trim());
        } else if inside && let Some((k, v)) = line.split_once('=') && k.trim() == key {
            return Some(v.trim().to_string());
        }
    }
    None
}

/// `key` of `[profile <profile>]` in an AWS config file's text.
fn profile_value(config: &str, profile: &str, key: &str) -> Option<String> {
    section_value(config, |h| h == profile || h.strip_prefix("profile").is_some_and(|n| n.trim() == profile), key).filter(|s| valid_profile(s))
}

/// `key` of `[sso-session <session>]` in an AWS config file's text.
fn session_value(config: &str, session: &str, key: &str) -> Option<String> {
    section_value(config, |h| h.strip_prefix("sso-session").is_some_and(|n| n.trim() == session), key)
}

/// What a profile signs in with: an `sso-session`, or (legacy) a profile with its own `sso_start_url`.
#[derive(Debug, PartialEq)]
enum SsoTarget {
    Session(String),
    Profile(String),
}

/// An assume-role profile (`source_profile`) holds no SSO settings itself: the chain is followed
/// to the profile that has an `sso_session` or an `sso_start_url`.
fn sso_target(profile: &str, config: &str) -> SsoTarget {
    let mut at = profile.to_string();
    for _ in 0..5 {
        if let Some(session) = profile_value(config, &at, "sso_session") {
            return SsoTarget::Session(session);
        }
        if profile_value(config, &at, "sso_start_url").is_some() {
            return SsoTarget::Profile(at);
        }
        match profile_value(config, &at, "source_profile") {
            Some(next) => at = next,
            None => break,
        }
    }
    SsoTarget::Profile(profile.to_string())
}

/// The SSO start URL the token of `target` is cached under.
fn start_url(target: &SsoTarget, config: &str) -> Option<String> {
    match target {
        SsoTarget::Session(s) => session_value(config, s, "sso_start_url"),
        SsoTarget::Profile(p) => section_value(config, |h| h == p || h.strip_prefix("profile").is_some_and(|n| n.trim() == p), "sso_start_url"),
    }
}

/// Arguments of the login for `profile`.
pub fn login_args(profile: &str, config: &str) -> Vec<String> {
    let mut args = vec!["sso".to_string(), "login".to_string()];
    match sso_target(profile, config) {
        SsoTarget::Session(s) => args.extend(["--sso-session".to_string(), s]),
        SsoTarget::Profile(p) => args.extend(["--profile".to_string(), p]),
    }
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

    let mut cmd = Command::new("aws");
    cmd.args(&args).env("PATH", tool_path());
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

// ── sign-in status ─────────────────────────────────────────────────────────
//
// Read from the AWS CLI's own token cache (`~/.aws/sso/cache/*.json`): no process, no network, so
// the window can ask every minute. A cached token names its `startUrl`; the newest one for the
// profile's start URL decides. With an `sso-session` the CLI renews an expired access token itself
// from its refresh token: that counts as signed in until a request is refused.

/// Whether a context's AWS profile has a usable SSO token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SsoState {
    /// the access token is valid until `expiresAt`
    Valid,
    /// the access token expired, but the CLI renews it from its refresh token
    Refreshable,
    /// the token expired: `aws sso login` is needed
    Expired,
    /// no token for this profile in the cache (never signed in, or not an SSO profile)
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoStatus {
    pub state: SsoState,
    /// RFC 3339; when the access token expires
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

/// A token file of the cache, as far as the status needs it.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedToken {
    start_url: Option<String>,
    access_token: Option<String>,
    expires_at: Option<String>,
    refresh_token: Option<String>,
    registration_expires_at: Option<String>,
}

/// The CLI writes `...Z`; older versions wrote `...UTC`.
fn parse_time(s: &str) -> Option<jiff::Timestamp> {
    let s = s.trim();
    let s = s.strip_suffix("UTC").map(|t| format!("{}Z", t.trim_end())).unwrap_or_else(|| s.to_string());
    s.parse().ok()
}

fn same_url(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/').eq_ignore_ascii_case(b.trim().trim_end_matches('/'))
}

/// The status of `start_url` among the cache's token files (their JSON text), at `now`.
fn status_from(tokens: &[String], start_url: Option<&str>, now: jiff::Timestamp) -> SsoStatus {
    let unknown = SsoStatus { state: SsoState::Unknown, expires_at: None };
    let Some(url) = start_url else { return unknown };
    let newest = tokens
        .iter()
        .filter_map(|t| serde_json::from_str::<CachedToken>(t).ok())
        .filter(|t| t.access_token.is_some() && t.start_url.as_deref().is_some_and(|u| same_url(u, url)))
        .filter_map(|t| Some((parse_time(t.expires_at.as_deref()?)?, t)))
        .max_by_key(|(at, _)| *at);
    let Some((expires, token)) = newest else { return unknown };
    let state = if expires > now {
        SsoState::Valid
    } else if token.refresh_token.is_some() && token.registration_expires_at.as_deref().and_then(parse_time).is_none_or(|r| r > now) {
        SsoState::Refreshable
    } else {
        SsoState::Expired
    };
    SsoStatus { state, expires_at: Some(expires.to_string()) }
}

/// The JSON text of every file in the CLI's SSO token cache.
async fn cached_tokens() -> Vec<String> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".aws").join("sso").join("cache")) else { return Vec::new() };
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return Vec::new() };
    let mut out = Vec::new();
    while let Ok(Some(e)) = entries.next_entry().await {
        let path = e.path();
        if path.extension().is_some_and(|x| x == "json") && let Ok(text) = tokio::fs::read_to_string(&path).await {
            out.push(text);
        }
    }
    out
}

/// The sign-in status of each of `contexts` that signs in with an AWS profile.
pub async fn status(contexts: &[String]) -> Result<std::collections::HashMap<String, SsoStatus>> {
    let (kubeconfig, _) = crate::session::load_kubeconfig().await?;
    let config = match aws_config_path() {
        Some(p) => tokio::fs::read_to_string(p).await.unwrap_or_default(),
        None => String::new(),
    };
    let tokens = cached_tokens().await;
    let now = jiff::Timestamp::now();
    Ok(contexts
        .iter()
        .filter_map(|c| {
            let profile = context_profile(&kubeconfig, c)?;
            let url = start_url(&sso_target(&profile, &config), &config);
            Some((c.clone(), status_from(&tokens, url.as_deref(), now)))
        })
        .collect())
}

pub mod cmd {
    use crate::ipc::Result;

    #[tauri::command]
    pub async fn aws_sso_login(context: String) -> Result<()> {
        super::login(&context).await
    }

    #[tauri::command]
    pub async fn aws_sso_status(contexts: Vec<String>) -> Result<std::collections::HashMap<String, super::SsoStatus>> {
        super::status(&contexts).await
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

    #[test]
    fn the_start_url_comes_from_the_session_or_the_legacy_profile() {
        let cfg = format!("{CONFIG}\n[profile admin-k8s]\nsource_profile = sso-toff\n");
        assert_eq!(start_url(&sso_target("admin-k8s", &cfg), &cfg).as_deref(), Some("https://y"));
        assert_eq!(start_url(&sso_target("sso-dev-eks", &cfg), &cfg).as_deref(), Some("https://x"));
        assert_eq!(start_url(&sso_target("missing", &cfg), &cfg), None);
    }

    #[test]
    fn status_follows_the_newest_cached_token_of_the_start_url() {
        let now: jiff::Timestamp = "2026-11-25T12:00:00Z".parse().unwrap();
        let tok = |url: &str, exp: &str, refresh: bool| {
            let r = if refresh { r#","refreshToken":"r","registrationExpiresAt":"2027-01-01T00:00:00Z""# } else { "" };
            format!(r#"{{"startUrl":"{url}","accessToken":"a","expiresAt":"{exp}"{r}}}"#)
        };
        let client = r#"{"clientId":"c","clientSecret":"s","expiresAt":"2027-01-01T00:00:00Z"}"#.to_string();
        let st = |tokens: &[String], url: Option<&str>| status_from(tokens, url, now).state;

        let valid = [tok("https://y/", "2026-11-25T13:00:00Z", false), tok("https://y", "2026-11-24T13:00:00Z", false), client.clone()];
        assert_eq!(st(&valid, Some("https://y")), SsoState::Valid);
        assert_eq!(status_from(&valid, Some("https://y"), now).expires_at.as_deref(), Some("2026-11-25T13:00:00Z"));
        assert_eq!(st(&[tok("https://y", "2026-11-25T11:00:00UTC", false)], Some("https://y")), SsoState::Expired);
        assert_eq!(st(&[tok("https://y", "2026-11-25T11:00:00Z", true)], Some("https://y")), SsoState::Refreshable);
        assert_eq!(st(&valid, Some("https://other")), SsoState::Unknown);
        assert_eq!(st(&[client], Some("https://y")), SsoState::Unknown);
        assert_eq!(st(&valid, None), SsoState::Unknown);
    }
}
