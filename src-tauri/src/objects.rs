//! Read-only object access: YAML/JSON, events, pods behind a workload, decoded secrets.
use std::collections::{BTreeMap, HashSet};

use base64::Engine;

use crate::{
    ipc::{BackendError, EventRow, Gvr, Json, ObjRef, PodRef, Result, take_array},
    session::{Session, api_path, with_query},
    state::AppState,
};

// ───────────────────────── yaml ─────────────────────────

/// The YAML parser and emitter recurse per nesting level and overflow a 1-2 MiB stack on deep
/// documents (CRD schemas), so they run on a thread of their own, off the async runtime.
async fn on_big_stack<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new().name("yaml".into()).stack_size(64 << 20).spawn(move || {
        let _ = tx.send(work());
    })?;
    rx.await.map_err(|_| BackendError::internal("yaml worker died"))?
}

pub async fn to_yaml(value: Json) -> Result<String> {
    on_big_stack(move || serde_saphyr::to_string(&value).map_err(|e| BackendError::internal(format!("yaml: {e}"))))
        .await
}

/// Parses a (multi-document) YAML stream; empty documents are dropped.
pub async fn from_yaml(text: String) -> Result<Vec<Json>> {
    on_big_stack(move || parse_yaml(&text, None)).await
}

/// A long stream of small documents (an organisation catalog has thousands): the parser's
/// default budget stops at 1024 documents and 250 000 nodes.
pub async fn from_yaml_stream(text: String) -> Result<Vec<Json>> {
    let mut budget = serde_saphyr::budget::Budget::default();
    budget.max_documents = 200_000;
    budget.max_nodes = 5_000_000;
    budget.max_events = 20_000_000;
    on_big_stack(move || parse_yaml(&text, Some(budget))).await
}

fn parse_yaml(text: &str, budget: Option<serde_saphyr::budget::Budget>) -> Result<Vec<Json>> {
    // YAML 1.1 octals, as kubectl reads them: `defaultMode: 0644` is 420, not the float 644.0.
    let mut options = serde_saphyr::Options::default();
    options.legacy_octal_numbers = true;
    if budget.is_some() {
        options.budget = budget;
    }
    let docs: Vec<Json> = serde_saphyr::from_multiple_with_options(text, options)
        .map_err(|e| BackendError::new(0, "InvalidYaml", e.to_string()))?;
    Ok(docs.into_iter().filter(|d| !d.is_null()).collect())
}

pub fn strip_managed_fields(object: &mut Json) {
    if let Some(meta) = object.get_mut("metadata").and_then(Json::as_object_mut) {
        meta.remove("managedFields");
    }
}

// ───────────────────────── get ─────────────────────────

pub async fn get(session: &Session, obj: &ObjRef) -> Result<Json> {
    session.get(&api_path(&obj.gvr, obj.ns(), Some(&obj.name))).await
}

pub async fn get_json(state: &AppState, obj: &ObjRef) -> Result<Json> {
    get(&*state.session(&obj.context).await?, obj).await
}

pub async fn get_yaml(state: &AppState, obj: &ObjRef, managed_fields: bool) -> Result<String> {
    let mut object = get_json(state, obj).await?;
    if !managed_fields {
        strip_managed_fields(&mut object);
    }
    to_yaml(object).await
}

// ───────────────────────── events ─────────────────────────

