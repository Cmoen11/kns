// Scope ids and the canonical scope chains (docs/ux.md §5.2-5.4).
//
// A scope is a named context in which a binding is live. At any moment the key engine has an
// ordered "chain" of active scopes, most specific first. Features never invent chains: the focused
// pane calls setBaseScopes(viewScopes(...)) and overlays/modes call pushScope(LAYERS.x).
import type { ViewKind } from "../types";

export const SCOPES = [
  "global",
  // pane views in NORMAL mode
  "pane", // any pane view in NORMAL (not EDIT, REVIEW or a live TERM)
  "table", "table.namespaced", "table.allns", "table.scrollhl",
  "containers", "list", "home", "aliases", "messages", "portforwards", "settings",
  "logs", "doc", "doc.yaml", "doc.secret",
  // resource kinds and capabilities of the cursor row's kind
  "k.namespaces", "k.pods", "k.deployments", "k.replicasets", "k.cronjobs", "k.nodes", "k.secrets",
  "can.logs", "can.shell", "can.scale", "can.restart", "can.setImage", "can.forward", "can.usedBy", "can.env",
  "flux", "flux.managed", "argo", "argo.app",
  // feature view kinds (docs/plan-features.md §2.7, §2.8)
  "hub", "why", "timeline", "diff", "patterns", "env", "devsets", "traps", "relations", "agents", "text", "deploys", "traffic", "database", "routes",
  // modes that replace NORMAL in a pane
  "edit", "review", "review.conflict", "review.secret", "review.flux",
  "term", "term.placeholder",
  // layers (pushed on the scope stack)
  "newpane", "move", "resize", "copy",
  "filter.input", "search.input", "command",
  "palette", "picker", "picker.fav", "picker.ns", "picker.ctx", "picker.dev", "help", "menu", "columns", "olist",
  "dialog", "dialog.discard", "settings.keymap",
  // side panels (src/sidepanels): live while DOM focus is inside the panel
  "side", "side.ctx", "side.activity",
  // vim keys (src/views/doc): live while DOM focus is inside a doc editor with vim on
  "vim",
] as const;

export type ScopeId = (typeof SCOPES)[number];

const SCOPE_SET = new Set<string>(SCOPES);
export const isScopeId = (s: string): s is ScopeId => SCOPE_SET.has(s);

/** What a layer lets through from the layers below it. */
export type Below =
  /** everything */
  | "all"
  /** only bindings that start with a Ctrl/Alt/Cmd chord or an F-key (text inputs) */
  | "chords"
  /** like "chords", and Esc also reaches the layers below (a modal editor: vim gets Esc first) */
  | "chords+esc"
  /** like "chords", but only bindings of the `global` scope: no chord of the pane under it (side panels) */
  | "global-chords"
  /** nothing (dialogs, sticky modes) */
  | "none";

/** Bottom-row mode badge (§2.5). */
export type ModeBadge =
  | "NORMAL" | "FILTER" | "COMMAND" | "NEW →" | "NEW ↓" | "PANE" | "RESIZE" | "MOVE"
  | "TERM" | "COPY" | "EDIT" | "REVIEW" | "SIDE"
  // vim modes of the focused doc editor (src/views/doc)
  | "INSERT" | "REPLACE" | "VISUAL" | "V-LINE" | "V-BLOCK";

export interface ScopeLayer {
  /** most specific first */
  scopes: readonly ScopeId[];
  below: Below;
  /** badge shown while this layer is on top */
  mode?: ModeBadge;
  /** TERM: keys go to the shell unless §5.3 gives them to the app */
  terminal?: boolean;
  /**
   * Sticky key modes (MOVE, RESIZE, COPY): the layer takes every key, even while focus sits in a
   * terminal or editor. Keys with no action in the layer are consumed, never typed.
   */
  capture?: boolean;
}

