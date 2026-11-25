// The shared live-table data layer over backend.subscribeTable (docs/ux.md §12.3, §3.4).
//
// - One backend subscription per unique TableQuery, refcounted: two panes on the same query share
//   it, and a grace period keeps it alive across navigation (back is instant, from cache).
// - Rows live in a Map by uid, outside React state. Deltas are applied as they arrive; subscribers
//   are told at most once per animation frame, however many events came in.
// - Row order is stable: a row keeps its position when it changes; new rows go last.
// - A paused lease (hidden pane) lets the watch stop after 30s; the last rows stay, marked stale.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Column, Row, TableEvent, TableQuery, Unsubscribe, WatchState } from "../ipc/types";
import type { PaneId } from "../types";
import { setPaneStatus } from "./pane-status";

export interface TableSnapshot {
  /** normalized query key */
  key: string;
  columns: readonly Column[];
  /** stable order; the array identity changes only when `version` does */
  rows: readonly Row[];
  state: WatchState;
  message?: string;
  /** false until the first snapshot arrived: show `syncing`, never "no resources" */
  synced: boolean;
  /** true while the watch is stopped (paused pane); rows are the last known ones */
  stale: boolean;
  /** bumped once per frame in which anything changed */
  version: number;
}

/** What changed in one frame, for cell-delta highlighting. */
export interface TableDelta {
  /** true after a (re)snapshot: treat everything as new */
  reset: boolean;
  /** uid -> the row before this frame (undefined = added) */
  changed: ReadonlyMap<string, Row | undefined>;
  deleted: readonly string[];
}

export interface Lease {
  readonly key: string;
  /** false = this holder does not need live data (hidden pane); the watch may pause after 30s */
  setLive(live: boolean): void;
  release(): void;
}

export interface TablesOptions {
  subscribe: (query: TableQuery, onEvent: (e: TableEvent) => void) => Unsubscribe;
  /** runs `fn` once, on the next frame */
  schedule: (fn: () => void) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** how long a subscription outlives its last holder (navigation), default 2000 */
  graceMs?: number;
  /** how long a watch outlives its last live holder while paused holders remain (§3.4), default 30000 */
  pauseMs?: number;
}

export interface Tables {
  /** Takes a reference on a query's subscription. Always release it. */
  acquire(query: TableQuery, opts?: { live?: boolean }): Lease;
  /** The current snapshot; the same object until the next frame with changes. */
  get(key: string): TableSnapshot;
  rowByUid(key: string, uid: string): Row | undefined;
  subscribe(key: string, fn: () => void): () => void;
  /** Called once per changed frame, before the snapshot subscribers. */
  subscribeDelta(key: string, fn: (d: TableDelta) => void): () => void;
  /** Drops and re-opens one subscription (view.refresh). Rows stay until the new snapshot. */
  refresh(key: string): void;
  /** Re-opens every live subscription (conn.reconnect). */
  resyncAll(): void;
  /** Worst watch state over all live subscriptions, for the connection indicator. */
  health(): { subscriptions: number; reconnecting: number; failed: number };
  subscribeHealth(fn: () => void): () => void;
  /** For tests: number of open backend subscriptions. */
  openCount(): number;
}

/** Stable key of a query; `undefined`, `""` and `"*"` all mean all namespaces. */
export function tableKey(q: TableQuery): string {
  const ns = q.namespaces?.length ? `[${q.namespaces.join(",")}]` : !q.namespace || q.namespace === "*" ? "" : q.namespace;
  return [q.context, q.gvr.group, q.gvr.version, q.gvr.resource, ns, q.labelSelector ?? "", q.fieldSelector ?? ""].join("\u0001");
}

const EMPTY_ROWS: readonly Row[] = Object.freeze([]);
const EMPTY_COLS: readonly Column[] = Object.freeze([]);
const emptySnapshot = (key: string): TableSnapshot => ({
  key, columns: EMPTY_COLS, rows: EMPTY_ROWS, state: "syncing", synced: false, stale: false, version: 0,
});

interface Entry {
  key: string;
  query: TableQuery;
  rows: Map<string, Row>;
  columns: readonly Column[];
  state: WatchState;
  message?: string;
  synced: boolean;
  /** bumped for each backend subscription, so events of a dropped one are ignored */
  gen: number;
  stop: Unsubscribe | null;
  holders: number;
  live: number;
  timer: unknown;
  dirty: boolean;
  rowsDirty: boolean;
  snapshot: TableSnapshot;
  subs: Set<() => void>;
  deltaSubs: Set<(d: TableDelta) => void>;
  reset: boolean;
  changed: Map<string, Row | undefined>;
  deleted: string[];
}

