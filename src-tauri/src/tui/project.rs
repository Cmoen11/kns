//! A repo's own cluster target: `.kns.toml` in the working directory or a parent (up to the
//! git root or the home directory). Lets a herdr workspace open straight on "its" service:
//!
//! ```toml
//! context = "staging"
//! namespace = "billett"
//! resource = "deploy"          # what to show first (alias, plural or kind)
//! selector = "app=billett-api" # label selector for that first table
//! ```
//!
//! Only `key = "value"` lines are read (no TOML dependency); `#` starts a comment.
use std::path::{Path, PathBuf};

pub const FILE: &str = ".kns.toml";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Project {
    pub file: Option<PathBuf>,
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub resource: Option<String>,
    pub selector: Option<String>,
}

pub fn find(start: &Path) -> Project {
    let home = dirs::home_dir();
    let mut dir = Some(start);
    while let Some(d) = dir {
        let f = d.join(FILE);
        if let Ok(text) = std::fs::read_to_string(&f) {
            let mut p = parse(&text);
            p.file = Some(f);
            return p;
        }
        if d.join(".git").exists() || home.as_deref() == Some(d) {
            break;
        }
        dir = d.parent();
    }
    Project::default()
}

pub fn parse(text: &str) -> Project {
    let mut p = Project::default();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            "context" => p.context = Some(v),
            "namespace" => p.namespace = Some(v),
            "resource" => p.resource = Some(v),
            "selector" => p.selector = Some(v),
            _ => {}
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_lines() {
        let p = parse("# x\ncontext = \"staging\"\nnamespace='billett' # inline\nresource = deploy\nother = 1\nselector = \"app=a,tier=b\"\n");
        assert_eq!(p.context.as_deref(), Some("staging"));
        assert_eq!(p.namespace.as_deref(), Some("billett"));
        assert_eq!(p.resource.as_deref(), Some("deploy"));
        assert_eq!(p.selector.as_deref(), Some("app=a,tier=b"));
    }
}
