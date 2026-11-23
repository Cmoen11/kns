# kns frontend: extension contract

How features plug into the design system, the input engine and persistence. Spec: `docs/ux.md`.
Everything here is exported from `src/actions`, `src/keys`, `src/store/*`, `src/ui`, `src/types`. Feature code imports the app-level API (§9-§15) from `src/foundation.ts`.

Rules that are enforced by this layer:

- No component hardcodes a key or adds a `keydown` listener for shortcuts. There is one window listener (`installKeys`, called in `main.tsx`). A shortcut is an **action** in the registry.
- Components use only `--k-*` tokens (`src/styles/tokens.css`). No hex, no raw palette (`--c-*`) variables.
- An action that has no handler is `built: false`: hidden from hints, palette, help and menus, and its key is unbound.
- Cluster text is untrusted: render it as text, never as HTML.

## 1. Actions

The full default keymap of ux.md §5.4 is data in `src/actions/keymap-data.ts`. Every id exists already; a feature makes it real by registering a handler.

```ts
// src/table/actions.ts  (small, imported eagerly by src/table/index.ts)
import { registerActions } from "../actions";

registerActions({
  "res.describe": {
    run: (ctx) => openDescribe({ beside: ctx.newPane }),     // ctx.newPane: 'right' | 'down' | null
    enabled: () => hasCursorRow() || "no row selected",       // false / string = disabled + reason
  },
  "mark.clear": { when: () => marks.size > 0, run: clearMarks }, // when=false: key falls through
  "namespace.favN": (ctx) => switchToSlot(ctx.digit!),       // N-families: one id, ctx.digit
  "res.yaml": async (ctx) => (await import("../views/doc")).openYaml(ctx),  // heavy view: lazy inside run
});
```

- **Register at module level in a small eager file.** Keys must work before a lazy chunk loads; do the `import()` inside `run`.
- `registerActions` throws on an unknown id (ids are the `ActionId` union) and on alias ids. Re-registering replaces the handler (HMR/StrictMode safe). It returns an unregister function.
- `when(ctx)` = applicability. False means "absent": not in hints, and the key goes to the next action bound to it. This is how the Esc ladder (§4.2) works: `search.close`, `select.clear`, `mark.clear`, `filter.clear`, `nav.back` all bind `Esc`.
- `enabled(ctx)` = permission/state. False or a reason string keeps it visible but disabled; the key is consumed and the reason is shown (RBAC, "no row").
- `write: true` actions are disabled automatically in read-only mode.
- `ActionContext`: `{ id, source, newPane, chord, digit, args, repeat, event }`. `args` are the words after a `:` command.
- Auto-repeat reaches only actions declared with `repeat: true` in the table.
- Call `engine.invalidate()` when state read by `when`/`enabled` changes and the hint row should refresh.

Run an action from code, the palette, a menu or a click. `engine.run` checks `built`, `when`, `enabled` and read-only, but **not** the scope: list what is runnable with `engine.available()` / `useAvailableActions()` and only run those.

```ts
import { engine } from "../keys";
engine.run("res.describe", { source: "palette", newPane: "right" });
engine.run("ui.zoom", { source: "command", args: ["125"] });   // ":ui 125"
```

`ActionDef` (registry entry) = spec `Action` + `label`, `group`, `command`, `scopes`, `repeat`, `alias`, `order`. `registry.list()` gives all of them (palette, help, `:` command lookup via `def.command`).

Adding a new action: add a row in `keymap-data.ts` (`a(id, scopes, keys, label, opts)`), then run `pnpm test`. The collision test fails if the key collides inside a scope segment.

## 2. Scopes

A binding is live when one of the action's scopes is in the active **chain** (most specific first). The chain is: pushed layers (top first), then the focused pane's base scopes, then `global`.

The focused pane sets the base chain, and the foundation does it (`src/panes/scope-sync.ts`, synchronously on every focus and view change). **Features never call `engine.setBaseScopes`** and never build a chain by hand. The chain is `viewScopes(info)` of the focused view:

```ts
// table pods:    viewScopes({ kind: "table", table: { resource: "pods", namespaced: true } })
// doc in edit:   viewScopes({ kind: "doc", format: "yaml", mode: "edit" })  -> ["edit"], mode EDIT
// live shell:    viewScopes({ kind: "shell", live: true })                  -> ["term"], mode TERM
```

What is not in the `ViewState` (a shell is live, the cursor row is Flux-managed) is added with `setPaneScope` (§10).

Overlays, inputs and sticky modes push a layer and pop it when they close:

```tsx
import { LAYERS } from "../actions";
import { useScopeLayer, engine } from "../keys";

function Palette() { useScopeLayer(LAYERS.palette); ... }        // component lifetime
const pop = engine.pushScope(LAYERS.resize); /* ... */ pop();     // imperative
```

| Layer | `below` | Meaning |
|---|---|---|
| `filterInput`, `searchInput`, `command`, `palette`, `picker*`, `help`, `columns` | `chords` | Only Ctrl/Alt/Cmd chords and F-keys reach the panes below (§5.2) |
| `dialog`, `dialogDiscard`, `menu` | `none` | Nothing below is reachable |
| `move`, `resize`, `copy` | `none` + `capture` | Sticky modes: take every key even while focus is in a terminal or editor; unbound keys are swallowed |
| `keymapEditor` | `all` | Adds keys on top |
| `vim` | `chords+esc` | Vim keys in a doc editor: as `chords`, and `Esc` also reaches the pane when `vim.escape` declines it |
| `sidebar`, `activity`, vim's command line | `global-chords` | As `chords`, but only bindings of the `global` scope: no chord of the pane underneath (`Ctrl+Backspace` delete, `Ctrl+S` review) acts on something the user is not looking at |

Input rules the engine applies by itself (§5.2, §5.3):

- Focus in an `<input>`, `<textarea>` or contenteditable: typed characters and text-editing chords (`Ctrl/⌘+A/C/X/V/Z`, word-delete, word-move) always go to the element. Arrows/Home/End/Backspace/Delete can only be claimed by the **top pushed layer** (e.g. `list.down` in the palette, `filter.chipRemove` when its `when` holds). So every text input needs its own layer.
- A view that uses single keys must not keep focus inside a contenteditable, or its keys are typed instead of run. The read-only doc view and REVIEW need CodeMirror `EditorView.editable.of(false)` (not only `readOnly`); only EDIT is editable.
- TERM (`mode: "TERM"`): everything goes to xterm except the §5.3 list (leader, `Ctrl+Shift+letter`, `Ctrl+1..9`, `Alt+arrows`, `Alt+h/j/k/l`, ... on Windows; every `⌘` chord on macOS) and the `term` scope's own chords.
- Leader (`pane.leader`, `Ctrl+.` / `⌘.`): sequences `leader x`. No timeout, Ctrl/⌘ ignored on the next key, the next key is always consumed, `Esc` cancels. Other sequences time out after 1s.
- `+` prefix: `registerActions(newPanePrefixHandlers())` once split works. The next action must have `opens: 'view'` and gets `ctx.newPane`; anything else cancels with a message.
- Setting "single keys off" disables character keys everywhere.

**Vim keys** (setting `vim`, default off; `:vim on|off`, action `app.vim`; `src/views/doc/vim.ts`, `vim-state.ts`). `@replit/codemirror-vim` is its own lazy chunk, fetched only while the setting is on, and attached through the `vimConf` compartment, so the toggle applies to open editors at once. It covers describe, YAML, JSON, secrets and EDIT; not the REVIEW diff. The routing rule:

- While a vim editor holds DOM focus (with vim the read-only views focus the editor too) the controller keeps `LAYERS.vim` pushed. Plain and named keys (`e`, `/`, `:`, Enter, Tab, arrows, Backspace) are vim's; Ctrl/Alt/⌘ chords, F-keys and the leader stay with the app (`Alt+h/j/k/l`, `Ctrl+S`, `Ctrl+K`), except the chords of `vim.keys`. Hints, help and menus show only what is live; the single-key actions stay runnable from the palette.
- `Esc` is `vim.escape` while vim is in insert/replace/visual mode, has a half-typed command or shows a search highlight (`vimBusy`), and **in a dirty EDIT** (`vimOwnsEscape` in `vim-state.ts`): there an idle Esc only closes the app search or extra cursors, else flashes `unsaved changes · :w review · :q leave (asks) · :q! discard`; it never opens the discard dialog (`Esc Esc :w Enter` must not discard). From an idle normal mode otherwise Esc is the pane's, as without vim: back in a read-only view, leave in a **clean** EDIT. "Dirty" is the controller's own flag (`bufDirty`, set in the editor's update listener), not the UI store's copy, which a remount clears.
- `vim.keys` hands vim the Ctrl chords the webview or an app binding would keep: `Ctrl+R`, `Ctrl+D`, `Ctrl+U`, `Ctrl+O`, `Ctrl+W` on Windows, plus `Ctrl+B`, `Ctrl+F` on macOS (rebindable). On Windows the app keeps its own (`vimTakesChord`): `Ctrl+B` is the sidebar and `Ctrl+F` the search in every vim mode (`editor.find` / the doc's `filter.open` are live in a vim editor; vim pages with `Ctrl+U` / `Ctrl+D`), and `Ctrl+W` closes the pane except in insert / replace mode, where it deletes a word. On macOS the app's shortcuts are `⌘` chords, so every chord of `vim.keys` is vim's. Other vim Ctrl chords that the app binds or blocks (`Ctrl+E`, `Ctrl+V` ...) stay with the app.
- Ex commands: `:w` / `:wq` / `:x` review, `:q` / `:q!` leave, `:e` edit, `:vim on|off` (the setting, so vim can be turned off from inside a vim editor).
- vim's `:` and `/` command line is a text input with a strict `global-chords` layer of its own (badge COMMAND): the pane's chords do not act on the buffer behind it. Global chords still do (`Ctrl+W` closes the pane, `Ctrl+B` toggles the sidebar).
- The discard dialog is modal for vim too: while it is open the editor takes no focus (a click on its scrim lands on the pane) and no vim layer is pushed.
- Ex commands: `:w` = `editor.review` (then Enter applies), `:wq` / `:x` the same, `:q` = leave the edit (asks when dirty) or back / close pane in a read-only view, `:q!` = discard, `:e` = `res.edit`. `y` also writes the system clipboard.
- The bottom-row badge shows INSERT / REPLACE / VISUAL / V-LINE / V-BLOCK, else the pane's own NORMAL / EDIT; the pane header shows `Vim` and the half-typed command.

## 3. Reading bindings and state

```tsx
import { Keys, KeyChip, Hint } from "../ui";
import { useBindings, useHints, useAvailableActions, useKeyState, engine } from "../keys";

<Keys action="res.describe" />            // chips for the live binding; nothing if unbound
<Hint action="filter.open" label="filter" />
const bindings = useBindings("pane.splitRight");   // [["Ctrl+.", "r"]], leader expanded, alias rows included
const hints = useHints();                 // AvailableAction[] for the bottom row, in hint order
const all = useAvailableActions();        // built + applicable now, with enabled/reason (palette, ?, menu)
const { mode, pending, leader, pendingSince, prefix, scopes } = useKeyState();  // badge, which-key
engine.continuations();                   // after the leader: [{ chord, action }] for the which-key panel
engine.on((e) => ...);                    // run | blocked | message | error
```

Keymap editor: `keymap.bindings(id, platform)`, `setKeymapOverride(id, { win: [["F2"]] })` (`[]` unbinds, `undefined` resets), `conflictsFor(keymap, registry, id, binding, platform)`, `isAssignable(chord, platform)`, `isRebindable(def)`, `canonicalChord(str)`, `normalizeEvent(e, platform)` to capture a key. Layering is defaults < k9s preset (`settings.k9sMode`) < user overrides.

Chord strings: `[Ctrl+][Alt+][Shift+][Cmd+]key`. Bare letters are case-sensitive (`g`, `G`), symbols never carry Shift (`?`, `Ctrl+.`), named keys: `Enter Esc Tab Space Backspace Delete Insert Up Down Left Right Home End PgUp PgDn Menu F1..F12`. Matching is by produced character (§5.1); AltGr is text.

## 4. Persistence

One persisted store = one backend key = one JSON file `{ schema, data }`. State must be plain JSON (keep functions outside the store).

```ts
import { persistedStore, PERSIST_KEYS, type PersistedSlice } from "../store/persist";
import { useStore } from "zustand";

type S = PersistedSlice<"favorites" | "layouts" | "nsSlots">;
export const favStore = persistedStore<S>({
  key: PERSIST_KEYS.favorites,
  version: 1,
  defaults: () => ({ favorites: [], layouts: [], nsSlots: {} }),
  sanitize: (data, d) => ({ ...d, ...validate(data) }),   // validate field by field; throw to reject
});
export const useFavorites = <T,>(sel: (s: S) => T) => useStore(favStore, sel);
favStore.setState((s) => ({ favorites: [...s.favorites, fav] }));   // debounced save (500ms)
await favStore.hydrated;                                             // first load done
```

- No save happens before the first load; `setState` calls made earlier are replayed on top of the loaded state.
- Bad JSON, unknown schema or a throwing `sanitize` gives defaults and keeps the old value under `<key>.bak`.
- `flushPersisted()` runs on `pagehide`. Keys: `settings`, `keymap`, `workspaces`, `favorites`, `columns` (`PERSIST_KEYS`).

Settings: `useSettings((s) => s.rowHeight)`, `getSettings()`, `setSettings({ mode: "lys" })`, `setContextFlags(ctx, { protected: true })`, `contextFlags(ctx)`, `stepZoom(1 | -1 | 0)`. Call `setActiveContext(name)` on connect / context switch so read-only mode follows the context.

## 5. Tokens and styles

- `<html data-tema data-modus data-mono data-rows>` is set by `src/store/appearance.ts` (before first paint via `src/boot.ts`). Mode `system` follows `prefers-color-scheme` live.
- Colours, type sizes, spacing, sizes: `--k-*` only (`tokens.css` = ux.md §9.2 plus `--k-type-mono`, `--k-h-control`, `--k-ring`, `--k-hair`). Spacing is `--k-luft-*`.
- Text styles are classes from `base.css` (ux.md §10): `t-cell t-row t-body t-palette-input t-ui t-hint t-ui-multi t-crumb t-input t-label t-colhead t-button t-dialog-title t-title t-mono`. Helpers: `truncate num sr-only selectable`.
- Row-state contract (tokens.css): `.row[data-marked]`, `.row[data-focus]`, `.cell[data-delta]`, `.line[data-match-current]`, `.status-word`, `.muted`, `.glyph`, `.level`.
- Row height: `var(--k-h-row)` (20 or 28). Mono font: `var(--k-font-mono)`.
- No animations or transitions (§16). Focus ring is global (`:focus-visible`, 2px inset).
- Scrim-relative sizes: inside a fixed overlay use `%`, not `vw`/`vh` (viewport units overshoot under CSS zoom).
- Zoom: `applyZoom` uses the Tauri webview zoom when allowed, else CSS `zoom` on `<html>`. When mixing `getBoundingClientRect`/pointer coordinates with CSS lengths, divide by `zoomFactor()`.

## 6. Primitives (`src/ui`)

| Export | Use |
|---|---|
| `Button` | `variant` primary/secondary/tertiary, `action` shows that action's key chip |
| `BarInput`, `Field`, `Literal`, `Checkbox`, `RadioGroup` | 20px bar input (label, `chip`, `error`), 32px dialog field (`label` is a node; wrap text the user must type in `<Literal>`: mono, as written), checkbox (a square that fills) and radio |
| `Dialog`, `Facts` | 400px modal: focus trap, focus return, `dialog.*` keys, `confirmDisabled`. The body scrolls, title and buttons stay. Keyboard focus on a prefilled text field selects it (`focusField`): no `onFocus` select of your own |
| `tip`, `actionTip`, `clipTip`, `TooltipHost` | the one themed tooltip (§17): attributes only, no native `title` |
| `confirm(opts)`, `objectFacts`, `DialogHost` | confirm tiers 1–3 incl. type-to-confirm and delete options |
| `toast`, `toasts`, `ToastHost`, `useErrorOverflow`, `useMessageLog` | toasts, undo, sticky errors, message log |
| `KeyChip`, `Keys`, `Hint` | key chips from the live keymap |
| `FilterChip`, `Tabs`, `EmptyState` | filter chip, fold/zoom tab strip, empty state |
| `Glyph`, `GlyphSprite`, `Nodelinje` | status glyphs (§9.5), watch/empty-state nodelinje |
| `announce`, `LiveRegion` | the one aria-live region |
| `ActionButton`, `ActionHint`, `Toolbar`, `Icon`, `openMenu`, `runAction`, `useActionState` | pointer controls bound to action ids (§17) |

```ts
const r = await confirm({
  tier: 2, title: "Delete deployment", typeToConfirm: "web", delete: true,
  facts: objectFacts({ kind: "Deployment", name: "web", namespace: "shop", context: "default" }),
});
if (r) await backend.deleteObject(ref, { propagation: r.propagation, gracePeriodSeconds: r.force ? 0 : undefined });

toast({ kind: "ok", text: "Scaled web to 3", undo: () => backend.scale(ref, 2) });  // 10s, owns Ctrl/⌘+Z
toasts.error("Forbidden: pods is read-only");                                       // stays until Ctrl/⌘+Shift+X
```

`App.tsx` mounts `GlyphSprite`, `DialogHost`, `ToastHost`, `OverlayHost`, `LiveRegion` and, last, `TooltipHost` around the frame (titlebar, pane tree, bottom row).

## 7. Built by this layer

`dialog.confirm/cancel/nextField/previousField/radioUp/radioDown/toggle`, `toast.dismiss`, `undo.lastAction`, `ui.zoomIn/zoomOut/zoomReset`, `ui.zoom`, `app.theme`, `app.mode`, `app.density`, `app.readOnly`, `app.killSwitch`, `hints.toggle`.

Built by the shell and pane layer (F2, `src/panes/actions.ts`): `pane.newPrefixRight/Down`, `open.newPaneRight/Down`, `pane.splitRight/Down`, `pane.focusLeft/Down/Up/Right`, `pane.next`, `pane.previous`, `pane.last`, `pane.focusN`, `pane.moveLeft/Down/Up/Right`, `pane.moveMode`, `move.target*`, `move.insert*`, `move.swap`, `move.cancel`, `pane.resizeLeft/Down/Up/Right`, `pane.resizeMode`, `resize.step*`, `resize.fine*`, `resize.done`, `pane.zoom`, `pane.equalize`, `pane.equalizeAll`, `pane.flipSplit`, `pane.followToggle`, `pane.close`, `pane.closeOthers`, `pane.reopenClosed`, `history.back/forward/last`, `nav.back`, `nav.crumbUp`, `conn.reconnect`, `window.fullscreen`, and inside Tauri only `window.close` and `app.quit`.

Everything else is `built: false` until a feature registers it. Who owns what is in §9.

## 8. Deviations from the ux.md §5.4 table

- **Split ids.** Compressed rows got one id per direction (`pane.focusLeft`, `move.targetLeft`, `resize.stepLeft`/`fineLeft`, `columns.moveDown`/`reorderUp`, `settings.moveDown`/`cyclePrev`, `copy.down`/`top`/`search`, `list.down`/`up`, `filter.chipFocusLeft`, `picker.moveSlotUp`, `dialog.radioUp`, `terminal.scrollPageUp`, `editor.addCursorAbove` ...). N-families stay one id with `ctx.digit`.
- **Alias rows** add a key in a narrower scope to another action: `pane.nextTab`/`pane.previousTab` (`Tab` only in NORMAL; `F6` is global), `nav.scrollLeftH`/`nav.scrollRightL` (`h`/`l` only on kinds without logs), `logs.fullscreen` (`f` = `pane.zoom`). Register the target only.
- **Added ids:** `filter.apply`/`filter.cancel` (Enter/Esc in filter and search inputs), `search.close`/`select.clear` (Esc ladder steps 5–6), `ui.zoom` (`:ui`), `keymap.resetAll` (`:keys reset`), `columns.close` (`Esc`/`Enter` in the column menu), `pane.newPrefixDown` lives in the `newpane` scope with key `+` (shown as `+` while NEW → is active).
- **Added keys and scopes:** `doc.copy` also binds `Ctrl/⌘+C` (§13.1), `copy.name` also covers `containers` (§12.5), `terminal.copy` also covers `term.placeholder` (an ended shell's scrollback).
- **The column menu layer** is `columns` only (no `olist`), with `below: chords`, so `Ctrl/⌘+Shift+M` toggles it shut.
- **Not in the keymap:** keys for `home.open` and `messages.open` (`:home`, `:errors` only), keyboard scrolling in REVIEW. (Opening a forward in the browser is `pf.openBrowser`, `o` in the port-forwards view; Rust opens the URL.)
- **`nav.bottom` is not bound in logs**; `G`/`End` there is `logs.resumeFollow` (same key in the spec).
- **`context.protect`** is command-only; `Ctrl/⌘+T` in the context picker is `picker.toggleProtected`.
- **`filter.open`** also covers the `list` scope (home, aliases); `open.newPaneRight/Down` also cover `containers` and `list`.
- **Port-forwards view** uses the `list` scope, not `table`.
- **TERM keeps** `Ctrl+Insert`, `Shift+Insert` and `Shift+F6` in addition to the §5.3 list.
- **k9s-mode on Windows:** `aliases.show` becomes `Ctrl+A` only, so `mark.all` can move to `Ctrl+Shift+A` as §5.7 says.
- Intentional shared keys are listed in `INTENTIONAL_SHARED` (Esc ladder; `c` cordon over copy-name on nodes).

## 9. Feature directories

Each feature owns one directory and edits nothing outside it. Its `index.ts` exports `register()`, which `src/features.ts` calls once before the first render. `register()` registers view kinds, overlays and shell items, and imports the feature's own small eager actions file. Heavy code (CodeMirror, xterm, the table) is loaded lazily by the view registry or inside an action's `run`.

Import everything from **`src/foundation.ts`**. It re-exports the APIs below plus the F1 ones (`registerActions`, `engine`, `toast`, `confirm`, `backend`, ...).

| Directory | View kinds | Actions it registers |
|---|---|---|
| `src/table` | `table`, `containers` | `nav.down/up/top/bottom/pageUp/pageDown/scrollLeft/scrollRight`, `nav.open`, `filter.*`, `view.refresh/wide/columns`, `columns.*`, `column.*`, `sort.*`, `mark.*`, `copy.name/namespace/cell`, `namespace.all/use`, and `res.logs`/`res.logsPrevious` (they only open the logs view) |
| `src/palette` | none (overlays) | `palette.open`, `command.open`, `palette.complete`, `list.*`, `context.pick`, `context.protect`, `namespace.pick`, `namespace.pickAllPanes`, `namespace.favN` (the slots live in its store), `fav.*`, `picker.*`, `menu.open`; also the which-key panel and the `:` command bar |
| `src/views/doc` | `doc` | `res.describe`, `res.yaml`, `res.edit`, `secret.decode` (they read the selection store, or `view.pod` in a containers view), `doc.*`, `secret.reveal*`, `search.*`, `select.*`, `editor.*`, `review.*`, `app.vim`, `vim.*` |
| `src/views/logs` | `logs` | `logs.*` (and `nav.*`, `filter.open/apply/cancel/cycleMode`, `search.*`, `select.*`, `view.refresh` in the logs view) |
| `src/views/shell` | `shell`, `attach`, `portforwards` | `pod.shell`, `pod.attach`, `terminal.*`, `copy.down/up/top/bottom/search/select/yank/leave`, `pf.*` |
| `src/actions/ops` | none | `res.delete`, `pod.kill`, `workload.*`, `rs.rollback`, `cronjob.*`, `node.*`, `pod.transfer`, `pod.sanitize`, `flux.*`, `res.usedBy`, `res.owner`, `pod.node`, `deploy.replicaSets`, `res.warp` |
| `src/views/tools` | `home`, `settings`, `aliases`, `messages` (+ the help overlay) | `home.open`, `settings.open`, `aliases.show`, `messages.open`, `help.overlay`, `settings.*`, `keymap.*` |
| `src/status` | none | `health.faults` (`:faults [ns]`); namespace health store + `subscribeNsHealth`, sidebar badges (`NsBadge`), titlebar summary, home "Needs attention", html hooks of the status-colour settings |
| `src/sidepanels` | none (two side panels, §14.1) | `sidebar.toggle/focus/filter`, `activity.toggle/focus/stop/copyAddress/openBrowser/stopAll/clearFinished`, `side.*` |
| `src/hub` | `hub` | `hub.open`, `hub.detail`, `hub.help` (catalog `src/hub/catalog.ts`, `registerTool`, `registerToolStatus`) |
| `src/diag` | `why`, `timeline`, `traps`, `reach`, `relations` | `res.why`, `why.*`, `res.timeline`, `trap.*`, `res.reach`, `res.relations`, `relations.*` (and the Rollouts activity group) |
| `src/diff` | `diff` | `res.diff`, `diff.*`, `doc.fieldOwners`, `doc.driftOnly` (gutter in `src/views/doc/ownership.ts`) |
| `src/dev` | `env`, `devsets` | `dev.*`, `env.*`, `picker.dev*` |
| `src/agents` | `agents` | `mcp.command`, `agents.*` |

**Shared ids.** The registry holds one handler per action id, and `registerActions` replaces. Ids that several features implement in their own views (`nav.down/up/top/bottom/pageUp/pageDown`, `nav.open`, `filter.open/apply/cancel/cycleMode/clear`, `search.*`, `select.*`, `view.refresh`, `view.saveToFile`) must be registered per view kind:

```ts
registerViewActions(["table", "containers"], {
  "nav.down": { run: () => moveCursor(1) },
  "nav.open": { run: (ctx) => drill(ctx.newPane), enabled: () => hasRow() || "no row selected" },
});
```

One dispatcher per id runs the handler of the focused pane's view kind, and is absent (`when` false) for kinds that registered none. Never mix `registerActions` and `registerViewActions` for the same id. Ids with a single owner (the table above) use `registerActions`.

`src/features.test.ts` enforces this: it registers every feature and fails when an id reaches the registry twice, when a view kind has no view, when two overlays share a name, or when the set of unbuilt actions differs from the list in §16. Update that list when you build or drop an action.

**One implementation per feature.** The `/` filter bar is the table's (`src/table/FilterBar.tsx`) and the `?` overlay is `src/views/tools/HelpOverlay.tsx`; the palette's duplicates were removed.

## 10. Views

```ts
// src/views/doc/index.ts
import { registerView, registerPaneGuard } from "../../foundation";
import "./actions"; // small, eager: registerActions({ "res.describe": ... })

export function register(): void {
  registerView({
    kinds: ["doc"],
    component: () => import("./DocView"),                 // default export: (props: ViewProps<"doc">) => JSX
    crumbs: (v) => [...],                                  // optional; defaultCrumbs(v) is the fallback
    scope: (v) => ({ format: v.format, mode: v.mode }),    // optional extra ViewScopeInfo
  });
  registerPaneGuard((pane, view) => (view.kind === "doc" && isDirty(pane) ? { label: "unsaved edit", onClose: "kept" } : null));
}
```

`ViewProps<K> = { pane, view, focused, visible }`.

- `view` is the pane's current history entry. It is a new object whenever the entry is edited (`replaceView`, `patchView`, a follow retarget), so react to its fields.
- The component is **remounted on every history move** (push, back, forward, last) and kept across edits of the entry. Local state is per history entry.
- `visible` is false while the pane is folded away or zoomed out. The pane stays mounted (a shell keeps running); pause rendering work and pass `live: visible` to `useTable`.
- A view that wants DOM focus (terminal, editor) focuses its own element in an effect on `focused`; otherwise the pane element takes focus.
- A crashing view shows its error inside the pane only.

Key scopes are set by the foundation from the focused pane's view (`src/panes/scope-sync.ts`); never call `engine.setBaseScopes`. Tables get `namespaced`, `allNamespaces`, `scalable` and `flux` from discovery. For live facts that are not in the `ViewState`:

```ts
setPaneScope(pane, { live: true });                    // shell connected -> TERM
setPaneScope(pane, { table: { fluxManaged: true } });  // cursor row is Flux-managed
setPaneScope(pane, null);                              // on unmount
```

Header slots (portals into this pane's header, §11.1) and the watch glyph:

```tsx
<PaneSlot name="chips"><FilterChip mode="RE" value="web" /></PaneSlot>
<PaneSlot name="labels">WRAP</PaneSlot>
<PaneSlot name="count">{shown}/{total}</PaneSlot>
setPaneStatus(pane, { watch: "live" });   // views without useTable; useTable({ pane }) does it itself
```

A `BarInput` (`.k-bar`) rendered into the `chips` slot takes the header row while it is mounted: `src/panes/panes.css` hides the crumbs, labels and link and never collapses the slot, however narrow the pane is (a hidden input cannot take focus). Filter and search bars need no CSS of their own for this. The palette's `:` bar is not inside a view's tree, so it portals into `.pane[data-focused] > .pane-header` (`src/palette/header.ts`).

Follow links from a `containers` pane: its selection carries the pod's gvr with the container's name, so a following document keeps showing the pod and a following logs pane moves to that container (`src/store/follow.ts`).

## 11. Opening views, history, panes

```ts
import { openView, patchView, replaceView, goBack, tableView, focusedPane, paneView, setNamespace } from "../foundation";

registerActions({
  "res.describe": {
    enabled: () => selectionTargets(focusedPane()!).length > 0 || "no row selected",
    run: (ctx) => {
      const ref = getSelection(focusedPane()!).focused!;
      openView({ kind: "doc", ref, format: "describe", mode: "view", managedFields: false, wrap: false }, { newPane: ctx.newPane });
    },
  },
});
```

- `openView(view, { pane?, newPane?, follow? })` pushes on the pane's history (default: the focused pane). With `newPane` it applies the §4.4 target rule: a following pane of the same kind (and doc format) linked to the source is retargeted, a pinned pane is never reused, otherwise the source is split; at 12 panes it refuses with a bottom-row message. **Always pass `ctx.newPane` through**: that is all the `+` prefix, `Ctrl/⌘+Enter` and `Alt+Enter` need. Describe and YAML opened beside follow the source; everything else is pinned. It returns the pane id.
- A pane that holds a live session (per the pane guards) is never navigated in place: the view opens to its right (§4.6).
- `replaceView(pane, view | fn)` and `patchView(pane, "table", { wide: true })` edit the current entry without a history push (filter, sort, wrap, namespace). `setNamespace(ns, pane?)` / `setNamespaceAllPanes(ns)` do the §8.1 switch.
- `goBack()`, `goForward()`, `goLast()`, `canGoBack()`, `canGoForward()`.
- `tableView(gvr, namespace = "*", extra?)` builds a `TableView` with defaults.
- The table cursor is written into the entry (`cursorUid`, `cursorName`) by the foundation from the selection store when the pane navigates away and at exit. Do not persist it per keystroke.
- Reading: `focusedPane()`, `paneView(pane?)`, `paneState(pane)`, `paneOrder()`, `paneIndex(pane)`, `paneNamespace(pane?)`, `getWorkspace()`; hooks `useFocusedPane()`, `usePaneView(pane)`, `useWorkspace(select)` (return primitives or stable references).
- Pane operations for code that is not an action: `focusPane`, `splitPane("right" | "down", { view? })`, `closePane`, `closeOtherPanes`, `reopenPane`, `toggleZoom`, `toggleFollow`, `setWorkspace(ws)` (saved-layout recall), `liveSessions()`.

Pure logic (unit-tested, no DOM): `src/store/layout-tree.ts` (tree), `src/store/geometry.ts` (rects, fold, zoom, neighbours, divider moves), `src/store/workspace.ts` (every pane and history operation on a `Workspace`, `sanitizeWorkspace`).

## 12. Selection

A table-like view publishes its cursor row and marks. Actions, follow links and other panes read them.

```ts
setSelection(pane, { focused: { gvr, namespace, name, uid } });   // cursor moved
setSelection(pane, { marked: refs });                              // marks changed ([] clears)
setSelection(pane, null);                                          // on unmount

const targets = selectionTargets(focusedPane()!);   // marked rows, else the cursor row
const ref = toObjRef(targets[0], focusedContext()); // IPC ObjRef: the pane's context (§8.3), never the window's
const other = useSelection(sourcePane);             // live, any pane
```

Publish on cursor and mark changes only, never per data frame. Follow links (§4.5) are driven from here: 150ms after the source cursor moves, a following doc pane's `view.ref` changes (logs: `view.target`, after 500ms). The follower only has to react to its `view` prop.

## 13. Cluster and live tables

```ts
// a pane's kube context (ux.md §8.3): what a view or an action is about
const context = usePaneContext(pane);                  // in a view (re-renders when it changes)
paneContext(pane); focusedContext();                   // outside React; read once, before the first await
const hasMetrics = useConn(context, (c) => c.info?.hasMetrics ?? false);   // status, info, discovery of that context
openView(view, { context: "staging" });                // in place: the pane restarts there; with newPane: a new pane there
openInContext(view, ref.context, { pane, newPane });   // an object of maybe another context: in place or beside
resolveResource("deploy", context);                    // alias map of a context (default: the focused pane's)
resourceFor(gvr, context); kindOf(gvr, context); useResource(gvr, context);
const { names, synced, forbidden } = useNamespaces(context);  // one shared watch per context
windowContext(); useCluster((s) => s.contexts);         // the window's context: only the window chrome reads it
await switchContext("staging");                        // the window (§8.2), confirms live sessions
reconnect();
```

```tsx
const query = useMemo(() => ({ context, gvr: view.gvr, namespace: view.namespace === "*" ? undefined : view.namespace }), [...]);
const snap = useTable(query, { live: visible, pane });   // { columns, rows, state, synced, stale, version }
```

**Pane context rule.** Never read the window's context in a view or an action: `src/store/pane-context.test.ts` fails on `windowContext()`, `useCluster` selectors on `.context` and direct `clusterStore` reads outside its list of window files. A feature that cannot work in a pane of another context refuses there (`focusedIsForeign()`) instead of falling back to the window's.

- One backend subscription per unique query, shared by every pane that shows it, kept 2s after the last user (back is instant) and paused 30s after the last *visible* user (`stale: true`, rows kept).
- `snap` is the same object until a frame in which something changed; at most one update per animation frame, however many deltas arrived. `snap.rows` keeps a stable order (updates in place, new rows last) and unchanged rows keep their identity.
- Mount `useTable` once per view and index into `snap.rows` from the virtualizer. Never copy rows into React state.
- Cell-delta highlighting: `tables().subscribeDelta(tableKey(query), (d) => ...)` gives `{ reset, changed: Map<uid, previousRow | undefined>, deleted }` once per changed frame. `tables().rowByUid(key, uid)`, `tables().refresh(key)` (`view.refresh`).
- Show `syncing` while `!snap.synced`, never "no resources".

## 14. Window chrome

```ts
registerShellItem({ id: "pf", area: "status", order: 10, component: PfIndicator });   // bottom row, right
registerShellItem({ id: "layout", area: "titlebar", component: LayoutName });         // titlebar, right
registerOverlay("palette", () => import("./Palette"));     // component: ({ props, close }: OverlayProps)
showOverlay("palette", { prefix: ">" }); closeOverlay("palette"); isOverlayOpen();
registerOverlay("whichkey", () => import("./WhichKey"), { always: true });   // mounted permanently
flash("pane limit reached (12)", "warn");                  // bottom-row message, 4s
useBuilt("palette.open");                                   // hide a control until its action exists
```

- Status ids `metrics`, `flux` and `pf` drop in that order under 900px (§15); the titlebar id `layout` hides under 1100px.
- Area `titlebar-left` renders before the context name (the sidebar toggle). `registerShellItem` replaces an item with the same id; `unregisterShellItem(id)` removes another feature's item. `src/sidepanels` (registered after the shell feature) removes `pf` and registers the live count (`pf 2  sh 1  log 1  op 1`) as `live`, so there is one count, and no width rule hides it: under 760px, where the panel is an overlay, it is the only sign of what is live.
- An overlay pushes its own scope layer (`useScopeLayer(LAYERS.palette)`), traps focus if it needs to and calls `close()`.
- Which-key (§5.5): `const { pending, open, items } = useLeaderPanel()`; `open` turns true 250ms after the leader, `items` are `{ chord, keys, action }` for built actions only.
- Titlebar controls (context, namespace, palette trigger) call `context.pick`, `namespace.pick` and `palette.open`. They are plain text or absent until those actions are registered.
- Blocked keys and `+`-prefix messages show in the bottom row; action errors are toasts.
- Pane guards: `registerPaneGuard((pane, view) => LiveSession | null)` with `onClose: "ends"` (shell: close, close-others, context switch and quit ask first) or `"kept"` (dirty edit: closes, toast `Draft kept`).

### 14.1 Side panels (`src/sidepanels`)

`App.tsx` mounts `<SidePanel side="left" />` (context sidebar) and `<SidePanel side="right" />` (activity panel) beside `<PaneTree />`. They are flex siblings, so they push the pane area and the pane tree re-measures by itself. A closed panel renders nothing; the bodies are lazy chunks.

| Action | Keys (Windows; `Ctrl` is `⌘` on macOS) | |
|---|---|---|
| `sidebar.toggle` / `activity.toggle` | `Ctrl+B` or `Ctrl+Shift+B` / `Ctrl+J` or `Ctrl+Shift+J`, `:sidebar`, `:activity` | show / hide (k9s-mode on Windows: only `Ctrl+Shift+B`) |
| `sidebar.focus` / `activity.focus` | `Ctrl+Shift+E` or `leader b` / `Ctrl+Shift+Y` or `leader v` | open if needed and move focus in; the same key again goes back |
| `side.*` | `j`/`k`/arrows, `g`/`G`, `Enter`, `Tab`/`Shift+Tab` (section), `h`/`l` (fold), `<`/`>` (width), `Esc` | inside a panel |
| `sidebar.filter` | `/` | type-to-filter contexts, namespaces and favourites |
| `activity.*` | `x`/`Delete` stop, `c` copy (address of a forward, the line of a Recent entry), `o` open in browser, `X` stop all in the group (confirm), `C` clear Recent | on the cursor row; right-click opens the same as a menu |
| `health.nsFaults`, `sidebar.problemsFirst` | `!` faults view of the namespace row (a badge click does the same), `s` problems first | context sidebar |

- **Scope.** Layers `LAYERS.sidebar` / `LAYERS.activity` (scopes `side.ctx` / `side.activity` + `side`, `below: "global-chords"`, badge `SIDE`) are pushed on focusin and popped on focusout of the panel element, so the scope is live exactly while DOM focus is inside; a document `focusin` listener is the safety net for focus that left without a focusout. Under a panel only global chords are live, never the focused pane's (`Ctrl+Backspace`). Rows are not focusable (the cursor is state) and the row's stop button never takes focus. In the filter input Left/Right/Home/End move the caret (`side.collapse/expand/top/bottom` decline), and nothing folds while a filter is set. A chord that moves pane focus (`Alt+hjkl`, `F6`) takes the focus out of the panel; a stop that closes the focused pane does not (`runStop`).
- **Rows.** A body builds one flat `PanelRow[]` (`model.ts`: header rows plus items with `activate`, `stop`, `copy`, `open`, `stopAll`) and renders `<Rows side rows />`, which publishes the list to the store; the actions read the cursor row from there. `Enter` and a click run `activate` and hand focus back to the panes unless the row says `stay` or `activate` resolves `false` (a declined confirm, a blocked namespace). A row's age is `since` (a timestamp), rendered by a leaf that ticks by itself.
- **Context sidebar** calls what the pickers call: `switchContext` (with its live-session confirm), `setNamespace` + `noteNamespaceUsed`, `recallFavourite`, `recallLayout`.
- **Activity panel** reads `useForwards`, `useSessions` (`views/shell/state`), the workspace's logs panes, `usePaneStatuses`, `tables().health()` and the operations log. `src/sidepanels/activity.ts` runs from startup (event-driven, no timers) and keeps start times and the log-stream list; what starts, fails and ends (forwards, sessions, log panes) goes to the action log. **Recent** (section `recent`, order 120, replaces Finished) is the action log of the window's context (`src/store/actionlog.ts`, persisted under key `actionlog`, 100 entries per context, 20 contexts): features call `recordAction({ text, state, error?, namespace?, write?, target? })` (also from `src/foundation.ts`); the write gate (`report` in `actions/ops/write.ts`) records every confirmed cluster write, `views/doc` applies, `dev/flows`, `debug/flows` snippets (by id), agent proposals, and `src/status` context switches and fired traps. Targets are plain data (`object`, `logs`, `forward`, `devset`, `namespace`, `view`); Enter re-resolves them (`sidepanels/recent.ts`; an object opens its table with `cursorName`). Operations shows only writes in flight. Never pass secret values, manifests or command lines. An idle open panel does no periodic work: ages tick in their own leaf (one shared 1s timer, only changed text re-renders), the row list is rebuilt only when its inputs change, a 1s clock runs only while a log stream is sampled or a reconnect counts down, and forwards are polled (2s) only while there are forwards and their section is unfolded.
- **Operations log** (`src/store/operations.ts`): `runOn` in `src/actions/ops/write.ts` opens an entry and counts items, `report` puts the toast's result line on it. Pass `{ read: true }` to `runOn` for a read-only pass. Editor applies (`views/doc`) are not in the log.
- **Persistence.** Own store, backend key `sidepanels`: `{ left, right: { open, width, collapsed } }`; widths are clamped to 180–480, and at render the panes always keep 320px (one docked panel may take the rest, two share it). Cursor, filter and history are not persisted.
- **Narrow windows.** Under 900px (CSS px of `.app`) a panel overlays the panes and shows only while it is `active` (it has focus, or a confirm dialog it opened has); the toggle then focuses it. Nothing done there writes `open`: a glance on a small window does not dock the panel for later. `useShown(side)` / `isShown(side)` in `store.ts` are the one rule for "is it on screen".
- Not built: no virtualization of the row lists, stopping a log stream closes its pane (there is no stream control without the view), an in-flight operation cannot be cancelled, the open state is read after first paint (a panel that was open appears one frame late).

## 15. Layout rules features rely on

- Chrome: titlebar 32, bottom row 20, pane header 20, tab strip 20 on a folded or zoomed pane. A view fills `.pane-body` (`position: relative; overflow: hidden`); size it with `height: 100%`.
- Pane frames are `contain: strict` and absolutely positioned. During a divider drag only their inline `left/top/width/height` change; no React render happens until the drop. Observe your own element with a `ResizeObserver` if you need its size (virtualizer, xterm fit).
- Minimum pane 240×120 (table, containers) or 240×96; below that the split folds to tabs and the pane gets `visible: false`.
- Zoom: lengths from `getBoundingClientRect` and pointer events are in viewport px; divide by `zoomFactor()` before mixing them with CSS px. `clientWidth` / `clientHeight` are already CSS px.

## 16. Status after integration

Verified with `pnpm typecheck`, `pnpm test`, `pnpm build`, and by walking ux.md §19 (J1–J5) with the keyboard in a browser against the mock backend. Nothing has been run inside the Tauri webview or on macOS.

**Unbuilt actions** (no handler, so hidden everywhere and their keys do nothing; the list `src/features.test.ts` checks):

| Action | Tier | Why |
|---|---|---|
| `fav.layoutPrevious` (`Alt+0`) | P0 | Parked workspaces (§7.2) do not exist; a layout recall replaces the workspace after confirming live sessions |
| `flux.notReady` (`:flux!`), `:flux` | P0 | Needs a table over several kinds |
| `pane.fitToTable`, `editor.replace`, `workload.setImage`, `rs.rollback`, `node.drain`, `pod.transfer`, `pod.sanitize`, `flux.trace`, `res.usedBy` | P1 | Not started |
| `res.warp` | P2 | Not started |

`pane.leader` has no handler by design (the key engine implements it). `window.close` and `app.quit` only do something inside Tauri.

**Feature waves (`docs/plan-features.md`).** Unbuilt feature actions are listed per package in `src/features.pending.ts` (also checked by `src/features.test.ts`). After wave 3 (2026-11-22) every list there is empty: no feature action is unbuilt. Built in wave 3: reach (`res.reach`, view `reach`, probe and "debug instead" as rows driven by `Enter`), relations (`res.relations`, `relations.collapse/expand` on `h`/`l`, view `relations`), Rollouts activity group (order 20), `:why` for Ingress/Job/CronJob/Flux, the hub's getting-started guides, and `hub.help` on the shell, describe/YAML, text and containers toolbars (shown only where a tool applies). Status per package: plan-features §6.7. After wave 2 only C3's remained unbuilt. `view.saveToFile` is built for text views only (packs, bundles, snippet output, docs). Built in wave 2: timeline, journal, traps, sparklines, debug container/copy, snippets, copy as kubectl, mirrord, pack and the text view, names proxy, connection strings, k9s port annotations, mounted-files export, agent proposals (Agent requests group, `leader y`), `show_in_kns` agent panes. Wave-2 activity groups: Agent requests 5, Dev sets not started 12, Traps 45, Debug pods 46, Journal 95. Status per package: plan-features §6.6. Built in wave 1: Tools hub (`hub.*`), `:why` and the crash card, diff and field owners, merged/structured logs and patterns, forwards to Services/workloads with open-in-browser, env view and dev sets, the MCP server with its read tools and the agents view. Status per package: plan-features §6.5.

**Built but partial**

- Merged logs (`l` with marks, bulk bar) keep their structured mode and chips in the pane's buffer only; a reload restores the pane but not those.
- `logs.head` is emulated in the frontend; `logs.previous` is always enabled.
- Favourites: no `FAV n` header label, no layout mini-map; the titlebar's "(edited)" mark follows tree changes only.
- Home has no Layouts section and reads favourites as a snapshot on focus.
- Help overlay is grouped by registry group, not by scope, and is not virtualized.
- Rebind captures a single chord through an `onKeyDown` on its capture field (an exception to the "no keydown listener" rule; the other is the palette's type-ahead, §17, which collects text only while its lazy input is on its way).
- REVIEW cannot be scrolled by keyboard; draft resume has no `Backspace discard` key.
- Right-click opens the context menu at the pointer. Tables and the tool lists (home, settings, aliases, messages) move the cursor to the clicked row first; a table opens its own row menu (§17).
- Describe refreshes on a 5s poll while visible.
- Delete has no dry run and no uid precondition (`DeleteOptions` in the IPC contract lacks both).

**Bundle after feature wave 3** (2026-11-22): entry `index.js` 493 kB / 163 kB (C3 actions and rollout watch, hub guides, mocks). **Bundle after feature wave 2** (2026-11-22): entry `index.js` 473 kB / 155 kB (wave-2 eager action files, catalog refinements and mocks; dialogs and views are lazy chunks). **Bundle after feature wave 1** (2026-11-22): entry `index.js` 421 kB / 138 kB (the wave-1 registrations, catalog, eager action files and their mocks; not traced further; `docs/tools.md` is a lazy chunk, the patterns worker its own 2 kB file). Earlier figures, kept for comparison: **Bundle** (`pnpm build`, minified / gzip): entry `index.js` 320 kB / 103 kB (React, zustand, the key engine, stores, all eager action files; sizes measured after the mouse-parity round, the split between `index`, `ui` and `foundation` moved and was not traced); `ui` 116 / 41; `foundation` 10 / 4; `TableView` 59 / 21; `LogsView` 32 / 11; lazy `DocView` (CodeMirror) 424 / 139; lazy `sessions` (xterm) 343 / 88; lazy `yaml` 97 / 30; lazy `vim` 123 / 40 (fetched only while the vim setting is on). The entry contains no CodeMirror, xterm or yaml code. `index.css` is 71 kB / 31 kB; the fonts are separate files.

## 17. Mouse parity: pointer controls

Keyboard-first stays; every pointer control is an **action id** run through the engine. Nothing here duplicates logic, and nothing takes keyboard focus from the pane. All of it is exported from `src/ui` and `src/foundation.ts`.

```tsx
import { ActionButton, ActionHint, Toolbar, PaneToolbar, openMenu, runAction, useActionState, tip, actionTip, keepFocus, Icon } from "../../foundation";

<ActionButton action="res.logs" />                              // icon from ACTION_ICONS, tooltip "Logs [l]"
<ActionButton action="logs.wrap" active={view.wrap} />          // toggle: aria-pressed + pressed look
<ActionButton action="res.delete" before={() => model.setCursorIndex(i)} />   // a row button: cursor first, then the action
<ActionButton action="ui.zoom" icon={null} label="125%" args={["125"]} keep />   // text button, ctx.args (like `:ui 125`), kept (disabled) while absent
<ActionHint action="filter.clear" label="remove the last chip" />   // key chip + underlined label, for prose and empty states
```

**What a button shows** (`actionState` / `useActionState`, `src/ui/action-state.ts`):

- *absent* (renders nothing; with `keep` it stays, disabled): the action is not built, none of its scopes is in the pane's own chain (`scopesOf(pane, view)` + `global` + what is live right now), or its `when` is false. The pane's chain is used, not only the engine's live chain, so a button still works while a filter input holds the keys.
- *disabled* (`aria-disabled`, never the native `disabled`: the click still focuses the pane and the bottom row says why): `enabled` returned false or a reason, or a `write` action in read-only mode. The tooltip adds the reason on a second line.
- The tooltip is the label and the key chip from the live keymap, read when it opens, so rebinding a key updates every tooltip.

**Tooltips** (`src/ui/Tooltip.tsx`). One host for the window with delegated listeners; a control only carries attributes, so a tooltip costs nothing per row and needs no subscription:

```tsx
<button {...tip("Pane menu")} aria-label="Pane menu" />                  // text
<button {...actionTip("pane.close")} />                                  // registry label + live key
<button {...actionTip("res.delete", undefined, state.reason)} />         // + why it is disabled
<span {...tip("Drag to resize", { reason: "double-click equalizes", delay: 1200 })} />   // slow: the pointer crosses it all the time
<div className="cell" {...clipTip(name)} />                              // the full text, only while the cell cuts it (600ms, as written)
<span {...tip(namespace, { plain: true, reason: "Alt+click: show only this namespace" })} />   // cluster text: never capitalized or cut
```

It opens after 300ms (at once when the pointer comes from another control with a tooltip, never for a `delay` one), under the control, above it when there is no room, inside the window. It closes on a key, a pointer press, the wheel, a scroll of the control's container and when the control goes away, and then stays closed until the pointer really moves (a button that appears under a resting pointer after a click does not pop its tooltip). It never takes focus and is `aria-hidden`: give the control its own `aria-label`. **Never use a native `title`** (two tooltips, the platform's delay, no key chip). Labels get a capital first letter; pass `plain` for text that is not ours.
- **Handlers read the focused pane, so the state is only evaluated for a control in the focused pane** (or outside the panes). In another pane a button is shown by scope alone and looks enabled; the click focuses that pane and a blocked action flashes its reason. State follows `engine` notifications: call `engine.invalidate()` when something your `when` / `enabled` reads changes. The foundation does it on focus, view and history changes, and when a pane's selection gains or loses its cursor row or marks (`src/panes/scope-sync.ts`).

**What a click does** (`runAction(id, { pane, args, newPane, before })`): the control's pane becomes the focused pane (and gets DOM focus when focus sat in a side panel), `before` runs, then `engine.run(id, { source: "pointer" })`. The pane comes from `PaneContext` (set by the pane frame, also through the header portals), so a button inside a view or its header slots needs no `pane` prop; in the window chrome it acts on the focused pane. Ctrl/⌘+click opens beside (Shift: below) for actions with `opens: "view"`. For a hand-made control use `onMouseDown={keepFocus}`, `tabIndex={-1}`, `{...actionTip(id)}`, an `aria-label` and `onClick={() => runAction(id)}`.

**Toolbars.** A toolbar is a list of action ids; `"|"` separates groups; an object adds `active`, `label`, `icon`, `args`, `before`, `showLabel`, `keep`, `join`. Buttons that do not fit move into a "more" menu (disabled ones with their reason). `join: true` keeps an item with the one before it (rendered in one `.k-toolbar-join`): a segmented control is in the bar whole or in "more" whole. Two ways to put one in the pane header:

```ts
// 1. declared with the view kind, when it only depends on the ViewState
registerView({
  kinds: ["logs"],
  component: () => import("./LogsView"),
  toolbar: (v) => ["logs.autoscroll", { action: "logs.wrap", active: v.wrap }, { action: "logs.timestamps", active: v.timestamps }, "|", "logs.previous", "logs.containerPicker", "filter.open", "logs.copy"],
});
```
```tsx
// 2. from inside the view, when it depends on live state (the "toolbar" pane slot)
<PaneToolbar items={["editor.review", "|", { action: "doc.wrap", active: wrap }]} />
// anywhere else (a row action bar, a panel): <Toolbar items={[...]} />
```

Every button evaluates its action's `when` / `enabled` on each engine notification. That is fine for a toolbar; it is not for a table: a row action bar is **one** bar for the cursor (or hovered) row, never buttons mounted in every row.

Icons: `<Icon name="…" />`, 12px line icons in the glyph sprite (`ICONS` in `src/ui/Glyph.tsx`: add a path there). `ACTION_ICONS` (`src/ui/ActionButton.tsx`) maps action ids to default icons; an action without an icon shows its label.

**Pane header** (`src/panes/Pane.tsx`, `panes.css`): back / forward, crumbs, the toolbar, chips, labels, count, watch, then split right, split down, zoom, the pane menu ("more") and close. The buttons are always visible and clickable (a click needs no hover first); on a pane with neither the focus nor the pointer they are `--k-text-muted` (`.pane-reveal`: colour only, nothing moves). Under 420px split and zoom live only in the pane menu, under 300px back / forward too. Crumbs under pressure: long ones (over 8 characters) shorten first to a 5ch stub, none goes below 3ch, the last never shrinks; from 420px down only the last two show, from 280px the last one. The `FOLLOW` word of the link hides under 560px. The toolbar sits directly after the crumbs, so its left edge only moves on a navigation: chips and labels (`UNSORTED n`, `WIDE`) come and go to its right, and when it overflows it gives up buttons at its right end, never the one under the pointer. It gives way before the crumbs, down to its "more" button. A right-click on the header opens the pane menu.

**Crumbs.** A `Crumb` has `view` (a click goes there: one step back when the previous history entry is that view, else a push; Ctrl/⌘+click beside; a pane with a live session, e.g. a dirty edit or a shell, is never navigated in place: the view opens to its right, `goToCrumb` in `src/panes/crumbs.ts`) or `action` (+ `args`: a click runs it for that pane). `defaultCrumbs` makes a table's namespace crumb `namespace.pick` and its resource crumb `palette.open`. A feature's own `crumbs` can do the same (the format crumb of a doc, say).

**Tab strips** (folded or zoomed panes): a click focuses the tab's pane, each tab has a close button (`pane.close` on that pane). **Dividers**: drag to resize (Alt: no snap), double-click equalizes that split, Shift+double-click all. **Pane headers** (`src/panes/drag.ts`, §3.5): drag a header (6px threshold) onto another pane; the outer 25% of an edge (max 160px) inserts on that side, the centre swaps, `Esc` cancels. The preview outlines where the pane lands; nothing moves until the drop. Buttons and inputs in the header are not handles.

**Context menu.** `openMenu({ at: { x, y }, items?, pane? })` (`src/ui/menu.ts`) opens the `menu.open` overlay at a point (viewport px; kept inside the window, corrected for zoom). Without `items` it lists the hint-row actions of the focused pane; with `items` exactly those actions, resolved to rows inside `openMenu` before the menu's layer takes the keys (that layer hides every other one, so a filter input's or a side panel's actions would read as absent afterwards). An entry is an action id, an action with options, or `"|"`: a rule between two groups (a rule that ends up first, last or doubled after absent actions dropped out is removed; a toolbar's overflow menu keeps the toolbar's groups). The menu is as tall as the window allows and scrolls only on a short window; the pointer moves the selection (`ListBox.onHover`, real movement only), so there is one highlight. `onCancel` runs once whenever the menu closes without a pick, however it closes (Esc, a click outside, another overlay replacing it, `Shift+F10` again). The window's `contextmenu` listener (`main.tsx`) opens it for any right-click inside a pane, after the pointerdown has focused the pane. **Right-click acts on what was clicked**: a view moves its cursor in its own React `onContextMenu` (React handlers run before the window listener, and the menu snapshots the hints when it opens):

```tsx
// move the cursor; the default menu then opens for that row
<div className="tbl-body" onContextMenu={(e) => { const i = rowIndexOf(e.target); if (i >= 0) model.setCursorIndex(i); }} />
// or a menu of its own: preventDefault tells the window listener it is handled
onContextMenu={(e) => { e.preventDefault(); model.setCursorIndex(i); openMenu({ at: { x: e.clientX, y: e.clientY }, items: ["res.logs", "res.describe", "res.delete"] }); }}
```

**Window chrome.** Titlebar: sidebar toggle, context switcher, namespace switcher (table panes), the palette field, then home, favourites, help, settings, a "more" menu (`WINDOW_MENU`: save view, save layout, favourites, aliases, errors, port-forwards) and the activity toggle. Bottom row: every hint is a button that runs its action; `+N` opens a menu of the hints that did not fit; the mode badge is a button outside NORMAL / TERM / the vim modes and runs the mode's leave action (`filter.cancel`, `list.close`, `move.cancel`, `resize.done`, `copy.leave`, `editor.leave`, `review.back`, `side.leave`; PANE and NEW drop the pending key).

**Home** opens a row with one click (`openOnClick` on `ListPane`; the click runs `nav.open` after the cursor moved); the other tool lists keep click = select, double-click = open or change.

**Doc toolbar** (`DocToolbar` in `src/views/doc/DocView.tsx`, through the `toolbar` slot; one item list per mode). The order is what a narrow pane keeps (the rest is in "more"); optional buttons sit at the end of their group and labels never change with the state, so nothing shifts. View: `res.edit` | `filter.open` (pressed with a query), `doc.copy`, `doc.wrap`, `doc.foldAll`, `doc.managedFields` (kept disabled outside YAML) | the format switch (three `doc.format` buttons with `args` `describe | yaml | json`, joined into a segmented control by `doc.css` and kept together by `join`; a secret gets `secret.revealToggle` instead) | `view.refresh`, `pane.followToggle` (linked panes) | `search.previous` / `search.next` (only with a query). EDIT: `editor.review`, `editor.leave` (always labelled Cancel; dirty, it asks) | `editor.find`, `editor.copy`, `editor.diffGutter`, `editor.wrap`, `editor.foldAll` | `editor.findNext` (with a query). REVIEW: `review.apply`, `review.back` | `review.toggleSplit`, `editor.wrap`, `review.revealSecret` | rebase / suspend flux when their scope is live; Apply and Back are repeated as labelled buttons under the dry-run lines, and the discard dialog's buttons run `editor.discardConfirm` / `editor.stay`. The toolbar keeps a reserve in the header that grows with the pane (`@container` 420 / 640 / 900 in `doc.css`). Review diff: one 2px bar per changed line (strong on the added side, quiet on the removed; not on the inline `ins` / `del` spans inside it), changed characters one surface step up. Pressed states come from the view state and `DocUi` (`folded`, `revealed`, `diffGutter`). With vim keys on, a pointer or menu run of `editor.leave` is `:q` (`Controller.quit()`: asks when dirty, no Esc ladder); `editor.find` / `filter.open` are live in a vim editor for keys and mouse alike. `editor.wrap` (Alt+Z) and `editor.copy` (Mod+Shift+C) exist because `w` and `c` are text in an editor.

**Tables** (`src/table`, the same Grid for the containers view). The action lists are data in `pointer.ts`; an action outside the pane's scopes drops out by itself, so one list serves every kind. Rows have no listeners, buttons or state: the body delegates by `data-index`, and every pointer path first calls `model.point(uid)` (cursor to the clicked row, selection published at once), then runs the action for that pane.

- Rows: click = cursor; double-click, Ctrl/⌘+click (beside) and middle-click = `nav.open`; right-click = the row menu (`rowMenu(ns)` from `ROW_MENU_GROUPS`: open and read · logs, shell, port-forward · scale, restart, Flux · related · copy, mark · delete last, with a rule between the groups). The gutter (and the 6px before the name, `CHECK_HIT`) is the checkbox = `mark.toggle` (stays on the row); Shift+click = `mark.range` from the cursor row (the last row clicked or marked; `pointRange` resets the anchor, so an older mark never widens the range). A click on a namespace cell selects like any other; Alt+click on it (`data-ns`, all-namespaces tables) or "show only namespace x" in the row menu (`rowMenu(ns)`) runs `namespace.pick <ns>`. "mark" picked from the row menu stays on the row, like the checkbox.
- Row bar (`RowBar.tsx`): one floating bar for the hovered row, on a zero-height sticky rail so it stays at the right edge while the table scrolls sideways. The first 2 / 3 / 4 / 6 / 8 of `ROW_ACTIONS` by pane width (under 320 / 480 / 640 / 880 / wider), then "more" (the row menu). Keyed by uid: when live data moves another row under the pointer it hides until the next mouse move. The bar is moved in the DOM in the same handler as the hover (the state follows one render later), and fades in over the cells instead of cutting them.
- **Marks decide the target** (`selectionTargets`: marks, else the cursor row). So while rows are marked there is no row bar; a right-click on an unmarked row drops the marks first (as a file manager does) and puts them back when the menu is closed without a pick, however it closes (`onCancel`), on a marked row the menu acts on the marks. The bulk bar under the rows (`BULK_ACTIONS`: only actions that take every marked row, plus mark all / clear) shows while rows are marked.
- Header: a click selects the column and runs `sort.selectedColumn` (containers: sorts directly, its scope has no sort actions); the sorted column shows an arrow icon; right-click or the hover caret opens the column menu (sort, `column.hide`, wider / narrower, `view.wide`, `view.columns`); the gutter holds the mark-all / clear box. `column.hide` is new (no key, `:hidecol`). In the column menu a click on a row's checkbox shows or hides that column (`columns.toggle`); the rest of the row selects it.
- Pane toolbar (`paneToolbar()` through `<PaneToolbar>`): `filter.open` and the `filter.faults` toggle first, then the row actions for the cursor row, then `view.wide`, `view.columns`, `view.refresh`. Filter chips (also FAULTS) are removed by a click.
- Columns (`columns.ts`, ux.md §12.2): spare width goes to the status word, then NAME up to its content width, then the rest; tier 4 columns join only when NAME can also be read (`NAME_COMFORT`); a user width on NAME is a floor; a column's ideal is at least its full header title. A press on a resize handle pins a width only after 3px of travel; double-click fits.
- Viewport: the scroller is snapped to the header plus whole rows (`.tbl-view` holds the slack); the wheel steps whole rows at once, other scrolls settle on a row edge at `scrollend` (a 120ms idle timer where the webview has no `scrollend`).

**Logs, shell, port-forwards** (`src/views/logs`, `src/views/shell`).

- Logs toolbar (`<PaneToolbar label="Logs">` in `LogsView.tsx`, because follow and the search are session state): `logs.autoscroll` (pause / play icon), `logs.wrap`, `logs.timestamps` | the time-range menu, `logs.previous`, `logs.containerPicker` | `filter.open` (search), `search.previous` / `search.next` (kept disabled without matches to step through), `logs.filterLines` | `logs.copy`, `logs.clear`. The time-range button is a **toolbar menu item** (`{ menu: MenuEntry[], label, text?, icon? }` in `Toolbar.tsx`): its rows are `logs.tail`, `logs.head` and `logs.since` with the preset as `args[0]` (`"5m"`; the handler takes the name or the digit of the key) and `binding: i`, so each row shows its own key. In the overflow menu the rows are listed flat. The jump control ("N new · latest", shown while paused and not ended) is a button that runs `logs.resumeFollow` for its pane. Header labels say only what differs from a plain followed tail of every container: `paused +n`, `ended` (`LogSession.ended`: every stream ran to its end), `filter`, `previous`, the container, the time range. Empty states name the one action that helps as a clickable `ActionHint`. The list is a whole number of lines with 2px above the first; the slack is at the bottom.
- Shell toolbar (`<PaneToolbar label="Shell">` in `ShellView.tsx`): `terminal.reconnect` (only without a live session), `terminal.copyMode` (in COPY the same button is `copy.leave`, pressed), `terminal.copy`, `terminal.paste`, `terminal.search`, `terminal.container`, `terminal.end`. Buttons never take the focus, so typing still goes to the terminal.
- Both toolbars keep a reserve of four buttons' width in the header (the logs reserve grows with the pane: `@container` 640 / 900 / 1100 in `logs.css`) instead of giving way completely (a `min-width` only: they do not take a share of the squeeze, or the crumbs of an unfocused pane would be ellipsized next to an invisible toolbar) (`.pane-toolbar:has(> .k-toolbar[aria-label="Logs"])` in `logs.css`, the same for `Shell`); the rest is in "more".
- Port-forward manager: `toolbar` of the view kind (`pf.openBrowser`, `pf.copyAddress`, `pf.stop`, `view.refresh`) and the same three as buttons in every row (plain buttons with `actionTip` attributes; a click moves the cursor to the row, then `runAction`). Shown on the hovered row and on the cursor row; the column is always there.

**Tool lists** (`ListPane.tsx`). A row's buttons are plain `<button data-act>`s, the list delegates the click: the pane takes the focus, the cursor goes to the row, then `engine.run` (not `runAction`: the `settings.keymap` layer is only live once the cursor sits on a keymap row). Settings: an on / off row is one switch (a click anywhere on the row flips it, `settings.change`; a double-click is two flips), a choice has previous / value / next (`settings.cyclePrev` / `change` / `cycleNext`); `ItemRow.control` says which. Keymap rows: the key chips are the rebind button, plus rebind / unbind / reset (`keymap.*`; dimmed from `keys` and `ItemRow.edited`); a double-click rebinds. Aliases: open and open beside (`nav.open`). Every tool view declares a `toolbar` with its filter; settings adds `keymap.resetAll`.

**Side panels** (`src/sidepanels`). Rows and section headers were clickable already. Row buttons (`RowButton` in `Frame.tsx`): open in browser, copy address, stop on a row; stop all and clear on a section header. They call `engine.run(id, { source: "pointer", args: [rowKey | section] })`: the `activity.*` handlers act on the named row when a pointer names one, so the buttons work while the keyboard focus stays in a pane (the `side.activity` scope is not needed, `engine.run` checks `when` / `enabled` only). Buttons and the age share one grid cell (`.side-end`), so nothing shifts; they show on the hovered row and on the cursor row of the focused panel. Both panels resize by dragging the inner edge (6px hit area; double-click resets).

**Keys in tooltips.** `shownBinding(id)` / `shownKeys(id)` (`action-state.ts`) give the first binding that works now: with the single-keys setting off, single keys are skipped (they are dead). Cached per keymap version; the tooltip reads it when it opens. `actionTitle` / `useTip` (plain strings) are still exported but nothing uses them: use `actionTip`.

**Palette lists.** The pointer moves the selection, on real movement only (`palette/ui/hover.ts`: a list that scrolls under a resting pointer keeps its selection); in `:` mode a hovered row does not change what Enter runs. Object rows read `namespace/name` with the kind as the right tag. **Type-ahead** (`session.ts`): the palette and the pickers are lazy, so what is typed between the opening key (or click) and the input's mount is collected and becomes the start of the input's text (`useState(typedAhead)`); `Ctrl/⌘+K` followed at once by a name loses no letters. Its window `keydown` listener lives only for that moment and collects text, never a shortcut.

**Restart asks first.** `workload.restart` is tier 1 (`simpleWrite({ tier: 1 })` in `src/actions/ops/actions.ts`): the dialog opens, Enter confirms; a protected context still makes it tier 2. `:settings` opens settings (`Ctrl/⌘+,`).

Known limits: a button in an unfocused pane cannot show a disabled state before it is clicked; a menu dismissed before its lazy chunk mounted never reports `onCancel` (the chunk is warmed at idle, so this needs a right-click in the first moments after start); the wheel steps table rows without the platform's smooth scrolling; the containers view sorts by a direct model call (its scope has no sort actions).
