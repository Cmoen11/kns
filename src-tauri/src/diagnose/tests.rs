//! Rule fixtures (§3 C1): at least one per rule, plus "no known cause found".
use std::{collections::BTreeMap, sync::LazyLock};

use serde_json::json;

use super::*;

static FIXTURES: LazyLock<Json> = LazyLock::new(|| serde_json::from_str(include_str!("fixtures.json")).expect("fixtures.json"));

fn fx(name: &str) -> Json {
    let v = FIXTURES[name].clone();
    assert!(!v.is_null(), "fixture {name}");
    v
}

fn pod_ref(name: &str) -> ObjRef {
    ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some("kns-spike".into()), name: name.into() }
}

fn ev(type_: &str, reason: &str, message: &str) -> EventRow {
    EventRow {
        type_: type_.into(),
        reason: reason.into(),
        message: message.into(),
        count: 2,
        last_seen: Some("2026-11-22T10:01:00Z".into()),
        source: "kubelet".into(),
        object_kind: "Pod".into(),
        object_name: "x".into(),
        namespace: Some("kns-spike".into()),
    }
}

fn run_pod(input: PodInput) -> Diagnosis {
    let r = pod_ref(s(&input.pod["metadata"]["name"]));
    let mut out = Out::default();
    pod_rules(&r, &input, &mut out);
    finish(&r, out, "2026-11-22T10:10:00Z".into())
}

fn pod(name: &str) -> PodInput {
    PodInput { pod: fx(name), ..Default::default() }
}

fn first(d: &Diagnosis) -> &Finding {
    d.findings.first().unwrap_or_else(|| panic!("no findings: {d:?}"))
}

fn has_log(f: &Finding, text: &str) -> bool {
    f.evidence.iter().any(|e| matches!(e, Evidence::LogLine { text: t, .. } if t.contains(text)))
}

#[test]
fn crashloop_first_finding_is_the_container_with_restarts_and_exit() {
    let mut input = pod("crashy");
    input.events = vec![ev("Warning", "BackOff", "Back-off restarting failed container main")];
    input.logs = BTreeMap::from([(
        "main".to_string(),
        (true, vec![LogTail { ts: "2026-11-22T10:00:02Z".into(), text: "panic: missing env KAFKA_BOOTSTRAP_SERVERS".into() }]),
    )]);
    let d = run_pod(input);
    let f = first(&d);
    assert_eq!(f.severity, Severity::Error);
    assert_eq!(f.title, "container main restarts: last exit 1 (Error) after 3s");
    let detail = f.detail.as_deref().unwrap_or_default();
    assert!(detail.contains("application error") && detail.contains("CrashLoopBackOff, 12 restarts"), "{detail}");
    assert!(has_log(f, "panic: missing env"));
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Field { path, value, .. } if path == "/status/containerStatuses/0/lastState/terminated/exitCode" && value == "1")));
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Event { event } if event.reason == "BackOff")));
    // the not-ready condition is explained by the crash, so no separate "not ready" finding
    assert!(!d.findings.iter().any(|f| f.title == "pod is not ready"));
}

#[test]
fn oomkilled_names_limit_and_lifetime() {
    let d = run_pod(pod("oomy"));
    let f = first(&d);
    assert_eq!(f.title, "container main was OOMKilled (exit 137) after 41s");
    // running again: a warning, it is not down now
    assert_eq!(f.severity, Severity::Warn);
    assert!(f.detail.as_deref().unwrap_or_default().contains("memory limit 32Mi"));
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Field { path, value, .. } if path == "/spec/containers/0/resources/limits/memory" && value == "32Mi")));
}

#[test]
fn image_pull_failure() {
    let mut input = pod("pullfail");
    input.events = vec![ev("Warning", "Failed", "Failed to pull image \"busybox:does-not-exist\": not found")];
    let d = run_pod(input);
    let f = first(&d);
    assert_eq!(f.title, "container main: image pull fails (ImagePullBackOff): busybox:does-not-exist");
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Field { path, .. } if path == "/spec/containers/0/image")));
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Event { .. })));
}

