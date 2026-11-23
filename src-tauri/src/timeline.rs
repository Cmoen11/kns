//! What happened to an object, in order (§3 C2).
//!
//! Two layers, as in `diagnose.rs`. The fetch layer (`timeline`) reads the object, its owners, its
//! pods and their nodes, the Deployment's ReplicaSets, HPAs that scale it, its Flux
//! Kustomization, the namespace's events and the local journal; a side read that fails is skipped,
//! never an error. The row builders and `merge` are pure and tested. Every `what` passes
//! `clean_untrusted` and the Redactor, so the webview and the MCP tool get the same safe text.
use std::collections::{BTreeSet, HashSet};

use jiff::Timestamp;

use crate::{
    ipc::{EventRow, Gvr, Json, ObjRef, Result, Severity, TimelineRow, TimelineSource, take_array},
    objects,
    redact::{Redactor, clean_untrusted},
    session::{Session, api_path, with_query},
    state::AppState,
};

/// Rows returned at most (the newest are kept).
pub const MAX_ROWS: usize = 500;
/// The window kns can look back (the journal keeps 7 days).
pub const MAX_MINUTES: u32 = 7 * 24 * 60;
/// Pods followed for a workload or Service (container and node rows).
const MAX_PODS: usize = 10;
/// Nodes whose events are read.
const MAX_NODES: usize = 3;

fn s(v: &Json) -> &str {
    v.as_str().unwrap_or_default()
}

fn arr(v: &Json) -> &[Json] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// RFC3339 → normalised UTC text; `None` for empty or unparsable times.
pub fn norm(t: &str) -> Option<String> {
    t.parse::<Timestamp>().ok().map(|ts| ts.to_string())
}

fn row(at: &str, source: TimelineSource, what: String, obj_ref: Option<ObjRef>, severity: Option<Severity>) -> Option<TimelineRow> {
    Some(TimelineRow { at: norm(at)?, source, what, obj_ref, severity })
}

/// `Pod/web-1: BackOff ×3: Back-off restarting failed container` (the same text for live events
/// and journal rows, so `merge` can drop a journal copy of a live event).
pub fn event_text(kind: &str, name: &str, reason: &str, count: i64, message: &str) -> String {
    let times = if count > 1 { format!(" ×{count}") } else { String::new() };
    let message = message.trim();
    if message.is_empty() { format!("{kind}/{name}: {reason}{times}") } else { format!("{kind}/{name}: {reason}{times}: {message}") }
}

/// An event as a row; `source` is `hpa` for an HPA's events, else `event`.
pub fn event_row(ev: &EventRow, obj_ref: Option<ObjRef>, source: TimelineSource) -> Option<TimelineRow> {
    let sev = if ev.type_ == "Warning" { Severity::Warn } else { Severity::Info };
    row(ev.last_seen.as_deref()?, source, event_text(&ev.object_kind, &ev.object_name, &ev.reason, ev.count, &ev.message), obj_ref, Some(sev))
}

fn container_image(template: &Json) -> String {
    arr(&template["spec"]["containers"]).iter().map(|c| s(&c["image"])).collect::<Vec<_>>().join(", ")
}

fn revision(rs: &Json) -> i64 {
    s(&rs["metadata"]["annotations"]["deployment.kubernetes.io/revision"]).parse().unwrap_or(0)
}

/// One row per ReplicaSet of a Deployment, oldest first, naming the image and what changed.
pub fn replica_set_rows(base: &ObjRef, replica_sets: &[Json]) -> Vec<TimelineRow> {
    let mut sorted: Vec<&Json> = replica_sets.iter().collect();
    sorted.sort_by_key(|rs| (revision(rs), s(&rs["metadata"]["creationTimestamp"]).to_string()));
    let mut out = Vec::new();
    let mut prev: Option<String> = None;
    for rs in sorted {
        let name = s(&rs["metadata"]["name"]);
        let image = container_image(&rs["spec"]["template"]);
        let rev = revision(rs);
        let rev = if rev > 0 { format!(" (revision {rev})") } else { String::new() };
        let what = match &prev {
            Some(p) if *p != image => format!("ReplicaSet {name} created{rev}: image {p} → {image}"),
            _ => format!("ReplicaSet {name} created{rev}: {image}"),
        };
        let r = ObjRef { context: base.context.clone(), gvr: Gvr::new("apps", "v1", "replicasets"), namespace: base.namespace.clone(), name: name.to_string() };
        out.extend(row(s(&rs["metadata"]["creationTimestamp"]), TimelineSource::ReplicaSet, what, Some(r), Some(Severity::Info)));
        prev = Some(image);
    }
    out
}

