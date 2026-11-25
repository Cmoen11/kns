//! Field ownership and revisions: mirror of `src/ipc/contract/diff.ts`. Owner D.
use serde::{Deserialize, Serialize};

use crate::ipc::{Json, ObjRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagerClass {
    Flux,
    Argo,
    Kns,
    Kubectl,
    Controller,
    Other,
}

/// One field and a manager that set it (from `metadata.managedFields`). A field several managers
/// own yields one row per manager.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOwner {
    /// JSON pointer into the live object; list items keyed by `k:` / `v:` are resolved to indices.
    /// A pointer that ends at a map or list item means the manager owns that node itself (`.`).
    pub path: String,
    /// Cleaned with `redact::clean_untrusted` (cluster text).
    pub manager: String,
    pub manager_class: ManagerClass,
    /// Apply | Update
    pub operation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subresource: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub revision: i64,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    /// What the revision holds: a ReplicaSet's `spec.template` (without `pod-template-hash`) or a
    /// ControllerRevision's `data`. Absent for Helm (release data is never read). Not redacted:
    /// for the human diff view only; an agent-facing path must drop it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<Json>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{drift::Fixtures, fwd::fixtures::obj};

    #[test]
    fn drift() {
        let mut f = Fixtures::new("diff");
        f.add(
            "fieldOwners",
            "FieldOwner[]",
            &[ManagerClass::Flux, ManagerClass::Argo, ManagerClass::Kns, ManagerClass::Kubectl, ManagerClass::Controller, ManagerClass::Other]
                .into_iter()
                .map(|manager_class| FieldOwner {
                    path: "/spec/replicas".into(),
                    manager: "kubectl-scale".into(),
                    manager_class,
                    operation: "Update".into(),
                    subresource: Some("scale".into()),
                    time: Some("2026-11-22T10:00:00Z".into()),
                })
                .collect::<Vec<_>>(),
        );
        f.add(
            "revisions",
            "Revision[]",
            &vec![
                Revision {
                    id: "rs-1".into(),
                    revision: 3,
                    created_at: "2026-11-22T10:00:00Z".into(),
                    image: Some("ghcr.io/example/api:1.4.2".into()),
                    obj_ref: obj("replicasets", "default", "api-6d4f"),
                    template: Some(serde_json::json!({"spec": {"containers": [{"name": "api", "image": "ghcr.io/example/api:1.4.2"}]}})),
                },
                Revision {
                    id: "sh.helm.release.v1.api.v2".into(),
                    revision: 2,
                    created_at: "2026-11-21T10:00:00Z".into(),
                    image: None,
                    obj_ref: obj("secrets", "default", "sh.helm.release.v1.api.v2"),
                    template: None,
                },
            ],
        );
        f.check();
    }
}
