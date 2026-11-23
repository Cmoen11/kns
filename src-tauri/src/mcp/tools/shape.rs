//! Pure shaping of tool results: raw data in, redacted and scope-filtered JSON out. No cluster
//! access, so the scope filter, the redactor and the `mustNotContain` checks are unit-tested here.
use serde_json::{Value, json};

use super::{scrub, text};
use crate::{
    ctxflags::CtxFlags,
    ipc::{Column, EventRow, Json, McpPolicy, Row},
    mcp::{policy, scope::Scope},
    redact::Redactor,
};

/// Max log lines returned (§5.2).
pub const MAX_LOG_LINES: usize = 500;

/// One context as `get_status` sees it.
pub struct CtxEntry {
    pub name: String,
    pub current: bool,
    pub connected: bool,
    pub flags: Option<CtxFlags>,
    pub stored: McpPolicy,
}

/// `get_status`: only contexts whose effective policy is not off; the rest are counted.
pub fn status(entries: &[CtxEntry], forwards: usize, active_dev_sets: &[String]) -> Json {
    let mut contexts = Vec::new();
    let mut hidden = 0;
    for e in entries {
        match policy::effective(e.stored, e.flags) {
            Some(p) if p != McpPolicy::Off => {
                let f = e.flags.unwrap_or_default();
                contexts.push(json!({
                    "name": e.name, "current": e.current, "connected": e.connected,
                    "protected": f.protected, "readOnly": f.read_only, "policy": p,
                }));
            }
            _ => hidden += 1,
        }
    }
    let mut v = json!({
        "contexts": contexts,
        "hiddenContexts": hidden,
        "server": { "name": "kns", "version": env!("CARGO_PKG_VERSION") },
        "forwards": forwards,
        "activeDevSets": active_dev_sets,
    });
    if contexts_empty(&v) {
        v["hint"] = json!("no context allows agents yet: ask the human to run \":mcp setup\" (or \":mcp policy read <context>\") in kns");
    } else if !v["contexts"].as_array().is_some_and(|c| c.iter().any(|c| c["connected"] == true)) {
        v["hint"] = json!("none of your contexts is connected in kns: ask the human to open one");
    }
    v
}

fn contexts_empty(v: &Json) -> bool {
    v["contexts"].as_array().is_none_or(Vec::is_empty)
}

/// `list_resources`: column names, rows with cleaned and redacted cells and labels, rows outside
/// the scope dropped (`filtered`).
pub fn rows(columns: &[Column], mut rows: Vec<Row>, truncated: bool, scope: &Scope, r: &mut Redactor) -> Json {
    let filtered = scope.retain(&mut rows, |row| row.namespace.as_deref());
    let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
    let out: Vec<Json> = rows
        .into_iter()
        .map(|row| {
            let mut cells = Value::Array(row.cells);
            scrub(r, &mut cells);
            let mut v = json!({ "name": text(r, &row.name), "cells": cells });
            if let Some(ns) = row.namespace {
                v["namespace"] = json!(ns);
            }
            if let Some(labels) = row.labels.filter(|l| !l.is_empty()) {
                let mut l = serde_json::to_value(labels).unwrap_or(Value::Null);
                scrub(r, &mut l);
                v["labels"] = l;
            }
            if let Some(d) = row.deleting {
                v["deleting"] = json!(d);
            }
            v
        })
        .collect();
    let mut v = json!({ "columns": names, "rows": out, "truncated": truncated });
    if filtered > 0 {
        v["filtered"] = json!(filtered);
    }
    v
}

