//! The kns MCP server (docs/plan-features.md §5). Owner H1; H2 and H3 extend it.
//!
//! - `auth.rs`: tokens, constant-time lookup, rate limits.
//! - `policy.rs`, `scope.rs`: what an agent may do and see, per context and namespace.
//! - `audit.rs`: the append-only audit file.
//! - `describe.rs`, `instructions.rs`: the tool table and the server instructions.
//! - `server.rs`: the loopback HTTP listener (axum + rmcp Streamable HTTP, stateless).
//! - `tools/`: the tool implementations.
//! - `shim.rs`: the stdio shim `kns-mcp` (`src/bin/kns-mcp.rs`, H3); std-only, no `crate::` paths.
//!
//! State lives in `McpState` (`state.ext`), persisted to `rust/mcp.json` (only Rust writes it):
//! `{schema, enabled, port, clients: [{name, tokenSha256, createdAt}], policies: {ctx: {policy, namespaces?}}}`.
//! The file is read on first use (`mcp_status` at UI boot); until then every policy is unknown,
//! which every caller treats as "deny".
pub mod audit;
pub mod auth;
pub mod describe;
pub mod instructions;
pub mod policy;
pub mod prompts;
pub mod resources;
pub mod scope;
pub mod server;
pub mod shim;
#[cfg(test)]
mod shim_e2e;
pub mod tools;

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

use serde::{Deserialize, Serialize};

use self::policy::StoredPolicy;
use crate::{
    events, ipc::{AuditOutcome, AuditRow, BackendError, BackendEvent, Json, McpClient, McpContextPolicy, McpPolicy, McpStatus, McpTool, Result},
    rustfiles,
    state::{AppState, lock},
};

/// Default listener port (`127.0.0.1:7099`, `rust/mcp.json`).
pub const DEFAULT_PORT: u16 = 7099;
/// `rust/mcp.json`
pub const CONFIG_FILE: &str = "mcp";
/// A client counts as connected when its token was used this recently.
pub const CONNECTED_FOR: Duration = Duration::from_secs(5 * 60);
/// How long the setup command (with the token) stays on the clipboard.
pub const CLIPBOARD_CLEAR: Duration = Duration::from_secs(120);

