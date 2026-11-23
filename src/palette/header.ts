// The focused pane's header element, for the `:` and `/` bars (docs/ux.md §6.2, §6.3).
//
// PaneSlot only works inside a view's own tree, and these bars are owned by the palette feature,
// so they portal into the header found in the DOM. The foundation should expose this (see the
// report): this lookup depends on the class names of src/panes/Pane.tsx.
export function paneHeader(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".pane[data-focused] > .pane-header");
}
