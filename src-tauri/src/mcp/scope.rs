//! The scope filter (docs/plan-features.md §5.4): one place that decides, per `(context,
//! namespace)`, what an agent may see. Applied to every tool argument and every tool result.
//!
//! - Policy `off` is handled by `policy::check` before a tool runs.
//! - With a namespace allowlist: a namespace outside it is denied (as an argument) or dropped
//!   (from a result, counted in `filtered`); cluster-scoped kinds are denied, because an
//!   allowlist means "only these namespaces".
//! - Without an allowlist every namespace is visible.
use super::McpError;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scope {
    /// `None` = no allowlist
    pub namespaces: Option<Vec<String>>,
}

impl Scope {
    pub fn new(namespaces: Option<Vec<String>>) -> Self {
        Self { namespaces: namespaces.filter(|n| !n.is_empty()) }
    }

    pub fn restricted(&self) -> bool {
        self.namespaces.is_some()
    }

    /// May the agent see objects in `namespace` (`None` = cluster-scoped)?
    pub fn allows(&self, namespace: Option<&str>) -> bool {
        match (&self.namespaces, namespace.filter(|n| !n.is_empty())) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(list), Some(ns)) => list.iter().any(|n| n == ns),
        }
    }

    /// Checks a tool argument. `namespaced = false` for cluster-scoped kinds.
    pub fn check(&self, context: &str, namespace: Option<&str>, namespaced: bool) -> Result<(), McpError> {
        if !namespaced {
            if self.restricted() {
                return Err(McpError::new("PolicyDenied", "cluster-scoped objects are hidden: this context has a namespace allowlist")
                    .hint(format!("ask the human to widen it with \":mcp policy … {context}\" in kns")));
            }
            return Ok(());
        }
        if self.allows(namespace) {
            return Ok(());
        }
        match namespace {
            Some(ns) if !ns.is_empty() => Err(McpError::new("PolicyDenied", format!("namespace \"{ns}\" is outside this context's allowlist"))
                .hint(format!("allowed: {}", self.namespaces.as_deref().unwrap_or_default().join(", ")))),
            _ => Err(McpError::new("Invalid", "this context has a namespace allowlist: name a namespace")
                .hint(format!("allowed: {}", self.namespaces.as_deref().unwrap_or_default().join(", ")))),
        }
    }

    /// The namespace to list in when the agent gave none: the only allowed one, or every
    /// namespace (`None`) when unrestricted. With several allowed namespaces the agent must pick.
    pub fn default_namespace(&self) -> Result<Option<String>, McpError> {
        match self.namespaces.as_deref() {
            None => Ok(None),
            Some([one]) => Ok(Some(one.clone())),
            Some(list) => Err(McpError::new("Invalid", "this context has a namespace allowlist: name a namespace")
                .hint(format!("allowed: {}", list.join(", ")))),
        }
    }

    /// Keeps the items whose namespace is allowed; returns how many were dropped.
    pub fn retain<T>(&self, items: &mut Vec<T>, namespace: impl Fn(&T) -> Option<&str>) -> usize {
        let before = items.len();
        items.retain(|i| self.allows(namespace(i)));
        before - items.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrestricted_sees_everything() {
        let s = Scope::new(None);
        assert!(s.allows(Some("kube-system")));
        assert!(s.allows(None));
        assert!(s.check("c", None, false).is_ok());
        assert_eq!(s.default_namespace().unwrap(), None);
        assert_eq!(Scope::new(Some(vec![])), s, "an empty allowlist is no allowlist");
    }

    #[test]
    fn allowlist_filters_and_denies_cluster_scoped() {
        let s = Scope::new(Some(vec!["shop".into(), "kns-spike".into()]));
        assert!(s.allows(Some("shop")));
        assert!(!s.allows(Some("kafka")));
        assert!(!s.allows(None));
        assert_eq!(s.check("c", None, false).unwrap_err().code, "PolicyDenied");
        assert_eq!(s.check("c", Some("kafka"), true).unwrap_err().code, "PolicyDenied");
        assert_eq!(s.check("c", None, true).unwrap_err().code, "Invalid");
        assert!(s.check("c", Some("kns-spike"), true).is_ok());
        assert_eq!(s.default_namespace().unwrap_err().code, "Invalid");
        assert_eq!(Scope::new(Some(vec!["a".into()])).default_namespace().unwrap().as_deref(), Some("a"));
    }

    #[test]
    fn retain_counts_dropped() {
        let s = Scope::new(Some(vec!["a".into()]));
        let mut rows = vec![Some("a"), Some("b"), None, Some("a")];
        assert_eq!(s.retain(&mut rows, |r| *r), 2);
        assert_eq!(rows, vec![Some("a"), Some("a")]);
    }
}
