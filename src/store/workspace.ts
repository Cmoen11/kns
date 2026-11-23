// Pure operations on a Workspace (docs/ux.md §3.2-3.4, §4.3-4.5). Each takes a workspace and
// returns a new one, or the same object when nothing changes. Ids and the clock are injected.
import type { Gvr, LayoutNode, PaneId, PaneState, TableView, ViewKind, ViewState, Workspace } from "../types";
import { neighbor, type Rect } from "./geometry";
import {
  appendToSplit,
  edgeDir,
  equalizeAll as treeEqualizeAll,
  equalizeSplit,
  findSplit,
  flipSplit as treeFlip,
  insertAtRoot,
  insertBeside,
  insertBesideSplit,
  leaf,
  leafIds,
  MAX_LEAVES,
  normalize,
  parentOf,
  removeLeaf,
  setSplitSizes,
  swapLeaves,
  treeErrors,
  type Edge,
  type IdGen,
} from "./layout-tree";

export const HISTORY_CAP = 50;
export const CLOSED_CAP = 10;
export const CAP_MESSAGE = `pane limit reached (${MAX_LEAVES})`;

/**
 * A reopen-stack entry. Beyond the spec's fields it remembers where the pane sat: on which `edge`
 * of which sibling (a split by id, and the nearest leaf as a fallback) and with what fraction.
 */
export type ClosedEntry = Workspace["closed"][number] & { beside?: PaneId; besideSplit?: string; edge?: Edge; size?: number };

export interface OpResult {
  ws: Workspace;
  /** the pane the operation created or targeted */
  pane?: PaneId;
  /** why nothing happened (shown in the bottom row) */
  error?: string;
}

export const CORE_PODS: Gvr = { group: "", version: "v1", resource: "pods" };
export const CORE_EVENTS: Gvr = { group: "", version: "v1", resource: "events" };
export const CORE_NAMESPACES: Gvr = { group: "", version: "v1", resource: "namespaces" };
export const FLUX_KUSTOMIZATIONS: Gvr = { group: "kustomize.toolkit.fluxcd.io", version: "v1", resource: "kustomizations" };

/** A table view with defaults: all namespaces, no filters, kind-default sort. */
export function tableView(gvr: Gvr, namespace: string | "*" = "*", extra: Partial<TableView> = {}): TableView {
  return { kind: "table", gvr, namespace, filters: [], faultsOnly: false, sort: null, wide: false, ...extra };
}

const pane = (id: PaneId, view: ViewState, link?: PaneState["link"], context?: string): PaneState => {
  const out: PaneState = link ? { id, history: [view], index: 0, link } : { id, history: [view], index: 0 };
  if (context) out.context = context;
  return out;
};

/** A pane's kube context: its own (§8.3), else the workspace's. */
export const contextOfPane = (ws: Workspace, id: PaneId): string => ws.panes[id]?.context ?? ws.context;

/** True when some pane of the workspace is in another context than the window (§8.3). */
export const isMixed = (ws: Workspace): boolean => Object.values(ws.panes).some((p) => p.context !== undefined && p.context !== ws.context);

export const currentView = (p: PaneState): ViewState => p.history[p.index];
export const viewOf = (ws: Workspace, id: PaneId): ViewState | undefined => {
  const p = ws.panes[id];
  return p && currentView(p);
};

/** Shell, attach and a doc in EDIT or REVIEW hold work (§4.6). */
export const isHeldView = (v: ViewState): boolean =>
  v.kind === "shell" || v.kind === "attach" || (v.kind === "doc" && v.mode !== "view");

/** What a restored or cloned pane may show of a view: no live exec id, no edit mode (§3.6). */
export function restoreView(v: ViewState): ViewState {
  if ((v.kind === "shell" || v.kind === "attach") && v.session !== undefined) {
    const { session: _session, ...rest } = v;
    return rest;
  }
  if (v.kind === "doc" && v.mode !== "view") return { ...v, mode: "view" };
  return v;
}

