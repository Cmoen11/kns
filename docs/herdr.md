# kns in Herdr

kns puts your clusters next to your terminals and agents in [Herdr](https://herdr.dev): a live native panel
in the Herdr app, and logs and shells as real Herdr terminal panes. kns keeps owning the credentials,
sessions and safety rules; Herdr only talks to it.

## Set up

In kns: **Settings → Herdr → Add to Herdr** (or `:herdr add`, or `kns-tui herdr install`). kns then sets up
whatever Herdr is installed:

| Herdr | What kns does |
|---|---|
| The Herdr app (`dev.herdr.app`) | writes the kns mod to `~/.config/herdr-app/mods/kns` (with a `config.js` naming this kns's `kns-tui`), turns on its loopback endpoint, runs `herdr-app check`, and opens the panel beside the focused pane the first time |
| The herdr TUI (`herdr` ≥ 0.9.5) | writes the TUI plugin (`herdr/herdr-plugin.toml`) to `<data_dir>/no.sixm.kns/herdr-plugin` and runs `herdr plugin link` |

Running it again updates. When kns itself is updated it rewrites an installed mod at start, so the panel
and kns always speak the same protocol. **Remove from Herdr** takes it all out again and turns the
endpoint off.

Herdr never changes its shipped layouts, so the panel is a pane: open it from the command palette with
**kns: panel beside this pane** or **kns: clusters in a new tab**. A pane is saved with its tab, splits,
zooms and closes like a terminal. Settings → Background: **Keep running in the tray** and **Launch at
login** keep kns there for Herdr when its window is closed.

## The panel

- Live tables (`subscribe_table`, streamed): Pods, Deploy, StatefulSets, DaemonSets, Services, Ingresses,
  Jobs, CronJobs, ConfigMaps, Secrets, Nodes, Events, and any other resource under **More…** (`:`).
  Health colours and counts are kns-tui's rules; pods and nodes get CPU and memory (`o` sorts by them).
- The view follows the space: what you picked there before, else the space's `.kns.toml` (context,
  namespace, resource, selector), else the kubeconfig context and its namespace. A pane opened with
  props `{context, namespace, resource}` stays on them.
- **Signing in**: a context that signs in with an AWS profile shows **Sign in** (`aws sso login`, the AWS
  CLI opens the browser) when its token expired or a connection was refused for credentials; the panel
  connects again afterwards. The state is read every minute (someone may sign in in a terminal).
- **One namespace**: when listing a resource in all namespaces is forbidden, the panel remembers that for
  the context and shows the context's kubeconfig namespace (else the one used last), as kns does. When
  listing namespaces is forbidden, the namespace picker offers the kubeconfig one and the ones you used,
  and takes any typed name.
- On a row: `⏎` pods of a workload/service/node, `l` logs and `p` previous logs, `s` shell (both open as
  Herdr panes running `kns-tui logs` / `kns-tui exec`, named after the pod), `y` YAML, `d` why, `E` events,
  `x` decode a Secret, `F` port-forward, `e` edit, `r` restart, `S` scale, `i` set image, `t` run a CronJob,
  `D` delete. Keys work once the panel has the keyboard (click it, or `pane.go` onto it); every action is
  also a button.
- **Edit**: Herdr's editor with the YAML → **Review** (`⌘S`): the diff and the server's dry run → **Apply**.
  A conflict offers **Rebase on server** (the window's three-way merge; overlaps come back marked) and,
  for another field manager, **Force apply**. Flux/Argo CD ownership is a warning. **kns: apply a
  manifest** (palette, `N`) reviews any manifest against the cluster the same way.
- Protected contexts ask for their name before a change; read-only contexts hide changes and kns refuses
  them anyway. 🔔 posts a Herdr notification when a pod starts failing.

## How it connects

```
Herdr app ── kns mod (native UI, gpui-shell JS) ── TCP 127.0.0.1 + token ──┐
Herdr panes ── kns-tui logs / exec ─────────────── Unix socket (0600) ─────┼─ kns (tray) ─ clusters
herdr TUI  ── kns-tui (plugin panes) ───────────── Unix socket (0600) ─────┘
```

A mod's script runtime has TCP (`net.connect`) but no Unix sockets, so kns serves the same protocol on
loopback TCP (`src-tauri/src/rpc/tcp.rs`), off unless turned on:

- it binds `127.0.0.1` on a free port and makes a new random token at every start;
- `rpc-tcp.json` (`{port, token, pid, protocol}`, in kns's data folder) is mode 0600: reading it is the
  permission, as the 0600 socket is for kns-tui;
- the first line must be `{"auth": "<token>"}` within 5 s, else `Unauthorized` and the connection closes
  (a browser reaching the port sends HTTP and is refused the same way);
- then it is the socket's protocol: calls, streams tagged with the request id, backend events, and the
  same mutation guard (read-only refuses, protected needs `confirm`; a dry run needs neither);
- turning it off ends every TCP connection and removes the file.

The mod (`herdr/app/kns/`): `client.js` (connection, auth, calls, streams, reconnect with backoff, starts
kns with `kns-tui start` when nothing answers), `model.js` (resources, the live table, health; kns-tui's
rules), `diff.js` (diff and merge3; the window's), `utf8.js` (the runtime has no TextDecoder), `panel.js`,
`dialogs.js` (YAML/why/events/secret, edit → review → apply, one confirmed action), `main.js` (one mod,
several views by `props.view`). `mod.test.mjs` tests the pure modules (`node --test`).

## Verified

On macOS with the Herdr app (herdr-core 0.1.22) and a local k3s, against a dev kns: install from kns
(`herdr-app check` passes), the panel live over TCP (pods with health, CPU and memory), a pane pinned to a
context, logs in a Herdr pane (`kns-tui logs --context …`, following), the why view, the edit view with
the YAML in Herdr's editor, a context whose RBAC forbids listing pods (the message says so), streaming of
20 000 lines through the mod runtime in under a second. Not tried by hand: clicking Review/Apply and the
action dialogs (no way to click from a script; the logic is the tested port), Sign in (no expired AWS
context at hand), and the herdr TUI plugin link (the TUI is not installed here).
