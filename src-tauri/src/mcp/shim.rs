//! The stdio shim `kns-mcp` (docs/plan-features.md §5.9, package H3).
//!
//! A stdio MCP client starts `kns-mcp`; the shim forwards each newline-delimited JSON-RPC message
//! from stdin as one POST to the running app's Streamable HTTP endpoint and writes every JSON-RPC
//! message of the answer to stdout, one per line. It is a plain console program:
//!
//! - It reads the port from `<config_dir>/no.sixm.kns/rust/mcp.json` (read-only, again for every
//!   message, so a port change or a later app start needs no restart) and the bearer token from the
//!   env var `KNS_MCP_TOKEN`. It never writes a file, never opens a cluster connection and connects
//!   to `127.0.0.1` only.
//! - Requests run on their own thread (a `wait_proposal` blocks up to 60 s and must not hold up a
//!   `ping`); stdout is written under one lock, one complete line at a time. Only JSON-RPC goes
//!   to stdout; diagnostics go to stderr.
//! - Every failure of a request (kns not running, server off, no token, 401 revoked token, 403,
//!   429, a broken answer) comes back as a JSON-RPC error with the request's id, so the client
//!   shows a reason instead of hanging. A failing notification is reported on stderr only.
//! - Headers: `Host: 127.0.0.1:<port>` exactly, no `Origin`, `Accept` for JSON and SSE,
//!   `Mcp-Method`/`Mcp-Name` (revision 2026-07-28; rmcp checks them against the body), and
//!   `MCP-Protocol-Version` (from the request's `_meta`, else the revision `initialize` agreed).
//!
//! This file is compiled twice: as `kns_lib::mcp::shim` (tests drive it against the real server)
//! and into `src/bin/kns-mcp.rs` via `#[path]`, so it uses std, `serde_json`, `base64` and `dirs`
//! only and never `crate::` paths. The binary stays small and links no Tauri code.
use std::{
    io::{BufRead, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};

/// The app's identifier (`tauri.conf.json`): the app config dir is `<config_dir>/<identifier>`.
pub const IDENTIFIER: &str = "no.sixm.kns";
/// Used when `mcp.json` does not exist yet (`mcp::DEFAULT_PORT`).
pub const DEFAULT_PORT: u16 = 7099;
/// `mcp::server::PATH`
pub const PATH: &str = "/mcp";
pub const TOKEN_ENV: &str = "KNS_MCP_TOKEN";
/// The CLI token kns writes next to `mcp.json` when the Claude Code skill is installed with one
/// (`mcp::skill`); read only when `KNS_MCP_TOKEN` is not set.
pub const TOKEN_FILE: &str = "cli-token";
/// A larger answer is refused (the server caps results at 256 KiB).
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
/// A larger stdin line is answered with an error without being sent (the server takes 1 MiB).
const MAX_LINE: usize = 2 * 1024 * 1024;
/// JSON-RPC "server error" range; `data.kns` names the cause.
const SHIM_ERROR: i64 = -32000;

/// `<config_dir>/no.sixm.kns/rust/mcp.json`: `%APPDATA%\no.sixm.kns\rust\mcp.json` on Windows,
/// `~/Library/Application Support/no.sixm.kns/rust/mcp.json` on macOS (Tauri's `app_config_dir`).
pub fn default_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| config_path_in(&d))
}

pub fn config_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(IDENTIFIER).join("rust").join("mcp.json")
}

/// `rust/cli-token` next to `mcp.json`, if it exists.
pub fn read_token_file(config: &Path) -> Option<String> {
    let path = config.with_file_name(TOKEN_FILE);
    std::fs::read_to_string(path).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty() && t.len() < 256)
}

/// What the shim reads from `mcp.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub port: u16,
    /// `None` when the file does not exist (kns was never set up for agents)
    pub enabled: Option<bool>,
}

/// The port and the on/off flag; a missing file means the default port.
pub fn read_endpoint(path: &Path) -> Result<Endpoint, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Endpoint { port: DEFAULT_PORT, enabled: None }),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    let port = match v.get("port") {
        None | Some(Value::Null) => DEFAULT_PORT,
        Some(p) => p.as_u64().and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0).ok_or_else(|| format!("{} has an invalid port", path.display()))?,
    };
    Ok(Endpoint { port, enabled: Some(v.get("enabled").and_then(Value::as_bool).unwrap_or(false)) })
}