export function createTables(opts: TablesOptions): Tables {
  const graceMs = opts.graceMs ?? 2000;
  const pauseMs = opts.pauseMs ?? 30000;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<string, Entry>();
  const dirty = new Set<Entry>();
  const healthSubs = new Set<() => void>();
  let scheduled = false;
  let healthDirty = false;

  function flush() {
    scheduled = false;
    const batch = [...dirty];
    dirty.clear();
    for (const e of batch) {
      e.dirty = false;
      const prev = e.snapshot;
      const rows = e.rowsDirty ? [...e.rows.values()] : prev.rows;
      e.rowsDirty = false;
      e.snapshot = {
        key: e.key, columns: e.columns, rows, state: e.state, message: e.message, synced: e.synced, stale: e.stop === null,
        version: prev.version + 1,
      };
      if (e.deltaSubs.size > 0 && (e.reset || e.changed.size > 0 || e.deleted.length > 0)) {
        const d: TableDelta = { reset: e.reset, changed: e.changed, deleted: e.deleted };
        for (const fn of [...e.deltaSubs]) fn(d);
      }
      e.reset = false;
      e.changed = new Map();
      e.deleted = [];
      for (const fn of [...e.subs]) fn();
    }
    if (healthDirty) {
      healthDirty = false;
      for (const fn of [...healthSubs]) fn();
    }
  }

  function mark(e: Entry | null) {
    if (e && !e.dirty) {
      e.dirty = true;
      dirty.add(e);
    }
    if (!scheduled) {
      scheduled = true;
      opts.schedule(flush);
    }
  }

  function onEvent(e: Entry, gen: number, ev: TableEvent) {
    if (gen !== e.gen || !entries.has(e.key)) return;
    if (ev.type === "state") {
      if (e.state === ev.state && e.message === ev.message) return;
      e.state = ev.state;
      e.message = ev.message;
      healthDirty = true;
    } else if (ev.type === "snapshot") {
      // keep the order of rows that survive a resync; new rows go last
      const next = new Map<string, Row>();
      const incoming = new Map<string, Row>();
      for (const r of ev.rows) incoming.set(r.uid, r);
      for (const uid of e.rows.keys()) {
        const r = incoming.get(uid);
        if (r) next.set(uid, r);
      }
      for (const [uid, r] of incoming) if (!next.has(uid)) next.set(uid, r);
      e.rows = next;
      e.columns = ev.columns;
      e.synced = true;
      e.rowsDirty = true;
      e.reset = true;
      e.changed.clear();
      e.deleted = [];
    } else {
      if (ev.upserts.length === 0 && ev.deletes.length === 0) return;
      for (const r of ev.upserts) {
        if (!e.changed.has(r.uid)) e.changed.set(r.uid, e.rows.get(r.uid));
        e.rows.set(r.uid, r);
      }
      for (const uid of ev.deletes) {
        if (e.rows.delete(uid)) {
          e.deleted.push(uid);
          e.changed.delete(uid);
        }
      }
      e.rowsDirty = true;
    }
    mark(e);
  }

  function open(e: Entry) {
    const gen = ++e.gen;
    // the entry is in the map before subscribing: a backend may emit synchronously
    const stop = opts.subscribe(e.query, (ev) => onEvent(e, gen, ev));
    e.stop = stop;
    healthDirty = true;
    mark(e);
  }

  function close(e: Entry) {
    if (!e.stop) return;
    const stop = e.stop;
    e.stop = null;
    e.gen++;
    stop();
    healthDirty = true;
    mark(e);
  }

  function retime(e: Entry) {
    if (e.timer !== null) clearTimer(e.timer);
    e.timer = null;
    if (e.holders === 0) {
      e.timer = setTimer(() => {
        e.timer = null;
        if (e.holders > 0) return;
        close(e);
        entries.delete(e.key);
        dirty.delete(e);
      }, graceMs);
    } else if (e.live === 0) {
      if (e.stop) {
        e.timer = setTimer(() => {
          e.timer = null;
          if (e.live === 0) close(e);
        }, pauseMs);
      }
    } else if (!e.stop) {
      open(e);
    }
  }

  function entryFor(query: TableQuery): Entry {
    const key = tableKey(query);
    let e = entries.get(key);
    if (!e) {
      e = {
        key, query: { ...query, namespace: !query.namespace || query.namespace === "*" ? undefined : query.namespace },
        rows: new Map(), columns: EMPTY_COLS, state: "syncing", synced: false, gen: 0, stop: null, holders: 0, live: 0,
        timer: null, dirty: false, rowsDirty: false, snapshot: emptySnapshot(key), subs: new Set(), deltaSubs: new Set(),
        reset: false, changed: new Map(), deleted: [],
      };
      entries.set(key, e);
    }
    return e;
  }

  const fallback = new Map<string, TableSnapshot>();

  return {
    acquire(query, o = {}) {
      const e = entryFor(query);
      let live = o.live ?? true;
      let released = false;
      e.holders++;
      if (live) e.live++;
      retime(e);
      return {
        key: e.key,
        setLive(next) {
          if (released || next === live) return;
          live = next;
          e.live += next ? 1 : -1;
          retime(e);
        },
        release() {
          if (released) return;
          released = true;
          e.holders--;
          if (live) e.live--;
          retime(e);
        },
      };
    },
    get(key) {
      const e = entries.get(key);
      if (e) return e.snapshot;
      let s = fallback.get(key);
      if (!s) {
        if (fallback.size > 64) fallback.clear();
        s = emptySnapshot(key);
        fallback.set(key, s);
      }
      return s;
    },
    rowByUid: (key, uid) => entries.get(key)?.rows.get(uid),
    subscribe(key, fn) {
      const e = entries.get(key);
      if (!e) return () => undefined;
      e.subs.add(fn);
      return () => e.subs.delete(fn);
    },
    subscribeDelta(key, fn) {
      const e = entries.get(key);
      if (!e) return () => undefined;
      e.deltaSubs.add(fn);
      return () => e.deltaSubs.delete(fn);
    },
    refresh(key) {
      const e = entries.get(key);
      if (!e || !e.stop) return;
      close(e);
      e.state = "syncing";
      open(e);
    },
    resyncAll() {
      for (const e of entries.values()) {
        if (!e.stop) continue;
        close(e);
        e.state = "syncing";
        open(e);
      }
    },
    health() {
      let subscriptions = 0;
      let reconnecting = 0;
      let failed = 0;
      for (const e of entries.values()) {
        if (!e.stop) continue;
        subscriptions++;
        if (e.state === "reconnecting") reconnecting++;
        else if (e.state === "error") failed++;
      }
      return { subscriptions, reconnecting, failed };
    },
    subscribeHealth(fn) {
      healthSubs.add(fn);
      return () => healthSubs.delete(fn);
    },
    openCount() {
      let n = 0;
      for (const e of entries.values()) if (e.stop) n++;
      return n;
    },
  };
}

