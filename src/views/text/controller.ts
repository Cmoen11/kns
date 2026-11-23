// The bridge between the eager `text` actions (./actions) and the lazy TextView: the view
// registers one controller per pane while it is mounted; the actions call the focused pane's.
import { focusedPane } from "../../foundation";
import type { PaneId } from "../../types";

export interface TextController {
  move(delta: number): void;
  moveTo(where: "top" | "bottom"): void;
  page(delta: number): void;
  /** Enter: fold or unfold the cursor section */
  fold(): void;
  /** Space: true, or why the cursor section cannot be dropped */
  canDrop(): true | string;
  drop(): void;
  /** `c`: true, or why there is nothing to copy */
  canCopy(): true | string;
  copy(): void;
  /** `Mod+S`: true, or why this text cannot be saved */
  canSave(): true | string;
  save(): void;
  /** moves the cursor to a section (pointer: before a row button runs) */
  point(id: string): void;
  refresh(): void;
}

const controllers = new Map<PaneId, TextController>();

export function setTextController(pane: PaneId, c: TextController | null): void {
  if (c) controllers.set(pane, c);
  else controllers.delete(pane);
}

export function textController(): TextController | undefined {
  const pane = focusedPane();
  return pane ? controllers.get(pane) : undefined;
}
