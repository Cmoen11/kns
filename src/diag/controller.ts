// The bridge between the eager `why` actions and the lazy WhyView: the view registers one
// controller per pane while it is mounted; the actions call the focused pane's.
import { focusedPane } from "../foundation";
import type { PaneId } from "../types";

export type NewPane = "right" | "down" | null;

export interface WhyController {
  move(delta: number): void;
  moveTo(where: "top" | "bottom"): void;
  /** Enter: follow the cursor row's evidence */
  open(newPane: NewPane): void;
  /** true, or why Enter does nothing on this row */
  canOpen(): true | string;
  refresh(): void;
  /** copies the findings; false while there are none loaded */
  copy(): boolean;
  loaded(): boolean;
}

const controllers = new Map<PaneId, WhyController>();

export function setWhyController(pane: PaneId, c: WhyController | null): void {
  if (c) controllers.set(pane, c);
  else controllers.delete(pane);
}

export function whyController(): WhyController | undefined {
  const pane = focusedPane();
  return pane ? controllers.get(pane) : undefined;
}