/// What one stdin message produced.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Outcome {
    /// complete JSON-RPC messages, one line each
    pub stdout: Vec<String>,
    /// one diagnostic line, if any
    pub stderr: Option<String>,
}

/// The proxy. Shared by every request thread.
pub struct Shim {
    config: Option<PathBuf>,
    token: Option<String>,
    /// the revision the last `initialize` agreed on (sent as `MCP-Protocol-Version`)
    version: Mutex<Option<String>>,
    pub connect_timeout: Duration,
    /// longer than `wait_proposal`'s 60 s and Claude Code's 5 min idle abort
    pub read_timeout: Duration,
}

impl Shim {
    pub fn new(config: Option<PathBuf>, token: Option<String>) -> Self {
        Self {
            config,
            token: token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
            version: Mutex::new(None),
            connect_timeout: Duration::from_secs(3),
            read_timeout: Duration::from_secs(330),
        }
    }

    /// From the environment: the default config path and `KNS_MCP_TOKEN`, else the token file
    /// kns wrote next to `mcp.json` for the CLI (`rust/cli-token`).
    pub fn from_env() -> Self {
        let config = default_config_path();
        let token = std::env::var(TOKEN_ENV).ok().filter(|t| !t.trim().is_empty()).or_else(|| config.as_deref().and_then(read_token_file));
        Self::new(config, token)
    }

    fn negotiated(&self) -> Option<String> {
        self.version.lock().map(|v| v.clone()).unwrap_or_default()
    }

    /// Handles one line from stdin.
    pub fn handle(&self, line: &str) -> Outcome {
        let line = line.trim();
        if line.is_empty() {
            return Outcome::default();
        }
        if line.len() > MAX_LINE {
            return error_outcome(&[Value::Null], "Invalid", "the message is larger than kns accepts (1 MiB)");
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                let mut o = Outcome::default();
                o.stdout.push(rpc_error(&Value::Null, -32700, &format!("parse error: {e}"), "ParseError"));
                return o;
            }
        };
        let ids = request_ids(&msg);
        let Some(token) = self.token.as_deref() else {
            return error_outcome(&ids, "NoToken", "no token: set KNS_MCP_TOKEN to the token from \":mcp setup\" in kns, or install the agent skill with a CLI token (\":mcp skill\")");
        };
        if !header_safe(token) {
            return error_outcome(&ids, "NoToken", "KNS_MCP_TOKEN contains characters an HTTP header cannot carry");
        }
        let headers = match request_headers(&msg, self.negotiated()) {
            Ok(h) => h,
            Err(e) => return error_outcome(&ids, "Invalid", &e),
        };
        let Some(config) = self.config.as_deref() else {
            return error_outcome(&ids, "ConfigError", "no config directory on this system: cannot find kns's settings");
        };
        let endpoint = match read_endpoint(config) {
            Ok(e) => e,
            Err(e) => return error_outcome(&ids, "ConfigError", &e),
        };
        let response = match post(endpoint.port, token, &headers, line.as_bytes(), self.connect_timeout, self.read_timeout) {
            Ok(r) => r,
            Err(e) if is_down(&e) => return error_outcome(&ids, "NotRunning", &not_running(&endpoint, config)),
            Err(e) => return error_outcome(&ids, "HttpError", &format!("talking to kns on 127.0.0.1:{} failed: {e}", endpoint.port)),
        };
        if let Some((code, text)) = status_error(&response) {
            return error_outcome(&ids, code, &text);
        }
        let messages = match messages(&response) {
            Ok(m) => m,
            Err(e) => return error_outcome(&ids, "BadResponse", &format!("kns sent an answer the shim cannot read: {e}")),
        };
        if msg.get("method").and_then(Value::as_str) == Some("initialize") {
            let agreed = messages.iter().find_map(|m| m.pointer("/result/protocolVersion").and_then(Value::as_str)).filter(|v| version_safe(v));
            if let (Some(v), Ok(mut slot)) = (agreed, self.version.lock()) {
                *slot = Some(v.to_string());
            }
        }
        let mut o = Outcome::default();
        for m in &messages {
            // serde_json escapes control characters: one message is always one line
            if let Ok(s) = serde_json::to_string(m) {
                o.stdout.push(s);
            }
        }
        if o.stdout.is_empty() && !ids.is_empty() {
            return error_outcome(&ids, "BadResponse", &format!("kns answered HTTP {} without a result", response.status));
        }
        o
    }
}

