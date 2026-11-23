// Going to a breadcrumb (docs/ux.md §4.3): shared by Backspace (nav.crumbUp) and a click on a crumb.
import { liveSession } from "../store/guards";
import { goBack, openView, paneState } from "../store/layout";
import type { PaneId, ViewState } from "../types";

export function sameView(a: ViewState, b: ViewState): boolean {
  if (a.kind !== b.kind) return false;
  // the table the object was opened from counts as its parent, whatever its namespace or scope
  if (a.kind === "table" && b.kind === "table") return a.gvr.resource === b.gvr.resource && a.gvr.group === b.gvr.group;
  return a.kind !== "doc" && a.kind !== "logs" && a.kind !== "containers" && a.kind !== "shell" && a.kind !== "attach";
}

/**
 * Opens a crumb's view in `pane`: one step back when the previous history entry is that view
 * (so its cursor and filter come back), else a push. With `newPane` it opens beside instead.
 * A pane that holds a live session (shell, dirty edit) is never navigated in place: `openView`
 * diverts to the right (§4.6). A history step has no such guard, so it is not taken then.
 */
export function goToCrumb(pane: PaneId, view: ViewState, newPane: "right" | "down" | null = null): void {
  const state = paneState(pane);
  const prev = state && state.index > 0 ? state.history[state.index - 1] : null;
  const live = state ? liveSession(pane, state.history[state.index]) : null;
  if (!newPane && !live && prev && sameView(prev, view)) goBack(pane);
  else openView(view, { pane, newPane });
}
