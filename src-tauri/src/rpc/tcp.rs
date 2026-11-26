//! The client protocol on loopback TCP, for clients that cannot open the Unix socket: the Herdr
//! app's mods (its script runtime has `net.connect(host, port)`, no Unix sockets), and Windows
//! later. Off unless turned on (`rpc_tcp_set`, `kns-tui tcp on`, `kns-tui herdr install`).
//!
//! - Binds `127.0.0.1` on a free port. Every start makes a new token (32 random bytes).
//! - `rpc-tcp.json` (`path::tcp_info_path`) holds `{port, token, pid, protocol}`, mode 0600, written
//!   atomically: being able to read it is the permission, as the 0600 socket is for the Unix side.
//! - The first line must be `{"auth": "<token>"}` within 5 s (compared in constant time); otherwise
//!   the server answers `{"error": Unauthorized}` and closes. A browser that reaches the port speaks
//!   HTTP, so its first line is never that JSON.
//! - After that it is the socket's protocol (`connection`): hello, calls, streams, backend events,
//!   the same mutation guard.
//! - Turning it off stops the listener, ends every TCP connection and removes the file.
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

use super::path;
use crate::{
    ipc::{BackendError, Json, Result},
    rustfiles,
    state::{AppState, lock},
};

const FILE: &str = "rpc-tcp";
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpStatus {
    pub enabled: bool,
    pub listening: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default)]
struct Slot {
    status: Mutex<TcpStatus>,
    stop: Mutex<Option<CancellationToken>>,
}

fn slot(state: &AppState) -> std::sync::Arc<Slot> {
    state.ext::<Slot>()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Info {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub protocol: u32,
}

/// Called from `setup`: starts the listener when the stored setting says so.
pub fn setup(state: &AppState, app: &tauri::AppHandle) {
    let stored: Option<Config> = rustfiles::dir(app)
        .ok()
        .and_then(|dir| std::fs::read(dir.join(format!("{FILE}.json"))).ok())
        .and_then(|b| serde_json::from_slice(&b).ok());
    if stored.is_some_and(|c| c.enabled) {
        start(state);
    }
}

pub fn status(state: &AppState) -> TcpStatus {
    lock(&slot(state).status).clone()
}

/// Stores the setting and starts or stops the listener.
pub async fn set(state: &AppState, enabled: bool) -> Result<TcpStatus> {
    let app = state.app().ok_or_else(|| BackendError::internal("the app is not running"))?.clone();
    rustfiles::write(&rustfiles::dir(&app)?, FILE, &Config { enabled }).await?;
    if enabled {
        start(state);
        // report the bound port, not "starting"
        for _ in 0..50 {
            let s = status(state);
            if s.listening || s.error.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    } else {
        stop(state);
    }
    Ok(status(state))
}

fn start(state: &AppState) {
    let s = slot(state);
    let mut stop_slot = lock(&s.stop);
    if stop_slot.is_some() {
        return;
    }
    let stop = CancellationToken::new();
    *stop_slot = Some(stop.clone());
    *lock(&s.status) = TcpStatus { enabled: true, ..Default::default() };
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let Some(info) = path::tcp_info_path() else {
            lock(&slot(&state).status).error = Some("no data directory for rpc-tcp.json".into());
            return;
        };
        let token = crate::mcp::auth::new_token();
        let result = serve(state.clone(), &info, token, stop).await;
        let s = slot(&state);
        let mut st = lock(&s.status);
        st.info_file = Some(info.display().to_string());
        match result {
            Ok(port) => {
                st.listening = true;
                st.port = Some(port);
            }
            Err(e) => {
                eprintln!("kns: TCP endpoint not started: {}", e.message);
                st.error = Some(e.message);
                drop(st);
                lock(&s.stop).take();
            }
        }
    });
}

fn stop(state: &AppState) {
    let s = slot(state);
    if let Some(stop) = lock(&s.stop).take() {
        stop.cancel();
    }
    *lock(&s.status) = TcpStatus::default();
    cleanup();
}

/// Removes the info file (app exit, turning TCP off), so no stale token is left lying around.
pub fn cleanup() {
    if let Some(p) = path::tcp_info_path()
        && let Ok(text) = std::fs::read_to_string(&p)
        && serde_json::from_str::<Info>(&text).is_ok_and(|i| i.pid == std::process::id())
    {
        let _ = std::fs::remove_file(p);
    }
}

