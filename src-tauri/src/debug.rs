//! Debug containers, debug copies and exec snippets (docs/plan-features.md §3 F).
//!
//! - `debug_container`: adds an ephemeral container (`kns-debug-xxxxx`) through the
//!   `pods/ephemeralcontainers` subresource and waits until it runs. It cannot be removed again;
//!   it goes away with the pod.
//! - `debug_copy`: a sleeping copy of a pod (every label dropped, probes removed, `restartPolicy:
//!   Never`, 1 h `activeDeadlineSeconds`), labelled `kns.dev/debug=true`.
//! - `snippet_run`: one `sh -c` exec without a TTY; the output is cleaned and redacted here, so
//!   the webview never sees a secret value a snippet like `env | sort` prints.
//!
//! Human actions only: none of this is reachable from the MCP server. Writes refuse a read-only
//! context here as well as in the UI; the UI adds the confirm tiers and the RBAC check.
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use http::Method;
use k8s_openapi::{api::core::v1::Pod, apimachinery::pkg::apis::meta::v1::Status};
use kube::api::{Api, AttachParams};
use rand::Rng;
use serde_json::{Map, json};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::{
    ctxflags,
    ipc::{BackendError, DebugPod, DebugPodKind, DebugRequest, Gvr, Json, ObjRef, Result, SnippetOutput, SnippetRunRequest},
    redact::{MAX_LINE, Redactor, clean_untrusted},
    session::{JSON, api_path, timed, with_query},
    state::{AppState, lock},
};

pub const DEBUG_LABEL: &str = "kns.dev/debug";
pub const SOURCE_LABEL: &str = "kns.dev/source";
/// Annotations on a copy: the full source pod name (labels cap at 63) and the shell container.
pub const SOURCE_ANNOTATION: &str = "kns.dev/source-pod";
pub const CONTAINER_ANNOTATION: &str = "kns.dev/container";
pub const EPHEMERAL_PREFIX: &str = "kns-debug-";
/// The extra container a copy gets when an image is picked.
pub const COPY_CONTAINER: &str = "kns-debug";
const STRATEGIC_MERGE: &str = "application/strategic-merge-patch+json";
const WAIT_RUNNING: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_secs(1);
pub const COPY_DEADLINE_SECONDS: i64 = 3600;
const SLEEP: [&str; 2] = ["sleep", "3600"];
pub const MAX_OUTPUT: usize = 256 * 1024;
const DEFAULT_TIMEOUT: u32 = 30;
const MAX_TIMEOUT: u32 = 120;
const MAX_COMMAND: usize = 4096;
/// Waiting reasons that will not fix themselves within the wait.
const FATAL_WAITING: &[&str] =
    &["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull", "CreateContainerError", "CreateContainerConfigError"];

fn pods_gvr() -> Gvr {
    Gvr::new("", "v1", "pods")
}

/// Five characters of `[a-z0-9]`, like a generated name suffix.
fn suffix() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = [0u8; 5];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

fn require_pod(obj: &ObjRef) -> Result<()> {
    if obj.gvr.group.is_empty() && obj.gvr.resource == "pods" && obj.ns().is_some() {
        Ok(())
    } else {
        Err(BackendError::invalid("debug needs a pod"))
    }
}

/// Writes refuse a read-only context (and wait for the flags to load, `ctxflags::effective`).
fn deny_read_only(state: &AppState, context: &str) -> Result<()> {
    if ctxflags::effective(state, context)?.read_only {
        return Err(BackendError::new(0, "ReadOnly", format!("{context} is read-only")));
    }
    Ok(())
}

/// A full image reference: no whitespace or control characters, at most 255 characters.
pub fn check_image(image: &str) -> Result<()> {
    let ok = !image.is_empty() && image.len() <= 255 && !image.chars().any(|c| c.is_whitespace() || c.is_control());
    if ok { Ok(()) } else { Err(BackendError::invalid("not an image reference")) }
}

