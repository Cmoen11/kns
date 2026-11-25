//! Rule fixtures for the Argo CD `:why` rules.
use serde_json::json;

use super::super::finish;
use super::*;
use crate::ipc::{Diagnosis, Evidence, Gvr};

fn app_ref() -> ObjRef {
    ObjRef { context: "default".into(), gvr: Gvr::new("argoproj.io", "v1alpha1", "applications"), namespace: Some("argocd".into()), name: "shop".into() }
}

fn run(o: Json) -> Diagnosis {
    let r = app_ref();
    let mut out = Out::default();
    application_rules(&r, &ArgoInput { obj: o, events: vec![] }, &mut out);
    finish(&r, out, "2026-11-25T10:00:00Z".into())
}

fn titles(d: &Diagnosis) -> Vec<String> {
    d.findings.iter().map(|f| f.title.clone()).collect()
}

#[test]
fn healthy_and_synced_has_no_findings() {
    let d = run(json!({ "spec": {}, "status": { "sync": { "status": "Synced" }, "health": { "status": "Healthy" } } }));
    assert!(d.findings.is_empty(), "{:?}", titles(&d));
    assert!(d.checked.iter().any(|c| c == "sync status"));
}

#[test]
fn degraded_resources_are_named() {
    let d = run(json!({ "status": {
        "health": { "status": "Degraded" },
        "sync": { "status": "Synced" },
        "resources": [
            { "kind": "Service", "namespace": "shop", "name": "web", "status": "Synced", "health": { "status": "Healthy" } },
            { "group": "apps", "kind": "Deployment", "namespace": "shop", "name": "web", "status": "Synced",
              "health": { "status": "Degraded", "message": "Deployment \"web\" exceeded its progress deadline" } }
        ]
    } }));
    assert_eq!(titles(&d), ["Deployment shop/web is Degraded"]);
    let f = &d.findings[0];
    assert_eq!(f.severity, Severity::Error);
    assert!(matches!(&f.evidence[0], Evidence::Field { path, .. } if path == "/status/resources/1/health"));
}

#[test]
fn out_of_sync_without_auto_sync_warns() {
    let d = run(json!({ "spec": { "syncPolicy": {} }, "status": {
        "health": { "status": "Healthy" },
        "sync": { "status": "OutOfSync", "revision": "4f2c9e1a7b3d5f6e8a9b0c1d2e3f4a5b6c7d8e9f" },
        "resources": [
            { "kind": "ConfigMap", "namespace": "shop", "name": "web-config", "status": "OutOfSync" },
            { "kind": "Deployment", "group": "apps", "namespace": "shop", "name": "web", "status": "OutOfSync" }
        ]
    } }));
    assert_eq!(titles(&d), ["2 resources are out of sync (Git at 4f2c9e1)"]);
    assert_eq!(d.findings[0].severity, Severity::Warn);
    assert_eq!(d.findings[0].evidence.len(), 3);
    assert!(d.findings[0].detail.as_deref().unwrap().contains("auto-sync is off"));
}

#[test]
fn out_of_sync_with_auto_sync_is_info() {
    let d = run(json!({ "spec": { "syncPolicy": { "automated": { "selfHeal": true } } }, "status": {
        "sync": { "status": "OutOfSync" },
        "resources": [{ "kind": "Deployment", "namespace": "shop", "name": "web", "status": "OutOfSync" }]
    } }));
    assert_eq!(titles(&d), ["Deployment shop/web is out of sync"]);
    assert_eq!(d.findings[0].severity, Severity::Info);
}

#[test]
fn failed_sync_and_conditions() {
    let d = run(json!({ "status": {
        "sync": { "status": "Unknown" },
        "conditions": [
            { "type": "ComparisonError", "message": "rpc error: helm template failed: values.yaml: no such file" },
            { "type": "OrphanedResourceWarning", "message": "Application has 1 orphaned resources" },
            { "type": "SomethingInformational", "message": "ignored" }
        ],
        "operationState": {
            "phase": "Failed",
            "message": "one or more objects failed to apply",
            "syncResult": { "revision": "abc", "resources": [
                { "kind": "Deployment", "namespace": "shop", "name": "web", "status": "SyncFailed", "message": "field is immutable" },
                { "kind": "Service", "namespace": "shop", "name": "web", "status": "Synced" }
            ] }
        }
    } }));
    let t = titles(&d);
    assert_eq!(t[..2], ["ComparisonError", "last sync of abc failed"]);
    assert!(t.contains(&"OrphanedResourceWarning".to_string()));
    let sync = d.findings.iter().find(|f| f.title.starts_with("last sync")).unwrap();
    assert!(matches!(&sync.evidence[1], Evidence::Field { value, .. } if value == "Deployment shop/web: field is immutable"));
}

#[test]
fn running_sync_and_progressing() {
    let d = run(json!({ "status": { "health": { "status": "Progressing" }, "sync": { "status": "Synced" }, "operationState": { "phase": "Running", "message": "waiting for healthy state" } } }));
    assert_eq!(titles(&d), ["a sync is running", "progressing"]);
}

#[test]
fn applicationset_conditions() {
    let r = ObjRef { gvr: Gvr::new("argoproj.io", "v1alpha1", "applicationsets"), ..app_ref() };
    let mut out = Out::default();
    let o = json!({ "status": { "conditions": [
        { "type": "ErrorOccurred", "status": "True", "reason": "ApplicationGenerationFromParamsError", "message": "missingkey=error: map has no entry for key \"env\"" },
        { "type": "ParametersGenerated", "status": "True" },
        { "type": "ResourcesUpToDate", "status": "False", "reason": "ApplicationGenerationFromParamsError", "message": "" }
    ] } });
    applicationset_rules(&r, &ArgoInput { obj: o, events: vec![] }, &mut out);
    let d = finish(&r, out, "2026-11-25T10:00:00Z".into());
    assert_eq!(
        titles(&d),
        ["ErrorOccurred=True (ApplicationGenerationFromParamsError)", "ResourcesUpToDate=False (ApplicationGenerationFromParamsError)"]
    );
}

#[test]
fn labels() {
    assert_eq!(resource_label(&json!({ "kind": "ClusterRole", "name": "reader" })), "ClusterRole reader");
    assert_eq!(short("4f2c9e1a7b3d5f6e8a9b"), "4f2c9e1");
    assert_eq!(short("main"), "main");
}
