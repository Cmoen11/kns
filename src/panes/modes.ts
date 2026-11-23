// Sticky pane modes (docs/ux.md §3.3, §3.5, §4.1): RESIZE and MOVE. Each pushes a capturing scope
// layer, so only its own keys work until it ends.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { LAYERS } from "../actions";
import { engine } from "../keys";
import { neighbor } from "../store/geometry";
import { dockPane, focusedPane, focusPane, getWorkspace, insertPane, navRects, swapPanes } from "../store/layout";
import type { Edge } from "../store/layout-tree";
import type { PaneId } from "../types";
import { animateLayout } from "./animate";

export interface PaneModes {
  /** MOVE mode: the pane being moved and the pane the drop keys act on */
  move: { pane: PaneId; target: PaneId } | null;
  resize: boolean;
}

export const paneModes = createStore<PaneModes>(() => ({ move: null, resize: false }));
export const usePaneModes = <T,>(select: (s: PaneModes) => T): T => useStore(paneModes, select);

let pop: (() => void) | null = null;

function end(): void {
  pop?.();
  pop = null;
  if (paneModes.getState().move || paneModes.getState().resize) paneModes.setState({ move: null, resize: false });
}

export function startResize(): void {
  end();
  if (!focusedPane()) return;
  pop = engine.pushScope(LAYERS.resize);
  paneModes.setState({ resize: true });
}
export const endResize = end;

export function startMove(): void {
  end();
  const pane = focusedPane();
  if (!pane) return;
  pop = engine.pushScope(LAYERS.move);
  paneModes.setState({ move: { pane, target: pane } });
}

/** h j k l: picks the target pane. */
export function moveTarget(edge: Edge): void {
  const m = paneModes.getState().move;
  const ws = getWorkspace();
  if (!m || !ws) return;
  const next = neighbor(navRects(), m.target, edge, ws.mru);
  if (next) paneModes.setState({ move: { ...m, target: next } });
}

/** H J K L: inserts the moving pane on that edge of the target (on itself: docks at the window edge). */
export function moveInsert(edge: Edge): void {
  const m = paneModes.getState().move;
  end();
  if (!m) return;
  animateLayout(() => (m.target === m.pane ? dockPane(m.pane, edge) : insertPane(m.pane, m.target, edge)));
  focusPane(m.pane);
}

/** Enter: swaps with the target. */
export function moveSwap(): void {
  const m = paneModes.getState().move;
  end();
  if (m && m.target !== m.pane) animateLayout(() => swapPanes(m.pane, m.target));
}

export const cancelMove = end;
