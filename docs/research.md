> **DECISION UPDATE (2026-11-21, supersedes §4, §7 and the Electron-specific parts of §5/§8).**
> This research was run with "no Go/Rust toolchain" as a cost. Afterwards the owner made
> "lightning fast, feels native" the top criterion and approved installing a toolchain.
> **Chosen stack: Tauri 2 + Rust backend (kube-rs) + React/TypeScript frontend.**
> Authoritative docs: `docs/requirements.md`, `docs/architecture.md`, `docs/ux.md`.
> §2 (k9s inventory), §3 (GUI lessons), the Kubernetes API semantics in §5 and the
> keymap in §6.3 still apply. Visual tokens in §6.5/§6.6 are superseded by `docs/ux.md`.

# k9s-style desktop GUI: research (2026-11-21)

Synthesis of six research inputs: k9s inventory, source-level critique, GUI survey, stack comparison, adversarial stack review, K8s API deep-dive, UX spec. Where inputs conflict, the later/source-checked one wins. Nothing was re-researched or run against the cluster in this synthesis. `[unverified]` = from recall or a secondary source; `[verify]` = test before relying on it.

## 1. Goal & niche

**Goal.** Cross-platform (Windows + macOS) desktop app with k9s's grammar and feature set and a polished GUI. One user, personal k3s cluster, Flux.

**Gap in the market.**
- Mouse-first Lens clones: Freelens, Headlamp.
- Tauri apps with a palette and some hotkeys: JET Pilot, Kubeli (OSS); Aptakube, Kunobi (proprietary).
- Only Kore is k9s-shaped: 7 stars, 10 resource types, GPUI toolkit.
- Nobody combines: true k9s grammar (`:` commands, `/` filter, single-key row actions, same aliases) + GUI strengths (log viewer, splits, YAML diff) + open source, local-first, no account + Flux-aware.

**Differentiators, in priority order.**
1. Keyboard-complete: k9s-compatible `:` bar and aliases, `/` filter, single-key actions, `?` overlay, remappable keys.
2. Fast start, watch-based live tables, virtualized.
3. Flux-first: Kustomization/HelmRelease status, reconcile, suspend/resume as native actions (in k9s this is a bundled plugin).
4. Strong log viewer: workload-wide follow, container picker, search that does not hide lines.
5. Docked terminal (pod exec), port-forward manager.
6. YAML edit with diff + server dry run; every CRD browsable via server Table columns.
7. Guardrails: read-only mode, protected contexts, confirm tiers.
8. No account, no telemetry, robust kubeconfig and exec-plugin auth.

**Tiered down for this user.** Multi-cluster merged tables (a survey top differentiator) are not P0 with one cluster. The per-context session bundle (section 5.1) keeps it possible later.

## 2. k9s feature inventory (tiered)

**Baseline.** k9s v0.51.0 (2026-06-06) is the latest release; v0.50.17 and v0.50.18 shipped 2026-01-11. Go, Apache-2.0. Keys below were checked against source at master `c732946` and are identical on tag v0.51.0 unless marked master-only.
Sources: https://github.com/derailed/k9s , https://k9scli.io/topics/commands/ , https://github.com/derailed/k9s/releases/tag/v0.51.0 , source base `https://github.com/derailed/k9s/blob/c732946a6da348ad1b4fdabd6b9bd0f8cd2d3804/` (paths below are relative to it).

**Corrections applied over the first-pass inventory** (it misread lowercase `ui.KeyX` as shifted):

| Topic | Correct value | Source |
|---|---|---|
| Scale | `s` (README right) | `internal/view/scale_extender.go` L48 |
| CronJob suspend | `s` | `internal/view/cronjob.go` L87 |
| Pod: transfer / sanitize / show node | `t` / `z` / `o` (`shift-o` = sort by selected column) | `internal/view/pod.go` L109-132 |
| Node | `c` cordon, `u` uncordon, `r` drain (README row is stale) | `internal/view/node.go` L45-61 |
| Helm | `r` rollback in history; `v` values, `v` again toggles all/user | `internal/view/helm_history.go` L83, `value_extender.go` L35, L74 |
| Image scans | `v` vulnerabilities, `shift-v` sort; scanner is grype + syft | `vul_extender.go` L31-32, `go.mod` |
| Xray expand | `space` toggles node, `x` toggles all | `internal/ui/tree.go` L94-96 |
| `:can` | `:can u:name` (also `g:`, `s:`) | `internal/view/cmd/types.go` L36 |
| DaemonSet | no scale | `internal/view/ds.go` L23-28 |
| Used-by scanners | Pod, Deployment, DaemonSet, StatefulSet, Job, CronJob (no ReplicaSet) | `internal/dao/job.go` L137 |
| Workload columns | KIND, NAMESPACE, NAME, STATUS, READY, VALID(wide), AGE | `internal/render/workload.go` |
| `shift-p` namespace sort | in source, only in all-namespaces | `internal/ui/table.go` L443-449 |
| Read-only | in v0.51.0 CronJob trigger/suspend are NOT gated (fixed on master) | `cronjob.go` diff |
| `logger.logBufferSize`, per-context `logo` | master-only | `git diff v0.51.0 HEAD` |
| Node shell | container name `k9s-shell` | `internal/view/exec.go` L309 |
| Popeye | dead: README only, no code | tree |
| Users/Groups | subjects collected from ClusterRoleBindings (RoleBindings not checked) | `internal/dao/rbac_subject.go` |

**Extender matrix (which view gets which action).**

| View | Logs | Owner jump | Set image | Scale | Restart | Port-forward |
|---|---|---|---|---|---|---|
| Pod | yes | yes | yes | no | no | yes |
| Deployment | yes | yes | yes | yes | yes | yes |
| StatefulSet | yes | yes | yes | yes | yes | yes |
| DaemonSet | yes | yes | yes | no | yes | yes |
| Service | yes | yes | no | no | no | yes |
| Job | yes | yes | no | no | no | no |
| Other GVR incl. CRDs | no | yes | no | if scale subresource | no | no |

**Structural facts that shape the build.**
- k9s shells out to `kubectl` for exec, attach, cp, edit. The GUI uses WebSocket exec and an in-app editor instead.
- k9s reads from informers. The GUI needs list+watch per visible view.
- Describe uses kubectl's `describe.Describer`; drain and rollback use kubectl Go libraries; Helm uses the Helm v3 SDK. All are re-implemented or shelled out in a JS backend.
- Pulses is UI-only, computed from ordinary lists. Pulse kinds: node, ns, svc, ev, pod, dp, sts, ds, job, cj, pv, pvc, hpa.
- Dedicated renderers exist for NetworkPolicy, PV, PVC, StorageClass, PDB, HPA, Endpoints, EndpointSlice, RBAC kinds. Ingress and CRDs use the server Table.

### P0: v1, daily use