/// Binds, writes the info file and accepts until `stop`. Returns the port once bound.
pub async fn serve(state: AppState, info_file: &Path, token: String, stop: CancellationToken) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| BackendError::config(format!("127.0.0.1: {e}")))?;
    let port = listener.local_addr()?.port();
    write_info(info_file, &Info { port, token: token.clone(), pid: std::process::id(), protocol: path::PROTOCOL })?;
    let token = std::sync::Arc::new(token);
    tauri::async_runtime::spawn(async move {
        loop {
            let accepted = tokio::select! {
                a = listener.accept() => a,
                _ = stop.cancelled() => break,
            };
            let Ok((stream, peer)) = accepted else { continue };
            if !peer.ip().is_loopback() {
                continue;
            }
            tauri::async_runtime::spawn(client(state.clone(), stream, token.clone(), stop.clone()));
        }
    });
    Ok(port)
}

async fn client(state: AppState, stream: TcpStream, token: std::sync::Arc<String>, stop: CancellationToken) {
    let _ = stream.set_nodelay(true);
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);
    let mut line = Vec::new();
    let first = tokio::time::timeout(AUTH_TIMEOUT, (&mut read).take(4096).read_until(b'\n', &mut line)).await;
    let authorized = matches!(first, Ok(Ok(n)) if n > 0) && authorized(&line, &token);
    if !authorized {
        let answer = serde_json::json!({ "error": BackendError::new(401, "Unauthorized", "the first line must be {\"auth\": \"<token from rpc-tcp.json>\"}") });
        let _ = write.write_all(format!("{answer}\n").as_bytes()).await;
        let _ = write.shutdown().await;
        return;
    }
    super::connection(state, read, write, Some(stop)).await;
}

fn authorized(line: &[u8], token: &str) -> bool {
    let Ok(v) = serde_json::from_slice::<Json>(line) else { return false };
    let Some(given) = v.get("auth").and_then(Json::as_str) else { return false };
    given.len() == token.len() && bool::from(given.as_bytes().ct_eq(token.as_bytes()))
}

/// Writes `info` with mode 0600 to a temporary file next to `path`, then renames it into place.
fn write_info(path: &Path, info: &Info) -> Result<()> {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!(".rpc-tcp.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(info).map_err(|e| BackendError::internal(e.to_string()))?;
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        std::io::Write::write_all(&mut f, text.as_bytes())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::*;

    async fn line(r: &mut tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>) -> Json {
        let l = tokio::time::timeout(Duration::from_secs(5), r.next_line()).await.unwrap().unwrap().unwrap_or_default();
        serde_json::from_str(&l).unwrap_or(Json::Null)
    }

    #[tokio::test]
    async fn token_first_then_the_socket_protocol_and_stop_ends_it() {
        let dir = std::env::temp_dir().join(format!("kns-tcp-{}", std::process::id()));
        let info_path = dir.join("rpc-tcp.json");
        let state = AppState::default();
        let stop = CancellationToken::new();
        let port = serve(state.clone(), &info_path, "secret-token".into(), stop.clone()).await.unwrap();
        let info: Info = serde_json::from_str(&std::fs::read_to_string(&info_path).unwrap()).unwrap();
        assert_eq!((info.port, info.token.as_str()), (port, "secret-token"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&info_path).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // a wrong token (or an HTTP request) gets Unauthorized and a closed connection
        for first in ["{\"auth\":\"nope\"}\n", "GET / HTTP/1.1\r\n"] {
            let (r, mut w) = TcpStream::connect(("127.0.0.1", port)).await.unwrap().into_split();
            let mut r = BufReader::new(r).lines();
            w.write_all(first.as_bytes()).await.unwrap();
            assert_eq!(line(&mut r).await["error"]["reason"], "Unauthorized");
            assert_eq!(line(&mut r).await, Json::Null, "closed after refusing");
        }

        // the right token: hello, then calls
        let (r, mut w) = TcpStream::connect(("127.0.0.1", port)).await.unwrap().into_split();
        let mut r = BufReader::new(r).lines();
        w.write_all(b"{\"auth\":\"secret-token\"}\n").await.unwrap();
        assert_eq!(line(&mut r).await["hello"]["app"], "kns");
        w.write_all(b"{\"id\":7,\"method\":\"redact_preview\",\"params\":{\"text\":\"x\"}}\n").await.unwrap();
        let v = line(&mut r).await;
        assert_eq!(v["id"], 7);
        assert!(v.get("result").is_some(), "{v}");
        // the mutation guard applies here too
        w.write_all(b"{\"id\":8,\"method\":\"scale\",\"params\":{\"objRef\":{\"context\":\"x\"}}}\n").await.unwrap();
        assert!(line(&mut r).await.get("error").is_some());

        // turning TCP off ends live connections and refuses new ones
        stop.cancel();
        assert_eq!(line(&mut r).await, Json::Null);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