/// An error an agent sees: a code from §5.3, a message and a hint naming what the human can do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl McpError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), hint: None }
    }
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredClient {
    pub name: String,
    /// lowercase hex SHA-256 of the token
    pub token_sha256: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub schema: u32,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub clients: Vec<StoredClient>,
    #[serde(default)]
    pub policies: BTreeMap<String, StoredPolicy>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for Config {
    fn default() -> Self {
        Self { schema: 1, enabled: false, port: DEFAULT_PORT, clients: vec![], policies: BTreeMap::new() }
    }
}

/// Where the config and the audit file live (the app's directories; temp dirs in tests).
#[derive(Debug, Clone)]
pub struct Dirs {
    /// `<app_config_dir>/rust`
    pub config: PathBuf,
    /// `<app_data_dir>`
    pub audit: PathBuf,
}

#[derive(Debug, Default, Clone)]
struct Stats {
    last_used_ms: Option<i64>,
    calls: u64,
    bytes: u64,
    redactions: u64,
}

struct Running {
    port: u16,
    cancel: tokio_util::sync::CancellationToken,
}

#[derive(Default)]
struct Inner {
    /// `None` until `rust/mcp.json` was read (deny everything)
    config: Option<Config>,
    dirs: Option<Dirs>,
    running: Option<Running>,
    /// why the server is not running although enabled
    error: Option<String>,
    stats: HashMap<String, Stats>,
}

#[derive(Default)]
pub struct McpState {
    inner: Mutex<Inner>,
    /// serialises loading and every config write
    write: tokio::sync::Mutex<()>,
    pub(crate) audit: audit::AuditLock,
    pub(crate) limiter: Mutex<auth::Limiter>,
}

fn slot(state: &AppState) -> std::sync::Arc<McpState> {
    state.ext::<McpState>()
}

fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

fn iso(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map(|t| t.to_string()).unwrap_or_default()
}

/// Sets the directories explicitly (tests). The app derives them from its handle.
pub fn set_dirs(state: &AppState, dirs: Dirs) {
    lock(&slot(state).inner).dirs = Some(dirs);
}

fn dirs(state: &AppState) -> Result<Dirs> {
    let s = slot(state);
    if let Some(d) = lock(&s.inner).dirs.clone() {
        return Ok(d);
    }
    let app = state.app().ok_or_else(|| BackendError::internal("the app is not running"))?;
    use tauri::Manager;
    let d = Dirs {
        config: rustfiles::dir(app)?,
        audit: app.path().app_data_dir().map_err(|e| BackendError::config(e.to_string()))?,
    };
    lock(&s.inner).dirs = Some(d.clone());
    Ok(d)
}

/// The loaded config (a copy); `None` before `ensure_loaded`.
pub fn config(state: &AppState) -> Option<Config> {
    lock(&slot(state).inner).config.clone()
}

/// Reads `rust/mcp.json` once and starts the server when it was left on. A damaged file is an
/// error and stays unloaded (every agent call denied) rather than being replaced by defaults.
pub async fn ensure_loaded(state: &AppState) -> Result<()> {
    let s = slot(state);
    if lock(&s.inner).config.is_some() {
        return Ok(());
    }
    let _w = s.write.lock().await;
    if lock(&s.inner).config.is_some() {
        return Ok(());
    }
    let d = dirs(state)?;
    let cfg: Config = rustfiles::read(&d.config, CONFIG_FILE).await?.unwrap_or_default();
    let start = cfg.enabled.then_some(cfg.port);
    lock(&s.inner).config = Some(cfg);
    if let Some(port) = start {
        start_server(state, port).await;
    }
    Ok(())
}

/// Applies `f` to the config and persists it (atomic write). The config must be loaded.
async fn update<T>(state: &AppState, f: impl FnOnce(&mut Config) -> Result<T>) -> Result<T> {
    ensure_loaded(state).await?;
    let s = slot(state);
    let _w = s.write.lock().await;
    let mut cfg = lock(&s.inner).config.clone().unwrap_or_default();
    let out = f(&mut cfg)?;
    rustfiles::write(&dirs(state)?.config, CONFIG_FILE, &cfg).await?;
    lock(&s.inner).config = Some(cfg);
    Ok(out)
}

/// The stored policy of a context (`off` when unknown).
pub fn stored_policy(state: &AppState, context: &str) -> Option<StoredPolicy> {
    let cfg = config(state)?;
    Some(cfg.policies.get(context).cloned().unwrap_or_default())
}

/// The effective policy of a context: `min(stored policy, flags)` (§5.4). `None` = unknown
/// (config or context flags not loaded), which every caller treats as "not propose".
pub fn effective_policy(state: &AppState, context: &str) -> Option<McpPolicy> {
    let stored = stored_policy(state, context)?;
    policy::effective(stored.policy, crate::ctxflags::effective(state, context).ok())
}

/// Contexts the human connected in this session: the webview lists it AND Rust already holds a
/// built session for it. The Rust peek never builds one, so an agent call can neither trigger a
/// credential plugin nor ride on a context the webview merely claims (§5.4). Unit tests have no
/// cluster, so there the webview list alone decides.
pub fn connected(state: &AppState, context: &str) -> bool {
    let listed = crate::uistate::current(state).connected.iter().any(|c| c == context);
    listed && (cfg!(test) || state.has_session(context))
}

// ───────────────────────── server lifecycle ─────────────────────────

async fn start_server(state: &AppState, port: u16) {
    let s = slot(state);
    if let Some(r) = lock(&s.inner).running.take() {
        r.cancel.cancel();
    }
    match server::start(state.clone(), port).await {
        Ok(cancel) => {
            let mut inner = lock(&s.inner);
            inner.running = Some(Running { port, cancel });
            inner.error = None;
        }
        Err(e) => lock(&s.inner).error = Some(e.message),
    }
}

fn stop_server(state: &AppState) {
    let s = slot(state);
    let mut inner = lock(&s.inner);
    if let Some(r) = inner.running.take() {
        r.cancel.cancel();
    }
    inner.error = None;
}

/// The live status (what the UI and the hub show).
pub fn status(state: &AppState) -> McpStatus {
    let s = slot(state);
    let inner = lock(&s.inner);
    let cfg = inner.config.clone().unwrap_or_default();
    let now = now_ms();
    let clients = cfg
        .clients
        .iter()
        .map(|c| {
            let st = inner.stats.get(&c.name).cloned().unwrap_or_default();
            McpClient {
                name: c.name.clone(),
                created_at: c.created_at.clone(),
                last_used_at: st.last_used_ms.map(iso),
                connected: st.last_used_ms.is_some_and(|t| now - t < CONNECTED_FOR.as_millis() as i64),
                calls: st.calls,
                bytes: st.bytes,
                redactions: st.redactions,
            }
        })
        .collect();
    McpStatus {
        on: inner.running.is_some(),
        port: inner.running.as_ref().map_or(cfg.port, |r| r.port),
        clients,
        tools: describe::TOOLS
            .iter()
            .map(|t| McpTool { name: t.name.into(), title: t.title.into(), description: t.description.into() })
            .collect(),
        policies: cfg
            .policies
            .iter()
            .map(|(context, p)| McpContextPolicy { context: context.clone(), policy: p.policy, namespaces: p.namespaces.clone() })
            .collect(),
        error: inner.error.clone(),
    }
}

fn emit_status(state: &AppState) {
    events::emit(state, BackendEvent::Mcp { status: status(state) });
}

pub async fn set_enabled(state: &AppState, on: bool) -> Result<McpStatus> {
    let port = update(state, |c| {
        c.enabled = on;
        Ok(c.port)
    })
    .await?;
    if on {
        start_server(state, port).await;
    } else {
        stop_server(state);
    }
    audit_event(state, "kns", if on { "server on" } else { "server off" }, Some(serde_json::json!({ "port": port })));
    emit_status(state);
    Ok(status(state))
}

pub async fn set_port(state: &AppState, port: u16) -> Result<McpStatus> {
    if port < 1024 {
        return Err(BackendError::invalid(format!("port {port} is outside 1024-65535")));
    }
    let enabled = update(state, |c| {
        c.port = port;
        Ok(c.enabled)
    })
    .await?;
    if enabled {
        start_server(state, port).await;
    }
    emit_status(state);
    Ok(status(state))
}

/// The command the wizard copies. The token is inline (Claude Code expands `${VAR}` only in
/// `.mcp.json`, not documented for `--header`); single quotes paste the same in PowerShell and bash.
pub fn setup_command(port: u16, token: &str) -> String {
    format!("claude mcp add --scope user --transport http kns http://127.0.0.1:{port}/mcp --header 'Authorization: Bearer {token}'")
}

/// Adds (or re-keys) a client and puts the setup command on the clipboard. The token is never
/// returned to the webview and never stored in plain text.
pub async fn client_add(state: &AppState, name: &str) -> Result<bool> {
    if !auth::valid_client_name(name) {
        return Err(BackendError::invalid(format!("invalid client name \"{}\": use 1-40 of A-Z a-z 0-9 . _ -", crate::redact::clean_untrusted(name, 60))));
    }
    let token = auth::new_token();
    let hash = auth::hash_token(&token);
    let (port, rekeyed) = update(state, |c| {
        let rekeyed = c.clients.iter().any(|x| x.name == name);
        c.clients.retain(|x| x.name != name);
        c.clients.push(StoredClient { name: name.into(), token_sha256: hash, created_at: iso(now_ms()) });
        Ok((c.port, rekeyed))
    })
    .await?;
    lock(&slot(state).limiter).forget(name);
    if rekeyed {
        crate::proposals::cancel_client(state, name, "the client's token was replaced");
    }
    let written = crate::clip::write_secret(&setup_command(port, &token), CLIPBOARD_CLEAR)?;
    audit_event(state, name, if rekeyed { "token replaced" } else { "token added" }, None);
    emit_status(state);
    Ok(written.excluded)
}

/// Removes a client: its token stops working at once, its open proposals are cancelled and the
/// forwards it still owns are stopped. Returns how many forwards were stopped.
pub async fn client_revoke(state: &AppState, name: &str) -> Result<usize> {
    let existed = update(state, |c| {
        let before = c.clients.len();
        c.clients.retain(|x| x.name != name);
        Ok(before != c.clients.len())
    })
    .await?;
    if !existed {
        return Err(BackendError::new(404, "NotFound", format!("no MCP client named \"{name}\"")));
    }
    lock(&slot(state).limiter).forget(name);
    lock(&slot(state).inner).stats.remove(name);
    crate::proposals::cancel_client(state, name, "the client's token was revoked");
    let stopped = crate::forward::stop_by_owner(state, name).await.unwrap_or(0);
    audit_event(state, name, "token revoked", Some(serde_json::json!({ "forwardsStopped": stopped })));
    emit_status(state);
    Ok(stopped)
}

/// A namespace name as Kubernetes allows it (RFC 1123 label).
fn valid_namespace(ns: &str) -> bool {
    !ns.is_empty()
        && ns.len() <= 63
        && ns.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !ns.starts_with('-')
        && !ns.ends_with('-')
}

/// `true` when `new` lets an agent do or see less than `old`.
pub fn is_lowering(old: &StoredPolicy, new: &StoredPolicy) -> bool {
    if new.policy < old.policy {
        return true;
    }
    match (&old.namespaces, &new.namespaces) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(o), Some(n)) => n.iter().any(|x| !o.contains(x)) || o.iter().any(|x| !n.contains(x)),
    }
}

