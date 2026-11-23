// Favourite views and saved layouts as data (docs/ux.md §7): conversion to and from the live
// workspace, summaries for the picker, and validation of stored values. Pure.
import { leafIds } from "../../store/layout-tree";
import { restoreView, sanitizeView } from "../../store/workspace";
import type { FavoriteView, Filter, LayoutNode, PaneId, SavedLayout, TableView, ViewState, Workspace } from "../../types";
import { isSlot } from "./slots";

type FavView = FavoriteView["view"];

// ── favourite views (§7.1) ───────────────────────────────────────────────────

/** What a favourite keeps of a table view: resource, namespace, filters, faults, sort, wide. */
export function toFavouriteView(view: TableView, currentNamespace: boolean): FavView {
  const out: FavView = {
    kind: "table", gvr: view.gvr, filters: view.filters, faultsOnly: view.faultsOnly, sort: view.sort, wide: view.wide,
    namespace: currentNamespace ? { current: true } : view.namespace,
  };
  if (view.scope) out.scope = view.scope;
  return out;
}

/** The table view a favourite opens; "current" resolves to the target pane's namespace (§7.1). */
export function fromFavouriteView(fav: FavView, paneNamespace: string | undefined): TableView {
  const { namespace, ...rest } = fav;
  return { ...rest, namespace: typeof namespace === "string" ? namespace : (paneNamespace ?? "*") };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** True when the pane's view is exactly what the favourite would open there (`FAV n` label). */
export function matchesFavourite(fav: FavView, view: ViewState): boolean {
  if (view.kind !== "table") return false;
  if (fav.gvr.resource !== view.gvr.resource || fav.gvr.group !== view.gvr.group) return false;
  if (typeof fav.namespace === "string" && fav.namespace !== view.namespace) return false;
  return (
    fav.faultsOnly === view.faultsOnly && fav.wide === view.wide && same(fav.filters, view.filters) &&
    same(fav.sort, view.sort) && same(fav.scope ?? null, view.scope ?? null)
  );
}

export function filterText(f: Filter): string {
  if (f.mode === "label") return `-l ${f.selector}`;
  return f.mode === "re" ? `/${f.text}` : f.mode === "not" ? `/!${f.text}` : `-f ${f.text}`;
}

/** `pods · shop · /web` */
export function favouriteSummary(fav: FavView): string {
  const parts = [fav.gvr.resource, typeof fav.namespace === "string" ? (fav.namespace === "*" ? "all" : fav.namespace) : "current"];
  for (const f of fav.filters) parts.push(filterText(f));
  if (fav.faultsOnly) parts.push("faults");
  if (fav.sort) parts.push(`${fav.sort.column}${fav.sort.desc ? "↓" : "↑"}`);
  if (fav.wide) parts.push("wide");
  return parts.join(" · ");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function sanitizeFavourites(raw: unknown): FavoriteView[] {
  if (!Array.isArray(raw)) return [];
  const out: FavoriteView[] = [];
  const ids = new Set<string>();
  const slots = new Set<number>();
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.name !== "string" || ids.has(r.id) || !isObj(r.view)) continue;
    const current = isObj(r.view.namespace) && r.view.namespace.current === true;
    const view = sanitizeView({ ...r.view, kind: "table", namespace: current ? "*" : r.view.namespace });
    if (!view || view.kind !== "table") continue;
    const { cursorUid: _cursor, namespace, ...rest } = view;
    const fav: FavoriteView = { id: r.id, name: r.name, view: { ...rest, namespace: current ? { current: true } : namespace } };
    if (isSlot(r.slot) && !slots.has(r.slot)) {
      fav.slot = r.slot;
      slots.add(r.slot);
    }
    ids.add(r.id);
    out.push(fav);
  }
  return out;
}

// ── saved layouts (§7.2) ─────────────────────────────────────────────────────

/** Short name of a view for the text summary. */
export function viewLabel(v: ViewState): string {
  switch (v.kind) {
    case "table":
      return v.gvr.resource;
    case "containers":
      return "containers";
    case "doc":
      return v.format;
    case "portforwards":
      return "port-forwards";
    case "messages":
      return "errors";
    default:
      return v.kind;
  }
}

