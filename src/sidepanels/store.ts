// Side-panel state. Two stores: the persisted prefs (open, width, folded sections) and the live
// runtime (which panel has focus, cursors, the sidebar filter). Small and eager: the toggle keys
// and the titlebar buttons work before a panel body has loaded.
//
// Focus model: a panel's key scope is live exactly while DOM focus is inside the panel element
// (focusin pushes the layer, focusout pops it; a document focusin listener is the safety net for
// focus that left without a focusout). Rows are not focusable: the cursor is state, and focus
// sits on the panel root or on the filter input.
//
// Showing: a docked panel shows while prefs.open; on a narrow window a panel is an overlay that
// shows only while it is `active`, and nothing done there is written to prefs.open.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { LAYERS } from "../actions";
import { engine } from "../keys";
import { getWorkspace, layoutStore } from "../store/layout";
import { persistedStore } from "../store/persist";
import {
  clampWidth, cursorIndex, defaultPrefs, headerKey, jumpSection, moveBy, NARROW_PX, sanitizePrefs, WIDTH_STEP,
  type Cursor, type PanelRow, type Side, type SidePrefs,
} from "./model";

// ── persisted: open, width, folded sections ────────────────────────────────

export const prefsStore = persistedStore<SidePrefs>({
  key: "sidepanels",
  version: 1,
  defaults: defaultPrefs,
  sanitize: (data) => sanitizePrefs(data),
});
export const usePrefs = <T,>(select: (s: SidePrefs) => T): T => useStore(prefsStore, select);

function patchPrefs(side: Side, patch: Partial<SidePrefs[Side]>): void {
  prefsStore.setState((s) => ({ ...s, [side]: { ...s[side], ...patch } }));
}

// ── runtime ────────────────────────────────────────────────────────────────

interface Runtime {
  /** the panel that holds DOM focus */
  focused: Side | null;
  /** the panel that holds focus or is about to get it (a narrow window shows only this one) */
  active: Side | null;
  /** bumped by every focus request: the panel element takes focus in an effect */
  focusTick: number;
  /** the window is narrower than NARROW_PX: panels overlay and auto-hide */
  narrow: boolean;
  cursor: Record<Side, Cursor | null>;
  /** context sidebar: type-to-filter text */
  filter: string;
  /** bumped to move focus into the filter input */
  filterTick: number;
}

export const runtimeStore = createStore<Runtime>(() => ({
  focused: null, active: null, focusTick: 0, narrow: false, cursor: { left: null, right: null }, filter: "", filterTick: 0,
}));
export const useRuntime = <T,>(select: (s: Runtime) => T): T => useStore(runtimeStore, select);
export const focusedSide = (): Side | null => runtimeStore.getState().focused;

/** Is the panel on screen: docked and open, or (narrow window) the active overlay. */
export const isShown = (side: Side): boolean => {
  const r = runtimeStore.getState();
  return r.narrow ? r.active === side : prefsStore.getState()[side].open;
};
export function useShown(side: Side): boolean {
  const open = usePrefs((s) => s[side].open);
  const narrow = useRuntime((s) => s.narrow);
  const active = useRuntime((s) => s.active === side);
  return narrow ? active : open;
}

// ── rows: published by the mounted panel body, read by the actions ─────────

const rows: Record<Side, readonly PanelRow[]> = { left: [], right: [] };

export function setPanelRows(side: Side, list: readonly PanelRow[]): void {
  rows[side] = list;
  // activate / stop / copy are enabled by the cursor row
  if (focusedSide() === side) engine.invalidate();
}
export const panelRows = (side: Side): readonly PanelRow[] => rows[side];

export function cursorOf(side: Side): { index: number; row: PanelRow | undefined } {
  const index = cursorIndex(rows[side], runtimeStore.getState().cursor[side]);
  return { index, row: index >= 0 ? rows[side][index] : undefined };
}

export function setCursor(side: Side, index: number): void {
  const row = rows[side][index];
  if (!row) return;
  const s = runtimeStore.getState();
  const cur = s.cursor[side];
  if (cur && cur.key === row.key && cur.index === index) return;
  runtimeStore.setState({ cursor: { ...s.cursor, [side]: { key: row.key, index } } });
  if (s.focused === side) engine.invalidate();
}
export const setCursorKey = (side: Side, key: string): void => setCursor(side, rows[side].findIndex((r) => r.key === key));

export const moveCursor = (side: Side, delta: number): void => setCursor(side, moveBy(rows[side], runtimeStore.getState().cursor[side], delta));
export const cursorTo = (side: Side, end: "top" | "bottom"): void => setCursor(side, end === "top" ? 0 : rows[side].length - 1);
export const cursorSection = (side: Side, dir: 1 | -1): void => setCursor(side, jumpSection(rows[side], runtimeStore.getState().cursor[side], dir));

