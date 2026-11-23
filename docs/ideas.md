# kns — ideas: debugging, local dev, agents (2026-11-22)

Status: proposals only. Nothing here is built, scheduled or promised. Written from the owner's wish: *"an insanely nice tool for debugging and for connecting to local services for local development; support for agents too."*

**Evidence tags** (same idea as `research.md`):

- `[code]` read in this repo (or in the local cargo registry / the owner's cluster manifests) today
- `[docs]` stated in this repo's docs or in the owner's cluster notes
- `[web]` checked on the web today (sources at the end)
- `[recall]` from memory, not re-checked
- `[assumed]` a guess; test before relying on it
- `[planned]` already in `research.md` / `ux.md` / README as P0/P1/P2; listed for context, not as a new idea

**Keys.** `:` commands and palette entries are the real proposal. Single keys are marked *(key?)*: I did not audit every scope in `keymap-data.ts`, so each needs a collision check against ux §5.4/§5.6. No proposal uses AltGr characters or Ctrl+Alt. Every action also gets a row button / toolbar button / context-menu entry through the registry (`frontend.md` §17), so mouse parity is free.

**Command names.** `:word` is first a resource alias (`:pod`, `:ctx`, discovery short names; ux §6.2 `[docs]`). The verbs proposed here (`:why`, `:timeline`, `:diff`, `:debug`, `:reach`, `:trap`, `:patterns`, `:dev`, `:env`, `:pack`, `:mcp`, `:explain`, `:x`, `:kubectl`) are not in the §6.2 table, but any of them can collide with a CRD's name or short name in some cluster. Rule to adopt: a built-in verb wins, the resource stays reachable by its full `resource.group` name, and the palette shows both. Names are placeholders.

**Shape rules respected.** One view per pane (new things are new view kinds or dialogs, never docks). Cluster text is rendered as text. Secrets and kubeconfigs stay in Rust. Writes go through the existing tiers, read-only mode, protected contexts and `canI`.

---

## Top 10 by value / effort

| # | Idea | Theme | Effort | Why it ranks here |
|---|---|---|---|---|
| 1 | **Forwards that target a Service or workload**, survive rollouts, keep the local port (L1) | dev | S–M | ux §13.5 already promises it; `ForwardQuery` is pod-only `[code]`. Everything else in theme 2 stands on it |
| 2 | **Dev sets**: N forwards up with one command, saved per context (L2) | dev | S–M | Daily use; mostly persistence + a list on top of #1 |
| 3 | **`:why`**: rule-based "why is this not running" with clickable evidence (D1) | debug | M | The single biggest debugging win; no LLM, no cluster agent |
| 4 | **Dev from workload**: resolve a workload's env, rewrite in-cluster addresses to the forwards, export `.env` (L4) | dev | M | "Run my local process as if it were this pod", honestly scoped |
| 5 | **Copy as context**: redacted bundle of the selection for any agent (A1) | agents | S | Agent support with zero protocol and zero new attack surface |
| 6 | **Diff anything**: two marked rows, revision vs revision, field ownership (D7) | debug | S | Reuses the REVIEW diff component |
| 7 | **Crash card**: last termination, exit code meaning, lifetime in the containers view (D2) | debug | S | The data is already parsed for describe `[code]`; this puts it in the triage path |
| 8 | **Logs: structured mode + patterns** on top of merged logs (D4) | debug | M–L | Merged logs are an open P0 anyway; do the parsing at ingest once |
| 9 | **kns MCP server**: read tools + "what the user is looking at" + proposals approved in the kns UI (A2) | agents | M (read) → L | The distinctive agent story; needs #3 and #5's redaction layer first |
| 10 | **Debug container** (`kubectl debug` in a pane) (D5) | debug | M | kube-rs has the call `[code]`; the shell pane and picker already handle ephemeral containers `[code]` |

Next in line: timeline + local event journal (D3), trap (D9), sparklines (D8), `:reach` (D6).

---

## Theme 1 — Debugging

What exists `[docs, README]`: describe with live events, logs (follow, previous, search, filter-lines, marks), shell, containers view, faults filter, owner/node jumps, pod CPU/MEM. Missing for real triage: an answer to "why", history, correlation across objects, and anything for images without a shell.

Limits that shape this theme:

- Events expire: the apiserver default `--event-ttl` is 1h `[web]`; k3s is assumed to keep that default `[assumed]`.
- `metrics.k8s.io` serves the latest sample only, no history `[recall]`. There is no Prometheus in the owner's cluster (nothing in the cluster manifests `[code]`).
- So history must be collected by kns while it runs, or reconstructed from object state (ReplicaSets, `lastState`, Flux status).

### D1. `:why` — explain a broken resource

- **Pitch:** one key on any row answers "why is this not running / not reachable / not ready" as an ordered list of findings, each with its evidence and a jump.
- **Flow:** `:why` or *(key? `W`)* on a row; `+ W` opens it beside and it follows the cursor like describe (ux §4.5). The view is a short list, most likely cause first:
  ```
  shop / pods / orders-6f7c9 / why                     FOLLOW <-1
  ✕ container orders: CrashLoopBackOff, 14 restarts, last exit 1 after 3s
      last lines (previous):  Caused by: UnknownHostException: kafka.kafka.svc…    Enter → logs at that line
  ! rollout 12m ago changed image …:20261122101500-ab12 → …-cd34                    Enter → diff of the two ReplicaSets
  · node node-1: no pressure, 61% memory allocatable used
  ```
  `j`/`k` move, `Enter` follows the evidence (log line, event's object, diff, the Secret that is missing), `c` copies the findings as text. Mouse: click a finding, hover bar with the same jumps.
- **Rules (deterministic, in Rust, unit-testable from fixtures):**
  - Pod: phase, conditions, `containerStatuses[].state/lastState` (reason, exit code, signal, OOMKilled), init containers, `FailedScheduling` message parsed (insufficient cpu/memory, taints, affinity, unbound PVC), image pull errors, failing probes (`Unhealthy` events), missing ConfigMap/Secret/key references, PVC Pending and its events.
  - Workload: `Progressing`/`Available` conditions, newest ReplicaSet's pods, quota/admission errors on the ReplicaSet, "what changed" = template diff against the previous ReplicaSet.
  - Service: no ready endpoints → selector matches 0 pods / pods not ready / `targetPort` names a port no container has.
  - Ingress: backend Service or port missing, TLS secret missing, cert-manager `Certificate` not Ready (the owner uses cert-manager `[docs]`).
  - Flux kinds: `Ready=False` message, failing `dependsOn`, source artifact revision vs applied revision, suspended.
  - CronJob/Job: last job failed, `backoffLimit` reached, suspended.
- **Backend:** new `diagnose(ref) -> Finding[]` with `Finding {severity, title, detail, evidence: Evidence[]}` and `Evidence = {kind: "object"|"logLine"|"event"|"diff", ref, …}`. Uses calls that exist (`get`, `list_events`, `pods_for`) plus a short previous-log tail. Putting it in Rust (not the frontend) matters: the MCP server (A2) reuses it.
- **Effort:** M. Ship pod + workload rules first, then Service/Ingress/Flux.
- **Risk:** a wrong "most likely cause" is worse than none. Every finding must show its evidence verbatim and say "no known cause found" when rules do not match. Never hide the raw describe.
- **Beats:** k9s gives a status word; Lens/Headlamp give an events tab; k8sgpt and SaaS tools need an LLM or an in-cluster agent. Here the answer is local, instant, and every line is a link into panes kns already has.

### D2. Crash card in the containers view

- **Pitch:** for each container show how it last died, without opening YAML.
- **Flow:** extra columns/lines in the containers view (ux §12.5): `LAST EXIT 137 OOMKilled · lived 41s · 14:02:11`, with exit codes translated (137 SIGKILL/OOM, 143 SIGTERM, 126/127 command not runnable, 139 segfault). `p` (previous logs, exists) from that row. In `:why` the same data is finding 1.
- **Already there `[code]`:** describe prints `Last State: Terminated (reason, exit code N, … ago)` (`src/views/doc/describe.ts`), and the containers table derives its STATE word from the *current* state only (`src/table/containers.ts`). The containers view (ux §12.5) has no last-termination column. So this is a presentation change: surface it where you triage, translate the code, add the lifetime.
- **Backend:** none; the pod object the view already watches.
- **Effort:** S. **Risk:** low.
- **Beats:** in k9s this is describe + scroll + mental exit-code lookup.

### D3. Timeline, and a local event journal

- **Pitch:** one time-ordered table of everything that happened to a workload and its neighbours.
- **Flow:** `:timeline` (alias `:tl`) on a row opens a table view: `TIME · SOURCE · WHAT`. Rows merge: events of the object, its owners, its pods and its node; ReplicaSet creations (= rollouts, with image change); container starts and terminations; HPA scaling; Flux reconcile revisions; kns's own operations from the activity panel. `Enter` jumps to the source object; `l` on a row opens logs positioned at that time. A log pane and a timeline pane opened beside each other can be **time-linked** (leader `f`, the existing follow toggle): moving the cursor in one moves the other to the nearest timestamp.
- **Journal:** opt-in per context, kns appends the Warning events it sees to a small ring file in the app data dir (say 7 days / 20 MB). The timeline then shows "from journal" rows older than the cluster remembers.
- **Backend:** `timeline(ref) -> TimelineRow[]` (composition of existing reads). `LogQuery` needs `sinceTime` (it has only `sinceSeconds` `[code]`). Journal = a background events watch per connected context + a file.
- **Effort:** M (timeline), +S (journal). **Risk:** the journal only covers hours when kns ran; label that clearly. An always-on events watch costs idle network; keep it opt-in (prior-art: idle cost is a feature `[docs]`).
- **Beats:** nobody local-first correlates rollout + events + restarts on one axis; and no desktop tool keeps events past the TTL without a cluster component.

### D4. Logs: merged, structured, patterns

- **Merged logs of marked rows** `[planned, P0, not built]`: `LogTarget` has no multi-object form `[docs frontend §16]`. Add `{by: "objects", refs}`. Everything below assumes it.
- **Structured mode.** Detect JSON and logfmt lines at ingest in Rust (prior-art: parse at ingest, not render `[docs]`). The line shows `level  message` and folds the rest; `Enter` (expand line, exists) shows the fields as an aligned key/value block. Filter chips on fields: `level>=warn`, `.traceId=abc`. Toggle *(key? `J` in logs)* or toolbar button. Plain lines are untouched.
- **Patterns.** `:patterns` *(key? `P` in logs)* turns the buffer into a table of line templates (numbers, hex, UUIDs, quoted strings masked): `COUNT · FIRST · LAST · TEMPLATE`, sorted by count. `Enter` returns to the log filtered to that pattern; `!` keeps only patterns with an error-ish level. **"New since rollout"**: for a workload, patterns that occur in the current ReplicaSet's pods and never in the previous container run (`previous` logs) are flagged `NEW`. That answers "what is this version saying that the last one did not".
- **Jump from a line to its pod:** palette action "Go to pod of this line" *(key? unassigned; `o` is the container picker in logs `[code]`)* or click the pod gutter → the pods table with the cursor on that pod; `+` variant opens beside.
- **Backend:** `LogLine` gains optional `level` and `fields`; a `log_patterns(streamId)` command (clustering in Rust over the buffered lines; the buffer then has to live in Rust as JET Pilot does `[docs prior-art]`, or the frontend sends the window). Effort M for structured, M for patterns.
- **Risk:** template mining on 10k lines must stay under a frame budget; do it off the UI thread and on demand, never per line.
- **Beats:** stern and Kubetail merge and colour streams `[recall]`; JSON-aware parsing is on JET Pilot's list `[docs research §3]`. Nobody in this class does patterns or a new-since-rollout diff locally.

### D5. Debug container (ephemeral) and debug copy

- **Pitch:** a shell for images that have none, in the same shell pane.
- **Flow:** `:debug` on a pod or container → dialog: image (remembered list; default `busybox`, one keystroke for a network toolbox image), target container (shares its process namespace), `Enter`. kns adds the ephemeral container, waits for Running, and opens the shell pane attached to it. The dialog states the fact kubectl hides: an ephemeral container cannot be removed; it goes away when the pod does.
- **Debug copy:** `:debug copy` creates a copy of the pod with the command replaced by a sleep, owner references and Service-selected labels stripped, labelled `kns.dev/debug=true`. The activity panel lists these under "Debug pods" with `x` = delete; kns offers cleanup on quit.
- **Backend:** `Api<Pod>::patch_ephemeral_containers` exists in kube-client 5.1 `[code: registry source]`. New command `debug_container(ref, image, target) -> container name`; then the existing `exec` with `attach`. `PodRef.ephemeralContainers` and the container picker already cover the rest `[code/docs]`. `canI patch pods/ephemeralcontainers` gates it. Ephemeral containers are GA since 1.25 `[recall]`; the cluster is 1.35 `[docs]`.
- **Tiers:** a write. Tier 1 on ordinary contexts, tier 2 on protected. The pod is not a Flux object, so Flux does not revert it `[assumed]`.
- **Effort:** M. **Risk:** pulling an arbitrary image into a prod pod; keep the image list explicit and show the full image reference in the confirm.
- **Beats:** k9s has no debug action `[recall]`; Lens-family tools mostly shell out to kubectl. Here it is one dialog and the result lands in a pane with copy mode and search.

### D6. `:reach` — can A talk to B

- **Pitch:** show the path from a pod to a target as a chain of checks, first failure highlighted.
- **Flow:** `:reach <target>` from a pod row (target picked with the palette's object search). Result view:
  ```
  orders-6f7c9  →  kafka.kafka:9092
  ✓ Service kafka/kafka exists, port 9092 → targetPort 9092
  ✓ 1 ready endpoint: kafka-0
  ✓ NetworkPolicy kafka/kafka-broker selects the target: allows all namespaces on 9092
  ? active probe not run            Enter runs: DNS + TCP connect from the pod
  ```
- **Two levels:** (1) static, read-only: Service → EndpointSlice → pod readiness → port match → NetworkPolicy evaluation (which policies select the target, does the source match). The owner's `kafka` namespace uses NetworkPolicies `[code: cluster manifests]`, so this is not hypothetical. (2) active, on `Enter`: exec a one-liner in the source container if it has `nc`/`wget`/`curl`/bash `/dev/tcp`; otherwise offer D5 with a toolbox image.
- **Backend:** `reach(from, to, port) -> Check[]`; reads only. Active probe = existing `exec` with a fixed command, output parsed.
- **Effort:** M static, +S active. **Risk:** NetworkPolicy semantics (and CNI-specific policies) are easy to get subtly wrong; label the static verdict "by standard NetworkPolicy rules" and let the active probe be the truth.
- **Beats:** today this is five kubectl commands and a mental model.

### D7. Diff anything

- **Two marked rows:** `Space`, `Space`, `:diff` → a read-only REVIEW-style diff of their YAML (managedFields and status stripped by default; `m` toggles). Works across namespaces and kinds.
- **Revisions:** on a Deployment, `z` (ReplicaSets, exists) then mark two; on StatefulSet/DaemonSet the same over ControllerRevisions; on a HelmRelease over its history. `:diff prev` = current vs previous revision in one step. Rollback itself is `[planned, P1]`.
- **Field ownership ("who wrote this").** In YAML view a gutter letter per field from `managedFields`: Flux (`kustomize-controller`/`helm-controller`), `kns`, `kubectl`, controllers. A filter shows only fields on a Flux-managed object **not** owned by Flux = manual drift that the next reconcile will fight over. Flux applies server-side, so there is no `last-applied-configuration` annotation to diff against `[recall]`; managedFields is the form that works. Where the annotation exists (kubectl client-side apply), offer live vs last-applied too.
- **Flux source vs cluster:** ruled out as a built-in, see "Ruled out".
- **Backend:** none for the first two (`getYaml` ×2, frontend diff exists). Ownership needs a managedFields → path map: small Rust helper or frontend.
- **Effort:** S (marked rows, revisions), M (ownership gutter). **Risk:** low.
- **Beats:** `kubectl diff` needs files; Lens has no object-vs-object diff `[recall]`.

### D8. Sparklines from kns's own samples

- **Pitch:** tiny CPU/MEM history per pod, with the memory limit as a line, so an OOM is visible before it happens.
- **Flow:** wide view (`*`) of pods gains a sparkline cell; the containers view shows memory vs limit. Static drawing, no animation (ux §16).
- **Backend:** Rust keeps a ring per pod (15s × 60 min) only for namespaces with a visible pods table; `pod_metrics_history(ns)`. Pulses is `[planned, P1]`; this is the cheap part of it.
- **Effort:** S–M. **Risk:** history starts when the table was first shown; draw the gap honestly. More depth (kubelet `/metrics/resource` through `nodes/proxy`) is P2 and needs extra RBAC `[recall]`.
- **Beats:** k9s and the metrics API show one number; Lens-family charts need Prometheus `[recall]`. This needs nothing in the cluster.

### D9. Trap — catch the next failure

- **Pitch:** arm a workload; when it next restarts, fails a probe or gets a Warning, kns captures the evidence automatically.
- **Flow:** `:trap` on a row → the activity panel shows `trap: orders (armed 2h)`. On trigger: toast + an **incident bundle** saved locally: previous logs, the last N lines before death, events, pod YAML, metric samples (D8), the `:why` findings. `Enter` on the bundle opens it as a doc; `:trap list` is a tool view.
- **Backend:** a watch on the pods of the target + `diagnose` + log tail; bundle = files under app data, secrets redacted (A1's redactor).
- **Effort:** M. **Risk:** only works while kns runs; say so in the row (`armed while kns is open`).
- **Beats:** intermittent crash loops are the classic "it was fine when I looked" problem; no desktop tool captures them unattended. The bundle is also exactly what an agent wants (theme 3).

### D10. Smaller ones (unscored: no separate risk or comparison; all read-only and low risk)

- **Relations view** — one tree per object with three sections: *up* (owner chain to the Flux Kustomization = Flux trace `[planned]`), *traffic* (Ingress host/path → Service → endpoints → pods), *uses* (ConfigMaps, Secrets, PVCs = used-by `[planned]`, reversed). Each row carries its status glyph; the first broken link is where to look. A tree table, not a drawn graph: denser, keyboard-native. This is Xray `[planned, P1]` pointed at debugging. M.
- **Rollout watch** — extends the activity panel's "operations in flight" rows that `requirements.md` already asks for `[planned]`: after restart / scale / reconcile the row shows `2/3 updated · 1 unavailable · waiting 40s` and, on stall, `Enter` opens `:why`. S–M.
- **Exec snippets** — named one-liners per image/label (`env | sort`, `cat /etc/resolv.conf`, `psql …`), `:x <name>`; output goes to a doc pane (searchable, copyable) or runs in the shell pane. The k9s-plugin use case without shelling out locally. S–M.
- **Copy as kubectl** — any kns action can print its `kubectl` equivalent (`:kubectl`), for runbooks, scripts and agents. S.

---

## Theme 2 — Local development against the cluster

The example cluster these ideas were written against `[docs: cluster notes; code: cluster manifests]`:

- Single-node k3s 1.35, Flux, Kafka (KRaft, PLAINTEXT), Schema Registry, kafka-ui, Postgres (pgvector) and memcached in `payments`, apps wired by env (`KAFKA_BOOTSTRAP_SERVERS`, `DATABASE_URL`, `envFrom` a Secret, many `secretKeyRef`s).
- Kafka has two listeners: `INTERNAL` advertising `kafka.kafka.svc.cluster.local:9092` and `LOCAL` advertising `localhost:9094`, made for port-forwarding `[code: cluster manifests]`. So a forward of 9092 connects and then fails on the advertised name; a forward of 9094 works **only on local port 9094**. A dev tool that knows this is worth more than a generic one.

What kube-rs + Tauri can do without admin rights on Windows and macOS:

| Capability | No admin | Notes |
|---|---|---|
| TCP forward to pod/Service/workload on `127.0.0.1:<port>` | yes | built today for pods `[code]` |
| Stable local ports, auto-reconnect, failover | yes | each connection already opens its own stream `[code]`; needs target re-resolution |
| Ports < 1024 | macOS yes on recent versions `[recall]`, Windows yes `[recall]` | verify; avoid by default |
| One loopback IP per service (`127.0.1.x:5432`) | Windows: yes, any `127/8` address binds `[recall]`. macOS: no, needs `sudo ifconfig lo0 alias` `[web]` | Windows-only nicety |
| `name.localhost` hostnames | Chromium and Firefox resolve it themselves `[recall]`; Safari and non-browser clients use the OS resolver, with mixed reports per OS version `[web]` | fine for HTTP UIs in Chrome/Edge/Firefox; verify Safari; not for JDBC/Kafka |
| Real cluster names (`kafka.kafka.svc.cluster.local`) locally | no: hosts file needs admin on both `[web]` | opt-in elevated helper at most |
| Reverse traffic (cluster → laptop) | only via a helper pod | port-forward is client-initiated `[recall]` |
| Full cluster network / VPN (Telepresence-style) | no: TUN driver or root daemon `[web]` | ruled out |
| UDP forward | no: needs a relay pod `[web: kftray]` | ruled out |

### L1. Forward a Service or workload, with failover and a stable port

- **Pitch:** forward the thing you mean (a Service), not the pod that happens to back it.
- **Flow:** unchanged: `F` on a Service/workload row → dialog → `Enter`. The manager row reads `svc/kafka → kafka-0` and, during a rollout, `waiting for a ready pod`; the local port stays bound, clients just retry. A named Service port resolves through `targetPort` to the container port.
- **Backend (the code gap):** `ForwardQuery` has `pod` only and `forward.rs` pins `Target.pod` `[code]`, while ux §13.5 says "forwards follow a workload across rollouts". Change `ForwardQuery` to `target: {kind: "pod"|"service"|"workload", ref}` + `remotePort: number | name`; resolve to a ready pod per accepted connection (cache with a pods watch or a short TTL); `Forward` gains `resolvedPod` and status `waiting`. After laptop sleep the next connection simply re-resolves.
- **Effort:** S–M. **Risk:** low; a contract change touching `types.ts`, `ipc.rs`, `tauri.ts`, `mock.ts` together.
- **Beats:** `kubectl port-forward svc/x` picks one pod and dies with it; k9s forwards die on rollout `[recall]`. Aptakube/JET Pilot already do this `[docs research §3]`, so it is table stakes.

### L2. Dev sets

- **Pitch:** "bring up my dev environment" is one command.
- **Flow:** `:dev` opens the picker (the `'` picker component with a `dev` group); `:dev up shop`, `:dev down`. The activity panel's port-forward group gets a set header with start/stop-all (`x` on the header). `:dev save <name>` turns the forwards running right now into a set. Home view gets a "Dev sets" section. Optional auto-start at launch per set (ux §3.6 lists forward restore as P1 opt-in `[planned]`).
- **Data:** `DevSet {id, name, context, forwards: [{target, remotePort, localPort, address, label}], rewrites: [{from, to}], env?: {workload, container}}` in `PersistedState`. Optionally also readable from a `kns.dev.yaml` in a project folder so a set lives with the repo (no secrets in it: only references).
- **Example for this cluster:** set `shop`: `svc/kafka 9094 → 9094` (pinned), `svc/schema-registry 8081 → 8081`, `svc/kafka-ui 8080 → 8080`; rewrite `kafka.kafka.svc.cluster.local:9092 → localhost:9094`.
- **Port conflicts:** `AddrInUse` exists as an error reason `[docs architecture]`. A pinned port that is taken fails loudly with "retry / pick another"; an unpinned one silently takes the next free port and the rewrite follows it.
- **Backend:** none beyond L1; `start_forward` in a loop. **Effort:** S–M. **Risk:** low.
- **Beats:** kftray does profiles as a separate tray app with JSON/Git sync `[web]`; kubefwd needs sudo `[web]`. Here sets sit next to the resources, share the keyboard model, and feed L4.

### L3. Names without admin

Ordered by how much I would build:

1. **HTTP by name on one port (build).** kns runs a small loopback HTTP reverse proxy (say `127.0.0.1:7080`) that routes by `Host`: `http://kafka-ui.kafka.localhost:7080` → the forward for `svc/kafka-ui`. Chromium-based browsers and Firefox resolve `*.localhost` to loopback themselves `[recall]`; Safari leaves it to macOS, where reports differ by version `[web]`, so on macOS this needs a test and a fallback to plain `localhost:<port>`. One port, any number of web UIs, no hosts file, and "open in browser" becomes a stable bookmarkable URL. HTTP only. Effort S–M. Risk: one more local listener; loopback only, unknown `Host` values are refused. Beats kubefwd/kftray names, which need admin `[web]`. (Opening the browser needs the opener capability, a known gap `[docs README]`.)
2. **Address rewriting instead of DNS (build, part of L4).** Do not make the cluster name resolve; change the value the app reads. Covers Postgres/Kafka/Redis clients with no privileges at all.
3. **Per-service loopback IPs (Windows only, maybe).** `127.0.1.5:5432` for one Postgres and `127.0.1.6:5432` for another, so real ports never clash. Not portable to macOS without sudo.
4. **Hosts-file block (opt-in, later; L effort; risk: elevation, and leftover entries after a crash).** A one-shot elevated helper (UAC / `osascript` admin prompt) writes a marked block for a dev set and removes it on `:dev down`. kns itself never runs elevated. Only worth it if rewriting proves insufficient.

### L4. Dev from workload: env export with rewrite

- **Pitch:** pick a Deployment, get what you need to run it locally: its dependencies forwarded and its environment in a file, with cluster addresses pointing at the forwards.
- **Flow:** `:dev from` (or `:env`) on a workload → a review screen (same shape as REVIEW):
  ```
  shop / deploy / orders / env                         14 keys · 9 from secrets
  KEY                       SOURCE                     VALUE                                  →
  KAFKA_BOOTSTRAP_SERVERS   literal                    kafka.kafka.svc.cluster.local:9092     localhost:9094   (listener LOCAL)
  SCHEMA_REGISTRY_URL       literal                    http://schema-registry.kafka…:8081     http://localhost:8081
  API_PASSWORD              secret app-env             ••••
  …
  forwards to start: svc/kafka 9094, svc/schema-registry 8081            [save as dev set]
  ```
  Keys: `Space` include/exclude a key, `x` reveal one value (re-masks on blur, as secrets do today), `Enter` exports. Export targets: file (`.env`), clipboard as dotenv / PowerShell `$env:…` / `export …`.
- **What it resolves:** `env` literals, `valueFrom` (ConfigMap key, Secret key, field refs where knowable), `envFrom` (ConfigMap, Secret), per container. Optionally mounted ConfigMap/Secret volumes written to a local folder.
- **Dependency detection:** values are scanned for in-cluster addresses (`name.ns.svc[.cluster.local][:port]`, `name.ns:port`, same-namespace `name:port` that matches a Service). Each hit proposes a forward and a rewrite. That is how a dev set can be generated from a workload instead of typed.
- **Kafka awareness:** if the target is a Kafka broker, kns reads the broker pod's `KAFKA_ADVERTISED_LISTENERS`. It warns when the forwarded port's listener advertises a name the laptop cannot reach, and suggests the listener that advertises `localhost:<port>` with that exact local port pinned. On this cluster that turns `…:9092` into `localhost:9094` automatically `[code: cluster manifests]`.
- **Safety:**
  - Secret values are fetched and written **in Rust**; the webview receives masked rows and gets a value only on explicit reveal.
  - File export refuses a path inside a git work tree that is not ignored (`git check-ignore`), unless confirmed; file mode 0600 on macOS.
  - Clipboard export offers auto-clear after 60s. kns never persists values, only references.
  - The activity panel records `exported 14 keys (9 secret) of deploy/orders to <path>` — names, never values.
  - Protected context: tier 2 (type the workload name). Read-only mode does not block it (it is not a cluster write) but the confirm still applies.
- **Backend:** `resolve_env(ref, container) -> EnvRow[]` (masked), `reveal_env(ref, container, key)`, `export_env(ref, container, keys, rewrites, target)`.
- **Effort:** M. **Risk:** this is a secrets-to-disk feature; the guards above are the feature, not decoration.
- **Honest limit:** the local process gets the pod's *configuration* and *outbound dependencies*. It does not get the pod's network identity, DNS, service account token (never exported), volumes or inbound traffic. Naming it "run as pod" would overpromise.
- **Beats:** the usual way is `kubectl get secret -o json | jq | base64 -d` per key plus hand-editing hostnames. Telepresence/mirrord solve the same need with privileged components `[web]`; this covers the common case with none.

### L5. Service-aware helpers

Detection by container image and port (Postgres 5432, Redis 6379, memcached 11211, Kafka, Schema Registry). All are thin:

- **Connection string:** on a forward row, `c` copies `localhost:port` today `[docs]`; add `C` *(key?)* = full URL built from a Secret the user picks once (remembered in the dev set as a reference), host rewritten to the forward. Clipboard with auto-clear.
- **Client inside the pod, no secret leaves the cluster:** `:x psql` on a Postgres pod = shell pane running `psql` with the pod's own env; `:x redis-cli` likewise. This is an exec snippet (D10) with detection.
- **Kafka at a glance:** snippets `:x kafka-topics` / `:x kafka-groups` run the broker image's own scripts via exec (`kafka-topics.sh --describe`, `kafka-consumer-groups.sh --describe --all-groups`; path in the `apache/kafka` image `[assumed]`) and render the output as a sortable table: topic, partitions, group, lag. No Kafka client is linked into kns.
- **Schema Registry:** HTTP through the forward or L3 proxy; open in the browser. Nothing custom.
- **Effort:** S each. **Risk:** output parsing of CLI tools is brittle across versions; show raw output when parsing fails. A copied connection string is a secret on the clipboard.
- **Beats:** a dedicated client needs the forward, the credentials and a profile per service; this is one command on the row, and the in-pod variants move no secret at all.

### L6. Reverse traffic and intercepts — honest assessment

- **What real intercept tools need** `[web]`: mirrord starts a privileged agent pod and injects a library into the local process (no native Windows injection). Telepresence needs a cluster-side traffic manager and a local root daemon / Windows service. Neither fits "no admin, no cluster agent".
- **What kns could do: preview route (P2, L effort).** A small unprivileged relay pod (kns-owned image) accepts connections in the cluster and relays them over a stream kns opened (port-forward to the relay's control port), to a local port. A **new** Service (and optionally Ingress host) points at the relay: `dev-orders.shop`. Existing objects are untouched, so Flux has nothing to revert. Use case: webhooks and callbacks hitting the laptop.
- **True intercept (not recommended):** repoint an existing Service's selector at the relay. Flux reverts it at the next reconcile `[docs research §5]`, so it must go through the existing suspend offer in REVIEW, and it steals all traffic on a single-replica app. On a personal cluster that is survivable, but it is the riskiest thing in this document.
- **Costs either way:** an image to publish and patch, a multiplexing protocol, crash cleanup (label + `activeDeadlineSeconds`), a write path with tiers.
- **Cheap alternative:** if `mirrord` is installed (macOS/Linux/WSL), `:mirrord` on a pod copies or launches `mirrord exec --target pod/<name> -- …` in the OS terminal. S effort, zero new machinery.

### L7. Already planned, relevant here

Port-forward annotations (`k9scli.io/*`) `[planned, P1]`, file transfer `[planned, P1]`, open forward in browser (known gap `[docs README]`).

---

## Theme 3 — Agent support

### Principles (non-negotiable, apply to every idea below)

1. **Cluster text is untrusted input.** Logs, annotations, event messages and ConfigMaps can contain instructions aimed at a model. No design may depend on the model resisting them.
2. **So the defence is capability, not prompting.** Nothing an agent can call changes the cluster. Writes exist only as *proposals* that a human approves **in the kns window**, through the same tiers as a manual action.
3. **Approval is never delegated to the client.** MCP tool annotations are hints that clients must treat as untrusted, not a security layer `[web]`. Elicitation is rendered by the client, is an optional capability, and the spec leaves the interaction model open `[web: spec 2026-07-28]`. Neither is a confirm dialog kns controls.
4. **Credentials never leave Rust.** No tool returns kubeconfig content, tokens, server credentials or exec-plugin output. The webview CSP allows only `self` and IPC `[code: tauri.conf.json]`; model and MCP traffic lives in Rust and the CSP stays as it is.
5. **Redaction happens in Rust before serialization**, by one function used by every agent-facing path (A1, A2, A3, D9 bundles).
6. **No escape hatches.** No raw API passthrough, no generic `kubectl`, no exec, no `decodeSecret`, no file paths. The Kubernetes MCP servers with 2026 CVEs failed exactly there: a generic kubectl tool with flag injection, a raw passthrough that bypassed redaction, read-only flags enforced by convention `[web]`.
7. **Everything is visible.** Each tool call is a row in the activity panel and a line in a local audit log.
8. **Per-context policy:** `agents: off | read | read + propose`. Default `off`; protected contexts cannot go above `read` without a tier 2 confirm; read-only contexts reject proposals outright. Optional namespace allowlist.

Residual risk to state plainly: an agent that can read logs and also has web access can leak what it read. Redaction and the namespace allowlist reduce it; they do not remove it.

### Redaction (shared layer)

- Always: Secret `data`/`stringData`; Helm release secrets; `last-applied-configuration` annotations; service account tokens.
- Env and ConfigMap values whose **key** matches `PASSWORD|PASSWD|SECRET|TOKEN|KEY|CREDENTIAL|DSN|AUTH`, and URLs with userinfo (`postgres://user:pw@…` → `postgres://user:•••@…`).
- Logs, best effort: PEM blocks, JWT-shaped strings, `Bearer …`, URL userinfo. Best effort means it will miss things; the UI says "redacted N values" and never "safe".
- Each response reports its redaction count; the context pack preview (A1) shows what was removed.

### A1. Copy as context (ship first)

- **Pitch:** one action turns the current selection into a compact, redacted bundle any agent can use. No protocol, no server.
- **Flow:** `:pack` (palette: "Copy for agent"; not `:context`, which reads as the contexts resource) on a row, on marked rows, or in a log/doc pane with a line selection. It opens a **doc pane preview** (it is just a document): header with what/where/when, `:why` findings, trimmed YAML (managedFields stripped, status kept), events, last N log lines incl. previous run, owner chain. A size line shows bytes and an approximate token count. `c` copies, `Ctrl/⌘+S` saves to a file, `Space` on a section drops it.
- **Format:** markdown; every block of cluster text is fenced and labelled with its source, and the header says the fenced content is data from a cluster, not instructions.
- **Backend:** `context_pack(refs, opts) -> string`, composed in Rust from `diagnose` (D1), `get`, `list_events`, a log tail, and the redactor.
- **Effort:** S once D1 exists (S–M without). **Risk:** low; nothing leaves the machine unless the user pastes it.
- **Beats:** today it is five copy-pastes with secrets in them.

### A2. kns as an MCP server (direction a — recommended first)

- **Pitch:** an agent the owner already uses (Claude Code in a terminal) can see what kns sees and ask for changes, and every change is approved in kns.
- **Why inside the app, not a standalone server:** the running app has the sessions, the caches, the UI state ("what is selected") and the confirm dialogs. A standalone stdio server would be one more kubeconfig-reading process with its own policy.
- **Transport (decision):** Streamable HTTP served by the Rust backend on `127.0.0.1:<port>`, off by default (`:mcp on`).
  - The spec requires Origin validation (403 on a bad Origin), says local servers should bind to localhost only, and that servers should authenticate all connections `[web: spec 2026-07-28]`. kns does all three: Origin check, Host allowlist (loopback names only; a missing Host check was the rmcp DNS-rebinding advisory `[web]`), and a bearer token.
  - Tokens: **one per registered client**. `:mcp add <name>` creates a token (stored hashed; shown once, with the client's config snippet); `:mcp revoke <name>` removes it. The 2026-07-28 revision has no protocol sessions and the client info in a request is self-reported `[web]`, so the token is the only trustworthy identity. The name in the activity panel, the `requested by:` line, rate limits and "one pending proposal per client" all key on it. "Connected" means "token used in the last N minutes"; "disconnect" means revoke.
  - For clients that only launch stdio servers: a `kns mcp` subcommand of the same binary that proxies stdio to the running app (newline-delimited JSON-RPC, as the spec's stdio framing `[web]`). If the app is not running it answers "kns is not running" — it never opens a cluster connection itself.
  - SDK: the Rust `rmcp` crate exists `[web]`; whether its current release implements the 2026-07-28 revision is `[assumed]`.
- **Read tools** (all capped in rows/bytes, all through the redactor):
  - `selection` — the focused pane's view, cursor row, marks, visible filter. *"Why is this broken?"* in the agent means the row under the kns cursor.
  - `list(kind, namespace, selector)`, `get(ref)`, `describe(ref)`, `events(ref|namespace)`.
  - `logs(ref, container, tail, since, grep)`.
  - `why(ref)` and `timeline(ref)` — structured findings; smaller and far less injectable than raw logs, so tool descriptions steer the agent here first.
  - `forwards()`, `dev_sets()`, `contexts()` (names and flags only).
- **Pointing tool:** `show(ref, view)` opens describe/logs/YAML/why in a pane beside the focused one, labelled `AGENT` in the header. It never takes focus, never replaces a pane (ux principle 7), and is capped (2 agent panes; further calls reuse them). The agent can show its evidence instead of pasting it.
- **Proposals (the only path to a write):**
  - `propose_apply(yaml)`, `propose_scale`, `propose_restart`, `propose_delete`, `propose_reconcile`, `propose_forward` / `propose_dev_set_up`. Each returns `{id, state: "pending"}` immediately; `proposal_status(id)` reports `pending | approved | rejected | expired | failed` with the API error if any.
  - In kns: a toast, a bottom-row segment `agent 1`, and a **Proposals** group in the activity panel. `Enter` on a proposal opens it: for an apply, the normal REVIEW with the server dry-run diff and the Flux-revert warning; for the others, the same dialog a manual action would show, with an extra fact line `requested by: claude-code`.
  - The human presses `Enter` (or types the name on a protected context). `Backspace` rejects, optionally with a reason the agent receives.
  - Guards: `canI` checked at propose time; one pending proposal per client; expiry after 10 minutes; a rate limit; no "always allow" for anything.
  - **Forwards are not harmless for an agent.** Starting a forward is local and tier 0 for a human `[docs ux §14]`, but it hands the agent's process a data-plane connection. On this cluster Kafka is PLAINTEXT without auth and kafka-ui is open `[docs, code]`, so an approved forward lets the agent produce to topics. Forward proposals therefore get a real dialog naming the service, the port and that consequence ("gives the requesting process network access to svc/kafka"), are approved each time, and stop when the client's token goes idle. Principle 2 holds for the control plane only; this dialog is where the data plane is decided.
- **Not exposed, by design:** exec/attach, secret decode, env export (L4), kill, context switching, kubeconfig paths, anything taking a URL or file path.
- **Activity panel:** group **Agents**: client name, connected since, calls, bytes returned, redactions; `x` revokes that client's token, `X` stops the server. Audit file under app data.
- **Backend:** HTTP listener + MCP layer in Rust; a tool layer that calls the same functions as the Tauri commands; proposal store; one new IPC direction — the frontend publishes its selection to Rust (`publish_ui_state`), and Rust emits proposal/agent events to the UI.
- **Effort:** M for read tools + `selection` + `show`; L with proposals. **Risk:** highest of the document for security review; mitigated by the principles above and by shipping read-only first.
- **Beats:** existing Kubernetes MCP servers are headless: they hold credentials, rely on the client for consent and have no idea what the human is looking at. kns is the consent surface and the shared screen.

### A3. Assistant inside kns (direction b — later, and smaller than a chat)

- **Recommendation:** do not start with a chat pane. The owner already has an agent in the terminal; a second one inside kns adds key management, a renderer and a model-choice UI for little gain. Start with a one-shot.
- **`:explain` (first step):** runs D1, sends the *findings and redacted evidence* (not raw objects) to a model, and shows the answer in a doc pane next to the `:why` pane. The deterministic findings stay visible beside the prose, so a wrong summary is easy to spot.
- **Assistant pane (later):** a view kind `assistant` (one view per pane): transcript above, input below; linked to a source pane with the existing follow link, so "this" is that pane's cursor row. It uses the same tool layer and policy as A2 — one enforcement point, not two.
- **Patches:** "propose a fix" opens the object in EDIT in a pane beside, buffer pre-filled, header label `AGENT DRAFT`. From there it is the normal flow: the user reads, `Ctrl/⌘+S` → REVIEW (server dry run) → `Enter`. The assistant has no way to press either key. For a Flux-managed object the assistant must say that the durable fix belongs in the GitOps source repository; if a local checkout path is configured it names the file, and never commits.
- **Model access:** calls go out from Rust only (CSP unchanged `[code]`); API key in the OS keychain. Options: bring-your-own API key; a local model server on localhost; or no key at all by driving an installed agent CLI as a subprocess with only the kns MCP attached `[assumed feasible]`.
- **Rendering:** model output is untrusted too: markdown through a renderer that builds DOM nodes (no `innerHTML`), no remote images, links shown as text and opened only by an explicit action.
- **Effort:** S–M for `:explain`, L for the pane. **Risk:** cost and privacy of sending cluster data to a provider; per-context policy (principle 8) applies and the first call per context asks.

### A4. Hand-offs that tie the themes together (unscored: each is S on top of A2 and carries A2's risks)

- **Incident bundle → agent:** a trap bundle (D9) or a context pack (A1) is exposed as an MCP resource (`kns://bundle/<id>`, `kns://selection`); with a client connected, "send to agent" is one key and the agent reads it by reference instead of through the clipboard.
- **Agent → dev set:** an agent about to run tests can `propose_dev_set_up("shop")`; the user approves in kns (each time, see A2) and the forwards from L2 come up. The agent gets `localhost:9094`, not a secret, but also whatever that port allows an unauthenticated client to do.
- **Agent → your screen:** `show` (A2) during an explanation: the evidence opens beside what you are reading.

---

## Ruled out, and why

| Idea | Why not |
|---|---|
| Telepresence-style full network access (cluster IPs and DNS from the laptop) | Needs a TUN driver / root daemon / Windows service and a cluster-side manager `[web]`. Breaks "no admin, no in-cluster agent" (research §3: local-first) |
| mirrord-style process interception built in | Privileged agent pod + library injection; no native Windows injection `[web]`. Launching the mirrord CLI is the cheap alternative (L6) |
| True traffic intercept by repointing an existing Service | Flux reverts it; steals all traffic on single-replica apps; needs relay image + protocol. Preview route (new Service) is the safe form, and still P2 |
| Hosts-file names by default | Needs admin on Windows and macOS `[web]`; kns must not run elevated. Opt-in helper at most; rewriting (L4) covers most needs |
| UDP port-forward | Kubernetes port-forward is TCP only; needs a relay pod `[web]` |
| Built-in "Flux source vs cluster" diff | Needs the source artifact plus a kustomize build / Helm render, which do not exist in Rust at parity `[recall]`. Field ownership (D7) answers "what drifted"; shelling out to `flux diff` against a local checkout is a possible P2 |
| Live vs last-applied as the main diff | Flux applies server-side; the annotation is not there `[recall]` |
| Metric history from the cluster | `metrics.k8s.io` has none `[recall]`; no Prometheus in this cluster `[code]`. kns samples instead (D8) |
| A drawn node-and-edge resource graph | Poor fit for dense, keyboard-first panes; a tree table carries the same links (D10) |
| LLM-first "explain" | Non-deterministic, needs keys, sends data out. Rules first (D1); model optional on top (A3) |
| Agent tools for exec, secret decode, raw API, generic kubectl | The exact shapes behind the 2026 Kubernetes-MCP CVEs `[web]`; nothing kns could do would make a human-approval step meaningful for free-form commands |
| MCP elicitation or tool annotations as the approval step | Client-controlled and optional `[web]`; approval must be in the kns window |
| Native Kafka/Postgres clients inside kns | Binary size and scope; exec the tools already in the pods (L5) |

---

## Not verified

- Nothing was built, run or tried against a cluster; macOS behaviour throughout is untested (as in the README).
- Windows binding any `127/8` address and low ports without admin `[recall]`.
- `*.localhost` resolution for non-browser clients on Windows/macOS: sources disagree `[web]`.
- k3s event TTL equals the upstream 1h default `[assumed]`; metrics-server keeps no history `[recall]`.
- Flux-managed objects carry no last-applied annotation; manager names in `managedFields` `[recall]`.
- Ephemeral-container call was found in the kube-client 5.1 source, not compiled or run `[code]`.
- `rmcp` support for the 2026-07-28 MCP revision; which MCP clients accept a loopback HTTP server with a bearer header `[assumed]`.
- Script paths in the `apache/kafka` image; k9s having no debug-container action; Lens having no object diff `[recall]`.
- Competitor features beyond what `research.md` §3 and `prior-art.md` already record: today's searches for Aptakube/Kubetail details returned nothing usable.
- Proposed single keys: only a quick grep of `src/actions/keymap-data.ts` (`W` in tables, `J`/`P` in logs, `C` in port-forwards showed no binding in those scopes `[code]`); not checked against k9s-mode or `when` clauses.

## Open questions for the owner

1. Agents: MCP server first (A2), or in-app assistant first (A3)?
2. Which agent client(s) must work day one? Decides HTTP vs stdio shim priority.
3. OK to send redacted cluster text to a hosted model at all, or local/CLI only?
4. `.env` export of secrets to disk (L4): acceptable with the guards, or clipboard only?
5. Dev sets: stored in kns only, or also a `kns.dev.yaml` per repo?
6. Auto-start a dev set at launch?
7. Worth an elevated hosts-file helper, or is rewriting enough?
8. Reverse/preview route (L6): real need (webhooks?) or skip?
9. Event journal + trap: OK that kns keeps a background events watch when enabled?
10. Debug container default image(s)?
11. `:why` scope first: pods/workloads only, or Flux kinds in the first cut?
12. Should `ideas.md` items get P-tiers in `research.md`, or stay separate?

## Sources (web, 2026-11-22)

- MCP spec 2026-07-28: [transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports.md), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md), [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation.md)
- MCP blog, [tool annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/); [annotations are a UX layer, not a security layer](https://dev.to/gyorgy/mcp-annotations-are-a-ux-layer-not-a-security-layer-mdh)
- DNS rebinding in MCP HTTP servers: [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-transport-trust-gap-20261109-csa-style/), [TypeScript SDK advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w), [rmcp advisory](https://rustsec.org/advisories/RUSTSEC-2026-0189)
- Kubernetes MCP servers and their advisories: [mcp-server-kubernetes CVE-2026-47250](https://advisories.gitlab.com/npm/mcp-server-kubernetes/CVE-2026-47250/), [advanced README (read-only, masking)](https://raw.githubusercontent.com/Flux159/mcp-server-kubernetes/main/ADVANCED_README.md), [NeuralTrust on Kubernetes MCP](https://neuraltrust.ai/blog/kubernetes-mcp)
- Intercept tools: [mirrord vs Telepresence (MetalBear)](https://metalbear.com/mirrord/compare/telepresence/), [Telepresence on mirrord](https://telepresence.io/docs/compare/mirrord), [Telepresence 2.30](https://telepresence.io/blog/telepresence-2.30)
- Forwarding tools: [kubefwd](https://github.com/txn2/kubefwd), [kftray](https://github.com/hcavarsan/kftray)
- `localhost` names: [curl on localhost](https://daniel.haxx.se/blog/2021/05/31/), [WebKit bug 160504](https://bugs.webkit.org/show_bug.cgi?id=160504), [Go issue 78485](https://github.com/golang/go/issues/78485)
- macOS loopback aliases: [gist](https://gist.github.com/brandt/c2f9e8277c90a1c284770c7ca7966226)
- Event TTL: [Platform9 KB](https://platform9.com/kb/kubernetes/kubernetes-event-disappears-after-60mins)