/** A workspace of side-by-side panes; `fractions` default to equal. */
export function newWorkspace(context: string, views: readonly ViewState[], ids: IdGen, fractions?: readonly number[]): Workspace {
  const list = views.length > 0 ? views : [{ kind: "home" } as ViewState];
  const panes: Record<PaneId, PaneState> = {};
  const order: PaneId[] = [];
  for (const v of list) {
    const id = ids();
    panes[id] = pane(id, v);
    order.push(id);
  }
  const root: LayoutNode =
    order.length === 1
      ? leaf(order[0])
      : normalize({ kind: "split", id: ids(), dir: "row", children: order.map(leaf), sizes: fractions ? [...fractions] : order.map(() => 1) });
  return { schema: 1, context, root, panes, focused: order[0], zoomed: null, mru: [...order], closed: [], dirty: false };
}

/** First-run layout by window width (§3.6): the kubeconfig context's namespace, else `*`, everywhere. */
export function defaultWorkspace(context: string, width: number, ids: IdGen, namespace: string | "*" = "*"): Workspace {
  const pods = tableView(CORE_PODS, namespace);
  const events = tableView(CORE_EVENTS, namespace, { faultsOnly: true });
  if (width < 1600) return newWorkspace(context, [pods], ids);
  if (width <= 2600) return newWorkspace(context, [pods, events], ids);
  const rail = 240 / width;
  const col = (1 - rail) / 3;
  const ws = newWorkspace(context, [{ kind: "home" }, pods, tableView(FLUX_KUSTOMIZATIONS, namespace), events], ids, [rail, col, col, col]);
  const first = leafIds(ws.root)[1];
  return { ...ws, focused: first, mru: [first, ...ws.mru.filter((p) => p !== first)] };
}

const touch = (ws: Workspace, patch: Partial<Workspace>): Workspace => ({ ...ws, ...patch, dirty: ws.layoutId ? true : ws.dirty });
const withRoot = (ws: Workspace, root: LayoutNode): Workspace => (root === ws.root ? ws : touch(ws, { root }));

function setPane(ws: Workspace, p: PaneState): Workspace {
  return ws.panes[p.id] === p ? ws : { ...ws, panes: { ...ws.panes, [p.id]: p } };
}

// ── focus ──────────────────────────────────────────────────────────────────

/** Focuses a pane and moves it to the front of the MRU list. While zoomed, the zoom follows (§3.4). */
export function focusPane(ws: Workspace, id: PaneId): Workspace {
  if (!ws.panes[id]) return ws;
  if (ws.focused === id && ws.mru[0] === id) return ws;
  return { ...ws, focused: id, mru: [id, ...ws.mru.filter((p) => p !== id)], zoomed: ws.zoomed && ws.zoomed !== id ? id : ws.zoomed };
}

/** F6 / Shift+F6: cycles panes in pane order. */
export function focusNext(ws: Workspace, delta: 1 | -1): Workspace {
  const order = leafIds(ws.root);
  const i = order.indexOf(ws.focused);
  return focusPane(ws, order[(i + delta + order.length) % order.length]);
}

/** Leader leader: the previously focused pane. */
export function focusLast(ws: Workspace): Workspace {
  return ws.mru.length > 1 ? focusPane(ws, ws.mru[1]) : ws;
}

/** Leader 1..9: pane N in pane order (this also unfolds or zooms to it). */
export function focusIndex(ws: Workspace, n: number): Workspace {
  const id = leafIds(ws.root)[n - 1];
  return id ? focusPane(ws, id) : ws;
}

/** Alt+arrows: the visible neighbour in a direction. */
export function focusDir(ws: Workspace, edge: Edge, rects: ReadonlyMap<PaneId, Rect>): Workspace {
  const id = neighbor(rects, ws.focused, edge, ws.mru);
  return id ? focusPane(ws, id) : ws;
}

// ── split, open beside, close, reopen ──────────────────────────────────────

/** What a split shows: the same view, except that held work is never cloned (§3.2). */
export function cloneView(p: PaneState): ViewState {
  const cur = currentView(p);
  if (cur.kind === "doc") return restoreView(cur);
  if (!isHeldView(cur)) return cur;
  for (let i = p.index - 1; i >= 0; i--) if (!isHeldView(p.history[i])) return p.history[i];
  return { kind: "home" };
}