/// `list_events`: newest first, at most `limit`, scope-filtered, messages redacted.
pub fn events(mut events: Vec<EventRow>, limit: usize, scope: &Scope, r: &mut Redactor) -> Json {
    let filtered = scope.retain(&mut events, |e| e.namespace.as_deref());
    let truncated = events.len() > limit;
    events.truncate(limit);
    let out: Vec<Json> = events
        .into_iter()
        .map(|e| {
            json!({
                "type": e.type_, "reason": text(r, &e.reason), "message": text(r, &e.message), "count": e.count,
                "lastSeen": e.last_seen, "source": text(r, &e.source),
                "object": { "kind": e.object_kind, "name": text(r, &e.object_name), "namespace": e.namespace },
            })
        })
        .collect();
    let mut v = json!({ "events": out, "truncated": truncated });
    if filtered > 0 {
        v["filtered"] = json!(filtered);
    }
    v
}

/// `get_logs`: each line cleaned and redacted **before** `grep` runs (so grepping for a secret
/// matches nothing), then the last `tail` lines kept.
pub fn logs(raw: &str, grep: Option<&str>, tail: usize, r: &mut Redactor) -> (Vec<String>, bool) {
    let tail = tail.clamp(1, MAX_LOG_LINES);
    let needle = grep.map(str::to_lowercase).filter(|g| !g.is_empty());
    let mut lines: Vec<String> = raw
        .lines()
        .map(|l| text(r, l))
        .filter(|l| needle.as_deref().is_none_or(|n| l.to_lowercase().contains(n)))
        .collect();
    let truncated = lines.len() > tail;
    if truncated {
        lines.drain(..lines.len() - tail);
    }
    (lines, truncated)
}

fn s(v: &Json) -> &str {
    v.as_str().unwrap_or_default()
}