| Feature | k9s trigger | K8s API | GUI treatment |
|---|---|---|---|
| Contexts | `:ctx [name]`, `Enter` | kubeconfig; client rebuild | Titlebar dropdown + palette; per-context session |
| Namespaces, favourites, all | `:ns [name]`, `0` all, `1`-`9` favourites, `u` use | `GET namespaces`; list across ns needs permission | Dropdown, number keys, fallback to typed ns when list is forbidden |
| Resource jump with args | `:pod`, `:po ns`, `:pod app=x`, `:pod /re`, `:pod -f fz`, `:pod @ctx` | Discovery `/api`, `/apis`; `labelSelector` | Same grammar in palette command mode, autocomplete |
| Aliases | `ctrl-a`, `:alias` | none | Alias view; discovery short names + user aliases later |
| Generic browser, all GVRs incl. CRDs | any alias | `Accept: application/json;as=Table;g=meta.k8s.io;v=v1` | Server columns as fallback; makes Flux CRDs browsable |
| Rich columns | Pod, Deploy, STS, DS, RS, Job, CronJob, Svc, Node, NS, Event, CM, Secret, PVC, PV, Ingress | list+watch | Start from Table; add derived status, ready, restarts |
| Sort | `shift-n/a/s/p`, `shift-o` selected column, `shift-left/right` selects column | none | Same keys + header click |
| Filter | `/re`, `/!re`, `/-l sel`, `/-f fz`; `ctrl-u`/`ctrl-q` clear | label mode restarts watch with `labelSelector` | Filter bar with chips per mode |
| Marks | `space`, `ctrl-space` range, `ctrl-\` clear | none | Checkbox column, bulk action bar |
| Copy | `c` name, `n` namespace | none | Same; `Ctrl/Cmd+C` copies cell |
| Faults only | `ctrl-z` | none | Chip in filter bar |
| Refresh | `ctrl-r` | re-list | Same |
| History | `[`, `]`, `-`, `esc` | none | Same + breadcrumbs |
| Vim nav | `j k h l`, `g`, `G`, `ctrl-b`, `ctrl-f` | none | Same + arrows, Home/End, PgUp/PgDn |
| Describe | `d` | GET + events by `involvedObject` | Native describe view, live events |
| YAML | `y`; `m` managedFields, `/` search, `n`/`N` matches | GET | Read-only viewer, toggle managedFields |
| Edit | `e` (kubectl edit) | SSAR patch; PUT or PATCH | In-app editor, diff, dry run, apply |
| Delete | `ctrl-d`; dialog propagation Background/Foreground/Orphan/None + Force | `DELETE` with `propagationPolicy`, grace 0 for force | Confirm tiers (6.4), `preconditions.uid` |
| Kill pod | `ctrl-k`, no confirm | `DELETE` grace 0 | Off by default; on in k9s-mode preset |
| Logs | `l`, `p` previous | `GET pods/{n}/log` with `follow`, `tailLines`, `sinceSeconds`, `previous`, `timestamps` | Custom virtualized viewer |
| Log controls | `s` autoscroll, `0` tail, `1` head (`limitBytes=5000`), `2`-`6` = 1m/5m/15m/30m/1h, `t` timestamps, `w` wrap, `f` fullscreen, `m` mark, `shift-c` clear, `c` copy, `ctrl-s` save, `/` filter, `a` all containers | one stream per container | Same keys + explicit container picker (k9s has none) |
| Workload logs | `l` on Deploy/STS/DS/Job/Svc | one stream per matched pod | Pod-name gutter, re-attach on new pods |
| Shell | `s` on pod/container, picker for multi-container | `pods/{n}/exec` WebSocket | xterm.js pane |
| Drill-downs | `Enter`: workload to pods, pod to containers, cronjob to jobs, node to pods, svc to pods; `z` deploy to RS; `shift-j` owner; `o` pod to node | list by selector, owner UID, `spec.nodeName` | Same + breadcrumbs, owner links |
| Scale | `s` | `/scale` subresource | Dialog; undo toast restores previous count |
| Rollout restart | `r` on Deploy/STS/DS | patch `kubectl.kubernetes.io/restartedAt` on template | Toast, no dialog |
| CronJob trigger / suspend | `t` / `s` | create Job from `jobTemplate`; flip `spec.suspend` | Same; gate in read-only (k9s v0.51.0 does not) |
| Secret decode | `x` | GET, base64 decode | Masked by default, reveal on demand |
| Port-forward | `shift-f` start, `f` or `:pf` list, `ctrl-d` stop | `pods/{n}/portforward` | Dialog + manager; kubectl fallback (5.8) |
| Metrics columns | automatic if metrics-server | `metrics.k8s.io` pods, nodes | CPU/MEM, %R, %L; hide when API absent |
| Cluster header | automatic | version, metrics | Context, cluster, user, version, CPU%, MEM% |
| Events | `:ev`, `ctrl-z` warnings | list+watch events | Warning chip, default sort last seen |
| Connection health | 15s loop, backoff, exit after retries (numbers not source-checked) | cheap call | Statusbar state, reconnect, never exit |
| RBAC gating, read-only | `--readonly`, SSAR before actions | `SelfSubjectAccessReview` / `RulesReview` | Disable actions, handle 403 |
| Flux suspend/resume, reconcile | bundled `plugins/flux.yaml`: `Shift-T`, `Shift-R`, `Shift-Z` | patch `spec.suspend`; annotate `reconcile.fluxcd.io/requestedAt` | Native actions on Flux kinds |
| Help | `?` | none | Searchable overlay incl. remapped keys |

### P1: important

| Feature | k9s trigger | K8s API | GUI treatment |
|---|---|---|---|
| Helm releases | `:helm`; `Enter` history; `v` values; `r` rollback; `ctrl-d` uninstall | k9s: Helm SDK. GUI: decode `sh.helm.release.v1.*` secrets | Read-only first; write ops via `helm` CLI if present |
| Set image | `i` | patch pod template | One field per container |
| ReplicaSet rollback | `ctrl-l` (RS must have 0 replicas) | patch Deployment template from RS | Revision picker on Deployment |
| Used-by | `u` on Secret, CM, PVC, SA, PriorityClass | client-side scan of 6 workload kinds | Reference list, Enter jumps |
| Cordon / uncordon / drain | `c` / `u` / `r`; drain dialog: grace, timeout, ignore DS, delete emptyDir, force, disable eviction | patch `spec.unschedulable`; Eviction API | Per-pod progress, cancel |
| Attach | `a` | `pods/{n}/attach` | Same pane as shell |
| File transfer | `t`; dialog Download, From, To, NoPreserve, Container, Retries | tar over exec | File dialogs |
| Sanitize | `z` | list + delete Completed/Failed | Typed confirm |
| Workload view | `:wk` | Table lists | Combined table |
| CRD view | `:crd`, `Enter` | CRDs | Drill into instances |
| Wide / custom columns | `ctrl-w`; `views.yaml` (jq-style) | none | Column chooser; custom columns later |
| Save table | `ctrl-s` | none | CSV via file dialog |
| Custom aliases, hotkeys, jumps | `aliases.yaml`, `hotkeys.yaml`, `jumps.yaml` | list with selectors | Settings files, hot reload |
| PF annotations | `k9scli.io/auto-port-forwards`, `k9scli.io/port-forwards` | none | Preselect dialog; duplicate guard |
| Pulses | `:pulses`, `:pu`, `:hz` | lists + metrics | Dashboard with gauges and sparklines |
| Xray | `:xray po\|svc\|dp\|rs\|sts\|ds [ns]`; `space`, `x` | related lists | Tree view |
| RBAC rules | `Enter` on Role/ClusterRole/bindings | GET role via binding | Flattened policy table; match namespace too (k9s bug: matches name only) |
| Extra columns | NetworkPolicy, StorageClass, PDB, HPA, Endpoints, EndpointSlice | list+watch | Dedicated columns |
| Delta indicators | automatic | none | Cell flash |
| Flux trace, suspended filter | `Shift-Q`, `Shift-S` | Flux labels, inventory | Owner link, filter chip |
| Light theme, per-context settings | skins, context config | none | Tokens (6.5) |

### P2: later or skip

| Feature | k9s trigger | Note |
|---|---|---|
| Plugins | `plugins.yaml`, about 60 bundled | Shell-out with env vars and inputs |
| Node shell | `s` on node, feature gate | Privileged pod |
| Subject policy, Users, Groups | `:can u:name`, `:usr`, `:grp` | Client-side RBAC evaluation |
| Impersonation | `--as`, `--as-group` | |
| Image scans | `v` | grype/syft are Go; needs external binary |
| Benchmarks | `b`, `:be` | Depends on `hey` |
| Dir view | `:dir <path>` | kubectl apply/delete from disk |
| Screen-dump browser | `:sd` | |
| Skins, logo, splash, `noIcons`, `invert` | 43 skins | |
| OSC52 clipboard, version check, `k9s info`, most CLI flags, cow | | |
| Popeye | `:popeye` | Skip; dead upstream |

## 3. Lessons from existing GUIs

**Landscape (GitHub API, 2026-11-21).**

| Tool | Stack | License | Status |
|---|---|---|---|
| [Freelens](https://github.com/freelensapp/freelens) | Electron/TS | MIT | v2.1.0 today, 5.9k stars |
| [Lens](https://github.com/lensapp/lens) | Electron | Commercial | OSS core frozen since 2025-02 |
| [Headlamp](https://github.com/kubernetes-sigs/headlamp) | React + Go backend, Electron desktop | Apache-2.0 | v0.46.0, 7.7k stars, SIG UI successor to Dashboard ([blog](https://kubernetes.io/blog/2026/06/01/dashboard-to-headlamp/)) |
| [Aptakube](https://aptakube.com) | Rust + Tauri | Proprietary | v1.23.0 on 2026-11-18 |
| [Kunobi](https://ninja.kunobi.com/) | Rust + Tauri 2 (vendor claim) | Proprietary | v1.7.1, Flux/Argo focus |
| [JET Pilot](https://github.com/unxsist/jet-pilot) | Tauri 2 + Vue 3 | MIT | v2.3.1, 660 stars |
| [Kubeli](https://github.com/atilladeniz/Kubeli) | Tauri 2.9, React 19, kube-rs | MIT | v0.3.90, 408 stars |
| [Kore](https://github.com/koreide/Kore) | Rust GPUI | MIT | v0.2.0, 7 stars |
| [Seabird](https://github.com/getseabird/seabird) | Go + GTK4 | MPL-2.0 | Stale since 2025-08 |

**Copy.**
- Command palette as universal entry (Aptakube, JET Pilot, Kore), plus k9s `:` and `/`.
- Single-key row actions and a `?` overlay (Kore).
- Guardrails: type the cluster name on protected contexts, read-only per cluster (Aptakube, JET Pilot).
- Dense virtualized tables with column pickers and CRD printer columns (Kunobi).
- Logs that follow a workload across pods; a clear-logs action (open Freelens ask); JSON-aware parsing later (JET Pilot).
- Terminal dock preset to context and namespace without touching kubeconfig (JET Pilot).
- Port-forwards that survive rollouts (Aptakube, JET Pilot).
- YAML edit with diff and server dry run (JET Pilot).
- Flux views: status, reconcile, suspend, drift (Kunobi, Aptakube). Kunobi is the competitor to study.
- Local-first: no in-cluster agent, no account, no telemetry.

**Avoid.**
- Login or subscription walls (Lens: [1](https://forums.k8slens.dev/t/lens-desktop-suddenly-showing-no-lens-subscription/7177), [2](https://forums.k8slens.dev/t/lens-desktop-login-error-please-try-again-later/3157)).
- Heavy startup and memory from a large legacy Electron codebase. Headlamp v0.45.0 had to tune startup ([notes](https://newreleases.io/project/github/kubernetes-sigs/headlamp/release/v0.45.0)).
- Connection fragility: Kunobi failed on kubeconfigs that k9s handled ([reviews](https://www.producthunt.com/products/kunobi/reviews)). Test odd kubeconfigs, exec plugins, stale contexts.
- UI with no escape hatch. Keep raw YAML and a terminal.
- Buried search (Freelens "move search fields to top left").
- Always-editable Secret values (Freelens) and silent destructive actions.
- Extension-API churn and unmaintained forks (OpenLens).
- Unsigned installers are tolerable for one user, but they block mac auto-update (section 7).

Other sources: [Aptakube Show HN](https://news.ycombinator.com/item?id=35687215), [Kunobi Show HN](https://news.ycombinator.com/item?id=48121066), [nadimtuhin](https://www.nadimtuhin.com/blog/kubernetes-dashboard-alternatives).

## 4. Stack decision

### Recommendation

**Electron + TypeScript, with all cluster access in the main process.** Use `@kubernetes/client-node` 2.0.2 for kubeconfig, auth and TLS only. Hand-roll watch, logs and exec on `undici` and `ws`. Keep `kubectl` as a first-class fallback, at least for port-forward. No local-shell tab in v1, which leaves zero native modules.

The adversarial review could not refute this. The strongest evidence is prior art: Freelens v2.1.0 ships Electron 44.11.5, client-node 2.0.2, electron-builder 26.18.0 and electron-vite 6.0.0 on Windows and macOS ([package.json](https://github.com/freelensapp/freelens/blob/main/freelens/package.json)).

**What would flip it:** the M0 spike (section 8) failing on the hand-rolled path against the real k3s.

### Ranked options

| Rank | Option | For | Against |
|---|---|---|---|
| 1 | Electron + client-node (thin) | Zero toolchain cost; best agent output; mature packaging and updater; Freelens as canary | 90-110 MB installer, 200-300 MB idle `[unverified]`; client-node streaming helpers below k9s grade |
| 2 | Electron + Go sidecar (client-go) | Same library as k9s; Headlamp model (Electron ^43.8.1, Go 1.26, client-go v0.37.1) | Needs Go; sidecar binary to sign; IPC to a second process |
| 3 | Wails v3 (Go) | client-go, small binary, built-in updater | 26 days stable; 10 repo advisories published 2026-10-18 to 11-01 incl. high-severity Windows ([advisories](https://github.com/wailsapp/wails/security/advisories)); agents write v2 code |
| 4 | Tauri 2 + kube-rs | Smallest and lightest; proven by JET Pilot, Kubeli | Rust + MSVC install; kube-rs had two majors this year (JET Pilot still on 4.2.0); rustls friction with private CAs possible |
| 5 | Electrobun 2 | Bun-native | v2 + new toolchain churn, agents do not know it |
| 6 | Neutralino | Tiny | No K8s client; kubectl wrapper only |
| - | Native WinUI + SwiftUI | | Two codebases |

**Unresolved disagreement.** The stack comparison ranks Wails v3 second on fidelity. The adversarial review rejects Wails and names Electron + Go sidecar as the fallback. This document follows the review, since its advisory count contradicts the comparison's "one advisory, Linux-only" claim. Patched status of those advisories was not checked.

### Verified versions (npm / GitHub, 2026-11-21)

| Item | Version | Note |
|---|---|---|
| Electron | 45.4.1 (2026-11-19) | Node 24.22.3, Chrome 156; 46 alpha bundles Node 26 ([releases](https://github.com/electron/electron/releases)) |
| @kubernetes/client-node | 2.0.2 (npm 11-02, GitHub 11-03) | ESM-only, `undici ^8.7.0`, `engines: node >=22.19.0` ([tag source](https://github.com/kubernetes-client/javascript/tree/2.0.2/src)) |
| electron-vite / electron-builder / electron-updater | 6.0.0 / 26.18.0 / 6.8.11 | |
| Tauri / kube-rs | 2.12.7 / 5.1.0 | |
| Wails | 3.1.0 (3.0.0 stable 2026-10-26) | Needs Go 1.26+ |
| TanStack Table / Virtual | 9.3.1 / 3.14 | Table v9 is a new major |
| @xterm/xterm | 6.0.0 | Use the `@xterm/` scope |
| React / Tailwind / zustand / TanStack Query | 19.3 / 4.3.5 / 5 / 5 | |
| cmdk / shadcn CLI | 1.1.1 / 4.23 | |

### Frontend picks

| Area | Pick | Conflict between inputs |
|---|---|---|
| Framework | React 19 | UX spec also allows Solid; React chosen for ecosystem |
| Table | TanStack Table 9 + Virtual | none |
| Palette | cmdk | none |
| UI kit | shadcn/ui on Radix | Stack doc: Radix safer for agents, Base UI newer; UX spec: Radix or React Aria. Radix chosen |
| Editor | CodeMirror 6 + `@codemirror/merge` | Kubeli and one input use Monaco. CodeMirror chosen for size and no worker setup |
| Terminal | xterm.js, exec only | Not used for logs |
| State | zustand for watch streams, TanStack Query for one-shot reads | none |

### Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | client-node 2.0.2 helpers: no exec ping (`pingIntervalMs` is on `main` only; [#2870](https://github.com/kubernetes-client/javascript/issues/2870) idle exec drops at 5 min), single-port legacy port-forward, log helper swallows stream errors, informer without bookmarks or pagination | Own the `ws`/`undici` layer; pin 2.0.2 exactly; M0 spike; `kubectl port-forward` fallback |
| 2 | undici-8 HTTP layer is three months old and may change ([#2306](https://github.com/kubernetes-client/javascript/issues/2306)) | One `raw()` function, integration tests against k3s, rerun before any Electron or client-node bump |
| 3 | Open bugs: exec auth ignores AbortSignal ([#3077](https://github.com/kubernetes-client/javascript/issues/3077)), watch cannot abort before first event ([#2860](https://github.com/kubernetes-client/javascript/issues/2860)) | Own fetch with own `signal` |
| 4 | Packaging: mac auto-update needs a signed app; unsigned Windows triggers SmartScreen | Decide signing up front; CI matrix in M0 |
| 5 | pnpm 11 blocks install scripts; Electron binary never downloads | `allowBuilds: { electron: true }` in `pnpm-workspace.yaml` on day one ([pnpm 11](https://pnpm.io/blog/releases/11.0)) |
| 6 | Agents write client-node 0.x positional calls and TanStack Table v8 code | Exact pins, strict `tsc` in CI |
| 7 | Electron cadence (major about every 8 weeks) | Renovate; Freelens as canary |
| 8 | Electron weight vs the "fast, light" differentiator | Lazy watchers, Table rows not objects, measure in M1 |
| 9 | Local shell later: `@lydell/node-pty` 1.2.0-beta.18 has win/mac prebuilds, but node-pty [#904](https://github.com/microsoft/node-pty/issues/904), [#951](https://github.com/microsoft/node-pty/issues/951) are open | Deferred |

## 5. Backend architecture

All of this runs in the Electron main process. The renderer never sees tokens or kubeconfigs.

### 5.1 Kubeconfig and sessions

- Do own file resolution: `KUBECONFIG` split on `path.delimiter` (`;` on Windows), else `~/.kube/config`. Call `loadFromFile` + `mergeConfig`. Avoid `loadFromDefault`: with no local config on Windows it runs `wsl.exe` synchronously.
- kubectl merge rule is first file wins; client-node's merge may differ `[verify]`.
- One immutable session per context: `{kc, discovery, rbacCache, watchers, forwards, execSessions, dispose()}`. Clone via `loadFromString(exportConfig())`. Context switch = pointer swap + `abortAll()` on the old session.
- `fs.watch` the kubeconfig files; re-read on 401.
- Exec credential plugins:
  - A kubeconfig is executable. Confirm before first use of an unknown exec command, or use the 2.0.2 policy API (`setExecCredentialPluginPolicy`).
  - GUI apps do not inherit shell PATH. On macOS resolve it with `$SHELL -ilc env`.
  - Windows: `.cmd` shims need `shell: true` or an explicit extension; set `windowsHide`.
  - Interactive plugins need a TTY. Detect failure and tell the user to run kubectl once.
- Tokens apply at connect time. Refresh on reconnect or 401.
- Honor `certificate-authority-data`, `insecure-skip-tls-verify`, `tls-server-name`, `proxy-url`. `ws` needs its own TLS options and proxy agent; `createDispatcherOptions` is undici-only. Proxy handling `[verify]`.

### 5.2 Raw request primitive

One function: `raw(session, path, {method, accept, body, signal})` on `undici.fetch`, with TLS and auth from `KubeConfig` (`createDispatcherOptions`, `applyToHTTPSOptions`). Everything in 5.3-5.11 goes through it. The exact plumbing differs across 2.x minors, so cover it with integration tests against k3s.

### 5.3 Discovery

- Aggregated discovery (GA since 1.30, [KEP-3352](https://www.kubernetes.dev/resources/keps/3352/)): `GET /api` and `GET /apis` with `Accept: application/json;v=v2;g=apidiscovery.k8s.io;as=APIGroupDiscoveryList, application/json`.
- If the response `Content-Type` is plain JSON, fall back to the legacy walk.
- Build `Map<GVR, {kind, namespaced, verbs, shortNames, categories, subresources}>`. Subresources enable actions (`deployments/scale`, `pods/log`).
- Hide resources without `list`. Dedupe kinds across groups by preferred version (`events`, `ingresses`).
- Refresh on CRD add/delete via a CRD watch. Show stale or failed APIServices instead of dropping them.
- Alias map: name, singular, short names, lowercased kind, `name.group`. Exclude `metrics.k8s.io` from shortcuts, as k9s does.

### 5.4 Generic watch

Own `ResourceWatcher` (about 200 lines), not `makeInformer`.

- List: `limit=500` + `continue`. An expired continue token (410) restarts the list.
- Watch: `?watch=1&resourceVersion=RV&allowWatchBookmarks=true&timeoutSeconds=300`. Newline-delimited JSON events ADDED, MODIFIED, DELETED, BOOKMARK, ERROR.
- Resume from the last seen rv, including bookmarks. Never compare rvs.
- 410 (HTTP or ERROR event): clear rv, relist, emit a fresh snapshot.
- Backoff 800 ms, factor 2, cap 30 s, jitter. Honor `Retry-After`. 403 stops the watcher with a message.
- Watch only visible views, namespace-scoped unless the user picks all. Stop after a short grace period on navigation.
- Semaphore of about 3 concurrent lists. Force reconnect on resume from sleep via Electron `powerMonitor`.
- WatchList streaming (`sendInitialEvents=true`) is optional; gate state on k3s `[verify]`.

### 5.5 Table format

- Header: `Accept: application/json;as=Table;g=meta.k8s.io;v=v1, application/json`, with `includeObject=Metadata`.
- Works on list and on watch. On watch, each event is a one-row Table and `columnDefinitions` arrive only on the first event; cache them per watch.
- CRD `additionalPrinterColumns` come for free. `priority > 0` columns are the wide view.
- Age and similar cells are pre-rendered strings. Compute age from `metadata.creationTimestamp` and sort on raw values.
- If a server returns plain JSON, render NAME and AGE only.
- Full objects are fetched on demand (YAML, describe, edit).
- Rich views (pods, nodes, workloads) need fields the Table lacks (container statuses, requests/limits). For those kinds, list full objects namespace-scoped, or fetch on selection. Decide per kind in M1.

### 5.6 Logs

- Raw fetch on `/api/v1/namespaces/{ns}/pods/{pod}/log` with own `signal`. Always request `timestamps=true`; the UI toggle only hides the prefix.
- One stream per container; merge client-side by RFC3339Nano timestamp. One stream per pod for workloads; attach new pods from the pod watch.
- `previous=true` returns 400 if the container never restarted. Enable only when `restartCount > 0`.
- Reconnect with `sinceTime` = last timestamp. Show a gap marker.
- Backend ring buffer: **50k lines per stream view, configurable** (inputs said 10-50k and 100k; 50k chosen).
- Cap line length. Save streams to a file, not from memory.

### 5.7 Exec and attach

- Hand-rolled on `ws` (about 100 lines). URL: `/api/v1/namespaces/{ns}/pods/{pod}/exec?container=..&stdin=true&stdout=true&tty=true&command=..`.
- Subprotocols: `v5.channel.k8s.io`, then `v4.channel.k8s.io`.
- Framing: first byte is the channel. 0 stdin, 1 stdout, 2 stderr, 3 status (V1Status JSON), 4 resize (`{"Width":cols,"Height":rows}`), 255 close (v5).
- TTY merges stderr into stdout.
- Own ping/pong keepalive with timeout (not in client-node 2.0.2).
- Shell detection: `sh -c 'command -v bash >/dev/null && exec bash || exec sh'`. Distroless images have no shell; ephemeral debug container is a later feature.
- Attach uses `/attach` with the same protocol.
- RBAC: check both `get` and `create` on `pods/exec` `[verify]`.

### 5.8 Port-forward

- Design: `net.createServer` on `127.0.0.1`; one WebSocket to `/portforward?ports=<remote>` per accepted connection; pipe with backpressure.
- client-node's helper is single-port and uses the legacy channel protocol, not the KEP-4006 tunnel ([KEP-4006](https://www.kubernetes.dev/resources/keps/4006/)). Whether k3s still serves that path is untested.
- Therefore: spike the hand-rolled path in M0. If it fails, v1 spawns `kubectl port-forward` and parses its output.
- Registry: `{id, ctx, ns, target, localPort, remotePort, status, conns}`. Duplicate guard. `EADDRINUSE` offers the next port.
- Service or workload targets re-resolve to a Ready pod on the next connection.
- Close listeners on context switch and quit.

**Unresolved disagreement.** The API deep-dive says kubectl cannot be relied on. The review says it is fine for one user who already has kubectl 1.32. This document allows a kubectl dependency for port-forward only, pending the spike.

### 5.9 Mutations

| Operation | Request | Notes |
|---|---|---|
| Edit / apply | SSA: `PATCH ?fieldManager=<app>&force=false`, `application/apply-patch+yaml`; or `PUT` with rv | 409 lists conflicting managers; offer force after confirm. Strip `managedFields`, `status`, rv, uid |
| Dry run | `?dryRun=All`, `fieldValidation=Warn` | Show server message and Warning headers verbatim |
| Patch CRDs | merge patch or JSON patch | Strategic merge returns 415 on CRDs; `KubernetesObjectApi.patch` defaults to it |
| Delete | `DELETE` with `propagationPolicy`, `gracePeriodSeconds`, `preconditions.uid` | Force = grace 0 |
| Scale | merge patch `{"spec":{"replicas":N}}` on `/scale` | Any kind with the subresource |
| Restart | patch `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` | Deploy, STS, DS |
| Rollback | patch Deployment `spec.template` from chosen RS, remove `pod-template-hash` | STS/DS use ControllerRevisions; later |
| CronJob trigger | `POST` Job from `spec.jobTemplate`, name `<cj>-manual-<rand>`, owner ref to CronJob, annotation `cronjob.kubernetes.io/instantiate: manual` | |
| CronJob suspend | patch `spec.suspend` | |
| Cordon | merge patch `spec.unschedulable` | |
| Drain | cordon; list pods by `spec.nodeName`; skip mirror and DS pods; `POST .../eviction`; 429 = PDB, retry every 5 s; wait | Budget a day; per-pod progress, cancel |
| Flux reconcile | merge patch annotation `reconcile.fluxcd.io/requestedAt: <now>` | With-source: annotate the source first |
| Flux suspend | merge patch `spec.suspend` | |
| Secret edit | via `stringData` | No hand-written base64 |

- Bulk: concurrency 5-10, per-item results.
- Flux warning: if the object carries `kustomize.toolkit.fluxcd.io/name` or `helm.toolkit.fluxcd.io/name` labels, warn that the change will be reverted; offer suspend.
- Flux kinds and versions are resolved through discovery, never hardcoded. Status from `status.conditions[type=Ready]`, `spec.suspend`, `status.lastAppliedRevision`, `observedGeneration` vs `generation`, `status.inventory.entries`.

### 5.10 Other reads

- **Describe:** object + events (`fieldSelector=involvedObject.uid=..`, watched) + owner and children + conditions. Hand-built for common kinds, generic conditions renderer for CRDs. Event retention is 1 hour by default; say so.
- **Metrics:** poll `metrics.k8s.io/v1beta1` pods and nodes every 15 s while a pod or node view is visible. Own quantity parser. Join with requests, limits and node allocatable. Ring buffer of 60 samples for sparklines. Hide columns if the API is absent.
- **Secrets:** decode in the backend only on reveal. Detect binary. Parse `kubernetes.io/tls` certs with `node:crypto` `X509Certificate` for expiry.
- **Helm:** list `secrets?labelSelector=owner=helm`; name, revision, status come from labels without decoding. Detail: base64 (K8s) then base64 (Helm) then gunzip if gzip magic bytes are present, then JSON. The input gave the magic as `1f 8b 8b`; standard gzip is `1f 8b 08` `[verify against Helm storage util]`. Write operations need the `helm` CLI. For this cluster HelmRelease CRs are the control surface.

### 5.11 RBAC gating

- `SelfSubjectRulesReview` per namespace gates the toolbar in one call. If `incomplete: true`, fall back to `SelfSubjectAccessReview` per action.
- Cache per (context, namespace), TTL about 60 s.
- Match wildcards, `resource/subresource` strings and `resourceNames`.
- Gating is advisory. Always handle 403 and show "forbidden", never an empty table.
- Read-only mode disables every write action, including CronJob trigger and suspend.

### 5.12 IPC

- `contextIsolation: true`, `nodeIntegration: false`, strict CSP, no remote content. All cluster text is untrusted; no `innerHTML`.
- Shared `protocol.ts` with zod or valibot schemas.
- RPC (request/response with id) over `contextBridge` + `ipcRenderer.invoke`: discovery, get YAML, apply, scale, can-i.
- Streams over `MessageChannelMain` ports: one per subscription, log view, exec session.
- Table subscriptions: `subscribe{gvr, ns, selector}` returns `snapshot{columns, rows, rv}` in chunks of 500, then `delta{upserts, deletes}`. Each message has a monotonic `seq`; a gap or relist triggers a new snapshot.
- Coalescing: backend buffers events in a `Map<uid, event>` and flushes **every 100 ms** (inputs said 50-100 ms and 4-10 Hz; 100 ms chosen). Flush early at a size cap. Never drop a delete without a resync.
- Logs: line batches `{ts, container, text}` on the same 100 ms cadence.
- Exec: binary frames. Credit-based flow control: renderer acks bytes, backend pauses the upstream above a 256 KB window.
- Every operation has an `AbortController`. Unsubscribe, context switch and window close abort.

## 6. UX spec

### 6.1 Layout

```
+--------------------------------------------------------------------------+
| Titlebar: [mac lights] ctx v  ns v      (palette trigger)     [win ctrls] |
+--------------------------------------------------------------------------+
| Header: ctx / cluster / user / version / CPU% / MEM% | hint bar (keys)    |
+----------+---------------------------------------------------------------+
| Sidebar  | Crumbs: Pods(all) > filter           [/ filter]         count |
| (toggle) |---------------------------------------------------------------|
| groups,  | Table (virtualized, sticky header, row focus)                 |
| favs,    |---------------------------------------------------------------|
| recent   | Detail split: YAML | Describe | Logs | Events | Terminal       |
+----------+---------------------------------------------------------------+
| Statusbar: mode NORMAL/FILTER/COMMAND | watch state | last error          |
+--------------------------------------------------------------------------+
```

- Sidebar collapsed by default; groups: Workloads, Network, Config, Storage, Cluster, Flux, CRDs.
- Hint bar shows keys valid for the current view; collapses by priority; header hides with `ctrl-e`.
- Esc pops the breadcrumb. Filter chips per mode (regex, inverse, label, fuzzy).
- Statusbar shows watch state (live, reconnecting, stale). Stale rows are dimmed, never silently frozen.
- macOS: native traffic lights in an inset titlebar, about 78 px reserved, title is the app name. Windows: overlay titlebar keeping native controls and snap layouts. Electron option names `[unverified]`.

### 6.2 Palette and command mode

- `Ctrl/Cmd+K` opens the palette; `:` opens it in command mode with k9s grammar; `/` focuses the filter.
- Contents: resources (from discovery), actions for the current selection with their shortcuts, contexts, namespaces, recents, settings.
- Destructive commands route through the same confirm flow as keys.
- Precedent: [Linear](https://linear.app/changelog/2019-12-18-new-command-menu), [Zed vim mode](https://zed.dev/docs/vim).

### 6.3 Keymap

Principles: keep k9s letters; add arrow and platform equivalents; plain letters are inactive while an input has focus; everything is remappable via a keymap file; a "k9s mode" preset restores every k9s binding.

| Action | k9s (v0.51.0 source) | GUI default | Notes |
|---|---|---|---|
| Help | `?` | `?` | |
| Command | `:` | `:`, `Ctrl/Cmd+K` | |
| Filter / clear | `/`, `ctrl-u` | `/`, `Esc` | |
| Back | `esc` | `Esc` | |
| History | `[` `]` `-` | same, `Alt+Left/Right` (Win), `Cmd+[`/`]` (mac) | |
| Row move | `j` `k`, arrows | same | |
| Top / bottom | `g` / `G` | same, `Home`/`End` | |
| Page | `ctrl-b` / `ctrl-f` | same, `PgUp`/`PgDn` | |
| Open / drill | `enter` | `Enter` | |
| Describe / YAML / Edit | `d` / `y` / `e` | same | Edit opens in-app editor |
| Logs / previous | `l` / `p` | same | |
| Shell / attach | `s` / `a` | same | `s` is scale on workloads, as in k9s |
| Scale | `s` | `s` | Deploy, STS, scalable CRDs |
| Restart | `r` | `r` | Deploy, STS, DS |
| Set image | `i` | `i` | |
| Deploy to ReplicaSets | `z` | `z` | |
| Rollback | `ctrl-l` | `Ctrl/Cmd+L` | |
| CronJob trigger / suspend | `t` / `s` | same | |
| Port-forward / list | `shift-f` / `f` | same | |
| Delete | `ctrl-d` | `Ctrl/Cmd+Backspace`, `Delete`; `ctrl-d` in k9s mode | Confirm tiers |
| Kill | `ctrl-k` | `Ctrl/Cmd+Shift+Backspace`, off by default; `ctrl-k` in k9s mode | |
| Mark / range / clear | `space` / `ctrl-space` / `ctrl-\` | `Space` / `Shift+Space`, `Shift+Down` / `Esc` | |
| Sort | `shift-n/a/s/p`, `shift-o` | same, header click | Press again to reverse |
| Select column | `shift-left/right` | same | Selects, does not move |
| Wide | `ctrl-w` | `Alt+W` | `Cmd+W` stays close-window |
| Faults | `ctrl-z` | `Ctrl/Cmd+Shift+F`, chip | `Ctrl+Z` stays undo |
| Refresh | `ctrl-r` | `Ctrl/Cmd+R` | |
| Save | `ctrl-s` | `Ctrl/Cmd+S` | |
| Copy name / ns | `c` / `n` | same | On nodes `c` is cordon |
| Owner / warp / pod's node | `shift-j` / `w` / `o` | same | |
| Secret decode / used-by | `x` / `u` | same | |
| Cordon / uncordon / drain | `c` / `u` / `r` | same | Node view |
| Transfer / sanitize | `t` / `z` | same | Pod view, P1 |
| Namespaces | `0` all, `1`-`9` favourites | same | |
| Xray expand | `space` node, `x` all | same | P1 |
| Logs: autoscroll / wrap / timestamps / fullscreen | `s` / `w` / `t` / `f` | same; scroll up pauses, `End` or `G` resumes | |
| Logs: tail / head / since | `0` / `1` / `2`-`6` | same | |
| Logs: mark / clear / all containers | `m` / `shift-c` / `a` | same | |
| Flux suspend / reconcile | plugin `Shift-T` / `Shift-R` | same | Native |
| Aliases | `ctrl-a` | `Ctrl/Cmd+Shift+A` | `Cmd+A` stays select-all |
| Quit | `:q`, `ctrl-c` | `Cmd+Q`, `Alt+F4`, `:q` | `Ctrl+C` copies selection |

**Parity vs safety (flagged).** k9s deletes on `ctrl-d` and kills on `ctrl-k` with no confirmation. The default here uses platform delete keys, confirm tiers, and kill disabled. The k9s-mode preset restores k9s keys and behaviour. Which is the default is an open question (section 9).

Platform rules: do not repurpose standard shortcuts ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/keyboards.md)). macOS needs a full menu bar with the same actions as the palette. Settings on `Cmd+,` / `Ctrl+,`.

### 6.4 Destructive actions

| Tier | Examples | Flow |
|---|---|---|
| 0 | restart, scale, cordon, trigger, Flux reconcile/suspend | No dialog; toast, undo where reversible (scale, cordon, suspend) |
| 1 | delete a controller-managed pod | Enter confirms, Esc cancels; dialog names resource, namespace, context |
| 2 | delete Deployment, StatefulSet, PVC; drain; any write on a protected context | Type the resource name |
| 3 | delete Namespace, CRD | Type the name; show dependent count |

- Delete dialog keeps k9s's propagation dropdown and Force checkbox, plus optional dry run.
- Multi-select: list items; type "delete N".
- No real undo for delete. Offer "re-apply last known YAML" for about 10 s; not available for PVC data.
- Protected contexts: coloured header band, all writes become tier 2. Read-only disables write keys.
- Sources: [Vercel Geist](https://vercel.com/geist/destructive-confirmation-input), [Smashing](https://smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces), [LogRocket](https://blog.logrocket.com/ux-design/ux-reversible-actions-framework/).

### 6.5 State colors

Semantic tokens as CSS custom properties; dark, light, follow-system. Values are proposals; contrast was not checked with a tool (targets: text 4.5:1, UI and focus rings 3:1).

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--bg-app` | `#0e1116` | `#f6f7f9` | |
| `--bg-panel` | `#151a21` | `#ffffff` | |
| `--bg-row-hover` | `#1b222b` | `#eef1f5` | |
| `--bg-row-selected` | `#1f3350` | `#dbe8fb` | |
| `--border` | `#2a3340` | `#d5dae1` | |
| `--text` / `--text-muted` | `#e6e9ee` / `#9aa4b2` | `#16191f` / `#5a6472` | |
| `--accent` / `--focus-ring` | `#4c9aff` / `#6bb0ff` | `#0b5fd6` / `#0b5fd6` | |
| `--state-ok` ● | `#3fb97a` | `#18794e` | Running and ready, Bound, Active, Flux Ready=True |
| `--state-progress` ◐ | `#4c9aff` | `#0b5fd6` | ContainerCreating, Init:n/m, rollout, Flux Reconciling |
| `--state-warn` ▲ | `#e5a83a` | `#8a5a00` | Long Pending, NotReady, restarts 5+, cordoned, usage above 80% of limit |
| `--state-error` ✕ | `#f0616d` | `#c42b3a` | CrashLoopBackOff, ImagePullBackOff, OOMKilled, Failed, Flux Ready=False |
| `--state-done` ○ | `#8b96a6` | `#5a6472` | Completed, suspended |
| `--state-terminating` | `#b78cf2` | `#7a43c2` | deletionTimestamp set |
| `--state-unknown` | `#6e7888` | `#78828f` | Unknown, stale data |

