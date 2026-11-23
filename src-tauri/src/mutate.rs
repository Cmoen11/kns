//! Everything that changes the cluster.
use http::Method;
use serde_json::json;

use crate::{
    ipc::{ApplyOptions, ApplyResult, BackendError, DeleteOptions, Gvr, Json, ObjRef, PatchType, Result},
    objects::{from_yaml, get, strip_managed_fields, to_yaml},
    session::{APPLY_PATCH, JSON, JSON_PATCH, MERGE_PATCH, Session, api_path, with_query},
    state::AppState,
};

const FIELD_MANAGER: &str = "kns";

fn object_path(obj: &ObjRef, subresource: Option<&str>) -> String {
    let mut path = api_path(&obj.gvr, obj.ns(), Some(&obj.name));
    if let Some(sub) = subresource.filter(|s| !s.is_empty()) {
        path.push('/');
        path.push_str(&crate::session::esc(sub));
    }
    path
}

// ───────────────────────── apply ─────────────────────────

/// Server-side apply of every document in `yaml`. Stops at the first failing document.
pub async fn apply_yaml(state: &AppState, context: &str, yaml: &str, opts: &ApplyOptions) -> Result<ApplyResult> {
    let session = state.session(context).await?;
    let docs = from_yaml(yaml.to_string()).await?;
    if docs.is_empty() {
        return Err(BackendError::new(0, "InvalidYaml", "no documents to apply"));
    }
    let mut result = ApplyResult { yaml: String::new(), warnings: Vec::new() };
    for doc in &docs {
        let label = format!(
            "{}/{}",
            doc["kind"].as_str().unwrap_or("?"),
            doc["metadata"]["name"].as_str().unwrap_or("?")
        );
        let (mut applied, warnings) = apply_one(&session, doc, opts)
            .await
            .map_err(|e| BackendError { message: format!("{label}: {}", e.message), ..e })?;
        strip_managed_fields(&mut applied);
        if !result.yaml.is_empty() {
            result.yaml.push_str("---\n");
        }
        result.yaml.push_str(&to_yaml(applied).await?);
        result.warnings.extend(warnings);
    }
    Ok(result)
}

