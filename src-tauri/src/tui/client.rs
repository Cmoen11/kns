//! The socket client: one connection, a reader thread, and every reply, stream event and backend
//! event delivered as a `Msg` on one channel (the UI loop), or awaited directly (`call`).
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Sender},
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::path;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: u64,
    pub reason: String,
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl RpcError {
    fn local(reason: &str, message: impl Into<String>) -> Self {
        Self { code: 0, reason: reason.into(), message: message.into() }
    }
    fn from_value(v: &Value) -> Self {
        Self {
            code: v["code"].as_u64().unwrap_or(0),
            reason: v["reason"].as_str().unwrap_or("Error").to_string(),
            message: v["message"].as_str().unwrap_or("error").to_string(),
        }
    }
}

pub type Reply = Result<Value, RpcError>;

/// What the reader thread hands to the UI.
#[derive(Debug)]
pub enum Msg {
    /// a reply to `send(tag, ...)`
    Reply { tag: Tag, result: Reply },
    /// an event of a stream started with `send(tag, ...)`
    Stream { tag: Tag, event: Value },
    /// a `BackendEvent`
    Backend(Value),
    /// the connection is gone (kns quit)
    Closed,
    /// a key, mouse or resize event (from the input thread)
    Input(ratatui::crossterm::event::Event),
}

/// Which request a reply or stream event belongs to: a kind chosen by the caller plus a
/// generation, so a late reply for a view the user already left can be dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    pub kind: &'static str,
    pub epoch: u64,
}

enum Waiter {
    Tagged(Tag),
    Sync(Sender<Reply>),
}

struct Shared {
    waiting: Mutex<HashMap<u64, Waiter>>,
    streams: Mutex<HashMap<u64, Tag>>,
}

#[derive(Clone)]
pub struct Client {
    write: Arc<Mutex<UnixStream>>,
    next: Arc<AtomicU64>,
    shared: Arc<Shared>,
    pub hello: Value,
}

impl Client {
    /// Connects to the running kns; starts `kns --background` when none answers and `autostart`.
    pub fn connect(tx: Sender<Msg>, autostart: bool) -> Result<Self, RpcError> {
        let sock = path::socket_path().ok_or_else(|| RpcError::local("Config", "no data directory for the kns socket"))?;
        let stream = match UnixStream::connect(&sock) {
            Ok(s) => s,
            Err(_) if autostart => start_and_wait(&sock)?,
            Err(e) => return Err(RpcError::local("NotRunning", format!("kns is not running ({}: {e})", sock.display()))),
        };
        Self::over(stream, tx)
    }

    fn over(stream: UnixStream, tx: Sender<Msg>) -> Result<Self, RpcError> {
        let read = stream.try_clone().map_err(|e| RpcError::local("Io", e.to_string()))?;
        let mut reader = BufReader::new(read);
        let mut first = String::new();
        reader.read_line(&mut first).map_err(|e| RpcError::local("Io", e.to_string()))?;
        let hello: Value = serde_json::from_str(&first).unwrap_or(Value::Null);
        let hello = hello.get("hello").cloned().ok_or_else(|| RpcError::local("Protocol", "kns did not greet; is it an older version?"))?;
        let shared = Arc::new(Shared { waiting: Mutex::new(HashMap::new()), streams: Mutex::new(HashMap::new()) });
        let rs = shared.clone();
        std::thread::spawn(move || read_loop(reader, rs, tx));
        Ok(Self { write: Arc::new(Mutex::new(stream)), next: Arc::new(AtomicU64::new(1)), shared, hello })
    }

    fn write(&self, id: u64, method: &str, params: Value) -> Result<(), RpcError> {
        let mut line = serde_json::to_string(&json!({ "id": id, "method": method, "params": params })).unwrap_or_default();
        line.push('\n');
        let mut w = self.write.lock().unwrap_or_else(|e| e.into_inner());
        w.write_all(line.as_bytes()).map_err(|e| RpcError::local("Closed", format!("kns went away: {e}")))
    }

