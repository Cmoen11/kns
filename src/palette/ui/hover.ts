// "Hover only moves the selection on real mouse movement". Browsers also fire mousemove when the
// content moves under a resting pointer: a list scrolled by the arrow keys, an overlay that opens
// under the cursor. Those events carry the screen position of the last real one, so the position
// is tracked for the whole window (one passive listener, no work but two compares) and a list
// asks whether the event it is handling was a move.

interface Point {
  screenX: number;
  screenY: number;
}

let lastX = Number.NaN;
let lastY = Number.NaN;
let moved = false;

/** Feeds one mouse event; returns whether the pointer is somewhere else than at the previous one. */
export function trackPointer(e: Point): boolean {
  // the very first event has nothing to compare with: a resting pointer
  moved = !Number.isNaN(lastX) && (e.screenX !== lastX || e.screenY !== lastY);
  lastX = e.screenX;
  lastY = e.screenY;
  return moved;
}

/** Inside a mousemove handler: true when that event was a real movement of the pointer. */
export const pointerMoved = (): boolean => moved;

/** Tests only. */
export function resetPointer(): void {
  lastX = lastY = Number.NaN;
  moved = false;
}

// capture on the window: runs before any list's own handler
if (typeof window !== "undefined") window.addEventListener("mousemove", trackPointer, { capture: true, passive: true });
