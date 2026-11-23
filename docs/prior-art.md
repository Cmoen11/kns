# kns — prior art and building fluid apps (2026-11-21)

Complements `research.md` §3 (landscape, copy/avoid lists) — nothing from there is repeated. Sources were fetched
2026-11-21. Tags: `[unverified]` = not confirmed from a primary source this session; `[derived]` = our inference
from sourced facts; `[kns]` = observed in this repo's working tree today (other agents are editing `src/` and
`src-tauri/`, so re-check before acting).

Spot-checked directly against source (not only via summaries): Tauri Channel thresholds (`channel.rs`), JET Pilot
watch/shell constants, React `useSyncExternalStore` caveat, xterm.js 6.0.0 release notes (#5105 removes the canvas
renderer), Tauri events-vs-channels doc, existence/state of tauri#12724, jet-pilot#132, headlamp#5863, and the
TanStack Virtual options against the installed packages (`react-virtual` 3.14.26 / `virtual-core` 3.19.11 contain
`directDomUpdates`, `useFlushSync`, `anchorTo`, `followOnAppend`). Everything else rests on sub-research summaries
of the linked pages.

---

## A. Lessons from similar products

### A1. Kubernetes GUIs

#### JET Pilot (Tauri 2 + Vue, kube-rs) — the closest reference, read its source

