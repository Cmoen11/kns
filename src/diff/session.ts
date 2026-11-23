// Per-pane diff state that the eager actions and the header read, and the controller the lazy
// DiffView registers. Free of CodeMirror and the YAML library.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { engine } from "../keys";
import type { PaneId } from "../types";

export interface DiffUi {
  loading: boolean;
  error: string | null;
  /** changed regions (hunks) */
  chunks: number;
  /** 0-based hunk the cursor is in, -1 = none yet */
  current: number;
  /** an extra line under the header ("projected onto the fields of last-applied") */
  note: string | null;
  leftLabel: string;
  rightLabel: string;
  /** unchanged regions are shown (Enter toggles) */
  expanded: boolean;
}

export const EMPTY_DIFF: DiffUi = Object.freeze({
  loading: false, error: null, chunks: 0, current: -1, note: null, leftLabel: "", rightLabel: "", expanded: false,
});

const store = createStore<Record<PaneId, DiffUi>>(() => ({}));

export const getDiffUi = (pane: PaneId | null | undefined): DiffUi => (pane && store.getState()[pane]) || EMPTY_DIFF;

export function patchDiffUi(pane: PaneId, patch: Partial<DiffUi>): void {
  const all = store.getState();
  const cur = all[pane] ?? EMPTY_DIFF;
  if ((Object.keys(patch) as (keyof DiffUi)[]).every((k) => cur[k] === patch[k])) return;
  store.setState({ ...all, [pane]: { ...cur, ...patch } }, true);
  engine.invalidate();
}

export function clearDiffUi(pane: PaneId): void {
  const all = store.getState();
  if (!(pane in all)) return;
  const next = { ...all };
  delete next[pane];
  store.setState(next, true);
  engine.invalidate();
}

export const useDiffUi = <T,>(pane: PaneId, select: (s: DiffUi) => T): T => useStore(store, (s) => select(s[pane] ?? EMPTY_DIFF));

/** Panes showing a diff (the tool's status line). */
export const useDiffPaneCount = (): number => useStore(store, (s) => Object.keys(s).length);

/** What the action handlers call; implemented by the lazy DiffView. */
export interface DiffController {
  scroll(lines: number): void;
  page(dir: 1 | -1): void;
  edge(end: "top" | "bottom"): void;
  hunk(dir: 1 | -1): void;
  refresh(): void;
  toggleExpanded(): void;
}

export const diffControllers = new Map<PaneId, DiffController>();
