//! Local event journal, opt-in per context (§3 C2).
//!
//! While a context's journal is on and kns holds a session for it, a background watch of Warning
//! events appends one redacted JSON line per event (and per count change) to
//! `<app_data_dir>/journal/<context>.jsonl`. The file is a ring: rows older than 7 days are
//! dropped, and past 20 MB the oldest rows go. The timeline reads it (`rows_for`), so it can show
//! what happened before the API's event TTL.
//!
//! No session is built for the journal: a watch starts on `journal_set(on)` (the human, on a
//! context kns is using) or, for contexts left on, the first `journal_status` after kns connected
//! them (the UI calls it on connect). It stops with `journal_set(off)`; the file stays.
use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    fmt::Debug,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use futures::StreamExt;
use jiff::Timestamp;
use k8s_openapi::api::core::v1::Event;
use kube::{
    Api, Resource,
    api::{ListParams, WatchEvent, WatchParams},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::{
    ipc::{BackendError, BackendEvent, Gvr, Json, JournalContext, JournalStatus, ObjRef, Result, Severity, TimelineRow, TimelineSource},
    redact::{Redactor, clean_untrusted},
    state::{AppState, lock},
};

/// Rows older than this are dropped.
pub const MAX_AGE_SECS: i64 = 7 * 24 * 3600;
/// A file past this size is cut back to `KEEP_BYTES` (oldest rows first).
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const KEEP_BYTES: u64 = 16 * 1024 * 1024;
const CONFIG: &str = "journal";
/// `journal` events to the UI at most this often per context.
const EMIT_EVERY: Duration = Duration::from_secs(2);

/// One journal line. `message` is cleaned and redacted before it is written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRow {
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub kind: String,
    pub name: String,
    pub reason: String,
    pub message: String,
    pub count: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Config {
    schema: u32,
    contexts: std::collections::BTreeMap<String, bool>,
}

#[derive(Debug, Clone)]
pub struct Dirs {
    /// `<app_config_dir>/rust`
    pub config: PathBuf,
    /// `<app_data_dir>`
    pub data: PathBuf,
}

#[derive(Default)]
struct Ctx {
    rows: u64,
    bytes: u64,
    counted: bool,
    watch: Option<CancellationToken>,
    last_emit: Option<Instant>,
}

#[derive(Default)]
pub struct Journal {
    dirs: Mutex<Option<Dirs>>,
    config: Mutex<Option<Config>>,
    ctx: Mutex<HashMap<String, Ctx>>,
    /// serialises file writes (append, rotation)
    write: tokio::sync::Mutex<()>,
}

// ───────────────────────── pure ─────────────────────────

/// A file name for a context: readable part plus a hash, so `a/b` and `a_b` never share a file.
pub fn file_name(context: &str) -> String {
    let readable: String = context.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).take(60).collect();
    let hash: String = Sha256::digest(context.as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{readable}-{hash}.jsonl")
}

/// The ring rule: rows older than `max_age_secs` go, then the oldest until the rest fits
/// `keep_bytes` (applied only when the lines exceed `max_bytes`). Unparsable lines go too.
pub fn rotate(lines: Vec<String>, now: &Timestamp, max_age_secs: i64, max_bytes: u64, keep_bytes: u64) -> Vec<String> {
    let oldest = now.as_second() - max_age_secs;
    let mut kept: VecDeque<String> = lines
        .into_iter()
        .filter(|l| serde_json::from_str::<JournalRow>(l).ok().and_then(|r| r.at.parse::<Timestamp>().ok()).is_some_and(|t| t.as_second() >= oldest))
        .collect();
    let size = |v: &VecDeque<String>| v.iter().map(|l| l.len() as u64 + 1).sum::<u64>();
    let mut total = size(&kept);
    if total > max_bytes {
        while total > keep_bytes {
            match kept.pop_front() {
                Some(l) => total -= l.len() as u64 + 1,
                None => break,
            }
        }
    }
    kept.into()
}

/// A Warning event (JSON of a core/v1 Event) as a journal row; `None` without a time.
pub fn row_of(e: &Json, r: &mut Redactor) -> Option<JournalRow> {
    let s = |v: &Json| v.as_str().unwrap_or_default().to_string();
    let at = [&e["lastTimestamp"], &e["series"]["lastObservedTime"], &e["eventTime"], &e["metadata"]["creationTimestamp"]]
        .iter()
        .find_map(|v| v.as_str().filter(|x| !x.is_empty()))
        .and_then(crate::timeline::norm)?;
    Some(JournalRow {
        at,
        namespace: e["involvedObject"]["namespace"].as_str().or(e["metadata"]["namespace"].as_str()).filter(|x| !x.is_empty()).map(str::to_string),
        kind: clean_untrusted(&s(&e["involvedObject"]["kind"]), 80),
        name: clean_untrusted(&s(&e["involvedObject"]["name"]), 253),
        reason: clean_untrusted(&s(&e["reason"]), 120),
        message: r.text(&clean_untrusted(&s(&e["message"]), 2048)),
        count: e["count"].as_i64().or_else(|| e["series"]["count"].as_i64()).unwrap_or(1),
    })
}

/// Journal rows of the timeline's objects: `(kind, name)` in `watched` in `namespace`, or a node
/// in `nodes`, at or after `since`.
pub fn select(lines: &str, context: &str, namespace: Option<&str>, watched: &BTreeSet<(String, String)>, nodes: &BTreeSet<String>, since: &Timestamp) -> Vec<TimelineRow> {
    lines
        .lines()
        .filter_map(|l| serde_json::from_str::<JournalRow>(l).ok())
        .filter(|row| row.at.parse::<Timestamp>().is_ok_and(|t| t >= *since))
        .filter_map(|row| {
            let node = row.kind == "Node" && nodes.contains(&row.name);
            let mine = row.namespace.as_deref() == namespace && watched.contains(&(row.kind.clone(), row.name.clone()));
            if !node && !mine {
                return None;
            }
            let obj_ref = ObjRef {
                context: context.to_string(),
                gvr: if node { Gvr::new("", "v1", "nodes") } else { gvr_of(&row.kind) },
                namespace: if node { None } else { row.namespace.clone() },
                name: row.name.clone(),
            };
            Some(TimelineRow {
                at: row.at.clone(),
                source: TimelineSource::Journal,
                what: crate::timeline::event_text(&row.kind, &row.name, &row.reason, row.count, &row.message),
                obj_ref: Some(obj_ref),
                severity: Some(Severity::Warn),
            })
        })
        .collect()
}

fn gvr_of(kind: &str) -> Gvr {
    match kind {
        "Deployment" | "ReplicaSet" | "StatefulSet" | "DaemonSet" => Gvr::new("apps", "v1", &format!("{}s", kind.to_lowercase())),
        "Job" | "CronJob" => Gvr::new("batch", "v1", &format!("{}s", kind.to_lowercase())),
        "HorizontalPodAutoscaler" => Gvr::new("autoscaling", "v2", "horizontalpodautoscalers"),
        "Service" => Gvr::new("", "v1", "services"),
        _ => Gvr::new("", "v1", "pods"),
    }
}

// ───────────────────────── dirs and config ─────────────────────────

fn slot(state: &AppState) -> std::sync::Arc<Journal> {
    state.ext::<Journal>()
}

/// Tests and examples set the directories; the app resolves them from Tauri.
pub fn set_dirs(state: &AppState, dirs: Dirs) {
    *lock(&slot(state).dirs) = Some(dirs);
}

pub fn dirs(state: &AppState) -> Result<Dirs> {
    let j = slot(state);
    if let Some(d) = lock(&j.dirs).clone() {
        return Ok(d);
    }
    use tauri::Manager;
    let app = state.app().ok_or_else(|| BackendError::internal("no app handle"))?;
    let d = Dirs {
        config: crate::rustfiles::dir(app)?,
        data: app.path().app_data_dir().map_err(|e| BackendError::config(e.to_string()))?,
    };
    *lock(&j.dirs) = Some(d.clone());
    Ok(d)
}

pub fn journal_path(dirs: &Dirs, context: &str) -> PathBuf {
    dirs.data.join("journal").join(file_name(context))
}

async fn config(state: &AppState) -> Result<Config> {
    let j = slot(state);
    if let Some(c) = lock(&j.config).clone() {
        return Ok(c);
    }
    let d = dirs(state)?;
    let c = crate::rustfiles::read::<Config>(&d.config, CONFIG).await?.unwrap_or(Config { schema: 1, ..Default::default() });
    *lock(&j.config) = Some(c.clone());
    Ok(c)
}

/// True when the journal of `context` is on (false until the config was read once).
pub fn is_on(state: &AppState, context: &str) -> bool {
    lock(&slot(state).config).as_ref().is_some_and(|c| c.contexts.get(context).copied().unwrap_or(false))
}

// ───────────────────────── file ─────────────────────────

async fn count_file(path: &Path) -> (u64, u64) {
    match tokio::fs::read(path).await {
        Ok(b) => (b.iter().filter(|c| **c == b'\n').count() as u64, b.len() as u64),
        Err(_) => (0, 0),
    }
}

/// Rewrites the file through `rotate` (start of a watch, and when it outgrew `MAX_BYTES`).
async fn rotate_file(path: &Path, max_bytes: u64) -> Result<(u64, u64)> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => return Err(e.into()),
    };
    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    let before = lines.len();
    let kept = rotate(lines, &Timestamp::now(), MAX_AGE_SECS, max_bytes, KEEP_BYTES);
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    if kept.len() != before {
        let tmp = path.with_extension("jsonl.tmp");
        tokio::fs::write(&tmp, out.as_bytes()).await?;
        tokio::fs::rename(&tmp, path).await?;
    }
    Ok((kept.len() as u64, out.len() as u64))
}

