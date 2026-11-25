//! Table subscriptions: paginated server-side Table list, then a Table watch whose events
//! are coalesced into deltas.
use std::{collections::HashMap, sync::Arc, time::Duration};

use futures::{AsyncBufReadExt, StreamExt};
use serde::{Deserialize, Deserializer};
use tokio::time::{Instant, sleep, sleep_until, timeout};
use tokio_util::sync::CancellationToken;

use crate::{
    ipc::{BackendError, Column, Json, OwnerRef, Result, Row, Sink, TableEvent, TableQuery, WatchState},
    session::{Session, api_path, with_query},
    state::AppState,
};

const TABLE: &str = "application/json;as=Table;g=meta.k8s.io;v=v1, application/json";
const PAGE: &str = "500";
const FLUSH_EVERY: Duration = Duration::from_millis(100);
const FLUSH_ROWS: usize = 500;
/// The server ends a watch after 300 s and bookmarks arrive about once a minute; a longer silence is a dead connection.
const WATCH_IDLE: Duration = Duration::from_secs(360);
const BACKOFF_START: Duration = Duration::from_millis(800);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Resources that cannot be watched (metrics, componentstatuses) are listed again this often.
const POLL_EVERY: Duration = Duration::from_secs(10);

/// Starts a subscription and returns its stream id at once; all progress is reported through `sink`.
pub async fn subscribe_table(state: &AppState, query: TableQuery, sink: impl Sink<TableEvent>) -> Result<String> {
    let namespaces = crate::multins::namespaces_of(&query);
    if !namespaces.is_empty() {
        return crate::multins::subscribe(state, query, namespaces, sink).await;
    }
    subscribe_one(state, query, sink).await
}

/// One subscription of one namespace (or all); `subscribe_table` without `namespaces`.
pub async fn subscribe_one(state: &AppState, query: TableQuery, sink: impl Sink<TableEvent>) -> Result<String> {
    let session = state.session(&query.context).await?;
    let handle = state.register_stream();
    let id = handle.id.clone();
    tokio::spawn(async move {
        let cancel = handle.cancel.clone();
        Subscription { session, query, sink, cancel, base: String::new(), poll: false }.run().await;
        drop(handle);
    });
    Ok(id)
}

/// One page of a Table list, as kns shows it (MCP `list_resources`, docs/plan-features.md §2.1).
#[derive(Debug, Clone)]
pub struct TableRows {
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    /// more rows exist beyond `limit`
    pub truncated: bool,
}

/// Lists at most `limit` (1..=500) rows of a resource once, without a watch. `namespace` applies
/// to namespaced resources only; `label_selector` is passed through.
pub async fn list_rows(
    state: &AppState,
    context: &str,
    gvr: &crate::ipc::Gvr,
    namespace: Option<&str>,
    label_selector: Option<&str>,
    limit: u32,
) -> Result<TableRows> {
    let session = state.session(context).await?;
    let namespaced = match session.discovery(None).await {
        Ok(d) => d.find(gvr).is_none_or(|r| r.namespaced),
        Err(_) => true,
    };
    let limit = limit.clamp(1, 500).to_string();
    let uri = with_query(
        &api_path(gvr, namespace.filter(|n| namespaced && !n.is_empty()), None),
        &[("includeObject", "Metadata"), ("labelSelector", label_selector.unwrap_or_default()), ("limit", &limit)],
    );
    let page: Doc = session.get_as(&uri, TABLE).await?;
    let columns = columns(&page);
    let truncated = page.metadata.continue_.as_str().is_some_and(|c| !c.is_empty());
    let rows = if page.is_table() {
        page.rows.into_iter().filter_map(row_from_table).collect()
    } else {
        page.items.into_iter().filter_map(|o| row_from_object(o.metadata)).collect()
    };
    Ok(TableRows { columns, rows, truncated })
}

