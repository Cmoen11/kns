//! Field ownership from managedFields and revisions (docs/plan-features.md §3 D). Owner: D.
//!
//! Pure functions over JSON (decoding `fieldsV1`, classifying managers, building revision lists)
//! with a thin fetch layer below them. Helm history is read with a metadata-only list
//! (`PartialObjectMetadataList`), so a release's data (its values) never leaves the cluster.
use std::collections::BTreeSet;

use crate::{
    ipc::{BackendError, FieldOwner, Gvr, Json, ManagerClass, ObjRef, Result, Revision, take_array},
    redact::{MAX_LINE, clean_untrusted},
    session::{JSON, Session, api_path, with_query},
    state::AppState,
};

// ───────────────────────── managers ─────────────────────────

/// Which kind of writer a field manager is. Flux and Argo CD are tested before the generic
/// controller match (`kustomize-controller` and `argocd-application-controller` are both).
pub fn classify(manager: &str) -> ManagerClass {
    let m = manager.to_ascii_lowercase();
    if m.starts_with("kustomize-controller")
        || m.starts_with("helm-controller")
        || m.starts_with("image-automation-controller")
        || m.starts_with("gotk")
        || m == "flux"
        || m.starts_with("flux-")
    {
        ManagerClass::Flux
    } else if crate::argo::is_argo_manager(&m) {
        ManagerClass::Argo
    } else if m == "kns" || m.starts_with("kns-") {
        ManagerClass::Kns
    } else if m.starts_with("kubectl") {
        ManagerClass::Kubectl
    } else if m.contains("controller")
        || m.contains("operator")
        || m == "kubelet"
        || m == "kube-scheduler"
        || m == "k3s"
        || m.starts_with("k3s-")
    {
        ManagerClass::Controller
    } else {
        ManagerClass::Other
    }
}

// ───────────────────────── fieldsV1 ─────────────────────────

/// One JSON pointer segment (RFC 6901: `~` → `~0`, `/` → `~1`).
fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

fn pointer(path: &[String]) -> String {
    if path.is_empty() {
        return String::new();
    }
    path.iter().map(|s| format!("/{}", escape(s))).collect()
}

/// Index of the list item a `k:{"name":"x"}` key names: every field of the key matches.
fn index_by_key(list: Option<&Json>, key: &Json) -> Option<usize> {
    let key = key.as_object()?;
    list?.as_array()?.iter().position(|item| key.iter().all(|(k, v)| item.get(k) == Some(v)))
}

/// Index of the set item a `v:<json>` key names.
fn index_by_value(list: Option<&Json>, value: &Json) -> Option<usize> {
    list?.as_array()?.iter().position(|item| item == value)
}

/// Every owned path of one `fieldsV1` tree, resolved against the live object. Keys that name a
/// list item the object no longer has (stale entries) are skipped.
pub fn decode_fields(fields: &Json, object: &Json) -> Vec<String> {
    let mut out = Vec::new();
    let mut path = Vec::new();
    walk(fields, Some(object), &mut path, &mut out);
    out
}

fn walk(fields: &Json, node: Option<&Json>, path: &mut Vec<String>, out: &mut Vec<String>) {
    let Some(map) = fields.as_object() else { return };
    for (key, child) in map {
        if key == "." {
            out.push(pointer(path));
            continue;
        }
        let (segment, next) = if let Some(name) = key.strip_prefix("f:") {
            (name.to_string(), node.and_then(|n| n.get(name)))
        } else if let Some(raw) = key.strip_prefix("k:") {
            let Some(i) = serde_json::from_str::<Json>(raw).ok().and_then(|k| index_by_key(node, &k)) else { continue };
            (i.to_string(), node.and_then(|n| n.get(i)))
        } else if let Some(raw) = key.strip_prefix("v:") {
            let Some(i) = serde_json::from_str::<Json>(raw).ok().and_then(|v| index_by_value(node, &v)) else { continue };
            (i.to_string(), node.and_then(|n| n.get(i)))
        } else if let Some(raw) = key.strip_prefix("i:") {
            let Ok(i) = raw.parse::<usize>() else { continue };
            (i.to_string(), node.and_then(|n| n.get(i)))
        } else {
            continue;
        };
        path.push(segment);
        if child.as_object().is_none_or(|m| m.is_empty()) {
            out.push(pointer(path));
        } else {
            walk(child, next, path, out);
        }
        path.pop();
    }
}