async fn append(state: &AppState, context: &str, rows: &[JournalRow]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let d = dirs(state)?;
    let path = journal_path(&d, context);
    let j = slot(state);
    let _w = j.write.lock().await;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut buf = String::new();
    for r in rows {
        buf.push_str(&serde_json::to_string(r)?);
        buf.push('\n');
    }
    let mut f = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await?;
    f.write_all(buf.as_bytes()).await?;
    f.flush().await?;
    drop(f);
    let (mut rows_now, mut bytes_now) = {
        let mut ctx = lock(&j.ctx);
        let c = ctx.entry(context.to_string()).or_default();
        c.rows += rows.len() as u64;
        c.bytes += buf.len() as u64;
        (c.rows, c.bytes)
    };
    if bytes_now > MAX_BYTES {
        (rows_now, bytes_now) = rotate_file(&path, MAX_BYTES).await?;
        let mut ctx = lock(&j.ctx);
        let c = ctx.entry(context.to_string()).or_default();
        c.rows = rows_now;
        c.bytes = bytes_now;
    }
    let emit = {
        let mut ctx = lock(&j.ctx);
        let c = ctx.entry(context.to_string()).or_default();
        let due = c.last_emit.is_none_or(|t| t.elapsed() >= EMIT_EVERY);
        if due {
            c.last_emit = Some(Instant::now());
        }
        due
    };
    if emit {
        crate::events::emit(state, BackendEvent::Journal { context: context.to_string(), rows: rows_now });
    }
    Ok(())
}

