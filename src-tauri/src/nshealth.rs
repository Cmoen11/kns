//! Namespace health (status-colors package): one cluster-wide aggregation per context, counts only.
//!
//! Four table subscriptions (`table::subscribe_table`, the same server-side Table list + watch the
//! panes use, with its backoff, relist and final `forbidden`) run across every namespace: pods,
//! deployments, statefulsets, daemonsets. Each row is kept as the few cells the fault rule reads,
//! and the counts per namespace go to the UI as one `NsHealthSnapshot` whenever they change, at
//! most once a second. A Table row is a few hundred bytes, so thousands of pods cost little; the
//! webview gets one entry per namespace that has a fault, never the rows.
//!
//! The fault rule is a port of `src/table/status.ts` (`deriveStatus` + `isFault`, the table's
//! FAULTS filter), pinned by the shared vectors in `src/table/__fixtures__/fault-vectors.json`, so a
//! badge counts the rows the faults views of that namespace show (pods plus the workload kinds; a
//! table holds one kind, so the click opens pods, or the faulty workload kind). The rule depends on age
//! (a transient state turns warn after 60s), so the counts are re-derived every 15s even when no
//! watch event arrives.
//!
//! RBAC: a kind that cannot be listed cluster-wide ends in `forbidden` (final, no retry spam). No
//! pods means state `forbidden` and no counts (the UI shows "unknown"); a forbidden workload kind
//! means `partial`. No per-namespace fallback: hundreds of watches would cost more than the badge.
use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};

use tokio::sync::mpsc;

use crate::{
    ipc::{FnSink, Gvr, NsHealth, NsHealthSnapshot, NsHealthState, Result, Row, Sink, TableEvent, TableQuery, WatchState, WorkloadFaults, WorkloadKind},
    redact::clean_untrusted,
    state::AppState,
    table,
};

/// Snapshots go out at most this often.
const EMIT_EVERY: Duration = Duration::from_secs(1);
/// The counts are re-derived this often without events (the 60s transient rule).
const REDERIVE_EVERY: Duration = Duration::from_secs(15);
const TRANSIENT_WARN_AFTER: i64 = 60;
const RESTART_WARN: i64 = 5;

// ── the fault rule: a port of src/table/status.ts ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum St {
    Ok,
    Progress,
    Warn,
    Error,
    Suspended,
    Done,
    Terminating,
    Unknown,
}

#[cfg(test)]
impl St {
    fn name(self) -> &'static str {
        match self {
            St::Ok => "ok",
            St::Progress => "progress",
            St::Warn => "warn",
            St::Error => "error",
            St::Suspended => "suspended",
            St::Done => "done",
            St::Terminating => "terminating",
            St::Unknown => "unknown",
        }
    }
}

const OK_WORDS: &[&str] = &["running", "ready", "active", "bound", "available", "healthy", "established", "true"];
const DONE_WORDS: &[&str] = &["completed", "complete", "succeeded"];
const PROGRESS_WORDS: &[&str] = &[
    "pending", "containercreating", "podinitializing", "creating", "progressing", "reconciling", "waiting", "provisioning", "starting", "updating",
    "installing", "upgrading",
];
const WARN_WORDS: &[&str] = &["released", "schedulingdisabled", "warning", "degraded"];
/// `ERROR_RE` of status.ts without the anchored alternatives (handled in `is_error_word`).
const ERROR_PARTS: &[&str] = &[
    "error", "backoff", "failed", "oomkilled", "evicted", "invalid", "lost", "deadlineexceeded", "notready", "unavailable", "containerstatusunknown",
    "cannotrun",
];

fn is_error_word(w: &str) -> bool {
    w.starts_with("err") || w == "false" || ERROR_PARTS.iter().any(|p| w.contains(p))
}

fn young(age: Option<i64>) -> bool {
    age.is_some_and(|a| a < TRANSIENT_WARN_AFTER)
}

/// `classifyWord` of status.ts.
pub fn classify_word(word: &str, age: Option<i64>) -> St {
    let w = word.trim().to_lowercase();
    if w.is_empty() || w == "<none>" || w == "<unknown>" || w == "unknown" {
        return St::Unknown;
    }
    if w == "terminating" {
        return St::Terminating;
    }
    if w == "suspended" {
        return St::Suspended;
    }
    if DONE_WORDS.contains(&w.as_str()) {
        return St::Done;
    }
    if WARN_WORDS.contains(&w.as_str()) {
        return St::Warn;
    }
    if is_error_word(&w) {
        return St::Error;
    }
    if OK_WORDS.contains(&w.as_str()) {
        return St::Ok;
    }
    if PROGRESS_WORDS.contains(&w.as_str()) || w.starts_with("init:") || w.starts_with("signal:") {
        return if young(age) || age.is_none() { St::Progress } else { St::Warn };
    }
    St::Unknown
}