Rules:
- Derive display status from container states, phase and deletionTimestamp, as kubectl does. `CrashLoopBackOff` is a Waiting reason, not a phase ([pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle)).
- Colour the status cell and a leading glyph only. Never colour alone.
- Transient states turn warn after 60 s (configurable).
- Ready `1/2` is warn, `0/N` is error unless Completed. Events: Normal muted, Warning warn.
- Flux mapping is this project's own; verify against Flux status fields.
- Metrics thresholds follow k9s defaults: warn 70, critical 90.

### 6.6 Typography

- UI: `system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", sans-serif`. Base 13 px; table cells 12 px.
- Mono: bundled font for logs, YAML, terminal. Candidates JetBrains Mono, Geist Mono, Cascadia Code; licences not verified. Fallback `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. 12 px, line-height 1.4, ligatures off.
- `tabular-nums` and right alignment in numeric columns. Middle ellipsis for long names.
- Scale 11 / 12 / 13 / 15 / 18. Zoom with `Ctrl/Cmd +/-`.

### 6.7 Components

**Table.**
- Rows 24 px compact (default) or 28 px. Fixed height, so no measurement.
- Key rows by `metadata.uid`. Overscan about 10. Keep the focused row mounted.
- Rows do not reorder on data change while sorted on a volatile column; resort on user action.
- Changed cells flash about 600 ms (k9s delta equivalent); static marker under reduced motion.
- Focus and selection are separate. Bulk actions apply to marks, else the focused row.
- Ages: kubectl style (`45s`, `2d4h`), ticking on a coarse timer, ISO time on hover.
- Column order, visibility and sort persist per resource type.
- Empty state shows the active filter and a one-key clear. k9s v0.51.0 shows "syncing" instead of a false "no resources"; do the same.
- `role="grid"`, roving tabindex, `aria-rowcount`, `aria-rowindex`, `aria-sort` ([APG grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid), [TanStack virtualization](https://tanstack.com/table/latest/docs/framework/react/guide/virtualization)).

**Log viewer.**
- Custom virtualized line list with an ANSI SGR parser; not xterm.js ([xterm discussion](https://github-redirect.dependabot.com/xtermjs/xterm.js/discussions/4885)).
- Follow on by default; scrolling up pauses and shows "Jump to latest" with an unread count. Paused viewport never moves.
- Search highlights without hiding lines; `n`/`N` step. Filter-lines is a separate toggle.
- Container picker (init and ephemeral included), previous toggle, since selector, pod-name gutter for workloads.
- Indicator bar for autoscroll, wrap, timestamps, all-containers, as k9s has.
- Level colouring on the level token only, optional. Long lines truncated with expand.

**List.**
- Shell: `AppShell`, `Titlebar`, `HeaderInfo`, `HintBar`, `Sidebar`, `Breadcrumbs`, `Statusbar`, `SplitPane`.
- Input: `CommandPalette`, `FilterBar`, `ContextSwitcher`, `NamespaceSwitcher`, `KeyChip`, `ShortcutHelpOverlay`, `KeymapEditor`.
- Data: `ResourceTable`, `ColumnMenu`, `StatusCell`, `AgeCell`, `ReadyCell`, `UsageBar`, `LabelChips`, `OwnerLink`, `EmptyState`, `StaleBanner`.
- Detail: `DetailTabs`, `YamlViewer` (view, edit, diff), `DescribeView`, `EventsList`, `ConditionsList`, `ContainersTable`, `RelatedResources`.
- Streams: `LogViewer`, `LogToolbar`, `TerminalPane`, `PortForwardManager`.
- Feedback: `ConfirmDialog`, `Toast`, `BulkActionBar`, `ErrorBoundary` with API error mapping.
- Foundations: token files, state glyphs, `useKeymap` (context-scoped, chords, platform-aware), `useSubscription`.

**Accessibility.**
- Visible focus ring, 2 px, 3:1. Sticky regions must not cover the focused row ([WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)).
- Setting to disable single-key shortcuts (WCAG 2.1.4 `[unverified]` level).
- Honor `prefers-reduced-motion` and `forced-colors`.
- Rate-limited `aria-live` region; do not announce every watch update.

## 7. Cross-platform build & release

**Toolchain.** pnpm 11, electron-vite 6, electron-builder 26, electron-updater 6. Exact version pins. `pnpm-workspace.yaml` needs `allowBuilds: { electron: true }`. Whether electron-builder still needs a hoisted linker under pnpm is unconfirmed `[verify]`.

**GitHub Actions.**

| Job | Runner | Steps |
|---|---|---|
| check | `ubuntu-latest` | install, strict `tsc`, lint, unit tests |
| build-win | `windows-latest` | electron-builder NSIS x64 (arm64 optional), publish to GitHub Releases on tag |
| build-mac | `macos-latest` | electron-builder DMG + zip, arm64 (x64 optional), sign + notarize if secrets exist, publish |

- Mac artifacts need a mac runner (from recall, not fetched).
- Renovate for Electron bumps. Integration tests against k3s run locally, not in CI, unless a kind/k3d job is added.

**Signing.**

| Platform | Unsigned result | Signed cost |
|---|---|---|
| macOS | Gatekeeper warning; no auto-update, since Squirrel.Mac needs a signed app ([Electron docs](https://electronjs.org/docs/latest/tutorial/code-signing)). Ad-hoc arm64 not tested | Apple Developer, about $99/yr, Developer ID + notarization ([electron-builder](https://www.electron.build/docs/features/code-signing/code-signing-mac)) |
| Windows | SmartScreen warning; updater still works | Certificate or Azure Artifact Signing; price and eligibility for individuals not confirmed ([pricing](https://azure.microsoft.com/pricing/details/artifact-signing/)) |

**Auto-update.** electron-updater with the GitHub Releases provider. Windows from M0. macOS only if signed; otherwise show a "new version" link.

**Size targets.** Installer 90-110 MB and idle 200-300 MB are unverified estimates; measure in M1.

## 8. Milestone plan

| M | Name | Contents | Done when |
|---|---|---|---|
| M0 | Spike + skeleton | Repo, pnpm `allowBuilds`, electron-vite, strict tsc, CI matrix producing Windows and mac installers. Spike on real k3s: `raw()` with kubeconfig auth; watch across laptop sleep; exec with resize and 10-minute idle; port-forward with concurrent connections | All four spike items pass, or the fallback is chosen (kubectl for port-forward; Go sidecar if exec or watch fail) |
| M1 | Browse | Sessions, context and namespace switch, discovery, alias map, `ResourceWatcher`, Table list+watch, IPC subscriptions, virtualized table, sort, filter modes, palette with `:` grammar, history, hint bar, `?`, statusbar, dark theme | Every GVR incl. Flux CRDs is browsable by keyboard; memory and startup measured |
| M2 | Inspect | YAML viewer, describe with live events, drill-downs, owner jump, rich columns and derived status for core kinds, events view, metrics columns, cluster header, secret decode, RBAC gating | Daily read-only use replaces k9s |
| M3 | Logs | Log viewer, container picker, previous, since, workload logs, search, mark, clear, save | |
| M4 | Act | Edit with diff + dry run + apply, delete with tiers, kill, scale, restart, CronJob trigger/suspend, Flux suspend/resume/reconcile, Flux revert warning, read-only mode, protected contexts, marks and bulk | All P0 writes |
| M5 | Streams | Shell pane (xterm.js), attach, port-forward dialog and manager, connection health polish | P0 complete |
| M6 | Release | Auto-update, signing per decision, settings, keymap file, k9s-mode preset, light theme | v1.0 |
| M7 | P1 ops | Helm (read, then CLI-backed writes), set image, rollback, cordon/drain, used-by, sanitize, file transfer, extra columns | |
| M8 | P1 views | Pulses, Xray, workload view, CRD view, RBAC rules, custom columns, aliases, hotkeys, jumps, PF annotations, Flux trace | |
| M9 | P2 | Plugins, node shell, `:can`, multi-cluster tables, local shell, scans | As wanted |

## 9. Open questions

**Decisions.**
- Mac signing: pay $99/yr, or no mac auto-update?
- Windows signing, or SmartScreen OK?
- Mac available for testing, or CI-only?
- kubectl on PATH OK as a hard dependency for port-forward?
- Default keymap: safe defaults, or k9s mode?
- Writes from M4, or read-only first release?
- Local shell tab ever needed?
- 90+ MB install and 200-300 MB idle acceptable?
- If spike fails: install Go for a sidecar?
- Light theme in v1?
- Bundle a mono font, which one?
- App name? (KNS?)
- Multi-cluster merged table: ever?

**Unresolved between inputs.**
- Fallback stack: Wails v3 (stack doc) vs Electron + Go sidecar (review).
- kubectl dependency: avoid (API doc) vs accept (review).
- Editor: CodeMirror vs Monaco. UI kit: Radix vs Base UI vs React Aria.

**Verify by test.**
- k3s serves the legacy WebSocket port-forward path?
- Exec RBAC: `get`, `create`, or both?
- WatchList gate on in this k3s?
- client-node merge order vs kubectl?
- Proxy handling for undici and `ws`?
- Helm gzip magic bytes.
- Full-object vs Table lists for rich views.
- electron-builder + pnpm 11 linker mode.
- Ad-hoc signed mac build: updater works?
- Wails advisory patch status (only if Wails is reconsidered).
- Colour contrast of all tokens.
- k9s column lists for STS, DS, Job, RS, PVC, CRD, Events (not read from source).