//! `*.localhost` name proxy for forwards (§3 B2). Off by default; `rust/proxy.json`. Owner: B2.
//!
//! An HTTP/1.1 reverse proxy on `127.0.0.1:<port>` (default 7080). `Host: <name>.<ns>.localhost[:port]`
//! routes to the running forward whose name is `<name>` in namespace `<ns>`; the name is the
//! forward's label (as a DNS label: lowercase, other characters `-`), else its target's name. The
//! oldest forward wins a name taken twice. Anything else (another host, a port other than the
//! proxy's, an unknown name) gets 421, so a DNS-rebinding page (its own host name) reaches nothing.
//!
//! **Cross-site guard**: 403 for a request with `Sec-Fetch-Site: cross-site`, or with an `Origin`
//! that is not exactly `http://<the Host it sent>`, for every method. No CORS headers are added and
//! redirects are passed through, never followed.
//!
//! One request per client connection: the proxy checks the request head, forces
//! `Connection: close`, sends the head and exactly `Content-Length` body bytes to the forward's own
//! recorded `address:localPort` and then reads nothing more from the client, so a second request on
//! the same connection never reaches the forward unchecked (even if the upstream ignores
//! `Connection: close`). Chunked request bodies are refused (411). A WebSocket upgrade keeps
//! `Connection: Upgrade` and is spliced both ways. The upstream never comes from the Host text.
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU16, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional},
    net::{TcpListener, TcpStream},
    task::JoinSet,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::{
    events, forward,
    ipc::{BackendError, BackendEvent, Forward, NameProxyStatus, ProxyName, Result},
    rustfiles,
    state::{AppState, lock},
};

pub const DEFAULT_PORT: u16 = 7080;
const FILE: &str = "proxy";
/// The request head must arrive within this, and fit in `MAX_HEAD`.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEAD: usize = 64 * 1024;
/// A forward holds a client up to 10 s while no pod is ready; connecting to it is local.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

// ───────────────────────── names and routing (pure) ─────────────────────────

/// `s` as one DNS label: lowercase ASCII letters and digits, anything else `-` (runs collapsed,
/// none at the ends), at most 63 characters. `None` when nothing is left.
pub fn dns_label(s: &str) -> Option<String> {
    let mut out = String::new();
    for c in s.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(63).collect();
    let out = out.trim_end_matches('-').to_string();
    (!out.is_empty()).then_some(out)
}

/// The proxy name of a forward: its label, else its target's name.
pub fn name_of(f: &Forward) -> Option<String> {
    f.label.as_deref().and_then(dns_label).or_else(|| dns_label(f.target.name()))
}

/// `<name>.<namespace>.localhost` of a forward.
pub fn host_of(f: &Forward) -> Option<String> {
    Some(format!("{}.{}.localhost", name_of(f)?, dns_label(&f.namespace)?))
}

/// Every routed name, oldest forward first (a name taken twice goes to the oldest).
pub fn names(forwards: &[Forward]) -> Vec<ProxyName> {
    let mut sorted: Vec<&Forward> = forwards.iter().collect();
    sorted.sort_by(|a, b| (a.started_at, a.id.len(), &a.id).cmp(&(b.started_at, b.id.len(), &b.id)));
    let mut out: Vec<ProxyName> = Vec::new();
    for f in sorted {
        if let Some(host) = host_of(f)
            && !out.iter().any(|n| n.host == host)
        {
            out.push(ProxyName { host, forward: f.id.clone() });
        }
    }
    out
}

/// The host of a `Host` header if the proxy routes it: `<label>.<label>.localhost`, with no port or
/// exactly the proxy's port. Lowercased, without the port.
pub fn parse_host(header: &str, port: u16) -> Option<String> {
    let h = header.trim().to_ascii_lowercase();
    let (host, p) = match h.rsplit_once(':') {
        Some((host, p)) => (host, Some(p)),
        None => (h.as_str(), None),
    };
    if let Some(p) = p
        && p.parse::<u16>().ok() != Some(port)
    {
        return None;
    }
    let host = host.strip_suffix('.').unwrap_or(host);
    let rest = host.strip_suffix(".localhost")?;
    let (name, ns) = rest.split_once('.')?;
    let ok = |l: &str| dns_label(l).as_deref() == Some(l);
    (ok(name) && ok(ns)).then(|| host.to_string())
}

