//! Integration check of the core backend against the real cluster, without a webview.
//! Calls the same functions the Tauri commands delegate to. Mutations only touch `kns-spike`.
//! Run: `cargo run --example core_check`
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail, ensure};
use kns_lib::{
    discovery,
    ipc::{
        AccessQuery, ApplyOptions, DeleteOptions, FnSink, Gvr, Json, ObjRef, PatchType, Propagation, TableEvent,
        TableQuery, WatchState,
    },
    metrics, mutate, objects, rbac, session,
    state::AppState,
    store, table,
};
use serde_json::json;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

const CTX: &str = "default";
/// The only namespace this example may mutate.
const NS: &str = "kns-spike";
const CM: &str = "kns-check-cm";
const DEPLOY: &str = "kns-check-deploy";
const CRON: &str = "kns-check-cron";
const SECRET: &str = "kns-check-secret";
const MF: &str = "kns-check-mf";

type Events = UnboundedReceiver<TableEvent>;

fn obj(group: &str, version: &str, resource: &str, name: &str) -> ObjRef {
    ObjRef { context: CTX.into(), gvr: Gvr::new(group, version, resource), namespace: Some(NS.into()), name: name.into() }
}

async fn subscribe(state: &AppState, gvr: Gvr, namespace: Option<&str>) -> anyhow::Result<(String, Events)> {
    let (tx, rx) = unbounded_channel();
    let query = TableQuery {
        context: CTX.into(),
        gvr,
        namespace: namespace.map(str::to_string),
        label_selector: None,
        field_selector: None,
    };
    let id = table::subscribe_table(state, query, FnSink(move |e| tx.send(e).is_ok())).await?;
    Ok((id, rx))
}

/// Next event for which `pick` returns something, within `secs`.
async fn wait_for<T>(rx: &mut Events, secs: u64, mut pick: impl FnMut(&TableEvent) -> Option<T>) -> anyhow::Result<T> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let event = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .map_err(|_| anyhow!("no matching table event within {secs}s"))?
            .ok_or_else(|| anyhow!("table stream ended"))?;
        if let Some(found) = pick(&event) {
            return Ok(found);
        }
    }
}

/// Expects `syncing`, `snapshot`, `live` in that order; returns (column names, row count).
async fn expect_snapshot(rx: &mut Events) -> anyhow::Result<(Vec<String>, usize)> {
    let mut order = Vec::new();
    let mut snapshot = None;
    while snapshot.is_none() || order.last().map(String::as_str) != Some("live") {
        wait_for(rx, 30, |e| {
            match e {
                TableEvent::State { state: WatchState::Syncing, .. } => order.push("syncing".to_string()),
                TableEvent::State { state: WatchState::Live, .. } => order.push("live".to_string()),
                TableEvent::State { state, message } => {
                    order.push(format!("{state:?}({})", message.clone().unwrap_or_default()))
                }
                TableEvent::Snapshot { columns, rows } => {
                    order.push("snapshot".to_string());
                    snapshot = Some((columns.iter().map(|c| c.name.clone()).collect(), rows.len()));
                }
                TableEvent::Delta { .. } => order.push("delta".to_string()),
            }
            Some(())
        })
        .await
        .with_context(|| format!("events so far: {order:?}"))?;
    }
    ensure!(order == ["syncing", "snapshot", "live"], "unexpected event order {order:?}");
    snapshot.ok_or_else(|| anyhow!("no snapshot"))
}

/// Waits for a delta that upserts a row called `name`; returns its uid.
async fn expect_upsert(rx: &mut Events, name: &str) -> anyhow::Result<String> {
    wait_for(rx, 15, |e| match e {
        TableEvent::Delta { upserts, .. } => upserts.iter().find(|r| r.name == name).map(|r| r.uid.clone()),
        _ => None,
    })
    .await
    .with_context(|| format!("upsert delta for {name}"))
}

