# kns for herdr

Your Kubernetes clusters in [herdr](https://github.com/herdrdev/herdr) panes, through the kns app running in
the background: live tables, "why is this broken", events, logs and shells, with kns's protected and read-only
contexts still enforced.

## Install

kns must be installed (it ships `kns-tui`). Then:

```sh
/Applications/kns.app/Contents/MacOS/kns-tui herdr install   # writes and links the plugin
# or, from GitHub:
herdr plugin install Cmoen11/kns/herdr
```

Bind a key in `~/.config/herdr/config.toml` and run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+k"
type = "plugin_action"
command = "kns.open"
description = "kns beside this pane"
```

Other actions: `kns.popup`, `kns.tab`, `kns.start` (kns in the background), `kns.window` (the kns window).

Optional: keep kns in the tray and start it at login with `kns-tui login-item on`.

## Use

- `:` a resource (`:deploy`, `:svc kube-system`, `:pods all`), `c` context, `n` namespace, `/` filter, `o` sort
  (newest, problems, CPU, memory).
- `⏎` pods of a workload, `y` YAML, `d` why, `E` events, `v` env.
- `e` edits in your `$EDITOR` (`KNS_EDITOR`, `VISUAL`, `EDITOR`): save and quit shows the diff and the server's
  dry run, `⏎` applies, `e` goes back, `r` rebases when the object changed meanwhile. `:apply file.yaml` and
  `:new deploy` review against the cluster the same way.
- `i` set image, `h` rollout history (`⏎` diff a revision, `u` roll back).
- `l` logs and `s` shell open as new herdr panes beside the TUI.
- `F` port-forward, `r` restart, `S` scale, `D` delete. A protected context asks for its name.
- `?` all keys.

The workspace row in herdr's sidebar shows `$kns`: context/namespace, pods, failing (`✗`) and not-ready (`~`).

A `.kns.toml` in the repo opens the workspace on its own service:

```toml
context = "staging"
namespace = "billett"
resource = "deploy"
selector = "app=billett-api"
```

Design and protocol: [docs/plan-background.md](../docs/plan-background.md).
