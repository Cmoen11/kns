// Pane header slots (docs/ux.md §11.1). A view renders its filter chips, state labels and count
// into its own pane's header through a portal, so that state never has to live in the foundation.
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Toolbar, type ToolbarItem } from "../ui/Toolbar";

export type PaneSlotName =
  /** after the crumbs: filter chips, the filter input */
  | "chips"
  /** right of the crumbs and chips: the view's action buttons (use <PaneToolbar>, docs/frontend.md §17) */
  | "toolbar"
  /** right side: FAV n, UNSORTED, FOLLOW, WRAP, TS, container ... (Etikett labels) */
  | "labels"
  /** right side, before the watch glyph: `shown/total` or `3 marked` */
  | "count";

export type PaneSlots = Record<PaneSlotName, HTMLElement | null>;

export const PaneSlotContext = createContext<PaneSlots>({ chips: null, toolbar: null, labels: null, count: null });

/**
 * Renders children into a slot of the header of the pane this view lives in.
 *
 *   <PaneSlot name="count">{shown}/{total}</PaneSlot>
 */
export function PaneSlot({ name, children }: { name: PaneSlotName; children: ReactNode }) {
  const node = useContext(PaneSlotContext)[name];
  return node ? createPortal(children, node) : null;
}

/**
 * A view's toolbar in its pane header: a list of action ids ("|" separates groups). Buttons follow
 * the registry (absent, disabled + reason, key in the tooltip) and overflow into a "more" menu.
 * For a toolbar that only depends on the ViewState, declare `toolbar` in registerView instead.
 *
 *   <PaneToolbar items={["logs.autoscroll", { action: "logs.wrap", active: view.wrap }, "|", "logs.copy"]} />
 */
export function PaneToolbar({ items, label }: { items: readonly ToolbarItem[]; label?: string }) {
  return (
    <PaneSlot name="toolbar">
      <Toolbar items={items} label={label} />
    </PaneSlot>
  );
}