/// The ids of the requests in a message (a batch has several; notifications none).
fn request_ids(msg: &Value) -> Vec<Value> {
    let one = |m: &Value| if m.get("method").is_some() { m.get("id").filter(|id| !id.is_null()).cloned() } else { None };
    match msg {
        Value::Array(items) => items.iter().filter_map(one).collect(),
        Value::Object(_) => one(msg).into_iter().collect(),
        _ => vec![Value::Null],
    }
}

fn rpc_error(id: &Value, code: i64, message: &str, kns: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message, "data": { "kns": kns } } }).to_string()
}

/// One JSON-RPC error per request id; a notification gets a stderr line only.
fn error_outcome(ids: &[Value], kns: &str, message: &str) -> Outcome {
    Outcome {
        stdout: ids.iter().map(|id| rpc_error(id, SHIM_ERROR, message, kns)).collect(),
        stderr: Some(format!("kns-mcp: {message}")),
    }
}

fn not_running(e: &Endpoint, config: &Path) -> String {
    match e.enabled {
        Some(false) => "the kns MCP server is off: turn it on with \":mcp on\" in kns (or \":mcp setup\")".into(),
        None => format!("kns is not running, or was never set up for agents ({} does not exist): start kns and run \":mcp setup\"", config.display()),
        Some(true) => format!("kns is not running (nothing answers on 127.0.0.1:{}): start kns", e.port),
    }
}

/// A failure to open the connection (as opposed to one while talking): only this means "down".
#[derive(Debug)]
struct ConnectError(std::io::Error);

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for ConnectError {}

/// Nothing answers on the port. A read that timed out (a slow `wait_proposal`) or a reset after
/// the request was sent is not "kns is not running".
fn is_down(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    e.get_ref().is_some_and(|i| i.is::<ConnectError>()) && matches!(e.kind(), ConnectionRefused | ConnectionReset | ConnectionAborted | TimedOut | AddrNotAvailable)
}

/// Printable ASCII without spaces at the ends: safe as a header value.
fn header_safe(v: &str) -> bool {
    !v.is_empty() && v.bytes().all(|b| (0x20..0x7f).contains(&b)) && !v.starts_with(' ') && !v.ends_with(' ')
}

fn version_safe(v: &str) -> bool {
    !v.is_empty() && v.len() <= 32 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
}

const B64_PREFIX: &str = "=?base64?";
const B64_SUFFIX: &str = "?=";

/// rmcp's `encode_header_value`: a value a header cannot carry verbatim travels base64-wrapped.
pub fn encode_header_value(value: &str) -> String {
    use base64::Engine;
    let bytes = value.as_bytes();
    let wrap = !value.is_empty()
        && (matches!(bytes.first(), Some(b' ' | b'\t'))
            || matches!(bytes.last(), Some(b' ' | b'\t'))
            || value.chars().any(|c| (c as u32) < 0x20 || (c as u32) > 0x7e)
            || (value.starts_with(B64_PREFIX) && value.ends_with(B64_SUFFIX)));
    if wrap { format!("{B64_PREFIX}{}{B64_SUFFIX}", base64::engine::general_purpose::STANDARD.encode(value)) } else { value.to_string() }
}

/// `Mcp-Method`, `Mcp-Name` and `MCP-Protocol-Version` for one message.
pub fn request_headers(msg: &Value, negotiated: Option<String>) -> Result<Vec<(&'static str, String)>, String> {
    let mut out = Vec::new();
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        // a batch or a response: no per-message headers
        if let Some(v) = negotiated.filter(|v| version_safe(v)) {
            out.push(("MCP-Protocol-Version", v));
        }
        return Ok(out);
    };
    if !header_safe(method) || method.contains(' ') {
        return Err("the method name contains characters an HTTP header cannot carry".into());
    }
    out.push(("Mcp-Method", method.to_string()));
    let params = msg.get("params");
    let key = match method {
        "tools/call" | "prompts/get" => Some("name"),
        "resources/read" | "resources/subscribe" | "resources/unsubscribe" => Some("uri"),
        "tasks/get" | "tasks/update" | "tasks/cancel" => Some("taskId"),
        _ => None,
    };
    if let Some(name) = key.and_then(|k| params?.get(k)?.as_str()) {
        out.push(("Mcp-Name", encode_header_value(name)));
    }
    let from_meta = params.and_then(|p| p.pointer("/_meta/io.modelcontextprotocol~1protocolVersion")).and_then(Value::as_str).map(str::to_string);
    if method != "initialize"
        && let Some(v) = from_meta.or(negotiated).filter(|v| version_safe(v))
    {
        out.push(("MCP-Protocol-Version", v));
    }
    Ok(out)
}

