# kns — architecture

Stack: **Tauri 2** (Rust backend, system webview) + **React 19 / TypeScript / Vite** frontend.
Kubernetes access: **kube-rs 5.1** (`kube` with `ws`, `gzip`), `k8s-openapi 0.29`.
Why: startup time and memory are the top criterion (see `requirements.md`). Verified by a spike against the
real k3s (v1.35): kubeconfig auth + k3s CA over rustls, server-side Table list + watch (also Flux CRDs),
aggregated discovery, log follow, exec, port-forward (`src-tauri/examples/spike.rs`).

## Process model

```
React UI (webview)  ──invoke()──▶  Rust commands   ──▶ kube-rs ──▶ API server
        ▲                               │
        └────── tauri::ipc::Channel ────┘   (tables, logs, exec)
```

- The webview never sees kubeconfigs or tokens. All cluster text is untrusted: no `innerHTML`.
- **The IPC contract is `src/ipc/types.ts`** (`Backend` interface). `src/ipc/tauri.ts` maps it to commands;
  `src/ipc/mock.ts` implements it in memory so the UI runs in a plain browser (`pnpm dev`).
- Rust mirrors the types in `src-tauri/src/ipc.rs` (`#[serde(rename_all = "camelCase")]`, enums `#[serde(tag = "type", rename_all = "camelCase")]`).
- Errors: every command returns `Result<T, BackendError>` where `BackendError {code, reason, message}` is serializable.

## Rust layout (`src-tauri/src`)

| File | Owns |
|---|---|
| `lib.rs` | Tauri builder, state registration, `generate_handler!` with every command |
| `ipc.rs` | Contract types (mirror of `types.ts`) and `BackendError` (+ `From<kube::Error>`) |
| `state.rs` | `AppState`: sessions per context, stream registry (`id -> CancellationToken`/handles), forwards |
| `session.rs` | kubeconfig loading (KUBECONFIG split on platform delimiter, else `~/.kube/config`), `Session {client, info, discovery cache}` per context, lazily built and cached |
| `discovery.rs` | Aggregated discovery (`/api` + `/apis` with `as=APIGroupDiscoveryList`), legacy fallback, `ApiResource` list incl. subresources; preferred version per group/kind |
| `table.rs` | `subscribe_table`: paginated Table list (`limit=500` + `continue`) then Table watch; reconnect/backoff; 410 → relist; coalescing |
| `objects.rs` | `get_yaml`, `get_json`, `list_events`, `pods_for`, `decode_secret` |
| `mutate.rs` | `apply_yaml` (server-side apply, fieldManager `kns`, dry-run, force), `delete_object`, `patch_object`, `scale`, `restart`, `trigger_cron_job` |
| `metrics.rs` | `pod_metrics`, `node_metrics` (quantity parsing) |
| `logs.rs` | `stream_logs` |
| `exec.rs` | `exec_start`, `exec_write`, `exec_resize` |
| `forward.rs` | `start_forward`, `list_forwards`, `stop_forward` |
| `rbac.rs` | `can_i` (SelfSubjectAccessReview, cached ~60 s) |
| `store.rs` | `load_state`, `save_state` (JSON files `<app_config_dir>/<key>.json`, atomic write, key sanitised) |

`stop_stream(id)` cancels any table/log/exec stream.

## Rules for the backend

**Generic access.** Everything is addressed by `Gvr` + namespace + name and goes through raw requests
(`client.request_text(http::Request)`, `client.request_stream`) or `Api<DynamicObject>` with an `ApiResource`
built from the Gvr. No per-kind typed code except where needed (pods for logs/exec, metrics).
Path helper: core group → `/api/{version}`, others → `/apis/{group}/{version}`; `namespaces/{ns}/` when namespaced and ns non-empty.

**Tables.** `Accept: application/json;as=Table;g=meta.k8s.io;v=v1, application/json`, `includeObject=Metadata`.
- On watch each event is a one-row Table; `columnDefinitions` are only on the first event — reuse the list's columns.
- `Row` is built from `rows[i].cells` + `rows[i].object.metadata` (uid, name, namespace, creationTimestamp,
  deletionTimestamp, labels, ownerReferences).
- Emit `state: syncing` → `snapshot` (all rows; one message, the UI virtualizes) → `state: live` → `delta`s.
- **Coalesce**: buffer watch events in a map keyed by uid and flush at most every **100 ms** (or at 500 buffered
  rows). A delete for a uid replaces a pending upsert. Never drop a delete.
- Watch params: `watch=1&resourceVersion=RV&allowWatchBookmarks=true&timeoutSeconds=300`. Track RV from every
  event incl. BOOKMARK. Normal timeout → rewatch from last RV. `410 Gone` (HTTP or ERROR event) → relist and emit
  a fresh snapshot. Other errors → `state: reconnecting`, backoff 800 ms ×2 capped 30 s with jitter. 403 →
  `state: forbidden` and stop. 404 → `state: error` and stop.
