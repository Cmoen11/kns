//! `:why`: deterministic findings with evidence (§3 C1). Owner: C1; C3 added Ingress, Flux and
//! Job/CronJob rules in `diagnose/c3.rs`.
//!
//! Two layers. The fetch layer (`diagnose`) reads the object and what the rules need (events,
//! pods, ReplicaSets, PVCs, a short previous-log tail) and never fails because a side read did:
//! a forbidden or missing side read becomes a note in `checked`. The rules (`pod_rules`,
//! `workload_rules`, `service_rules`) are pure functions over that JSON, tested with fixtures.
//! `finish` sorts the findings worst first and passes every text through the Redactor and
//! `clean_untrusted`, so the webview, MCP (H1) and the pack (G) all get the same safe text.
use std::collections::BTreeMap;

use jiff::Timestamp;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};

use crate::{
    ipc::{BackendError, Diagnosis, EventRow, Evidence, Finding, Gvr, Json, ObjRef, Result, Severity, take_array},
    objects,
    redact::{MAX_LINE, Redactor, clean_untrusted},
    session::{Session, api_path, timed, with_query},
    state::AppState,
};

/// Previous-log lines quoted per crashed container (§3 C1).
pub const LOG_TAIL: i64 = 20;
/// Unhealthy pods of a workload that are diagnosed in depth.
const MAX_PODS: usize = 3;
/// Crashed containers whose previous logs are read, per pod.
const MAX_LOG_CONTAINERS: usize = 2;
/// Events quoted as evidence for one finding.
const MAX_EVENTS: usize = 3;

// ───────────────────────── kinds ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Pod,
    Deployment,
    StatefulSet,
    DaemonSet,
    ReplicaSet,
    Service,
    Ingress,
    Job,
    CronJob,
    /// any `*.toolkit.fluxcd.io` object with a Ready condition (Kustomization, HelmRelease, sources)
    Flux,
}

/// The kinds `:why` has rules for (the UI's `canWhy` mirrors this list).
pub fn target_of(gvr: &Gvr) -> Option<Target> {
    match (gvr.group.as_str(), gvr.resource.as_str()) {
        ("", "pods") => Some(Target::Pod),
        ("apps", "deployments") => Some(Target::Deployment),
        ("apps", "statefulsets") => Some(Target::StatefulSet),
        ("apps", "daemonsets") => Some(Target::DaemonSet),
        ("apps", "replicasets") => Some(Target::ReplicaSet),
        ("", "services") => Some(Target::Service),
        ("networking.k8s.io", "ingresses") => Some(Target::Ingress),
        ("batch", "jobs") => Some(Target::Job),
        ("batch", "cronjobs") => Some(Target::CronJob),
        (g, _) if g.ends_with(c3::FLUX_SUFFIX) => Some(Target::Flux),
        _ => None,
    }
}

// ───────────────────────── small helpers ─────────────────────────

fn s(v: &Json) -> &str {
    v.as_str().unwrap_or_default()
}

fn arr(v: &Json) -> &[Json] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn int(v: &Json) -> Option<i64> {
    v.as_i64()
}

/// kubectl-style short duration: `41s`, `5m30s`, `3h12m`, `2d4h`.
pub fn human(secs: i64) -> String {
    let secs = secs.max(0);
    let (d, h, m, s) = (secs / 86_400, secs % 86_400 / 3600, secs % 3600 / 60, secs % 60);
    match () {
        _ if d > 0 => if h > 0 { format!("{d}d{h}h") } else { format!("{d}d") },
        _ if h > 0 => if m > 0 { format!("{h}h{m}m") } else { format!("{h}h") },
        _ if m > 0 => if s > 0 && m < 10 { format!("{m}m{s}s") } else { format!("{m}m") },
        _ => format!("{s}s"),
    }
}

fn ts(v: &Json) -> Option<Timestamp> {
    v.as_str()?.parse().ok()
}

/// Seconds between two RFC3339 fields, when both parse.
fn lifetime(started: &Json, finished: &Json) -> Option<i64> {
    Some(ts(finished)?.as_second() - ts(started)?.as_second())
}

const SIGNALS: &[(i64, &str)] = &[
    (1, "SIGHUP"),
    (2, "SIGINT"),
    (3, "SIGQUIT"),
    (4, "SIGILL"),
    (5, "SIGTRAP"),
    (6, "SIGABRT"),
    (7, "SIGBUS"),
    (8, "SIGFPE"),
    (9, "SIGKILL"),
    (11, "SIGSEGV"),
    (13, "SIGPIPE"),
    (14, "SIGALRM"),
    (15, "SIGTERM"),
];

/// What an exit code usually means (the same table as the crash card, `src/table/containers.ts`).
pub fn exit_meaning(code: i64) -> String {
    match code {
        0 => "exited normally".into(),
        1 => "application error".into(),
        2 => "misuse of a shell builtin or bad arguments".into(),
        126 => "command found but not executable".into(),
        127 => "command not found (entrypoint or PATH)".into(),
        137 => "SIGKILL: killed by the OOM killer or after the grace period".into(),
        139 => "SIGSEGV: segmentation fault".into(),
        143 => "SIGTERM: asked to stop".into(),
        c if c > 128 && c < 160 => match SIGNALS.iter().find(|(n, _)| *n == c - 128) {
            Some((_, name)) => format!("killed by {name}"),
            None => format!("killed by signal {}", c - 128),
        },
        c if c < 0 => "container runtime error".into(),
        _ => "application-defined exit code".into(),
    }
}

fn event(e: &EventRow) -> Evidence {
    Evidence::Event { event: e.clone() }
}

fn field(r: &ObjRef, path: impl Into<String>, value: impl Into<String>) -> Evidence {
    Evidence::Field { obj_ref: r.clone(), path: path.into(), value: value.into() }
}

fn finding(severity: Severity, title: impl Into<String>, detail: Option<String>, evidence: Vec<Evidence>) -> Finding {
    Finding { severity, title: title.into(), detail: detail.filter(|d| !d.is_empty()), evidence }
}

