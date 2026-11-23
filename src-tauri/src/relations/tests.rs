//! Pure helpers of the relations tree (§3 C3).
use serde_json::json;

use super::*;

fn deploy() -> Json {
    json!({
        "metadata": { "name": "web", "namespace": "kns-spike", "uid": "d1",
            "labels": { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" } },
        "spec": {
            "replicas": 3,
            "selector": { "matchLabels": { "app": "web" } },
            "template": {
                "metadata": { "labels": { "app": "web", "tier": "fe" } },
                "spec": {
                    "serviceAccountName": "web",
                    "imagePullSecrets": [{ "name": "regcred" }],
                    "containers": [{
                        "name": "main",
                        "envFrom": [{ "configMapRef": { "name": "web-env" } }, { "secretRef": { "name": "web-secrets" } }],
                        "env": [{ "name": "DB_PASSWORD", "valueFrom": { "secretKeyRef": { "name": "db", "key": "password" } } },
                                { "name": "X", "valueFrom": { "configMapKeyRef": { "name": "web-env", "key": "x" } } }]
                    }],
                    "volumes": [
                        { "name": "data", "persistentVolumeClaim": { "claimName": "web-data" } },
                        { "name": "cfg", "projected": { "sources": [{ "configMap": { "name": "extra" } }, { "secret": { "name": "tls" } }] } }
                    ]
                }
            }
        },
        "status": { "readyReplicas": 2 }
    })
}

#[test]
fn uses_lists_references_once_in_order() {
    let d = deploy();
    let u = uses_of(pod_spec(&d).unwrap());
    let names: Vec<String> = u.iter().map(|(k, n)| format!("{k}/{n}")).collect();
    assert_eq!(
        names,
        vec![
            "ConfigMap/web-env",
            "Secret/web-secrets",
            "Secret/db",
            "PersistentVolumeClaim/web-data",
            "ConfigMap/extra",
            "Secret/tls",
            "Secret/regcred",
            "ServiceAccount/web",
        ]
    );
    // no serviceAccountName: the default account
    assert_eq!(uses_of(&json!({ "containers": [] })), vec![("ServiceAccount", "default".to_string())]);
}

#[test]
fn owners_and_flux_labels() {
    let pod = json!({ "metadata": { "ownerReferences": [
        { "apiVersion": "v1", "kind": "Node", "name": "n1" },
        { "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-7d9f", "controller": true }
    ] } });
    assert_eq!(owner_ref(&pod), Some(("apps/v1".into(), "ReplicaSet".into(), "web-7d9f".into())));
    assert_eq!(owner_ref(&json!({ "metadata": {} })), None);
    assert_eq!(flux_owner(&deploy()), Some(("kustomize.toolkit.fluxcd.io", "Kustomization", "apps".into(), "flux-system".into())));
    let hr = json!({ "metadata": { "labels": { "helm.toolkit.fluxcd.io/name": "redis", "helm.toolkit.fluxcd.io/namespace": "data" } } });
    assert_eq!(flux_owner(&hr).unwrap().1, "HelmRelease");
}

#[test]
fn services_select_template_labels() {
    let d = deploy();
    let labels = pod_labels(&d).unwrap();
    assert!(service_selects(&json!({ "spec": { "selector": { "app": "web" } } }), labels));
    assert!(!service_selects(&json!({ "spec": { "selector": { "app": "web", "tier": "be" } } }), labels));
    assert!(!service_selects(&json!({ "spec": {} }), labels), "no selector selects nothing");
    let pod = json!({ "metadata": { "labels": { "app": "web" } }, "spec": { "containers": [] } });
    assert!(service_selects(&json!({ "spec": { "selector": { "app": "web" } } }), pod_labels(&pod).unwrap()));
}

#[test]
fn ingress_services_dedup() {
    let ing = json!({ "spec": {
        "defaultBackend": { "service": { "name": "web" } },
        "rules": [{ "http": { "paths": [{ "backend": { "service": { "name": "web" } } }, { "backend": { "service": { "name": "api" } } }] } }]
    } });
    assert_eq!(ingress_services(&ing), vec!["web", "api"]);
}

#[test]
fn status_words() {
    assert_eq!(status_of("Deployment", &deploy()).as_deref(), Some("2/3 ready"));
    let pod = json!({ "status": { "phase": "Running", "containerStatuses": [{ "ready": false, "state": { "waiting": { "reason": "CrashLoopBackOff" } } }] } });
    assert_eq!(status_of("Pod", &pod).as_deref(), Some("CrashLoopBackOff 0/1"));
    assert_eq!(status_of("Secret", &Json::Null).as_deref(), Some("missing"));
    let ks = json!({ "spec": { "suspend": true }, "status": { "conditions": [{ "type": "Ready", "status": "True" }] } });
    assert_eq!(status_of("Kustomization", &ks).as_deref(), Some("Ready · suspended"));
    assert_eq!(status_of("Job", &json!({ "status": { "conditions": [{ "type": "Failed", "status": "True" }] } })).as_deref(), Some("Failed"));
}

#[test]
fn kinds_round_trip() {
    assert_eq!(kind_of(&Gvr::new("apps", "v1", "deployments")), "Deployment");
    assert_eq!(kind_of(&Gvr::new("kustomize.toolkit.fluxcd.io", "v1", "kustomizations")), "Kustomization");
    assert_eq!(kind_of(&Gvr::new("source.toolkit.fluxcd.io", "v1", "gitrepositories")), "GitRepository");
    assert_eq!(kind_of(&Gvr::new("example.com", "v1", "widgets")), "Widget");
    assert_eq!(kind_of(&Gvr::new("example.com", "v1", "policies")), "Policy");
    assert_eq!(known_gvr("Ingress").unwrap().group, "networking.k8s.io");
}

#[test]
fn builder_caps_and_guards_cycles() {
    let mut b = Builder::new();
    let base = ObjRef { context: "c".into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some("n".into()), name: "p".into() };
    let root = b.root(&base, &json!({}));
    assert_eq!(root.relation, RelationKind::Self_);
    // the root again (a cycle): refused
    assert!(b.node(&base, RelationKind::Owner, None).is_none());
    for i in 0..MAX_NODES * 2 {
        let r = ObjRef { name: format!("x{i}"), ..base.clone() };
        let _ = b.node(&r, RelationKind::Owned, Some("Running".into()));
    }
    assert_eq!(b.nodes, MAX_NODES);
}

#[test]
fn statuses_are_cleaned() {
    let mut b = Builder::new();
    let r = ObjRef { context: "c".into(), gvr: Gvr::new("", "v1", "services"), namespace: Some("n".into()), name: "s".into() };
    let n = b.node(&r, RelationKind::Traffic, Some("Cluster\u{202e}IP https://u:pw-hunter2@h".into())).unwrap();
    let st = n.status.unwrap();
    assert!(!st.contains('\u{202e}'));
    assert!(!st.contains("pw-hunter2"), "{st}");
}
