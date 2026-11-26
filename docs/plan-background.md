# kns in the background, kns-tui and the herdr plugin

Goal: work with the clusters from a terminal workspace ([herdr](https://github.com/herdrdev/herdr)) without
opening the kns window, while kns keeps owning credentials, sessions, port-forwards and the safety rules.

```
kns-tui (herdr pane) ─┐
kns-tui logs / exec ──┼─ Unix socket (0600) ─▶  kns --background  ─▶ kube-rs ─▶ clusters
kns window (webview) ─┘   NDJSON, same API       (one process, tray)
```

## 1. One process, optionally without a window

- `kns --background` runs the Rust backend, the MCP server (when on) and the client socket with a tray icon
  and **no webview** (the window is `create: false` in both `tauri.conf.json` and `tauri.macos.conf.json`; the
  macOS file replaces the whole window list, so both need it). On macOS the Dock icon is hidden
  (activation policy `Accessory`) until a window opens.
- "Keep running" (`rust/background.json {keepRunning}`, on for a `--background` start): closing the window
  destroys the webview and leaves kns in the tray. `RunEvent::ExitRequested` without an exit code is
  prevented; the tray's "Quit kns" exits with code 0.
- `tauri-plugin-single-instance`: a second `kns` start shows the running instance's window (Finder, Dock,
  `kns-tui open`); a second `kns --background` does nothing. On macOS, `Reopen` (Dock click) also shows it.
- "Launch at login" writes `~/Library/LaunchAgents/no.sixm.kns.background.plist` (`kns --background`,
  `RunAtLoad`, not `KeepAlive`: quitting means quitting). macOS only for now.
- Code: `src-tauri/src/background.rs`; Tauri commands `background_status`, `background_set`.

## 2. The client socket (`src-tauri/src/rpc/`)

- Path (`rpc/path.rs`, shared with `kns-tui` through `#[path]`): `KNS_SOCKET`, else `$XDG_RUNTIME_DIR/kns.sock`
  (Linux), else `<data_dir>/no.sixm.kns/kns.sock`. A path longer than 100 bytes (`sun_path` is 104 on macOS)
  becomes `<temp_dir>/kns-<fnv64 of the path>.sock`, computed the same way on both sides.
- Access: mode 0600 and the peer's uid must equal the socket owner's. No token: the socket is as private as the
  kubeconfig behind it. A live socket at start means another kns answers there (error); a dead one is replaced.
- Protocol (newline-delimited JSON, `PROTOCOL = 1`):
  - greeting `{"hello": {app, version, protocol, pid, methods}}`
  - request `{"id", "method", "params"}` → `{"id", "result"}` | `{"id", "error": BackendError}`
  - stream events `{"sub": <request id>, "event": …}` for `subscribe_table`, `stream_logs`, `exec_start`,
    `subscribe_ns_health`. Tagging with the request id means no event can arrive before the client knows its
    stream; the reply carries the stream id for `stop_stream`.
  - backend events `{"backend": BackendEvent}` (what the webview gets as `kns://event`)
- Methods (`rpc/dispatch.rs`): the Tauri command names and camelCase parameters, about 95 of them, plus
  `hello`, `show_window`, `connected_contexts`. Left out: webview-only calls (`publish_ui_state`, `save_state`)
  and calls that open a native dialog (`catalog_choose`, `pack_save`).
- Closing a connection stops its streams (and with them exec sessions).
- The same protocol on loopback TCP for clients without Unix sockets (the Herdr app's mods):
  `rpc/tcp.rs`, off unless turned on, a token in a 0600 `rpc-tcp.json`, the first line
  `{"auth": token}`. See [herdr.md](herdr.md).

### Safety rules over the socket

- A socket client is the human, like the webview: a context it connects counts as connected for the MCP gate
  (`mcp::connected`) while the connection lives. Agents still need their own policy for it.
- Mutations (`apply_yaml`, `delete_object`, `patch_object`, `scale`, `restart`, `trigger_cron_job`, `debug_*`,
  `snippet_run`) are checked in Rust, not trusted to the client: unknown context flags deny; `readOnly` refuses
  (`403 ReadOnly`); `protected` needs `"confirm": "<context>"` (`428 ConfirmRequired`). kns-tui answers that by
  asking for the name. Agent proposals keep their own gate (`proposalId` → `run_step`).

## 3. kns-tui (`src-tauri/src/bin/kns-tui.rs`, `src-tauri/src/tui/`)

A ratatui program bundled next to `kns` (every `src/bin` binary is, like `kns-mcp`). It links no Tauri or
Kubernetes code and never holds credentials; when no kns answers it starts `kns --background` (`KNS_APP`, the
`kns` next to it, or `/Applications/kns.app`) in its own process group.

| Module | Owns |
|---|---|
| `client.rs` | the connection, reader thread, replies/streams/backend events as `Msg`s tagged with a view epoch |
| `model.rs` | resources and lookup (aliases, core wins), the live table (snapshot/delta/state), health, age, selectors, log cleaning |
| `app.rs` | the view stack (table, text, logs, forwards, review, history), overlays (pickers, prompts, confirm, protected), keys, drawing |
| `edit.rs` | `$EDITOR` on a private temp file, YAML parse/normalize, GitOps owner, conflict classes, `:new` skeletons |
| `diff.rs` | line diff, unified diff, three-way merge (a port of the window's `merge3.ts`) |
| `exec.rs` | a pod shell passed through the terminal (raw mode; stdin polled with a timeout so it stops with the shell) |
| `herdr.rs` | herdr detection, opening panes, the sidebar token |
| `plugin.rs` | the embedded plugin files, `herdr install`, the `open-pane` action |
| `project.rs` | `.kns.toml` |

Keys follow kns/k9s: `:` resource or command, `c`/`n` context/namespace pickers, `/` filter, `o` sort
(name, newest, problems, CPU, memory), `⏎` drill (workload/service/node → pods, pod → logs), `y` YAML, `e` edit,
`d` why (`diagnose`), `E` events, `v` env (`env_resolve`, values redacted), `l`/`p` logs, `s` shell,
`F` port-forward, `r` restart, `S` scale, `i` set image, `h` history, `t` run a CronJob, `x` decode a Secret,
`D` delete, `W` open the kns window, `?` help.

Pods and nodes tables get CPU and memory columns (`pod_metrics`/`node_metrics` every 15 s while shown) when
the cluster serves metrics.k8s.io.

### Edit and apply

The window's edit flow (docs/ux.md §13.2), in a terminal:

1. `e` fetches the YAML (`get_yaml`, no managedFields) and opens `KNS_EDITOR`/`VISUAL`/`EDITOR` (else `vi`)
   on a `0600` file in a `0700` directory of its own, removed as soon as the editor exits (also for a Secret).
   `# kns:` lines on top say what is edited and the last error; they are dropped on the way back. A non-zero
   editor exit (`:cq`) cancels.
2. The review shows the unified diff and runs `apply_yaml` with `dryRun` on the server. A dry run is not a
   change, so the socket lets it through without the protected confirm (and on read-only contexts).
3. `⏎` applies (server-side apply, field manager `kns`); a protected context asks for its name first.
   `e` returns to the editor with the error on top. A version or field-manager conflict offers `r`: the
   edit is replayed onto the server's current version with the same three-way merge as the window
   (overlaps come back in the editor with markers); a field-manager conflict also offers `f` (force).
4. Flux/Argo CD ownership (labels, tracking annotation) is shown as a warning: the controller will put its
   version back.

`:apply <file>`, `:apply` (an empty buffer) and `:new <kind>` (a skeleton) review any number of documents:
after the dry run each one is diffed against what the cluster has now (server-owned fields and status
dropped), marked new/changed/unchanged. A manifest that creates a namespace and objects in it cannot be
dry-run as a whole (kubectl has the same limit); kns-tui accepts it with a warning. `w` saves the manifest
to a new file.

`h` lists revisions (`revisions`); `⏎` diffs one against the running template, `u` rolls a Deployment back
(JSON patch of `spec.template`, like `kubectl rollout undo`). `i` sets images with a JSON patch guarded by a
`test` of each container's name.

`.kns.toml` (in the working directory or a parent, up to the git root): `context`, `namespace`, `resource`,
`selector` pick the first view, so a workspace opens on "its" service.

## 4. herdr TUI plugin (`herdr/`)

The Herdr *app* (`dev.herdr.app`) is a different program with mods instead of plugins; kns's panel for
it is described in [herdr.md](herdr.md). Both are installed from kns: Settings → Herdr → Add to Herdr.


herdr plugin v1 (herdr ≥ 0.9.5): panes are declared in `herdr-plugin.toml` and opened with
`herdr plugin pane open --plugin kns --entrypoint <id> [--env K=V]`. The manifest fixes argv, so targets travel
as `KNS_CONTEXT`, `KNS_NAMESPACE`, `KNS_POD`, `KNS_CONTAINER`, `KNS_WORKLOAD`.

- Panes: `tui` (split), `popup` (90%×85%), `tab`, `logs`, `exec`. Actions: `kns.open`, `kns.popup`, `kns.tab`,
  `kns.start`, `kns.window`. Commands go through `bin/kns-herdr`, which finds kns-tui (`$KNS_TUI`, the path baked
  in by `kns-tui herdr install`, `PATH`, kns.app).
- In a plugin pane, `l` opens a `logs` pane below and `s` an `exec` pane to the right (`--target-pane` = this
  pane, `--cwd` = this directory). In a plain herdr pane kns-tui uses `herdr pane split` + `pane run`. Outside
  herdr both open in place.
- The pods table of a plugin pane reports `$kns` on the workspace row (`herdr workspace report-metadata
  --source plugin:kns --token kns=<ctx>/<ns> <pods> ✗<bad> ~<warn>`, TTL 3 min, refreshed on change or every
  minute, cleared on exit).
- Install: Settings → Herdr → Add to Herdr, or `kns-tui herdr install` (kns writes the plugin to
  `<data_dir>/no.sixm.kns/herdr-plugin` and runs `herdr plugin link`), or `herdr plugin install Cmoen11/kns/herdr`.

## Verified

- Unit tests: socket hello/call/error/backend event/disconnect, 0600, mutation guard (unknown flags, readOnly,
  protected), socket path shortening, plist, TUI model (lookup, table deltas, health, age, selectors, filter,
  log cleaning), CLI parsing, project file, manifest entrypoints.
- Edit and apply by hand against the local k3s with a scripted editor and with `vi`: `:new deploy` with a new
  namespace, `:apply file`, `e` → diff → dry run → apply, a conflict from a `scale` meanwhile → `r` rebase
  (kept the server's replicas, applied the edit), invalid YAML and a server validation error back in the
  editor, discard, set image, history diff and roll back, env, CPU/memory columns and sorting, delete. The
  temp file was `0600` and gone after the editor exited.
- By hand on macOS against a local k3s (rancher-desktop), dev build: `kns --background` starts without a
  webview (~90 MB RSS, debug); `kns-tui start/status/open/call`; the TUI's pods/deploy/svc tables live, drill
  into pods, YAML, why, events, logs (single pod and a whole Deployment), namespace picker, filter, shell in place
  and back, port-forward + `:pf` + stop. herdr calls checked against a fake `herdr` binary (plugin pane and
  plain pane modes, sidebar token); real herdr not run.

## Not done yet

- Windows: no socket (named pipe) and no kns-tui; launch at login on Windows/Linux.
- TUI: dev sets, traffic/relations/reach views, Secret edit as decoded values (today: base64 YAML, like
  `kubectl edit`), mouse. The protected-name prompt for apply is covered by the socket guard's unit tests,
  not tried by hand.
