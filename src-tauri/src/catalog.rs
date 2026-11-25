//! The organisation catalog (docs/catalog.md): which teams own which systems, the namespace a
//! system has in each environment, the repositories behind its workloads and which kube context
//! is which environment. Optional; nothing in kns needs it.
//!
//! The file is a multi-document YAML (or JSON) stream of Backstage entities
//! (`backstage.io/v1alpha1`: Group, User, System, Component, Resource) with a few `kns.dev/`
//! annotations. An organisation exports it from wherever it keeps that knowledge; kns knows no
//! organisation.
//!
//! The window never sends a path: the file is chosen in a native dialog that Rust opens, and its
//! path is kept in `<config>/catalog-source.path`, which `save_state` (always `<key>.json`) cannot
//! write. So the webview cannot point kns at another file. Errors name the file and the problem,
//! never its contents.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    ipc::{BackendError, Json, Result},
    redact::clean_untrusted,
};

const MAX_BYTES: u64 = 32 << 20;
const MAX_ENTITIES: usize = 100_000;
const MAX_TEXT: usize = 400;
const SOURCE_FILE: &str = "catalog-source.path";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub name: String,
    pub title: String,
    pub links: Vec<Link>,
    /// user entity names
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// team names
    pub member_of: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gitops {
    /// `argocd`, `flux` or what the catalog says
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// where an environment's image tag is, with `{app}` and `{env}`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_file: Option<String>,
    /// a workload is `<prefix><app>`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub name: String,
    pub description: String,
    /// spec.type: service, website, library, gitops ...
    #[serde(rename = "type")]
    pub kind: String,
    /// `owner/repo` on GitHub (`github.com/project-slug`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// workload names it deploys (`kns.dev/workloads`)
    pub workloads: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gitops: Option<Gitops>,
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct System {
    pub name: String,
    pub title: String,
    pub description: String,
    /// team name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// its namespace in every environment; none = it has no namespace
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// environments it runs in; empty = every one
    pub environments: Vec<String>,
    /// Secrets its namespace should have (`kns.dev/expected-secrets`)
    pub expected_secrets: Vec<String>,
    pub components: Vec<Component>,
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LabelKeys {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cluster {
    pub name: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// a context whose name or cluster contains one of these is this cluster
    pub context_match: Vec<String>,
    pub protected: bool,
    pub labels: LabelKeys,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    /// the file, as the UI shows it
    pub source: String,
    pub teams: Vec<Team>,
    pub users: Vec<User>,
    pub systems: Vec<System>,
    pub clusters: Vec<Cluster>,
    /// what was skipped and why
    pub warnings: Vec<String>,
}

// ───────────────────────── parsing (pure) ─────────────────────────

fn text(v: Option<&Json>) -> String {
    v.and_then(Json::as_str).map(|s| clean_untrusted(s.trim(), MAX_TEXT)).unwrap_or_default()
}

/// `group:default/billett`, `group:billett`, `billett` -> `billett`.
pub fn ref_name(r: &str) -> String {
    let after_kind = r.split_once(':').map_or(r, |(_, n)| n);
    after_kind.rsplit('/').next().unwrap_or(after_kind).trim().to_string()
}

fn list(v: Option<&Json>) -> Vec<String> {
    match v {
        Some(Json::Array(a)) => a.iter().filter_map(Json::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        Some(Json::String(s)) => csv(s),
        _ => Vec::new(),
    }
}

fn csv(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
}

fn links(meta: &Json) -> Vec<Link> {
    let Some(Json::Array(items)) = meta.get("links") else { return Vec::new() };
    items
        .iter()
        .filter_map(|l| {
            let url = l.get("url")?.as_str()?.trim();
            // only web links: the UI opens them in the browser
            if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() > 2000 {
                return None;
            }
            let title = text(l.get("title"));
            Some(Link { url: url.to_string(), title: if title.is_empty() { url.to_string() } else { title } })
        })
        .collect()
}

fn annotation<'a>(meta: &'a Json, key: &str) -> Option<&'a str> {
    meta.get("annotations")?.get(key)?.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// A Kubernetes object name, as a namespace or workload has.
fn dns_label(s: &str) -> bool {
    !s.is_empty() && s.len() <= 253 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

/// Builds the catalog from the parsed documents. Unknown kinds are ignored; entities without a
/// name are skipped with a warning.
pub fn build(docs: &[Json], source: &str) -> Catalog {
    let mut c = Catalog { source: source.to_string(), ..Default::default() };
    let mut components: Vec<(Option<String>, Component)> = Vec::new();
    for (i, doc) in docs.iter().take(MAX_ENTITIES).enumerate() {
        let kind = doc.get("kind").and_then(Json::as_str).unwrap_or_default();
        let meta = doc.get("metadata").cloned().unwrap_or(Json::Null);
        let spec = doc.get("spec").cloned().unwrap_or(Json::Null);
        let name = text(meta.get("name"));
        if name.is_empty() {
            if !kind.is_empty() {
                c.warnings.push(format!("document {}: {kind} without metadata.name", i + 1));
            }
            continue;
        }
        let title = Some(text(meta.get("title"))).filter(|t| !t.is_empty()).unwrap_or_else(|| name.clone());
        match kind {
            "Group" => c.teams.push(Team {
                name,
                title: Some(text(spec.get("profile").and_then(|p| p.get("displayName")))).filter(|t| !t.is_empty()).unwrap_or(title),
                links: links(&meta),
                members: list(spec.get("members")).iter().map(|m| ref_name(m)).collect(),
            }),
            "User" => c.users.push(User {
                name,
                email: Some(text(spec.get("profile").and_then(|p| p.get("email")))).filter(|e| !e.is_empty()).map(|e| e.to_lowercase()),
                member_of: list(spec.get("memberOf")).iter().map(|m| ref_name(m)).collect(),
            }),
            "System" => {
                let namespace = annotation(&meta, "kns.dev/namespace").map(String::from);
                if let Some(ns) = namespace.as_deref()
                    && !dns_label(ns)
                {
                    c.warnings.push(format!("system {name}: \"{}\" is not a namespace name", clean_untrusted(ns, 80)));
                    continue;
                }
                c.systems.push(System {
                    name,
                    title,
                    description: text(meta.get("description")),
                    owner: spec.get("owner").and_then(Json::as_str).map(ref_name),
                    namespace,
                    environments: annotation(&meta, "kns.dev/environments").map(csv).unwrap_or_default(),
                    expected_secrets: annotation(&meta, "kns.dev/expected-secrets").map(csv).unwrap_or_default(),
                    components: Vec::new(),
                    links: links(&meta),
                });
            }
            "Component" => {
                let gitops = annotation(&meta, "kns.dev/gitops").map(|tool| Gitops {
                    tool: tool.to_string(),
                    path: annotation(&meta, "kns.dev/gitops-path").map(String::from),
                    image_file: annotation(&meta, "kns.dev/gitops-image-file").map(String::from),
                    app_prefix: annotation(&meta, "kns.dev/gitops-app-prefix").map(String::from),
                });
                let repo = annotation(&meta, "github.com/project-slug").filter(|s| s.split('/').count() == 2).map(String::from);
                components.push((
                    spec.get("system").and_then(Json::as_str).map(ref_name),
                    Component {
                        name,
                        description: text(meta.get("description")),
                        kind: text(spec.get("type")),
                        repo,
                        workloads: annotation(&meta, "kns.dev/workloads").map(csv).unwrap_or_default().into_iter().filter(|w| dns_label(w)).collect(),
                        gitops,
                        links: links(&meta),
                    },
                ));
            }
            "Resource" if spec.get("type").and_then(Json::as_str) == Some("kubernetes-cluster") => {
                let label = |k: &str| annotation(&meta, k).map(String::from);
                let mut context_match = annotation(&meta, "kns.dev/context-match").map(csv).unwrap_or_default();
                if context_match.is_empty() {
                    context_match.push(name.clone());
                }
                c.clusters.push(Cluster {
                    name,
                    title,
                    environment: label("kns.dev/environment"),
                    context_match,
                    protected: annotation(&meta, "kns.dev/protected") == Some("true"),
                    labels: LabelKeys {
                        team: label("kns.dev/team-label"),
                        system: label("kns.dev/system-label"),
                        service: label("kns.dev/service-label"),
                        version: label("kns.dev/version-label"),
                    },
                });
            }
            _ => {}
        }
    }
    if docs.len() > MAX_ENTITIES {
        c.warnings.push(format!("only the first {MAX_ENTITIES} documents were read"));
    }
    for (system, comp) in components {
        match system.and_then(|s| c.systems.iter_mut().find(|x| x.name == s)) {
            Some(s) => s.components.push(comp),
            None => c.warnings.push(format!("component {}: no system", comp.name)),
        }
    }
    // membership from either side: Group.spec.members and User.spec.memberOf
    for u in &c.users {
        for t in &u.member_of {
            if let Some(team) = c.teams.iter_mut().find(|x| &x.name == t)
                && !team.members.contains(&u.name)
            {
                team.members.push(u.name.clone());
            }
        }
    }
    let teams: Vec<(String, Vec<String>)> = c.teams.iter().map(|t| (t.name.clone(), t.members.clone())).collect();
    for u in &mut c.users {
        for (t, members) in &teams {
            if members.contains(&u.name) && !u.member_of.contains(t) {
                u.member_of.push(t.clone());
            }
        }
    }
    c
}

// ───────────────────────── links ─────────────────────────

/// The web links of the loaded catalog: the only URLs `catalog_open` opens, so the window cannot
/// open an address of its own choosing.
static LINKS: std::sync::RwLock<Option<std::collections::HashSet<String>>> = std::sync::RwLock::new(None);

/// Every URL a catalog lets the UI open: entity links and the GitHub page of each repository.
pub fn link_set(c: &Catalog) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let mut add = |ls: &[Link]| out.extend(ls.iter().map(|l| l.url.clone()));
    for t in &c.teams {
        add(&t.links);
    }
    for s in &c.systems {
        add(&s.links);
        for comp in &s.components {
            add(&comp.links);
        }
    }
    for s in &c.systems {
        for comp in &s.components {
            if let Some(repo) = &comp.repo {
                out.insert(format!("https://github.com/{repo}"));
            }
        }
    }
    out
}

/// The GitHub repositories (`owner/repo`, lowercase) of the loaded catalog: the only ones
/// `crate::github` reads, and whose pages `catalog_open` opens.
static REPOS: std::sync::RwLock<Option<std::collections::HashSet<String>>> = std::sync::RwLock::new(None);

/// Every repository of a catalog's components, lowercase (GitHub names are case-insensitive).
pub fn repo_set(c: &Catalog) -> std::collections::HashSet<String> {
    c.systems.iter().flat_map(|s| &s.components).filter_map(|comp| comp.repo.as_ref()).map(|r| r.to_lowercase()).collect()
}

fn remember_links(c: Option<&Catalog>) {
    if let Ok(mut l) = LINKS.write() {
        *l = c.map(link_set);
    }
    if let Ok(mut r) = REPOS.write() {
        *r = c.map(repo_set);
    }
}

/// Whether the loaded catalog has this repository (`owner/repo`).
pub fn knows_repo(repo: &str) -> bool {
    REPOS.read().ok().and_then(|r| r.as_ref().map(|s| s.contains(&repo.to_lowercase()))).unwrap_or(false)
}

/// A page under `https://github.com/<repo>/` of a repository `known` accepts: a compare, a commit,
/// a pull request. Only plain URL characters after the repository; no query tricks are needed.
pub fn github_page_of(url: &str, known: impl Fn(&str) -> bool) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else { return false };
    let mut parts = rest.splitn(3, '/');
    let (Some(owner), Some(name)) = (parts.next(), parts.next()) else { return false };
    let tail = parts.next().unwrap_or("");
    let safe = |s: &str| s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~/".contains(&b));
    // `a...b` (a compare) is fine; a `.` or `..` segment is not
    let no_dot_segment = !tail.split('/').any(|seg| seg == "." || seg == "..");
    url.len() <= 2000 && !owner.is_empty() && !name.is_empty() && safe(owner) && safe(name) && safe(tail) && no_dot_segment && known(&format!("{owner}/{name}"))
}

/// Whether the loaded catalog has this link, or it is a page of one of its repositories.
pub fn knows_link(url: &str) -> bool {
    LINKS.read().ok().and_then(|l| l.as_ref().map(|s| s.contains(url))).unwrap_or(false) || github_page_of(url, knows_repo)
}

// ───────────────────────── the file ─────────────────────────

fn source_file(config: &Path) -> PathBuf {
    config.join(SOURCE_FILE)
}

async fn stored_path(config: &Path) -> Option<PathBuf> {
    let text = tokio::fs::read_to_string(source_file(config)).await.ok()?;
    Some(PathBuf::from(text.trim())).filter(|p| !p.as_os_str().is_empty())
}

/// Reads and parses a catalog file.
pub async fn read(path: &Path) -> Result<Catalog> {
    let shown = path.display().to_string();
    let meta = tokio::fs::metadata(path).await.map_err(|e| BackendError::new(0, "Catalog", format!("{shown}: {e}")))?;
    if meta.len() > MAX_BYTES {
        return Err(BackendError::new(0, "Catalog", format!("{shown}: larger than {} MB", MAX_BYTES >> 20)));
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| BackendError::new(0, "Catalog", format!("{shown}: {e}")))?;
    let text = String::from_utf8(bytes).map_err(|_| BackendError::new(0, "Catalog", format!("{shown}: not UTF-8 text")))?;
    let docs = crate::objects::from_yaml_stream(text).await.map_err(|e| {
        // the parser's position, never the text around it
        let at = e.message.split_whitespace().skip_while(|w| *w != "line").take(2).collect::<Vec<_>>().join(" ");
        BackendError::new(0, "Catalog", format!("{shown}: not YAML{}", if at.is_empty() { String::new() } else { format!(" ({at})") }))
    })?;
    let catalog = build(&docs, &shown);
    if catalog.teams.is_empty() && catalog.systems.is_empty() && catalog.clusters.is_empty() {
        return Err(BackendError::new(0, "Catalog", format!("{shown}: no Group, System or kubernetes-cluster Resource entities")));
    }
    Ok(catalog)
}

/// The catalog of the stored path; `None` when none was chosen.
pub async fn load(config: &Path) -> Result<Option<Catalog>> {
    match stored_path(config).await {
        Some(p) => read(&p).await.map(Some),
        None => Ok(None),
    }
}

async fn remember(config: &Path, path: &Path) -> Result<()> {
    tokio::fs::create_dir_all(config).await?;
    tokio::fs::write(source_file(config), path.to_string_lossy().as_bytes()).await?;
    Ok(())
}

pub mod cmd {
    use std::path::PathBuf;

    use tauri::Manager;

    use super::Catalog;
    use crate::ipc::{BackendError, Result};

    fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
        app.path().app_config_dir().map_err(|e| BackendError::config(e.to_string()))
    }

    /// The chosen catalog, read again; `None` when none was chosen.
    #[tauri::command]
    pub async fn catalog_load(app: tauri::AppHandle) -> Result<Option<Catalog>> {
        let c = super::load(&config_dir(&app)?).await?;
        super::remember_links(c.as_ref());
        Ok(c)
    }

    /// Opens the file dialog; a file that reads as a catalog is remembered. `None` = cancelled.
    #[tauri::command]
    pub async fn catalog_choose(app: tauri::AppHandle) -> Result<Option<Catalog>> {
        use tauri_plugin_dialog::DialogExt;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut dialog = app.dialog().file().set_title("Organisation catalog").add_filter("Catalog", &["yaml", "yml", "json"]);
        if let Some(home) = dirs::home_dir() {
            dialog = dialog.set_directory(home);
        }
        dialog.pick_file(move |path| {
            let _ = tx.send(path.and_then(|p| p.into_path().ok()));
        });
        let Some(path) = rx.await.map_err(|_| BackendError::internal("the file dialog went away"))? else { return Ok(None) };
        let catalog = super::read(&path).await?;
        super::remember(&config_dir(&app)?, &path).await?;
        super::remember_links(Some(&catalog));
        Ok(Some(catalog))
    }

    /// Forgets the catalog file (the file itself is left alone).
    #[tauri::command]
    pub async fn catalog_forget(app: tauri::AppHandle) -> Result<()> {
        super::remember_links(None);
        match tokio::fs::remove_file(super::source_file(&config_dir(&app)?)).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    /// Opens a link of the loaded catalog, or a page of one of its GitHub repositories, in the
    /// browser; any other URL is refused.
    #[tauri::command]
    pub async fn catalog_open(app: tauri::AppHandle, url: String) -> Result<()> {
        if !super::knows_link(&url) {
            return Err(BackendError::invalid("not a link of the catalog"));
        }
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url, None::<&str>).map_err(|e| BackendError::internal(format!("could not open the browser: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn docs() -> Vec<Json> {
        vec![
            json!({"kind": "Group", "metadata": {"name": "billett", "title": "Billett", "links": [{"url": "https://slack.example/x", "title": "#billett"}, {"url": "javascript:alert(1)"}]}, "spec": {"type": "team", "members": ["user:default/ada"]}}),
            json!({"kind": "User", "metadata": {"name": "bob"}, "spec": {"profile": {"email": "Bob@Example.com"}, "memberOf": ["group:billett"]}}),
            json!({"kind": "User", "metadata": {"name": "ada"}, "spec": {"profile": {"email": "ada@example.com"}}}),
            json!({"kind": "System", "metadata": {"name": "shop", "title": "Shop", "annotations": {"kns.dev/namespace": "shop", "kns.dev/environments": "test, prod"}}, "spec": {"owner": "group:billett"}}),
            json!({"kind": "System", "metadata": {"name": "bad", "annotations": {"kns.dev/namespace": "Not A Namespace"}}, "spec": {}}),
            json!({"kind": "Component", "metadata": {"name": "shop-api", "annotations": {"github.com/project-slug": "org/shop-api", "kns.dev/workloads": "shop-api,BAD NAME"}}, "spec": {"type": "service", "system": "shop"}}),
            json!({"kind": "Component", "metadata": {"name": "shop-ops", "annotations": {"kns.dev/gitops": "argocd", "kns.dev/gitops-image-file": "{app}/eks-{env}/image.yaml"}}, "spec": {"type": "gitops", "system": "system:shop"}}),
            json!({"kind": "Component", "metadata": {"name": "orphan"}, "spec": {"system": "nope"}}),
            json!({"kind": "Resource", "metadata": {"name": "eks-prod", "annotations": {"kns.dev/environment": "prod", "kns.dev/protected": "true", "kns.dev/team-label": "tags.datadoghq.com/team"}}, "spec": {"type": "kubernetes-cluster"}}),
            json!({"kind": "Resource", "metadata": {"name": "a-bucket"}, "spec": {"type": "s3-bucket"}}),
            json!({"kind": "API", "metadata": {"name": "ignored"}}),
        ]
    }

    #[test]
    fn builds_teams_systems_and_clusters() {
        let c = build(&docs(), "catalog.yaml");
        assert_eq!(c.teams.len(), 1);
        let team = &c.teams[0];
        assert_eq!(team.links, vec![Link { url: "https://slack.example/x".into(), title: "#billett".into() }]);
        // members from both sides
        assert_eq!(team.members, vec!["ada".to_string(), "bob".to_string()]);
        let ada = c.users.iter().find(|u| u.name == "ada").unwrap();
        assert_eq!(ada.member_of, vec!["billett".to_string()]);
        assert_eq!(c.users.iter().find(|u| u.name == "bob").unwrap().email.as_deref(), Some("bob@example.com"));

        assert_eq!(c.systems.len(), 1, "the system with a bad namespace is skipped");
        let shop = &c.systems[0];
        assert_eq!(shop.owner.as_deref(), Some("billett"));
        assert_eq!(shop.namespace.as_deref(), Some("shop"));
        assert_eq!(shop.environments, vec!["test".to_string(), "prod".to_string()]);
        assert_eq!(shop.components.len(), 2);
        assert_eq!(shop.components[0].repo.as_deref(), Some("org/shop-api"));
        assert_eq!(shop.components[0].workloads, vec!["shop-api".to_string()]);
        assert_eq!(shop.components[1].gitops.as_ref().unwrap().image_file.as_deref(), Some("{app}/eks-{env}/image.yaml"));

        assert_eq!(c.clusters.len(), 1);
        let prod = &c.clusters[0];
        assert!(prod.protected);
        assert_eq!(prod.context_match, vec!["eks-prod".to_string()]);
        assert_eq!(prod.labels.team.as_deref(), Some("tags.datadoghq.com/team"));
        assert!(c.warnings.iter().any(|w| w.contains("bad")));
        assert!(c.warnings.iter().any(|w| w.contains("orphan")));
        let links = link_set(&c);
        assert!(links.contains("https://github.com/org/shop-api"));
        assert!(links.contains("https://slack.example/x"));
        assert!(!links.iter().any(|l| l.starts_with("javascript")));
    }

    #[test]
    fn drift() {
        let mut f = crate::contract::drift::Fixtures::new("catalog");
        let mut c = build(&docs(), "catalog.yaml");
        c.systems[0].links.push(Link { url: "https://example.com/shop".into(), title: "Runbook".into() });
        f.add("catalogs", "Catalog[]", &vec![c, Catalog { source: "empty.yaml".into(), ..Default::default() }]);
        f.check();
    }

    #[test]
    fn github_pages_of_catalog_repositories_only() {
        let c = build(&docs(), "catalog.yaml");
        let repos = repo_set(&c);
        assert_eq!(repos, ["org/shop-api".to_string()].into_iter().collect());
        let known = |r: &str| repos.contains(&r.to_lowercase());
        assert!(github_page_of("https://github.com/org/shop-api/compare/v1.0.0...v1.1.0", known));
        assert!(github_page_of("https://github.com/Org/Shop-Api/pull/12", known));
        assert!(github_page_of("https://github.com/org/shop-api", known));
        assert!(!github_page_of("https://github.com/org/other/compare/a...b", known));
        assert!(!github_page_of("https://github.com.evil.example/org/shop-api", known));
        assert!(!github_page_of("http://github.com/org/shop-api", known));
        assert!(!github_page_of("https://github.com/org/shop-api/x?y=1", known));
        assert!(!github_page_of("https://github.com/org/shop-api/../../evil/repo", known));
        assert!(!github_page_of("https://github.com/org/shop-api/a b", known));
        assert!(!github_page_of("https://github.com/org/shop-api/%2e%2e/x", known));
    }

    #[test]
    fn refs() {
        assert_eq!(ref_name("group:default/billett"), "billett");
        assert_eq!(ref_name("group:billett"), "billett");
        assert_eq!(ref_name("billett"), "billett");
    }

    #[tokio::test]
    async fn reads_a_file_and_hides_its_text_on_errors() {
        let dir = std::env::temp_dir().join(format!("kns-catalog-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let good = dir.join("c.yaml");
        tokio::fs::write(&good, "kind: Group\nmetadata: {name: t}\n---\nkind: Resource\nmetadata: {name: eks-test}\nspec: {type: kubernetes-cluster}\n").await.unwrap();
        let c = read(&good).await.unwrap();
        assert_eq!((c.teams.len(), c.clusters.len()), (1, 1));

        // an organisation has more entities than the YAML parser's default 1024 documents
        let big = dir.join("big.yaml");
        let stream = (0..3000).map(|i| format!("kind: User\nmetadata: {{name: u{i}}}\nspec: {{profile: {{email: u{i}@example.com}}, memberOf: [t]}}\n")).collect::<Vec<_>>().join("---\n");
        tokio::fs::write(&big, format!("kind: Group\nmetadata: {{name: t}}\n---\n{stream}")).await.unwrap();
        assert_eq!(read(&big).await.unwrap().users.len(), 3000);

        let bad = dir.join("secret.yaml");
        tokio::fs::write(&bad, "password: hunter2\n  : [unbalanced\n").await.unwrap();
        let e = read(&bad).await.unwrap_err();
        assert!(!e.message.contains("hunter2"), "{}", e.message);

        let empty = dir.join("e.yaml");
        tokio::fs::write(&empty, "a: 1\n").await.unwrap();
        assert!(read(&empty).await.unwrap_err().message.contains("no Group"));

        assert!(link_set(&c).is_empty());
        remember(&dir, &good).await.unwrap();
        assert!(load(&dir).await.unwrap().is_some());
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