- If the server answers a list with plain JSON (no Table), fall back to columns Name + Age.
- A subscription ends when `stop_stream` is called or the Channel send fails (webview gone).

**Sessions.** One `kube::Client` per context, cached. `connect` returns `ClusterInfo` (server version via
`apiserver_version`, `hasMetrics` from discovery). Exec-credential plugins work through kube-rs; on Windows make
sure no console window flashes.

**Logs.** One task per (pod, container): `Api<Pod>::log_stream` with `timestamps=true` always. Split the leading
RFC3339 timestamp into `ts`. Batch lines per stream and flush every 100 ms or 500 lines. Cap line length at
16 KiB. Emit `end` / `error` per target. `previous`, `tailLines`, `sinceSeconds`, `follow` map 1:1.

**Exec.** `Api<Pod>::exec`/`attach` with `AttachParams` (tty, stdin, stdout, stderr = !tty). Empty `command`
→ `["sh","-c","command -v bash >/dev/null 2>&1 && exec bash || exec sh"]`. Output is forwarded as base64 `data`
events (batch small reads, flush ≤ 16 ms). `exec_write(id, data)` writes UTF-8 to stdin; `exec_resize` sends
`TerminalSize`; send the initial size right after start. On process end emit `exit` with the status.

**Port-forward.** `TcpListener` on `address:localPort` (0 = free port); per accepted connection open
`Api<Pod>::portforward(pod, &[remote])` and `copy_bidirectional`. Track connection count. Stop = cancel listener +
connections. Bind errors are returned as `BackendError` (reason `AddrInUse`).

**Mutations.**
- `apply_yaml`: multi-document YAML allowed; for each doc resolve Gvr via discovery from apiVersion/kind; SSA
  `PATCH` with `fieldManager=kns`, `force` from opts, `dryRun=All` when requested; strip `metadata.managedFields`
  from the returned YAML. Collect `Warning` response headers if reachable, else `[]`.
- `delete_object`: `DeleteParams` from opts (propagation, grace period).
- `patch_object`: merge or JSON patch, optional subresource.
- `scale`: merge patch `{"spec":{"replicas":N}}` on the `scale` subresource.
- `restart`: merge patch `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] = now (RFC3339)`.
- `trigger_cron_job`: create a Job from `spec.jobTemplate`, name `<cj>-manual-<5 random chars>`, ownerReference to
  the CronJob, annotation `cronjob.kubernetes.io/instantiate: manual`; returns the Job name.

**Objects.** `get_yaml` strips `managedFields` unless asked. `list_events`: core `events` with
`fieldSelector=involvedObject.uid=<uid>` (or name/kind/namespace) sorted newest first. `pods_for`: pod → itself;
deploy/sts/ds/rs/job → pods by `spec.selector.matchLabels`(+matchExpressions) in the namespace; cronjob → pods of
its jobs; service → `spec.selector`; node → `fieldSelector=spec.nodeName=`. `decode_secret`: base64-decode
`data`, `null` for non-UTF-8 values.

**Metrics.** `metrics.k8s.io/v1beta1` pods/nodes via raw request; parse quantities (`n`, `u`, `m`, `Ki`, `Mi`, `Gi`, …).
Node allocatable from the core nodes list. If the API is absent return an empty list, not an error.

## Frontend layout (`src`)

| Dir | Owns |
|---|---|
| `ipc/` | contract, tauri + mock backends |
| `styles/` | semantic tokens, the theme palette (`claude.css`), base CSS; fonts come from `@fontsource` |
| `keys/` | keymap registry, key matching (by produced character), scopes, dispatcher |
| `store/` | zustand stores: cluster (contexts, discovery), layout (pane tree), favorites, settings |
| `panes/` | pane tree, dividers, focus/resize/zoom, pane header |
| `table/` | virtualized resource table, columns, sort/filter/marks, status rendering |
| `views/` | describe, yaml/edit, logs, shell, port-forwards, events, help, settings |
| `palette/` | command palette, `:` grammar, resource aliases |
| `actions/` | action registry (id, label, scope, availability, run) used by keys, palette, menus |
| `ui/` | primitives: Button, Dialog, Input, Toast, KeyChip, Tabs, Node glyphs |

UX and visual spec: `docs/ux.md`. Requirements: `docs/requirements.md`.

## Build & release

- Dev: `pnpm tauri dev`. UI only: `pnpm dev` (mock backend) at http://localhost:1420.
- Checks: `pnpm typecheck`, `pnpm test`, `cargo clippy`/`cargo test` in `src-tauri`.
- CI: GitHub Actions matrix (windows-latest, macos-latest) with `tauri-action` → NSIS installer + `.dmg`.
  macOS builds are unsigned and not hand-tested (no Mac available); WKWebView differs from WebView2.