/// Events with one of `reasons`, newest first (the fetch layer sorts them), at most `MAX_EVENTS`.
fn events_with<'a>(events: &'a [EventRow], reasons: &[&str]) -> Vec<&'a EventRow> {
    events.iter().filter(|e| reasons.contains(&e.reason.as_str())).take(MAX_EVENTS).collect()
}

/// A Kubernetes label selector (structured or a plain map) as a `labelSelector` string.
pub fn selector_string(selector: &Json) -> Option<String> {
    let map = selector.as_object()?;
    let structured = map.contains_key("matchLabels") || map.contains_key("matchExpressions");
    let labels = if structured { selector["matchLabels"].as_object() } else { Some(map) };
    let mut parts: Vec<String> =
        labels.into_iter().flatten().filter_map(|(k, v)| Some(format!("{k}={}", v.as_str()?))).collect();
    for expr in arr(&selector["matchExpressions"]) {
        let key = expr["key"].as_str()?;
        let values: Vec<&str> = arr(&expr["values"]).iter().filter_map(Json::as_str).collect();
        parts.push(match expr["operator"].as_str()? {
            "In" => format!("{key} in ({})", values.join(",")),
            "NotIn" => format!("{key} notin ({})", values.join(",")),
            "Exists" => key.to_string(),
            "DoesNotExist" => format!("!{key}"),
            _ => return None,
        });
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

fn pod_ref(base: &ObjRef, pod: &Json) -> ObjRef {
    ObjRef {
        context: base.context.clone(),
        gvr: Gvr::new("", "v1", "pods"),
        namespace: pod["metadata"]["namespace"].as_str().map(str::to_string).or_else(|| base.namespace.clone()),
        name: s(&pod["metadata"]["name"]).to_string(),
    }
}

fn condition<'a>(obj: &'a Json, kind: &str) -> Option<(usize, &'a Json)> {
    arr(&obj["status"]["conditions"]).iter().enumerate().find(|(_, c)| c["type"].as_str() == Some(kind))
}

/// The pod is Running/Succeeded, Ready and has never restarted.
pub fn pod_healthy(pod: &Json) -> bool {
    let phase = s(&pod["status"]["phase"]);
    if phase == "Succeeded" {
        return true;
    }
    let ready = condition(pod, "Ready").is_some_and(|(_, c)| c["status"].as_str() == Some("True"));
    let restarts: i64 = arr(&pod["status"]["containerStatuses"]).iter().filter_map(|c| int(&c["restartCount"])).sum();
    phase == "Running" && ready && restarts == 0 && pod["metadata"]["deletionTimestamp"].is_null()
}

fn pod_ready(pod: &Json) -> bool {
    condition(pod, "Ready").is_some_and(|(_, c)| c["status"].as_str() == Some("True"))
}

// ───────────────────────── inputs ─────────────────────────

/// One previous-log line (timestamp from the kubelet, text as written).
#[derive(Debug, Clone, PartialEq)]
pub struct LogTail {
    pub ts: String,
    pub text: String,
}

/// What the pod rules read.
#[derive(Debug, Clone, Default)]
pub struct PodInput {
    pub pod: Json,
    /// events of the pod, newest first
    pub events: Vec<EventRow>,
    /// container → (previous?, last lines)
    pub logs: BTreeMap<String, (bool, Vec<LogTail>)>,
    /// PVCs the pod mounts that could be read
    pub pvcs: Vec<Json>,
}

/// What the workload rules read.
#[derive(Debug, Clone, Default)]
pub struct WorkloadInput {
    pub obj: Json,
    pub events: Vec<EventRow>,
    /// Deployments: the ReplicaSets it owns
    pub replica_sets: Vec<Json>,
    /// pods of the newest revision (all pods for other kinds)
    pub pods: Vec<Json>,
    /// the unhealthy pods diagnosed in depth (at most `MAX_PODS`)
    pub deep: Vec<PodInput>,
}

/// What the Service rules read.
#[derive(Debug, Clone, Default)]
pub struct ServiceInput {
    pub svc: Json,
    pub events: Vec<EventRow>,
    /// pods matching the selector (None: no selector)
    pub pods: Option<Vec<Json>>,
}

#[derive(Debug, Default)]
pub struct Out {
    pub findings: Vec<Finding>,
    pub checked: Vec<String>,
    /// one per diagnosis, so masks applied by a rule (ReplicaSet templates) are counted too
    pub redactor: Redactor,
}

impl Out {
    fn check(&mut self, what: &str) {
        if !self.checked.iter().any(|c| c == what) {
            self.checked.push(what.to_string());
        }
    }
    fn push(&mut self, f: Finding) {
        self.findings.push(f);
    }
}

// ───────────────────────── pod rules ─────────────────────────

/// `0/3 nodes are available: 1 Insufficient memory, 2 node(s) had untolerated taint {a: b}. preemption: …`
/// → `[(2, "node(s) had untolerated taint {a: b}"), (1, "Insufficient memory")]`, biggest first, and the total.
pub fn parse_failed_scheduling(message: &str) -> (Option<u32>, Vec<(u32, String)>) {
    let Some(at) = message.find("nodes are available:") else { return (None, Vec::new()) };
    let total = message[..at].trim().split('/').nth(1).and_then(|n| n.trim().parse().ok());
    let mut rest = &message[at + "nodes are available:".len()..];
    if let Some(p) = rest.find(". preemption:") {
        rest = &rest[..p];
    }
    let rest = rest.trim().trim_end_matches('.');
    let mut out: Vec<(u32, String)> = Vec::new();
    for part in rest.split(", ") {
        let mut words = part.splitn(2, ' ');
        match (words.next().and_then(|n| n.parse::<u32>().ok()), words.next()) {
            (Some(n), Some(reason)) => out.push((n, reason.trim().to_string())),
            // a reason with ", " inside (taint values): glue it back on
            _ => {
                if let Some(last) = out.last_mut() {
                    last.1.push_str(", ");
                    last.1.push_str(part);
                }
            }
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.0));
    (total, out)
}

fn probe_summary(p: &Json) -> String {
    let port = |v: &Json| match v {
        Json::Number(n) => n.to_string(),
        other => s(other).to_string(),
    };
    if !p["httpGet"].is_null() {
        format!("httpGet :{}{}", port(&p["httpGet"]["port"]), s(&p["httpGet"]["path"]))
    } else if !p["tcpSocket"].is_null() {
        format!("tcpSocket :{}", port(&p["tcpSocket"]["port"]))
    } else if !p["grpc"].is_null() {
        format!("grpc :{}", port(&p["grpc"]["port"]))
    } else if !p["exec"].is_null() {
        let cmd: Vec<&str> = arr(&p["exec"]["command"]).iter().filter_map(Json::as_str).collect();
        format!("exec {}", cmd.join(" "))
    } else {
        "probe".into()
    }
}

/// Spec paths that refer to a ConfigMap or Secret (env, envFrom, volumes), with what they are.
fn ref_paths(pod: &Json, kind: &str, name: &str) -> Vec<(String, String)> {
    let (key_ref, from_ref, vol) = if kind == "secret" {
        ("secretKeyRef", "secretRef", "secret")
    } else {
        ("configMapKeyRef", "configMapRef", "configMap")
    };
    let vol_name_key = if kind == "secret" { "secretName" } else { "name" };
    let mut out = Vec::new();
    for list in ["initContainers", "containers"] {
        for (i, c) in arr(&pod["spec"][list]).iter().enumerate() {
            let cname = s(&c["name"]);
            for (j, e) in arr(&c["env"]).iter().enumerate() {
                if s(&e["valueFrom"][key_ref]["name"]) == name {
                    out.push((format!("/spec/{list}/{i}/env/{j}/valueFrom/{key_ref}"), format!("env {} of {cname}", s(&e["name"]))));
                }
            }
            for (j, e) in arr(&c["envFrom"]).iter().enumerate() {
                if s(&e[from_ref]["name"]) == name {
                    out.push((format!("/spec/{list}/{i}/envFrom/{j}/{from_ref}"), format!("envFrom of {cname}")));
                }
            }
        }
    }
    for (i, v) in arr(&pod["spec"]["volumes"]).iter().enumerate() {
        if s(&v[vol][vol_name_key]) == name {
            out.push((format!("/spec/volumes/{i}/{vol}"), format!("volume {}", s(&v["name"]))));
        }
        for (j, src) in arr(&v["projected"]["sources"]).iter().enumerate() {
            if s(&src[vol]["name"]) == name {
                out.push((format!("/spec/volumes/{i}/projected/sources/{j}/{vol}"), format!("volume {}", s(&v["name"]))));
            }
        }
    }
    out
}

/// A missing ConfigMap / Secret / key named by the kubelet: `secret "x" not found`,
/// `couldn't find key K in Secret ns/x`, `configmap "x" not found`.
pub fn parse_missing_ref(message: &str) -> Option<(String, String, Option<String>)> {
    let lower = message.to_ascii_lowercase();
    if let Some(at) = lower.find("couldn't find key ") {
        let rest = &message[at + "couldn't find key ".len()..];
        let mut w = rest.split_whitespace();
        let key = w.next()?.to_string();
        if w.next()? != "in" {
            return None;
        }
        let kind = w.next()?.to_ascii_lowercase();
        let full = w.next()?.trim_end_matches(['.', ',', ')']);
        let name = full.rsplit('/').next()?.to_string();
        return Some((kind, name, Some(key)));
    }
    for kind in ["secret", "configmap"] {
        let pat = format!("{kind} \"");
        if let Some(at) = lower.find(&pat) {
            let rest = &message[at + pat.len()..];
            let end = rest.find('"')?;
            if rest[end..].starts_with("\" not found") {
                return Some((kind.to_string(), rest[..end].to_string(), None));
            }
        }
    }
    None
}

fn missing_ref_finding(r: &ObjRef, pod: &Json, message: &str, extra: Vec<Evidence>) -> Option<Finding> {
    let (kind, name, key) = parse_missing_ref(message)?;
    let label = if kind == "secret" { "Secret" } else { "ConfigMap" };
    let title = match &key {
        Some(k) => format!("key {k} missing in {label} {name}"),
        None => format!("{label} {name} not found"),
    };
    let paths = ref_paths(pod, &kind, &name);
    let detail = (!paths.is_empty()).then(|| {
        let used: Vec<&str> = paths.iter().map(|(_, what)| what.as_str()).collect();
        format!("referenced by {}", used.join(", "))
    });
    let mut evidence: Vec<Evidence> = paths.into_iter().map(|(p, _)| field(r, p, name.clone())).collect();
    evidence.extend(extra);
    Some(finding(Severity::Error, title, detail, evidence))
}

/// Findings for one pod. `r` is the pod's ref (evidence points at it).
pub fn pod_rules(r: &ObjRef, input: &PodInput, out: &mut Out) {
    let pod = &input.pod;
    let status = &pod["status"];
    let phase = s(&status["phase"]);
    out.check("phase");
    out.check("conditions");

    // evicted / failed pod
    if phase == "Failed" && s(&status["reason"]) == "Evicted" {
        out.push(finding(
            Severity::Error,
            "pod was evicted",
            status["message"].as_str().map(str::to_string),
            vec![field(r, "/status/message", s(&status["message"]))],
        ));
    }

    // scheduling
    out.check("scheduling");
    if let Some((i, c)) = condition(pod, "PodScheduled")
        && c["status"].as_str() == Some("False")
    {
        let msg = s(&c["message"]);
        let ev = events_with(&input.events, &["FailedScheduling"]);
        let source = ev.first().map(|e| e.message.as_str()).filter(|m| !m.is_empty()).unwrap_or(msg);
        let (total, reasons) = parse_failed_scheduling(source);
        let title = match (reasons.first(), total) {
            (Some((n, why)), Some(t)) => format!("not scheduled: {why} ({n} of {t} nodes)"),
            (Some((n, why)), None) => format!("not scheduled: {why} ({n} nodes)"),
            _ => format!("not scheduled: {}", if c["reason"].is_string() { s(&c["reason"]) } else { "Unschedulable" }),
        };
        let detail = (reasons.len() > 1)
            .then(|| reasons.iter().map(|(n, why)| format!("{n}× {why}")).collect::<Vec<_>>().join("; "));
        let mut evidence: Vec<Evidence> = ev.into_iter().map(event).collect();
        evidence.push(field(r, format!("/status/conditions/{i}/message"), msg));
        out.push(finding(Severity::Error, title, detail, evidence));
    }

    // PVCs
    out.check("volumes");
    for pvc in &input.pvcs {
        let pvc_phase = s(&pvc["status"]["phase"]);
        if pvc_phase != "Bound" {
            let name = s(&pvc["metadata"]["name"]);
            let pvc_ref = ObjRef {
                context: r.context.clone(),
                gvr: Gvr::new("", "v1", "persistentvolumeclaims"),
                namespace: r.namespace.clone(),
                name: name.to_string(),
            };
            let class = pvc["spec"]["storageClassName"].as_str().map(|c| format!("storage class {c}"));
            out.push(finding(
                Severity::Error,
                format!("PersistentVolumeClaim {name} is {}", if pvc_phase.is_empty() { "not bound" } else { pvc_phase }),
                class,
                vec![Evidence::Object { obj_ref: pvc_ref }],
            ));
        }
    }
    for e in events_with(&input.events, &["FailedMount", "FailedAttachVolume"]).into_iter().take(1) {
        if let Some(f) = missing_ref_finding(r, pod, &e.message, vec![event(e)]) {
            out.push(f);
        } else {
            out.push(finding(Severity::Error, format!("volume mount fails ({})", e.reason), Some(e.message.clone()), vec![event(e)]));
        }
    }

    // containers
    out.check("init containers");
    out.check("containers");
    out.check("image pulls");
    out.check("config refs");
    for (list, statuses, init) in [("initContainers", "initContainerStatuses", true), ("containers", "containerStatuses", false)] {
        let specs = arr(&pod["spec"][list]);
        for (si, cs) in arr(&status[statuses]).iter().enumerate() {
            let name = s(&cs["name"]);
            let spec_i = specs.iter().position(|c| s(&c["name"]) == name);
            let spec = spec_i.map(|i| &specs[i]);
            let who = if init { format!("init container {name}") } else { format!("container {name}") };
            let base = format!("/status/{statuses}/{si}");
            let waiting = &cs["state"]["waiting"];
            let reason = s(&waiting["reason"]);
            let restarts = int(&cs["restartCount"]).unwrap_or(0);

            // image pull
            if matches!(reason, "ImagePullBackOff" | "ErrImagePull" | "InvalidImageName" | "ErrImageNeverPull" | "RegistryUnavailable") {
                let image = spec.map(|c| s(&c["image"])).unwrap_or_else(|| s(&cs["image"]));
                let mut evidence = Vec::new();
                if let Some(i) = spec_i {
                    evidence.push(field(r, format!("/spec/{list}/{i}/image"), image));
                }
                evidence.extend(
                    input
                        .events
                        .iter()
                        .filter(|e| e.reason == "Failed" && (e.message.contains(image) || e.message.contains("pull")))
                        .take(2)
                        .map(event),
                );
                out.push(finding(
                    Severity::Error,
                    format!("{who}: image pull fails ({reason}): {image}"),
                    waiting["message"].as_str().map(str::to_string),
                    evidence,
                ));
                continue;
            }

            // config errors (missing ConfigMap / Secret / key)
            if matches!(reason, "CreateContainerConfigError" | "CreateContainerError") {
                let msg = s(&waiting["message"]);
                let wev = field(r, format!("{base}/state/waiting/message"), msg);
                let f = missing_ref_finding(r, pod, msg, vec![wev.clone()])
                    .unwrap_or_else(|| finding(Severity::Error, format!("{who} cannot start ({reason})"), Some(msg.to_string()), vec![wev]));
                out.push(f);
                continue;
            }

            // terminations: the last one, or the current one when it failed
            let last = &cs["lastState"]["terminated"];
            let now = &cs["state"]["terminated"];
            let (term, term_path, current) = if !now.is_null() && (int(&now["exitCode"]).unwrap_or(0) != 0 || s(&now["reason"]) == "OOMKilled") {
                (now, format!("{base}/state/terminated"), true)
            } else if !last.is_null() && restarts > 0 {
                (last, format!("{base}/lastState/terminated"), false)
            } else {
                continue;
            };
            let code = int(&term["exitCode"]).unwrap_or(0);
            let why = s(&term["reason"]);
            let oom = why == "OOMKilled";
            let lived = lifetime(&term["startedAt"], &term["finishedAt"]).map(human);
            let after = lived.as_ref().map(|l| format!(" after {l}")).unwrap_or_default();
            let running_now = !cs["state"]["running"].is_null();
            let crashloop = reason == "CrashLoopBackOff";
            let title = if oom {
                format!("{who} was OOMKilled (exit {code}){after}")
            } else if current && restarts == 0 {
                format!("{who} exited {code} ({}){after}", if why.is_empty() { "Error" } else { why })
            } else {
                format!("{who} restarts: last exit {code} ({}){after}", if why.is_empty() { "Error" } else { why })
            };
            let mut detail = vec![exit_meaning(code)];
            if crashloop {
                detail.push(format!("CrashLoopBackOff, {restarts} restarts"));
            } else if restarts > 0 {
                detail.push(format!("{restarts} restarts{}", if running_now { ", running again now" } else { "" }));
            }
            let mut evidence = vec![field(r, format!("{term_path}/exitCode"), code.to_string())];
            if oom
                && let Some(i) = spec_i
            {
                let limit = &specs[i]["resources"]["limits"]["memory"];
                if let Some(l) = limit.as_str() {
                    detail.push(format!("memory limit {l}"));
                    evidence.push(field(r, format!("/spec/{list}/{i}/resources/limits/memory"), l));
                } else {
                    detail.push("no memory limit on the container: the node ran out of memory".into());
                }
            }
            if let Some((previous, lines)) = input.logs.get(name) {
                for l in lines {
                    evidence.push(Evidence::LogLine {
                        pod: s(&pod["metadata"]["name"]).to_string(),
                        container: name.to_string(),
                        previous: *previous,
                        ts: l.ts.clone(),
                        text: l.text.clone(),
                    });
                }
            }
            evidence.extend(events_with(&input.events, &["BackOff"]).into_iter().take(1).map(event));
            // restarted earlier but healthy again: a warning, not the cause of an outage
            let severity = if crashloop || current || !running_now { Severity::Error } else { Severity::Warn };
            out.push(finding(severity, title, Some(detail.join("; ")), evidence));
        }
    }

    // probes
    out.check("probes");
    let unhealthy: Vec<&EventRow> = input.events.iter().filter(|e| e.reason == "Unhealthy").collect();
    for (word, key) in [("Liveness", "livenessProbe"), ("Readiness", "readinessProbe"), ("Startup", "startupProbe")] {
        let hits: Vec<&EventRow> = unhealthy.iter().copied().filter(|e| e.message.starts_with(word)).take(MAX_EVENTS).collect();
        let Some(first) = hits.first() else { continue };
        let what = first.message.split_once("probe failed:").map(|(_, w)| w.trim()).unwrap_or(&first.message);
        let mut evidence: Vec<Evidence> = hits.iter().map(|e| event(e)).collect();
        // the container(s) that have this probe
        let specs = arr(&pod["spec"]["containers"]);
        let with: Vec<(usize, &Json)> = specs.iter().enumerate().filter(|(_, c)| !c[key].is_null()).collect();
        let who = match with.as_slice() {
            [(i, c)] => {
                evidence.push(field(r, format!("/spec/containers/{i}/{key}"), probe_summary(&c[key])));
                format!(" in {}", s(&c["name"]))
            }
            _ => String::new(),
        };
        let count: i64 = hits.iter().map(|e| e.count.max(1)).sum();
        let severity = if word == "Readiness" { Severity::Warn } else { Severity::Error };
        let consequence = match word {
            "Liveness" => "the kubelet restarts the container",
            "Readiness" => "the pod gets no Service traffic",
            _ => "the container is restarted before it starts",
        };
        out.push(finding(
            severity,
            format!("{} probe fails{who}: {what}", word.to_lowercase()),
            Some(format!("{count}× recently; {consequence}")),
            evidence,
        ));
    }

    // terminating
    if let Some(since) = pod["metadata"]["deletionTimestamp"].as_str() {
        let finalizers: Vec<&str> = arr(&pod["metadata"]["finalizers"]).iter().filter_map(Json::as_str).collect();
        let detail = (!finalizers.is_empty()).then(|| format!("finalizers: {}", finalizers.join(", ")));
        out.push(finding(Severity::Info, format!("pod is terminating (since {since})"), detail, vec![field(r, "/metadata/deletionTimestamp", since)]));
    }

    // not ready, nothing else explains it
    let explained = out.findings.iter().any(|f| f.severity != Severity::Info);
    if !explained
        && phase == "Running"
        && let Some((i, c)) = condition(pod, "Ready")
        && c["status"].as_str() == Some("False")
    {
        let why = [s(&c["reason"]), s(&c["message"])].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(": ");
        out.push(finding(Severity::Warn, "pod is not ready", Some(why), vec![field(r, format!("/status/conditions/{i}"), s(&c["message"]))]));
    }
    if phase == "Pending" && !out.findings.iter().any(|f| f.severity == Severity::Error) {
        out.push(finding(Severity::Info, "pod is Pending", status["message"].as_str().map(str::to_string), vec![field(r, "/status/phase", phase)]));
    }
    out.check("previous logs");
    out.check("events");
}

/// Warning events on the object itself that no other rule explained (FailedCreate, quota …).
fn warning_events(events: &[EventRow], out: &mut Out, skip: &[&str]) {
    let mut seen: Vec<&str> = Vec::new();
    for e in events.iter().filter(|e| e.type_ == "Warning" && !skip.contains(&e.reason.as_str())) {
        if seen.contains(&e.reason.as_str()) || seen.len() >= MAX_EVENTS {
            continue;
        }
        seen.push(&e.reason);
        out.push(finding(Severity::Warn, format!("{}: {}", e.reason, e.message), None, vec![event(e)]));
    }
}

// ───────────────────────── workload rules ─────────────────────────

fn revision(rs: &Json) -> i64 {
    s(&rs["metadata"]["annotations"]["deployment.kubernetes.io/revision"]).parse().unwrap_or(0)
}

/// Leaves of a JSON value as `path: value` lines (arrays of named items keyed by name).
fn flatten(v: &Json, path: &str, out: &mut BTreeMap<String, String>) {
    match v {
        Json::Object(map) => {
            for (k, child) in map {
                flatten(child, &if path.is_empty() { k.clone() } else { format!("{path}.{k}") }, out);
            }
        }
        Json::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                let key = item["name"].as_str().map(|n| format!("[{n}]")).unwrap_or_else(|| format!("[{i}]"));
                flatten(item, &format!("{path}{key}"), out);
            }
        }
        Json::Null => {}
        Json::String(x) => {
            out.insert(path.to_string(), x.clone());
        }
        other => {
            out.insert(path.to_string(), other.to_string());
        }
    }
}

