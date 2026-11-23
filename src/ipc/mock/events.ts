// Mock event bus (docs/plan-features.md §2.11): what `kns://event` is in the real app.
import type { BackendEvent, EventsBackend } from "../types";

const subs = new Set<(e: BackendEvent) => void>();

/** Delivers an event to every onEvent subscriber, asynchronously like the real bus. */
export function emitMock(e: BackendEvent): void {
  queueMicrotask(() => {
    for (const cb of [...subs]) cb(e);
  });
}

export const eventsMock: EventsBackend = {
  onEvent: (cb) => {
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  },
};