#[test]
fn failed_scheduling_is_parsed() {
    let mut input = pod("unschedulable");
    input.events = vec![ev(
        "Warning",
        "FailedScheduling",
        "0/3 nodes are available: 1 Insufficient memory, 2 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.",
    )];
    let d = run_pod(input);
    let f = first(&d);
    assert_eq!(f.title, "not scheduled: node(s) had untolerated taint {node-role.kubernetes.io/control-plane: } (2 of 3 nodes)");
    assert!(f.detail.as_deref().unwrap_or_default().contains("1× Insufficient memory"));
    assert!(!d.findings.iter().any(|f| f.title == "pod is Pending"));
}

#[test]
fn parse_failed_scheduling_handles_commas_in_reasons() {
    let (total, r) = parse_failed_scheduling("0/5 nodes are available: 3 node(s) didn't match Pod's node affinity/selector, 2 node(s) had taint {a: b, c}, that the pod didn't tolerate.");
    assert_eq!(total, Some(5));
    assert_eq!(r[0], (3, "node(s) didn't match Pod's node affinity/selector".to_string()));
    assert_eq!(r[1].0, 2);
    assert!(r[1].1.contains("{a: b, c}"));
    assert_eq!(parse_failed_scheduling("no idea"), (None, vec![]));
}

#[test]
fn missing_secret_points_at_the_env_reference() {
    let d = run_pod(pod("configerror"));
    let f = first(&d);
    assert_eq!(f.title, "Secret envdemo not found");
    assert_eq!(f.detail.as_deref(), Some("referenced by env PASSWORD of main"));
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Field { path, .. } if path == "/spec/containers/0/env/0/valueFrom/secretKeyRef")));
}

#[test]
fn missing_key_and_failed_mount() {
    assert_eq!(
        parse_missing_ref("couldn't find key PASSWORD in Secret kns-spike/envdemo"),
        Some(("secret".into(), "envdemo".into(), Some("PASSWORD".into())))
    );
    assert_eq!(parse_missing_ref("configmap \"envdemo\" not found"), Some(("configmap".into(), "envdemo".into(), None)));
    assert_eq!(parse_missing_ref("all good"), None);

    let mut input = pod("configerror");
    input.pod["status"]["containerStatuses"][0]["state"]["waiting"]["reason"] = json!("ContainerCreating");
    input.events = vec![ev("Warning", "FailedMount", "MountVolume.SetUp failed for volume \"cfg\" : configmap \"envdemo\" not found")];
    let d = run_pod(input);
    let f = first(&d);
    assert_eq!(f.title, "ConfigMap envdemo not found");
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Field { path, .. } if path == "/spec/containers/0/envFrom/0/configMapRef")));
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Event { .. })));
}

#[test]
fn readiness_probe() {
    let mut input = pod("probed");
    input.events = vec![ev("Warning", "Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503")];
    let d = run_pod(input);
    let f = first(&d);
    assert_eq!(f.title, "readiness probe fails in nginx: HTTP probe failed with statuscode: 503");
    assert_eq!(f.severity, Severity::Warn);
    assert!(f.evidence.iter().any(|e| matches!(e, Evidence::Field { value, .. } if value == "httpGet :8080/healthz")));
}

#[test]
fn not_ready_without_explanation() {
    let d = run_pod(pod("probed"));
    assert_eq!(first(&d).title, "pod is not ready");
}

#[test]
fn pending_pvc() {
    let mut input = pod("pvc");
    input.pvcs = vec![json!({ "metadata": { "name": "data-db-0" }, "spec": { "storageClassName": "local-path" }, "status": { "phase": "Pending" } })];
    let d = run_pod(input);
    assert!(d.findings.iter().any(|f| f.title == "PersistentVolumeClaim data-db-0 is Pending" && f.detail.as_deref() == Some("storage class local-path")));
    assert_eq!(first(&d).title, "not scheduled: Unschedulable");
}

#[test]
fn evicted() {
    let d = run_pod(pod("evicted"));
    assert_eq!(first(&d).title, "pod was evicted");
    assert_eq!(first(&d).detail.as_deref(), Some("The node was low on resource: memory."));
}

#[test]
fn init_container_exit_127() {
    let d = run_pod(pod("init"));
    let f = first(&d);
    assert_eq!(f.title, "init container migrate restarts: last exit 127 (Error) after 1s");
    assert!(f.detail.as_deref().unwrap_or_default().contains("command not found"));
}

