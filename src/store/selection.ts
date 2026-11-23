// Per-pane selection (cursor row and marked rows), published by table-like views and read by
// actions, follow links and other panes. Live state: outside React, never persisted.
import { useCallback, useSyncExternalStore } from "react";
import type { ObjRef } from "../ipc/types";
import type { ObjectRef, PaneId } from "../types";

export interface PaneSelection {
  /** the cursor row */
  focused: ObjectRef | null;
  /** marked rows (Space); empty when nothing is marked */
  marked: readonly ObjectRef[];
}

const NO_MARKS: readonly ObjectRef[] = Object.freeze([]);
export const NO_SELECTION: PaneSelection = Object.freeze({ focused: null, marked: NO_MARKS });

const state = new Map<PaneId, PaneSelection>();
const subs = new Map<PaneId, Set<() => void>>();
const anySubs = new Set<(pane: PaneId) => void>();

export function sameRef(a: ObjectRef | null | undefined, b: ObjectRef | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.name === b.name && a.namespace === b.namespace && a.uid === b.uid &&
    a.gvr.resource === b.gvr.resource && a.gvr.group === b.gvr.group && a.gvr.version === b.gvr.version
  );
}

/**
 * Publishes a pane's selection. Call it when the cursor row or the marks change (not per frame of
 * data); identical values are ignored. Pass null when the view unmounts.
 */
export function setSelection(pane: PaneId, sel: Partial<PaneSelection> | null): void {
  const prev = state.get(pane) ?? NO_SELECTION;
  const next: PaneSelection =
    sel === null ? NO_SELECTION : { focused: sel.focused === undefined ? prev.focused : sel.focused, marked: sel.marked ?? prev.marked };
  const sameMarks = prev.marked === next.marked || (prev.marked.length === 0 && next.marked.length === 0);
  if (sameRef(prev.focused, next.focused) && sameMarks) return;
  if (next.focused === null && next.marked.length === 0) state.delete(pane);
  else state.set(pane, next);
  for (const fn of [...(subs.get(pane) ?? [])]) fn();
  for (const fn of [...anySubs]) fn(pane);
}

export const getSelection = (pane: PaneId): PaneSelection => state.get(pane) ?? NO_SELECTION;

/** The objects an action applies to: the marked rows, else the cursor row. */
export function selectionTargets(pane: PaneId): readonly ObjectRef[] {
  const s = getSelection(pane);
  return s.marked.length > 0 ? s.marked : s.focused ? [s.focused] : NO_MARKS;
}

export function subscribeSelection(pane: PaneId, fn: () => void): () => void {
  let set = subs.get(pane);
  if (!set) subs.set(pane, (set = new Set()));
  const mine = set;
  mine.add(fn);
  return () => {
    mine.delete(fn);
    if (mine.size === 0 && subs.get(pane) === mine) subs.delete(pane);
  };
}

/** Fires for every pane whose selection changes (follow links). */
export function onAnySelection(fn: (pane: PaneId) => void): () => void {
  anySubs.add(fn);
  return () => anySubs.delete(fn);
}

/** A pane's selection, live. Works for any pane, not only the caller's own. */
export function useSelection(pane: PaneId): PaneSelection {
  const subscribe = useCallback((fn: () => void) => subscribeSelection(pane, fn), [pane]);
  return useSyncExternalStore(subscribe, () => getSelection(pane));
}

/** The IPC form of an object reference. */
export const toObjRef = (ref: ObjectRef, context: string): ObjRef => ({
  context,
  gvr: ref.gvr,
  namespace: ref.namespace,
  name: ref.name,
});