/// Events of one object (matched by involvedObject) or, without `obj`, of a namespace / the cluster.
pub async fn list_events(
    state: &AppState,
    context: &str,
    namespace: Option<&str>,
    obj: Option<&ObjRef>,
) -> Result<Vec<EventRow>> {
    let session = state.session(context).await?;
    let (namespace, selector) = match obj {
        Some(o) => {
            let mut selector = format!("involvedObject.name={}", o.name);
            if let Some(kind) = session.discovery(None).await?.find(&o.gvr).map(|r| r.kind.clone()) {
                selector.push_str(&format!(",involvedObject.kind={kind}"));
            }
            if let Some(ns) = o.ns() {
                selector.push_str(&format!(",involvedObject.namespace={ns}"));
            }
            (o.ns(), selector)
        }
        None => (namespace, String::new()),
    };
    let uri = with_query(&api_path(&Gvr::new("", "v1", "events"), namespace, None), &[("fieldSelector", &selector)]);
    let list = session.get(&uri).await?;
    let text = |v: &Json| v.as_str().unwrap_or_default().to_string();
    let mut rows: Vec<EventRow> = items(&list)
        .iter()
        .map(|e| EventRow {
            type_: text(&e["type"]),
            reason: text(&e["reason"]),
            message: text(&e["message"]),
            count: e["count"].as_i64().or_else(|| e["series"]["count"].as_i64()).unwrap_or(1),
            last_seen: [
                &e["lastTimestamp"],
                &e["series"]["lastObservedTime"],
                &e["eventTime"],
                &e["metadata"]["creationTimestamp"],
            ]
            .iter()
            .find_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_string)),
            source: [&e["source"]["component"], &e["reportingComponent"]]
                .iter()
                .find_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_string))
                .unwrap_or_default(),
            object_kind: text(&e["involvedObject"]["kind"]),
            object_name: text(&e["involvedObject"]["name"]),
            namespace: e["metadata"]["namespace"].as_str().map(str::to_string),
        })
        .collect();
    // RFC3339 UTC timestamps order lexicographically.
    rows.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    Ok(rows)
}

// ───────────────────────── pods ─────────────────────────

fn items(list: &Json) -> &[Json] {
    list["items"].as_array().map(Vec::as_slice).unwrap_or_default()
}