/// Sets a context's policy. Lowering it cancels that context's open proposals; lowering to
/// `off` also stops agent-owned forwards there. (Storing `propose` on a protected context needs
/// the UI's tier-2 confirm, §5.4.)
pub async fn policy_set(state: &AppState, context: &str, policy: McpPolicy, namespaces: Option<Vec<String>>) -> Result<()> {
    if context.is_empty() || context.len() > 253 {
        return Err(BackendError::invalid("invalid context name"));
    }
    let mut namespaces = namespaces.filter(|n| !n.is_empty());
    if let Some(list) = &mut namespaces {
        if let Some(bad) = list.iter().find(|n| !valid_namespace(n)) {
            return Err(BackendError::invalid(format!("invalid namespace \"{}\"", crate::redact::clean_untrusted(bad, 80))));
        }
        list.sort();
        list.dedup();
    }
    let new = StoredPolicy { policy, namespaces };
    let old = update(state, |c| {
        let old = c.policies.get(context).cloned().unwrap_or_default();
        if new.policy == McpPolicy::Off && new.namespaces.is_none() {
            c.policies.remove(context);
        } else {
            c.policies.insert(context.into(), new.clone());
        }
        Ok(old)
    })
    .await?;
    if is_lowering(&old, &new) {
        crate::proposals::cancel_context(state, context, &format!("the agent policy for {context} was lowered"));
    }
    if new.policy == McpPolicy::Off && old.policy != McpPolicy::Off {
        stop_agent_forwards_in(state, context).await;
    }
    audit_event(state, "kns", "policy", Some(serde_json::json!({ "context": context, "policy": new.policy, "namespaces": new.namespaces })));
    emit_status(state);
    Ok(())
}

