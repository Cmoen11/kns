// Shared domain types, verbatim from docs/ux.md §3.1. Change them only together with the spec.
import type { Gvr } from "../ipc/types";

export type { Gvr };

export type PaneId = string;
/** row = side by side, col = stacked */
export type Dir = "row" | "col";

export interface SplitNode {
  kind: "split";
  id: string;
  dir: Dir;
  /** >= 2; a child split never has the same dir (flattened) */
  children: LayoutNode[];
  /** fractions, sum = 1, same length as children */
  sizes: number[];
}
export interface LeafNode {
  kind: "leaf";
  pane: PaneId;
}
export type LayoutNode = SplitNode | LeafNode;

/** An object inside the window's context (the IPC `ObjRef` adds `context`). */
export interface ObjectRef {
  gvr: Gvr;
  namespace?: string;
  name: string;
  uid?: string;
}

export type FilterMode = "re" | "not" | "fuzzy";
export type Filter = { mode: FilterMode; text: string } | { mode: "label"; selector: string };
export type Scope =
  | { by: "owner"; ref: ObjectRef }
  | { by: "selector"; selector: string }
  | { by: "node"; name: string };
export type Sort = { column: string; desc: boolean };

export interface TableView {
  kind: "table";
  gvr: Gvr;
  namespace: string | "*";
  filters: Filter[];
  faultsOnly: boolean;
  /** null = per-kind memory, then kind default (§12.4) */
  sort: Sort | null;
  wide: boolean;
  scope?: Scope;
  /** restored if the row still exists */
  cursorUid?: string;
  /** the cursor's first row by name, when no uid is known (a jump from the action log) */
  cursorName?: string;
}
/** pod -> containers; has no GVR of its own */
export interface ContainersView {
  kind: "containers";
  pod: ObjectRef;
  sort: Sort | null;
  cursorName?: string;
}
/** one CodeMirror 6 editor for all of these */
export interface DocView {
  kind: "doc";
  ref: ObjectRef;
  format: "yaml" | "describe" | "json" | "secret";
  /** edit is always yaml or secret (§13.2) */
  mode: "view" | "edit" | "review";
  managedFields: boolean;
  wrap: boolean;
}
export type FollowTarget =
  | { by: "object"; ref: ObjectRef }
  /** used in saved layouts */
  | { by: "paneSelection"; pane: PaneId };
/** `objects`: merged logs of several marked rows, one pane (plan-features §2.8, E). */
export type LogTarget =
  | FollowTarget
  | { by: "selector"; namespace: string; selector: string }
  | { by: "objects"; refs: ObjectRef[] };
export type LogSince = "tail" | "head" | "1m" | "5m" | "15m" | "30m" | "1h";
export interface LogsView {
  kind: "logs";
  target: LogTarget;
  container: string | "*";
  since: LogSince;
  previous: boolean;
  wrap: boolean;
  timestamps: boolean;
  match?: { mode: FilterMode; text: string };
  filterLines: boolean;
}
export interface ShellView {
  kind: "shell" | "attach";
  /** never a selector */
  target: FollowTarget;
  container?: string;
  /** live exec id on the Rust side; absent = placeholder */
  session?: string;
}
export interface ToolView {
  kind: "home" | "portforwards" | "settings" | "aliases" | "messages" | "traps" | "agents";
}

// ── feature view kinds (docs/plan-features.md §2.8). Registered as placeholders by A1; each
// feature's owner replaces its placeholder with the real view. ────────────────────────────

/** Tools hub entries (§2.10). The catalog (src/hub/catalog.ts) re-exports this. */
export type ToolId =
  // Basics (existing features)
  | "palette" | "panes" | "logs" | "shell" | "describe-edit" | "port-forward" | "favourites" | "filter"
  // new
  | "why" | "crash" | "timeline" | "journal" | "trap" | "sparklines" | "reach" | "relations" | "rollout"
  | "diff" | "owners" | "logs-merged" | "logs-structured" | "logs-patterns" | "debug" | "snippets" | "kubectl"
  | "devsets" | "env" | "names" | "conn-string" | "mirrord" | "pack" | "mcp" | "proposals"
  // status colours package
  | "ns-health" | "action-log" | "status-colors"
  // pod traffic (src/traffic)
  | "traffic"
  // database browser (src/database)
  | "database"
  // HTTP routes (src/routes)
  | "routes";

