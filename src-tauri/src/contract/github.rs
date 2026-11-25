//! GitHub, read only: mirror of `src/ipc/contract/github.ts`. Produced by `crate::github`, which
//! asks the GitHub CLI (`gh api`); kns never holds a token.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    /// `gh` was found
    pub installed: bool,
    /// `gh` has a usable login for github.com
    pub logged_in: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// why not, when it is not usable
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The image one environment of one app runs, read from an ops (GitOps) repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvImage {
    pub app: String,
    pub env: String,
    /// the file in the repository
    pub path: String,
    /// `image.name`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `image.tag`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// why the file gave no tag
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvImages {
    pub repo: String,
    /// the commit the files were read at
    pub sha: String,
    /// by app, then environment
    pub images: Vec<EnvImage>,
    /// GitHub cut the file list short, or there were more files than kns reads
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCommit {
    pub sha: String,
    /// the first line of the message
    pub title: String,
    /// GitHub login, else the git author name
    pub author: String,
    /// RFC 3339
    pub date: String,
    /// the pull request it came from: `(#123)` or `Merge pull request #123` in the message
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCompare {
    pub repo: String,
    /// the refs that resolved (`x` or `vx`)
    pub base: String,
    pub head: String,
    /// ahead, behind, identical or diverged
    pub status: String,
    pub ahead_by: u32,
    pub behind_by: u32,
    pub total_commits: u32,
    /// newest first; GitHub returns at most 250
    pub commits: Vec<GithubCommit>,
    /// the compare page on github.com
    pub url: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::drift::Fixtures;

    #[test]
    fn drift() {
        let mut f = Fixtures::new("github");
        f.add(
            "statuses",
            "GithubStatus[]",
            &vec![
                GithubStatus { installed: true, logged_in: true, login: Some("ada".into()), message: None },
                GithubStatus { installed: true, logged_in: false, login: None, message: Some("gh is not logged in: run `gh auth login`".into()) },
                GithubStatus { installed: false, logged_in: false, login: None, message: Some("gh (the GitHub CLI) is not installed".into()) },
            ],
        );
        f.add(
            "envImages",
            "EnvImages",
            &EnvImages {
                repo: "example/shop-ops".into(),
                sha: "0123456789abcdef0123456789abcdef01234567".into(),
                images: vec![
                    EnvImage { app: "orders".into(), env: "prod".into(), path: "orders/eks-prod/image.yaml".into(), name: Some("example/shop-orders".into()), tag: Some("1.4.0".into()), error: None },
                    EnvImage { app: "orders".into(), env: "test".into(), path: "orders/eks-test/image.yaml".into(), name: Some("example/shop-orders".into()), tag: Some("1.5.0".into()), error: None },
                    EnvImage { app: "web".into(), env: "test".into(), path: "web/eks-test/image.yaml".into(), name: None, tag: None, error: Some("no image.tag".into()) },
                ],
                truncated: false,
            },
        );
        f.add(
            "compare",
            "GithubCompare",
            &GithubCompare {
                repo: "example/shop-orders".into(),
                base: "v1.4.0".into(),
                head: "v1.5.0".into(),
                status: "ahead".into(),
                ahead_by: 2,
                behind_by: 0,
                total_commits: 2,
                commits: vec![
                    GithubCommit { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(), title: "Retry payment callbacks (#42)".into(), author: "ada".into(), date: "2026-11-20T10:00:00Z".into(), pr: Some(42) },
                    GithubCommit { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(), title: "Bump deps".into(), author: "Bob".into(), date: "2026-11-19T09:00:00Z".into(), pr: None },
                ],
                url: "https://github.com/example/shop-orders/compare/v1.4.0...v1.5.0".into(),
            },
        );
        f.check();
    }
}
