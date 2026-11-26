# kns for Herdr

Your Kubernetes clusters in [Herdr](https://herdr.dev): a live panel in the Herdr app, logs and shells as
Herdr panes, with kns's protected and read-only contexts still enforced. Full description:
[docs/herdr.md](../docs/herdr.md).

## Install

In kns: **Settings → Herdr → Add to Herdr** (or `:herdr add`, or `kns-tui herdr install`). kns installs
what fits the Herdr you have:

- **Herdr app**: the panel (`app/kns/`, a Herdr mod). Open it from the command palette: **kns: panel
  beside this pane** or **kns: clusters in a new tab**.
- **herdr TUI** (≥ 0.9.5): the plugin (`herdr-plugin.toml`, `bin/kns-herdr`), linked with `herdr plugin
  link`. Bind a key in `~/.config/herdr/config.toml` and run `herdr server reload-config`:

  ```toml
  [[keys.command]]
  key = "prefix+k"
  type = "plugin_action"
  command = "kns.open"
  description = "kns beside this pane"
  ```

  Other actions: `kns.popup`, `kns.tab`, `kns.start` (kns in the background), `kns.window` (the kns window).

Keep kns running for Herdr when its window is closed: Settings → Background → **Keep running in the
tray**, **Launch at login** (or `kns-tui login-item on`).

## Use

- Panel: tabs for the common resources and **More…**, context and namespace chips, filter, sort, 🔔 for
  failing pods. Click a row for its actions; double-click opens it (pods: logs).
- Keys (panel focused, and in `kns-tui`): `⏎` open, `l` logs, `s` shell, `y` YAML, `e` edit, `d` why,
  `E` events, `r` restart, `S` scale, `i` image, `D` delete, `c`/`n` context/namespace, `/` filter.
- Signed out of AWS: the panel shows **Sign in** (`aws sso login`).
- A `.kns.toml` in the repo opens the space on its own service:

  ```toml
  context = "staging"
  namespace = "billett"
  resource = "deploy"
  selector = "app=billett-api"
  ```

Design and protocol: [docs/herdr.md](../docs/herdr.md), [docs/plan-background.md](../docs/plan-background.md).
