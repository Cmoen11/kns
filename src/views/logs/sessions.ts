// The live logs state per pane. It is module-level, not component state, because the view is
// remounted on every history move while the buffer must survive for 30s (docs/ux.md §4.6), and
// because the action handlers (loaded eagerly) need to reach the pane's session.
import { focusedPane, paneView } from "../../foundation";
import type { LogsView, PaneId } from "../../types";
import type { LogSession } from "./session";
import type { StreamManager } from "./streams";

export interface PaneLogs {
  pane: PaneId;
  session: LogSession;
  streams: StreamManager;
  /** the single container shown before "all containers" was switched on */
  lastContainer?: string;
  drop?: ReturnType<typeof setTimeout>;
}

/** how long a buffer outlives its view */
export const KEEP_MS = 30_000;

const panes = new Map<PaneId, PaneLogs>();

export const logsOf = (pane: PaneId): PaneLogs | undefined => panes.get(pane);

/** The pane's state, created on first use; cancels a pending drop. */
export function acquireLogs(pane: PaneId, create: () => PaneLogs): PaneLogs {
  let pl = panes.get(pane);
  if (!pl) panes.set(pane, (pl = create()));
  if (pl.drop) clearTimeout(pl.drop);
  pl.drop = undefined;
  return pl;
}

/** The view unmounted: stop the streams now, drop the buffer after 30s. */
export function releaseLogs(pane: PaneId): void {
  const pl = panes.get(pane);
  if (!pl) return;
  pl.streams.detach();
  if (pl.drop) clearTimeout(pl.drop);
  pl.drop = setTimeout(() => {
    if (panes.get(pane) === pl) panes.delete(pane);
  }, KEEP_MS);
}

export interface FocusedLogs {
  pane: PaneId;
  view: LogsView;
  pl: PaneLogs;
}

/** The focused pane's logs view and state; null when it shows something else or is still loading. */
export function focusedLogs(): FocusedLogs | null {
  const pane = focusedPane();
  if (!pane) return null;
  const view = paneView(pane);
  const pl = panes.get(pane);
  return view?.kind === "logs" && pl && !pl.drop ? { pane, view, pl } : null;
}