    /// Fire a request; the reply (and stream events, if it starts one) arrive as `Msg`s with `tag`.
    pub fn send(&self, tag: Tag, method: &str, params: Value) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        lock(&self.shared.waiting).insert(id, Waiter::Tagged(tag.clone()));
        lock(&self.shared.streams).insert(id, tag);
        if self.write(id, method, params).is_err() {
            lock(&self.shared.waiting).remove(&id);
        }
    }

    /// Blocking call (CLI commands, exec mode).
    pub fn call(&self, method: &str, params: Value) -> Reply {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        lock(&self.shared.waiting).insert(id, Waiter::Sync(tx));
        self.write(id, method, params)?;
        rx.recv().unwrap_or_else(|_| Err(RpcError::local("Closed", "kns went away")))
    }

    /// Like `call`, for a stream: events go to `tag` on the UI channel.
    pub fn call_stream(&self, tag: Tag, method: &str, params: Value) -> Reply {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        lock(&self.shared.waiting).insert(id, Waiter::Sync(tx));
        lock(&self.shared.streams).insert(id, tag);
        self.write(id, method, params)?;
        rx.recv().unwrap_or_else(|_| Err(RpcError::local("Closed", "kns went away")))
    }

    pub fn stop(&self, stream_id: &str) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let _ = self.write(id, "stop_stream", json!({ "id": stream_id }));
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn read_loop(mut reader: BufReader<UnixStream>, shared: Arc<Shared>, tx: Sender<Msg>) {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(ev) = v.get("backend") {
            let _ = tx.send(Msg::Backend(ev.clone()));
        } else if let Some(sub) = v.get("sub").and_then(Value::as_u64) {
            let tag = lock(&shared.streams).get(&sub).cloned();
            if let Some(tag) = tag {
                let _ = tx.send(Msg::Stream { tag, event: v["event"].clone() });
            }
        } else if let Some(id) = v.get("id").and_then(Value::as_u64) {
            let result = match v.get("error") {
                Some(e) if !e.is_null() => Err(RpcError::from_value(e)),
                _ => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
            };
            // a failed or non-stream reply frees its stream slot
            if result.is_err() || !result.as_ref().is_ok_and(Value::is_string) {
                lock(&shared.streams).remove(&id);
            }
            match lock(&shared.waiting).remove(&id) {
                Some(Waiter::Tagged(tag)) => {
                    let _ = tx.send(Msg::Reply { tag, result });
                }
                Some(Waiter::Sync(s)) => {
                    let _ = s.send(result);
                }
                None => {}
            }
        }
    }
    for (_, w) in lock(&shared.waiting).drain() {
        if let Waiter::Sync(s) = w {
            let _ = s.send(Err(RpcError::local("Closed", "kns went away")));
        }
    }
    let _ = tx.send(Msg::Closed);
}

// ───────────────────────── starting kns ─────────────────────────

/// The `kns` app binary: `KNS_APP`, next to this binary (bundled), or the installed app.
pub fn app_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("KNS_APP").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let exe = std::env::current_exe().ok().and_then(|e| e.canonicalize().ok());
    if let Some(dir) = exe.as_deref().and_then(Path::parent) {
        let sib = dir.join(if cfg!(windows) { "kns.exe" } else { "kns" });
        if sib.is_file() {
            return Some(sib);
        }
    }
    let installed = [
        PathBuf::from("/Applications/kns.app/Contents/MacOS/kns"),
        dirs::home_dir().map(|h| h.join("Applications/kns.app/Contents/MacOS/kns")).unwrap_or_default(),
    ];
    installed.into_iter().find(|p| p.is_file())
}

/// Starts `kns --background` detached from this terminal.
pub fn start_background() -> Result<(), RpcError> {
    let bin = app_binary().ok_or_else(|| RpcError::local("NotInstalled", "kns not found: install kns.app or set KNS_APP"))?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--background").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // own process group: closing the herdr pane must not take kns down with it
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ()).map_err(|e| RpcError::local("Spawn", format!("{}: {e}", bin.display())))
}

fn start_and_wait(sock: &Path) -> Result<UnixStream, RpcError> {
    start_background()?;
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        if let Ok(s) = UnixStream::connect(sock) {
            return Ok(s);
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(RpcError::local("NotRunning", format!("started kns, but {} never answered", sock.display())))
}
