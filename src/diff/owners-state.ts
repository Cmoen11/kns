// Field-owner toggles per doc pane (`O` / :owners, :drift). Small and free of CodeMirror: the
// eager actions and the doc header read it; the lazy gutter (src/views/doc/ownership.ts) reads it
// when an editor state is built and subscribes to it, so a reload of the document (which rebuilds
// the editor state) keeps the letters.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useWorkspace } from "../store/layout";
import { engine } from "../keys";
import type { PaneId } from "../types";

export interface OwnersUi {
  /** the gutter shows a letter per field */
  on: boolean;
  /** only fields of a Flux-managed object that Flux does not own; the rest is folded */
  drift: boolean;
  /** what the gutter found for the shown object (null = not loaded yet) */
  fluxManaged: boolean | null;
  /** fields a human changed under Flux (drift rows) */
  driftCount: number;
  error: string | null;
}

export const OWNERS_OFF: OwnersUi = Object.freeze({ on: false, drift: false, fluxManaged: null, driftCount: 0, error: null });

const store = createStore<Record<PaneId, OwnersUi>>(() => ({}));

export const ownersStore = store;
export const getOwners = (pane: PaneId | null | undefined): OwnersUi => (pane && store.getState()[pane]) || OWNERS_OFF;

export function patchOwners(pane: PaneId, patch: Partial<OwnersUi>): void {
  const all = store.getState();
  const cur = all[pane] ?? OWNERS_OFF;
  if ((Object.keys(patch) as (keyof OwnersUi)[]).every((k) => cur[k] === patch[k])) return;
  const next = { ...cur, ...patch };
  // turning the letters off ends drift-only too
  if (!next.on) Object.assign(next, { drift: false, fluxManaged: null, driftCount: 0, error: null });
  store.setState({ ...all, [pane]: next }, true);
  engine.invalidate();
}

export function clearOwners(pane: PaneId): void {
  const all = store.getState();
  if (!(pane in all)) return;
  const next = { ...all };
  delete next[pane];
  store.setState(next, true);
  engine.invalidate();
}

export const useOwners = <T,>(pane: PaneId, select: (s: OwnersUi) => T): T => useStore(store, (s) => select(s[pane] ?? OWNERS_OFF));

/** Live YAML panes with the letters on (the tool's status line); closed panes and other views do not count. */
export function useOwnersPaneCount(): number {
  const on = useStore(store, (s) => Object.keys(s).filter((p) => s[p].on).sort().join(" "));
  return useWorkspace((ws) => {
    if (!ws || !on) return 0;
    return on.split(" ").filter((p) => {
      const pane = ws.panes[p];
      const v = pane?.history[pane.index];
      return v?.kind === "doc" && v.mode === "view" && v.format === "yaml";
    }).length;
  });
}