async fn stop_agent_forwards_in(state: &AppState, context: &str) {
    let Ok(forwards) = crate::forward::list_forwards(state).await else { return };
    for f in forwards {
        if f.context == context && matches!(f.owner, crate::ipc::ForwardOwner::Agent { .. }) {
            let _ = crate::forward::stop_forward(state, &f.id).await;
        }
    }
}

pub async fn audit_tail(state: &AppState, limit: u32) -> Result<Vec<AuditRow>> {
    let d = dirs(state)?;
    let s = slot(state);
    let limit = limit.clamp(1, 1000) as usize;
    Ok(tokio::task::spawn_blocking(move || audit::tail(&s.audit, &d.audit, limit)).await.unwrap_or_default())
}

fn audit_event(state: &AppState, client: &str, what: &str, args: Option<Json>) {
    let Ok(d) = dirs(state) else { return };
    let _ = audit::append_event(&slot(state).audit, &d.audit, &iso(now_ms()), client, what, args);
}

/// A proposal state change in the audit file (§5.6): who, which proposal, the new state. Never
/// the payload (it can carry an agent's YAML).
pub fn audit_proposal(state: &AppState, p: &crate::ipc::Proposal) {
    let st = serde_json::to_value(p.state).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
    let args = serde_json::json!({ "proposalId": p.id, "kind": crate::proposals::kind(&p.payload), "context": p.context });
    audit_event(state, &p.client, &format!("proposal {st}"), Some(args));
}

/// Called by the auth layer for every authenticated request.
pub(crate) fn touch(state: &AppState, client: &str) {
    lock(&slot(state).inner).stats.entry(client.into()).or_default().last_used_ms = Some(now_ms());
}

