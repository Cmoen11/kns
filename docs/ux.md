# kns UX spec

Status: final synthesis of the flow, layout and visual proposals, revised after critique. It supersedes `research.md` §6 for colours, typography, layout and default keys; the k9s key facts in §6.3 are kept. Tags: **[ours]** a choice of our own, **[verify]** untested.

Nothing here is tested on hardware. Contrast figures are WCAG ratios recomputed by script from the exact `tokens.css` values for all 3 themes × 2 modes.

## 1. Principles

1. **Keyboard first.** Every action has a key or a `:` command. The mouse is parity, never a requirement.
2. **One registry.** `{id, scope, tier, built, opens, write, hint, win, mac, when}` generates the hint row, `?` overlay, palette chips, context menus and macOS menu. No component hardcodes a key.
3. **k9s keys where sane.** Replacements are listed in §5.7; a k9s-mode preset restores them.
4. **One view per pane.** No tabs or docks inside a pane. A detail view drills in place or opens in another pane.
5. **One rule for "new pane".** `+` then any view-opening action opens right; `+ +` opens below.
6. **Esc is safe.** It never closes a pane, unzooms or quits.
7. **Nothing is lost silently.** No pane is replaced or auto-closed. Pinned panes are never reused. A live shell never ends and an unsaved edit is never dropped without a confirm (§4.6). Layout pressure folds panes to tabs; the tree is not changed.
8. **Instant.** Key handling is synchronous, the frame swaps from cache in the same frame, and data streams in after. Row heights are fixed and the cursor row never moves on screen because of data (§12.3).
9. **No state by colour step alone.** Every state has a second signal (bar, glyph, line, frame, word).
10. **Tokens only.** Components read `--k-*` tokens, which map to the theme palette. The only hardcoded colours are the status and syntax hues.
11. **Dense.** XS step, 20px rows, 52px of fixed chrome.
12. **No implied parity.** An action that is not built is absent from hints, `?`, the palette, the leader panel and menus, and its key does nothing (§5.4).

### Resolved conflicts

| Topic | Decision | Reason |
|---|---|---|
| New-pane prefix | `+` right, `+ +` below; direct `Ctrl/⌘+Enter` and `Alt/⌥+Enter` | Unshifted on a Norwegian layout; leaves `,` `.` free for history |
| History | `,` back, `.` forward, `-` last; `[` `]` aliases | No AltGr; a `,` prefix would push history onto Backspace or Alt+arrows, both taken |
| Alt+arrows | Pane focus (left Alt only) | Works inside terminal panes; no Ctrl+Alt (AltGr), no Shift+arrow (text selection) |
| `Ctrl/⌘+1..9` | Favourite views | Requirement: favourites on hotkeys. Pane N is leader + digit |
| Layout recall | `Alt+1..9` / `⌥⌘1..9`, `Alt+0` last parked | Requirement: layouts on hotkeys. Cost on Windows shells is in §18 |
| Pane leader | `Ctrl+.` / `⌘.`, one-shot, which-key after 250ms; RESIZE and MOVE are sticky; the second key ignores Ctrl/⌘ | Cheapest for single operations; never `Ctrl+P` |
| `Ctrl/⌘+D` | Unbound in tables (one-time hint) | k9s delete habit and shell EOF; split is leader `r` / `d` |
| `*` / `!` | Wide columns / faults | `Alt+W` breaks produced-character matching on macOS; `Ctrl+Z` is undo |
| Tab | Cycles panes in NORMAL; `F6` everywhere. In inputs: completes in completion inputs, cycles the mode in filter and search inputs | One rule per input kind (§5.2) |
| Esc and panes | Never closes a pane | `Ctrl/⌘+W` closes, `Ctrl/⌘+Shift+T` reopens |
| Follow link | On for describe/YAML opened with the prefix; logs, shell and edit pinned | Saves a leader `f` each time; owner-reversible |
| Pane reuse | Only a following pane of the same kind and format | Pinned panes hold work (§4.4) |
| Layout pressure | Fold to tabs; refuse only at 12 leaves | A split on a small window must still work |
| Minimum pane | 240×120 (tables), 240×96 (others) | 360 allows too few columns on 1366 |
| Tree | Flattened n-ary | Three columns equalize to thirds |
| Sidebar | None; `home` pane view | Pixels go to tables |
| Chrome | Titlebar 32, one bottom row 20, pane header 20, column header 20, rows 20 | Every row is a 16px line box plus an inset (2+2 or 8+8) |
| Focused pane | A soft frame around the pane card + title colour | No layout shift |
| Windows titlebar | Native caption buttons and snap layouts | Native feel; route is [verify] |
| Namespace keys | `Ctrl/⌘+N` focused pane, `Ctrl/⌘+Shift+N` all panes | Namespace is per pane |
| Palette prefixes | `:` `>` `'` `?` | `@` and `#` dropped (`@` needs AltGr) |
| Glyphs | Filled only, unique shape per state, integer px, one node colour | "Fyll og omriss kan ikke stå sammen"; node colour cannot separate states (§9.5) |
| Status hues | Two (warn, error), on glyphs and words only | "Sparsomt"; the rest comes from theme tokens |
| Match highlight | Background step + underline | Colour alone is not enough |
| Overlay surface | b1, rounded, soft shadow + scrim | Floats like the Claude desktop app's menus |
| Key chip | UI type, filled chip, case preserved | Never the uppercase label style, because `g` and `G` differ |
| Size zoom | Zoom 85/100/110/125/150% on top of a 1.2x base scale (100% = 12px UI text, 24px rows; 85% is about the raw XS step) | One factor scales everything together |
| Motion | None; delta is a static 1s state | Reference: "ikke bestemt ennå", so simplest |
| Mono | Geist Mono 12/16 default; compare with JetBrains Mono in M1 | Both OFL 1.1 |
| Pin | Dropped as a separate feature; "pinned" means follow is off | Nothing is replaced silently, so it duplicates the follow toggle |

## 2. Window anatomy

Fixed chrome is 52px: titlebar 32 and bottom row 20. Per pane: header 20, column header 20, rows 20, log and YAML lines 16. Panes are separated by a 1px divider. A folded or zoomed pane adds one 20px tab strip (§3.4).

Budgets, for a client area of the given size at 100% zoom:

| Window | Pane area | Rows, full-height table | Rows, half-height table | Log lines, full height | Comfortable columns |
|---|---|---|---|---|---|
| 1366×768 | 1366×716 | 33 | 15 | 43 | 2 × 682 |
| 1920×1080 | 1920×1028 | 49 | 23 | 63 | 3 × 639 |
| 3440×1440 | 3440×1388 | 67 | 32 | 85 | rail 240 + 4 × 799 |

Formulas: table rows = floor((H − 40) / 20); log lines = floor((H − 20) / 16); half height = (pane area height − 1) / 2.

### 2.1 Laptop 1366×768 (Windows): `pods | (services / logs)`

```
+------------------------------------------------------------------------------------------------+
| default v1.32                      [Ctrl K  Search or run]              debug    [ _  []  X ] | 32
+===============================================+------------------------------------------------+
| shop / pods   /web  FAULTS    14/52  #-o | shop / services                   9  #-o | 20
|    NAME              STATUS     RDY RST AGE CPU MEM | NAME      TYPE       PORTS CLUSTER-IP   AGE | 20
| |  web-7d9f8-abcde   # Running  1/1   0 2d4h 12  84 | web       ClusterIP  80    10.43.1.20   41d | 20
|    api-5c6b7-fghij   # Running  2/2   1  5h  40 210 |   ... 15 rows ...                            |
|    job-migrate-x1    o Error    0/1   3 12m   0   0 +------------------------------------------------+
|   ... 33 rows ...                             | shop / pods / api-5c6b7 / logs  FOLLOW   #-o | 20
|                                               | 12:01:07 api  GET /healthz 200                    | 16
|                                               |   ... 21 lines ...                                |
+-----------------------------------------------+------------------------------------------------+
| NORMAL  d describe  l logs  s shell  e edit  + new pane  / filter  ? help      pf 1  flux 12/12  #-o | 20
+------------------------------------------------------------------------------------------------+
```

Legend: `===` focused pane, `|` at row start is the cursor bar, `#` square and `o` circle are status glyphs in the STATUS cell, `#-o` is the node line watch glyph.

- Each column is 682px, so the pods table shows tiers 0–3 (§12.2).
- The right column is 357px per pane: 15 table rows, 21 log lines.
- Services have no status, so they have no glyph.

### 2.2 Desktop 1920×1080: three columns, describe following pane 1

```
+--------------------------------------------------------------------------------------------------------+
| default  k3s / admin  v1.32           [Ctrl K  Search or run]                   flux-vakt  [ _ [] X ] | 32
+=================================+----------------------------------+-----------------------------------+
| flux-system / kustomizations #-o| * / pods   FAULTS       3/61 #-o | flux-system / apps / describe <-1 | 20
|    NAME   READY   REVISION  AGE |    NS  NAME  STATUS  RDY RST AGE |  1  Name:       apps              |
| |  apps   # True  main@1a2b 41d |  shop job-x o Error 0/1 ... |  2  Namespace:  flux-system       |
|   ... 49 rows ...               |  ... 23 rows ...                 |  ... 63 lines ...                 |
|                                 +----------------------------------+                                   |
|                                 | * / events   WARNING   12/340 #-o|                                   |
|                                 |  ... 23 rows ...                 |                                   |
+---------------------------------+----------------------------------+-----------------------------------+
| NORMAL  R reconcile  T suspend  d describe  y yaml  + new pane  ? help          pf 0  flux 11/12  #-o | 20
+--------------------------------------------------------------------------------------------------------+
```

### 2.3 Ultrawide 3440×1440 (macOS): home rail + four columns

```
+----------------------------------------------------------------------------------------------------------------+
| (o o o)  default  k3s / admin  v1.32      [⌘K  Search or run]                                         drift   | 32
+=========+--------------------------+--------------------------+--------------------------+--------------------+
| home    | * / pods            #-o  | flux / helmreleases #-o  | shop / deploy/web   | shop / web-7d |
| FAVOR.  |  ... 67 rows, tier 4 ... |  ... 32 rows ...         |   / logs  FOLLOW         |   / shell   TERM   |
| RECENT  |                          +--------------------------+  ... 85 lines ...        |  ... 85 lines ...  |
| WORKL.  |                          | * / events  WARNING      |                          |                    |
| FLUX    |                          |  ... 32 rows ...         |                          |                    |
+---------+--------------------------+--------------------------+--------------------------+--------------------+
| NORMAL  Enter open  + new pane  ' favourites  ? help                           pf 2  flux 12/12  cpu 31%  #-o | 20
+----------------------------------------------------------------------------------------------------------------+
```

### 2.4 Titlebar (32px, `--k-bg-app`)

- **macOS:** native traffic lights, overlay title bar (`src-tauri/tauri.macos.conf.json`: `titleBarStyle: Overlay`, hidden title, lights centred in the 32px row), 78px reserved on the left [verify].
- **Windows:** native caption buttons and Win11 snap layouts, 138px reserved on the right. Tauri's overlay style is macOS-only, so the route is a plugin or native hit-testing [verify].
- **Windows fallback:** if neither works, the standard OS title bar is used and the 32px row stays where it is as an ordinary app bar with no drag region and no reserved 138px. Nothing moves into the bottom row. The cost is the OS title bar height (about 31px), which is two table rows.
- Everything non-interactive is a drag region. Padding-inline 8, group gap 12, item gap 6.
- Left: context name (UI S 12px), then `cluster / user` and server version (UI type, muted). Opens the context picker. `cluster / user` hides under 1280 wide; it is always in the context picker and the `home` view.
- Centre: palette trigger, a key chip plus the text "Search or run". It is not an input field.
- Right: `READ ONLY` and `PROTECTED` labels (label style), then the active layout name with `edited` when it has diverged.
- No favourites strip, no logo. The app name appears only in the OS window title.

### 2.5 Bottom row (20px, `--k-bg-app`)

`[mode badge] [hints for the focused pane's scope ...] ...flex... [errors N] [pf N] [flux a/b] [cpu% mem%] [connection node line + word]`

- Mode badge: label style. Values: `NORMAL`, `FILTER`, `COMMAND`, `NEW →`, `NEW ↓`, `PANE`, `RESIZE`, `MOVE`, `TERM`, `COPY`, `EDIT`, `REVIEW`. `RO` is a second badge.
- Hints: key chip + label (UI type, weight 500, `--k-text-3`), key-to-label gap 6, hint gap 12, padding-inline 8. They overflow to `+N`; `?` shows everything.
- Hint order comes from the registry's `hint` number (0 first, `null` never shown). Order: actions specific to the focused kind, then view actions (`d` `y` `e` `l` `s`), then `+`, `/`, `?`. Only built, permitted actions appear.
- `Ctrl/⌘+E` hides the hints; the badge and status stay.
- `cpu% mem%` is absent when `metrics.k8s.io` is absent.
- The connection segment is the node line plus a word: `live`, `reconnecting 3s`, `offline`. `F5` or `:reconnect` retries at once and resets the backoff. The app never exits on connection loss.
- Status segments drop right to left under width pressure (§15). The connection glyph never hides.

## 3. Pane system

### 3.1 Data model

```ts
type PaneId = string;
type Dir = 'row' | 'col';              // row = side by side, col = stacked

interface SplitNode {
  kind: 'split'; id: string; dir: Dir;
  children: LayoutNode[];              // >= 2; a child split never has the same dir (flattened)
  sizes: number[];                     // fractions, sum = 1, same length as children
}
interface LeafNode { kind: 'leaf'; pane: PaneId }
type LayoutNode = SplitNode | LeafNode;

interface Gvr { group: string; version: string; resource: string }
interface ObjectRef { gvr: Gvr; namespace?: string; name: string; uid?: string }

type Filter =
  | { mode: 're' | 'not' | 'fuzzy'; text: string }
  | { mode: 'label'; selector: string };
type Scope =
  | { by: 'owner'; ref: ObjectRef }
  | { by: 'selector'; selector: string }
  | { by: 'node'; name: string };
type Sort = { column: string; desc: boolean };

interface TableView {
  kind: 'table'; gvr: Gvr; namespace: string | '*';
  filters: Filter[]; faultsOnly: boolean;
  sort: Sort | null;                   // null = per-kind memory, then kind default (§12.4)
  wide: boolean; scope?: Scope;
  cursorUid?: string;                  // restored if the row still exists
}
interface ContainersView {             // pod -> containers; has no GVR of its own
  kind: 'containers'; pod: ObjectRef;
  sort: Sort | null; cursorName?: string;
}
interface DocView {                    // one CodeMirror 6 editor for all of these
  kind: 'doc'; ref: ObjectRef;
  format: 'yaml' | 'describe' | 'json' | 'secret';
  mode: 'view' | 'edit' | 'review';    // edit is always yaml or secret (§13.2)
  managedFields: boolean; wrap: boolean;
}
type FollowTarget =
  | { by: 'object'; ref: ObjectRef }
  | { by: 'paneSelection'; pane: PaneId };      // used in saved layouts
type LogTarget = FollowTarget
  | { by: 'selector'; namespace: string; selector: string };
interface LogsView {
  kind: 'logs'; target: LogTarget; container: string | '*';
  since: 'tail' | 'head' | '1m' | '5m' | '15m' | '30m' | '1h';
  previous: boolean; wrap: boolean; timestamps: boolean;
  match?: { mode: 're' | 'not' | 'fuzzy'; text: string };
  filterLines: boolean;
}
interface ShellView {
  kind: 'shell' | 'attach'; target: FollowTarget;   // never a selector
  container?: string;
  session?: string;                    // live exec id on the Rust side; absent = placeholder
}
interface ToolView { kind: 'home' | 'portforwards' | 'settings' | 'aliases' | 'messages' }
type ViewState = TableView | ContainersView | DocView | LogsView | ShellView | ToolView;

interface PaneState {
  id: PaneId;
  history: ViewState[];                // drill stack, capped at 50; a push from mid-stack truncates forward
  index: number;                       // current entry; Esc , . move it
  last?: number;                       // target of `-`
  link?: { source: PaneId | null; follow: boolean };   // source null = source pane was closed
  context?: string;                    // §8.3: the pane's kube context when it is not the window's; never the workspace's own
}

interface Workspace {
  schema: 1;
  context: string;
  root: LayoutNode;
  panes: Record<PaneId, PaneState>;
  focused: PaneId;
  zoomed: PaneId | null;
  mru: PaneId[];                       // focus after close, fold order
  closed: { pane: PaneState; parent: string; at: number }[];   // reopen stack, max 10
  layoutId?: string; dirty: boolean;
}

type Slot = 1|2|3|4|5|6|7|8|9;
interface FavoriteView {
  id: string; name: string; slot?: Slot;
  view: Omit<TableView, 'cursorUid' | 'namespace'> & {
    namespace: string | '*' | { current: true };   // current = the target pane's namespace at recall
  };
}
interface SavedLayout {
  id: string; name: string; slot?: Slot;
  root: LayoutNode; views: Record<PaneId, ViewState>; focused: PaneId;
  links: Record<PaneId, { source: PaneId; follow: boolean }>;
}

type Chord = string;                   // 'Ctrl+K', 'g', 'Shift+Space', 'leader'
type Binding = Chord[];                // a sequence; length 1 is a single chord: ['+','+'], ['leader','r']
interface KeymapOverride { win?: Binding[]; mac?: Binding[] }   // replaces the default list; [] unbinds

interface Action {                     // the registry entry (code, not persisted)
  id: string; scope: string;
  tier: 'P0' | 'P1' | 'P2'; built: boolean;
  opens: 'view' | 'dialog' | 'none';   // only 'view' is accepted after the + prefix
  write: boolean;                      // disabled in read-only; tier 2 on protected contexts
  hint: number | null;                 // hint-row priority
  menu?: string;                       // macOS menu path
  win: Binding[]; mac: Binding[]; when?: string;
}

interface Settings {
  theme: 'claude';
  mode: 'system' | 'lys' | 'mork';
  zoom: 100 | 110 | 125 | 150;         // webview zoom
  rowHeight: 20 | 28;
  hints: boolean; singleKeys: boolean; k9sMode: boolean;
  mono: 'geist' | 'jetbrains';
  killEnabled: boolean;                // default false
  logBufferLines: number;              // default 10000, range 1000..100000
  termScrollback: number;              // default 5000
  contexts: Record<string, { protected: boolean; readOnly: boolean }>;
}
interface PersistedState {
  schema: 1;
  workspaces: Record<string /* context */, Workspace>;
  parked: Record<string /* context */, Workspace[]>;   // newest first, max 4; Alt+0 swaps with [0]
  favorites: FavoriteView[]; layouts: SavedLayout[];
  nsSlots: Record<string /* context */, ({ name: string; pinned: boolean } | null)[]>;   // slots 1..9
  columns: Record<string /* gvr key */, {
    order: string[]; hidden: string[]; pinned: string[];
    widths: Record<string, number>; sort?: Sort;        // last user sort for the kind
  }>;
  keymap: Record<string /* action id */, KeymapOverride>;
  settings: Settings;
}
// Drafts are separate files: <app data>/drafts/<context>/<uid>.yaml (§13.2). Secrets are never written.
```