fn lived(started: &str, finished: &str) -> Option<String> {
    let a = started.parse::<Timestamp>().ok()?;
    let b = finished.parse::<Timestamp>().ok()?;
    Some(crate::diagnose::human(b.as_second() - a.as_second()))
}

fn terminated_text(container: &str, t: &Json) -> (String, Severity) {
    let code = t["exitCode"].as_i64().unwrap_or(0);
    let reason = s(&t["reason"]);
    let reason = if reason.is_empty() { crate::diagnose::exit_meaning(code) } else { reason.to_string() };
    let after = lived(s(&t["startedAt"]), s(&t["finishedAt"])).map(|l| format!(" after {l}")).unwrap_or_default();
    let sev = if code == 0 { Severity::Info } else if reason == "OOMKilled" { Severity::Error } else { Severity::Warn };
    (format!("container {container} terminated: exit {code} ({reason}){after}"), sev)
}

/// Pod lifecycle rows: created, scheduled/ready transitions, container starts and terminations.
pub fn pod_rows(pod_ref: &ObjRef, pod: &Json) -> Vec<TimelineRow> {
    let mut out = Vec::new();
    let r = || Some(pod_ref.clone());
    let name = &pod_ref.name;
    out.extend(row(s(&pod["metadata"]["creationTimestamp"]), TimelineSource::Container, format!("pod {name} created"), r(), Some(Severity::Info)));
    for c in arr(&pod["status"]["conditions"]) {
        let ty = s(&c["type"]);
        if !matches!(ty, "PodScheduled" | "Ready") {
            continue;
        }
        let ok = s(&c["status"]) == "True";
        let reason = s(&c["reason"]);
        let what = if reason.is_empty() { format!("pod {name} {ty}={}", s(&c["status"])) } else { format!("pod {name} {ty}={} ({reason})", s(&c["status"])) };
        out.extend(row(s(&c["lastTransitionTime"]), TimelineSource::Container, what, r(), Some(if ok { Severity::Info } else { Severity::Warn })));
    }
    for key in ["initContainerStatuses", "containerStatuses"] {
        for cs in arr(&pod["status"][key]) {
            let cname = s(&cs["name"]);
            let restarts = cs["restartCount"].as_i64().unwrap_or(0);
            if let Some(started) = cs["state"]["running"]["startedAt"].as_str() {
                let again = if restarts > 0 { format!(" (restart {restarts})") } else { String::new() };
                out.extend(row(started, TimelineSource::Container, format!("container {cname} started{again}"), r(), Some(Severity::Info)));
            }
            for t in [&cs["state"]["terminated"], &cs["lastState"]["terminated"]] {
                if t.is_null() {
                    continue;
                }
                let (what, sev) = terminated_text(cname, t);
                out.extend(row(s(&t["finishedAt"]), TimelineSource::Container, what, r(), Some(sev)));
            }
        }
    }
    if s(&pod["status"]["reason"]) == "Evicted" {
        let msg = s(&pod["status"]["message"]);
        let at = arr(&pod["status"]["conditions"]).iter().map(|c| s(&c["lastTransitionTime"])).max().unwrap_or_default();
        out.extend(row(at, TimelineSource::Container, format!("pod {name} evicted: {msg}"), r(), Some(Severity::Error)));
    }
    out
}

/// A Flux Kustomization's last applied revision.
pub fn flux_rows(ks_ref: &ObjRef, ks: &Json) -> Vec<TimelineRow> {
    let mut out = Vec::new();
    let ready = arr(&ks["status"]["conditions"]).iter().find(|c| s(&c["type"]) == "Ready");
    let revision = s(&ks["status"]["lastAppliedRevision"]);
    if let Some(c) = ready {
        let ok = s(&c["status"]) == "True";
        let what = if revision.is_empty() {
            format!("Kustomization {}: Ready={} {}", ks_ref.name, s(&c["status"]), s(&c["message"]))
        } else {
            format!("Kustomization {} applied revision {revision} (Ready={})", ks_ref.name, s(&c["status"]))
        };
        out.extend(row(s(&c["lastTransitionTime"]), TimelineSource::Flux, what.trim().to_string(), Some(ks_ref.clone()), Some(if ok { Severity::Info } else { Severity::Warn })));
    }
    out
}