/// The changed leaves of two pod templates: (`left` lines, `right` lines, short summary).
/// The templates must already be redacted. `pod-template-hash` is ignored.
pub fn template_diff(old: &Json, new: &Json) -> Option<(String, String, String)> {
    let strip = |t: &Json| {
        let mut t = t.clone();
        if let Some(labels) = t.pointer_mut("/metadata/labels").and_then(Json::as_object_mut) {
            labels.remove("pod-template-hash");
        }
        let mut m = BTreeMap::new();
        flatten(&t, "", &mut m);
        m
    };
    let (a, b) = (strip(old), strip(new));
    let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
    keys.sort();
    keys.dedup();
    let (mut left, mut right, mut summary) = (Vec::new(), Vec::new(), Vec::new());
    for k in keys {
        let (x, y) = (a.get(k), b.get(k));
        if x == y {
            continue;
        }
        let none = "(none)".to_string();
        left.push(format!("{k}: {}", x.unwrap_or(&none)));
        right.push(format!("{k}: {}", y.unwrap_or(&none)));
        if summary.len() < 3 {
            let short = k.strip_prefix("spec.").unwrap_or(k);
            summary.push(format!("{short} {} → {}", x.unwrap_or(&none), y.unwrap_or(&none)));
        }
    }
    if left.is_empty() {
        return None;
    }
    let more = left.len().saturating_sub(summary.len());
    let mut summary = summary.join("; ");
    if more > 0 {
        summary.push_str(&format!(" (+{more} more)"));
    }
    Some((left.join("\n"), right.join("\n"), summary))
}

