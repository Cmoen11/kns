//! GitHub, read only (docs/catalog.md): which image tag each environment of an app runs, read
//! from an ops (GitOps) repository, and the commits between two tags of an app repository.
//!
//! kns holds no token: every request goes through the GitHub CLI (`gh api --hostname github.com`),
//! which signs in with the login the user made with `gh auth login`. The window names a repository
//! and refs, never a URL or a command line: repositories must be in the loaded catalog
//! (`catalog::knows_repo`), and every name and ref is checked before it reaches an argument.
//! Nothing here writes.
use std::{process::Stdio, time::Duration};

use futures::{StreamExt, stream};
use regex::Regex;
use tokio::{process::Command, time::timeout};

use crate::{
    contract::{EnvImage, EnvImages, GithubCommit, GithubCompare, GithubStatus},
    ipc::{BackendError, Json, Result},
    redact::clean_untrusted,
};

/// One `gh api` call; a slow network, not a person.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Image files read per repository.
const MAX_FILES: usize = 400;
/// Image files read at once.
const PARALLEL: usize = 8;
/// Longest text kept from GitHub (titles, names, tags).
const MAX_TEXT: usize = 300;
const NOT_INSTALLED: &str = "NotInstalled";

// ───────────────────────── checks (pure) ─────────────────────────

/// `owner/name` as GitHub allows it, and never an option or a path trick.
pub fn valid_repo(s: &str) -> bool {
    let Some((owner, name)) = s.split_once('/') else { return false };
    let owner_ok = !owner.is_empty() && owner.len() <= 39 && !owner.starts_with('-') && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let name_ok = !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && !name.starts_with('-')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b));
    owner_ok && name_ok
}

/// A tag, branch or commit as it goes into an API path: no option, no `..`, no URL characters.
pub fn valid_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && !s.starts_with(['-', '/', '.'])
        && !s.ends_with(['/', '.'])
        && !s.contains("..")
        && !s.contains("//")
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b))
}

/// An image-file template (`{app}/eks-{env}/image.yaml`): one `{app}`, one `{env}`, a relative path.
pub fn valid_template(t: &str) -> bool {
    let literal = t.replace("{app}", "").replace("{env}", "");
    t.matches("{app}").count() == 1
        && t.matches("{env}").count() == 1
        && t.len() <= 200
        && !t.starts_with('/')
        && !t.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..")
        && literal.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b))
}

/// The template as a regex over repository paths: `{app}` and `{env}` are one path segment each.
pub fn template_regex(t: &str) -> Regex {
    let mut re = String::from("^");
    let mut rest = t;
    while let Some(i) = rest.find('{') {
        re.push_str(&regex::escape(&rest[..i]));
        let tail = &rest[i..];
        if let Some(after) = tail.strip_prefix("{app}") {
            re.push_str("(?P<app>[A-Za-z0-9._-]+)");
            rest = after;
        } else if let Some(after) = tail.strip_prefix("{env}") {
            re.push_str("(?P<env>[A-Za-z0-9._-]+)");
            rest = after;
        } else {
            re.push_str(&regex::escape("{"));
            rest = &tail[1..];
        }
    }
    re.push_str(&regex::escape(rest));
    re.push('$');
    Regex::new(&re).expect("escaped template")
}

/// `(app, env)` of a path that matches the template.
pub fn match_path(re: &Regex, path: &str) -> Option<(String, String)> {
    let c = re.captures(path)?;
    let (app, env) = (c.name("app")?.as_str(), c.name("env")?.as_str());
    (app != "." && app != ".." && env != "." && env != "..").then(|| (app.to_string(), env.to_string()))
}

// ───────────────────────── parsing (pure) ─────────────────────────

fn scalar(v: Option<&Json>) -> Option<String> {
    let s = match v? {
        Json::String(s) => s.trim().to_string(),
        Json::Number(n) => n.to_string(),
        Json::Bool(b) => b.to_string(),
        _ => return None,
    };
    Some(clean_untrusted(&s, MAX_TEXT)).filter(|s| !s.is_empty())
}

