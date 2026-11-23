# k9s inventory critique (checked against source)

The inventory is broadly right on structure but wrong on about a dozen key letters. It read lowercase `ui.KeyX` constants as shifted; `KeyShiftX` is a separate constant.

**Method.** Shallow clone of `derailed/k9s` master at `c732946` (2026-11-21), diffed against tag `v0.51.0` (latest release, 2026-06-06). All key bindings cited below are identical on tag and master unless marked *master-only*.

Source links use `B/` = `https://github.com/derailed/k9s/blob/c732946a6da348ad1b4fdabd6b9bd0f8cd2d3804/`. Release notes: https://github.com/derailed/k9s/releases/tag/v0.51.0

**Not checked:** connection-health numbers (15s, 2 min, `maxConnRetry`), the v0.40.x/v0.50.0 attributions for custom columns, and full column lists (my grep skipped columns named via constants like `colName`).

## (a) Missing from the inventory

**Navigation and prompt**
- Vim navigation: `g` top, `G` bottom, `ctrl-b`/`ctrl-f` page up/down, `h j k l` (`B/internal/view/help.go` L164-205).
- `ctrl-u` and `ctrl-q` clear the filter; `ctrl-p` persists the current context config; `ctrl-r` at app level is a redraw (`B/internal/ui/app.go` L145-150).
- Prompt keys: `tab`/`right`/`ctrl-f` accept a suggestion, `up`/`down` cycle suggestions, `ctrl-w`/`ctrl-u` clear the line (`B/internal/ui/prompt.go` L152-185).
- Command synonyms (`B/internal/view/cmd/types.go`):
  - quit: `q`, `q!`, `qa`, `Q`, `quit`, `exit`
  - help: `?`, `h`, `help`
  - aliases: `a`, `alias`, `aliases`
  - xray: `x`, `xr`, `xray`
  - dir: `dir`, `dirs`, `d`, `ls`
  - context: `ctx`, `context`, `contexts`
  - namespace: `ns`, `namespace`, `namespaces`
- Pulses also answers to `hz` (`B/internal/dao/registry.go` L198-201).
- Alias view sorts: `shift-r` resource, `shift-c` command, `shift-a` API group (`B/internal/view/alias.go` L53-56).

**Dialogs**
- Delete: propagation dropdown Background (default), Foreground, Orphan, None, plus a Force checkbox (`B/internal/ui/dialog/delete.go`).
- Restart: has a `FieldManager` input (`B/internal/ui/dialog/restart.go` L40).
- Transfer: Download checkbox, From, To, NoPreserve, Container, Retries (`B/internal/ui/dialog/transfer.go`).
- Generic dialogs: typed-confirm, error, prompt, and a modal list picker (`B/internal/ui/dialog/`, `B/internal/view/picker.go`).

**Extender matrix (which views get which action)**

| View | Logs | Owner jump | Set image | Scale | Restart | Port-forward |
|---|---|---|---|---|---|---|
| Pod | yes | yes | yes | no | no | yes |
| Deployment | yes | yes | yes | yes | yes | yes |
| StatefulSet | yes | yes | yes | yes | yes | yes |
| DaemonSet | yes | yes | yes | no | yes | yes |
| Service | yes | yes | no | no | no | yes |
| Job | yes | yes | no | no | no | no |
| Any other GVR, incl. CRDs | no | yes | no | if it has a scale subresource | no | no |

- The inventory omitted port-forward on Deployment, StatefulSet and DaemonSet.
- Sources: `B/internal/view/dp.go` L27-33, `ds.go` L23-28, `sts.go` L23-29, `pod.go` L53-57, `svc.go` L38-40, `job.go` L28-29, `command.go` L326.

