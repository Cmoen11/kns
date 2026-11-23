// The one rate-limited aria-live region (docs/ux.md §17): mode changes, toasts and errors.
// Watch updates are never announced.
import { useSyncExternalStore } from "react";

const MIN_GAP_MS = 500;
let text = "";
let lastAt = 0;
let queued: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();

function publish(next: string) {
  // the same sentence twice must still be announced
  text = next === text ? `${next} ` : next;
  lastAt = Date.now();
  for (const fn of subs) fn();
}

/** Announces a short sentence to screen readers. Bursts collapse to the latest message. */
export function announce(message: string): void {
  const wait = lastAt + MIN_GAP_MS - Date.now();
  if (wait <= 0 && !timer) {
    publish(message);
    return;
  }
  queued = message;
  timer ??= setTimeout(() => {
    timer = null;
    if (queued !== null) publish(queued);
    queued = null;
  }, Math.max(0, wait));
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

/** Mount once at the root. */
export function LiveRegion() {
  const value = useSyncExternalStore(subscribe, () => text);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {value}
    </div>
  );
}