struct Subscription<S> {
    session: Arc<Session>,
    query: TableQuery,
    sink: S,
    cancel: CancellationToken,
    /// Collection path with the selectors applied.
    base: String,
    /// The resource has no watch: stay `live` by listing it again every `POLL_EVERY`.
    poll: bool,
}

/// The subscription is over (stopped, receiver gone, or a fatal state was reported).
struct Stop;

enum WatchEnd {
    /// Server closed the watch normally: watch again from the last resourceVersion.
    Rewatch,
    /// resourceVersion too old: list again.
    Gone,
    Failed(BackendError),
}

struct Snapshot {
    columns: Vec<Column>,
    rows: Vec<Row>,
    resource_version: String,
}

enum Pending {
    Upsert(Row),
    Delete,
}

/// Watch events waiting to go out as one delta.
struct Batch {
    pending: HashMap<String, Pending>,
    /// When the buffered changes are due; `None` while nothing waits for the timer.
    flush_at: Option<Instant>,
    /// When the last delta went out.
    flushed: Option<Instant>,
}

// ───────────────────────── wire format ─────────────────────────
//
// Only the fields a row needs are named: serde skips the rest (managedFields and annotations are
// most of a Table response) without building it. No untagged/flattened types, which would buffer.

/// `null` (Go's empty slice or absent struct) reads as the default value.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de> + Default>(d: D) -> std::result::Result<T, D::Error> {
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// Object metadata. Values stay loosely typed so that one odd field cannot fail a whole page.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Meta {
    uid: Json,
    name: Json,
    namespace: Json,
    creation_timestamp: Json,
    deletion_timestamp: Json,
    labels: Json,
    owner_references: Json,
    resource_version: Json,
    #[serde(rename = "continue")]
    continue_: Json,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Object {
    #[serde(deserialize_with = "nullable")]
    metadata: Meta,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct TableRow {
    #[serde(deserialize_with = "nullable")]
    cells: Vec<Json>,
    #[serde(deserialize_with = "nullable")]
    object: Object,
}

/// Any document of the list and the watch: a `Table`, a plain list (`items`), a single object
/// (`metadata` only) or a `Status` (`code`, `reason`, `message`).
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Doc {
    kind: Json,
    #[serde(deserialize_with = "nullable")]
    metadata: Meta,
    column_definitions: Json,
    #[serde(deserialize_with = "nullable")]
    rows: Vec<TableRow>,
    #[serde(deserialize_with = "nullable")]
    items: Vec<Object>,
    code: Json,
    reason: Json,
    message: Json,
}

impl Doc {
    fn is_table(&self) -> bool {
        self.kind == "Table"
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct WatchEvent {
    #[serde(rename = "type")]
    type_: Json,
    #[serde(deserialize_with = "nullable")]
    object: Doc,
}

// ───────────────────────── subscription ─────────────────────────

impl<S: Sink<TableEvent>> Subscription<S> {
    async fn run(mut self) {
        let _ = self.run_inner().await;
    }

    async fn run_inner(&mut self) -> std::result::Result<(), Stop> {
        self.state(WatchState::Syncing, None)?;
        let cancel = self.cancel.clone();
        self.base = tokio::select! {
            _ = cancel.cancelled() => return Err(Stop),
            base = self.collection_path() => base,
        };
        let mut backoff = BACKOFF_START;
        // Whether the UI was last told `live`; a poll that merely repeats does not say it again.
        let mut live = false;
        loop {
            // (Re)list. Reached at start, whenever the watch's resourceVersion expired, and on every poll.
            let listed = tokio::select! {
                _ = self.cancel.cancelled() => return Err(Stop),
                r = self.list() => r,
            };
            let mut rv = match listed {
                Ok(snapshot) => {
                    let rv = snapshot.resource_version;
                    self.emit(TableEvent::Snapshot { columns: snapshot.columns, rows: snapshot.rows })?;
                    if !std::mem::replace(&mut live, true) {
                        self.state(WatchState::Live, None)?;
                    }
                    backoff = BACKOFF_START;
                    rv
                }
                // An expired continue token: start the list over (after a pause, should the server insist).
                Err(e) if e.code == 410 => {
                    self.pause(Duration::from_secs(1)).await?;
                    continue;
                }
                Err(e) => {
                    live = false;
                    self.fail(e, &mut backoff).await?;
                    continue;
                }
            };
            let mut degraded = false;
            while !self.poll {
                let started = Instant::now();
                match self.watch(&mut rv, &mut degraded).await? {
                    // A server that closes watches at once must not turn this into a busy loop.
                    WatchEnd::Rewatch if started.elapsed() < Duration::from_secs(1) => {
                        self.pause(Duration::from_secs(1)).await?
                    }
                    WatchEnd::Rewatch => {}
                    WatchEnd::Gone => {
                        live = false;
                        self.state(WatchState::Syncing, None)?;
                        break;
                    }
                    // The list works but the watch is not offered (and discovery did not say so): poll.
                    WatchEnd::Failed(e) if matches!(e.code, 405 | 501) => {
                        if std::mem::take(&mut degraded) {
                            self.state(WatchState::Live, None)?;
                        }
                        self.poll = true;
                    }
                    WatchEnd::Failed(e) => {
                        if started.elapsed() > BACKOFF_MAX {
                            backoff = BACKOFF_START;
                        }
                        degraded = true;
                        self.fail(e, &mut backoff).await?;
                    }
                }
            }
            if self.poll {
                self.pause(POLL_EVERY).await?;
            }
        }
    }

    fn emit(&self, event: TableEvent) -> std::result::Result<(), Stop> {
        if self.cancel.is_cancelled() || !self.sink.send(event) { Err(Stop) } else { Ok(()) }
    }

    fn state(&self, state: WatchState, message: Option<String>) -> std::result::Result<(), Stop> {
        self.emit(TableEvent::State { state, message })
    }

    async fn pause(&self, wait: Duration) -> std::result::Result<(), Stop> {
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Stop),
            _ = sleep(wait) => Ok(()),
        }
    }

    /// Reports an error. Answers that a retry cannot change are final: 403 → `forbidden`; 404, a
    /// rejected request (400/422, e.g. a selector typo) and an unsupported one (405/501) → `error`.
    /// Anything else is `reconnecting` and waits out the backoff before the caller retries.
    async fn fail(&self, e: BackendError, backoff: &mut Duration) -> std::result::Result<(), Stop> {
        match e.code {
            403 => {
                self.state(WatchState::Forbidden, Some(e.message))?;
                return Err(Stop);
            }
            400 | 404 | 405 | 422 | 501 => {
                self.state(WatchState::Error, Some(e.message))?;
                return Err(Stop);
            }
            _ => self.state(WatchState::Reconnecting, Some(e.message))?,
        }
        let wait = backoff.mul_f64(0.75 + jitter() * 0.5);
        *backoff = (*backoff * 2).min(BACKOFF_MAX);
        self.pause(wait).await
    }

    /// Resolves the collection path and whether the resource has to be polled.
    async fn collection_path(&mut self) -> String {
        let q = &self.query;
        // The namespace only applies to namespaced resources. A resource discovery does not know
        // is taken at face value (namespaced, watchable): the server has the last word.
        let mut namespaced = true;
        if let Ok(d) = self.session.discovery(None).await
            && let Some(r) = d.find(&q.gvr)
        {
            namespaced = r.namespaced;
            self.poll = !r.verbs.is_empty() && !r.verbs.iter().any(|v| v == "watch");
        }
        let namespace = q.namespace.as_deref().filter(|_| namespaced);
        with_query(
            &api_path(&q.gvr, namespace, None),
            &[
                ("includeObject", "Metadata"),
                ("labelSelector", q.label_selector.as_deref().unwrap_or_default()),
                ("fieldSelector", q.field_selector.as_deref().unwrap_or_default()),
            ],
        )
    }

    async fn list(&self) -> Result<Snapshot> {
        let mut snapshot = Snapshot { columns: Vec::new(), rows: Vec::new(), resource_version: String::new() };
        let mut token = String::new();
        loop {
            let uri = with_query(&self.base, &[("limit", PAGE), ("continue", &token)]);
            let page: Doc = self.session.get_as(&uri, TABLE).await?;
            if snapshot.columns.is_empty() {
                snapshot.columns = columns(&page);
            }
            if page.is_table() {
                snapshot.rows.extend(page.rows.into_iter().filter_map(row_from_table));
            } else {
                snapshot.rows.extend(page.items.into_iter().filter_map(|o| row_from_object(o.metadata)));
            }
            snapshot.resource_version = text(page.metadata.resource_version).unwrap_or_default();
            token = text(page.metadata.continue_).unwrap_or_default();
            if token.is_empty() {
                return Ok(snapshot);
            }
        }
    }

    /// One watch connection. `rv` follows every event so a reconnect resumes where this one ended.
    async fn watch(&self, rv: &mut String, degraded: &mut bool) -> std::result::Result<WatchEnd, Stop> {
        let uri = with_query(
            &self.base,
            &[("watch", "1"), ("resourceVersion", rv), ("allowWatchBookmarks", "true"), ("timeoutSeconds", "300")],
        );
        let request = http::Request::get(uri)
            .header(http::header::ACCEPT, TABLE)
            // Kubernetes 1.37+ gzips a watch one member per event, which the client's decompression
            // does not decode past the first event (kube-rs opts its own watches out the same way).
            .header(http::header::ACCEPT_ENCODING, "identity")
            .body(Vec::new());
        let request = match request {
            Ok(r) => r,
            Err(e) => return Ok(WatchEnd::Failed(e.into())),
        };
        let opened = tokio::select! {
            _ = self.cancel.cancelled() => return Err(Stop),
            r = timeout(Duration::from_secs(60), self.session.client.request_stream(request)) => r,
        };
        let stream = match opened {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Ok(end_for(e.into())),
            Err(_) => return Ok(WatchEnd::Failed(BackendError::new(0, "Network", "watch request timed out"))),
        };
        if std::mem::take(degraded) {
            self.state(WatchState::Live, None)?;
        }

        let mut lines = Box::pin(stream).lines();
        let mut batch = Batch { pending: HashMap::new(), flush_at: None, flushed: None };
        let end = loop {
            let line = tokio::select! {
                _ = self.cancel.cancelled() => return Err(Stop),
                _ = async { sleep_until(batch.flush_at.unwrap_or_else(Instant::now)).await }, if batch.flush_at.is_some() => {
                    self.flush(&mut batch)?;
                    continue;
                }
                l = timeout(WATCH_IDLE, lines.next()) => l,
            };
            let line = match line {
                Ok(Some(Ok(l))) => l,
                Ok(Some(Err(e))) => break WatchEnd::Failed(BackendError::new(0, "Network", e.to_string())),
                Ok(None) | Err(_) => break WatchEnd::Rewatch,
            };
            if line.trim().is_empty() {
                continue;
            }
            let WatchEvent { type_: kind, object } = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(e) => break WatchEnd::Failed(BackendError::internal(format!("watch event: {e}"))),
            };
            if kind == "ERROR" {
                let code = object.code.as_u64().unwrap_or(0) as u16;
                let reason = object.reason.as_str().unwrap_or_default();
                break end_for(BackendError::from_status(code, reason, object.message.as_str().unwrap_or_default()));
            }
            // Single-object tables carry the object's resourceVersion in the table metadata.
            let is_table = object.is_table();
            let Doc { mut metadata, rows, .. } = object;
            if let Some(v) = text(metadata.resource_version.take()) {
                *rv = v;
            }
            if kind == "BOOKMARK" {
                continue;
            }
            let rows: Vec<Row> = if is_table {
                rows.into_iter().filter_map(row_from_table).collect()
            } else {
                row_from_object(metadata).into_iter().collect()
            };
            for row in rows {
                let uid = row.uid.clone();
                // Last event per uid wins, so a delete replaces a buffered upsert and is never lost.
                batch.pending.insert(uid, if kind == "DELETED" { Pending::Delete } else { Pending::Upsert(row) });
            }
            if batch.pending.is_empty() {
                continue;
            }
            // Leading edge: a change after a quiet spell goes out at once; a burst goes out at most
            // every `FLUSH_EVERY` (or as soon as `FLUSH_ROWS` have piled up).
            let due = batch.flushed.map(|at| at + FLUSH_EVERY);
            if batch.pending.len() >= FLUSH_ROWS || due.is_none_or(|due| due <= Instant::now()) {
                self.flush(&mut batch)?;
            } else if batch.flush_at.is_none() {
                batch.flush_at = due;
            }
        };
        // A relist supersedes whatever is still buffered; every other exit delivers it.
        if !matches!(end, WatchEnd::Gone) {
            self.flush(&mut batch)?;
        }
        Ok(end)
    }

    fn flush(&self, batch: &mut Batch) -> std::result::Result<(), Stop> {
        batch.flush_at = None;
        if batch.pending.is_empty() {
            return Ok(());
        }
        batch.flushed = Some(Instant::now());
        let (mut upserts, mut deletes) = (Vec::new(), Vec::new());
        for (uid, change) in batch.pending.drain() {
            match change {
                Pending::Upsert(row) => upserts.push(row),
                Pending::Delete => deletes.push(uid),
            }
        }
        self.emit(TableEvent::Delta { upserts, deletes })
    }
}

