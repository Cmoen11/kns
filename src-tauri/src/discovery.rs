//! API discovery: aggregated (`APIGroupDiscoveryList`) with a fallback to the legacy
//! per-group-version documents.
use std::{collections::HashSet, time::Duration};

use futures::future::join_all;

use crate::{
    ipc::{ApiResource, Gvr, Json, Result},
    session::Session,
    state::AppState,
};

const AGGREGATED: &str = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList, application/json";
/// The `discover` command refetches when the cache is older than this.
const FRESH: Duration = Duration::from_secs(10);

#[derive(Debug, Default)]
pub struct Discovery {
    /// Every served group/version/resource; versions of a group in preference order.
    pub all: Vec<ApiResource>,
    /// One entry per group/resource at its preferred version.
    pub preferred: Vec<ApiResource>,
    /// The aggregated APIs (`/apis`) did not answer: only the core group is listed.
    pub partial: bool,
}

impl Discovery {
    pub fn find(&self, gvr: &Gvr) -> Option<&ApiResource> {
        self.all.iter().find(|r| &r.gvr == gvr)
    }

    pub fn by_kind(&self, group: &str, version: &str, kind: &str) -> Option<&ApiResource> {
        self.all.iter().find(|r| r.gvr.group == group && r.gvr.version == version && r.kind == kind)
    }

    pub fn has_group(&self, group: &str) -> bool {
        self.all.iter().any(|r| r.gvr.group == group)
    }

    fn from_all(all: Vec<ApiResource>, partial: bool) -> Self {
        let mut seen = HashSet::new();
        let preferred =
            all.iter().filter(|r| seen.insert((r.gvr.group.clone(), r.gvr.resource.clone()))).cloned().collect();
        Self { all, preferred, partial }
    }
}

pub async fn discover(state: &AppState, context: &str) -> Result<Vec<ApiResource>> {
    let session = state.session(context).await?;
    Ok(session.discovery(Some(FRESH)).await?.preferred.clone())
}

pub async fn fetch(session: &Session) -> Result<Discovery> {
    let (core, groups) = tokio::join!(root(session, "/api"), root(session, "/apis"));
    let mut all = core?;
    // A broken aggregated API must not hide the core group; the result is marked so it is not cached for long.
    let partial = groups.is_err();
    all.extend(groups.unwrap_or_default());
    Ok(Discovery::from_all(all, partial))
}

async fn root(session: &Session, path: &str) -> Result<Vec<ApiResource>> {
    let doc: Json = session.get_as(path, AGGREGATED).await?;
    if doc["kind"] == "APIGroupDiscoveryList" { Ok(aggregated(&doc)) } else { legacy(session, path, &doc).await }
}

fn strings(v: &Json) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn list(v: &Json) -> &[Json] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn text(v: &Json) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn aggregated(doc: &Json) -> Vec<ApiResource> {
    let mut out = Vec::new();
    for group in list(&doc["items"]) {
        let group_name = group["metadata"]["name"].as_str().unwrap_or_default();
        for version in list(&group["versions"]) {
            let version_name = version["version"].as_str().unwrap_or_default();
            for r in list(&version["resources"]) {
                out.push(ApiResource {
                    gvr: Gvr::new(group_name, version_name, r["resource"].as_str().unwrap_or_default()),
                    kind: text(&r["responseKind"]["kind"]),
                    singular: text(&r["singularResource"]),
                    namespaced: r["scope"] == "Namespaced",
                    verbs: strings(&r["verbs"]),
                    short_names: strings(&r["shortNames"]),
                    categories: strings(&r["categories"]),
                    subresources: list(&r["subresources"]).iter().map(|s| text(&s["subresource"])).collect(),
                });
            }
        }
    }
    out
}

/// Legacy discovery: `/api` lists versions, `/apis` lists groups; each group-version has its own document.
async fn legacy(session: &Session, path: &str, doc: &Json) -> Result<Vec<ApiResource>> {
    let mut group_versions: Vec<(String, String)> = Vec::new();
    if path == "/api" {
        group_versions.extend(strings(&doc["versions"]).into_iter().map(|v| (String::new(), v)));
    } else {
        for group in list(&doc["groups"]) {
            let name = text(&group["name"]);
            let preferred = text(&group["preferredVersion"]["version"]);
            let mut versions: Vec<String> = list(&group["versions"]).iter().map(|v| text(&v["version"])).collect();
            versions.sort_by_key(|v| *v != preferred);
            group_versions.extend(versions.into_iter().map(|v| (name.clone(), v)));
        }
    }
    let docs = join_all(group_versions.iter().map(|(group, version)| {
        let uri = if group.is_empty() { format!("/api/{version}") } else { format!("/apis/{group}/{version}") };
        async move { session.get(&uri).await }
    }))
    .await;

    let mut out = Vec::new();
    // Group-versions that fail to answer (stale APIService) are skipped.
    for ((group, version), doc) in group_versions.iter().zip(docs) {
        let Ok(doc) = doc else { continue };
        let resources = list(&doc["resources"]);
        for r in resources {
            let name = r["name"].as_str().unwrap_or_default();
            if name.contains('/') {
                continue;
            }
            let prefix = format!("{name}/");
            out.push(ApiResource {
                gvr: Gvr::new(group, version, name),
                kind: text(&r["kind"]),
                singular: text(&r["singularName"]),
                namespaced: r["namespaced"] == true,
                verbs: strings(&r["verbs"]),
                short_names: strings(&r["shortNames"]),
                categories: strings(&r["categories"]),
                subresources: resources
                    .iter()
                    .filter_map(|s| s["name"].as_str()?.strip_prefix(&prefix).map(str::to_string))
                    .collect(),
            });
        }
    }
    Ok(out)
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{ApiResource, Result};

    #[tauri::command]
    pub async fn discover(state: tauri::State<'_, AppState>, context: String) -> Result<Vec<ApiResource>> {
        super::discover(&state, &context).await
    }
}
