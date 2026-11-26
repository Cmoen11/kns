//! Data the TUI keeps: discovered resources, a live table, log lines. Pure functions here are
//! unit tested; the views and keys live in `app.rs`.
use std::collections::HashMap;

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Res {
    pub group: String,
    pub version: String,
    pub resource: String,
    pub kind: String,
    pub singular: String,
    pub namespaced: bool,
    pub short: Vec<String>,
    pub verbs: Vec<String>,
}

impl Res {
    pub fn from_value(v: &Value) -> Option<Self> {
        let s = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or_default().to_string();
        let list = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let r = Self {
            group: s("/gvr/group"),
            version: s("/gvr/version"),
            resource: s("/gvr/resource"),
            kind: s("/kind"),
            singular: s("/singular"),
            namespaced: v["namespaced"].as_bool().unwrap_or(false),
            short: list("shortNames"),
            verbs: list("verbs"),
        };
        (!r.resource.is_empty() && !r.resource.contains('/')).then_some(r)
    }

    pub fn gvr(&self) -> Value {
        json!({ "group": self.group, "version": self.version, "resource": self.resource })
    }

    pub fn can(&self, verb: &str) -> bool {
        self.verbs.iter().any(|v| v == verb)
    }

    /// `deployments.apps`, `pods`
    pub fn label(&self) -> String {
        if self.group.is_empty() { self.resource.clone() } else { format!("{}.{}", self.resource, self.group) }
    }

    pub fn is(&self, group: &str, resource: &str) -> bool {
        self.group == group && self.resource == resource
    }
}

/// Built-in resources, so the first table opens before discovery answers.
pub fn builtin(resource: &str) -> Option<Res> {
    let (group, version, kind, namespaced, short): (&str, &str, &str, bool, &[&str]) = match resource {
        "pods" => ("", "v1", "Pod", true, &["po"]),
        "deployments" => ("apps", "v1", "Deployment", true, &["deploy"]),
        "services" => ("", "v1", "Service", true, &["svc"]),
        "namespaces" => ("", "v1", "Namespace", false, &["ns"]),
        "nodes" => ("", "v1", "Node", false, &["no"]),
        _ => return None,
    };
    Some(Res {
        group: group.into(),
        version: version.into(),
        resource: resource.into(),
        kind: kind.into(),
        singular: kind.to_lowercase(),
        namespaced,
        short: short.iter().map(|s| s.to_string()).collect(),
        verbs: ["get", "list", "watch", "delete", "patch", "update"].iter().map(|s| s.to_string()).collect(),
    })
}

/// Finds a resource by plural, singular, kind, short name or `plural.group`; core and the
/// common groups win over CRDs with the same name.
pub fn lookup<'a>(all: &'a [Res], name: &str) -> Option<&'a Res> {
    let n = name.trim().to_lowercase();
    if n.is_empty() {
        return None;
    }
    let rank = |r: &Res| match r.group.as_str() {
        "" => 0,
        "apps" => 1,
        "batch" => 2,
        "networking.k8s.io" | "autoscaling" | "policy" => 3,
        g if g.ends_with(".k8s.io") => 5,
        _ => 4,
    };
    let mut hits: Vec<&Res> = all
        .iter()
        .filter(|r| {
            r.resource == n || r.singular == n || r.kind.to_lowercase() == n || r.short.contains(&n) || r.label() == n
        })
        .collect();
    hits.sort_by_key(|r| (rank(r), r.label() != n));
    hits.first().copied()
}

// ───────────────────────── table ─────────────────────────

#[derive(Debug, Clone)]
pub struct Row {
    pub uid: String,
    pub name: String,
    pub namespace: Option<String>,
    pub created: Option<String>,
    pub deleting: bool,
    pub cells: Vec<String>,
}

impl Row {
    pub fn from_value(v: &Value) -> Self {
        let cells = v["cells"].as_array().map(|a| a.iter().map(cell_text).collect()).unwrap_or_default();
        Self {
            uid: v["uid"].as_str().unwrap_or_default().to_string(),
            name: v["name"].as_str().unwrap_or_default().to_string(),
            namespace: v["namespace"].as_str().map(str::to_string),
            created: v["created"].as_str().map(str::to_string),
            deleting: v.get("deleting").is_some_and(|d| !d.is_null()),
            cells,
        }
    }
}

