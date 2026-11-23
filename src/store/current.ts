// The current object (docs/plan-features.md §2.10): what "this pod" means for the tools hub's
// "Try", `:pack` and the selection an agent reads (`get_selection`).
//
// 1. the focused pane's cursor row;
// 2. else the cursor of the previous history entry of the focused pane, when that entry was a
//    table (the hub, why ... opened in place over it: tables drop their selection on unmount, so
//    the last one is cached here per pane with the history index it belonged to);
// 3. else the cursor of the last table pane that published one.
import type { ObjectRef, PaneId, ViewKind } from "../types";
import { getWorkspace } from "./layout";
import { getSelection, onAnySelection, type PaneSelection } from "./selection";
import { contextOfPane, currentView } from "./workspace";

export interface CurrentObject {
  /** the pane whose cursor it is */
  paneId: PaneId;
  ref: ObjectRef;
  /** marked rows of that pane (empty when none) */
  marked: readonly ObjectRef[];
  /** the view kind that published it (table, containers) */
  kind: ViewKind;
  /** containers view: the container under the cursor (`ref` is its pod) */
  container?: string;
}

/** A pane's last published cursor (already resolved, see toCurrent), with the history entry it belonged to. */
export interface CachedCursor {
  ref: ObjectRef;
  marked: readonly ObjectRef[];
  kind: ViewKind;
  container?: string;
  /** history index of the entry that published it */
  index: number;
}

/** What the resolution needs to know about a pane's current entry. */
export interface EntryInfo {
  kind: ViewKind;
  index: number;
  previousKind: ViewKind | null;
  /** containers view: its pod */
  pod?: ObjectRef;
}

/** What the resolution reads; injected so it is tested without stores. */
export interface CurrentInput {
  focused: PaneId | null;
  /** live selection of a pane */
  selection: (pane: PaneId) => PaneSelection;
  /** the pane's current entry (kind, history index) and the kind of the entry before it; null when the pane is gone */
  entry: (pane: PaneId) => EntryInfo | null;
  cache: ReadonlyMap<PaneId, CachedCursor>;
  /** the last table-like pane that published a cursor */
  lastTable: PaneId | null;
}

const TABLE_LIKE: ReadonlySet<ViewKind> = new Set<ViewKind>(["table", "containers"]);
export const isTableLike = (kind: ViewKind): boolean => TABLE_LIKE.has(kind);

/**
 * A published selection as a current object. A containers view publishes the pod's gvr with the
 * container's name (follow links rely on it, §12.5); here it becomes the pod plus `container`.
 */
export function toCurrent(pane: PaneId, sel: PaneSelection, e: EntryInfo): CurrentObject | null {
  if (!sel.focused) return null;
  if (e.kind === "containers") return e.pod ? { paneId: pane, ref: e.pod, marked: [], kind: e.kind, container: sel.focused.name } : null;
  return { paneId: pane, ref: sel.focused, marked: sel.marked, kind: e.kind };
}

const fromCache = (pane: PaneId, c: CachedCursor): CurrentObject => {
  const out: CurrentObject = { paneId: pane, ref: c.ref, marked: c.marked, kind: c.kind };
  if (c.container !== undefined) out.container = c.container;
  return out;
};

/** Pure resolution of §2.10's three rules. */
export function resolveCurrent(input: CurrentInput): CurrentObject | null {
  const { focused, selection, entry, cache, lastTable } = input;
  if (focused) {
    const e = entry(focused);
    const live = e && isTableLike(e.kind) ? toCurrent(focused, selection(focused), e) : null;
    if (live) return live;
    const c = cache.get(focused);
    if (e && c && e.index > 0 && c.index === e.index - 1 && e.previousKind !== null && isTableLike(e.previousKind)) return fromCache(focused, c);
  }
  if (lastTable && lastTable !== focused) {
    const e = entry(lastTable);
    if (!e || !isTableLike(e.kind)) return null;
    const live = toCurrent(lastTable, selection(lastTable), e);
    if (live) return live;
    const c = cache.get(lastTable);
    if (c && c.index === e.index) return fromCache(lastTable, c);
  }
  return null;
}

// ── live state ─────────────────────────────────────────────────────────────

const cache = new Map<PaneId, CachedCursor>();
let lastTable: PaneId | null = null;

function entryOf(pane: PaneId): EntryInfo | null {
  const p = getWorkspace()?.panes[pane];
  if (!p) return null;
  const prev = p.index > 0 ? p.history[p.index - 1] : undefined;
  const v = currentView(p);
  const out: EntryInfo = { kind: v.kind, index: p.index, previousKind: prev ? prev.kind : null };
  if (v.kind === "containers") out.pod = v.pod;
  return out;
}

let started = false;
/** Starts caching cursors. Called once at startup (idempotent); currentObject() starts it too. */
export function initCurrent(): void {
  if (started) return;
  started = true;
  onAnySelection((pane) => {
    const e = entryOf(pane);
    const cur = e && isTableLike(e.kind) ? toCurrent(pane, getSelection(pane), e) : null;
    if (!e || !cur) return;
    cache.set(pane, { ref: cur.ref, marked: cur.marked, kind: cur.kind, container: cur.container, index: e.index });
    lastTable = pane;
  });
}

/** The object "this" refers to right now, or null. */
export function currentObject(): CurrentObject | null {
  initCurrent();
  const ws = getWorkspace();
  for (const id of [...cache.keys()]) if (!ws?.panes[id]) cache.delete(id);
  if (lastTable && !ws?.panes[lastTable]) lastTable = null;
  // §8.3: the last table only counts when it shows the focused pane's context; "this pod" of
  // another cluster would be handed to :pack, the hub or an agent under the wrong context
  const sameContext = ws && lastTable ? contextOfPane(ws, lastTable) === contextOfPane(ws, ws.focused) : false;
  return resolveCurrent({ focused: ws?.focused ?? null, selection: getSelection, entry: entryOf, cache, lastTable: sameContext ? lastTable : null });
}