/// One tool call: audit line, per-client counters and the `agentActivity` event.
pub(crate) struct CallRecord<'a> {
    pub client: &'a str,
    pub tool: &'a str,
    pub args: &'a Json,
    pub result_bytes: u64,
    pub redactions: u32,
    pub outcome: AuditOutcome,
    pub proposal_id: Option<String>,
    pub ms: u64,
}

pub(crate) fn record_call(state: &AppState, r: CallRecord<'_>) {
    let now = now_ms();
    {
        let s = slot(state);
        let mut inner = lock(&s.inner);
        let st = inner.stats.entry(r.client.into()).or_default();
        st.last_used_ms = Some(now);
        st.calls += 1;
        st.bytes += r.result_bytes;
        st.redactions += u64::from(r.redactions);
    }
    let (args, _) = audit::args_for_audit(r.args);
    let row = AuditRow {
        ts: iso(now),
        client: r.client.into(),
        tool: r.tool.into(),
        args: Some(args).filter(|a| a.as_object().is_none_or(|o| !o.is_empty())),
        result_bytes: r.result_bytes,
        redactions: r.redactions,
        outcome: r.outcome,
        proposal_id: r.proposal_id.clone(),
        ms: r.ms,
    };
    if let Ok(d) = dirs(state) {
        let _ = audit::append(&slot(state).audit, &d.audit, &row);
    }
    events::emit(state, BackendEvent::AgentActivity { client: r.client.into(), tool: r.tool.into(), at: row.ts, ok: r.outcome == AuditOutcome::Ok });
}

/// The client whose token this is, if any (constant-time over every stored hash).
pub(crate) fn client_for_token(state: &AppState, token: &str) -> Option<String> {
    let cfg = config(state)?;
    auth::find_client(cfg.clients.iter().map(|c| (c.name.as_str(), c.token_sha256.as_str())), token)
}

pub mod cmd {
    use serde::Serialize;

    use crate::{
        ipc::{AuditRow, McpPolicy, McpStatus, Result},
        state::AppState,
    };

