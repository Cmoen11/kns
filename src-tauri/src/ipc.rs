//! IPC contract: Rust mirror of `src/ipc/types.ts`. Change both together.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use crate::contract::*;

pub type Json = serde_json::Value;
pub type Result<T> = std::result::Result<T, BackendError>;

/// Moves the array at `key` out of `value`; empty when absent or not an array.
/// (Unlike `value[key].take()` this cannot panic on unexpected server data.)
pub fn take_array(value: &mut Json, key: &str) -> Vec<Json> {
    match value.get_mut(key).map(Json::take) {
        Some(Json::Array(items)) => items,
        _ => Vec::new(),
    }
}

// ───────────────────────── errors ─────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackendError {
    /// HTTP status when the API server answered, else 0
    pub code: u16,
    pub reason: String,
    pub message: String,
}

impl BackendError {
    pub fn new(code: u16, reason: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code, reason: reason.into(), message: message.into() }
    }
    pub fn config(message: impl Into<String>) -> Self {
        Self::new(0, "Config", message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(0, "Invalid", message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(0, "Internal", message)
    }
    pub fn not_implemented(what: &str) -> Self {
        Self::new(0, "NotImplemented", format!("{what} is not implemented yet"))
    }
    /// Error for a non-2xx API answer; `body` is usually a `metav1.Status`.
    pub fn from_response(code: u16, body: &str) -> Self {
        let status: Json = serde_json::from_str(body).unwrap_or(Json::Null);
        let message = match status["message"].as_str() {
            Some(m) if !m.is_empty() => m,
            _ => body.trim(),
        };
        let message: String = message.chars().take(500).collect();
        Self::from_status(code, status["reason"].as_str().unwrap_or_default(), &message)
    }
    /// Error from the fields of a `metav1.Status`; empty ones are derived from the code.
    pub fn from_status(code: u16, reason: &str, message: &str) -> Self {
        let reason = if reason.is_empty() { reason_for(code) } else { reason };
        let message = if message.is_empty() { format!("HTTP {code}") } else { message.to_string() };
        Self::new(code, reason, message)
    }
}

fn reason_for(code: u16) -> &'static str {
    match code {
        400 => "BadRequest",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "NotFound",
        405 => "MethodNotAllowed",
        409 => "Conflict",
        410 => "Gone",
        422 => "Invalid",
        429 => "TooManyRequests",
        500 => "InternalError",
        503 => "ServiceUnavailable",
        504 => "Timeout",
        _ => "Unknown",
    }
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.reason, self.code, self.message)
    }
}
impl std::error::Error for BackendError {}

impl From<kube::Error> for BackendError {
    fn from(e: kube::Error) -> Self {
        use kube::Error as E;
        match e {
            E::Api(s) => Self::from_status(s.code, &s.reason, &s.message),
            // A refused exec/attach/port-forward upgrade carries the HTTP status (403, 404, ...).
            E::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(status)) => {
                Self::from_status(status.as_u16(), "", &chain(&e))
            }
            E::Auth(_) | E::InferConfig(_) | E::InferKubeconfig(_) | E::RustlsTls(_) | E::TlsRequired => {
                Self::config(chain(&e))
            }
            E::SerdeError(_) | E::FromUtf8(_) | E::BuildRequest(_) | E::HttpError(_) => Self::internal(chain(&e)),
            _ => Self::new(0, "Network", chain(&e)),
        }
    }
}
impl From<kube::config::KubeconfigError> for BackendError {
    fn from(e: kube::config::KubeconfigError) -> Self {
        Self::config(chain(&e))
    }
}
impl From<serde_json::Error> for BackendError {
    fn from(e: serde_json::Error) -> Self {
        Self::internal(format!("json: {e}"))
    }
}
impl From<http::Error> for BackendError {
    fn from(e: http::Error) -> Self {
        Self::internal(format!("request: {e}"))
    }
}
impl From<std::io::Error> for BackendError {
    fn from(e: std::io::Error) -> Self {
        let reason = match e.kind() {
            std::io::ErrorKind::AddrInUse => "AddrInUse",
            std::io::ErrorKind::PermissionDenied => "PermissionDenied",
            std::io::ErrorKind::NotFound => "NotFound",
            _ => "Io",
        };
        Self::new(0, reason, e.to_string())
    }
}

/// Error message including its sources (hyper/tower errors hide the cause otherwise).
pub fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let text = s.to_string();
        if !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        src = s.source();
    }
    out
}

