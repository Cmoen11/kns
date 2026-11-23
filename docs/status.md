# kns: status log

The detailed per-wave status that used to live in the README. The short version is in the README's Status section; what each feature does is in `docs/tools.md`; the plan and real-cluster scripts are in `docs/plan-features.md` §6.

## Overall

Checked with `pnpm typecheck`, `pnpm test` and `pnpm build`, by walking the journeys of `docs/ux.md` §19 in a browser against the mock backend, and in the Windows release build (WebView2) against a real k3s cluster.

- **Verified in the Windows app against a real cluster:** tables with metrics, sort, filter, describe, YAML, logs, shell, palette, port-forward, both side panels, row buttons and right-click menus, scale, restart, edit → review (server dry run) → conflict → rebase → apply, delete with confirm, strict CSP.
- **Verified against the mock only:** open beside, palette object search, vim mode, most side-panel and pointer interactions.
- **Not verified:** macOS (built unsigned in CI, never run by hand), clipboard, forbidden / reconnect states.

An action that is not built has no handler: it is absent from hints, palette, help and menus, and its key does nothing.

## Built (P0)

- **Panes:** split, focus, move (keys, MOVE mode, header drag), resize (keys, RESIZE mode, divider drag), zoom, equalize, flip, fold to tabs, close and reopen, history per pane, follow links, persisted workspace per context.
- **Keys:** one registry with rebindable defaults, scopes and layers, leader with which-key panel, `+` new-pane prefix, hint row, `?` help, context menu (`Shift+F10`, right-click), k9s-mode preset, keymap editor in settings.
- **Tables:** virtualized rows, server columns with width tiers, wide toggle, sort, `/` filter (regex, inverse, label, fuzzy, chips), faults-only, marks, copy, column menu, drill-down, containers view, pod CPU/MEM.
- **Palette and commands:** `Ctrl/⌘+K` palette, `:` command bar with completion, namespace and context pickers, namespace slots `0`–`9`, protected and read-only contexts.
- **Favourites:** saved views on `Ctrl/⌘+1..9`, saved layouts on `Alt+1..9`, the `'` picker with rename, delete and slot move.
- **Documents:** describe, YAML, JSON and secrets in CodeMirror; search, line and character selection, folding; edit with diff gutter and multi-cursor; review with server dry run, apply, three-way rebase; drafts.
- **Logs:** follow, pause, wrap, timestamps, since/tail/head, previous, all containers or one, search and filter-lines, marks, copy, reconnect with gap marker.
- **Shell and port-forwards:** xterm shell with container picker, copy mode, search, reconnect; port-forward dialog and manager.
- **Operations:** delete with confirm tiers, kill (behind the kill switch), scale, restart, CronJob trigger and suspend, Flux reconcile (with source) and suspend/resume, undo toasts, RBAC-aware disabling, owner / node / replicasets jumps.
- **Tool views:** home, settings, aliases, messages.
- **Side panels:** context sidebar (contexts, namespaces, favourites) and activity panel (port-forwards, shells, log streams, operations, connection).
- **Mouse:** pane header buttons, view toolbars, row hover bar, right-click menus, click-to-sort, mark checkboxes, clickable titlebar and hint row.
- **Editor:** optional vim mode. **Detail views** open in a pane beside the list by default. UI zoom 85–150 % on a 1.2x base scale.

## Feature wave 1 (`docs/plan-features.md`, integrated 2026-11-22)

Checked with typecheck, Vitest, `pnpm build`, clippy and `cargo test`, and by clicking through the mock in a browser. In the Windows release build against a real cluster (namespace `kns-spike`) only this was run: Tools hub, `W` on a crash-looping pod, a Service forward surviving a rollout restart, the env view of a Deployment, and the MCP server (401 without token, 403 with `Origin`, `get_status`, `explain_why`, masked Secret from `get_object`). The rest of the script in plan-features §6.5 is still open.

- **Tools hub** (`Ctrl/⌘+Shift+H`, `leader g`, `:tools`, titlebar button) with every tool, its keys, mouse paths, live status, "Try it" and `docs/tools.md`.
- **Debug:** `:why` (`W`) for pods, workloads and Services (Ingress, Job, CronJob and Flux since wave 3) with evidence you can follow; crash card columns in the containers view.
- **Diff:** two marked rows (`D`), `:diff prev`, `:diff applied`; field owners (`O`) and `:drift` in YAML.
- **Logs:** merged logs of marked rows, structured mode (`J`) with field chips, patterns (`P`) in a worker, go to pod (`O`).
- **Local dev:** forwards to Services and workloads with failover on a stable port, open in browser; env view (`E`) with rewrites and side-effect overrides, `.env` export (file or clipboard), dev sets (`leader e`, `:dev`).
- **Agents:** local MCP server (`:mcp setup`, `:agents`) on `127.0.0.1` with bearer tokens, Origin/Host checks, per-context policy, audit; 17 read tools.

Fixed after the real-cluster run (in wave-2 integration): `:pods`/`:svc`/`:deploy` from a hub, why, env, logs or shell pane keep the pane's namespace; env view headers line up; `:why` never shows the kubelet's "unable to retrieve container logs" text as evidence; a dev set that fails to start by itself shows a toast and an Activity row; Secret diffs are masked in Rust; the env export typed confirm is checked in Rust.