export interface WhyView {
  kind: "why";
  ref: ObjectRef;
}
export interface TimelineView {
  kind: "timeline";
  ref: ObjectRef;
  sinceMinutes: number;
}
export type DiffSide = { ref: ObjectRef } | { revision: { owner: ObjectRef; id: string } };
export interface DiffView {
  kind: "diff";
  left: DiffSide;
  right: DiffSide;
  managedFields: boolean;
  split: boolean;
}
export interface PatternsView {
  kind: "patterns";
  source: PaneId;
  errorsOnly: boolean;
}
export interface EnvView {
  kind: "env";
  ref: ObjectRef;
  container?: string;
  devSet?: string;
}
export interface DevSetsView {
  kind: "devsets";
  selected?: string;
}
export type TextSource =
  | { by: "pack"; refs: ObjectRef[] }
  | { by: "bundle"; id: string }
  | { by: "snippet"; runId: string }
  | { by: "doc"; anchor: string }
  /** commits and pull requests between two refs of a catalog repository (deploys view, src/catalog/deploys) */
  | { by: "changes"; repo: string; base: string; head: string };
export interface TextView {
  kind: "text";
  title: string;
  source: TextSource;
}
export interface RelationsView {
  kind: "relations";
  ref: ObjectRef;
}
export interface ReachView {
  kind: "reach";
  from: ObjectRef;
  to: ObjectRef;
  port?: number | string;
}
/** Who a pod talks to, in and out: readings of its socket table added up (src/traffic). */
export interface TrafficView {
  kind: "traffic";
  pod: ObjectRef;
  /** the container to read through; default: Rust picks one */
  container?: string;
}
/** The HTTP routes of a namespace or of every namespace, and where each ends (src/routes). */
export interface RoutesView {
  kind: "routes";
  /** none: every namespace */
  namespace?: string;
}
/** A Postgres or MySQL/MariaDB server in a pod, browsed from kns (src/database). */
export interface DatabaseView {
  kind: "database";
  /** what was opened: a pod, workload, Service or CloudNativePG cluster */
  ref: ObjectRef;
}
/** What each environment of a catalog system runs, from its ops repository (docs/catalog.md). */
export interface DeploysView {
  kind: "deploys";
  /** the catalog system's name */
  system: string;
  /** its namespace: what the live versions are read from */
  namespace: string;
}
export interface HubView {
  kind: "hub";
  tool?: ToolId;
}

export type FeatureViewState =
  | WhyView | TimelineView | DiffView | PatternsView | EnvView | DevSetsView | TextView | RelationsView | ReachView | HubView | DeploysView | TrafficView | DatabaseView | RoutesView;

export type ViewState = TableView | ContainersView | DocView | LogsView | ShellView | ToolView | FeatureViewState;
export type ViewKind = ViewState["kind"];

export interface PaneState {
  id: PaneId;
  /** drill stack, capped at 50; a push from mid-stack truncates forward */
  history: ViewState[];
  /** current entry; Esc , . move it */
  index: number;
  /** target of `-` */
  last?: number;
  /** source null = source pane was closed */
  link?: { source: PaneId | null; follow: boolean };
  /** set on a pane opened by an agent's `show_in_kns` (header label AGENT); never persisted */
  agent?: string;
  /**
   * The pane's kube context when it is not the window's (§8.3). Absent = the window's context, so
   * a workspace never names its own context here. Split, `+` and open beside inherit it.
   */
  context?: string;
}

export interface Workspace {
  schema: 1;
  context: string;
  root: LayoutNode;
  panes: Record<PaneId, PaneState>;
  focused: PaneId;
  zoomed: PaneId | null;
  /** focus after close, fold order */
  mru: PaneId[];
  /** reopen stack, max 10 */
  closed: { pane: PaneState; parent: string; at: number }[];
  layoutId?: string;
  dirty: boolean;
}

export type Slot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export interface FavoriteView {
  id: string;
  name: string;
  slot?: Slot;
  view: Omit<TableView, "cursorUid" | "namespace"> & {
    /** current = the target pane's namespace at recall */
    namespace: string | "*" | { current: true };
  };
}
export interface SavedLayout {
  id: string;
  name: string;
  slot?: Slot;
  root: LayoutNode;
  views: Record<PaneId, ViewState>;
  focused: PaneId;
  links: Record<PaneId, { source: PaneId; follow: boolean }>;
  /** §8.3: the kube context of each pane that had its own; recalled in another window context, a pane named here keeps it */
  contexts?: Record<PaneId, string>;
}