/** Splits a pane; the new pane shows `view` (default: a clone) and takes focus. */
export function splitPane(ws: Workspace, id: PaneId, edge: Edge, ids: IdGen, view?: ViewState): OpResult {
  const src = ws.panes[id];
  if (!src) return { ws };
  if (leafIds(ws.root).length >= MAX_LEAVES) return { ws, error: CAP_MESSAGE };
  const next = ids();
  const root = insertBeside(ws.root, id, next, edge, ids);
  const out = touch(ws, { root, panes: { ...ws.panes, [next]: pane(next, view ?? cloneView(src), undefined, src.context) } });
  return { ws: focusPane(out, next), pane: next };
}

/** §4.5: describe, YAML and `why` opened beside follow the source cursor; everything else is pinned. */
export const followsByDefault = (v: ViewState): boolean =>
  (v.kind === "doc" && v.mode === "view" && (v.format === "describe" || v.format === "yaml")) || v.kind === "why";

/** Following panes that leave focus on the source (the cursor keeps moving there). */
const keepsSourceFocus = (v: ViewState): boolean => v.kind === "doc" || v.kind === "why";

export const sameTarget = (a: ViewState, b: ViewState): boolean =>
  a.kind === b.kind && (a.kind !== "doc" || (b.kind === "doc" && a.format === b.format));

export interface OpenBesideResult extends OpResult {
  /** true when a following pane was retargeted instead of a new one opened */
  reused?: boolean;
}

/**
 * Opens a view beside `source` (§4.4). A following pane of the same kind (and doc format) linked
 * to the source is retargeted; pinned panes are never reused; otherwise the source is split.
 * The new pane takes focus, except a following doc pane.
 */
export function openBeside(
  ws: Workspace, source: PaneId, view: ViewState, edge: Edge, ids: IdGen, opts: { follow?: boolean; context?: string } = {},
): OpenBesideResult {
  if (!ws.panes[source]) return { ws };
  // the new pane is in the source's context unless one is asked for (context picker Ctrl/⌘+Enter, §8.3)
  const context = normalContext(ws, opts.context ?? ws.panes[source].context);
  for (const id of leafIds(ws.root)) {
    const p = ws.panes[id];
    if (id !== source && p.link?.source === source && p.link.follow && p.context === context && sameTarget(currentView(p), view)) {
      return { ws: replaceView(ws, id, view), pane: id, reused: true };
    }
  }
  if (leafIds(ws.root).length >= MAX_LEAVES) return { ws, error: CAP_MESSAGE };
  const follow = (opts.follow ?? followsByDefault(view)) && context === ws.panes[source].context;
  const next = ids();
  const root = insertBeside(ws.root, source, next, edge, ids);
  // a pane in another context than its source never follows it: the source's cursor names objects of another cluster
  const linked = context === ws.panes[source].context ? { source, follow } : { source, follow: false };
  let out = touch(ws, { root, panes: { ...ws.panes, [next]: pane(next, view, linked, context) } });
  // MRU still records the new pane right behind the source, so closing the source lands on it
  out = follow && keepsSourceFocus(view) ? { ...out, mru: [out.mru[0], next, ...out.mru.slice(1)] } : focusPane(out, next);
  return { ws: out, pane: next };
}

function unlink(panes: Record<PaneId, PaneState>, gone: PaneId): Record<PaneId, PaneState> {
  let out = panes;
  for (const p of Object.values(panes)) {
    if (p.link?.source === gone) {
      if (out === panes) out = { ...panes };
      out[p.id] = { ...p, link: { source: null, follow: false } };
    }
  }
  return out;
}

/**
 * Closes a pane (§3.2). Its fraction goes to the siblings, it goes on the reopen stack, and focus
 * returns to its opener, else the MRU pane. Closing the last pane resets it to `home`.
 */
