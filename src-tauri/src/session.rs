//! Kubeconfig loading, one cached `Session` per context, and the raw request helpers
//! every other module uses.
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use bytes::Bytes;
use http::{HeaderMap, Method, Request};
use http_body_util::BodyExt;
use kube::{
    Client, Config,
    config::{KubeConfigOptions, Kubeconfig},
};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::de::DeserializeOwned;

use crate::{
    discovery::{self, Discovery},
    ipc::{BackendError, ClusterInfo, ContextInfo, ContextList, Gvr, Json, Result, chain},
    state::AppState,
};

/// Upper bound for a non-streaming request; kube-rs sets no read timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a discovery result without the aggregated APIs is served before it is fetched again.
const PARTIAL_TTL: Duration = Duration::from_secs(5);
pub const MERGE_PATCH: &str = "application/merge-patch+json";
pub const JSON_PATCH: &str = "application/json-patch+json";
pub const APPLY_PATCH: &str = "application/apply-patch+yaml";
pub const JSON: &str = "application/json";

/// Allocatable (cpu milli, memory bytes) per node name.
pub(crate) type Allocatable = Arc<HashMap<String, (i64, i64)>>;

pub struct Session {
    pub client: Client,
    pub context: String,
    pub cluster: String,
    pub user: String,
    pub server: String,
    /// Last discovery result. Readers never wait for a refresh that someone else is running.
    discovery: RwLock<Option<(Instant, Arc<Discovery>)>>,
    /// Held while discovery is being fetched, so there is one fetch at a time.
    discovery_refresh: tokio::sync::Mutex<()>,
    /// SelfSubjectAccessReview answers, see `rbac.rs`.
    pub(crate) access: Mutex<HashMap<String, (Instant, bool)>>,
    /// Allocatable (cpu milli, memory bytes) per node, see `metrics.rs`.
    pub(crate) allocatable: Mutex<Option<(Instant, Allocatable)>>,
}

// ───────────────────────── kubeconfig ─────────────────────────

fn kubeconfig_paths() -> Vec<PathBuf> {
    match std::env::var_os("KUBECONFIG").filter(|v| !v.is_empty()) {
        Some(v) => std::env::split_paths(&v).filter(|p| !p.as_os_str().is_empty()).collect(),
        None => std::env::home_dir().map(|h| h.join(".kube").join("config")).into_iter().collect(),
    }
}

/// Merged kubeconfig (first file wins, like kubectl) and the files that were read.
pub(crate) async fn load_kubeconfig() -> Result<(Kubeconfig, Vec<String>)> {
    let read = || -> Result<(Kubeconfig, Vec<String>)> {
        let mut merged: Option<Kubeconfig> = None;
        let mut files = Vec::new();
        for path in kubeconfig_paths() {
            if !path.is_file() {
                continue;
            }
            let next = Kubeconfig::read_from(&path)
                .map_err(|e| BackendError::config(format!("{}: {}", path.display(), chain(&e))))?;
            merged = Some(match merged {
                Some(m) => m.merge(next)?,
                None => next,
            });
            files.push(path.display().to_string());
        }
        Ok((merged.unwrap_or_default(), files))
    };
    tokio::task::spawn_blocking(read).await.map_err(|e| BackendError::internal(e.to_string()))?
}

pub async fn list_contexts() -> Result<ContextList> {
    let (kubeconfig, files) = load_kubeconfig().await?;
    let contexts = kubeconfig
        .contexts
        .iter()
        .map(|c| {
            let ctx = c.context.as_ref();
            ContextInfo {
                name: c.name.clone(),
                cluster: ctx.map(|x| x.cluster.clone()).unwrap_or_default(),
                user: ctx.and_then(|x| x.user.clone()).unwrap_or_default(),
                namespace: ctx.and_then(|x| x.namespace.clone()).filter(|n| !n.is_empty()),
                aws_profile: crate::awslogin::context_profile(&kubeconfig, &c.name),
            }
        })
        .collect();
    Ok(ContextList { contexts, current: kubeconfig.current_context.filter(|c| !c.is_empty()), files })
}