/// Desired and ready pod counts of a workload.
fn counts(target: Target, obj: &Json) -> (i64, i64) {
    let st = &obj["status"];
    match target {
        Target::DaemonSet => (int(&st["desiredNumberScheduled"]).unwrap_or(0), int(&st["numberReady"]).unwrap_or(0)),
        _ => (int(&obj["spec"]["replicas"]).unwrap_or(1), int(&st["readyReplicas"]).unwrap_or(0)),
    }
}

/// Findings for a Deployment, StatefulSet, DaemonSet or ReplicaSet.
pub fn workload_rules(r: &ObjRef, target: Target, input: &WorkloadInput, out: &mut Out) {
    let obj = &input.obj;
    out.check("conditions");
    for (i, c) in arr(&obj["status"]["conditions"]).iter().enumerate() {
        let (kind, status, reason, msg) = (s(&c["type"]), s(&c["status"]), s(&c["reason"]), s(&c["message"]));
        let path = format!("/status/conditions/{i}");
        match (kind, status) {
            ("Progressing", "False") => out.push(finding(
                Severity::Error,
                format!("rollout is stuck ({})", if reason.is_empty() { "Progressing=False" } else { reason }),
                Some(msg.to_string()),
                vec![field(r, path, msg)],
            )),
            ("ReplicaFailure", "True") => out.push(finding(
                Severity::Error,
                format!("pods cannot be created ({reason})"),
                Some(msg.to_string()),
                vec![field(r, path, msg)],
            )),
            ("Available", "False") => out.push(finding(Severity::Warn, "not available", Some(msg.to_string()), vec![field(r, path, msg)])),
            _ => {}
        }
    }

    out.check("replicas");
    let (desired, ready) = counts(target, obj);
    if desired > ready {
        let unready: Vec<Evidence> = input
            .pods
            .iter()
            .filter(|p| !pod_ready(p))
            .take(MAX_PODS)
            .map(|p| Evidence::Object { obj_ref: pod_ref(r, p) })
            .collect();
        let severity = if ready == 0 { Severity::Error } else { Severity::Warn };
        let detail = (input.pods.len() as i64) < desired && target != Target::DaemonSet;
        out.push(finding(
            severity,
            format!("{ready} of {desired} pods ready"),
            detail.then(|| format!("only {} pods exist", input.pods.len())),
            unready,
        ));
    }

    // the newest revision's pods, in depth
    out.check("pods of the newest revision");
    for p in &input.deep {
        let pr = pod_ref(r, &p.pod);
        let mut sub = Out::default();
        pod_rules(&pr, p, &mut sub);
        sort_findings(&mut sub.findings);
        if let Some(mut f) = sub.findings.into_iter().find(|f| f.severity != Severity::Info) {
            f.title = format!("pod {}: {}", pr.name, f.title);
            f.evidence.insert(0, Evidence::Object { obj_ref: pr });
            out.push(f);
        }
    }

    // what changed in the newest revision
    if target == Target::Deployment {
        out.check("what changed vs the previous revision");
        let mut rs: Vec<&Json> = input.replica_sets.iter().collect();
        rs.sort_by_key(|x| std::cmp::Reverse(revision(x)));
        let problems = out.findings.iter().any(|f| f.severity != Severity::Info);
        if problems
            && let [new, old, ..] = rs.as_slice()
        {
            let rs_gvr = Gvr::new("apps", "v1", "replicasets");
            let mut a = old["spec"]["template"].clone();
            let mut b = new["spec"]["template"].clone();
            out.redactor.object(&rs_gvr, &mut a);
            out.redactor.object(&rs_gvr, &mut b);
            if let Some((left, right, summary)) = template_diff(&a, &b) {
                let rs_ref = |x: &Json| ObjRef {
                    context: r.context.clone(),
                    gvr: rs_gvr.clone(),
                    namespace: r.namespace.clone(),
                    name: s(&x["metadata"]["name"]).to_string(),
                };
                out.push(finding(
                    Severity::Info,
                    format!("revision {} changed: {summary}", revision(new)),
                    Some(format!("compared with revision {} ({})", revision(old), s(&old["metadata"]["name"]))),
                    vec![Evidence::Diff { left, right, left_ref: Some(rs_ref(old)), right_ref: Some(rs_ref(new)) }],
                ));
            }
        }
    }
    out.check("events");
    warning_events(&input.events, out, &[]);
}