export function closePane(ws: Workspace, id: PaneId, now: number, ids: IdGen): Workspace {
  const state = ws.panes[id];
  if (!state) return ws;
  const at = parentOf(ws.root, id);
  const entry: ClosedEntry = { pane: state, parent: at?.split.id ?? "", at: now };
  if (at) {
    const { split, index } = at;
    const horizontal = split.dir === "row";
    const after = index > 0;
    const sibling = split.children[after ? index - 1 : 1];
    const l = leafIds(sibling);
    entry.beside = after ? l[l.length - 1] : l[0];
    if (sibling.kind === "split") entry.besideSplit = sibling.id;
    entry.edge = after ? (horizontal ? "right" : "down") : horizontal ? "left" : "up";
    entry.size = split.sizes[index];
  }
  const closed = [...ws.closed, entry].slice(-CLOSED_CAP);
  const root = removeLeaf(ws.root, id);
  if (!root) {
    const fresh = ids();
    return touch(ws, { root: leaf(fresh), panes: { [fresh]: pane(fresh, { kind: "home" }) }, focused: fresh, mru: [fresh], zoomed: null, closed });
  }
  const { [id]: _gone, ...rest } = ws.panes;
  const panes = unlink(rest, id);
  let mru = ws.mru.filter((p) => p !== id);
  let focused = ws.focused;
  if (focused === id) {
    const opener = state.link?.source;
    focused = opener && panes[opener] ? opener : (mru[0] ?? leafIds(root)[0]);
    mru = [focused, ...mru.filter((p) => p !== focused)];
  }
  const single = root.kind === "leaf";
  const zoomed = single ? null : ws.zoomed === id ? focused : ws.zoomed;
  return touch(ws, { root, panes, focused, mru, zoomed, closed });
}

/** Leader o: closes every other pane; each goes on the reopen stack. */
export function closeOthers(ws: Workspace, keep: PaneId, now: number, ids: IdGen): Workspace {
  if (!ws.panes[keep]) return ws;
  let out = focusPane(ws, keep);
  for (const id of leafIds(ws.root)) if (id !== keep) out = closePane(out, id, now, ids);
  return out;
}

/** Reopens the last closed pane beside its former neighbour, else in its former split, else at the root. */
export function reopenPane(ws: Workspace, ids: IdGen): OpResult {
  const entry = ws.closed[ws.closed.length - 1] as ClosedEntry | undefined;
  if (!entry) return { ws, error: "no closed pane to reopen" };
  if (leafIds(ws.root).length >= MAX_LEAVES) return { ws, error: CAP_MESSAGE };
  const old = entry.pane;
  const id = ws.panes[old.id] ? ids() : old.id;
  const history = old.history.map(restoreView);
  const link = old.link && old.link.source && ws.panes[old.link.source] ? old.link : old.link ? { source: null, follow: false } : undefined;
  const state: PaneState = { ...old, id, history, link };
  if (!link) delete state.link;
  let root: LayoutNode;
  if (entry.besideSplit && entry.edge && findSplit(ws.root, entry.besideSplit)) {
    root = insertBesideSplit(ws.root, entry.besideSplit, id, entry.edge, ids, entry.size);
  } else if (entry.beside && entry.edge && ws.panes[entry.beside]) {
    // the sibling subtree is gone: next to its nearest pane, with an equal share
    root = insertBeside(ws.root, entry.beside, id, entry.edge, ids, entry.besideSplit ? undefined : entry.size);
  } else if (entry.parent && findSplit(ws.root, entry.parent)) root = appendToSplit(ws.root, entry.parent, id);
  else root = insertAtRoot(ws.root, id, "right", ids);
  const out = touch(ws, { root, panes: { ...ws.panes, [id]: state }, closed: ws.closed.slice(0, -1) });
  return { ws: focusPane(out, id), pane: id };
}

// ── move, flip, sizes, zoom ────────────────────────────────────────────────

/** Leader H J K L: swap with the neighbour in that direction; at the outermost edge, dock at root level. */
export function movePane(ws: Workspace, id: PaneId, edge: Edge, rects: ReadonlyMap<PaneId, Rect>, ids: IdGen): Workspace {
  if (!ws.panes[id]) return ws;
  const other = neighbor(rects, id, edge, ws.mru);
  if (other) return withRoot(ws, swapLeaves(ws.root, id, other));
  return dockPane(ws, id, edge, ids);
}