    /// `mcp_client_add` answer: the setup command went to the clipboard; the token is shown nowhere.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ClientAdded {
        pub copied: bool,
        /// the clipboard entry was kept out of clipboard history (Windows)
        pub excluded: bool,
    }

    /// Loads `rust/mcp.json` on first call (and starts the server when it was left on).
    #[tauri::command]
    pub async fn mcp_status(state: tauri::State<'_, AppState>) -> Result<McpStatus> {
        super::ensure_loaded(&state).await?;
        Ok(super::status(&state))
    }

    #[tauri::command]
    pub async fn mcp_set_enabled(state: tauri::State<'_, AppState>, on: bool) -> Result<McpStatus> {
        super::set_enabled(&state, on).await
    }

    #[tauri::command]
    pub async fn mcp_set_port(state: tauri::State<'_, AppState>, port: u16) -> Result<McpStatus> {
        super::set_port(&state, port).await
    }

    #[tauri::command]
    pub async fn mcp_client_add(state: tauri::State<'_, AppState>, name: String) -> Result<ClientAdded> {
        let excluded = super::client_add(&state, &name).await?;
        Ok(ClientAdded { copied: true, excluded })
    }

    #[tauri::command]
    pub async fn mcp_client_revoke(state: tauri::State<'_, AppState>, name: String) -> Result<()> {
        super::client_revoke(&state, &name).await.map(|_| ())
    }

    #[tauri::command]
    pub async fn mcp_policy_set(
        state: tauri::State<'_, AppState>,
        context: String,
        policy: McpPolicy,
        namespaces: Option<Vec<String>>,
    ) -> Result<()> {
        super::policy_set(&state, &context, policy, namespaces).await
    }

    #[tauri::command]
    pub async fn mcp_audit_tail(state: tauri::State<'_, AppState>, limit: u32) -> Result<Vec<AuditRow>> {
        super::audit_tail(&state, limit).await
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A state with temp dirs, a loaded config and loaded (empty) context flags.
    pub async fn state(tag: &str) -> (AppState, PathBuf) {
        let base = std::env::temp_dir().join(format!("kns-mcp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let state = AppState::default();
        set_dirs(&state, Dirs { config: base.join("rust"), audit: base.join("data") });
        ensure_loaded(&state).await.unwrap();
        crate::ctxflags::set(&state, Some(HashMap::new()));
        (state, base)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn effective_policy_unknown_until_loaded() {
        let state = AppState::default();
        assert_eq!(effective_policy(&state, "default"), None);
        let (state, base) = testing::state("eff").await;
        assert_eq!(effective_policy(&state, "default"), Some(McpPolicy::Off));
        policy_set(&state, "default", McpPolicy::Propose, None).await.unwrap();
        assert_eq!(effective_policy(&state, "default"), Some(McpPolicy::Propose));
        crate::ctxflags::set(&state, crate::ctxflags::parse_settings(&serde_json::json!({ "data": { "contexts": { "default": { "readOnly": true } } } })));
        assert_eq!(effective_policy(&state, "default"), Some(McpPolicy::Read));
        crate::ctxflags::set(&state, None);
        assert_eq!(effective_policy(&state, "default"), None);
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn config_persists_and_reloads() {
        let (state, base) = testing::state("persist").await;
        policy_set(&state, "default", McpPolicy::Read, Some(vec!["b".into(), "a".into(), "a".into()])).await.unwrap();
        assert!(policy_set(&state, "default", McpPolicy::Read, Some(vec!["Bad_NS".into()])).await.is_err());
        let state2 = AppState::default();
        set_dirs(&state2, Dirs { config: base.join("rust"), audit: base.join("data") });
        ensure_loaded(&state2).await.unwrap();
        let p = stored_policy(&state2, "default").unwrap();
        assert_eq!(p.policy, McpPolicy::Read);
        assert_eq!(p.namespaces, Some(vec!["a".into(), "b".into()]));
        // off without allowlist removes the entry
        policy_set(&state2, "default", McpPolicy::Off, None).await.unwrap();
        assert!(config(&state2).unwrap().policies.is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn corrupt_config_stays_unloaded() {
        let base = std::env::temp_dir().join(format!("kns-mcp-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(base.join("rust")).unwrap();
        std::fs::write(base.join("rust/mcp.json"), b"{nope").unwrap();
        let state = AppState::default();
        set_dirs(&state, Dirs { config: base.join("rust"), audit: base.join("data") });
        assert_eq!(ensure_loaded(&state).await.unwrap_err().reason, "Corrupt");
        assert_eq!(effective_policy(&state, "x"), None);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn lowering() {
        let p = |policy, ns: Option<&[&str]>| StoredPolicy { policy, namespaces: ns.map(|n| n.iter().map(|s| s.to_string()).collect()) };
        assert!(is_lowering(&p(McpPolicy::Propose, None), &p(McpPolicy::Read, None)));
        assert!(!is_lowering(&p(McpPolicy::Read, None), &p(McpPolicy::Propose, None)));
        assert!(is_lowering(&p(McpPolicy::Read, None), &p(McpPolicy::Read, Some(&["a"]))));
        assert!(!is_lowering(&p(McpPolicy::Read, Some(&["a"])), &p(McpPolicy::Read, None)));
        assert!(is_lowering(&p(McpPolicy::Read, Some(&["a", "b"])), &p(McpPolicy::Read, Some(&["a"]))));
    }

    #[tokio::test]
    async fn revoke_removes_the_token() {
        let (state, base) = testing::state("revoke").await;
        // add without the clipboard: write the client directly
        let token = auth::new_token();
        let hash = auth::hash_token(&token);
        update(&state, |c| {
            c.clients.push(StoredClient { name: "claude-code".into(), token_sha256: hash, created_at: "x".into() });
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(client_for_token(&state, &token).as_deref(), Some("claude-code"));
        client_revoke(&state, "claude-code").await.unwrap();
        assert_eq!(client_for_token(&state, &token), None);
        assert_eq!(client_revoke(&state, "claude-code").await.unwrap_err().code, 404);
        let rows = audit_tail(&state, 10).await.unwrap();
        assert_eq!(rows[0].tool, "token revoked");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn setup_command_shape() {
        let c = setup_command(7099, "TOKEN");
        assert!(c.starts_with("claude mcp add --scope user --transport http kns http://127.0.0.1:7099/mcp"));
        assert!(c.ends_with("--header 'Authorization: Bearer TOKEN'"));
    }
}
