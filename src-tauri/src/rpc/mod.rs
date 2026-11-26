//! The local client socket (docs/plan-background.md): the whole backend contract for frontends
//! other than the webview, e.g. `kns-tui` in a herdr pane.
//!
//! - A Unix socket (`path.rs`), mode 0600, peers must run as the socket owner. No token: the
//!   socket is as private as the kubeconfig it fronts. Not on Windows yet (named pipe: later).
//! - Newline-delimited JSON. The server greets with `{"hello": {...}}`.
//!   Request `{"id": 1, "method": "get_yaml", "params": {...}}` -> `{"id": 1, "result": ...}` or
//!   `{"id": 1, "error": {code, reason, message}}`. Method and parameter names are the Tauri
//!   commands' (`dispatch.rs`).
//! - Streams (`subscribe_table`, `stream_logs`, `exec_start`, `subscribe_ns_health`) answer with
//!   their stream id; their events arrive as `{"sub": <request id>, "event": ...}`, tagged with the
//!   request id so no event can arrive before the client knows what it belongs to.
//!   `stop_stream` ends one; closing the connection ends all of its streams.
//! - Backend events (`kns://event` in the webview) arrive as `{"backend": BackendEvent}`.
//! - A client is the human, like the webview: contexts it connects count as connected for the
//!   MCP gate (`mcp::connected`) while the connection lives. Mutations honour the context flags
//!   (`readOnly` refuses, `protected` needs `confirm`).
pub mod dispatch;
pub mod path;

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::Serialize;
use serde_json::json;
use tokio::sync::{broadcast, mpsc};

use crate::{
    ipc::{BackendError, BackendEvent, Json, Result, Sink},
    state::{AppState, lock},
};

/// Largest request line (an `apply_yaml` of a big manifest fits easily).
#[cfg_attr(not(unix), allow(dead_code))]
const MAX_LINE: usize = 16 * 1024 * 1024;

// ───────────────────────── shared state ─────────────────────────

#[derive(Default)]
#[cfg_attr(not(unix), allow(dead_code))]
struct Slot {
    /// connection id -> contexts its client connected
    humans: Mutex<HashMap<u64, HashSet<String>>>,
    bus: Mutex<Option<broadcast::Sender<Json>>>,
    clients: std::sync::atomic::AtomicU64,
}

fn slot(state: &AppState) -> Arc<Slot> {
    state.ext::<Slot>()
}

/// True while a socket client that connected `context` is attached.
pub fn human_connected(state: &AppState, context: &str) -> bool {
    lock(&slot(state).humans).values().any(|set| set.contains(context))
}

/// Number of attached socket clients.
pub fn client_count(state: &AppState) -> usize {
    lock(&slot(state).humans).len()
}