/** Moves a pane to an outermost edge of the window. */
export function dockPane(ws: Workspace, id: PaneId, edge: Edge, ids: IdGen): Workspace {
  if (!ws.panes[id] || ws.root.kind === "leaf") return ws;
  if (ws.root.dir === edgeDir(edge)) {
    const end = edge === "left" || edge === "up" ? ws.root.children[0] : ws.root.children[ws.root.children.length - 1];
    if (end.kind === "leaf" && end.pane === id) return ws;
  }
  const rest = removeLeaf(ws.root, id);
  return rest ? withRoot(ws, normalize(insertAtRoot(rest, id, edge, ids))) : ws;
}

/** MOVE mode / drag: inserts `id` on an edge of `target` (§3.5). */
export function insertPane(ws: Workspace, id: PaneId, target: PaneId, edge: Edge, ids: IdGen): Workspace {
  if (id === target || !ws.panes[id] || !ws.panes[target]) return ws;
  const rest = removeLeaf(ws.root, id);
  return rest ? withRoot(ws, normalize(insertBeside(rest, target, id, edge, ids))) : ws;
}

export function swapPanes(ws: Workspace, a: PaneId, b: PaneId): Workspace {
  if (!ws.panes[a] || !ws.panes[b]) return ws;
  return withRoot(ws, swapLeaves(ws.root, a, b));
}

/** Leader t: toggles the dir of the pane's parent split. */
export function flipSplit(ws: Workspace, id: PaneId): Workspace {
  const at = parentOf(ws.root, id);
  return at ? withRoot(ws, treeFlip(ws.root, at.split.id)) : ws;
}

/** Leader =: equal fractions for the children of the pane's parent split. */
export function equalize(ws: Workspace, id: PaneId): Workspace {
  const at = parentOf(ws.root, id);
  return at ? withRoot(ws, equalizeSplit(ws.root, at.split.id)) : ws;
}

/** Leader 0: equal fractions in the whole tree. */
export const equalizeAll = (ws: Workspace): Workspace => withRoot(ws, treeEqualizeAll(ws.root));

export const setSizes = (ws: Workspace, splitId: string, sizes: readonly number[]): Workspace =>
  withRoot(ws, setSplitSizes(ws.root, splitId, sizes));

/** Zoom sets `zoomed`; the tree is untouched (§3.4). A single pane cannot zoom. */
export function toggleZoom(ws: Workspace, id: PaneId): Workspace {
  if (!ws.panes[id] || ws.root.kind === "leaf") return ws.zoomed ? { ...ws, zoomed: null } : ws;
  if (ws.zoomed) return { ...ws, zoomed: null };
  return { ...focusPane(ws, id), zoomed: id };
}

// ── history (§4.3) ─────────────────────────────────────────────────────────

/** Pushes a view on a pane's stack. A push from mid-stack truncates the forward entries. */
export function pushView(ws: Workspace, id: PaneId, view: ViewState): Workspace {
  const p = ws.panes[id];
  if (!p) return ws;
  let history = [...p.history.slice(0, p.index + 1), view];
  let last = p.index;
  const over = history.length - HISTORY_CAP;
  if (over > 0) {
    history = history.slice(over);
    last = Math.max(0, last - over);
  }
  return setPane(ws, { ...p, history, index: history.length - 1, last });
}

/** Edits the current entry without pushing (namespace, filter, sort, follow retarget). */
export function replaceView(ws: Workspace, id: PaneId, view: ViewState | ((v: ViewState) => ViewState)): Workspace {
  const p = ws.panes[id];
  if (!p) return ws;
  const cur = currentView(p);
  const next = typeof view === "function" ? view(cur) : view;
  if (next === cur) return ws;
  const history = [...p.history];
  history[p.index] = next;
  return setPane(ws, { ...p, history });
}

/** `,` and `.`: moves the index; `Esc` step 9 is historyGo(-1). */
export function historyGo(ws: Workspace, id: PaneId, delta: number): Workspace {
  const p = ws.panes[id];
  if (!p) return ws;
  const index = p.index + delta;
  if (delta === 0 || index < 0 || index >= p.history.length) return ws;
  return setPane(ws, { ...p, index, last: p.index });
}