/** The layers named by the spec. Push with pushScope(LAYERS.dialog); pop with the returned function. */
export const LAYERS = {
  filterInput: { scopes: ["filter.input"], below: "chords", mode: "FILTER" },
  searchInput: { scopes: ["search.input"], below: "chords", mode: "FILTER" },
  command: { scopes: ["command", "olist"], below: "chords", mode: "COMMAND" },
  palette: { scopes: ["palette", "olist"], below: "chords" },
  pickerFavourites: { scopes: ["picker.fav", "picker", "olist"], below: "chords" },
  pickerNamespace: { scopes: ["picker.ns", "picker", "olist"], below: "chords" },
  pickerContext: { scopes: ["picker.ctx", "picker", "olist"], below: "chords" },
  pickerDev: { scopes: ["picker.dev", "picker", "olist"], below: "chords" },
  picker: { scopes: ["picker", "olist"], below: "chords" },
  help: { scopes: ["help", "olist"], below: "chords" },
  menu: { scopes: ["menu", "olist"], below: "none" },
  columns: { scopes: ["columns"], below: "chords" },
  dialog: { scopes: ["dialog"], below: "none" },
  dialogDiscard: { scopes: ["dialog.discard"], below: "none" },
  move: { scopes: ["move"], below: "none", mode: "MOVE", capture: true },
  resize: { scopes: ["resize"], below: "none", mode: "RESIZE", capture: true },
  copy: { scopes: ["copy"], below: "none", mode: "COPY", capture: true },
  keymapEditor: { scopes: ["settings.keymap"], below: "all" },
  // side panels: single keys belong to the panel; of the rest only global Ctrl/Alt/Cmd chords are
  // live, never a chord of the pane the user is not looking at (Ctrl+Backspace = delete)
  sidebar: { scopes: ["side.ctx", "side"], below: "global-chords", mode: "SIDE" },
  activity: { scopes: ["side.activity", "side"], below: "global-chords", mode: "SIDE" },
  // vim keys in a doc editor: plain and named keys belong to vim; Ctrl/Alt/Cmd chords, F-keys and
  // (when vim does not claim it) Esc still reach the pane. Pushed with the badge of the moment.
  vim: { scopes: ["vim"], below: "chords+esc" },
} as const satisfies Record<string, ScopeLayer>;

/** What the table view knows about the kind it shows. */
export interface TableKind {
  /** plural resource name, e.g. "pods" */
  resource: string;
  namespaced: boolean;
  /** the view shows all namespaces */
  allNamespaces?: boolean;
  /** has the scale subresource (deploy, sts, scalable CRDs) */
  scalable?: boolean;
  /** a Flux kind (kustomizations, helmreleases, sources ...) */
  flux?: boolean;
  /** the cursor row is managed by Flux */
  fluxManaged?: boolean;
  /** an Argo CD kind (applications, applicationsets) */
  argo?: boolean;
}

const WORKLOADS = new Set(["deployments", "statefulsets", "daemonsets"]);
const LOGS = new Set(["pods", "deployments", "statefulsets", "daemonsets", "jobs", "services"]);
const USED_BY = new Set(["secrets", "configmaps", "persistentvolumeclaims", "serviceaccounts"]);
/** kinds with a pod template: dev from workload (`E`) reads their env */
const ENV = new Set(["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs"]);
const KIND_SCOPE: Record<string, ScopeId> = {
  namespaces: "k.namespaces", pods: "k.pods", deployments: "k.deployments", replicasets: "k.replicasets",
  cronjobs: "k.cronjobs", nodes: "k.nodes", secrets: "k.secrets",
};

/** The base chain of a resource table. */
export function tableScopes(k: TableKind): ScopeId[] {
  const r = k.resource;
  const out: ScopeId[] = [];
  if (KIND_SCOPE[r]) out.push(KIND_SCOPE[r]);
  if (LOGS.has(r)) out.push("can.logs");
  if (r === "pods") out.push("can.shell");
  if (k.scalable ?? (r === "deployments" || r === "statefulsets")) out.push("can.scale");
  if (WORKLOADS.has(r)) out.push("can.restart");
  if (r === "pods" || WORKLOADS.has(r)) out.push("can.setImage");
  if (r === "pods" || r === "services" || WORKLOADS.has(r)) out.push("can.forward");
  if (USED_BY.has(r)) out.push("can.usedBy");
  if (ENV.has(r)) out.push("can.env");
  if (k.flux) out.push("flux");
  if (k.fluxManaged) out.push("flux.managed");
  if (k.argo && r === "applications") out.push("argo.app");
  if (k.argo) out.push("argo");
  if (k.namespaced) out.push("table.namespaced");
  if (k.namespaced && k.allNamespaces) out.push("table.allns");
  // h and l scroll as a pair, only on kinds with no logs action (§5.4)
  if (!LOGS.has(r)) out.push("table.scrollhl");
  out.push("table", "pane");
  return out;
}

export interface ViewScopeInfo {
  kind: ViewKind;
  /** table views */
  table?: TableKind;
  /** doc views */
  format?: "yaml" | "describe" | "json" | "secret";
  mode?: "view" | "edit" | "review";
  /** review flags */
  conflict?: boolean;
  fluxManaged?: boolean;
  /** shell/attach: true while the session is live */
  live?: boolean;
}

/**
 * The base scope chain for a pane view ('global' is always appended by the engine).
 * Pass the result to setBaseScopes together with baseMode(info).
 */
