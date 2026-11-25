//! Argo CD facts read from plain objects. Pure; mirrored by `src/actions/ops/argo.ts`.
//!
//! Two levels, because the people who use a workload cluster often cannot read the Application
//! objects (Argo CD runs in a management cluster, or in a namespace they have no access to):
//!
//! - **managed objects**: what Argo CD stamps on everything it applies. The tracking annotation
//!   `argocd.argoproj.io/tracking-id` (`<app>:<group>/<kind>:<namespace>/<name>`, the app written
//!   `<app-namespace>_<app>` with apps in any namespace) is certain, so is the
//!   `argocd.argoproj.io/instance` label or annotation. `app.kubernetes.io/instance` is Argo's
//!   legacy label tracking, but Helm sets the same label, so it only counts together with a field
//!   manager of Argo CD (`argocd-controller`, `argocd-application-controller`).
//! - **Applications** (`argoproj.io` `applications`): sync and health status, conditions and the
//!   resources that are out of sync or unhealthy (`diagnose/argo.rs`).
use crate::ipc::Json;

pub const GROUP: &str = "argoproj.io";
pub const TRACKING_ANNOTATION: &str = "argocd.argoproj.io/tracking-id";
pub const INSTANCE_KEY: &str = "argocd.argoproj.io/instance";
const LEGACY_INSTANCE_LABEL: &str = "app.kubernetes.io/instance";

fn s(v: &Json) -> &str {
    v.as_str().unwrap_or_default()
}

/// One parsed tracking id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tracking {
    pub app: String,
    /// the Application's namespace, when the id names it (`ns_app`)
    pub app_namespace: Option<String>,
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

/// `app` or `ns_app` (an object name never holds `_`, so the split is unambiguous).
fn split_app(text: &str) -> Option<(String, Option<String>)> {
    if text.is_empty() {
        return None;
    }
    match text.split_once('_') {
        Some((ns, app)) if !ns.is_empty() && !app.is_empty() => Some((app.to_string(), Some(ns.to_string()))),
        Some(_) => None,
        None => Some((text.to_string(), None)),
    }
}

/// `<app>:<group>/<kind>:<namespace>/<name>`; the group and the namespace may be empty.
pub fn parse_tracking_id(id: &str) -> Option<Tracking> {
    let mut parts = id.trim().splitn(3, ':');
    let (app, gk, nn) = (parts.next()?, parts.next()?, parts.next()?);
    let (app, app_namespace) = split_app(app)?;
    let (group, kind) = gk.split_once('/')?;
    let (namespace, name) = nn.split_once('/')?;
    if kind.is_empty() || name.is_empty() {
        return None;
    }
    Some(Tracking {
        app,
        app_namespace,
        group: group.to_string(),
        kind: kind.to_string(),
        namespace: (!namespace.is_empty()).then(|| namespace.to_string()),
        name: name.to_string(),
    })
}

/// A field manager of Argo CD.
pub fn is_argo_manager(manager: &str) -> bool {
    let m = manager.to_ascii_lowercase();
    m == "argocd" || m.starts_with("argocd-")
}

/// The Application that manages an object, as far as the object says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgoOwner {
    pub app: String,
    /// None: the object does not say (the Application is in Argo CD's own namespace)
    pub namespace: Option<String>,
}

/// The Argo CD Application that applied `o`, from its annotations, labels and field managers.
pub fn argo_owner(o: &Json) -> Option<ArgoOwner> {
    let meta = &o["metadata"];
    let (annotations, labels) = (&meta["annotations"], &meta["labels"]);
    if let Some(t) = parse_tracking_id(s(&annotations[TRACKING_ANNOTATION])) {
        return Some(ArgoOwner { app: t.app, namespace: t.app_namespace });
    }
    let instance = |v: &str| split_app(v.trim()).map(|(app, namespace)| ArgoOwner { app, namespace });
    for v in [&annotations[INSTANCE_KEY], &labels[INSTANCE_KEY]] {
        if let Some(owner) = instance(s(v)) {
            return Some(owner);
        }
    }
    let by_argo = meta["managedFields"].as_array().is_some_and(|m| m.iter().any(|e| is_argo_manager(s(&e["manager"]))));
    if by_argo {
        return instance(s(&labels[LEGACY_INSTANCE_LABEL]));
    }
    None
}

/// `Application ns/app` or `Application app`.
pub fn owner_text(o: &ArgoOwner) -> String {
    match &o.namespace {
        Some(ns) => format!("Application {ns}/{}", o.app),
        None => format!("Application {}", o.app),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tracking_ids() {
        let t = parse_tracking_id("web-test:apps/Deployment:shop/web").unwrap();
        assert_eq!((t.app.as_str(), t.app_namespace, t.group.as_str(), t.kind.as_str()), ("web-test", None, "apps", "Deployment"));
        assert_eq!((t.namespace.as_deref(), t.name.as_str()), (Some("shop"), "web"));
        // core group, apps in any namespace
        let t = parse_tracking_id("shop_web-test:/Service:shop/web").unwrap();
        assert_eq!((t.app.as_str(), t.app_namespace.as_deref(), t.group.as_str()), ("web-test", Some("shop"), ""));
        // cluster-scoped
        let t = parse_tracking_id("infra:rbac.authorization.k8s.io/ClusterRole:/reader").unwrap();
        assert_eq!((t.namespace, t.name.as_str()), (None, "reader"));
        for bad in ["", "app", "app:apps/Deployment", "app:Deployment:shop/web", ":apps/Deployment:shop/web", "_x:apps/D:a/b", "app:apps/:a/b", "app:apps/D:a/"] {
            assert!(parse_tracking_id(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn managers() {
        assert!(is_argo_manager("argocd-controller"));
        assert!(is_argo_manager("argocd-application-controller"));
        assert!(is_argo_manager("ArgoCD"));
        assert!(!is_argo_manager("argo-rollouts"));
        assert!(!is_argo_manager("kustomize-controller"));
    }

    #[test]
    fn owners() {
        let tracked = json!({ "metadata": { "annotations": { TRACKING_ANNOTATION: "shop_web-prod:apps/Deployment:shop/web" } } });
        assert_eq!(argo_owner(&tracked), Some(ArgoOwner { app: "web-prod".into(), namespace: Some("shop".into()) }));
        let label = json!({ "metadata": { "labels": { INSTANCE_KEY: "web" } } });
        assert_eq!(argo_owner(&label), Some(ArgoOwner { app: "web".into(), namespace: None }));
        // Helm sets app.kubernetes.io/instance too: only with an Argo CD field manager
        let helm = json!({ "metadata": { "labels": { "app.kubernetes.io/instance": "web" }, "managedFields": [{ "manager": "helm" }] } });
        assert_eq!(argo_owner(&helm), None);
        let legacy = json!({ "metadata": { "labels": { "app.kubernetes.io/instance": "web" }, "managedFields": [{ "manager": "argocd-controller" }] } });
        assert_eq!(argo_owner(&legacy), Some(ArgoOwner { app: "web".into(), namespace: None }));
        assert_eq!(argo_owner(&json!({ "metadata": {} })), None);
        assert_eq!(owner_text(&ArgoOwner { app: "web".into(), namespace: Some("shop".into()) }), "Application shop/web");
    }
}
