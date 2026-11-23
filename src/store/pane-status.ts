// Per-pane status a view reports to its header (docs/ux.md §11.1): the watch glyph.
// Kept out of the workspace: it is live state, never persisted.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { WatchState } from "../ipc/types";
import type { PaneId } from "../types";

export type PaneWatch = WatchState | "stale";

export interface PaneStatus {
  /** null = the view has no watch (doc, shell, tools): no glyph */
  watch: PaneWatch | null;
  /** why the watch is not live (forbidden, error) */
  message?: string;
}

const NONE: PaneStatus = { watch: null };
const store = createStore<Record<PaneId, PaneStatus>>(() => ({}));

/** Called by views (useTable does it for tables). */
export function setPaneStatus(pane: PaneId, status: PaneStatus): void {
  const all = store.getState();
  const cur = all[pane] ?? NONE;
  if (cur.watch === status.watch && cur.message === status.message) return;
  const next = { ...all };
  if (status.watch === null) delete next[pane];
  else next[pane] = status;
  store.setState(next, true);
}

// ── faulty rows of a table pane (status colours): the header and the tab strip show a hint ──

export interface PaneFaults {
  error: number;
  warn: number;
}
const faultsStore = createStore<Record<PaneId, PaneFaults>>(() => ({}));
/** Called by the table (Grid) when its counts change; null on unmount. */
export function setPaneFaults(pane: PaneId, f: PaneFaults | null): void {
  const all = faultsStore.getState();
  const cur = all[pane];
  const empty = !f || f.error + f.warn === 0;
  if (empty ? !cur : cur && cur.error === f!.error && cur.warn === f!.warn) return;
  const next = { ...all };
  if (empty) delete next[pane];
  else next[pane] = f!;
  faultsStore.setState(next, true);
}
export const usePaneFaults = (pane: PaneId): PaneFaults | undefined => useStore(faultsStore, (s) => s[pane]);
export const usePaneFaultsAll = (): Readonly<Record<PaneId, PaneFaults>> => useStore(faultsStore);

export const getPaneStatus = (pane: PaneId): PaneStatus => store.getState()[pane] ?? NONE;
export const usePaneStatus = (pane: PaneId): PaneStatus => useStore(store, (s) => s[pane] ?? NONE);
/** Every pane that reports a watch (the activity panel's health group). */
export const usePaneStatuses = (): Readonly<Record<PaneId, PaneStatus>> => useStore(store);
/** "2 failing rows, 1 warning" */
export function faultsText(f: PaneFaults): string {
  const parts: string[] = [];
  if (f.error > 0) parts.push(`${f.error} failing row${f.error === 1 ? "" : "s"}`);
  if (f.warn > 0) parts.push(`${f.warn} warning${f.warn === 1 ? "" : "s"}`);
  return parts.join(", ");
}