/// Forwards a backend event to every attached client. Called by `events::emit`.
pub fn broadcast(state: &AppState, event: &BackendEvent) {
    let s = slot(state);
    let bus = lock(&s.bus);
    if let Some(tx) = bus.as_ref().filter(|tx| tx.receiver_count() > 0)
        && let Ok(v) = serde_json::to_value(event)
    {
        let _ = tx.send(v);
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
fn subscribe(state: &AppState) -> broadcast::Receiver<Json> {
    let s = slot(state);
    let mut bus = lock(&s.bus);
    bus.get_or_insert_with(|| broadcast::channel(256).0).subscribe()
}

pub fn hello() -> Json {
    json!({
        "app": "kns",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": path::PROTOCOL,
        "pid": std::process::id(),
        "methods": dispatch::METHODS,
    })
}

pub(crate) fn config_dir(state: &AppState) -> Result<PathBuf> {
    use tauri::Manager;
    let app = state.app().ok_or_else(|| BackendError::internal("the app is not running"))?;
    app.path().app_config_dir().map_err(|e| BackendError::config(e.to_string()))
}

pub(crate) fn open_url(state: &AppState, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let app = state.app().ok_or_else(|| BackendError::internal("the app is not running"))?;
    app.opener().open_url(url, None::<&str>).map_err(|e| BackendError::internal(format!("could not open the browser: {e}")))
}

// ───────────────────────── connection ─────────────────────────

/// One attached client: its outgoing line queue and what it owns.
pub struct Conn {
    id: u64,
    out: mpsc::UnboundedSender<String>,
    streams: Mutex<Vec<String>>,
}

impl Conn {
    #[cfg_attr(not(unix), allow(dead_code))]
    fn send<T: Serialize>(&self, msg: &T) -> bool {
        match serde_json::to_string(msg) {
            Ok(line) => self.out.send(line).is_ok(),
            Err(_) => true,
        }
    }

    pub fn own_stream(&self, id: &str) {
        lock(&self.streams).push(id.to_string());
    }

    pub fn human_connected(&self, state: &AppState, context: &str) {
        lock(&slot(state).humans).entry(self.id).or_default().insert(context.to_string());
    }
}

/// Stream events for one request: `{"sub": <request id>, "event": ...}`.
pub struct RpcSink {
    out: mpsc::UnboundedSender<String>,
    sub: Json,
}

impl RpcSink {
    pub fn new(conn: &Conn, sub: &Json) -> Self {
        Self { out: conn.out.clone(), sub: sub.clone() }
    }
}

impl<T: Serialize + Send + Sync + 'static> Sink<T> for RpcSink {
    fn send(&self, event: T) -> bool {
        match serde_json::to_string(&json!({ "sub": self.sub, "event": event })) {
            Ok(line) => self.out.send(line).is_ok(),
            Err(_) => true,
        }
    }
}

// ───────────────────────── server ─────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketStatus {
    pub path: Option<String>,
    pub listening: bool,
    pub clients: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
struct Listening(Mutex<SocketStatus>);

pub fn status(state: &AppState) -> SocketStatus {
    let mut s = lock(&state.ext::<Listening>().0).clone();
    s.clients = client_count(state);
    s
}

/// Starts the listener (once). Errors are kept for `background_status` and printed.
pub fn start(state: &AppState) {
    #[cfg(unix)]
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            let path = path::socket_path();
            let result = match path.clone() {
                Some(p) => unix::serve(state.clone(), p).await,
                None => Err(BackendError::config("no data directory for the socket")),
            };
            let listening = state.ext::<Listening>();
            let mut st = lock(&listening.0);
            st.path = path.map(|p| p.display().to_string());
            match result {
                Ok(()) => st.listening = true,
                Err(e) => {
                    eprintln!("kns: client socket not started: {}", e.message);
                    st.error = Some(e.message);
                }
            }
        });
    }
    #[cfg(not(unix))]
    {
        lock(&state.ext::<Listening>().0).error = Some("the client socket is not available on this platform yet".into());
    }
}