### 3.2 Commands

| Operation | Rule |
|---|---|
| Split | The new pane clones the current view (the watch is shared, so it is instant) and takes focus. A shell or dirty edit is not cloned; the new pane shows the parent table instead. Same-direction parent: insert a sibling and halve the source's fraction. Otherwise wrap the leaf in a new split. |
| Open in new pane | See §4.4 for the target rule. |
| Close | The fraction goes to the siblings proportionally. A split with one child is replaced by that child. Focus returns to the opener if it exists, else the MRU pane. The pane goes on the `closed` stack. Closing the last pane resets it to `home`. A pane with a live shell asks first (§4.6); a dirty edit keeps its draft and says so in a toast. |
| Reopen | Pops `closed` and re-inserts beside its former parent (or at the root if the parent is gone). Shells come back as a placeholder, which is why close confirms. An edit comes back as view with its draft offered. |
| Move | Leader `H J K L`: swap with the neighbour in that direction; at the outermost edge the pane docks at root level. MOVE mode (leader `m`) can also insert on any edge of any pane (§3.5). |
| Flip | Toggles the parent split's `dir`. |
| Equalize | Leader `=`: children of the parent split. Leader `0`: the whole tree. |
| Close others | Closes all other panes; they go on the `closed` stack. One confirm lists every live shell that would end. |
| Cap | 12 leaves per window. At the cap a split is refused with a bottom-row message. |

### 3.3 Resize

- **Divider:** 1px `--k-divider` visible, 8px hit area. Hover or drag shows 2px `--k-accent`.
- **Drag:** changes only the two adjacent children, live, no ghost. Per frame only a CSS variable on the split element changes; React does not render. Panes use `contain: strict`.
- **Snap:** 8px magnet to 1/4, 1/3, 1/2, 2/3, 3/4 of the parent. Hold Alt to disable.
- **Double-click:** equalizes that split's children. Shift+double-click equalizes the tree.
- **Keyboard:** `Alt+Shift+arrows` / `⌃⌘arrows` move the divider on that side of the focused pane by 24px. If there is no divider on that side, the opposite one moves in the same direction.
- **RESIZE mode** (leader `a`): arrows or `h j k l` move 24px, with Shift 8px. `Enter` or `Esc` leaves.
- **Clamp:** drags and keys stop at the minimums. A pane is never closed by resizing.
- **Window resize:** fractions are kept, clamped to minimums, then fold.

### 3.4 Zoom and fold

- **Zoom** sets `zoomed`; the tree is untouched. A 20px tab strip above the pane lists all panes (index + last crumb), and the header shows a `ZOOM` label. Focus keys switch which pane is zoomed.
- **Fold:** when a split cannot give every child its minimum, it shows only its MRU child with the same 20px tab strip listing the siblings. It unfolds when space returns. A bottom-row message says `folded: 3 panes (F6 cycles)`.
- **One strip per pane.** If the shown child of a folded split is itself a folded split, the strips merge into one that lists every leaf under the outer split. A pane never carries more than one strip.
- **Budget.** The strip takes 20px from the pane, which is one table row. Minimum pane sizes are measured below the strip.
- **Direct pick.** Strip items show the pane index. Leader `1`..`9` focuses that pane, which also unfolds or zooms to it. `F6` cycles.
- Folded and zoomed-out panes keep their watch for 30s, then pause. The last snapshot is kept and marked stale, and resyncs when shown. Shells and log streams in hidden panes keep running.

### 3.5 Drag to rearrange (mouse parity)

- Drag a pane header, 6px threshold, `Esc` cancels.
- Drop on the outer 25% of a target's edge (capped at 160px) to insert on that side. Drop on the centre to swap.
- Preview: a 2px `--k-accent` outline on the zone, no fill. Nothing moves until drop.
- **Keyboard equivalent, MOVE mode** (leader `m`, sticky): `h j k l` or arrows pick a target pane, shown with the same outline. `H J K L` inserts the moving pane on that edge of the target. `Enter` swaps with the target. `Esc` cancels. Leader `H J K L` stays as the one-step swap.

### 3.6 Persistence

- The Rust side writes `PersistedState` as JSON in the app config directory: debounced 500ms, atomic rename, schema checked on load. An unknown schema falls back to defaults and keeps the file as `.bak`.
- **Startup:** the frame and pane tree paint from the JSON before any cluster call. Tables show `syncing` until the first snapshot.
- **First-run layout** (namespace `*` everywhere):

| Width | Panes |
|---|---|
| Under 1600 | `pods` |
| 1600–2600 | `pods` \| `events` with the warning chip |
| Above 2600 | `home` rail 240 \| `pods` \| `:flux` \| `events` with the warning chip |

| View | Restore rule |
|---|---|
| Table, containers | Resubscribe; cursor restored by uid or container name |
| Doc (view) | Refetch; if the object is gone, an empty state with `Esc` back |
| Doc (edit, review) | Restored as view. The draft file is offered: `draft from 12:04 · Enter resume · Backspace discard` (P0) |
| Logs | Reattach with a tail and a gap marker; workload targets re-resolved |
| Shell, attach | Placeholder with `Enter reconnects`. The app never execs on startup or on layout recall |
| Port-forwards | Not restarted (P1 opt-in) |

## 4. Navigation, modes and flow

### 4.1 Modes

| Badge | Enter | Leave | Single keys |
|---|---|---|---|
| NORMAL | default | | Active |
| FILTER | `/`, `Ctrl/⌘+F` | `Enter` applies, `Esc` cancels | Inactive (input) |
| COMMAND | `:` | `Enter` runs, `Esc` cancels | Inactive (input) |
| NEW → / NEW ↓ | `+` / `+ +` | The next view-opening action, or `Esc` | Active; a key that does not open a view cancels the prefix and is not executed |
| PANE | `Ctrl+.` / `⌘.` | One command key, or `Esc` | Only leader keys; Ctrl/⌘ ignored |
| RESIZE | leader `a` | `Enter`, `Esc` | Only resize keys |
| MOVE | leader `m` | A drop key, `Enter`, `Esc` | Only move keys |
| TERM | Focus in a shell pane | Pane chords | Go to the shell |
| COPY | `Ctrl+Shift+Space` / `⌘⇧Space` in TERM | `y`, `Esc` | Only copy-mode keys |
| EDIT | `e` | `Esc` (confirms if dirty) | Go to the editor |
| REVIEW | `Ctrl/⌘+S` in EDIT | `Enter` applies, `Esc` back to EDIT | Only review keys |
| RO | `:ro on` | `:ro off` | Write keys disabled |

The prefix has no timeout. `+` pressed once shows `NEW →`; a second `+` switches to `NEW ↓`; a third cancels.

After the prefix, the key is resolved in the focused scope. Only an action whose registry entry has `opens: 'view'` runs. `s` on a deployment (scale, a dialog) or `u` on a node (uncordon) cancels the prefix and does nothing, with the message `+ s: scale does not open a view`.

### 4.2 Esc precedence (first match wins)

1. Pending prefix, leader, RESIZE or MOVE: cancel.
2. Dialog: cancel.
3. Overlay (palette, help, pickers, column menu, context menu): close.
4. FILTER or COMMAND input: leave, restoring the applied filter.
5. Doc or log search bar open: close it.
6. A line selection exists (doc view, logs): clear it.
7. Marks exist: clear marks.
8. Filter or faults chips exist: remove the last one.
9. View stack deeper than 1: back.
10. Root: no-op.

In TERM, Esc goes to the shell; in COPY it leaves copy mode. In EDIT, Esc closes the search bar, then collapses multiple cursors, then leaves edit mode.

### 4.3 Drill-down, back and history

- `Enter` pushes the child view from the table below. `d`, `y`, `e`, `l`, `p`, `s` and the other view keys push in place, as in k9s. `Esc` pops.

