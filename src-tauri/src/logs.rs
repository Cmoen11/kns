//! `stream_logs`: one reader task per (pod, container), merged into batched `lines` events.
use std::{pin::pin, sync::Arc, time::Duration};

use futures::{AsyncBufRead, AsyncBufReadExt};
use jiff::Timestamp;
use k8s_openapi::api::core::v1::Pod;
use kube::{
    Client,
    api::{Api, LogParams},
};
use tokio::{
    sync::mpsc,
    task::JoinSet,
    time::{Instant, sleep_until, timeout},
};
use tokio_util::sync::CancellationToken;

use crate::{
    ipc::{BackendError, LogEvent, LogLine, LogQuery, LogTarget, Result, Sink},
    logparse,
    session::timed,
    state::AppState,
};

const FLUSH_EVERY: Duration = Duration::from_millis(100);
const FLUSH_LINES: usize = 500;
/// A batch also goes out at this many bytes of text: 500 lines of 16 KiB would be an 8 MB message.
const FLUSH_BYTES: usize = 256 * 1024;
/// Longest line text passed on; the rest of a longer line is dropped.
const MAX_LINE: usize = 16 * 1024;
/// Room for the kubelet timestamp in front of the text.
const MAX_RAW: usize = MAX_LINE + 64;
/// A follow that is silent this long is opened again from the last line: without TCP keepalive
/// (kube-rs sets none) a connection that died during sleep or behind a NAT looks just like a quiet log.
pub const FOLLOW_IDLE: Duration = Duration::from_secs(300);

enum Msg {
    Line(LogLine),
    End(LogTarget),
    Error(LogTarget, String),
}

/// Starts the streams and returns the stream id at once. A target that cannot be opened reports
/// an `error` event; the stream unregisters itself when every target has ended.
pub async fn stream_logs(state: &AppState, query: LogQuery, sink: impl Sink<LogEvent>) -> Result<String> {
    stream_logs_with(state, query, sink, FOLLOW_IDLE).await
}

/// `stream_logs` with its own idle time before a silent follow is reopened.
pub async fn stream_logs_with(
    state: &AppState,
    query: LogQuery,
    sink: impl Sink<LogEvent>,
    follow_idle: Duration,
) -> Result<String> {
    // checked before anything starts, so a bad timestamp is an error of the call
    since_time(&query)?;
    let session = state.session(&query.context).await?;
    let handle = state.register_stream();
    let id = handle.id.clone();
    tokio::spawn(async move {
        run(session.client.clone(), query, sink, handle.cancel.clone(), follow_idle).await;
        drop(handle);
    });
    Ok(id)
}

/// `sinceTime` as a timestamp; `Invalid` when it is not RFC3339.
fn since_time(query: &LogQuery) -> Result<Option<Timestamp>> {
    query
        .since_time
        .as_deref()
        .map(|s| s.parse::<Timestamp>().map_err(|e| BackendError::invalid(format!("sinceTime {s:?}: {e}"))))
        .transpose()
}

/// The API request for one target. `sinceTime` wins over `sinceSeconds`: the API takes one.
fn log_params(query: &LogQuery, target: &LogTarget, since_time: Option<Timestamp>) -> LogParams {
    LogParams {
        container: Some(target.container.clone()).filter(|c| !c.is_empty()),
        follow: query.follow,
        previous: query.previous.unwrap_or(false),
        since_seconds: if since_time.is_some() { None } else { query.since_seconds.filter(|s| *s > 0) },
        since_time,
        tail_lines: query.tail_lines.filter(|n| *n >= 0),
        timestamps: true,
        ..Default::default()
    }
}