fn names(pod: &Json, list: &str) -> Vec<String> {
    pod["spec"][list].as_array().map(|a| a.iter().filter_map(|c| c["name"].as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn cleaned(s: &str) -> String {
    clean_untrusted(s, 300)
}

// ───────────────────────── ephemeral containers ─────────────────────────

/// The ephemeral container `debug_container` adds. stdin and a TTY keep the image's default shell
/// running, so the exec that follows has a process to join.
pub fn ephemeral_container(name: &str, image: &str, target: Option<&str>) -> Json {
    let mut c = json!({
        "name": name,
        "image": image,
        "stdin": true,
        "tty": true,
        "terminationMessagePolicy": "File",
    });
    if let Some(t) = target {
        c["targetContainerName"] = json!(t);
    }
    c
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EphemeralState {
    /// started at (RFC3339, may be empty)
    Running(String),
    Waiting { reason: String, message: String },
    Terminated { reason: String, code: Option<i64> },
    /// no status yet
    Pending,
}

/// The state of ephemeral container `name` in a pod object.
pub fn ephemeral_state(pod: &Json, name: &str) -> EphemeralState {
    let Some(status) = pod["status"]["ephemeralContainerStatuses"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["name"].as_str() == Some(name)))
    else {
        return EphemeralState::Pending;
    };
    let state = &status["state"];
    let text = |v: &Json| v.as_str().unwrap_or_default().to_string();
    if state["running"].is_object() {
        EphemeralState::Running(text(&state["running"]["startedAt"]))
    } else if state["terminated"].is_object() {
        EphemeralState::Terminated { reason: text(&state["terminated"]["reason"]), code: state["terminated"]["exitCode"].as_i64() }
    } else if state["waiting"].is_object() {
        EphemeralState::Waiting { reason: text(&state["waiting"]["reason"]), message: text(&state["waiting"]["message"]) }
    } else {
        EphemeralState::Pending
    }
}

/// Ephemeral containers this run of kns added (they cannot be listed by label).
#[derive(Default)]
struct Added(Mutex<Vec<DebugPod>>);

fn added(state: &AppState) -> Arc<Added> {
    state.ext::<Added>()
}

pub async fn debug_container(state: &AppState, req: &DebugRequest) -> Result<String> {
    let obj = &req.obj_ref;
    require_pod(obj)?;
    check_image(&req.image)?;
    deny_read_only(state, &obj.context)?;
    let session = state.session(&obj.context).await?;
    let path = api_path(&obj.gvr, obj.ns(), Some(&obj.name));
    let pod = session.get(&path).await?;
    if let Some("Succeeded" | "Failed") = pod["status"]["phase"].as_str() {
        return Err(BackendError::invalid(format!("pod {} has ended; debug a copy instead", obj.name)));
    }
    let target = req.target.as_deref().filter(|t| !t.is_empty());
    if let Some(t) = target
        && !names(&pod, "containers").iter().any(|c| c == t)
    {
        return Err(BackendError::invalid(format!("pod {} has no container {}", obj.name, cleaned(t))));
    }
    let taken = names(&pod, "ephemeralContainers");
    let name = loop {
        let n = format!("{EPHEMERAL_PREFIX}{}", suffix());
        if !taken.contains(&n) {
            break n;
        }
    };
    let body = json!({ "spec": { "ephemeralContainers": [ephemeral_container(&name, &req.image, target)] } });
    session.send_json(Method::PATCH, &format!("{path}/ephemeralcontainers"), STRATEGIC_MERGE, &body).await?;

    let started = Instant::now();
    loop {
        let pod = session.get(&path).await?;
        match ephemeral_state(&pod, &name) {
            EphemeralState::Running(at) => {
                let entry = DebugPod {
                    context: obj.context.clone(),
                    namespace: obj.ns().unwrap_or_default().to_string(),
                    name: obj.name.clone(),
                    source: obj.name.clone(),
                    kind: DebugPodKind::Ephemeral,
                    container: Some(name.clone()),
                    created_at: at,
                };
                lock(&added(state).0).push(entry);
                return Ok(name);
            }
            EphemeralState::Waiting { reason, message } if FATAL_WAITING.contains(&reason.as_str()) => {
                return Err(BackendError::new(
                    0,
                    "DebugFailed",
                    format!("{name}: {reason}: {}. It stays in the pod (ephemeral containers cannot be removed).", cleaned(&message)),
                ));
            }
            EphemeralState::Terminated { reason, code } => {
                let code = code.map(|c| format!(" (exit {c})")).unwrap_or_default();
                return Err(BackendError::new(0, "DebugFailed", format!("{name} ended at once: {}{code}", cleaned(&reason))));
            }
            _ => {}
        }
        if started.elapsed() >= WAIT_RUNNING {
            return Err(BackendError::new(
                0,
                "Timeout",
                format!("{name} is not running after {}s; it stays in the pod (ephemeral containers cannot be removed)", WAIT_RUNNING.as_secs()),
            ));
        }
        tokio::time::sleep(POLL).await;
    }
}

// ───────────────────────── debug copies ─────────────────────────

/// A label value: at most 63 characters of `[A-Za-z0-9._-]`, alphanumeric at both ends.
pub fn label_value(s: &str) -> String {
    let kept: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).take(63).collect();
    kept.trim_matches(|c: char| !c.is_ascii_alphanumeric()).to_string()
}

/// `<source>-debug-<suffix>`, at most 63 characters (a hostname).
pub fn copy_name(source: &str, suffix: &str) -> String {
    let tail = format!("-debug-{suffix}");
    let head: String = source.chars().take(63 - tail.len()).collect();
    format!("{}{tail}", head.trim_end_matches(['-', '.']))
}

/// The copy `debug_copy` creates, and the container its shell opens in. Pure.
///
/// Every label is dropped (an orphan pod that matches a ReplicaSet's selector is adopted, and the
/// ReplicaSet then deletes a pod to get back to its count), as are owner references, the node,
/// probes and ephemeral containers. The target container (or the first) sleeps instead of running
/// its command; with `image` a `kns-debug` container sharing the process namespace is added.
pub fn sanitize_copy(pod: &Json, name: &str, image: Option<&str>, target: Option<&str>) -> Result<(Json, String)> {
    let source = pod["metadata"]["name"].as_str().ok_or_else(|| BackendError::invalid("pod without a name"))?;
    let namespace = pod["metadata"]["namespace"].as_str().unwrap_or_default();
    let mut spec = match &pod["spec"] {
        Json::Object(m) => m.clone(),
        _ => return Err(BackendError::invalid("pod without a spec")),
    };
    let containers = names(pod, "containers");
    let target = match target.filter(|t| !t.is_empty()) {
        Some(t) if containers.iter().any(|c| c == t) => t.to_string(),
        Some(t) => return Err(BackendError::invalid(format!("pod {source} has no container {}", cleaned(t)))),
        None => containers.first().cloned().ok_or_else(|| BackendError::invalid("pod without containers"))?,
    };

    for key in ["nodeName", "ephemeralContainers"] {
        spec.remove(key);
    }
    spec.insert("restartPolicy".into(), json!("Never"));
    spec.insert("activeDeadlineSeconds".into(), json!(COPY_DEADLINE_SECONDS));
    for list in ["containers", "initContainers"] {
        if let Some(Json::Array(cs)) = spec.get_mut(list) {
            for c in cs.iter_mut().filter_map(Json::as_object_mut) {
                for probe in ["livenessProbe", "readinessProbe", "startupProbe"] {
                    c.remove(probe);
                }
                if list == "containers" && c.get("name").and_then(Json::as_str) == Some(target.as_str()) {
                    c.insert("command".into(), json!(SLEEP));
                    c.remove("args");
                }
            }
        }
    }
    let mut shell = target;
    if let Some(image) = image.filter(|i| !i.is_empty()) {
        check_image(image)?;
        let all: Vec<String> = containers.iter().chain(names(pod, "initContainers").iter()).cloned().collect();
        let mut extra = COPY_CONTAINER.to_string();
        let mut i = 1;
        while all.contains(&extra) {
            extra = format!("{COPY_CONTAINER}-{i}");
            i += 1;
        }
        if let Some(Json::Array(cs)) = spec.get_mut("containers") {
            cs.push(json!({ "name": extra, "image": image, "command": SLEEP, "stdin": true, "tty": true }));
        }
        spec.insert("shareProcessNamespace".into(), json!(true));
        shell = extra;
    }

    let mut labels = Map::new();
    labels.insert(DEBUG_LABEL.into(), json!("true"));
    labels.insert(SOURCE_LABEL.into(), json!(label_value(source)));
    let copy = json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": labels,
            "annotations": { SOURCE_ANNOTATION: source, CONTAINER_ANNOTATION: shell },
        },
        "spec": spec,
    });
    Ok((copy, shell))
}