/// `describe_object`: a kubectl-describe-like text from an object that was already redacted and
/// cleaned, plus its newest events.
pub fn describe(obj: &Json, events: &[Json]) -> String {
    let meta = &obj["metadata"];
    let mut out = String::new();
    let mut line = |k: &str, v: &str| {
        if !v.is_empty() {
            out.push_str(&format!("{k:<14}{v}\n"));
        }
    };
    line("Name:", s(&meta["name"]));
    line("Namespace:", s(&meta["namespace"]));
    line("Kind:", &format!("{} ({})", s(&obj["kind"]), s(&obj["apiVersion"])));
    line("Created:", s(&meta["creationTimestamp"]));
    if let Some(d) = meta["deletionTimestamp"].as_str() {
        line("Deleting:", d);
    }
    let map = |v: &Json| -> String {
        v.as_object().map(|m| m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default())).collect::<Vec<_>>().join(", ")).unwrap_or_default()
    };
    line("Labels:", &map(&meta["labels"]));
    if let Some(a) = meta["annotations"].as_object() {
        let keys: Vec<&str> = a.keys().map(String::as_str).collect();
        line("Annotations:", &keys.join(", "));
    }
    if let Some(owners) = meta["ownerReferences"].as_array() {
        let o: Vec<String> = owners.iter().map(|o| format!("{}/{}", s(&o["kind"]), s(&o["name"]))).collect();
        line("Owners:", &o.join(", "));
    }
    let spec = &obj["spec"];
    let status = &obj["status"];
    if let Some(r) = spec["replicas"].as_i64() {
        line(
            "Replicas:",
            &format!("{r} desired, {} ready, {} updated, {} available", status["readyReplicas"].as_i64().unwrap_or(0), status["updatedReplicas"].as_i64().unwrap_or(0), status["availableReplicas"].as_i64().unwrap_or(0)),
        );
    }
    line("Phase:", s(&status["phase"]));
    line("Node:", s(&spec["nodeName"]));
    line("Type:", s(&spec["type"]));
    if let Some(ports) = spec["ports"].as_array() {
        let p: Vec<String> = ports.iter().map(|p| format!("{} {}→{}/{}", s(&p["name"]), p["port"], p["targetPort"], s(&p["protocol"]))).collect();
        line("Ports:", &p.join(", "));
    }
    // containers: pods directly, workloads through the pod template
    let pod_spec = if spec["containers"].is_array() { spec } else { &spec["template"]["spec"] };
    let statuses = status["containerStatuses"].as_array().cloned().unwrap_or_default();
    if let Some(cs) = pod_spec["containers"].as_array() {
        out.push_str("Containers:\n");
        for c in cs {
            let name = s(&c["name"]);
            out.push_str(&format!("  {name}:\n    Image:      {}\n", s(&c["image"])));
            if let Some(st) = statuses.iter().find(|st| s(&st["name"]) == name) {
                let state = st["state"].as_object().and_then(|m| m.iter().next()).map(|(k, v)| {
                    let why = s(&v["reason"]);
                    if why.is_empty() { k.clone() } else { format!("{k} ({why})") }
                });
                out.push_str(&format!("    State:      {}\n    Ready:      {}\n    Restarts:   {}\n", state.unwrap_or_default(), st["ready"], st["restartCount"]));
                if let Some((k, v)) = st["lastState"].as_object().and_then(|m| m.iter().next()) {
                    out.push_str(&format!("    Last state: {k} ({}, exit {})\n", s(&v["reason"]), v["exitCode"]));
                }
            }
        }
    }
    if let Some(conds) = status["conditions"].as_array().filter(|c| !c.is_empty()) {
        out.push_str("Conditions:\n");
        for c in conds {
            let msg = s(&c["message"]);
            out.push_str(&format!("  {:<22}{:<7}{}{}\n", s(&c["type"]), s(&c["status"]), s(&c["reason"]), if msg.is_empty() { String::new() } else { format!(": {msg}") }));
        }
    }
    out.push_str("Events:\n");
    if events.is_empty() {
        out.push_str("  <none>\n");
    }
    for e in events {
        out.push_str(&format!("  {} {} x{} {}: {}\n", s(&e["lastSeen"]), s(&e["type"]), e["count"], s(&e["reason"]), s(&e["message"])));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact::Redactor;

    const SECRET: &str = "s3cr3t-value";

    fn flags() -> Option<CtxFlags> {
        Some(CtxFlags::default())
    }

    #[test]
    fn status_lists_only_allowed_contexts() {
        let e = |name: &str, stored, connected| CtxEntry { name: name.into(), current: name == "default", connected, flags: flags(), stored };
        let v = status(&[e("default", McpPolicy::Propose, true), e("staging", McpPolicy::Off, true), e("lab", McpPolicy::Read, false)], 0, &[]);
        let names: Vec<&str> = v["contexts"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["default", "lab"]);
        assert_eq!(v["hiddenContexts"], 1);
        assert!(v.get("hint").is_none());
        let v = status(&[e("staging", McpPolicy::Off, true)], 0, &[]);
        assert!(v["hint"].as_str().unwrap().contains(":mcp setup"));
        // read-only caps at read
        let ro = CtxEntry { name: "ro".into(), current: false, connected: true, flags: Some(CtxFlags { protected: true, read_only: true }), stored: McpPolicy::Propose };
        let v = status(&[ro], 0, &[]);
        assert_eq!(v["contexts"][0]["policy"], "read");
        assert_eq!(v["contexts"][0]["protected"], true);
        // flags not loaded: hidden
        let unk = CtxEntry { name: "u".into(), current: false, connected: true, flags: None, stored: McpPolicy::Propose };
        assert_eq!(status(&[unk], 0, &[])["hiddenContexts"], 1);
    }

    fn row(ns: &str, name: &str, cell: &str) -> Row {
        Row {
            uid: name.into(),
            name: name.into(),
            namespace: Some(ns.into()),
            created: None,
            deleting: None,
            labels: Some([("app".to_string(), name.to_string()), ("token".to_string(), SECRET.to_string())].into()),
            owners: None,
            cells: vec![json!(name), json!(cell)],
        }
    }

    #[test]
    fn rows_are_filtered_and_redacted() {
        let cols = vec![Column { name: "Name".into(), type_: "string".into(), format: "name".into(), description: String::new(), priority: 0 }];
        let mut r = Redactor::new();
        let s = Scope::new(Some(vec!["kns-spike".into()]));
        let v = rows(&cols, vec![row("kns-spike", "web", &format!("password={SECRET}")), row("kafka", "kafka", "x")], false, &s, &mut r);
        assert_eq!(v["rows"].as_array().unwrap().len(), 1);
        assert_eq!(v["filtered"], 1);
        assert!(!v.to_string().contains(SECRET), "{v}");
        assert!(r.count >= 2);
    }

    #[test]
    fn logs_grep_runs_on_redacted_text() {
        let raw = format!("start\nDB_PASSWORD={SECRET}\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123\nboom \u{1b}[31merror\u{1b}[0m\n");
        let mut r = Redactor::new();
        let (lines, _) = logs(&raw, Some(SECRET), 100, &mut r);
        assert!(lines.is_empty(), "grep for a masked value matches nothing: {lines:?}");
        let (lines, truncated) = logs(&raw, None, 100, &mut r);
        let all = lines.join("\n");
        assert!(!all.contains(SECRET) && !all.contains("eyJzdWIiOiIxIn0") && !all.contains('\u{1b}'), "{all}");
        assert!(!truncated);
        let (lines, truncated) = logs(&raw, Some("ERROR"), 100, &mut r);
        assert_eq!(lines, vec!["boom error".to_string()]);
        assert!(!truncated);
        let many: String = (0..1000).map(|i| format!("l{i}\n")).collect();
        let (lines, truncated) = logs(&many, None, 9999, &mut r);
        assert_eq!(lines.len(), MAX_LOG_LINES);
        assert_eq!(lines.last().unwrap(), "l999");
        assert!(truncated);
    }

    #[test]
    fn events_filtered_and_capped() {
        let ev = |ns: &str, msg: &str| EventRow {
            type_: "Warning".into(),
            reason: "BackOff".into(),
            message: msg.into(),
            count: 2,
            last_seen: Some("2026-11-22T10:00:00Z".into()),
            source: "kubelet".into(),
            object_kind: "Pod".into(),
            object_name: "crashy".into(),
            namespace: Some(ns.into()),
        };
        let mut r = Redactor::new();
        let s = Scope::new(Some(vec!["a".into()]));
        let v = events(vec![ev("a", &format!("token={SECRET}")), ev("b", "x"), ev("a", "y"), ev("a", "z")], 2, &s, &mut r);
        assert_eq!(v["events"].as_array().unwrap().len(), 2);
        assert_eq!(v["truncated"], true);
        assert_eq!(v["filtered"], 1);
        assert!(!v.to_string().contains(SECRET));
    }

    #[test]
    fn describe_text_from_a_pod() {
        let pod = json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": "crashy", "namespace": "kns-spike", "labels": { "app": "crashy" }, "ownerReferences": [{ "kind": "ReplicaSet", "name": "crashy-1" }] },
            "spec": { "nodeName": "n1", "containers": [{ "name": "app", "image": "busybox:1.37.0" }] },
            "status": { "phase": "Running", "containerStatuses": [{ "name": "app", "ready": false, "restartCount": 7,
                "state": { "waiting": { "reason": "CrashLoopBackOff" } }, "lastState": { "terminated": { "reason": "Error", "exitCode": 1 } } }],
                "conditions": [{ "type": "Ready", "status": "False", "reason": "ContainersNotReady" }] }
        });
        let t = describe(&pod, &[json!({ "lastSeen": "t", "type": "Warning", "count": 3, "reason": "BackOff", "message": "restarting" })]);
        for want in ["Name:         crashy", "waiting (CrashLoopBackOff)", "Restarts:   7", "terminated (Error, exit 1)", "ReplicaSet/crashy-1", "BackOff: restarting", "Ready"] {
            assert!(t.contains(want), "{want} in\n{t}");
        }
    }
}