/// Every field of the object with its manager(s), sorted by path, then class and manager.
pub fn owners_of(object: &Json) -> Vec<FieldOwner> {
    let mut out = Vec::new();
    let Some(entries) = object["metadata"]["managedFields"].as_array() else { return out };
    for entry in entries {
        if entry["fieldsType"].as_str().is_some_and(|t| t != "FieldsV1") {
            continue;
        }
        let manager = clean_untrusted(entry["manager"].as_str().unwrap_or("unknown"), MAX_LINE);
        let class = classify(&manager);
        let operation = clean_untrusted(entry["operation"].as_str().unwrap_or(""), MAX_LINE);
        let subresource = entry["subresource"].as_str().filter(|s| !s.is_empty()).map(|s| clean_untrusted(s, MAX_LINE));
        let time = entry["time"].as_str().map(|s| clean_untrusted(s, MAX_LINE));
        // a status-subresource entry is rooted at the object too (its paths start with /status)
        let mut seen = BTreeSet::new();
        for path in decode_fields(&entry["fieldsV1"], object) {
            if !seen.insert(path.clone()) {
                continue;
            }
            out.push(FieldOwner {
                path,
                manager: manager.clone(),
                manager_class: class,
                operation: operation.clone(),
                subresource: subresource.clone(),
                time: time.clone(),
            });
        }
    }
    out.sort_by(|a, b| {
        a.path.cmp(&b.path).then(a.manager_class.cmp(&b.manager_class)).then(a.manager.cmp(&b.manager))
    });
    out
}

// ───────────────────────── revisions ─────────────────────────

fn owned_by(object: &Json, uid: &str) -> bool {
    object["metadata"]["ownerReferences"].as_array().is_some_and(|refs| refs.iter().any(|r| r["uid"] == uid))
}

fn first_image(template: &Json) -> Option<String> {
    template["spec"]["containers"][0]["image"].as_str().map(str::to_string)
}

fn child_ref(owner: &ObjRef, gvr: Gvr, name: &str) -> ObjRef {
    ObjRef { context: owner.context.clone(), gvr, namespace: owner.namespace.clone(), name: name.to_string() }
}

fn str_of(v: &Json) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn newest_first(mut list: Vec<Revision>) -> Vec<Revision> {
    list.sort_by(|a, b| b.revision.cmp(&a.revision).then(b.created_at.cmp(&a.created_at)));
    list
}