/// `2/3` -> (2, 3).
pub fn parse_ratio(text: Option<&str>) -> Option<(i64, i64)> {
    let (a, b) = text?.trim().split_once('/')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// The leading integer of `5 (2m ago)`.
pub fn leading_int(text: Option<&str>) -> Option<i64> {
    let t = text?.trim_start();
    let end = t.char_indices().find(|&(i, c)| !(c.is_ascii_digit() || (i == 0 && c == '-'))).map_or(t.len(), |(i, _)| i);
    t[..end].parse().ok()
}

fn replicas(ready: i64, desired: i64, age: Option<i64>) -> St {
    if desired == 0 {
        St::Done
    } else if ready >= desired {
        St::Ok
    } else if young(age) {
        St::Progress
    } else if ready == 0 {
        St::Error
    } else {
        St::Warn
    }
}

fn pod_like(word: &str, ready: Option<&str>, restarts: Option<&str>, age: Option<i64>) -> St {
    let mut state = classify_word(word, age);
    if state == St::Ok {
        if let Some((r, n)) = parse_ratio(ready)
            && r < n
        {
            state = if young(age) {
                St::Progress
            } else if r == 0 {
                St::Error
            } else {
                St::Warn
            };
        } else if leading_int(restarts).unwrap_or(0) >= RESTART_WARN {
            state = St::Warn;
        }
    }
    state
}

/// `deriveStatus` of status.ts for the kinds health counts. `get` takes a lowercased column name.
pub fn derive<'a>(resource: &str, get: impl Fn(&str) -> Option<&'a str>, deleting: bool, age: Option<i64>) -> Option<St> {
    if deleting {
        return Some(St::Terminating);
    }
    match resource {
        "pods" => Some(pod_like(get("status").unwrap_or("Unknown"), get("ready"), get("restarts"), age)),
        "deployments" | "statefulsets" => parse_ratio(get("ready")).map(|(r, n)| replicas(r, n, age)),
        "daemonsets" | "replicasets" => match (leading_int(get("desired")), leading_int(get("ready"))) {
            (Some(d), Some(r)) => Some(replicas(r, d, age)),
            _ => None,
        },
        _ => None,
    }
}

/// `isFault` of status.ts.
pub fn is_fault(s: Option<St>) -> bool {
    matches!(s, Some(St::Warn | St::Error))
}

// ── the aggregation (pure) ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Pods,
    Workload(WorkloadKind),
}

pub const KINDS: [Kind; 4] = [
    Kind::Pods,
    Kind::Workload(WorkloadKind::Deployments),
    Kind::Workload(WorkloadKind::Statefulsets),
    Kind::Workload(WorkloadKind::Daemonsets),
];

impl Kind {
    pub fn resource(self) -> &'static str {
        match self {
            Kind::Pods => "pods",
            Kind::Workload(WorkloadKind::Deployments) => "deployments",
            Kind::Workload(WorkloadKind::Statefulsets) => "statefulsets",
            Kind::Workload(WorkloadKind::Daemonsets) => "daemonsets",
        }
    }
    fn gvr(self) -> Gvr {
        let (group, version) = if self == Kind::Pods { ("", "v1") } else { ("apps", "v1") };
        Gvr { group: group.into(), version: version.into(), resource: self.resource().into() }
    }
    /// The columns the rule reads.
    fn wanted(self) -> &'static [&'static str] {
        match self {
            Kind::Pods => &["status", "ready", "restarts"],
            Kind::Workload(WorkloadKind::Daemonsets) => &["desired", "ready"],
            Kind::Workload(_) => &["ready"],
        }
    }
}