/// The forward a `Host` header routes to.
pub fn route<'a>(header: &str, port: u16, forwards: &'a [Forward]) -> Option<&'a Forward> {
    let host = parse_host(header, port)?;
    let id = names(forwards).into_iter().find(|n| n.host == host)?.forward;
    forwards.iter().find(|f| f.id == id)
}

/// The cross-site guard: `Err(why)` for `Sec-Fetch-Site: cross-site`, or an `Origin` that is not
/// exactly `http://<host header>` (also `Origin: null`).
pub fn guard(headers: &[(String, String)], host_header: &str) -> std::result::Result<(), &'static str> {
    let same = format!("http://{}", host_header.trim().to_ascii_lowercase());
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("sec-fetch-site") && v.trim().eq_ignore_ascii_case("cross-site") {
            return Err("cross-site request refused");
        }
        if k.eq_ignore_ascii_case("origin") && v.trim().to_ascii_lowercase() != same {
            return Err("request from another origin refused");
        }
    }
    Ok(())
}

// ───────────────────────── request head (pure) ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub request_line: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    fn values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.headers.iter().filter(move |(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Parses a request head (without the final blank line). Refuses what a proxy should not guess
/// about: no HTTP/1.x request line, folded or nameless header lines, not exactly one `Host`, and
/// both `Transfer-Encoding` and `Content-Length`.
pub fn parse_head(text: &str) -> std::result::Result<Head, &'static str> {
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_string();
    let parts: Vec<&str> = request_line.split(' ').collect();
    if parts.len() != 3 || parts[0].is_empty() || !parts[0].bytes().all(|b| b.is_ascii_uppercase()) || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
        return Err("not an HTTP/1.x request");
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.starts_with([' ', '\t']) {
            return Err("folded header line");
        }
        let (k, v) = line.split_once(':').ok_or("header line without a name")?;
        if k.is_empty() || !k.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)) {
            return Err("bad header name");
        }
        headers.push((k.to_string(), v.trim().to_string()));
    }
    let head = Head { request_line, headers };
    if head.values("host").count() != 1 {
        return Err("exactly one Host header is needed");
    }
    if head.values("transfer-encoding").next().is_some() && head.values("content-length").next().is_some() {
        return Err("both Transfer-Encoding and Content-Length");
    }
    Ok(head)
}