/// Sorted oldest first, rows before `since` dropped, duplicates (same time and text; a journal
/// copy of a live event) dropped keeping the first source, the newest `MAX_ROWS` kept. Every
/// `what` is cleaned and redacted.
pub fn merge(rows: Vec<TimelineRow>, since: &Timestamp, r: &mut Redactor) -> Vec<TimelineRow> {
    let mut seen = HashSet::new();
    let mut out: Vec<(Timestamp, TimelineRow)> = rows
        .into_iter()
        .filter_map(|row| {
            let at = row.at.parse::<Timestamp>().ok()?;
            (at >= *since).then_some((at, row))
        })
        .filter(|(at, row)| seen.insert((*at, row.what.clone())))
        .collect();
    // stable: equal times keep their input order (events before journal rows)
    out.sort_by_key(|(at, _)| *at);
    let skip = out.len().saturating_sub(MAX_ROWS);
    out.into_iter()
        .skip(skip)
        .map(|(_, mut row)| {
            row.what = r.text(&clean_untrusted(&row.what, 1024));
            row
        })
        .collect()
}

// ───────────────────────── fetch ─────────────────────────

async fn list(session: &Session, gvr: &Gvr, ns: Option<&str>, selector: Option<&str>) -> Option<Vec<Json>> {
    let params: Vec<(&str, &str)> = selector.map(|sel| vec![("labelSelector", sel)]).unwrap_or_default();
    let uri = with_query(&api_path(gvr, ns, None), &params);
    session.get(&uri).await.ok().map(|mut l| take_array(&mut l, "items"))
}

fn owner_gvr(kind: &str) -> Option<Gvr> {
    Some(match kind {
        "ReplicaSet" => Gvr::new("apps", "v1", "replicasets"),
        "Deployment" => Gvr::new("apps", "v1", "deployments"),
        "StatefulSet" => Gvr::new("apps", "v1", "statefulsets"),
        "DaemonSet" => Gvr::new("apps", "v1", "daemonsets"),
        "Job" => Gvr::new("batch", "v1", "jobs"),
        "CronJob" => Gvr::new("batch", "v1", "cronjobs"),
        _ => return None,
    })
}

const KIND_OF: &[(&str, &str, &str)] = &[
    ("", "pods", "Pod"),
    ("", "services", "Service"),
    ("apps", "deployments", "Deployment"),
    ("apps", "replicasets", "ReplicaSet"),
    ("apps", "statefulsets", "StatefulSet"),
    ("apps", "daemonsets", "DaemonSet"),
    ("batch", "jobs", "Job"),
    ("batch", "cronjobs", "CronJob"),
    ("", "nodes", "Node"),
];

fn kind_of(gvr: &Gvr) -> Option<&'static str> {
    KIND_OF.iter().find(|(g, r, _)| *g == gvr.group && *r == gvr.resource).map(|(_, _, k)| *k)
}