fn copy_entry(context: &str, pod: &Json) -> Option<DebugPod> {
    let meta = &pod["metadata"];
    let text = |v: &Json| v.as_str().map(str::to_string);
    Some(DebugPod {
        context: context.to_string(),
        namespace: text(&meta["namespace"])?,
        name: text(&meta["name"])?,
        source: text(&meta["annotations"][SOURCE_ANNOTATION])
            .or_else(|| text(&meta["labels"][SOURCE_LABEL]))
            .unwrap_or_default(),
        kind: DebugPodKind::Copy,
        container: text(&meta["annotations"][CONTAINER_ANNOTATION]),
        created_at: text(&meta["creationTimestamp"]).unwrap_or_default(),
    })
}

pub async fn debug_copy(state: &AppState, obj: &ObjRef, image: Option<&str>, target: Option<&str>) -> Result<DebugPod> {
    require_pod(obj)?;
    deny_read_only(state, &obj.context)?;
    let session = state.session(&obj.context).await?;
    let pod = session.get(&api_path(&obj.gvr, obj.ns(), Some(&obj.name))).await?;
    let name = copy_name(&obj.name, &suffix());
    let (copy, _) = sanitize_copy(&pod, &name, image, target)?;
    let created = session.send_json(Method::POST, &api_path(&obj.gvr, obj.ns(), None), JSON, &copy).await?;
    copy_entry(&obj.context, &created).ok_or_else(|| BackendError::internal("the API server answered without the pod"))
}