#[test]
fn healthy_pod_has_no_known_cause_but_says_what_was_checked() {
    let d = run_pod(pod("healthy"));
    assert!(d.findings.is_empty(), "{:?}", d.findings);
    for c in ["phase", "containers", "probes", "events"] {
        assert!(d.checked.iter().any(|x| x == c), "{c} in {:?}", d.checked);
    }
}

#[test]
fn liveness_probe_is_an_error() {
    let mut input = pod("healthy");
    input.pod["spec"]["containers"][0]["livenessProbe"] = json!({ "tcpSocket": { "port": "http" } });
    input.events = vec![ev("Warning", "Unhealthy", "Liveness probe failed: dial tcp 10.0.0.1:80: connect: connection refused")];
    let d = run_pod(input);
    assert_eq!(first(&d).severity, Severity::Error);
    assert!(first(&d).evidence.iter().any(|e| matches!(e, Evidence::Field { value, .. } if value == "tcpSocket :http")));
}

#[test]
fn terminating_pod_lists_finalizers() {
    let mut input = pod("healthy");
    input.pod["metadata"]["deletionTimestamp"] = json!("2026-11-22T10:00:00Z");
    input.pod["metadata"]["finalizers"] = json!(["example.com/hold"]);
    let d = run_pod(input);
    assert!(d.findings.iter().any(|f| f.severity == Severity::Info && f.detail.as_deref() == Some("finalizers: example.com/hold")));
}

#[test]
fn exit_code_table() {
    assert_eq!(exit_meaning(0), "exited normally");
    assert_eq!(exit_meaning(1), "application error");
    assert!(exit_meaning(2).contains("bad arguments"));
    assert!(exit_meaning(126).contains("not executable"));
    assert!(exit_meaning(127).contains("not found"));
    assert!(exit_meaning(137).starts_with("SIGKILL"));
    assert!(exit_meaning(139).starts_with("SIGSEGV"));
    assert!(exit_meaning(143).starts_with("SIGTERM"));
    assert_eq!(exit_meaning(130), "killed by SIGINT");
    assert_eq!(exit_meaning(134), "killed by SIGABRT");
    assert_eq!(exit_meaning(150), "killed by signal 22");
    assert_eq!(exit_meaning(3), "application-defined exit code");
}

#[test]
fn human_durations() {
    assert_eq!(human(3), "3s");
    assert_eq!(human(41), "41s");
    assert_eq!(human(330), "5m30s");
    assert_eq!(human(1500), "25m");
    assert_eq!(human(3 * 3600 + 12 * 60), "3h12m");
    assert_eq!(human(2 * 86_400 + 4 * 3600), "2d4h");
    assert_eq!(human(-5), "0s");
}

#[test]
fn selector_strings() {
    assert_eq!(selector_string(&json!({ "app": "web" })).as_deref(), Some("app=web"));
    assert_eq!(
        selector_string(&json!({ "matchLabels": { "app": "web" }, "matchExpressions": [{ "key": "tier", "operator": "In", "values": ["a", "b"] }] })).as_deref(),
        Some("app=web,tier in (a,b)")
    );
    assert_eq!(selector_string(&json!({})), None);
}

// ── services ──

fn svc_ref() -> ObjRef {
    ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", "services"), namespace: Some("kns-spike".into()), name: "db".into() }
}

fn run_svc(input: ServiceInput) -> Diagnosis {
    let mut out = Out::default();
    service_rules(&svc_ref(), &input, &mut out);
    finish(&svc_ref(), out, "t".into())
}

fn svc(target_port: Json) -> Json {
    json!({ "metadata": { "name": "db" }, "spec": { "type": "ClusterIP", "selector": { "app": "db" }, "ports": [{ "name": "pg", "port": 5432, "targetPort": target_port }] } })
}

#[test]
fn service_with_no_pods() {
    let d = run_svc(ServiceInput { svc: svc(json!(5432)), events: vec![], pods: Some(vec![]) });
    let f = first(&d);
    assert_eq!(f.title, "selector matches 0 pods");
    assert_eq!(f.detail.as_deref(), Some("app=db"));
}

fn unready_with_port() -> Json {
    let mut p = fx("probed");
    p["spec"]["containers"][0]["ports"] = json!([{ "name": "http", "containerPort": 8080 }]);
    p
}