/// Removes the socket file (app exit).
pub fn cleanup() {
    #[cfg(unix)]
    if let Some(p) = path::socket_path() {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(unix)]
mod unix {
    use std::{os::unix::fs::PermissionsExt, path::PathBuf};

    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::{UnixListener, UnixStream},
    };

    use super::*;

    /// Binds the socket and accepts in the background. Returns once bound.
    pub async fn serve(state: AppState, path: PathBuf) -> Result<()> {
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        // A live socket means another kns answers there; a dead one is left over from a crash.
        if tokio::fs::symlink_metadata(&path).await.is_ok() {
            if UnixStream::connect(&path).await.is_ok() {
                return Err(BackendError::new(0, "AddrInUse", format!("another kns already listens on {}", path.display())));
            }
            tokio::fs::remove_file(&path).await?;
        }
        let listener = UnixListener::bind(&path).map_err(|e| BackendError::config(format!("{}: {e}", path.display())))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let owner = owner_uid(&path);
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { continue };
                // Only the user who owns the socket (the same check sshd's agent socket relies on).
                let peer = stream.peer_cred().ok().map(|c| c.uid());
                if owner.is_none() || peer != owner {
                    continue;
                }
                tauri::async_runtime::spawn(connection(state.clone(), stream));
            }
        });
        Ok(())
    }

    fn owner_uid(path: &std::path::Path) -> Option<u32> {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).ok().map(|m| m.uid())
    }

    async fn connection(state: AppState, stream: UnixStream) {
        let s = slot(&state);
        let id = s.clients.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        lock(&s.humans).insert(id, HashSet::new());
        let (read, mut write) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let conn = Arc::new(Conn { id, out: tx, streams: Mutex::new(vec![]) });

        let writer = tauri::async_runtime::spawn(async move {
            while let Some(mut line) = rx.recv().await {
                line.push('\n');
                if write.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        conn.send(&json!({ "hello": hello() }));
        let mut events = subscribe(&state);
        let ev_conn = conn.clone();
        let forward_events = tauri::async_runtime::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(ev) => {
                        if !ev_conn.send(&json!({ "backend": ev })) {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        let mut lines = BufReader::new(read);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match (&mut lines).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if buf.len() > MAX_LINE {
                conn.send(&json!({ "id": null, "error": BackendError::invalid("request too large") }));
                break;
            }
            let Ok(text) = std::str::from_utf8(&buf) else { continue };
            if text.trim().is_empty() {
                continue;
            }
            let msg: Json = match serde_json::from_str(text) {
                Ok(m) => m,
                Err(e) => {
                    conn.send(&json!({ "id": null, "error": BackendError::invalid(format!("bad JSON: {e}")) }));
                    continue;
                }
            };
            let (state, conn) = (state.clone(), conn.clone());
            tauri::async_runtime::spawn(async move {
                let rid = msg.get("id").cloned().unwrap_or(Json::Null);
                let method = msg.get("method").and_then(Json::as_str).unwrap_or_default().to_string();
                let params = msg.get("params").cloned().unwrap_or(json!({}));
                let reply = match dispatch::call(&state, &conn, &rid, &method, &params).await {
                    Ok(result) => json!({ "id": rid, "result": result }),
                    Err(error) => json!({ "id": rid, "error": error }),
                };
                conn.send(&reply);
            });
        }

        // Connection gone: its streams stop, its contexts no longer count as human-connected.
        forward_events.abort();
        for sid in lock(&conn.streams).drain(..) {
            state.stop_stream(&sid);
        }
        lock(&s.humans).remove(&id);
        drop(conn);
        let _ = writer.await;
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixStream,
    };

    use super::*;

    async fn read_json(lines: &mut tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>) -> Json {
        let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await.unwrap().unwrap().unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[tokio::test]
    async fn hello_call_error_and_human_context() {
        let dir = std::env::temp_dir().join(format!("kns-rpc-{}", std::process::id()));
        let path = dir.join("t.sock");
        let state = AppState::default();
        unix::serve(state.clone(), path.clone()).await.unwrap();
        let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&path).unwrap().permissions());
        assert_eq!(mode & 0o777, 0o600);

        let (r, mut w) = UnixStream::connect(&path).await.unwrap().into_split();
        let mut lines = BufReader::new(r).lines();
        let hello = read_json(&mut lines).await;
        assert_eq!(hello["hello"]["app"], "kns");

        w.write_all(b"{\"id\":1,\"method\":\"redact_preview\",\"params\":{\"text\":\"x\"}}\n").await.unwrap();
        let v = read_json(&mut lines).await;
        assert_eq!(v["id"], 1);
        assert!(v.get("result").is_some(), "{v}");

        w.write_all(b"{\"id\":2,\"method\":\"nope\"}\n").await.unwrap();
        let v = read_json(&mut lines).await;
        assert_eq!(v["error"]["reason"], "UnknownMethod");

        w.write_all(b"{\"id\":3,\"method\":\"scale\",\"params\":{\"objRef\":{\"context\":\"x\"}}}\n").await.unwrap();
        let v = read_json(&mut lines).await;
        assert!(v.get("error").is_some(), "unknown flags deny: {v}");

        // backend events reach the client
        crate::events::emit(&state, BackendEvent::Forwards);
        let v = read_json(&mut lines).await;
        assert!(v.get("backend").is_some(), "{v}");

        assert_eq!(client_count(&state), 1);
        drop(w);
        drop(lines);
        for _ in 0..50 {
            if client_count(&state) == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(client_count(&state), 0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