export function viewScopes(v: ViewScopeInfo): ScopeId[] {
  switch (v.kind) {
    case "table":
      return tableScopes(v.table ?? { resource: "", namespaced: true });
    case "containers":
      return ["containers", "can.logs", "can.shell", "can.forward", "can.env", "pane"];
    case "logs":
      return ["logs", "pane"];
    case "doc": {
      if (v.mode === "edit") return ["edit"];
      if (v.mode === "review") {
        const out: ScopeId[] = [];
        if (v.conflict) out.push("review.conflict");
        if (v.format === "secret") out.push("review.secret");
        if (v.fluxManaged) out.push("review.flux");
        out.push("review");
        return out;
      }
      const out: ScopeId[] = [];
      if (v.format === "yaml") out.push("doc.yaml");
      if (v.format === "secret") out.push("doc.secret");
      out.push("doc", "pane");
      return out;
    }
    case "shell":
    case "attach":
      return v.live ? ["term"] : ["term.placeholder", "pane"];
    case "home":
      return ["home", "list", "pane"];
    case "aliases":
      return ["aliases", "list", "pane"];
    case "messages":
      return ["messages", "list", "pane"];
    case "portforwards":
      return ["portforwards", "list", "pane"];
    case "settings":
      return ["settings", "pane"];
    // feature kinds (plan-features §2.7): list-like, so Enter is nav.open, / filters, j/k scroll
    // and Tab / Shift+Tab switch panes
    case "hub":
    case "why":
    case "timeline":
    case "diff":
    case "patterns":
    case "env":
    case "devsets":
    case "traps":
    case "relations":
    case "agents":
    case "text":
    case "deploys":
    case "traffic":
    case "routes":
      return [v.kind, "list", "pane"];
    case "reach":
      return ["list", "pane"];
    // its own keys only: the tree, grid and SQL editor take the pointer and text input
    case "database":
      return ["database", "pane"];
    default:
      return ["pane"];
  }
}

/** Feature view kinds with a list-like chain (knownSegments, tests). */
export const FEATURE_LIST_KINDS = [
  "hub", "why", "timeline", "diff", "patterns", "env", "devsets", "traps", "relations", "agents", "text", "reach", "deploys", "traffic", "routes",
] as const satisfies readonly ViewKind[];

/** The mode badge that goes with viewScopes(info). */
export function baseMode(v: ViewScopeInfo): ModeBadge {
  if (v.kind === "doc" && v.mode === "edit") return "EDIT";
  if (v.kind === "doc" && v.mode === "review") return "REVIEW";
  if ((v.kind === "shell" || v.kind === "attach") && v.live) return "TERM";
  return "NORMAL";
}

/**
 * Every set of scopes that can be live together in one segment of the chain: each base chain
 * (plus 'global') and each layer. Used by the collision test and the keymap editor's conflict
 * check. A new scope must appear here, or its bindings are never checked.
 */
export function knownSegments(): ScopeId[][] {
  const out: ScopeId[][] = [];
  const base = (scopes: ScopeId[]) => out.push([...scopes, "global"]);
  const kinds: TableKind[] = [];
  const namespaced = [
    "pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs", "services",
    "secrets", "configmaps", "persistentvolumeclaims", "serviceaccounts", "ingresses",
  ];
  for (const resource of namespaced) {
    kinds.push({ resource, namespaced: true }, { resource, namespaced: true, allNamespaces: true, fluxManaged: true });
  }
  kinds.push(
    { resource: "nodes", namespaced: false },
    { resource: "namespaces", namespaced: false },
    { resource: "customresourcedefinitions", namespaced: false },
    { resource: "kustomizations", namespaced: true, flux: true, allNamespaces: true },
    { resource: "helmreleases", namespaced: true, flux: true, fluxManaged: true },
    { resource: "applications", namespaced: true, argo: true, allNamespaces: true },
    { resource: "applicationsets", namespaced: true, argo: true },
    { resource: "widgets", namespaced: true, scalable: true },
  );
  for (const table of kinds) base(tableScopes(table));
  base(viewScopes({ kind: "containers" }));
  base(viewScopes({ kind: "logs" }));
  for (const format of ["yaml", "describe", "json", "secret"] as const) {
    base(viewScopes({ kind: "doc", format, mode: "view" }));
  }
  base(viewScopes({ kind: "doc", format: "yaml", mode: "edit" }));
  base(viewScopes({ kind: "doc", format: "secret", mode: "review", conflict: true, fluxManaged: true }));
  base(viewScopes({ kind: "shell", live: true }));
  base(viewScopes({ kind: "shell", live: false }));
  for (const kind of ["home", "aliases", "messages", "portforwards", "settings"] as const) base(viewScopes({ kind }));
  for (const kind of FEATURE_LIST_KINDS) base(viewScopes({ kind }));
  base(viewScopes({ kind: "database" }));
  for (const layer of Object.values(LAYERS)) out.push([...layer.scopes]);
  out.push(["newpane"]);
  return out;
}