#[test]
fn service_pods_not_ready_and_bad_target_port() {
    let d = run_svc(ServiceInput { svc: svc(json!("postgres")), events: vec![], pods: Some(vec![fx("healthy"), unready_with_port()]) });
    assert_eq!(first(&d).title, "targetPort postgres names no container port");
    let nr = d.findings.iter().find(|f| f.title == "1 of 2 pods not ready").expect("not ready");
    assert_eq!(nr.severity, Severity::Warn);
    assert!(matches!(&nr.evidence[0], Evidence::Object { obj_ref } if obj_ref.name == "web-2"));
    // a named targetPort that exists is fine
    let d = run_svc(ServiceInput { svc: svc(json!("http")), events: vec![], pods: Some(vec![unready_with_port()]) });
    assert!(d.findings.iter().all(|f| !f.title.starts_with("targetPort")), "{:?}", d.findings);
}

#[test]
fn service_without_selector_and_external_name() {
    let mut s = svc(json!(1));
    s["spec"]["selector"] = Json::Null;
    let d = run_svc(ServiceInput { svc: s, events: vec![], pods: None });
    assert!(first(&d).title.starts_with("no selector"));
    let ext = json!({ "spec": { "type": "ExternalName", "externalName": "db.example.com" } });
    let d = run_svc(ServiceInput { svc: ext, events: vec![], pods: None });
    assert_eq!(first(&d).title, "ExternalName Service: resolves to db.example.com");
}

// ── workloads ──

fn deploy_ref() -> ObjRef {
    ObjRef { context: "default".into(), gvr: Gvr::new("apps", "v1", "deployments"), namespace: Some("kns-spike".into()), name: "crashy".into() }
}

fn rs(name: &str, rev: &str, image: &str, token: &str) -> Json {
    json!({
        "metadata": { "name": name, "uid": format!("uid-{name}"), "annotations": { "deployment.kubernetes.io/revision": rev } },
        "spec": { "template": {
            "metadata": { "labels": { "app": "crashy", "pod-template-hash": name } },
            "spec": { "containers": [{ "name": "main", "image": image, "env": [{ "name": "API_TOKEN", "value": token }] }] }
        } }
    })
}

#[test]
fn deployment_reports_ready_count_pod_cause_and_what_changed() {
    let crashy = fx("crashy");
    let obj = json!({
        "metadata": { "name": "crashy", "uid": "d1" },
        "spec": { "replicas": 2 },
        "status": { "readyReplicas": 0, "conditions": [
            { "type": "Available", "status": "False", "reason": "MinimumReplicasUnavailable", "message": "Deployment does not have minimum availability." },
            { "type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded", "message": "ReplicaSet \"crashy-2\" has timed out progressing." }
        ] }
    });
    let input = WorkloadInput {
        obj,
        events: vec![],
        // revision 10 sorts after revision 9 numerically, not as text
        replica_sets: vec![rs("crashy-9", "9", "busybox:1.36", "old-s3cr3t"), rs("crashy-10", "10", "busybox:1.37.0", "s3cr3t-value")],
        pods: vec![crashy.clone(), crashy.clone()],
        deep: vec![PodInput { pod: crashy, ..Default::default() }],
    };
    let mut out = Out::default();
    workload_rules(&deploy_ref(), Target::Deployment, &input, &mut out);
    let d = finish(&deploy_ref(), out, "t".into());
    assert_eq!(first(&d).title, "rollout is stuck (ProgressDeadlineExceeded)");
    assert!(d.findings.iter().any(|f| f.title == "0 of 2 pods ready" && f.severity == Severity::Error));
    let pod_f = d.findings.iter().find(|f| f.title.starts_with("pod crashy-7d9f-abcde: container main restarts")).expect("pod finding");
    assert!(matches!(&pod_f.evidence[0], Evidence::Object { obj_ref } if obj_ref.name == "crashy-7d9f-abcde"));
    let changed = d.findings.iter().find(|f| f.title.starts_with("revision 10 changed:")).expect("what changed");
    assert_eq!(changed.severity, Severity::Info);
    assert!(changed.title.contains("busybox:1.36 → busybox:1.37.0"), "{}", changed.title);
    match &changed.evidence[0] {
        Evidence::Diff { left, right, left_ref, right_ref } => {
            assert!(left.contains("spec.containers[main].image: busybox:1.36"));
            assert!(right.contains("spec.containers[main].image: busybox:1.37.0"));
            assert!(!left.contains("pod-template-hash"));
            assert_eq!(left_ref.as_ref().map(|r| r.name.as_str()), Some("crashy-9"));
            assert_eq!(right_ref.as_ref().map(|r| r.name.as_str()), Some("crashy-10"));
        }
        other => panic!("{other:?}"),
    }
    // the secret-named env value changed too, but only the mask may show
    let all = serde_json::to_string(&d).expect("json");
    assert!(!all.contains("s3cr3t"), "{all}");
    // both templates masked API_TOKEN: counted in the diagnosis
    assert!(d.redactions.as_ref().is_some_and(|r| r.by_rule.get("key").copied().unwrap_or(0) >= 2), "{:?}", d.redactions);
}