fn end_for(e: BackendError) -> WatchEnd {
    if e.code == 410 || e.reason == "Expired" || e.reason == "Gone" { WatchEnd::Gone } else { WatchEnd::Failed(e) }
}

/// Pseudo-random value in `[0, 1)`; good enough to spread reconnects.
fn jitter() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let n = std::collections::hash_map::RandomState::new().build_hasher().finish();
    (n % 1000) as f64 / 1000.0
}

fn columns(page: &Doc) -> Vec<Column> {
    let text = |v: &Json| v.as_str().unwrap_or_default().to_string();
    match page.column_definitions.as_array() {
        Some(defs) if page.is_table() => defs
            .iter()
            .map(|c| Column {
                name: text(&c["name"]),
                type_: text(&c["type"]),
                format: text(&c["format"]),
                description: text(&c["description"]),
                priority: c["priority"].as_i64().unwrap_or(0) as i32,
            })
            .collect(),
        // The server ignored the Table request: Name + Age from the object metadata.
        _ => [("Name", "string", "name"), ("Age", "date", "")]
            .into_iter()
            .map(|(name, type_, format)| Column {
                name: name.into(),
                type_: type_.into(),
                format: format.into(),
                description: String::new(),
                priority: 0,
            })
            .collect(),
    }
}