/// Builds (or reuses) the session and checks connectivity. A failed check drops the session
/// so the next attempt re-reads the kubeconfig.
pub async fn connect(state: &AppState, context: &str) -> Result<ClusterInfo> {
    let session = state.session(context).await?;
    let (version, discovery) = tokio::join!(timed(session.client.apiserver_version()), session.discovery(None));
    let version = match version {
        Ok(v) => v,
        Err(e) => {
            state.drop_session(&session);
            return Err(e);
        }
    };
    autostart_once(state, context);
    Ok(ClusterInfo {
        context: session.context.clone(),
        cluster: session.cluster.clone(),
        user: session.user.clone(),
        server: session.server.clone(),
        server_version: version.git_version,
        has_metrics: discovery.map(|d| d.has_group("metrics.k8s.io")).unwrap_or(false),
    })
}

/// Contexts whose approved `autoStart` dev sets were already brought up in this app run.
#[derive(Default)]
struct AutostartDone(Mutex<std::collections::HashSet<String>>);

/// After the first successful connect of `context` in this run, brings up its approved
/// `autoStart` dev sets in the background (plan-features Q7). Failures are kept for the UI
/// (`devset::failures`: toast and Activity row), not retried.
fn autostart_once(state: &AppState, context: &str) {
    let done = state.ext::<AutostartDone>();
    if !crate::state::lock(&done.0).insert(context.to_string()) {
        return;
    }
    let (state, context) = (state.clone(), context.to_string());
    tauri::async_runtime::spawn(async move {
        for (name, r) in crate::devset::autostart(&state, &context).await {
            if let Err(e) = r {
                eprintln!("kns: auto-start of dev set \"{name}\" failed: {}", e.message);
            }
        }
    });
}

// ───────────────────────── session ─────────────────────────

impl Session {
    pub async fn build(context: &str) -> Result<Self> {
        let (kubeconfig, _) = load_kubeconfig().await?;
        let ctx = kubeconfig
            .contexts
            .iter()
            .find(|c| c.name == context)
            .and_then(|c| c.context.clone())
            .ok_or_else(|| BackendError::config(format!("context \"{context}\" not found in kubeconfig")))?;
        let options = KubeConfigOptions { context: Some(context.to_string()), ..Default::default() };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options).await?;
        let server = config.cluster_url.to_string();
        // Building the client runs exec credential plugins synchronously.
        let client = tokio::task::spawn_blocking(move || Client::try_from(config))
            .await
            .map_err(|e| BackendError::internal(e.to_string()))??;
        Ok(Self {
            client,
            context: context.to_string(),
            cluster: ctx.cluster,
            user: ctx.user.unwrap_or_default(),
            server,
            discovery: Default::default(),
            discovery_refresh: Default::default(),
            access: Default::default(),
            allocatable: Default::default(),
        })
    }

    /// The cached discovery if it is no older than `max_age`. A partial result (the aggregated
    /// APIs did not answer) is only trusted for `PARTIAL_TTL`.
    fn cached_discovery(&self, max_age: Option<Duration>) -> Option<Arc<Discovery>> {
        let slot = self.discovery.read().unwrap_or_else(|e| e.into_inner());
        let (at, d) = slot.as_ref()?;
        let max_age = if d.partial { Some(max_age.map_or(PARTIAL_TTL, |m| m.min(PARTIAL_TTL))) } else { max_age };
        max_age.is_none_or(|max| at.elapsed() <= max).then(|| d.clone())
    }

    /// Cached discovery; refetched when missing or older than `max_age`.
    pub async fn discovery(&self, max_age: Option<Duration>) -> Result<Arc<Discovery>> {
        if let Some(d) = self.cached_discovery(max_age) {
            return Ok(d);
        }
        let _refreshing = self.discovery_refresh.lock().await;
        // Someone else may have refreshed it while this caller waited.
        if let Some(d) = self.cached_discovery(max_age) {
            return Ok(d);
        }
        let fresh = Arc::new(discovery::fetch(self).await?);
        *self.discovery.write().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), fresh.clone()));
        Ok(fresh)
    }

    /// One request, whole body. Non-2xx answers become `BackendError` with the API status.
    pub async fn send(
        &self,
        method: Method,
        uri: &str,
        accept: Option<&str>,
        body: Option<(&str, Vec<u8>)>,
    ) -> Result<(HeaderMap, Bytes)> {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(accept) = accept {
            req = req.header(http::header::ACCEPT, accept);
        }
        let (content_type, bytes) = body.unzip();
        if let Some(content_type) = content_type {
            req = req.header(http::header::CONTENT_TYPE, content_type);
        }
        let req = req.body(kube::client::Body::from(bytes.unwrap_or_default()))?;
        timed(async {
            let res = self.client.send(req).await?;
            let (parts, body) = res.into_parts();
            let bytes = body.collect().await?.to_bytes();
            if parts.status.is_success() {
                Ok((parts.headers, bytes))
            } else {
                Err(BackendError::from_response(parts.status.as_u16(), &String::from_utf8_lossy(&bytes)))
            }
        })
        .await
    }

    pub async fn get(&self, uri: &str) -> Result<Json> {
        self.get_as(uri, JSON).await
    }

    /// GET deserialized straight from the body; fields `T` does not name are skipped unparsed.
    pub async fn get_as<T: DeserializeOwned>(&self, uri: &str, accept: &str) -> Result<T> {
        let (_, bytes) = self.send(Method::GET, uri, Some(accept), None).await?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Request with a JSON body (`content_type` picks plain JSON or a patch flavour); returns the JSON answer.
    pub async fn send_json(&self, method: Method, uri: &str, content_type: &str, body: &Json) -> Result<Json> {
        let bytes = serde_json::to_vec(body)?;
        let (_, answer) = self.send(method, uri, Some(JSON), Some((content_type, bytes))).await?;
        Ok(serde_json::from_slice(&answer).unwrap_or(Json::Null))
    }
}

