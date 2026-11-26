//! Editing in the user's own editor and the YAML helpers of the review.
//!
//! The buffer goes to a private file (`0600` in a `0700` directory of its own) only while the
//! editor runs and is removed right after, also for a Secret. Lines starting with `# kns:` at
//! the top are ours (what is being edited, the last error) and are dropped on the way back.
use std::{
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    process::Command,
};

use serde_json::Value;

pub const HEADER: &str = "# kns:";

/// `KNS_EDITOR`, `VISUAL`, `EDITOR`, else `vi`. May carry arguments (`code -w`, `nvim -u NONE`).
pub fn editor() -> String {
    ["KNS_EDITOR", "VISUAL", "EDITOR"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "vi".into())
}

fn private_dir() -> Result<PathBuf, String> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("kns-edit-{}-{nanos}", std::process::id()));
    std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

fn file_name(hint: &str) -> String {
    let clean: String = hint.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '-' }).collect();
    format!("{}.yaml", clean.trim_matches('-').chars().take(80).collect::<String>())
}

/// Runs the editor on `header` + `text` and returns the text without our header. The terminal
/// must already be handed over (raw mode off, alternate screen left). A non-zero exit (`:cq`)
/// cancels.
pub fn edit(text: &str, hint: &str, header: &[String]) -> Result<Option<String>, String> {
    let dir = private_dir()?;
    let path = dir.join(file_name(hint));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|e| e.to_string())?;
        for h in header {
            writeln!(f, "{HEADER} {h}").map_err(|e| e.to_string())?;
        }
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        drop(f);
        let status = Command::new("sh")
            .arg("-c")
            .arg(format!("{} \"$1\"", editor()))
            .arg("sh")
            .arg(&path)
            .status()
            .map_err(|e| format!("could not start the editor: {e}"))?;
        if !status.success() {
            return Ok(None);
        }
        let back = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(Some(strip_header(&back)))
    })();
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir(&dir);
    result
}

/// Drops the leading `# kns:` lines.
pub fn strip_header(text: &str) -> String {
    let mut rest = text;
    while rest.starts_with(HEADER) {
        rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or("");
    }
    rest.to_string()
}

/// The header for an edit: what it is, how to cancel, and the last error if any.
pub fn header(what: &str, context: &str, error: Option<&str>) -> Vec<String> {
    let mut h = vec![format!("{what} in {context}. Save and quit to review the change; quit without saving (or :cq) to keep the last version.")];
    if let Some(e) = error {
        for l in e.lines().take(8) {
            h.push(format!("error: {l}"));
        }
    }
    h
}

/// Every document of a YAML stream (YAML 1.1 octals, as the backend and kubectl read them).
pub fn parse_docs(text: &str) -> Result<Vec<Value>, String> {
    let mut options = serde_saphyr::Options::default();
    options.legacy_octal_numbers = true;
    let docs: Vec<Value> = serde_saphyr::from_multiple_with_options(text, options).map_err(|e| e.to_string())?;
    Ok(docs.into_iter().filter(|d| !d.is_null()).collect())
}

pub fn to_yaml(v: &Value) -> String {
    serde_saphyr::to_string(v).unwrap_or_else(|e| format!("# {e}\n"))
}

/// Drops what the server owns or changes on every write, so a diff shows only real changes.
pub fn normalize(mut v: Value) -> Value {
    if let Some(meta) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        for k in ["managedFields", "resourceVersion", "generation", "uid", "creationTimestamp", "selfLink"] {
            meta.remove(k);
        }
        if let Some(a) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            a.remove("kubectl.kubernetes.io/last-applied-configuration");
            a.remove("deployment.kubernetes.io/revision");
            if a.is_empty() {
                meta.remove("annotations");
            }
        }
    }
    if let Some(o) = v.as_object_mut() {
        o.remove("status");
    }
    v
}

/// `Kind ns/name` of a document.
pub fn doc_label(d: &Value) -> String {
    let ns = d["metadata"]["namespace"].as_str().map(|n| format!("{n}/")).unwrap_or_default();
    format!("{} {ns}{}", d["kind"].as_str().unwrap_or("?"), d["metadata"]["name"].as_str().unwrap_or("?"))
}