/** `-`: toggles the last view. */
export function historyLast(ws: Workspace, id: PaneId): Workspace {
  const p = ws.panes[id];
  if (!p || p.last === undefined || p.last === p.index || p.last < 0 || p.last >= p.history.length) return ws;
  return setPane(ws, { ...p, index: p.last, last: p.index });
}

export const canGoBack = (ws: Workspace, id: PaneId): boolean => (ws.panes[id]?.index ?? 0) > 0;
export const canGoForward = (ws: Workspace, id: PaneId): boolean => {
  const p = ws.panes[id];
  return !!p && p.index < p.history.length - 1;
};

// ── follow links (§4.5) ────────────────────────────────────────────────────

/** Leader f: toggles follow on a linked pane. Shells cannot follow. */
export function toggleFollow(ws: Workspace, id: PaneId): OpResult {
  const p = ws.panes[id];
  if (!p) return { ws };
  const kind = currentView(p).kind;
  if (kind === "shell" || kind === "attach") return { ws, error: "a shell cannot follow" };
  if (!p.link || p.link.source === null || !ws.panes[p.link.source]) return { ws, error: "this pane has no source pane" };
  // §8.3: the source's cursor names objects of another cluster
  if (contextOfPane(ws, id) !== contextOfPane(ws, p.link.source)) return { ws, error: "the source pane is in another context" };
  return { ws: setPane(ws, { ...p, link: { ...p.link, follow: !p.link.follow } }), pane: id };
}

/** The context to store on a pane: undefined for the workspace's own. */
const normalContext = (ws: Workspace, context: string | undefined): string | undefined => (context && context !== ws.context ? context : undefined);

/**
 * Puts a pane in another kube context (§8.3). Its history restarts at `view` (default: its current
 * view, which is re-read there): back must never return to an object of the other cluster. Panes
 * linked to it are unlinked, and a pane cannot follow one in another context.
 */
export function setPaneContext(ws: Workspace, id: PaneId, context: string, view?: ViewState): Workspace {
  const p = ws.panes[id];
  if (!p) return ws;
  const next = normalContext(ws, context);
  if (next === p.context && !view) return ws;
  const v = view ?? cloneView(p);
  const state: PaneState = { id, history: [v], index: 0 };
  if (p.link) state.link = { source: p.link.source, follow: false };
  if (p.agent) state.agent = p.agent;
  if (next) state.context = next;
  let panes: Record<PaneId, PaneState> = { ...ws.panes, [id]: state };
  for (const o of Object.values(panes)) if (o.link?.source === id && o.link.follow) panes = { ...panes, [o.id]: { ...o, link: { source: id, follow: false } } };
  return touch(ws, { panes });
}

/** The panes that follow `source` right now. */
export function followers(ws: Workspace, source: PaneId): PaneId[] {
  const out: PaneId[] = [];
  const ctx = contextOfPane(ws, source);
  for (const p of Object.values(ws.panes)) if (p.link?.source === source && p.link.follow && contextOfPane(ws, p.id) === ctx) out.push(p.id);
  return out;
}

// ── validation and restore (§3.6) ──────────────────────────────────────────

/** Invariant violations, for tests and load-time checks. */
export function workspaceErrors(ws: Workspace): string[] {
  const out = treeErrors(ws.root);
  const leaves = leafIds(ws.root);
  const ids = Object.keys(ws.panes);
  for (const l of leaves) if (!ws.panes[l]) out.push(`leaf ${l} has no pane state`);
  for (const id of ids) {
    if (!leaves.includes(id)) out.push(`pane ${id} is not in the tree`);
    const p = ws.panes[id];
    if (p.id !== id) out.push(`pane ${id} has id ${p.id}`);
    if (p.history.length === 0 || p.history.length > HISTORY_CAP) out.push(`pane ${id}: history length ${p.history.length}`);
    if (!(p.index >= 0 && p.index < p.history.length)) out.push(`pane ${id}: index out of range`);
    if (p.link?.source && !ws.panes[p.link.source]) out.push(`pane ${id}: link to a missing pane`);
  }
  if (leaves.length > MAX_LEAVES) out.push("more than 12 leaves");
  if (!ws.panes[ws.focused]) out.push("focused pane is missing");
  if (ws.zoomed !== null && !ws.panes[ws.zoomed]) out.push("zoomed pane is missing");
  if (ws.mru[0] !== ws.focused) out.push("mru does not start with the focused pane");
  if (ws.mru.length !== leaves.length || new Set(ws.mru).size !== ws.mru.length || ws.mru.some((p) => !ws.panes[p])) out.push("mru is not a permutation of the panes");
  if (ws.closed.length > CLOSED_CAP) out.push("closed stack too long");
  return out;
}