async fn run(client: Client, query: LogQuery, sink: impl Sink<LogEvent>, cancel: CancellationToken, follow_idle: Duration) {
    let (tx, mut rx) = mpsc::channel(1024);
    let mut readers = JoinSet::new();
    // validated in stream_logs_with
    let since = since_time(&query).ok().flatten();
    let parse = query.parse.unwrap_or(false);
    for target in &query.targets {
        let params = log_params(&query, target, since);
        readers.spawn(read_target(client.clone(), params, target.clone(), tx.clone(), cancel.clone(), follow_idle, parse));
    }
    drop(tx);

    let mut batch: Vec<LogLine> = Vec::new();
    let mut batch_bytes = 0;
    let mut flush_at: Option<Instant> = None;
    let flush = |batch: &mut Vec<LogLine>, batch_bytes: &mut usize, flush_at: &mut Option<Instant>| {
        *flush_at = None;
        *batch_bytes = 0;
        batch.is_empty() || sink.send(LogEvent::Lines { lines: std::mem::take(batch) })
    };
    loop {
        let msg = tokio::select! {
            _ = cancel.cancelled() => break,
            _ = async { sleep_until(flush_at.unwrap_or_else(Instant::now)).await }, if flush_at.is_some() => {
                if !flush(&mut batch, &mut batch_bytes, &mut flush_at) {
                    break;
                }
                continue;
            }
            m = rx.recv() => m,
        };
        let delivered = match msg {
            Some(Msg::Line(line)) => {
                batch_bytes += line.text.len() + line.msg.as_ref().map_or(0, String::len) + line.fields.as_ref().map_or(0, |f| f.iter().map(|(k, v)| k.len() + v.len()).sum());
                batch.push(line);
                if batch.len() >= FLUSH_LINES || batch_bytes >= FLUSH_BYTES {
                    flush(&mut batch, &mut batch_bytes, &mut flush_at)
                } else {
                    flush_at.get_or_insert_with(|| Instant::now() + FLUSH_EVERY);
                    true
                }
            }
            // A target's last lines go out before its end/error.
            Some(Msg::End(t)) => {
                flush(&mut batch, &mut batch_bytes, &mut flush_at)
                    && sink.send(LogEvent::End { pod: t.pod, container: t.container })
            }
            Some(Msg::Error(t, message)) => {
                flush(&mut batch, &mut batch_bytes, &mut flush_at)
                    && sink.send(LogEvent::Error { pod: t.pod, container: t.container, message })
            }
            // Every reader is done.
            None => break,
        };
        if !delivered {
            break;
        }
    }
    // Stopped, receiver gone or finished: either way no reader may outlive the stream.
    cancel.cancel();
    readers.shutdown().await;
}

async fn read_target(
    client: Client,
    params: LogParams,
    target: LogTarget,
    tx: mpsc::Sender<Msg>,
    cancel: CancellationToken,
    follow_idle: Duration,
    parse: bool,
) {
    let outcome = tokio::select! {
        _ = cancel.cancelled() => return,
        r = read_lines(client, params, &target, &tx, follow_idle, parse) => r,
    };
    let msg = match outcome {
        Ok(()) => Msg::End(target),
        Err(e) => Msg::Error(target, e.message),
    };
    tokio::select! {
        _ = cancel.cancelled() => {}
        _ = tx.send(msg) => {}
    }
}