/// One HTTP answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    /// lowercase names
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// POST `body` to `http://127.0.0.1:<port>/mcp` with `Connection: close`; reads the whole answer.
pub fn post(port: u16, token: &str, extra: &[(&str, String)], body: &[u8], connect: Duration, read: Duration) -> std::io::Result<HttpResponse> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, connect).map_err(|e| std::io::Error::new(e.kind(), ConnectError(e)))?;
    stream.set_read_timeout(Some(read))?;
    stream.set_write_timeout(Some(read))?;
    let mut head = format!(
        "POST {PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nUser-Agent: kns-mcp/{}\r\nContent-Length: {}\r\nConnection: close\r\n",
        env!("CARGO_PKG_VERSION"),
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;
    let mut raw = Vec::new();
    stream.take(MAX_RESPONSE as u64 + 1).read_to_end(&mut raw)?;
    if raw.len() > MAX_RESPONSE {
        return Err(std::io::Error::other("the answer is larger than 16 MiB"));
    }
    parse_response(&raw).map_err(std::io::Error::other)
}

/// Parses a complete HTTP/1.1 response (Content-Length, chunked, or until close).
pub fn parse_response(raw: &[u8]) -> Result<HttpResponse, String> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("no end of headers")?;
    let head = std::str::from_utf8(&raw[..end]).map_err(|_| "headers are not UTF-8")?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let mut parts = status_line.splitn(3, ' ');
    let proto = parts.next().unwrap_or_default();
    if !proto.starts_with("HTTP/1.") {
        return Err(format!("not an HTTP/1.x answer: {}", status_line.chars().take(40).collect::<String>()));
    }
    let status: u16 = parts.next().and_then(|s| s.parse().ok()).ok_or("no status code")?;
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    let rest = &raw[end + 4..];
    let mut res = HttpResponse { status, headers, body: Vec::new() };
    res.body = if res.header("transfer-encoding").is_some_and(|t| t.to_ascii_lowercase().contains("chunked")) {
        dechunk(rest)?
    } else if let Some(len) = res.header("content-length") {
        let len: usize = len.parse().map_err(|_| "bad Content-Length")?;
        if rest.len() < len {
            return Err("the answer ended early".into());
        }
        rest[..len].to_vec()
    } else {
        rest.to_vec()
    };
    Ok(res)
}