/// Runs a request future with the request timeout, mapping errors to `BackendError`.
pub async fn timed<T, E: Into<BackendError>>(fut: impl Future<Output = std::result::Result<T, E>>) -> Result<T> {
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Ok(r) => r.map_err(Into::into),
        Err(_) => Err(BackendError::new(0, "Network", "request timed out")),
    }
}

// ───────────────────────── paths ─────────────────────────

/// Everything except unreserved characters; safe for path segments and query values.
const ESCAPE: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

pub fn esc(s: &str) -> String {
    utf8_percent_encode(s, ESCAPE).to_string()
}

/// `/api/v1[/namespaces/ns]/pods[/name]` or `/apis/group/version/...`.
pub fn api_path(gvr: &Gvr, namespace: Option<&str>, name: Option<&str>) -> String {
    let mut path = if gvr.group.is_empty() {
        format!("/api/{}", esc(&gvr.version))
    } else {
        format!("/apis/{}/{}", esc(&gvr.group), esc(&gvr.version))
    };
    if let Some(ns) = namespace.filter(|n| !n.is_empty()) {
        path.push_str("/namespaces/");
        path.push_str(&esc(ns));
    }
    path.push('/');
    path.push_str(&esc(&gvr.resource));
    if let Some(name) = name {
        path.push('/');
        path.push_str(&esc(name));
    }
    path
}

/// Appends percent-encoded query parameters, skipping empty values.
pub fn with_query(path: &str, params: &[(&str, &str)]) -> String {
    let mut out = path.to_string();
    let mut sep = if path.contains('?') { '&' } else { '?' };
    for (k, v) in params.iter().filter(|(_, v)| !v.is_empty()) {
        out.push(sep);
        out.push_str(k);
        out.push('=');
        out.push_str(&esc(v));
        sep = '&';
    }
    out
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{ClusterInfo, ContextList, Result};

    #[tauri::command]
    pub async fn list_contexts() -> Result<ContextList> {
        super::list_contexts().await
    }

    #[tauri::command]
    pub async fn connect(state: tauri::State<'_, AppState>, context: String) -> Result<ClusterInfo> {
        super::connect(&state, &context).await
    }
}
