//! One table over a few namespaces: a user whose RBAC grants a handful of namespaces (a team on
//! a shared cluster) cannot list across all of them, so `TableQuery.namespaces` runs one
//! subscription per namespace (`table::subscribe_one`, with its backoff, relist and final
//! states) and merges them into one stream that looks like a single subscription to the UI.
//!
//! The merge (`Merge`, pure) waits until every namespace has its first list (or ended forbidden /
//! error) before it sends one snapshot, then passes deltas through. A relist of one namespace
//! sends a fresh combined snapshot. A namespace that is forbidden contributes no rows; only when
//! every one is forbidden is the table `forbidden`.
use std::collections::HashMap;

use tokio::sync::mpsc;

use crate::{
    ipc::{Column, FnSink, Result, Row, Sink, TableEvent, TableQuery, WatchState},
    redact::clean_untrusted,
    state::AppState,
    table,
};

/// More namespaces than this are cut: the point is a team's few, not a cluster.
pub const MAX_NAMESPACES: usize = 40;

#[derive(Default)]
struct Part {
    namespace: String,
    rows: HashMap<String, Row>,
    /// its first list arrived, or it ended (forbidden / error)
    synced: bool,
    state: Option<WatchState>,
    message: Option<String>,
}

/// The merge of N namespace subscriptions of one resource. Pure: events in, events out.
pub struct Merge {
    parts: Vec<Part>,
    columns: Option<Vec<Column>>,
    snapshot_sent: bool,
    /// the last state sent, with its message
    state_sent: Option<(WatchState, Option<String>)>,
}

impl Merge {
    pub fn new(namespaces: &[String]) -> Self {
        Self {
            parts: namespaces.iter().map(|n| Part { namespace: n.clone(), ..Default::default() }).collect(),
            columns: None,
            snapshot_sent: false,
            state_sent: None,
        }
    }

    fn all_synced(&self) -> bool {
        self.parts.iter().all(|p| p.synced)
    }

    fn combined(&self) -> TableEvent {
        let mut rows: Vec<Row> = self.parts.iter().flat_map(|p| p.rows.values().cloned()).collect();
        rows.sort_by(|a, b| (a.namespace.as_deref(), a.name.as_str()).cmp(&(b.namespace.as_deref(), b.name.as_str())));
        TableEvent::Snapshot { columns: self.columns.clone().unwrap_or_default(), rows }
    }

    /// The state of the whole table and why, from the parts.
    fn state(&self) -> (WatchState, Option<String>) {
        if !self.all_synced() {
            return (WatchState::Syncing, None);
        }
        let ended = |s: Option<WatchState>| matches!(s, Some(WatchState::Forbidden | WatchState::Error));
        let denied: Vec<&str> = self.parts.iter().filter(|p| p.state == Some(WatchState::Forbidden)).map(|p| p.namespace.as_str()).collect();
        if denied.len() == self.parts.len() {
            return (WatchState::Forbidden, self.parts.first().and_then(|p| p.message.clone()));
        }
        if self.parts.iter().all(|p| ended(p.state)) {
            return (WatchState::Error, self.parts.iter().find_map(|p| p.message.clone()));
        }
        if let Some(p) = self.parts.iter().find(|p| p.state == Some(WatchState::Reconnecting)) {
            return (WatchState::Reconnecting, p.message.clone().map(|m| format!("{}: {m}", p.namespace)));
        }
        let note = (!denied.is_empty()).then(|| format!("forbidden in {}", denied.join(", ")));
        (WatchState::Live, note)
    }

    /// Applies one event of namespace `i` and returns what the merged stream sends.
    pub fn apply(&mut self, i: usize, event: TableEvent) -> Vec<TableEvent> {
        let mut out = Vec::new();
        if self.state_sent.is_none() {
            self.state_sent = Some((WatchState::Syncing, None));
            out.push(TableEvent::State { state: WatchState::Syncing, message: None });
        }
        let Some(part) = self.parts.get_mut(i) else { return out };
        let mut resnapshot = false;
        match event {
            TableEvent::Snapshot { columns, rows } => {
                if self.columns.is_none() || self.columns.as_ref().is_some_and(Vec::is_empty) {
                    self.columns = Some(columns);
                }
                part.rows = rows.into_iter().map(|r| (r.uid.clone(), r)).collect();
                part.synced = true;
                resnapshot = self.snapshot_sent;
            }
            TableEvent::Delta { upserts, deletes } => {
                for uid in &deletes {
                    part.rows.remove(uid);
                }
                for r in &upserts {
                    part.rows.insert(r.uid.clone(), r.clone());
                }
                if self.snapshot_sent {
                    out.push(TableEvent::Delta { upserts, deletes });
                }
            }
            TableEvent::State { state, message } => {
                part.state = Some(state);
                part.message = message.map(|m| clean_untrusted(&m, 300));
                if matches!(state, WatchState::Forbidden | WatchState::Error) {
                    part.synced = true;
                    if state == WatchState::Forbidden && !part.rows.is_empty() {
                        part.rows.clear();
                        resnapshot = self.snapshot_sent;
                    }
                }
            }
        }
        if (!self.snapshot_sent && self.all_synced()) || resnapshot {
            self.snapshot_sent = true;
            out.push(self.combined());
        }
        let now = self.state();
        if self.state_sent.as_ref() != Some(&now) {
            self.state_sent = Some(now.clone());
            out.push(TableEvent::State { state: now.0, message: now.1 });
        }
        out
    }
}

