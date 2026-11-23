// The bridge between the eager C3 actions and the lazy relations / reach views: each mounted view
// registers one controller per pane; the actions call the focused pane's (as ./c2-controller does).
import { focusedPane } from "../foundation";
import type { PaneId } from "../types";
import type { ListController } from "./c2-controller";

export interface RelationsController extends ListController {
  fold(dir: "collapse" | "expand"): void;
  canFold(dir: "collapse" | "expand"): true | string;
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

export const relationsControllers = registry<RelationsController>();
export const reachControllers = registry<ListController>();