/// What is kept of one row: its namespace, creation time and the cells the rule reads.
#[derive(Debug, Clone)]
struct Entry {
    namespace: String,
    created: Option<i64>,
    deleting: bool,
    cells: Vec<(&'static str, String)>,
}

#[derive(Default)]
struct KindRows {
    /// lowercased column name -> cell index
    columns: HashMap<String, usize>,
    rows: HashMap<String, Entry>,
    synced: bool,
    state: Option<WatchState>,
    message: Option<String>,
}

/// Every row of the four kinds, by uid. Pure apart from the clock passed in.
pub struct Aggregate {
    kinds: BTreeMap<Kind, KindRows>,
}

impl Default for Aggregate {
    fn default() -> Self {
        Self { kinds: KINDS.iter().map(|k| (*k, KindRows::default())).collect() }
    }
}

fn unix(created: Option<&str>) -> Option<i64> {
    created?.parse::<jiff::Timestamp>().ok().map(|t| t.as_second())
}

fn cell_text(v: &crate::ipc::Json) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

impl Aggregate {
    fn entry(kind: Kind, columns: &HashMap<String, usize>, row: &Row) -> Option<(String, Entry)> {
        let namespace = row.namespace.clone()?;
        let cells = kind
            .wanted()
            .iter()
            .filter_map(|c| columns.get(*c).and_then(|&i| row.cells.get(i)).map(|v| (*c, cell_text(v))))
            .collect();
        Some((row.uid.clone(), Entry { namespace, created: unix(row.created.as_deref()), deleting: row.deleting.is_some(), cells }))
    }

    /// Applies one event of `kind`'s subscription.
    pub fn apply(&mut self, kind: Kind, event: TableEvent) {
        let k = self.kinds.entry(kind).or_default();
        match event {
            TableEvent::Snapshot { columns, rows } => {
                k.columns = columns.iter().enumerate().map(|(i, c)| (c.name.to_lowercase(), i)).collect();
                k.rows = rows.iter().filter_map(|r| Self::entry(kind, &k.columns, r)).collect();
                k.synced = true;
            }
            TableEvent::Delta { upserts, deletes } => {
                for r in &upserts {
                    if let Some((uid, e)) = Self::entry(kind, &k.columns, r) {
                        k.rows.insert(uid, e);
                    }
                }
                for uid in &deletes {
                    k.rows.remove(uid);
                }
            }
            TableEvent::State { state, message } => {
                k.state = Some(state);
                k.message = message.map(|m| clean_untrusted(&m, 300));
                // a final state is as good as synced: nothing more will come
                if matches!(state, WatchState::Forbidden | WatchState::Error) {
                    k.synced = true;
                    if state == WatchState::Forbidden {
                        k.rows.clear();
                    }
                }
            }
        }
    }

    /// The snapshot at `now` (unix seconds).
    pub fn snapshot(&self, context: &str, now: i64) -> NsHealthSnapshot {
        #[derive(Default)]
        struct Acc {
            failing: u32,
            warn: u32,
            workloads: BTreeMap<WorkloadKind, (u32, u32)>,
        }
        let mut by_ns: BTreeMap<&str, Acc> = BTreeMap::new();
        let (mut pods, mut workloads) = (0u32, 0u32);
        for (kind, k) in &self.kinds {
            for e in k.rows.values() {
                match kind {
                    Kind::Pods => pods += 1,
                    Kind::Workload(_) => workloads += 1,
                }
                let get = |c: &str| e.cells.iter().find(|(n, _)| *n == c).map(|(_, v)| v.as_str());
                let st = derive(kind.resource(), get, e.deleting, e.created.map(|c| now - c));
                if !is_fault(st) {
                    continue;
                }
                let acc = by_ns.entry(e.namespace.as_str()).or_default();
                let error = st == Some(St::Error);
                match kind {
                    Kind::Pods if error => acc.failing += 1,
                    Kind::Pods => acc.warn += 1,
                    Kind::Workload(w) => {
                        let slot = acc.workloads.entry(*w).or_default();
                        if error { slot.0 += 1 } else { slot.1 += 1 }
                    }
                }
            }
        }
        let namespaces = by_ns
            .into_iter()
            .map(|(ns, a)| NsHealth {
                namespace: ns.to_string(),
                pods_failing: a.failing,
                pods_warn: a.warn,
                workloads: a.workloads.into_iter().map(|(kind, (down, degraded))| WorkloadFaults { kind, down, degraded }).collect(),
            })
            .collect();
        let (state, message) = self.state();
        NsHealthSnapshot { context: context.to_string(), state, message, namespaces, pods, workloads }
    }