/// The head sent upstream: hop-by-hop connection headers replaced by `Connection: close`, or
/// `Connection: Upgrade` for an upgrade (WebSocket) request.
pub fn upstream_head(head: &Head) -> String {
    let upgrade = is_upgrade(head);
    let mut out = format!("{}\r\n", head.request_line);
    for (k, v) in &head.headers {
        if ["connection", "keep-alive", "proxy-connection"].iter().any(|h| k.eq_ignore_ascii_case(h)) {
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str(if upgrade { "Connection: Upgrade\r\n\r\n" } else { "Connection: close\r\n\r\n" });
    out
}

/// An upgrade (WebSocket) request: `Upgrade` and `Connection: upgrade`.
pub fn is_upgrade(head: &Head) -> bool {
    head.values("upgrade").next().is_some() && head.values("connection").any(|v| v.to_ascii_lowercase().contains("upgrade"))
}

/// The request body length: `Content-Length` (0 without one). `Err` for a chunked body, a bad or
/// repeated length.
pub fn body_length(head: &Head) -> std::result::Result<u64, (u16, &'static str)> {
    if head.values("transfer-encoding").next().is_some() {
        return Err((411, "chunked request bodies are not supported; send Content-Length"));
    }
    let lengths: Vec<&str> = head.values("content-length").collect();
    match lengths.as_slice() {
        [] => Ok(0),
        [one] => one.trim().parse::<u64>().map_err(|_| (400, "bad Content-Length")),
        _ => Err((400, "more than one Content-Length")),
    }
}

/// A plain-text error response; no CORS headers.
pub fn response(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

// ───────────────────────── serving ─────────────────────────

/// The running forwards, read per request.
pub type Forwards = Arc<dyn Fn() -> Vec<Forward> + Send + Sync>;

/// Accepts until cancelled; each connection carries one checked request.
pub async fn serve(listener: TcpListener, port: u16, forwards: Forwards, cancel: CancellationToken) {
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((tcp, _)) => {
                    let _ = tcp.set_nodelay(true);
                    conns.spawn(connection(tcp, port, forwards.clone()));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
        }
    }
    drop(listener);
    conns.shutdown().await;
}

/// Reads up to the end of the request head; returns the head text and the bytes after it.
async fn read_head(tcp: &mut TcpStream) -> std::result::Result<(String, Vec<u8>), u16> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(end + 4);
            buf.truncate(end);
            return String::from_utf8(buf).map(|h| (h, rest)).map_err(|_| 400);
        }
        if buf.len() > MAX_HEAD {
            return Err(431);
        }
        match tcp.read(&mut chunk).await {
            Ok(0) | Err(_) => return Err(0),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

async fn reply(tcp: &mut TcpStream, status: u16, reason: &str, body: &str) {
    let _ = tcp.write_all(response(status, reason, body).as_bytes()).await;
    let _ = tcp.shutdown().await;
}

async fn connection(mut tcp: TcpStream, port: u16, forwards: Forwards) {
    let (text, rest) = match timeout(HEAD_TIMEOUT, read_head(&mut tcp)).await {
        Ok(Ok(h)) => h,
        Ok(Err(431)) => return reply(&mut tcp, 431, "Request Header Fields Too Large", "request head too large\n").await,
        Ok(Err(400)) => return reply(&mut tcp, 400, "Bad Request", "bad request\n").await,
        _ => return,
    };
    let head = match parse_head(&text) {
        Ok(h) => h,
        Err(why) => return reply(&mut tcp, 400, "Bad Request", &format!("{why}\n")).await,
    };
    let host = head.values("host").next().unwrap_or_default().to_string();
    if let Err(why) = guard(&head.headers, &host) {
        return reply(&mut tcp, 403, "Forbidden", &format!("{why}\n")).await;
    }
    let upgrade = is_upgrade(&head);
    let length = match body_length(&head) {
        Ok(n) => n,
        Err((411, why)) => return reply(&mut tcp, 411, "Length Required", &format!("{why}\n")).await,
        Err((_, why)) => return reply(&mut tcp, 400, "Bad Request", &format!("{why}\n")).await,
    };
    let list = forwards();
    // never say which names exist: a rebinding page would read the body
    let Some(f) = route(&host, port, &list) else {
        return reply(&mut tcp, 421, "Misdirected Request", "kns: no forward has this name\n").await;
    };
    let Ok(ip) = f.address.parse::<IpAddr>() else { return reply(&mut tcp, 502, "Bad Gateway", "kns: the forward has no address\n").await };
    let upstream = timeout(CONNECT_TIMEOUT, TcpStream::connect(SocketAddr::new(ip, f.local_port))).await;
    let Ok(Ok(mut up)) = upstream else { return reply(&mut tcp, 502, "Bad Gateway", "kns: the forward did not accept the connection\n").await };
    let _ = up.set_nodelay(true);
    // an upgrade becomes a byte stream both ways; a plain request sends its body and nothing after it
    let first = if upgrade { rest.len() } else { rest.len().min(usize::try_from(length).unwrap_or(usize::MAX)) };
    if up.write_all(upstream_head(&head).as_bytes()).await.is_err() || up.write_all(&rest[..first]).await.is_err() {
        return reply(&mut tcp, 502, "Bad Gateway", "kns: the forward closed the connection\n").await;
    }
    if upgrade {
        let _ = copy_bidirectional(&mut tcp, &mut up).await;
        return;
    }
    let remaining = length - first as u64;
    let (mut cr, mut cw) = tcp.split();
    let (mut ur, mut uw) = up.split();
    let to_up = async { tokio::io::copy(&mut (&mut cr).take(remaining), &mut uw).await };
    let to_client = async {
        let r = tokio::io::copy(&mut ur, &mut cw).await;
        let _ = cw.shutdown().await;
        r
    };
    let _ = tokio::join!(to_up, to_client);
}

// ───────────────────────── state, file, commands ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct ProxyFile {
    on: bool,
    port: u16,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    port: u16,
    running: Option<CancellationToken>,
    error: Option<String>,
}

#[derive(Default)]
struct Proxy {
    inner: tokio::sync::Mutex<Inner>,
    /// the port while running, 0 when off: for synchronous readers (`url_for`)
    live: AtomicU16,
    /// tests: the directory instead of the app's `rust/`
    dir: Mutex<Option<PathBuf>>,
}

fn dir(state: &AppState) -> Result<PathBuf> {
    if let Some(d) = lock(&state.ext::<Proxy>().dir).clone() {
        return Ok(d);
    }
    rustfiles::dir(state.app().ok_or_else(|| BackendError::internal("the name proxy needs the app"))?)
}

fn start(state: &AppState, proxy: &Proxy, inner: &mut Inner, port: u16) -> Result<()> {
    let listener = forward::choose_listener(IpAddr::V4(Ipv4Addr::LOCALHOST), Some(port), true)
        .map_err(|e| BackendError::new(0, "AddrInUse", format!("the name proxy could not listen on 127.0.0.1:{port}: {}", e.message)))?;
    let listener = TcpListener::from_std(listener)?;
    let cancel = CancellationToken::new();
    let st = state.clone();
    tokio::spawn(serve(listener, port, Arc::new(move || forward::snapshots(&st)), cancel.clone()));
    inner.running = Some(cancel);
    inner.port = port;
    inner.error = None;
    proxy.live.store(port, Ordering::SeqCst);
    Ok(())
}

fn stop(proxy: &Proxy, inner: &mut Inner) {
    if let Some(c) = inner.running.take() {
        c.cancel();
    }
    proxy.live.store(0, Ordering::SeqCst);
}

/// Reads `rust/proxy.json` once and starts the proxy when it was left on.
async fn ensure_loaded(state: &AppState, proxy: &Proxy, inner: &mut Inner) {
    if inner.loaded {
        return;
    }
    inner.loaded = true;
    inner.port = DEFAULT_PORT;
    let file = match dir(state) {
        Ok(d) => rustfiles::read::<ProxyFile>(&d, FILE).await.ok().flatten(),
        Err(_) => None,
    };
    if let Some(f) = file {
        inner.port = if f.port >= 1024 { f.port } else { DEFAULT_PORT };
        if f.on
            && let Err(e) = start(state, proxy, inner, inner.port)
        {
            inner.error = Some(e.message);
        }
    }
}

fn status_of(state: &AppState, inner: &Inner) -> NameProxyStatus {
    let on = inner.running.is_some();
    NameProxyStatus { on, port: inner.port, names: if on { names(&forward::snapshots(state)) } else { Vec::new() }, error: inner.error.clone() }
}

/// On/off, port, routed names (the first call loads `rust/proxy.json` and starts it if left on).
pub async fn status(state: &AppState) -> Result<NameProxyStatus> {
    let proxy = state.ext::<Proxy>();
    let mut inner = proxy.inner.lock().await;
    ensure_loaded(state, &proxy, &mut inner).await;
    Ok(status_of(state, &inner))
}

/// Turns the proxy on (on `port`, default the last one) or off, and remembers it.
pub async fn set(state: &AppState, on: bool, port: Option<u16>) -> Result<NameProxyStatus> {
    let proxy = state.ext::<Proxy>();
    let mut inner = proxy.inner.lock().await;
    ensure_loaded(state, &proxy, &mut inner).await;
    let port = port.unwrap_or(inner.port);
    if port < 1024 {
        return Err(BackendError::invalid(format!("the name proxy port is 1024-65535, not {port}")));
    }
    let restart = inner.running.is_some() && inner.port != port;
    if !on {
        stop(&proxy, &mut inner);
    } else if restart || inner.running.is_none() {
        // bind the new port first: when it is taken, the old listener keeps serving
        let old = inner.running.take();
        let old_port = inner.port;
        if let Err(e) = start(state, &proxy, &mut inner, port) {
            if old.is_some() {
                inner.running = old;
                proxy.live.store(old_port, Ordering::SeqCst);
            }
            return Err(e);
        }
        if let Some(c) = old {
            c.cancel();
        }
    }
    inner.port = port;
    inner.error = None;
    rustfiles::write(&dir(state)?, FILE, &ProxyFile { on, port }).await?;
    events::emit(state, BackendEvent::Forwards);
    Ok(status_of(state, &inner))
}

/// `http://<name>.<ns>.localhost:<port>/` of a forward while the proxy runs and routes it there.
pub fn url_for(state: &AppState, f: &Forward) -> Option<String> {
    let port = state.ext::<Proxy>().live.load(Ordering::SeqCst);
    if port == 0 {
        return None;
    }
    let host = host_of(f)?;
    names(&forward::snapshots(state)).into_iter().any(|n| n.host == host && n.forward == f.id).then(|| format!("http://{host}:{port}/"))
}

pub mod cmd {
    use crate::{
        ipc::{NameProxyStatus, Result},
        state::AppState,
    };

    #[tauri::command]
    pub async fn name_proxy_status(state: tauri::State<'_, AppState>) -> Result<NameProxyStatus> {
        super::status(&state).await
    }

    #[tauri::command]
    pub async fn name_proxy_set(state: tauri::State<'_, AppState>, on: bool, port: Option<u16>) -> Result<NameProxyStatus> {
        super::set(&state, on, port).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{ForwardOwner, ForwardStatus, ForwardTarget, PortRef};

    fn fwd(id: &str, ns: &str, name: &str, label: Option<&str>, port: u16, started: i64) -> Forward {
        Forward {
            id: id.into(),
            context: "default".into(),
            target: ForwardTarget::Service { namespace: ns.into(), name: name.into() },
            pod: format!("{name}-0"),
            namespace: ns.into(),
            resolved_pod: None,
            remote_port: PortRef::Number(80),
            resolved_port: Some(80),
            local_port: port,
            address: "127.0.0.1".into(),
            connections: 0,
            status: ForwardStatus::Active,
            message: None,
            label: label.map(Into::into),
            dev_set: None,
            owner: ForwardOwner::User,
            requested_by: None,
            started_at: started,
            idle_stop_at: None,
        }
    }

    #[test]
    fn labels_become_dns_labels() {
        assert_eq!(dns_label("Kafka UI").as_deref(), Some("kafka-ui"));
        assert_eq!(dns_label("a.b_c--d").as_deref(), Some("a-b-c-d"));
        assert_eq!(dns_label("--"), None);
        assert_eq!(dns_label(&"x".repeat(80)).map(|s| s.len()), Some(63));
        let f = fwd("f1", "kafka", "kafka-ui", Some("Kafka UI"), 1, 1);
        assert_eq!(host_of(&f).as_deref(), Some("kafka-ui.kafka.localhost"));
        assert_eq!(host_of(&fwd("f2", "kafka", "kafka-ui", None, 1, 1)).as_deref(), Some("kafka-ui.kafka.localhost"));
    }

    #[test]
    fn names_go_to_the_oldest_forward() {
        let list = vec![fwd("f2", "kns-spike", "web", None, 2, 20), fwd("f1", "kns-spike", "web", None, 1, 10), fwd("f3", "kns-spike", "db", Some("pg"), 3, 30)];
        let n = names(&list);
        assert_eq!(n.len(), 2);
        assert_eq!((n[0].host.as_str(), n[0].forward.as_str()), ("web.kns-spike.localhost", "f1"));
        assert_eq!(n[1].host, "pg.kns-spike.localhost");
    }

    #[test]
    fn host_routing() {
        let list = vec![fwd("f1", "kns-spike", "web", None, 1, 1)];
        assert_eq!(route("web.kns-spike.localhost:7080", 7080, &list).map(|f| f.id.as_str()), Some("f1"));
        assert_eq!(route("WEB.kns-spike.localhost", 7080, &list).map(|f| f.id.as_str()), Some("f1"), "no port, any case");
        assert_eq!(route("web.kns-spike.localhost.:7080", 7080, &list).map(|f| f.id.as_str()), Some("f1"), "trailing dot");
        assert!(route("web.kns-spike.localhost:7081", 7080, &list).is_none(), "another port");
        assert!(route("api.kns-spike.localhost:7080", 7080, &list).is_none(), "unknown name");
        assert!(route("evil.example:7080", 7080, &list).is_none(), "rebinding host");
        assert!(route("localhost:7080", 7080, &list).is_none());
        assert!(route("x.web.kns-spike.localhost:7080", 7080, &list).is_none(), "three labels");
        assert!(route("web.kns-spike.localhost.evil.example", 7080, &list).is_none());
        assert!(route("127.0.0.1:7080", 7080, &list).is_none());
    }

    #[test]
    fn cross_site_guard() {
        let h = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let host = "web.kns-spike.localhost:7080";
        assert!(guard(&h(&[]), host).is_ok(), "no Origin (navigation, curl)");
        assert!(guard(&h(&[("Origin", "http://web.kns-spike.localhost:7080"), ("Sec-Fetch-Site", "same-origin")]), host).is_ok());
        assert!(guard(&h(&[("Sec-Fetch-Site", "none")]), host).is_ok(), "typed into the address bar");
        assert!(guard(&h(&[("sec-fetch-site", "Cross-Site")]), host).is_err());
        assert!(guard(&h(&[("Origin", "http://evil.example")]), host).is_err());
        assert!(guard(&h(&[("Origin", "null")]), host).is_err());
        assert!(guard(&h(&[("Origin", "http://api.kns-spike.localhost:7080")]), host).is_err(), "another local name");
        assert!(guard(&h(&[("Origin", "https://web.kns-spike.localhost:7080")]), host).is_err(), "another scheme");
        // the shape of a no-cors form POST from another site
        assert!(guard(&h(&[("Origin", "http://evil.example"), ("Sec-Fetch-Mode", "no-cors"), ("Content-Type", "text/plain")]), host).is_err());
    }

    #[test]
    fn heads() {
        let head = parse_head("GET / HTTP/1.1\r\nHost: web.kns-spike.localhost:7080\r\nConnection: keep-alive\r\nKeep-Alive: 5\r\nAccept: */*").unwrap();
        let up = upstream_head(&head);
        assert_eq!(up, "GET / HTTP/1.1\r\nHost: web.kns-spike.localhost:7080\r\nAccept: */*\r\nConnection: close\r\n\r\n");
        let ws = parse_head("GET /ws HTTP/1.1\r\nHost: a.b.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket").unwrap();
        assert!(upstream_head(&ws).ends_with("Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
        assert!(parse_head("GET / HTTP/1.1").is_err(), "no Host");
        assert!(parse_head("GET / HTTP/1.1\r\nHost: a\r\nHost: b").is_err(), "two Hosts");
        assert!(parse_head("GET / HTTP/2\r\nHost: a").is_err());
        assert!(parse_head("GET / HTTP/1.1\r\nHost: a\r\n folded").is_err());
        assert!(parse_head("POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nContent-Length: 3").is_err());
        assert!(parse_head("get / HTTP/1.1\r\nHost: a").is_err());
        let len = |h: &str| body_length(&parse_head(h).unwrap());
        assert_eq!(len("POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 12"), Ok(12));
        assert_eq!(len("GET / HTTP/1.1\r\nHost: a"), Ok(0));
        assert_eq!(len("POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked").unwrap_err().0, 411);
        assert_eq!(len("POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\nContent-Length: 2").unwrap_err().0, 400);
        assert_eq!(len("POST / HTTP/1.1\r\nHost: a\r\nContent-Length: x").unwrap_err().0, 400);
    }

    /// An upstream that keeps the connection open (ignores `Connection: close`) and answers every
    /// request head it reads; reports each head.
    async fn keep_alive_upstream() -> (u16, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while let Ok(n) = s.read(&mut chunk).await {
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        while let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head: Vec<u8> = buf.drain(..end + 4).collect();
                            let _ = tx.send(String::from_utf8_lossy(&head).into_owned());
                            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok").await;
                        }
                    }
                });
            }
        });
        (port, rx)
    }

    #[tokio::test]
    async fn a_second_request_on_one_connection_never_reaches_the_forward() {
        let (up, mut seen) = keep_alive_upstream().await;
        let list = vec![fwd("f1", "kns-spike", "web", None, up, 1)];
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let cancel = CancellationToken::new();
        tokio::spawn(serve(l, port, Arc::new(move || list.clone()), cancel.clone()));
        let host = format!("web.kns-spike.localhost:{port}");
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(format!("POST /a HTTP/1.1\r\nHost: {host}\r\nContent-Length: 2\r\n\r\nhi").as_bytes()).await.unwrap();
        let mut got = [0u8; 256];
        let n = timeout(Duration::from_secs(5), s.read(&mut got)).await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&got[..n]).starts_with("HTTP/1.1 200"));
        assert!(seen.recv().await.unwrap().starts_with("POST /a"));
        // the same socket, a request the guard would refuse
        let _ = s.write_all(format!("POST /b HTTP/1.1\r\nHost: {host}\r\nOrigin: http://evil.example\r\nContent-Length: 0\r\n\r\n").as_bytes()).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(seen.try_recv().is_err(), "the second request was not forwarded");
        cancel.cancel();
    }

    /// An upstream that records the request head it got and answers 200.
    async fn upstream() -> (u16, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let tx = tx.clone();
                tokio::spawn(async move {
                    if let Ok((head, _)) = read_head(&mut s).await {
                        let _ = tx.send(head);
                        let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").await;
                    }
                });
            }
        });
        (port, rx)
    }

    async fn send(port: u16, req: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = timeout(Duration::from_secs(5), s.read_to_string(&mut out)).await;
        out
    }

    #[tokio::test]
    async fn proxies_and_refuses_over_sockets() {
        let (up, mut seen) = upstream().await;
        let list = vec![fwd("f1", "kns-spike", "web", None, up, 1)];
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let cancel = CancellationToken::new();
        tokio::spawn(serve(l, port, Arc::new(move || list.clone()), cancel.clone()));
        let host = format!("web.kns-spike.localhost:{port}");

        let ok = send(port, &format!("GET /x HTTP/1.1\r\nHost: {host}\r\nConnection: keep-alive\r\n\r\n")).await;
        assert!(ok.starts_with("HTTP/1.1 200") && ok.ends_with("ok"), "{ok}");
        let head = seen.recv().await.unwrap();
        assert!(head.contains("Connection: close") && !head.contains("keep-alive"), "{head}");

        let same = send(port, &format!("POST /api HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nContent-Length: 2\r\n\r\n{{}}")).await;
        assert!(same.starts_with("HTTP/1.1 200"), "same origin: {same}");
        seen.recv().await.unwrap();

        let unknown = send(port, &format!("GET / HTTP/1.1\r\nHost: api.kns-spike.localhost:{port}\r\n\r\n")).await;
        assert!(unknown.starts_with("HTTP/1.1 421") && !unknown.contains("web"), "{unknown}");
        let rebinding = send(port, &format!("GET / HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n")).await;
        assert!(rebinding.starts_with("HTTP/1.1 421"), "{rebinding}");

        let cross = send(port, &format!("GET / HTTP/1.1\r\nHost: {host}\r\nSec-Fetch-Site: cross-site\r\n\r\n")).await;
        assert!(cross.starts_with("HTTP/1.1 403"), "{cross}");
        let no_cors = send(
            port,
            &format!("POST /delete HTTP/1.1\r\nHost: {host}\r\nOrigin: http://evil.example\r\nSec-Fetch-Mode: no-cors\r\nContent-Type: text/plain\r\nContent-Length: 1\r\n\r\nx"),
        )
        .await;
        assert!(no_cors.starts_with("HTTP/1.1 403") && !no_cors.contains("access-control"), "{no_cors}");
        assert!(seen.try_recv().is_err(), "refused requests never reached the upstream");

        let bad = send(port, "HELLO\r\n\r\n").await;
        assert!(bad.starts_with("HTTP/1.1 400"), "{bad}");
        cancel.cancel();
    }
}
