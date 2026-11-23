// The bridge between the eager C2 actions and the lazy timeline / traps views: each mounted view
// registers one controller per pane; the actions call the focused pane's (as ./controller does
// for `why`).
import { focusedPane } from "../foundation";
import type { PaneId } from "../types";

export type NewPane = "right" | "down" | null;

export interface ListController {
  move(delta: number): void;
  moveTo(where: "top" | "bottom"): void;
  /** Enter on the cursor row */
  open(newPane: NewPane): void;
  /** true, or why Enter does nothing on this row */
  canOpen(): true | string;
  refresh(): void;
  loaded(): boolean;
}

export interface TimelineController extends ListController {
  /** `l`: logs at the cursor row's time */
  logs(newPane: NewPane): void;
  canLogs(): true | string;
}

export interface TrapsController extends ListController {
  /** `x`: disarm the cursor row's trap */
  disarm(): void;
  canDisarm(): true | string;
}

function registry<C>() {
  const map = new Map<PaneId, C>();
  return {
    set(pane: PaneId, c: C | null) {
      if (c) map.set(pane, c);
      else map.delete(pane);
    },
    get(): C | undefined {
      const pane = focusedPane();
      return pane ? map.get(pane) : undefined;
    },
  };
}

export const timelineControllers = registry<TimelineController>();
export const trapsControllers = registry<TrapsController>();