// ───────────────────────── service rules ─────────────────────────

/// Findings for a Service.
pub fn service_rules(r: &ObjRef, input: &ServiceInput, out: &mut Out) {
    let svc = &input.svc;
    let spec = &svc["spec"];
    out.check("selector");
    if s(&spec["type"]) == "ExternalName" {
        out.push(finding(
            Severity::Info,
            format!("ExternalName Service: resolves to {}", s(&spec["externalName"])),
            Some("no pods or endpoints are involved".into()),
            vec![field(r, "/spec/externalName", s(&spec["externalName"]))],
        ));
        return;
    }
    let Some(pods) = &input.pods else {
        out.push(finding(
            Severity::Info,
            "no selector: endpoints are managed by hand or by a controller",
            None,
            vec![field(r, "/spec/selector", "")],
        ));
        return;
    };
    let selector = selector_string(&spec["selector"]).unwrap_or_default();
    out.check("endpoints");
    if pods.is_empty() {
        out.push(finding(
            Severity::Error,
            "selector matches 0 pods",
            Some(selector.clone()),
            vec![field(r, "/spec/selector", selector.clone())],
        ));
    } else {
        let unready: Vec<&Json> = pods.iter().filter(|p| !pod_ready(p)).collect();
        if !unready.is_empty() {
            let severity = if unready.len() == pods.len() { Severity::Error } else { Severity::Warn };
            out.push(finding(
                severity,
                format!("{} of {} pods not ready", unready.len(), pods.len()),
                Some("pods that are not ready get no traffic".into()),
                unready.iter().take(MAX_PODS).map(|p| Evidence::Object { obj_ref: pod_ref(r, p) }).collect(),
            ));
        }
    }
    out.check("targetPort");
    if !pods.is_empty() {
        for (i, port) in arr(&spec["ports"]).iter().enumerate() {
            let Some(name) = port["targetPort"].as_str() else { continue };
            let found = pods.iter().any(|p| {
                arr(&p["spec"]["containers"]).iter().any(|c| arr(&c["ports"]).iter().any(|cp| s(&cp["name"]) == name))
            });
            if !found {
                let label = port["name"].as_str().map(|n| format!("port {n}")).unwrap_or_else(|| format!("port {}", port["port"]));
                out.push(finding(
                    Severity::Error,
                    format!("targetPort {name} names no container port"),
                    Some(format!("{label}: none of the selected pods has a container port named {name}")),
                    vec![field(r, format!("/spec/ports/{i}/targetPort"), name)],
                ));
            }
        }
    }
    out.check("events");
    warning_events(&input.events, out, &[]);
}

