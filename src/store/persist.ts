// Persisted zustand stores over backend.loadState / saveState (docs/ux.md §3.6).
//
// One store = one backend key = one JSON file, holding one or more fields of PersistedState
// (see PERSIST_KEYS). The file content is the envelope { schema, data }.
// - Writes are debounced (500ms) and coalesced; the Rust side makes each write atomic.
// - Nothing is saved before the first load has resolved, and a set() made before that is replayed
//   on top of the loaded state instead of being lost or clobbering the file.
// - Unreadable, unknown-schema or invalid data falls back to defaults; the old value is kept under
//   "<key>.bak".
// Store state must be plain JSON data: keep functions out of it.
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Json } from "../ipc/types";
import type { PersistedState } from "../types";

export interface PersistBackend {
  loadState(key: string): Promise<Json>;
  saveState(key: string, value: Json): Promise<void>;
}

/** The backend key of each persisted store and the PersistedState fields it owns. */
export const PERSIST_KEYS = {
  settings: "settings", // PersistedState.settings
  keymap: "keymap", // { keymap }
  workspaces: "workspaces", // { workspaces, parked }
  favorites: "favorites", // { favorites, layouts, nsSlots }
  columns: "columns", // { columns }
  tools: "tools", // feature tools: snippets, recent debug images (plan-features §2.10a)
} as const;

/** A store's state type when it owns some PersistedState fields: PersistedSlice<'favorites' | 'layouts'>. */
export type PersistedSlice<K extends keyof PersistedState> = Pick<PersistedState, K>;

export interface PersistOptions<T extends object> {
  /** backend key: [A-Za-z0-9._-], at most 100 characters */
  key: string;
  /** schema version of `data`; bump it when the shape changes */
  version: number;
  defaults: () => T;
  /**
   * Validates loaded data field by field and returns a complete, safe state (clamp enums and
   * ranges, drop unknown ids). Throw to reject the data entirely.
   */
  sanitize: (data: unknown, defaults: T) => T;
  /** Upgrades data written with an older version. Without it, older data is rejected. */
  migrate?: (data: unknown, fromVersion: number) => unknown;
  /** default 500 */
  debounceMs?: number;
  /** default: the app backend (src/ipc) */
  backend?: PersistBackend;
}

export interface PersistedStore<T extends object> extends StoreApi<T> {
  /** Resolves when the stored value has been loaded (or defaults were kept). Never rejects. */
  readonly hydrated: Promise<void>;
  isHydrated(): boolean;
  /** Writes pending changes now. */
  flush(): Promise<void>;
}

const all = new Set<PersistedStore<object>>();

/** Flushes every persisted store (call on pagehide / before quit). */
export function flushPersisted(): Promise<void> {
  return Promise.all([...all].map((s) => s.flush())).then(() => undefined);
}

let defaultBackend: Promise<PersistBackend> | null = null;
function appBackend(): Promise<PersistBackend> {
  // imported lazily so persist.ts stays free of the IPC layer in tests
  return (defaultBackend ??= import("../ipc").then((m) => m.backend));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function persistedStore<T extends object>(opts: PersistOptions<T>): PersistedStore<T> {
  const debounceMs = opts.debounceMs ?? 500;
  const backend = (): Promise<PersistBackend> => (opts.backend ? Promise.resolve(opts.backend) : appBackend());
  const store = createStore<T>(() => opts.defaults());

  let hydrated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let saving: Promise<void> = Promise.resolve();
  const early: Parameters<StoreApi<T>["setState"]>[] = [];

  const rawSet = store.setState;
  store.setState = ((...args: Parameters<StoreApi<T>["setState"]>) => {
    if (!hydrated) early.push(args);
    rawSet(...args);
  }) as StoreApi<T>["setState"];

  async function write(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    const envelope = { schema: opts.version, data: store.getState() as unknown as Json };
    try {
      await (await backend()).saveState(opts.key, envelope);
    } catch (e) {
      console.warn(`[persist] saving "${opts.key}" failed`, e);
    }
  }
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    saving = saving.then(write);
    return saving;
  }
  function schedule() {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  }

  function decode(raw: Json): { state: T; backup: boolean } {
    const defaults = opts.defaults();
    if (raw === null || raw === undefined) return { state: defaults, backup: false };
    try {
      if (!isObject(raw) || typeof raw.schema !== "number" || !("data" in raw)) throw new Error("not an envelope");
      let data: unknown = raw.data;
      if (raw.schema > opts.version) throw new Error(`schema ${raw.schema} is newer than ${opts.version}`);
      if (raw.schema < opts.version) {
        if (!opts.migrate) throw new Error(`no migration from schema ${raw.schema}`);
        data = opts.migrate(data, raw.schema);
      }
      return { state: opts.sanitize(data, defaults), backup: false };
    } catch (e) {
      console.warn(`[persist] "${opts.key}" is unusable, using defaults`, e);
      return { state: opts.defaults(), backup: true };
    }
  }

  const load = (async () => {
    let raw: Json = null;
    let b: PersistBackend | null = null;
    try {
      b = await backend();
      raw = await b.loadState(opts.key);
    } catch (e) {
      console.warn(`[persist] loading "${opts.key}" failed, using defaults`, e);
    }
    const { state, backup } = decode(raw);
    if (backup && b) void b.saveState(`${opts.key}.bak`, raw).catch(() => undefined);
    hydrated = true;
    rawSet(state, true);
    // replay what was set while loading, on top of the loaded state
    for (const args of early) rawSet(...args);
    const replayed = early.length > 0;
    early.length = 0;
    store.subscribe(schedule);
    if (replayed || backup) schedule();
  })();

  const api: PersistedStore<T> = Object.assign(store, {
    hydrated: load,
    isHydrated: () => hydrated,
    flush: () => (hydrated ? flush() : load.then(flush)),
  });
  all.add(api as unknown as PersistedStore<object>);
  return api;
}
