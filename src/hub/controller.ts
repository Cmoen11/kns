// How the eager hub actions reach a mounted hub view: each hub registers a controller for its
// pane, and the handlers talk to the focused pane's one (as src/views/tools/controllers.ts does).
import { focusedPane } from "../foundation";
import type { PaneId } from "../types";
import type { ToolId } from "./catalog";

export interface HubController {
  move(delta: number): void;
  page(dir: 1 | -1): void;
  top(): void;
  bottom(): void;
  /** the tool under the cursor */
  current(): ToolId | undefined;
  filterOpen(): void;
  filterApply(): void;
  filterCancel(): void;
  isFiltering(): boolean;
  hasFilter(): boolean;
  filterClear(): void;
  toggleDetail(): void;
}

const controllers = new Map<PaneId, HubController>();

export function setHubController(pane: PaneId, c: HubController): () => void {
  controllers.set(pane, c);
  return () => {
    if (controllers.get(pane) === c) controllers.delete(pane);
  };
}

/** The focused pane's hub, if it shows one. */
export function hubCtl(): HubController | undefined {
  const pane = focusedPane();
  return pane ? controllers.get(pane) : undefined;
}