pub fn cell_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => clean_log(s),
        Value::Array(a) => a.iter().map(cell_text).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    }
}

#[derive(Debug, Clone)]
pub struct Column {
    pub name: String,
    /// index into `Row::cells`
    pub index: usize,
}

#[derive(Debug, Default, Clone)]
pub struct Table {
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    index: HashMap<String, usize>,
    pub state: String,
    pub message: Option<String>,
}

impl Table {
    pub fn syncing() -> Self {
        Self { state: "syncing".into(), ..Default::default() }
    }

    /// Applies a `TableEvent`. Returns true when rows changed.
    pub fn apply(&mut self, ev: &Value) -> bool {
        match ev["type"].as_str() {
            Some("snapshot") => {
                let cols = ev["columns"].as_array().cloned().unwrap_or_default();
                self.columns = cols
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c["priority"].as_i64().unwrap_or(0) == 0)
                    .map(|(i, c)| Column { name: c["name"].as_str().unwrap_or_default().to_string(), index: i })
                    .collect();
                self.rows = ev["rows"].as_array().map(|a| a.iter().map(Row::from_value).collect()).unwrap_or_default();
                self.reindex();
                true
            }
            Some("delta") => {
                for u in ev["upserts"].as_array().into_iter().flatten() {
                    let row = Row::from_value(u);
                    match self.index.get(&row.uid) {
                        Some(&i) => self.rows[i] = row,
                        None => {
                            self.index.insert(row.uid.clone(), self.rows.len());
                            self.rows.push(row);
                        }
                    }
                }
                let deletes: Vec<&str> = ev["deletes"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                if !deletes.is_empty() {
                    self.rows.retain(|r| !deletes.contains(&r.uid.as_str()));
                    self.reindex();
                }
                true
            }
            Some("state") => {
                self.state = ev["state"].as_str().unwrap_or_default().to_string();
                self.message = ev["message"].as_str().map(str::to_string);
                false
            }
            _ => false,
        }
    }

    fn reindex(&mut self) {
        self.index = self.rows.iter().enumerate().map(|(i, r)| (r.uid.clone(), i)).collect();
    }

    pub fn column(&self, name: &str) -> Option<usize> {
        self.columns.iter().find(|c| c.name.eq_ignore_ascii_case(name)).map(|c| c.index)
    }
}

/// How healthy a row looks, from its Status/Ready cells (pods) or Ready/Available (workloads).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Health {
    Ok,
    Done,
    Warn,
    Bad,
}

pub fn status_health(status: &str) -> Health {
    let s = status.to_lowercase();
    if s.is_empty() {
        return Health::Ok;
    }
    const BAD: &[&str] = &["crashloop", "error", "imagepull", "errimage", "oomkilled", "failed", "evicted", "invalid", "backoff", "unknown", "notready", "lost"];
    const WARN: &[&str] = &["pending", "containercreating", "podinitializing", "init:", "terminating", "progressing", "suspended", "waiting"];
    const DONE: &[&str] = &["completed", "succeeded", "complete"];
    if BAD.iter().any(|b| s.contains(b)) {
        Health::Bad
    } else if WARN.iter().any(|w| s.contains(w)) {
        Health::Warn
    } else if DONE.iter().any(|d| s.contains(d)) {
        Health::Done
    } else {
        Health::Ok
    }
}

/// "1/2" -> Warn when not all are ready (Done for "0/1" Completed pods is decided by status).
pub fn ready_health(ready: &str) -> Health {
    match ready.split_once('/') {
        Some((a, b)) if a.trim() != b.trim() => Health::Warn,
        _ => Health::Ok,
    }
}

