//! `:why` rules added in wave 3 (§3 C3): Ingress, Flux objects, Job and CronJob.
//!
//! Same split as the rest of `diagnose`: the fetch functions read what the rules need and turn a
//! forbidden or missing side read into a note in `checked`; the rules are pure over JSON and tested
//! in `c3_tests`. Every text is redacted and cleaned by `finish` in the parent module.
use jiff::Timestamp;

use super::{
    Out, PodInput, Target, arr, condition, field, finding, human, int, list, pod_input, pod_ref, pod_rules, pod_healthy,
    pod_ready, s, selector_string, side_note, sort_findings, ts, warning_events, events_of,
};
use crate::{
    ipc::{EventRow, Evidence, Gvr, Json, ObjRef, Result, Severity},
    session::{Session, api_path},
    state::AppState,
};

/// Backend Services of an Ingress whose pods are counted.
const MAX_BACKENDS: usize = 5;
/// Dependencies of a Flux object that are read.
const MAX_DEPENDS: usize = 5;

pub const FLUX_SUFFIX: &str = ".toolkit.fluxcd.io";

fn obj(r: &ObjRef) -> Evidence {
    Evidence::Object { obj_ref: r.clone() }
}

fn sibling(r: &ObjRef, gvr: Gvr, namespace: Option<&str>, name: &str) -> ObjRef {
    ObjRef {
        context: r.context.clone(),
        gvr,
        namespace: namespace.map(str::to_string).or_else(|| r.namespace.clone()),
        name: name.to_string(),
    }
}

fn svc_gvr() -> Gvr {
    Gvr::new("", "v1", "services")
}

// ───────────────────────── Ingress ─────────────────────────

/// One backend Service as the Ingress names it, with what was found.
#[derive(Debug, Clone, Default)]
pub struct Backend {
    /// JSON pointer of the backend in the Ingress
    pub path: String,
    pub service: String,
    /// `port.number` or `port.name`
    pub port: Json,
    /// None: not read (forbidden); Some(Null): not found
    pub svc: Option<Json>,
    /// pods selected by the Service (None: not read or no selector)
    pub pods: Option<Vec<Json>>,
}