| Area | What they do | Source |
|---|---|---|
| Watch transport | Rust "WatchHub": one kube-runtime watcher per (context, GVR, namespace scope), shared between subscribers, streamed over `tauri::ipc::Channel<InvokeResponseBody>`. Messages: `snapshot`, `delta {added, modified, deleted}`, `status`. `BATCH_INTERVAL = 150ms`, `WARM_PERIOD = 60s` (watcher stays alive after last unsubscribe), `MAX_WATCHERS = 64` | [watch/mod.rs](https://github.com/unxsist/jet-pilot/blob/main/src-tauri/src/watch/mod.rs) |
| Coalescing | Per uid; N modifications collapse to the latest; added+deleted inside one batch sends nothing | [watch/batch.rs](https://github.com/unxsist/jet-pilot/blob/main/src-tauri/src/watch/batch.rs) |
| Serialise once | Each object is kept as a pre-serialised `Box<str>` (managedFields stripped); a batch is string concatenation sent as `InvokeResponseBody::Json(String)` — no serde pass per send | [watch/object.rs](https://github.com/unxsist/jet-pilot/blob/main/src-tauri/src/watch/object.rs) |
| Relist | A 410 relist is diffed against the store and sent as a delta, so unchanged rows keep identity | [watch/entry.rs](https://github.com/unxsist/jet-pilot/blob/main/src-tauri/src/watch/entry.rs) |
| Hidden window | Delivery pauses when every window is hidden; flushes on resume | watch/mod.rs |
| UI store | `Map<uid,row>` of non-reactive rows; publish to the UI is throttled by measured render cost (never more often than ~4× the last render time; large lists at most every rows/5 ms) | [useWatchedList.ts](https://github.com/unxsist/jet-pilot/blob/main/src/composables/useWatchedList.ts) |
| Table | `@tanstack/vue-virtual`, `overscan: 12`, `getItemKey` = row id | [VirtualDataTable.vue](https://github.com/unxsist/jet-pilot/blob/main/src/components/ui/VirtualDataTable.vue) |
| Logs | Parsed and stored in Rust; UI gets an "appended" notification and pulls the filtered window. Bounded queue `LINE_QUEUE = 16_384` (backpressure), `BATCH_WINDOW = 80ms`, `MAX_BATCH = 5_000`, `MAX_ENTRIES_PER_SESSION = 20_000`; virtualized list | [log_stream.rs](https://github.com/unxsist/jet-pilot/blob/main/src-tauri/src/log_stream.rs) |
| Terminal | Output as `InvokeResponseBody::Raw(bytes)` on a Channel (no base64); 256 KiB scrollback replay; xterm 5.3 + fit only | [shell.rs](https://github.com/unxsist/jet-pilot/blob/main/src-tauri/src/shell.rs) |

Their bugs (all avoidable):
- **Windows startup crash**: the `watch_subscribe` future grew to 362 KB, Tauri's command wrappers multiplied it ~6× and overflowed the 1 MB Windows main-thread stack. Fix: box the client build, bigger stack, a future-size test. [#132](https://github.com/unxsist/jet-pilot/issues/132)
- **WKWebView-only freeze**: a reactive effect that read what it wrote ping-ponged between two kept-alive tables; Chromium survived, WKWebView hung, so browser testing missed it. [PR #127](https://github.com/unxsist/jet-pilot/pull/127)
- **Dead keyboard after palette jump**: focus was restored to an element in a now-hidden view. Fix: restore only if the element is connected and visible, else focus the content root, deferred one task. [#109](https://github.com/unxsist/jet-pilot/issues/109)
- Windows: console windows flashing from spawned processes. [#70](https://github.com/unxsist/jet-pilot/issues/70) (cause `[unverified]`)

**Copy:** Channel + serialise-once + uid coalescing + relist-as-diff + warm watchers + pause-when-hidden + render-cost-adaptive publish + Raw exec bytes. **Avoid:** large command futures, effect loops, blind focus restore.

#### Kubeli (Tauri 2 + React 19 + kube-rs) — same frontend stack as kns

- Watch: `app.emit` per watcher event (global events, not Channels); typed per-kind commands for 7 kinds, everything else polls. [watch.rs](https://github.com/atilladeniz/Kubeli/blob/main/src-tauri/src/commands/watch.rs)
- UI apply: `setData(prev => …)` with `findIndex` by uid per event → O(n) scan and one React render per event. [useK8sResource.ts](https://github.com/atilladeniz/Kubeli/blob/main/src/lib/hooks/k8s/useK8sResource.ts) (our reading of the source; no issue reports it)
- Table: `@tanstack/react-virtual`, 44px rows, overscan 10; the table component **opts out of React Compiler** because of `useVirtualizer`.
- Logs: backend batching (50 ms / 100 lines) was added late because one webview event per line was too slow. [PR #370](https://github.com/atilladeniz/Kubeli/pull/370)
- Terminal: xterm 6 + fit + web-links; text frames batched 8 ms / 64 KiB with carry-over for split UTF-8 sequences. [shell.rs](https://github.com/atilladeniz/Kubeli/blob/main/src-tauri/src/commands/shell.rs)
- Watches and pollers stop after 30 s hidden/unfocused. [PR #506](https://github.com/atilladeniz/Kubeli/pull/506)
- Startup: subprocess probes congested the Tauri command worker pool; an artificial 400 ms delay was removed. [PR #341](https://github.com/atilladeniz/Kubeli/pull/341)
- Monaco cursor/selection broke across two releases (global `user-select` + mount/layout race). [#73](https://github.com/atilladeniz/Kubeli/issues/73)

**Copy:** idle grace-period pause; UTF-8 carry-over if text is ever sent. **Avoid:** per-event emit, array-scan state, per-kind watch commands, blocking work in commands at startup, global `user-select: none` that reaches the editor.

#### Headlamp (Electron/web + Go backend)

- Always-on watches on an overview page: 1300 nodes → ~30 MB/s inbound, heap 1.0 → 3.5 GB, renderer OOM. Fix was polling every minute. [#5863](https://github.com/kubernetes-sigs/headlamp/issues/5863), [PR #6021](https://github.com/kubernetes-sigs/headlamp/pull/6021)
- Unbounded list: 35k pods OOM; fix `limit=1000` + load more, watch off while paginated. [PR #5660](https://github.com/kubernetes-sigs/headlamp/pull/5660)
- TanStack-style faceting (`getFacetedUniqueValues`) builds a map for every column on every change; guarded off above 500 rows. [PR #7486](https://github.com/kubernetes-sigs/headlamp/pull/7486)
- Table is paginated material-react-table, not virtualized; logs are xterm with `scrollback: 10000` + search addon.
- v0.45 startup: lazy-load optional modules, tune GC. [PR #7358](https://github.com/kubernetes-sigs/headlamp/pull/7358)

**Lesson:** a watch is a firehose proportional to object size × churn. Table-format rows (kns) are the right default; never ship full objects for a list; never compute per-column facets eagerly.

#### Freelens / Lens (Electron, MobX)

- Watch events buffered and flushed by a reaction with a 1000 ms delay; buffer 50 000. [kube-object.store.ts](https://github.com/freelensapp/freelens/blob/main/packages/core/src/common/k8s-api/kube-object.store.ts)
- Freeze at 4k+ pods: derived per-row indexes (events for object, etc.) were recomputed on every access because of a missing observable setup. [#1777](https://github.com/freelensapp/freelens/issues/1777), [PR #1956](https://github.com/freelensapp/freelens/pull/1956)
- Lens: above ~1000 pods even the namespace switch becomes sluggish. [lens#6247](https://github.com/lensapp/lens/issues/6247)
- Logs: ANSI → HTML per line with sanitising on render.

**Lesson:** 1 s flush is visibly laggy — stay ≤ 150 ms. Any per-row derived lookup (events by uid, metrics by pod, owner) must be an index built once per change, never a scan per cell render. Parse ANSI at ingest, not at render.

#### Closed products (changelogs only)

- **Aptakube** ([changelog](https://aptakube.com/changelog)): whole releases are performance-only for lists/watches/navigation on large clusters (1.21.4, 1.22.2); reduced idle CPU and network (1.19.7); fewer TCP connections to the API server (1.18.6); ~30% smaller/faster start (1.21.6); drain no longer freezes the app (1.21.3); `G P`-style chord navigation (1.22.0). Author on HN calls Tauri one of his best decisions; a happy user still keeps k9s for key bindings and plugins ([HN search](https://hn.algolia.com/api/v1/search?query=aptakube&tags=comment)). Wording via summariser, approximate.
- **K8Studio** ([changelog](https://k8studio.io/changelog/)): 3.1.6 high-throughput log rendering; 3.1.7 dedupes metric fetches and skips UI updates when values are unchanged.
- **Kunobi**: no independent engineering signal found.
- **Kore** (GPUI + `alacritty_terminal`), **Seabird** (GTK4 + VTE): native stacks, nothing transferable beyond what §3 has.

**Lesson:** the paid competitor's changelog is mostly perf work on idle cost and large lists — idle CPU/network is a feature. Long operations (drain) must be background tasks with progress, never awaited in a UI path.

**Gaps in A1 (asked for, not found):** multi-cluster handling — only JET Pilot's per-(context, GVR, namespace) watcher key and `MAX_WATCHERS` cap were found, nothing on merged tables; Reddit threads were not fetched and independent user praise/complaints are thin (HN comments on Aptakube only); Freelens log cap and exec transport not read; closed products have no engineering write-ups.

### A2. Keyboard-first / pane-based apps

#### Hits on decisions already made in `ux.md`

| kns decision | Evidence | Action |
|---|---|---|
| Leader `Ctrl+.` | Linux ibus hijacks `Ctrl+.` (emoji) — irrelevant on Win/mac. [VS Code wiki](https://github.com/microsoft/vscode/wiki/Keybinding-Issues) | Keep. Note if Linux is ever added |
| Which-key after 250 ms | which-key.nvim default 200 ms ([repo](https://github.com/folke/which-key.nvim)); Zed default 1000 ms and off, raised from 700 because the panel flashed when a prefix was also a complete binding ([Zed PR 43618](https://github.com/zed-industries/zed/pull/43618)) | Keep 250 ms, but **enforce in the keymap validator that a leader/prefix chord is never also a complete binding** in the same scope (otherwise a timeout is needed and everything gets laggy; Zed waits 1 s — [docs](https://zed.dev/docs/key-bindings)) |
| Match on produced character | VS Code deliberately does not: Windows dispatches on `keyCode`, mac/Linux on `code` + native layout lookup; any `Ctrl+Alt+<key>` default shadows AltGr characters. [VS Code wiki](https://github.com/microsoft/vscode/wiki/Keybinding-Issues) | `[kns]` `src/keys/chord.ts` already guards IME, `Dead`, AltGr and mac Option, and uses `code` for digits/non-Latin letters. Keep the rule "no `Ctrl+Alt+<char>` defaults"; allow an optional physical-key form (VS Code's `ctrl+[Backquote]` syntax — [docs](https://code.visualstudio.com/docs/configure/keybindings)) in overrides as an escape hatch |

#### Pane focus

- Zed: directional (`ctrl-k ctrl-<arrow>`), numbered (`alt-1..9`), swap, zoom (`shift-escape`); vim map adds cyclic and "previous pane". [default keymap](https://raw.githubusercontent.com/zed-industries/zed/main/assets/keymaps/default-linux.json), [vim keymap](https://raw.githubusercontent.com/zed-industries/zed/main/assets/keymaps/vim.json)
- tmux: prefix+arrows (wraps), `q` flashes pane numbers then a digit jumps, `;` = previously active pane. [man](https://man.openbsd.org/tmux.1)
- lazygit: numbered jump with the jump key printed in each panel title (`showPanelJumps`). [Config.md](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md)
- Warp: directional + cyclic + maximize. [docs](https://docs.warp.dev/terminal/windows/split-panes) Claude Desktop: focused pane normal, others dimmed. [docs](https://code.claude.com/docs/en/desktop.md)
- Zed tabs: close → activate by history (MRU) is a setting (`activate_on_close`). [settings](https://zed.dev/docs/reference/all-settings)

**Copy:** all three models — directional, numbered (number shown in the pane header, lazygit-style) and a "last pane" toggle; MRU focus when a pane closes; optionally dim inactive panes. **Avoid:** overloading one digit chord with different meanings per context (Zed `alt-1..9` = pane or tab). Which pane receives focus on close is undocumented in Zed/VS Code/tmux/Warp — specify it in kns (MRU) and test it.

#### Resize

- tmux: two step sizes (1 and 5 cells); repeatable bindings within `repeat-time` 500 ms; even-spread layout; zoom shows `Z` in the status line and any layout-changing command auto-unzooms. [man](https://man.openbsd.org/tmux.1)
- Zed vim map: `ctrl-w =` resets sizes, `ctrl-w _` maximizes. VS Code: toggle-maximize group; double-click tab can "expand" (others shrunk) or "maximize" (others hidden). [custom layout](https://code.visualstudio.com/docs/configure/custom-layout)
- which-key.nvim "hydra" (`loop = true`) keeps the panel open until Esc.

**Copy:** sticky RESIZE mode with the which-key panel staying up (already in `ux.md`), two step sizes, `=` equalize, zoom indicator, auto-unzoom on split/move. **Avoid:** invisible timeout-based repeat.

#### Shortcut discoverability

- Zed: status bar shows pending keystrokes; a key mid-chord opens the list of continuations and pauses the timeout. [docs](https://zed.dev/docs/key-bindings) Which-key issues they hit: empty on first press, listing duplicate/disabled bindings. [PR 43618](https://github.com/zed-industries/zed/pull/43618)
- Raycast action panel: every action shows its shortcut; Enter runs the primary action without opening the panel. [manual](https://manual.raycast.com/action-panel.md)
- Superhuman: the palette is the one place for every command and teaches the shortcut; alias matches render as `title (alias)` so the canonical name is learned; the same key toggles the palette and restores prior focus. [blog](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)
- Linear: `?` help is searchable and was redesigned to raise shortcut adoption; `G` then `I`-style sequences. [changelog](https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help)
- zellij: default keys collided with apps running inside (e.g. vim); 0.41 added an "unlock-first" preset and a first-run choice. [post](https://zellij.dev/news/colliding-keybinds-plugin-manager/)

**Copy:** pending-chord indicator in the bottom row; palette rows always show the binding; `?` overlay searchable; alias → canonical name. **Avoid:** which-key showing unbuilt/disabled entries (matches `ux.md` principle 12); app keys leaking into shell panes — kns needs an explicit pass-through rule for terminal and editor panes (see B6).

#### Command palette

- Raycast ranking: exact alias → alias prefix → fuzzy title → subtitle/keywords → frecency; per-item "reset ranking"; empty state shows favourites and recents. [manual](https://manual.raycast.com/search-bar.md)
- Warp: prefixes have long and short forms plus clickable filter chips. [docs](https://docs.warp.dev/terminal/command-palette) VS Code: `?` lists the available prefixes. [docs](https://code.visualstudio.com/docs/getstarted/userinterface)
- Superhuman: boost context-relevant commands, hide only the fully irrelevant; latency ceiling 100 ms, target < 50 ms. [speed post](https://blog.superhuman.com/superhuman-is-built-for-speed/)

**Copy:** Raycast's ranking order; per-query frecency persisted via `save_state`; empty state = favourites + recents + actions for the focused pane's selection; `?` lists prefixes. **Avoid:** fuzzy matching beating an exact alias (`po` must always be pods).

#### Saved layouts / restore

- Warp launch configs (YAML: windows/tabs/panes, split direction, focus) — a file with an unresolvable path silently disappears from the list. Session restore is separate (auto, overwritten on quit). [launch configs](https://docs.warp.dev/terminal/sessions/launch-configurations), [restore](https://docs.warp.dev/terminal/sessions/session-restoration)
- zellij: KDL layouts with percentage sizes (fixed sizes are flagged unstable), invalid files fail with a pointed error; **swap layouts** keyed on pane count auto-rearrange as panes open/close. [layouts](https://zellij.dev/documentation/creating-a-layout.html), [swap layouts](https://zellij.dev/documentation/swap-layouts.html)
- Obsidian Workspaces: explicit save-over under a name. [help](https://obsidian.md/help/plugins/workspaces) Zed: `restore_on_startup` options.

**Copy:** store tree + ratios (never px) + per-pane view params + focused pane; keep "auto session restore" and "named layouts" as two separate things; a pane whose resource no longer resolves is restored as a placeholder with the error, never dropped `[derived]`. **Avoid:** silent drop of invalid layout files.

#### Keymap precedence and rebinding UI

- Zed: context tree, deeper context wins, then later definition wins; `null` unbinds. VS Code: last matching rule wins, `-command` removes, "show same keybindings", record-key widget, and a **dispatch troubleshooting log**. [VS Code docs](https://code.visualstudio.com/docs/configure/keybindings)
- Obsidian only got a usable conflict list in 1.13 (filter for conflicts, tooltip naming the other command). [forum](https://forum.obsidian.md/t/implemented-v1-13-hotkeys-click-on-n-commands-with-conflicts-to-show-all-hotkey-conflicts/84829)

**Copy:** record-key widget, live conflict list scoped to overlapping contexts, and a "key trace" debug toggle (shows event → stroke → scope → action) — cheap to build on `src/keys` and it pays for itself on the first Norwegian-layout bug.

**Gaps in A2 (asked for, not found):** Arc (help pages returned 403, nothing verified); Linear and Raycast engineering posts on speed/sync (only product docs and changelogs sourced); zellij mode-aware status-bar hints and Linear tooltip hints (search snippets only); min pane sizes and focus-after-close are undocumented everywhere checked; Claude Desktop panes: only the focus/dim behaviour and close keys are documented.

### A3. Tauri post-mortems and platform lessons

| Lesson | Detail | Source |
|---|---|---|
| Windows is the IPC bottleneck | Maintainer-relayed, non-scientific: 10 MB binary IPC ≈ 5 ms on macOS, ≈ 200 ms on Windows | [discussion 11915](https://github.com/orgs/tauri-apps/discussions/11915) |
| Per-message webview memory growth on WebView2 | Open: 2M events → ~1.1 GB webview; distinct payloads grow the heap, identical ones do not; reproduced in plain WebView2 (script retained per eval). Channels showed private-memory growth too. Draft fix covers events only | [tauri#12724](https://github.com/tauri-apps/tauri/issues/12724), [wry#1489](https://github.com/tauri-apps/wry/issues/1489) |
| No memory win on Windows | WebView2 app memory ≈ Electron (v1-era measurement: 370–399 MB vs 312–318 MB for the same sites) | [tauri#5889](https://github.com/tauri-apps/tauri/issues/5889) |
| White flash | Maintainer fix: `visible: false`, `show()` after frontend-ready. `backgroundColor` exists in 2.x but ignores alpha on Windows and the webview layer is not implemented on macOS | [tauri#1564](https://github.com/tauri-apps/tauri/issues/1564), [builder docs](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html) |
| Windows snap layouts need native decorations | Unsupported with `decorations: false`, upstream-blocked, will not land in v2 | [tauri#4531](https://github.com/tauri-apps/tauri/issues/4531) |
| WKWebView = OS Safari | Feature floor is the user's macOS version; `minimumSystemVersion` defaults to 10.13 | [webview versions](https://v2.tauri.app/reference/webview-versions/) |
| WKWebView rAF is capped at 60 fps | Closed "not planned"; workaround uses a private API | [tauri#13978](https://github.com/tauri-apps/tauri/issues/13978) |
| Hidden webviews throttle | `backgroundThrottling` config is macOS 14+ only; hidden views may throttle timers | [config](https://v2.tauri.app/reference/config/) |
| WKWebView smart punctuation | A DB client shipped a bug where a typed straight quote became a curly quote and broke queries. Same post: page results, virtualize, write big exports from Rust to file | [Tabularis post](https://hackernoon.com/six-months-with-tauri-the-benefits-and-the-bill) |
| `additionalBrowserArgs` replaces wry's defaults | Re-add `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` if you set it | builder docs |
| `data-tauri-drag-region` is not inherited | Applies only to the element itself; needs `core:window:allow-start-dragging` | [window customization](https://v2.tauri.app/learn/window-customization/) |
| Browser accelerators are on by default | WebView2 zoom hotkeys default on; `tauri-plugin-prevent-default` has flags for reload, find, print, devtools, context menu and Windows `browser_accelerator_keys` | [plugin README](https://docs.rs/crate/tauri-plugin-prevent-default/latest/source/README.md) |
| Updater key is forever | Signature check cannot be disabled; a lost private key ends updates for existing installs; the key must be a real env var in CI | [updater](https://v2.tauri.app/plugin/updater/) |
| Unsigned macOS | Browser-downloaded unsigned apps show as damaged; Apple Silicon requires at least ad-hoc signing | [sign/macos](https://v2.tauri.app/distribute/sign/macos/) |
| WebView2 installer modes | `downloadBootstrapper` +0, `embedBootstrapper` +~1.8 MB, `offlineInstaller` +~127 MB | [windows installer](https://v2.tauri.app/distribute/windows-installer/) |
| Left Tauri for Electron | Drivers were Linux WebKitGTK, notifications and sidecar packaging — not Windows/macOS | [Paseo post](https://dev.to/moboudra/i-was-wrong-about-electron-1e9g) |
| No Chrome profiler on WKWebView | One team profiled their production UI in Chrome through a bridge shim | [secondary source](https://fooqux.com/article/5536) `[unverified]` |

Not found this session: rigorous IPC MB/s benchmarks, WebView2 cold-start numbers, write-ups from Spacedrive/Hoppscotch/GitButler/Yaak/Jan.

---

## B. Building fluid apps

Format: **technique** → why → how in kns → source.

### B1. Budgets and perceived performance

- **Budget keys at 50 ms, not 200 ms.** RAIL: respond < 100 ms, handle input within 50 ms, produce a frame in ~10 ms of the 16 ms slot ([web.dev RAIL](https://web.dev/articles/rail)). INP "good" (≤ 200 ms, [web.dev INP](https://web.dev/articles/inp)) is far too loose here: Superhuman's rule is 100 ms ceiling, < 50 ms target ([post](https://blog.superhuman.com/superhuman-is-built-for-speed/)); editor-latency measurements put good native editors at 1–10 ms and a slow web editor at ~50 ms ([Fatin](https://pavelfatin.com/typing-with-pleasure/)); hardware already adds tens of ms ([Dan Luu](https://danluu.com/input-lag/)). → kns: cursor move/typing painted in the next frame (handler ≤ 8 ms); view swap ≤ 50 ms; nothing ≥ 100 ms without visible feedback.
- **Instant from cache, then stream.** Superhuman: local cache + preload likely-next. → keep the last snapshot per (gvr, ns) in the store and keep watchers warm ~60 s (JET Pilot) so Esc/back and pane re-open paint in the same frame; show `syncing` only when there is no cache.
- **Optimistic with a pending overlay.** Figma: apply locally, ignore server values that conflict with unacknowledged local changes to avoid flicker ([post](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)). → for tier-0 actions (scale, suspend, cordon) keep a per-uid pending patch over incoming deltas until the command resolves `[derived]`.
- **No layout shift by construction.** Fixed 20px rows/16px lines (already specified), `scrollbar-gutter: stable` on scrollers (no effect with mac overlay scrollbars — [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/scrollbar-gutter)), fonts loaded before first paint (B5).

### B2. React 19

- **External-store updates are always blocking.** react.dev: a store mutation during a transition makes React restart that render as blocking ([useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)). → with deltas every 100 ms, any transition that reads zustand and takes > 100 ms de-opts every time `[derived]`. So: the table store path must be cheap enough to render synchronously (≤ ~4 ms per batch), and anything slow (filter/sort of 10k rows) must be computed outside render and published as a finished result.
- **Keep text input synchronous.** Transitions cannot drive controlled inputs; use `useState` for the input and `useDeferredValue` for the consumer, with the slow child memoized ([useTransition](https://react.dev/reference/react/useTransition), [useDeferredValue](https://react.dev/reference/react/useDeferredValue)). → filter bar and palette: the keystroke only sets local state; the row filter runs on the deferred value (or debounced in the store).
- **zustand v5.** Atomic selectors with `===`; a selector returning a new reference can loop — wrap with `useShallow` ([migration](https://zustand.docs.pmnd.rs/reference/migrations/migrating-to-v5)). `store.subscribe` (+ `subscribeWithSelector`) gives **transient updates** that write to refs/DOM without rendering ([README](https://raw.githubusercontent.com/pmndrs/zustand/main/README.md)). → use transient subscriptions for counters, watch-state glyph, delta flash, scroll position; never call `useStore()` without a selector.
- **React Compiler 1.0** is stable (2025-10) and memoizes within components/hooks ([blog](https://react.dev/blog/2025/10/07/react-compiler-1)). Known problem: `useVirtualizer` returns stale items under the compiler; workaround is `"use no memo"` in that component ([virtual#736](https://github.com/TanStack/virtual/issues/736)); TanStack Table v8's hook is on the incompatible list, v9 `useTable` compiles ([Table guide](https://tanstack.com/table/latest/docs/framework/react/guide/react-compiler)). → `[kns]` not installed yet; if adopted, add `"use no memo"` to the virtualized table and log list and keep the lint on. Kubeli does exactly this.
- **`<Activity mode="hidden">`** (React 19.2) keeps state and DOM, applies `display:none`, **destroys effects** and renders at low priority ([reference](https://react.dev/reference/react/Activity)). → good for folded/zoomed-away panes, but xterm/CodeMirror instances and stream subscriptions created in effects are torn down on hide; own those in a per-pane controller object outside React and only attach/detach the DOM node `[derived]`. `[kns]` installed React is 19.3.1 (`package.json` range `^19.1.0`), so `<Activity>` is available.
- **When to bypass React.** TanStack limits direct DOM writes to scroll positioning, not cell data ([virtualization guide](https://tanstack.com/table/latest/docs/framework/react/guide/virtualization.md)). VS Code's split view writes sizes straight to `style` ([splitview.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/base/browser/ui/splitview/splitview.ts)). → bypass for: divider drag, virtual scroll offset, cursor-bar position, delta flash class, statusbar counters. Not for cell contents.
- `flushSync` is a last resort ([react.dev](https://react.dev/reference/react-dom/flushSync)).

### B3. Virtualized tables with live deltas

- **Virtualizer settings (TanStack Virtual 3.14.26 — `[kns]` installed version).** Defaults are `overscan: 1`, `getItemKey` = index, `isScrollingResetDelay` 150 ms ([API](https://tanstack.com/virtual/latest/docs/api/virtualizer)). → set `estimateSize: () => 20` (never `measureElement`), `getItemKey` = uid (memoized), `overscan` 8–12, custom `rangeExtractor` that always includes the cursor row, and position with a single translated block. `useFlushSync` (default true) forces a sync render per scroll event; setting it false batches but can lag visually — measure both ([docs](https://raw.githubusercontent.com/TanStack/virtual/main/docs/framework/react/react-virtual.md)). `directDomUpdates` (virtualizer writes positions itself and re-renders only when the index range or `isScrolling` changes; items must be `position:absolute; top:0`) is present in the installed version — the best fit for kns's fixed rows; measure against the default.
- **Row identity + scroll anchoring with fixed rows.** Key by uid. When rows are inserted/removed above the viewport, add `delta × 20px` to `scrollTop` in the same commit `[derived]`; opt out of browser anchoring with `overflow-anchor: none` so the two do not fight ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor)). Note Safari only supports `overflow-anchor` from 27, so never depend on native anchoring ([caniuse](https://caniuse.com/css-overflow-anchor)). This implements `ux.md` principle 8 ("cursor row never moves because of data").
- **One commit per batch, at most one per frame.** AG Grid's high-frequency API batches transactions for 50 ms by default ([docs](https://www.ag-grid.com/react-data-grid/data-update-high-frequency/)); JET Pilot additionally throttles by measured render cost. → backend already flushes at 100 ms; on the UI apply each delta to the `Map`, mark dirty, and publish once in `requestAnimationFrame`; if the last publish cost > budget, skip frames.
- **Store shape.** `Map<uid,row>` + a separately maintained sorted/filtered `uid[]` view. A delta updates the map in O(k) and patches the view by binary insertion when the sort key is stable; full re-sort only on user action (already the rule in `research.md` §6.7). Per-row derived data is indexed by uid once per change (Freelens lesson).
- **Sorting cost.** Reuse one `Intl.Collator` and its `compare` for large sorts rather than `localeCompare` ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/localeCompare)); precompute sort keys (numbers for age/restarts/CPU) at ingest. No trustworthy benchmark number found.
- **TanStack Table v9** (stable 2026-08) reports large wins on 20k+ rows and a selector API so components subscribe to slices ([announcement](https://tanstack.com/blog/announcing-tanstack-table-v9), [migration](https://tanstack.com/table/latest/docs/framework/react/guide/migrating.md)). `[kns]` it is not a dependency today; for a fixed-row, k9s-style table a hand-rolled column model + own sort/filter is small and avoids row-model rebuilds on every delta. If Table is added, never enable faceting (Headlamp).
- **Row DOM cost.** Rows as absolutely positioned flex/grid lines (no `<table>` layout), ~10 cells × ~60 mounted rows per pane. VS Code's list widget insists on known heights before render and handles 100k items ([wiki](https://github.com/microsoft/vscode/wiki/Lists-And-Trees)). Canvas grids (Glide) are the escape hatch if DOM rows ever fail the budget — not needed at this size.
- **cmdk** is fine up to ~2–3k items; beyond that turn off its filter, rank yourself and virtualize ([README](https://raw.githubusercontent.com/pacocoursey/cmdk/main/README.md)). `[kns]` not installed; the Raycast-style ranking in A2 needs custom scoring anyway.

### B4. Streaming: logs and terminal

- **xterm flow control.** Parser throughput 5–35 MB/s; the write buffer hard-caps at 50 MB and drops beyond it. Use `write(data, cb)` with watermarks (guide example: HIGH 100 000 / LOW 10 000 bytes; keep HIGH ≤ 500 K for keystroke response), and do not attach a callback to every chunk ([guide](https://xtermjs.org/docs/guides/flowcontrol/)). VS Code: `HighWatermarkChars` 100 000, `LowWatermarkChars` 5 000, ack every 5 000 chars ([source](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/platform/terminal/common/terminal.ts)). → kns: count bytes in the xterm `write` callback and ack to Rust every 5 000 bytes consumed (one `invoke`); Rust stops reading exec stdout when un-acked bytes exceed 100 000 and resumes below 5 000. Invariant from VS Code: **ack size ≤ resume threshold**, otherwise the stream can stall with the last ack never sent. This is the "credit window" from `research.md` §5.12, now with numbers.
- **Renderer.** xterm.js 6.0.0 (2025-12-22) removed the canvas addon; choices are DOM or WebGL ([release](https://github.com/xtermjs/xterm.js/releases)). WebGL contexts can be lost (OOM, suspend): handle `onContextLoss` by disposing the addon and falling back to DOM ([addon README](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-webgl/README.md)); VS Code does try-WebGL-else-DOM ([docs](https://code.visualstudio.com/docs/terminal/appearance)). → `[kns]` only `addon-fit` and `addon-web-links` are installed; add `@xterm/addon-webgl` with the fallback, and cap concurrent WebGL terminals (each pane = one context) `[derived]`. WebGL behaviour in WKWebView is unverified — DOM renderer must be acceptable on mac.
- **Log viewer structure (Chrome DevTools console).** Keeps ~2 viewports of rows in the DOM, cumulative heights in an `Int32Array` with binary search, spacer divs above/below, and a stick-to-bottom flag that renders the tail and pins `scrollTop` ([ConsoleViewport.ts](https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/main/front_end/panels/console/ConsoleViewport.ts)). → with fixed 16px lines kns needs no height array while wrap is off; with wrap on, use the same cumulative-height array. TanStack Virtual also has `anchorTo: 'end'` + `followOnAppend` (present in the installed `virtual-core` 3.19.11) for follow mode.
- **Ring buffer + rAF append.** Store lines in a fixed-capacity ring (index arithmetic, no `Array.shift`), parse ANSI SGR once at ingest into spans (Freelens parses per render), append at most once per frame, and when follow is off never touch `scrollTop` (when the ring evicts lines above the viewport, compensate by `evicted × 16px`). `[derived]`; JET Pilot goes further and keeps the buffer in Rust, UI pulling only the visible/filtered window — the right move if 50k lines × several panes costs too much JS heap.
- **Search without blocking.** Chunk over the ring and yield: `scheduler.yield()` exists in Chromium 129+ but not in Safari → feature-detect with a `setTimeout(0)`/`MessageChannel` fallback ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield), [caniuse](https://caniuse.com/mdn-api_scheduler_yield)). Or search in Rust if the buffer lives there.
- **CodeMirror 6.** Renders only the viewport; DOM writes and layout reads are separated (reads go through `requestMeasure`) ([guide](https://codemirror.net/docs/guide/)). → for a live-following YAML view dispatch minimal `changes`, not a new state; never read layout in an update listener.

### B5. Tauri IPC, startup, webview differences

- **Channels, not events, for every stream.** Events are JSON-only, delivered by evaluating JS, and documented as not for high throughput; Channels are ordered and fast ([calling-frontend](https://v2.tauri.app/develop/calling-frontend/)). `[kns]` already uses Channels everywhere.
- **Know the Channel thresholds (tauri 2.12.x source).** JSON < 8192 B and raw < 1024 B are inlined into an eval'd script; larger payloads are stored and fetched by the webview via an internal fetch command. Source comments: eval is ~2× faster than fetch for 8 KB JSON on WebView2, ~30% faster for 1 KB on macOS ([channel.rs](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/ipc/channel.rs)). `Channel<Vec<u8>>` serialises as a JSON number array — raw bytes need `InvokeResponseBody::Raw`. → small frequent messages are cheap; large snapshots take a second round trip; neither path avoids the per-message script on WebView2 (A3 leak), so **fewer, larger messages** is the rule.
- **Terminal bytes as Raw.** `[kns]` `src-tauri/src/exec.rs` base64-encodes into a JSON `Data` event every ≤ 16 ms. Base64 adds a third in size plus encode + `atob` + copy on a hot path. → change the exec channel to `Channel<InvokeResponseBody>`: `Raw(bytes)` for output, `Json` for `exit`/errors (JET Pilot pattern); UI receives an `ArrayBuffer` and passes a `Uint8Array` straight to `term.write`. Also removes the UTF-8 split problem entirely.
- **Serialise once.** `[kns]` `table.rs` builds `serde_json::Value` rows then the Channel serialises `TableEvent` again. → keep each row as a pre-serialised string keyed by uid (also makes relist-diff a string compare) and send batches as `InvokeResponseBody::Json(String)` (JET Pilot). Large invoke results (YAML, JSON) can return `tauri::ipc::Response` instead of a serialised struct ([calling-rust](https://v2.tauri.app/develop/calling-rust/)).
- **Snapshot size.** `[kns]` the snapshot is one message with labels and ownerReferences per row. On Windows large IPC is the slow path (A3). → measure a 10k-row snapshot on WebView2; if > 50 ms, send the first ~200 rows as their own message (first paint), then the rest; drop labels from rows unless a label filter/column needs them.
- **Do the heavy work in Rust.** Parsing, coalescing, timestamp splitting, quantity parsing and (optionally) log search/filter belong in Rust; the webview thread should only apply and paint. Tabularis/QoreDB reached the same conclusion (cursor in Rust, pages over IPC).
- **Commands must not block or bloat.** Kubeli congested the command pool with subprocess probes at startup; JET Pilot overflowed the Windows main-thread stack with a 362 KB command future. → `async` commands that `tokio::spawn` the long-lived task and return the id (kns does this); add a test asserting `size_of_val(&future)` for the big commands stays small, box large inner futures.
- **Startup without a flash.** `[kns]` `tauri.conf.json` has no `visible: false`, no `backgroundColor`, and `index.html` has no `color-scheme` meta or inline background. → create the window hidden, set `backgroundColor` to the theme background, inline a 1 KB critical style block (background + `color-scheme`) in `index.html`, and call `getCurrentWindow().show()` once the shell has committed and the UI font promise has resolved — trigger it from a layout effect / microtask, **not** from `requestAnimationFrame`: a hidden webview may throttle or never fire rAF (see below), which would leave the window waiting for the fallback `[verify on both platforms]`. Add a Rust-side timeout (~1.5 s) so a JS failure still shows the window. ([tauri#1564](https://github.com/tauri-apps/tauri/issues/1564); `<meta name="color-scheme">` prevents default-white canvas — [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme))
- **WebView2 cold start.** Microsoft: first creation spins up processes and caches; keep the user-data folder on local disk; get static content up first and defer heavy script ([perf guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)). → code-split CodeMirror, xterm, YAML parser and settings out of the entry chunk (dynamic `import()`), prefetch them on idle; start `connect` + discovery in Rust at process start, not after React mounts.
- **Release profile.** `[kns]` already `lto`, `codegen-units = 1`, `opt-level = 3`, `panic = "abort"`, `strip` — matches [Tauri guidance](https://v2.tauri.app/concept/size/). `tokio` uses `features = ["full"]`; trim later for build time/size.
- **WKWebView feature floor** (set `bundle.macOS.minimumSystemVersion` deliberately): `content-visibility` Safari 18, View Transitions 18, `overflow-anchor` 27, `getCoalescedEvents` 18.2, Event Timing 26.2; **absent**: `scheduler.yield/postTask`, `long-animation-frame`, `longtask`, `layout-shift`, `navigator.keyboard.getLayoutMap` ([caniuse](https://caniuse.com/css-content-visibility), [MDN BCD](https://github.com/mdn/browser-compat-data)). → feature-detect all of these; the perf HUD (B7) degrades to rAF timing on mac.
- **Hidden/occluded windows throttle timers and rAF.** → never use rAF as the only pump for draining streams: when `document.hidden`, stop publishing and tell Rust to pause delivery (JET Pilot), resume with a fresh snapshot/diff.
- **Font rendering differs.** `-webkit-font-smoothing: antialiased` only affects macOS and makes light-on-dark text thinner ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/font-smooth)); the UI font at 12px on a dark surface should be judged on a real Mac before forcing it. Windows uses its own ClearType/grayscale pipeline `[unverified details]`.
- **Fonts off the critical path.** `[kns]` An earlier font stylesheet inlined six base64 woff2 faces (595 KB). web.dev advises against inlining fonts ([font best practices](https://web.dev/articles/font-best-practices)); the CSS cannot finish parsing until the whole file is read, and the rare heading face was paid for on every start. → ship woff2 as files; `<link rel="preload" as="font" type="font/woff2" crossorigin>` for the two body weights only ([preload](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preload)); declare the display face with normal `@font-face` so it loads on first use; `font-display: block` (local load is ms-scale, avoids a swap); await `document.fonts.load()` for the body face before showing the window; subset to Latin if the licence allows `[unverified]`.
- **xterm font race.** If the mono font is not loaded when the terminal opens, cell metrics come from the fallback font. Load the font first (`@xterm/addon-web-fonts` `loadFonts`, or `document.fonts.load`) and only then `open()` + `fit()` ([addon README](https://cdn.jsdelivr.net/npm/@xterm/addon-web-fonts@0.1.0/README.md), [xterm#1164](https://github.com/xtermjs/xterm.js/issues/1164)).

### B6. CSS, drag-resize, input

- **Contain every pane.** `contain: strict` (size+layout+paint+style) on each pane body — its size is set from outside, so a table update or log append cannot relayout siblings; note it creates a containing block and stacking context ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/contain)). Rows: `contain: content` + fixed height.
- **`content-visibility: auto`** skipped a demo's rendering from 232 ms to 30 ms ([web.dev](https://web.dev/articles/content-visibility)) but is redundant for virtualized rows; use it (or `<Activity>`) for folded-tab panes; Safari ≥ 18 only.
- **Compositor-only + few layers.** Only `transform` and `opacity` skip layout/paint; each promoted layer costs memory; `will-change` is a last resort to be toggled from script ([web.dev](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count), [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/will-change)). kns has no motion (ux decision) — so: no `will-change` in stylesheets, no `backdrop-filter` on overlays (scrim is a flat colour) `[derived — no source on its cost in WebView2/WKWebView was found]`, no box-shadow animations. `[kns]` the template `App.css` still has `will-change: filter` — goes away with the template.
- **Divider drag = zero React renders.** VS Code: on drag start disable pointer events on iframes/views and inject a global cursor style; per move write `style` sizes directly and lay out synchronously; no framework state ([sash.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/base/browser/ui/sash/sash.ts), [splitview.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/base/browser/ui/splitview/splitview.ts)). → on `pointerdown`: `setPointerCapture` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)), read all rects once; on `pointermove`: store the latest x/y only; in rAF: write `flex-basis`/a CSS custom property on the two neighbours; on `pointerup`: commit ratios to the layout store and persist. Same code path for keyboard resize steps. react-resizable-panels exposes the same split (per-move vs after-release callbacks) and a deferred "separator preview" mode for heavy children ([README](https://raw.githubusercontent.com/bvaughn/react-resizable-panels/main/README.md)).
- **No forced reflow in handlers.** Reading `offset*`/`client*`/`getBoundingClientRect`/`scrollTop`/`getComputedStyle` after a write, and calling `focus()` or `scrollIntoView()`, force synchronous layout ([Paul Irish list](https://gist.github.com/paulirish/5d52fb081b3570c81e3a)); batch reads first ([web.dev](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)). → cursor movement must not call `scrollIntoView`/`focus` per keypress: compute the target `scrollTop` from index × 20 and set it once.
- **ResizeObserver discipline.** Callbacks run before paint; writing sizes inside one causes loop errors; defer with rAF and skip when the size is unchanged ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver)). → one shared observer per pane root; xterm `fit()` and column-tier recalculation coalesced to one call per frame during drag, and the PTY resize (`exec_resize`) sent only on drag end/after ~100 ms idle `[derived]`.
- **Scrolling.** `overscroll-behavior: none` on every scroller (kills chaining and mac bounce — [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior)); wheel listeners `{passive: true}` explicitly on pane elements ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener)).
- **Key handling.** `code` is layout-independent, `key` reflects layout+modifiers; ignore `key === "Dead"`; guard IME with `isComposing || keyCode === 229` ([MDN keydown](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event)); AltGr reports Ctrl+Alt on Windows ([getModifierState](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/getModifierState)); a WebKit bug has composition and keydown/keyup events in the wrong order on macOS ([bug 165004](https://bugs.webkit.org/show_bug.cgi?id=165004); whether and where it is fixed is `[unverified]`); keyup may not fire for keys held with Cmd ([bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1299553), WKWebView `[unverified]`). → `[kns]` `chord.ts` covers these; additionally: bind only on `keydown`; never keep "keys currently held" state; reset pending chord on `blur`/`visibilitychange`.
- **Embedded widgets own keys.** xterm: `attachCustomKeyEventHandler` runs first and returning `false` makes xterm skip the key ([API](https://xtermjs.org/docs/api/terminal/classes/terminal/)); CodeMirror: `keymap` precedence via `Prec.highest` ([reference](https://codemirror.net/docs/ref/)). → one window-level capture-phase dispatcher decides; in terminal/editor scopes it lets everything through except the leader, pane-focus chords and palette, and the widgets are configured to yield exactly those (zellij's collision lesson).
- **Focus.** For a virtual list keep DOM focus on the pane container and track the cursor in state (`aria-activedescendant` model) so unmounting a row never loses focus ([APG](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)); `focus({preventScroll: true})` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus)); `inert` on everything behind a dialog ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert)); restore focus by pane id, not element reference (JET Pilot #109).
- **Native feel.** `user-select: none` (+ `-webkit-user-select`) on chrome only — not on cells, logs, YAML ([web.dev](https://web.dev/articles/app-like-pwas)); `cursor: default` on chrome; disable browser accelerators and the default context menu (A3 plugin); `autocorrect/autocapitalize/spellcheck="off"` on every input (WKWebView smart quotes would corrupt `:` commands and label selectors).

### B7. Measuring fluidity

- **In-app perf HUD (dev flag).**
  - Key latency, two numbers: (a) handler cost = `performance.now()` at dispatcher entry → end of the synchronous React commit (measure in a layout effect); (b) frames to paint = number of rAF callbacks between the keydown and the frame that contains the change (should be 1) `[derived]`. A keydown→rAF time alone is dominated by where in the frame the key landed and cannot go below about one frame. Event Timing (`PerformanceObserver({type:'event', durationThreshold:16})`) works too but rounds to 8 ms and has a 16 ms floor ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming)).
  - Frame times: rAF delta histogram during divider drag and scroll.
  - Long frames: `long-animation-frame` entries (> 50 ms, with script attribution and `forcedStyleAndLayoutDuration`) — Chromium/WebView2 only ([docs](https://developer.chrome.com/docs/web-platform/long-animation-frames)).
  - IPC: Rust stamps each batch with send time and byte size; UI records receive→applied→painted.
- **React tracks.** React 19.2 adds Scheduler/Components tracks to Chrome DevTools performance profiles ([react.dev](https://react.dev/reference/dev-tools/react-performance-tracks)) — usable in WebView2 DevTools.
- **DevTools.** Tauri: Ctrl+Shift+I in dev; release builds need the `devtools` feature ([debug](https://v2.tauri.app/develop/debug/)). WKWebView: Safari Web Inspector when inspectable ([WebKit](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/)).
- **Automation.** Launch the built app with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and attach Playwright with `connectOverCDP`; isolate with `WEBVIEW2_USER_DATA_FOLDER` ([Playwright WebView2](https://playwright.dev/docs/webview2)). This gives tracing and scripted key presses against the real webview on Windows. `tauri-driver` has no macOS support ([docs](https://v2.tauri.app/develop/tests/webdriver/)).
- **Memory.** WebView2 is a process group (browser + renderer + GPU + helpers): sum the tree, not the app exe ([process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)). `measureUserAgentSpecificMemory` needs cross-origin isolation — not practical.
- **Rust.** `tracing` spans around list/watch/flush; `tokio-console` for stuck tasks ([repo](https://github.com/tokio-rs/console)).
- **Mock-backend benches.** `[kns]` `src/ipc/mock.ts` exists: add a "storm" mode (10k rows, 500 deltas/s, 5k log lines/s) so table/log performance is testable in plain Chrome with the full profiler, and in CI with Playwright.

---

## C. Top 20 recommendations for kns, ranked by impact

Each item: area → what to check or change → why.

1. **IPC / exec** — `src-tauri/src/exec.rs`, `src/ipc/tauri.ts`, `ExecEvent` in `ipc.rs`/`types.ts`: send terminal output as `InvokeResponseBody::Raw` instead of base64-in-JSON; write the `ArrayBuffer` straight into xterm. Add ack-based flow control (UI acks every 5 000 bytes consumed; Rust pauses above 100 000 un-acked, resumes below 5 000; ack size ≤ resume threshold). Removes encode/decode/copy from the hottest path and bounds memory. (B4, B5)
2. **Startup** — `src-tauri/tauri.conf.json`, `index.html`, `src/main.tsx`: window `visible: false` + `backgroundColor`; inline background + `color-scheme` in `index.html`; `show()` after the first shell commit with fonts ready (not gated on rAF — hidden webviews may not fire it), with a Rust timeout fallback. Replace the template `App.tsx`/`App.css`/title. Start connect + discovery in Rust at launch. (B5)
3. **Fonts** — fonts now come from `@fontsource` as woff2 files (done); preload only the UI font 400/500; the heading serif lazy; mono (`@fontsource/geist-mono`) loaded before any xterm `open()`. Biggest single item on the first-paint path. (B5)
4. **Table store** — `src/store` / `src/table` (not written yet): external store with `Map<uid,row>` + maintained sorted/filtered `uid[]`; apply a backend batch in O(k); publish at most once per `requestAnimationFrame`; skip frames when the last publish exceeded budget; per-row derived data indexed by uid. No `findIndex`, no array copy per event. (A1, B3)
5. **Cursor movement path** — `src/table`, `src/keys`: `j/k` must touch only cursor state: two rows re-render (or a class toggle), scroll target computed arithmetically (index × 20), no `scrollIntoView`, no `focus()` per key, DOM focus stays on the pane container. This is the interaction users feel most. (B2, B6)
6. **Virtualizer config** — `src/table`, logs view: `getItemKey` = uid, fixed `estimateSize`, overscan 8–12, `rangeExtractor` including the cursor row, `overflow-anchor: none` + manual `scrollTop` compensation (`Δrows × 20`) for inserts/removes above the viewport. Measure `useFlushSync` true vs false and try `directDomUpdates`. (B3)
7. **Pane resize** — `src/panes`: drag writes sizes directly to the DOM in rAF with pointer capture; commit to the layout store only on release; `contain: strict` on pane bodies; coalesce xterm `fit()`/column-tier recalculation to one per frame and send `exec_resize` only when the drag settles. Target zero React renders during a drag. (B6)
8. **Filter/palette input** — `src/table` filter bar, `src/palette`: the keystroke updates only local input state; filtering 10k rows runs on a deferred value or in the store off the keystroke; never read the big store inside a transition (external-store updates force blocking renders). (B2)
9. **Table IPC payloads** — `src-tauri/src/table.rs`: keep rows pre-serialised per uid and send `InvokeResponseBody::Json(String)`; measure a 10k-row snapshot on WebView2 and split off the first ~200 rows if it exceeds 50 ms; drop `labels` from rows unless needed. (A1, B5)
10. **WebView2 message-count soak test** — IPC in general: run 1 h of log follow + busy exec + a churning table and watch the webview process-tree memory (tauri#12724). If it grows, batch harder (logs 100 → 150–250 ms when rate is high, size-coalesce exec frames) — fewer, larger messages. (A3)
11. **Pause when hidden/idle** — `src-tauri/src/state.rs`, stream registry, `src/ipc`: on `visibilitychange`/window hide and for folded panes, pause delivery in Rust and resume with a diff; keep watchers warm ~60 s after the last subscriber so back-navigation is instant from cache. (A1)
12. **Relist as diff** — `src-tauri/src/table.rs`: on 410/reconnect, diff the new list against the last sent state and emit a delta rather than a fresh `snapshot`, so row identity, cursor and scroll survive reconnects. (A1)
13. **Key engine hardening** — `src/keys`, `src/actions/keymap-data.ts`: validator rejects (a) a prefix chord that is also a complete binding in an overlapping scope, (b) `Ctrl+Alt+<char>` defaults; keydown-only; reset pending chord on blur; single capture-phase dispatcher; add a key-trace debug toggle and a pending-chord indicator. (A2, B6)
14. **Browser defaults off** — `src-tauri` builder/capabilities: disable WebView2 accelerators (reload `Ctrl+R`/`F5`, find, print, zoom hotkeys), default context menu, and smart punctuation/autocorrect on inputs. `Ctrl+R` is kns "refresh" — the webview must never reload. (A3, B6)
15. **Terminal/editor pass-through** — shell and YAML views: xterm `attachCustomKeyEventHandler` and CodeMirror `Prec.highest` keymap yield only leader, pane-focus and palette chords to the dispatcher; everything else stays in the widget. Add `@xterm/addon-webgl` with `onContextLoss` → DOM fallback. (B4, B6)
16. **Logs view** — `src/views` logs, `src-tauri/src/logs.rs`: fixed-capacity ring (no `shift`), ANSI parsed once at ingest, append once per frame, manual stick-to-bottom (no reliance on `overflow-anchor`), eviction compensation when paused, chunked search with a `scheduler.yield` fallback. If JS heap is an issue, keep the buffer in Rust and pull windows (JET Pilot). (B4)
17. **Focus restore rule** — `src/panes`, `src/ui` Dialog, `src/palette`: restore focus by pane id after overlays; if the target is gone or hidden, focus the active pane root; `inert` behind dialogs. Add a test: palette-jump then key press still works. (A1)
18. **Windows stack / command hygiene** — `src-tauri/src/lib.rs` commands: test that the futures of `subscribe_table`, `stream_logs`, `exec_start`, `connect` are small (box large inner futures); no blocking work or subprocess waits inside commands at startup. (A1)
19. **React Compiler + Activity** — build config, `src/panes`: adopt the compiler with `"use no memo"` on virtualizer components; use `<Activity>` (available, React 19.3.1 installed) for folded panes only after stream/xterm/CodeMirror ownership lives outside effects. (B2)
20. **macOS blind spots** — `tauri.conf.json` (`minimumSystemVersion`), CSS, perf HUD: pick a floor (Safari 18 for `content-visibility`), feature-detect scheduler/LoAF/keyboard-map APIs, do not force `-webkit-font-smoothing` untested, treat the DOM xterm renderer as the mac baseline, and get one hands-on WKWebView test session before any release claim (JET Pilot's WKWebView-only freeze). (A3, B5)

Also worth doing, lower impact: palette ranking à la Raycast with frecency; layout files with ratios + placeholder panes; numbered pane jump with the number in the pane header; mock-backend storm mode.

## D. Things to measure

Targets are ours unless a source is given; machine = the owner's Windows box, release build.

| Metric | How | Target |
|---|---|---|
| Key handler cost, cursor move in a 10k-row table | dispatcher entry → end of synchronous commit (layout effect) | p50 ≤ 4 ms, p95 ≤ 8 ms |
| Frames to paint, cursor move | rAF callbacks between keydown and the frame showing the change; Event Timing duration as cross-check (8 ms resolution) | 1 frame at p99; Event Timing duration never > 50 ms (RAIL input budget) |
| Typing in filter with 10k rows | same two numbers for the input echo; mark for filtered rows painted | echo: handler ≤ 4 ms, 1 frame; filtered rows ≤ 100 ms (RAIL) |
| Palette open → first frame; keystroke → results | same | ≤ 50 ms (Superhuman target) |
| View swap from cache (Esc/back, pane open) | action → painted | ≤ 50 ms; first data for an uncached view ≤ 100 ms after the snapshot arrives |
| Frame time during divider drag (2 tables + logs + shell) | rAF delta histogram | p95 ≤ 16.7 ms; 0 frames > 33 ms; 0 React commits |
| Frame time while scrolling a 10k-row table under 100 deltas/s | rAF histogram | p95 ≤ 16.7 ms |
| Long animation frames in steady state | `long-animation-frame` observer (WebView2) | 0 entries (> 50 ms) per 10 min idle-with-watch |
| Delta batch apply + publish | `performance.measure` in the table store | ≤ 4 ms per batch at 500 changed rows |
| Snapshot 10k rows: Rust send → rows painted | Rust stamp + UI stamp | ≤ 150 ms total; IPC part ≤ 50 ms on WebView2 |
| Exec echo latency (key → glyph) on local cluster | marks around `exec_write` and first `Raw` frame render | ≤ 30 ms excluding network RTT |
| Terminal throughput (`yes`/`cat` big file) | bytes/s rendered, UI stays responsive | ≥ 5 MB/s (xterm's lower parser bound) with key latency still ≤ 50 ms |
| Log follow at 5k lines/s | rAF histogram + heap | p95 frame ≤ 16.7 ms; heap flat after ring is full |
| Cold start: process start → window shown (painted shell) | Rust `Instant` at `main` → `show()` | ≤ 400 ms warm WebView2; ≤ 1 s cold; no white frame |
| Start → first table rows (cluster reachable) | Rust + UI marks | ≤ 1 s |
| Entry JS + CSS before first paint | build output size check in CI | JS ≤ 250 KB gzip; CSS ≤ 30 KB with no inline fonts |
| Idle memory, one pods table | sum of WebView2 process tree + app exe | record baseline; alert on +20% regressions (expect a few hundred MB tree — WebView2 ≈ Electron per tauri#5889) |
| Memory after 1 h soak (logs + exec + churning table) | same | growth ≤ 50 MB over baseline; otherwise act on rec. 10 |
| Idle CPU with 2 live watches, no changes | Task Manager / `Get-Counter` | < 1% average; 0 rAF callbacks scheduled when nothing is dirty |
| IPC message rate | counter in Rust per stream | ≤ 10/s per table, ≤ 10/s per log view, ≤ 60/s per terminal |
| Command future sizes | Rust unit test with `size_of_val` | each < 16 KB (JET Pilot crashed at 362 KB × wrappers) |

Automated checks to add: Playwright-over-CDP smoke on Windows (cursor-move latency, drag frame histogram, LoAF count), mock-backend storm bench in Chrome, bundle-size budget, future-size test.