pub fn row_health(table: &Table, row: &Row) -> Health {
    if row.deleting {
        return Health::Warn;
    }
    let mut h = Health::Ok;
    if let Some(i) = table.column("Status") {
        h = h.max(status_health(row.cells.get(i).map(String::as_str).unwrap_or("")));
    }
    if h == Health::Done {
        return h;
    }
    if let Some(i) = table.column("Ready") {
        h = h.max(ready_health(row.cells.get(i).map(String::as_str).unwrap_or("")));
    }
    h
}

/// `250m`, `1.5` (cores).
pub fn fmt_cpu(milli: i64) -> String {
    if milli < 1000 { format!("{milli}m") } else { format!("{:.1}", milli as f64 / 1000.0) }
}

/// `512Ki`, `34Mi`, `1.2Gi`.
pub fn fmt_mem(bytes: i64) -> String {
    const KI: f64 = 1024.0;
    let b = bytes as f64;
    if b >= KI * KI * KI {
        format!("{:.1}Gi", b / (KI * KI * KI))
    } else if b >= KI * KI {
        format!("{:.0}Mi", b / (KI * KI))
    } else {
        format!("{:.0}Ki", b / KI)
    }
}

pub fn percent(used: i64, of: i64) -> String {
    if of <= 0 { String::new() } else { format!("{}%", used * 100 / of) }
}

/// Compact age: `45s`, `12m`, `5h`, `3d`, `2y`.
pub fn age(created: &str, now: jiff::Timestamp) -> String {
    let Ok(t) = created.parse::<jiff::Timestamp>() else { return String::new() };
    let s = (now.as_second() - t.as_second()).max(0);
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m", s / 60),
        3600..86_400 => format!("{}h", s / 3600),
        86_400..31_536_000 => format!("{}d", s / 86_400),
        _ => format!("{}y", s / 31_536_000),
    }
}