**Views and rendering**
- Dedicated renderer files exist for NetworkPolicy, PV, PVC, StorageClass, PDB, HPA, Endpoints, EndpointSlice and the four RBAC kinds (`B/internal/render/`). For example NetworkPolicy has ING/EGR selector, ports and block columns; PDB has MIN-AVAILABLE, MAX-UNAVAILABLE, ALLOWED-DISRUPTIONS.
- Delta indicators on changed cells: `Δ`, `↑`, `↓` (`B/internal/ui/deltas.go`).
- TUI chrome: flash messages, menu hints, crumbs, logo status, splash, and a log indicator bar showing Autoscroll/ColumnLock/FullScreen/Timestamps/Wrap/AllContainers state (`B/internal/ui/`, `B/internal/view/log_indicator.go`).
- The help view lists user hotkeys alongside built-ins (`help.go` L223).
- v0.51.0 notes items not in the inventory:
  - "syncing" status instead of a false "no resources" warning (#3993)
  - sidecar init-container pod status (#4005)
  - selected-column header colour (#3780)
  - plugins with inputs default to `confirm: true` (#3872)
  - Windows NanoServer shell detection (#3634)

**Config and hot reload**
- fsnotify watchers hot-reload `views.yaml`, `jumps.yaml` and the skins directory (`B/internal/ui/config.go` L62-154).
- `imageScans.exclusions` takes `namespaces` and `labels` (`B/internal/config/scans.go`).
- `shellPod` also has `command`, `args`, `namespace`, `labels`, `imagePullSecrets`, `imagePullPolicy` (`B/internal/config/shell_pod.go`).
- `portForwardAddress` is a top-level config key (`B/internal/config/k9s.go` L46).
- Env vars: `K9S_EDITOR` (listed before `KUBE_EDITOR` and `EDITOR` in `B/internal/view/exec.go` L44), `KUBECACHEDIR`, `KUBECONFIG`.

**CLI flags** (`B/cmd/root.go` L207-390)
- UI: `--refresh`, `--headless`, `--logoless`, `--crumbsless`, `--splashless`, `--invert`, `--screen-dump-dir`.
- Scope and mode: `--all-namespaces`, `--command`, `--write` (overrides read-only).
- Connection: `--kubeconfig`, `--request-timeout`, `--cluster`, `--user`, `--token`, `--insecure-skip-tls-verify`, `--certificate-authority`, `--client-key`, `--client-certificate`.
- Impersonation: `--as`, `--as-group`.

**Bundled content**
- About 60 community plugins in `B/plugins/`, including debug-container, pvc-debug-container, pvc-resize, remove-finalizers, helm-diff, helm-values, log-stern, watch-events and node-root-shell.
- `B/plugins/flux.yaml` matters for this user:
  - `Shift-T` suspend/resume HelmRelease, Kustomization, ResourceSet and others
  - `Shift-R` and `Shift-Z` reconcile
  - `Shift-Q` flux trace
  - `Shift-S` list suspended
- 43 bundled skins in `B/skins/`.

## (b) Wrong claims

| Inventory claim | Actual | Source |
|---|---|---|
| Scale is `S` in source; README `s` is wrong | Scale is `s`. README is right. | `B/internal/view/scale_extender.go` L48 |
| CronJob suspend is `S` | `s` | `cronjob.go` L87 |
| File transfer `shift-t`, sanitize `shift-z`, show node `shift-o` | `t`, `z`, `o`. `shift-o` is sort by selected column. | `pod.go` L109, L116, L132; `table.go` L238 |
| Helm rollback `R`; "DAO has no rollback method" | `r` ("RollBackTo..."). `HelmHistory.Rollback` exists. | `helm_history.go` L83; `B/internal/dao/helm_history.go` L138 |
| Helm values toggle `V` | `v` opens values, and `v` again toggles all/user values | `value_extender.go` L35, L74 |
| Image scans on `V`; scanner "probably Trivy" | `v` shows vulnerabilities, `shift-v` sorts by VS. Scanner is Anchore grype + syft. Columns: SEVERITY, VULNERABILITY, IMAGE, LIBRARY, FIXED-IN. | `vul_extender.go` L31-32; `B/go.mod` L8-9 |
| DaemonSets have scale | No scale extender on DaemonSet | `ds.go` L23-28 |
| Cordon key open (`c` vs `u`) | Source: `c` cordon, `u` uncordon, `r` drain. The README row is stale. | `node.go` L45-61 |
| Xray expand/collapse "none bound" | `space` toggles a node, `x` toggles all | `B/internal/ui/tree.go` L94-96 |
| `shift-p` namespace sort is "README only" | In source; bound only when viewing all namespaces | `B/internal/ui/table.go` L443-449 |
| `:can <u\|g\|s> <name>` | Syntax is `:can u:name` (regex `^can\s+([ugs]):\s*([\w-:]+)`) | `cmd/types.go` L36 |
| Used-by: "Jobs not mentioned" | Jobs are scanned. Scanners: Pod, Deployment, DaemonSet, StatefulSet, Job, CronJob. No ReplicaSet. | `B/internal/dao/job.go` L137 |
| Workload columns GVR, READINESS, VALIDITY | KIND, NAMESPACE, NAME, STATUS, READY, VALID (wide), AGE | `B/internal/render/workload.go` L18-24 |
| "Everything else uses the server Table" incl. NetworkPolicy, PV, StorageClass, HPA, PDB | These have dedicated renderer files. Ingress has none, so it is generic. I did not confirm registry wiring for each. | `B/internal/render/` |
| Users/Groups derivation unverified | Subjects of the given kind are collected from ClusterRoleBindings (`listClusterRoleBindings`; RoleBindings not checked). Column FIRST LOCATION. `Enter` opens the policy view. | `B/internal/dao/rbac_subject.go`; `user.go` L32 |
| "v0.50.x ran Apr to Oct 2025" | v0.50.17 and v0.50.18 shipped 2026-01-11 | `gh release list` |
| `logger.logBufferSize` and per-context `logo` listed as shipped | Master-only; not in v0.51.0 | `git diff v0.51.0 HEAD` |
| Read-only hides everything dangerous | In v0.51.0, CronJob trigger and suspend are **not** gated by read-only. The gate was added on master. | `cronjob.go` diff |
| Node shell pod named `k9s_shell` | Container name is `k9s-shell` | `exec.go` L309 |
| Helm, PF, Context columns unverified | Helm: NAMESPACE, NAME, REVISION, STATUS, CHART, APP VERSION, VALID (wide), AGE. History: REVISION, STATUS, CHART, APP VERSION, DESCRIPTION. PF: NAMESPACE, NAME, CONTAINER, PORTS, URL, C, N. Context: NAME, CLUSTER, AUTHINFO, NAMESPACE. | `B/internal/render/helm/`, `portforward.go`, `context.go` L39-42 |

**Confirmed as stated:**
- Popeye appears only in the README; there is no popeye code in the tree.
- Describe uses kubectl's `describe.Describer` with `ShowEvents: true` (`B/internal/dao/describe.go` L48-57).
- Head uses `limitBytes=5000` (`B/internal/dao/log_options.go` L92).
- RS rollback uses `polymorphichelpers.RollbackerFor` and rejects an RS with non-zero replicas (`B/internal/dao/rs.go` L60-124).
- Xray accepts only po, svc, dp, ds, sts, rs (`command.go` L89-96).
- Pulse resources are node, ns, svc, ev, pod, dp, sts, ds, job, cj, pv, pvc, hpa (`B/internal/model/pulse_health.go` L26-42).
- Benchmarks use `rakyll/hey`; Helm uses the v3 SDK; custom columns use `gojq`.

**Internally inconsistent:** section 4 says set-image is a "strategic merge patch" built by `GetTemplateJsonPatch`. The name suggests a JSON patch; I did not read it.

## (c) Tiering for a GUI clone

Weighted for one user on k3s with Flux. Several TUI features turn into ordinary GUI affordances (noted in brackets).

**P0: v1, daily use**
- Kubeconfig load, context list and switch, namespace switch, favourites, all-namespaces.
- Discovery-driven resource browser for every GVR including CRDs, with server-side Table columns as the fallback; this is what makes Flux CRDs (Kustomization, HelmRelease, sources) browsable.
- Watch-backed live tables with rich columns for Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, Service, Node, Namespace, Event, ConfigMap, Secret, PVC, PV, Ingress.
- Table mechanics: sort by any column, regex/inverse/fuzzy filter, label-selector filter, multi-select [checkboxes], copy name/namespace, faults-only toggle, refresh.
- Command palette with alias resolution and autocomplete (`:pod ns`, `:pod app=x`, `:pod /x`), plus back/forward history [also sidebar and breadcrumbs].
- Describe, live YAML view (managedFields toggle, search), and edit [in-app editor with apply].
- Delete with propagation and force; kill pod.
- Logs: follow, previous, tail, since windows, timestamps, wrap, filter, mark, clear, copy, save, all-containers, and workload logs via selector [add a container picker].
- Shell into a container with a container picker [xterm.js].
- Drill-downs: workload to pods, pod to containers, deployment to ReplicaSets, cronjob to jobs, node to pods, service to pods, jump to owner.
- Scale, rollout restart, CronJob trigger and suspend/resume.
- Secret decode.
- Port-forward start, list, stop.
- Metrics columns for pods and nodes when metrics-server exists; cluster info header.
- Events view with warning filter.
- Connection health with reconnect.
- RBAC-gated actions via `SelfSubjectAccessReview`; read-only mode.
- Flux suspend/resume and reconcile as native actions. In k9s this is a bundled plugin; for this user it is daily use.

**P1: important**
- Helm releases: list, history, values (all/user), notes, manifest, rollback, uninstall.
- Set image; ReplicaSet rollback.
- Used-by references for Secret, ConfigMap, PVC, ServiceAccount, PriorityClass.
- Node cordon, uncordon, drain with options and progress.
- Attach; file transfer to and from a pod.
- Sanitize completed/failed pods.
- Workload view (`:wk`); CRD view with drill-in.
- Wide-column toggle [column chooser]; custom columns (`views.yaml`-style, jq expressions); save table to CSV.
- Custom aliases; hotkeys; custom jumps (`jumps.yaml`).
- Port-forward annotations (auto and preselect); duplicate guard.
- Pulses dashboard.
- Xray tree.
- RBAC rules view for roles and bindings.
- Dedicated columns for NetworkPolicy, StorageClass, PDB, HPA, Endpoints, EndpointSlice.
- Delta indicators on changed cells; per-context settings persistence.
- Flux trace and a suspended-resources filter.
- Theme: light and dark.

**P2: later or niche**
- Plugins system (shell-out with env vars and inputs) and the bundled plugin set.
- Node shell (privileged shell pod).
- `:can` subject policy, Users and Groups views; impersonation (`--as`).
- Image vulnerability scans (grype/syft are Go; would need an external binary).
- Benchmarks (`hey`), benchmark config and results view.
- Dir view (apply/delete manifests from disk).
- Screen-dump browser view.
- Full skin system and 43 skins; logo, splash, crumbs/header toggles, `noIcons`, `invert`.
- OSC52 clipboard, version check, `k9s info`, most CLI flags.
- Popeye: skip; it is dead upstream.
- Mouse config, vim key parity beyond basics, cow.

Source checkout used: a temporary local clone of the k9s repository