async fn apply_one(session: &Session, doc: &Json, opts: &ApplyOptions) -> Result<(Json, Vec<String>)> {
    let missing = |field: &str| BackendError::invalid(format!("missing {field}"));
    let api_version = doc["apiVersion"].as_str().ok_or_else(|| missing("apiVersion"))?;
    let kind = doc["kind"].as_str().ok_or_else(|| missing("kind"))?;
    let name = doc["metadata"]["name"].as_str().ok_or_else(|| missing("metadata.name"))?;
    let (group, version) = api_version.rsplit_once('/').unwrap_or(("", api_version));

    // A kind that is not in the cache may have been installed a moment ago (CRD in an earlier document).
    let mut discovery = session.discovery(None).await?;
    if discovery.by_kind(group, version, kind).is_none() {
        discovery = session.discovery(Some(std::time::Duration::ZERO)).await?;
    }
    let resource = discovery
        .by_kind(group, version, kind)
        .ok_or_else(|| BackendError::new(404, "NotFound", format!("the server has no kind {kind} in {api_version}")))?;
    let namespace = resource
        .namespaced
        .then(|| doc["metadata"]["namespace"].as_str().unwrap_or(session.client.default_namespace()));

    let uri = with_query(
        &api_path(&resource.gvr, namespace, Some(name)),
        &[
            ("fieldManager", FIELD_MANAGER),
            ("force", if opts.force.unwrap_or(false) { "true" } else { "" }),
            ("dryRun", if opts.dry_run.unwrap_or(false) { "All" } else { "" }),
        ],
    );
    // JSON is valid YAML, so the parsed document is sent as JSON. The server refuses an apply that
    // carries managedFields, which YAML fetched with them (`get_yaml`) does.
    let mut doc = doc.clone();
    strip_managed_fields(&mut doc);
    let body = serde_json::to_vec(&doc)?;
    let (headers, text) = session.send(Method::PATCH, &uri, Some(JSON), Some((APPLY_PATCH, body))).await?;
    let warnings = headers
        .get_all(http::header::WARNING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(warning_texts)
        .collect();
    Ok((serde_json::from_slice(&text)?, warnings))
}

/// Messages of a `Warning` header: `299 - "first", 299 - "second"`, quoted strings with `\` escapes.
fn warning_texts(header: &str) -> Vec<String> {
    let mut texts = Vec::new();
    let mut chars = header.chars();
    // A second quoted string before the next comma is the warning's optional date.
    let mut is_date = false;
    while let Some(c) = chars.next() {
        match c {
            ',' => is_date = false,
            '"' => {
                let mut text = String::new();
                while let Some(c) = chars.next().filter(|c| *c != '"') {
                    text.push(if c == '\\' { chars.next().unwrap_or(c) } else { c });
                }
                if !std::mem::replace(&mut is_date, true) {
                    texts.push(text);
                }
            }
            _ => {}
        }
    }
    if texts.is_empty() {
        texts.push(header.to_string());
    }
    texts
}

// ───────────────────────── delete / patch ─────────────────────────

pub async fn delete_object(state: &AppState, obj: &ObjRef, opts: &DeleteOptions) -> Result<()> {
    let session = state.session(&obj.context).await?;
    let mut body = json!({ "apiVersion": "v1", "kind": "DeleteOptions" });
    if let Some(p) = opts.propagation {
        body["propagationPolicy"] = json!(p);
    }
    if let Some(grace) = opts.grace_period_seconds {
        body["gracePeriodSeconds"] = json!(grace);
    }
    session.send_json(Method::DELETE, &object_path(obj, None), JSON, &body).await?;
    Ok(())
}

pub async fn patch_object(
    state: &AppState,
    obj: &ObjRef,
    patch: &Json,
    patch_type: PatchType,
    subresource: Option<&str>,
) -> Result<()> {
    let session = state.session(&obj.context).await?;
    let content_type = if patch_type == PatchType::Json { JSON_PATCH } else { MERGE_PATCH };
    let uri = with_query(&object_path(obj, subresource), &[("fieldManager", FIELD_MANAGER)]);
    session.send_json(Method::PATCH, &uri, content_type, patch).await?;
    Ok(())
}

pub async fn scale(state: &AppState, obj: &ObjRef, replicas: u32) -> Result<()> {
    patch_object(state, obj, &json!({ "spec": { "replicas": replicas } }), PatchType::Merge, Some("scale")).await
}

/// Rolling restart, the way `kubectl rollout restart` does it.
pub async fn restart(state: &AppState, obj: &ObjRef) -> Result<()> {
    let now = jiff::Timestamp::now().strftime("%Y-%m-%dT%H:%M:%SZ").to_string();
    let patch = json!({
        "spec": { "template": { "metadata": { "annotations": { "kubectl.kubernetes.io/restartedAt": now } } } }
    });
    patch_object(state, obj, &patch, PatchType::Merge, None).await
}

// ───────────────────────── cronjob ─────────────────────────

fn random_suffix(len: usize) -> String {
    use std::hash::{BuildHasher, Hasher};
    const ALPHABET: &[u8] = b"bcdfghjklmnpqrstvwxz2456789";
    let mut n = std::collections::hash_map::RandomState::new().build_hasher().finish();
    (0..len)
        .map(|_| {
            let c = ALPHABET[(n % ALPHABET.len() as u64) as usize] as char;
            n /= ALPHABET.len() as u64;
            c
        })
        .collect()
}

/// Runs a CronJob now by creating a Job from its template; returns the Job name.
pub async fn trigger_cron_job(state: &AppState, obj: &ObjRef) -> Result<String> {
    let session = state.session(&obj.context).await?;
    let cronjob = get(&session, obj).await?;
    let template = &cronjob["spec"]["jobTemplate"];
    if !template["spec"].is_object() {
        return Err(BackendError::invalid(format!("{} has no spec.jobTemplate", obj.name)));
    }
    // Job names are limited to 63 characters.
    let prefix: String = obj.name.chars().take(63 - "-manual-".len() - 5).collect();
    let name = format!("{prefix}-manual-{}", random_suffix(5));
    let mut annotations = template["metadata"]["annotations"].as_object().cloned().unwrap_or_default();
    annotations.insert("cronjob.kubernetes.io/instantiate".into(), json!("manual"));
    let job = json!({
        "apiVersion": format!("batch/{}", obj.gvr.version),
        "kind": "Job",
        "metadata": {
            "name": name,
            "namespace": cronjob["metadata"]["namespace"],
            "labels": template["metadata"]["labels"],
            "annotations": annotations,
            "ownerReferences": [{
                "apiVersion": cronjob["apiVersion"].as_str().unwrap_or("batch/v1"),
                "kind": "CronJob",
                "name": cronjob["metadata"]["name"],
                "uid": cronjob["metadata"]["uid"],
                "controller": true,
                "blockOwnerDeletion": true,
            }],
        },
        "spec": template["spec"],
    });
    let uri = with_query(
        &api_path(&Gvr::new("batch", &obj.gvr.version, "jobs"), obj.ns(), None),
        &[("fieldManager", FIELD_MANAGER)],
    );
    session.send_json(Method::POST, &uri, JSON, &job).await?;
    Ok(name)
}

/// A merge patch that only asks Flux to reconcile (what `flux.reconcile` sends): the one thing a
/// `reconcile` proposal may patch.
fn is_reconcile_patch(patch: &Json) -> bool {
    let only = |v: &Json, key: &str| v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(key));
    only(patch, "metadata")
        && only(&patch["metadata"], "annotations")
        && only(&patch["metadata"]["annotations"], "reconcile.fluxcd.io/requestedAt")
        && patch["metadata"]["annotations"]["reconcile.fluxcd.io/requestedAt"].is_string()
}