| Row kind | `Enter` opens |
|---|---|
| Deployment, StatefulSet, DaemonSet, ReplicaSet, Job | Pods, scoped by owner |
| Pod | Containers view (§12.5) |
| Container | Logs of that container |
| CronJob | Jobs, scoped by owner |
| Node | Pods, scoped by node |
| Service | Pods, scoped by selector; describe if it has no selector |
| Namespace | Pods in that namespace (`u` only switches the pane's namespace) |
| CRD (the definition) | Instances of that kind |
| Event | Describe of the involved object |
| Port-forward row | The target's table with the cursor on it |
| Home and alias rows | That view |
| Everything else (ConfigMap, Secret, PVC, PV, Ingress, CRD instances, Flux kinds) | Describe. A Secret is never decoded by `Enter` |

- **Three back keys, three effects.**

| Key | Effect on `index` | Touches filters and marks |
|---|---|---|
| `Esc` | Runs the §4.2 ladder; only its step 9 does `index − 1` | Yes: clears marks, then chips, before it goes back |
| `,` (and `[`) | Always `index − 1`; `.` is `index + 1` | Never |
| `Backspace` | Goes to the parent crumb. If the previous entry is that parent, `index − 1`; otherwise it pushes the parent view with the cursor on the object | Never |

- `-` toggles the last view.
- **What pushes.** `Enter`, view keys, `:` jumps, favourites and palette results push an entry. A namespace switch, filter, sort or faults change edits the current entry and does not push. A push from mid-stack truncates the forward entries.
- Breadcrumbs: `namespace / resource / object / view`. Each segment is clickable.
- Each pane has its own history (50 entries), namespace, filter, sort and cursor.

### 4.4 Open in a new pane

- `+` then any action with `opens: 'view'`. With everything built that is: `nav.open`, `res.describe`, `res.yaml`, `res.edit`, `res.logs`, `res.logsPrevious`, `pod.shell`, `pod.attach`, `pf.list`, `res.usedBy`, `res.owner`, `pod.node`, `deploy.replicaSets`, `secret.decode`, `command.open`, `fav.picker`, `palette.open`, `fav.viewN`. Unbuilt ones are not accepted.
- Feature tools (docs/plan-features.md §2.7) add: `hub.open`, `res.why`, `res.timeline`, `res.diff`, `res.relations`, `res.reach`, `res.pack`, `trap.list`, `logs.patterns`, `logs.goToPod`, `dev.picker`, `picker.devEdit`, `dev.fromWorkload`, `agents.open`. Plain keys open them in place; the `+` prefix opens beside. Exceptions: `logs.patterns` always opens beside (in place would stop the source stream, §4.6), and a view an agent shows (`show_in_kns`) always opens beside, labelled AGENT. A `why` pane opened beside follows the source cursor like describe; `timeline` is pinned.
- Direct chords for `Enter` on table rows, palette rows, picker rows and in the `:` input: `Ctrl/⌘+Enter` (right), `Alt/⌥+Enter` (below).
- Mouse: `Ctrl/⌘`+click or middle-click (right); `Ctrl/⌘+Shift`+click (below).

Target rule:
1. If a pane linked to this source has `follow = true` and shows the same view kind and, for docs, the same `format`, retarget it. So `+ d` reuses a following describe, but `+ y` after `+ d` opens a second pane.
2. Pinned panes (`follow = false`) are never reused. That covers logs, shells and edits by default, and any doc pane the user unfollowed.
3. Otherwise split the focused pane in the prefix direction.
4. If that breaks the minimum, the split still happens and folds (§3.4).
5. At 12 leaves, refuse with a message.

Focus rule: the new pane takes focus. Exception: a following doc pane (describe or YAML) leaves focus on the source, because following only matters while the source cursor moves. [ours, owner-reversible]

### 4.5 Follow link

- A pane opened with the prefix is linked to its source (`link.source`).
- Describe and YAML follow the source cursor by default: 150ms debounce, in-flight request cancelled, scroll reset. Logs, shell and edit are pinned.
- Leader `f` toggles follow. The header shows `<- N` and `FOLLOW`.
- Entering EDIT in a following pane pauses follow until the edit ends.

Edge cases:

| Case | Rule |
|---|---|
| Source pane closed | `link.source` becomes null, follow turns off, the pane keeps its target. The `<- N` label goes |
| Source navigates to another table | Follow continues with the new table's cursor |
| Source shows a non-table view | Follow pauses and keeps the last target; it resumes when a table or containers view returns |
| Marks in the source | Ignored. Follow tracks the cursor row only |
| Source table empty | The follower keeps its last target |
| `paneSelection` log or shell target | Resolved once, when the pane opens or the layout is recalled and the source has a cursor row. It is then pinned to that object. Until then the pane shows `waiting for a selection in pane N` |
| Follow turned on for a logs pane | The stream restarts on the new cursor row after 500ms, with a gap marker |
| Shell pane | Cannot follow. Leader `f` is disabled there |

### 4.6 Live sessions and held panes

A **live session** is a running shell or attach, or an EDIT buffer with unsaved changes. The rules below are the whole lifetime model.

| Event | Shell or attach | Dirty edit |
|---|---|---|
| In-place navigation from the pane (`Ctrl/⌘+1..9`, palette `Enter`, `:` result) | The pane is held: the view opens in a new pane to the right instead | Same |
| Therefore, in history | A live session is only ever the current entry, never below another view | Same |
| `Ctrl/⌘+W`, leader `x`, `:close` | Dialog: `Ends the shell in web-7d9f8 · Enter end · Esc keep` | Closes; the draft file stays; toast `draft kept` |
| Close others, window close, quit | One dialog listing all shells that would end | Drafts stay |
| Layout recall, context switch | The workspace is parked with its shells still running | Stays open in the parked workspace |
| Parked workspace evicted (a fifth is parked) | Dialog listing its shells; `Esc` cancels the recall | Drafts stay |
| Session ends by itself | Pane keeps scrollback, shows `session ended · Enter reconnects`; `Esc` now pops | — |
| Secret edit (never written to disk) | — | Close, park eviction and quit ask: `Enter` discards, `Esc` stays |

- A log stream runs only while its view is the current entry of its pane. When the view leaves, the buffer is kept for 30s; returning later reattaches with a tail and a gap marker.
- At most 8 live shells per app. The ninth is refused with a message. [ours]
- Parked workspaces pause their watches after 30s, like folded panes.

## 5. Keymap

### 5.1 Matching rules

1. Bindings match the produced character (`event.key`), not the physical key.
2. For symbols Shift is ignored, because the character already encodes it. On a Norwegian layout: `/` is Shift+7, `:` Shift+., `?` Shift++, `!` Shift+1, `*` Shift+', `>` Shift+<. Unshifted: `+`, `,`, `.`, `-`, `'`, `<`.
3. Letters are case-sensitive. Case comes from `shiftKey`, so CapsLock is ignored.
4. **AltGr is checked first.** If `event.getModifierState('AltGraph')` is true, the event is text. It is never matched against a chord. It goes to the focused input, editor or terminal, and in NORMAL its character can match a single-key binding (`[` `]`). On Windows, if the AltGraph state is not reported, `ctrlKey && altKey` with a printable `key` is treated the same way [verify in WebView2]. No default uses Ctrl+Alt on Windows.
5. **Exact modifier sets.** A chord matches only when the pressed modifiers equal the declared ones (Shift on symbols aside). `Alt+8` needs Alt alone; `Ctrl+8` needs Ctrl alone. So AltGr+8, which arrives as Ctrl+Alt+Digit8, matches neither even if rule 4 fails.
6. **Left Alt only.** On layouts with AltGr, the right Alt key is AltGr and can never trigger `Alt+…` chords. The help overlay says so.
7. On macOS, Option plus a printable key produces a character. Defaults with ⌥ use only arrows, Enter or digits, plus one exception: ⌥ with the physical keys H, J, K, L (`event.code`) is the chord `Alt+H/J/K/L` (pane focus, as on Windows), never the character (˙ ∆ ˚ ¬).
8. `Ctrl/⌘`+letter matches the lowercase `event.key`, falling back to `event.code` for non-Latin layouts.
9. Modifier+digit (`Ctrl/⌘+1..9`, `Alt+0..9`, `⌥⌘0..9`) matches `event.code` Digit0..9 under rule 5. This is the one exception to rule 1 and is evaluated before rule 10.
10. `Ctrl/⌘` with `+` also accepts `=`, but only when `event.code` is not a digit key. `Ctrl+Shift+0` on a Norwegian layout (which produces `=`) therefore matches nothing; `Ctrl/⌘+Shift+digit` is unbound.
11. In PANE mode the second key is matched with Ctrl and ⌘ ignored, so a still-held `Ctrl+R` after `Ctrl+.` is `r`. The key is consumed in every scope, including TERM.
12. Dead keys are never bound. Events during IME composition are ignored.
13. All webview accelerators are disabled (reload, find, print, zoom, caret browsing, history) and the context menu is our own. On Windows a bare Alt press is suppressed [verify]. Fallbacks if this fails are in §5.8.

### 5.2 When single keys are inactive

| Context | Single keys | Tab | App chords that still work |
|---|---|---|---|
| NORMAL | Active | Next pane | All |
| Filter input (tables) | Typed | Cycles the mode chip: RE, NOT, LABEL, FUZZY | All `Ctrl/⌘` chords except text-editing ones |
| Search input (logs, doc view, EDIT) | Typed | Cycles the mode chip: RE, NOT, FUZZY | Same |
| Completion inputs: palette, `:` command, every picker | Typed | Accepts the ghost completion | Same, plus picker chords |
| Dialog | Typed if a text field has focus | Moves focus | `Enter`, `Esc`, arrows, `Space` |
| EDIT | Typed | Indents | §5.3 |
| TERM | To the shell | To the shell | §5.3 |
| Setting "single keys off" | Inactive everywhere | Next pane | All; every action stays reachable through the palette |

- Tab has exactly two input meanings: complete (completion inputs) and cycle mode (filter and search inputs). Nothing else.
- The `'` favourites picker is the palette with the `'` prefix already typed. It is one component and one Tab rule. It has no sections to switch; Views, Layouts and Parked are groups in one list.
- Text-editing chords in any input belong to the input: `Ctrl/⌘+A/C/X/V/Z`, `Ctrl+Backspace` / `⌥⌫`, `⌘⌫`, `Ctrl/⌥+←/→`.

### 5.3 Terminal and editor scopes

**TERM, Windows.** The app owns exactly this list; every other key event goes to xterm.js:

| App keeps | Goes to the shell |
|---|---|
| `Ctrl+.` (leader) and the key after it | Bare `Ctrl`+letter, `Ctrl+Space`, `Ctrl+[ ] \ ^ _ @` |
| `Ctrl+Shift`+letter chords, `Ctrl+Shift+Enter`, `Ctrl+Shift+Space` | `Ctrl+Backspace`, `Ctrl+Enter`, `Ctrl+Tab` |
| `Ctrl+1..9` (opens beside, §4.6), `Ctrl+,` | `Ctrl++`, `Ctrl+-`, `Ctrl+0` (zoom is `:ui` or leader-free elsewhere) |
| `Alt+arrows`, `Alt+h/j/k/l` (pane focus), `Alt+Shift+arrows`, `Alt+0..9`, `Alt+Enter` | Every other `Alt`+key, every AltGr key |
| `F1`, `F5`, `F6`, `Shift+PgUp/PgDn`, `Shift+F10` | `Tab`, `Esc`, arrows, plain keys |

Consequences: close is leader `x`, palette is `Ctrl+Shift+P` or leader `p`, namespace picker is leader `n`.

**TERM, macOS.** Every `⌘` chord belongs to the app, and so does `⌥h/j/k/l` (pane focus). `Ctrl`+key goes to the shell.

**Norwegian characters.** `[ ] { } | \ @ $` need AltGr on Windows and Option on macOS.
- xterm.js runs with `macOptionIsMeta: false`. Option composes characters; there is no Meta key by default, and `Esc` works as the Meta prefix. A setting can turn Option-as-Meta on for users with another layout [ours].
- AltGr events pass through TERM untouched (rule 4), so they reach xterm.js as text.
- EDIT binds no `⌥`+printable chord on macOS and no Ctrl+Alt chord on Windows. CodeMirror defaults of that shape are not installed.

**EDIT (CodeMirror 6).** The app installs its own keymap instead of CodeMirror's defaults wholesale. The CodeMirror defaults named here are from recall [verify].

| Chord | Winner | Result |
|---|---|---|
| `Ctrl/⌘+F`, `F3`, `Ctrl/⌘+G` | App | The header search bar (the same one `/` opens in view mode), next match. CodeMirror's own search panel is not used |
| `Ctrl/⌘+D` | Editor | Select next occurrence (multi-cursor) |
| `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z`, `Ctrl+Y` | Editor | Undo, redo. The app's undo-last-action is NORMAL only |
| `Ctrl/⌘+A`, `Ctrl/⌘+C/X/V`, `Ctrl/⌘+/` | Editor | Select all, clipboard, toggle comment |
| `Ctrl/⌘+Enter` | Editor | Insert blank line |
| `Alt+arrows` (Windows) | App | Pane focus. Move line is `Ctrl+Shift+PgUp/PgDn` |
| `⌥↑/↓` (macOS) | Editor | Move line (pane focus is `⌥⌘arrows`) |
| `Ctrl+Shift+↑/↓` / `⌃⌥↑/↓` | Editor | Add cursor above / below. Not `⌃⇧↑/↓` on macOS (Mission Control) and not `Ctrl+Alt+arrows` on Windows (AltGr pair) |
| `Ctrl/⌘+Shift+K` | App | Context picker. Delete line is unbound |
| `Ctrl/⌘+Shift+L` | App | Save layout. Select all matches is unbound |
| `Ctrl/⌘+S` | App | Review |
| `Ctrl/⌘+W`, `Ctrl/⌘+K`, `Ctrl/⌘+N`, leader, `F6` | App | As global |
| Fold chords with `[` `]` | Replaced | `Ctrl/⌘+Shift+O` fold toggle, `Ctrl/⌘+Shift+U` fold all toggle |

### 5.4 Complete keymap

"leader" is `Ctrl+.` on Windows and `⌘.` on macOS. `same` means identical to the Windows column. An id with no tag is P0.

**Tiers and the parity rule.** Every action carries `tier` and `built`. While `built` is false the action is left out of the hint row, the `?` overlay, the palette, the leader panel, context menus and the macOS menu, and its key is unbound. The `?` overlay ends with a plain text list, "k9s actions not in kns yet", with no key chips. P1 and P2 rows below are designs, not promises.

**Rebinding.** Every id is rebindable, including the leader and each leader sub-key (they are sequences such as `['leader','r']`). An action can hold several bindings and sequences per platform (§3.1).

- **Conflicts.** The editor rejects a binding that equals, or is a prefix of, another binding on the same platform whose scope overlaps. It names the other action and offers replace (unbind the other), swap or cancel.
- **Reserved.** `Esc`, dialog `Enter`, and the OS chords `⌘Q` `⌘H` `⌘M` `Alt+F4` cannot be reassigned.
- **Reset.** `r` resets one action, `:keys reset` resets all after a confirm. The k9s-mode preset sits under user overrides.

**macOS menu.** Menu key equivalents run before the webview, so:
- Only bindings that include `⌘` (or an F-key) become key equivalents. Single keys and `:` commands appear as text after the item title and are not equivalents, so they never fire while typing.
- A menu item dispatches the action id through the registry with the same `when` check. Items are disabled when the scope does not apply.
- Edit-menu Undo, Redo, Cut, Copy, Paste and Select All use the standard responder actions, so they reach the focused input, editor or terminal. Tauri support for live enable state is [verify].

#### Global and window

| Action id | Windows | macOS | Scope | k9s |
|---|---|---|---|---|
| palette.open | `Ctrl+K`, `Ctrl+Shift+P`, leader `p` | `⌘K`, `⌘⇧P`, leader `p` | global (TERM on Windows: not `Ctrl+K`) | none |
| command.open | `:` | same | pane normal | `:` |
| filter.open | `/`, `Ctrl+F` | `/`, `⌘F` | table, containers, logs, doc view | `/` |
| help.overlay | `?`, `F1` | same | global (`F1` in TERM and EDIT) | `?` |
| menu.open | `Shift+F10`, `Menu` | `⇧F10` | global; the menu lists the same actions as the hints | none |
| context.pick | `Ctrl+Shift+K` | `⌘⇧K` | global | `:ctx` |
| context.pickPane | `leader C` | `leader C` | global | `:pane ctx` |
| context.protect | `:protect on\|off`; `Ctrl+T` in the context picker | `:protect on\|off`; `⌘T` in the picker | command, context picker | none |
| namespace.pick | `Ctrl+N`, leader `n` | `⌘N`, leader `n` | global (TERM on Windows: leader `n`) | `:ns` |
| namespace.pickAllPanes | `Ctrl+Shift+N` | `⌘⇧N` | global | none |
| namespace.all | `0` | same | namespaced table | `0` |
| namespace.favN | `1`..`9` | same | namespaced table | `1`..`9` |
| namespace.use | `u` | same | table:namespaces | `u` |
| fav.picker | `'` | same | pane normal | none |
| fav.viewN | `Ctrl+1..9` | `⌘1..9` | global | none |
| fav.layoutN | `Alt+1..9` | `⌥⌘1..9` | global | none |
| fav.layoutPrevious | `Alt+0` | `⌥⌘0` | global | none |
| fav.saveView | `Ctrl+Shift+S` | `⌘⇧S` | global | none |
| fav.saveLayout | `Ctrl+Shift+L` | `⌘⇧L` | global | none |
| aliases.show | `Ctrl+Shift+A`, `:alias` | `⌘⇧A`, `:alias` | global | ctrl-a |
| home.open | `:home` | same | command | none |
| flux.notReady | `:flux!` | same | command | none |
| pf.open | `:pf` | same | command | `:pf` |
| messages.open | `:errors` | same | command | none |
| conn.reconnect | `F5`, `:reconnect` | same | global | automatic |
| hints.toggle | `Ctrl+E` | `⌘E` | global | ctrl-e |
| settings.open | `Ctrl+,` | `⌘,` | global | none |
| ui.zoomIn / zoomOut / zoomReset | `Ctrl++` / `Ctrl+-` / `Ctrl+0`; `:ui 100\|110\|125\|150` | `⌘+` / `⌘-` / `⌘0`; same command | global (TERM on Windows: command only) | none |
| undo.lastAction | `Ctrl+Z` | `⌘Z` | NORMAL only, while an undo toast is live; undoes the newest | none |
| toast.dismiss | `Ctrl+Shift+X` | `⌘⇧X` | global | none |
| window.fullscreen | `F11` | `⌃⌘F` | global | none |
| window.close | (none; same as quit) | `⌘⇧W` | global | none |
| app.quit | `Alt+F4`, `:q` | `⌘Q`, `:q` | global | `:q`, ctrl-c |
| app.readOnly | `:ro on\|off` | same | command | `--readonly` |
| app.killSwitch | `:kill on\|off` | same | command | none |
| app.theme / mode / density | `:theme`, `:mode`, `:rows 20\|28` | same | command | skins |

#### Panes

| Action id | Windows | macOS | Scope | k9s |
|---|---|---|---|---|
| pane.leader | `Ctrl+.` | `⌘.` | global | none |
| pane.newPrefixRight | `+` | same | pane normal | none |
| pane.newPrefixDown | `+ +` | same | pane normal | none |
| open.newPaneRight | `Ctrl+Enter` | `⌘Enter` | table, palette, pickers, `:` input | none |
| open.newPaneDown | `Alt+Enter` | `⌥Enter` | table, palette, pickers, `:` input | none |
| pane.splitRight / splitDown | leader `r` / `d`; `:split r\|d` | same | leader | none |
| pane.focusLeft/Down/Up/Right | `Alt+←↓↑→`, `Alt+h j k l`; leader `h j k l` or arrows | `⌥⌘←↓↑→`, `⌥h j k l`; same leader keys | global | none |
| pane.next / previous | `Tab` / `Shift+Tab`; `F6` / `Shift+F6` | same | Tab: pane normal; F6: global | none |
| pane.last | leader, leader | same | leader | none |
| pane.focusN | leader `1`..`9` | same | leader (also picks a folded or zoomed-out pane) | none |
| pane.moveLeft/Down/Up/Right | leader `H J K L` | same | leader | none |
| pane.moveMode | leader `m` | same | leader | none |
| move.target / insertEdge / swap / cancel | `h j k l` or arrows / `H J K L` / `Enter` / `Esc` | same | move | none |
| pane.resizeLeft/Down/Up/Right | `Alt+Shift+←↓↑→` | `⌃⌘←↓↑→` | global | none |
| pane.resizeMode | leader `a` | same | leader | none |
| resize.step / fine / done | arrows or `h j k l` / with Shift / `Enter`, `Esc` | same | resize | none |
| pane.zoom | `Ctrl+Shift+Enter`; leader `z` | `⌘⇧Enter`; leader `z` | global | `f` in logs |
| pane.equalize / equalizeAll | leader `=` / leader `0` | same | leader | none |
| pane.flipSplit | leader `t` | same | leader | none |
| pane.followToggle | leader `f` | same | leader | none |
| pane.fitToTable (P1) | leader `i` | same | leader | none |
| pane.close | `Ctrl+W`; leader `x` | `⌘W`; leader `x` | global (TERM on Windows: leader `x`) | none |
| pane.closeOthers | leader `o`; `:only` | same | leader | none |
| pane.reopenClosed | `Ctrl+Shift+T`; leader `u` | `⌘⇧T`; leader `u` | global | none |

Pane numbers appear in pane headers only while PANE mode is active; tab strips always show them.

**Focus algorithm (`Alt+arrows`).** It is geometric, not tree-based.
1. Candidates are the visible panes that share the focused pane's edge on that side and overlap it on the other axis.
2. The candidate that contains the focused pane's cursor coordinate on the other axis wins (the cursor row's y for left and right, the pane's centre x for up and down). With no such candidate, the largest overlap wins; ties go to MRU.
3. No wrap. At the window edge the key does nothing.
4. A folded split counts as one pane (its shown child). Hidden siblings are reached with `F6` or leader digits.
5. While zoomed, left and up go to the previous pane index and right and down to the next, wrapping.

#### Navigation and table

| Action id | Windows | macOS | Scope | k9s |
|---|---|---|---|---|
| nav.down / up | `j` / `k`, `↓` / `↑` | same | table, lists, doc view, logs | `j` `k` |
| nav.scrollLeft / Right | `←` / `→`; `h` / `l` only on kinds with no logs action | same | table. `h` and `l` scroll as a pair or not at all | `h` `l` |
| nav.top / bottom | `g` / `G`, `Home` / `End` | same | table, logs, doc view | `g` `G` |
| nav.pageUp / Down | `PgUp` / `PgDn`, `Ctrl+↑` / `Ctrl+↓` | `PgUp` / `PgDn`, `⌃B` / `⌃F` | table, lists, logs, doc view | ctrl-b / ctrl-f |
| nav.open | `Enter` | same | table, containers, home, aliases | enter |
| nav.back | `Esc` | same | pane normal | esc |
| nav.crumbUp | `Backspace` | `⌫` | pane normal | none |
| history.back / forward | `,` / `.`; `[` / `]` | same | pane normal | `[` `]` |
| history.last | `-` | same | pane normal | `-` |
| filter.clear | `Esc` | same | pane normal | ctrl-u, ctrl-q |
| filter.cycleMode | `Tab` | same | filter input, search input | typed prefixes |
| filter.clearText | `Ctrl+U` | `⌃U` | filter input | ctrl-u |
| filter.chipFocus / remove | `←` `→` in an empty input / `Backspace` | same | filter input | none |
| filter.faults | `!` | same | table | ctrl-z |
| view.refresh | `Ctrl+R` (also reconnects a stale watch) | `⌘R` | pane normal | ctrl-r |
| view.wide | `*` | same | table | ctrl-w |
| view.columns | `Ctrl+Shift+M` | `⌘⇧M` | table | none (views.yaml) |
| columns.move / toggle / pin / reorder / fit / reset | `j` `k` / `Space` / `p` / `J` `K` / `f` / `r` | same | column menu | none |
| column.narrower / wider | `<` / `>` (8px; acts on the selected column) | same | table, column menu | none |
| view.saveToFile (P1) | `Ctrl+S` | `⌘S` | table, logs | ctrl-s |
| sort.name / age / status / namespace | `N` / `A` / `S` / `P` | same | table (`P` only in all namespaces) | shift-n/a/s/p |
| sort.selectedColumn | `O` | same | table | shift-o |
| column.selectLeft / Right | `Shift+←` / `Shift+→` | same | table | shift-left/right |
| mark.toggle | `Space` | same | table | space |
| mark.range | `Shift+Space`, `Shift+↓` / `Shift+↑` | same | table | ctrl-space |
| mark.all | `Ctrl+A` | `⌘A` | table | none |
| mark.clear | `Esc` | same | table | ctrl-\ |
| copy.name / namespace | `c` / `n` | same | table (`c` is cordon on nodes once built) | `c` / `n` |
| copy.cell | `Ctrl+C` | `⌘C` | table | none |

`copy.cell` copies the cell at the cursor row and the selected column. The selected column defaults to NAME. With marks it copies that column for every marked row, one per line. There is no separate cell cursor.

#### Resource actions

| Action id | Windows | macOS | Scope | k9s |
|---|---|---|---|---|
| res.describe | `d` | same | table, containers | `d` |
| res.yaml | `y` | same | table | `y` |
| res.edit | `e` | same | table, doc view | `e` |
| res.delete | `Ctrl+Backspace`, `Delete` | `⌘⌫` | table | ctrl-d |
| pod.kill (needs `:kill on`) | `Ctrl+Shift+Backspace` | `⌘⇧⌫` | table:pods | ctrl-k |
| res.logs / logsPrevious | `l` / `p` | same | pod, container, deploy, sts, ds, job, svc | `l` / `p` |
| pod.shell | `s` | same | pod, container | `s` |
| pod.attach (P1) | `a` | same | pod, container | `a` |
| workload.scale | `s` | same | deploy, sts, scalable CRDs | `s` |
| workload.restart | `r` | same | deploy, sts, ds | `r` |
| workload.setImage (P1) | `i` | same | pod, deploy, sts, ds | `i` |
| deploy.replicaSets | `z` | same | deploy | `z` |
| rs.rollback (P1) | `Ctrl+L` | `⌘L` | replicasets | ctrl-l |
| cronjob.trigger / suspend | `t` / `s` | same | cronjobs | `t` / `s` |
| pf.start / list | `F` / `f` | same | pod, container, svc, workloads | shift-f / `f` |
| pf.stop | `Ctrl+Backspace`, `Delete` | `⌘⌫` | port-forwards | ctrl-d |
| pf.copyAddress | `c` | same | port-forwards | none |
| secret.decode | `x` | same | secrets | `x` |
| res.usedBy (P1) | `u` | same | secret, cm, pvc, sa | `u` |
| res.owner | `J` | same | table | shift-j |
| pod.node | `o` | same | pods | `o` |
| res.warp (P2, undefined) | `w` | same | table | `w` (research §6.3) |
| node.cordon / uncordon / drain (P1) | `c` / `u` / `r` | same | nodes | `c` / `u` / `r` |
| pod.transfer / sanitize (P1) | `t` / `z` | same | pods | `t` / `z` |
| flux.suspendResume | `T` | same | Flux kinds | plugin shift-t |
| flux.reconcile | `R` | same | Flux kinds | plugin shift-r |
| flux.reconcileWithSource | `Ctrl+Shift+R`; `:reconcile source` | `⌘⇧R`; same command | Flux kinds | none |
| flux.trace (P1) | `Q` | same | Flux-managed objects | plugin shift-q |

`res.warp` is listed in research §6.3 but not in the §2 inventory, and its k9s behaviour was not source-checked. It stays unbuilt and hidden until it is verified and specified.

#### Logs, doc, editor, review, terminal

| Action id | Windows | macOS | Scope | k9s |
|---|---|---|---|---|
| logs.autoscroll / wrap / timestamps | `s` / `w` / `t` | same | logs | same |
| logs.fullscreen (= pane.zoom) | `f` | same | logs | `f` |
| logs.tail / head / since | `0` / `1` / `2`..`6` | same | logs | same |
| logs.mark / clear / allContainers | `m` / `C` / `a` | same | logs | `m` / shift-c / `a` |
| logs.copy / previous | `c` / `p` | same | logs (`c` copies the selection if one exists) | `c` / `p` |
| logs.containerPicker | `o` | same | logs | none |
| logs.expandLine | `Enter` | same | logs | none |
| logs.filterLines | `F`; `Shift+Enter` in the search input | same | logs | `/` filter |
| search.next / previous | `n` / `N` | same | logs, doc view | `n` / `N` |
| logs.resumeFollow | `End`, `G` | same | logs | none |
| select.lines | `v`, then `j` `k` extend | same | logs, doc view | none |
| select.chars | `Shift+arrows` from the line cursor | same | doc view | none |
| doc.managedFields | `m` | same | doc view (yaml) | `m` |
| doc.wrap / copy | `w` / `c` (selection, else all) | same | doc view | none |
| doc.foldToggle / foldAll | `z` / `Z` | same | doc view | none |
| doc.format (yaml ↔ json) | `Y` | same | doc view | none |
| secret.revealToggle / revealKey | `x` / `Enter` | same | doc view (secret) | `x` |
| editor.review | `Ctrl+S` | `⌘S` | edit | none (kubectl edit) |
| editor.diffGutter | `Ctrl+Shift+D` | `⌘⇧D` | edit | none |
| editor.find / findNext | `Ctrl+F` / `F3`, `Ctrl+G` | `⌘F` / `⌘G` | edit | none |
| editor.replace (P1) | `Ctrl+H` | `⌘⇧F` | edit | none |
| editor.selectNextOccurrence | `Ctrl+D` | `⌘D` | edit | none |
| editor.addCursorAbove / Below | `Ctrl+Shift+↑` / `↓` | `⌃⌥↑` / `↓` | edit | none |
| editor.moveLineUp / Down | `Ctrl+Shift+PgUp` / `PgDn` | `⌥↑` / `⌥↓` | edit | none |
| editor.foldToggle / foldAll | `Ctrl+Shift+O` / `Ctrl+Shift+U` | `⌘⇧O` / `⌘⇧U` | edit | none |
| editor.leave | `Esc` | same | edit | none |
| editor.discardConfirm / stay | `Enter` / `Esc` | same | dirty-discard dialog | none |
| review.apply / back | `Enter` / `Esc` | same | review | none |
| review.toggleSplit | `Tab` | same | review | none |
| review.rebase | `r` | same | review, on conflict | none |
| review.revealSecret | `x` | same | review of a Secret | none |
| review.suspendFlux | `T` | same | review, Flux-managed object | none |
| terminal.copy / paste | `Ctrl+Shift+C` / `Ctrl+Shift+V`; `Ctrl+Insert` / `Shift+Insert` | `⌘C` / `⌘V` | term | none |
| terminal.scrollPage | `Shift+PgUp` / `Shift+PgDn` | `⌘⇧↑` / `⌘⇧↓` | term | none |
| terminal.search | `Ctrl+Shift+F` | `⌘F` | term | none |
| terminal.copyMode | `Ctrl+Shift+Space` | `⌘⇧Space` | term | none |
| copy.move / select / yank / leave | `j` `k` `g` `G` `/` / `v` / `y` / `Esc` | same | copy mode | none |
| terminal.reconnect | `Enter` | same | term placeholder | none |

#### Overlays and dialogs

| Action id | Windows | macOS | Scope | k9s |
|---|---|---|---|---|
| list.move / accept / close | `↑` `↓` (`Ctrl+J` / `Ctrl+K` are not bound) / `Enter` / `Esc` | same | palette, pickers, help, context menu | none |
| palette.complete | `Tab` | same | palette, command input, pickers | none |
| picker.rename | `F2` | same | favourites picker | none |
| picker.delete | `Ctrl+Shift+Backspace` | `⌘⇧⌫` | favourites picker (never a text-editing chord) | none |
| picker.moveSlot | `Shift+↑` / `Shift+↓` | same | favourites picker | none |
| picker.toggleNsFavourite | `Ctrl+D` | `⌘D` | namespace picker | none |
| picker.toggleProtected | `Ctrl+T` | `⌘T` | context picker | none |
| dialog.confirm / cancel | `Enter` / `Esc` | same | dialog | enter / esc |
| dialog.nextField / previousField | `Tab` / `Shift+Tab` | same | dialog | tab |
| dialog.radioMove | `↑` `↓` on a focused radio group | same | dialog | none |
| dialog.toggle | `Space` on a focused checkbox | same | dialog | none |
| settings.move / change / cycle / filter | `j` `k` / `Enter`, `Space` / `←` `→` / `/` | same | settings view | none |
| keymap.rebind / clear / reset | `Enter` / `Backspace` / `r` | same | settings: keymap editor | none |

Favourite slots are recalled with the global `Ctrl/⌘+1..9` and `Alt+1..9` / `⌥⌘1..9`, which also work while the picker is open. Digits in the picker's query are always text, so names that start with a digit can be searched.

### 5.5 Leader panel (which-key)

Shown after 250ms in PANE mode, as an overlay anchored above the bottom row. It lists only built actions:

`r` split right · `d` split down · `h j k l` focus · `H J K L` move · `m` move mode · `1..9` pane · `a` resize · `z` zoom · `=` equalize · `0` equalize all · `t` flip · `f` follow · `i` fit (P1) · `u` reopen · `x` close · `o` close others · `p` palette · `n` namespace · leader again: last pane.

### 5.6 Collision audit

- Repeated letters live in disjoint scopes: `s` (shell, scale, suspend, autoscroll), `c` (copy name, cordon, copy log, copy doc, copy address), `u` (use namespace, used-by, uncordon; reopen after the leader), `r`, `t`, `z`, `o`, `f`, `m`, `p`, `w`, `x`, `v`.
- `N` is sort-by-name in tables and previous match in logs and doc view. `F` is port-forward in tables and filter-lines in logs.
- `0` is all-namespaces in tables, tail in logs and equalize-all after the leader. `Ctrl/⌘+0` is zoom reset; `Alt+0` / `⌥⌘0` is the last parked layout.
- `+` is the prefix; `Ctrl/⌘++` is zoom in. `.` and `,` are history; `Ctrl+.` is the leader; `Ctrl+,` is settings. `<` `>` resize a column.
- `Ctrl/⌘+D` exists only in EDIT and the namespace picker. `Ctrl/⌘+S` is one save concept per scope. `Ctrl/⌘+T` exists only in the context picker.
- `Ctrl/⌘+Z` has one owner per scope: the editor in EDIT, the input in inputs, the app in NORMAL.
- `Ctrl/⌘+Shift+Backspace` is kill in the pods table and delete-favourite in the favourites picker.
- `J` is owner in tables and move-down only after the leader.
- macOS: `⌘H`, `⌘M` and `⌘Q` keep their system meaning. `⌘N` and `⌘W` are repurposed (§18).
- Uppercase table keys (`T`, `R`, `Q`, `J`, `F`, `O`, `N`, `A`, `S`, `P`) must be checked against k9s source for further Shift+letter sorts before more are added [verify].

### 5.7 k9s replacements and k9s-mode

| k9s key | kns default | Why |
|---|---|---|
| ctrl-d delete | `Ctrl/⌘+Backspace`, `Delete` | Unconfirmed delete in k9s |
| ctrl-k kill | `Ctrl/⌘+Shift+Backspace`, off by default | Collides with the palette |
| ctrl-w wide | `*` | Close convention |
| ctrl-z faults | `!` | Undo |
| ctrl-a aliases | `Ctrl/⌘+Shift+A` | Select all |
| ctrl-b / ctrl-f | `PgUp` / `PgDn`; `Ctrl+↑/↓` on Windows; `⌃B` / `⌃F` on macOS | Find, on Windows |
| ctrl-space | `Shift+Space`, `Shift+↑/↓` | macOS input-source switch |
| `[` `]` | `,` `.` (aliases kept) | AltGr on Norwegian |

**k9s-mode.** The preset restores every k9s binding in that table. "ctrl" means the physical Control key on both platforms, as in a terminal: `Ctrl` on Windows, `⌃` on macOS.

- **macOS:** nothing collides, because kns defaults use `⌘`. `⌘K`, `⌘W`, `⌘A`, `⌘Z` and `⌘F` keep their kns meaning next to `⌃K`, `⌃W`, `⌃A`, `⌃Z`, `⌃F`. `⌃Space` works only if the system input-source shortcut is off.
- **Windows:** the restored keys displace these kns bindings.

| Restored k9s key | Displaced kns action | Moves to |
|---|---|---|
| `Ctrl+K` kill (only with `:kill on`) | palette.open | `Ctrl+Shift+P`, leader `p` |
| `Ctrl+W` wide | pane.close | leader `x` |
| `Ctrl+A` aliases | mark.all | `Ctrl+Shift+A` |
| `Ctrl+Z` faults | undo.lastAction | `Ctrl+Shift+Z` |
| `Ctrl+F` page down | filter.open's second binding | `/` only |
| `Ctrl+B` page up | none | — |
| `Ctrl+D` delete (tables) | none in tables. The namespace picker and EDIT keep their own `Ctrl+D` | — |
| `Ctrl+Space` range mark | none | — |
| `Ctrl+U`, `Ctrl+Q` clear filter | none | — |

Delete and kill keep their confirm tiers in k9s-mode. Turning k9s-mode on asks once whether to also enable kill.

### 5.8 Chords the webview or OS may swallow [verify]

These are from recall, not tested. Each has a fallback that does not depend on the fix.

| Platform | Chord | Risk | Fallback if it cannot be freed |
|---|---|---|---|
| WebView2 | `Ctrl+Shift+P` | System print | Leader `p` |
| WebView2 | `Ctrl+Shift+R`, `Ctrl+R` | Reload | `:reconcile source`; `F5` |
| WebView2 | `Ctrl+F`, `Ctrl+G`, `F3` | Find bar | `/`, `n`, `N`; in EDIT `Enter` / `Shift+Enter` in the search bar |
| WebView2 | `Ctrl++`, `Ctrl+-`, `Ctrl+0` | Browser zoom | `:ui` |
| WebView2 | `Alt+←/→` | History | Leader `h` / `l` |
| WebView2 | `F6`, `F7` | Focus cycling, caret browsing | `Tab`, leader digits. `F7` is not bound |
| WebView2 | `Ctrl+Shift+C`, `I`, `J` | Devtools in dev builds | `Ctrl+Insert` copies. `I` and `J` are not bound |
| macOS | `⌃⇧↑/↓` | Mission Control | Not used; add-cursor is `⌃⌥↑/↓` |
| macOS | `⌘.` | Cocoa cancel | `⌃.` as a second leader binding |
| macOS | `⌘⇧A`, `⌘⇧L` | Services menu shortcuts | `:alias`, `:layout save` |
| macOS | `⌥⌘8` | Accessibility zoom toggle | `:layout`, the `'` picker |
| macOS | Unhandled `⌘` chords | System beep | Every bound `⌘` chord is consumed; menu equivalents cover the rest |

All WebView2 rows depend on `AreBrowserAcceleratorKeysEnabled = false` (§18.24).

## 6. Command palette, `:` and `/`

### 6.1 Palette (`Ctrl/⌘+K`)

| Prefix | Content |
|---|---|
| none | Fuzzy over resources, actions on the selection (with their keys), favourites, layouts, namespaces, contexts, panes, settings; recency-ranked |
| `:` | k9s command grammar |
| `>` | Actions only, including every live undoable action |
| `'` | Favourites, layouts and parked workspaces. Pressing `'` in NORMAL opens exactly this |
| `?` | Key search (same data as the help overlay) |

- `Enter` runs in the focused pane; `Ctrl/⌘+Enter` in a new pane right; `Alt/⌥+Enter` below.
- `Tab` accepts the ghost completion, with every prefix.
- Destructive results use the same tiers as keys (§14). RBAC-denied actions are listed disabled with the reason. Unbuilt actions are not listed.

### 6.2 `:` grammar

- `:` opens the same component in COMMAND mode, anchored in the pane header, scoped to that pane.
- `Tab` accepts the ghost completion. Completion sources: discovery short names, aliases, namespaces, contexts, favourites.
- `Ctrl/⌘+Enter` and `Alt/⌥+Enter` run the command in a new pane.

| Form | Meaning |
|---|---|
| `:po`, `:pod` | Resource by alias |
| `:po ns` | In namespace `ns` |
| `:pod app=x` | Label selector |
| `:pod /re` | With regex filter |
| `:pod -f fz` | With fuzzy filter |
| `:pod @ctx` | Pods of context `ctx` in the focused pane only (§8.3): the pane restarts its history there. With `+` / `Ctrl/⌘+Enter` they open in a new pane beside it. `:ctx` switches the whole window (`@` typed with AltGr; only here) |
| `:ns [name]`, `:ctx [name]` | Switch, or open the picker |
| `:pane ctx [name]` | The focused pane's context (§8.3), or the picker in pane mode (`leader C`) |
| `:ev`, `:pf`, `:alias`, `:home`, `:errors` | Views |
| `:flux`, `:flux!` | All Flux kinds in one table; `!` shows not-ready only |
| `:reconcile [source]` | Flux reconcile of the cursor row, optionally with its source |
| `:split r\|d`, `:close`, `:only`, `:zoom`, `:equal` | Pane commands |
| `:fav <name>`, `:fav save <name> [slot]` | Favourite views |
| `:layout <name>`, `:layout save <name> [slot]` | Layouts |
| `:theme claude`, `:mode system\|lys\|mork`, `:ui 100\|110\|125\|150`, `:rows 20\|28` | Appearance |
| `:ro on\|off` | Read-only for the current context |
| `:protect on\|off` | Protected flag for the current context. Turning it off is tier 2 (type the context name) |
| `:kill on\|off` | Enables the kill action. Turning it on is tier 2 |
| `:reconnect` | Rebuild the client and resync |
| `:keys`, `:keys reset`, `:q` | Keymap editor, reset bindings, quit |

### 6.3 `/` filter

- The field opens inside the pane header (20px, replaces the crumbs while editing). `Enter` turns the text into a chip.
- `Tab` cycles the mode: `RE`, `NOT`, `LABEL`, `FUZZY`. The typed k9s prefixes still work: `!re`, `-l sel`, `-f fz`.
- Filtering is live while typing. `LABEL` restarts the watch with `labelSelector` on `Enter` only.
- Several chips combine with AND. `Esc` in NORMAL removes the last chip. With the input open and empty, `←` `→` focus a chip and `Backspace` removes it.
- In logs and doc view `/` is search: matches are highlighted, `n` / `N` step. `Tab` cycles `RE`, `NOT`, `FUZZY` there too.
- In logs, `Enter` applies the search as highlight and `Shift+Enter` applies it as filter-lines. `F` in NORMAL toggles filter-lines on the current search. `NOT` always filters lines, since there is nothing to highlight.
- EDIT uses the same header bar through `Ctrl/⌘+F`. There is one search UI for the editor in both modes.

## 7. Favourites

### 7.1 Saved views

- Content: resource, namespace (a name, `*`, or "current"), filters, faults, sort, wide.
- "Current" is stored as `{ current: true }` and resolves to the target pane's namespace at recall. The save dialog has a checkbox for it; the default is the concrete namespace.
- **Save:** `Ctrl/⌘+Shift+S`. The dialog has a name field prefilled from the crumbs and a slot field prefilled with the next free slot (or none when all nine are taken). Name + `Enter` is enough.
- **Occupied slot:** the dialog names the occupant. `Enter` then asks `replace slot 3 (warnings)?`. The old favourite stays in the list without a slot.
- **Recall:** `Ctrl/⌘+1..9` in the focused pane; `+` first for a new pane; `:fav name`; palette. In a held pane (§4.6) it opens beside.
- When the current view matches a favourite, the pane header shows `FAV 3`.

### 7.2 Saved layouts

- Content: split tree, sizes, one view per pane, links and follow flags, focused pane.
- **Save:** `Ctrl/⌘+Shift+L`, same dialog and the same occupied-slot rule. Saving under an existing name overwrites after an `Enter` confirm.
- **Recall:** `Alt+1..9` / `⌥⌘1..9`; `:layout name`; picker.
- **Parking.** Applying a layout parks the current workspace instead of discarding it. Up to four are parked per context, newest first, with their shells still running and their edits open.
  - `Alt+0` / `⌥⌘0` swaps the current workspace with the newest parked one.
  - Older ones are in the `'` picker under Parked, with a summary such as `pods | svc / logs · 2 shells`.
  - Parking a fifth evicts the oldest. If that one holds a live shell, a dialog lists it first (§4.6).
  - Recalling the layout that is already active and unedited does nothing.
- Log and shell panes are saved as `paneSelection` (the selection of pane N); log panes may also be a label selector. Never a pod name. Recall never execs: shell panes are placeholders until `Enter`.
- A layout saved on a larger window folds on a smaller one. It is never rewritten.
- Layouts are global; the live workspace is kept per context.

### 7.3 Picker (`'`)

- It is the palette with the `'` prefix: one list in three groups (Views, Layouts, Parked). Typing filters, digits included. `Tab` completes.
- Rows are 20px: slot digit, name, summary (`pods · shop · /web`). Layout rows add a 48×16 mini-map drawn from the tree (P1; the text summary `pods | svc / logs` is P0).
- `Enter` opens; `Ctrl/⌘+Enter` and `Alt/⌥+Enter` open in a new pane. `F2` renames, `Ctrl/⌘+Shift+Backspace` deletes (after an `Enter` confirm), `Shift+↑/↓` moves between slots.
- Favourites also appear in the `home` view and the palette.

## 8. Context and namespace

### 8.1 Namespace (per pane)

- The first crumb of the pane header is the namespace. `*` means all.
- `0` is all namespaces. `1`..`9` are favourite slots.
- **Slots do not shift.** A pinned slot never changes. A free slot is filled by the first recently used namespace that has no slot, lowest free number first, and then stays. When all nine are taken, a new namespace replaces the least recently used unpinned slot in place. No other number moves.
- On cluster-scoped tables (nodes, PVs, namespaces, CRDs) `0`..`9` do nothing and show `nodes are cluster-scoped`.
- `Ctrl/⌘+N` opens the picker for the focused pane: fuzzy search, `Enter` uses. Rows show their slot number. `Ctrl/⌘+D` pins or unpins a slot. The current namespace has a gutter square.
- `Ctrl/⌘+Shift+N` opens the same picker and applies to all table panes.
- `:ns x` works too. If listing namespaces is forbidden, the typed name is accepted.
- Switching keeps the resource and filters, clears the cursor and marks, and does not push history.

### 8.2 Context (window)

- The window has a context: it decides which saved workspace is on screen and is the context of every pane that does not have its own (§8.3).
- `Ctrl/⌘+Shift+K` opens the picker; `:ctx x` switches directly. Rows show name, cluster, user, connection state and the `PROTECTED` and `READ ONLY` labels. In the picker `Ctrl/⌘+Enter` / `Alt+Enter` do not switch the window: they open the focused pane's view beside it, in that context (§8.3).
- A switch swaps the whole workspace to that context's saved one in the same frame; tables show `syncing`. The workspace left behind keeps its shells (§4.6).
- With the single `default` context the picker still works and shows connection state.
- **Protected context.** Set with `:protect on`, `Ctrl/⌘+T` in the picker, or the Contexts section of settings. Stored in `Settings.contexts`.
  - Signal: the `PROTECTED` label with the warn glyph in the titlebar, and a 2px `--k-text` line under the titlebar. The line uses a theme token, not the warn hue.
  - Effect: every write becomes tier 2 (§14).
  - Turning it off is itself tier 2: type the context name.
- **Read-only.** Set with `:ro on`, or in settings, per context. A `READ ONLY` label and the `RO` badge. Write keys are disabled and their hints removed.
- With panes in several contexts (§8.3) the titlebar's context, its `PROTECTED` / `READ ONLY` labels and the protected line follow the **focused pane's** context; `:protect` and `:ro` apply to it.

### 8.3 Context per pane

Like the namespace (§8.1), a pane can show another context than the window: staging and prod side by side.

- **Open one.** In the context picker `Ctrl/⌘+Enter` (right) or `Alt+Enter` (below) opens a copy of the focused pane's view in a new pane, in the picked context. `leader C` (`:pane ctx`) opens the picker for the focused pane only: Enter puts that pane in the context. `:pods @staging` opens pods of staging in the focused pane (`+` first: beside it).
- **Inheritance.** Split, `+`, open beside and drills keep the source pane's context. A pane in another context than its source never follows it (a cursor names objects of one cluster).
- **Changing a pane's context** restarts its history at the current view, re-read there: Esc never goes back to an object of the other cluster. A pane holding a live session (shell, attach, dirty edit) keeps its context; open the other one beside it. Panes following it stop following.
- **Signals.** While panes of more than one context are on screen, every pane header starts with its context crumb (click: pick another context for that pane; a protected context shows the warn glyph). A protected context's pane draws the protected line under its header (`--k-text`, like the titlebar's). The titlebar shows the focused pane's context, and `pane · window <name>` when that is not the window's. The activity panel's health group has a connection row per extra context, and Recent is the log of the focused pane's context.
- **Everything acts on the pane's context:** reads, `canI`, the write tiers (a protected context makes every write in its panes tier 2, whatever the window is), read-only, the action log, shells, port-forwards, env, `:why` and the other diagnosis views. An object of another context reached from an activity row, a finding or a forward opens beside, in its context.
- **Connections.** A context a pane shows is connected when the pane appears and released (no retries, no namespace watch) when no pane shows it; its discovery stays cached.
- **Persistence.** The context is saved with the pane and restored as it was, also when the kubeconfig no longer has it: the pane then says it is offline instead of showing another cluster. A saved layout remembers the panes that had their own context and recalls them in it; its other panes take the window's context. Favourite views do not carry a context.
- **Agents** see the focused pane's context in `get_selection`, with the current object labelled with its own pane's context. Agent panes (`show_in_kns`) open only in the window's context.