/// A non-empty string value, moved out without copying.
fn text(v: Json) -> Option<String> {
    match v {
        Json::String(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

fn row_from_table(row: TableRow) -> Option<Row> {
    row_from_meta(row.object.metadata, row.cells)
}

fn row_from_object(meta: Meta) -> Option<Row> {
    let cells = vec![meta.name.clone(), meta.creation_timestamp.clone()];
    row_from_meta(meta, cells)
}

fn row_from_meta(meta: Meta, cells: Vec<Json>) -> Option<Row> {
    let name = text(meta.name)?;
    let namespace = text(meta.namespace);
    // Virtual resources (e.g. metrics) have no uid.
    let uid = text(meta.uid).unwrap_or_else(|| format!("{}/{name}", namespace.as_deref().unwrap_or_default()));
    let labels = match meta.labels {
        // Label values may be empty; a value that is not a string is dropped.
        Json::Object(m) => Some(
            m.into_iter()
                .filter_map(|(k, v)| match v {
                    Json::String(v) => Some((k, v)),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    };
    let owners = match meta.owner_references {
        Json::Array(refs) => Some(
            refs.into_iter()
                .map(|mut o| {
                    let mut field = |key: &str| o.get_mut(key).map(Json::take).and_then(text).unwrap_or_default();
                    OwnerRef { kind: field("kind"), name: field("name"), uid: field("uid"), api_version: field("apiVersion") }
                })
                .collect(),
        ),
        _ => None,
    };
    Some(Row {
        uid,
        name,
        namespace,
        created: text(meta.creation_timestamp),
        deleting: text(meta.deletion_timestamp),
        labels,
        owners,
        cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_page_skips_what_a_row_does_not_need() {
        let page: Doc = serde_json::from_str(
            r#"{"kind":"Table","apiVersion":"meta.k8s.io/v1","metadata":{"resourceVersion":"42","continue":"next"},
            "columnDefinitions":[{"name":"Name","type":"string","format":"name","description":"d","priority":0}],
            "rows":[{"cells":["a",1,null],"object":{"kind":"PartialObjectMetadata","metadata":{
                "name":"a","namespace":"ns","uid":"u1","creationTimestamp":"2026-01-01T00:00:00Z",
                "labels":{"app":"x","empty":"","odd":7},"annotations":{"big":"..."},
                "ownerReferences":[{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"rs","uid":"u0","controller":true}],
                "managedFields":[{"manager":"m","fieldsV1":{"f:spec":{}}}]}}},
              {"cells":["nameless"],"object":{"metadata":{}}},
              {"cells":null,"object":null}]}"#,
        )
        .expect("table page");
        assert!(page.is_table());
        assert_eq!(columns(&page).len(), 1);
        assert_eq!(text(page.metadata.resource_version), Some("42".into()));
        assert_eq!(text(page.metadata.continue_), Some("next".into()));
        let rows: Vec<Row> = page.rows.into_iter().filter_map(row_from_table).collect();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!((row.uid.as_str(), row.name.as_str(), row.namespace.as_deref()), ("u1", "a", Some("ns")));
        assert_eq!(row.cells.len(), 3);
        let labels = row.labels.clone().expect("labels");
        assert_eq!(labels.len(), 2);
        assert_eq!(labels.get("empty").map(String::as_str), Some(""));
        assert_eq!(row.owners.as_ref().map(|o| (o.len(), o[0].kind.clone())), Some((1, "ReplicaSet".into())));
    }

    #[test]
    fn empty_and_plain_documents() {
        let empty: Doc = serde_json::from_str(r#"{"kind":"Table","metadata":{},"rows":null}"#).expect("empty table");
        assert!(empty.is_table() && empty.rows.is_empty());
        let list: Doc = serde_json::from_str(
            r#"{"kind":"FooList","metadata":{"resourceVersion":"7"},"items":[{"metadata":{"name":"n","creationTimestamp":"t"}}]}"#,
        )
        .expect("plain list");
        assert_eq!(columns(&list).len(), 2);
        let rows: Vec<Row> = list.items.into_iter().filter_map(|o| row_from_object(o.metadata)).collect();
        assert_eq!((rows.len(), rows[0].uid.as_str(), rows[0].cells.len()), (1, "/n", 2));
        let event: WatchEvent = serde_json::from_str(
            r#"{"type":"ERROR","object":{"kind":"Status","code":410,"reason":"Expired","message":"too old"}}"#,
        )
        .expect("error event");
        assert!(event.type_ == "ERROR" && event.object.code == 410 && event.object.reason == "Expired");
    }
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{Result, TableEvent, TableQuery};

    #[tauri::command]
    pub async fn subscribe_table(
        state: tauri::State<'_, AppState>,
        query: TableQuery,
        channel: tauri::ipc::Channel<TableEvent>,
    ) -> Result<String> {
        super::subscribe_table(&state, query, channel).await
    }
}