// ───────────────────────── stream sink ─────────────────────────

/// Where a stream reports its events. `false` means the receiver is gone and the stream must stop.
pub trait Sink<T>: Send + Sync + 'static {
    fn send(&self, event: T) -> bool;
}

impl<T: Serialize + Send + Sync + 'static> Sink<T> for tauri::ipc::Channel<T> {
    fn send(&self, event: T) -> bool {
        tauri::ipc::Channel::send(self, event).is_ok()
    }
}

/// Closure-backed sink (tests, examples).
pub struct FnSink<F>(pub F);

impl<T, F: Fn(T) -> bool + Send + Sync + 'static> Sink<T> for FnSink<F> {
    fn send(&self, event: T) -> bool {
        (self.0)(event)
    }
}

// ───────────────────────── basics ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Gvr {
    pub group: String,
    pub version: String,
    pub resource: String,
}

impl Gvr {
    pub fn new(group: &str, version: &str, resource: &str) -> Self {
        Self { group: group.into(), version: version.into(), resource: resource.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjRef {
    pub context: String,
    pub gvr: Gvr,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub name: String,
}

impl ObjRef {
    /// Namespace, with `""` treated as absent.
    pub fn ns(&self) -> Option<&str> {
        self.namespace.as_deref().filter(|n| !n.is_empty())
    }
}

// ───────────────────────── contexts ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// the AWS profile its exec plugin signs in with: the context can `aws sso login`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aws_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextList {
    pub contexts: Vec<ContextInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub context: String,
    pub cluster: String,
    pub user: String,
    pub server: String,
    pub server_version: String,
    pub has_metrics: bool,
}

// ───────────────────────── discovery ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResource {
    pub gvr: Gvr,
    pub kind: String,
    pub singular: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    pub short_names: Vec<String>,
    pub categories: Vec<String>,
    pub subresources: Vec<String>,
}

// ───────────────────────── tables ─────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    pub context: String,
    pub gvr: Gvr,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub label_selector: Option<String>,
    #[serde(default)]
    pub field_selector: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub format: String,
    pub description: String,
    pub priority: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerRef {
    pub kind: String,
    pub name: String,
    pub uid: String,
    pub api_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub uid: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleting: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owners: Option<Vec<OwnerRef>>,
    pub cells: Vec<Json>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchState {
    Syncing,
    Live,
    Reconnecting,
    Forbidden,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TableEvent {
    Snapshot {
        columns: Vec<Column>,
        rows: Vec<Row>,
    },
    Delta {
        upserts: Vec<Row>,
        deletes: Vec<String>,
    },
    State {
        state: WatchState,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

// ───────────────────────── objects & mutations ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Propagation {
    Background,
    Foreground,
    Orphan,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOptions {
    #[serde(default)]
    pub propagation: Option<Propagation>,
    #[serde(default)]
    pub grace_period_seconds: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOptions {
    #[serde(default)]
    pub dry_run: Option<bool>,
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub yaml: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PatchType {
    Merge,
    Json,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    #[serde(rename = "type")]
    pub type_: String,
    pub reason: String,
    pub message: String,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    pub source: String,
    pub object_kind: String,
    pub object_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodRef {
    pub namespace: String,
    pub name: String,
    pub containers: Vec<String>,
    pub init_containers: Vec<String>,
    pub ephemeral_containers: Vec<String>,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
}

// ───────────────────────── metrics ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetric {
    pub namespace: String,
    pub name: String,
    pub cpu_milli: i64,
    pub mem_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetric {
    pub name: String,
    pub cpu_milli: i64,
    pub mem_bytes: i64,
    pub cpu_alloc_milli: i64,
    pub mem_alloc_bytes: i64,
}

// logs: LogQuery, LogLine, LogEvent, LogTarget moved to contract/logs.rs (re-exported above).

// ───────────────────────── exec ─────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecQuery {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub command: Vec<String>,
    pub tty: bool,
    #[serde(default)]
    pub attach: Option<bool>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecEvent {
    Data {
        b64: String,
    },
    Exit {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Error {
        message: String,
    },
}

// ───────────────────────── port-forward ─────────────────────────
// `ForwardQuery`, `Forward` and `ForwardStatus` live in contract/fwd.rs (B-fwd, docs/plan-features.md §2.4).

// ───────────────────────── rbac ─────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessQuery {
    pub context: String,
    pub verb: String,
    pub gvr: Gvr,
    #[serde(default)]
    pub subresource: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}