/// Label selector of a workload/service object (`matchLabels` only; `matchExpressions` as `key in (...)`).
pub fn selector_of(obj: &Value) -> Option<String> {
    let sel = obj.pointer("/spec/selector")?;
    let labels = sel.get("matchLabels").or_else(|| sel.as_object().filter(|o| !o.contains_key("matchExpressions")).map(|_| sel))?;
    let mut parts: Vec<String> = labels.as_object()?.iter().filter_map(|(k, v)| v.as_str().map(|v| format!("{k}={v}"))).collect();
    for e in sel["matchExpressions"].as_array().into_iter().flatten() {
        let key = e["key"].as_str().unwrap_or_default();
        let vals: Vec<&str> = e["values"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        match e["operator"].as_str() {
            Some("In") => parts.push(format!("{key} in ({})", vals.join(","))),
            Some("NotIn") => parts.push(format!("{key} notin ({})", vals.join(","))),
            Some("Exists") => parts.push(key.to_string()),
            Some("DoesNotExist") => parts.push(format!("!{key}")),
            _ => {}
        }
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

/// Log text made safe for a cell grid: ANSI escape sequences (CSI `ESC [ … letter`, OSC
/// `ESC ] … BEL|ESC \`, two-byte `ESC x`) and other control characters removed, tabs expanded.
pub fn clean_log(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    // parameters and intermediates, then one final byte in @..~
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' || (n == '\x1b' && chars.peek() == Some(&'\\')) {
                            if n == '\x1b' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\t' => out.push_str("    "),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Case-insensitive match of every space-separated word against name, namespace and cells.
pub fn matches(row: &Row, filter: &str) -> bool {
    if filter.is_empty() {
        return true;
    }
    let hay = format!("{} {} {}", row.name, row.namespace.as_deref().unwrap_or(""), row.cells.join(" ")).to_lowercase();
    filter.to_lowercase().split_whitespace().all(|w| hay.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn res(group: &str, resource: &str, kind: &str, short: &[&str]) -> Res {
        Res {
            group: group.into(),
            version: "v1".into(),
            resource: resource.into(),
            kind: kind.into(),
            singular: kind.to_lowercase(),
            namespaced: true,
            short: short.iter().map(|s| s.to_string()).collect(),
            verbs: vec![],
        }
    }

    #[test]
    fn lookup_prefers_core_and_knows_aliases() {
        let all = vec![res("events.k8s.io", "events", "Event", &[]), res("", "events", "Event", &["ev"]), res("apps", "deployments", "Deployment", &["deploy"])];
        assert_eq!(lookup(&all, "events").unwrap().group, "");
        assert_eq!(lookup(&all, "events.events.k8s.io").unwrap().group, "events.k8s.io");
        assert_eq!(lookup(&all, "deploy").unwrap().resource, "deployments");
        assert_eq!(lookup(&all, "Deployment").unwrap().resource, "deployments");
        assert!(lookup(&all, "nope").is_none());
    }

    #[test]
    fn table_snapshot_delta_delete() {
        let mut t = Table::default();
        t.apply(&json!({ "type": "snapshot", "columns": [{ "name": "Name", "priority": 0 }, { "name": "IP", "priority": 1 }, { "name": "Status", "priority": 0 }],
            "rows": [{ "uid": "a", "name": "a", "cells": ["a", "1.2.3.4", "Running"] }] }));
        assert_eq!(t.columns.len(), 2);
        assert_eq!(t.column("status"), Some(2));
        t.apply(&json!({ "type": "delta", "upserts": [{ "uid": "b", "name": "b", "cells": ["b", "", "CrashLoopBackOff"] }, { "uid": "a", "name": "a", "cells": ["a", "", "Running"] }], "deletes": [] }));
        assert_eq!(t.rows.len(), 2);
        assert_eq!(row_health(&t, &t.rows[1]), Health::Bad);
        t.apply(&json!({ "type": "delta", "upserts": [], "deletes": ["a"] }));
        assert_eq!(t.rows.len(), 1);
        assert_eq!(t.rows[0].name, "b");
        t.apply(&json!({ "type": "delta", "upserts": [{ "uid": "b", "name": "b2", "cells": [] }], "deletes": [] }));
        assert_eq!(t.rows[0].name, "b2", "index survives a delete");
    }

    #[test]
    fn health_and_age() {
        assert_eq!(status_health("Running"), Health::Ok);
        assert_eq!(status_health("Completed"), Health::Done);
        assert_eq!(status_health("Init:0/1"), Health::Warn);
        assert_eq!(status_health("ImagePullBackOff"), Health::Bad);
        assert_eq!(ready_health("1/2"), Health::Warn);
        assert_eq!(ready_health("2/2"), Health::Ok);
        let now: jiff::Timestamp = "2026-01-02T00:00:00Z".parse().unwrap();
        assert_eq!(age("2026-01-01T00:00:00Z", now), "1d");
        assert_eq!(age("2026-01-01T23:59:30Z", now), "30s");
        assert_eq!(age("bad", now), "");
    }

    #[test]
    fn selectors() {
        assert_eq!(selector_of(&json!({ "spec": { "selector": { "matchLabels": { "app": "web" } } } })).as_deref(), Some("app=web"));
        assert_eq!(selector_of(&json!({ "spec": { "selector": { "app": "db" } } })).as_deref(), Some("app=db"), "service selector");
        let e = json!({ "spec": { "selector": { "matchLabels": { "a": "1" }, "matchExpressions": [{ "key": "t", "operator": "In", "values": ["x", "y"] }] } } });
        assert_eq!(selector_of(&e).as_deref(), Some("a=1,t in (x,y)"));
        assert_eq!(selector_of(&json!({ "spec": {} })), None);
    }

    #[test]
    fn log_cleaning() {
        assert_eq!(clean_log("\x1b[90m2026\x1b[0m \x1b[32mINF\x1b[0m ok"), "2026 INF ok");
        assert_eq!(clean_log("a\tb\r"), "a    b");
        assert_eq!(clean_log("\x1b]0;title\x07x\x1b]8;;http://a\x1b\\y"), "xy");
        assert_eq!(clean_log("æøå ✓"), "æøå ✓");
    }

    #[test]
    fn filtering() {
        let r = Row { uid: "u".into(), name: "web-1".into(), namespace: Some("shop".into()), created: None, deleting: false, cells: vec!["Running".into()] };
        assert!(matches(&r, "web run"));
        assert!(matches(&r, "SHOP"));
        assert!(!matches(&r, "db"));
    }
}