#[test]
fn healthy_workload_has_no_what_changed() {
    let input = WorkloadInput {
        obj: json!({ "metadata": { "uid": "d1" }, "spec": { "replicas": 1 }, "status": { "readyReplicas": 1 } }),
        replica_sets: vec![rs("a-1", "1", "x:1", "t"), rs("a-2", "2", "x:2", "t")],
        pods: vec![fx("healthy")],
        ..Default::default()
    };
    let mut out = Out::default();
    workload_rules(&deploy_ref(), Target::Deployment, &input, &mut out);
    assert!(out.findings.is_empty(), "{:?}", out.findings);
}

#[test]
fn daemonset_counts_and_warning_events() {
    let input = WorkloadInput {
        obj: json!({ "status": { "desiredNumberScheduled": 3, "numberReady": 2 } }),
        events: vec![ev("Warning", "FailedCreate", "Error creating: pods \"x\" is forbidden: exceeded quota")],
        ..Default::default()
    };
    let mut out = Out::default();
    workload_rules(&deploy_ref(), Target::DaemonSet, &input, &mut out);
    assert!(out.findings.iter().any(|f| f.title == "2 of 3 pods ready" && f.detail.is_none()));
    assert!(out.findings.iter().any(|f| f.title.starts_with("FailedCreate: Error creating")));
}

// ── redaction and untrusted text ──

#[test]
fn must_not_contain_secrets_or_hidden_characters() {
    let mut input = pod("crashy");
    // the Redactor masks `key: value` / `key=value` at a line start, not inside a sentence
    input.events = vec![ev("Warning", "BackOff", "restarting\npassword: s3cr3t-value \u{202E}evil")];
    input.logs = BTreeMap::from([(
        "main".to_string(),
        (
            true,
            vec![
                LogTail { ts: "2026-11-22T10:00:01Z".into(), text: "DB_PASSWORD=s3cr3t-value".into() },
                LogTail { ts: "2026-11-22T10:00:02Z".into(), text: "connecting to postgres://app:s3cr3t-value@db:5432/app".into() },
                LogTail { ts: "2026-11-22T10:00:03Z".into(), text: "\u{1b}[31mred\u{1b}[0m \u{200B}zero\u{E0041}tag".into() },
            ],
        ),
    )]);
    let d = run_pod(input);
    let all = serde_json::to_string(&d).expect("json");
    assert!(!all.contains("s3cr3t"), "{all}");
    for bad in ['\u{202E}', '\u{200B}', '\u{E0041}', '\u{1b}'] {
        assert!(!all.contains(bad), "{bad:?} in {all}");
    }
    assert!(all.contains("red zerotag"));
    assert!(d.redactions.as_ref().is_some_and(|r| r.count >= 3), "{:?}", d.redactions);
}

#[test]
fn unsupported_kinds_have_no_rules() {
    assert_eq!(target_of(&Gvr::new("", "v1", "configmaps")), None);
    assert_eq!(target_of(&Gvr::new("apps", "v1", "deployments")), Some(Target::Deployment));
}

#[test]
fn split_log_timestamps() {
    assert_eq!(split_ts("2026-11-22T10:00:00.123456789Z hello world"), LogTail { ts: "2026-11-22T10:00:00.123456789Z".into(), text: "hello world".into() });
    assert_eq!(split_ts("no ts here"), LogTail { ts: String::new(), text: "no ts here".into() });
}