/// Decodes a chunked body.
pub fn dechunk(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = data.windows(2).position(|w| w == b"\r\n").ok_or("chunk size line without end")?;
        let size_line = std::str::from_utf8(&data[..eol]).map_err(|_| "bad chunk size")?;
        let size_hex = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_hex, 16).map_err(|_| format!("bad chunk size \"{}\"", size_hex.chars().take(16).collect::<String>()))?;
        data = &data[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if data.len() < size + 2 {
            return Err("the answer ended inside a chunk".into());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

/// HTTP statuses that are not a JSON-RPC answer, as (`data.kns`, message).
fn status_error(r: &HttpResponse) -> Option<(&'static str, String)> {
    let detail = || String::from_utf8_lossy(&r.body).chars().filter(|c| !c.is_control()).take(200).collect::<String>();
    match r.status {
        200..=299 => None,
        401 => Some(("Unauthorized", "kns refused the token (HTTP 401): KNS_MCP_TOKEN is wrong or was revoked; create a new one with \":mcp setup\" in kns".into())),
        403 => Some(("Forbidden", format!("kns refused the request (HTTP 403): {}", detail()))),
        413 => Some(("Invalid", "the message is larger than kns accepts (1 MiB)".into())),
        429 => Some(("RateLimited", format!("kns rate-limited this agent (HTTP 429); retry in {} s", r.header("retry-after").unwrap_or("a few")))),
        // rmcp answers protocol errors (e.g. a header mismatch) with a JSON-RPC body: pass it on
        _ if r.header("content-type").is_some_and(|c| c.contains("json")) && serde_json::from_slice::<Value>(&r.body).is_ok_and(|v| v.get("error").is_some()) => None,
        s => Some(("HttpError", format!("kns answered HTTP {s}: {}", detail()))),
    }
}

/// The JSON-RPC messages in an answer: a JSON body (one message or a batch) or an SSE stream.
pub fn messages(r: &HttpResponse) -> Result<Vec<Value>, String> {
    if r.body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    let text = std::str::from_utf8(&r.body).map_err(|_| "the body is not UTF-8")?;
    if r.header("content-type").is_some_and(|c| c.starts_with("text/event-stream")) {
        return Ok(sse_data(text).into_iter().filter_map(|d| serde_json::from_str(&d).ok()).collect());
    }
    match serde_json::from_str(text).map_err(|e| e.to_string())? {
        Value::Array(items) => Ok(items),
        v => Ok(vec![v]),
    }
}

/// The `data` of each SSE event (multi-line data joined with `\n`; empty events skipped).
pub fn sse_data(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for line in text.lines().chain(std::iter::once("")) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if !cur.is_empty() {
                let d = cur.join("\n");
                if !d.trim().is_empty() {
                    out.push(d);
                }
                cur.clear();
            }
        } else if let Some(d) = line.strip_prefix("data:") {
            cur.push(d.strip_prefix(' ').unwrap_or(d));
        }
    }
    out
}

const USAGE: &str = "kns-mcp: connects a stdio MCP client to the MCP server of the running kns app.

Usage: kns-mcp            serve MCP over stdin/stdout (newline-delimited JSON-RPC)
       kns-mcp --check    ask kns for its tool list once and report
       kns-mcp guide | tools | help <tool> | call <tool> …   the tools as shell commands (kns-mcp --help)
       kns-mcp --help | --version

Environment: KNS_MCP_TOKEN  the agent's token from \":mcp setup\" in kns (else the CLI token from \":mcp skill\")
Reads the port from the kns settings; never connects anywhere but 127.0.0.1.";

/// The program. Returns the exit code.
pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("--help" | "-h") => {
            println!("{USAGE}");
            return 0;
        }
        Some("--version" | "-V") => {
            println!("kns-mcp {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }
        Some("--check") => return check(&Shim::from_env()),
        Some(other) => {
            eprintln!("kns-mcp: unknown argument \"{}\"\n\n{USAGE}", other.chars().filter(|c| !c.is_control()).take(40).collect::<String>());
            return 2;
        }
        None => {}
    }
    let shim = Arc::new(Shim::from_env());
    if shim.token.is_none() {
        eprintln!("kns-mcp: {TOKEN_ENV} is not set; every request will be refused");
    }
    serve(shim, std::io::stdin().lock(), Arc::new(Mutex::new(std::io::stdout())));
    0
}

/// `--check`: one `tools/list` through the same path a client uses.
fn check(shim: &Shim) -> i32 {
    let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }).to_string();
    let o = shim.handle(&req);
    let v: Option<Value> = o.stdout.first().and_then(|l| serde_json::from_str(l).ok());
    match v.as_ref().and_then(|v| v.pointer("/result/tools")).and_then(Value::as_array) {
        Some(tools) => {
            println!("ok: kns answers with {} tools", tools.len());
            0
        }
        None => {
            let msg = v.as_ref().and_then(|v| v.pointer("/error/message")).and_then(Value::as_str).map(str::to_string);
            eprintln!("kns-mcp: {}", msg.or(o.stderr).unwrap_or_else(|| "no answer".into()));
            1
        }
    }
}