/// The object's timeline over the last `since_minutes` (clamped to 1..=7 days).
pub async fn timeline(state: &AppState, obj_ref: &ObjRef, since_minutes: u32) -> Result<Vec<TimelineRow>> {
    let since_minutes = since_minutes.clamp(1, MAX_MINUTES);
    let since = Timestamp::now() - jiff::SignedDuration::from_secs(i64::from(since_minutes) * 60);
    let session = state.session(&obj_ref.context).await?;
    let obj = objects::get(&session, obj_ref).await?;
    let ns = obj_ref.ns().map(str::to_string);
    let mut rows: Vec<TimelineRow> = Vec::new();
    // (kind, name) of every namespaced object whose events belong on this timeline
    let mut watched: BTreeSet<(String, String)> = BTreeSet::new();
    let own_kind = kind_of(&obj_ref.gvr).map(str::to_string).or_else(|| obj["kind"].as_str().map(str::to_string)).unwrap_or_default();
    watched.insert((own_kind.clone(), obj_ref.name.clone()));
    let rref = |gvr: Gvr, name: &str| ObjRef { context: obj_ref.context.clone(), gvr, namespace: ns.clone(), name: name.to_string() };

    // owners, up to two levels (pod → ReplicaSet → Deployment, pod → Job → CronJob)
    let mut deployment: Option<(String, Json)> = (own_kind == "Deployment").then(|| (obj_ref.name.clone(), obj.clone()));
    let mut cursor = obj.clone();
    for _ in 0..2 {
        let Some(owner) = arr(&cursor["metadata"]["ownerReferences"]).iter().find(|o| o["controller"].as_bool() == Some(true)).cloned() else { break };
        let (kind, name) = (s(&owner["kind"]).to_string(), s(&owner["name"]).to_string());
        let Some(gvr) = owner_gvr(&kind) else { break };
        watched.insert((kind.clone(), name.clone()));
        let Ok(next) = objects::get(&session, &rref(gvr, &name)).await else { break };
        if kind == "Deployment" {
            deployment = Some((name, next.clone()));
        }
        cursor = next;
    }

    // a Deployment's ReplicaSets: image changes, and their events (created / deleted pods)
    if let Some((dname, dep)) = &deployment {
        let uid = s(&dep["metadata"]["uid"]);
        let sel = crate::diagnose::selector_string(&dep["spec"]["selector"]);
        if let Some(all) = list(&session, &Gvr::new("apps", "v1", "replicasets"), ns.as_deref(), sel.as_deref()).await {
            let owned: Vec<Json> = all.into_iter().filter(|r| arr(&r["metadata"]["ownerReferences"]).iter().any(|o| s(&o["uid"]) == uid)).collect();
            for r in &owned {
                watched.insert(("ReplicaSet".into(), s(&r["metadata"]["name"]).to_string()));
            }
            rows.extend(replica_set_rows(&rref(Gvr::new("apps", "v1", "deployments"), dname), &owned));
        }
    }

    // pods: lifecycle rows, their events, their nodes
    let pods: Vec<Json> = if own_kind == "Pod" {
        vec![obj.clone()]
    } else {
        match objects::pods_for(state, obj_ref).await {
            Ok(list) => {
                let mut out = Vec::new();
                for p in list.into_iter().take(MAX_PODS) {
                    if let Ok(full) = objects::get(&session, &rref(Gvr::new("", "v1", "pods"), &p.name)).await {
                        out.push(full);
                    }
                }
                out
            }
            Err(_) => Vec::new(),
        }
    };
    let mut nodes: BTreeSet<String> = BTreeSet::new();
    for p in &pods {
        let pname = s(&p["metadata"]["name"]).to_string();
        watched.insert(("Pod".into(), pname.clone()));
        rows.extend(pod_rows(&rref(Gvr::new("", "v1", "pods"), &pname), p));
        if let Some(n) = p["spec"]["nodeName"].as_str() {
            nodes.insert(n.to_string());
        }
    }

    // HPAs that scale the object (or its Deployment)
    let mut hpas: HashSet<String> = HashSet::new();
    if let Some(list) = list(&session, &Gvr::new("autoscaling", "v2", "horizontalpodautoscalers"), ns.as_deref(), None).await {
        for h in list {
            let t = &h["spec"]["scaleTargetRef"];
            if watched.contains(&(s(&t["kind"]).to_string(), s(&t["name"]).to_string())) {
                let name = s(&h["metadata"]["name"]).to_string();
                watched.insert(("HorizontalPodAutoscaler".into(), name.clone()));
                hpas.insert(name);
            }
        }
    }

    // the namespace's events, one list, filtered to the objects above
    if let Ok(events) = objects::list_events(state, &obj_ref.context, ns.as_deref(), None).await {
        for ev in &events {
            if !watched.contains(&(ev.object_kind.clone(), ev.object_name.clone())) {
                continue;
            }
            let (source, gvr) = if hpas.contains(&ev.object_name) && ev.object_kind == "HorizontalPodAutoscaler" {
                (TimelineSource::Hpa, Gvr::new("autoscaling", "v2", "horizontalpodautoscalers"))
            } else {
                let gvr = KIND_OF.iter().find(|(_, _, k)| *k == ev.object_kind).map(|(g, r, _)| Gvr::new(g, "v1", r));
                (TimelineSource::Event, gvr.unwrap_or_else(|| obj_ref.gvr.clone()))
            };
            rows.extend(event_row(ev, Some(rref(gvr, &ev.object_name)), source));
        }
    }
    // node events (cluster-scoped objects; listed per node)
    for node in nodes.iter().take(MAX_NODES) {
        let nref = ObjRef { context: obj_ref.context.clone(), gvr: Gvr::new("", "v1", "nodes"), namespace: None, name: node.clone() };
        if let Ok(events) = objects::list_events(state, &obj_ref.context, None, Some(&nref)).await {
            rows.extend(events.iter().filter_map(|ev| event_row(ev, Some(nref.clone()), TimelineSource::Event)));
        }
    }

    // Flux: the Kustomization that applied the object
    let labels = &obj["metadata"]["labels"];
    let (ks_name, ks_ns) = (s(&labels["kustomize.toolkit.fluxcd.io/name"]), s(&labels["kustomize.toolkit.fluxcd.io/namespace"]));
    if !ks_name.is_empty() && !ks_ns.is_empty() {
        let ks_ref = ObjRef { context: obj_ref.context.clone(), gvr: Gvr::new("kustomize.toolkit.fluxcd.io", "v1", "kustomizations"), namespace: Some(ks_ns.into()), name: ks_name.into() };
        if let Ok(ks) = objects::get(&session, &ks_ref).await {
            rows.extend(flux_rows(&ks_ref, &ks));
        }
    }

    // the local journal: Warning events recorded while kns ran (older than the API keeps)
    rows.extend(crate::journal::rows_for(state, &obj_ref.context, ns.as_deref(), &watched, &nodes, &since).await);

    let mut r = Redactor::new();
    Ok(merge(rows, &since, &mut r))
}