// ───────────────────────── finish ─────────────────────────

fn rank(sev: Severity) -> u8 {
    match sev {
        Severity::Error => 0,
        Severity::Warn => 1,
        Severity::Info => 2,
    }
}

/// Worst first; the order of the rules within a severity is kept.
pub fn sort_findings(f: &mut [Finding]) {
    f.sort_by_key(|x| rank(x.severity));
}

fn clean(r: &mut Redactor, s: &mut String) {
    *s = clean_untrusted(&r.text(s), MAX_LINE);
}

/// Every text through the Redactor, then `clean_untrusted`.
pub fn sanitize(findings: &mut [Finding], r: &mut Redactor) {
    for f in findings {
        clean(r, &mut f.title);
        if let Some(d) = f.detail.as_mut() {
            clean(r, d);
        }
        for e in &mut f.evidence {
            match e {
                Evidence::Object { .. } => {}
                Evidence::LogLine { text, ts, container, .. } => {
                    clean(r, text);
                    clean(r, ts);
                    clean(r, container);
                }
                Evidence::Event { event } => {
                    clean(r, &mut event.reason);
                    clean(r, &mut event.message);
                    clean(r, &mut event.source);
                }
                Evidence::Diff { left, right, .. } => {
                    clean(r, left);
                    clean(r, right);
                }
                Evidence::Field { path, value, .. } => {
                    clean(r, path);
                    clean(r, value);
                }
            }
        }
    }
}

