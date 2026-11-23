//! Reach chain fixtures (§3 C3): a passing and failing chain, policies, probe building.
use serde_json::json;

use super::*;

fn r(resource: &str, ns: &str, name: &str) -> ObjRef {
    ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", resource), namespace: Some(ns.into()), name: name.into() }
}

fn pod(name: &str, ns: &str, labels: Json, ready: bool, ports: Json) -> Json {
    json!({
        "metadata": { "name": name, "namespace": ns, "labels": labels },
        "spec": { "containers": [{ "name": "main", "ports": ports }] },
        "status": { "phase": "Running", "podIP": format!("10.42.0.{}", name.len()), "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }] }
    })
}

fn web_svc() -> Json {
    json!({
        "metadata": { "name": "web", "namespace": "kns-spike" },
        "spec": { "type": "ClusterIP", "clusterIP": "10.43.0.10", "selector": { "app": "web" }, "ports": [{ "name": "http", "port": 80, "targetPort": "http", "protocol": "TCP" }] }
    })
}

fn slice(ready: &[bool]) -> Json {
    json!({
        "ports": [{ "name": "http", "port": 8080, "protocol": "TCP" }],
        "endpoints": ready.iter().map(|r| json!({ "addresses": ["10.42.0.9"], "conditions": { "ready": r } })).collect::<Vec<_>>()
    })
}

fn base() -> ReachInput {
    ReachInput {
        from_pod: pod("envdemo-1", "kns-spike", json!({ "app": "envdemo" }), true, json!([])),
        to: web_svc(),
        to_is_service: true,
        port: Some(PortRef::Number(80)),
        dest_pods: vec![pod("web-1", "kns-spike", json!({ "app": "web" }), true, json!([{ "name": "http", "containerPort": 8080 }]))],
        slices: Some(vec![slice(&[true])]),
        src_policies: Some(vec![]),
        dst_policies: Some(vec![]),
        namespaces: Some(vec![json!({ "metadata": { "name": "kns-spike", "labels": { "kubernetes.io/metadata.name": "kns-spike" } } })]),
        other_policy_kinds: vec![],
    }
}

fn check(inp: &ReachInput) -> ReachCheck {
    finish(chain(&r("pods", "kns-spike", "envdemo-1"), &r("services", "kns-spike", "web"), inp))
}

fn step<'a>(c: &'a ReachCheck, name: &str) -> &'a ReachStep {
    c.steps.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("no step {name}: {c:#?}"))
}

#[test]
fn passing_chain_without_policies() {
    let c = check(&base());
    assert_eq!(c.ok, Some(true), "{c:#?}");
    assert_eq!(step(&c, "port").detail, "http 80/TCP → targetPort http");
    assert_eq!(step(&c, "endpoints").detail, "1 of 1 endpoints ready");
    assert_eq!(step(&c, "target port").detail, "container port 8080 on 1 ready pod");
    assert!(step(&c, "ingress to destination").detail.starts_with("no NetworkPolicy limits ingress of web"));
    assert!(c.steps.iter().all(|s| s.name != "DNS"), "DNS only matters when egress is limited");
}

#[test]
fn failing_chain_denied_by_policy() {
    let mut inp = base();
    let deny = json!({ "metadata": { "name": "web-from-frontend", "namespace": "kns-spike" }, "spec": {
        "podSelector": { "matchLabels": { "app": "web" } },
        "ingress": [{ "from": [{ "podSelector": { "matchLabels": { "app": "frontend" } } }] }]
    } });
    inp.dst_policies = Some(vec![deny.clone()]);
    inp.src_policies = Some(vec![deny]);
    let c = check(&inp);
    assert_eq!(c.ok, Some(false));
    let s = step(&c, "ingress to destination");
    assert_eq!(s.ok, Some(false));
    assert!(s.detail.contains("web-from-frontend"), "{}", s.detail);
    assert!(s.detail.ends_with("(by standard rules)"));
}