pub async fn debug_pods_list(state: &AppState, context: &str) -> Result<Vec<DebugPod>> {
    let session = state.session(context).await?;
    let uri = with_query(&api_path(&pods_gvr(), None, None), &[("labelSelector", &format!("{DEBUG_LABEL}=true"))]);
    let mut out: Vec<DebugPod> = match session.get(&uri).await {
        Ok(list) => list["items"]
            .as_array()
            .map(|items| {
                items.iter().filter(|p| p["metadata"]["deletionTimestamp"].is_null()).filter_map(|p| copy_entry(context, p)).collect()
            })
            .unwrap_or_default(),
        // listing pods in every namespace may be forbidden; the ephemeral list still works
        Err(e) if e.code == 403 => Vec::new(),
        Err(e) => return Err(e),
    };
    let mine: Vec<DebugPod> = lock(&added(state).0).iter().filter(|p| p.context == context).cloned().collect();
    let mut gone = Vec::new();
    for p in mine {
        let path = api_path(&pods_gvr(), Some(&p.namespace), Some(&p.name));
        match session.get(&path).await {
            Ok(pod) if pod["status"]["ephemeralContainerStatuses"].as_array().is_some_and(|a| {
                a.iter().any(|s| s["name"].as_str() == p.container.as_deref() && s["state"]["terminated"].is_null())
            }) =>
            {
                out.push(p)
            }
            // the pod is gone or the container ended: forget it
            Ok(_) => gone.push(p),
            Err(e) if e.code == 404 => gone.push(p),
            Err(_) => out.push(p),
        }
    }
    if !gone.is_empty() {
        lock(&added(state).0).retain(|p| !gone.contains(p));
    }
    out.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
    Ok(out)
}

pub async fn debug_pod_delete(state: &AppState, obj: &ObjRef) -> Result<()> {
    require_pod(obj)?;
    deny_read_only(state, &obj.context)?;
    let session = state.session(&obj.context).await?;
    let path = api_path(&obj.gvr, obj.ns(), Some(&obj.name));
    let pod = session.get(&path).await?;
    if pod["metadata"]["labels"][DEBUG_LABEL].as_str() != Some("true") {
        return Err(BackendError::invalid(format!("{} is not a kns debug copy (no {DEBUG_LABEL}=true label)", obj.name)));
    }
    session.send(Method::DELETE, &path, Some(JSON), None).await?;
    Ok(())
}