## 9. Tokens

### 9.1 Root setup

- `<html data-tema="claude" data-modus="mork">`. A mode change only changes `data-modus`. There is one theme, "claude".
- Mode follows the system by default (owner addition). The palette is attribute-scoped, so this needs a listener, not a media query (`src/store/appearance.ts`).
- Until settings load, the HTML ships `data-modus="mork"`; `boot.ts` applies the last mode from localStorage before first paint.
- Overlays float: a rounded surface with a soft shadow over the scrim, no hard frame.

### 9.2 Layers

Three layers, each in one file:

1. **Palette** (`src/styles/claude.css`): raw colours per mode as `--c-*` (`--c-bg-1..6`, `--c-text-1..3`, `--c-fg-1`, `--c-fg-3`, `--c-accent`, `--c-emph`, `--c-node`). b1 is the content surface, b2 the chrome (darker than the content in dark mode, like the Claude desktop app), b3–b6 step away from b1.
2. **Semantic tokens** (`src/styles/tokens.css`): the `--k-*` layer, mapped onto the palette, plus the fixed status and syntax hues, the type and spacing scales, sizes and fonts.
3. **Theme overrides** (`src/styles/claude.css`, scoped to `[data-tema="claude"]`): where the look departs from the base sizes: larger UI type, taller chrome, rounded pane cards with a gap, pill-shaped list rows, floating overlays.