pub mod cmd {
    use crate::{
        ipc::{ObjRef, Result, TimelineRow},
        state::AppState,
    };

    #[tauri::command]
    pub async fn timeline(state: tauri::State<'_, AppState>, obj_ref: ObjRef, since_minutes: u32) -> Result<Vec<TimelineRow>> {
        super::timeline(&state, &obj_ref, since_minutes).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn pod_ref() -> ObjRef {
        ObjRef { context: "c".into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some("ns".into()), name: "web-1".into() }
    }

    fn ev(kind: &str, name: &str, reason: &str, at: &str, warn: bool) -> EventRow {
        EventRow {
            type_: if warn { "Warning".into() } else { "Normal".into() },
            reason: reason.into(),
            message: "msg".into(),
            count: 2,
            last_seen: Some(at.into()),
            source: "kubelet".into(),
            object_kind: kind.into(),
            object_name: name.into(),
            namespace: Some("ns".into()),
        }
    }

    fn at(s: &str) -> Timestamp {
        s.parse().unwrap()
    }

    #[test]
    fn merge_orders_by_time_drops_old_and_duplicate_rows() {
        let rows = vec![
            event_row(&ev("Pod", "web-1", "BackOff", "2026-11-22T10:05:00Z", true), None, TimelineSource::Event).unwrap(),
            event_row(&ev("Pod", "web-1", "Pulled", "2026-11-22T10:01:00+00:00", false), None, TimelineSource::Event).unwrap(),
            event_row(&ev("Pod", "web-1", "Old", "2026-11-22T08:00:00Z", false), None, TimelineSource::Event).unwrap(),
            // the journal's copy of the BackOff event
            TimelineRow { source: TimelineSource::Journal, ..event_row(&ev("Pod", "web-1", "BackOff", "2026-11-22T10:05:00Z", true), None, TimelineSource::Event).unwrap() },
        ];
        let out = merge(rows, &at("2026-11-22T09:00:00Z"), &mut Redactor::new());
        let whats: Vec<&str> = out.iter().map(|r| r.what.as_str()).collect();
        assert_eq!(whats, vec!["Pod/web-1: Pulled ×2: msg", "Pod/web-1: BackOff ×2: msg"]);
        assert_eq!(out[1].source, TimelineSource::Event);
        assert_eq!(out[1].severity, Some(Severity::Warn));
        assert_eq!(out[0].at, "2026-11-22T10:01:00Z");
    }

    #[test]
    fn merge_redacts_and_caps() {
        let mut rows: Vec<TimelineRow> = (0..(MAX_ROWS + 20))
            .map(|i| TimelineRow { at: format!("2026-11-22T10:{:02}:{:02}Z", i / 60 % 60, i % 60), source: TimelineSource::Event, what: format!("row {i}"), obj_ref: None, severity: None })
            .collect();
        rows.push(TimelineRow { at: "2026-11-22T11:00:00Z".into(), source: TimelineSource::Journal, what: "connecting with password=hunter2 \u{202e}x".into(), obj_ref: None, severity: None });
        let out = merge(rows, &at("2026-11-22T00:00:00Z"), &mut Redactor::new());
        assert_eq!(out.len(), MAX_ROWS);
        let last = &out.last().unwrap().what;
        assert!(!last.contains("hunter2"), "{last}");
        assert!(!last.contains('\u{202e}'));
        assert_eq!(out[0].what, "row 21");
    }

    #[test]
    fn pod_rows_cover_starts_terminations_and_conditions() {
        let pod = json!({
            "metadata": { "name": "web-1", "creationTimestamp": "2026-11-22T09:00:00Z" },
            "status": {
                "conditions": [
                    { "type": "PodScheduled", "status": "True", "lastTransitionTime": "2026-11-22T09:00:01Z" },
                    { "type": "Ready", "status": "False", "reason": "ContainersNotReady", "lastTransitionTime": "2026-11-22T09:10:00Z" },
                    { "type": "Initialized", "status": "True", "lastTransitionTime": "2026-11-22T09:00:02Z" }
                ],
                "containerStatuses": [{
                    "name": "main", "restartCount": 2,
                    "state": { "running": { "startedAt": "2026-11-22T09:10:30Z" } },
                    "lastState": { "terminated": { "exitCode": 137, "reason": "OOMKilled", "startedAt": "2026-11-22T09:09:19Z", "finishedAt": "2026-11-22T09:10:00Z" } }
                }]
            }
        });
        let rows = pod_rows(&pod_ref(), &pod);
        let whats: Vec<&str> = rows.iter().map(|r| r.what.as_str()).collect();
        assert!(whats.contains(&"pod web-1 created"));
        assert!(whats.contains(&"pod web-1 Ready=False (ContainersNotReady)"));
        assert!(whats.contains(&"container main started (restart 2)"));
        assert!(whats.contains(&"container main terminated: exit 137 (OOMKilled) after 41s"), "{whats:?}");
        assert!(!whats.iter().any(|w| w.contains("Initialized")));
        let oom = rows.iter().find(|r| r.what.contains("OOMKilled")).unwrap();
        assert_eq!(oom.severity, Some(Severity::Error));
        assert_eq!(oom.source, TimelineSource::Container);
    }

    #[test]
    fn replica_set_rows_name_the_image_change() {
        let rs = |name: &str, rev: &str, at: &str, image: &str| {
            json!({ "metadata": { "name": name, "creationTimestamp": at, "annotations": { "deployment.kubernetes.io/revision": rev } },
                    "spec": { "template": { "spec": { "containers": [{ "name": "main", "image": image }] } } } })
        };
        let base = ObjRef { gvr: Gvr::new("apps", "v1", "deployments"), name: "web".into(), ..pod_ref() };
        let rows = replica_set_rows(&base, &[rs("web-2", "2", "2026-11-22T10:00:00Z", "nginx:1.27.3"), rs("web-1", "1", "2026-11-21T10:00:00Z", "nginx:1.27")]);
        assert_eq!(rows[0].what, "ReplicaSet web-1 created (revision 1): nginx:1.27");
        assert_eq!(rows[1].what, "ReplicaSet web-2 created (revision 2): image nginx:1.27 → nginx:1.27.3");
        assert_eq!(rows[1].obj_ref.as_ref().map(|r| r.gvr.resource.as_str()), Some("replicasets"));
    }

    #[test]
    fn flux_row_names_the_revision() {
        let ks_ref = ObjRef { gvr: Gvr::new("kustomize.toolkit.fluxcd.io", "v1", "kustomizations"), name: "apps".into(), namespace: Some("flux-system".into()), context: "c".into() };
        let ks = json!({ "status": { "lastAppliedRevision": "main@sha1:abc", "conditions": [{ "type": "Ready", "status": "True", "lastTransitionTime": "2026-11-22T10:00:00Z" }] } });
        let rows = flux_rows(&ks_ref, &ks);
        assert_eq!(rows[0].what, "Kustomization apps applied revision main@sha1:abc (Ready=True)");
        assert_eq!(rows[0].source, TimelineSource::Flux);
    }

    #[test]
    fn unparsable_times_give_no_row() {
        let mut e = ev("Pod", "x", "R", "", false);
        assert!(event_row(&e, None, TimelineSource::Event).is_none());
        e.last_seen = None;
        assert!(event_row(&e, None, TimelineSource::Event).is_none());
    }
}
