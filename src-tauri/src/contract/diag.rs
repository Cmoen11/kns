//! Diagnosis, timeline, traps, sparklines, reach, relations: mirror of `src/ipc/contract/diag.ts`.
//! Owner C. C1 refined `Evidence::Diff` (optional refs) and `Diagnosis.redactions`.
use serde::{Deserialize, Serialize};

use crate::ipc::{EventRow, ObjRef};

use super::{fwd::PortRef, pack::RedactionReport};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warn,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Evidence {
    Object {
        #[serde(rename = "ref")]
        obj_ref: ObjRef,
    },
    LogLine { pod: String, container: String, previous: bool, ts: String, text: String },
    Event { event: EventRow },
    /// `left`/`right`: the changed fields, one `path: value` per line; the refs name both objects
    Diff {
        left: String,
        right: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        left_ref: Option<ObjRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        right_ref: Option<ObjRef>,
    },
    Field {
        #[serde(rename = "ref")]
        obj_ref: ObjRef,
        path: String,
        value: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub severity: Severity,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    pub findings: Vec<Finding>,
    pub checked: Vec<String>,
    pub at: String,
    /// what the Redactor masked in this diagnosis (absent only in hand-made values)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redactions: Option<RedactionReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimelineSource {
    Event,
    ReplicaSet,
    Container,
    Hpa,
    Flux,
    Journal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRow {
    pub at: String,
    pub source: TimelineSource,
    pub what: String,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub obj_ref: Option<ObjRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<Severity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrapTrigger {
    Restart,
    OomKilled,
    CrashLoop,
    NotReady,
    Evicted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrapOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    pub triggers: Vec<TrapTrigger>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrapFired {
    pub at: String,
    pub bundle_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trap {
    pub id: String,
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    pub armed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    pub triggers: Vec<TrapTrigger>,
    pub fired: Vec<TrapFired>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalContext {
    pub context: String,
    pub on: bool,
    pub rows: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalStatus {
    pub contexts: Vec<JournalContext>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodSample {
    pub at: i64,
    pub cpu_milli: i64,
    pub mem_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodSeries {
    pub namespace: String,
    pub name: String,
    pub samples: Vec<PodSample>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachStep {
    pub name: String,
    pub ok: Option<bool>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachCheck {
    pub from: ObjRef,
    pub to: ObjRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<PortRef>,
    pub steps: Vec<ReachStep>,
    pub ok: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachProbeResult {
    pub ok: bool,
    /// what ran, for the human (the tool and its target; the script itself is fixed)
    pub command: String,
    /// cleaned and redacted tool output
    pub output: String,
    /// `nc`, `wget` or `bash` (absent: nothing ran)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// the probe could not run here (no exec right, no shell, no tool): offer a debug container
    #[serde(default)]
    pub needs_debug: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationKind {
    #[serde(rename = "self")]
    Self_,
    Owner,
    Owned,
    Traffic,
    Uses,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationNode {
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    pub kind: String,
    pub relation: RelationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub children: Vec<RelationNode>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{drift::Fixtures, fwd::fixtures::obj};

    #[test]
    fn drift() {
        let pod = obj("pods", "default", "web-1");
        let event = EventRow {
            type_: "Warning".into(),
            reason: "BackOff".into(),
            message: "Back-off restarting failed container".into(),
            count: 3,
            last_seen: Some("2026-11-22T10:00:00Z".into()),
            source: "kubelet".into(),
            object_kind: "Pod".into(),
            object_name: "web-1".into(),
            namespace: Some("default".into()),
        };
        let mut f = Fixtures::new("diag");
        f.add(
            "diagnosis",
            "Diagnosis",
            &Diagnosis {
                obj_ref: pod.clone(),
                findings: vec![Finding {
                    severity: Severity::Error,
                    title: "container main exited 137 (OOMKilled)".into(),
                    detail: Some("lived 41s".into()),
                    evidence: vec![
                        Evidence::Object { obj_ref: pod.clone() },
                        Evidence::LogLine { pod: "web-1".into(), container: "main".into(), previous: true, ts: "2026-11-22T10:00:00Z".into(), text: "killed".into() },
                        Evidence::Event { event },
                        Evidence::Diff {
                            left: "image: a:1".into(),
                            right: "image: a:2".into(),
                            left_ref: Some(obj("replicasets", "default", "web-1")),
                            right_ref: Some(obj("replicasets", "default", "web-2")),
                        },
                        Evidence::Field { obj_ref: pod.clone(), path: "/spec/containers/0/resources/limits/memory".into(), value: "32Mi".into() },
                    ],
                }],
                checked: vec!["phase".into(), "containers".into()],
                at: "2026-11-22T10:00:00Z".into(),
                redactions: Some(RedactionReport { count: 1, by_rule: [("key".to_string(), 1)].into_iter().collect() }),
            },
        );
        f.add(
            "timelineRows",
            "TimelineRow[]",
            &[TimelineSource::Event, TimelineSource::ReplicaSet, TimelineSource::Container, TimelineSource::Hpa, TimelineSource::Flux, TimelineSource::Journal]
                .into_iter()
                .map(|source| TimelineRow { at: "2026-11-22T10:00:00Z".into(), source, what: "x".into(), obj_ref: Some(pod.clone()), severity: Some(Severity::Warn) })
                .collect::<Vec<_>>(),
        );
        let triggers = vec![TrapTrigger::Restart, TrapTrigger::OomKilled, TrapTrigger::CrashLoop, TrapTrigger::NotReady, TrapTrigger::Evicted];
        f.add("trapOpts", "TrapOpts", &TrapOpts { until: Some("2026-11-22T12:00:00Z".into()), triggers: triggers.clone() });
        f.add(
            "trap",
            "Trap",
            &Trap {
                id: "t1".into(),
                obj_ref: pod.clone(),
                armed_at: "2026-11-22T10:00:00Z".into(),
                until: None,
                triggers,
                fired: vec![TrapFired { at: "2026-11-22T10:05:00Z".into(), bundle_id: "b1".into() }],
            },
        );
        f.add(
            "journalStatus",
            "JournalStatus",
            &JournalStatus { contexts: vec![JournalContext { context: "default".into(), on: true, rows: 12, bytes: 4096 }] },
        );
        f.add(
            "podSeries",
            "PodSeries[]",
            &vec![PodSeries { namespace: "default".into(), name: "web-1".into(), samples: vec![PodSample { at: 1_763_805_600_000, cpu_milli: 12, mem_bytes: 1_048_576 }] }],
        );
        f.add(
            "reachCheck",
            "ReachCheck",
            &ReachCheck {
                from: pod.clone(),
                to: obj("services", "default", "web"),
                port: Some(PortRef::Name("http".into())),
                steps: vec![
                    ReachStep { name: "endpoints".into(), ok: Some(true), detail: "1 ready".into() },
                    ReachStep { name: "network policy".into(), ok: None, detail: "by standard rules".into() },
                ],
                ok: None,
            },
        );
        f.add(
            "reachProbe",
            "ReachProbeResult",
            &ReachProbeResult { ok: true, command: "nc -z -w2 web.default.svc 80".into(), output: "".into(), tool: Some("nc".into()), needs_debug: false },
        );
        f.add(
            "relations",
            "RelationNode",
            &RelationNode {
                obj_ref: pod.clone(),
                kind: "Pod".into(),
                relation: RelationKind::Self_,
                status: Some("Running".into()),
                children: [RelationKind::Owner, RelationKind::Owned, RelationKind::Traffic, RelationKind::Uses]
                    .into_iter()
                    .map(|relation| RelationNode { obj_ref: pod.clone(), kind: "ReplicaSet".into(), relation, status: None, children: vec![] })
                    .collect(),
            },
        );
        f.check();
    }
}