/// The Diagnosis from rule output: sorted, redacted, cleaned.
pub fn finish(obj_ref: &ObjRef, mut out: Out, at: String) -> Diagnosis {
    sort_findings(&mut out.findings);
    let mut redactor = std::mem::take(&mut out.redactor);
    sanitize(&mut out.findings, &mut redactor);
    for c in &mut out.checked {
        *c = clean_untrusted(c, MAX_LINE);
    }
    Diagnosis { obj_ref: obj_ref.clone(), findings: out.findings, checked: out.checked, at, redactions: Some(redactor.report()) }
}

// ───────────────────────── fetch ─────────────────────────

fn side_note(out: &mut Out, what: &str, e: &BackendError) {
    let why = match e.code {
        403 => "forbidden".to_string(),
        404 => "not found".to_string(),
        _ => e.message.chars().take(120).collect(),
    };
    out.check(&format!("{what}: not read ({why})"));
}

async fn list(session: &Session, gvr: &Gvr, ns: Option<&str>, selector: Option<&str>) -> Result<Vec<Json>> {
    let params: Vec<(&str, &str)> = selector.map(|sel| vec![("labelSelector", sel)]).unwrap_or_default();
    let uri = with_query(&api_path(gvr, ns, None), &params);
    Ok(take_array(&mut session.get(&uri).await?, "items"))
}

fn owned_by(obj: &Json, uid: &str) -> bool {
    !uid.is_empty() && arr(&obj["metadata"]["ownerReferences"]).iter().any(|o| s(&o["uid"]) == uid)
}

async fn events_of(state: &AppState, context: &str, r: &ObjRef, out: &mut Out) -> Vec<EventRow> {
    match objects::list_events(state, context, r.ns(), Some(r)).await {
        Ok(ev) => ev,
        Err(e) => {
            side_note(out, "events", &e);
            Vec::new()
        }
    }
}

/// `2026-11-22T10:00:00.123456789Z text` → (ts, text).
fn split_ts(line: &str) -> LogTail {
    match line.split_once(' ') {
        Some((t, rest)) if t.parse::<Timestamp>().is_ok() => LogTail { ts: t.to_string(), text: rest.to_string() },
        _ => LogTail { ts: String::new(), text: line.to_string() },
    }
}

/// The last lines of each crashed container (previous instance when it restarted).
async fn crash_logs(session: &Session, pod: &Json, out: &mut Out) -> BTreeMap<String, (bool, Vec<LogTail>)> {
    let mut logs = BTreeMap::new();
    let ns = s(&pod["metadata"]["namespace"]);
    let name = s(&pod["metadata"]["name"]);
    let api: Api<Pod> = Api::namespaced(session.client.clone(), ns);
    let mut wanted: Vec<(String, bool)> = Vec::new();
    for key in ["initContainerStatuses", "containerStatuses"] {
        for cs in arr(&pod["status"][key]) {
            let restarts = int(&cs["restartCount"]).unwrap_or(0);
            let now = &cs["state"]["terminated"];
            if restarts > 0 && !cs["lastState"]["terminated"].is_null() {
                wanted.push((s(&cs["name"]).to_string(), true));
            } else if !now.is_null() && int(&now["exitCode"]).unwrap_or(0) != 0 {
                wanted.push((s(&cs["name"]).to_string(), false));
            }
        }
    }
    for (container, previous) in wanted.into_iter().take(MAX_LOG_CONTAINERS) {
        let read = |previous: bool| {
            let params = LogParams {
                container: Some(container.clone()),
                previous,
                tail_lines: Some(LOG_TAIL),
                timestamps: true,
                limit_bytes: Some(64 * 1024),
                ..Default::default()
            };
            let api = api.clone();
            async move { timed(api.logs(name, &params)).await }
        };
        // the kubelet answers a gone previous instance with an error *as the body*: never evidence;
        // fall back to the current run, or leave the row out
        let mut got = match read(previous).await {
            Ok(text) if crate::logs::is_kubelet_log_error(&text) => None,
            Ok(text) => Some((previous, text)),
            Err(e) if !previous => {
                side_note(out, &format!("logs of {container}"), &e);
                None
            }
            Err(_) => None,
        };
        if got.is_none() && previous {
            got = match read(false).await {
                Ok(text) if !crate::logs::is_kubelet_log_error(&text) => Some((false, text)),
                Ok(_) => None,
                Err(e) => {
                    side_note(out, &format!("logs of {container}"), &e);
                    None
                }
            };
        }
        if let Some((previous, text)) = got {
            let lines: Vec<LogTail> = text.lines().filter(|l| !l.is_empty()).map(split_ts).collect();
            if !lines.is_empty() {
                logs.insert(container, (previous, lines));
            }
        }
    }
    logs
}