// ── sections ───────────────────────────────────────────────────────────────

export function setCollapsed(side: Side, section: string, collapsed: boolean): void {
  // a filter shows every section unfolded: a fold made now would only show (and stick) once it clears
  if (side === "left" && runtimeStore.getState().filter.trim() !== "") return;
  const cur = prefsStore.getState()[side].collapsed;
  if ((cur[section] ?? false) === collapsed) return;
  patchPrefs(side, { collapsed: { ...cur, [section]: collapsed } });
  // the cursor row may be folded away: it goes to the section's header
  if (collapsed) {
    const s = runtimeStore.getState();
    const index = rows[side].findIndex((r) => r.key === headerKey(section));
    runtimeStore.setState({ cursor: { ...s.cursor, [side]: { key: headerKey(section), index: Math.max(0, index) } } });
  }
}
export const toggleSection = (side: Side, section: string): void => setCollapsed(side, section, !(prefsStore.getState()[side].collapsed[section] ?? false));

// ── width ──────────────────────────────────────────────────────────────────

export const setWidth = (side: Side, width: number): void => {
  const w = clampWidth(width, side);
  if (prefsStore.getState()[side].width !== w) patchPrefs(side, { width: w });
};
export const stepWidth = (side: Side, dir: 1 | -1): void => setWidth(side, prefsStore.getState()[side].width + dir * WIDTH_STEP);

// ── filter (context sidebar) ───────────────────────────────────────────────

export const setFilter = (text: string): void => {
  if (runtimeStore.getState().filter !== text) runtimeStore.setState({ filter: text });
};
export const focusFilter = (): void => runtimeStore.setState((s) => ({ filterTick: s.filterTick + 1 }));

// ── focus ──────────────────────────────────────────────────────────────────

const LAYER = { left: LAYERS.sidebar, right: LAYERS.activity } as const;
let popLayer: (() => void) | null = null;
/** where focus was before it moved into a panel */
let returnTo: HTMLElement | null = null;

const inPanel = (el: Element | null): boolean => !!el && el.closest(".side-panel") !== null;
// a context menu opened from a row (right-click in Recent) counts as a dialog: the panel stays
const inDialog = (el: Element | null): boolean => !!el && el.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;

/** Remembers the element to go back to. Call before focus moves into a panel. */
export function noteReturn(): void {
  const a = document.activeElement;
  if (a instanceof HTMLElement && a !== document.body && !inPanel(a)) returnTo = a;
}

/** The panel element got DOM focus: its scope goes live. */
export function panelFocusIn(side: Side): void {
  if (runtimeStore.getState().focused === side) return;
  popLayer?.();
  popLayer = engine.pushScope(LAYER[side]);
  runtimeStore.setState({ focused: side, active: side });
}

/**
 * DOM focus left the panel element for `to` (or the panel unmounted). A confirm dialog opened from
 * the panel keeps it `active`: on a narrow window the panel must still be there when the dialog
 * closes and hands the focus back.
 */
export function panelFocusOut(side: Side, to: Element | null = document.activeElement): void {
  const s = runtimeStore.getState();
  const keep = inDialog(to);
  if (s.focused !== side) {
    if (s.active === side && !keep && !inPanel(to)) runtimeStore.setState({ active: null });
    return;
  }
  popLayer?.();
  popLayer = null;
  runtimeStore.setState({ focused: null, active: s.active === side && !keep ? null : s.active });
}