/// `image.name` and `image.tag` of an image file's documents, or why there is no tag.
pub fn image_of(docs: &[Json]) -> (Option<String>, Option<String>, Option<String>) {
    let image = docs.iter().find_map(|d| d.get("image"));
    let name = scalar(image.and_then(|i| i.get("name")));
    let tag = scalar(image.and_then(|i| i.get("tag")));
    let error = tag.is_none().then(|| if image.is_none() { "no image" } else { "no image.tag" }.to_string());
    (name, tag, error)
}

/// The pull request a commit came from: `Title (#123)` (squash) or `Merge pull request #123 from ...`.
pub fn pr_number(message: &str) -> Option<u32> {
    static SQUASH: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"\(#(\d{1,9})\)").expect("regex"));
    static MERGE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"^Merge pull request #(\d{1,9})\b").expect("regex"));
    let title = message.lines().next().unwrap_or_default();
    SQUASH.captures_iter(title).last().or_else(|| MERGE.captures(title)).and_then(|c| c[1].parse().ok())
}

fn num(v: &Json, key: &str) -> u32 {
    v.get(key).and_then(Json::as_u64).map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
}

/// The compare page of two refs (already checked: plain URL characters).
pub fn compare_url(repo: &str, base: &str, head: &str) -> String {
    format!("https://github.com/{repo}/compare/{base}...{head}")
}