// ───────────────────────── snippets ─────────────────────────

/// Reads from an open stream into `out` until EOF, at most `cap` bytes in total across streams.
async fn drain<R: AsyncRead + Unpin>(stream: &mut Option<R>, buf: &mut [u8]) -> Option<usize> {
    let reader = stream.as_mut()?;
    match reader.read(buf).await {
        Ok(n) if n > 0 => Some(n),
        _ => {
            *stream = None;
            Some(0)
        }
    }
}

/// Exit code from the exec status: `Success` is 0, a failure carries it in `details.causes`.
pub fn exit_code(status: &Status) -> (Option<i32>, Option<String>) {
    if status.status.as_deref() == Some("Success") {
        return (Some(0), None);
    }
    let code = status
        .details
        .as_ref()
        .and_then(|d| d.causes.as_ref())
        .and_then(|causes| causes.iter().find(|c| c.reason.as_deref() == Some("ExitCode")))
        .and_then(|c| c.message.as_deref()?.trim().parse().ok());
    let message = if code.is_none() { status.message.clone().filter(|m| !m.is_empty()) } else { None };
    (code, message)
}

/// Cleans and redacts raw snippet output.
pub fn redact_output(raw: &[u8]) -> (String, crate::ipc::RedactionReport) {
    let mut r = Redactor::new();
    let text = r.text(&clean_untrusted(&String::from_utf8_lossy(raw), MAX_LINE));
    (text, r.report())
}

pub async fn snippet_run(state: &AppState, req: &SnippetRunRequest) -> Result<SnippetOutput> {
    let obj = &req.obj_ref;
    require_pod(obj)?;
    if req.command.trim().is_empty() || req.command.len() > MAX_COMMAND {
        return Err(BackendError::invalid("snippet command is empty or too long"));
    }
    let limit = Duration::from_secs(u64::from(req.timeout_seconds.unwrap_or(DEFAULT_TIMEOUT).clamp(1, MAX_TIMEOUT)));
    let session = state.session(&obj.context).await?;
    let pods: Api<Pod> = Api::namespaced(session.client.clone(), obj.ns().unwrap_or_default());
    let params = AttachParams {
        container: req.container.clone().filter(|c| !c.is_empty()),
        stdin: false,
        stdout: true,
        stderr: true,
        tty: false,
        ..Default::default()
    };
    let started = Instant::now();
    let command = vec!["sh".to_string(), "-c".to_string(), req.command.clone()];
    let mut process = timed(pods.exec(&obj.name, command, &params)).await?;
    let (mut stdout, mut stderr) = (process.stdout(), process.stderr());
    let status = process.take_status();

    let mut raw: Vec<u8> = Vec::new();
    let mut truncated = false;
    let read = async {
        let (mut a, mut b) = (vec![0u8; 16 * 1024], vec![0u8; 16 * 1024]);
        while stdout.is_some() || stderr.is_some() {
            let n = tokio::select! {
                Some(n) = drain(&mut stdout, &mut a) => (n, true),
                Some(n) = drain(&mut stderr, &mut b) => (n, false),
                else => break,
            };
            let chunk = if n.1 { &a[..n.0] } else { &b[..n.0] };
            let room = MAX_OUTPUT.saturating_sub(raw.len());
            raw.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if chunk.len() > room {
                truncated = true;
                break;
            }
        }
    };
    let timed_out = tokio::time::timeout(limit, read).await.is_err();
    let (mut code, mut message) = (None, None);
    if timed_out {
        truncated = true;
        message = Some(format!("timed out after {}s", limit.as_secs()));
    } else if !truncated && let Some(s) = status {
        match tokio::time::timeout(Duration::from_secs(5), s).await {
            Ok(Some(s)) => (code, message) = exit_code(&s),
            _ => message = Some("no exit status (connection closed)".into()),
        }
    } else if truncated {
        message = Some(format!("output cut at {} KiB", MAX_OUTPUT / 1024));
    }
    drop(process);
    let (output, redactions) = redact_output(&raw);
    Ok(SnippetOutput {
        output,
        exit_code: code,
        message: message.map(|m| cleaned(&m)),
        truncated,
        millis: started.elapsed().as_millis() as u64,
        redactions,
    })
}