/** `pods | svc / logs`: `|` side by side, `/` stacked, nested splits in brackets. */
export function treeSummary(root: LayoutNode, views: Readonly<Record<PaneId, ViewState>>): string {
  const walk = (n: LayoutNode, top: boolean): string => {
    if (n.kind === "leaf") return views[n.pane] ? viewLabel(views[n.pane]) : "?";
    const s = n.children.map((c) => walk(c, false)).join(n.dir === "row" ? " | " : " / ");
    return top ? s : `(${s})`;
  };
  return walk(root, true);
}

/**
 * What a layout stores of a pane's view. Log and shell panes are saved as the selection of
 * another pane, never as a pod name (§7.2); recall never execs.
 */
function savedView(ws: Workspace, id: PaneId, order: readonly PaneId[]): ViewState {
  const pane = ws.panes[id];
  const v = restoreView(pane.history[pane.index]);
  if (v.kind === "table") {
    const { cursorUid: _cursor, ...rest } = v;
    return rest;
  }
  if (v.kind === "logs" || v.kind === "shell" || v.kind === "attach") {
    if (v.target.by !== "object") return v;
    const linked = pane.link?.source && ws.panes[pane.link.source] ? pane.link.source : undefined;
    const table = linked ?? order.find((p) => p !== id && ws.panes[p].history[ws.panes[p].index].kind === "table");
    // nothing to take a selection from: the pane comes back as home rather than as a pod name
    if (!table) return { kind: "home" };
    return { ...v, target: { by: "paneSelection", pane: table } } as ViewState;
  }
  return v;
}

export function toSavedLayout(ws: Workspace, id: string, name: string, slot?: SavedLayout["slot"]): SavedLayout {
  const order = leafIds(ws.root);
  const views: Record<PaneId, ViewState> = {};
  const links: SavedLayout["links"] = {};
  for (const p of order) {
    views[p] = savedView(ws, p, order);
    const link = ws.panes[p].link;
    if (link?.source && order.includes(link.source)) links[p] = { source: link.source, follow: link.follow };
  }
  const contexts: Record<PaneId, string> = {};
  for (const p of order) {
    const c = ws.panes[p].context;
    if (c && c !== ws.context) contexts[p] = c;
  }
  const out: SavedLayout = { id, name, root: ws.root, views, focused: ws.focused, links };
  if (Object.keys(contexts).length > 0) out.contexts = contexts;
  if (slot !== undefined) out.slot = slot;
  return out;
}

/** Builds a fresh workspace from a layout: new pane and split ids, one history entry per pane. */
export function fromSavedLayout(layout: SavedLayout, context: string, ids: () => string): Workspace {
  const map = new Map<PaneId, PaneId>();
  for (const p of leafIds(layout.root)) map.set(p, ids());
  const remapNode = (n: LayoutNode): LayoutNode =>
    n.kind === "leaf" ? { kind: "leaf", pane: map.get(n.pane) as PaneId } : { ...n, id: ids(), children: n.children.map(remapNode), sizes: [...n.sizes] };
  const remapView = (v: ViewState): ViewState => {
    if ((v.kind === "logs" || v.kind === "shell" || v.kind === "attach") && v.target.by === "paneSelection") {
      const pane = map.get(v.target.pane);
      return pane ? ({ ...v, target: { by: "paneSelection", pane } } as ViewState) : { kind: "home" };
    }
    return restoreView(v);
  };
  const panes: Workspace["panes"] = {};
  for (const [old, id] of map) {
    const view = remapView(layout.views[old] ?? { kind: "home" });
    const link = layout.links[old];
    const source = link ? map.get(link.source) : undefined;
    panes[id] = source ? { id, history: [view], index: 0, link: { source, follow: link.follow } } : { id, history: [view], index: 0 };
    // §8.3: a pane saved in its own context comes back in it (never silently in the window's)
    const own = layout.contexts?.[old];
    if (own && own !== context) panes[id].context = own;
  }
  const order = [...map.values()];
  const focused = map.get(layout.focused) ?? order[0];
  return {
    schema: 1, context, root: remapNode(layout.root), panes, focused, zoomed: null,
    mru: [focused, ...order.filter((p) => p !== focused)], closed: [], layoutId: layout.id, dirty: false,
  };
}

