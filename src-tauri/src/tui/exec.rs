//! A shell in a pod, passed straight through this terminal: raw mode, stdin bytes to
//! `exec_write`, `data` events to stdout, the terminal size to `exec_resize`. In a herdr pane
//! this is the whole process; outside herdr the TUI suspends itself around it.
use std::{
    io::{Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use base64::Engine;
use ratatui::crossterm::terminal;
use serde_json::json;

use super::client::{Client, Msg, Tag};

pub struct ExecTarget {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub container: Option<String>,
    pub command: Vec<String>,
}

/// Runs until the remote process exits; returns its exit code.
pub fn run(target: &ExecTarget) -> Result<i32, String> {
    let (tx, rx) = mpsc::channel::<Msg>();
    let client = Client::connect(tx, true).map_err(|e| e.message)?;
    let (cols, rows) = terminal::size().unwrap_or((80, 24));
    let mut out = std::io::stdout();
    let _ = write!(out, "\x1b[2m── {}  {}/{}{} ──\x1b[0m\r\n", target.context, target.namespace, target.pod, target.container.as_ref().map(|c| format!(" ({c})")).unwrap_or_default());
    let _ = out.flush();
    let query = json!({
        "context": target.context, "namespace": target.namespace, "pod": target.pod,
        "container": target.container, "command": target.command,
        "tty": true, "cols": cols, "rows": rows,
    });
    let id = client
        .call_stream(Tag { kind: "exec", epoch: 0 }, "exec_start", json!({ "query": query }))
        .map_err(|e| e.message)?
        .as_str()
        .unwrap_or_default()
        .to_string();

    terminal::enable_raw_mode().map_err(|e| e.to_string())?;
    let result = pump(&client, &id, &rx, (cols, rows));
    let _ = terminal::disable_raw_mode();
    client.stop(&id);
    result
}

fn pump(client: &Client, id: &str, rx: &mpsc::Receiver<Msg>, size: (u16, u16)) -> Result<i32, String> {
    // stdin -> exec_write in its own thread. It polls with a timeout and stops with the shell:
    // a thread left blocked in read() would steal the TUI's next keys and terminal replies.
    let stop = Arc::new(AtomicBool::new(false));
    let writer = client.clone();
    let wid = id.to_string();
    let flag = stop.clone();
    let input = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        while !flag.load(Ordering::Relaxed) {
            let n = match read_stdin(&mut buf, 100) {
                Some(0) => continue,
                Some(n) => n,
                None => break,
            };
            pending.extend_from_slice(&buf[..n]);
            // send whole UTF-8 characters only; keep a split multi-byte sequence for the next read
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid == 0 {
                continue;
            }
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            if writer.call("exec_write", json!({ "id": wid, "data": text })).is_err() {
                break;
            }
        }
    });
    let result = output(client, id, rx, size);
    stop.store(true, Ordering::Relaxed);
    let _ = input.join();
    result
}

/// Reads stdin when it has data within `timeout_ms`: `Some(0)` = nothing yet, `None` = closed.
fn read_stdin(buf: &mut [u8], timeout_ms: i32) -> Option<usize> {
    let mut fds = libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 };
    // SAFETY: one valid pollfd for the duration of the call
    let ready = unsafe { libc::poll(&mut fds, 1, timeout_ms) };
    if ready < 0 {
        return (std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted).then_some(0);
    }
    if ready == 0 {
        return Some(0);
    }
    if fds.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 && fds.revents & libc::POLLIN == 0 {
        return None;
    }
    match std::io::stdin().lock().read(buf) {
        Ok(0) | Err(_) => None,
        Ok(n) => Some(n),
    }
}

fn output(client: &Client, id: &str, rx: &mpsc::Receiver<Msg>, mut size: (u16, u16)) -> Result<i32, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut out = std::io::stdout();
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Msg::Stream { event, .. }) => match event["type"].as_str() {
                Some("data") => {
                    if let Some(bytes) = event["b64"].as_str().and_then(|s| b64.decode(s).ok()) {
                        let _ = out.write_all(&bytes);
                        let _ = out.flush();
                    }
                }
                Some("exit") => {
                    let code = event["code"].as_i64().unwrap_or(0) as i32;
                    if let Some(m) = event["message"].as_str().filter(|m| !m.is_empty() && code != 0) {
                        let _ = write!(out, "\r\n\x1b[2m{m}\x1b[0m\r\n");
                    }
                    return Ok(code);
                }
                Some("error") => return Err(event["message"].as_str().unwrap_or("exec failed").to_string()),
                _ => {}
            },
            Ok(Msg::Closed) => return Err("kns went away".into()),
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("kns went away".into()),
        }
        if let Ok(now) = terminal::size()
            && now != size
        {
            size = now;
            let _ = client.call("exec_resize", json!({ "id": id, "cols": now.0, "rows": now.1 }));
        }
    }
}

/// Parses `[context/]namespace/pod`.
pub fn parse_target(spec: &str, default_context: Option<&str>) -> Option<(String, String, String)> {
    let parts: Vec<&str> = spec.split('/').collect();
    match parts.as_slice() {
        [ctx, ns, pod] => Some((ctx.to_string(), ns.to_string(), pod.to_string())),
        [ns, pod] => Some((default_context?.to_string(), ns.to_string(), pod.to_string())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert_eq!(parse_target("dev/ns/p", None), Some(("dev".into(), "ns".into(), "p".into())));
        assert_eq!(parse_target("ns/p", Some("c")), Some(("c".into(), "ns".into(), "p".into())));
        assert_eq!(parse_target("ns/p", None), None);
        assert_eq!(parse_target("p", Some("c")), None);
    }
}
