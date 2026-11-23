// Mouse parity for the C2 list views (docs/frontend.md §17): a click selects, a double click or
// the row's open button runs nav.open, Ctrl/⌘+click and a middle click open beside, a right click
// moves the cursor and lets the default menu open. Every pointer path goes through runAction.
import type { MouseEvent } from "react";
import { runAction } from "../foundation";
import type { PaneId } from "../types";

export function listPointer(pane: PaneId, select: (i: number) => void, invalidate: () => void) {
  const indexOf = (e: MouseEvent): number => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : -1;
  };
  const act = (e: MouseEvent): string | undefined => (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  return {
    onClick: (e: MouseEvent) => {
      const i = indexOf(e);
      if (i < 0) return;
      select(i);
      const a = act(e);
      if (a && a !== "open") {
        runAction(a as Parameters<typeof runAction>[0], { pane, before: () => select(i) });
        return;
      }
      if (a || e.ctrlKey || e.metaKey) {
        const newPane = e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : null;
        runAction("nav.open", { pane, newPane, before: () => select(i) });
      }
    },
    onDoubleClick: (e: MouseEvent) => {
      const i = indexOf(e);
      if (i >= 0 && !act(e)) runAction("nav.open", { pane, before: () => select(i) });
    },
    onAuxClick: (e: MouseEvent) => {
      const i = indexOf(e);
      if (e.button === 1 && i >= 0) {
        select(i);
        runAction("nav.open", { pane, newPane: "right", before: () => select(i) });
      }
    },
    onContextMenu: (e: MouseEvent) => {
      const i = indexOf(e);
      if (i >= 0) {
        select(i);
        invalidate();
      }
    },
  };
}