/// The namespaces of a query, cleaned: no empty names, no duplicates, at most `MAX_NAMESPACES`.
pub fn namespaces_of(query: &TableQuery) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in query.namespaces.iter().flatten() {
        let n = n.trim();
        if !n.is_empty() && !out.iter().any(|o| o == n) {
            out.push(n.to_string());
        }
    }
    out.truncate(MAX_NAMESPACES);
    out
}

/// Starts the merged subscription and returns its stream id at once.
pub async fn subscribe(state: &AppState, query: TableQuery, namespaces: Vec<String>, sink: impl Sink<TableEvent>) -> Result<String> {
    state.session(&query.context).await?;
    let handle = state.register_stream();
    let id = handle.id.clone();
    let app = state.clone();
    tokio::spawn(async move {
        let cancel = handle.cancel.clone();
        let (tx, mut rx) = mpsc::unbounded_channel::<(usize, TableEvent)>();
        let mut inner = Vec::new();
        for (i, ns) in namespaces.iter().enumerate() {
            let sender = tx.clone();
            let q = TableQuery { namespace: Some(ns.clone()), namespaces: None, ..query.clone() };
            match table::subscribe_one(&app, q, FnSink(move |e| sender.send((i, e)).is_ok())).await {
                Ok(id) => inner.push(id),
                Err(e) => {
                    let _ = tx.send((i, TableEvent::State { state: WatchState::Error, message: Some(e.message) }));
                }
            }
        }
        drop(tx);
        let mut merge = Merge::new(&namespaces);
        'run: loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                ev = rx.recv() => match ev {
                    Some((i, e)) => {
                        for out in merge.apply(i, e) {
                            if !sink.send(out) {
                                break 'run;
                            }
                        }
                    }
                    None => break,
                },
            }
        }
        for id in inner {
            app.stop_stream(&id);
        }
        drop(handle);
    });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(uid: &str, ns: &str) -> Row {
        Row { uid: uid.into(), name: uid.into(), namespace: Some(ns.into()), created: None, deleting: None, labels: None, owners: None, cells: vec![] }
    }

    fn snap(rows: Vec<Row>) -> TableEvent {
        TableEvent::Snapshot { columns: vec![], rows }
    }
    fn st(state: WatchState) -> TableEvent {
        TableEvent::State { state, message: None }
    }
    fn kinds(out: &[TableEvent]) -> Vec<String> {
        out.iter()
            .map(|e| match e {
                TableEvent::Snapshot { rows, .. } => format!("snapshot:{}", rows.len()),
                TableEvent::Delta { upserts, deletes } => format!("delta:+{}-{}", upserts.len(), deletes.len()),
                TableEvent::State { state, .. } => format!("{state:?}"),
            })
            .collect()
    }

    #[test]
    fn waits_for_every_namespace_then_one_snapshot() {
        let mut m = Merge::new(&["a".into(), "b".into()]);
        assert_eq!(kinds(&m.apply(0, st(WatchState::Syncing))), ["Syncing"]);
        assert!(m.apply(0, snap(vec![row("1", "a")])).is_empty());
        assert!(m.apply(1, st(WatchState::Syncing)).is_empty());
        assert_eq!(kinds(&m.apply(1, snap(vec![row("2", "b"), row("3", "b")]))), ["snapshot:3", "Live"]);
        // the inner live states change nothing
        assert!(m.apply(0, st(WatchState::Live)).is_empty());
        assert_eq!(kinds(&m.apply(1, TableEvent::Delta { upserts: vec![row("4", "b")], deletes: vec!["2".into()] })), ["delta:+1-1"]);
    }

    #[test]
    fn a_forbidden_namespace_adds_no_rows_and_all_forbidden_is_forbidden() {
        let mut m = Merge::new(&["a".into(), "b".into()]);
        m.apply(0, snap(vec![row("1", "a")]));
        let out = m.apply(1, st(WatchState::Forbidden));
        assert_eq!(kinds(&out), ["snapshot:1", "Live"]);
        let TableEvent::State { message, .. } = &out[1] else { panic!() };
        assert_eq!(message.as_deref(), Some("forbidden in b"));

        let mut all = Merge::new(&["a".into(), "b".into()]);
        all.apply(0, st(WatchState::Forbidden));
        assert_eq!(kinds(&all.apply(1, st(WatchState::Forbidden))), ["snapshot:0", "Forbidden"]);
    }

    #[test]
    fn a_relist_sends_a_fresh_combined_snapshot() {
        let mut m = Merge::new(&["a".into(), "b".into()]);
        m.apply(0, snap(vec![row("1", "a")]));
        m.apply(1, snap(vec![row("2", "b")]));
        assert_eq!(kinds(&m.apply(0, snap(vec![row("5", "a"), row("6", "a")]))), ["snapshot:3"]);
        assert_eq!(kinds(&m.apply(1, st(WatchState::Reconnecting))), ["Reconnecting"]);
        assert_eq!(kinds(&m.apply(1, st(WatchState::Live))), ["Live"]);
    }

    #[test]
    fn namespaces_are_cleaned() {
        let q = TableQuery {
            context: "c".into(),
            gvr: crate::ipc::Gvr { group: "".into(), version: "v1".into(), resource: "pods".into() },
            namespace: None,
            namespaces: Some(vec!["a".into(), " ".into(), "a".into(), "b".into()]),
            label_selector: None,
            field_selector: None,
        };
        assert_eq!(namespaces_of(&q), ["a", "b"]);
    }
}
