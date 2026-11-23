// Pod CPU/MEM (docs/ux.md §12.2): backend.podMetrics polled every 15s, only while a pods table
// that shows them is visible. One poller per (context, namespace), shared by panes.
import { tagMetrics } from "../diag/spark";
import { useCallback, useSyncExternalStore } from "react";
import type { PodMetric } from "../ipc/types";
import { backend } from "../foundation";
import { metricKey } from "./cells";

const POLL_MS = 15000;
export const NO_METRICS: ReadonlyMap<string, PodMetric> = new Map();

interface Entry {
  map: ReadonlyMap<string, PodMetric>;
  subs: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: boolean;
}

const entries = new Map<string, Entry>();

function poll(key: string, context: string, namespace: string | undefined): void {
  const e = entries.get(key);
  if (!e || e.inflight) return;
  e.inflight = true;
  backend.podMetrics(context, namespace).then(
    (list) => {
      e.inflight = false;
      const map = new Map<string, PodMetric>();
      for (const m of list) map.set(metricKey(m.namespace, m.name), m);
      tagMetrics(map, context);
      e.map = map;
      for (const fn of [...e.subs]) fn();
    },
    () => {
      // metrics-server hiccup: keep the last values
      e.inflight = false;
    },
  );
}

/** Live pod metrics by `namespace/name`. Pass active=false to stop polling (hidden pane, other kind). */
export function usePodMetrics(context: string | null, namespace: string | undefined, active: boolean): ReadonlyMap<string, PodMetric> {
  const key = active && context ? `${context}\u0001${namespace ?? ""}` : "";
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!key || !context) return () => undefined;
      let e = entries.get(key);
      if (!e) entries.set(key, (e = { map: NO_METRICS, subs: new Set(), timer: null, inflight: false }));
      const entry = e;
      entry.subs.add(fn);
      if (entry.timer === null) {
        entry.timer = setInterval(() => poll(key, context, namespace), POLL_MS);
        poll(key, context, namespace);
      }
      return () => {
        entry.subs.delete(fn);
        if (entry.subs.size === 0) {
          if (entry.timer !== null) clearInterval(entry.timer);
          entry.timer = null;
          if (entries.get(key) === entry) entries.delete(key);
        }
      };
    },
    [key, context, namespace],
  );
  return useSyncExternalStore(subscribe, () => (key ? (entries.get(key)?.map ?? NO_METRICS) : NO_METRICS));
}