async fn read_lines(
    client: Client,
    mut params: LogParams,
    target: &LogTarget,
    tx: &mpsc::Sender<Msg>,
    follow_idle: Duration,
    parse: bool,
) -> Result<()> {
    let pods: Api<Pod> = Api::namespaced(client, &target.namespace);
    let names: (Arc<str>, Arc<str>) = (target.pod.as_str().into(), target.container.as_str().into());
    // Timestamp of the newest line passed on; after a reopen everything up to it is skipped.
    let mut last: Option<Timestamp> = None;
    loop {
        let mut stream = pin!(timed(pods.log_stream(&target.pod, &params)).await?);
        let resumed = params.since_time.is_some();
        // Lines are split by hand: they may be huge or not UTF-8.
        let mut raw: Vec<u8> = Vec::new();
        loop {
            let chunk = if params.follow {
                match timeout(follow_idle, stream.fill_buf()).await {
                    Ok(chunk) => chunk?,
                    Err(_) => break,
                }
            } else {
                stream.fill_buf().await?
            };
            if chunk.is_empty() {
                if !raw.is_empty() {
                    let _ = tx.send(Msg::Line(parse_line(&raw, &names, parse))).await;
                }
                return Ok(());
            }
            let newline = chunk.iter().position(|b| *b == b'\n');
            let part = &chunk[..newline.unwrap_or(chunk.len())];
            let room = MAX_RAW.saturating_sub(raw.len());
            raw.extend_from_slice(&part[..part.len().min(room)]);
            let used = part.len() + usize::from(newline.is_some());
            stream.as_mut().consume(used);
            if newline.is_some() {
                let line = parse_line(&raw, &names, parse);
                raw.clear();
                if params.follow {
                    let ts = line.ts.parse::<Timestamp>().ok();
                    // `sinceTime` has whole seconds, so a reopened stream repeats part of its last second.
                    if resumed && ts.is_some() && ts <= last {
                        continue;
                    }
                    last = ts.or(last);
                }
                if tx.send(Msg::Line(line)).await.is_err() {
                    return Ok(());
                }
            }
        }
        // Silent for `follow_idle`: reopen. With no line seen yet the same request is simply repeated.
        if let Some(ts) = last {
            params.since_time = Some(ts);
            params.since_seconds = None;
            params.tail_lines = None;
        }
    }
}

/// Splits `<RFC3339 timestamp> <text>`; a line without a timestamp keeps an empty `ts`. With
/// `parse`, level, message and fields are filled from the text (`crate::logparse`).
fn parse_line(raw: &[u8], (pod, container): &(Arc<str>, Arc<str>), parse: bool) -> LogLine {
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    let line = String::from_utf8_lossy(raw);
    let (ts, text) = match line.split_once(' ') {
        Some((ts, text)) if is_timestamp(ts) => (ts, text),
        None if is_timestamp(&line) => (&*line, ""),
        _ => ("", &*line),
    };
    let text = &text[..text.floor_char_boundary(MAX_LINE)];
    let parsed = if parse { logparse::parse(text) } else { None };
    let (level, msg, fields) = match parsed {
        Some(p) => (p.level, p.msg, Some(p.fields).filter(|f| !f.is_empty())),
        None => (None, None, None),
    };
    LogLine { ts: ts.into(), pod: pod.clone(), container: container.clone(), text: text.into(), level, msg, fields }
}

fn is_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    (20..=40).contains(&b.len()) && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-' && b[10] == b'T'
}