async fn poll<T>(what: &str, secs: u64, mut f: impl AsyncFnMut() -> anyhow::Result<Option<T>>) -> anyhow::Result<T> {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(v) = f().await? {
            return Ok(v);
        }
        ensure!(Instant::now() < end, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn check(state: &AppState) -> anyhow::Result<()> {
    // ── contexts, connect, discovery ──
    let contexts = session::list_contexts().await?;
    println!(
        "[contexts] {:?} current={:?} files={}",
        contexts.contexts.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        contexts.current,
        contexts.files.len()
    );
    ensure!(contexts.contexts.iter().any(|c| c.name == CTX), "context {CTX} missing");

    let t = Instant::now();
    let info = session::connect(state, CTX).await?;
    println!(
        "[connect] cluster={} user={} version={} hasMetrics={} in {:?}",
        info.cluster,
        info.user,
        info.server_version,
        info.has_metrics,
        t.elapsed()
    );
    ensure!(session::connect(state, "no-such-context").await.is_err_and(|e| e.reason == "Config"));

    let resources = discovery::discover(state, CTX).await?;
    println!("[discover] {} resources", resources.len());
    for (group, resource) in [("", "pods"), ("apps", "deployments"), ("kustomize.toolkit.fluxcd.io", "kustomizations")] {
        let r = resources
            .iter()
            .find(|r| r.gvr.group == group && r.gvr.resource == resource)
            .ok_or_else(|| anyhow!("{resource} not discovered"))?;
        println!(
            "  {}/{} {} kind={} namespaced={} short={:?} subresources={:?}",
            r.gvr.group, r.gvr.version, r.gvr.resource, r.kind, r.namespaced, r.short_names, r.subresources
        );
        ensure!(!r.subresources.is_empty(), "{resource} has no subresources");
        ensure!(r.verbs.iter().any(|v| v == "watch"), "{resource} has no watch verb");
    }

    // ── pods table, all namespaces ──
    let t = Instant::now();
    let (pods_id, mut pods_rx) = subscribe(state, Gvr::new("", "v1", "pods"), None).await?;
    let (columns, rows) = expect_snapshot(&mut pods_rx).await?;
    println!("[table pods] id={pods_id} rows={rows} columns={columns:?} in {:?}", t.elapsed());
    ensure!(rows > 0 && columns.first().is_some_and(|c| c == "Name"));
    ensure!(state.stream_count() == 1);
    ensure!(state.stop_stream(&pods_id), "stop_stream did not find {pods_id}");
    // The task drops its sink when it ends, which closes the channel.
    let closed = tokio::time::timeout(Duration::from_secs(5), async { while pods_rx.recv().await.is_some() {} }).await;
    ensure!(closed.is_ok() && state.stream_count() == 0, "pods stream still running after stop_stream");
    println!("[stop_stream] stream ended, registry empty");

    // Cluster-scoped resource with a namespace in the query, a CRD, and failure states.
    let (id, mut rx) = subscribe(state, Gvr::new("", "v1", "nodes"), Some(NS)).await?;
    let (columns, rows) = expect_snapshot(&mut rx).await?;
    println!("[table nodes] rows={rows} columns={}", columns.len());
    state.stop_stream(&id);
    let (id, mut rx) = subscribe(state, Gvr::new("kustomize.toolkit.fluxcd.io", "v1", "kustomizations"), None).await?;
    let (columns, rows) = expect_snapshot(&mut rx).await?;
    println!("[table kustomizations] rows={rows} columns={columns:?}");
    state.stop_stream(&id);
    let (_, mut rx) = subscribe(state, Gvr::new("", "v1", "nopes"), None).await?;
    let message = wait_for(&mut rx, 15, |e| match e {
        TableEvent::State { state: WatchState::Error, message } => Some(message.clone().unwrap_or_default()),
        _ => None,
    })
    .await?;
    println!("[table 404] state=error message={message:?}");
    ensure!(rx.recv().await.is_none(), "404 subscription did not stop");

    // ── yaml round trip ──
    // Strings that a careless emitter leaves unquoted and a parser then reads as another type.
    let strings = [
        "yes", "no", "on", "off", "y", "n", "true", "TRUE", "True", "false", "null", "Null", "NULL", "~", "", " ",
        " padded ", "012", "0755", "-007", "+1", "12", "1.0", ".5", "1e3", "1_000", "0x1f", "0X1F", "0o17", "0b101",
        ".inf", "-.inf", ".nan", ".NaN", "2026-11-21", "2026-11-21T10:00:00Z", "a: b", "a #b", "# x", "- a", "-", "?",
        "? a", "@x", "*x", "&x", "!x", "|", ">", "%x", "`x", "{a}", "[a]", "a,b", "'quoted'", "\"dq\"", "back\\slash",
        "tab\there", "trailing space ", "line one\nline two\n", "no trailing newline\nsecond", "\nleading newline",
        "trailing newlines\n\n", "  indented first line\nsecond\n", "crlf\r\nline", "unicode æøå ✓", "---", "...",
        "key: value\nother: [1, 2]\n",
    ];
    let mut tricky = json!({ "real": true, "int": 12, "float": 1.5, "nothing": null, "list": [1, "1", true, "true"],
        "long": "word ".repeat(120), "nested": { "empty_map": {}, "empty_list": [] } });
    for (i, s) in strings.iter().enumerate() {
        tricky[format!("s{i}")] = json!(s);
        tricky["keys"][*s] = json!(i);
    }
    let text = objects::to_yaml(tricky.clone()).await?;
    let back = objects::from_yaml(text.clone()).await?;
    ensure!(back.len() == 1, "expected one document, got {}", back.len());
    for (key, want) in tricky.as_object().into_iter().flatten() {
        ensure!(back[0][key] == *want, "yaml round trip changed {key}: {want} -> {}\n{text}", back[0][key]);
    }
    ensure!(back[0] == tricky, "yaml round trip changed the document:\n{text}");
    // Every real object of a few kinds must survive YAML unchanged (read-only).
    let session = state.session(CTX).await?;
    let mut swept = 0;
    for path in [
        "/api/v1/pods",
        "/api/v1/configmaps",
        "/apis/apps/v1/deployments",
        "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations",
        "/apis/apiextensions.k8s.io/v1/customresourcedefinitions",
    ] {
        let list = session.get(path).await?;
        for item in list["items"].as_array().into_iter().flatten() {
            let back = objects::from_yaml(objects::to_yaml(item.clone()).await?).await?;
            ensure!(
                back.len() == 1 && back[0] == *item,
                "yaml round trip changed {path} {}/{}",
                item["metadata"]["namespace"],
                item["metadata"]["name"]
            );
            swept += 1;
        }
    }
    println!("[yaml] {} tricky strings (values and keys) and {swept} cluster objects round-trip", strings.len());

    // Server warnings are collected from the Warning headers.
    let deprecated = format!(
        "apiVersion: v1\nkind: Pod\nmetadata: {{name: kns-check-warn, namespace: {NS}}}\nspec:\n  \
         nodeSelector: {{beta.kubernetes.io/os: linux}}\n  containers:\n  - {{name: main, image: busybox}}\n"
    );
    let warned = mutate::apply_yaml(state, CTX, &deprecated, &ApplyOptions { dry_run: Some(true), force: None }).await?;
    println!("[apply warnings] {:?}", warned.warnings);
    ensure!(!warned.warnings.is_empty(), "no warnings collected");

    // ── configmap: apply (dry-run, real), get_yaml, patch, deltas, delete ──
    let cm = obj("", "v1", "configmaps", CM);
    let (cm_id, mut cm_rx) = subscribe(state, cm.gvr.clone(), Some(NS)).await?;
    let (_, rows) = expect_snapshot(&mut cm_rx).await?;
    println!("[table configmaps/{NS}] rows={rows}");
    let cm_yaml = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {CM}\n  namespace: {NS}\n  labels:\n    app: kns-check\n\
         data:\n  plain: hello\n  flag: \"true\"\n  octal: \"012\"\n  script: |\n    line one\n    line two\n"
    );
    let dry = mutate::apply_yaml(state, CTX, &cm_yaml, &ApplyOptions { dry_run: Some(true), force: None }).await?;
    ensure!(dry.yaml.contains(CM) && !dry.yaml.contains("managedFields"));
    ensure!(objects::get_json(state, &cm).await.is_err_and(|e| e.code == 404), "dry-run created the object");
    ensure!(
        wait_for(&mut cm_rx, 1, |e| matches!(e, TableEvent::Delta { .. }).then_some(())).await.is_err(),
        "dry-run produced a delta"
    );
    println!("[apply dry-run] ok, nothing created, no delta ({} bytes yaml)", dry.yaml.len());

    let applied = mutate::apply_yaml(state, CTX, &cm_yaml, &ApplyOptions::default()).await?;
    let uid = expect_upsert(&mut cm_rx, CM).await?;
    println!("[apply] created uid={uid} warnings={:?}; upsert delta received", applied.warnings);

    let yaml = objects::get_yaml(state, &cm, false).await?;
    ensure!(!yaml.contains("managedFields"), "managedFields not stripped");
    ensure!(objects::get_yaml(state, &cm, true).await?.contains("managedFields"));
    let parsed = objects::from_yaml(yaml.clone()).await?;
    let data = &parsed.first().ok_or_else(|| anyhow!("empty yaml"))?["data"];
    ensure!(
        *data == json!({ "plain": "hello", "flag": "true", "octal": "012", "script": "line one\nline two\n" }),
        "get_yaml changed the data: {data}\n{yaml}"
    );
    println!("[get_yaml]\n{}", yaml.trim_end().lines().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n"));
    // The edit loop: what get_yaml returns must apply unchanged.
    mutate::apply_yaml(state, CTX, &yaml, &ApplyOptions { dry_run: None, force: Some(true) }).await?;
    println!("[apply get_yaml output] ok");

    mutate::patch_object(state, &cm, &json!({ "data": { "extra": "1" } }), PatchType::Merge, None).await?;
    expect_upsert(&mut cm_rx, CM).await?;
    let patch = json!([{ "op": "add", "path": "/data/extra2", "value": "2" }]);
    mutate::patch_object(state, &cm, &patch, PatchType::Json, None).await?;
    expect_upsert(&mut cm_rx, CM).await?;
    let now = objects::get_json(state, &cm).await?;
    ensure!(now["data"]["extra"] == "1" && now["data"]["extra2"] == "2" && now["data"]["plain"] == "hello");
    println!("[patch] merge + json patch applied; upsert deltas received");

    // Coalescing: a burst of changes arrives as fewer deltas, the last one carrying the final state.
    for i in 0..10 {
        mutate::patch_object(state, &cm, &json!({ "data": { "burst": i.to_string() } }), PatchType::Merge, None).await?;
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    let mut deltas = 0;
    while let Ok(event) = cm_rx.try_recv() {
        deltas += usize::from(matches!(event, TableEvent::Delta { .. }));
    }
    ensure!((1..10).contains(&deltas), "10 patches produced {deltas} deltas");
    println!("[coalesce] 10 patches -> {deltas} deltas");

    mutate::delete_object(state, &cm, &DeleteOptions::default()).await?;
    wait_for(&mut cm_rx, 15, |e| match e {
        TableEvent::Delta { deletes, .. } => deletes.contains(&uid).then_some(()),
        _ => None,
    })
    .await
    .context("delete delta")?;
    println!("[delete] delete delta received for uid={uid}");
    ensure!(state.stop_stream(&cm_id));

    // ── deployment: scale, restart, pods_for ──
    let sh = obj("", "v1", "pods", "sh");
    let image = objects::get_json(state, &sh).await?["spec"]["containers"][0]["image"]
        .as_str()
        .ok_or_else(|| anyhow!("pod sh has no image"))?
        .to_string();
    let deploy = obj("apps", "v1", "deployments", DEPLOY);
    let deploy_yaml = format!(
        "apiVersion: apps/v1\nkind: Deployment\nmetadata: {{name: {DEPLOY}, namespace: {NS}}}\nspec:\n  replicas: 1\n  \
         selector: {{matchLabels: {{app: {DEPLOY}}}}}\n  template:\n    metadata: {{labels: {{app: {DEPLOY}}}}}\n    \
         spec:\n      terminationGracePeriodSeconds: 0\n      containers:\n      - name: main\n        image: {image}\n        \
         command: [sleep, \"3600\"]\n"
    );
    mutate::apply_yaml(state, CTX, &deploy_yaml, &ApplyOptions::default()).await?;
    mutate::scale(state, &deploy, 2).await?;
    ensure!(objects::get_json(state, &deploy).await?["spec"]["replicas"] == 2, "scale did not apply");
    mutate::restart(state, &deploy).await?;
    let restarted = objects::get_json(state, &deploy).await?["spec"]["template"]["metadata"]["annotations"]
        ["kubectl.kubernetes.io/restartedAt"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("restartedAt annotation missing"))?;
    println!("[scale] replicas=2  [restart] restartedAt={restarted}");
    let pods = poll("deployment pods", 60, async || {
        let pods = objects::pods_for(state, &deploy).await?;
        Ok((pods.len() >= 2).then_some(pods))
    })
    .await?;
    println!(
        "[pods_for deployment] {:?}",
        pods.iter().map(|p| format!("{} {} {:?}", p.name, p.phase, p.containers)).collect::<Vec<_>>()
    );

    // ── cronjob trigger ──
    let cron = obj("batch", "v1", "cronjobs", CRON);
    let cron_yaml = format!(
        "apiVersion: batch/v1\nkind: CronJob\nmetadata: {{name: {CRON}, namespace: {NS}}}\nspec:\n  schedule: \"0 0 1 1 *\"\n  \
         suspend: true\n  jobTemplate:\n    metadata: {{labels: {{app: {CRON}}}}}\n    spec:\n      ttlSecondsAfterFinished: 60\n      \
         template:\n        spec:\n          restartPolicy: Never\n          containers:\n          - name: main\n            \
         image: {image}\n            command: [\"true\"]\n"
    );
    mutate::apply_yaml(state, CTX, &cron_yaml, &ApplyOptions::default()).await?;
    let job_name = mutate::trigger_cron_job(state, &cron).await?;
    let job = objects::get_json(state, &obj("batch", "v1", "jobs", &job_name)).await?;
    ensure!(job_name.starts_with(&format!("{CRON}-manual-")) && job_name.len() == CRON.len() + 13);
    ensure!(job["metadata"]["ownerReferences"][0]["kind"] == "CronJob");
    ensure!(job["metadata"]["annotations"]["cronjob.kubernetes.io/instantiate"] == "manual");
    let pods = poll("cronjob pods", 60, async || {
        let pods = objects::pods_for(state, &cron).await?;
        Ok((!pods.is_empty()).then_some(pods))
    })
    .await?;
    println!("[trigger_cron_job] job={job_name}  [pods_for cronjob] {:?}", pods.iter().map(|p| &p.name).collect::<Vec<_>>());

    // ── pods_for: pod, job, node ──
    let own = objects::pods_for(state, &sh).await?;
    ensure!(own.len() == 1 && own[0].name == "sh" && !own[0].containers.is_empty());
    let node = own[0].node.clone().ok_or_else(|| anyhow!("pod sh has no node"))?;
    let of_job = objects::pods_for(state, &obj("batch", "v1", "jobs", &job_name)).await?;
    ensure!(of_job.len() == 1, "job has {} pods", of_job.len());
    let node_ref = ObjRef { context: CTX.into(), gvr: Gvr::new("", "v1", "nodes"), namespace: None, name: node.clone() };
    let on_node = objects::pods_for(state, &node_ref).await?;
    ensure!(on_node.iter().any(|p| p.name == "sh"));
    println!("[pods_for] pod=1 ({:?} on {node}) job={} node={}", own[0].containers, of_job.len(), on_node.len());

    // ── events ──
    let events = poll("deployment events", 30, async || {
        let events = objects::list_events(state, CTX, None, Some(&deploy)).await?;
        Ok((!events.is_empty()).then_some(events))
    })
    .await?;
    ensure!(events.iter().all(|e| e.object_name == DEPLOY && e.object_kind == "Deployment"));
    ensure!(events.windows(2).all(|w| w[0].last_seen >= w[1].last_seen), "events not sorted newest first");
    let first = &events[0];
    println!(
        "[list_events object] {} events; newest: {} {} {:?} count={} source={} at {:?}",
        events.len(),
        first.type_,
        first.reason,
        first.message,
        first.count,
        first.source,
        first.last_seen
    );
    let in_ns = objects::list_events(state, CTX, Some(NS), None).await?;
    let all = objects::list_events(state, CTX, None, None).await?;
    ensure!(in_ns.len() >= events.len() && all.len() >= in_ns.len());
    ensure!(in_ns.iter().all(|e| e.namespace.as_deref() == Some(NS)));
    println!("[list_events] namespace={} cluster={}", in_ns.len(), all.len());

    // ── secret ──
    let secret_yaml = format!(
        "apiVersion: v1\nkind: Secret\nmetadata: {{name: {SECRET}, namespace: {NS}}}\ntype: Opaque\n\
         data:\n  text: aGVsbG8gd29ybGQ=\n  binary: //79\n"
    );
    mutate::apply_yaml(state, CTX, &secret_yaml, &ApplyOptions::default()).await?;
    let decoded = objects::decode_secret(state, &obj("", "v1", "secrets", SECRET)).await?;
    println!("[decode_secret] {}", serde_json::to_string(&decoded)?);
    ensure!(decoded.get("text") == Some(&Some("hello world".to_string())) && decoded.get("binary") == Some(&None));

    // ── metrics ──
    let pod_metrics = metrics::pod_metrics(state, CTX, None).await?;
    let spike_metrics = metrics::pod_metrics(state, CTX, Some(NS)).await?;
    let node_metrics = metrics::node_metrics(state, CTX).await?;
    println!("[pod_metrics] all={} {NS}={} sample={:?}", pod_metrics.len(), spike_metrics.len(), pod_metrics.first());
    println!("[node_metrics] {node_metrics:?}");
    if info.has_metrics {
        ensure!(!pod_metrics.is_empty() && spike_metrics.iter().all(|m| m.namespace == NS));
        ensure!(pod_metrics.iter().any(|m| m.mem_bytes > 0));
        ensure!(node_metrics.iter().all(|n| n.cpu_alloc_milli > 0 && n.mem_alloc_bytes > 0 && n.mem_bytes > 0));
    }

    // ── rbac ──
    let access = |verb: &str, gvr: Gvr, subresource: Option<&str>| AccessQuery {
        context: CTX.into(),
        verb: verb.into(),
        gvr,
        subresource: subresource.map(str::to_string),
        namespace: Some(NS.into()),
        name: None,
    };
    let get_pods = rbac::can_i(state, &access("get", Gvr::new("", "v1", "pods"), None)).await?;
    let exec_pods = rbac::can_i(state, &access("create", Gvr::new("", "v1", "pods"), Some("exec"))).await?;
    let t = Instant::now();
    let cached = rbac::can_i(state, &access("get", Gvr::new("", "v1", "pods"), None)).await?;
    println!("[can_i] get pods={get_pods} create pods/exec={exec_pods} cached={cached} in {:?}", t.elapsed());
    ensure!(get_pods && cached && t.elapsed() < Duration::from_millis(5));

    // ── review fixes ──
    // Concurrent first uses of a context share one session build.
    let fresh = AppState::default();
    let built = futures::future::join_all((0..8).map(|_| fresh.session(CTX))).await;
    let first = built[0].clone()?;
    ensure!(built.iter().all(|s| s.as_ref().is_ok_and(|s| std::sync::Arc::ptr_eq(s, &first))), "sessions built more than once");
    let missing = fresh.session("kns-no-such-context").await.err().map(|e| e.reason);
    ensure!(missing.as_deref() == Some("Config"), "unknown context: {missing:?}");
    println!("[session] 8 concurrent first calls share one session; unknown context -> {missing:?}");

    // YAML fetched with managedFields can be applied again; legacy octals are read like kubectl does.
    let mf = obj("", "v1", "configmaps", MF);
    let yaml = format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {MF}\n  namespace: {NS}\ndata:\n  mode: \"0644\"\n");
    mutate::apply_yaml(state, CTX, &yaml, &ApplyOptions::default()).await?;
    let with_fields = objects::get_yaml(state, &mf, true).await?;
    ensure!(with_fields.contains("managedFields"), "get_yaml(managedFields) has none");
    let again = ApplyOptions { dry_run: Some(true), force: Some(true) };
    let applied = mutate::apply_yaml(state, CTX, &with_fields, &again).await.context("apply of YAML with managedFields")?;
    ensure!(!applied.yaml.contains("managedFields") && applied.yaml.contains("mode: \"0644\""), "unexpected result:\n{}", applied.yaml);
    let pod = format!(
        "apiVersion: v1\nkind: Pod\nmetadata:\n  name: kns-check-octal\n  namespace: {NS}\nspec:\n  containers:\n  - name: c\n    image: busybox\n  volumes:\n  - name: v\n    configMap:\n      name: {MF}\n      defaultMode: 0644\n"
    );
    let dry = ApplyOptions { dry_run: Some(true), force: None };
    let octal = mutate::apply_yaml(state, CTX, &pod, &dry).await.context("dry-run apply with defaultMode: 0644")?;
    ensure!(octal.yaml.contains("defaultMode: 420"), "0644 was not read as octal:\n{}", octal.yaml);
    println!("[apply] YAML with managedFields re-applies (dry-run); `defaultMode: 0644` -> 420, \"0644\" stays a string");

    // A request the server rejects is a final `error`, not an endless reconnect.
    let (tx, mut rx) = unbounded_channel();
    let query = TableQuery {
        context: CTX.into(),
        gvr: Gvr::new("", "v1", "pods"),
        namespace: Some(NS.into()),
        label_selector: Some("app in (".into()),
        field_selector: None,
    };
    table::subscribe_table(state, query, FnSink(move |e| tx.send(e).is_ok())).await?;
    let rejected = wait_for(&mut rx, 15, |e| match e {
        TableEvent::State { state: WatchState::Syncing, .. } => None,
        other => Some(format!("{other:?}")),
    })
    .await?;
    ensure!(rejected.contains("Error"), "bad selector gave {rejected}");
    ensure!(matches!(tokio::time::timeout(Duration::from_secs(2), rx.recv()).await, Ok(None)), "stream did not end after the error");
    println!("[table] invalid label selector -> {rejected}, stream ended");

    // A resource without watch (metrics) stays live and is listed again instead of `reconnecting`.
    if info.has_metrics {
        let (id, mut rx) = subscribe(state, Gvr::new("metrics.k8s.io", "v1beta1", "pods"), Some(NS)).await?;
        let (columns, rows) = expect_snapshot(&mut rx).await?;
        let t = Instant::now();
        let next = wait_for(&mut rx, 20, |e| match e {
            TableEvent::Snapshot { rows, .. } => Some(Ok(rows.len())),
            other => Some(Err(format!("{other:?}"))),
        })
        .await?;
        let again = next.map_err(|e| anyhow!("metrics table: expected a second snapshot, got {e}"))?;
        ensure!(state.stop_stream(&id));
        println!("[table] metrics pods (no watch): {rows} rows {columns:?}, still live, relisted after {:?} ({again} rows)", t.elapsed());
    }

    // Page (re)load: every stream is stopped.
    let (_, mut pods_rx) = subscribe(state, Gvr::new("", "v1", "pods"), Some(NS)).await?;
    let (_, mut cm_rx) = subscribe(state, Gvr::new("", "v1", "configmaps"), Some(NS)).await?;
    expect_snapshot(&mut pods_rx).await?;
    expect_snapshot(&mut cm_rx).await?;
    ensure!(state.stop_all_streams() == 2 && state.stream_count() == 0);
    for rx in [&mut pods_rx, &mut cm_rx] {
        let ended = tokio::time::timeout(Duration::from_secs(3), async { while rx.recv().await.is_some() {} }).await;
        ensure!(ended.is_ok(), "a table stream survived stop_all_streams");
    }
    println!("[streams] stop_all_streams ended both table streams");

    // ── persisted state ──
    let dir = std::env::temp_dir().join(format!("kns-core-check-{}", std::process::id()));
    let value = json!({ "panes": [{ "kind": "table", "gvr": "pods" }], "theme": "dark", "n": 3 });
    store::save_state(&dir, "layout", &value).await?;
    store::save_state(&dir, "layout", &value).await?;
    ensure!(store::load_state(&dir, "layout").await? == value);
    ensure!(store::load_state(&dir, "missing").await? == Json::Null);
    store::save_state(&dir, "../escape/x", &json!(1)).await?;
    ensure!(dir.join(".._escape_x.json").is_file(), "key was not sanitised");
    ensure!(store::save_state(&dir, "..", &json!(1)).await.is_err() && store::load_state(&dir, "").await.is_err());
    ensure!(store::save_state(&dir, "CON", &json!(1)).await.is_err(), "a device name was accepted as key");
    // Saves issued together: none fails, and the file holds one of the values, whole.
    let saves = futures::future::join_all((0..20).map(|n| { let dir = dir.clone(); async move { store::save_state(&dir, "race", &json!({ "n": n })).await } })).await;
    ensure!(saves.iter().all(Result::is_ok), "concurrent saves failed: {saves:?}");
    ensure!(store::load_state(&dir, "race").await?["n"].is_u64(), "concurrent saves left a broken file");
    std::fs::remove_file(dir.join("race.json"))?;
    let files: Vec<_> = std::fs::read_dir(&dir)?.filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
    println!("[state] round-trip ok, files={files:?}");
    ensure!(files.len() == 2, "temp files left behind");
    std::fs::remove_dir_all(&dir)?;

    ensure!(state.stream_count() == 0, "{} streams left in the registry", state.stream_count());
    Ok(())
}

/// Deletes everything `check` may have created. Jobs and pods go with their owners.
async fn cleanup(state: &AppState) -> anyhow::Result<()> {
    let opts = DeleteOptions { propagation: Some(Propagation::Background), grace_period_seconds: Some(0) };
    let mut failed = Vec::new();
    for target in [
        obj("", "v1", "configmaps", CM),
        obj("apps", "v1", "deployments", DEPLOY),
        obj("batch", "v1", "cronjobs", CRON),
        obj("", "v1", "secrets", SECRET),
        obj("", "v1", "configmaps", MF),
    ] {
        match mutate::delete_object(state, &target, &opts).await {
            Ok(()) => println!("[cleanup] deleted {}/{}", target.gvr.resource, target.name),
            Err(e) if e.code == 404 => {}
            Err(e) => failed.push(format!("{}: {e}", target.name)),
        }
    }
    if !failed.is_empty() {
        bail!("cleanup failed: {failed:?}");
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let state = AppState::default();
    let started = Instant::now();
    let result = check(&state).await;
    let cleaned = cleanup(&state).await;
    match (result, cleaned) {
        (Ok(()), Ok(())) => println!("CORE CHECK PASSED in {:?}", started.elapsed()),
        (result, cleaned) => {
            for e in [result.err(), cleaned.err()].into_iter().flatten() {
                println!("CORE CHECK FAILED: {e:#}");
            }
            std::process::exit(1);
        }
    }
}