const VIEW_KINDS: ReadonlySet<string> = new Set<ViewKind>([
  "table", "containers", "doc", "logs", "shell", "attach", "home", "portforwards", "settings", "aliases", "messages",
]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isGvr = (v: unknown): v is Gvr => isObj(v) && typeof v.group === "string" && typeof v.version === "string" && typeof v.resource === "string";
const isRef = (v: unknown): boolean => isObj(v) && isGvr(v.gvr) && typeof v.name === "string";
const isTarget = (v: unknown): boolean =>
  isObj(v) && ((v.by === "object" && isRef(v.ref)) || (v.by === "paneSelection" && typeof v.pane === "string") || (v.by === "selector" && typeof v.selector === "string") ||
    (v.by === "objects" && Array.isArray(v.refs) && v.refs.length > 0 && v.refs.every(isRef)));

/** A stored view that is safe to hand to a view component, or null. */
export function sanitizeView(raw: unknown): ViewState | null {
  if (!isObj(raw) || typeof raw.kind !== "string" || !VIEW_KINDS.has(raw.kind)) return null;
  const v = raw as unknown as ViewState;
  switch (v.kind) {
    case "table":
      if (!isGvr(v.gvr) || typeof v.namespace !== "string") return null;
      return restoreView({ ...v, filters: Array.isArray(v.filters) ? v.filters.filter(isObj) : [], faultsOnly: v.faultsOnly === true, sort: isObj(v.sort) ? v.sort : null, wide: v.wide === true });
    case "containers":
      return isRef(v.pod) ? { ...v, sort: isObj(v.sort) ? v.sort : null } : null;
    case "doc":
      return isRef(v.ref) && ["yaml", "describe", "json", "secret"].includes(v.format) ? restoreView(v) : null;
    case "logs":
      return isTarget(v.target) ? v : null;
    case "shell":
    case "attach":
      return isTarget(v.target) && ["object", "paneSelection"].includes((v.target as { by: string }).by) ? restoreView(v) : null;
    default:
      // only tool kinds pass VIEW_KINDS; feature kinds (plan-features §2.8) are dropped above
      return { kind: v.kind } as ViewState;
  }
}

function sanitizePane(raw: unknown, id: PaneId): PaneState | null {
  if (!isObj(raw) || !Array.isArray(raw.history)) return null;
  // a pane an agent opened (show_in_kns, plan-features §2.8) is never restored: without its AGENT
  // label it would pass as the human's own
  if (typeof raw.agent === "string") return null;
  const history: ViewState[] = [];
  let index = typeof raw.index === "number" ? Math.round(raw.index) : 0;
  raw.history.slice(-HISTORY_CAP).forEach((h, i) => {
    const v = sanitizeView(h);
    if (v) history.push(v);
    else if (i < index) index--;
  });
  if (history.length === 0) return null;
  index = Math.min(history.length - 1, Math.max(0, index));
  const out: PaneState = { id, history, index };
  if (typeof raw.last === "number" && raw.last >= 0 && raw.last < history.length) out.last = Math.round(raw.last);
  if (isObj(raw.link)) out.link = { source: typeof raw.link.source === "string" ? raw.link.source : null, follow: raw.link.follow === true };
  // kept even when the kubeconfig no longer has it: the pane then shows the context as offline
  // instead of silently showing another cluster
  if (typeof raw.context === "string" && raw.context !== "") out.context = raw.context;
  return out;
}

function sanitizeNode(raw: unknown, panes: Record<PaneId, PaneState>, seen: Set<string>): LayoutNode | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "leaf") {
    if (typeof raw.pane !== "string" || !panes[raw.pane] || seen.has(raw.pane)) return null;
    seen.add(raw.pane);
    return leaf(raw.pane);
  }
  if (raw.kind !== "split" || !Array.isArray(raw.children) || typeof raw.id !== "string") return null;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  const kids: unknown[] = raw.children;
  const rawSizes: unknown[] = Array.isArray(raw.sizes) ? raw.sizes : [];
  kids.forEach((c, i) => {
    const n = sanitizeNode(c, panes, seen);
    if (!n) return;
    children.push(n);
    const s = rawSizes[i];
    sizes.push(typeof s === "number" && s > 0 && Number.isFinite(s) ? s : 1 / kids.length);
  });
  if (children.length === 0) return null;
  let id = raw.id;
  while (seen.has(`split:${id}`)) id += "'";
  seen.add(`split:${id}`);
  return { kind: "split", id, dir: raw.dir === "col" ? "col" : "row", children, sizes };
}