/** requestAnimationFrame with a timer fallback, so a backgrounded window still drains. */
function frame(fn: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  setTimeout(run, 250);
}

let app: Tables | null = null;
/** The app's table hub (created on first use, so tests never touch the IPC layer). */
export function tables(): Tables {
  if (!app) throw new Error("tables: call initTables(backend) first");
  return app;
}
export function initTables(backend: { subscribeTable: TablesOptions["subscribe"] }): Tables {
  return (app ??= createTables({ subscribe: (q, cb) => backend.subscribeTable(q, cb), schedule: frame }));
}

export interface UseTableOptions {
  /** false while the pane is hidden (folded, zoomed out): the watch may pause after 30s */
  live?: boolean;
  /** reports the watch state to this pane's header glyph */
  pane?: PaneId;
}

/**
 * Live rows of a query. Returns a stable snapshot object that changes at most once per frame.
 * Pass null while the query is not known yet. Mount it in as few components as possible and hand
 * rows down by index; never copy the rows into React state.
 */
export function useTable(query: TableQuery | null, opts: UseTableOptions = {}): TableSnapshot {
  const hub = tables();
  const key = query ? tableKey(query) : "";
  const live = opts.live ?? true;
  const lease = useRef<Lease | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const q = queryRef.current;
    if (!q) return;
    const l = hub.acquire(q, { live });
    lease.current = l;
    return () => {
      lease.current = null;
      l.release();
    };
    // `live` changes go through setLive below, without re-acquiring
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, key]);
  useEffect(() => lease.current?.setLive(live), [live]);

  // declared after the acquiring effect, so the entry exists when React subscribes
  const subscribe = useCallback((fn: () => void) => hub.subscribe(key, fn), [hub, key]);
  const snap = useSyncExternalStore(subscribe, () => hub.get(key));

  const pane = opts.pane;
  const state = !query ? null : snap.stale ? "stale" : snap.state;
  useEffect(() => {
    if (!pane) return;
    setPaneStatus(pane, { watch: state, message: snap.message });
    return () => setPaneStatus(pane, { watch: null });
  }, [pane, state, snap.message]);

  return snap;
}