/// ReplicaSets of a Deployment (`deployment.kubernetes.io/revision`), newest first.
pub fn replicaset_revisions(owner: &ObjRef, owner_uid: &str, replicasets: &[Json]) -> Vec<Revision> {
    let gvr = Gvr::new("apps", "v1", "replicasets");
    newest_first(
        replicasets
            .iter()
            .filter(|rs| owned_by(rs, owner_uid))
            .map(|rs| {
                let name = str_of(&rs["metadata"]["name"]);
                let revision = rs["metadata"]["annotations"]["deployment.kubernetes.io/revision"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let mut template = rs["spec"]["template"].clone();
                if let Some(labels) = template.pointer_mut("/metadata/labels").and_then(Json::as_object_mut) {
                    labels.remove("pod-template-hash");
                }
                Revision {
                    id: name.clone(),
                    revision,
                    created_at: str_of(&rs["metadata"]["creationTimestamp"]),
                    image: first_image(&template),
                    obj_ref: child_ref(owner, gvr.clone(), &name),
                    template: Some(template),
                }
            })
            .collect(),
    )
}

/// ControllerRevisions of a StatefulSet or DaemonSet, newest first.
pub fn controller_revisions(owner: &ObjRef, owner_uid: &str, revisions: &[Json]) -> Vec<Revision> {
    let gvr = Gvr::new("apps", "v1", "controllerrevisions");
    newest_first(
        revisions
            .iter()
            .filter(|cr| owned_by(cr, owner_uid))
            .map(|cr| {
                let name = str_of(&cr["metadata"]["name"]);
                let data = cr["data"].clone();
                Revision {
                    id: name.clone(),
                    revision: cr["revision"].as_i64().unwrap_or(0),
                    created_at: str_of(&cr["metadata"]["creationTimestamp"]),
                    image: first_image(&data["spec"]["template"]),
                    obj_ref: child_ref(owner, gvr.clone(), &name),
                    template: Some(data),
                }
            })
            .collect(),
    )
}

/// Helm release history from release Secrets' metadata only (labels `version`, `status`).
pub fn helm_revisions(owner: &ObjRef, storage_namespace: &str, items: &[Json]) -> Vec<Revision> {
    let gvr = Gvr::new("", "v1", "secrets");
    newest_first(
        items
            .iter()
            .map(|s| {
                let name = str_of(&s["metadata"]["name"]);
                let revision = s["metadata"]["labels"]["version"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0);
                Revision {
                    id: name.clone(),
                    revision,
                    created_at: str_of(&s["metadata"]["creationTimestamp"]),
                    image: None,
                    obj_ref: ObjRef {
                        context: owner.context.clone(),
                        gvr: gvr.clone(),
                        namespace: Some(storage_namespace.to_string()),
                        name,
                    },
                    template: None,
                }
            })
            .collect(),
    )
}

/// The Helm release a Flux HelmRelease installs: `spec.releaseName`, else `<targetNamespace>-<name>`
/// or `<name>`; stored in `spec.storageNamespace`, else the HelmRelease's namespace.
pub fn helm_release_of(hr: &Json, namespace: &str) -> (String, String) {
    let name = str_of(&hr["metadata"]["name"]);
    let release = hr["spec"]["releaseName"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| {
        match hr["spec"]["targetNamespace"].as_str().filter(|s| !s.is_empty()) {
            Some(target) => format!("{target}-{name}"),
            None => name.clone(),
        }
    });
    let storage = hr["spec"]["storageNamespace"].as_str().filter(|s| !s.is_empty()).unwrap_or(namespace).to_string();
    (release, storage)
}

const METADATA_LIST: &str = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json";

async fn list(session: &Session, gvr: &Gvr, namespace: Option<&str>, params: &[(&str, &str)], accept: &str) -> Result<Vec<Json>> {
    let uri = with_query(&api_path(gvr, namespace, None), params);
    let mut page: Json = session.get_as(&uri, accept).await?;
    Ok(take_array(&mut page, "items"))
}

pub async fn field_owners(state: &AppState, obj: &ObjRef) -> Result<Vec<FieldOwner>> {
    let object = crate::objects::get_json(state, obj).await?;
    Ok(owners_of(&object))
}

pub async fn revisions(state: &AppState, obj: &ObjRef) -> Result<Vec<Revision>> {
    let session = state.session(&obj.context).await?;
    let object = crate::objects::get(&session, obj).await?;
    let uid = object["metadata"]["uid"].as_str().unwrap_or_default().to_string();
    let ns = obj.ns();
    match (obj.gvr.group.as_str(), obj.gvr.resource.as_str()) {
        ("apps", "deployments") => {
            let rs = list(&session, &Gvr::new("apps", "v1", "replicasets"), ns, &[], JSON).await?;
            Ok(replicaset_revisions(obj, &uid, &rs))
        }
        ("apps", "statefulsets" | "daemonsets") => {
            let crs = list(&session, &Gvr::new("apps", "v1", "controllerrevisions"), ns, &[], JSON).await?;
            Ok(controller_revisions(obj, &uid, &crs))
        }
        ("helm.toolkit.fluxcd.io", "helmreleases") => {
            let (release, storage) = helm_release_of(&object, ns.unwrap_or("default"));
            let selector = format!("owner=helm,name={release}");
            let items = list(&session, &Gvr::new("", "v1", "secrets"), Some(&storage), &[("labelSelector", &selector)], METADATA_LIST).await?;
            Ok(helm_revisions(obj, &storage, &items))
        }
        _ => Err(BackendError::invalid(format!("{} have no revisions", obj.gvr.resource))),
    }
}

pub mod cmd {
    use crate::ipc::{FieldOwner, ObjRef, Result, Revision};
    use crate::state::AppState;

    #[tauri::command]
    pub async fn field_owners(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<Vec<FieldOwner>> {
        super::field_owners(&state, &obj_ref).await
    }

    #[tauri::command]
    pub async fn revisions(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<Vec<Revision>> {
        super::revisions(&state, &obj_ref).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> Json {
        let path = format!("{}/tests/fixtures/ownership/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).expect("json")
    }

    fn owner(kind: &str) -> ObjRef {
        ObjRef { context: "default".into(), gvr: Gvr::new("apps", "v1", kind), namespace: Some("kns-spike".into()), name: "web".into() }
    }

    #[test]
    fn classifies_managers() {
        for (m, c) in [
            ("kustomize-controller", ManagerClass::Flux),
            ("helm-controller", ManagerClass::Flux),
            ("gotk-sync", ManagerClass::Flux),
            ("argocd-controller", ManagerClass::Argo),
            ("argocd-application-controller", ManagerClass::Argo),
            ("kns", ManagerClass::Kns),
            ("kubectl", ManagerClass::Kubectl),
            ("kubectl-client-side-apply", ManagerClass::Kubectl),
            ("kubectl-scale", ManagerClass::Kubectl),
            ("kubectl-edit", ManagerClass::Kubectl),
            ("kube-controller-manager", ManagerClass::Controller),
            ("cert-manager-certificates-controller", ManagerClass::Controller),
            ("kubelet", ManagerClass::Controller),
            ("k3s", ManagerClass::Controller),
            ("prometheus-operator", ManagerClass::Controller),
            ("Go-http-client", ManagerClass::Other),
            ("helm", ManagerClass::Other),
        ] {
            assert_eq!(classify(m), c, "{m}");
        }
    }

    #[test]
    fn decodes_fields_v1_of_a_deployment() {
        let obj = fixture("deployment");
        let owners = owners_of(&obj);
        let of = |path: &str| owners.iter().filter(|o| o.path == path).map(|o| o.manager.as_str()).collect::<Vec<_>>();
        // f: leaves
        assert_eq!(of("/spec/replicas"), ["kubectl-scale"]);
        assert_eq!(of("/metadata/labels/app"), ["kustomize-controller"]);
        // k:{"name":...} resolved to the index in the live list ("sidecar" is item 1)
        assert_eq!(of("/spec/template/spec/containers/1/image"), ["kustomize-controller"]);
        assert_eq!(of("/spec/template/spec/containers/1"), ["kustomize-controller"]);
        // a multi-field key (containerPort + protocol)
        assert_eq!(of("/spec/template/spec/containers/0/ports/0/containerPort"), ["kustomize-controller"]);
        // `/` in a key is escaped as ~1
        assert_eq!(of("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt"), ["kns"]);
        // v: set items
        assert_eq!(of("/metadata/finalizers/0"), ["kustomize-controller"]);
        // status subresource
        let status: Vec<_> = owners.iter().filter(|o| o.path == "/status/replicas").collect();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].subresource.as_deref(), Some("status"));
        assert_eq!(status[0].manager_class, ManagerClass::Controller);
        // a key naming a list item the object no longer has is skipped, not mis-indexed
        assert!(owners.iter().all(|o| !o.path.contains("gone")));
        assert!(owners.iter().all(|o| !o.path.starts_with("/spec/template/spec/containers/2")));
        // shared ownership: one row per manager, sorted by class
        assert_eq!(of("/spec/template/spec/containers/0/image"), ["kustomize-controller", "kubectl-edit"]);
        // sorted by path
        assert!(owners.windows(2).all(|w| w[0].path <= w[1].path));
    }

    #[test]
    fn cleans_manager_names() {
        let obj = json!({
            "metadata": { "managedFields": [
                { "manager": "evil\u{202e}gnp.exe\u{1b}[31m", "operation": "Update", "fieldsType": "FieldsV1",
                  "fieldsV1": { "f:metadata": { "f:labels": { "f:x": {} } } } }
            ], "labels": { "x": "1" } }
        });
        let owners = owners_of(&obj);
        assert_eq!(owners.len(), 1);
        assert!(!owners[0].manager.contains('\u{202e}'));
        assert!(!owners[0].manager.contains('\u{1b}'));
        assert_eq!(owners[0].manager_class, ManagerClass::Other);
    }

    #[test]
    fn no_managed_fields_is_empty() {
        assert!(owners_of(&json!({"metadata": {}})).is_empty());
        assert!(decode_fields(&json!(null), &json!({})).is_empty());
    }

    #[test]
    fn replicasets_newest_first_without_hash_label() {
        let list = fixture("replicasets");
        let revs = replicaset_revisions(&owner("deployments"), "uid-web", list["items"].as_array().unwrap());
        assert_eq!(revs.iter().map(|r| r.revision).collect::<Vec<_>>(), [3, 2, 1]);
        assert_eq!(revs[0].id, "web-7c9f");
        assert_eq!(revs[0].image.as_deref(), Some("nginx:1.27-alpine"));
        assert_eq!(revs[0].obj_ref.gvr.resource, "replicasets");
        let t = revs[0].template.as_ref().unwrap();
        assert!(t["metadata"]["labels"].get("pod-template-hash").is_none());
        assert_eq!(t["metadata"]["labels"]["app"], "web");
    }

    #[test]
    fn controller_revisions_by_owner() {
        let list = fixture("controllerrevisions");
        let revs = controller_revisions(&owner("statefulsets"), "uid-sts", list["items"].as_array().unwrap());
        assert_eq!(revs.iter().map(|r| r.revision).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(revs[0].image.as_deref(), Some("postgres:17"));
    }

    #[test]
    fn helm_history_from_metadata_only() {
        let list = fixture("helm-metadata");
        let o = ObjRef {
            context: "default".into(),
            gvr: Gvr::new("helm.toolkit.fluxcd.io", "v2", "helmreleases"),
            namespace: Some("flux-system".into()),
            name: "api".into(),
        };
        let revs = helm_revisions(&o, "apps", list["items"].as_array().unwrap());
        assert_eq!(revs.iter().map(|r| r.revision).collect::<Vec<_>>(), [3, 2, 1]);
        assert!(revs.iter().all(|r| r.template.is_none()));
        assert_eq!(revs[0].obj_ref.namespace.as_deref(), Some("apps"));
        // nothing of the release payload survives
        assert!(!serde_json::to_string(&revs).unwrap().contains("H4sI"));
    }

    #[test]
    fn helm_release_names() {
        let hr = |spec: Json| json!({"metadata": {"name": "api", "namespace": "flux-system"}, "spec": spec});
        assert_eq!(helm_release_of(&hr(json!({})), "flux-system"), ("api".into(), "flux-system".into()));
        assert_eq!(helm_release_of(&hr(json!({"targetNamespace": "apps"})), "flux-system"), ("apps-api".into(), "flux-system".into()));
        assert_eq!(
            helm_release_of(&hr(json!({"releaseName": "x", "storageNamespace": "apps"})), "flux-system"),
            ("x".into(), "apps".into())
        );
    }

    #[test]
    fn pointer_escaping() {
        assert_eq!(pointer(&["a/b".into(), "c~d".into()]), "/a~1b/c~0d");
        assert_eq!(pointer(&[]), "");
    }
}