#[test]
fn no_ready_endpoints_and_wrong_port() {
    let mut inp = base();
    inp.slices = Some(vec![slice(&[false, false])]);
    inp.dest_pods[0]["status"]["conditions"][0]["status"] = json!("False");
    let c = check(&inp);
    assert_eq!(c.ok, Some(false));
    assert_eq!(step(&c, "endpoints").detail, "0 of 2 endpoints ready");

    let mut inp = base();
    inp.port = Some(PortRef::Name("grpc".into()));
    let c = check(&inp);
    assert_eq!(c.ok, Some(false));
    assert_eq!(step(&c, "port").detail, "no port grpc; the Service has http 80");
}

#[test]
fn checked_port_is_reported_when_none_was_asked() {
    let mut inp = base();
    inp.port = None;
    assert_eq!(check(&inp).port, Some(PortRef::Number(80)));
}

#[test]
fn numeric_string_port_and_named_target_missing() {
    let mut inp = base();
    inp.port = Some(PortRef::Name("80".into()));
    assert_eq!(check(&inp).ok, Some(true));
    let mut inp = base();
    inp.dest_pods[0]["spec"]["containers"][0]["ports"] = json!([{ "name": "web", "containerPort": 8080 }]);
    let c = check(&inp);
    assert_eq!(c.ok, Some(false));
    assert!(step(&c, "target port").detail.contains("no container port named http"));
}

#[test]
fn undeclared_numeric_target_port_is_undecided_but_not_overall() {
    let mut inp = base();
    inp.to["spec"]["ports"][0]["targetPort"] = json!(8080);
    inp.dest_pods[0]["spec"]["containers"][0]["ports"] = json!([]);
    let c = check(&inp);
    assert_eq!(step(&c, "target port").ok, None);
    assert_eq!(c.ok, Some(true));
}

#[test]
fn unreadable_policies_make_it_unknown() {
    let mut inp = base();
    inp.dst_policies = None;
    let c = check(&inp);
    assert_eq!(c.ok, None);
    assert_eq!(step(&c, "ingress to destination").ok, None);
}

#[test]
fn egress_limited_without_dns_fails_dns_step() {
    let mut inp = base();
    let eg = json!({ "metadata": { "name": "envdemo-egress", "namespace": "kns-spike" }, "spec": {
        "podSelector": { "matchLabels": { "app": "envdemo" } },
        "policyTypes": ["Egress"],
        "egress": [{ "to": [{ "podSelector": { "matchLabels": { "app": "web" } } }], "ports": [{ "port": 8080 }] }]
    } });
    inp.src_policies = Some(vec![eg]);
    let c = check(&inp);
    assert_eq!(step(&c, "egress from source").ok, Some(true), "{c:#?}");
    let dns = step(&c, "DNS");
    assert_eq!(dns.ok, Some(false));
    assert!(dns.detail.contains("web.kns-spike.svc"));
    assert_eq!(c.ok, Some(false));
}

#[test]
fn external_name_and_pending_source() {
    let mut inp = base();
    inp.to = json!({ "metadata": { "name": "ext" }, "spec": { "type": "ExternalName", "externalName": "db.example.com" } });
    let c = check(&inp);
    assert_eq!(c.ok, None);
    let mut inp = base();
    inp.from_pod["status"]["phase"] = json!("Pending");
    assert_eq!(check(&inp).ok, Some(false));
}

#[test]
fn pod_destination_with_named_port() {
    let mut inp = base();
    inp.to_is_service = false;
    inp.to = inp.dest_pods[0].clone();
    inp.port = Some(PortRef::Name("http".into()));
    let c = finish(chain(&r("pods", "kns-spike", "envdemo-1"), &r("pods", "kns-spike", "web-1"), &inp));
    assert_eq!(c.ok, Some(true), "{c:#?}");
}