/// Reads stdin until EOF; one thread per message; waits for the answers still running at EOF.
pub fn serve<R: BufRead, W: Write + Send + 'static>(shim: Arc<Shim>, mut input: R, out: Arc<Mutex<W>>) {
    let mut running: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match input.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                eprintln!("kns-mcp: reading stdin failed: {e}");
                break;
            }
        }
        let line = match String::from_utf8(std::mem::take(&mut buf)) {
            Ok(l) => l,
            Err(_) => {
                emit(&out, &Outcome { stdout: vec![rpc_error(&Value::Null, -32700, "parse error: the line is not UTF-8", "ParseError")], stderr: None });
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        running.retain(|h| !h.is_finished());
        let (shim, out) = (shim.clone(), out.clone());
        running.push(std::thread::spawn(move || emit(&out, &shim.handle(&line))));
    }
    for h in running {
        let _ = h.join();
    }
}

fn emit<W: Write>(out: &Mutex<W>, o: &Outcome) {
    if let Some(e) = &o.stderr {
        eprintln!("{e}");
    }
    if o.stdout.is_empty() {
        return;
    }
    if let Ok(mut w) = out.lock() {
        for line in &o.stdout {
            let _ = w.write_all(line.as_bytes());
            let _ = w.write_all(b"\n");
        }
        let _ = w.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_path_and_endpoint() {
        let base = std::env::temp_dir().join(format!("kns-shim-cfg-{}", std::process::id()));
        let path = config_path_in(&base);
        assert!(path.ends_with(Path::new("no.sixm.kns").join("rust").join("mcp.json")));
        assert_eq!(read_endpoint(&path).unwrap(), Endpoint { port: DEFAULT_PORT, enabled: None });
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"schema":1,"enabled":true,"port":7123,"clients":[{"name":"x","tokenSha256":"ab","createdAt":"t"}]}"#).unwrap();
        assert_eq!(read_endpoint(&path).unwrap(), Endpoint { port: 7123, enabled: Some(true) });
        std::fs::write(&path, r#"{"schema":1}"#).unwrap();
        assert_eq!(read_endpoint(&path).unwrap(), Endpoint { port: DEFAULT_PORT, enabled: Some(false) });
        std::fs::write(&path, r#"{"port":70000}"#).unwrap();
        assert!(read_endpoint(&path).is_err());
        std::fs::write(&path, "nope").unwrap();
        assert!(read_endpoint(&path).is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn headers_follow_the_body() {
        let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "get_status", "arguments": {} } });
        let h = request_headers(&call, Some("2025-11-25".into())).unwrap();
        assert_eq!(h, vec![("Mcp-Method", "tools/call".into()), ("Mcp-Name", "get_status".into()), ("MCP-Protocol-Version", "2025-11-25".into())]);
        let read = json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": { "uri": "kns://devset/é", "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
        let h = request_headers(&read, Some("2025-11-25".into())).unwrap();
        assert_eq!(h[1].1, encode_header_value("kns://devset/é"));
        assert!(h[1].1.starts_with("=?base64?"), "non-ASCII is wrapped");
        assert_eq!(h[2], ("MCP-Protocol-Version", "2026-07-28".into()), "the request's _meta wins");
        let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {} });
        assert_eq!(request_headers(&init, Some("2025-11-25".into())).unwrap(), vec![("Mcp-Method", "initialize".into())]);
        // header injection through the method or the version is refused or dropped
        let evil = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list\r\nX-Evil: 1" });
        assert!(request_headers(&evil, None).is_err());
        let evil_v = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": { "_meta": { "io.modelcontextprotocol/protocolVersion": "1\r\nX: y" } } });
        assert_eq!(request_headers(&evil_v, None).unwrap().len(), 1);
        let name = json!({ "jsonrpc": "2.0", "id": 4, "method": "prompts/get", "params": { "name": "a\r\nb" } });
        assert!(request_headers(&name, None).unwrap()[1].1.starts_with("=?base64?"));
    }

    #[test]
    fn responses_parse() {
        let r = parse_response(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\ncontent-length: 2\r\n\r\n{}extra").unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, b"{}".as_slice()));
        let r = parse_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n[1,2\r\n3;x=y\r\n,3]\r\n0\r\n\r\n").unwrap();
        assert_eq!(r.body, b"[1,2,3]");
        assert_eq!(messages(&r).unwrap(), vec![json!(1), json!(2), json!(3)]);
        let r = parse_response(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\n\r\n").unwrap();
        assert!(messages(&r).unwrap().is_empty());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\n{}").is_err());
        assert!(parse_response(b"SSH-2.0\r\n\r\n").is_err());
        assert!(dechunk(b"zz\r\n").is_err());
        let sse = HttpResponse {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            body: b": keep\n\nevent: message\nid: 1\ndata: {\"id\":1,\ndata: \"result\":{}}\n\ndata:\n\nretry: 5\n".to_vec(),
        };
        assert_eq!(messages(&sse).unwrap(), vec![json!({ "id": 1, "result": {} })]);
    }

    #[test]
    fn statuses_become_errors() {
        let r = |status: u16, ct: &str, body: &str| HttpResponse { status, headers: vec![("content-type".into(), ct.into()), ("retry-after".into(), "2".into())], body: body.as_bytes().to_vec() };
        assert_eq!(status_error(&r(401, "text/plain", "Unauthorized")).unwrap().0, "Unauthorized");
        assert_eq!(status_error(&r(403, "text/plain", "Forbidden: Host not allowed")).unwrap().0, "Forbidden");
        assert!(status_error(&r(429, "text/plain", "")).unwrap().1.contains("retry in 2 s"));
        assert!(status_error(&r(400, "application/json", r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"m"}}"#)).is_none(), "a JSON-RPC error body passes");
        assert_eq!(status_error(&r(500, "text/plain", "boom\u{1b}[31m")).unwrap().1, "kns answered HTTP 500: boom[31m");
        assert!(status_error(&r(200, "application/json", "{}")).is_none());
    }

    #[test]
    fn local_failures_answer_with_the_request_id() {
        let shim = Shim::new(Some(PathBuf::from("/nonexistent/kns/mcp.json")), None);
        let o = shim.handle(r#"{"jsonrpc":"2.0","id":"a-7","method":"tools/list"}"#);
        let v: Value = serde_json::from_str(&o.stdout[0]).unwrap();
        assert_eq!(v["id"], "a-7");
        assert_eq!(v["error"]["data"]["kns"], "NoToken");
        // a notification: nothing on stdout
        let o = shim.handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert!(o.stdout.is_empty() && o.stderr.is_some());
        // not JSON: parse error with id null
        let o = shim.handle("{nope");
        let v: Value = serde_json::from_str(&o.stdout[0]).unwrap();
        assert_eq!((v["id"].clone(), v["error"]["code"].clone()), (Value::Null, json!(-32700)));
        assert!(shim.handle("   ").stdout.is_empty());
        // a token that would break the header
        let shim = Shim::new(None, Some("abc\r\nX: y".into()));
        let o = shim.handle(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        assert!(o.stdout[0].contains("NoToken"));
        // batch: one error per request
        let shim = Shim::new(None, None);
        let o = shim.handle(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"n"},{"jsonrpc":"2.0","id":2,"method":"ping"}]"#);
        assert_eq!(o.stdout.len(), 2);
    }

    #[test]
    fn only_a_failed_connect_is_down() {
        use std::io::{Error, ErrorKind};
        assert!(is_down(&Error::new(ErrorKind::ConnectionRefused, ConnectError(Error::from(ErrorKind::ConnectionRefused)))));
        assert!(!is_down(&Error::from(ErrorKind::TimedOut)), "a read timeout is not \"not running\"");
        assert!(!is_down(&Error::from(ErrorKind::ConnectionReset)));
    }

    #[test]
    fn not_running_names_the_fix() {
        let p = Path::new("x/mcp.json");
        assert!(not_running(&Endpoint { port: 7099, enabled: Some(false) }, p).contains(":mcp on"));
        assert!(not_running(&Endpoint { port: 7099, enabled: None }, p).contains(":mcp setup"));
        assert!(not_running(&Endpoint { port: 7123, enabled: Some(true) }, p).contains("127.0.0.1:7123"));
    }

    #[test]
    fn serve_writes_whole_lines_and_waits_at_eof() {
        let shim = Arc::new(Shim::new(None, None));
        let input = std::io::Cursor::new(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}".to_vec());
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        serve(shim, input, out.clone());
        let text = String::from_utf8(out.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        let mut ids: Vec<i64> = lines.iter().map(|l| serde_json::from_str::<Value>(l).unwrap()["id"].as_i64().unwrap()).collect();
        ids.sort();
        assert_eq!(ids, vec![1, 2]);
    }
}
