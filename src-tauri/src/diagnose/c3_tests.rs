//! Rule fixtures for the wave-3 `:why` rules (§3 C3): at least one per rule.
use serde_json::json;

use super::super::finish;
use super::*;
use crate::ipc::Diagnosis;

fn r(group: &str, version: &str, resource: &str, name: &str) -> ObjRef {
    ObjRef { context: "default".into(), gvr: Gvr::new(group, version, resource), namespace: Some("kns-spike".into()), name: name.into() }
}

fn done(rf: &ObjRef, out: Out) -> Diagnosis {
    finish(rf, out, "2026-11-22T10:10:00Z".into())
}

fn titles(d: &Diagnosis) -> Vec<String> {
    d.findings.iter().map(|f| f.title.clone()).collect()
}

fn ready_pod(name: &str, ready: bool) -> Json {
    json!({
        "metadata": { "name": name, "namespace": "kns-spike" },
        "status": { "phase": "Running", "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }] }
    })
}

fn ingress() -> Json {
    json!({
        "metadata": { "name": "web", "namespace": "kns-spike", "annotations": { "cert-manager.io/cluster-issuer": "letsencrypt" } },
        "spec": {
            "ingressClassName": "traefik",
            "tls": [{ "hosts": ["web.example"], "secretName": "web-tls" }],
            "rules": [{ "host": "web.example", "http": { "paths": [
                { "path": "/", "pathType": "Prefix", "backend": { "service": { "name": "web", "port": { "number": 80 } } } },
                { "path": "/api", "pathType": "Prefix", "backend": { "service": { "name": "api", "port": { "name": "http" } } } },
                { "path": "/old", "pathType": "Prefix", "backend": { "service": { "name": "gone", "port": { "number": 80 } } } }
            ] } }]
        },
        "status": { "loadBalancer": { "ingress": [{ "ip": "10.0.0.1" }] } }
    })
}

fn svc(name: &str, ports: Json) -> Json {
    json!({ "metadata": { "name": name }, "spec": { "selector": { "app": name }, "ports": ports } })
}

#[test]
fn ingress_backends_cover_default_and_rules() {
    let mut ing = ingress();
    ing["spec"]["defaultBackend"] = json!({ "service": { "name": "fallback", "port": { "number": 8080 } } });
    let b = ingress_backends(&ing);
    assert_eq!(b.len(), 4);
    assert_eq!(b[0].1, "fallback");
    assert_eq!(b[2], ("/spec/rules/0/http/paths/1/backend".into(), "api".into(), json!("http")));
}

#[test]
fn ingress_missing_service_wrong_port_no_pods_and_tls() {
    let rf = r("networking.k8s.io", "v1", "ingresses", "web");
    let input = IngressInput {
        ing: ingress(),
        events: vec![],
        backends: vec![
            Backend { path: "/spec/rules/0/http/paths/0/backend".into(), service: "web".into(), port: json!(80), svc: Some(svc("web", json!([{ "name": "http", "port": 80 }]))), pods: Some(vec![ready_pod("web-1", false)]) },
            Backend { path: "/spec/rules/0/http/paths/1/backend".into(), service: "api".into(), port: json!("http"), svc: Some(svc("api", json!([{ "name": "grpc", "port": 9090 }]))), pods: Some(vec![]) },
            Backend { path: "/spec/rules/0/http/paths/2/backend".into(), service: "gone".into(), port: json!(80), svc: Some(Json::Null), pods: None },
        ],
        tls: vec![TlsSecret { path: "/spec/tls/0".into(), name: "web-tls".into(), exists: Some(false) }],
        certificates: Some(vec![json!({
            "metadata": { "name": "web-cert" },
            "spec": { "secretName": "web-tls" },
            "status": { "conditions": [{ "type": "Ready", "status": "False", "reason": "DoesNotExist", "message": "Issuing certificate as Secret does not exist" }] }
        })]),
    };
    let mut out = Out::default();
    ingress_rules(&rf, &input, &mut out);
    let d = done(&rf, out);
    let t = titles(&d);
    assert!(t.contains(&"backend Service web has no ready pods (0 of 1)".to_string()), "{t:?}");
    assert!(t.contains(&"Service api has no port http".to_string()), "{t:?}");
    assert!(t.contains(&"backend Service gone does not exist".to_string()), "{t:?}");
    assert!(t.contains(&"TLS Secret web-tls does not exist".to_string()), "{t:?}");
    assert!(t.iter().any(|x| x.starts_with("Certificate web-cert is not Ready (DoesNotExist)")), "{t:?}");
    let tls = d.findings.iter().find(|f| f.title.starts_with("TLS Secret")).unwrap();
    assert_eq!(tls.detail.as_deref(), Some("cert-manager Certificate web-cert should create it"));
    assert!(d.findings.iter().all(|f| f.severity == Severity::Error));
}

#[test]
fn ingress_healthy_gives_no_error() {
    let rf = r("networking.k8s.io", "v1", "ingresses", "web");
    let mut ing = ingress();
    ing["spec"]["tls"] = json!([]);
    let input = IngressInput {
        ing,
        backends: vec![Backend { path: "/x".into(), service: "web".into(), port: json!(80), svc: Some(svc("web", json!([{ "port": 80 }]))), pods: Some(vec![ready_pod("web-1", true)]) }],
        ..Default::default()
    };
    let mut out = Out::default();
    ingress_rules(&rf, &input, &mut out);
    assert!(done(&rf, out).findings.is_empty());
}

#[test]
fn ingress_without_address_is_info() {
    let rf = r("networking.k8s.io", "v1", "ingresses", "web");
    let mut ing = ingress();
    ing["status"] = json!({});
    ing["spec"].as_object_mut().unwrap().remove("ingressClassName");
    let mut out = Out::default();
    ingress_rules(&rf, &IngressInput { ing, ..Default::default() }, &mut out);
    let d = done(&rf, out);
    assert_eq!(d.findings[0].title, "no address assigned yet");
    assert!(d.findings[0].detail.as_deref().unwrap().contains("no ingressClassName"));
}

fn ks(extra: Json) -> Json {
    let mut v = json!({
        "metadata": { "name": "apps", "namespace": "flux-system", "generation": 3 },
        "spec": { "interval": "10m", "path": "./apps", "sourceRef": { "kind": "GitRepository", "name": "flux-system" } },
        "status": { "observedGeneration": 3, "conditions": [{ "type": "Ready", "status": "True", "reason": "ReconciliationSucceeded", "message": "Applied revision: main@sha1:0123456789abcdef0123456789abcdef01234567" }],
            "lastAppliedRevision": "main@sha1:0123456789abcdef0123456789abcdef01234567",
            "lastAttemptedRevision": "main@sha1:0123456789abcdef0123456789abcdef01234567" }
    });
    merge(&mut v, extra);
    v
}

fn merge(a: &mut Json, b: Json) {
    match (a, b) {
        (Json::Object(a), Json::Object(b)) => {
            for (k, v) in b {
                merge(a.entry(k).or_insert(Json::Null), v);
            }
        }
        (a, b) => *a = b,
    }
}

fn ks_ref(name: &str) -> ObjRef {
    ObjRef { context: "default".into(), gvr: Gvr::new("kustomize.toolkit.fluxcd.io", "v1", "kustomizations"), namespace: Some("flux-system".into()), name: name.into() }
}

#[test]
fn flux_source_and_depends_parse() {
    let o = ks(json!({ "spec": { "dependsOn": [{ "name": "infra" }, { "name": "crds", "namespace": "other" }] } }));
    assert_eq!(flux_source_ref(&o), Some((None, "GitRepository".into(), "flux-system".into(), None)));
    assert_eq!(flux_depends(&o), vec![("infra".into(), None), ("crds".into(), Some("other".into()))]);
    let hr = json!({ "spec": { "chart": { "spec": { "chart": "x", "sourceRef": { "kind": "HelmRepository", "name": "bitnami", "namespace": "flux-system" } } } } });
    assert_eq!(flux_source_ref(&hr).unwrap().1, "HelmRepository");
}

#[test]
fn flux_not_ready_with_failed_revision() {
    let rf = ks_ref("apps");
    let o = ks(json!({ "status": {
        "conditions": [{ "type": "Ready", "status": "False", "reason": "BuildFailed", "message": "kustomize build failed: accumulating resources" }],
        "lastAttemptedRevision": "main@sha1:fedcba9876543210fedcba9876543210fedcba98"
    } }));
    let mut out = Out::default();
    flux_rules(&rf, &FluxInput { obj: o, ..Default::default() }, &mut out);
    let d = done(&rf, out);
    assert_eq!(d.findings[0].title, "not Ready: BuildFailed");
    assert!(titles(&d).contains(&"revision main@sha1:fedcba9 did not apply; still on main@sha1:0123456".to_string()), "{:?}", titles(&d));
}

#[test]
fn flux_suspended_dependency_and_source() {
    let rf = ks_ref("apps");
    let o = ks(json!({ "spec": { "suspend": true } }));
    let dep_ref = ks_ref("infra");
    let dep = ks(json!({ "status": { "conditions": [{ "type": "Ready", "status": "False", "reason": "HealthCheckFailed", "message": "timeout waiting for: [Deployment/infra/x status: 'InProgress']" }] } }));
    let missing = ks_ref("crds");
    let src_ref = ObjRef { gvr: Gvr::new("source.toolkit.fluxcd.io", "v1", "gitrepositories"), name: "flux-system".into(), ..rf.clone() };
    let src = json!({ "spec": {}, "status": { "conditions": [{ "type": "Ready", "status": "False", "reason": "GitOperationFailed", "message": "authentication required" }] } });
    let mut out = Out::default();
    flux_rules(&rf, &FluxInput { obj: o, events: vec![], source: Some((src_ref, src)), depends: vec![(dep_ref, dep), (missing, Json::Null)] }, &mut out);
    let d = done(&rf, out);
    let t = titles(&d);
    assert!(t.contains(&"reconciliation is suspended".to_string()));
    assert!(t.contains(&"waits for dependency infra (not Ready)".to_string()), "{t:?}");
    assert!(t.contains(&"depends on crds which does not exist".to_string()), "{t:?}");
    assert!(t.contains(&"source GitRepository flux-system is not Ready".to_string()), "{t:?}");
    // errors before the suspended warning
    assert_eq!(d.findings.last().unwrap().title, "reconciliation is suspended");
}

#[test]
fn flux_source_ahead_is_info_and_healthy_is_quiet() {
    let rf = ks_ref("apps");
    let src_ref = ObjRef { gvr: Gvr::new("source.toolkit.fluxcd.io", "v1", "gitrepositories"), name: "flux-system".into(), ..rf.clone() };
    let src = json!({ "status": { "artifact": { "revision": "main@sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "conditions": [{ "type": "Ready", "status": "True" }] } });
    let mut out = Out::default();
    flux_rules(&rf, &FluxInput { obj: ks(json!({})), source: Some((src_ref, src)), ..Default::default() }, &mut out);
    let d = done(&rf, out);
    assert_eq!(titles(&d), vec!["source is at main@sha1:aaaaaaa, applied is main@sha1:0123456".to_string()]);
    let mut out = Out::default();
    flux_rules(&rf, &FluxInput { obj: ks(json!({})), ..Default::default() }, &mut out);
    assert!(done(&rf, out).findings.is_empty());
}

#[test]
fn short_rev_keeps_non_hashes() {
    assert_eq!(short_rev("6.5.1@sha256:abcdefabcdefabcdefabcdef"), "6.5.1@sha256:abcdefa");
    assert_eq!(short_rev("v1.2.3"), "v1.2.3");
}

#[test]
fn job_backoff_limit_and_deep_pod() {
    let rf = r("batch", "v1", "jobs", "migrate");
    let job = json!({
        "metadata": { "name": "migrate" },
        "spec": { "backoffLimit": 2 },
        "status": { "failed": 3, "conditions": [{ "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded", "message": "Job has reached the specified backoff limit" }] }
    });
    let pod = json!({
        "metadata": { "name": "migrate-abc", "namespace": "kns-spike" },
        "spec": { "containers": [{ "name": "main", "image": "x" }] },
        "status": { "phase": "Failed", "containerStatuses": [{ "name": "main", "restartCount": 0, "state": { "terminated": { "exitCode": 2, "reason": "Error" } } }] }
    });
    let mut out = Out::default();
    job_rules(&rf, &JobInput { job, events: vec![], deep: vec![PodInput { pod, ..Default::default() }] }, &mut out);
    let d = done(&rf, out);
    assert_eq!(d.findings[0].title, "job failed (BackoffLimitExceeded)");
    assert!(d.findings[0].detail.as_deref().unwrap().contains("backoffLimit 2"));
    assert!(titles(&d).iter().any(|t| t.starts_with("pod migrate-abc: container main exited 2")), "{:?}", titles(&d));
}

#[test]
fn job_running_with_failures_and_complete() {
    let rf = r("batch", "v1", "jobs", "j");
    let mut out = Out::default();
    job_rules(&rf, &JobInput { job: json!({ "spec": {}, "status": { "failed": 1, "active": 1 } }), ..Default::default() }, &mut out);
    assert_eq!(done(&rf, out).findings[0].title, "1 pod failed so far");
    let mut out = Out::default();
    let ok = json!({ "status": { "startTime": "2026-11-22T10:00:00Z", "completionTime": "2026-11-22T10:01:30Z", "conditions": [{ "type": "Complete", "status": "True" }] } });
    job_rules(&rf, &JobInput { job: ok, ..Default::default() }, &mut out);
    let d = done(&rf, out);
    assert_eq!(d.findings[0].title, "job completed in 1m30s");
    assert_eq!(d.findings[0].severity, Severity::Info);
}

#[test]
fn cronjob_last_run_failed_suspended_and_never() {
    let rf = r("batch", "v1", "cronjobs", "nightly");
    let now: Timestamp = "2026-11-22T12:00:00Z".parse().unwrap();
    let cron = json!({ "spec": { "schedule": "0 3 * * *" }, "status": { "lastScheduleTime": "2026-11-22T03:00:00Z" } });
    let jobs = vec![
        json!({ "metadata": { "name": "nightly-1", "creationTimestamp": "2026-11-21T03:00:00Z" }, "status": { "conditions": [{ "type": "Failed", "status": "True", "reason": "BackoffLimitExceeded" }] } }),
        json!({ "metadata": { "name": "nightly-2", "creationTimestamp": "2026-11-22T03:00:00Z" }, "status": { "conditions": [{ "type": "Failed", "status": "True", "reason": "DeadlineExceeded", "message": "Job was active longer than specified deadline" }] } }),
    ];
    let mut out = Out::default();
    cronjob_rules(&rf, &CronJobInput { cron, events: vec![], jobs }, now, &mut out);
    let d = done(&rf, out);
    assert_eq!(d.findings[0].title, "last run nightly-2 failed (DeadlineExceeded)");
    assert!(titles(&d).contains(&"1 earlier run failed too".to_string()));

    let mut out = Out::default();
    cronjob_rules(&rf, &CronJobInput { cron: json!({ "spec": { "schedule": "*/5 * * * *", "suspend": true }, "status": {} }), ..Default::default() }, now, &mut out);
    assert_eq!(titles(&done(&rf, out)), vec!["CronJob is suspended: no new runs are scheduled".to_string()]);

    let mut out = Out::default();
    cronjob_rules(&rf, &CronJobInput { cron: json!({ "spec": { "schedule": "*/5 * * * *" }, "status": {} }), ..Default::default() }, now, &mut out);
    assert_eq!(titles(&done(&rf, out)), vec!["never scheduled yet (schedule */5 * * * *)".to_string()]);
}

#[test]
fn cronjob_long_running_with_forbid() {
    let rf = r("batch", "v1", "cronjobs", "nightly");
    let now: Timestamp = "2026-11-22T12:00:00Z".parse().unwrap();
    let cron = json!({ "spec": { "schedule": "0 * * * *", "concurrencyPolicy": "Forbid" }, "status": { "lastScheduleTime": "2026-11-22T09:00:00Z" } });
    let jobs = vec![json!({ "metadata": { "name": "nightly-9", "creationTimestamp": "2026-11-22T09:00:00Z" }, "status": { "active": 1, "startTime": "2026-11-22T09:00:00Z" } })];
    let mut out = Out::default();
    cronjob_rules(&rf, &CronJobInput { cron, events: vec![], jobs }, now, &mut out);
    let d = done(&rf, out);
    assert_eq!(d.findings[0].title, "run nightly-9 has been running for 3h");
    assert!(d.findings[0].detail.as_deref().unwrap().contains("Forbid"));
}

#[test]
fn targets_of_new_kinds() {
    use super::super::target_of;
    assert_eq!(target_of(&Gvr::new("networking.k8s.io", "v1", "ingresses")), Some(Target::Ingress));
    assert_eq!(target_of(&Gvr::new("batch", "v1", "jobs")), Some(Target::Job));
    assert_eq!(target_of(&Gvr::new("batch", "v1", "cronjobs")), Some(Target::CronJob));
    assert_eq!(target_of(&Gvr::new("helm.toolkit.fluxcd.io", "v2", "helmreleases")), Some(Target::Flux));
    assert_eq!(target_of(&Gvr::new("source.toolkit.fluxcd.io", "v1", "gitrepositories")), Some(Target::Flux));
    assert_eq!(target_of(&Gvr::new("", "v1", "configmaps")), None);
}

#[test]
fn flux_message_is_redacted() {
    let rf = ks_ref("apps");
    let o = ks(json!({ "status": { "conditions": [{ "type": "Ready", "status": "False", "reason": "X", "message": "clone https://bot:hunter2pass@git.example/repo failed" }] } }));
    let mut out = Out::default();
    flux_rules(&rf, &FluxInput { obj: o, ..Default::default() }, &mut out);
    let text = serde_json::to_string(&done(&rf, out)).unwrap();
    assert!(!text.contains("hunter2pass"), "{text}");
}
