// Opening the context menu from the pointer (docs/frontend.md §17). The menu itself is the
// palette feature's overlay behind the `menu.open` action; this is the neutral hand-over: a caller
// leaves a request (where, and optionally which actions), runs `menu.open`, and the overlay takes it.
import { registry, type ActionId } from "../actions/registry";
import { engine } from "../keys/instance";
import { focusedPane } from "../store/layout";
import type { Binding, PaneId } from "../types";
import { actionState } from "./action-state";

/** One row of a pointer menu: an action id, an action with what a button could carry, or `"|"`: a rule between two groups. */
export type MenuEntry =
  | ActionId
  | "|"
  | {
      action: ActionId;
      /** overrides the registry label */
      label?: string;
      args?: readonly string[];
      /** runs before the action (move the cursor to the clicked row) */
      before?: () => void;
      /** which of the action's bindings the row shows (an N-family like logs.since: the key of this preset); -1: none (the key does something else than this row: it opens a picker); default: all */
      binding?: number;
    };

export interface MenuRequest {
  /** anchor in viewport px (a pointer event's clientX / clientY, or a button's rect) */
  at?: { x: number; y: number };
  /** the rows; default: the hint-row actions of the focused pane */
  items?: readonly MenuEntry[];
  /** the pane the rows act on; default: the focused pane */
  pane?: PaneId | null;
  /** the menu was closed without a pick (Esc, a click outside, another overlay opening over it): undo what opening it changed */
  onCancel?: () => void;
  /** set by openMenu: `items` as rows, resolved before the menu's layer took the keys */
  rows?: readonly MenuRow[];
}

/** One resolved row of a pointer menu. */
export interface MenuRow {
  /** a rule between two groups, not an action: the other fields are empty */
  separator?: true;
  action: ActionId;
  label: string;
  bindings: Binding[];
  enabled: boolean;
  reason?: string;
  opens: boolean;
  args?: readonly string[];
  before?: () => void;
}

/**
 * The rows of `items` for `pane`: absent actions drop out, disabled ones keep their reason. A
 * separator stays only between two rows that are there (never first, last or doubled).
 * Must run before the menu opens: its layer hides every other layer (`below: "none"`), so an
 * action of a live layer (filter input, copy mode, a side panel) would read as absent after.
 */
export function resolve(items: readonly MenuEntry[], pane: PaneId | null): MenuRow[] {
  const out: MenuRow[] = [];
  let gap = false;
  for (const it of items) {
    if (it === "|") {
      gap = out.length > 0;
      continue;
    }
    const e = typeof it === "string" ? { action: it } : it;
    const s = actionState(e.action, { pane, args: e.args });
    if (!s.present) continue;
    if (gap) out.push({ separator: true, action: e.action, label: "", bindings: [], enabled: false, opens: false });
    gap = false;
    const all = engine.bindingsFor(e.action);
    out.push({
      action: e.action,
      label: e.label ?? s.label,
      bindings: e.binding === undefined ? all : e.binding < 0 ? [] : all.slice(e.binding, e.binding + 1),
      enabled: s.enabled,
      reason: s.reason,
      opens: registry.target(e.action)?.opens === "view",
      args: e.args,
      before: e.before,
    });
  }
  return out;
}

let pending: MenuRequest | null = null;

/**
 * Opens the context menu at a point. Without `items` it lists what the hint row lists for the
 * focused pane (move the cursor to the clicked row first); with `items` it lists exactly those
 * actions, disabled ones with their reason.
 *
 *   onContextMenu={(e) => { e.preventDefault(); model.setCursorIndex(i); openMenu({ at: { x: e.clientX, y: e.clientY }, items: ["res.logs", "res.describe", "|", "res.delete"] }); }}
 */
export function openMenu(request: MenuRequest = {}): boolean {
  pending = request.items ? { ...request, rows: resolve(request.items, request.pane ?? focusedPane()) } : request;
  const ok = engine.run("menu.open", { source: "pointer" });
  pending = null;
  return ok;
}

/** For the `menu.open` handler: the request of the click that is opening the menu, once. */
export function takeMenuRequest(): MenuRequest | null {
  const r = pending;
  pending = null;
  return r;
}

/** Anchor under an element (a "more" button): its bottom-left corner. */
export function menuAnchor(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
}