/** Canonical chord string, see src/keys/chord.ts: 'Ctrl+K', 'g', 'Shift+Space', 'leader'. */
export type Chord = string;
/** A sequence; length 1 is a single chord: ['+','+'], ['leader','r']. */
export type Binding = Chord[];
/** Replaces the default list for that platform; [] unbinds. */
export interface KeymapOverride {
  win?: Binding[];
  mac?: Binding[];
}

export type Tier = "P0" | "P1" | "P2";
export type Opens = "view" | "dialog" | "none";

/** The registry entry of §3.1 (code, not persisted). src/actions adds label, group and handlers. */
export interface Action {
  id: string;
  /** Space-separated scope ids; the action is active when any of them is in the active chain. */
  scope: string;
  tier: Tier;
  built: boolean;
  /** only 'view' is accepted after the + prefix */
  opens: Opens;
  /** disabled in read-only; tier 2 on protected contexts */
  write: boolean;
  /** hint-row priority, lower first; null = never in the hint row */
  hint: number | null;
  /** macOS menu path */
  menu?: string;
  win: Binding[];
  mac: Binding[];
  /** human-readable condition, shown in docs/help; the executable form is the handler's `when` */
  when?: string;
}

export type Theme = "claude";
export type Mode = "system" | "lys" | "mork";
export type Zoom = 85 | 100 | 110 | 125 | 150;

export interface ContextFlags {
  protected: boolean;
  readOnly: boolean;
  /** the name kns shows for the context (tabs, pickers, crumbs); the kubeconfig name stays the key */
  alias?: string;
}

export interface Settings {
  theme: Theme;
  mode: Mode;
  /** webview zoom */
  zoom: Zoom;
  rowHeight: 20 | 28;
  hints: boolean;
  /** detail views opened from a list land in a pane beside it */
  openBeside: boolean;
  singleKeys: boolean;
  /** vim keys in the doc editors (CodeMirror); default false */
  vim: boolean;
  k9sMode: boolean;
  mono: "geist" | "jetbrains";
  /** default false */
  killEnabled: boolean;
  /** default 10000, range 1000..100000 */
  logBufferLines: number;
  /** default 5000 */
  termScrollback: number;
  contexts: Record<string, ContextFlags>;
  /** images offered by the debug container dialog (F pins the tags); first is the default */
  debugImages: string[];
  /** seconds before a copied secret is cleared from the clipboard (0 = never) */
  clipboardClearSeconds: number;
  /** logs: parse JSON / logfmt lines into columns when the stream allows it */
  logsStructured: boolean;
  /** agent-owned forwards stop after this many idle minutes (0 = never; plan-features §5.5) */
  agentForwardIdleMinutes: number;
  /** status hues: full colours ok/progress glyphs too; quiet keeps only warn and error (src/status) */
  statusColors: "full" | "quiet";
  /** faint tint behind failing table rows */
  rowTint: boolean;
  /** namespace health badges in the context sidebar and the titlebar summary (a cluster-wide watch) */
  nsHealth: boolean;
  /** what the Recent action log records: everything, cluster writes only, or nothing */
  actionLog: "all" | "writes" | "off";
  /** context sidebar: namespaces with problems first */
  nsProblemsFirst: boolean;
  /** tables: a name that starts with its namespace and a dash shows without that prefix */
  stripNsPrefix: boolean;
  /** organisation catalog (docs/catalog.md): who the user is, an email address or user name */
  catalogUser: string;
  /** organisation catalog: the teams to scope to (`:team`); empty = the user's own */
  catalogTeams: string[];
}

export type NsSlot = { name: string; pinned: boolean } | null;
export interface ColumnPrefs {
  order: string[];
  hidden: string[];
  pinned: string[];
  widths: Record<string, number>;
  /** last user sort for the kind */
  sort?: Sort;
}

export interface PersistedState {
  schema: 1;
  workspaces: Record<string /* context */, Workspace>;
  /** newest first, max 4; Alt+0 swaps with [0] */
  parked: Record<string /* context */, Workspace[]>;
  favorites: FavoriteView[];
  layouts: SavedLayout[];
  /** slots 1..9 */
  nsSlots: Record<string /* context */, NsSlot[]>;
  columns: Record<string /* gvr key */, ColumnPrefs>;
  keymap: Record<string /* action id */, KeymapOverride>;
  settings: Settings;
}
// Drafts are separate files: <app data>/drafts/<context>/<uid>.yaml (§13.2). Secrets are never written.