    fn state(&self) -> (NsHealthState, Option<String>) {
        let pods = &self.kinds[&Kind::Pods];
        let msg = |k: Kind, r: &KindRows| Some(format!("{}: {}", k.resource(), r.message.clone().unwrap_or_else(|| "forbidden".into())));
        match pods.state {
            Some(WatchState::Forbidden) => return (NsHealthState::Forbidden, msg(Kind::Pods, pods)),
            Some(WatchState::Error) => return (NsHealthState::Error, msg(Kind::Pods, pods)),
            _ => {}
        }
        if self.kinds.values().any(|k| !k.synced) {
            return (NsHealthState::Syncing, None);
        }
        if pods.state == Some(WatchState::Reconnecting) {
            return (NsHealthState::Reconnecting, pods.message.clone());
        }
        for (kind, k) in &self.kinds {
            if matches!(k.state, Some(WatchState::Forbidden | WatchState::Error)) {
                return (NsHealthState::Partial, msg(*kind, k));
            }
        }
        (NsHealthState::Live, None)
    }
}

// ── the subscription ───────────────────────────────────────────────────────

/// Starts the health watch of `context` and returns its stream id at once (`stop_stream` ends it,
/// and so does a page reload). Snapshots go to `sink`; the first one says `syncing`.
pub async fn subscribe_ns_health(state: &AppState, context: String, sink: impl Sink<NsHealthSnapshot>) -> Result<String> {
    // builds (or reuses) the session first, so a broken kubeconfig fails the call, not the stream
    state.session(&context).await?;
    let handle = state.register_stream();
    let id = handle.id.clone();
    let app = state.clone();
    tokio::spawn(async move {
        let cancel = handle.cancel.clone();
        let (tx, mut rx) = mpsc::unbounded_channel::<(Kind, TableEvent)>();
        let mut inner = Vec::new();
        for kind in KINDS {
            let sender = tx.clone();
            let query = TableQuery { context: context.clone(), gvr: kind.gvr(), namespace: None, label_selector: None, field_selector: None };
            match table::subscribe_table(&app, query, FnSink(move |e| sender.send((kind, e)).is_ok())).await {
                Ok(id) => inner.push(id),
                Err(e) => {
                    let _ = tx.send((kind, TableEvent::State { state: WatchState::Error, message: Some(e.message) }));
                }
            }
        }
        drop(tx);
        let mut agg = Aggregate::default();
        let mut last: Option<NsHealthSnapshot> = None;
        let mut dirty = true;
        let mut derived = Instant::now();
        let mut tick = tokio::time::interval(EMIT_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                ev = rx.recv() => match ev {
                    Some((kind, e)) => {
                        agg.apply(kind, e);
                        dirty = true;
                    }
                    None => break,
                },
                _ = tick.tick() => {
                    if !dirty && derived.elapsed() < REDERIVE_EVERY {
                        continue;
                    }
                    dirty = false;
                    derived = Instant::now();
                    let snap = agg.snapshot(&context, jiff::Timestamp::now().as_second());
                    if last.as_ref() != Some(&snap) {
                        if !sink.send(snap.clone()) {
                            break;
                        }
                        last = Some(snap);
                    }
                }
            }
        }
        for id in inner {
            app.stop_stream(&id);
        }
        drop(handle);
    });
    Ok(id)
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{NsHealthSnapshot, Result};

    #[tauri::command]
    pub async fn subscribe_ns_health(state: tauri::State<'_, AppState>, context: String, channel: tauri::ipc::Channel<NsHealthSnapshot>) -> Result<String> {
        super::subscribe_ns_health(&state, context, channel).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{Column, Json};
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        resource: String,
        cells: HashMap<String, String>,
        age_sec: i64,
        #[serde(default)]
        deleting: bool,
        state: String,
    }

    #[derive(Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }

    #[test]
    fn shared_vectors_match_status_ts() {
        let v: Vectors = serde_json::from_str(include_str!("../../src/table/__fixtures__/fault-vectors.json")).expect("vectors");
        assert!(v.vectors.len() > 20);
        for x in &v.vectors {
            let st = derive(&x.resource, |c| x.cells.get(c).map(String::as_str), x.deleting, Some(x.age_sec));
            assert_eq!(st.map(St::name), Some(x.state.as_str()), "{} {:?} {}s", x.resource, x.cells, x.age_sec);
        }
    }

    #[test]
    fn helpers() {
        assert_eq!(parse_ratio(Some(" 2 / 3 ")), Some((2, 3)));
        assert_eq!(parse_ratio(Some("x")), None);
        assert_eq!(leading_int(Some("5 (2m ago)")), Some(5));
        assert_eq!(leading_int(Some("-1")), Some(-1));
        assert_eq!(leading_int(Some("abc")), None);
        assert_eq!(classify_word("Pending", None), St::Progress);
    }

    fn col(name: &str) -> Column {
        Column { name: name.into(), type_: "string".into(), format: String::new(), description: String::new(), priority: 0 }
    }
    fn row(uid: &str, ns: &str, created: &str, cells: &[&str]) -> Row {
        Row {
            uid: uid.into(),
            name: uid.into(),
            namespace: Some(ns.into()),
            created: Some(created.into()),
            deleting: None,
            labels: None,
            owners: None,
            cells: cells.iter().map(|c| Json::String((*c).into())).collect(),
        }
    }
    const OLD: &str = "2026-01-01T00:00:00Z";

