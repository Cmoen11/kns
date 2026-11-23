// Motion for rearranging panes (docs/ux.md §16 exception): a swap, insert, dock or move glides
// the panes to their new places. Only these operations animate: splits, closes, divider drags and
// window resizes still happen in the same frame, so a transition never lags behind the pointer.

/** Matches `--k-pane-move` in panes.css. */
const DURATION = 180;

let timer: ReturnType<typeof setTimeout> | undefined;

function reduced(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs a layout operation with transitions on the pane frames. The attribute is set before the
 * store changes, so the frames' new left/top/width/height are transitioned (the transition
 * property of the after-change style applies).
 */
export function animateLayout<T>(op: () => T): T {
  const area = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".panes");
  if (!area || reduced()) return op();
  area.dataset.animate = "";
  clearTimeout(timer);
  timer = setTimeout(() => delete area.dataset.animate, DURATION + 60);
  return op();
}
