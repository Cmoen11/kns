// Namespace health, the live part: one backend subscription for the window's context while it is
// connected and the setting is on (nshealth.rs aggregates; only counts per namespace arrive).
// Eager and tiny; the badges read it through narrow selectors.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend } from "../ipc";
import type { NsHealth, NsHealthSnapshot, Unsubscribe } from "../ipc/types";
import { clusterStore } from "../store/cluster";
import { getSettings, settingsStore } from "../store/settings";
import { knows, shareEntries, totals, type HealthTotals } from "./health-model";

interface HealthState {
  snapshot: NsHealthSnapshot | null;
  /** faulty namespaces by name (structurally shared between snapshots) */
  byNs: ReadonlyMap<string, NsHealth>;
  totals: HealthTotals;
  /** the snapshot says something about the cluster (live, reconnecting, partial) */
  known: boolean;
}

const EMPTY: HealthState = { snapshot: null, byNs: new Map(), totals: totals(null), known: false };
export const healthStore = createStore<HealthState>(() => EMPTY);
export const useHealth = <T,>(select: (s: HealthState) => T): T => useStore(healthStore, select);
/** One namespace's entry (undefined when healthy); `*` is not a namespace here. */
export const useNsHealth = (ns: string): NsHealth | undefined => useStore(healthStore, (s) => s.byNs.get(ns));
export const getHealth = (): HealthState => healthStore.getState();

/** Applies a snapshot (exported for tests). */
export function applySnapshot(s: NsHealthSnapshot): void {
  const prev = healthStore.getState();
  // reconnecting / partial keep the last counts of what could not be listed; forbidden and error clear
  const known = knows(s);
  const byNs = known ? shareEntries(prev.byNs, s.namespaces) : new Map<string, NsHealth>();
  healthStore.setState({ snapshot: s, byNs, totals: totals(known ? s : null), known });
}

let stop: Unsubscribe | null = null;
let running: string | null = null;

function sync(): void {
  const c = clusterStore.getState();
  const want = getSettings().nsHealth && c.status === "connected" && c.context ? c.context : null;
  if (want === running) return;
  stop?.();
  stop = null;
  running = want;
  healthStore.setState(EMPTY);
  if (!want) return;
  stop = backend.subscribeNsHealth(want, (s) => {
    if (running === want && s.context === want) applySnapshot(s);
  });
}

let started = false;
/** Called once from register(). */
export function initHealth(): void {
  if (started) return;
  started = true;
  clusterStore.subscribe(sync);
  settingsStore.subscribe(sync);
  sync();
}