Components reference only `--k-*` tokens. No component contains a hex value or a raw `--c-*` variable. Glyphs are SVG with `currentColor`.

### 9.3 Contrast (worst case across light and dark)

| Foreground | on b1 | on b2 | on b3 | on b4 | on b5 | on b6 |
|---|---|---|---|---|---|---|
| `--k-text` | 13.77 | 15.11 | 12.01 | 10.36 | 8.86 | 7.45 |
| `--k-text-2` | 10.21 | 9.38 | 8.71 | 7.68 | 6.57 | 5.53 |
| `--k-text-3` | 6.21 | 5.67 | 5.27 | 4.68 | 4.00 | 3.36 |
| `--k-text-muted`, `--k-node` | 4.68 | 4.67 | 4.08 | 3.52 | — | — |
| `--k-accent` | 3.85 | 3.49 | 3.24 | 2.95 | 2.62 | 2.29 |
| `--k-st-warn` | 7.14 | 6.48 | 6.01 | 5.47 | 4.87 | 4.14 |
| `--k-st-error` | 6.15 | 5.86 | 5.36 | 4.63 | 3.96 | 3.33 |
| `--k-st-ok` | 6.91 | 6.26 | 5.82 | 5.29 | 4.71 | 4.12 |
| `--k-st-progress`, `--k-st-info` | 7.63 | 7.29 | 6.65 | 5.74 | 4.91 | 4.13 |

Computed with the WCAG 2 formula from `claude.css` and `tokens.css`. Hairlines, dividers and frames are translucent text colour and decorative. The accent is a glyph, bar and button colour (≥ 3:1 on b1–b3), never body text; white on the accent button is 3.12 (dark) and 4.05 (light).

Rules that follow:
- Targets: text 4.5:1; glyphs, focus ring and frames 3:1; hairlines and the divider are decorative.
- Muted text is allowed only on b1 and b2. On marked and focused rows it steps up to `--k-text-3`.
- Status hue as text is allowed only on b1 and b2. On b5 neither word nor glyph has a hue (the rule in `tokens.css`).

### 9.4 State signals

| State | Background | Second signal |
|---|---|---|
| Row hover | b2 | Pointer |
| Cursor row, focused pane | b4 | 2px `--k-accent` bar on the row's left edge |
| Cursor row, unfocused pane | b3 | None (idle by design) |
| Marked row | b3 | The checkbox square, 8×8, `--k-mark`, in the mark gutter |
| Cursor + marked | b4 | Bar and square |
| Focused pane | none | 2px `--k-accent` line on the header's top edge; title in `--k-text` |
| Unfocused pane | none | Title in `--k-text-3` |
| Overlay | b2 | 1px `--k-frame` and the scrim |
| Changed cell | b5 for 1s | Static, then off; text and glyph in `--k-text` |
| Stale or terminating row | none | Text in `--k-text-muted`; glyph changes |
| Held row (left the filter under the cursor) | none | Text in `--k-text-muted`, label-style `GONE` in the status cell |
| Search match / current match | b4 / b5 | Underline / underline plus 2px accent bar at the line's left edge |
| Focus ring | none | 2px `--k-focus`, inset |

Changed-cell rules:
- Columns declare `delta: false` to opt out. Metrics columns (CPU, MEM and the percentages) and AGE never flash, so a scrape does not repaint b5 across the table.
- A changed status cell flashes like any other; the b5 rule removes the hue for that second, and the shape still carries the state.