/// The GitOps owner that will put its own version back: Flux from its labels, Argo CD from
/// its tracking annotation or instance label.
pub fn gitops_owner(d: &Value) -> Option<String> {
    let labels = &d["metadata"]["labels"];
    for (prefix, kind) in [("kustomize.toolkit.fluxcd.io", "Flux Kustomization"), ("helm.toolkit.fluxcd.io", "Flux HelmRelease")] {
        if let (Some(n), Some(ns)) = (labels[format!("{prefix}/name")].as_str(), labels[format!("{prefix}/namespace")].as_str()) {
            return Some(format!("{kind} {ns}/{n}"));
        }
    }
    if let Some(t) = d["metadata"]["annotations"]["argocd.argoproj.io/tracking-id"].as_str() {
        return Some(format!("Argo CD Application {}", t.split(':').next().unwrap_or(t)));
    }
    labels["argocd.argoproj.io/instance"].as_str().map(|a| format!("Argo CD Application {a}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    /// another field manager owns fields of the change: force takes them over
    FieldManager,
    /// the object changed since the edit started: rebase
    Version,
}

/// The same rule as `classifyConflict` in the window.
pub fn classify(code: u16, reason: &str, message: &str) -> Option<Conflict> {
    if code != 409 && reason != "Conflict" {
        return None;
    }
    let m = message.to_lowercase();
    if m.contains("conflicts with \"") || m.contains("conflict with \"") || (m.contains("apply failed with") && m.contains("conflict")) {
        Some(Conflict::FieldManager)
    } else {
        Some(Conflict::Version)
    }
}

/// A starting manifest for `:new <kind>`.
pub fn skeleton(kind: &str, namespace: &str) -> String {
    let ns = if namespace.is_empty() { "default" } else { namespace };
    match kind.to_lowercase().as_str() {
        "deploy" | "deployment" | "deployments" => format!(
            "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app\n  namespace: {ns}\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: my-app\n  template:\n    metadata:\n      labels:\n        app: my-app\n    spec:\n      containers:\n        - name: app\n          image: nginx:1.27\n          ports:\n            - containerPort: 80\n"
        ),
        "svc" | "service" | "services" => format!(
            "apiVersion: v1\nkind: Service\nmetadata:\n  name: my-app\n  namespace: {ns}\nspec:\n  selector:\n    app: my-app\n  ports:\n    - port: 80\n      targetPort: 80\n"
        ),
        "cm" | "configmap" | "configmaps" => format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config\n  namespace: {ns}\ndata:\n  key: value\n"),
        "secret" | "secrets" => format!(
            "apiVersion: v1\nkind: Secret\nmetadata:\n  name: my-secret\n  namespace: {ns}\ntype: Opaque\nstringData:\n  password: change-me\n"
        ),
        "job" | "jobs" => format!(
            "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: my-job\n  namespace: {ns}\nspec:\n  backoffLimit: 0\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n        - name: job\n          image: busybox:1.37\n          command: [\"sh\", \"-c\", \"echo hello\"]\n"
        ),
        "cj" | "cronjob" | "cronjobs" => format!(
            "apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: my-cron\n  namespace: {ns}\nspec:\n  schedule: \"*/15 * * * *\"\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: Never\n          containers:\n            - name: job\n              image: busybox:1.37\n              command: [\"sh\", \"-c\", \"date\"]\n"
        ),
        "ns" | "namespace" | "namespaces" => "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: my-namespace\n".into(),
        "pod" | "pods" | "po" => format!(
            "apiVersion: v1\nkind: Pod\nmetadata:\n  name: debug\n  namespace: {ns}\nspec:\n  restartPolicy: Never\n  containers:\n    - name: debug\n      image: busybox:1.37\n      command: [\"sleep\", \"3600\"]\n"
        ),
        _ => format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-object\n  namespace: {ns}\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn header_is_stripped_and_names_are_safe() {
        assert_eq!(strip_header("# kns: a\n# kns: error: b\nkind: Pod\n# kns: kept\n"), "kind: Pod\n# kns: kept\n");
        assert_eq!(file_name("deployment/web api"), "deployment-web-api.yaml");
    }

    #[test]
    fn conflicts_are_classified_like_the_window() {
        let fm = "Apply failed with 1 conflict: conflict with \"kubectl-client-side-apply\" using apps/v1: .spec.replicas";
        assert_eq!(classify(409, "Conflict", fm), Some(Conflict::FieldManager));
        assert_eq!(classify(409, "Conflict", "the object has been modified; please apply your changes to the latest version"), Some(Conflict::Version));
        assert_eq!(classify(422, "Invalid", "spec.replicas: Invalid value"), None);
    }

    #[test]
    fn yaml_round_trip_normalize_and_owner() {
        let docs = parse_docs("kind: A\nmetadata: {name: a, resourceVersion: '1', labels: {kustomize.toolkit.fluxcd.io/name: apps, kustomize.toolkit.fluxcd.io/namespace: flux-system}}\nspec: {mode: 0644}\nstatus: {x: 1}\n---\n---\nkind: B\nmetadata: {name: b, namespace: team}\n").unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0]["spec"]["mode"], json!(420));
        assert_eq!(gitops_owner(&docs[0]).as_deref(), Some("Flux Kustomization flux-system/apps"));
        assert_eq!(doc_label(&docs[1]), "B team/b");
        let n = normalize(docs[0].clone());
        assert!(n.get("status").is_none() && n["metadata"].get("resourceVersion").is_none());
        assert!(parse_docs(&skeleton("deploy", "x")).unwrap()[0]["spec"]["template"].is_object());
        assert!(parse_docs("a: [").is_err());
    }
}