function sanitizeNode(raw: unknown, seen: Set<string>): LayoutNode | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "leaf") {
    if (typeof raw.pane !== "string" || seen.has(raw.pane)) return null;
    seen.add(raw.pane);
    return { kind: "leaf", pane: raw.pane };
  }
  if (raw.kind !== "split" || !Array.isArray(raw.children) || typeof raw.id !== "string") return null;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  const rawSizes: unknown[] = Array.isArray(raw.sizes) ? raw.sizes : [];
  raw.children.forEach((c: unknown, i: number) => {
    const n = sanitizeNode(c, seen);
    if (!n) return;
    children.push(n);
    const s = rawSizes[i];
    sizes.push(typeof s === "number" && s > 0 && Number.isFinite(s) ? s : 1);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { kind: "split", id: raw.id, dir: raw.dir === "col" ? "col" : "row", children, sizes: sizes.map((s) => s / total) };
}

export function sanitizeLayouts(raw: unknown): SavedLayout[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedLayout[] = [];
  const ids = new Set<string>();
  const slots = new Set<number>();
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.name !== "string" || ids.has(r.id) || !isObj(r.views)) continue;
    const root = sanitizeNode(r.root, new Set());
    if (!root) continue;
    const leaves = leafIds(root);
    const views: Record<PaneId, ViewState> = {};
    for (const p of leaves) views[p] = sanitizeView(r.views[p]) ?? { kind: "home" };
    const links: SavedLayout["links"] = {};
    if (isObj(r.links)) {
      for (const [p, l] of Object.entries(r.links)) {
        if (isObj(l) && typeof l.source === "string" && leaves.includes(p) && leaves.includes(l.source)) links[p] = { source: l.source, follow: l.follow === true };
      }
    }
    const layout: SavedLayout = {
      id: r.id, name: r.name, root, views, links,
      focused: typeof r.focused === "string" && leaves.includes(r.focused) ? r.focused : leaves[0],
    };
    if (isObj(r.contexts)) {
      const contexts: Record<PaneId, string> = {};
      for (const [p, c] of Object.entries(r.contexts)) if (leaves.includes(p) && typeof c === "string" && c !== "") contexts[p] = c;
      if (Object.keys(contexts).length > 0) layout.contexts = contexts;
    }
    if (isSlot(r.slot) && !slots.has(r.slot)) {
      layout.slot = r.slot;
      slots.add(r.slot);
    }
    ids.add(r.id);
    out.push(layout);
  }
  return out;
}

/** The views of a layout by pane position, with pane references as positions (ids differ per recall). */
function viewsByPosition(root: LayoutNode, views: Readonly<Record<PaneId, ViewState>>): string {
  const order = leafIds(root);
  return JSON.stringify(
    order.map((p) => {
      const v = views[p];
      if (v && (v.kind === "logs" || v.kind === "shell" || v.kind === "attach") && v.target.by === "paneSelection") {
        return { ...v, target: { by: "paneSelection", pane: order.indexOf(v.target.pane) } };
      }
      return v ?? null;
    }),
  );
}

/**
 * True when the workspace is this layout and nothing was changed since: the tree (the
 * foundation's `dirty` flag covers splits, closes and sizes) and every pane's view. Navigation
 * does not set `dirty`, so the views are compared here.
 */
export function isLayoutUnedited(ws: Workspace, layout: SavedLayout): boolean {
  if (ws.layoutId !== layout.id || ws.dirty) return false;
  const now = toSavedLayout(ws, layout.id, layout.name);
  return viewsByPosition(now.root, now.views) === viewsByPosition(layout.root, layout.views);
}