### 9.5 Status glyphs

The glyph sits inside the STATUS cell, directly before the status word, in an 8×8 box with 6px on each side. Filled only. Kinds with no status have no glyph and no glyph column.

| State | Shape (px) | Colour | Word colour on b1/b2 | Examples |
|---|---|---|---|---|
| ok | square 7×7 | `--k-st-ok` (Quiet: `--k-node`) | `--k-text-2` | Running and ready, Bound, Active, Flux Ready=True |
| progress | horizontal line 8×2 | `--k-st-progress` (Quiet: `--k-node`) | `--k-text-2` | ContainerCreating, Init:n/m, rollout, Reconciling |
| warn | 45° line 8×2 | `--k-st-warn` | `--k-st-warn` | Long Pending, `1/2` ready, restarts 5+, cordoned, Warning events |
| error | circle Ø8 | `--k-st-error` | `--k-st-error` | CrashLoopBackOff, ImagePullBackOff, OOMKilled, Failed, Ready=False |
| suspended | vertical line 2×8 | `--k-node` | `--k-text-2` | Flux or CronJob suspended |
| done | square 4×4 | `--k-node` | `--k-text-muted` | Completed, scaled to 0 |
| terminating | horizontal line 8×2 (the progress shape) | `--k-node` | `--k-text-muted` (whole row) | deletionTimestamp set |
| unknown / stale | no glyph | — | `--k-text-muted` | Unknown, stale watch |

- **Shape carries the state.** Six shapes are in use and each is distinct at 1x: large square, small square, circle, and a line in three directions. Only one 4px shape remains, so nothing has to be told apart at that size.
- Terminating is not a separate shape. It is "in transit" with the whole row muted and the word `Terminating`. Unknown is the absence of a node plus the word.
- Warn and error also differ from the others by hue, but never only by hue: no other state uses the 45° line or the circle.
- Reading [ours]: square is technology at work, line is in transit, circle is "a person must look".
- Status derivation follows research §6.5: derive from container states, phase and deletionTimestamp; transient states turn warn after 60s; `0/N` is error unless Completed.
- **Geometry, one rule for both sizes:** round to the nearest whole pixel. Square = 0.9 × size: 7 at 8px (7.2), 4 at 4px (3.6). Line thickness = 0.2 × size: 2 at 8px (1.6), 1 at 4px (0.8). The 45° line is an SVG path and is anti-aliased.
- One SVG sprite, `shape-rendering: crispEdges` for squares and axis-aligned lines.
- A marked ok row no longer shows two squares side by side: the mark is in the gutter at the row's left edge, the glyph is inside the STATUS cell after the name.

### 9.6 Other node uses

| Use | Form |
|---|---|
| Watch and connection glyph | Node line at 4px: square 4×4, line 4×1, circle Ø4, with 8px gaps, 28px wide, all in `--k-node`. Live: all three. Reconnecting: the line is removed. Stale, paused or offline: only the circle remains. Always paired with a word (`live`, `reconnecting`, `stale`, `offline`). |
| Mark | A checkbox, "a square that fills": 8×8, `--k-mark`, in the 12px mark gutter. It is a form control, not a node, so it is a full 8px and not 7 |
| Form controls | Checkbox is a square that fills; radio is a circle with a centred node |
| Empty states | One free-standing node line (8px nodes: square 7×7, line 8×2, circle Ø8; 16px gaps) in `--k-node`, in its own block 28px above the text |

Sort direction is not a node. A sorted column header shows `↑` or `↓` as a character in the label's own type, plus `aria-sort`.

Not allowed: nodes as bullets, breadcrumb separators, sort indicators or punctuation; inside log lines or document text; as spinners; behind or under text; outlined variants; any colour outside `--k-node` and the status hues (`--k-st-ok`, `--k-st-progress`, `--k-st-warn`, `--k-st-error`; §18 item 39).

## 10. Typography

Fonts are open-licensed (SIL OFL) and bundled from `@fontsource`; no proprietary font is in the repository.

- **UI:** Instrument Sans 400 and 500. Weights are locked per style and never change for focus, selection or hierarchy. Never bold.
- **Headings:** Newsreader 400 (and italic for the one emphasised word), only in empty states and settings titles.
- **Mono:** Geist Mono 400 (JetBrains Mono selectable), 12px on a 16px line, ligatures off.

Base sizes (in CSS px, before the 1.2× base zoom; the "claude" theme raises UI and label sizes one step, see `claude.css`):

| Element | Class | Size / line | Weight |
|---|---|---|---|
| Table cell, palette rows | `.t-cell`, `.t-row` | 12, single line in a 16px box, `tabular-nums` | 400 |
| Column header, button label | `.t-colhead`, `.t-button` | 10, single line, sentence case | 500 |
| Pane crumbs, typed input text | `.t-crumb`, `.t-input` | 12, single line | 500 |
| Palette input | `.t-palette-input` | 14, single line in a 20px box | 400 |
| Hints, bottom-row status, counts, key chips | `.t-ui`, `.t-hint` | 10, single line | 500 |
| Mode badge, group and field labels | `.t-label` | 8, uppercase | 500 |
| Dialog title | `.t-dialog-title` | 14 / 18 | 500 |
| Dialog body, toast | `.t-body` | 12 / 17 | 400 |
| Multi-line UI text | `.t-ui-multi` | 10 / 15 | 500 |
| Empty-state and settings titles | `.t-title` | 28 / 31, serif | 400 |
| Logs, YAML, describe, terminal | `.t-mono` | 12 / 16 | 400 |

- Single-line rows have no line-height of their own: the text sits in the row's line box.
- The label style is the only uppercase style. Resource names are never uppercased. Key chips keep their case, because `g` and `G` differ.
- Long names get a middle ellipsis. Numeric columns are right-aligned.
- `Ctrl/⌘ +` and `-` change the webview zoom factor; every CSS pixel scales together. Budgets in §2 are for 100%.

## 11. Components

Spacing comes from one scale (`--k-luft-*`): 2, 6, 8, 12, 14, 16, 20, 24, 28, 32, 40, 44, 48, 56, 64. Radius is `--k-radius` (6px in the "claude" theme, 10–14px for cards and overlays).

Row heights are a line box plus an inset on each side: 20 = 16 + 2 + 2, 28 = 16 + 6 + 6, 32 = 16 + 8 + 8, and the palette input is 32 = 20 + 6 + 6.

### 11.1 Pane header (20px)

`[N] [crumbs] [chips] ...flex... [<- N FOLLOW] [FAV n] [UNSORTED n] [count] [watch 28px]`

