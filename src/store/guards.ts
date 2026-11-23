// Live-session guards (docs/ux.md §4.6). The foundation does not know whether a shell is running
// or an edit is dirty; the views that own that state register a guard, and close, in-place
// navigation, context switch and quit consult it.
import type { PaneId, ViewState } from "../types";

export interface LiveSession {
  /** what would be lost, e.g. "shell in web-7d9f8" or "unsaved edit of deploy/web" */
  label: string;
  /**
   * 'ends' = closing the pane destroys it and must be confirmed (shell, attach, secret edit);
   * 'kept' = closing is fine because a draft stays (dirty YAML edit); a toast says so.
   */
  onClose: "ends" | "kept";
}

export type PaneGuard = (pane: PaneId, view: ViewState) => LiveSession | null;

const guards = new Set<PaneGuard>();

/** Registers a guard; returns the function that removes it. */
export function registerPaneGuard(guard: PaneGuard): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

/** The live session a pane holds right now, if any. */
export function liveSession(pane: PaneId, view: ViewState | undefined): LiveSession | null {
  if (!view) return null;
  for (const g of guards) {
    const s = g(pane, view);
    if (s) return s;
  }
  return null;
}
