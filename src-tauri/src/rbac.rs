//! `can_i`: SelfSubjectAccessReview with a short per-session cache.
use std::time::{Duration, Instant};

use http::Method;
use serde_json::json;

use crate::{
    ipc::{AccessQuery, Result},
    session::JSON,
    state::{AppState, lock},
};

const TTL: Duration = Duration::from_secs(60);
const URI: &str = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";

pub async fn can_i(state: &AppState, q: &AccessQuery) -> Result<bool> {
    let session = state.session(&q.context).await?;
    let opt = |v: &Option<String>| v.clone().unwrap_or_default();
    let (subresource, namespace, name) = (opt(&q.subresource), opt(&q.namespace), opt(&q.name));
    let key = format!(
        "{}\n{}\n{}\n{}\n{subresource}\n{namespace}\n{name}",
        q.verb, q.gvr.group, q.gvr.version, q.gvr.resource
    );
    if let Some((at, allowed)) = lock(&session.access).get(&key).copied()
        && at.elapsed() < TTL
    {
        return Ok(allowed);
    }
    let review = json!({
        "apiVersion": "authorization.k8s.io/v1",
        "kind": "SelfSubjectAccessReview",
        "spec": { "resourceAttributes": {
            "verb": q.verb,
            "group": q.gvr.group,
            "version": q.gvr.version,
            "resource": q.gvr.resource,
            "subresource": subresource,
            "namespace": namespace,
            "name": name,
        }},
    });
    let answer = session.send_json(Method::POST, URI, JSON, &review).await?;
    let allowed = answer["status"]["allowed"] == true;
    let mut cache = lock(&session.access);
    cache.retain(|_, (at, _)| at.elapsed() < TTL);
    cache.insert(key, (Instant::now(), allowed));
    Ok(allowed)
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{AccessQuery, Result};

    #[tauri::command]
    pub async fn can_i(state: tauri::State<'_, AppState>, query: AccessQuery) -> Result<bool> {
        super::can_i(&state, &query).await
    }
}