/// A TLS secret named by the Ingress: exists? (None: not read).
#[derive(Debug, Clone, Default)]
pub struct TlsSecret {
    pub path: String,
    pub name: String,
    pub exists: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct IngressInput {
    pub ing: Json,
    pub events: Vec<EventRow>,
    pub backends: Vec<Backend>,
    pub tls: Vec<TlsSecret>,
    /// cert-manager Certificates of the namespace (None: CRD absent or not readable)
    pub certificates: Option<Vec<Json>>,
}

/// Every backend of an Ingress: `(pointer, service, port)`; the default backend first.
pub fn ingress_backends(ing: &Json) -> Vec<(String, String, Json)> {
    let mut out = Vec::new();
    let spec = &ing["spec"];
    let mut push = |path: String, b: &Json| {
        if let Some(name) = b["service"]["name"].as_str() {
            let port = if b["service"]["port"]["number"].is_number() {
                b["service"]["port"]["number"].clone()
            } else {
                b["service"]["port"]["name"].clone()
            };
            out.push((path, name.to_string(), port));
        }
    };
    push("/spec/defaultBackend".into(), &spec["defaultBackend"]);
    for (i, rule) in arr(&spec["rules"]).iter().enumerate() {
        for (j, p) in arr(&rule["http"]["paths"]).iter().enumerate() {
            push(format!("/spec/rules/{i}/http/paths/{j}/backend"), &p["backend"]);
        }
    }
    out
}

fn port_text(p: &Json) -> String {
    match p {
        Json::Number(n) => n.to_string(),
        Json::String(x) => x.clone(),
        _ => "(no port)".into(),
    }
}

/// Does the Service expose this port (number = `port`, name = `name`)?
pub fn service_has_port(svc: &Json, port: &Json) -> bool {
    arr(&svc["spec"]["ports"]).iter().any(|p| match port {
        Json::Number(n) => p["port"].as_i64() == n.as_i64(),
        Json::String(name) => p["name"].as_str() == Some(name),
        _ => false,
    })
}

pub fn ingress_rules(r: &ObjRef, input: &IngressInput, out: &mut Out) {
    let ns = r.ns();
    out.check("backend Services");
    out.check("Service ports");
    let mut seen: Vec<(String, String)> = Vec::new();
    for b in &input.backends {
        let key = (b.service.clone(), port_text(&b.port));
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let svc_ref = sibling(r, svc_gvr(), ns, &b.service);
        let Some(svc) = &b.svc else { continue };
        if svc.is_null() {
            out.push(finding(
                Severity::Error,
                format!("backend Service {} does not exist", b.service),
                Some("requests for this path get 503 from the ingress controller".into()),
                vec![field(r, format!("{}/service/name", b.path), b.service.clone())],
            ));
            continue;
        }
        if !b.port.is_null() && !service_has_port(svc, &b.port) {
            let ports: Vec<String> = arr(&svc["spec"]["ports"])
                .iter()
                .map(|p| match p["name"].as_str() {
                    Some(n) => format!("{n} ({})", p["port"]),
                    None => p["port"].to_string(),
                })
                .collect();
            out.push(finding(
                Severity::Error,
                format!("Service {} has no port {}", b.service, port_text(&b.port)),
                Some(format!("the Service exposes {}", if ports.is_empty() { "no ports".into() } else { ports.join(", ") })),
                vec![field(r, format!("{}/service/port", b.path), port_text(&b.port)), obj(&svc_ref)],
            ));
            continue;
        }
        if let Some(pods) = &b.pods {
            let ready = pods.iter().filter(|p| pod_ready(p)).count();
            if ready == 0 {
                let title = if pods.is_empty() {
                    format!("backend Service {} selects 0 pods", b.service)
                } else {
                    format!("backend Service {} has no ready pods (0 of {})", b.service, pods.len())
                };
                let mut evidence = vec![obj(&svc_ref)];
                evidence.extend(pods.iter().take(3).map(|p| obj(&pod_ref(r, p))));
                out.push(finding(Severity::Error, title, Some("the ingress controller has no endpoint to send traffic to (503)".into()), evidence));
            }
        }
    }

    out.check("TLS secrets");
    for t in &input.tls {
        if t.exists != Some(false) {
            continue;
        }
        let cert = input
            .certificates
            .as_ref()
            .and_then(|list| list.iter().find(|c| c["spec"]["secretName"].as_str() == Some(t.name.as_str())));
        let detail = match cert {
            Some(c) => format!("cert-manager Certificate {} should create it", s(&c["metadata"]["name"])),
            None if has_issuer_annotation(&input.ing) => "cert-manager is asked to issue it (annotation), but no Certificate exists yet".into(),
            None => "the controller serves its default certificate for these hosts".into(),
        };
        out.push(finding(Severity::Error, format!("TLS Secret {} does not exist", t.name), Some(detail), vec![field(r, format!("{}/secretName", t.path), t.name.clone())]));
    }

    out.check("cert-manager Certificates");
    if let Some(certs) = &input.certificates {
        for t in &input.tls {
            let Some(c) = certs.iter().find(|c| c["spec"]["secretName"].as_str() == Some(t.name.as_str())) else { continue };
            let Some((i, ready)) = condition(c, "Ready") else { continue };
            if ready["status"].as_str() == Some("True") {
                continue;
            }
            let cert_ref = sibling(r, Gvr::new("cert-manager.io", "v1", "certificates"), ns, s(&c["metadata"]["name"]));
            let msg = s(&ready["message"]);
            out.push(finding(
                Severity::Error,
                format!("Certificate {} is not Ready ({})", s(&c["metadata"]["name"]), if ready["reason"].is_string() { s(&ready["reason"]) } else { "Ready=False" }),
                Some(msg.to_string()),
                vec![Evidence::Field { obj_ref: cert_ref.clone(), path: format!("/status/conditions/{i}/message"), value: msg.to_string() }, obj(&cert_ref)],
            ));
        }
    }

    out.check("address");
    let lb = arr(&input.ing["status"]["loadBalancer"]["ingress"]);
    if lb.is_empty() {
        out.push(finding(
            Severity::Info,
            "no address assigned yet",
            Some(match input.ing["spec"]["ingressClassName"].as_str() {
                Some(c) => format!("ingress class {c}: the controller has not published an address"),
                None => "no ingressClassName: only a default ingress class picks it up".into(),
            }),
            vec![field(r, "/status/loadBalancer", "")],
        ));
    }
    out.check("events");
    warning_events(&input.events, out, &[]);
}

fn has_issuer_annotation(ing: &Json) -> bool {
    ing["metadata"]["annotations"]
        .as_object()
        .is_some_and(|a| a.contains_key("cert-manager.io/cluster-issuer") || a.contains_key("cert-manager.io/issuer"))
}

// ───────────────────────── Flux ─────────────────────────

#[derive(Debug, Clone, Default)]
pub struct FluxInput {
    pub obj: Json,
    pub events: Vec<EventRow>,
    /// the source (`spec.sourceRef`, HelmRelease `spec.chart.spec.sourceRef` / `chartRef`):
    /// (ref, object; Null = not found). None: no source or not read
    pub source: Option<(ObjRef, Json)>,
    /// `spec.dependsOn`: (ref, object; Null = not found)
    pub depends: Vec<(ObjRef, Json)>,
}

fn ready_of(o: &Json) -> Option<(usize, &Json)> {
    condition(o, "Ready")
}

fn cond_text(c: &Json) -> String {
    [s(&c["reason"]), s(&c["message"])].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(": ")
}

pub fn flux_rules(r: &ObjRef, input: &FluxInput, out: &mut Out) {
    let o = &input.obj;
    out.check("suspended");
    if o["spec"]["suspend"].as_bool() == Some(true) {
        out.push(finding(
            Severity::Warn,
            "reconciliation is suspended",
            Some("Flux does not apply changes until it is resumed".into()),
            vec![field(r, "/spec/suspend", "true")],
        ));
    }

    out.check("Ready condition");
    let ready = ready_of(o);
    if let Some((i, c)) = ready {
        match c["status"].as_str() {
            Some("False") => out.push(finding(
                Severity::Error,
                format!("not Ready: {}", if c["reason"].is_string() { s(&c["reason"]) } else { "Ready=False" }),
                Some(s(&c["message"]).to_string()),
                vec![field(r, format!("/status/conditions/{i}/message"), s(&c["message"]))],
            )),
            Some("Unknown") => out.push(finding(
                Severity::Info,
                format!("reconciling ({})", if c["reason"].is_string() { s(&c["reason"]) } else { "Unknown" }),
                Some(s(&c["message"]).to_string()),
                vec![field(r, format!("/status/conditions/{i}/message"), s(&c["message"]))],
            )),
            _ => {}
        }
    }
    if let Some((i, c)) = condition(o, "Stalled")
        && c["status"].as_str() == Some("True")
    {
        out.push(finding(Severity::Error, "stalled: Flux stopped retrying", Some(cond_text(c)), vec![field(r, format!("/status/conditions/{i}"), s(&c["message"]))]));
    }

    out.check("dependsOn");
    for (dep_ref, dep) in &input.depends {
        if dep.is_null() {
            out.push(finding(
                Severity::Error,
                format!("depends on {} which does not exist", dep_label(dep_ref, r)),
                Some("Flux waits for it and never applies this one".into()),
                vec![field(r, "/spec/dependsOn", dep_ref.name.clone())],
            ));
            continue;
        }
        let dep_ready = ready_of(dep);
        if dep_ready.is_none_or(|(_, c)| c["status"].as_str() != Some("True")) {
            let why = dep_ready.map(|(_, c)| cond_text(c)).unwrap_or_else(|| "no Ready condition yet".into());
            out.push(finding(
                Severity::Error,
                format!("waits for dependency {} (not Ready)", dep_label(dep_ref, r)),
                Some(why),
                vec![obj(dep_ref)],
            ));
        }
    }

    out.check("source");
    if let Some((src_ref, src)) = &input.source {
        let label = format!("{} {}", kind_word(&src_ref.gvr.resource), src_ref.name);
        if src.is_null() {
            out.push(finding(Severity::Error, format!("source {label} does not exist"), None, vec![field(r, "/spec/sourceRef/name", src_ref.name.clone())]));
        } else if src["spec"]["suspend"].as_bool() == Some(true) {
            out.push(finding(Severity::Warn, format!("source {label} is suspended"), Some("no new revisions are fetched".into()), vec![obj(src_ref)]));
        } else if let Some((_, c)) = ready_of(src)
            && c["status"].as_str() == Some("False")
        {
            out.push(finding(Severity::Error, format!("source {label} is not Ready"), Some(cond_text(c)), vec![obj(src_ref)]));
        }
    }

    out.check("revision");
    let st = &o["status"];
    let (attempted, applied) = (s(&st["lastAttemptedRevision"]), s(&st["lastAppliedRevision"]));
    if !attempted.is_empty() && !applied.is_empty() && attempted != applied {
        out.push(finding(
            Severity::Warn,
            format!("revision {} did not apply; still on {}", short_rev(attempted), short_rev(applied)),
            ready.map(|(_, c)| s(&c["message"]).to_string()),
            vec![field(r, "/status/lastAttemptedRevision", attempted), field(r, "/status/lastAppliedRevision", applied)],
        ));
    } else if let Some((_, src)) = &input.source
        && !applied.is_empty()
    {
        let at = s(&src["status"]["artifact"]["revision"]);
        if !at.is_empty() && at != applied && !out.findings.iter().any(|f| f.severity == Severity::Error) {
            out.push(finding(
                Severity::Info,
                format!("source is at {}, applied is {}", short_rev(at), short_rev(applied)),
                Some("the next reconcile applies it (or :reconcile now)".into()),
                vec![field(r, "/status/lastAppliedRevision", applied)],
            ));
        }
    }
    if let (Some(g), Some(og)) = (int(&o["metadata"]["generation"]), int(&st["observedGeneration"]))
        && og < g
        && o["spec"]["suspend"].as_bool() != Some(true)
    {
        out.push(finding(Severity::Info, format!("latest spec (generation {g}) not reconciled yet (observed {og})"), None, vec![field(r, "/status/observedGeneration", og.to_string())]));
    }
    out.check("events");
    warning_events(&input.events, out, &[]);
}

fn dep_label(dep: &ObjRef, me: &ObjRef) -> String {
    if dep.namespace != me.namespace {
        format!("{}/{}", dep.namespace.as_deref().unwrap_or(""), dep.name)
    } else {
        dep.name.clone()
    }
}

fn kind_word(resource: &str) -> &str {
    match resource {
        "gitrepositories" => "GitRepository",
        "ocirepositories" => "OCIRepository",
        "helmrepositories" => "HelmRepository",
        "helmcharts" => "HelmChart",
        "buckets" => "Bucket",
        "kustomizations" => "Kustomization",
        "helmreleases" => "HelmRelease",
        other => other,
    }
}

/// `main@sha1:0123456789abcdef…` → `main@sha1:0123456`.
pub fn short_rev(rev: &str) -> String {
    match rev.rsplit_once(':') {
        Some((head, hash)) if hash.len() > 12 && hash.chars().all(|c| c.is_ascii_hexdigit()) => format!("{head}:{}", &hash[..7]),
        _ => rev.to_string(),
    }
}

/// The source reference of a Kustomization / HelmRelease / HelmChart: (apiVersion?, kind, name, namespace?).
pub fn flux_source_ref(o: &Json) -> Option<(Option<String>, String, String, Option<String>)> {
    let spec = &o["spec"];
    let r = [&spec["sourceRef"], &spec["chart"]["spec"]["sourceRef"], &spec["chartRef"]].into_iter().find(|x| x["kind"].is_string())?;
    Some((r["apiVersion"].as_str().map(str::to_string), s(&r["kind"]).to_string(), s(&r["name"]).to_string(), r["namespace"].as_str().map(str::to_string)))
}

/// `spec.dependsOn` entries: (name, namespace?).
pub fn flux_depends(o: &Json) -> Vec<(String, Option<String>)> {
    arr(&o["spec"]["dependsOn"]).iter().filter_map(|d| Some((d["name"].as_str()?.to_string(), d["namespace"].as_str().map(str::to_string)))).collect()
}

// ───────────────────────── Job / CronJob ─────────────────────────

#[derive(Debug, Clone, Default)]
pub struct JobInput {
    pub job: Json,
    pub events: Vec<EventRow>,
    /// the unhealthy pods diagnosed in depth (newest first, at most 2)
    pub deep: Vec<PodInput>,
}

pub fn job_rules(r: &ObjRef, input: &JobInput, out: &mut Out) {
    let j = &input.job;
    let st = &j["status"];
    out.check("conditions");
    let mut done = false;
    for (i, c) in arr(&st["conditions"]).iter().enumerate() {
        if c["status"].as_str() != Some("True") {
            continue;
        }
        match s(&c["type"]) {
            "Failed" => {
                done = true;
                let reason = s(&c["reason"]);
                let detail = match reason {
                    "BackoffLimitExceeded" => format!("{}; backoffLimit {}", s(&c["message"]), int(&j["spec"]["backoffLimit"]).unwrap_or(6)),
                    "DeadlineExceeded" => format!("{}; activeDeadlineSeconds {}", s(&c["message"]), int(&j["spec"]["activeDeadlineSeconds"]).unwrap_or(0)),
                    _ => s(&c["message"]).to_string(),
                };
                out.push(finding(
                    Severity::Error,
                    format!("job failed ({})", if reason.is_empty() { "Failed" } else { reason }),
                    Some(detail),
                    vec![field(r, format!("/status/conditions/{i}"), s(&c["message"]))],
                ));
            }
            "Complete" => {
                done = true;
                let took = super::lifetime(&st["startTime"], &st["completionTime"]).map(|x| format!(" in {}", human(x))).unwrap_or_default();
                out.push(finding(Severity::Info, format!("job completed{took}"), None, vec![field(r, "/status/completionTime", s(&st["completionTime"]))]));
            }
            "Suspended" => out.push(finding(Severity::Warn, "job is suspended", None, vec![field(r, "/spec/suspend", "true")])),
            _ => {}
        }
    }
    out.check("pods");
    let failed = int(&st["failed"]).unwrap_or(0);
    if !done && failed > 0 {
        out.push(finding(
            Severity::Warn,
            format!("{failed} pod{} failed so far", if failed == 1 { "" } else { "s" }),
            Some(format!("backoffLimit {}; {} active", int(&j["spec"]["backoffLimit"]).unwrap_or(6), int(&st["active"]).unwrap_or(0))),
            vec![field(r, "/status/failed", failed.to_string())],
        ));
    }
    out.check("pods of the job");
    for p in &input.deep {
        let pr = pod_ref(r, &p.pod);
        let mut sub = Out::default();
        pod_rules(&pr, p, &mut sub);
        sort_findings(&mut sub.findings);
        if let Some(mut f) = sub.findings.into_iter().find(|f| f.severity != Severity::Info) {
            f.title = format!("pod {}: {}", pr.name, f.title);
            f.evidence.insert(0, obj(&pr));
            out.push(f);
        }
    }
    out.check("events");
    warning_events(&input.events, out, &[]);
}

#[derive(Debug, Clone, Default)]
pub struct CronJobInput {
    pub cron: Json,
    pub events: Vec<EventRow>,
    /// Jobs it owns
    pub jobs: Vec<Json>,
}

fn job_failed(j: &Json) -> Option<&Json> {
    arr(&j["status"]["conditions"]).iter().find(|c| s(&c["type"]) == "Failed" && s(&c["status"]) == "True")
}

pub fn cronjob_rules(r: &ObjRef, input: &CronJobInput, now: Timestamp, out: &mut Out) {
    let c = &input.cron;
    out.check("suspended");
    if c["spec"]["suspend"].as_bool() == Some(true) {
        out.push(finding(Severity::Warn, "CronJob is suspended: no new runs are scheduled", None, vec![field(r, "/spec/suspend", "true")]));
    }
    out.check("schedule");
    let last = ts(&c["status"]["lastScheduleTime"]);
    if last.is_none() && c["spec"]["suspend"].as_bool() != Some(true) {
        out.push(finding(
            Severity::Info,
            format!("never scheduled yet (schedule {})", s(&c["spec"]["schedule"])),
            c["spec"]["timeZone"].as_str().map(|z| format!("time zone {z}")),
            vec![field(r, "/spec/schedule", s(&c["spec"]["schedule"]))],
        ));
    }
    out.check("last run");
    let job_gvr = Gvr::new("batch", "v1", "jobs");
    let mut jobs: Vec<&Json> = input.jobs.iter().collect();
    jobs.sort_by_key(|j| std::cmp::Reverse(s(&j["metadata"]["creationTimestamp"]).to_string()));
    if let Some(newest) = jobs.first() {
        let jr = sibling(r, job_gvr.clone(), r.ns(), s(&newest["metadata"]["name"]));
        if let Some(f) = job_failed(newest) {
            out.push(finding(
                Severity::Error,
                format!("last run {} failed ({})", jr.name, if f["reason"].is_string() { s(&f["reason"]) } else { "Failed" }),
                Some(s(&f["message"]).to_string()),
                vec![obj(&jr)],
            ));
        } else if int(&newest["status"]["active"]).unwrap_or(0) > 0
            && let Some(start) = ts(&newest["status"]["startTime"])
        {
            let running = now.as_second() - start.as_second();
            if running > 3600 {
                let policy = c["spec"]["concurrencyPolicy"].as_str().unwrap_or("Allow");
                let detail = (policy == "Forbid").then(|| "concurrencyPolicy Forbid: later runs are skipped while it runs".to_string());
                out.push(finding(Severity::Warn, format!("run {} has been running for {}", jr.name, human(running)), detail, vec![obj(&jr)]));
            }
        }
    }
    let failed_older = jobs.iter().skip(1).filter(|j| job_failed(j).is_some()).count();
    if failed_older > 0 {
        out.push(finding(Severity::Info, format!("{failed_older} earlier run{} failed too", if failed_older == 1 { "" } else { "s" }), None, vec![]));
    }
    out.check("events");
    warning_events(&input.events, out, &[]);
}

// ───────────────────────── fetch ─────────────────────────

async fn get_opt(session: &Session, gvr: &Gvr, ns: Option<&str>, name: &str, what: &str, out: &mut Out) -> Option<Json> {
    match session.get(&api_path(gvr, ns, Some(name))).await {
        Ok(v) => Some(v),
        Err(e) if e.code == 404 => Some(Json::Null),
        Err(e) => {
            side_note(out, what, &e);
            None
        }
    }
}

/// Metadata of a Secret only (`PartialObjectMetadata`): the values never reach kns.
async fn secret_exists(session: &Session, ns: Option<&str>, name: &str, out: &mut Out) -> Option<bool> {
    let uri = api_path(&Gvr::new("", "v1", "secrets"), ns, Some(name));
    match session.get_as::<Json>(&uri, "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1").await {
        Ok(_) => Some(true),
        Err(e) if e.code == 404 => Some(false),
        Err(e) => {
            side_note(out, &format!("Secret {name}"), &e);
            None
        }
    }
}

/// The served gvr of a kind in a group: `apiVersion` when given and served, else the preferred version.
async fn gvr_of(session: &Session, api_version: Option<&str>, group: &str, kind: &str) -> Option<Gvr> {
    let d = session.discovery(None).await.ok()?;
    if let Some(av) = api_version
        && let Some((g, v)) = av.split_once('/')
        && let Some(r) = d.by_kind(g, v, kind)
    {
        return Some(r.gvr.clone());
    }
    d.preferred.iter().find(|r| r.gvr.group == group && r.kind == kind).map(|r| r.gvr.clone())
}

pub async fn ingress_input(state: &AppState, session: &Session, r: &ObjRef, ing: Json, out: &mut Out) -> IngressInput {
    let events = events_of(state, &r.context, r, out).await;
    let ns = r.ns();
    let mut backends = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (path, name, port) in ingress_backends(&ing) {
        let cached = backends.iter().find(|b: &&Backend| b.service == name).map(|b| (b.svc.clone(), b.pods.clone()));
        let (svc, pods) = match cached {
            Some(c) => c,
            None if seen.len() >= MAX_BACKENDS => continue,
            None => {
                seen.push(name.clone());
                let svc = get_opt(session, &svc_gvr(), ns, &name, &format!("Service {name}"), out).await;
                let pods = match svc.as_ref().and_then(|v| selector_string(&v["spec"]["selector"])) {
                    Some(sel) => match list(session, &Gvr::new("", "v1", "pods"), ns, Some(&sel)).await {
                        Ok(p) => Some(p),
                        Err(e) => {
                            side_note(out, "pods", &e);
                            None
                        }
                    },
                    None => None,
                };
                (svc, pods)
            }
        };
        backends.push(Backend { path, service: name, port, svc, pods });
    }
    let mut tls = Vec::new();
    for (i, t) in arr(&ing["spec"]["tls"]).iter().enumerate() {
        let Some(name) = t["secretName"].as_str() else { continue };
        let exists = secret_exists(session, ns, name, out).await;
        tls.push(TlsSecret { path: format!("/spec/tls/{i}"), name: name.to_string(), exists });
    }
    let certificates = if tls.is_empty() {
        None
    } else {
        match gvr_of(session, None, "cert-manager.io", "Certificate").await {
            None => None,
            Some(gvr) => match list(session, &gvr, ns, None).await {
                Ok(v) => Some(v),
                Err(e) => {
                    side_note(out, "Certificates", &e);
                    None
                }
            },
        }
    };
    IngressInput { ing, events, backends, tls, certificates }
}

pub async fn flux_input(state: &AppState, session: &Session, r: &ObjRef, o: Json, out: &mut Out) -> FluxInput {
    let events = events_of(state, &r.context, r, out).await;
    let ns = r.ns();
    let mut source = None;
    if let Some((av, kind, name, src_ns)) = flux_source_ref(&o) {
        match gvr_of(session, av.as_deref(), "source.toolkit.fluxcd.io", &kind).await {
            Some(gvr) => {
                let src_ns = src_ns.or_else(|| ns.map(str::to_string));
                let sr = sibling(r, gvr.clone(), src_ns.as_deref(), &name);
                if let Some(v) = get_opt(session, &gvr, src_ns.as_deref(), &name, &format!("{kind} {name}"), out).await {
                    source = Some((sr, v));
                }
            }
            None => out.check(&format!("source {kind} {name}: kind not served")),
        }
    }
    let mut depends = Vec::new();
    for (name, dep_ns) in flux_depends(&o).into_iter().take(MAX_DEPENDS) {
        let dep_ns = dep_ns.or_else(|| ns.map(str::to_string));
        let dr = sibling(r, r.gvr.clone(), dep_ns.as_deref(), &name);
        if let Some(v) = get_opt(session, &r.gvr, dep_ns.as_deref(), &name, &format!("dependency {name}"), out).await {
            depends.push((dr, v));
        }
    }
    FluxInput { obj: o, events, source, depends }
}

pub async fn job_input(state: &AppState, session: &Session, r: &ObjRef, job: Json, out: &mut Out) -> JobInput {
    let events = events_of(state, &r.context, r, out).await;
    let pods = match selector_string(&job["spec"]["selector"]) {
        Some(sel) => match list(session, &Gvr::new("", "v1", "pods"), r.ns(), Some(&sel)).await {
            Ok(p) => p,
            Err(e) => {
                side_note(out, "pods", &e);
                Vec::new()
            }
        },
        None => Vec::new(),
    };
    let mut worst: Vec<&Json> = pods.iter().filter(|p| !pod_healthy(p)).collect();
    // the newest failed pod says most about why it fails now
    worst.sort_by_key(|p| std::cmp::Reverse(s(&p["metadata"]["creationTimestamp"]).to_string()));
    let mut deep = Vec::new();
    for p in worst.into_iter().take(2) {
        let pr = pod_ref(r, p);
        deep.push(pod_input(state, session, &r.context, &pr, p.clone(), out).await);
    }
    JobInput { job, events, deep }
}

pub async fn cronjob_input(state: &AppState, session: &Session, r: &ObjRef, cron: Json, out: &mut Out) -> CronJobInput {
    let events = events_of(state, &r.context, r, out).await;
    let uid = s(&cron["metadata"]["uid"]).to_string();
    let jobs = match list(session, &Gvr::new("batch", "v1", "jobs"), r.ns(), None).await {
        Ok(all) => all.into_iter().filter(|j| super::owned_by(j, &uid)).collect(),
        Err(e) => {
            side_note(out, "Jobs", &e);
            Vec::new()
        }
    };
    CronJobInput { cron, events, jobs }
}

/// Fetch + rules for the wave-3 kinds.
pub async fn run(state: &AppState, session: &Session, target: Target, r: &ObjRef, o: Json, out: &mut Out) -> Result<()> {
    match target {
        Target::Ingress => {
            let input = ingress_input(state, session, r, o, out).await;
            ingress_rules(r, &input, out);
        }
        Target::Flux => {
            let input = flux_input(state, session, r, o, out).await;
            flux_rules(r, &input, out);
        }
        Target::Job => {
            let input = job_input(state, session, r, o, out).await;
            job_rules(r, &input, out);
        }
        Target::CronJob => {
            let input = cronjob_input(state, session, r, o, out).await;
            cronjob_rules(r, &input, Timestamp::now(), out);
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
#[path = "c3_tests.rs"]
mod tests;

