# kns — requirements (from the owner, authoritative)

kns = graphical k9s. Desktop app for Windows + macOS.

## Product
- Feature parity target: k9s (see `research.md` §2, tiered P0/P1/P2). P0 first; never imply parity that is not built.
- Easy context + namespace switching.
- One user, personal k3s cluster (single kube context `default`), Flux GitOps. Flux-aware actions are first class.

## Performance (top criterion)
- Lightning fast, feels native. Instant startup, low memory, no jank. Virtualized tables, coalesced watch deltas, no layout jumps.
- Stack: Tauri 2, Rust backend (kube-rs), React + TypeScript frontend.

## UX (make it GOOD)
- Keyboard first: a shortcut for EVERYTHING. Nothing requires the mouse. k9s keys kept where sane. Central, rebindable keymap registry (no hardcoded keys in components). `?` overlay, hint bar, Ctrl/Cmd+K palette, `:` command mode, `/` filter.
- Keys are matched on the produced character (Norwegian layout: `/` and `:` are shifted, `[` `]` need AltGr = Ctrl+Alt on Windows).
- Split panes like Claude Desktop: several views side by side (e.g. pods | services). Each pane has its own resource/namespace/filter/history. Open anything in a new pane (shortcut + modifier-click). Easy resize by dragging the divider AND by keyboard; double-click divider = equalize; zoom/maximize a pane; move focus/move pane with keys; layout persists.
- Flow: drill-down with Enter, back with Esc, breadcrumbs, history per pane.
- Scales with screen size: columns prioritised/hidden by width; more panes on big screens; graceful on small.
- Favorites: saved views (resource + namespace + filter + sort) and saved pane layouts, on hotkeys and in the palette.
- Compact, dense design.

## Visual design
- One theme, "claude" (`src/styles/claude.css`): warm greys and a clay accent in the style of the Claude desktop app,
  rounded pane cards, floating overlays, generous spacing. Mode follows the system; Light/Dark selectable.
- Fonts are open-licensed only (SIL OFL, bundled via `@fontsource`): Instrument Sans for all UI, Newsreader for the few
  large headings (empty states, settings titles), Geist Mono / JetBrains Mono for logs, YAML and the terminal.
  Never bold for hierarchy. No proprietary or brand-portal fonts in the repository.
- Status colours are used sparingly, for status only.

## Safety
- Confirm tiers on destructive actions, read-only mode, RBAC-aware disabling.
- Never test destructive actions against real workloads; only in a throwaway namespace.

## Additions (owner, later)
- Mode: **follow the system** (prefers-color-scheme) by default, live-switching; manual override Light/Dark in settings.
- In-app editor (VS Code-like, inside a pane): viewing and editing config/YAML opens in a real code editor with
  syntax highlighting themed from the active mode (light and dark), line numbers, folding,
  search (Ctrl/Cmd+F), multi-cursor, diff view before apply, server dry-run, inline API errors. CodeMirror 6.
  Read-only "view" and "edit" are the same editor; `e` toggles to edit. Also used for describe/JSON and secrets.

## Activity panel (owner, later) — SCHEDULED FOR THE NEXT ROUND; agents in the current workflow: do not build it
Inspired by the "Background tasks" pane in Claude Desktop: a slim, toggleable side panel (one shortcut) giving an
instant overview of everything live/running, grouped with counts, each item with status, age/duration and one-key actions:
- Port-forwards (target, local→remote port, connections; open in browser, copy address, stop)
- Shell/attach sessions (pod/container, duration; jump to pane, end)
- Log streams (target, lines/s; jump to pane, stop)
- Operations in flight and recently finished (bulk delete progress, rollout restart progress, scale, apply, Flux reconcile) with result and error
- Watches/connection health (context, reconnecting/stale subscriptions)
- "Finished" section, collapsed, with history (like the screenshot), clear-all.
Fully keyboard navigable (j/k, Enter = jump, x = stop), stop-all per group, badge count in the titlebar/bottom row when hidden.

## Side panels and editor additions (owner, round 2) — BUILD NOW
- **Activity panel**: build the section above now (right side).
- **Context sidebar** (left, like the Claude Desktop sidebar): a toggleable side panel that makes switching context
  very easy: all kube contexts (current one marked, cluster/user, protected/read-only flags), one click or
  j/k + Enter to switch. Below: namespaces of the current context (click/Enter = switch the focused table pane) and
  saved favourites/layouts. One shortcut to toggle, one to focus; width resizable; open/closed + width persisted.
- **Vim mode in the editors** (CodeMirror), a setting that can be turned on/off (default off).
- **Alt+h/j/k/l** focus pane left/down/up/right (done, in keymap-data.ts).
- "Open beside" (done): detail views from a list open in a pane next to it; setting, default on.

## Mouse parity (owner, round 3)
Keyboard-first stays, but the app must be fully and comfortably usable with the mouse alone. Design the UI for it:
visible buttons for things, easy navigation without the keyboard.
- Pane header: back/forward, split right/down, zoom, close; clickable breadcrumbs (resource, namespace = pickers).
- Tables: click selects, double-click opens, right-click acts on the clicked row; a row action bar / hover actions
  (logs, describe, YAML, edit, shell, port-forward, scale, restart, delete); clickable sort headers; filter field
  always reachable by click; checkbox-style marking for bulk actions.
- Doc/editor: toolbar (edit, review/apply, discard, copy, wrap, format switch describe/YAML/JSON).
- Logs: toolbar (follow, wrap, timestamps, since/tail, previous, container picker, search). Shell: reconnect, copy mode.
- Titlebar/bottom row: context and namespace switchers, palette, favourites, help, settings, side-panel toggles as
  buttons; the hint row items are clickable and run their action.
- Every button shows its shortcut in the tooltip (teaches the keys); nothing is keyboard-only or pointer-only.
- Stays compact: icon buttons, hover-revealed where it would clutter, no layout shift.