/**
 * Validates a stored workspace field by field and applies the restore rules of §3.6: shells come
 * back as placeholders, edits as views. Null when nothing usable is left.
 */
export function sanitizeWorkspace(raw: unknown, context: string): Workspace | null {
  if (!isObj(raw) || !isObj(raw.panes)) return null;
  const all: Record<PaneId, PaneState> = {};
  for (const [id, p] of Object.entries(raw.panes)) {
    const s = sanitizePane(p, id);
    if (s) all[id] = s;
  }
  const seen = new Set<string>();
  const parsed = sanitizeNode(raw.root, all, seen);
  if (!parsed) return null;
  const root = normalize(parsed);
  let leaves = leafIds(root);
  let tree = root;
  // never restore more than the cap
  for (const extra of leaves.slice(MAX_LEAVES)) tree = removeLeaf(tree, extra) ?? tree;
  leaves = leafIds(tree);
  const panes: Record<PaneId, PaneState> = {};
  for (const id of Object.keys(all)) {
    if (!leaves.includes(id)) continue;
    let p = all[id];
    if (p.context === context) {
      p = { ...p };
      delete p.context;
    }
    panes[id] = p.link?.source && !leaves.includes(p.link.source) ? { ...p, link: { source: null, follow: false } } : p;
  }
  const stored = Array.isArray(raw.mru) ? raw.mru.filter((p): p is string => typeof p === "string" && !!panes[p]) : [];
  const focused = typeof raw.focused === "string" && panes[raw.focused] ? raw.focused : (stored[0] ?? leaves[0]);
  const mru = [...new Set([focused, ...stored, ...leaves])];
  const closed: ClosedEntry[] = [];
  if (Array.isArray(raw.closed)) {
    for (const c of raw.closed.slice(-CLOSED_CAP)) {
      if (!isObj(c) || !isObj(c.pane) || typeof c.pane.id !== "string") continue;
      const p = sanitizePane(c.pane, c.pane.id);
      if (!p) continue;
      const e: ClosedEntry = { pane: p, parent: typeof c.parent === "string" ? c.parent : "", at: typeof c.at === "number" ? c.at : 0 };
      if (typeof c.beside === "string" && (c.edge === "left" || c.edge === "right" || c.edge === "up" || c.edge === "down")) {
        e.beside = c.beside;
        e.edge = c.edge;
        if (typeof c.besideSplit === "string") e.besideSplit = c.besideSplit;
        if (typeof c.size === "number" && c.size > 0 && c.size < 1) e.size = c.size;
      }
      closed.push(e);
    }
  }
  const ws: Workspace = {
    schema: 1,
    context,
    root: tree,
    panes,
    focused,
    zoomed: typeof raw.zoomed === "string" && panes[raw.zoomed] && leaves.length > 1 ? raw.zoomed : null,
    mru,
    closed,
    dirty: raw.dirty === true,
  };
  if (typeof raw.layoutId === "string") ws.layoutId = raw.layoutId;
  return ws;
}