#[test]
fn other_policy_kinds_are_named() {
    let mut inp = base();
    inp.other_policy_kinds = vec!["CiliumNetworkPolicy".into()];
    let c = check(&inp);
    assert_eq!(step(&c, "other policy kinds").ok, None);
    assert_eq!(c.ok, Some(true));
}

#[test]
fn details_are_redacted_and_cleaned() {
    let mut inp = base();
    inp.to["spec"]["type"] = json!("ClusterIP\u{202e}https://u:hunter2pw@x");
    let text = serde_json::to_string(&check(&inp)).unwrap();
    assert!(!text.contains("hunter2pw"), "{text}");
    assert!(!text.contains('\u{202e}'));
}

#[test]
fn probe_target_validates_and_resolves() {
    let svc = web_svc();
    let to = r("services", "kns-spike", "web");
    assert_eq!(probe_target(&to, &svc, true, &PortRef::Name("http".into())).unwrap(), ("web.kns-spike.svc".into(), 80));
    assert_eq!(probe_target(&to, &svc, true, &PortRef::Name("80".into())).unwrap(), ("web.kns-spike.svc".into(), 80));
    assert!(probe_target(&to, &svc, true, &PortRef::Number(81)).is_err());
    for evil in ["web;rm -rf /", "web$(id)", "WEB", "-web", "web'", "a b", ""] {
        let to = r("services", "kns-spike", evil);
        assert!(probe_target(&to, &svc, true, &PortRef::Number(80)).is_err(), "{evil}");
    }
    let to = r("services", "kns spike'", "web");
    assert!(probe_target(&to, &svc, true, &PortRef::Number(80)).is_err());
    // a pod: its IP and a declared port only
    let p = pod("web-1", "kns-spike", json!({}), true, json!([{ "name": "http", "containerPort": 8080 }]));
    let to = r("pods", "kns-spike", "web-1");
    assert_eq!(probe_target(&to, &p, false, &PortRef::Name("http".into())).unwrap(), ("10.42.0.5".into(), 8080));
    let mut bad = p.clone();
    bad["status"]["podIP"] = json!("10.0.0.1; reboot");
    assert!(probe_target(&to, &bad, false, &PortRef::Number(8080)).is_err());
}

#[test]
fn probe_script_and_marker() {
    let s = probe_script("web.kns-spike.svc", 80);
    assert!(s.contains("nc -z -w2 \"$h\" \"$p\""));
    assert!(s.contains("wget -T2 --spider 'http://web.kns-spike.svc:80/'"));
    assert!(s.contains("/dev/tcp/"));
    assert!(probe_script("fd00::1", 80).contains("http://[fd00::1]:80/"));
    assert_eq!(parse_marker("x\nKNS_TOOL=nc KNS_RC=1\n"), Some(("nc".into(), 1)));
    assert_eq!(parse_marker("sh: not found"), None);
    assert!(probe_ok("nc", 0, ""));
    assert!(!probe_ok("nc", 1, ""));
    assert!(probe_ok("wget", 1, "wget: server returned error: HTTP/1.1 404 Not Found"));
    assert!(!probe_ok("wget", 1, "wget: can't connect to remote host (10.43.0.10): Connection refused"));
    assert!(!probe_ok("wget", 1, "wget: download timed out"));
    assert!(!probe_ok("bash", 1, ""));
}

#[test]
fn dns_labels_rule() {
    assert!(is_dns_label("web-1"));
    assert!(!is_dns_label("web.1"));
    assert!(!is_dns_label(&"a".repeat(64)));
}

#[test]
fn both_ends_in_one_context() {
    let from = r("pods", "kns-spike", "envdemo-1");
    assert!(require_to(&from, &r("services", "kns-spike", "web")).unwrap());
    let mut other = r("services", "kns-spike", "web");
    other.context = "prod".into();
    assert!(require_to(&from, &other).is_err(), "the destination is never read with another context's session");
    assert!(require_to(&from, &r("configmaps", "kns-spike", "x")).is_err());
}