## Feature wave 2 (`docs/plan-features.md` §6.6, integrated 2026-11-22, mock only)

Checked with typecheck, Vitest, `pnpm build`, clippy and `cargo test`, the MCP gate over in-process HTTP, and by clicking through the mock in a browser. Nothing of wave 2 has run against a real cluster or in the release build yet: the script is in plan-features §6.6.

- **Debug:** timeline (`H`, `:timeline`), event journal (`:journal on`), traps with redacted incident bundles (`:trap`, `:traps`), memory sparklines in the wide pods view; debug container (`B`) and debug copy (`:debug copy`), exec snippets (`:x`), copy as kubectl (`:kubectl`), mirrord command (`:mirrord`).
- **Local dev:** names on one port (`:dev names on`, `http://<name>.<ns>.localhost:7080`), own loopback address per Service on Windows, connection strings (`C` in `:pf`, Rust writes the clipboard), `k9scli.io/port-forwards` annotations, mounted ConfigMap/Secret files export.
- **Agents:** context packs (`leader c`, MCP `make_pack`) with a redaction legend; proposals for dev-set start, forward, env export, scale, restart, delete, reconcile and apply, approved in kns (Agent requests group, `leader y`); `draft_dev_set_from_workload` / `save_dev_set`, `show_in_kns`, `kns://` resources and the `dev_config` prompt.
- **Left out:** snippet output into a shell pane; cleanup offer on quit; timeline follow and in-view window change; packing selected text.

## Feature wave 3 (`docs/plan-features.md` §6.7, integrated 2026-11-22, mock only)

Checked with typecheck, Vitest, `pnpm build`, clippy and `cargo test` (the stdio shim end to end against the in-process server), and by clicking through the mock in a browser. Nothing of wave 3 has run against a real cluster, in the release build or on macOS: the consolidated script for waves 1–3 is in plan-features §6.7.

- **Debug:** can it reach (`:reach web:80`, row menu): Service → port → endpoints → container port → NetworkPolicies of both ends → DNS, then an optional probe from inside the pod (asks first; offers a debug container when it cannot run). Relations (`:relations`): owners up to the Flux Kustomization/HelmRelease and its source, owned objects, traffic, ConfigMaps/Secrets/PVCs used (Secrets by name only). Rollout watch in the activity panel after restart, scale or reconcile. `:why` for Ingresses, Jobs, CronJobs and Flux objects.
- **Agents:** stdio shim `kns-mcp` (token from `KNS_MCP_TOKEN`, loopback only, `--check`); dev-set, bundle and pack ids no longer tell an agent whether they exist; a request left `executing` by a reload ends with a reason.
- **Tools hub:** "Start here" guides (local development against a service; connect an agent) and help buttons on every tool view.
- **Hardened at integration:** the protected-context typed confirm of env and mounted-file exports is checked in Rust; `explain_why` and agent packs drop findings about objects in namespaces outside the agent's allowlist; `:reach` refuses two contexts; unit tests can no longer build a cluster session.

## Built (P1)

`pod.attach`, `node.cordon`, `node.uncordon`.

## Not built

| What | Tier |
|---|---|
| Parked workspaces and `Alt+0` (previous layout): a layout recall replaces the workspace | P0 |
| `:flux` and `:flux!` (all Flux kinds / everything not ready in one table) | P0 |
| `FAV n` label in the pane header; Layouts section on home | P0 |
| Dry run and uid precondition on delete (needs an IPC contract change) | P0 |
| Keyboard scrolling in REVIEW | P0 |
| Save to file (outside text views), fit pane to table, editor replace, set image, rollback, drain, transfer, sanitize, Flux trace, used-by, layout mini-map | P1 |
| Warp | P2 |

## Known gaps

- Clipboard actions (copy name/cell, log and doc copy, terminal copy/paste) are untested in the webview.
- Forbidden, error and reconnect states were not exercised: the mock backend cannot produce them.
- macOS has no Alt+h/j/k/l pane focus.
- Opening a forward in the browser (`o` in `:pf`) goes through the Rust opener; the webview has no opener permission. Not yet checked in the app.
- More detail per feature: `docs/frontend.md` §16.

## Status colours, namespace health, action log (integrated 2026-11-22)

Checked with typecheck, Vitest, `pnpm build`, clippy and `cargo test`. No click-through in the mock and no real-cluster run is recorded; the titlebar summary and row tint do render in the mock (README screenshots).

- **Status colours:** one palette for state in every theme and mode (ok, in progress, warning, error, unknown), glyph and word always carry the state too; READY/RESTARTS heat; faint tint behind failing rows; Full or Quiet setting.
- **Namespace health:** a badge per namespace in the context sidebar, a total on "all namespaces", a titlebar summary ("3 failing"); `!` on a namespace row opens its faults view, `s` sorts problems first, `:faults [namespace]`. Counted in Rust from one cluster-wide watch per connected context.
- **Recent (action log):** what you did and what happened, per context, 100 entries, in the activity panel (`Mod+J`, `Mod+Shift+Y`); `Enter` jumps to the object, forward, dev set or namespace. Never records secret values, manifests or command lines.
- **Pane fault hints:** pane header and tab strip show a glyph and count of faulty rows; home has a "Needs attention" section.