    fn pods_snapshot() -> TableEvent {
        TableEvent::Snapshot {
            columns: vec![col("Name"), col("Ready"), col("Status"), col("Restarts"), col("Age")],
            rows: vec![
                row("p1", "kns-spike", OLD, &["crashy-1", "0/1", "CrashLoopBackOff", "12 (1m ago)", "1h"]),
                row("p2", "kns-spike", OLD, &["oomy-1", "0/1", "OOMKilled", "4", "1h"]),
                row("p3", "kns-spike", OLD, &["web-1", "1/1", "Running", "0", "1h"]),
                row("p4", "kns-spike", OLD, &["pend-1", "0/1", "Pending", "0", "1h"]),
                row("p5", "default", OLD, &["ok-1", "1/1", "Running", "0", "1h"]),
            ],
        }
    }

    fn synced() -> Aggregate {
        let mut a = Aggregate::default();
        a.apply(Kind::Pods, pods_snapshot());
        let deploy = TableEvent::Snapshot {
            columns: vec![col("Name"), col("Ready"), col("Up-to-date"), col("Available"), col("Age")],
            rows: vec![row("d1", "kns-spike", OLD, &["crashy", "0/1", "1", "0", "1h"]), row("d2", "kns-spike", OLD, &["web", "1/2", "2", "1", "1h"])],
        };
        a.apply(Kind::Workload(WorkloadKind::Deployments), deploy);
        a.apply(Kind::Workload(WorkloadKind::Statefulsets), TableEvent::Snapshot { columns: vec![col("Name"), col("Ready")], rows: vec![] });
        a.apply(Kind::Workload(WorkloadKind::Daemonsets), TableEvent::Snapshot { columns: vec![col("Name"), col("Desired"), col("Ready")], rows: vec![] });
        a
    }

    #[test]
    fn counts_per_namespace_and_only_faulty_ones() {
        let now = "2026-06-01T00:00:00Z".parse::<jiff::Timestamp>().unwrap().as_second();
        let s = synced().snapshot("default", now);
        assert_eq!(s.state, NsHealthState::Live);
        assert_eq!((s.pods, s.workloads), (5, 2));
        assert_eq!(s.namespaces.len(), 1, "healthy namespaces stay out");
        let ns = &s.namespaces[0];
        assert_eq!(ns.namespace, "kns-spike");
        assert_eq!((ns.pods_failing, ns.pods_warn), (2, 1));
        assert_eq!(ns.workloads, vec![WorkloadFaults { kind: WorkloadKind::Deployments, down: 1, degraded: 1 }]);
    }

    #[test]
    fn deltas_and_age_change_the_counts() {
        let mut a = synced();
        let created = "2026-06-01T00:00:00Z";
        let t0 = created.parse::<jiff::Timestamp>().unwrap().as_second();
        // a fresh Pending pod is in transit first, a fault after 60s
        a.apply(Kind::Pods, TableEvent::Delta { upserts: vec![row("p6", "games", created, &["new-1", "0/1", "Pending", "0", "1s"])], deletes: vec!["p1".into()] });
        let s = a.snapshot("default", t0 + 10);
        assert!(s.namespaces.iter().all(|n| n.namespace != "games"));
        assert_eq!(s.namespaces[0].pods_failing, 1, "p1 deleted");
        let s = a.snapshot("default", t0 + 120);
        assert_eq!(s.namespaces.iter().find(|n| n.namespace == "games").map(|n| n.pods_warn), Some(1));
    }

    #[test]
    fn states() {
        let mut a = Aggregate::default();
        assert_eq!(a.snapshot("c", 0).state, NsHealthState::Syncing);
        a.apply(Kind::Pods, TableEvent::State { state: WatchState::Forbidden, message: Some("pods is forbidden: \u{1b}[31muser\u{1b}[0m".into()) });
        let s = a.snapshot("c", 0);
        assert_eq!(s.state, NsHealthState::Forbidden);
        assert!(!s.message.unwrap().contains('\u{1b}'), "server text is cleaned");

        let mut a = synced();
        a.apply(Kind::Workload(WorkloadKind::Daemonsets), TableEvent::State { state: WatchState::Forbidden, message: None });
        assert_eq!(a.snapshot("c", 0).state, NsHealthState::Partial);
        a.apply(Kind::Pods, TableEvent::State { state: WatchState::Reconnecting, message: None });
        assert_eq!(a.snapshot("c", 0).state, NsHealthState::Reconnecting);
    }
}