async fn pod_input(state: &AppState, session: &Session, context: &str, r: &ObjRef, pod: Json, out: &mut Out) -> PodInput {
    let events = events_of(state, context, r, out).await;
    let mut pvcs = Vec::new();
    let pvc_gvr = Gvr::new("", "v1", "persistentvolumeclaims");
    for v in arr(&pod["spec"]["volumes"]) {
        if let Some(claim) = v["persistentVolumeClaim"]["claimName"].as_str() {
            match session.get(&api_path(&pvc_gvr, r.ns(), Some(claim))).await {
                Ok(p) => pvcs.push(p),
                Err(e) => side_note(out, &format!("PersistentVolumeClaim {claim}"), &e),
            }
        }
    }
    let logs = crash_logs(session, &pod, out).await;
    PodInput { pod, events, logs, pvcs }
}

/// Unhealthy pods first (not ready, restarting), then the rest.
fn worst_pods(pods: &[Json]) -> Vec<&Json> {
    let mut v: Vec<&Json> = pods.iter().filter(|p| !pod_healthy(p)).collect();
    v.sort_by_key(|p| (pod_ready(p), std::cmp::Reverse(arr(&p["status"]["containerStatuses"]).iter().filter_map(|c| int(&c["restartCount"])).sum::<i64>())));
    v
}

/// Findings for a pod, workload or Service; every text passes the Redactor and `clean_untrusted`.
/// Other kinds give no findings and a `checked` note, never an error.
pub async fn diagnose(state: &AppState, context: &str, obj_ref: &ObjRef) -> Result<Diagnosis> {
    let at = Timestamp::now().to_string();
    let mut out = Out::default();
    let Some(target) = target_of(&obj_ref.gvr) else {
        out.check(&format!("no rules for {} yet (pods, workloads, Services, Ingresses, Jobs, CronJobs and Flux objects)", obj_ref.gvr.resource));
        return Ok(finish(obj_ref, out, at));
    };
    let session = state.session(context).await?;
    let obj = objects::get(&session, obj_ref).await?;
    match target {
        Target::Pod => {
            let input = pod_input(state, &session, context, obj_ref, obj, &mut out).await;
            pod_rules(obj_ref, &input, &mut out);
        }
        Target::Service => {
            let events = events_of(state, context, obj_ref, &mut out).await;
            let pods = match selector_string(&obj["spec"]["selector"]) {
                None => None,
                Some(sel) => match list(&session, &Gvr::new("", "v1", "pods"), obj_ref.ns(), Some(&sel)).await {
                    Ok(p) => Some(p),
                    Err(e) => {
                        // without the pods no endpoint rule can decide anything
                        side_note(&mut out, "pods", &e);
                        warning_events(&events, &mut out, &[]);
                        return Ok(finish(obj_ref, out, at));
                    }
                },
            };
            service_rules(obj_ref, &ServiceInput { svc: obj, events, pods }, &mut out);
        }
        Target::Deployment | Target::StatefulSet | Target::DaemonSet | Target::ReplicaSet => {
            let events = events_of(state, context, obj_ref, &mut out).await;
            let uid = s(&obj["metadata"]["uid"]).to_string();
            let selector = selector_string(&obj["spec"]["selector"]);
            let pods_gvr = Gvr::new("", "v1", "pods");
            let mut replica_sets = Vec::new();
            let mut owner_uid = uid.clone();
            if target == Target::Deployment
                && let Some(sel) = &selector
            {
                match list(&session, &Gvr::new("apps", "v1", "replicasets"), obj_ref.ns(), Some(sel)).await {
                    Ok(all) => replica_sets = all.into_iter().filter(|x| owned_by(x, &uid)).collect(),
                    Err(e) => side_note(&mut out, "ReplicaSets", &e),
                }
                // the newest revision owns the pods that matter
                if let Some(newest) = replica_sets.iter().max_by_key(|x| revision(x)) {
                    owner_uid = s(&newest["metadata"]["uid"]).to_string();
                }
            }
            let pods: Vec<Json> = match &selector {
                Some(sel) => match list(&session, &pods_gvr, obj_ref.ns(), Some(sel)).await {
                    Ok(all) => all.into_iter().filter(|p| owned_by(p, &owner_uid)).collect(),
                    Err(e) => {
                        side_note(&mut out, "pods", &e);
                        Vec::new()
                    }
                },
                None => Vec::new(),
            };
            let mut deep = Vec::new();
            for p in worst_pods(&pods).into_iter().take(MAX_PODS) {
                let pr = pod_ref(obj_ref, p);
                deep.push(pod_input(state, &session, context, &pr, p.clone(), &mut out).await);
            }
            let input = WorkloadInput { obj, events, replica_sets, pods, deep };
            workload_rules(obj_ref, target, &input, &mut out);
        }
        Target::Ingress | Target::Job | Target::CronJob | Target::Flux => c3::run(state, &session, target, obj_ref, obj, &mut out).await?,
    }
    Ok(finish(obj_ref, out, at))
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{Diagnosis, ObjRef, Result};

    #[tauri::command]
    pub async fn diagnose(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<Diagnosis> {
        super::diagnose(&state, &obj_ref.context, &obj_ref).await
    }
}

mod c3;
pub use c3::flux_source_ref;

#[cfg(test)]
mod tests;
