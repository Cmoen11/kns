// Namespace health, the live part: one backend subscription for the window's context while it is
// connected and the setting is on (nshealth.rs aggregates; only counts per namespace arrive).
// Eager and tiny; the badges read it through narrow selectors.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend } from "../ipc";
import type { NsHealth, NsHealthSnapshot, Unsubscribe } from "../ipc/types";
import { clusterStore } from "../store/cluster";
import { fallbackNamespaces } from "../catalog/namespaces";
import { catalogStore } from "../catalog/store";
import { favStore } from "../palette/favourites/store";
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
/** the namespaces the running watch covers; null = all of them */
let runningOver: string | null = null;
/** contexts that refused the cluster-wide watch this session: they use the fallback namespaces */
const refusedAll = new Set<string>();

function sync(): void {
  const c = clusterStore.getState();
  const want = getSettings().nsHealth && c.status === "connected" && c.context ? c.context : null;
  // a team member may not list pods across all namespaces: watch the team's (catalog) or the
  // used ones instead, at most 40 (nshealth.rs)
  const over = want && refusedAll.has(want) ? fallbackNamespaces(want) : null;
  const overKey = over && over.length > 0 ? over.join(",") : null;
  if (want === running && overKey === runningOver) return;
  stop?.();
  stop = null;
  running = want;
  runningOver = overKey;
  healthStore.setState(EMPTY);
  if (!want) return;
  stop = backend.subscribeNsHealth(
    want,
    (s) => {
      if (running !== want || s.context !== want) return;
      if (s.state === "forbidden" && runningOver === null && !refusedAll.has(want)) {
        refusedAll.add(want);
        // retried over the team's namespaces when there are any; else the forbidden state stays
        if (fallbackNamespaces(want).length > 0) {
          queueMicrotask(sync);
          return;
        }
      }
      applySnapshot(s);
    },
    overKey ? over! : undefined,
  );
}

let started = false;
/** Called once from register(). */
export function initHealth(): void {
  if (started) return;
  started = true;
  clusterStore.subscribe(sync);
  settingsStore.subscribe(sync);
  // the fallback namespaces follow the catalog and the namespaces used
  catalogStore.subscribe(sync);
  favStore.subscribe(sync);
  sync();
}