/// The write commands. With a `proposal_id` each one is a step of an approved agent proposal:
/// `proposals::run_step` gates it, checks the arguments against the approved payload and records
/// the outcome (docs/plan-features.md §2.6). Without one it is a human action, as before.
/// A reconcile with source: the executor patches the source without `proposal_id`, then the
/// object itself with it (the proposal has one step).
pub mod cmd {
    use super::{AppState, is_reconcile_patch};
    use crate::{
        ipc::{ApplyOptions, ApplyResult, DeleteOptions, Json, ObjRef, PatchType, ProposalPayload, Result},
        proposals::run_step,
    };

    #[tauri::command]
    pub async fn apply_yaml(
        state: tauri::State<'_, AppState>,
        context: String,
        yaml: String,
        opts: ApplyOptions,
        proposal_id: Option<String>,
    ) -> Result<ApplyResult> {
        let matches = |p: &ProposalPayload| matches!(p, ProposalPayload::Apply { context: c, yaml: y, .. } if *c == context && *y == yaml);
        run_step(&state, proposal_id.as_deref(), "apply", matches, super::apply_yaml(&state, &context, &yaml, &opts)).await
    }

    #[tauri::command]
    pub async fn delete_object(
        state: tauri::State<'_, AppState>,
        obj_ref: ObjRef,
        opts: DeleteOptions,
        proposal_id: Option<String>,
    ) -> Result<()> {
        let matches = |p: &ProposalPayload| matches!(p, ProposalPayload::Delete { obj_ref: r } if *r == obj_ref);
        run_step(&state, proposal_id.as_deref(), "delete", matches, super::delete_object(&state, &obj_ref, &opts)).await
    }

    #[tauri::command]
    pub async fn patch_object(
        state: tauri::State<'_, AppState>,
        obj_ref: ObjRef,
        patch: Json,
        patch_type: PatchType,
        subresource: Option<String>,
        proposal_id: Option<String>,
    ) -> Result<()> {
        let matches = |p: &ProposalPayload| {
            matches!(p, ProposalPayload::Reconcile { obj_ref: r, .. } if *r == obj_ref)
                && patch_type == PatchType::Merge
                && subresource.is_none()
                && is_reconcile_patch(&patch)
        };
        let run = super::patch_object(&state, &obj_ref, &patch, patch_type, subresource.as_deref());
        run_step(&state, proposal_id.as_deref(), "reconcile", matches, run).await
    }

    #[tauri::command]
    pub async fn scale(state: tauri::State<'_, AppState>, obj_ref: ObjRef, replicas: u32, proposal_id: Option<String>) -> Result<()> {
        let matches = |p: &ProposalPayload| matches!(p, ProposalPayload::Scale { obj_ref: r, replicas: n } if *r == obj_ref && *n == replicas);
        run_step(&state, proposal_id.as_deref(), "scale", matches, super::scale(&state, &obj_ref, replicas)).await
    }

    #[tauri::command]
    pub async fn restart(state: tauri::State<'_, AppState>, obj_ref: ObjRef, proposal_id: Option<String>) -> Result<()> {
        let matches = |p: &ProposalPayload| matches!(p, ProposalPayload::Restart { obj_ref: r } if *r == obj_ref);
        run_step(&state, proposal_id.as_deref(), "restart", matches, super::restart(&state, &obj_ref)).await
    }

    #[tauri::command]
    pub async fn trigger_cron_job(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<String> {
        super::trigger_cron_job(&state, &obj_ref).await
    }
}

#[cfg(test)]
mod tests {
    use super::warning_texts;

    #[test]
    fn only_a_reconcile_patch_passes_for_a_reconcile_proposal() {
        use super::is_reconcile_patch;
        use serde_json::json;
        assert!(is_reconcile_patch(&json!({ "metadata": { "annotations": { "reconcile.fluxcd.io/requestedAt": "2026-11-22T10:00:00Z" } } })));
        assert!(!is_reconcile_patch(&json!({ "spec": { "suspend": true } })));
        assert!(!is_reconcile_patch(&json!({ "metadata": { "annotations": { "reconcile.fluxcd.io/requestedAt": "x", "evil": "y" } } })));
        assert!(!is_reconcile_patch(&json!({ "metadata": { "annotations": { "reconcile.fluxcd.io/requestedAt": "x" }, "labels": {} } })));
    }

    #[test]
    fn warning_headers() {
        assert_eq!(warning_texts(r#"299 - "one""#), ["one"]);
        let two = r#"299 - "one, two", 299 - "say \"hi\" \\ bye" "Mon, 01 Jan 2026 00:00:00 GMT""#;
        assert_eq!(warning_texts(two), ["one, two", r#"say "hi" \ bye"#]);
        assert_eq!(warning_texts("unquoted"), ["unquoted"]);
    }
}