/// A `GET /repos/{repo}/compare/{base}...{head}` answer; commits newest first.
pub fn parse_compare(repo: &str, base: &str, head: &str, v: &Json) -> GithubCompare {
    let mut commits: Vec<GithubCommit> = v
        .get("commits")
        .and_then(Json::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    let sha = c.get("sha")?.as_str()?;
                    if sha.len() > 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return None;
                    }
                    let commit = c.get("commit");
                    let message = commit.and_then(|m| m.get("message")).and_then(Json::as_str).unwrap_or_default();
                    let git_author = commit.and_then(|m| m.get("author"));
                    let author = scalar(c.get("author").and_then(|a| a.get("login"))).or_else(|| scalar(git_author.and_then(|a| a.get("name")))).unwrap_or_default();
                    let date = scalar(git_author.and_then(|a| a.get("date"))).or_else(|| scalar(commit.and_then(|m| m.get("committer")).and_then(|a| a.get("date")))).unwrap_or_default();
                    Some(GithubCommit {
                        sha: sha.to_string(),
                        title: clean_untrusted(message.lines().next().unwrap_or_default().trim(), MAX_TEXT),
                        author,
                        date,
                        pr: pr_number(message),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    commits.reverse();
    GithubCompare {
        repo: repo.to_string(),
        base: base.to_string(),
        head: head.to_string(),
        status: scalar(v.get("status")).unwrap_or_default(),
        ahead_by: num(v, "ahead_by"),
        behind_by: num(v, "behind_by"),
        total_commits: num(v, "total_commits"),
        commits,
        url: compare_url(repo, base, head),
    }
}

/// The other spelling of a version ref: `1.2.0` -> `v1.2.0`, `v1.2.0` -> `1.2.0`.
fn other_spelling(r: &str) -> Option<String> {
    match r.strip_prefix('v') {
        Some(bare) if bare.starts_with(|c: char| c.is_ascii_digit()) => Some(bare.to_string()),
        Some(_) => None,
        None => Some(format!("v{r}")),
    }
}

/// The pairs of refs to try, as given first: `x...y`, `vx...vy`, then the mixed ones.
pub fn ref_candidates(base: &str, head: &str) -> Vec<(String, String)> {
    let b2 = other_spelling(base);
    let h2 = other_spelling(head);
    let mut out = vec![(base.to_string(), head.to_string())];
    if let (Some(b), Some(h)) = (&b2, &h2) {
        out.push((b.clone(), h.clone()));
    }
    if let Some(h) = &h2 {
        out.push((base.to_string(), h.clone()));
    }
    if let Some(b) = &b2 {
        out.push((b.clone(), head.to_string()));
    }
    out.dedup();
    out
}

/// A failed `gh` run as an error the UI can show: the HTTP status when gh printed one, never
/// more than the last line of what it said.
pub fn gh_error(what: &str, stderr: &str) -> BackendError {
    let last = clean_untrusted(stderr.trim().lines().last().unwrap_or("no output").trim(), MAX_TEXT);
    if stderr.contains("gh auth login") || stderr.contains("HTTP 401") {
        BackendError::new(401, "Unauthorized", "gh is not logged in to github.com: run `gh auth login`")
    } else if stderr.contains("HTTP 404") {
        BackendError::new(404, "NotFound", format!("{what}: not found (or the gh login may not read it)"))
    } else if stderr.contains("HTTP 403") || stderr.contains("HTTP 429") {
        BackendError::new(403, "Forbidden", format!("{what}: {last}"))
    } else {
        BackendError::config(format!("{what}: {last}"))
    }
}

// ───────────────────────── gh ─────────────────────────

/// Runs `gh api --hostname github.com <args>` and returns what it printed.
async fn gh_api(what: &str, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new("gh");
    cmd.arg("api").args(["--hostname", "github.com"]).args(args);
    cmd.env("PATH", crate::awslogin::tool_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => BackendError::new(0, NOT_INSTALLED, "gh (the GitHub CLI) is not installed: https://cli.github.com"),
        _ => BackendError::config(format!("could not run gh: {e}")),
    })?;
    let out = timeout(CALL_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| BackendError::config(format!("{what}: gh did not answer within {} s", CALL_TIMEOUT.as_secs())))??;
    if !out.status.success() {
        return Err(gh_error(what, &String::from_utf8_lossy(&out.stderr)));
    }
    String::from_utf8(out.stdout).map_err(|_| BackendError::internal(format!("{what}: gh printed something that is not UTF-8")))
}

async fn gh_json(what: &str, args: &[&str]) -> Result<Json> {
    let text = gh_api(what, args).await?;
    serde_json::from_str(&text).map_err(|_| BackendError::internal(format!("{what}: GitHub's answer is not JSON")))
}

/// Whether gh is there and logged in, and as whom.
pub async fn status() -> GithubStatus {
    match gh_api("github.com", &["user", "--jq", ".login"]).await {
        Ok(out) => {
            let login = clean_untrusted(out.trim(), 100);
            GithubStatus { installed: true, logged_in: true, login: Some(login).filter(|l| !l.is_empty()), message: None }
        }
        Err(e) if e.reason == NOT_INSTALLED => GithubStatus { installed: false, logged_in: false, login: None, message: Some(e.message) },
        Err(e) => GithubStatus { installed: true, logged_in: false, login: None, message: Some(e.message) },
    }
}

fn check_repo(repo: &str) -> Result<()> {
    if !valid_repo(repo) {
        return Err(BackendError::invalid("not a GitHub repository name (owner/name)"));
    }
    if !crate::catalog::knows_repo(repo) {
        return Err(BackendError::invalid(format!("{repo} is not a repository of the catalog")));
    }
    Ok(())
}

/// The image every app runs in every environment, from the files of an ops repository that match
/// `template` at the head of its default branch.
pub async fn env_images(repo: &str, template: &str) -> Result<EnvImages> {
    check_repo(repo)?;
    if !valid_template(template) {
        return Err(BackendError::invalid("the image file template needs one {app} and one {env} in a relative path"));
    }
    let tree = gh_json(repo, &[&format!("repos/{repo}/git/trees/HEAD?recursive=1")]).await?;
    let sha = tree.get("sha").and_then(Json::as_str).filter(|s| s.len() <= 64 && s.bytes().all(|b| b.is_ascii_hexdigit())).unwrap_or("HEAD").to_string();
    let re = template_regex(template);
    let mut files: Vec<(String, String, String)> = tree
        .get("tree")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter(|e| e.get("type").and_then(Json::as_str) == Some("blob"))
        .filter_map(|e| {
            let path = e.get("path")?.as_str()?;
            let (app, env) = match_path(&re, path)?;
            Some((app, env, path.to_string()))
        })
        .collect();
    files.sort();
    let mut truncated = tree.get("truncated").and_then(Json::as_bool).unwrap_or(false);
    if files.len() > MAX_FILES {
        files.truncate(MAX_FILES);
        truncated = true;
    }
    let images = stream::iter(files)
        .map(|(app, env, path)| {
            let sha = sha.clone();
            async move {
                // the path matched the template: plain path characters, nothing to encode
                let endpoint = format!("repos/{repo}/contents/{path}?ref={sha}");
                let read = gh_api(&path, &["-H", "Accept: application/vnd.github.raw+json", &endpoint]).await;
                let (name, tag, error) = match read {
                    Ok(text) => match crate::objects::from_yaml(text).await {
                        Ok(docs) => image_of(&docs),
                        Err(_) => (None, None, Some("not YAML".to_string())),
                    },
                    Err(e) => (None, None, Some(e.message)),
                };
                EnvImage { app, env, path, name, tag, error }
            }
        })
        .buffered(PARALLEL)
        .collect::<Vec<_>>()
        .await;
    Ok(EnvImages { repo: repo.to_string(), sha, images, truncated })
}

/// The commits between two refs of a repository; each ref is tried as given and with (or
/// without) a leading `v`.
pub async fn compare(repo: &str, base: &str, head: &str) -> Result<GithubCompare> {
    check_repo(repo)?;
    if !valid_ref(base) || !valid_ref(head) {
        return Err(BackendError::invalid("not a tag, branch or commit name"));
    }
    for (b, h) in ref_candidates(base, head) {
        match gh_json(repo, &[&format!("repos/{repo}/compare/{b}...{h}")]).await {
            Ok(v) => return Ok(parse_compare(repo, &b, &h, &v)),
            // an unknown ref: try the next spelling
            Err(e) if e.code == 404 || e.code == 422 => continue,
            Err(e) => return Err(e),
        }
    }
    Err(BackendError::new(404, "NotFound", format!("{repo}: no tag, branch or commit {base} or {head} (tried with and without a leading v)")))
}

pub mod cmd {
    use crate::{
        contract::{EnvImages, GithubCompare, GithubStatus},
        ipc::Result,
    };

    /// Whether the GitHub CLI is installed and logged in, and as whom.
    #[tauri::command]
    pub async fn github_status() -> Result<GithubStatus> {
        Ok(super::status().await)
    }

    /// The image tag of every app in every environment of an ops repository of the catalog.
    #[tauri::command]
    pub async fn github_env_images(repo: String, image_file: String) -> Result<EnvImages> {
        super::env_images(&repo, &image_file).await
    }

    /// The commits between two refs of a repository of the catalog.
    #[tauri::command]
    pub async fn github_compare(repo: String, base: String, head: String) -> Result<GithubCompare> {
        super::compare(&repo, &base, &head).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_names_refs_and_templates() {
        assert!(valid_repo("example/shop-ops"));
        assert!(valid_repo("Org-1/repo.name_x"));
        for bad in ["", "example", "a/b/c", "-x/y", "x/..", "x/-y", "x/y z", "x/y?z", "ex ample/y"] {
            assert!(!valid_repo(bad), "{bad}");
        }
        assert!(valid_ref("1.4.0"));
        assert!(valid_ref("v1.4.0"));
        assert!(valid_ref("release/2026-11"));
        assert!(valid_ref("0123abc"));
        for bad in ["", "-x", "/x", "x/", "a..b", "a//b", "a b", "a?b", "a#b", "a%2e", ".x", "x."] {
            assert!(!valid_ref(bad), "{bad}");
        }
        assert!(valid_template("{app}/eks-{env}/image.yaml"));
        assert!(valid_template("apps/{env}/{app}.yaml"));
        for bad in ["{app}/image.yaml", "{app}/{env}/{env}.yaml", "/{app}/{env}.yaml", "../{app}/{env}", "{app}//{env}", "{app}/{env}/a b.yaml"] {
            assert!(!valid_template(bad), "{bad}");
        }
    }

    #[test]
    fn matches_paths_against_the_template() {
        let re = template_regex("{app}/eks-{env}/image.yaml");
        assert_eq!(match_path(&re, "orders/eks-prod/image.yaml"), Some(("orders".into(), "prod".into())));
        assert_eq!(match_path(&re, "orders/eks-test/image.yaml"), Some(("orders".into(), "test".into())));
        assert_eq!(match_path(&re, "orders/eks-prod/values.yaml"), None);
        assert_eq!(match_path(&re, "x/orders/eks-prod/image.yaml"), None);
        assert_eq!(match_path(&re, "orders/prod/image.yaml"), None);
        // the dot in image.yaml is literal
        assert_eq!(match_path(&re, "orders/eks-prod/imageXyaml"), None);
    }

    #[test]
    fn reads_image_name_and_tag() {
        let (name, tag, err) = image_of(&[json!({"image": {"name": "example/shop-orders", "tag": "1.5.0"}})]);
        assert_eq!((name.as_deref(), tag.as_deref(), err), (Some("example/shop-orders"), Some("1.5.0"), None));
        // a tag YAML reads as a number
        assert_eq!(image_of(&[json!({"image": {"tag": 42}})]).1.as_deref(), Some("42"));
        assert_eq!(image_of(&[json!({"image": {"name": "x"}})]).2.as_deref(), Some("no image.tag"));
        assert_eq!(image_of(&[json!({"other": 1})]).2.as_deref(), Some("no image"));
    }

    #[test]
    fn finds_pull_request_numbers() {
        assert_eq!(pr_number("Retry payment callbacks (#42)\n\nbody (#7)"), Some(42));
        assert_eq!(pr_number("Revert \"x (#3)\" (#9)"), Some(9));
        assert_eq!(pr_number("Merge pull request #123 from org/branch"), Some(123));
        assert_eq!(pr_number("Bump deps"), None);
        assert_eq!(pr_number("Fix #12 in parser"), None);
    }

    #[test]
    fn tries_both_spellings_of_a_version() {
        assert_eq!(
            ref_candidates("1.4.0", "1.5.0"),
            vec![("1.4.0".into(), "1.5.0".into()), ("v1.4.0".into(), "v1.5.0".into()), ("1.4.0".into(), "v1.5.0".into()), ("v1.4.0".into(), "1.5.0".into())]
        );
        assert_eq!(ref_candidates("v1.4.0", "v1.5.0")[1], ("1.4.0".into(), "1.5.0".into()));
        // a branch name that starts with v is not a version
        assert_eq!(ref_candidates("very", "main"), vec![("very".into(), "main".into()), ("very".into(), "vmain".into())]);
    }

    #[test]
    fn parses_a_compare() {
        let v = json!({
            "status": "ahead", "ahead_by": 2, "behind_by": 0, "total_commits": 2,
            "html_url": "https://evil.example/",
            "commits": [
                {"sha": "aaaaaaaa", "author": null, "commit": {"message": "Bump deps", "author": {"name": "Bob", "date": "2026-11-19T09:00:00Z"}}},
                {"sha": "bbbbbbbb", "author": {"login": "ada"}, "commit": {"message": "Retry callbacks (#42)\n\nlong text", "author": {"name": "Ada L", "date": "2026-11-20T10:00:00Z"}}},
                {"sha": "not-a-sha", "commit": {"message": "dropped"}}
            ]
        });
        let c = parse_compare("example/shop-orders", "v1.4.0", "v1.5.0", &v);
        assert_eq!(c.url, "https://github.com/example/shop-orders/compare/v1.4.0...v1.5.0");
        assert_eq!((c.status.as_str(), c.ahead_by, c.total_commits), ("ahead", 2, 2));
        assert_eq!(c.commits.len(), 2);
        assert_eq!(c.commits[0].sha, "bbbbbbbb", "newest first");
        assert_eq!((c.commits[0].title.as_str(), c.commits[0].author.as_str(), c.commits[0].pr), ("Retry callbacks (#42)", "ada", Some(42)));
        assert_eq!(c.commits[1].author, "Bob");
        assert!(crate::catalog::github_page_of(&c.url, |r| r == "example/shop-orders"));
    }

    #[test]
    fn maps_gh_errors_without_their_text() {
        assert_eq!(gh_error("x/y", "To get started with GitHub CLI, please run:  gh auth login").code, 401);
        assert_eq!(gh_error("x/y", "gh: Not Found (HTTP 404)").code, 404);
        assert_eq!(gh_error("x/y", "gh: API rate limit exceeded (HTTP 403)").code, 403);
        let e = gh_error("x/y", "line one\nsecret context\nlast line");
        assert_eq!(e.message, "x/y: last line");
    }

    #[tokio::test]
    async fn refuses_repositories_outside_the_catalog() {
        let e = env_images("someone/else", "{app}/{env}/image.yaml").await.unwrap_err();
        assert_eq!(e.reason, "Invalid");
        let e = compare("not a repo", "a", "b").await.unwrap_err();
        assert_eq!(e.reason, "Invalid");
    }
}
