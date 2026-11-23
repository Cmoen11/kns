// Dev sets as the UI knows them (docs/plan-features.md §2.5): one listing from Rust (the single
// writer), re-read on boot and on each `devSets` event. Running state comes from the forwards
// listing (`Forward.devSet`), so nothing here polls.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend, toasts } from "../foundation";
import type { BackendError, DevSet, DevSetFailure, Forward } from "../ipc/types";
import { getForwards, refreshForwards, subscribeForwards, useForwards } from "../views/shell/forwards";

interface DevState {
  sets: readonly DevSet[];
  loaded: boolean;
  error: string | null;
  /** sets that failed to come up by themselves (autoStart); Rust keeps them until up or cleared */
  failures: readonly DevSetFailure[];
}

const store = createStore<DevState>(() => ({ sets: [], loaded: false, error: null, failures: [] }));
export const useDevSets = <T,>(select: (s: DevState) => T): T => useStore(store, select);
export const getDevSets = (): readonly DevSet[] => store.getState().sets;
export const devSetById = (id: string): DevSet | undefined => store.getState().sets.find((s) => s.id === id);
export const devSetByName = (name: string, context?: string): DevSet | undefined =>
  store.getState().sets.find((s) => s.name === name && (context === undefined || s.context === context));

export const errorText = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as BackendError).message) : String(e);

/** Failures already toasted in this page (a reload toasts the ones still open once more). */
const toasted = new Set<string>();
const failureKey = (f: DevSetFailure): string => `${f.devSet}@${f.at}`;

/** Re-reads the autoStart failures (optionally clearing some first); new ones toast once. */
export async function refreshFailures(clear?: string[]): Promise<void> {
  try {
    const failures = await backend.devSetFailures(clear);
    for (const f of failures) {
      if (toasted.has(failureKey(f))) continue;
      toasted.add(failureKey(f));
      toasts.error(`Dev set ${f.name} did not start by itself: ${f.message}`);
    }
    store.setState({ failures });
  } catch {
    /* an older backend without the command: nothing to show */
  }
}

/** Dismisses the failure rows of these sets (Activity `x` / clear). */
export const clearFailures = (ids: string[]): Promise<void> => refreshFailures(ids);

let inflight: Promise<void> | null = null;
export function refreshDevSets(): Promise<void> {
  void refreshFailures();
  inflight ??= backend
    .devSetsList()
    .then(
      (sets) => store.setState({ sets: [...sets].sort((a, b) => a.context.localeCompare(b.context) || a.name.localeCompare(b.name)), loaded: true, error: null }),
      (e: unknown) => store.setState({ loaded: true, error: errorText(e) }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

let started = false;
/** Called once from register(): the first listing and the event hint. */
export function initDevSets(): void {
  if (started) return;
  started = true;
  void refreshDevSets();
  // forwards may outlive a window reload: the running state needs the listing too
  void refreshForwards();
  try {
    backend.onEvent((e) => {
      if (e.type === "devSets") void refreshDevSets();
    });
  } catch {
    /* tests without an event bus */
  }
}

/** Forwards of a set that are running now. */
export const setForwards = (list: readonly Forward[], id: string): Forward[] => list.filter((f) => f.devSet === id);

/** Ids of the sets with at least one running forward (stable string for selectors). */
const runningKey = (list: readonly Forward[]): string => [...new Set(list.flatMap((f) => (f.devSet ? [f.devSet] : [])))].sort().join(",");
export const useRunningSetIds = (): readonly string[] => {
  const key = useForwards((s) => runningKey(s.list));
  return key === "" ? EMPTY : key.split(",");
};
const EMPTY: readonly string[] = [];
export const runningSetIds = (): string[] => (runningKey(getForwards()) || "").split(",").filter(Boolean);
export { subscribeForwards };