/// Journal rows for the timeline (empty when there is no journal file for the context).
pub async fn rows_for(state: &AppState, context: &str, namespace: Option<&str>, watched: &BTreeSet<(String, String)>, nodes: &BTreeSet<String>, since: &Timestamp) -> Vec<TimelineRow> {
    let Ok(d) = dirs(state) else { return Vec::new() };
    match tokio::fs::read_to_string(journal_path(&d, context)).await {
        Ok(text) => select(&text, context, namespace, watched, nodes, since),
        Err(_) => Vec::new(),
    }
}

// ───────────────────────── watch ─────────────────────────

/// Lists, then watches, `api` until `cancel` fires; `on` gets every object as JSON (with the
/// event type: `ADDED`, `MODIFIED`, `DELETED`; the initial list arrives as `ADDED`). Errors and
/// expired resourceVersions relist after a backoff (5 s doubling to 60 s). Shared with `trap.rs`.
pub(crate) async fn watch_json<K>(api: Api<K>, fields: Option<String>, labels: Option<String>, cancel: CancellationToken, mut on: impl FnMut(&str, Json))
where
    K: Resource + Clone + DeserializeOwned + Serialize + Debug + Send + 'static,
{
    let mut backoff = Duration::from_secs(5);
    'outer: loop {
        let mut lp = ListParams::default();
        if let Some(f) = &fields {
            lp = lp.fields(f);
        }
        if let Some(l) = &labels {
            lp = lp.labels(l);
        }
        let listed = tokio::select! {
            _ = cancel.cancelled() => return,
            r = api.list(&lp) => r,
        };
        let mut rv = match listed {
            Ok(list) => {
                for item in &list.items {
                    if let Ok(v) = serde_json::to_value(item) {
                        on("ADDED", v);
                    }
                }
                backoff = Duration::from_secs(5);
                list.metadata.resource_version.unwrap_or_default()
            }
            Err(_) => {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        loop {
            let mut wp = WatchParams::default().timeout(290);
            if let Some(f) = &fields {
                wp = wp.fields(f);
            }
            if let Some(l) = &labels {
                wp = wp.labels(l);
            }
            let stream = tokio::select! {
                _ = cancel.cancelled() => return,
                r = api.watch(&wp, &rv) => r,
            };
            let Ok(stream) = stream else { continue 'outer };
            let mut stream = stream.boxed();
            loop {
                let next = tokio::select! {
                    _ = cancel.cancelled() => return,
                    n = stream.next() => n,
                };
                match next {
                    None => break,
                    Some(Ok(WatchEvent::Added(o))) => emit_obj(&mut on, "ADDED", &o, &mut rv),
                    Some(Ok(WatchEvent::Modified(o))) => emit_obj(&mut on, "MODIFIED", &o, &mut rv),
                    Some(Ok(WatchEvent::Deleted(o))) => emit_obj(&mut on, "DELETED", &o, &mut rv),
                    Some(Ok(WatchEvent::Bookmark(b))) => rv = b.metadata.resource_version,
                    // 410 Gone and friends: relist
                    Some(Ok(WatchEvent::Error(_))) | Some(Err(_)) => {
                        tokio::select! {
                            _ = cancel.cancelled() => return,
                            _ = tokio::time::sleep(backoff) => {}
                        }
                        backoff = (backoff * 2).min(Duration::from_secs(60));
                        continue 'outer;
                    }
                }
            }
        }
    }
}

fn emit_obj<K: Resource + Serialize>(on: &mut impl FnMut(&str, Json), ty: &str, o: &K, rv: &mut String) {
    if let Some(v) = o.meta().resource_version.clone() {
        *rv = v;
    }
    if let Ok(v) = serde_json::to_value(o) {
        on(ty, v);
    }
}

/// Starts the watch of `context` unless it runs. Needs a built session (never builds one).
fn start_watch(state: &AppState, context: &str) {
    let j = slot(state);
    {
        let mut ctx = lock(&j.ctx);
        let c = ctx.entry(context.to_string()).or_default();
        if c.watch.is_some() {
            return;
        }
        c.watch = Some(CancellationToken::new());
    }
    let cancel = lock(&j.ctx).get(context).and_then(|c| c.watch.clone()).unwrap_or_default();
    let state = state.clone();
    let context = context.to_string();
    tauri::async_runtime::spawn(async move {
        let session = match state.session(&context).await {
            Ok(s) => s,
            Err(_) => {
                if let Some(c) = lock(&slot(&state).ctx).get_mut(&context) {
                    c.watch = None;
                }
                return;
            }
        };
        if let Ok(d) = dirs(&state)
            && let Ok((rows, bytes)) = rotate_file(&journal_path(&d, &context), MAX_BYTES).await
        {
            let j = slot(&state);
            let mut ctx = lock(&j.ctx);
            let c = ctx.entry(context.clone()).or_default();
            c.rows = rows;
            c.bytes = bytes;
            c.counted = true;
        }
        // `uid:count` already written: the initial list and every relist repeat events
        let mut seen: HashSet<String> = HashSet::new();
        let mut order: VecDeque<String> = VecDeque::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<JournalRow>();
        let writer_state = state.clone();
        let writer_ctx = context.clone();
        let writer = tauri::async_runtime::spawn(async move {
            while let Some(first) = rx.recv().await {
                let mut batch = vec![first];
                while let Ok(more) = rx.try_recv() {
                    batch.push(more);
                }
                let _ = append(&writer_state, &writer_ctx, &batch).await;
            }
        });
        let api: Api<Event> = Api::all(session.client.clone());
        watch_json(api, Some("type=Warning".into()), None, cancel, |ty, e| {
            if ty == "DELETED" {
                return;
            }
            let key = format!("{}:{}", e["metadata"]["uid"].as_str().unwrap_or_default(), e["count"].as_i64().or_else(|| e["series"]["count"].as_i64()).unwrap_or(1));
            if !seen.insert(key.clone()) {
                return;
            }
            order.push_back(key);
            if order.len() > 20_000
                && let Some(old) = order.pop_front()
            {
                seen.remove(&old);
            }
            let mut r = Redactor::new();
            if let Some(row) = row_of(&e, &mut r) {
                let _ = tx.send(row);
            }
        })
        .await;
        drop(writer);
    });
}

fn stop_watch(state: &AppState, context: &str) {
    if let Some(c) = lock(&slot(state).ctx).get_mut(context)
        && let Some(t) = c.watch.take()
    {
        t.cancel();
    }
}

pub async fn set(state: &AppState, context: &str, on: bool) -> Result<()> {
    let mut c = config(state).await?;
    c.schema = 1;
    c.contexts.insert(context.to_string(), on);
    let d = dirs(state)?;
    crate::rustfiles::write(&d.config, CONFIG, &c).await?;
    *lock(&slot(state).config) = Some(c);
    if on {
        // the human turned it on for a context kns uses: the session is there (or built now)
        start_watch(state, context);
    } else {
        stop_watch(state, context);
    }
    let rows = lock(&slot(state).ctx).get(context).map_or(0, |c| c.rows);
    crate::events::emit(state, BackendEvent::Journal { context: context.to_string(), rows });
    Ok(())
}

pub async fn status(state: &AppState) -> Result<JournalStatus> {
    let c = config(state).await?;
    let d = dirs(state)?;
    let mut out = Vec::new();
    for (context, on) in &c.contexts {
        if *on && state.has_session(context) {
            start_watch(state, context);
        }
        let known = lock(&slot(state).ctx).get(context).map(|x| (x.counted, x.rows, x.bytes));
        let (rows, bytes) = match known {
            Some((true, rows, bytes)) => (rows, bytes),
            _ => {
                let (rows, bytes) = count_file(&journal_path(&d, context)).await;
                let j = slot(state);
                let mut ctx = lock(&j.ctx);
                let x = ctx.entry(context.clone()).or_default();
                x.rows = rows;
                x.bytes = bytes;
                x.counted = true;
                (rows, bytes)
            }
        };
        if *on || rows > 0 {
            out.push(JournalContext { context: context.clone(), on: *on, rows, bytes });
        }
    }
    Ok(JournalStatus { contexts: out })
}

pub mod cmd {
    use crate::{
        ipc::{JournalStatus, Result},
        state::AppState,
    };

    #[tauri::command]
    pub async fn journal_set(state: tauri::State<'_, AppState>, context: String, on: bool) -> Result<()> {
        super::set(&state, &context, on).await
    }

    #[tauri::command]
    pub async fn journal_status(state: tauri::State<'_, AppState>) -> Result<JournalStatus> {
        super::status(&state).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn line(at: &str, name: &str) -> String {
        serde_json::to_string(&JournalRow { at: at.into(), namespace: Some("ns".into()), kind: "Pod".into(), name: name.into(), reason: "BackOff".into(), message: "m".into(), count: 1 }).unwrap()
    }

    #[test]
    fn rotation_drops_old_rows_then_oldest_past_the_size() {
        let now: Timestamp = "2026-11-22T12:00:00Z".parse().unwrap();
        let lines = vec![line("2026-11-10T00:00:00Z", "ancient"), "not json".into(), line("2026-11-21T00:00:00Z", "a"), line("2026-11-22T00:00:00Z", "b"), line("2026-11-22T11:00:00Z", "c")];
        // by age only
        let kept = rotate(lines.clone(), &now, MAX_AGE_SECS, MAX_BYTES, KEEP_BYTES);
        assert_eq!(kept.len(), 3);
        assert!(kept[0].contains("\"a\""));
        // over the size: the oldest go until the rest fits
        let one = line("2026-11-22T11:00:00Z", "c").len() as u64 + 1;
        let kept = rotate(lines, &now, MAX_AGE_SECS, one * 2, one * 2);
        assert_eq!(kept.len(), 2);
        assert!(kept[0].contains("\"b\"") && kept[1].contains("\"c\""));
    }

    #[test]
    fn rows_are_redacted_and_cleaned() {
        let e = json!({
            "metadata": { "uid": "u1", "namespace": "ns", "creationTimestamp": "2026-11-22T10:00:00Z" },
            "involvedObject": { "kind": "Pod", "name": "web\u{200b}-1", "namespace": "ns" },
            "reason": "Failed", "message": "connect postgres://app:s3cr3t-value@db:5432 failed, token=abc123def456", "count": 3,
            "lastTimestamp": "2026-11-22T10:05:00Z", "type": "Warning"
        });
        let mut r = Redactor::new();
        let row = row_of(&e, &mut r).unwrap();
        let text = serde_json::to_string(&row).unwrap();
        assert!(!text.contains("s3cr3t-value"), "{text}");
        assert!(!text.contains("abc123def456"), "{text}");
        assert_eq!(row.name, "web-1");
        assert_eq!(row.at, "2026-11-22T10:05:00Z");
        assert_eq!(row.count, 3);
    }

    #[test]
    fn select_keeps_the_timeline_objects_and_nodes() {
        let text = [line("2026-11-22T10:00:00Z", "web-1"), line("2026-11-22T10:00:00Z", "other"), line("2026-11-20T10:00:00Z", "web-1")].join("\n")
            + "\n"
            + &serde_json::to_string(&JournalRow { at: "2026-11-22T10:01:00Z".into(), namespace: None, kind: "Node".into(), name: "n1".into(), reason: "NodeNotReady".into(), message: "".into(), count: 1 }).unwrap();
        let watched: BTreeSet<(String, String)> = [("Pod".to_string(), "web-1".to_string())].into_iter().collect();
        let nodes: BTreeSet<String> = ["n1".to_string()].into_iter().collect();
        let since: Timestamp = "2026-11-22T00:00:00Z".parse().unwrap();
        let rows = select(&text, "c", Some("ns"), &watched, &nodes, &since);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].source, TimelineSource::Journal);
        assert_eq!(rows[1].obj_ref.as_ref().map(|r| r.gvr.resource.as_str()), Some("nodes"));
    }

    #[test]
    fn file_names_are_safe_and_distinct() {
        let a = file_name("arn:aws:eks:eu-north-1:123:cluster/x");
        assert!(a.ends_with(".jsonl"));
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')));
        assert_ne!(file_name("a/b"), file_name("a_b"));
        assert!(!file_name("../..").contains('/'));
    }

    #[tokio::test]
    async fn set_status_and_append_round_trip() {
        let base = std::env::temp_dir().join(format!("kns-journal-{}", std::process::id()));
        let state = AppState::default();
        set_dirs(&state, Dirs { config: base.join("rust"), data: base.join("data") });
        // off: nothing listed
        assert!(status(&state).await.unwrap().contexts.is_empty());
        // on without a session: the config is written, no watch can start
        {
            let mut c = config(&state).await.unwrap();
            c.contexts.insert("dev".into(), true);
            crate::rustfiles::write(&base.join("rust"), CONFIG, &c).await.unwrap();
            *lock(&slot(&state).config) = Some(c);
        }
        append(&state, "dev", &[serde_json::from_str(&line("2099-01-01T00:00:00Z", "web-1")).unwrap()]).await.unwrap();
        let st = status(&state).await.unwrap();
        assert_eq!(st.contexts.len(), 1);
        assert!(st.contexts[0].on);
        assert_eq!(st.contexts[0].rows, 1);
        assert!(is_on(&state, "dev"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
