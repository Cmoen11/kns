// How the eager action handlers reach a mounted tool view: each list registers a controller for
// its pane, and the handlers talk to the focused pane's one.
import { focusedPane } from "../../foundation";
import type { PaneId } from "../../types";
import type { ItemRow } from "./list-model";

export interface ListController {
  move(delta: number): void;
  page(dir: 1 | -1): void;
  top(): void;
  bottom(): void;
  /** the cursor row */
  current(): ItemRow | undefined;
  filterOpen(): void;
  filterApply(): void;
  filterCancel(): void;
  isFiltering(): boolean;
  hasFilter(): boolean;
  filterClear(): void;
}

const controllers = new Map<PaneId, ListController>();

// `:keys` (settings.open with the argument "keys"): the settings view that mounts next starts on
// its first keymap row. One-shot.
let keysJump = false;
export const requestKeysJump = (): void => void (keysJump = true);
export function takeKeysJump(): boolean {
  const v = keysJump;
  keysJump = false;
  return v;
}

/** Registers a pane's list; the returned function removes it (only if it is still the one). */
export function setController(pane: PaneId, c: ListController): () => void {
  controllers.set(pane, c);
  return () => {
    if (controllers.get(pane) === c) controllers.delete(pane);
  };
}

/** The focused pane's list, if it shows a tool view. */
export function ctl(): ListController | undefined {
  const pane = focusedPane();
  return pane ? controllers.get(pane) : undefined;
}