fn pod_ref(pod: &Json) -> PodRef {
    let names = |v: &Json| -> Vec<String> {
        v.as_array()
            .map(|a| a.iter().filter_map(|c| c["name"].as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let text = |v: &Json| v.as_str().unwrap_or_default().to_string();
    PodRef {
        namespace: text(&pod["metadata"]["namespace"]),
        name: text(&pod["metadata"]["name"]),
        containers: names(&pod["spec"]["containers"]),
        init_containers: names(&pod["spec"]["initContainers"]),
        ephemeral_containers: names(&pod["spec"]["ephemeralContainers"]),
        phase: text(&pod["status"]["phase"]),
        node: pod["spec"]["nodeName"].as_str().map(str::to_string),
    }
}

/// Label selector string for a `LabelSelector` object or a plain label map; `None` when it selects nothing.
fn selector_string(selector: &Json) -> Option<String> {
    let map = selector.as_object()?;
    let structured = map.contains_key("matchLabels") || map.contains_key("matchExpressions");
    let labels = if structured { selector["matchLabels"].as_object() } else { Some(map) };
    let mut parts: Vec<String> = labels
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| Some(format!("{k}={}", v.as_str()?)))
        .collect();
    for expr in selector["matchExpressions"].as_array().into_iter().flatten() {
        let key = expr["key"].as_str()?;
        let values: Vec<&str> = expr["values"].as_array().into_iter().flatten().filter_map(Json::as_str).collect();
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

async fn list_pods(session: &Session, namespace: Option<&str>, params: &[(&str, &str)]) -> Result<Vec<Json>> {
    let uri = with_query(&api_path(&Gvr::new("", "v1", "pods"), namespace, None), params);
    Ok(take_array(&mut session.get(&uri).await?, "items"))
}

/// Pods behind a workload, service, job, cronjob or node (or the pod itself).
pub async fn pods_for(state: &AppState, obj: &ObjRef) -> Result<Vec<PodRef>> {
    let session = state.session(&obj.context).await?;
    let pods = match (obj.gvr.group.as_str(), obj.gvr.resource.as_str()) {
        ("", "pods") => vec![get(&session, obj).await?],
        ("", "nodes") => {
            list_pods(&session, None, &[("fieldSelector", &format!("spec.nodeName={}", obj.name))]).await?
        }
        ("batch", "cronjobs") => {
            let cronjob = get(&session, obj).await?;
            let owned_by = |o: &Json, uids: &HashSet<&str>| {
                o["metadata"]["ownerReferences"]
                    .as_array()
                    .is_some_and(|refs| refs.iter().any(|r| r["uid"].as_str().is_some_and(|u| uids.contains(u))))
            };
            let jobs = session.get(&api_path(&Gvr::new("batch", &obj.gvr.version, "jobs"), obj.ns(), None)).await?;
            let cronjob_uid: HashSet<&str> = cronjob["metadata"]["uid"].as_str().into_iter().collect();
            let job_uids: HashSet<&str> = items(&jobs)
                .iter()
                .filter(|j| owned_by(j, &cronjob_uid))
                .filter_map(|j| j["metadata"]["uid"].as_str())
                .collect();
            if job_uids.is_empty() {
                Vec::new()
            } else {
                let pods = list_pods(&session, obj.ns(), &[]).await?;
                pods.into_iter().filter(|p| owned_by(p, &job_uids)).collect()
            }
        }
        // Only kinds whose `spec.selector` selects pods: elsewhere it means something else (a PVC's selects volumes).
        ("apps", "deployments" | "statefulsets" | "daemonsets" | "replicasets")
        | ("batch", "jobs")
        | ("policy", "poddisruptionbudgets")
        | ("", "services" | "replicationcontrollers") => {
            match selector_string(&get(&session, obj).await?["spec"]["selector"]) {
                Some(selector) => list_pods(&session, obj.ns(), &[("labelSelector", &selector)]).await?,
                None => Vec::new(),
            }
        }
        _ => Vec::new(),
    };
    Ok(pods.iter().map(pod_ref).collect())
}

// ───────────────────────── secrets ─────────────────────────

/// Secret data decoded from base64: key → UTF-8 text, or `None` for binary values.
/// A Secret as the diff may show it (§6.6 e): every `data` / `stringData` value becomes
/// `••• <digest>`, a short SHA-256 of `salt` and the value, so two sides fetched with one salt
/// still show *whether* a value changed but never the value. The last-applied annotation (it holds
/// the values) is dropped. Any other kind is returned as is.
pub fn mask_secret_values(obj: &mut Json, salt: &str) {
    use sha2::{Digest, Sha256};
    let is_secret = obj["kind"] == "Secret" && obj["apiVersion"] == "v1";
    if !is_secret {
        return;
    }
    // get_mut, not `obj[field]`: mutable indexing would insert `null` for a missing key
    for field in ["data", "stringData"] {
        if let Some(map) = obj.get_mut(field).and_then(|v| v.as_object_mut()) {
            for v in map.values_mut() {
                let raw = v.as_str().unwrap_or_default();
                let digest = Sha256::digest(format!("{salt}\u{0}{raw}").as_bytes());
                let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
                *v = Json::String(format!("••• {hex}"));
            }
        }
    }
    if let Some(ann) = obj.pointer_mut("/metadata/annotations").and_then(|v| v.as_object_mut()) {
        ann.remove("kubectl.kubernetes.io/last-applied-configuration");
    }
}

/// [`get_json`] with Secret values masked in Rust ([`mask_secret_values`]); the webview never gets them.
pub async fn get_json_masked(state: &AppState, obj: &ObjRef, salt: &str) -> Result<Json> {
    let mut o = get_json(state, obj).await?;
    let secret_ref = obj.gvr.group.is_empty() && obj.gvr.resource == "secrets";
    if secret_ref && o["kind"] != "Secret" {
        return Err(BackendError::internal("expected a Secret"));
    }
    mask_secret_values(&mut o, salt);
    Ok(o)
}

pub async fn decode_secret(state: &AppState, obj: &ObjRef) -> Result<BTreeMap<String, Option<String>>> {
    let secret = get_json(state, obj).await?;
    let decode = |v: &Json| {
        let bytes = base64::engine::general_purpose::STANDARD.decode(v.as_str()?).ok()?;
        String::from_utf8(bytes).ok()
    };
    Ok(secret["data"]
        .as_object()
        .map(|data| data.iter().map(|(k, v)| (k.clone(), decode(v))).collect())
        .unwrap_or_default())
}

pub mod cmd {
    use std::collections::BTreeMap;

    use super::AppState;
    use crate::ipc::{EventRow, Json, ObjRef, PodRef, Result};

    #[tauri::command]
    pub async fn get_yaml(state: tauri::State<'_, AppState>, obj_ref: ObjRef, managed_fields: bool) -> Result<String> {
        super::get_yaml(&state, &obj_ref, managed_fields).await
    }

    #[tauri::command]
    pub async fn get_json(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<Json> {
        super::get_json(&state, &obj_ref).await
    }

    /// The diff's fetch: Secret values masked (with a per-diff salt), never sent to the webview.
    #[tauri::command]
    pub async fn get_json_masked(state: tauri::State<'_, AppState>, obj_ref: ObjRef, salt: String) -> Result<Json> {
        super::get_json_masked(&state, &obj_ref, &salt).await
    }

    #[tauri::command]
    pub async fn list_events(
        state: tauri::State<'_, AppState>,
        context: String,
        namespace: Option<String>,
        obj_ref: Option<ObjRef>,
    ) -> Result<Vec<EventRow>> {
        super::list_events(&state, &context, namespace.as_deref(), obj_ref.as_ref()).await
    }

    #[tauri::command]
    pub async fn pods_for(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<Vec<PodRef>> {
        super::pods_for(&state, &obj_ref).await
    }

    #[tauri::command]
    pub async fn decode_secret(
        state: tauri::State<'_, AppState>,
        obj_ref: ObjRef,
    ) -> Result<BTreeMap<String, Option<String>>> {
        super::decode_secret(&state, &obj_ref).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{mask_secret_values, parse_yaml};

    /// §6.6 e: the diff's Secret fetch masks every value in Rust; equal values keep equal digests
    /// under one salt, so a changed key still shows as changed.
    #[test]
    fn secret_values_are_masked_with_comparable_digests() {
        let secret = |pw: &str| {
            json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": "db", "annotations": { "kubectl.kubernetes.io/last-applied-configuration": format!("{{\"data\":{{\"pw\":\"{pw}\"}}}}"), "team": "a" } },
                    "data": { "pw": pw, "user": "YXBw" }, "stringData": { "token": "s3cr3t-token" } })
        };
        let (mut a, mut b) = (secret("czNjcjN0LXZhbHVl"), secret("b3RoZXI="));
        mask_secret_values(&mut a, "salt1");
        mask_secret_values(&mut b, "salt1");
        let text = format!("{a}{b}");
        for bad in ["czNjcjN0LXZhbHVl", "b3RoZXI=", "YXBw", "s3cr3t-token", "last-applied"] {
            assert!(!text.contains(bad), "{bad}: {text}");
        }
        assert_eq!(a["data"]["user"], b["data"]["user"], "same value, same digest");
        assert_ne!(a["data"]["pw"], b["data"]["pw"], "changed value, other digest");
        assert_eq!(a["metadata"]["annotations"]["team"], "a");
        let mut c = secret("czNjcjN0LXZhbHVl");
        mask_secret_values(&mut c, "salt2");
        assert_ne!(a["data"]["pw"], c["data"]["pw"], "digests do not carry over between diffs");
        // a bare Secret gets no keys it did not have
        let mut bare = json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": "x" }, "data": { "k": "dg==" } });
        mask_secret_values(&mut bare, "s");
        assert!(bare.get("stringData").is_none() && bare["metadata"].get("annotations").is_none(), "{bare}");
        let mut cm = json!({ "apiVersion": "v1", "kind": "ConfigMap", "data": { "a": "plain" } });
        mask_secret_values(&mut cm, "s");
        assert_eq!(cm["data"]["a"], "plain", "other kinds untouched");
    }

    #[test]
    fn yaml_octals_like_kubectl() {
        let docs = parse_yaml("mode: 0644\nquoted: \"0644\"\nexec: 0755\nro: 0400\nplain: 420\nzero: 0\n", None).expect("yaml");
        assert_eq!(docs, [json!({ "mode": 420, "quoted": "0644", "exec": 493, "ro": 256, "plain": 420, "zero": 0 })]);
    }

    /// Strings that look like numbers must survive emit → parse (edit and re-apply) as strings.
    #[test]
    fn yaml_round_trip_keeps_number_like_strings() {
        let object = json!({
            "octal": "0644", "short": "010", "not_octal": "08", "hex": "0x1F", "new_octal": "0o17",
            "int": "420", "float": "1.0", "exp": "1e3", "bool": "true", "null": "null", "tilde": "~", "empty": "",
            "number": 420, "real": 1.5,
        });
        let yaml = serde_saphyr::to_string(&object).expect("emit");
        assert_eq!(parse_yaml(&yaml, None).expect("parse"), [object], "{yaml}");
    }
}