pub mod cmd {
    use crate::ipc::{DebugPod, DebugRequest, ObjRef, Result, SnippetOutput, SnippetRunRequest};
    use crate::state::AppState;

    #[tauri::command]
    pub async fn debug_container(state: tauri::State<'_, AppState>, req: DebugRequest) -> Result<String> {
        super::debug_container(&state, &req).await
    }

    #[tauri::command]
    pub async fn debug_copy(
        state: tauri::State<'_, AppState>,
        obj_ref: ObjRef,
        image: Option<String>,
        target: Option<String>,
    ) -> Result<DebugPod> {
        super::debug_copy(&state, &obj_ref, image.as_deref(), target.as_deref()).await
    }

    #[tauri::command]
    pub async fn debug_pods_list(state: tauri::State<'_, AppState>, context: String) -> Result<Vec<DebugPod>> {
        super::debug_pods_list(&state, &context).await
    }

    /// Deletes a kns debug copy (only pods labelled `kns.dev/debug=true`).
    #[tauri::command]
    pub async fn debug_pod_delete(state: tauri::State<'_, AppState>, obj_ref: ObjRef) -> Result<()> {
        super::debug_pod_delete(&state, &obj_ref).await
    }

    /// Runs one snippet as a single exec; the output is cleaned and redacted here.
    #[tauri::command]
    pub async fn snippet_run(state: tauri::State<'_, AppState>, req: SnippetRunRequest) -> Result<SnippetOutput> {
        super::snippet_run(&state, &req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Json {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/debug").join(name);
        serde_json::from_str(&std::fs::read_to_string(&path).expect("fixture")).expect("json")
    }

    #[test]
    fn copy_matches_the_fixture() {
        let pod = fixture("crashy.pod.json");
        let (copy, shell) = sanitize_copy(&pod, "crashy-7d9f-debug-ab1c2", None, None).expect("copy");
        assert_eq!(shell, "app");
        assert_eq!(copy, fixture("crashy.copy.expected.json"));
    }

    #[test]
    fn copy_drops_every_label_owner_node_and_probe() {
        let pod = fixture("crashy.pod.json");
        let (copy, _) = sanitize_copy(&pod, "x-debug-aaaaa", None, None).expect("copy");
        let text = copy.to_string();
        for gone in ["ownerReferences", "pod-template-hash", "livenessProbe", "readinessProbe", "startupProbe", "nodeName", "resourceVersion", "uid", "\"status\"", "ephemeralContainers", "crash-loop"] {
            assert!(!text.contains(gone), "{gone} survived: {text}");
        }
        assert_eq!(copy["metadata"]["labels"], json!({ DEBUG_LABEL: "true", SOURCE_LABEL: "crashy-7d9f" }));
        assert_eq!(copy["spec"]["restartPolicy"], "Never");
        assert_eq!(copy["spec"]["activeDeadlineSeconds"], COPY_DEADLINE_SECONDS);
        assert_eq!(copy["spec"]["containers"][0]["command"], json!(SLEEP));
        // the sidecar keeps its own command
        assert_eq!(copy["spec"]["containers"][1]["command"], json!(["/proxy"]));
    }

    #[test]
    fn copy_with_image_adds_a_sharing_debug_container() {
        let pod = fixture("crashy.pod.json");
        let (copy, shell) = sanitize_copy(&pod, "x-debug-aaaaa", Some("busybox:1.37.0"), Some("sidecar")).expect("copy");
        assert_eq!(shell, COPY_CONTAINER);
        assert_eq!(copy["spec"]["shareProcessNamespace"], true);
        let cs = copy["spec"]["containers"].as_array().unwrap();
        assert_eq!(cs.len(), 3);
        assert_eq!(cs[2]["image"], "busybox:1.37.0");
        assert_eq!(cs[1]["command"], json!(SLEEP), "the target sleeps");
        assert!(cs[1].get("args").is_none());
        assert_eq!(copy["metadata"]["annotations"][CONTAINER_ANNOTATION], COPY_CONTAINER);
    }

    #[test]
    fn copy_refuses_unknown_target_and_bad_image() {
        let pod = fixture("crashy.pod.json");
        assert!(sanitize_copy(&pod, "x", None, Some("nope")).is_err());
        assert!(sanitize_copy(&pod, "x", Some("busy box"), None).is_err());
        assert!(sanitize_copy(&json!({ "metadata": { "name": "a" } }), "x", None, None).is_err());
    }

    #[test]
    fn names_fit_in_63() {
        let long = "a".repeat(80);
        let n = copy_name(&long, "abcde");
        assert!(n.len() <= 63 && n.ends_with("-debug-abcde"), "{n}");
        assert_eq!(copy_name("web-1", "abcde"), "web-1-debug-abcde");
        assert_eq!(label_value(&format!("{}-x", "b".repeat(70))).len(), 63);
        assert_eq!(label_value("-a.b-"), "a.b");
        assert_eq!(suffix().len(), 5);
    }

    #[test]
    fn ephemeral_container_shape() {
        let c = ephemeral_container("kns-debug-abcde", "nicolaka/netshoot:v0.13", Some("main"));
        assert_eq!(
            c,
            json!({ "name": "kns-debug-abcde", "image": "nicolaka/netshoot:v0.13", "stdin": true, "tty": true, "terminationMessagePolicy": "File", "targetContainerName": "main" })
        );
        assert!(ephemeral_container("n", "i", None).get("targetContainerName").is_none());
    }

    #[test]
    fn ephemeral_states() {
        let pod = |state: Json| json!({ "status": { "ephemeralContainerStatuses": [{ "name": "kns-debug-a", "state": state }] } });
        assert_eq!(ephemeral_state(&json!({}), "kns-debug-a"), EphemeralState::Pending);
        assert_eq!(
            ephemeral_state(&pod(json!({ "running": { "startedAt": "2026-11-22T10:00:00Z" } })), "kns-debug-a"),
            EphemeralState::Running("2026-11-22T10:00:00Z".into())
        );
        assert_eq!(
            ephemeral_state(&pod(json!({ "waiting": { "reason": "ImagePullBackOff", "message": "nope" } })), "kns-debug-a"),
            EphemeralState::Waiting { reason: "ImagePullBackOff".into(), message: "nope".into() }
        );
        assert_eq!(
            ephemeral_state(&pod(json!({ "terminated": { "reason": "Error", "exitCode": 1 } })), "kns-debug-a"),
            EphemeralState::Terminated { reason: "Error".into(), code: Some(1) }
        );
        assert_eq!(ephemeral_state(&pod(json!({ "running": {} })), "other"), EphemeralState::Pending);
    }

    #[test]
    fn images() {
        assert!(check_image("busybox:1.37.0").is_ok());
        assert!(check_image("ghcr.io/a/b@sha256:abc").is_ok());
        for bad in ["", "a b", "a\nb", &"x".repeat(256)] {
            assert!(check_image(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn snippet_output_is_redacted() {
        let raw = b"HOME=/root\nDB_PASSWORD=hunter2-s3cr3t\nDATABASE_URL=postgres://app:pw-s3cr3t@db.kns-spike.svc:5432/app\nAPI_TOKEN=tok-s3cr3t\n\x1b[31mred\x1b[0m\n";
        let (text, report) = redact_output(raw);
        for secret in ["hunter2-s3cr3t", "pw-s3cr3t", "tok-s3cr3t", "\x1b"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert!(text.contains("HOME=/root"));
        assert!(text.contains("red"));
        assert!(report.count >= 3, "{report:?}");
    }

    #[test]
    fn exit_codes() {
        let ok = Status { status: Some("Success".into()), ..Default::default() };
        assert_eq!(exit_code(&ok), (Some(0), None));
        let failed: Status = serde_json::from_value(json!({
            "status": "Failure", "message": "command terminated with non-zero exit code",
            "details": { "causes": [{ "reason": "ExitCode", "message": "127" }] }
        }))
        .unwrap();
        assert_eq!(exit_code(&failed), (Some(127), None));
        let no_code: Status = serde_json::from_value(json!({ "status": "Failure", "message": "exec failed" })).unwrap();
        assert_eq!(exit_code(&no_code), (None, Some("exec failed".into())));
    }
}