/// Text the kubelet sends back *as the log body* (HTTP 200) when it cannot read a container log:
/// the previous instance was garbage-collected, or its file rotated away. It is never a log line;
/// `:why`, packs and trap bundles fall back to the current run (or leave the row out).
pub fn is_kubelet_log_error(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.lines().count() > 2 {
        return false;
    }
    let line = t.lines().next().unwrap_or_default();
    // an optional RFC 3339 prefix (timestamps=true) does not change it
    let first = match line.split_once(' ') {
        Some((ts, rest)) if is_timestamp(ts) => rest,
        _ => line,
    }
    .to_ascii_lowercase();
    first.starts_with("unable to retrieve container logs for ")
        || first.starts_with("failed to try resolving symlinks in path")
        || (first.starts_with("previous terminated container") && first.contains("not found"))
        || (first.starts_with("container") && first.contains("is waiting to start"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubelet_log_errors_are_not_log_lines() {
        assert!(is_kubelet_log_error("unable to retrieve container logs for containerd://4f0c1d2e3b"));
        assert!(is_kubelet_log_error("unable to retrieve container logs for containerd://4f0c\n"));
        assert!(is_kubelet_log_error("failed to try resolving symlinks in path \"/var/log/pods/x/0.log\": lstat: no such file or directory"));
        assert!(is_kubelet_log_error("previous terminated container \"app\" in pod \"crashy-1\" not found"));
        assert!(is_kubelet_log_error("2026-11-22T10:00:00.000000000Z unable to retrieve container logs for docker://abc"));
        assert!(!is_kubelet_log_error("2026-11-22T10:00:00Z error: connection refused\nexit 1\nretrying"));
        assert!(!is_kubelet_log_error("starting app"));
        assert!(!is_kubelet_log_error(""));
    }

    fn parse(raw: &[u8]) -> (String, String) {
        let line = parse_line(raw, &("p".into(), "c".into()), false);
        (line.ts, line.text)
    }

    fn query(since_seconds: Option<i64>, since_time: Option<&str>) -> LogQuery {
        LogQuery {
            context: "c".into(),
            targets: vec![],
            follow: true,
            tail_lines: Some(10),
            since_seconds,
            since_time: since_time.map(Into::into),
            previous: None,
            parse: None,
        }
    }

    #[test]
    fn since_time_wins_and_is_validated() {
        let target = LogTarget { namespace: "n".into(), pod: "p".into(), container: "c".into() };
        let q = query(Some(60), Some("2026-11-22T10:00:00Z"));
        let since = since_time(&q).unwrap();
        let params = log_params(&q, &target, since);
        assert_eq!((params.since_seconds, params.since_time.map(|t| t.to_string())), (None, Some("2026-11-22T10:00:00Z".into())));
        let q = query(Some(60), None);
        assert_eq!(log_params(&q, &target, since_time(&q).unwrap()).since_seconds, Some(60));
        assert!(since_time(&query(None, Some("yesterday"))).is_err());
    }

    #[test]
    fn parses_only_when_asked() {
        let raw = br#"2026-11-21T14:05:11Z {"level":"error","msg":"boom","code":7}"#;
        let plain = parse_line(raw, &("p".into(), "c".into()), false);
        assert_eq!((plain.level, plain.msg, plain.fields), (None, None, None));
        let line = parse_line(raw, &("p".into(), "c".into()), true);
        assert_eq!(line.level, Some(crate::contract::logs::LogLevel::Error));
        assert_eq!(line.msg.as_deref(), Some("boom"));
        assert_eq!(line.fields, Some(vec![("code".into(), "7".into())]));
        // a plain line stays plain
        let line = parse_line(b"2026-11-21T14:05:11Z GET / 200", &("p".into(), "c".into()), true);
        assert_eq!((line.level, line.fields), (None, None));
    }

    #[test]
    fn splits_timestamp() {
        let ts = "2026-11-21T14:05:11.123456789Z";
        assert_eq!(parse(format!("{ts} hello world\r").as_bytes()), (ts.into(), "hello world".into()));
        assert_eq!(parse(ts.as_bytes()), (ts.into(), String::new()));
        assert_eq!(parse(format!("{ts} ").as_bytes()), (ts.into(), String::new()));
        assert_eq!(parse(b"no timestamp here"), (String::new(), "no timestamp here".into()));
        assert_eq!(parse(b"\xff\xfe"), (String::new(), "\u{fffd}\u{fffd}".into()));
    }

    #[test]
    fn caps_text_on_a_char_boundary() {
        let raw = format!("2026-11-21T14:05:11Z {}", "é".repeat(MAX_LINE));
        let (_, text) = parse(raw.as_bytes());
        assert!(text.len() <= MAX_LINE && text.len() >= MAX_LINE - 1 && text.chars().all(|c| c == 'é'));
    }
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{LogEvent, LogQuery, Result};

    #[tauri::command]
    pub async fn stream_logs(
        state: tauri::State<'_, AppState>,
        query: LogQuery,
        channel: tauri::ipc::Channel<LogEvent>,
    ) -> Result<String> {
        super::stream_logs(&state, query, channel).await
    }
}