- Background `--k-bg-header`, padding-inline 8, gap 6.
- Pane index `N` (UI type) shows only in PANE mode.
- Crumb separator is a plain ` / ` in `--k-text-muted`.
- Count is `shown/total`; with marks, `3 marked`.
- Focused: 2px accent line on the top edge (drawn inside the 20px, in the top inset), title in `--k-text`. Unfocused: title in `--k-text-3`.
- Collapse order under width pressure: `FAV`, chips fold to `2 FILTERS`, crumbs truncate to the last segment, count. The watch glyph never hides. Crumbs: long ones (over 8 characters, an object name) shorten first, to a 5-character stub; no crumb shrinks below 3 characters (never a bare separator); from 420px down only the last two crumbs show (`web-7d9 / logs`), from 280px the last one. The `FOLLOW` word of the link hides under 560px (the source pane's number stays).
- Header buttons (mouse parity: back / forward, the view's toolbar, split, zoom, pane menu, close) are always visible and clickable; on a pane with neither focus nor pointer they are `--k-text-muted`. Only the colour changes.
- Logs show state labels only for what differs from a plain followed tail of every container: `PAUSED +128`, `ENDED`, `FILTER`, `PREVIOUS`, the container, the time range. Follow, wrap and timestamps are pressed buttons of the logs toolbar.

### 11.2 Table row and cells

| Part | Size |
|---|---|
| Row height | 20 (16 line box + 2 + 2); option 28 (16 + 6 + 6) |
| Mark gutter | 12 = cursor bar 2 + checkbox square 8 + 2 |
| Cursor bar | 2px, at the row's left edge, inside the mark gutter |
| Status glyph | Inside the STATUS cell: 6 + glyph 8 + 6, then the word. Glyph-only width 20 |
| Cell padding-inline | 6 (12 between columns) |
| Right inset | 8 |
| Row dividers | None |
| Scrollbar | 6px overlay thumb, `--k-frame`, radius 2; shown on scroll or hover |

Text: name in `--k-text`; other cells `--k-text-2`; age and counts `--k-text-muted`. States follow §9.4.

### 11.3 Column header (20px)

- Background `--k-bg-header`, 1px `--k-line` below, label style in `--k-text-3`, 16px line box with 2px above and below.
- Sorted: label in `--k-text` followed by `↑` or `↓`.
- Selected column (`Shift+←/→`): 2px accent underline. `<` and `>` change its width by 8px.
- Resize handle: 6px hit area; 1px `--k-frame` on hover.
- Headers shorten before a column hides: `RESTARTS` to `RST`, `NAMESPACE` to `NS`.

### 11.4 Key chip and filter chip

| | Key chip | Filter chip |
|---|---|---|
| Height | 16 (2 above and below in a 20px row) | 16 |
| Padding-inline | 6 | 6 |
| Min width | 16 | — |
| Type | UI 10px, weight 500, case preserved | label style mode + UI type value, gap 6 |
| Surface | No fill, 1px `--k-frame` | `--k-bg-chip`, no frame |
| Text | `--k-text-2` | `--k-text-2` |
| Focused | — | 2px focus ring |
| Disabled | 50% | — |

- A chip shows the produced character for the active layout. Combos are separate chips with a 2px gap.
- Key chip + label is the only action affordance in the bottom row and pane headers. There are no buttons in chrome.

### 11.5 Inputs

| | Bar input (filter, search, command) | Dialog field |
|---|---|---|
| Height | 20 (fills the pane header) | 32 |
| Label | label style to the left of the field, 6px gap: `FILTER`, `SEARCH`, `COMMAND`. Then the mode chip | label style above, 6px gap |
| Surface | `--k-bg-input`, 1px `--k-frame` | `--k-bg-input`, 1px `--k-frame` |
| Padding-inline | 8 | 8 |
| Focus | Frame becomes 2px `--k-focus`, inset | Frame becomes 2px `--k-focus`, inset |
| Error | Circle glyph and message in the header's right side (UI type, error hue) | Circle glyph and message below (UI type, error hue). The frame keeps its colour |
| Disabled | 50% | 50% |

- The bar input has a label beside the field because the bar is one row (§18).
- The error hue is used on the glyph and the message only, never on a frame.

### 11.6 Palette and pickers

- Width 560 (640 from 1920 wide; max 80vw), top offset 64, `--k-bg-overlay` with 1px `--k-frame`, scrim behind.
- Input row 32, padding-inline 12, with its label-style label (`SEARCH OR RUN`, or the picker's name) above the list edge at the left of the field. Result rows 20, padding-inline 12, key chips right-aligned. At most 14 rows visible, then scroll.
- Group labels: label style, 20px high.
- Selected row: b4 plus the 2px accent bar. Matched characters are underlined, with no colour change.
- Pickers (namespace, context, favourites, container) are the same component, 400 wide.

### 11.7 Dialog

- Width 400, padding 16, gaps 12, `--k-bg-overlay` with frame and scrim.
- Title: status glyph (tier 3 only) + dialog title style. Body: body text.
- Fact block: kind, name, namespace, context in mono on `--k-bg-input`, padding 8.
- Footer right-aligned, 12px gap: tertiary Cancel, then the primary.
- Propagation is a radio group; Force and dry run are checkboxes.
- The body scrolls when the window is short; the title and the buttons stay on screen.
- The text to type on tier 2 and 3 is shown as written inside the upper-case label (`TYPE web TO CONFIRM`): names are case-sensitive.
- **Keys.** Focus starts in the text field if there is one, else on the primary. A prefilled text field is selected when the keyboard puts the focus in it (the dialog opening, `Tab`), so typing replaces the value; a click places the caret. `Tab` / `Shift+Tab` move through field, radio group, checkboxes and buttons. `↑` `↓` change the radio. `Space` toggles a checkbox. `Enter` confirms from anywhere; `Esc` cancels.

### 11.8 Buttons [verify visuals]

Used only in dialogs, settings and empty states. Height 32, side margin 24. One primary per surface. Each button shows its key chip after the label.

| Variant | Default | Hover | Focus | Disabled |
|---|---|---|---|---|
| Primary | Fill `--k-btn-bg`, text `--k-btn-fg` | Fill `--k-btn-hover` | 2px ring, 2px offset | 50%, no hover |
| Secondary | Transparent, 1px `--k-frame`, text `--k-text` | Background `--k-row-marked` | Same ring | 50% |
| Tertiary | Text only, `--k-text-2` | 1px underline | Same ring | 50% |

The destructive confirm is the primary button, not a red one. Danger is carried by the tier.

### 11.9 Toast

- Bottom-right, 12px inset, 6px above the bottom row. Width 280, padding 8 × 12, overlay surface with frame.
- Content: status glyph, body text, optional tertiary action with key chip (`Ctrl/⌘+Z` undo).
- Lasts 4s, or 10s with undo. At most three are visible in total, stacked with a 6px gap.
- **Undo.** Only the newest undo toast shows the `Ctrl/⌘+Z` chip, and that is the one the key undoes. When it is undone or expires, the next newest takes the chip. The key works in NORMAL only; while an input, EDIT or TERM has focus the chip is hidden and the timer keeps running. Every live undo is also in the palette under `>undo`.
- **Errors.** An error toast stays until `Ctrl/⌘+Shift+X`, but it counts toward the three. When a fourth message arrives, the oldest error leaves the stack and is counted in the bottom row as `errors N`. `:errors` opens the full list (the `messages` view). No error is dropped.

### 11.10 Tab strip, divider, help, empty state

- **Tab strip** (fold and zoom): 20px, `--k-bg-header`, items `index + last crumb` in UI type with a 12px gap. Active item: `--k-text` plus a 2px accent underline. Others `--k-text-3`. Leader + index picks an item.
- **Divider:** §3.3.
- **Help overlay (`?`):** 720 wide (max 90vw), max height 80vh, same surface as the palette. A search input, then actions grouped by scope in two columns, rows 20px. It shows remapped keys, the reason for disabled actions, and ends with the text list of k9s actions not built yet.
- **Context menu (`Shift+F10`, Menu key, right-click):** the same list component, 240 wide, rows 20px. It holds the actions of the hint row with their key chips. A pointer menu (row menu, pane menu, a toolbar's overflow) lists its own actions in groups with a 1px `--k-line` rule between them (5px); it is as tall as the window allows and scrolls only on a short window. The pointer moves the selection (one highlight, no separate hover). A disabled row keeps its whole label; its reason is cut first and is in the row's tooltip.
- **Tooltip:** one themed tooltip for the window (`--k-bg-overlay`, frame): the control's label, the key chip from the live keymap, and the reason on a second line when the control is disabled. Opens after 300ms, at once when the pointer comes from another control; closes on a key, a click, the wheel or a scroll, and stays closed until the pointer really moves again. Never takes focus. A cut-off name (table NAME cell, folded tab) shows its full text after 600ms, as written, only while it is cut. No native `title` anywhere.
- **Empty state:** node line block, 28px gap, serif 28px title, body text line with the one-key fix (`Esc clears the filter`). Shown in panes of at least 320×240; smaller panes show the text line only. While the first snapshot is pending, the text is `syncing`, never "no resources".
- **Home view:** a list in sections (Favourites, Layouts, Recent, Workloads, Network, Config, Storage, Cluster, Flux, CRDs). Rows 20px, group labels label style. Keys: `j` `k`, `g` `G`, `/` filters, `Enter` opens, `+` or `Ctrl/⌘+Enter` opens beside. As a rail it is an ordinary pane 240 wide, which is also the pane minimum.
- **Aliases view:** a table of alias, resource and group, with the same keys as home.
- **Settings view:** a list of rows grouped by section (Appearance, Keys, Contexts, Safety, Logs). `j` `k` move, `Enter` or `Space` toggles or opens a field, `←` `→` cycle an option, `/` filters. The Contexts section holds the protected and read-only flags; Safety holds the kill switch.

## 12. Table behaviour

### 12.1 Density and rendering

- Fixed row height, virtualized, overscan 10 rows; the cursor row stays mounted.
- Rows are keyed by `metadata.uid`. Only table rows cross IPC, not full objects.
- One watch per `(gvr, namespace, selector)`, refcounted across panes. Deltas are coalesced per 100ms.
- One `ResizeObserver` per pane, coalesced per frame. Nothing else is measured.
- **Memory caps.** Logs keep `logBufferLines` (default 10 000) per pane in a ring buffer on the Rust side; a workload stream shares one cap across its pods. Terminal scrollback is `termScrollback` (default 5 000 lines). Hidden log views drop their buffer after 30s. At most 8 live shells.

### 12.2 Column priority

Each column declares `{tier, min, ideal, delta}`. A higher tier hides first; within a tier the rightmost hides first.

Pods (widths include cell padding; thresholds include the 8px right inset):

| Tier | Columns (min width) | Shown from pane width |
|---|---|---|
| 0 | mark gutter 12, NAME 120 (takes all spare width), status glyph alone 20 | always (160) |
| 1 | STATUS 88 (glyph + word, replaces the 20px glyph), READY 44 | 272 (STATUS alone from 228) |
| 2 | RST 40, AGE 44 | 356 |
| 3 | CPU 48, MEM 56 | 460 |
| 4 | NODE 120, IP 104 | 684 |
| 5 | %CPU/R, %CPU/L, %MEM/R, %MEM/L, QOS and other wide columns | only with wide on (`*`), then horizontal scroll |

- At the 240px minimum pane a pods table shows NAME and STATUS.
- In all namespaces, NAMESPACE (96, header `NS`) joins tier 1 and shifts every threshold by 96.
- **No metrics-server.** When `metrics.k8s.io` is absent, CPU, MEM and the percentage columns are removed from the kind's column set, not left blank. Later tiers move down by the freed width. They return when the API appears.
- **Algorithm:** add tiers while the sum of minimums fits; grow columns toward `ideal`; give the rest to NAME. Pure arithmetic on cached specs.
  - Grow order: the status word first, then NAME to its content width (sampled, at most 320), then the other columns in priority order; what is left goes to NAME, so the table always fills the pane.
  - `ideal` is the content width and at least the full header title, so a column shows `READY` / `UP-TO-DATE` instead of `RDY` / `UPD` once there is room.
  - **Tier 4 waits for a readable NAME** [ours]: the tier 4 thresholds of the tables here assume names that fit 120px. With longer names tier 4 joins only when NAME can also have its content width, up to 220px (`NAME_COMFORT`), so a pane just past 684 does not show NODE next to names cut to a dozen characters. A width the user set on NAME turns this off.
  - A user width on NAME is a floor, not a cap: spare width still goes to it. Dragging NAME narrower than what the pane gives it anyway stores nothing.
- **Hysteresis:** a tier appears at threshold + 24px and hides below the threshold. The change lands in one frame. NAME is left-anchored, so the eye's anchor does not move. It counts from the first measured fit of a column set (not from the unmeasured first render, and not across a changed set: the server's columns arriving, metrics coming or going).
- **Whole rows.** The viewport is the header plus a whole number of rows; what is left (under one row) stays empty below. The wheel steps whole rows at once (trackpad pixel deltas add up to rows); any other scroll settles on a row edge when it ends. Until the server's columns arrive the header bar is empty (no placeholder column that then moves).

Other built-in kinds. Tier 0 is always the mark gutter and NAME, plus the 20px status glyph where the kind has a status. Tier 5 shows only with wide on.

| Kind | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 (wide) |
|---|---|---|---|---|---|
| Deployment | STATUS, READY | UP-TO-DATE (`UPD`), AGE | AVAILABLE (`AVL`) | IMAGES | CONTAINERS, SELECTOR, LABELS |
| StatefulSet | STATUS, READY | AGE | SERVICE | IMAGES | CONTAINERS, SELECTOR |
| DaemonSet | STATUS, READY | AGE, UPD | AVL | NODE SELECTOR | IMAGES, CONTAINERS |
| ReplicaSet | STATUS, READY | AGE | DESIRED, CURRENT | OWNER | IMAGES, SELECTOR |
| Job | STATUS, COMPLETIONS | DURATION, AGE | — | IMAGES | CONTAINERS, SELECTOR |
| CronJob | STATUS (suspended), SCHEDULE | LAST SCHEDULE, AGE | ACTIVE | TIMEZONE | IMAGES, CONTAINERS |
| Service | TYPE, PORTS | CLUSTER-IP, AGE | EXTERNAL-IP | — | SELECTOR |
| Node | STATUS | ROLES, AGE | CPU%, MEM% | VERSION, PODS | INTERNAL-IP, OS-IMAGE, KERNEL, TAINTS, CPU/A, MEM/A |
| Namespace | STATUS | AGE | — | — | LABELS |
| Event | REASON, LAST SEEN | MESSAGE (takes spare width once shown) | COUNT | — | SOURCE, FIRST SEEN |
| ConfigMap | DATA | AGE | — | — | LABELS |
| Secret | TYPE | DATA, AGE | — | — | LABELS |
| PVC | STATUS, CAPACITY | AGE | VOLUME, STORAGECLASS | — | ACCESS MODES, VOLUMEMODE |
| PV | STATUS, CAPACITY | CLAIM, AGE | STORAGECLASS | RECLAIM | ACCESS MODES, REASON |
| Ingress | HOSTS | CLASS, AGE | ADDRESS | PORTS | — |

- **Events:** the NAME column is the involved object (`pod/web-7d9f8`). The glyph is the event type: warn for Warning, none for Normal. Default sort is LAST SEEN, newest first.
- **Server Table kinds (CRDs):** name is tier 0; the first two priority-0 columns are tier 1; AGE is tier 2; remaining priority-0 columns are tier 3; `priority > 0` columns are tier 5.
- **Flux kinds:** READY and STATUS tier 1; REVISION tier 2; SUSPENDED tier 3.
- **Overrides:** the column menu (`Ctrl/⌘+Shift+M`) hides, pins (tier 0), reorders and fits. `<` `>` set a width. Stored per GVR.

### 12.3 Live updates

The rule is: **the cursor row never moves on screen because of data.** Rows may come and go around it.

- **Anchoring.** When rows above the cursor row are added or removed, the scroll offset changes by the same number of rows in the same frame, so the cursor row keeps its screen position. The one exception is the top of the list, where there is nothing to scroll.
- **Cursor row leaves the set** (it no longer matches a filter or FAULTS): it stays as a held row with muted text and a `GONE` label until the cursor moves off it. Then it disappears.
- **Cursor row deleted from the cluster:** it shows as terminating while the object exists, then the cursor moves to the next row, which takes the same screen position.
- **Other rows that leave the set** are removed at once, with anchoring.
- **Volatile sort column.** Existing rows keep their order when values change. The new order applies on the next user sort or `Ctrl/⌘+R`.
- **New rows** appear in sort position when that is at or below the cursor row, or off screen. Otherwise they are appended at the end.
- **Marker for appended rows.** A 1px `--k-line` rule sits above the first appended row, and the pane header shows `UNSORTED 4`. `Ctrl/⌘+R` or a sort key sorts them in and clears both.
- A changed cell gets the static 1s delta state, except columns with `delta: false`.
- Ages tick on a coarse timer, kubectl style (`45s`, `2d4h`).
- Stale watch: row text goes muted, the watch glyph and word change. Data is never silently frozen.

### 12.4 Sort, filter and marks

- Sort keys as in k9s; pressing again reverses. Header click also sorts.
- **Who owns the sort.** When a table opens, the first of these that exists wins:
  1. An explicit sort in what opened it: a favourite view, a saved layout, or a history entry.
  2. The last sort the user chose for that kind (`columns[gvr].sort`).
  3. The kind's default: events by LAST SEEN descending; everything else by NAME, with NAMESPACE first in all namespaces.
- A sort key changes the pane's sort and updates the per-kind memory. In a pane opened from a favourite it changes only the pane, and the header's `FAV n` label gains `edited`.
- Filters: §6.3. `!` toggles the `FAULTS` chip. On events it is the `WARNING` chip.
- Cursor and marks are separate.
- `Space` toggles and moves down. `Shift+Space` marks the range from the last mark. `Ctrl/⌘+A` marks all filtered rows.
- Marks survive watch updates and are cleared by `Esc`, a namespace switch or leaving the view.

What an action does when marks exist:

| Action | With marks |
|---|---|
| Delete, restart, Flux reconcile and suspend, cordon, kill | Applies to all marked rows; one dialog or toast with per-item results |
| Scale | One dialog; the same replica count is set on every marked row |
| Logs (`l`) | One merged stream over the marked pods, with the pod gutter; at most 8 |
| Copy name, namespace, cell | All marked rows, one per line |
| Describe, YAML, edit, shell, attach, port-forward, owner, node | Cursor row only. The hint reads `d describe (cursor row)` while marks exist |

### 12.5 Containers view

`Enter` on a pod pushes a `containers` view. It has no GVR; rows come from the pod's spec and status and update with the pod's watch.

| Tier | Columns |
|---|---|
| 0 | NAME, status glyph |
| 1 | STATE (glyph + word), READY |
| 2 | RST, TYPE (`init`, `ctr`, `eph`) |
| 3 | CPU, MEM (with metrics-server) |
| 4 | IMAGE, PORTS |
| 5 (wide) | PROBES (L:R:S), AGE, %CPU/R, %MEM/L |

- Crumbs: `namespace / pods / pod / containers`. Sort defaults to spec order: init, then containers, then ephemeral.
- State glyphs follow §9.5: running and ready is ok, waiting is progress (warn after 60s), a terminated init container with exit 0 is done, CrashLoopBackOff and non-zero exits are error.
- Actions on a container row: `Enter` or `l` logs, `p` previous logs, `s` shell, `a` attach (P1), `F` port-forward with that container's ports, `d` describe of the pod scrolled to the container, `c` copy name. There are no marks and no delete.

## 13. Detail views

### 13.1 Doc view: describe, YAML, JSON, secrets

One CodeMirror 6 editor serves all of them. View and edit are the same editor; `e` toggles to edit.

- **Layout:** pane header, then the editor. Line-number gutter and fold gutter in `--k-text-muted`, mono 12/16, padding-inline 8.
- **View mode** is read-only and is not EDIT mode. Single keys stay active: `j` `k` move a line cursor, `g` `G`, `/` search, `n` `N`, `z` `Z` fold, `w` wrap, `c` copy, `m` managed fields, `Y` format, `e` edit.
- **Selection by keyboard.** `v` starts a line selection and `j` `k` extend it. `Shift+arrows` extend a character selection from the line cursor. `c` or `Ctrl/⌘+C` copies the selection; with none, `c` copies all. `Esc` clears it.
- **Search** is the header bar (§6.3) in both view and EDIT.
- **Describe** (`d`): generated describe text with live events at the bottom. It refreshes in place and keeps the scroll position. `e` switches to the YAML of the same object in edit mode.
- **YAML** (`y`): managed fields hidden by default.
- **JSON** (`Y`): view only. `e` from JSON switches to YAML for editing; there is no JSON edit.
- **Secret** (`x`): keys listed with values masked (`••••`). `Enter` reveals the value on the cursor line; `x` toggles all. Revealed values re-mask when the pane loses focus.
- **Syntax theme:** only `--k-syn-*` tokens, in YAML, JSON, secrets, EDIT, REVIEW and with vim keys alike. Five hues of our own, one set per mode and the same in every theme (owner request): keys blue (`key`), string values green (`string`; quoted, plain and block scalars), numbers violet (`number`), `true` / `false` / `null` / `~` teal (`atom`), and `---`, directives, block scalar headers, anchors, aliases and tags pink (`meta`). Punctuation is tertiary text and comments are muted, both from the theme. Describe has no grammar: its `Key:` labels use `key`, the rest is secondary text. No italics.
  - Contrast: every hue is at least 4.5:1 on b1–b4 (editor, cursor line, diff-add, match) and 3.8:1 on b5 in light and dark; comments are at least 3.2:1. Hues stay clear of warn and error.
  - A search match is primary text, whatever token it covers. Removed diff lines stay muted; added lines keep their syntax colours. On the selection (b5) a token that keeps its colour is at least 3.8:1.
  - Numbers and constants are marked from the syntax tree (plain scalars only), so a key, a comment, a quoted `"true"` or a block scalar line is never coloured as one.

### 13.2 Edit, diff and apply

1. `e` enters EDIT. The badge shows `EDIT`; the header shows `EDITED` when dirty.
2. `Ctrl/⌘+Shift+D` toggles a diff gutter against the server version.
3. `Ctrl/⌘+S` runs a server dry run and opens REVIEW:
   - A diff, split when the pane is at least 720 wide, else unified. `Tab` toggles.
   - Added lines: `--k-diff-add` plus a `+` in the gutter. Removed lines: `--k-diff-del`, muted text, `−` in the gutter. No green or red.
   - A result line: `dry run ok`, or the API error.
   - If the object is Flux-managed: a warn-glyph line saying the change will be reverted, with `T` to suspend the owner first.
4. `Enter` applies. REVIEW with a passed dry run is the confirmation for an edit, so there is no further dialog on an ordinary context. On a protected context `Enter` opens the tier 2 dialog over the diff (§14). `Esc` returns to EDIT.
5. **Inline API errors:** the offending line gets a 1px `--k-text` underline and the error circle glyph in the gutter; the message shows in a 20px line under the header with the glyph and the text in the error hue. The hue is on the glyph and words only.
6. **Conflict** (resourceVersion changed): REVIEW shows a `CONFLICT` label and `r` to rebase.
   - `r` replays the user's changes onto the new server version as a three-way merge.
   - Clean merge: REVIEW refreshes with the diff against the new version and a new dry run.
   - Overlapping changes: back to EDIT with conflict markers (`<<<<<<< mine`, `=======`, `>>>>>>> server`) and an inline error on each block. `Ctrl/⌘+S` is refused while markers remain.
   - There is no "overwrite the server" key.
7. `Esc` in EDIT with a dirty buffer asks: `Enter` discards, `Esc` stays.
8. In read-only mode or without RBAC permission, `e` is disabled with the reason in the hint.

**Drafts (P0).** While a buffer is dirty it is written to `<app data>/drafts/<context>/<uid>.yaml`, debounced 500ms. The file is deleted on apply or discard. A pane closed with a dirty buffer keeps its draft; the next `e` on that object offers it (§3.6).

**Secrets.**
- `e` on a Secret opens the secret format in EDIT with values decoded to plain text. Entering EDIT is a reveal.
- Values that are not valid UTF-8 stay base64, are labelled `binary` and are locked.
- Apply re-encodes into `data`. REVIEW masks values in the diff; `x` reveals them.
- Secret drafts are never written to disk, so leaving a dirty Secret edit always asks (§4.6).

### 13.3 Logs

- A custom virtualized line list with an ANSI parser; not xterm.js.
- Line: mono 12/16, padding-inline 8. Optional gutters in order: timestamp (muted), pod/container (`--k-text-3`, middle ellipsis, fixed width).
- Only the level token is coloured, with the warn or error hue. The message stays in `--k-text-2`. On the current match line (b5) the level loses its hue.
- ANSI SGR colours map onto the two status hues and the text levels, not raw ANSI [ours].
- Follow is on by default. Scrolling up pauses; the header shows `PAUSED +128`. `End` or `G` resumes. A paused viewport never moves. When every stream of the target has ended the header says `ENDED`.
- The viewport is a whole number of lines with 2px above the first; the slack sits at the bottom, so a followed list never shows half a line under the header.
- Search (`/`) highlights without hiding lines. `Tab` picks `RE`, `NOT` or `FUZZY`. `Shift+Enter` in the input, or `F` afterwards, turns the search into filter-lines; the header then shows `FILTER`.
- Buffer: `logBufferLines` per pane, default 10 000. When it wraps, a muted label-style row at the top says `older lines dropped`.
- Mark (`m`): a 1px `--k-divider` rule with a timestamp. Gap marker after reattach: a muted label-style row.
- Wrap is off by default. Long lines truncate; `Enter` on the cursor line expands it.
- `v` starts a line selection; `c` copies it.
- Workload logs (deploy, sts, ds, job, svc): one stream per matched pod, re-attached as pods come and go.
- `o` opens the container picker, including init and ephemeral containers.

### 13.4 Shell

- xterm.js, mono 12/16, themed from `--k-*` tokens, `macOptionIsMeta: false`, scrollback `termScrollback` lines. The header shows pod, container and `TERM`.
- With several containers the picker appears first.
- Key routing: §5.3. Copy and paste: `Ctrl+Shift+C/V` or `Ctrl+Insert` / `Shift+Insert` on Windows, `⌘C/V` on macOS.
- **Scrollback:** `Shift+PgUp/PgDn` on Windows, `⌘⇧↑/↓` on macOS.
- **Search:** `Ctrl+Shift+F` / `⌘F` opens the header search bar over the scrollback.
- **Copy mode:** `Ctrl+Shift+Space` / `⌘⇧Space`. The badge shows `COPY` and the shell receives no keys. `j` `k` `g` `G` move a line cursor, `/` searches, `v` starts a selection, `y` copies and leaves, `Esc` leaves.
- When the session ends the pane keeps its scrollback and shows `session ended · Enter reconnects`.
- Closing a pane with a live session asks first (§4.6). View recalls from the pane open beside it, never over it.
- Leaving the pane: `Alt+arrows` / `⌥⌘arrows`, `F6`, or the leader.

### 13.5 Port-forwards

- `F` on a pod, container, service or workload opens a dialog: container ports preselected, local port editable, address `127.0.0.1`. `Enter` starts.
- `f` or `:pf` opens the manager, a table: NAME, NAMESPACE, TARGET, LOCAL, REMOTE, STATE, AGE.
- In the manager: `Ctrl/⌘+Backspace` or `Delete` stops (tier 0, toast); `c` copies `localhost:port`; `Enter` jumps to the target.
- The bottom row shows `pf N`. A broken forward shows the warn glyph in the manager and a toast.
- Forwards follow a workload across rollouts where possible.
- Stopping a forward is local, not a cluster write, so it stays tier 0 on a protected context.

## 14. Destructive actions

| Tier | Examples | Flow |
|---|---|---|
| 0 | Scale, cordon, trigger, Flux reconcile and suspend, stop a port-forward | No dialog. Toast; undo where reversible (scale, cordon, suspend) |
| 1 | Restart (a rolling restart is one click away on a row button, so it asks); delete a controller-managed pod; apply an edit (REVIEW is the dialog); end a live shell | Dialog; `Enter` confirms, primary focused |
| 2 | Delete a Deployment, StatefulSet or PVC; drain; any cluster write on a protected context; `:protect off`; `:kill on` | Type the name; primary disabled until it matches |
| 3 | Delete a Namespace or CRD | As tier 2, plus the dependent count and the error glyph in the title |

- Every dialog names the kind, name, namespace and context in the fact block.
- Delete keeps k9s's propagation choice (Background, Foreground, Orphan) and Force, plus an optional dry run. Deletes send `preconditions.uid`.
- Bulk: the dialog lists the items (scrolling past 8); type `delete N`. Per-item results arrive in a toast.
- There is no real undo for delete. "Re-apply last known YAML" is offered for 10s, not for PVC data.

**Protected contexts: every cluster write is tier 2, not only deletes.** "Write" is any action whose registry entry has `write: true`.

| Write | What changes on a protected context |
|---|---|
| Restart, trigger, Flux reconcile, suspend, resume, cordon | The tier 2 dialog opens first; type the resource name |
| Scale | The scale dialog gains the name field under the replica count |
| Edit | `Enter` in REVIEW opens the tier 2 dialog over the diff |
| Tier 1 deletes | Become tier 2 |
| Tier 2 and 3 deletes | Unchanged; the fact block shows `PROTECTED` |
| Bulk | Type `<verb> N`, for example `restart 3` |
| Undo of a write | Also a write: `Ctrl/⌘+Z` opens the same dialog |
| Port-forward start and stop, logs, shell | Not cluster writes; unchanged |

- **Kill** (`Ctrl/⌘+Shift+Backspace`) exists only after `:kill on` or the Safety setting, both tier 2. Even then it is tier 1 on ordinary contexts and tier 2 on protected ones; it is never unconfirmed.
- Read-only mode disables write keys and removes their hints. RBAC-denied actions are shown disabled, with the reason in `?` and the palette.
- Editing a Flux-managed object warns in REVIEW (§13.2).
- Destructive actions are tested only in a throwaway namespace.

## 15. Responsiveness

| Condition | Result |
|---|---|
| Pane narrower than a tier threshold | Columns hide by tier (§12.2) |
| A split cannot give every child its minimum | Fold to tabs (§3.4) |
| Pane under 320×240 | Empty states show text only |
| Pane under 720 wide | REVIEW diff is unified |
| Window width under 1280 | Titlebar `cluster / user` hidden |
| Window width under 1100 | Titlebar layout name hidden |
| Window width under 900 | Bottom row drops cpu/mem, then flux, then pf |
| Window width under 720 | Palette trigger shrinks to the key chip; server version hidden |
| Window height under 480 | Hints hidden; badge and connection glyph stay |
| Window minimum | 640×400 |
| Width 2600 and above, first run | Home rail plus three columns |

- Fractions are kept on window resize, so a layout scales with the screen.
- Zoom (`Ctrl/⌘ +`, `:ui`) is the supported way to make everything larger on a big screen. It scales CSS pixels; the conditions above then apply to the zoomed sizes.

## 16. Motion

There is none. The reference says animation is "ikke bestemt ennå", so the simplest option applies.

**One exception, by owner request:** rearranging panes (drag drop, swap, MOVE mode insert and dock, leader `H J K L`, flip) glides the panes, dividers and tab strips to their new places in 180ms (`--k-pane-move`, ease-out). The drop preview slides between zones in 120ms. Only these operations set `data-animate` on the pane area (`src/panes/animate.ts`); split, close, zoom, fold, divider drag and window resize stay in the same frame. Under `prefers-reduced-motion: reduce` nothing animates.

| Element | Behaviour |
|---|---|
| Row focus, hover, pane focus, zoom, split, fold, sort, column changes, theme and mode switch | Same frame |
| Palette, dialog, picker, toast in and out | Same frame |
| Changed cell | Static state for 1s, then off |
| Loading | A muted `syncing` row. No spinner, no skeleton shimmer |
| Log follow | Jumps to the latest line; no smooth scroll |
| Tab strip underline | Jumps |

`prefers-reduced-motion` needs no special handling.

## 17. Accessibility

- **Contrast:** targets and worst cases are in §9.3. No state depends on colour alone.
- **Focus:** a visible 2px ring or bar on everything focusable. Sticky headers never cover the cursor row.
- **Grid:** `role="grid"`, roving tabindex, `aria-rowcount`, `aria-rowindex`, `aria-sort`, `aria-selected` for marks.
- **Panes:** each is a `region` labelled by its crumbs. `F6` cycles regions.
- **Dialogs and overlays:** focus is trapped and returns to the opener on close.
- **Single keys:** a setting turns them off (WCAG 2.1.4); every action stays reachable through chords and the palette.
- **Announcements:** one rate-limited `aria-live` region for mode changes, toasts and errors. Watch updates are not announced.
- **Glyphs:** every status glyph has the status word beside it; the glyph itself is `aria-hidden`. Unknown has the word and no glyph.
- **`forced-colors`:** tokens map to system colours (§9.2); glyphs use `currentColor`.
- **Text size:** zoom raises all text, up to 150%. Text at 8px is limited to short label-style labels that repeat information available elsewhere.
- **Mouse parity:** header click sorts, context menus mirror the hints, hints are clickable, dividers drag.

## 18. Deviations and gaps the owner must know about

**Design system**

1. **One theme, "claude"** (owner request): warm greys and a clay accent in the style of the Claude desktop app, rounded pane cards, floating overlays, more room. The earlier brand theme, its palette and its fonts were removed from the repository because they were not ours to publish.
2. **Status hues [ours].** Fixed per mode (§9.3); used for glyphs, words, small badges and a faint row tint, never as a surface.
3. **Fonts** are SIL OFL only (§10).
4. **No motion** except rearranging panes (§16).
5. **`--k-scrim`, `--k-disabled`, the lines and frames** are derived with `color-mix` or alpha.
6. **Syntax highlighting** uses five hues of its own (`--k-syn-*`, §13.1).
7. **Glyph rounding.** Nearest whole pixel: the square is 7 at 8px and 4 at 4px; lines are 2 and 1.

**Against the task brief and earlier research**

16. **Mode follows the system by default** (your later addition), falling back to dark. The brief said dark by default.
17. **One editor for describe, YAML, JSON and secrets** (your later addition) replaces the separate describe and YAML viewers of research §6.7.
18. **`Ctrl/⌘+W` closes a pane**, not the window; `⌘N` is the namespace picker, not a new window; `Alt+arrows` is pane focus, not history.
19. **`Ctrl+D` does nothing in tables** outside k9s-mode.
20. **A following describe or YAML pane does not take focus** when opened (§4.4).

**Unverified platform claims**

21. All key positions and OS conflicts are untested on a Norwegian keyboard on both platforms.
22. On Windows, `Alt+arrows` and `Alt+0..9` are taken from the shell in terminal panes (readline Alt+digit arguments, Alt+arrow word movement in some shells).
23. `F6`, `F1`, `F3`, `F5` and `F11` need Fn on Mac laptops. `⌃⌘arrows` and `⌥⌘digits` must be checked against macOS window tiling and system shortcuts.
24. Windows native caption buttons with a custom titlebar, bare-Alt suppression and disabling WebView2 accelerators from Tauri are unverified. §5.8 lists each chord at risk and its fallback; §2.4 has the titlebar fallback.
25. CodeMirror's default bindings in §5.3 are from recall.

**Added in this revision**

26. **Bar input label.** The filter, search and command bar has a label beside the field, not above it, because the bar is one row.
27. **Glyph states by shape.** ok, progress, done and suspended are told apart by shape first; colour is a second signal (item 39). Unknown has no glyph, and terminating shares the progress shape with a muted row.
28. **Sort direction is a text arrow** (`↑` `↓`) in the header label, since a node may not be used as an inline symbol.
29. **Zoom is webview zoom.** If you would rather have no zoom at all, it is one setting to remove.
30. **Row option is 20 or 28.**
33. **Parked workspaces keep shells alive**, up to four workspaces and eight shells. That costs memory against the "low memory" goal; the caps are the mitigation.
34. **AltGr and the right Alt key.** Only the left Alt triggers `Alt+…` chords on a Norwegian layout. `getModifierState('AltGraph')` in WebView2 is [verify]; the exact-modifier rule is the backstop.
35. **macOS Option is not Meta in shells.** Needed for `[ ] { } | \ @ $`. `Esc` is the Meta prefix.
36. **Terminal copy mode, MOVE mode and the three-way rebase** are new designs with no k9s precedent. They exist so nothing needs the mouse.
37. **`res.warp`, attach, set image, rollback, used-by, node actions, transfer, sanitize, Flux trace and save-to-file are not P0.** They are specified but hidden until built.
38. **Menu accelerators on macOS** run before the webview. Live enable state for menu items from Tauri is [verify].
39. **More status colour (owner, status-colors round).** Items 27 and §9.5 kept colour to warn and error. The owner asked for "a bit more colour": the palette now has `--k-st-ok` (green, h150) and `--k-st-progress` (blue, h245; `--k-st-info` shares it), each ≥ 4.5:1 on b1–b2 and ≥ 3:1 on b3–b4 in light and dark, clear of the warn (78) and error (27) hues. Only the 8px glyph takes the ok / progress hue; their words stay `--k-text-2`, so a healthy table is calm. Setting "Status colours: Quiet" restores the old rule. New uses of the hues: READY / RESTARTS cells that explain a fault, a faint tint behind failing rows (setting "Row tint", 9% error / 6% warn mixed into the row; never on the cursor or marked rows), namespace badges, the titlebar health summary, pane watch and connection glyphs in trouble, a 2px edge on toasts and on failed Recent entries. Colour is still never alone: shape and word carry every state.

**Decisions I need from you**

- Amber for warn: OK?
- `Alt+1..9` for layouts on Windows, given the shell cost: OK?
- Follow on by default for describe and YAML, with focus staying on the table: OK?
- `⌘N` as namespace picker: any wish for multi-window later?
- Zoom as webview zoom (item 29): keep it, or no zoom?
- Parked workspaces with live shells (item 33): keep four, or end shells on layout recall after a confirm?
- Status glyph inside the STATUS cell after the name, instead of a leading column: OK?
- Should the `default` context start protected?

## 19. Journeys

Windows keys are shown. On macOS: `Ctrl` → `⌘`, `Alt+arrows` → `⌥⌘arrows`, `Alt+Shift+arrows` → `⌃⌘arrows`, `Alt+digit` → `⌥⌘digit`.

### J1. Pods and services side by side, logs of a crashing pod, saved as a layout

1. `:` `po` `Enter`: pods in the focused pane.
2. `+` `:` `svc` `Enter`: services open in a new pane to the right and take focus.
3. `Alt+←`: back to pods.
4. `!`: faults only, so the CrashLoopBackOff pod is at the top. `j` if needed.
5. `+` `+` `l`: logs open in a pane below, following the stream. The pane is pinned, so a later `+ l` on another pod opens a second logs pane. `p` there shows the previous container.
6. `Ctrl+Shift+L`, type `debug`, `Enter`: saved to the next free layout slot (1).
7. Any time later: `Alt+1`. The workspace that was there is parked, not lost; `Alt+0` swaps back to it.

### J2. Namespace and context

1. `Ctrl+N`, type `flux`, `Enter`: the focused pane moves to `flux-system`.
2. `0`: all namespaces. `2`: namespace favourite slot 2, which keeps its number.
3. `Ctrl+Shift+N`, type `pers`, `Enter`: every table pane moves to `shop`.
4. `Ctrl+Shift+K`, `↓`, `Enter`: switch context; that context's own workspace is restored.
5. `:` `protect on` `Enter`: the context is protected. From now on every write asks for the resource name.

### J3. Flux triage with a following describe

1. `:` `ks` `Enter`, then `!`: failing Kustomizations.
2. `+` `d`: describe opens on the right and follows; focus stays in the table.
3. `j`: the describe pane retargets after 150ms. `+` `y` would open a separate YAML pane, not replace the describe.
4. `R`: reconcile (toast, no dialog). `Ctrl+Shift+R` reconciles with source.
5. `T`: suspend. `Ctrl+Z` undoes while the toast is live and focus is in a table.
6. `Alt+→`, `/` `Message` `Enter`, `n`: search inside the describe. `Alt+←` returns.
7. `:` `flux!` `Enter`: everything not ready across Flux kinds.

### J4. Scale and edit safely

1. `:` `dp shop` `Enter`, `j` to the row.
2. `s`, type `3`, `Enter`: scaled. `Ctrl+Z` restores the previous count, as long as focus is still in the table.
3. `e`: the YAML opens in EDIT. `Ctrl+Z` now belongs to the editor; the scale undo is still under `Ctrl+K` `>undo` until its toast expires. Change the YAML; `Ctrl+D` selects the next occurrence for a multi-cursor edit.
4. `Ctrl+S`: REVIEW with the diff and the dry-run result. If the object is Flux-managed, `T` suspends the owner first.
5. `Enter` applies, or `Esc` returns to the editor. On a protected context `Enter` asks for the deployment name first. `Esc` again leaves EDIT; a second `Esc` goes back to the table.

### J5. Arrange panes, reuse a view, shell and port-forward

1. `Ctrl+.` `r`: split right (a clone). `:` `ev` `Enter`, then `!`: warning events, newest first.
2. `Ctrl+Shift+S`, type `warnings`, `Enter`: saved to the next free view slot (say 2).
3. `Alt+Shift+←` three times: 72px wider. Or `Ctrl+.` `a`, then `h` `h` `h`, `Enter`.
4. `Ctrl+Shift+Enter`: zoom. Press again to unzoom.
5. `Ctrl+.` `H`: move the pane left. `Ctrl+.` `m`, `l`, `J`: put it under the pane to the right instead. `Ctrl+.` `0`: equalize everything.
6. `Ctrl+W`: close it. `Ctrl+Shift+T`: reopen it.
7. `Alt+←` to pods, `+` `s`: a shell in a new pane (TERM). Work, then `Alt+←` back. `Ctrl+2` pressed inside the shell opens the saved view beside it, not over it.
8. `F`, `Enter`: port-forward with the preselected ports. `+` `+` `f`: the manager opens below; `Ctrl+Backspace` there stops one.
9. Later: `Ctrl+2` opens the saved view in the focused pane; `+` then `Ctrl+2` opens it beside.
10. `Ctrl+.` `x` on the shell pane: a dialog names the shell that would end. `Enter` ends it, `Esc` keeps it.