function focusPaneElement(): void {
  const pane = document.querySelector<HTMLElement>(".pane[data-focused]");
  // a terminal or editor inside the focused pane held the focus before: give it back there
  const target = returnTo && returnTo.isConnected && pane?.contains(returnTo) ? returnTo : pane;
  returnTo = null;
  if (target) target.focus({ preventScroll: true });
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/** Esc, or the focus key again: back to the pane the focus came from. */
export function leavePanel(): void {
  const s = runtimeStore.getState();
  if (s.focused === null && s.active === null) return;
  focusPaneElement();
  // nothing took the focus (no pane yet): still drop the scope
  const side = runtimeStore.getState().focused;
  if (side) panelFocusOut(side);
  else if (runtimeStore.getState().active) runtimeStore.setState({ active: null });
}

/**
 * After an activation that changes what the panes show (a jump, a context or namespace switch):
 * hands focus to the focused pane once React has committed, unless a view (terminal, editor) or a
 * dialog already took it. Focus that fell on <body> (the panel was unmounted under a dialog) goes
 * to the pane as well, or a terminal would get no keys until it is clicked.
 */
export function returnToPanes(): void {
  setTimeout(() => {
    const a = document.activeElement;
    if (inPanel(a)) return leavePanel();
    if (a && a !== document.body) return;
    focusPaneElement();
    const s = runtimeStore.getState();
    if (s.focused) panelFocusOut(s.focused, null);
    else if (s.active) runtimeStore.setState({ active: null });
  }, 0);
}

/** Opens the panel if needed and moves focus into it; when it already has focus, goes back. */
export function focusPanel(side: Side): void {
  const s = runtimeStore.getState();
  if (s.focused === side) return leavePanel();
  noteReturn();
  // a narrow window shows the panel as an overlay for this visit: it is not docked for later
  if (!s.narrow && !prefsStore.getState()[side].open) patchPrefs(side, { open: true });
  runtimeStore.setState({ active: side, focusTick: s.focusTick + 1 });
}

export function setOpen(side: Side, open: boolean): void {
  if (prefsStore.getState()[side].open === open) return;
  if (!open) {
    if (focusedSide() === side) leavePanel();
    panelFocusOut(side, null);
  }
  patchPrefs(side, { open });
}

/** The close button: undocks the panel, or (narrow window) hides the overlay. */
export function hidePanel(side: Side): void {
  const s = runtimeStore.getState();
  if (!s.narrow) return setOpen(side, false);
  if (s.focused === side) leavePanel();
  else if (s.active === side) runtimeStore.setState({ active: null });
}

/** Show / hide. On a narrow window a panel only shows while it has focus, so toggling focuses it. */
export function togglePanel(side: Side): void {
  const s = runtimeStore.getState();
  if (s.narrow) {
    if (s.active === side) leavePanel();
    else focusPanel(side);
    return;
  }
  setOpen(side, !prefsStore.getState()[side].open);
}

/**
 * Runs a row's Enter / click. Headers fold; everything else hands focus back to the panes, unless
 * the row stays or the activation was declined (a confirm answered "Stay" resolves false).
 */
export async function activateRow(side: Side, row: PanelRow): Promise<void> {
  if (row.header) return toggleSection(side, row.section);
  if (!row.activate) return;
  const result = await row.activate();
  if (!row.stay && result !== false) returnToPanes();
}

/** > 0 while a stop started from a panel is running */
let holding = 0;
/**
 * Runs a row's stop (key, button or stop-all). Stopping may close the focused pane, which moves
 * pane focus by itself: that must not throw the focus out of the panel, or the next `x` would
 * land in a table.
 */
export async function runStop(side: Side, fn: (() => unknown) | undefined): Promise<void> {
  if (!fn) return;
  const was = runtimeStore.getState().focused === side;
  holding++;
  try {
    await fn();
  } finally {
    // the pane-focus change of a closed pane is published in this tick
    setTimeout(() => {
      holding--;
      const a = document.activeElement;
      // the focus was in the panel and is nowhere now: back into the panel
      if (was && (!a || a === document.body) && (isShown(side) || runtimeStore.getState().narrow)) {
        runtimeStore.setState((s) => ({ active: side, focusTick: s.focusTick + 1 }));
      }
    }, 0);
  }
}

// ── wiring that runs once ──────────────────────────────────────────────────

let started = false;
/** Called from register(): pane focus moved by a chord (Alt+hjkl, F6) takes the focus out of a panel. */
export function initSidePanels(): void {
  if (started) return;
  started = true;
  let last = getWorkspace()?.focused ?? null;
  layoutStore.subscribe(() => {
    const now = getWorkspace()?.focused ?? null;
    if (now === last) return;
    last = now;
    // not when the panel's own stop closed the pane (runStop)
    if (focusedSide() !== null && holding === 0) returnToPanes();
  });
  if (typeof document === "undefined") return;
  // Safety net: focus that reached something outside the panels without a focusout on the panel
  // (the focused element was removed) must not leave the SIDE scope or a narrow overlay behind.
  document.addEventListener("focusin", (e) => {
    const s = runtimeStore.getState();
    if (s.focused === null && s.active === null) return;
    const to = e.target instanceof Element ? e.target : null;
    if (inPanel(to) || inDialog(to)) return;
    if (s.focused) panelFocusOut(s.focused, to);
    else if (s.active && s.narrow) runtimeStore.setState({ active: null });
  });
}

let observer: ResizeObserver | null = null;
/** Watches the window frame's width (CSS px, so it follows the zoom). Called once a panel mounts. */
export function watchNarrow(): void {
  if (observer || typeof ResizeObserver === "undefined") return;
  const app = document.querySelector<HTMLElement>(".app");
  if (!app) return;
  const measure = () => {
    const narrow = app.clientWidth < NARROW_PX;
    const s = runtimeStore.getState();
    if (s.narrow === narrow) return;
    // widening with an overlay showing that is not docked: it goes away, the focus goes to the pane
    if (!narrow && s.active && !prefsStore.getState()[s.active].open) leavePanel();
    runtimeStore.setState({ narrow });
  };
  observer = new ResizeObserver(measure);
  observer.observe(app);
  measure();
}
