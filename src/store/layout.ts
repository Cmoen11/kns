// The Workspace store (docs/ux.md §3): one workspace per kube context, persisted (§3.6), plus the
// imperative pane API every feature uses. The tree logic is pure and lives in workspace.ts,
// layout-tree.ts and geometry.ts; this file only applies it to the active workspace.
import { useCallback, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { PaneId, PaneState, ViewKind, ViewState, Workspace } from "../types";
import { confirm } from "../ui/confirm";
import { toast } from "../ui/toast";
import { computeGeometry, dividerFor, moveDivider, navigationRects, type Geometry, type Rect, type Size } from "./geometry";
import { liveSession, type LiveSession } from "./guards";
import { findSplit, leafIds, type Edge, type IdGen } from "./layout-tree";
import { paneNamespaceIn } from "./pane-namespace";
import { setPaneStatus } from "./pane-status";
import { settingsStore } from "./settings";
import { PERSIST_KEYS, persistedStore, type PersistedSlice } from "./persist";
import { getSelection, setSelection } from "./selection";
import { flash } from "./status";
import * as T from "./tabs";
import * as W from "./workspace";

export interface LayoutState extends PersistedSlice<"workspaces" | "parked"> {
  /** the window's context; its workspace is the one on screen */
  current: string | null;
  /** open context tabs in strip order (§8.2); always holds `current` */
  tabs: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function sanitizeLayout(data: unknown): LayoutState {
  const out: LayoutState = { workspaces: {}, parked: {}, current: null, tabs: [] };
  if (!isObj(data)) return out;
  if (isObj(data.workspaces)) {
    for (const [ctx, raw] of Object.entries(data.workspaces)) {
      const ws = W.sanitizeWorkspace(raw, ctx);
      if (ws) out.workspaces[ctx] = ws;
    }
  }
  if (typeof data.current === "string" && out.workspaces[data.current]) out.current = data.current;
  out.tabs = T.sanitizeTabs(data.tabs, out.current, (c) => !!out.workspaces[c]);
  return out;
}

export const layoutStore = persistedStore<LayoutState>({
  key: PERSIST_KEYS.workspaces,
  version: 1,
  defaults: () => ({ workspaces: {}, parked: {}, current: null, tabs: [] }),
  sanitize: sanitizeLayout,
});

let counter = 0;
/** Unique pane and split ids. */
export const newId: IdGen = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const active = (s: LayoutState): Workspace | null => (s.current ? (s.workspaces[s.current] ?? null) : null);

/** The workspace on screen, or null before the context is known. */
export const getWorkspace = (): Workspace | null => active(layoutStore.getState());

/** Narrow selector on the active workspace. Return primitives or stable references. */
export function useWorkspace<T>(select: (ws: Workspace | null) => T): T {
  return useStore(layoutStore, (s) => select(active(s)));
}

export const focusedPane = (): PaneId | null => getWorkspace()?.focused ?? null;

// ── kube context of a pane (§8.3) ──────────────────────────────────────────

/**
 * The kube context a pane shows (default: the focused pane): its own, else the window's. "" before
 * the context is known. Action handlers act on the focused pane (a click focuses its pane first),
 * so `paneContext()` is "the context this action is about". Read it once, before the first await.
 */
export function paneContext(pane?: PaneId): string {
  const ws = getWorkspace();
  return ws ? W.contextOfPane(ws, pane ?? ws.focused) : "";
}
/** The focused pane's kube context: what keys act on. */
export const focusedContext = (): string => paneContext();
/** A pane's kube context in React (re-renders when it changes). */
export const usePaneContext = (pane: PaneId | null | undefined): string =>
  useWorkspace((ws) => (ws ? W.contextOfPane(ws, pane ?? ws.focused) : ""));
/** True when the focused pane is in another context than the window. */
export const focusedIsForeign = (): boolean => {
  const ws = getWorkspace();
  return !!ws && W.contextOfPane(ws, ws.focused) !== ws.context;
};
/** Every context a pane of the workspace on screen shows, the window's first. */
export function workspaceContexts(): string[] {
  const ws = getWorkspace();
  if (!ws) return [];
  const out = new Set<string>([ws.context]);
  for (const id of leafIds(ws.root)) out.add(W.contextOfPane(ws, id));
  return [...out];
}

// ── context tabs (§8.2) ────────────────────────────────────────────────────

/** Open tabs, strip order. */
export const openTabs = (): string[] => layoutStore.getState().tabs;
export const useTabs = (): string[] => useStore(layoutStore, (s) => s.tabs);

/** Tabs by last use, the one on screen first; in memory only. */
let mru: string[] = [];
export const tabMru = (): string[] => mru;

/** The workspaces of the open tabs: the one on screen and the warm ones. */
export function openWorkspaces(s: LayoutState = layoutStore.getState()): Workspace[] {
  const out: Workspace[] = [];
  for (const t of s.tabs) {
    const ws = s.workspaces[t];
    if (ws) out.push(ws);
  }
  const cur = active(s);
  if (cur && !out.includes(cur)) out.push(cur);
  return out;
}

/** Every context a pane of an open tab shows: these stay connected. */
export function tabContexts(): string[] {
  const out = new Set<string>();
  for (const ws of openWorkspaces()) {
    out.add(ws.context);
    for (const id of leafIds(ws.root)) out.add(W.contextOfPane(ws, id));
  }
  return [...out];
}

function sessionsIn(ws: Workspace | undefined): LiveSession[] {
  const out: LiveSession[] = [];
  if (!ws) return out;
  for (const id of leafIds(ws.root)) {
    const s = liveSession(id, W.viewOf(ws, id));
    if (s) out.push(s);
  }
  return out;
}

/** The live sessions a tab holds: what closing it ends or keeps. */
export const tabLiveSessions = (context: string): LiveSession[] => sessionsIn(layoutStore.getState().workspaces[context]);

/** Every live session in every open tab (quit). */
export const allLiveSessions = (): LiveSession[] => openWorkspaces().flatMap(sessionsIn);

/** The tab that must close before `context` can open, if the strip is full. */
export function tabToEvict(context: string): string | null {
  const s = layoutStore.getState();
  if (s.tabs.includes(context)) return null;
  return T.tabToEvict(s.tabs, s.current, mru, (t) => tabLiveSessions(t).some((l) => l.onClose === "ends"));
}

/** Takes a tab out of the strip; its workspace stays saved. Not the one on screen. */
export function removeTab(context: string): void {
  layoutStore.setState((s) => (s.current === context || !s.tabs.includes(context) ? s : { ...s, tabs: T.withoutTab(s.tabs, context) }));
  mru = mru.filter((m) => m !== context);
}

/** True while panes of more than one context are on screen: the pane headers then name their context. */
export const useMixedContexts = (): boolean => useWorkspace((ws) => !!ws && W.isMixed(ws));

/**
 * Puts a pane in another context (§8.3): its history restarts at `view` (default: its current view
 * re-read there). Linked panes stop following it.
 */
export function setPaneContext(context: string, opts: { pane?: PaneId; view?: ViewState } = {}): boolean {
  const ws = getWorkspace();
  const id = opts.pane ?? ws?.focused;
  if (!ws || !id || !ws.panes[id]) return false;
  const live = sessionOf(id);
  if (live) {
    flash(`the pane holds a ${live.label}: open the context beside it (Ctrl/⌘+Enter in the picker)`, "warn");
    return false;
  }
  setSelection(id, null);
  const done = apply((w) => W.setPaneContext(stamp(w, id), id, context, opts.view));
  if (done) bump(id);
  return done;
}
export const useFocusedPane = (): PaneId | null => useWorkspace((ws) => ws?.focused ?? null);

/** The current view of a pane (default: the focused pane). */
export function paneView(pane?: PaneId): ViewState | undefined {
  const ws = getWorkspace();
  return ws ? W.viewOf(ws, pane ?? ws.focused) : undefined;
}
export const paneState = (pane: PaneId): PaneState | undefined => getWorkspace()?.panes[pane];

/** A pane's current view; re-renders only when that entry changes. */
export function usePaneView(pane: PaneId): ViewState | undefined {
  return useWorkspace((ws) => (ws ? W.viewOf(ws, pane) : undefined));
}

/** Pane ids in pane order (1-based index = position + 1). */
export const paneOrder = (): PaneId[] => {
  const ws = getWorkspace();
  return ws ? leafIds(ws.root) : [];
};
export const paneIndex = (pane: PaneId): number => paneOrder().indexOf(pane) + 1;

function apply(fn: (ws: Workspace) => Workspace): boolean {
  const before = getWorkspace();
  if (!before) return false;
  const next = fn(before);
  if (next === before) return false;
  layoutStore.setState((s) => (s.current ? { ...s, workspaces: { ...s.workspaces, [s.current]: next } } : s));
  return true;
}

function applyResult(fn: (ws: Workspace) => W.OpResult): PaneId | null {
  let result: W.OpResult | null = null;
  apply((ws) => (result = fn(ws)).ws);
  const r = result as W.OpResult | null;
  if (r?.error) flash(r.error, "warn");
  return r?.pane ?? null;
}

// ── geometry ───────────────────────────────────────────────────────────────

/** §1: minimum pane 240×120 for tables, 240×96 for everything else. */
const MIN_TABLE: Size = { w: 240, h: 120 };
const MIN_OTHER: Size = { w: 240, h: 96 };
const FALLBACK: Size = { w: 1600, h: 900 };

let viewport: Size = { w: 0, h: 0 };
let geomKey = "";
let geomRoot: unknown = null;
let geom: Geometry | null = null;
const viewportSubs = new Set<() => void>();

/** The pane area in CSS px; set by the PaneTree's ResizeObserver. */
export function setViewport(w: number, h: number): void {
  w = Math.floor(w);
  h = Math.floor(h);
  if (w === viewport.w && h === viewport.h) return;
  viewport = { w, h };
  for (const fn of [...viewportSubs]) fn();
}
export const getViewport = (): Size => viewport;

const EMPTY_GEOMETRY: Geometry = { size: { w: 0, h: 0 }, rects: new Map(), strips: [], dividers: [], splits: new Map(), hidden: [] };

export function geometryOf(ws: Workspace, size: Size): Geometry {
  return computeGeometry({
    root: ws.root,
    width: size.w,
    height: size.h,
    mru: ws.mru,
    zoomed: ws.zoomed,
    min: (p) => {
      const k = W.viewOf(ws, p)?.kind;
      return k === "table" || k === "containers" ? MIN_TABLE : MIN_OTHER;
    },
  });
}

/** Rects, strips and dividers of the active workspace; the same object until something moves. */
export function getGeometry(): Geometry {
  const ws = getWorkspace();
  if (!ws) return EMPTY_GEOMETRY;
  const size = viewport.w > 0 && viewport.h > 0 ? viewport : FALLBACK;
  let kinds = "";
  for (const id of ws.mru) kinds += `${id}:${W.viewOf(ws, id)?.kind},`;
  const key = `${size.w}x${size.h}|${ws.zoomed}|${kinds}`;
  if (geom && geomRoot === ws.root && geomKey === key) return geom;
  geomRoot = ws.root;
  geomKey = key;
  return (geom = geometryOf(ws, size));
}

export function useGeometry(): Geometry {
  const subscribe = useCallback((fn: () => void) => {
    const off = layoutStore.subscribe(fn);
    viewportSubs.add(fn);
    return () => {
      off();
      viewportSubs.delete(fn);
    };
  }, []);
  return useSyncExternalStore(subscribe, getGeometry);
}

// ── context ────────────────────────────────────────────────────────────────

/** Makes `context` the window's workspace, creating the first-run layout when it has none (§3.6, §8.2). */
/** `namespace`: the kubeconfig context's own, for a workspace that does not exist yet. */
/** The context's tab opens (after the one on screen) when it is not open yet. */
export function setLayoutContext(context: string, width = typeof window === "undefined" ? 1440 : window.innerWidth, namespace?: string): void {
  // the cursor of every pane is written into its entry, so coming back lands on the same row
  if (layoutStore.getState().current !== context) stampCursors();
  layoutStore.setState((s) => {
    const tabs = T.withTab(s.tabs, context, s.current);
    if (s.current === context && s.workspaces[context] && tabs.length === s.tabs.length) return s;
    const ws = s.workspaces[context] ?? W.defaultWorkspace(context, width, newId, namespace);
    return { ...s, current: context, tabs, workspaces: { ...s.workspaces, [context]: ws } };
  });
  mru = T.touch(mru, context);
}

/** Replaces the active workspace (saved-layout recall). */
export function setWorkspace(ws: Workspace): void {
  layoutStore.setState((s) => ({ ...s, current: ws.context, tabs: T.withTab(s.tabs, ws.context, s.current), workspaces: { ...s.workspaces, [ws.context]: ws } }));
}

// ── navigation epoch: a view component is remounted per history move, not per edit ──

const epochs = new Map<PaneId, number>();
export const navEpoch = (pane: PaneId): number => epochs.get(pane) ?? 0;
const bump = (pane: PaneId) => epochs.set(pane, navEpoch(pane) + 1);

/** Writes the live cursor into the current entry, so back/forward and restart restore it. */
function stamp(ws: Workspace, pane: PaneId): Workspace {
  const cur = getSelection(pane).focused;
  if (!cur) return ws;
  return W.replaceView(ws, pane, (v) => {
    if (v.kind === "table") return v.cursorUid === cur.uid || !cur.uid ? v : { ...v, cursorUid: cur.uid };
    if (v.kind === "containers") return v.cursorName === cur.name ? v : { ...v, cursorName: cur.name };
    return v;
  });
}

/** Stamps every pane's cursor (before the state is flushed at exit). */
export function stampCursors(): void {
  apply((ws) => {
    let out = ws;
    for (const id of Object.keys(ws.panes)) out = stamp(out, id);
    return out;
  });
}

// ── views and history (§4.3, §4.4) ─────────────────────────────────────────

export interface OpenOptions {
  /** the pane to navigate, or the source of a new pane (default: the focused pane) */
  pane?: PaneId;
  /** open beside the source instead of in place: pass ctx.newPane straight through */
  newPane?: "right" | "down" | null;
  /** new panes only: overrides the default follow (describe and YAML follow, the rest is pinned) */
  follow?: boolean;
  /**
   * The kube context to show the view in (§8.3, `:pods @staging`). Default: the source pane's. In
   * place, another context restarts the pane's history (setPaneContext); beside, the new pane gets it.
   */
  context?: string;
}

/**
 * Opens a view: pushes it on the pane's history, or with `newPane` applies the §4.4 target rule
 * (reuse a following pane of the same kind, else split). A pane that holds a live session is never
 * navigated in place: the view opens to its right instead (§4.6). Returns the pane that shows it.
 */
export function openView(view: ViewState, opts: OpenOptions = {}): PaneId | null {
  const ws = getWorkspace();
  if (!ws) return null;
  const source = opts.pane ?? ws.focused;
  if (!ws.panes[source]) return null;
  let dir = opts.newPane ?? null;
  if (!dir && liveSession(source, W.viewOf(ws, source))) dir = "right";
  const other = opts.context !== undefined && opts.context !== "" && opts.context !== W.contextOfPane(ws, source);
  if (other && !dir) return setPaneContext(opts.context as string, { pane: source, view }) ? source : null;
  // "Open beside" setting: a detail view opened from a list lands in a pane next to it. The pane
  // this list opened last for the same kind is reused (unless it holds a live session), so
  // stepping through rows does not pile up panes. An explicit `+` always splits.
  if (!dir && !other && settingsStore.getState().openBeside) {
    const from = W.viewOf(ws, source);
    const list = from?.kind === "table" || from?.kind === "containers";
    const detail = view.kind === "doc" || view.kind === "logs" || view.kind === "shell" || view.kind === "attach";
    if (list && detail) {
      for (const id of leafIds(ws.root)) {
        const p = ws.panes[id];
        const cur = W.currentView(p);
        if (id !== source && p.link?.source === source && W.sameTarget(cur, view) && !liveSession(id, cur)) {
          apply((w) => W.focusPane(W.pushView(stamp(w, source), id, view), id));
          bump(id);
          return id;
        }
      }
      dir = "right";
    }
  }
  if (dir) return applyResult((w) => W.openBeside(stamp(w, source), source, view, dir, newId, { follow: opts.follow, context: opts.context }));
  apply((w) => W.pushView(stamp(w, source), source, view));
  bump(source);
  return source;
}

/**
 * Opens a copy of a pane's view in a new pane beside it, in `context` (context picker
 * Ctrl/⌘+Enter / Alt+Enter, §8.3): "the same list, in staging".
 */
export function openPaneInContext(context: string, dir: "right" | "down", pane?: PaneId): PaneId | null {
  const ws = getWorkspace();
  const id = pane ?? ws?.focused;
  const p = id ? ws?.panes[id] : undefined;
  if (!ws || !id || !p) return null;
  return applyResult((w) => W.openBeside(stamp(w, id), id, W.cloneView(p), dir, newId, { follow: false, context }));
}

/**
 * Opens a view of an object that lives in `context` (an activity row, a forward, a finding): in
 * the pane when it shows that context, else in a new pane beside it, in that context (§8.3).
 */
export function openInContext(view: ViewState, context: string, opts: OpenOptions = {}): PaneId | null {
  const ws = getWorkspace();
  if (!ws) return null;
  const source = opts.pane ?? ws.focused;
  if (!context || context === W.contextOfPane(ws, source)) return openView(view, opts);
  return openView(view, { ...opts, context, newPane: opts.newPane ?? "right" });
}

/** Edits a pane's current entry without pushing history (namespace, filter, sort, wrap ...). */
export function replaceView(pane: PaneId, view: ViewState | ((v: ViewState) => ViewState)): void {
  apply((ws) => W.replaceView(ws, pane, view));
}

/** Typed form of replaceView: patches the current entry when it is of `kind`. */
export function patchView<K extends ViewKind>(pane: PaneId, kind: K, patch: Partial<Extract<ViewState, { kind: K }>>): void {
  apply((ws) => W.replaceView(ws, pane, (v) => (v.kind === kind ? ({ ...v, ...patch } as ViewState) : v)));
}

function historyMove(pane: PaneId | undefined, fn: (ws: Workspace, id: PaneId) => Workspace): boolean {
  const id = pane ?? focusedPane();
  if (!id) return false;
  const moved = apply((ws) => fn(stamp(ws, id), id));
  if (moved) bump(id);
  return moved;
}
/** `,` and Esc step 9. */
export const goBack = (pane?: PaneId): boolean => historyMove(pane, (ws, id) => W.historyGo(ws, id, -1));
/** `.` */
export const goForward = (pane?: PaneId): boolean => historyMove(pane, (ws, id) => W.historyGo(ws, id, 1));
/** `-` */
export const goLast = (pane?: PaneId): boolean => historyMove(pane, W.historyLast);
export const canGoBack = (pane?: PaneId): boolean => {
  const ws = getWorkspace();
  return !!ws && W.canGoBack(ws, pane ?? ws.focused);
};
export const canGoForward = (pane?: PaneId): boolean => {
  const ws = getWorkspace();
  return !!ws && W.canGoForward(ws, pane ?? ws.focused);
};

/** Switches a table pane's namespace: keeps resource and filters, clears the cursor, no history push (§8.1). */
export function setNamespace(namespace: string | "*", pane?: PaneId): void {
  const id = pane ?? focusedPane();
  if (!id) return;
  setSelection(id, null);
  patchView(id, "table", { namespace, cursorUid: undefined });
}

/** Ctrl/⌘+Shift+N: the same switch on every table pane. */
export function setNamespaceAllPanes(namespace: string | "*"): void {
  for (const id of paneOrder()) if (paneView(id)?.kind === "table") setNamespace(namespace, id);
}

/** The namespace of a pane's table view, `*` for all, undefined for views without one. */
export function paneNamespace(pane?: PaneId): string | undefined {
  const ws = getWorkspace();
  return ws ? paneNamespaceIn(ws, pane ?? ws.focused) : undefined;
}

// ── pane operations (§3.2-3.4) ─────────────────────────────────────────────

const target = (pane?: PaneId): PaneId | null => pane ?? focusedPane();

export function focusPane(pane: PaneId): void {
  apply((ws) => W.focusPane(ws, pane));
}
export const focusNextPane = (delta: 1 | -1): boolean => apply((ws) => W.focusNext(ws, delta));
export const focusLastPane = (): boolean => apply(W.focusLast);
export const focusPaneIndex = (n: number): boolean => apply((ws) => W.focusIndex(ws, n));
/** Rects for direction keys: every pane, also folded or zoomed-out ones. */
export function navRects(): Map<PaneId, Rect> {
  const ws = getWorkspace();
  if (!ws) return new Map();
  const g = getGeometry();
  if (g.hidden.length === 0) return g.rects;
  return navigationRects(ws.root, viewport.w > 0 && viewport.h > 0 ? viewport : FALLBACK, ws.mru);
}
export const focusDirection = (edge: Edge): boolean => apply((ws) => W.focusDir(ws, edge, navRects()));

/** Splits a pane; the new pane clones the view (or shows `view`) and takes focus. */
export function splitPane(edge: "right" | "down", opts: { pane?: PaneId; view?: ViewState } = {}): PaneId | null {
  const id = target(opts.pane);
  if (!id) return null;
  return applyResult((ws) => W.splitPane(stamp(ws, id), id, edge, newId, opts.view));
}

function forget(pane: PaneId) {
  setSelection(pane, null);
  setPaneStatus(pane, { watch: null });
  epochs.delete(pane);
}

const sessionOf = (pane: PaneId): LiveSession | null => liveSession(pane, paneView(pane));

/** Closes a pane. A live shell asks first; a dirty edit keeps its draft and says so (§4.6). */
export async function closePane(pane?: PaneId): Promise<boolean> {
  const id = target(pane);
  if (!id) return false;
  const live = sessionOf(id);
  if (live?.onClose === "ends") {
    const ok = await confirm({ tier: 1, title: "Close pane", body: `Ends the ${live.label}.`, confirmLabel: "End", cancelLabel: "Keep" });
    if (!ok) return false;
  }
  const done = apply((ws) => W.closePane(stamp(ws, id), id, Date.now(), newId));
  if (done && live?.onClose === "kept") toast("Draft kept");
  return done;
}

/** Closes all other panes; one confirm lists every live session that would end. */
export async function closeOtherPanes(pane?: PaneId): Promise<boolean> {
  const id = target(pane);
  if (!id) return false;
  const ending: string[] = [];
  let kept = false;
  for (const other of paneOrder()) {
    if (other === id) continue;
    const live = sessionOf(other);
    if (live?.onClose === "ends") ending.push(live.label);
    else if (live) kept = true;
  }
  if (ending.length > 0) {
    const ok = await confirm({ tier: 1, title: "Close other panes", body: "These sessions end.", items: ending, confirmLabel: "End", cancelLabel: "Keep" });
    if (!ok) return false;
  }
  const done = apply((ws) => {
    let out = ws;
    for (const p of Object.keys(ws.panes)) out = stamp(out, p);
    return W.closeOthers(out, id, Date.now(), newId);
  });
  if (done && kept) toast("Drafts kept");
  return done;
}

/** Every live session in the window (context switch, quit). */
export function liveSessions(): LiveSession[] {
  const out: LiveSession[] = [];
  for (const id of paneOrder()) {
    const s = sessionOf(id);
    if (s) out.push(s);
  }
  return out;
}

export const reopenPane = (): PaneId | null => applyResult((ws) => W.reopenPane(ws, newId));
export const canReopen = (): boolean => (getWorkspace()?.closed.length ?? 0) > 0;

export function movePane(edge: Edge, pane?: PaneId): boolean {
  const id = target(pane);
  return !!id && apply((ws) => W.movePane(ws, id, edge, navRects(), newId));
}
export const insertPane = (pane: PaneId, onto: PaneId, edge: Edge): boolean => apply((ws) => W.insertPane(ws, pane, onto, edge, newId));
export const dockPane = (pane: PaneId, edge: Edge): boolean => apply((ws) => W.dockPane(ws, pane, edge, newId));
export const swapPanes = (a: PaneId, b: PaneId): boolean => apply((ws) => W.swapPanes(ws, a, b));

export function flipSplit(pane?: PaneId): boolean {
  const id = target(pane);
  return !!id && apply((ws) => W.flipSplit(ws, id));
}
export function equalizePanes(pane?: PaneId): boolean {
  const id = target(pane);
  return !!id && apply((ws) => W.equalize(ws, id));
}
export const equalizeAllPanes = (): boolean => apply(W.equalizeAll);
export const equalizeSplitById = (splitId: string): boolean =>
  apply((ws) => {
    const s = findSplit(ws.root, splitId);
    return s ? W.setSizes(ws, splitId, s.children.map(() => 1)) : ws;
  });
export const setSplitSizes = (splitId: string, sizes: readonly number[]): boolean => apply((ws) => W.setSizes(ws, splitId, sizes));

export function toggleZoom(pane?: PaneId): boolean {
  const id = target(pane);
  return !!id && apply((ws) => W.toggleZoom(ws, id));
}

/**
 * Keyboard resize (§3.3): moves the divider on `edge` side of the pane by `px` in that direction;
 * with no divider there, the opposite one moves the same way. Stops at the minimums.
 */
export function resizePane(edge: Edge, px: number, pane?: PaneId): boolean {
  const id = target(pane);
  const ws = getWorkspace();
  if (!id || !ws) return false;
  const d = dividerFor(ws.root, id, edge);
  const s = d && getGeometry().splits.get(d.split);
  if (!d || !s) return false;
  const sizes = moveDivider(s, d.index, edge === "right" || edge === "down" ? px : -px);
  return !!sizes && setSplitSizes(d.split, sizes);
}

/** Leader f. */
export function toggleFollow(pane?: PaneId): boolean {
  const id = target(pane);
  return !!id && applyResult((ws) => W.toggleFollow(ws, id)) !== null;
}

// ── housekeeping: forget live state of panes that left every open tab ──────
// (a pane of a warm tab keeps its marks and status, so switching back finds them)

let known = new Set<PaneId>();
layoutStore.subscribe((s) => {
  const now = new Set<PaneId>();
  for (const ws of openWorkspaces(s)) for (const id of Object.keys(ws.panes)) now.add(id);
  for (const id of known) if (!now.has(id)) forget(id);
  known = now;
});
